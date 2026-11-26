'use strict';
// Tax computations from POSTED records only. Every number uses the rule version effective
// on the relevant date, so re-running an old quarter gives the old answer.
const { getRule } = require('./rules');
const { mulRate, divRound, fmt, peso } = require('./money');
const { quarterRange, fiscalYearRange, daysBetween, show } = require('./dates');
const { incomeStatement } = require('./ledger');

// ---------------- VAT (2550Q) ----------------
function vatQuarter(db, client, year, q, depth = 0) {
  const { from, to } = quarterRange(year, q, client.fy_end_month);
  const s = db.prepare(`SELECT COALESCE(SUM(vatable),0) AS vatable, COALESCE(SUM(zero_rated),0) AS zero, COALESCE(SUM(exempt),0) AS exempt,
    COALESCE(SUM(vat),0) AS vat, COUNT(*) AS n FROM documents WHERE client_id = ? AND kind = 'sale' AND status = 'posted' AND doc_date BETWEEN ? AND ?`).get(client.id, from, to);
  const p = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN input_vat_allowed = 1 THEN vatable END),0) AS vatable,
      COALESCE(SUM(CASE WHEN input_vat_allowed = 1 THEN vat END),0) AS vat,
      COALESCE(SUM(CASE WHEN input_vat_allowed = 0 THEN vat END),0) AS disallowed,
      COALESCE(SUM(CASE WHEN input_vat_allowed = 0 OR vat = 0 THEN total END),0) AS nonvat_purchases, COUNT(*) AS n
    FROM documents WHERE client_id = ? AND kind = 'purchase' AND status = 'posted' AND doc_date BETWEEN ? AND ?`).get(client.id, from, to);
  // Carry over excess input VAT from the previous quarter (looks back up to 8 quarters)
  let carryover = 0;
  if (depth < 8) {
    const pq = q === 1 ? [year - 1, 4] : [year, q - 1];
    const prev = vatQuarter(db, client, pq[0], pq[1], depth + 1);
    if (prev.hasData || prev.carryover) carryover = prev.excessInput;
  }
  const totalSales = s.vatable + s.zero + s.exempt;
  const availableInput = p.vat + carryover;
  const net = s.vat - availableInput;
  const rate = getRule(db, 'vat.rate', to);
  return {
    form: '2550Q', from, to, rate: rate.value, basis: rate.legal_basis, hasData: s.n + p.n > 0,
    lines: [
      ['Part IV-A 31', 'VATable sales', s.vatable], ['Part IV-A 32', 'Zero-rated sales', s.zero], ['Part IV-A 33', 'Exempt sales', s.exempt],
      ['Part IV-A 34', 'Total sales', totalSales], ['Part IV-A 34B', 'Output tax due', s.vat],
      ['Part IV-B 38', 'Input tax carried over from previous quarter', carryover],
      ['Part IV-B 44', 'Purchases with input tax (domestic, invoiced)', p.vatable], ['Part IV-B 44B', 'Input tax on current purchases', p.vat],
      ['Part IV-B', 'Total available input tax', availableInput],
      ['Info', 'Input VAT NOT claimable (non-VAT supplier / no VAT invoice) — charged to expense', p.disallowed],
      [net >= 0 ? 'Part IV 61' : 'Part IV 61', net >= 0 ? 'VAT PAYABLE' : 'Excess input tax (carried over to next quarter)', Math.abs(net)],
    ],
    outputVat: s.vat, inputVat: p.vat, carryover, payable: net > 0 ? net : 0, excessInput: net < 0 ? -net : 0, totalSales,
    notes: ['Capital goods amortization (purchases > ₱1M) is not handled in the MVP — enter manually if applicable.', 'Line numbers are indicative; check against the current 2550Q version.'],
  };
}

// ---------------- Percentage tax (2551Q) ----------------
function percentageTaxQuarter(db, client, year, q) {
  const { from, to } = quarterRange(year, q, client.fy_end_month);
  const docs = db.prepare(`SELECT doc_date, total FROM documents WHERE client_id = ? AND kind = 'sale' AND status = 'posted' AND doc_date BETWEEN ? AND ?`).all(client.id, from, to);
  const groups = {};
  for (const d of docs) {
    const r = getRule(db, 'pt.rate', d.doc_date);
    const g = (groups[r.value] ||= { rate: r.value, basis: r.legal_basis, gross: 0 });
    g.gross += d.total;
  }
  const rows = Object.values(groups).map((g) => ({ ...g, tax: mulRate(g.gross, g.rate) }));
  const gross = rows.reduce((s, r) => s + r.gross, 0);
  const tax = rows.reduce((s, r) => s + r.tax, 0);
  if (!rows.length) { const r = getRule(db, 'pt.rate', to); rows.push({ rate: r.value, basis: r.legal_basis, gross: 0, tax: 0 }); }
  return {
    form: '2551Q', from, to, rows, gross, payable: tax,
    lines: [...rows.map((r) => ['Sched 1 (ATC PT010)', `Gross sales/receipts taxed at ${r.rate / 10000}%`, r.gross]), ['Item 14', 'Total tax due', tax]],
    notes: ['Assumes all sales are subject to Sec. 116 percentage tax (ATC PT010).'],
  };
}

// ---------------- Income tax (1701Q/1701, 1702Q/1702) ----------------
function graduated(table, taxable) {
  if (taxable <= 0) return 0;
  let b = table[0];
  for (const row of table) if (taxable > row.over) b = row;
  return b.base + mulRate(taxable - b.over, b.rate);
}

function cumulativeCwt(db, clientId, from, to) {
  return db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journals j ON j.id = l.journal_id
    JOIN accounts a ON a.id = l.account_id WHERE j.client_id = ? AND a.code = '1310' AND j.date BETWEEN ? AND ?`).get(clientId, from, to).v;
}

