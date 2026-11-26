'use strict';
process.removeAllListeners('warning');
const { open } = require('../src/db');
const { seedRules } = require('../src/rules');
const { createChart } = require('../src/coa');
const { accountMap, postJournal, linesForDocument } = require('../src/ledger');
const { validateDocument, inputVatAllowed } = require('../src/validate');
const { parseMoney: P } = require('../src/money');

function makeDb() { const db = open(':memory:'); seedRules(db); return db; }

function makeClient(db, over = {}) {
  const c = { reg_name: 'Test Co', tin: '111-222-333', taxpayer_type: 'corporation', vat_status: 'VAT', income_regime: 'rcit', deduction: 'itemized', fy_end_month: 12, size: 'medium', tax_types: 'VAT,IT', ...over };
  const cols = Object.keys(c);
  c.id = Number(db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k])).lastInsertRowid);
  c.branch = '000';
  createChart(db, c.id, c.taxpayer_type, c.vat_status === 'VAT');
  return c;
}

// Insert + post a document the way the app does. Amounts in pesos for readability.
function doc(db, c, d) {
  const A = accountMap(db, c.id);
  const x = { doc_type: 'invoice', payment: 'cash', party_vat_registered: 1, party_tin: '999-888-777-000', vatable: 0, vat: 0, exempt: 0, zero_rated: 0, ...d };
  for (const k of ['vatable', 'vat', 'exempt', 'zero_rated', 'total']) x[k] = P(x[k]);
  if (!x.total) x.total = x.vatable + x.vat + x.exempt + x.zero_rated;
  x.party_name = x.party_name || 'Party';
  x.doc_no = x.doc_no || String(Math.random()).slice(2, 10);
  x.account_id = A[x.account || (x.kind === 'sale' ? '4010' : '6190')].id;
  x.flags = validateDocument(db, c, x);
  x.input_vat_allowed = inputVatAllowed(c, x) ? 1 : 0;
  x.id = Number(db.prepare(`INSERT INTO documents (client_id, kind, doc_type, doc_no, doc_date, party_name, party_tin, vatable, vat, exempt, zero_rated, total, party_vat_registered, input_vat_allowed, account_id, payment, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'posted')`).run(c.id, x.kind, x.doc_type, x.doc_no, x.doc_date, x.party_name, x.party_tin, x.vatable, x.vat, x.exempt, x.zero_rated, x.total, x.party_vat_registered, x.input_vat_allowed, x.account_id, x.payment).lastInsertRowid);
  postJournal(db, { client_id: c.id, date: x.doc_date, ref: x.doc_no, source: x.kind, document_id: x.id, lines: linesForDocument(db, c, x) });
  return x;
}

module.exports = { makeDb, makeClient, doc, P };
