'use strict';
const { html } = require('../html');
const { page, table, badge, money } = require('../layout');
const auth = require('../auth');
const { audit, tx } = require('../db');
const { createChart } = require('../coa');
const { show, today, addDays } = require('../dates');
const { fmt, peso } = require('../money');
const { generateFilings } = require('../calendar');
const { TIN_RE } = require('../validate');

const TYPES = { individual: 'Sole proprietor / professional', corporation: 'Corporation', opc: 'One Person Corporation', partnership: 'Partnership (taxable)', gpp: 'General professional partnership', nonstock: 'Non-stock / non-profit', cooperative: 'Cooperative' };
const REGIMES = { graduated: 'Graduated rates (individual)', '8pct': '8% gross sales option (individual)', rcit: 'Regular corporate income tax', small_corp: 'Small corporation rate (20%)', exempt: 'Exempt' };
const TAXTYPES = { VAT: 'VAT (2550Q)', PT: 'Percentage tax (2551Q)', IT: 'Income tax (quarterly + annual)', EWT: 'Expanded withholding (0619-E/1601-EQ/1604-E)', WTC: 'Withholding on compensation (1601-C/1604-C)' };
const FIELDS = ['reg_name', 'trade_name', 'tin', 'branch', 'rdo', 'address', 'psic', 'taxpayer_type', 'vat_status', 'income_regime', 'deduction', 'fy_end_month', 'accounting_method', 'books_type', 'size', 'withholding_agent', 'ops_start_year', 'tax_types', 'contact', 'notes'];

function clientForm(c = {}, action) {
  const sel = (name, opts, v) => html`<select name="${name}">${Object.entries(opts).map(([k, l]) => html`<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${l}</option>`)}</select>`;
  const tt = new Set((c.tax_types || '').split(','));
  return html`<form class="card" method="post" action="${action}">
    <h3>Registration (from BIR Form 2303 / COR)</h3>
    <div class="row">
      <div><label>Registered name</label><input name="reg_name" value="${c.reg_name || ''}" required></div>
      <div><label>Trade name</label><input name="trade_name" value="${c.trade_name || ''}"></div>
      <div><label>TIN (000-000-000)</label><input name="tin" value="${c.tin || ''}" required inputmode="numeric"></div>
      <div><label>Branch code</label><input name="branch" value="${c.branch || '000'}" inputmode="numeric"></div>
      <div><label>RDO</label><input name="rdo" value="${c.rdo || ''}"></div>
      <div><label>Line of business / PSIC</label><input name="psic" value="${c.psic || ''}"></div>
    </div>
    <label>Registered address</label><input name="address" value="${c.address || ''}">
    <h3>Tax profile</h3>
    <div class="row">
      <div><label>Taxpayer type</label>${sel('taxpayer_type', TYPES, c.taxpayer_type)}</div>
      <div><label>VAT registration</label>${sel('vat_status', { VAT: 'VAT-registered', NONVAT: 'Non-VAT' }, c.vat_status)}</div>
      <div><label>Income tax regime</label>${sel('income_regime', REGIMES, c.income_regime)}</div>
      <div><label>Deduction method</label>${sel('deduction', { itemized: 'Itemized', osd: 'Optional standard deduction (40%)' }, c.deduction)}</div>
      <div><label>Fiscal year ends (month)</label>${sel('fy_end_month', Object.fromEntries([...Array(12)].map((_, i) => [i + 1, new Date(2000, i, 1).toLocaleString('en', { month: 'long' }) + (i === 11 ? ' (calendar year)' : '')])), c.fy_end_month || 12)}</div>
      <div><label>Taxpayer size (EOPT)</label>${sel('size', { micro: 'Micro (< ₱3M)', small: 'Small (₱3M–₱20M)', medium: 'Medium (₱20M–₱1B)', large: 'Large (≥ ₱1B)' }, c.size)}</div>
      <div><label>Accounting method</label>${sel('accounting_method', { accrual: 'Accrual', cash: 'Cash' }, c.accounting_method)}</div>
      <div><label>Books type</label>${sel('books_type', { 'loose-leaf': 'Loose-leaf', manual: 'Manual', computerized: 'Computerized' }, c.books_type)}</div>
      <div><label>Withholding agent?</label>${sel('withholding_agent', { 0: 'No', 1: 'Yes' }, c.withholding_agent || 0)}</div>
      <div><label>Year operations started</label><input name="ops_start_year" value="${c.ops_start_year || ''}" inputmode="numeric"></div>
    </div>
    <label>Registered tax types / form obligations</label>
    ${Object.entries(TAXTYPES).map(([k, l]) => html`<label style="font-weight:400"><input type="checkbox" name="tt_${k}" ${tt.has(k) ? 'checked' : ''}>${l}</label>`)}
    <div class="row"><div><label>Contact person / phone / email</label><input name="contact" value="${c.contact || ''}"></div>
    <div><label>Notes</label><input name="notes" value="${c.notes || ''}"></div></div>
    <div class="actions"><button>Save client</button></div></form>`;
}