// Tax due on the cumulative figures from start of fiscal year to end of quarter q (q = 4 → annual)
function incomeTaxCumulative(db, client, year, q) {
  const fy = fiscalYearRange(year, client.fy_end_month);
  const to = quarterRange(year, q, client.fy_end_month).to;
  const is = incomeStatement(db, client.id, { from: fy.from, to });
  const lines = []; const notes = []; let due = 0; let form;
  const L = (ref, label, v) => lines.push([ref, label, v]);
  const isIndividual = client.taxpayer_type === 'individual';
  form = isIndividual ? (q < 4 ? '1701Q' : (client.income_regime === '8pct' || client.deduction === 'osd' ? '1701A' : '1701')) : (q < 4 ? '1702Q' : (client.income_regime === 'exempt' ? '1702-EX' : '1702-RT'));

  if (client.income_regime === 'exempt') {
    notes.push(client.taxpayer_type === 'gpp' ? 'General professional partnership: exempt from income tax; partners report their shares (NIRC Sec. 26).' : 'Client is marked income-tax exempt. Confirm exemption basis (e.g. Sec. 30 NIRC / CDA registration).');
    L('', 'Gross revenue', is.revenue);
  } else if (isIndividual && client.income_regime === '8pct') {
    const r = getRule(db, 'it.individual.8pct', to);
    const gross = is.revenue + is.otherIncome;
    const base = Math.max(0, gross - r.value.exemption);
    due = mulRate(base, r.value.rate);
    L('Sched II 47', 'Gross sales/receipts (cumulative)', is.revenue); L('Sched II 50', 'Add: other non-operating income', is.otherIncome);
    L('Sched II 51', 'Total', gross); L('Sched II 52', 'Less: allowable reduction (₱250,000)', r.value.exemption);
    L('Sched II 53', 'Taxable income', base); L('Sched II 54', `Tax due (${r.value.rate / 10000}%)`, due);
    notes.push(r.legal_basis);
    if (gross > r.value.ceiling) notes.push('⚠ Gross sales exceed ₱3,000,000 — the 8% option is no longer available; switch to graduated rates and check VAT registration.');
  } else if (isIndividual) {
    const r = getRule(db, 'it.individual.graduated', to);
    let deduction;
    if (client.deduction === 'osd') { deduction = mulRate(is.revenue, getRule(db, 'it.osd.rate', to).value); L('Sched I 38', 'Less: OSD (40% of gross sales/receipts)', deduction); }
    else { deduction = is.totalCos + is.totalOpex; L('Sched I', 'Less: cost of sales', is.totalCos); L('Sched I 38', 'Less: itemized deductions', is.totalOpex); }
    lines.unshift(['Sched I 36', 'Gross sales/receipts (cumulative)', is.revenue]);
    const taxable = is.revenue - deduction + is.otherIncome;
    L('Sched I 40', 'Add: other non-operating income', is.otherIncome); L('Sched I 41', 'Taxable income', taxable);
    due = graduated(r.value, taxable); L('Sched I 42', 'Tax due (graduated table)', due);
    notes.push(r.legal_basis);
  } else {
    const isSmall = client.income_regime === 'small_corp';
    const rr = isSmall ? getRule(db, 'it.corp.small', to) : getRule(db, 'it.corp.rcit', to);
    const rate = isSmall ? rr.value.rate : rr.value;
    const grossIncome = is.revenue - is.totalCos;
    let deduction;
    if (client.deduction === 'osd') deduction = mulRate(grossIncome + is.otherIncome, getRule(db, 'it.osd.rate', to).value);
    else deduction = is.totalOpex;
    const taxable = grossIncome + is.otherIncome - deduction;
    const rcit = Math.max(0, mulRate(taxable, rate));
    L('Sched 1', 'Sales/revenues (cumulative)', is.revenue); L('Sched 1', 'Less: cost of sales/services', is.totalCos);
    L('Sched 1', 'Gross income from operations', grossIncome); L('Sched 1', 'Add: other taxable income', is.otherIncome);
    L('Sched 1', client.deduction === 'osd' ? 'Less: OSD (40% of gross income)' : 'Less: itemized deductions', deduction);
    L('Sched 1', 'Taxable income', taxable); L('Sched 1', `Regular income tax (${rate / 10000}%)`, rcit);
    due = rcit;
    notes.push(rr.legal_basis);
    if (isSmall) notes.push('Small-corporation rate requires net taxable income ≤ ₱5M and total assets ≤ ₱100M (excl. land). Confirm eligibility.');
    const mr = getRule(db, 'it.corp.mcit', to);
    const mcitApplies = client.ops_start_year && year >= client.ops_start_year + 4;
    const mcit = mulRate(Math.max(0, grossIncome + is.otherIncome), mr.value);
    L('Sched 2', `Minimum corporate income tax (${mr.value / 10000}% of gross income)${mcitApplies ? '' : ' — not yet applicable'}`, mcit);
    if (mcitApplies && mcit > rcit) { due = mcit; notes.push('MCIT is higher than RCIT, so MCIT is the tax due. Excess MCIT may be carried forward for 3 years.'); }
    if (!client.ops_start_year) notes.push('Set "year operations started" on the client profile to determine if MCIT applies.');
    if (client.taxpayer_type === 'partnership') notes.push('Taxable partnership: taxed as a corporation (NIRC Sec. 22(B)).');
  }
  const cwt = cumulativeCwt(db, client.id, fy.from, to);
  return { form, from: fy.from, to, lines, due, cwt, notes, is };
}

