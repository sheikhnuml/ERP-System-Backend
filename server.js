import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// 1. ENVIRONMENT CONFIGURATION & DATABASE INITIALIZATION
// ============================================================================
dotenv.config();

const PORT = process.env.PORT || 5000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL CONFIG ERROR]: Missing SUPABASE_URL or SUPABASE_KEY in environment configuration.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

// Immutable System Policy Defaults
const DEFAULT_SHIFT_POLICY = Object.freeze({
  shift_start: '09:00:00',
  grace_minutes: 15,
  half_day_cutoff: '11:30:00',
  absent_cutoff: '13:00:00'
});

const DEFAULT_PAYROLL_RULES = Object.freeze({
  working_days: 30,
  grace_lates: 2,
  late_fine_amount: 300,
  half_day_deduction_pct: 50,
  absent_deduction_pct: 100
});

// ============================================================================
// 2. MIDDLEWARES & UTILITY HELPERS
// ============================================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Request Audit Logger Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[HTTP Audit] ${timestamp} | ${req.method} ${req.originalUrl}`);
  next();
});

// Asynchronous Route Handler Wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Converts "HH:MM:SS" or "HH:MM" to Total Minutes from Midnight
const parseTimeToMinutes = (timeString) => {
  if (!timeString || typeof timeString !== 'string') return 0;
  const [hours = 0, minutes = 0] = timeString.split(':').map(Number);
  return hours * 60 + minutes;
};

// Computes Accurate Start and End Dates for a Given "YYYY-MM" Target Month
const getMonthDateRange = (monthStr) => {
  const [year, month] = monthStr.split('-').map(Number);
  const startDate = `${monthStr}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate, lastDay };
};

// System Notification Dispatcher
const logNotification = async ({ target_permission = 'all', title, message, type = 'info', link_url = '/' }) => {
  try {
    await supabase
      .from('app_notifications')
      .insert([{ target_permission, title, message, type, link_url, is_read: false }]);
  } catch (err) {
    console.error('[Notification Dispatch Warning]:', err.message);
  }
};

// Health Check Probe
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`
  });
});

// ============================================================================
// 3. INVENTORY & PRODUCT CATALOG APIs
// ============================================================================

// Fetch All Catalog Products (Chunked to bypass default batch limits)
app.get('/api/products', asyncHandler(async (req, res) => {
  let allProducts = [];
  let start = 0;
  const chunkSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })
      .range(start, start + chunkSize - 1);

    if (error) throw error;

    allProducts.push(...data);
    if (data.length < chunkSize) {
      hasMore = false;
    } else {
      start += chunkSize;
    }
  }

  res.status(200).json(allProducts);
}));

// Create Product Definition
app.post('/api/products', asyncHandler(async (req, res) => {
  const { name, sku, price, stock_quantity } = req.body;

  if (!name || !sku) {
    return res.status(400).json({ error: 'Product name and SKU are mandatory fields.' });
  }

  const { data, error } = await supabase
    .from('products')
    .insert([{
      name: name.trim(),
      sku: sku.trim().toUpperCase(),
      price: Math.max(0, Number(price) || 0),
      stock_quantity: Math.max(0, Number(stock_quantity) || 0)
    }])
    .select();

  if (error) throw error;
  res.status(201).json(data);
}));

// Update Product Definition
app.put('/api/products/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, sku, price, stock_quantity } = req.body;

  const { data, error } = await supabase
    .from('products')
    .update({
      name: name?.trim(),
      sku: sku?.trim().toUpperCase(),
      price: Math.max(0, Number(price) || 0),
      stock_quantity: Math.max(0, Number(stock_quantity) || 0)
    })
    .eq('id', id)
    .select();

  if (error) throw error;
  res.status(200).json(data);
}));

// Delete Product
app.delete('/api/products/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('products').delete().eq('id', id).select();

  if (error) throw error;
  res.status(200).json({ message: 'Product record deleted successfully.', data });
}));

// ============================================================================
// 4. POINT OF SALE (POS) & REVENUE LEDGER APIs
// ============================================================================

