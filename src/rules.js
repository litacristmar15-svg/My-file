'use strict';
// Versioned tax rule tables. NOTHING in the tax engine hard-codes a rate, threshold or deadline:
// it always asks getRule(key, date) for the version effective on that date.
// Money values are centavos; rates are ppm (12% = 120000).

const SEED = [
  // ---------- VAT ----------
  { key: 'vat.rate', value: 120000, from: '2006-02-01', basis: 'NIRC Secs. 106 & 108 as amended by RA 9337; retained by RA 10963 (TRAIN)' },
  { key: 'vat.threshold', value: 300000000, from: '2018-01-01', basis: 'NIRC Sec. 109(1)(CC) as amended by RA 10963 (TRAIN); RR 13-2018', notes: 'Gross sales/receipts above ₱3,000,000 in any 12-month period require VAT registration.' },

  // ---------- Percentage tax (non-VAT, Sec. 116) ----------
  { key: 'pt.rate', value: 30000, from: '2018-01-01', to: '2020-06-30', basis: 'NIRC Sec. 116 as amended by RA 10963 (TRAIN)' },
  { key: 'pt.rate', value: 10000, from: '2020-07-01', to: '2023-06-30', basis: 'RA 11534 (CREATE) Sec. 5 amending NIRC Sec. 116; RR 4-2021', notes: 'Temporary 1% rate.' },
  { key: 'pt.rate', value: 30000, from: '2023-07-01', basis: 'NIRC Sec. 116 (rate reverts to 3% after CREATE transitory period); RMC 69-2023' },

  // ---------- Individual income tax ----------
  { key: 'it.individual.graduated', from: '2018-01-01', to: '2022-12-31', basis: 'NIRC Sec. 24(A)(2)(a) as amended by RA 10963 (TRAIN), table effective 2018-2022',
    value: [
      { over: 0, base: 0, rate: 0 },
      { over: 25000000, base: 0, rate: 200000 },
      { over: 40000000, base: 3000000, rate: 250000 },
      { over: 80000000, base: 13000000, rate: 300000 },
      { over: 200000000, base: 49000000, rate: 320000 },
      { over: 800000000, base: 241000000, rate: 350000 },
    ] },
  { key: 'it.individual.graduated', from: '2023-01-01', basis: 'NIRC Sec. 24(A)(2)(a) as amended by RA 10963 (TRAIN), table effective January 1, 2023 onwards',
    value: [
      { over: 0, base: 0, rate: 0 },
      { over: 25000000, base: 0, rate: 150000 },
      { over: 40000000, base: 2250000, rate: 200000 },
      { over: 80000000, base: 10250000, rate: 250000 },
      { over: 200000000, base: 40250000, rate: 300000 },
      { over: 800000000, base: 220250000, rate: 350000 },
    ] },
  { key: 'it.individual.8pct', value: { rate: 80000, exemption: 25000000, ceiling: 300000000 }, from: '2018-01-01', basis: 'NIRC Sec. 24(A)(2)(b) as amended by RA 10963 (TRAIN); RR 8-2018',
    notes: '₱250,000 reduction applies only to purely self-employed/professionals (not mixed-income earners).' },
  { key: 'it.osd.rate', value: 400000, from: '2008-07-06', basis: 'NIRC Sec. 34(L) as amended by RA 9504; RR 16-2008', notes: 'Individuals: 40% of gross sales/receipts. Corporations: 40% of gross income.' },

  // ---------- Corporate income tax ----------
  { key: 'it.corp.rcit', value: 300000, from: '2009-01-01', to: '2020-06-30', basis: 'NIRC Sec. 27(A) as amended by RA 9337' },
  { key: 'it.corp.rcit', value: 250000, from: '2020-07-01', basis: 'RA 11534 (CREATE) amending NIRC Sec. 27(A); RR 5-2021' },
  { key: 'it.corp.small', value: { rate: 200000, max_taxable_income: 500000000, max_assets: 10000000000 }, from: '2020-07-01', basis: 'RA 11534 (CREATE) amending NIRC Sec. 27(A); RR 5-2021',
    notes: '20% if net taxable income ≤ ₱5M AND total assets ≤ ₱100M (excluding land on which the office/plant stands).' },
  { key: 'it.corp.mcit', value: 20000, from: '2009-01-01', to: '2020-06-30', basis: 'NIRC Sec. 27(E)' },
  { key: 'it.corp.mcit', value: 10000, from: '2020-07-01', to: '2023-06-30', basis: 'RA 11534 (CREATE) Sec. 27(E); RR 5-2021', notes: 'Temporary 1% MCIT.' },
  { key: 'it.corp.mcit', value: 20000, from: '2023-07-01', basis: 'NIRC Sec. 27(E) (reverts to 2%); RMC 69-2023', notes: 'Applies beginning the 4th taxable year after the year operations commenced.' },

  // ---------- Penalties ----------
  { key: 'penalty', value: { surcharge: 250000, interest_annual: 120000, surcharge_micro_small: 250000, interest_annual_micro_small: 120000 }, from: '2018-01-01', to: '2024-01-21',
    basis: 'NIRC Secs. 248 & 249 as amended by RA 10963 (TRAIN): 25% surcharge; interest at double the legal rate (12% p.a.)' },
  { key: 'penalty', value: { surcharge: 250000, interest_annual: 120000, surcharge_micro_small: 100000, interest_annual_micro_small: 60000 }, from: '2024-01-22',
    basis: 'RA 11976 (EOPT Act) adding NIRC Sec. 248(C)/249(D); RR 6-2024', needs_review: 1,
    notes: 'Micro & small taxpayers: 10% surcharge and 50% of the regular interest rate. Please confirm effective date and coverage.' },

  // ---------- Filing deadlines (rules, not code) ----------
  { key: 'deadline.2550Q', value: { type: 'days_after_quarter_end', days: 25 }, from: '2023-01-01', basis: 'NIRC Sec. 114(A) as amended by TRAIN (quarterly VAT returns only from 2023); RR 3-2024 (EOPT)', needs_review: 1 },
  { key: 'deadline.2551Q', value: { type: 'days_after_quarter_end', days: 25 }, from: '2018-01-01', basis: 'NIRC Sec. 128(A)(1) as amended by TRAIN; RR 11-2018' },
  { key: 'deadline.0619-E', value: { type: 'day_of_next_month', day: 10 }, from: '2018-01-01', basis: 'RR 11-2018 (monthly remittance for 1st & 2nd month of the quarter)' },
  { key: 'deadline.1601-EQ', value: { type: 'last_day_of_month_after_quarter' }, from: '2018-01-01', basis: 'RR 11-2018' },
  { key: 'deadline.1601-C', value: { type: 'day_of_next_month', day: 10, december_day: 15 }, from: '2018-01-01', basis: 'RR 11-2018 (December return due January 15)' },
  { key: 'deadline.1701Q', value: { type: 'fixed_per_quarter', dates: { 1: '05-15', 2: '08-15', 3: '11-15' } }, from: '2018-01-01', basis: 'NIRC Sec. 74(A) as amended by TRAIN; RR 8-2018' },
  { key: 'deadline.1702Q', value: { type: 'days_after_quarter_end', days: 60 }, from: '2018-01-01', basis: 'NIRC Sec. 77(B)' },
  { key: 'deadline.1701', value: { type: 'fixed_next_year', date: '04-15' }, from: '2018-01-01', basis: 'NIRC Sec. 51(C)(1)' },
  { key: 'deadline.1702', value: { type: 'month_day_after_fy_end', months: 4, day: 15 }, from: '2018-01-01', basis: 'NIRC Sec. 77(B) — 15th day of the 4th month after fiscal year end' },
  { key: 'deadline.1604-C', value: { type: 'fixed_next_year', date: '01-31' }, from: '2018-01-01', basis: 'RR 11-2018 as amended' },
  { key: 'deadline.1604-E', value: { type: 'fixed_next_year', date: '03-01' }, from: '2018-01-01', basis: 'RR 11-2018 as amended' },
];

function seedRules(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM rules').get().n;
  if (n > 0) return;
  const ins = db.prepare('INSERT INTO rules (key, value, effective_from, effective_to, legal_basis, notes, needs_review) VALUES (?,?,?,?,?,?,?)');
  for (const r of SEED) ins.run(r.key, JSON.stringify(r.value), r.from, r.to || null, r.basis, r.notes || null, r.needs_review || 0);
}

function getRule(db, key, date) {
  const row = db.prepare(`SELECT * FROM rules WHERE key = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC, id DESC LIMIT 1`).get(key, date, date);
  if (!row) throw new Error(`No tax rule "${key}" effective on ${date}. Add one in Tax Rules.`);
  return { ...row, value: JSON.parse(row.value) };
}

module.exports = { SEED, seedRules, getRule };