function incomeTaxQuarter(db, client, year, q) {
  const cur = incomeTaxCumulative(db, client, year, q);
  let prior = 0;
  for (let i = 1; i < q && i <= 3; i++) {
    const c = incomeTaxCumulative(db, client, year, i);
    prior = Math.max(prior, c.due - c.cwt); // assumes earlier quarters were paid as computed
  }
  prior = Math.max(0, prior);
  const payable = cur.due - prior - cur.cwt;
  cur.lines.push(['', 'Less: tax paid in previous quarters (as computed)', prior], ['', 'Less: creditable tax withheld (2307s received)', cur.cwt],
    ['', payable >= 0 ? 'TAX PAYABLE' : 'Overpayment', Math.abs(payable)]);
  return { ...cur, prior, payable: Math.max(0, payable) };
}

// ---------------- Penalties ----------------
function penalty(db, { tax, dueDate, payDate, size }) {
  const r = getRule(db, 'penalty', payDate);
  const micro = size === 'micro' || size === 'small';
  const sRate = micro ? r.value.surcharge_micro_small : r.value.surcharge;
  const iRate = micro ? r.value.interest_annual_micro_small : r.value.interest_annual;
  const days = Math.max(0, daysBetween(dueDate, payDate));
  const surcharge = days > 0 ? mulRate(tax, sRate) : 0;
  const interest = days > 0 ? divRound(BigInt(tax) * BigInt(iRate) * BigInt(days), 1000000n * 365n) : 0;
  return { days, surcharge, interest, total: tax + surcharge + interest, sRate, iRate, basis: r.legal_basis, needsReview: !!r.needs_review,
    note: 'Compromise penalty (RMO 7-2015 schedule) is not included.' };
}

// Plain-language summary for clients
function plainSummary(client, year, q, { vat, pt, it }) {
  const parts = [];
  const name = client.trade_name || client.reg_name;
  parts.push(`${name} — Quarter ${q} of fiscal year ${year} (quarter ending ${show(it.to)}).`);
  parts.push(`You earned ${peso(it.is.revenue + it.is.otherIncome)} in total sales/income so far this year, and spent ${peso(it.is.totalCos + it.is.totalOpex)}. Your net income so far is ${peso(it.is.netIncome)}.`);
  if (vat) parts.push(vat.payable ? `Your VAT due this quarter is ${peso(vat.payable)}.` : `No VAT is due this quarter; ${peso(vat.excessInput)} of input VAT carries over to next quarter.`);
  if (pt) parts.push(`Your percentage tax due this quarter is ${peso(pt.payable)}.`);
  parts.push(it.payable ? `Your income tax payable this quarter is ${peso(it.payable)}.` : 'No income tax is payable this quarter.');
  return parts;
}

module.exports = { vatQuarter, percentageTaxQuarter, incomeTaxQuarter, incomeTaxCumulative, graduated, penalty, plainSummary };