// Process Counter Transaction
app.post('/api/sales', asyncHandler(async (req, res) => {
  const {
    invoiceNumber,
    cartItems = [],
    subtotal = 0,
    tax = 0,
    totalAmount = 0,
    totalItems = 0
  } = req.body;

  if (!cartItems.length) {
    return res.status(400).json({ error: 'Cannot process a transaction with an empty cart.' });
  }

  const resolvedInvoiceNumber = invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;

  // 1. Record Master Invoice
  const { error: invoiceError } = await supabase
    .from('invoices')
    .insert([{
      invoice_number: resolvedInvoiceNumber,
      subtotal: Number(subtotal),
      tax: Number(tax),
      total_amount: Number(totalAmount),
      total_items: Number(totalItems) || cartItems.length,
      items: cartItems
    }]);

  if (invoiceError) throw invoiceError;

  // 2. Decrement Stock Quantities & Log Granular Line Items
  for (const item of cartItems) {
    const { data: currentProduct, error: fetchErr } = await supabase
      .from('products')
      .select('stock_quantity')
      .eq('id', item.id)
      .single();

    if (fetchErr || !currentProduct) {
      throw new Error(`Product "${item.name}" was not found in active inventory.`);
    }

    const currentStock = Number(currentProduct.stock_quantity) || 0;
    const remainingStock = Math.max(0, currentStock - Number(item.sellQuantity));
    const lineItemTotal = Number(item.price) * Number(item.sellQuantity);

    const { error: stockUpdateError } = await supabase
      .from('products')
      .update({ stock_quantity: remainingStock })
      .eq('id', item.id);

    if (stockUpdateError) throw stockUpdateError;

    const { error: salesLogError } = await supabase
      .from('sales')
      .insert([{
        product_name: item.name,
        sku: item.sku,
        quantity_sold: Number(item.sellQuantity),
        total_price: lineItemTotal
      }]);

    if (salesLogError) throw salesLogError;

    // Inventory Threshold Alerts
    if (remainingStock <= 0) {
      await logNotification({
        target_permission: 'inventory',
        title: 'Stock Out Alert',
        message: `${item.name} is completely sold out (0 units remaining).`,
        type: 'danger',
        link_url: '/low-stock'
      });
    } else if (remainingStock < 10) {
      await logNotification({
        target_permission: 'inventory',
        title: 'Low Stock Advisory',
        message: `${item.name} is running low on stock (${remainingStock} units remaining).`,
        type: 'warning',
        link_url: '/low-stock'
      });
    }
  }

  // Broadcast Notification to Accounts Team
  await logNotification({
    target_permission: 'ledger',
    title: 'POS Transaction Processed',
    message: `Invoice #${resolvedInvoiceNumber} recorded for Rs ${Number(totalAmount).toLocaleString()}.`,
    type: 'success',
    link_url: '/ledger'
  });

  res.status(201).json({
    message: 'Sale transaction processed successfully.',
    invoiceNumber: resolvedInvoiceNumber,
    totalAmount
  });
}));

// Fetch Invoices
app.get('/api/invoices', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Fetch Granular Line Item Sales
app.get('/api/sales', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('sales')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// ============================================================================
// 5. SUPPLIERS, PURCHASES & SETTLEMENTS APIs
// ============================================================================

// Fetch Suppliers Directory
app.get('/api/suppliers', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .order('name', { ascending: true });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Register Supplier
app.post('/api/suppliers', asyncHandler(async (req, res) => {
  const { name, contact_person, phone, email, address } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Supplier company name is required.' });
  }

  const { data, error } = await supabase
    .from('suppliers')
    .insert([{
      name: name.trim(),
      contact_person: contact_person?.trim() || '',
      phone: phone?.trim() || '',
      email: email?.trim() || '',
      address: address?.trim() || '',
      balance: 0
    }])
    .select();

  if (error) throw error;
  res.status(201).json(data[0]);
}));

// Fetch Purchase Consignments
app.get('/api/purchases', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Process Stock Inward Consignment
app.post('/api/purchases', asyncHandler(async (req, res) => {
  const {
    purchaseInvoiceNo,
    supplierId,
    supplierName,
    totalAmount,
    paidAmount,
    dueAmount,
    totalItems,
    items
  } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'Purchase consignment must contain at least one item.' });
  }

  // 1. Record Inward Purchase Bill
  const { error: purchaseError } = await supabase
    .from('purchases')
    .insert([{
      purchase_invoice_no: purchaseInvoiceNo.trim(),
      supplier_id: supplierId,
      supplier_name: supplierName,
      total_amount: Number(totalAmount),
      paid_amount: Number(paidAmount || 0),
      due_amount: Number(dueAmount || 0),
      total_items: Number(totalItems),
      items
    }]);

  if (purchaseError) throw purchaseError;

  // 2. Increment Stock Quantities in Warehouse
  for (const item of items) {
    const { data: prodData } = await supabase
      .from('products')
      .select('stock_quantity')
      .eq('id', item.productId)
      .single();

    const currentStock = prodData ? Number(prodData.stock_quantity) : 0;
    const newStock = currentStock + Number(item.quantity);

    const { error: stockUpdateError } = await supabase
      .from('products')
      .update({ stock_quantity: newStock })
      .eq('id', item.productId);

    if (stockUpdateError) throw stockUpdateError;
  }

  // 3. Update Supplier Payable Balance
  if (supplierId && Number(dueAmount) > 0) {
    const { data: supData } = await supabase
      .from('suppliers')
      .select('balance')
      .eq('id', supplierId)
      .single();

    const currentBalance = supData ? Number(supData.balance) : 0;
    const updatedBalance = currentBalance + Number(dueAmount);

    await supabase
      .from('suppliers')
      .update({ balance: updatedBalance })
      .eq('id', supplierId);
  }

  // Alert Warehouse Personnel
  await logNotification({
    target_permission: 'inventory',
    title: 'Inward Consignment Received',
    message: `Bill #${purchaseInvoiceNo} received from ${supplierName || 'vendor'}. Stock levels updated.`,
    type: 'info',
    link_url: '/inventory'
  });

  res.status(201).json({ message: 'Stock inward recorded and inventory balances incremented.' });
}));