function readClient(body) {
  const c = {};
  for (const f of FIELDS) c[f] = body[f] ?? null;
  c.tax_types = Object.keys(TAXTYPES).filter((k) => body['tt_' + k]).join(',');
  c.fy_end_month = Number(c.fy_end_month) || 12;
  c.withholding_agent = Number(c.withholding_agent) || 0;
  c.ops_start_year = c.ops_start_year ? Number(c.ops_start_year) : null;
  if (!TIN_RE.test(c.tin || '')) throw new Error('TIN format looks wrong (expected 000-000-000).');
  if (c.taxpayer_type === 'individual' && ['rcit', 'small_corp'].includes(c.income_regime)) throw new Error('Individuals use graduated or 8% regime.');
  if (c.taxpayer_type !== 'individual' && ['graduated', '8pct'].includes(c.income_regime)) throw new Error('Graduated / 8% regimes are for individuals only.');
  if (c.income_regime === '8pct' && c.vat_status === 'VAT') throw new Error('The 8% option is not available to VAT-registered taxpayers.');
  return c;
}

module.exports = function (app, db) {
  // Load client + access check for every /clients/:cid route (multi-client isolation)
  app.param('cid', (req, res, next, id) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id));
    if (!c) return res.status(404).page({ title: 'Not found', body: html`<h1>Client not found</h1>` });
    if (!auth.canSeeClient(db, req.user, c.id)) return res.status(403).page({ title: 'Not allowed', body: html`<h1>You are not assigned to this client.</h1>` });
    req.client = c; next();
  });

  app.get('/clients', (req, res) => {
    const clients = auth.visibleClients(db, req.user);
    const t = today();
    const stat = db.prepare(`SELECT
      (SELECT COUNT(*) FROM filings WHERE client_id = ? AND status='pending' AND due_date < ?) AS overdue,
      (SELECT COUNT(*) FROM documents WHERE client_id = ? AND status IN ('for_encoding','encoded','rejected','for_review','approved')) AS open`);
    res.page({ title: 'Clients', body: html`<h1>Clients</h1>
      ${auth.can.approve(req.user) ? html`<div class="actions"><a class="btn" href="/clients/new">+ New client</a></div>` : ''}
      ${table(['Client', 'TIN', 'Type', 'VAT', 'Open docs', 'Overdue filings'], clients.map((c) => { const s = stat.get(c.id, t, c.id); return html`<tr>
        <td><a href="/clients/${c.id}">${c.reg_name}</a>${c.trade_name ? html`<div class="muted">${c.trade_name}</div>` : ''}</td><td>${c.tin}-${c.branch}</td>
        <td>${TYPES[c.taxpayer_type]}</td><td>${c.vat_status}</td><td>${s.open}</td><td>${s.overdue ? html`<span class="badge b-overdue">${s.overdue}</span>` : '0'}</td></tr>`; }))}` });
  });

  app.get('/clients/new', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go('/clients', 'Only accountants and admins can add clients.', true);
    res.page({ title: 'New client', body: html`<h1>New client</h1>${clientForm({ tax_types: 'IT' }, '/clients')}` });
  });
  app.post('/clients', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go('/clients', 'Not allowed.', true);
    let c; try { c = readClient(req.body); } catch (e) { return res.go('/clients/new', e.message, true); }
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO clients (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`).run(...FIELDS.map((f) => c[f]));
      const id = Number(r.lastInsertRowid);
      createChart(db, id, c.taxpayer_type, c.vat_status === 'VAT');
      db.prepare('INSERT OR IGNORE INTO client_staff (client_id, user_id) VALUES (?,?)').run(id, req.user.id);
      audit(db, { user_id: req.user.id, client_id: id, entity: 'client', entity_id: id, action: 'create', after: c });
      return id;
    });
    const y = Number(today().slice(0, 4));
    generateFilings(db, { ...c, id }, y);
    res.go(`/clients/${id}`, 'Client created with default chart of accounts and filing calendar.');
  });

  app.get('/clients/:cid', (req, res) => {
    const c = req.client;
    const y = today().slice(0, 4);
    const months = db.prepare(`SELECT substr(doc_date,1,7) AS m,
        SUM(CASE WHEN kind='sale' THEN total ELSE 0 END) AS sales, SUM(CASE WHEN kind='purchase' THEN total ELSE 0 END) AS purchases
      FROM documents WHERE client_id = ? AND status = 'posted' AND doc_date >= ? GROUP BY m ORDER BY m`).all(c.id, `${Number(y) - 1}-01-01`);
    const maxv = Math.max(1, ...months.map((m) => Math.max(m.sales, m.purchases)));
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM documents WHERE client_id = ? GROUP BY status').all(c.id).map((r) => [r.status, r.n]));
    const t = today();
    const filings = db.prepare(`SELECT * FROM filings WHERE client_id = ? AND status = 'pending' ORDER BY due_date LIMIT 6`).all(c.id);
    const top = db.prepare(`SELECT a.name, SUM(l.debit - l.credit) AS v FROM journal_lines l JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
      WHERE j.client_id = ? AND a.type = 'expense' AND j.date >= ? GROUP BY a.id ORDER BY v DESC LIMIT 5`).all(c.id, `${y}-01-01`);
    const bar = (v, color) => html`<div style="height:10px;background:${color};width:${Math.round((v / maxv) * 100)}%;border-radius:3px;min-width:${v ? 2 : 0}px"></div>`;
    res.page({ title: c.reg_name, client: c, active: 'overview', body: html`
      <div class="bigbtns">
        <a class="btn" href="/clients/${c.id}/docs/new?kind=sale">+ Sale / invoice</a>
        <a class="btn" href="/clients/${c.id}/docs/new?kind=purchase">+ Expense / purchase</a>
        <a class="btn secondary" href="/clients/${c.id}/docs/upload">📷 Upload receipt photos</a>
        <a class="btn secondary" href="/clients/${c.id}/docs?status=for_review">Review queue (${counts.for_review || 0})</a>
      </div>
      <div class="grid" style="margin-top:14px">
        ${['for_encoding', 'encoded', 'rejected', 'for_review', 'approved', 'posted'].map((s) => html`<a class="card" style="text-decoration:none;color:inherit" href="/clients/${c.id}/docs?status=${s}">${badge(s)}<div class="stat">${counts[s] || 0}</div></a>`)}
      </div>
      <h2>Next filings</h2>
      ${table(['Due', 'Form', 'Period', 'Status'], filings.map((f) => html`<tr><td>${show(f.due_date)}</td><td>${f.form}</td><td>${f.period_label}</td><td>${f.due_date < t ? html`<span class="badge b-overdue">Overdue</span>` : badge('pending')}</td></tr>`))}
      <h2>Sales vs expenses by month (posted)</h2>
      ${table(['Month', 'Sales', 'Expenses / purchases', ''], months.map((m) => html`<tr><td>${m.m}</td><td class="num">${fmt(m.sales)}</td><td class="num">${fmt(m.purchases)}</td>
        <td style="min-width:140px">${bar(m.sales, '#198754')}<div style="height:3px"></div>${bar(m.purchases, '#d97706')}</td></tr>`))}
      <h2>Top expenses this year</h2>
      ${table(['Account', 'Amount'], top.map((r) => html`<tr><td>${r.name}</td><td class="num">${fmt(r.v)}</td></tr>`))}` });
  });

  // ---------- Setup: profile, staff, accounts, parties, period locks ----------
  app.get('/clients/:cid/setup', (req, res) => {
    const c = req.client;
    const accounts = db.prepare('SELECT * FROM accounts WHERE client_id = ? ORDER BY code').all(c.id);
    const parties = db.prepare('SELECT p.*, a.name AS acct FROM parties p LEFT JOIN accounts a ON a.id = p.default_account_id WHERE p.client_id = ? ORDER BY kind, name').all(c.id);
    const staff = db.prepare('SELECT u.* FROM users u JOIN client_staff s ON s.user_id = u.id WHERE s.client_id = ?').all(c.id);
    const users = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name').all();
    const locks = db.prepare('SELECT l.*, u.name FROM period_locks l LEFT JOIN users u ON u.id = l.locked_by WHERE client_id = ? ORDER BY period DESC').all(c.id);
    const isAdmin = auth.can.admin(req.user), canEdit = auth.can.approve(req.user);
    res.page({ title: 'Setup', client: c, active: 'setup', body: html`
      <h1>Client setup</h1>
      ${canEdit ? html`<details><summary><strong>Edit client profile</strong></summary>${clientForm(c, `/clients/${c.id}`)}</details>` : ''}
      <h2>Suppliers &amp; customers (master list)</h2>
      ${table(['Kind', 'Name', 'TIN', 'VAT?', 'Default account'], parties.map((p) => html`<tr><td>${p.kind}</td><td>${p.name}<div class="muted">${p.address || ''}</div></td><td>${p.tin || ''}</td><td>${p.vat_registered ? 'VAT' : 'Non-VAT'}</td><td>${p.acct || ''}</td></tr>`))}
      <form class="card" method="post" action="/clients/${c.id}/parties"><h3>Add supplier / customer</h3><div class="row">
        <div><label>Kind</label><select name="kind"><option value="supplier">Supplier</option><option value="customer">Customer</option></select></div>
        <div><label>Name</label><input name="name" required></div><div><label>TIN</label><input name="tin" inputmode="numeric"></div>
        <div><label>VAT-registered?</label><select name="vat_registered"><option value="1">Yes</option><option value="0">No</option></select></div>
        <div><label>Default account</label><select name="default_account_id"><option value="">—</option>${accounts.map((a) => html`<option value="${a.id}">${a.code} ${a.name}</option>`)}</select></div>
      </div><label>Address</label><input name="address"><div class="actions"><button>Add</button></div></form>

      <h2>Chart of accounts</h2>
      ${table(['Code', 'Name', 'Type'], accounts.map((a) => html`<tr><td>${a.code}</td><td>${a.name}</td><td>${a.type}</td></tr>`))}
      ${canEdit ? html`<form class="card" method="post" action="/clients/${c.id}/accounts"><h3>Add account</h3><div class="row">
        <div><label>Code</label><input name="code" required></div><div><label>Name</label><input name="name" required></div>
        <div><label>Type</label><select name="type">${['asset', 'liability', 'equity', 'income', 'expense'].map((t) => html`<option>${t}</option>`)}</select></div>
      </div><p class="muted">Codes starting with 5 are treated as cost of sales in the income statement.</p><div class="actions"><button>Add account</button></div></form>` : ''}

      <h2>Assigned staff</h2>
      <p>${staff.map((s) => s.name).join(', ') || 'None'}</p>
      ${isAdmin ? html`<form class="card" method="post" action="/clients/${c.id}/staff"><label>Assigned staff (tick all that apply)</label>
        ${users.map((u) => html`<label style="font-weight:400"><input type="checkbox" name="u_${u.id}" ${staff.some((s) => s.id === u.id) ? 'checked' : ''}>${u.name} (${u.role})</label>`)}
        <div class="actions"><button>Save assignment</button></div></form>` : ''}

      <h2>Period locks</h2>
      <p class="muted">Lock a month after its returns are filed. Nothing can be posted into a locked month. Unlocking requires a reason and is logged.</p>
      ${table(['Period', 'Locked by', 'When', 'Reason'], locks.map((l) => html`<tr><td>${l.period}</td><td>${l.name || ''}</td><td>${l.locked_at}</td><td>${l.reason || ''}</td></tr>`))}
      ${isAdmin ? html`<form class="card" method="post" action="/clients/${c.id}/lock"><div class="row">
        <div><label>Month</label><input type="month" name="period" required></div>
        <div><label>Action</label><select name="action"><option value="lock">Lock</option><option value="unlock">Unlock</option></select></div>
        <div><label>Reason</label><input name="reason" required></div></div><div class="actions"><button>Apply</button></div></form>` : ''}` });
  });

  app.post('/clients/:cid', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go(`/clients/${req.client.id}/setup`, 'Not allowed.', true);
    let c; try { c = readClient(req.body); } catch (e) { return res.go(`/clients/${req.client.id}/setup`, e.message, true); }
    if (c.vat_status !== req.client.vat_status) createChart(db, req.client.id, c.taxpayer_type, c.vat_status === 'VAT'); // adds missing VAT/PT accounts
    db.prepare(`UPDATE clients SET ${FIELDS.map((f) => f + ' = ?').join(', ')} WHERE id = ?`).run(...FIELDS.map((f) => c[f]), req.client.id);
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'client', entity_id: req.client.id, action: 'update', before: req.client, after: c });
    res.go(`/clients/${req.client.id}/setup`, 'Client profile saved.');
  });

  app.post('/clients/:cid/parties', (req, res) => {
    const b = req.body;
    const r = db.prepare('INSERT INTO parties (client_id, kind, name, tin, address, vat_registered, default_account_id) VALUES (?,?,?,?,?,?,?)')
      .run(req.client.id, b.kind, b.name, b.tin || null, b.address || null, Number(b.vat_registered), b.default_account_id ? Number(b.default_account_id) : null);
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'party', entity_id: Number(r.lastInsertRowid), action: 'create', after: b });
    res.go(`/clients/${req.client.id}/setup`, 'Saved.');
  });

  app.post('/clients/:cid/accounts', (req, res) => {
    if (!auth.can.approve(req.user)) return res.go(`/clients/${req.client.id}/setup`, 'Not allowed.', true);
    try {
      db.prepare('INSERT INTO accounts (client_id, code, name, type) VALUES (?,?,?,?)').run(req.client.id, req.body.code, req.body.name, req.body.type);
      audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'account', action: 'create', after: req.body });
      res.go(`/clients/${req.client.id}/setup`, 'Account added.');
    } catch (e) { res.go(`/clients/${req.client.id}/setup`, 'Could not add account (code already used?).', true); }
  });

  app.post('/clients/:cid/staff', (req, res) => {
    if (!auth.can.admin(req.user)) return res.go(`/clients/${req.client.id}/setup`, 'Not allowed.', true);
    const ids = Object.keys(req.body).filter((k) => k.startsWith('u_')).map((k) => Number(k.slice(2)));
    tx(db, () => {
      db.prepare('DELETE FROM client_staff WHERE client_id = ?').run(req.client.id);
      for (const id of ids) db.prepare('INSERT INTO client_staff (client_id, user_id) VALUES (?,?)').run(req.client.id, id);
      audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'client_staff', action: 'assign', after: ids });
    });
    res.go(`/clients/${req.client.id}/setup`, 'Assignment saved.');
  });

  app.post('/clients/:cid/lock', (req, res) => {
    if (!auth.can.admin(req.user)) return res.go(`/clients/${req.client.id}/setup`, 'Only admins can lock/unlock periods.', true);
    const { period, action, reason } = req.body;
    if (!/^\d{4}-\d{2}$/.test(period || '') || !reason) return res.go(`/clients/${req.client.id}/setup`, 'Month and reason are required.', true);
    if (action === 'lock') db.prepare('INSERT OR REPLACE INTO period_locks (client_id, period, locked_by, reason) VALUES (?,?,?,?)').run(req.client.id, period, req.user.id, reason);
    else db.prepare('DELETE FROM period_locks WHERE client_id = ? AND period = ?').run(req.client.id, period);
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'period', action, after: { period, reason } });
    res.go(`/clients/${req.client.id}/setup`, `Period ${period} ${action}ed.`);
  });
};

module.exports.TYPES = TYPES;
