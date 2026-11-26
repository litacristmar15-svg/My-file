'use strict';
const { html, raw } = require('./html');
const { fmt } = require('./money');
const { show } = require('./dates');

const STATUS_LABEL = { for_encoding: 'For encoding', encoded: 'Encoded', rejected: 'Returned', for_review: 'For review', approved: 'Approved', posted: 'Posted', reversed: 'Reversed', pending: 'Pending', filed: 'Filed' };
const badge = (s) => html`<span class="badge b-${s}">${STATUS_LABEL[s] || s}</span>`;
const money = (c) => html`<span class="num">${fmt(c)}</span>`;

function page({ user, title, client, body, flash, active }) {
  const nav = client ? html`
    <nav class="subnav">
      <a href="/clients/${client.id}" class="${active === 'overview' ? 'on' : ''}">Overview</a>
      <a href="/clients/${client.id}/docs" class="${active === 'docs' ? 'on' : ''}">Documents</a>
      <a href="/clients/${client.id}/books" class="${active === 'books' ? 'on' : ''}">Books</a>
      <a href="/clients/${client.id}/fs" class="${active === 'fs' ? 'on' : ''}">Financial statements</a>
      <a href="/clients/${client.id}/tax" class="${active === 'tax' ? 'on' : ''}">Tax</a>
      <a href="/clients/${client.id}/filings" class="${active === 'filings' ? 'on' : ''}">Filings</a>
      <a href="/clients/${client.id}/setup" class="${active === 'setup' ? 'on' : ''}">Setup</a>
    </nav>` : '';
  return '<!doctype html>' + html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · L2C Books</title>
<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0f5132">
<link rel="stylesheet" href="/style.css">
</head><body>
<header class="top no-print">
  <a class="brand" href="/">L2C <span>Books &amp; Tax</span></a>
  ${user ? html`<nav class="mainnav">
    <a href="/">Dashboard</a><a href="/clients">Clients</a><a href="/penalty">Penalty calc</a>
    ${user.role === 'admin' ? html`<a href="/rules">Tax rules</a><a href="/users">Users</a><a href="/audit">Audit log</a>` : ''}
    <form method="post" action="/logout" class="inline"><button class="link">Log out (${user.name})</button></form>
  </nav>` : ''}
</header>
${client ? html`<div class="clienthead no-print"><strong>${client.reg_name}</strong> <span class="muted">TIN ${client.tin}-${client.branch} · ${client.vat_status === 'VAT' ? 'VAT' : 'Non-VAT'} · ${client.taxpayer_type}</span></div>` : ''}
${nav}
<main>
${flash ? html`<div class="flash ${flash.type || ''}">${flash.msg}</div>` : ''}
${body}
</main>
<script src="/app.js"></script>
</body></html>`.s;
}

function table(headers, rows, { foot, cls = '' } = {}) {
  return html`<div class="tablewrap"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
  <tbody>${rows.length ? rows : html`<tr><td colspan="${headers.length}" class="muted">Nothing here yet.</td></tr>`}</tbody>
  ${foot ? html`<tfoot>${foot}</tfoot>` : ''}</table></div>`;
}

module.exports = { page, table, badge, money, show, STATUS_LABEL };