// Fetch Supplier Payment Vouchers
app.get('/api/supplier-payments', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('supplier_payments')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Process Supplier Payment Disbursement (FIFO Bill Settlement)
// Process Supplier Payment Disbursement (Targeted Multi-Bill + FIFO Settlement)
app.post('/api/supplier-payments', asyncHandler(async (req, res) => {
  const { 
    supplierId, 
    amountPaid, 
    paymentMode, 
    paymentReferenceNo, 
    notes, 
    selectedBillIds = [] 
  } = req.body;
  
  const payAmt = Number(amountPaid);

  if (!supplierId || isNaN(payAmt) || payAmt <= 0) {
    return res.status(400).json({ error: 'Valid payment amount and supplier identification are required.' });
  }

  const { data: supplier, error: supErr } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', supplierId)
    .single();

  if (supErr || !supplier) {
    return res.status(404).json({ error: 'Supplier account not found.' });
  }

  const paymentRef = `PAY-${Date.now().toString().slice(-6)}`;

  // 1. Fetch Unpaid Bills & Settle Selected Bills First (Then FIFO for any remainder)
  const { data: unpaidPurchases, error: purErr } = await supabase
    .from('purchases')
    .select('*')
    .eq('supplier_id', supplierId)
    .gt('due_amount', 0)
    .order('created_at', { ascending: true });

  const settledBillsBreakdown = [];

  if (!purErr && unpaidPurchases && unpaidPurchases.length > 0) {
    let remainingToDeduct = payAmt;

    // Prioritize user-selected bills first; keep remaining bills in FIFO order
    const selectedSet = new Set((selectedBillIds || []).map(String));
    const prioritizedBills = [
      ...unpaidPurchases.filter(b => selectedSet.has(String(b.id))),
      ...unpaidPurchases.filter(b => !selectedSet.has(String(b.id)))
    ];

    for (const bill of prioritizedBills) {
      if (remainingToDeduct <= 0) break;

      const billDue = Number(bill.due_amount);
      const deduction = Math.min(billDue, remainingToDeduct);

      const newPaid = Number(bill.paid_amount || 0) + deduction;
      const newDue = billDue - deduction;

      await supabase
        .from('purchases')
        .update({ paid_amount: newPaid, due_amount: newDue })
        .eq('id', bill.id);

      settledBillsBreakdown.push(
        `${bill.purchase_invoice_no} (Rs ${deduction.toLocaleString()}${newDue === 0 ? ' - Cleared' : ' - Partial'})`
      );

      remainingToDeduct -= deduction;
    }
  }

  // Build permanent audit note showing exact bills settled
  const settlementAuditText = settledBillsBreakdown.length > 0
    ? `Bills Settled: ${settledBillsBreakdown.join(', ')}`
    : 'General Account Settlement';

  const finalNotes = notes?.trim()
    ? `${settlementAuditText} | Note: ${notes.trim()}`
    : settlementAuditText;

  // 2. Record Disbursement Voucher with Bill Allocation Audit
  const { error: payErr } = await supabase
    .from('supplier_payments')
    .insert([{
      payment_reference: paymentRef,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      amount_paid: payAmt,
      payment_mode: paymentMode || 'Cash',
      payment_reference_no: paymentReferenceNo || '',
      notes: finalNotes
    }]);

  if (payErr) throw payErr;

  // 3. Decrement Supplier Master Balance
  const currentBalance = Number(supplier.balance || 0);
  const updatedBalance = Math.max(0, currentBalance - payAmt);

  const { error: updateSupErr } = await supabase
    .from('suppliers')
    .update({ balance: updatedBalance })
    .eq('id', supplierId);

  if (updateSupErr) throw updateSupErr;

  await logNotification({
    target_permission: 'purchases',
    title: 'Supplier Settlement Disbursed',
    message: `Voucher #${paymentRef}: Rs ${payAmt.toLocaleString()} paid to ${supplier.name} (${settlementAuditText}).`,
    type: 'success',
    link_url: '/purchases'
  });

  res.status(201).json({
    message: 'Payment voucher logged and supplier bills settled.',
    paymentReference: paymentRef,
    settledBills: settledBillsBreakdown
  });
}));

// ============================================================================
// CRM LEADS PIPELINE APIs
// ============================================================================

// Fetch All CRM Leads
app.get('/api/crm/leads', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('crm_leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Create New Lead
app.post('/api/crm/leads', asyncHandler(async (req, res) => {
  const {
    title,
    client_name,
    company_name,
    phone,
    email,
    deal_value,
    stage,
    priority,
    assigned_to,
    notes
  } = req.body;

  if (!title || !client_name) {
    return res.status(400).json({ error: 'Lead title and client name are required.' });
  }

  const { data, error } = await supabase
    .from('crm_leads')
    .insert([{
      title: title.trim(),
      client_name: client_name.trim(),
      company_name: company_name?.trim() || '',
      phone: phone?.trim() || '',
      email: email?.trim() || '',
      deal_value: Math.max(0, Number(deal_value) || 0),
      stage: stage || 'new',
      priority: priority || 'medium',
      assigned_to: assigned_to || 'Unassigned',
      notes: notes || '',
      updated_at: new Date().toISOString()
    }])
    .select();

  if (error) throw error;

  await logNotification({
    target_permission: 'crm',
    title: 'New Commercial Opportunity',
    message: `Lead "${title}" created for ${client_name} (Value: Rs ${Number(deal_value || 0).toLocaleString()}).`,
    type: 'info',
    link_url: '/crm'
  });

  res.status(201).json(data[0]);
}));

// Update Lead Details
app.put('/api/crm/leads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title,
    client_name,
    company_name,
    phone,
    email,
    deal_value,
    stage,
    priority,
    assigned_to,
    notes
  } = req.body;

  const { data, error } = await supabase
    .from('crm_leads')
    .update({
      title: title?.trim(),
      client_name: client_name?.trim(),
      company_name: company_name?.trim() || '',
      phone: phone?.trim() || '',
      email: email?.trim() || '',
      deal_value: Math.max(0, Number(deal_value) || 0),
      stage: stage || 'new',
      priority: priority || 'medium',
      assigned_to: assigned_to || 'Unassigned',
      notes: notes || '',
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select();

  if (error) throw error;
  res.status(200).json({ message: 'Lead updated successfully.', lead: data[0] });
}));

// Quick Stage Transition (Move along pipeline stages)
app.put('/api/crm/leads/:id/stage', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { stage } = req.body;

  if (!stage) {
    return res.status(400).json({ error: 'Target stage is required.' });
  }

  const { data, error } = await supabase
    .from('crm_leads')
    .update({
      stage,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select();

  if (error) throw error;

  if (stage === 'won') {
    await logNotification({
      target_permission: 'crm',
      title: 'Deal Won & Closed!',
      message: `Commercial lead "${data[0].title}" was successfully closed for Rs ${Number(data[0].deal_value).toLocaleString()}.`,
      type: 'success',
      link_url: '/crm'
    });
  }

  res.status(200).json({ message: 'Pipeline stage updated successfully.', lead: data[0] });
}));

// Delete Lead Record
app.delete('/api/crm/leads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('crm_leads').delete().eq('id', id);

  if (error) throw error;
  res.status(200).json({ message: 'Lead record removed.' });
}));

