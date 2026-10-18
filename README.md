# ⚙️ Sheikh's Enterprise ERP & POS System (Backend API)

Welcome to the **Backend Server & RESTful API** of **Sheikh's Enterprise ERP & Point of Sale (POS) System** — a robust and secure server architecture built to handle core business logic, database transactions, inventory synchronization, and role-based access control (RBAC).

---

## 🌟 What is this Project?
This repository houses the **Node.js & Express.js backend** that powers Sheikh's Enterprise ERP. It connects directly with a Supabase PostgreSQL database to manage real-time inventory updates, automated sales processing, purchase orders, vendor payables, employee attendance tracking, and monthly payroll calculations.

---

## 🛠️ Core Backend Modules & API Logic

1. **🔒 Authentication & RBAC Engine:**
   - Secure operator login and session validation.
   - Role-based permission verification for staff and administrators.

2. **⚡ POS & Sales Processing:**
   - Handles retail checkout transactions and generates unique invoice numbers.
   - Automatically updates and deducts stock quantities from inventory upon sale completion.

3. **📦 Inventory & Supply Chain Management:**
   - Real-time product catalog synchronization.
   - Low-stock alert monitoring and vendor purchase order logging.

4. **👥 HR, Attendance & Payroll:**
   - Shift clock-in and clock-out timestamp recording.
   - Automated salary calculation and monthly payroll ledger generation.

---

## 🛠️ Technology Stack
- **Runtime Environment:** Node.js
- **Framework:** Express.js
- **Database & Client:** Supabase (PostgreSQL Database)
- **Middleware:** CORS, Dotenv, Express JSON Parser

---

## ⚙️ Local Development Setup

To run this backend server locally on your machine, follow these steps:

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your computer.

### 1. Clone the Repository
```bash
git clone [https://github.com/sheikhnuml/ERP-System-Backend.git](https://github.com/sheikhnuml/ERP-System-Backend.git)
cd ERP-System-Backend
