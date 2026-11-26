'use strict';
// "Allowable as BIR proof" checks. Each flag: { level: 'error'|'warning'|'info', code, message }.
// Errors block submission for review; warnings must be read by the reviewer.
const { getRule } = require('./rules');
const { mulRate, fmt } = require('./money');
const { isValidIso } = require('./dates');

const TIN_RE = /^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/;
const normTin = (t) => (t || '').replace(/[^0-9]/g, '');

function validateDocument(db, client, doc, { excludeId } = {}) {
  const f = [];
  const add = (level, code, message) => f.push({ level, code, message });
  const isVatClient = client.vat_status === 'VAT';

  if (!doc.doc_no) add('error', 'NO_DOC_NO', 'Invoice/receipt number is missing.');
  if (!doc.doc_date || !isValidIso(doc.doc_date)) add('error', 'NO_DATE', 'Document date is missing or invalid.');
  if (!doc.party_name) add('error', 'NO_PARTY', doc.kind === 'sale' ? 'Customer name is missing.' : 'Supplier name is missing.');
  if (doc.total <= 0) add('error', 'NO_AMOUNT', 'Total amount must be more than zero.');

  // TIN
  if (doc.kind === 'purchase') {
    if (!doc.party_tin) add('error', 'NO_TIN', 'Supplier TIN is missing — the receipt is not valid BIR support for the expense.');
    else if (!TIN_RE.test(doc.party_tin)) add('error', 'BAD_TIN', 'Supplier TIN format looks wrong (expected 000-000-000-000).');
  } else if (doc.party_tin && !TIN_RE.test(doc.party_tin)) add('warning', 'BAD_TIN', 'Customer TIN format looks wrong (expected 000-000-000-000).');

  // Period
  if (doc.period && doc.doc_date && doc.doc_date.slice(0, 7) !== doc.period)
    add('warning', 'OUT_OF_PERIOD', `Document date is outside the period being encoded (${doc.period}).`);

  // Duplicate (same supplier/customer TIN + document number)
  if (doc.doc_no) {
    const dup = db.prepare(`SELECT id, status FROM documents WHERE client_id = ? AND kind = ? AND doc_no = ?
      AND REPLACE(REPLACE(COALESCE(party_tin,''),'-',''),' ','') = ? AND id <> ? AND status <> 'reversed'`)
      .get(client.id, doc.kind, doc.doc_no, normTin(doc.party_tin), excludeId || 0);
    if (dup) add('error', 'DUPLICATE', `Possible duplicate: document #${dup.id} has the same TIN and number.`);
  }

  // Amount arithmetic
  const parts = doc.vatable + doc.vat + doc.exempt + doc.zero_rated;
  if (parts !== doc.total) add('error', 'TOTAL_MISMATCH', `VATable + VAT + exempt + zero-rated (${fmt(parts)}) does not equal the total (${fmt(doc.total)}).`);
  if (doc.vat > 0 && doc.doc_date && isValidIso(doc.doc_date)) {
    const rate = getRule(db, 'vat.rate', doc.doc_date).value;
    const expected = mulRate(doc.vatable, rate);
    if (Math.abs(expected - doc.vat) > 100) add('warning', 'VAT_RATE', `VAT (${fmt(doc.vat)}) is not ${rate / 10000}% of VATable amount (expected about ${fmt(expected)}).`);
  }

  if (doc.kind === 'sale') {
    if (!isVatClient && (doc.vat > 0 || doc.vatable > 0)) add('error', 'NONVAT_CHARGED_VAT', 'This client is NON-VAT and must not charge VAT on sales. Enter the amount as exempt / gross.');
    if (doc.doc_type !== 'invoice') add('warning', 'SALE_DOC_TYPE', 'Under the EOPT Act (RA 11976) the INVOICE is the primary proof of sale for both goods and services.');
  } else {
    let disallow = null;
    if (doc.vat > 0 && doc.party_vat_registered === 0) disallow = 'Supplier is NON-VAT: input VAT cannot be claimed. The full amount goes to expense.';
    else if (doc.vat > 0 && doc.doc_type !== 'invoice') disallow = 'Under the EOPT Act (RA 11976) only a VAT INVOICE supports input VAT. Official receipts/other documents are not valid input VAT support.';
    if (disallow) add('warning', 'INPUT_VAT_DISALLOWED', disallow);
    if (doc.vat > 0 && !isVatClient) add('info', 'NONVAT_CLIENT_INPUT', 'Client is NON-VAT: VAT paid on purchases is part of the cost (no input VAT claim).');
    if (doc.personal) add('warning', 'PERSONAL', 'Marked as personal / not related to the business — NOT deductible.');
    if (doc.account_code === '6060') add('info', 'EAR_LIMIT', 'Representation/entertainment (EAR) is deductible only up to 0.5% of net sales (goods) or 1% of net revenue (services) — RR 10-2002.');
    if (doc.total > 0 && doc.payment === 'cash' && doc.total >= 10000000) add('info', 'LARGE_CASH', 'Large cash payment — check if EWT should have been withheld.');
  }
  return f;
}

function inputVatAllowed(client, doc) {
  if (client.vat_status !== 'VAT' || doc.kind !== 'purchase' || doc.vat <= 0) return false;
  if (doc.party_vat_registered === 0) return false;
  if (doc.doc_type !== 'invoice') return false;
  if (doc.personal) return false;
  return true;
}

const hasErrors = (flags) => flags.some((x) => x.level === 'error');

module.exports = { validateDocument, inputVatAllowed, hasErrors, TIN_RE };