// ============================================================================
// 6. NOTIFICATION SYSTEM APIs
// ============================================================================

// Fetch Recent Notifications
app.get('/api/notifications', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('app_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(40);

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Mark Single Notification Read
app.put('/api/notifications/:id/read', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase
    .from('app_notifications')
    .update({ is_read: true })
    .eq('id', id);

  if (error) throw error;
  res.status(200).json({ message: 'Notification marked as read.' });
}));

// Mark All Notifications Read
app.put('/api/notifications/mark-all-read', asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from('app_notifications')
    .update({ is_read: true })
    .eq('is_read', false);

  if (error) throw error;
  res.status(200).json({ message: 'All notifications marked as read.' });
}));

// ============================================================================
// 7. HOLIDAYS & SHIFT SETTINGS APIs
// ============================================================================

// Fetch Declared Holidays
app.get('/api/holidays', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('company_holidays')
    .select('*')
    .order('holiday_date', { ascending: false });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Declare Official Holiday
app.post('/api/holidays', asyncHandler(async (req, res) => {
  const { holiday_date, title } = req.body;

  if (!holiday_date || !title) {
    return res.status(400).json({ error: 'Both holiday date and description are required.' });
  }

  const { data, error } = await supabase
    .from('company_holidays')
    .insert([{ holiday_date, title: title.trim() }])
    .select();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'This calendar date is already designated as a holiday.' });
    }
    throw error;
  }

  // Retroactively excuse attendance records for that calendar day
  await supabase
    .from('staff_attendance')
    .update({
      is_excused: true,
      excuse_reason: `Official Company Holiday: ${title.trim()}`
    })
    .eq('date', holiday_date);

  res.status(201).json(data[0]);
}));

