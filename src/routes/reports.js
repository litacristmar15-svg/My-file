'use strict';
const { html, raw } = require('../html');
const { table, badge, money } = require('../layout');
const auth = require('../auth');
const { audit } = require('../db');
const { show, today, quarterRange, fiscalYearRange, isValidIso } = require('../dates');
const { fmt, peso, parseMoney, toDecimal } = require('../money');
const L = require('../ledger');
const T = require('../tax');
const { generateFilings } = require('../calendar');

function csv(res, name, headers, rows) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send('﻿' + [headers, ...rows].map((r) => r.map(q).join(',')).join('\r\n'));
}

function header(c, book, from, to) {
  return html`<div class="report-head"><div><strong>${c.reg_name}</strong></div>${c.trade_name ? html`<div>${c.trade_name}</div>` : ''}
    <div>TIN ${c.tin}-${c.branch} · RDO ${c.rdo || '—'}</div><div>${c.address || ''}</div>
    <h2 style="margin:10px 0 2px">${book}</h2><div>${from ? `For the period ${show(from)} to ${show(to)}` : `As of ${show(to)}`}</div></div>`;
}

function rangeForm(c, action, extra = '', q = {}) {
  return html`<form class="card actions no-print" method="get" action="${action}">${extra}
    <div><label>From</label><input type="date" name="from" value="${q.from}"></div><div><label>To</label><input type="date" name="to" value="${q.to}"></div>
    <div style="align-self:end"><button>Show</button></div></form>`;
}

