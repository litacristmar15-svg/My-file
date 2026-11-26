'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, makeClient, doc, P } = require('./helpers');
const { validateDocument, inputVatAllowed } = require('../src/validate');

const base = { kind: 'purchase', doc_type: 'invoice', doc_no: '123', doc_date: '2026-03-05', period: '2026-03', party_name: 'Supplier', party_tin: '123-456-789-000', party_vat_registered: 1, vatable: P(100), vat: P(12), exempt: 0, zero_rated: 0, total: P(112) };
const codes = (f) => f.map((x) => x.code);

test('clean VAT invoice passes', () => {
  const db = makeDb(); const c = makeClient(db);
  assert.deepEqual(validateDocument(db, c, base).filter((f) => f.level !== 'info'), []);
  assert.equal(inputVatAllowed(c, base), true);
});

test('missing / bad TIN, missing number, out-of-period, total mismatch', () => {
  const db = makeDb(); const c = makeClient(db);
  assert.ok(codes(validateDocument(db, c, { ...base, party_tin: '' })).includes('NO_TIN'));
  assert.ok(codes(validateDocument(db, c, { ...base, party_tin: '12-34' })).includes('BAD_TIN'));
  assert.ok(codes(validateDocument(db, c, { ...base, doc_no: null })).includes('NO_DOC_NO'));
  assert.ok(codes(validateDocument(db, c, { ...base, period: '2026-04' })).includes('OUT_OF_PERIOD'));
  assert.ok(codes(validateDocument(db, c, { ...base, total: P(113) })).includes('TOTAL_MISMATCH'));
  assert.ok(codes(validateDocument(db, c, { ...base, vat: P(20), total: P(120) })).includes('VAT_RATE'));
});

test('duplicate invoice (same supplier TIN + number) is caught even with different TIN formatting', () => {
  const db = makeDb(); const c = makeClient(db);
  doc(db, c, { kind: 'purchase', doc_date: '2026-03-01', doc_no: 'A-77', party_tin: '123456789000', vatable: '100', vat: '12' });
  assert.ok(codes(validateDocument(db, c, { ...base, doc_no: 'A-77' })).includes('DUPLICATE'));
});

test('EOPT: OR does not support input VAT; non-VAT supplier VAT is disallowed; non-VAT client may not charge VAT', () => {
  const db = makeDb(); const c = makeClient(db);
  const or = { ...base, doc_type: 'or' };
  assert.ok(codes(validateDocument(db, c, or)).includes('INPUT_VAT_DISALLOWED')); assert.equal(inputVatAllowed(c, or), false);
  const nv = { ...base, party_vat_registered: 0 };
  assert.ok(codes(validateDocument(db, c, nv)).includes('INPUT_VAT_DISALLOWED')); assert.equal(inputVatAllowed(c, nv), false);
  const nvClient = makeClient(db, { tin: '321-321-321', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated' });
  assert.ok(codes(validateDocument(db, nvClient, { ...base, kind: 'sale' })).includes('NONVAT_CHARGED_VAT'));
  assert.ok(codes(validateDocument(db, c, { ...base, account_code: '6060' })).includes('EAR_LIMIT'));
});