// Remove Holiday Declaration
app.delete('/api/holidays/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase
    .from('company_holidays')
    .delete()
    .eq('id', id);

  if (error) throw error;
  res.status(200).json({ message: 'Holiday declaration removed.' });
}));

// Fetch Shift Timing Policy Rules
app.get('/api/attendance/settings', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('attendance_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  res.status(200).json(data || DEFAULT_SHIFT_POLICY);
}));

// Update Shift Timing Policy Rules
app.put('/api/attendance/settings', asyncHandler(async (req, res) => {
  const { shift_start, grace_minutes, half_day_cutoff, absent_cutoff } = req.body;

  const payload = {
    id: 1,
    shift_start: shift_start || DEFAULT_SHIFT_POLICY.shift_start,
    grace_minutes: Number(grace_minutes) ?? DEFAULT_SHIFT_POLICY.grace_minutes,
    half_day_cutoff: half_day_cutoff || DEFAULT_SHIFT_POLICY.half_day_cutoff,
    absent_cutoff: absent_cutoff || DEFAULT_SHIFT_POLICY.absent_cutoff,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('attendance_settings')
    .upsert(payload)
    .select()
    .single();

  if (error) throw error;
  res.status(200).json({ message: 'Shift timing policy updated successfully.', data });
}));

// ============================================================================
// 8. STAFF ATTENDANCE APIs
// ============================================================================

// Operator Logout Check-Out Handler
app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User identifier is required for shift checkout.' });
  }

  const todayDate = new Date().toISOString().split('T')[0];
  const { data: attRecord } = await supabase
    .from('staff_attendance')
    .select('*')
    .eq('user_id', userId)
    .eq('date', todayDate)
    .maybeSingle();

  if (attRecord && attRecord.check_in) {
    const checkInTime = new Date(attRecord.check_in);
    const checkOutTime = new Date();
    const durationMinutes = Math.max(0, Math.round((checkOutTime - checkInTime) / (1000 * 60)));

    await supabase
      .from('staff_attendance')
      .update({
        check_out: checkOutTime.toISOString(),
        total_minutes: durationMinutes
      })
      .eq('id', attRecord.id);
  }

  res.status(200).json({ message: 'Shift checkout recorded successfully.' });
}));

// Query Attendance Logs
app.get('/api/attendance', asyncHandler(async (req, res) => {
  const { date } = req.query;

  let query = supabase
    .from('staff_attendance')
    .select('*')
    .order('date', { ascending: false })
    .order('check_in', { ascending: false });

  if (date) {
    query = query.eq('date', date);
  }

  const { data, error } = await query;
  if (error) throw error;
  res.status(200).json(data || []);
}));

// Manual Attendance Override / Excusal
app.put('/api/attendance/:id/override', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, is_excused, excuse_reason } = req.body;

  const { data, error } = await supabase
    .from('staff_attendance')
    .update({
      status: status || 'On Time',
      is_excused: is_excused ?? false,
      excuse_reason: excuse_reason || ''
    })
    .eq('id', id)
    .select();

  if (error) throw error;
  res.status(200).json({ message: 'Attendance status updated successfully.', data: data[0] });
}));