module.exports = function (app, db) {
  const range = (req) => {
    const y = today().slice(0, 4);
    const fy = fiscalYearRange(Number(y), req.client.fy_end_month);
    return { from: isValidIso(req.query.from) ? req.query.from : fy.from, to: isValidIso(req.query.to) ? req.query.to : fy.to };
  };

  // ================= BOOKS OF ACCOUNTS =================
  const BOOKS = { gj: 'General Journal', gl: 'General Ledger', sj: 'Sales Journal', pj: 'Purchase Journal', crj: 'Cash Receipts Journal', cdj: 'Cash Disbursements Journal', ar: 'Accounts Receivable Subsidiary Ledger', ap: 'Accounts Payable Subsidiary Ledger', tb: 'Trial Balance' };
  app.get('/clients/:cid/books', (req, res) => {
    const c = req.client; const book = BOOKS[req.query.book] ? req.query.book : 'gj';
    const { from, to } = range(req); const isCsv = req.query.format === 'csv';
    const vat = c.vat_status === 'VAT';
    let headers, rows, foot;
    const docs = (kind) => db.prepare(`SELECT * FROM documents WHERE client_id = ? AND kind = ? AND status = 'posted' AND doc_date BETWEEN ? AND ? ORDER BY doc_date, id`).all(c.id, kind, from, to);
    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);

    if (book === 'gj') {
      const js = L.journalEntries(db, c.id, { from, to });
      headers = ['Date', 'JE #', 'Reference', 'Account', 'Debit', 'Credit'];
      rows = js.flatMap((j) => [...j.lines.map((l, i) => [i ? '' : show(j.date), i ? '' : j.id, i ? '' : j.ref, (l.credit ? '      ' : '') + l.code + ' ' + l.name, l.debit, l.credit]), ['', '', '', '   ' + (j.memo || ''), null, null]]);
      foot = ['', '', '', 'Totals', js.reduce((s, j) => s + sum(j.lines, 'debit'), 0), js.reduce((s, j) => s + sum(j.lines, 'credit'), 0)];
    } else if (book === 'gl') {
      const gl = L.generalLedger(db, c.id, { from, to });
      headers = ['Date', 'JE #', 'Particulars', 'Debit', 'Credit', 'Balance'];
      rows = gl.flatMap((a) => [[`${a.code} ${a.name}`, '', 'Opening balance', null, null, a.opening], ...a.moves.map((m) => [show(m.date), m.jid, m.memo || m.ref, m.debit, m.credit, m.balance]), ['', '', 'Closing balance', null, null, a.closing]]);
    } else if (book === 'sj') {
      const d = docs('sale');
      if (vat) { headers = ['Date', 'Invoice no.', 'Customer', 'TIN', 'VATable sales', 'Zero-rated', 'Exempt', 'Output VAT', 'Total'];
        rows = d.map((x) => [show(x.doc_date), x.doc_no, x.party_name, x.party_tin, x.vatable, x.zero_rated, x.exempt, x.vat, x.total]);
        foot = ['', '', 'Totals', '', sum(d, 'vatable'), sum(d, 'zero_rated'), sum(d, 'exempt'), sum(d, 'vat'), sum(d, 'total')];
      } else { headers = ['Date', 'Invoice no.', 'Customer', 'TIN', 'Gross sales (percentage tax base)'];
        rows = d.map((x) => [show(x.doc_date), x.doc_no, x.party_name, x.party_tin, x.total]); foot = ['', '', 'Totals', '', sum(d, 'total')]; }
    } else if (book === 'pj') {
      const d = docs('purchase');
      const claim = (x) => (x.input_vat_allowed ? x.vat : 0);
      if (vat) { headers = ['Date', 'Invoice no.', 'Supplier', 'TIN', 'Net of VAT', 'Exempt / non-VAT', 'Input VAT (claimable)', 'VAT not claimable', 'Total'];
        rows = d.map((x) => [show(x.doc_date), x.doc_no, x.party_name, x.party_tin, x.vatable + x.zero_rated, x.exempt, claim(x), x.vat - claim(x), x.total]);
        foot = ['', '', 'Totals', '', d.reduce((s, x) => s + x.vatable + x.zero_rated, 0), sum(d, 'exempt'), d.reduce((s, x) => s + claim(x), 0), d.reduce((s, x) => s + x.vat - claim(x), 0), sum(d, 'total')];
      } else { headers = ['Date', 'Invoice no.', 'Supplier', 'TIN', 'Total (gross)'];
        rows = d.map((x) => [show(x.doc_date), x.doc_no, x.party_name, x.party_tin, x.total]); foot = ['', '', 'Totals', '', sum(d, 'total')]; }
    } else if (book === 'crj' || book === 'cdj') {
      const js = L.journalEntries(db, c.id, { from, to });
      const isCash = (l) => l.code === '1010' || l.code === '1020';
      const pick = js.filter((j) => j.lines.some((l) => isCash(l) && (book === 'crj' ? l.debit : l.credit)));
      headers = ['Date', 'JE #', 'Reference', 'Particulars', book === 'crj' ? 'Cash debit' : 'Cash credit', 'Account', 'Debit', 'Credit'];
      rows = pick.flatMap((j) => { const cash = j.lines.filter(isCash).reduce((s, l) => s + (book === 'crj' ? l.debit - l.credit : l.credit - l.debit), 0);
        return j.lines.filter((l) => !isCash(l)).map((l, i) => [i ? '' : show(j.date), i ? '' : j.id, i ? '' : j.ref, i ? '' : j.memo, i ? null : cash, l.code + ' ' + l.name, l.debit, l.credit]); });
      foot = ['', '', '', 'Total cash', pick.reduce((s, j) => s + j.lines.filter(isCash).reduce((a, l) => a + (book === 'crj' ? l.debit - l.credit : l.credit - l.debit), 0), 0), '', null, null];
    } else if (book === 'ar' || book === 'ap') {
      const kind = book === 'ar' ? 'sale' : 'purchase';
      const d = db.prepare(`SELECT * FROM documents WHERE client_id = ? AND kind = ? AND payment = 'credit' AND status = 'posted' AND doc_date <= ? ORDER BY party_name, doc_date`).all(c.id, kind, to);
      headers = [book === 'ar' ? 'Customer' : 'Supplier', 'Date', 'Invoice no.', 'Amount', 'Running balance'];
      let cur = null, run = 0; rows = [];
      for (const x of d) { if (x.party_name !== cur) { cur = x.party_name; run = 0; } run += x.total; rows.push([x.party_name, show(x.doc_date), x.doc_no, x.total, run]); }
      foot = ['Total', '', '', sum(d, 'total'), null];
      rows.push(['', '', 'Note: collections/payments are recorded via journal entries; see GL account ' + (book === 'ar' ? '1100' : '2010') + ' for the net balance.', null, null]);
    } else if (book === 'tb') {
      const tb = L.trialBalance(db, c.id, { from, to });
      headers = ['Code', 'Account', 'Debit', 'Credit'];
      rows = tb.rows.map((r) => [r.code, r.name, r.debit, r.credit]); foot = ['', tb.balanced ? 'Totals (balanced ✔)' : 'Totals — NOT BALANCED', tb.totalDebit, tb.totalCredit];
    }
    if (isCsv) return csv(res, `${c.tin}-${book}-${from}-${to}`, headers, [...rows, ...(foot ? [foot] : [])].map((r) => r.map((v) => (typeof v === 'number' ? toDecimal(v) : v))));
    const cell = (v, i) => (typeof v === 'number' ? html`<td class="num">${fmt(v)}</td>` : v === null ? html`<td></td>` : html`<td>${v}</td>`);
    res.page({ title: BOOKS[book], client: c, active: 'books', body: html`
      <div class="actions no-print">${Object.entries(BOOKS).map(([k, l]) => html`<a class="btn ${k === book ? '' : 'secondary'}" href="?book=${k}&from=${from}&to=${to}">${l}</a>`)}</div>
      ${rangeForm(c, '', html`<input type="hidden" name="book" value="${book}">`, { from, to })}
      <div class="actions no-print"><button onclick="window.print()" class="secondary">Print / save as PDF</button><a class="btn secondary" href="?book=${book}&from=${from}&to=${to}&format=csv">Download Excel (CSV)</a></div>
      ${header(c, BOOKS[book], book === 'tb' ? null : from, to)}
      ${table(headers, rows.map((r) => html`<tr>${r.map(cell)}</tr>`), { foot: foot ? html`<tr>${foot.map(cell)}</tr>` : null })}
      <p class="muted">Books type: ${c.books_type}. Prepared by L2C Tax and Accounting Services · Generated ${show(today())}.</p>` });
  });

  // ================= FINANCIAL STATEMENTS =================
  app.get('/clients/:cid/fs', (req, res) => {
    const c = req.client; const { from, to } = range(req);
    const is = L.incomeStatement(db, c.id, { from, to });
    const bs = L.balanceSheet(db, c.id, { to });
    // comparative: same period one year earlier
    const py = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    const isPy = L.incomeStatement(db, c.id, { from: py(from), to: py(to) });
    const bsPy = L.balanceSheet(db, c.id, { to: py(to) });
    const equityName = { individual: "Owner's Equity", partnership: "Partners' Equity", gpp: "Partners' Equity", nonstock: 'Fund Balance', cooperative: 'Members\' Equity' }[c.taxpayer_type] || "Stockholders' Equity";
    const isNP = c.taxpayer_type === 'nonstock';
    const line = (label, v, pv, cls = '') => html`<tr class="${cls}"><td>${label}</td><td class="num">${fmt(v)}</td><td class="num">${pv === undefined ? '' : fmt(pv)}</td></tr>`;
    const pyAmt = (list, code) => (list.find((x) => x.code === code) || { amount: 0 }).amount;
    const H = ['', 'Current', 'Prior year'];
    const priorEq = bs.totalEquity - bs.netIncome; // capital + unclosed earnings before this period (approx.)
    const netInPeriod = is.netIncome;
    res.page({ title: 'Financial statements', client: c, active: 'fs', body: html`
      ${rangeForm(c, '', '', { from, to })}
      <div class="actions no-print"><button onclick="window.print()" class="secondary">Print / save as PDF</button></div>
      ${!bs.balanced ? html`<div class="flash error">Balance sheet does not balance — check the trial balance.</div>` : ''}
      ${header(c, 'Statement of Financial Position', null, to)}
      ${table(H, [
        html`<tr><td colspan="3"><strong>ASSETS</strong></td></tr>`, ...bs.assets.map((a) => line(a.name, a.amount, pyAmt(bsPy.assets, a.code), 'indent')), line('Total assets', bs.totalAssets, bsPy.totalAssets, 'total'),
        html`<tr><td colspan="3"><strong>LIABILITIES</strong></td></tr>`, ...bs.liabilities.map((a) => line(a.name, a.amount, pyAmt(bsPy.liabilities, a.code), 'indent')), line('Total liabilities', bs.totalLiabilities, bsPy.totalLiabilities, 'total'),
        html`<tr><td colspan="3"><strong>${equityName.toUpperCase()}</strong></td></tr>`, ...bs.equity.map((a) => line(a.name, a.amount, pyAmt(bsPy.equity, a.code), 'indent')),
        line(isNP ? 'Excess of revenue over expenses (unclosed)' : 'Net income (not yet closed)', bs.netIncome, bsPy.netIncome, 'indent'), line('Total ' + equityName.toLowerCase(), bs.totalEquity, bsPy.totalEquity, 'total'),
        line('Total liabilities and ' + equityName.toLowerCase(), bs.totalLiabilities + bs.totalEquity, bsPy.totalLiabilities + bsPy.totalEquity, 'total')])}
      <div class="pagebreak"></div>
      ${header(c, isNP ? 'Statement of Activities' : 'Statement of Comprehensive Income', from, to)}
      ${table(H, [
        line(isNP ? 'Contributions and revenue' : 'Revenue', is.revenue, isPy.revenue), line('Cost of sales / services', -is.totalCos, -isPy.totalCos, 'indent'), line('Gross profit', is.grossProfit, isPy.grossProfit, 'total'),
        line('Other income', is.otherIncome, isPy.otherIncome),
        html`<tr><td colspan="3"><strong>Operating expenses</strong></td></tr>`, ...is.opex.map((a) => line(a.name, a.amount, pyAmt(isPy.opex, a.code), 'indent')), line('Total operating expenses', is.totalOpex, isPy.totalOpex, 'total'),
        line(isNP ? 'Change in net assets' : 'Net income (loss) before tax', is.netIncome, isPy.netIncome, 'total')])}
      <p class="muted">Income tax expense is recorded through an adjusting entry after the tax computation is finalized.</p>
      <div class="pagebreak"></div>
      ${header(c, isNP ? 'Statement of Changes in Fund Balance' : `Statement of Changes in ${equityName}`, from, to)}
      ${table(['', 'Amount'], [
        html`<tr><td>Balance at beginning / contributions (capital accounts + prior unclosed income)</td><td class="num">${fmt(priorEq + bs.netIncome - netInPeriod)}</td></tr>`,
        html`<tr><td>Net income for the period</td><td class="num">${fmt(netInPeriod)}</td></tr>`],
        { foot: html`<tr><td>Balance at end of period</td><td class="num">${fmt(bs.totalEquity)}</td></tr>` })}
      <p class="muted">MVP note: Statement of Cash Flows and Notes to FS templates are planned for Phase 2 (see README).</p>` });
  });

  // ================= TAX =================
  app.get('/clients/:cid/tax', (req, res) => {
    const c = req.client;
    const t = today();
    const year = Number(req.query.year) || Number(t.slice(0, 4));
    const q = Math.min(4, Math.max(1, Number(req.query.q) || Math.ceil(Number(t.slice(5, 7)) / 3)));
    const vat = c.vat_status === 'VAT' ? T.vatQuarter(db, c, year, q) : null;
    const pt = c.vat_status === 'NONVAT' && c.taxpayer_type !== 'nonstock' && c.income_regime !== '8pct' ? T.percentageTaxQuarter(db, c, year, q) : null;
    const it = T.incomeTaxQuarter(db, c, year, q);
    const ws = (title, r) => html`<h2>${title}</h2><p class="muted">Period ${show(r.from)} – ${show(r.to)}</p>
      ${table(['Line', 'Description', 'Amount (₱)'], r.lines.map(([ref, label, v]) => html`<tr><td class="muted">${ref}</td><td>${label}</td><td class="num">${fmt(v)}</td></tr>`))}
      ${(r.notes || []).map((n) => html`<p class="muted">• ${n}</p>`)}`;
    res.page({ title: 'Tax', client: c, active: 'tax', body: html`
      <form class="card actions no-print" method="get"><div><label>Fiscal year (ending)</label><input name="year" value="${year}" inputmode="numeric"></div>
        <div><label>Quarter</label><select name="q">${[1, 2, 3, 4].map((n) => html`<option value="${n}" ${n === q ? 'selected' : ''}>${n === 4 ? 'Q4 / Annual' : 'Q' + n}</option>`)}</select></div>
        <div style="align-self:end"><button>Compute</button> <button type="button" class="secondary" onclick="window.print()">Print</button></div></form>
      <div class="card summary"><h2 style="margin-top:0">Plain-language summary (for the client)</h2>${T.plainSummary(c, year, q, { vat, pt, it }).map((p) => html`<p>${p}</p>`)}</div>
      ${vat ? ws(`VAT — BIR Form 2550Q worksheet`, vat) : ''}
      ${pt ? ws('Percentage tax — BIR Form 2551Q worksheet', pt) : ''}
      ${c.income_regime === '8pct' && c.vat_status === 'NONVAT' ? html`<p class="muted">8% option: the 8% income tax is in lieu of the graduated rates AND the percentage tax, so no 2551Q is computed.</p>` : ''}
      ${ws(`Income tax — BIR Form ${it.form} worksheet (cumulative)`, it)}
      <p class="muted">Computed from POSTED documents and journal entries only. Uses the tax rule versions effective for the period (see Tax rules). Review before filing; EWT/2307 and compensation withholding are planned for the next phase.</p>` });
  });

  // ================= FILINGS / COMPLIANCE =================
  app.get('/clients/:cid/filings', (req, res) => {
    const c = req.client; const t = today();
    const rows = db.prepare('SELECT * FROM filings WHERE client_id = ? ORDER BY due_date').all(c.id);
    const approver = auth.can.approve(req.user);
    res.page({ title: 'Filings', client: c, active: 'filings', body: html`<h1>Filing calendar</h1>
      <p class="muted">Generated from the client's registered tax types (${c.tax_types || 'none set'}) and fiscal year. Deadlines that fall on a weekend move to the next working day (holidays are not yet considered — double-check).</p>
      ${approver ? html`<form class="actions no-print" method="post" action="/clients/${c.id}/filings/generate"><input name="year" value="${Number(t.slice(0, 4)) + 1}" style="width:110px" inputmode="numeric"><button class="secondary">Generate calendar for this fiscal year</button></form>` : ''}
      ${table(['Due', 'Form', 'Period', 'Status', 'Filed', 'Reference / amount', ''], rows.map((f) => {
        const st = f.status === 'filed' ? badge('filed') : f.due_date < t ? html`<span class="badge b-overdue">Overdue ${Math.round((new Date(t) - new Date(f.due_date)) / 86400000)}d</span>` : f.due_date === t ? html`<span class="badge b-for_review">Due today</span>` : badge('pending');
        return html`<tr><td>${show(f.due_date)}</td><td><strong>${f.form}</strong></td><td>${f.period_label}</td><td>${st}</td><td>${show(f.filed_date)}</td>
          <td>${f.reference || ''}${f.amount_paid != null ? html`<div class="num">${peso(f.amount_paid)}</div>` : ''}</td>
          <td>${f.status === 'pending' && approver ? html`<details><summary>Mark filed</summary><form method="post" action="/clients/${c.id}/filings/${f.id}">
            <label>Date filed</label><input type="date" name="filed_date" value="${t}" required><label>Confirmation / reference no.</label><input name="reference" required>
            <label>Amount paid (₱)</label><input name="amount_paid" inputmode="decimal"><div class="actions"><button>Save</button></div></form></details>` : ''}
            ${f.status === 'pending' && f.due_date < t ? html`<a href="/penalty?due=${f.due_date}&size=${c.size}">penalty?</a>` : ''}</td></tr>`;
      }))}` });
  });
  app.post('/clients/:cid/filings/generate', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go(`/clients/${req.client.id}/filings`, 'Not allowed.', true);
    const n = generateFilings(db, req.client, Number(req.body.year));
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'filings', action: 'generate', after: { year: req.body.year, added: n } });
    res.go(`/clients/${req.client.id}/filings`, `${n} filing(s) added.`);
  });
  app.post('/clients/:cid/filings/:fid', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go(`/clients/${req.client.id}/filings`, 'Not allowed.', true);
    const f = db.prepare('SELECT * FROM filings WHERE id = ? AND client_id = ?').get(Number(req.params.fid), req.client.id);
    if (!f) return res.status(404).send('Not found');
    const b = req.body; const amt = b.amount_paid ? parseMoney(b.amount_paid) : null;
    db.prepare("UPDATE filings SET status = 'filed', filed_date = ?, reference = ?, amount_paid = ? WHERE id = ?").run(b.filed_date, b.reference, amt, f.id);
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'filing', entity_id: f.id, action: 'filed', before: f, after: b });
    res.go(`/clients/${req.client.id}/filings`, `${f.form} ${f.period_label} marked as filed.`);
  });
};
