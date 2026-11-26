'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, makeClient } = require('./helpers');
const { generateFilings, dueDate } = require('../src/calendar');

test('deadlines follow the rule table and roll weekends to the next working day', () => {
  const db = makeDb();
  assert.equal(dueDate(db, '2550Q', { periodEnd: '2026-03-31', q: 1 }), '2026-04-27'); // Apr 25 2026 is a Saturday
  assert.equal(dueDate(db, '2550Q', { periodEnd: '2026-06-30', q: 2 }), '2026-07-27'); // Jul 25 is Saturday
  assert.equal(dueDate(db, '1702Q', { periodEnd: '2026-03-31', q: 1 }), '2026-06-01'); // May 30 Sat → Jun 1
  assert.equal(dueDate(db, '1701Q', { periodEnd: '2026-06-30', q: 2 }), '2026-08-17'); // Aug 15 Sat → Aug 17
  assert.equal(dueDate(db, '1601-C', { periodEnd: '2026-12-31', q: 4 }), '2027-01-15');
  assert.equal(dueDate(db, '1601-EQ', { periodEnd: '2026-09-30', q: 3 }), '2026-11-02'); // Oct 31 is a Saturday
  assert.equal(dueDate(db, '1701', { periodEnd: '2026-12-31', q: 4, fyEndYear: 2026, fyEndMonth: 12 }), '2027-04-15');
  assert.equal(dueDate(db, '1702', { periodEnd: '2026-06-30', q: 4, fyEndYear: 2026, fyEndMonth: 6 }), '2026-10-15');
});

test('calendar is generated from registered tax types', () => {
  const db = makeDb();
  const c = makeClient(db, { tax_types: 'VAT,IT,EWT,WTC' });
  generateFilings(db, c, 2026);
  const forms = db.prepare('SELECT form, COUNT(*) AS n FROM filings WHERE client_id = ? GROUP BY form').all(c.id);
  const m = Object.fromEntries(forms.map((f) => [f.form, f.n]));
  assert.deepEqual(m, { '2550Q': 4, '1702Q': 3, '1702': 1, '0619-E': 8, '1601-EQ': 4, '1604-E': 1, '1601-C': 12, '1604-C': 1 });
  assert.equal(generateFilings(db, c, 2026), 0, 'idempotent');
  const nv = makeClient(db, { tin: '999-999-999', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', tax_types: 'PT,IT' });
  generateFilings(db, nv, 2026);
  const f2 = db.prepare('SELECT DISTINCT form FROM filings WHERE client_id = ? ORDER BY form').all(nv.id).map((r) => r.form);
  assert.deepEqual(f2, ['1701', '1701Q', '2551Q']);
});