// Administrative Force Shift Closure
app.put('/api/attendance/:id/checkout', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data: attRecord, error: fetchErr } = await supabase
    .from('staff_attendance')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !attRecord) {
    return res.status(404).json({ error: 'Attendance entry not found.' });
  }

  const checkInTime = new Date(attRecord.check_in);
  const checkOutTime = new Date();
  const durationMinutes = Math.max(0, Math.round((checkOutTime - checkInTime) / (1000 * 60)));

  const { data, error } = await supabase
    .from('staff_attendance')
    .update({
      check_out: checkOutTime.toISOString(),
      total_minutes: durationMinutes
    })
    .eq('id', id)
    .select();

  if (error) throw error;
  res.status(200).json({ message: 'Shift closed manually by administrator.', data: data[0] });
}));

// ============================================================================
// 9. DYNAMIC PAYROLL ENGINE APIs
// ============================================================================

// Fetch Active Payroll Formula Rules
app.get('/api/payroll/rules', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('payroll_rules')
    .select('*')
    .eq('id', 1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  res.status(200).json(data || DEFAULT_PAYROLL_RULES);
}));

// Update Payroll Deduction Rules
app.put('/api/payroll/rules', asyncHandler(async (req, res) => {
  const { working_days, grace_lates, late_fine_amount, half_day_deduction_pct, absent_deduction_pct } = req.body;

  const payload = {
    id: 1,
    working_days: Number(working_days) || DEFAULT_PAYROLL_RULES.working_days,
    grace_lates: Number(grace_lates) ?? DEFAULT_PAYROLL_RULES.grace_lates,
    late_fine_amount: Number(late_fine_amount) ?? DEFAULT_PAYROLL_RULES.late_fine_amount,
    half_day_deduction_pct: Number(half_day_deduction_pct) ?? DEFAULT_PAYROLL_RULES.half_day_deduction_pct,
    absent_deduction_pct: Number(absent_deduction_pct) ?? DEFAULT_PAYROLL_RULES.absent_deduction_pct,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('payroll_rules')
    .upsert(payload)
    .select()
    .single();

  if (error) throw error;
  res.status(200).json({ message: 'Payroll rules updated successfully.', data });
}));

// Generate Full Monthly Salary Ledger Sheet
app.get('/api/payroll/sheet', asyncHandler(async (req, res) => {
  const { month } = req.query;
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  // Accurate month boundary resolution (prevents PostgreSQL out-of-range date crashes)
  const { startDate, endDate } = getMonthDateRange(targetMonth);

  // 1. Fetch System Rules
  const { data: rulesData } = await supabase
    .from('payroll_rules')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  const rules = rulesData || DEFAULT_PAYROLL_RULES;

  // 2. Fetch Active Staff Directory
  const { data: staffUsers, error: userErr } = await supabase
    .from('app_users')
    .select('id, username, full_name, role, base_salary, is_blocked')
    .order('id', { ascending: true });

  if (userErr) throw userErr;

  // 3. Fetch Monthly Attendance Logs
  const { data: monthAttendance, error: attErr } = await supabase
    .from('staff_attendance')
    .select('*')
    .gte('date', startDate)
    .lte('date', endDate);

  if (attErr) throw attErr;

  // 4. Fetch Monthly Declared Holidays
  const { data: holidays } = await supabase
    .from('company_holidays')
    .select('*')
    .gte('holiday_date', startDate)
    .lte('holiday_date', endDate);

  const holidayCount = holidays ? holidays.length : 0;

  // 5. Compute Mathematical Payroll Breakdown
  const salarySheet = staffUsers.map(user => {
    const baseSalary = Number(user.base_salary) || 0;
    const workingDays = Math.max(1, Number(rules.working_days) || 30);
    const dailyWage = Math.round(baseSalary / workingDays);

    const userLogs = (monthAttendance || []).filter(a => a.user_id === user.id);

    let onTimeCount = 0;
    let lateCount = 0;
    let unexcusedLateCount = 0;
    let halfDayCount = 0;
    let unexcusedHalfDayCount = 0;
    let absentCount = 0;
    let excusedCount = 0;

    userLogs.forEach(log => {
      if (log.is_excused) {
        excusedCount++;
      } else if (log.status === 'Late') {
        lateCount++;
        unexcusedLateCount++;
      } else if (log.status === 'Half Day') {
        halfDayCount++;
        unexcusedHalfDayCount++;
      } else if (log.status === 'Absent') {
        absentCount++;
      } else {
        onTimeCount++;
      }
    });

    // Deductions Evaluation:
    const chargeableLates = Math.max(0, unexcusedLateCount - rules.grace_lates);
    const lateDeduction = chargeableLates * Number(rules.late_fine_amount);
    const halfDayDeduction = Math.round(unexcusedHalfDayCount * (dailyWage * (rules.half_day_deduction_pct / 100)));
    const absentDeduction = Math.round(absentCount * (dailyWage * (rules.absent_deduction_pct / 100)));

    const totalDeductions = lateDeduction + halfDayDeduction + absentDeduction;
    const netSalary = Math.max(0, baseSalary - totalDeductions);

    return {
      user_id: user.id,
      operator_name: user.full_name || user.username,
      username: user.username,
      role: user.role,
      base_salary: baseSalary,
      daily_wage: dailyWage,
      total_logs: userLogs.length,
      on_time_count: onTimeCount,
      late_count: lateCount,
      chargeable_lates: chargeableLates,
      half_day_count: halfDayCount,
      absent_count: absentCount,
      excused_count: excusedCount,
      holiday_count: holidayCount,
      late_deduction: lateDeduction,
      half_day_deduction: halfDayDeduction,
      absent_deduction: absentDeduction,
      total_deductions: totalDeductions,
      net_salary: netSalary
    };
  });

  res.status(200).json({
    month: targetMonth,
    rules,
    holidays: holidays || [],
    sheet: salarySheet
  });
}));

// ============================================================================
// 10. AUTHENTICATION & ROLE-BASED ACCESS CONTROL (RBAC) APIs
// ============================================================================

// Operator Authentication & Dynamic Shift Initializer
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password credentials are required.' });
  }

  const { data: user, error } = await supabase
    .from('app_users')
    .select('id, username, password, full_name, role, permissions, is_blocked, base_salary')
    .ilike('username', username.trim())
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  if (user.is_blocked) {
    return res.status(403).json({
      error: 'This workstation account is suspended. Contact the system administrator.'
    });
  }

  if (user.password !== password.trim()) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Dynamic Shift & Auto-Resume Evaluation
  try {
    const todayDate = new Date().toISOString().split('T')[0];
    const { data: existingAttendance } = await supabase
      .from('staff_attendance')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', todayDate)
      .maybeSingle();

    if (!existingAttendance) {
      // 1. Fetch Dynamic Shift Policy
      const { data: shiftConfig } = await supabase
        .from('attendance_settings')
        .select('*')
        .eq('id', 1)
        .maybeSingle();

      const config = shiftConfig || DEFAULT_SHIFT_POLICY;

      const now = new Date();
      const currentTotalMins = now.getHours() * 60 + now.getMinutes();

      const shiftStartMins = parseTimeToMinutes(config.shift_start || DEFAULT_SHIFT_POLICY.shift_start);
      const graceLimitMins = shiftStartMins + Number(config.grace_minutes || DEFAULT_SHIFT_POLICY.grace_minutes);
      const halfDayLimitMins = parseTimeToMinutes(config.half_day_cutoff || DEFAULT_SHIFT_POLICY.half_day_cutoff);
      const absentLimitMins = parseTimeToMinutes(config.absent_cutoff || DEFAULT_SHIFT_POLICY.absent_cutoff);

      let shiftStatus = 'On Time';
      if (currentTotalMins > absentLimitMins) {
        shiftStatus = 'Absent';
      } else if (currentTotalMins > halfDayLimitMins) {
        shiftStatus = 'Half Day';
      } else if (currentTotalMins > graceLimitMins) {
        shiftStatus = 'Late';
      }

      // Check for Declared Company/Government Holiday
      const { data: todayHoliday } = await supabase
        .from('company_holidays')
        .select('*')
        .eq('holiday_date', todayDate)
        .maybeSingle();

      await supabase
        .from('staff_attendance')
        .insert([{
          user_id: user.id,
          operator_name: user.full_name || user.username,
          date: todayDate,
          check_in: now.toISOString(),
          status: shiftStatus,
          is_excused: Boolean(todayHoliday),
          excuse_reason: todayHoliday ? `Official Holiday: ${todayHoliday.title}` : ''
        }]);

    } else if (existingAttendance.check_out) {
      // Auto-Resume Safety Net: Reactivate previously closed shift on same-day re-login
      await supabase
        .from('staff_attendance')
        .update({
          check_out: null,
          total_minutes: 0
        })
        .eq('id', existingAttendance.id);

      console.log(`[Shift Resumed]: Shift reactivated for operator ${user.full_name || user.username}`);
    }
  } catch (attErr) {
    console.error('[Attendance Evaluation Warning]:', attErr.message);
  }

  const { password: _, ...userSession } = user;
  res.status(200).json({
    message: 'Authentication successful.',
    user: userSession
  });
}));

