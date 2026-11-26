'use strict';
const path = require('path');
const express = require('express');
const auth = require('./auth');
const { audit } = require('./db');
const { html } = require('./html');
const { page, table, badge, money } = require('./layout');
const { show, today, addDays, isValidIso } = require('./dates');
const { parseMoney, peso, pct } = require('./money');
const { penalty } = require('./tax');

function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}

function createApp(db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.uploadDir = opts.uploadDir || path.join(__dirname, '..', 'data', 'uploads');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  // --- helpers available to all routes ---
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.user = auth.getSessionUser(db, req.cookies.sid);
    res.go = (url, msg, err) => res.redirect(url + (msg ? (url.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) : ''));
    res.page = (o) => res.send(page({ user: req.user, flash: req.query.err ? { type: 'error', msg: req.query.err } : req.query.ok ? { msg: req.query.ok } : null, ...o }));
    next();
  });

  // --- login ---
  app.get('/login', (req, res) => res.page({ title: 'Log in', body: html`
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>L2C Books &amp; Tax</h1>
      <form method="post" action="/login">
        <label>Username</label><input name="username" autocomplete="username" required autofocus>
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
        <div class="actions"><button>Log in</button></div>
      </form></div>` }));
  const attempts = new Map();
  app.post('/login', (req, res) => {
    const key = (req.body.username || '').toLowerCase();
    const a = attempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) return res.go('/login', 'Too many attempts. Try again in a few minutes.', true);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(key);
    if (!u || !auth.verifyPassword(req.body.password || '', u.salt, u.pass_hash)) {
      a.n += 1; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; } attempts.set(key, a);
      return res.go('/login', 'Wrong username or password.', true);
    }
    attempts.delete(key);
    const token = auth.createSession(db, u.id);
    audit(db, { user_id: u.id, entity: 'user', entity_id: u.id, action: 'login' });
    res.set('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
    res.set('Set-Cookie', 'sid=; Max-Age=0; Path=/'); res.redirect('/login');
  });

  // everything below requires login
  app.use((req, res, next) => { if (!req.user) return res.redirect('/login'); next(); });
  const adminOnly = (req, res, next) => auth.can.admin(req.user) ? next() : res.status(403).page({ title: 'Not allowed', body: html`<h1>Admins only</h1>` });

  // --- dashboard ---
  app.get('/', (req, res) => {
    const clients = auth.visibleClients(db, req.user);
    const ids = clients.map((c) => c.id);
    const t = today();
    const inList = ids.length ? ids.join(',') : '0';
    const filings = db.prepare(`SELECT f.*, c.reg_name FROM filings f JOIN clients c ON c.id = f.client_id
      WHERE f.client_id IN (${inList}) AND f.status = 'pending' AND f.due_date <= ? ORDER BY f.due_date LIMIT 60`).all(addDays(t, 14));
    const overdue = filings.filter((f) => f.due_date < t), dueToday = filings.filter((f) => f.due_date === t), upcoming = filings.filter((f) => f.due_date > t);
    const review = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE client_id IN (${inList}) AND status = 'for_review'`).get().n;
    // Missing-record alerts
    const alerts = [];
    const lastMonth = addDays(t.slice(0, 8) + '01', -1).slice(0, 7);
    for (const c of clients) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE client_id = ? AND kind = 'sale' AND substr(doc_date,1,7) = ? AND status <> 'reversed'`).get(c.id, lastMonth).n;
      if (!n) alerts.push({ red: false, c, msg: `No sales encoded for ${lastMonth}.` });
      const old = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE client_id = ? AND status IN ('for_encoding','encoded','rejected','for_review','approved') AND created_at < datetime('now','-7 days')`).get(c.id).n;
      if (old) alerts.push({ red: true, c, msg: `${old} document(s) not yet posted for more than 7 days.` });
    }
    const frow = (f) => html`<tr><td>${show(f.due_date)}</td><td><a href="/clients/${f.client_id}/filings">${f.reg_name}</a></td><td>${f.form}</td><td>${f.period_label}</td></tr>`;
    res.page({ title: 'Dashboard', body: html`
      <h1>Good day, ${req.user.name}</h1>
      <div class="grid">
        <div class="card"><div class="muted">Overdue filings</div><div class="stat" style="color:var(--red)">${overdue.length}</div></div>
        <div class="card"><div class="muted">Due today</div><div class="stat" style="color:var(--amber)">${dueToday.length}</div></div>
        <div class="card"><div class="muted">Due in next 14 days</div><div class="stat">${upcoming.length}</div></div>
        <div class="card"><div class="muted">Documents waiting for review</div><div class="stat">${review}</div></div>
      </div>
      ${overdue.length ? html`<h2>⚠ Overdue</h2>${table(['Due', 'Client', 'Form', 'Period'], overdue.map(frow))}` : ''}
      ${dueToday.length ? html`<h2>Due today</h2>${table(['Due', 'Client', 'Form', 'Period'], dueToday.map(frow))}` : ''}
      <h2>Upcoming (14 days)</h2>${table(['Due', 'Client', 'Form', 'Period'], upcoming.map(frow))}
      <h2>Missing records</h2>
      ${alerts.length ? alerts.map((a) => html`<div class="alert ${a.red ? 'red' : ''}"><a href="/clients/${a.c.id}/docs">${a.c.reg_name}</a>: ${a.msg}</div>`) : html`<p class="muted">All clients have records for last month.</p>`}
      ${req.user.role === 'admin' ? workload(db) : ''}` });
  });

  function workload(db) {
    const rows = db.prepare(`SELECT u.name, COUNT(DISTINCT s.client_id) AS clients,
      (SELECT COUNT(*) FROM filings f JOIN client_staff s2 ON s2.client_id = f.client_id WHERE s2.user_id = u.id AND f.status='pending' AND f.due_date < date('now','+8 hours')) AS overdue,
      (SELECT COUNT(*) FROM documents d JOIN client_staff s3 ON s3.client_id = d.client_id WHERE s3.user_id = u.id AND d.status IN ('for_review','approved')) AS review
      FROM users u LEFT JOIN client_staff s ON s.user_id = u.id WHERE u.active = 1 GROUP BY u.id ORDER BY u.name`).all();
    return html`<h2>Staff workload</h2>${table(['Staff', 'Clients', 'Overdue filings', 'Docs waiting'], rows.map((r) => html`<tr><td>${r.name}</td><td>${r.clients}</td><td>${r.overdue}</td><td>${r.review}</td></tr>`))}`;
  }

  // --- penalty calculator ---
  app.get('/penalty', (req, res) => {
    let result = '';
    const q = req.query;
    if (q.tax && isValidIso(q.due) && isValidIso(q.paid)) {
      try {
        const p = penalty(db, { tax: parseMoney(q.tax), dueDate: q.due, payDate: q.paid, size: q.size });
        result = html`<div class="card"><h2>Estimated amount to pay</h2>${table(['Item', 'Amount'], [
          html`<tr><td>Basic tax</td><td class="num">${peso(parseMoney(q.tax))}</td></tr>`,
          html`<tr><td>Surcharge (${pct(p.sRate)})</td><td class="num">${peso(p.surcharge)}</td></tr>`,
          html`<tr><td>Interest (${pct(p.iRate)} per year × ${p.days} days late)</td><td class="num">${peso(p.interest)}</td></tr>`],
        { foot: html`<tr><td>Total</td><td class="num">${peso(p.total)}</td></tr>` })}
        <p class="muted">Basis: ${p.basis}. ${p.note} ${p.needsReview ? '⚠ This rule is marked for review.' : ''}</p></div>`;
      } catch (e) { result = html`<div class="flash error">${e.message}</div>`; }
    }
    res.page({ title: 'Penalty estimator', body: html`<h1>Late filing penalty estimator</h1>
      <form class="card" method="get"><div class="row">
        <div><label>Basic tax due (₱)</label><input name="tax" inputmode="decimal" value="${q.tax || ''}" required></div>
        <div><label>Original due date</label><input type="date" name="due" value="${q.due || ''}" required></div>
        <div><label>Date of payment</label><input type="date" name="paid" value="${q.paid || today()}" required></div>
        <div><label>Taxpayer size</label><select name="size">${['micro', 'small', 'medium', 'large'].map((s) => html`<option ${q.size === s ? 'selected' : ''}>${s}</option>`)}</select></div>
      </div><div class="actions"><button>Compute</button></div></form>${result}` });
  });

  // --- admin: users ---
  app.get('/users', adminOnly, (req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY name').all();
    res.page({ title: 'Users', body: html`<h1>Staff users</h1>
      ${table(['Name', 'Username', 'Role', 'Active'], users.map((u) => html`<tr><td>${u.name}</td><td>${u.username}</td><td>${u.role}</td><td>${u.active ? 'Yes' : 'No'}</td></tr>`))}
      <h2>Add user</h2><form class="card" method="post" action="/users"><div class="row">
        <div><label>Full name</label><input name="name" required></div><div><label>Username</label><input name="username" required></div>
        <div><label>Role</label><select name="role"><option value="encoder">Encoder</option><option value="accountant">Accountant / Reviewer</option><option value="admin">Admin / Owner</option></select></div>
        <div><label>Temporary password (10+ chars, letters and numbers)</label><input name="password" type="password" required></div>
      </div><div class="actions"><button>Add user</button></div></form>` });
  });
  app.post('/users', adminOnly, (req, res) => {
    const { name, username, role, password } = req.body;
    if (!auth.strongEnough(password)) return res.go('/users', 'Password must be at least 10 characters with letters and numbers.', true);
    try {
      const id = auth.createUser(db, { name, username: username.toLowerCase(), role, password });
      audit(db, { user_id: req.user.id, entity: 'user', entity_id: id, action: 'create', after: { name, username, role } });
      res.go('/users', 'User added.');
    } catch (e) { res.go('/users', e.message, true); }
  });

  // --- admin: tax rules ---
  app.get('/rules', adminOnly, (req, res) => {
    const rules = db.prepare('SELECT * FROM rules ORDER BY key, effective_from').all();
    res.page({ title: 'Tax rules', body: html`<h1>Tax rule tables</h1>
      <p class="muted">Computations always use the version effective on the transaction/period date. To change a rate, add a NEW version with its effective date — do not edit old ones. Money is in centavos; rates in parts-per-million (12% = 120000).</p>
      ${table(['Key', 'Effective', 'Value', 'Legal basis / notes'], rules.map((r) => html`<tr>
        <td><strong>${r.key}</strong>${r.needs_review ? html` <span class="badge b-for_review">needs review</span>` : ''}</td>
        <td>${show(r.effective_from)} – ${r.effective_to ? show(r.effective_to) : 'onwards'}</td>
        <td><code style="font-size:12px;word-break:break-all">${r.value.length > 160 ? r.value.slice(0, 160) + '…' : r.value}</code></td>
        <td>${r.legal_basis}${r.notes ? html`<br><span class="muted">${r.notes}</span>` : ''}</td></tr>`))}
      <h2>Add a new rule version</h2>
      <form class="card" method="post" action="/rules"><div class="row">
        <div><label>Key</label><input name="key" list="rulekeys" required><datalist id="rulekeys">${[...new Set(rules.map((r) => r.key))].map((k) => html`<option value="${k}">`)}</datalist></div>
        <div><label>Effective from</label><input type="date" name="effective_from" required></div>
        <div><label>Effective to (optional)</label><input type="date" name="effective_to"></div>
      </div>
      <label>Value (JSON)</label><textarea name="value" rows="3" required></textarea>
      <label>Legal basis (RR / RMC / law)</label><input name="legal_basis" required>
      <label>Notes</label><input name="notes">
      <div class="actions"><button>Save new version</button></div></form>` });
  });
  app.post('/rules', adminOnly, (req, res) => {
    const b = req.body;
    try { JSON.parse(b.value); } catch { return res.go('/rules', 'Value must be valid JSON.', true); }
    if (!isValidIso(b.effective_from)) return res.go('/rules', 'Effective-from date is required.', true);
    const r = db.prepare('INSERT INTO rules (key, value, effective_from, effective_to, legal_basis, notes, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(b.key.trim(), b.value, b.effective_from, b.effective_to || null, b.legal_basis, b.notes || null, req.user.id);
    audit(db, { user_id: req.user.id, entity: 'rule', entity_id: Number(r.lastInsertRowid), action: 'create', after: b });
    res.go('/rules', 'New rule version saved.');
  });

  // --- admin: audit log ---
  app.get('/audit', adminOnly, (req, res) => {
    const rows = db.prepare(`SELECT a.*, u.name AS uname, c.reg_name FROM audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN clients c ON c.id = a.client_id
      ${req.query.client ? 'WHERE a.client_id = ?' : ''} ORDER BY a.id DESC LIMIT 300`).all(...(req.query.client ? [req.query.client] : []));
    res.page({ title: 'Audit log', body: html`<h1>Audit log</h1><p class="muted">Append-only. Last 300 events.</p>
      ${table(['When (UTC)', 'User', 'Client', 'What', 'Details'], rows.map((r) => html`<tr><td>${r.at}</td><td>${r.uname || ''}</td><td>${r.reg_name || ''}</td>
        <td>${r.entity} #${r.entity_id || ''} · ${r.action}</td><td style="font-size:12px;max-width:420px;word-break:break-word">${r.before ? html`<div><b>before:</b> ${r.before.slice(0, 300)}</div>` : ''}${r.after ? html`<div><b>after:</b> ${r.after.slice(0, 300)}</div>` : ''}</td></tr>`))}` });
  });

  require('./routes/clients')(app, db);
  require('./routes/docs')(app, db);
  require('./routes/reports')(app, db);

  app.use((req, res) => res.status(404).page({ title: 'Not found', body: html`<h1>Page not found</h1>` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).page({ title: 'Error', body: html`<h1>Something went wrong</h1><div class="flash error">${err.message}</div><p><a href="javascript:history.back()">Go back</a></p>` });
  });
  return app;
}

module.exports = { createApp };
