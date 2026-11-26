'use strict';
// Demo data: 5 clients (VAT corp, non-VAT sole prop, 8% professional, partnership, non-stock)
process.removeAllListeners('warning');
const path = require('path');
const fs = require('fs');
const { open } = require('./db');
const { seedRules } = require('./rules');
const { createUser } = require('./auth');
const { createChart } = require('./coa');
const { validateDocument, inputVatAllowed, hasErrors } = require('./validate');
const { postJournal, linesForDocument, accountMap } = require('./ledger');
const { splitVatInclusive } = require('./money');
const { generateFilings } = require('./calendar');
const { iso, lastDay } = require('./dates');

function seed(db, { year = 2026, months = 10 } = {}) {
  seedRules(db);
  const users = {
    admin: createUser(db, { username: 'admin', name: 'Lita (Owner)', role: 'admin', password: 'DemoAdmin2026' }),
    acct: createUser(db, { username: 'maria', name: 'Maria Santos', role: 'accountant', password: 'DemoMaria2026' }),
    enc: createUser(db, { username: 'jun', name: 'Jun Reyes', role: 'encoder', password: 'DemoJun2026' }),
  };
  const clients = [
    { reg_name: 'Bayanihan Trading Corporation', trade_name: 'Bayanihan Hardware', tin: '009-123-456', rdo: '044', address: '12 Rizal Ave., Taguig City', psic: '4752 Retail sale of hardware', taxpayer_type: 'corporation', vat_status: 'VAT', income_regime: 'rcit', deduction: 'itemized', size: 'small', withholding_agent: 1, ops_start_year: 2016, tax_types: 'VAT,IT,EWT,WTC', contact: 'Mr. Ramon Tan · 0917 000 0001', scale: 400 },
    { reg_name: 'Nena Cruz', trade_name: "Aling Nena's Sari-Sari Store", tin: '301-222-333', rdo: '039', address: '45 Mabini St., Quezon City', psic: '4711 Retail (sari-sari)', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', deduction: 'osd', size: 'micro', tax_types: 'PT,IT', contact: '0918 000 0002', scale: 60 },
    { reg_name: 'Jose Reyes', trade_name: 'Atty. Jose Reyes Law Office', tin: '402-555-666', rdo: '050', address: 'Unit 5, Legaspi Towers, Makati City', psic: '6910 Legal activities', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: '8pct', deduction: 'osd', size: 'micro', tax_types: 'IT', contact: '0919 000 0003', scale: 90 },
    { reg_name: 'Santos & Lim Architects', trade_name: '', tin: '503-777-888', rdo: '047', address: '88 Kalayaan Ave., Quezon City', psic: '7110 Architectural activities', taxpayer_type: 'gpp', vat_status: 'NONVAT', income_regime: 'exempt', deduction: 'itemized', size: 'micro', withholding_agent: 1, tax_types: 'PT,IT,EWT', contact: 'Arch. Lim · 0920 000 0004', scale: 120 },
    { reg_name: 'Kapitbahay Foundation, Inc.', trade_name: '', tin: '604-888-999', rdo: '043', address: '7 Pasig Blvd., Pasig City', psic: '9499 Civic organizations', taxpayer_type: 'nonstock', vat_status: 'NONVAT', income_regime: 'exempt', deduction: 'itemized', size: 'micro', withholding_agent: 1, tax_types: 'IT,EWT,WTC', contact: 'Ms. Grace Uy · 0921 000 0005', scale: 50 },
  ];
  let r = 7;
  const rnd = (a, b) => { r = (r * 16807) % 2147483647; return a + (r % (b - a + 1)); };
  const SUPPLIERS = [
    { name: 'Meralco', tin: '000-101-528-000', vat: 1, acct: '6030' }, { name: 'PLDT Inc.', tin: '000-488-793-000', vat: 1, acct: '6110' },
    { name: 'National Book Store', tin: '000-161-217-000', vat: 1, acct: '6040' }, { name: 'Petron Station EDSA', tin: '000-168-801-000', vat: 1, acct: '6120' },
    { name: 'Mang Tomas Carinderia', tin: '412-345-678-000', vat: 0, acct: '6060' }, { name: 'JRS Building Lessor', tin: '205-111-222-000', vat: 1, acct: '6020' },
  ];
  const CUSTOMERS = ['Juan dela Cruz', 'ABC Builders Inc.', 'Walk-in customer', 'XYZ Realty Corp.', 'Barangay San Roque'];

  for (const c of clients) {
    const scale = c.scale; delete c.scale;
    const cols = Object.keys(c);
    const id = Number(db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k])).lastInsertRowid);
    c.id = id; c.branch = '000'; c.fy_end_month = 12;
    createChart(db, id, c.taxpayer_type, c.vat_status === 'VAT');
    for (const u of [users.acct, users.enc]) db.prepare('INSERT INTO client_staff VALUES (?,?)').run(id, u);
    const A = accountMap(db, id);
    // Opening balances
    postJournal(db, { client_id: id, date: `${year}-01-01`, ref: 'OB', memo: 'Opening balances', source: 'opening', user_id: users.acct, lines: [
      { account_id: A['1020'].id, debit: scale * 100000 * 5 }, { account_id: A['1500'].id, debit: scale * 100000 * 3 },
      { account_id: A['3010'].id, credit: scale * 100000 * 8 }] });
    const parties = {};
    for (const s of SUPPLIERS) parties[s.name] = Number(db.prepare('INSERT INTO parties (client_id, kind, name, tin, vat_registered, default_account_id) VALUES (?,?,?,?,?,?)').run(id, 'supplier', s.name, s.tin, s.vat, A[s.acct].id).lastInsertRowid);
    let inv = 1000;
    const add = (d, status = 'posted') => {
      const flags = validateDocument(db, c, d);
      d.input_vat_allowed = inputVatAllowed(c, d) ? 1 : 0;
      const ins = db.prepare(`INSERT INTO documents (client_id, kind, doc_type, doc_no, doc_date, period, party_name, party_tin, vatable, vat, exempt, zero_rated, total, party_vat_registered, input_vat_allowed, account_id, payment, description, status, flags, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, d.kind, d.doc_type, d.doc_no, d.doc_date, d.doc_date.slice(0, 7), d.party_name, d.party_tin, d.vatable, d.vat, d.exempt, d.zero_rated, d.total, d.party_vat_registered, d.input_vat_allowed, d.account_id, d.payment, d.description || null, status === 'posted' ? 'approved' : status, JSON.stringify(flags), users.enc, d.doc_date + ' 09:00:00');
      const docId = Number(ins.lastInsertRowid);
      if (status === 'posted' && !hasErrors(flags)) {
        const jid = postJournal(db, { client_id: id, date: d.doc_date, ref: `${d.kind === 'sale' ? 'SI' : 'PV'}-${d.doc_no}`, memo: d.party_name, source: d.kind === 'sale' ? 'sales' : 'purchases', document_id: docId, lines: linesForDocument(db, c, d), user_id: users.acct });
        db.prepare("UPDATE documents SET status = 'posted', journal_id = ?, approved_by = ? WHERE id = ?").run(jid, users.acct, docId);
      }
    };
    for (let m = 1; m <= months; m++) {
      const md = (d) => iso(year, m, Math.min(d, lastDay(year, m)));
      for (let k = 0; k < 4; k++) {
        const total = scale * rnd(300, 1500) * 100;
        const vat = c.vat_status === 'VAT' ? splitVatInclusive(total, 120000) : null;
        const cust = CUSTOMERS[rnd(0, CUSTOMERS.length - 1)];
        add({ kind: 'sale', doc_type: 'invoice', doc_no: String(inv++), doc_date: md(3 + k * 7), party_name: cust, party_tin: cust.includes('Inc') || cust.includes('Corp') ? '123-456-789-000' : null,
          vatable: vat ? vat.net : 0, vat: vat ? vat.vat : 0, exempt: vat ? 0 : total, zero_rated: 0, total, party_vat_registered: 1, account_id: A['4010'].id, payment: k === 3 ? 'credit' : 'cash' });
      }
      for (const s of SUPPLIERS) {
        if (s.acct === '6060' && m % 3) continue;
        const total = Math.round(scale * rnd(20, 120)) * 100 * (s.acct === '6020' ? 4 : 1);
        const vatOn = s.vat && c.vat_status === 'VAT';
        const sp = splitVatInclusive(total, 120000);
        add({ kind: 'purchase', doc_type: 'invoice', doc_no: `${s.name.slice(0, 3).toUpperCase()}-${year}${String(m).padStart(2, '0')}`, doc_date: md(rnd(5, 26)), party_name: s.name, party_tin: s.tin,
          vatable: vatOn || s.vat ? sp.net : 0, vat: vatOn || s.vat ? sp.vat : 0, exempt: s.vat ? 0 : total, zero_rated: 0, total, party_vat_registered: s.vat, account_id: A[s.acct].id, payment: 'cash' });
      }
      if (c.taxpayer_type !== 'nonstock' && c.income_regime !== '8pct') {
        // cost of sales ≈ 55-65% of the month's sales
        const monthSales = db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM documents WHERE client_id = ? AND kind = 'sale' AND substr(doc_date,1,7) = ?").get(id, md(1).slice(0, 7)).t;
        const total = Math.round((monthSales * rnd(55, 65)) / 10000) * 100; const sp = splitVatInclusive(total, 120000);
        add({ kind: 'purchase', doc_type: 'invoice', doc_no: `INV-${year}${m}`, doc_date: md(15), party_name: 'Metro Wholesale Supply Inc.', party_tin: '007-555-123-000', vatable: sp.net, vat: sp.vat, exempt: 0, zero_rated: 0, total, party_vat_registered: 1, account_id: A['5010'].id, payment: 'credit' });
      }
    }
    // A few documents still in the workflow
    const m = months + 1;
    add({ kind: 'purchase', doc_type: 'or', doc_no: 'OR-5521', doc_date: iso(year, m, 4), party_name: 'National Book Store', party_tin: '000-161-217-000', vatable: 89286, vat: 10714, exempt: 0, zero_rated: 0, total: 100000, party_vat_registered: 1, account_id: A['6040'].id, payment: 'cash' }, 'for_review');
    add({ kind: 'sale', doc_type: 'invoice', doc_no: String(inv++), doc_date: iso(year, m, 6), party_name: 'Juan dela Cruz', party_tin: null, vatable: 0, vat: 0, exempt: 500000, zero_rated: 0, total: 500000, party_vat_registered: 1, account_id: A['4010'].id, payment: 'cash',
      ...(c.vat_status === 'VAT' ? { vatable: 446429, vat: 53571, exempt: 0 } : {}) }, 'encoded');
    generateFilings(db, c, year);
    // mark filings through Q3 as filed — except Aling Nena's Q3, left overdue to demo alerts + penalty calc
    const cutoff = c.taxpayer_type === 'individual' && c.income_regime === 'graduated' ? `${year}-06-30` : `${year}-09-30`;
    db.prepare("UPDATE filings SET status = 'filed', filed_date = due_date, reference = 'eFPS-DEMO-' || id WHERE client_id = ? AND period_end <= ?").run(id, cutoff);
    db.prepare('INSERT INTO period_locks (client_id, period, locked_by, reason) VALUES (?,?,?,?)').run(id, `${year}-01`, users.admin, 'Q1 returns filed (demo)');
  }
  return { users, clients };
}

if (require.main === module) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'l2c.db');
  if (fs.existsSync(DB_PATH) && !process.argv.includes('--force')) { console.error(`${DB_PATH} already exists. Use "npm run seed -- --force" to wipe and re-seed.`); process.exit(1); }
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) fs.rmSync(f, { force: true });
  const db = open(DB_PATH);
  seed(db);
  console.log('Demo data loaded. Logins: admin / DemoAdmin2026 · maria / DemoMaria2026 (accountant) · jun / DemoJun2026 (encoder)');
}
module.exports = { seed };