// Fetch Staff Directory (Includes base_salary)
app.get('/api/users', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('app_users')
    .select('id, username, full_name, role, permissions, is_blocked, base_salary, created_at')
    .order('id', { ascending: true });

  if (error) throw error;
  res.status(200).json(data || []);
}));

// Register Operator Account
app.post('/api/users', asyncHandler(async (req, res) => {
  const { username, password, full_name, role, permissions, base_salary } = req.body;

  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Username, password, and full name are required.' });
  }

  const { data, error } = await supabase
    .from('app_users')
    .insert([{
      username: username.toLowerCase().trim(),
      password: password.trim(),
      full_name: full_name.trim(),
      role: role || 'staff',
      permissions: permissions || [],
      base_salary: Math.max(0, Number(base_salary) || 0),
      is_blocked: false
    }])
    .select('id, username, full_name, role, permissions, is_blocked, base_salary, created_at');

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'This username is already allocated to another operator.' });
    }
    throw error;
  }

  await logNotification({
    target_permission: 'all',
    title: 'New Operator Registered',
    message: `Account "@${username}" was provisioned for ${full_name}.`,
    type: 'info',
    link_url: '/users'
  });

  res.status(201).json(data[0]);
}));

// Update Operator Account
app.put('/api/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { full_name, password, permissions, is_blocked, base_salary } = req.body;

  const updatePayload = {
    full_name: full_name?.trim(),
    permissions: permissions || [],
    is_blocked: is_blocked ?? false,
    base_salary: Math.max(0, Number(base_salary) || 0)
  };

  if (password && password.trim() !== '') {
    updatePayload.password = password.trim();
  }

  const { data, error } = await supabase
    .from('app_users')
    .update(updatePayload)
    .eq('id', id)
    .select('id, username, full_name, role, permissions, is_blocked, base_salary, created_at');

  if (error) throw error;
  res.status(200).json({ message: 'Operator account updated successfully.', user: data[0] });
}));

