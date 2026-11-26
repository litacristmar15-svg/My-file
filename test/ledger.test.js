'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, makeClient, doc, P } = require('./helpers');
const L = require('../src/ledger');

test('unbalanced or foreign-account entries are rejected', () => {
  const db = makeDb(); const c = makeClient(db); const other = makeClient(db, { tin: '444-444-444' });
  const A = L.accountMap(db, c.id), B = L.accountMap(db, other.id);
  assert.throws(() => L.postJournal(db, { client_id: c.id, date: '2026-01-01', lines: [{ account_id: A['1010'].id, debit: 100 }, { account_id: A['3010'].id, credit: 99 }] }), /not balanced/);
  assert.throws(() => L.postJournal(db, { client_id: c.id, date: '2026-01-01', lines: [{ account_id: A['1010'].id, debit: 100 }, { account_id: B['3010'].id, credit: 100 }] }), /does not belong/);
  assert.throws(() => L.postJournal(db, { client_id: c.id, date: '2026-01-01', lines: [{ account_id: A['1010'].id, debit: 1.5 }, { account_id: A['3010'].id, credit: 1.5 }] }), /centavos/);
});

test('locked periods block posting; posted lines cannot be edited or deleted', () => {
  const db = makeDb(); const c = makeClient(db); const A = L.accountMap(db, c.id);
  db.prepare("INSERT INTO period_locks (client_id, period) VALUES (?, '2026-03')").run(c.id);
  assert.throws(() => L.postJournal(db, { client_id: c.id, date: '2026-03-15', lines: [{ account_id: A['1010'].id, debit: 100 }, { account_id: A['3010'].id, credit: 100 }] }), /locked/);
  const id = L.postJournal(db, { client_id: c.id, date: '2026-04-15', lines: [{ account_id: A['1010'].id, debit: 100 }, { account_id: A['3010'].id, credit: 100 }] });
  assert.throws(() => db.prepare('UPDATE journal_lines SET debit = 5 WHERE journal_id = ?').run(id), /cannot be edited/);
  assert.throws(() => db.prepare('DELETE FROM journal_lines WHERE journal_id = ?').run(id), /cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM audit').run(), /append-only/);
});

test('reversal nets the account balances back to zero and cannot be repeated', () => {
  const db = makeDb(); const c = makeClient(db);
  const d = doc(db, c, { kind: 'sale', doc_date: '2026-02-01', vatable: '1000', vat: '120' });
  const jid = db.prepare('SELECT id FROM journals WHERE document_id = ?').get(d.id).id;
  L.reverseJournal(db, jid, { reason: 'wrong customer' });
  assert.ok(L.balances(db, c.id, { to: '2026-12-31' }).every((r) => r.balance === 0));
  assert.throws(() => L.reverseJournal(db, jid, {}), /already reversed/);
});

test('posting rules: VAT sale, disallowed input VAT goes to expense, non-VAT client', () => {
  const db = makeDb(); const c = makeClient(db);
  doc(db, c, { kind: 'sale', doc_date: '2026-01-05', vatable: '1000', vat: '120', payment: 'credit' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-01-06', vatable: '100', vat: '12', doc_type: 'or', account: '6040' });
  const b = Object.fromEntries(L.balances(db, c.id, { to: '2026-12-31' }).map((r) => [r.code, r.balance]));
  assert.equal(b['1100'], P(1120)); assert.equal(b['4010'], -P(1000)); assert.equal(b['2100'], -P(120));
  assert.equal(b['6040'], P(112)); assert.equal(b['1300'], 0); // OR → full amount expensed
  const nv = makeClient(db, { tin: '888-888-888', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated' });
  doc(db, nv, { kind: 'purchase', doc_date: '2026-01-06', vatable: '100', vat: '12', account: '6040' });
  const b2 = Object.fromEntries(L.balances(db, nv.id, { to: '2026-12-31' }).map((r) => [r.code, r.balance]));
  assert.equal(b2['6040'], P(112)); assert.equal(b2['1300'], undefined);
});

test('trial balance balances and financial statements tie out to it (seeded demo data)', () => {
  const db = makeDb();
  db.exec('DELETE FROM rules'); // seed() seeds rules itself
  const { seed } = require('../src/seed');
  const { clients } = seed(db, { year: 2026, months: 6 });
  for (const c of clients) {
    const tb = L.trialBalance(db, c.id, { to: '2026-12-31' });
    assert.ok(tb.balanced, `TB balanced for ${c.reg_name}`);
    assert.ok(tb.totalDebit > 0);
    const bs = L.balanceSheet(db, c.id, { to: '2026-12-31' });
    assert.ok(bs.balanced, `BS balances for ${c.reg_name}`);
    const is = L.incomeStatement(db, c.id, { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(is.netIncome, bs.netIncome, 'IS net income = BS unclosed net income');
    // TB with a period start still balances (prior income rolled into equity)
    assert.ok(L.trialBalance(db, c.id, { from: '2026-04-01', to: '2026-06-30' }).balanced);
    // Sales journal total = revenue + output VAT on posted sales
    const sj = db.prepare("SELECT SUM(total) AS t FROM documents WHERE client_id = ? AND kind = 'sale' AND status = 'posted'").get(c.id).t;
    const b = Object.fromEntries(L.balances(db, c.id, { to: '2026-12-31' }).map((r) => [r.code, r.balance]));
    assert.equal(sj, -(b['4010'] + (b['2100'] || 0)));
  }
});
