'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','accountant','encoder')),
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, reg_name TEXT NOT NULL, trade_name TEXT, tin TEXT NOT NULL, branch TEXT DEFAULT '000',
  rdo TEXT, address TEXT, psic TEXT,
  taxpayer_type TEXT NOT NULL CHECK (taxpayer_type IN ('individual','corporation','opc','partnership','gpp','nonstock','cooperative')),
  vat_status TEXT NOT NULL CHECK (vat_status IN ('VAT','NONVAT')),
  income_regime TEXT NOT NULL CHECK (income_regime IN ('graduated','8pct','rcit','small_corp','exempt')),
  deduction TEXT NOT NULL DEFAULT 'itemized' CHECK (deduction IN ('itemized','osd')),
  fy_end_month INTEGER NOT NULL DEFAULT 12, accounting_method TEXT DEFAULT 'accrual',
  books_type TEXT DEFAULT 'loose-leaf', size TEXT DEFAULT 'micro' CHECK (size IN ('micro','small','medium','large')),
  withholding_agent INTEGER NOT NULL DEFAULT 0, ops_start_year INTEGER,
  tax_types TEXT NOT NULL DEFAULT '', contact TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS client_staff (
  client_id INTEGER NOT NULL REFERENCES clients(id), user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (client_id, user_id));
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), code TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  active INTEGER NOT NULL DEFAULT 1, UNIQUE (client_id, code));
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('supplier','customer')), name TEXT NOT NULL, tin TEXT, address TEXT,
  vat_registered INTEGER NOT NULL DEFAULT 1, default_account_id INTEGER REFERENCES accounts(id), last_used TEXT);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('sale','purchase')),
  doc_type TEXT NOT NULL DEFAULT 'invoice', doc_no TEXT, doc_date TEXT, period TEXT,
  party_id INTEGER REFERENCES parties(id), party_name TEXT, party_tin TEXT, party_address TEXT,
  vatable INTEGER NOT NULL DEFAULT 0, vat INTEGER NOT NULL DEFAULT 0, exempt INTEGER NOT NULL DEFAULT 0,
  zero_rated INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  party_vat_registered INTEGER NOT NULL DEFAULT 1, input_vat_allowed INTEGER NOT NULL DEFAULT 1, personal INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id), payment TEXT NOT NULL DEFAULT 'cash', description TEXT,
  status TEXT NOT NULL DEFAULT 'encoded'
    CHECK (status IN ('for_encoding','encoded','rejected','for_review','approved','posted','reversed')),
  reject_reason TEXT, flags TEXT NOT NULL DEFAULT '[]', file_path TEXT, file_name TEXT, file_type TEXT,
  created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
  journal_id INTEGER REFERENCES journals(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_docs_client ON documents(client_id, status, doc_date);
CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), date TEXT NOT NULL,
  ref TEXT, memo TEXT, source TEXT NOT NULL DEFAULT 'manual', document_id INTEGER, reversal_of INTEGER REFERENCES journals(id),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_journals_client ON journals(client_id, date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL REFERENCES journals(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0), credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0)));
-- Posted journal lines can never be changed or deleted (reverse instead).
CREATE TRIGGER IF NOT EXISTS no_update_lines BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'Posted entries cannot be edited; reverse them'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_lines BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'Posted entries cannot be deleted; reverse them'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_journals BEFORE DELETE ON journals BEGIN SELECT RAISE(ABORT, 'Posted entries cannot be deleted; reverse them'); END;
CREATE TABLE IF NOT EXISTS period_locks (
  client_id INTEGER NOT NULL REFERENCES clients(id), period TEXT NOT NULL, locked_by INTEGER, reason TEXT,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (client_id, period));
CREATE TABLE IF NOT EXISTS filings (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), form TEXT NOT NULL, period_label TEXT NOT NULL,
  period_end TEXT, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','filed')),
  filed_date TEXT, reference TEXT, amount_paid INTEGER, notes TEXT, UNIQUE (client_id, form, period_label));
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  legal_basis TEXT NOT NULL, notes TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_rules_key ON rules(key, effective_from);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, user_id INTEGER, client_id INTEGER, entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL,
  before TEXT, after TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TRIGGER IF NOT EXISTS no_update_audit BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'Audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_audit BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'Audit log is append-only'); END;
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function audit(db, { user_id, client_id, entity, entity_id, action, before, after }) {
  db.prepare('INSERT INTO audit (user_id, client_id, entity, entity_id, action, before, after) VALUES (?,?,?,?,?,?,?)')
    .run(user_id ?? null, client_id ?? null, entity, entity_id ?? null, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

module.exports = { open, tx, audit };