// Update Profile & Security
app.put('/api/users/profile/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { full_name, currentPassword, newPassword } = req.body;

  const { data: user, error: fetchErr } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !user) {
    return res.status(404).json({ error: 'Operator profile not found.' });
  }

  const updatePayload = {};

  if (full_name && full_name.trim() !== '') {
    updatePayload.full_name = full_name.trim();
  }

  if (newPassword && newPassword.trim() !== '') {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password verification is required to authorize changes.' });
    }

    if (user.password !== currentPassword.trim()) {
      return res.status(400).json({ error: 'Current password verification failed.' });
    }

    if (newPassword.trim().length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }

    updatePayload.password = newPassword.trim();
  }

  if (Object.keys(updatePayload).length === 0) {
    return res.status(400).json({ error: 'No profile modifications provided.' });
  }

  const { data: updatedData, error: updateErr } = await supabase
    .from('app_users')
    .update(updatePayload)
    .eq('id', id)
    .select('id, username, full_name, role, permissions, is_blocked, base_salary, created_at');

  if (updateErr) throw updateErr;

  res.status(200).json({
    message: 'Profile credentials updated successfully.',
    user: updatedData[0]
  });
}));

// Delete Operator Account
app.delete('/api/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('app_users').delete().eq('id', id);

  if (error) throw error;
  res.status(200).json({ message: 'Operator account deleted successfully.' });
}));

// ============================================================================
// 11. CENTRALIZED ERROR HANDLING & UNMATCHED ROUTES
// ============================================================================

// 404 Not Found Handler
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(`[Unhandled Server Error] ${req.method} ${req.url}:`, err.message || err);

  const statusCode = err.status || 500;
  const errorMessage = err.message || 'An unexpected internal server error occurred.';

  res.status(statusCode).json({ error: errorMessage });
});

// ============================================================================
// 12. SERVER INITIALIZATION & GRACEFUL SHUTDOWN
// ============================================================================
const server = app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`[Enterprise ERP Gateway] Online & Listening on Port: ${PORT}`);
  console.log(`[Services Active] POS, Ledger, Inventory, Shift Engine & Payroll`);
  console.log('================================================================');
});

// Graceful Termination Handlers
const handleShutdown = (signal) => {
  console.log(`\n[Shutdown Signal Received: ${signal}]. Closing HTTP gateway gracefully...`);
  server.close(() => {
    console.log('[Enterprise ERP Gateway] Server closed. Safe exit complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));