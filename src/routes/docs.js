'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { html } = require('../html');
const { table, badge, money, STATUS_LABEL } = require('../layout');
const auth = require('../auth');
const { audit, tx } = require('../db');
const { show, today, isValidIso } = require('../dates');
const { parseMoney, toDecimal, fmt, splitVatInclusive } = require('../money');
const { validateDocument, inputVatAllowed, hasErrors } = require('../validate');
const { postJournal, linesForDocument, reverseJournal } = require('../ledger');
const { getRule } = require('../rules');

const EDITABLE = { encoder: ['for_encoding', 'encoded', 'rejected'], accountant: ['for_encoding', 'encoded', 'rejected', 'for_review'], admin: ['for_encoding', 'encoded', 'rejected', 'for_review'] };

module.exports = function (app, db) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => { const d = path.join(app.locals.uploadDir, String(req.client.id)); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 30 },
    fileFilter: (req, file, cb) => cb(null, /^(image\/|application\/pdf)/.test(file.mimetype)),
  });
  const base = (c) => `/clients/${c.id}/docs`;

  // ---------- list ----------
  app.get('/clients/:cid/docs', (req, res) => {
    const c = req.client; const st = req.query.status; const kind = req.query.kind;
    const where = ['client_id = ?']; const args = [c.id];
    if (st) { where.push('status = ?'); args.push(st); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (req.query.month) { where.push('substr(doc_date,1,7) = ?'); args.push(req.query.month); }
    const docs = db.prepare(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY COALESCE(doc_date, created_at) DESC, id DESC LIMIT 500`).all(...args);
    const tab = (s, l) => html`<a class="btn ${st === s ? '' : 'secondary'}" href="${base(c)}${s ? '?status=' + s : ''}">${l}</a>`;
    res.page({ title: 'Documents', client: c, active: 'docs', body: html`
      <h1>Documents</h1>
      <div class="actions">
        <a class="btn" href="${base(c)}/new?kind=sale">+ Sale</a><a class="btn" href="${base(c)}/new?kind=purchase">+ Expense</a>
        <a class="btn secondary" href="${base(c)}/upload">📷 Upload photos</a>
        ${auth.can.approve(req.user) ? html`<a class="btn secondary" href="/clients/${c.id}/journal/new">+ Journal entry</a>` : ''}
      </div>
      <div class="actions">${tab('', 'All')}${Object.keys(STATUS_LABEL).filter((s) => !['pending', 'filed'].includes(s)).map((s) => tab(s, STATUS_LABEL[s]))}</div>
      ${table(['Date', 'Type', 'No.', 'Customer / supplier', 'Total', 'Status', 'Flags'], docs.map((d) => {
        const flags = JSON.parse(d.flags);
        return html`<tr><td>${show(d.doc_date)}</td><td>${d.kind === 'sale' ? 'Sale' : 'Expense'}</td>
          <td><a href="${base(c)}/${d.id}">${d.doc_no || '(no number) #' + d.id}</a></td><td>${d.party_name || ''}</td>
          <td class="num">${fmt(d.total)}</td><td>${badge(d.status)}</td>
          <td>${flags.filter((f) => f.level === 'error').length ? html`<span class="badge b-rejected">${flags.filter((f) => f.level === 'error').length} error</span> ` : ''}${flags.filter((f) => f.level === 'warning').length ? html`<span class="badge b-for_review">${flags.filter((f) => f.level === 'warning').length} warning</span>` : ''}${d.file_path ? ' 📎' : ''}</td></tr>`;
      }))}` });
  });

  // ---------- batch upload (receipt photos) ----------
  app.get('/clients/:cid/docs/upload', (req, res) => {
    const c = req.client;
    res.page({ title: 'Upload', client: c, active: 'docs', body: html`<h1>Upload receipts / invoices</h1>
      <form class="card" method="post" action="${base(c)}/upload" enctype="multipart/form-data">
        <label>What are these?</label><select name="kind"><option value="purchase">Expenses / purchases</option><option value="sale">Sales invoices</option></select>
        <label>Photos or PDFs (you can select many, or use the camera)</label>
        <input type="file" name="files" accept="image/*,application/pdf" multiple required>
        <p class="muted">Each file becomes a document "For encoding". Open each one to type in the details next to the picture.</p>
        <div class="actions"><button>Upload</button></div></form>` });
  });
  app.post('/clients/:cid/docs/upload', upload.array('files', 30), (req, res) => {
    const c = req.client; const kind = req.body.kind === 'sale' ? 'sale' : 'purchase';
    const ins = db.prepare(`INSERT INTO documents (client_id, kind, status, file_path, file_name, file_type, created_by) VALUES (?,?,?,?,?,?,?)`);
    let n = 0;
    tx(db, () => { for (const f of req.files || []) { const r = ins.run(c.id, kind, 'for_encoding', path.relative(app.locals.uploadDir, f.path), f.originalname, f.mimetype, req.user.id); audit(db, { user_id: req.user.id, client_id: c.id, entity: 'document', entity_id: Number(r.lastInsertRowid), action: 'upload', after: { file: f.originalname } }); n++; } });
    res.go(`${base(c)}?status=for_encoding`, `${n} file(s) uploaded and waiting for encoding.`);
  });

  // ---------- serve source file (access-checked) ----------
  app.get('/clients/:cid/docs/:id/file', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!d || !d.file_path) return res.status(404).send('No file');
    const full = path.resolve(app.locals.uploadDir, d.file_path);
    if (!full.startsWith(path.resolve(app.locals.uploadDir))) return res.status(400).send('Bad path');
    res.set('Content-Type', d.file_type || 'application/octet-stream'); res.set('Cache-Control', 'private, no-store');
    fs.createReadStream(full).pipe(res);
  });

  // ---------- new / view document ----------
  function docForm(req, d) {
    const c = req.client;
    const isSale = d.kind === 'sale';
    const accounts = db.prepare(`SELECT * FROM accounts WHERE client_id = ? AND active = 1 AND type IN (${isSale ? "'income'" : "'expense','asset'"}) ORDER BY type = 'asset', code`).all(c.id);
    const parties = db.prepare('SELECT name, tin, address, vat_registered, default_account_id FROM parties WHERE client_id = ? AND kind = ? ORDER BY last_used DESC NULLS LAST, name').all(c.id, isSale ? 'customer' : 'supplier');
    const last = !d.id ? db.prepare('SELECT * FROM documents WHERE client_id = ? AND kind = ? AND created_by = ? AND doc_date IS NOT NULL ORDER BY id DESC LIMIT 1').get(c.id, d.kind, req.user.id) : null;
    const defAcct = d.account_id || (last && last.account_id) || (accounts.find((a) => a.code === (isSale ? '4010' : '6190')) || {}).id;
    const vatRate = getRule(db, 'vat.rate', d.doc_date || today()).value;
    const role = req.user.role;
    const editable = !d.id || EDITABLE[role].includes(d.status);
    const v = (k) => d[k] ?? '';
    const m = (k) => (d.id || d[k] ? toDecimal(d[k] || 0) : '');
    const flags = d.flags ? JSON.parse(d.flags) : [];
    const defaultVatMode = c.vat_status === 'VAT' ? 'inclusive' : 'exempt';
    const action = d.id ? `${base(c)}/${d.id}` : base(c);
    const fileBox = d.file_path ? (d.file_type === 'application/pdf'
      ? html`<iframe src="${base(c)}/${d.id}/file" class="docimg" style="height:80vh"></iframe>`
      : html`<a href="${base(c)}/${d.id}/file" target="_blank"><img class="docimg" src="${base(c)}/${d.id}/file" alt="source document"></a>`) : '';
    const form = html`
      <form id="docform" method="post" action="${action}" enctype="multipart/form-data" data-parties="${JSON.stringify(parties)}" data-vatrate="${vatRate}" data-vatclient="${c.vat_status === 'VAT' ? 1 : 0}">
      <fieldset ${editable ? '' : 'disabled'} style="border:0;padding:0;margin:0">
        <input type="hidden" name="kind" value="${d.kind}">
        <div class="row">
          <div><label>Document type</label><select name="doc_type">${[['invoice', 'Invoice (VAT/non-VAT)'], ['or', 'Official receipt (old)'], ['receipt', 'Other receipt / acknowledgment'], ['other', 'Other (billing, contract…)']].map(([k, l]) => html`<option value="${k}" ${v('doc_type') === k ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div><label>Invoice / receipt no.</label><input name="doc_no" value="${v('doc_no')}" autofocus></div>
          <div><label>Date</label><input type="date" name="doc_date" value="${v('doc_date')}" required></div>
          <div><label>Encoding period (month)</label><input type="month" name="period" value="${v('period') || (last && last.period) || today().slice(0, 7)}"></div>
        </div>
        <div class="row">
          <div><label>${isSale ? 'Customer' : 'Supplier'} name</label><input name="party_name" list="partylist" value="${v('party_name')}" autocomplete="off" required>
            <datalist id="partylist">${parties.map((p) => html`<option value="${p.name}">`)}</datalist></div>
          <div><label>${isSale ? 'Customer' : 'Supplier'} TIN</label><input name="party_tin" value="${v('party_tin')}" inputmode="numeric" placeholder="000-000-000-000"></div>
          ${!isSale ? html`<div><label>Supplier is</label><select name="party_vat_registered"><option value="1" ${d.party_vat_registered !== 0 ? 'selected' : ''}>VAT-registered</option><option value="0" ${d.party_vat_registered === 0 ? 'selected' : ''}>Non-VAT</option></select></div>` : ''}
        </div>
        <label>Address</label><input name="party_address" value="${v('party_address')}">
        <div class="row">
          <div><label>Amount is</label><select name="vat_mode">
            <option value="inclusive" ${defaultVatMode === 'inclusive' ? 'selected' : ''}>VAT-inclusive (auto-split 12%)</option>
            <option value="exempt" ${defaultVatMode === 'exempt' ? 'selected' : ''}>${c.vat_status === 'VAT' || !isSale ? 'VAT-exempt / non-VAT' : 'Gross (non-VAT)'}</option>
            <option value="zero">Zero-rated</option><option value="manual">I'll type the breakdown</option></select></div>
          <div><label>TOTAL amount (₱)</label><input name="total" value="${m('total')}" inputmode="decimal" required style="font-size:20px;font-weight:700"></div>
        </div>
        <div class="row">
          <div><label>VATable</label><input name="vatable" value="${m('vatable')}" inputmode="decimal"></div>
          <div><label>VAT</label><input name="vat" value="${m('vat')}" inputmode="decimal"></div>
          <div><label>VAT-exempt / non-VAT</label><input name="exempt" value="${m('exempt')}" inputmode="decimal"></div>
          <div><label>Zero-rated</label><input name="zero_rated" value="${m('zero_rated')}" inputmode="decimal"></div>
        </div>
        <div class="row">
          <div><label>Account</label><select name="account_id">${accounts.map((a) => html`<option value="${a.id}" ${defAcct === a.id ? 'selected' : ''}>${a.code} ${a.name}</option>`)}</select></div>
          <div><label>${isSale ? 'Collected' : 'Paid'}</label><select name="payment"><option value="cash" ${v('payment') !== 'credit' ? 'selected' : ''}>Cash / now</option><option value="credit" ${v('payment') === 'credit' ? 'selected' : ''}>On account (${isSale ? 'receivable' : 'payable'})</option></select></div>
        </div>
        <label>Description</label><input name="description" value="${v('description')}">
        ${!isSale ? html`<label style="font-weight:400"><input type="checkbox" name="personal" ${d.personal ? 'checked' : ''}>Personal / not related to the business</label>` : ''}
        ${!d.file_path ? html`<label>Attach photo / PDF of the document</label><input type="file" name="file" accept="image/*,application/pdf" capture="environment">` : ''}
        ${editable ? html`<div class="actions"><button name="next" value="save">Save</button><button name="next" value="submit" class="secondary">Save &amp; send for review</button>${!d.id ? html`<button name="next" value="another" class="secondary">Save &amp; add another</button>` : ''}</div>` : ''}
      </fieldset></form>`;
    return { form, fileBox, flags, editable };
  }

  app.get('/clients/:cid/docs/new', (req, res) => {
    const kind = req.query.kind === 'sale' ? 'sale' : 'purchase';
    const { form } = docForm(req, { kind });
    res.page({ title: kind === 'sale' ? 'New sale' : 'New expense', client: req.client, active: 'docs', body: html`<h1>${kind === 'sale' ? 'New sale' : 'New expense / purchase'}</h1><div class="card">${form}</div>` });
  });

  app.get('/clients/:cid/docs/:id', (req, res) => {
    const c = req.client;
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND client_id = ?').get(Number(req.params.id), c.id);
    if (!d) return res.status(404).page({ title: 'Not found', body: html`<h1>Document not found</h1>` });
    const { form, fileBox, flags } = docForm(req, d);
    const lines = d.journal_id ? db.prepare('SELECT l.*, a.code, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE journal_id = ?').all(d.journal_id) : [];
    const hist = db.prepare(`SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE entity = 'document' AND entity_id = ? ORDER BY a.id`).all(d.id);
    const approver = auth.can.approve(req.user);
    const act = (a, label, cls = '') => html`<form class="inline" method="post" action="${base(c)}/${d.id}/${a}"><button class="${cls}">${label}</button></form>`;
    res.page({ title: 'Document', client: c, active: 'docs', body: html`
      <h1>${d.kind === 'sale' ? 'Sale' : 'Expense'} ${d.doc_no || '#' + d.id} ${badge(d.status)}</h1>
      ${d.status === 'rejected' && d.reject_reason ? html`<div class="flash error">Returned by reviewer: ${d.reject_reason}</div>` : ''}
      ${flags.length ? html`<ul class="flags">${flags.map((f) => html`<li class="f-${f.level}"><strong>${f.level.toUpperCase()}</strong> · ${f.message}</li>`)}</ul>` : html`<div class="flash">All checks passed.</div>`}
      <div class="actions">
        ${['encoded', 'rejected'].includes(d.status) ? act('submit', 'Send for review') : ''}
        ${approver && d.status === 'for_review' ? html`${act('approve', 'Approve')}${act('post', 'Approve & post')}
          <form class="inline" method="post" action="${base(c)}/${d.id}/reject"><input name="reason" placeholder="Reason for returning" required style="width:auto;display:inline-block"> <button class="danger">Return to encoder</button></form>` : ''}
        ${approver && d.status === 'approved' ? act('post', 'Post to books') : ''}
        ${approver && d.status === 'posted' ? html`<form class="inline" method="post" action="${base(c)}/${d.id}/reverse"><input name="reason" placeholder="Reason for reversal" required style="width:auto;display:inline-block"> <button class="danger">Reverse entry</button></form>` : ''}
      </div>
      <div class="${fileBox ? 'split' : ''}">${fileBox ? html`<div>${fileBox}</div>` : ''}<div class="card">${form}</div></div>
      ${lines.length ? html`<h2>Journal entry #${d.journal_id}</h2>${table(['Account', 'Debit', 'Credit'], lines.map((l) => html`<tr><td>${l.code} ${l.name}</td><td class="num">${l.debit ? fmt(l.debit) : ''}</td><td class="num">${l.credit ? fmt(l.credit) : ''}</td></tr>`))}` : ''}
      <h2>History</h2>${table(['When (UTC)', 'Who', 'Action'], hist.map((h) => html`<tr><td>${h.at}</td><td>${h.name || ''}</td><td>${h.action}</td></tr>`))}` });
  });

  // ---------- save (create or update) ----------
  function readDoc(req, c) {
    const b = req.body;
    const d = {
      kind: b.kind === 'sale' ? 'sale' : 'purchase', doc_type: b.doc_type || 'invoice', doc_no: (b.doc_no || '').trim() || null,
      doc_date: b.doc_date || null, period: b.period || null, party_name: (b.party_name || '').trim() || null,
      party_tin: (b.party_tin || '').trim() || null, party_address: (b.party_address || '').trim() || null,
      total: parseMoney(b.total), vatable: parseMoney(b.vatable), vat: parseMoney(b.vat), exempt: parseMoney(b.exempt), zero_rated: parseMoney(b.zero_rated),
      account_id: b.account_id ? Number(b.account_id) : null, payment: b.payment === 'credit' ? 'credit' : 'cash',
      description: b.description || null, personal: b.personal ? 1 : 0,
      party_vat_registered: b.party_vat_registered === undefined ? 1 : Number(b.party_vat_registered),
    };
    // Auto-split when only the total was given (server-side twin of the browser helper)
    if (d.total && !d.vatable && !d.vat && !d.exempt && !d.zero_rated) {
      const mode = b.vat_mode;
      const supplierNonVat = d.kind === 'purchase' && d.party_vat_registered === 0;
      if (mode === 'inclusive' && !supplierNonVat && !(d.kind === 'sale' && c.vat_status !== 'VAT')) {
        const s = splitVatInclusive(d.total, getRule(db, 'vat.rate', isValidIso(d.doc_date) ? d.doc_date : today()).value); d.vatable = s.net; d.vat = s.vat;
      } else if (mode === 'zero') d.zero_rated = d.total; else d.exempt = d.total;
    }
    if (d.account_id && !db.prepare('SELECT 1 FROM accounts WHERE id = ? AND client_id = ?').get(d.account_id, c.id)) throw new Error('Invalid account.');
    d.account_code = d.account_id ? db.prepare('SELECT code FROM accounts WHERE id = ?').get(d.account_id).code : null;
    return d;
  }

  function rememberParty(c, d) {
    if (!d.party_name) return null;
    const kind = d.kind === 'sale' ? 'customer' : 'supplier';
    const p = db.prepare('SELECT * FROM parties WHERE client_id = ? AND kind = ? AND lower(name) = lower(?)').get(c.id, kind, d.party_name);
    if (p) {
      db.prepare('UPDATE parties SET last_used = datetime(\'now\'), tin = COALESCE(?, tin), address = COALESCE(?, address), vat_registered = ?, default_account_id = COALESCE(?, default_account_id) WHERE id = ?')
        .run(d.party_tin, d.party_address, d.party_vat_registered, d.account_id, p.id);
      return p.id;
    }
    return Number(db.prepare('INSERT INTO parties (client_id, kind, name, tin, address, vat_registered, default_account_id, last_used) VALUES (?,?,?,?,?,?,?,datetime(\'now\'))')
      .run(c.id, kind, d.party_name, d.party_tin, d.party_address, d.party_vat_registered, d.account_id).lastInsertRowid);
  }

  const COLS = ['kind', 'doc_type', 'doc_no', 'doc_date', 'period', 'party_id', 'party_name', 'party_tin', 'party_address', 'vatable', 'vat', 'exempt', 'zero_rated', 'total', 'party_vat_registered', 'input_vat_allowed', 'personal', 'account_id', 'payment', 'description', 'status', 'flags'];

  function save(req, res, existing) {
    const c = req.client;
    let d;
    try { d = readDoc(req, c); } catch (e) { return res.go(existing ? `${base(c)}/${existing.id}` : `${base(c)}/new?kind=${req.body.kind}`, e.message, true); }
    const flags = validateDocument(db, c, d, { excludeId: existing && existing.id });
    d.input_vat_allowed = inputVatAllowed(c, d) ? 1 : 0;
    d.flags = JSON.stringify(flags);
    const wantSubmit = req.body.next === 'submit';
    d.status = wantSubmit && !hasErrors(flags) ? 'for_review' : 'encoded';
    const id = tx(db, () => {
      d.party_id = rememberParty(c, d);
      let id;
      if (existing) {
        db.prepare(`UPDATE documents SET ${COLS.map((k) => k + ' = ?').join(', ')}, reject_reason = NULL, updated_at = datetime('now') WHERE id = ?`).run(...COLS.map((k) => d[k] ?? null), existing.id);
        id = existing.id;
        audit(db, { user_id: req.user.id, client_id: c.id, entity: 'document', entity_id: id, action: 'edit', before: existing, after: d });
      } else {
        id = Number(db.prepare(`INSERT INTO documents (${COLS.join(',')}, client_id, created_by) VALUES (${COLS.map(() => '?').join(',')}, ?, ?)`).run(...COLS.map((k) => d[k] ?? null), c.id, req.user.id).lastInsertRowid);
        audit(db, { user_id: req.user.id, client_id: c.id, entity: 'document', entity_id: id, action: 'create', after: d });
      }
      if (req.file) db.prepare('UPDATE documents SET file_path = ?, file_name = ?, file_type = ? WHERE id = ?').run(path.relative(app.locals.uploadDir, req.file.path), req.file.originalname, req.file.mimetype, id);
      return id;
    });
    const msg = wantSubmit && hasErrors(flags) ? 'Saved, but NOT sent for review — fix the errors first.' : wantSubmit ? 'Saved and sent for review.' : 'Saved.';
    if (req.body.next === 'another') return res.go(`${base(c)}/new?kind=${d.kind}`, `Saved #${id}. Next one:`);
    // after encoding an uploaded photo, jump to the next one waiting
    if (existing && existing.status === 'for_encoding') {
      const nxt = db.prepare("SELECT id FROM documents WHERE client_id = ? AND status = 'for_encoding' ORDER BY id LIMIT 1").get(c.id);
      if (nxt) return res.go(`${base(c)}/${nxt.id}`, msg + ' Next photo:', wantSubmit && hasErrors(flags));
    }
    res.go(`${base(c)}/${id}`, msg, wantSubmit && hasErrors(flags));
  }

  app.post('/clients/:cid/docs', upload.single('file'), (req, res) => save(req, res, null));
  app.post('/clients/:cid/docs/:id', upload.single('file'), (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!d) return res.status(404).send('Not found');
    if (!EDITABLE[req.user.role].includes(d.status)) return res.go(`${base(req.client)}/${d.id}`, 'This document can no longer be edited.', true);
    save(req, res, d);
  });

  // ---------- workflow actions ----------
  function load(req) { return db.prepare('SELECT * FROM documents WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id); }
  function setStatus(req, d, status, extra = {}) {
    const sets = Object.keys(extra).map((k) => `, ${k} = ?`).join('');
    db.prepare(`UPDATE documents SET status = ?${sets}, updated_at = datetime('now') WHERE id = ?`).run(status, ...Object.values(extra), d.id);
    audit(db, { user_id: req.user.id, client_id: req.client.id, entity: 'document', entity_id: d.id, action: status, before: { status: d.status }, after: { status, ...extra } });
  }
  app.post('/clients/:cid/docs/:id/submit', (req, res) => {
    const d = load(req); const u = `${base(req.client)}/${req.params.id}`;
    if (!d || !['encoded', 'rejected'].includes(d.status)) return res.go(u, 'Cannot send this document for review.', true);
    if (hasErrors(JSON.parse(d.flags))) return res.go(u, 'Fix the errors before sending for review.', true);
    setStatus(req, d, 'for_review'); res.go(u, 'Sent for review.');
  });
  app.post('/clients/:cid/docs/:id/reject', (req, res) => {
    const d = load(req); const u = `${base(req.client)}/${req.params.id}`;
    if (!auth.can.approve(req.user) || !d || !['for_review', 'approved'].includes(d.status)) return res.go(u, 'Not allowed.', true);
    setStatus(req, d, 'rejected', { reject_reason: req.body.reason || 'No reason given' }); res.go(u, 'Returned to encoder.');
  });
  app.post('/clients/:cid/docs/:id/approve', (req, res) => {
    const d = load(req); const u = `${base(req.client)}/${req.params.id}`;
    if (!auth.can.approve(req.user) || !d || d.status !== 'for_review') return res.go(u, 'Not allowed.', true);
    setStatus(req, d, 'approved', { approved_by: req.user.id }); res.go(u, 'Approved.');
  });
  app.post('/clients/:cid/docs/:id/post', (req, res) => {
    const d = load(req); const u = `${base(req.client)}/${req.params.id}`;
    if (!auth.can.approve(req.user) || !d || !['for_review', 'approved'].includes(d.status)) return res.go(u, 'Not allowed.', true);
    if (hasErrors(JSON.parse(d.flags))) return res.go(u, 'This document has errors and cannot be posted.', true);
    try {
      const jid = postJournal(db, { client_id: req.client.id, date: d.doc_date, ref: `${d.kind === 'sale' ? 'SI' : 'PV'}-${d.doc_no}`, memo: `${d.party_name}${d.description ? ' — ' + d.description : ''}`,
        source: d.kind === 'sale' ? 'sales' : 'purchases', document_id: d.id, lines: linesForDocument(db, req.client, d), user_id: req.user.id });
      setStatus(req, d, 'posted', { journal_id: jid, approved_by: d.approved_by || req.user.id });
      res.go(u, `Posted to the books (JE #${jid}).`);
    } catch (e) { res.go(u, e.message, true); }
  });
  app.post('/clients/:cid/docs/:id/reverse', (req, res) => {
    const d = load(req); const u = `${base(req.client)}/${req.params.id}`;
    if (!auth.can.approve(req.user) || !d || d.status !== 'posted') return res.go(u, 'Not allowed.', true);
    try {
      const date = require('../ledger').isLocked(db, req.client.id, d.doc_date) ? today() : d.doc_date;
      reverseJournal(db, d.journal_id, { date, user_id: req.user.id, reason: req.body.reason });
      setStatus(req, d, 'reversed', { reject_reason: req.body.reason }); res.go(u, 'Entry reversed. Encode a corrected document if needed.');
    } catch (e) { res.go(u, e.message, true); }
  });

  // ---------- manual journal entry (adjusting, depreciation, opening balances, closing) ----------
  app.get('/clients/:cid/journal/new', (req, res) => {
    const c = req.client;
    if (!auth.can.approve(req.user)) return res.go(base(c), 'Only accountants can make journal entries.', true);
    const accounts = db.prepare('SELECT * FROM accounts WHERE client_id = ? AND active = 1 ORDER BY code').all(c.id);
    const opts = html`<option value="">—</option>${accounts.map((a) => html`<option value="${a.id}">${a.code} ${a.name}</option>`)}`;
    res.page({ title: 'Journal entry', client: c, active: 'docs', body: html`<h1>Journal entry</h1>
      <form class="card" method="post" action="/clients/${c.id}/journal"><div class="row">
        <div><label>Date</label><input type="date" name="date" required value="${today()}"></div>
        <div><label>Type</label><select name="source"><option value="adjusting">Adjusting</option><option value="opening">Opening balance</option><option value="depreciation">Depreciation</option><option value="payroll">Payroll</option><option value="closing">Closing</option><option value="manual">Other</option></select></div>
        <div><label>Reference</label><input name="ref"></div></div>
        <label>Explanation</label><input name="memo" required>
        ${table(['Account', 'Debit', 'Credit'], [...Array(8)].map((_, i) => html`<tr><td><select name="a${i}">${opts}</select></td><td><input name="d${i}" inputmode="decimal"></td><td><input name="c${i}" inputmode="decimal"></td></tr>`))}
        <p class="muted">Debits must equal credits.</p><div class="actions"><button>Post entry</button></div></form>` });
  });
  app.post('/clients/:cid/journal', (req, res) => {
    const c = req.client; const b = req.body;
    if (!auth.can.approve(req.user)) return res.go(base(c), 'Not allowed.', true);
    try {
      const lines = [];
      for (let i = 0; i < 8; i++) if (b['a' + i]) lines.push({ account_id: Number(b['a' + i]), debit: parseMoney(b['d' + i]), credit: parseMoney(b['c' + i]) });
      const jid = postJournal(db, { client_id: c.id, date: b.date, ref: b.ref, memo: b.memo, source: b.source || 'manual', lines, user_id: req.user.id });
      res.go(`/clients/${c.id}/books?book=gj`, `Journal entry #${jid} posted.`);
    } catch (e) { res.go(`/clients/${c.id}/journal/new`, e.message, true); }
  });
};
