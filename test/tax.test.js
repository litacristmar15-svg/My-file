'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, makeClient, doc, P } = require('./helpers');
const T = require('../src/tax');
const { getRule } = require('../src/rules');

test('rule lookup is by effective date (re-running an old period gives the old answer)', () => {
  const db = makeDb();
  assert.equal(getRule(db, 'pt.rate', '2022-12-31').value, 10000); // 1% CREATE
  assert.equal(getRule(db, 'pt.rate', '2023-07-01').value, 30000); // back to 3%
  assert.equal(getRule(db, 'it.corp.rcit', '2020-06-30').value, 300000);
  assert.equal(getRule(db, 'it.corp.rcit', '2020-07-01').value, 250000);
  assert.equal(getRule(db, 'it.corp.mcit', '2022-01-01').value, 10000);
  assert.throws(() => getRule(db, 'pt.rate', '2010-01-01'), /No tax rule/);
});

test('graduated table — 2023 onwards vs 2018-2022 (worked examples)', () => {
  const db = makeDb();
  const t23 = getRule(db, 'it.individual.graduated', '2026-12-31').value;
  const t18 = getRule(db, 'it.individual.graduated', '2022-12-31').value;
  assert.equal(T.graduated(t23, P(250000)), 0);
  assert.equal(T.graduated(t23, P(500000)), P(42500));     // 22,500 + 20% × 100,000
  assert.equal(T.graduated(t23, P(1000000)), P(152500));   // 102,500 + 25% × 200,000
  assert.equal(T.graduated(t23, P(10000000)), P(2902500)); // 2,202,500 + 35% × 2,000,000
  assert.equal(T.graduated(t18, P(500000)), P(55000));     // 30,000 + 25% × 100,000
});

