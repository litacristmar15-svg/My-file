'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../src/db');
const { seed } = require('../src/seed');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');

let server, base, db;
test.before(async () => {
  process.removeAllListeners('warning');
  db = open(':memory:');
  seed(db, { year: 2026, months: 3 });
  createUser(db, { username: 'outsider', name: 'Outsider', role: 'encoder', password: 'Outsider2026' }); // assigned to no client
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'l2c-up-'));
  server = createApp(db, { uploadDir: up }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function login(u, p) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: u, password: p }) });
  const c = r.headers.get('set-cookie'); assert.ok(c && c.startsWith('sid='), 'logged in ' + u);
  return c.split(';')[0];
}
const get = (cookie, url) => fetch(base + url, { headers: { cookie }, redirect: 'manual' });
const post = (cookie, url, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('login required; wrong password rejected', async () => {
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=nope' });
  assert.match(r.headers.get('location'), /err=/);
});

test('every main page renders for admin', async () => {
  const ck = await login('admin', 'DemoAdmin2026');
  const pages = ['/', '/clients', '/penalty?tax=1000&due=2026-01-25&paid=2026-03-01&size=micro', '/rules', '/users', '/audit'];
  for (let id = 1; id <= 5; id++) {
    pages.push(`/clients/${id}`, `/clients/${id}/docs`, `/clients/${id}/docs/new?kind=sale`, `/clients/${id}/docs/new?kind=purchase`, `/clients/${id}/docs/upload`,
      `/clients/${id}/fs`, `/clients/${id}/tax?year=2026&q=1`, `/clients/${id}/tax?year=2026&q=4`, `/clients/${id}/filings`, `/clients/${id}/setup`, `/clients/${id}/journal/new`);
    for (const b of ['gj', 'gl', 'sj', 'pj', 'crj', 'cdj', 'ar', 'ap', 'tb']) pages.push(`/clients/${id}/books?book=${b}`);
  }
  for (const p of pages) { const r = await get(ck, p); assert.equal(r.status, 200, p); }
  const tb = await (await get(ck, '/clients/1/books?book=tb')).text();
  assert.match(tb, /balanced ✔/);
  const csv = await get(ck, '/clients/1/books?book=sj&format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

test('staff only see assigned clients; encoders cannot approve or see admin pages', async () => {
  const out = await login('outsider', 'Outsider2026');
  assert.equal((await get(out, '/clients/1')).status, 403);
  assert.equal((await get(out, '/clients/1/books?book=gj')).status, 403);
  assert.doesNotMatch(await (await get(out, '/clients')).text(), /Bayanihan/);
  const enc = await login('jun', 'DemoJun2026');
  assert.equal((await get(enc, '/rules')).status, 403);
  const doc = db.prepare("SELECT id FROM documents WHERE client_id = 1 AND status = 'for_review'").get();
  await post(enc, `/clients/1/docs/${doc.id}/post`, {});
  assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id).status, 'for_review');
});

test('encode → review → post workflow with VAT auto-split, then reverse', async () => {
  const enc = await login('jun', 'DemoJun2026');
  const acct = db.prepare("SELECT id FROM accounts WHERE client_id = 1 AND code = '6040'").get().id;
  const r = await post(enc, '/clients/1/docs', { kind: 'purchase', doc_type: 'invoice', doc_no: 'NB-9001', doc_date: '2026-04-10', period: '2026-04',
    party_name: 'New Supplier Corp', party_tin: '111-000-222-000', party_vat_registered: '1', vat_mode: 'inclusive', total: '1,120.00', account_id: String(acct), payment: 'cash', next: 'submit' });
  assert.equal(r.status, 302);
  const d = db.prepare("SELECT * FROM documents WHERE doc_no = 'NB-9001'").get();
  assert.equal(d.vatable, 100000); assert.equal(d.vat, 12000); assert.equal(d.status, 'for_review');
  assert.ok(db.prepare("SELECT 1 FROM parties WHERE client_id = 1 AND name = 'New Supplier Corp'").get(), 'supplier remembered');
  const acc = await login('maria', 'DemoMaria2026');
  await post(acc, `/clients/1/docs/${d.id}/post`, {});
  const posted = db.prepare('SELECT * FROM documents WHERE id = ?').get(d.id);
  assert.equal(posted.status, 'posted'); assert.ok(posted.journal_id);
  await post(acc, `/clients/1/docs/${d.id}/reverse`, { reason: 'test' });
  assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(d.id).status, 'reversed');
  assert.ok(db.prepare('SELECT 1 FROM journals WHERE reversal_of = ?').get(posted.journal_id));
  // duplicate is blocked from review
  await post(enc, '/clients/1/docs', { kind: 'purchase', doc_type: 'invoice', doc_no: 'X-1', doc_date: '2026-04-10', party_name: 'Dup Inc', party_tin: '222-000-222-000', vat_mode: 'inclusive', total: '112', account_id: String(acct), next: 'submit' });
  await post(enc, '/clients/1/docs', { kind: 'purchase', doc_type: 'invoice', doc_no: 'X-1', doc_date: '2026-04-11', party_name: 'Dup Inc', party_tin: '222000222000', vat_mode: 'inclusive', total: '112', account_id: String(acct), next: 'submit' });
  const dups = db.prepare("SELECT status FROM documents WHERE doc_no = 'X-1' ORDER BY id").all().map((x) => x.status);
  assert.deepEqual(dups, ['for_review', 'encoded']);
  // audit trail recorded
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity = 'document' AND entity_id = ?").get(d.id).n >= 3);
});

test('posting into a locked month is refused', async () => {
  const acc = await login('maria', 'DemoMaria2026');
  const a = db.prepare("SELECT id FROM accounts WHERE client_id = 2 AND code = '1010'").get().id;
  const b = db.prepare("SELECT id FROM accounts WHERE client_id = 2 AND code = '3010'").get().id;
  const r = await post(acc, '/clients/2/journal', { date: '2026-01-20', memo: 'x', a0: String(a), d0: '100', a1: String(b), c1: '100' });
  assert.match(decodeURIComponent(r.headers.get('location')), /locked/);
});
