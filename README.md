# L2C Books & Tax — MVP

A web app for **L2C Tax and Accounting Services** that takes a client's receipts and invoices all the way to books of accounts, financial statements, BIR tax worksheets and a filing calendar. Works on a laptop and on a phone (it can be installed to the home screen).

> **Status: quick MVP, not deployed.** It runs on one computer with a single database file. Read "What's NOT in the MVP yet" before using it for real client work.

## What it does today

| Area | What you can do |
|---|---|
| **Staff & roles** | Admin/Owner, Accountant/Reviewer, Encoder. Staff only see clients assigned to them. Session times out after 30 min idle; 5 wrong passwords = 5‑minute lockout. |
| **Client profiles** | Registered/trade name, TIN + branch, RDO, address, PSIC, taxpayer type (sole prop, corp, OPC, partnership, GPP, non‑stock, coop), VAT / non‑VAT, income tax regime (graduated, 8%, RCIT, small corp 20%, exempt), OSD vs itemized, fiscal year end, size (micro/small/medium/large per EOPT), registered tax types. |
| **Chart of accounts** | Created automatically per client type and VAT status; you can add accounts. |
| **Encoding** | Fast sale/expense forms: type the TOTAL and VAT is split automatically (12/112). Supplier/customer list remembers TIN, address and usual account. "Save & add another" for speed. Camera / photo / PDF attachment. Bulk photo upload → each photo waits "For encoding" beside a form. |
| **BIR proof checks** | Missing/invalid TIN, missing invoice no./date, date outside the period, duplicate (same TIN + number), totals that don't add up, VAT not 12%, **Official Receipt used for input VAT (EOPT)**, VAT from a non‑VAT supplier, non‑VAT client charging VAT, personal expenses, EAR limit reminder. Errors block review; warnings are shown to the reviewer. |
| **Workflow** | For encoding → Encoded → For review → Approved → Posted (or Returned with a reason). Posted entries can't be edited or deleted — only reversed. Every action is in the audit log (who, when, before/after). |
| **Accounting engine** | Double entry; debits must equal credits; amounts stored as whole centavos (no rounding drift). Manual journal entries for adjustments, depreciation, opening balances, payroll, closing. **Period locking** by admin with a logged reason. |
| **Books of accounts** | General Journal, General Ledger, Sales Journal, Purchase Journal, Cash Receipts, Cash Disbursements, AR/AP subsidiary ledgers, Trial Balance. VAT clients get VATable/exempt/zero‑rated/VAT columns; non‑VAT clients get gross amounts. Header with name, TIN, address, book name and period. **Print → Save as PDF**, or **Download Excel (CSV)**. |
| **Financial statements** | Statement of Financial Position, Statement of Comprehensive Income (Statement of Activities for non‑stock), Statement of Changes in Equity — with prior‑year comparative column. |
| **Tax worksheets** | **2550Q** VAT (output, input, carry‑over, disallowed input VAT), **2551Q** percentage tax, **1701Q/1701/1701A** (graduated with OSD or itemized, or 8%), **1702Q/1702‑RT** (RCIT, 20% small corp, MCIT comparison). Cumulative quarterly with prior‑quarter payments and 2307 credits (account 1310). Plus a **plain‑language summary** you can send to the client. |
| **Compliance calendar** | Built from each client's tax types and fiscal year: 2550Q, 2551Q, 1701Q/1702Q, annual ITR, 0619‑E, 1601‑EQ, 1604‑E, 1601‑C, 1604‑C. Dashboard shows overdue / due today / next 14 days, missing‑record alerts ("no sales encoded for October", "documents not posted after 7 days") and staff workload. Mark filed with date, reference no. and amount. |
| **Penalty estimator** | Surcharge + interest, with EOPT reduced rates for micro/small taxpayers. |
| **Tax rule tables** | Every rate, threshold and deadline is stored with an effective date and legal basis. Add a new version from the **Tax rules** screen — no programming needed. Old periods keep using old rules. |

## What's NOT in the MVP yet (next phases)

- **BIR .DAT files** (SLS/SLP, QAP, SAWT, alphalists) + validator
- **AI receipt reading (OCR)** — photos are stored and shown, but you type the fields
- **Excel/CSV/POS import** with column mapping
- **EWT per ATC + Form 2307**, withholding on compensation, **payroll**, 1601‑C/1604‑C/2316 computations (the calendar already tracks these deadlines)
- Statement of Cash Flows, Notes to FS, closing entries wizard
- Email/SMS reminders, 2FA, password change screen, one‑click per‑client export (ZIP)
- Public holidays in deadline calculation (only weekends are rolled forward today)
- Capital goods input VAT amortization

## How to run it on a computer

You need **Node.js 22.13 or newer** (free, from nodejs.org).

```bash
npm install          # one time
npm run seed         # optional: loads 5 demo clients (wipes nothing unless you add -- --force)
npm start            # open http://localhost:3000
```

Demo logins (after `npm run seed`): `admin / DemoAdmin2026` (owner), `maria / DemoMaria2026` (accountant), `jun / DemoJun2026` (encoder).
Without demo data, the first start prints a random admin password in the terminal (or set `ADMIN_PASSWORD=...`).

Run the automated tests: `npm test` (29 tests — tax worked examples, rounding, posting rules, books tying out to the trial balance, role/isolation checks, the full encode→post workflow).

Settings (environment variables): `PORT` (default 3000), `DB_PATH` (default `data/l2c.db`), `UPLOAD_DIR` (default `data/uploads`), `NODE_ENV=production` (marks the login cookie HTTPS‑only).

## Demo clients

1. **Bayanihan Trading Corporation** — VAT corporation, RCIT/MCIT, withholding agent
2. **Nena Cruz (Aling Nena's Sari‑Sari Store)** — non‑VAT sole proprietor, graduated + OSD, percentage tax (Q3 left **overdue** on purpose)
3. **Atty. Jose Reyes** — professional on the **8% option**
4. **Santos & Lim Architects** — general professional partnership (non‑VAT)
5. **Kapitbahay Foundation, Inc.** — non‑stock, non‑profit

## Backups

`npm run backup` makes a consistent copy of the database plus all uploaded receipts into `backups/<date-time>/`. Schedule it daily (e.g. cron `0 2 * * * cd /app && npm run backup`) and copy the `backups` folder off the server (Google Drive, S3, etc.).

## Updating tax rules (no programming)

1. Log in as admin → **Tax rules**.
2. Pick the key (e.g. `pt.rate`), enter the **effective from** date, the value, and the legal basis (RR/RMC number).
3. Money is in **centavos** (₱3,000,000 = `300000000`); rates are **parts per million** (12% = `120000`, 3% = `30000`).
4. Don't edit old versions — add a new one. Quarters before the new date keep the old answer.

## Deploying (when you're ready — not done yet)

Cheapest path for this MVP: one small cloud server (DigitalOcean / Hetzner / Linode, ~US$5–7 ≈ ₱300–400/month) or Railway/Render with a persistent disk (~US$7–10/month), behind HTTPS. See `DECISIONS.md` for the planned move to PostgreSQL + cloud file storage.