test('8% option professional: (gross − ₱250,000) × 8%, cumulative quarterly with prior payments', () => {
  const db = makeDb();
  const c = makeClient(db, { taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: '8pct', deduction: 'osd', tax_types: 'IT' });
  doc(db, c, { kind: 'sale', doc_date: '2026-02-10', exempt: '400000' });
  doc(db, c, { kind: 'sale', doc_date: '2026-05-10', exempt: '600000' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-05-11', exempt: '50000' }); // expenses don't matter under 8%
  const q1 = T.incomeTaxQuarter(db, c, 2026, 1);
  assert.equal(q1.due, P(12000)); // (400,000 − 250,000) × 8%
  assert.equal(q1.form, '1701Q');
  const q2 = T.incomeTaxQuarter(db, c, 2026, 2);
  assert.equal(q2.due, P(60000)); // (1,000,000 − 250,000) × 8%
  assert.equal(q2.prior, P(12000));
  assert.equal(q2.payable, P(48000));
});

test('graduated + OSD vs itemized for a non-VAT sole proprietor', () => {
  const db = makeDb();
  const osd = makeClient(db, { taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', deduction: 'osd', tax_types: 'PT,IT' });
  doc(db, osd, { kind: 'sale', doc_date: '2026-03-01', exempt: '1000000' });
  doc(db, osd, { kind: 'purchase', doc_date: '2026-03-02', exempt: '700000' });
  // OSD: 1,000,000 − 400,000 = 600,000 → 22,500 + 20% × 200,000 = 62,500
  assert.equal(T.incomeTaxQuarter(db, osd, 2026, 1).due, P(62500));
  const item = makeClient(db, { tin: '222-333-444', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', deduction: 'itemized', tax_types: 'PT,IT' });
  doc(db, item, { kind: 'sale', doc_date: '2026-03-01', exempt: '1000000' });
  doc(db, item, { kind: 'purchase', doc_date: '2026-03-02', exempt: '700000' });
  // Itemized: 300,000 taxable → 15% × 50,000 = 7,500
  assert.equal(T.incomeTaxQuarter(db, item, 2026, 1).due, P(7500));
});

test('percentage tax (2551Q) uses the rate effective on each sale date (1% → 3% in July 2023)', () => {
  const db = makeDb();
  const c = makeClient(db, { taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', tax_types: 'PT,IT' });
  doc(db, c, { kind: 'sale', doc_date: '2026-04-15', exempt: '100000' });
  doc(db, c, { kind: 'sale', doc_date: '2026-06-15', exempt: '50000' });
  assert.equal(T.percentageTaxQuarter(db, c, 2026, 2).payable, P(4500)); // 3% × 150,000
  const old = makeClient(db, { tin: '555-555-555', taxpayer_type: 'individual', vat_status: 'NONVAT', income_regime: 'graduated', fy_end_month: 9, tax_types: 'PT' });
  // FY ending Sept 2023: Q4 = Jul–Sep 2023 (3%); Q3 = Apr–Jun 2023 (1%)
  doc(db, old, { kind: 'sale', doc_date: '2023-06-15', exempt: '100000' });
  doc(db, old, { kind: 'sale', doc_date: '2023-07-15', exempt: '100000' });
  assert.equal(T.percentageTaxQuarter(db, old, 2023, 3).payable, P(1000));
  assert.equal(T.percentageTaxQuarter(db, old, 2023, 4).payable, P(3000));
});

test('VAT 2550Q: output − input; OR and non-VAT supplier input VAT disallowed; excess carried over', () => {
  const db = makeDb();
  const c = makeClient(db);
  doc(db, c, { kind: 'sale', doc_date: '2026-01-10', vatable: '100000', vat: '12000' });
  doc(db, c, { kind: 'sale', doc_date: '2026-02-10', exempt: '5000' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-01-15', vatable: '50000', vat: '6000' });                      // claimable
  doc(db, c, { kind: 'purchase', doc_date: '2026-01-16', vatable: '10000', vat: '1200', doc_type: 'or' });      // OR → disallowed (EOPT)
  doc(db, c, { kind: 'purchase', doc_date: '2026-01-17', vatable: '10000', vat: '1200', party_vat_registered: 0 }); // non-VAT supplier
  const q1 = T.vatQuarter(db, c, 2026, 1);
  assert.equal(q1.outputVat, P(12000));
  assert.equal(q1.inputVat, P(6000));
  assert.equal(q1.payable, P(6000));
  assert.equal(q1.totalSales, P(105000));
  // Q2: only purchases → excess input carried to Q3
  doc(db, c, { kind: 'purchase', doc_date: '2026-04-15', vatable: '100000', vat: '12000' });
  doc(db, c, { kind: 'sale', doc_date: '2026-05-10', vatable: '50000', vat: '6000' });
  const q2 = T.vatQuarter(db, c, 2026, 2);
  assert.equal(q2.payable, 0); assert.equal(q2.excessInput, P(6000));
  doc(db, c, { kind: 'sale', doc_date: '2026-07-10', vatable: '100000', vat: '12000' });
  const q3 = T.vatQuarter(db, c, 2026, 3);
  assert.equal(q3.carryover, P(6000)); assert.equal(q3.payable, P(6000));
});

test('corporation: RCIT 25% vs MCIT 2% — higher one is due once MCIT applies', () => {
  const db = makeDb();
  const c = makeClient(db, { ops_start_year: 2015 });
  doc(db, c, { kind: 'sale', doc_date: '2026-03-01', vatable: '1000000', vat: '120000' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-03-02', vatable: '800000', vat: '96000', account: '5010' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-03-03', vatable: '190000', vat: '22800', account: '6020' });
  const r = T.incomeTaxQuarter(db, c, 2026, 1);
  // taxable = 1,000,000 − 800,000 − 190,000 = 10,000 → RCIT 2,500; MCIT = 2% × 200,000 = 4,000
  assert.equal(r.due, P(4000));
  assert.equal(r.form, '1702Q');
  const young = makeClient(db, { tin: '777-777-777', ops_start_year: 2024 });
  doc(db, young, { kind: 'sale', doc_date: '2026-03-01', vatable: '1000000', vat: '120000' });
  doc(db, young, { kind: 'purchase', doc_date: '2026-03-02', vatable: '800000', vat: '96000', account: '5010' });
  doc(db, young, { kind: 'purchase', doc_date: '2026-03-03', vatable: '190000', vat: '22800', account: '6020' });
  assert.equal(T.incomeTaxQuarter(db, young, 2026, 1).due, P(2500)); // MCIT not yet applicable
});

test('small corporation 20% rate and annual (Q4) uses full year', () => {
  const db = makeDb();
  const c = makeClient(db, { income_regime: 'small_corp', ops_start_year: 2025 });
  doc(db, c, { kind: 'sale', doc_date: '2026-03-01', vatable: '500000', vat: '60000' });
  doc(db, c, { kind: 'sale', doc_date: '2026-11-01', vatable: '500000', vat: '60000' });
  doc(db, c, { kind: 'purchase', doc_date: '2026-03-03', vatable: '200000', vat: '24000', account: '6020' });
  const a = T.incomeTaxQuarter(db, c, 2026, 4);
  assert.equal(a.due, P(160000)); // 800,000 × 20%
  assert.equal(a.form, '1702-RT');
  assert.equal(a.prior, P(60000)); // Q1–Q3 cumulative: 300,000 × 20%
});

test('penalty: EOPT reduced rates for micro/small vs regular', () => {
  const db = makeDb();
  const micro = T.penalty(db, { tax: P(10000), dueDate: '2025-04-25', payDate: '2025-05-25', size: 'micro' });
  assert.equal(micro.days, 30); assert.equal(micro.surcharge, P(1000)); assert.equal(micro.interest, 4932); // 10,000 × 6% × 30/365 = 49.32
  const large = T.penalty(db, { tax: P(10000), dueDate: '2025-04-25', payDate: '2025-05-25', size: 'large' });
  assert.equal(large.surcharge, P(2500)); assert.equal(large.interest, 9863);
  const onTime = T.penalty(db, { tax: P(10000), dueDate: '2025-04-25', payDate: '2025-04-25', size: 'large' });
  assert.equal(onTime.total, P(10000));
});
