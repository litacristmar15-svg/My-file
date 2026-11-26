'use strict';
// Double-entry engine. Every journal must balance (sum debits = sum credits) — enforced here
// inside a DB transaction; journal_lines also have DB CHECKs and immutability triggers.
const { tx, audit } = require('./db');
const { ROLE } = require('./coa');

function accountMap(db, clientId) {
  const m = {};
  for (const a of db.prepare('SELECT * FROM accounts WHERE client_id = ?').all(clientId)) m[a.code] = a;
  return m;
}

function isLocked(db, clientId, date) {
  return !!db.prepare('SELECT 1 FROM period_locks WHERE client_id = ? AND period = ?').get(clientId, date.slice(0, 7));
}

function postJournal(db, { client_id, date, ref, memo, source = 'manual', document_id = null, reversal_of = null, lines, user_id }) {
  if (!date) throw new Error('Journal date is required.');
  if (isLocked(db, client_id, date)) throw new Error(`Period ${date.slice(0, 7)} is locked. Ask an admin to unlock it (with a reason).`);
  lines = lines.filter((l) => (l.debit || 0) !== 0 || (l.credit || 0) !== 0);
  if (lines.length < 2) throw new Error('A journal entry needs at least two lines.');
  let dr = 0, cr = 0;
  const owned = new Set(db.prepare('SELECT id FROM accounts WHERE client_id = ?').all(client_id).map((a) => a.id));
  for (const l of lines) {
    for (const k of ['debit', 'credit']) if (!Number.isSafeInteger(l[k] || 0) || (l[k] || 0) < 0) throw new Error('Amounts must be positive whole centavos.');
    if ((l.debit || 0) && (l.credit || 0)) throw new Error('A line cannot have both a debit and a credit.');
    if (!owned.has(l.account_id)) throw new Error('Account does not belong to this client.');
    dr += l.debit || 0; cr += l.credit || 0;
  }
  if (dr !== cr) throw new Error(`Entry is not balanced: debits ${dr / 100} vs credits ${cr / 100}.`);
  return tx(db, () => {
    const j = db.prepare('INSERT INTO journals (client_id, date, ref, memo, source, document_id, reversal_of, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(client_id, date, ref || null, memo || null, source, document_id, reversal_of, user_id || null);
    const id = Number(j.lastInsertRowid);
    const ins = db.prepare('INSERT INTO journal_lines (journal_id, account_id, debit, credit) VALUES (?,?,?,?)');
    for (const l of lines) ins.run(id, l.account_id, l.debit || 0, l.credit || 0);
    audit(db, { user_id, client_id, entity: 'journal', entity_id: id, action: reversal_of ? 'reverse' : 'post', after: { date, ref, memo, lines } });
    return id;
  });
}

// Build the journal lines for an approved sales/purchase document.
function linesForDocument(db, client, doc) {
  const A = accountMap(db, client.id);
  const need = (code) => { if (!A[code]) throw new Error(`Account ${code} is missing in this client's chart of accounts.`); return A[code].id; };
  const vatClient = client.vat_status === 'VAT';
  const lines = [];
  if (doc.kind === 'sale') {
    const debitAcct = need(doc.payment === 'credit' ? ROLE.ar : ROLE.cash);
    const revenue = doc.account_id || need(ROLE.revenue);
    lines.push({ account_id: debitAcct, debit: doc.total });
    if (vatClient) {
      lines.push({ account_id: revenue, credit: doc.vatable + doc.exempt + doc.zero_rated });
      if (doc.vat) lines.push({ account_id: need(ROLE.outputVat), credit: doc.vat });
    } else lines.push({ account_id: revenue, credit: doc.total });
  } else {
    const creditAcct = need(doc.payment === 'credit' ? ROLE.ap : ROLE.cash);
    let expense = doc.account_id || need(ROLE.misc);
    if (doc.personal) {
      if (!A['3020']) throw new Error('Personal expenses cannot be posted for this client type. Reject the document instead.');
      expense = A['3020'].id; // owner's/partners' drawings
    }
    const input = doc.input_vat_allowed && vatClient ? doc.vat : 0;
    lines.push({ account_id: expense, debit: doc.total - input });
    if (input) lines.push({ account_id: need(ROLE.inputVat), debit: input });
    lines.push({ account_id: creditAcct, credit: doc.total });
  }
  return lines;
}

function reverseJournal(db, journalId, { date, user_id, reason }) {
  const j = db.prepare('SELECT * FROM journals WHERE id = ?').get(journalId);
  if (!j) throw new Error('Journal not found.');
  if (db.prepare('SELECT 1 FROM journals WHERE reversal_of = ?').get(journalId)) throw new Error('This entry was already reversed.');
  const lines = db.prepare('SELECT account_id, debit, credit FROM journal_lines WHERE journal_id = ?').all(journalId)
    .map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit }));
  return postJournal(db, { client_id: j.client_id, date: date || j.date, ref: 'REV-' + (j.ref || j.id), memo: `Reversal of JE #${j.id}: ${reason || ''}`, source: 'reversal', reversal_of: j.id, lines, user_id });
}

// Account balances. For balance-sheet accounts we take everything up to `to`;
// for income/expense accounts only the [from, to] window (when `from` is given).
function balances(db, clientId, { from, to }) {
  const sums = db.prepare(`
    SELECT l.account_id AS id, SUM(l.debit) AS dr, SUM(l.credit) AS cr
    FROM journal_lines l JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
    WHERE j.client_id = ? AND j.date <= ? AND (a.type IN ('asset','liability','equity') OR ? = '' OR j.date >= ?)
    GROUP BY l.account_id`).all(clientId, to, from || '', from || '');
  const byId = Object.fromEntries(sums.map((r) => [r.id, r]));
  return db.prepare('SELECT id, code, name, type FROM accounts WHERE client_id = ? ORDER BY code').all(clientId).map((a) => {
    const r = byId[a.id] || { dr: 0, cr: 0 };
    return { ...a, dr: r.dr, cr: r.cr, balance: r.dr - r.cr }; // positive = debit balance
  });
}

function trialBalance(db, clientId, opts) {
  const rows = balances(db, clientId, opts).filter((r) => r.dr || r.cr);
  // Prior-period income/expense (when `from` is given) is rolled into "Retained earnings - prior periods"
  let prior = 0;
  if (opts.from) {
    const p = db.prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id WHERE j.client_id = ? AND j.date < ? AND a.type IN ('income','expense')`).get(clientId, opts.from).v;
    prior = p;
  }
  const out = rows.map((r) => ({ ...r, debit: r.balance > 0 ? r.balance : 0, credit: r.balance < 0 ? -r.balance : 0 }));
  if (prior) out.push({ code: '3999', name: 'Retained earnings / capital - prior periods income (unclosed)', type: 'equity', debit: prior < 0 ? -prior : 0, credit: prior > 0 ? prior : 0 });
  const totalDebit = out.reduce((s, r) => s + r.debit, 0);
  const totalCredit = out.reduce((s, r) => s + r.credit, 0);
  return { rows: out, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

function incomeStatement(db, clientId, { from, to }) {
  const b = balances(db, clientId, { from, to });
  const income = b.filter((r) => r.type === 'income' && (r.dr || r.cr)).map((r) => ({ ...r, amount: -r.balance }));
  const cos = b.filter((r) => r.type === 'expense' && r.code.startsWith('5') && (r.dr || r.cr)).map((r) => ({ ...r, amount: r.balance }));
  const opex = b.filter((r) => r.type === 'expense' && !r.code.startsWith('5') && (r.dr || r.cr)).map((r) => ({ ...r, amount: r.balance }));
  const revenue = income.filter((r) => r.code === '4010').reduce((s, r) => s + r.amount, 0);
  const otherIncome = income.filter((r) => r.code !== '4010').reduce((s, r) => s + r.amount, 0);
  const totalCos = cos.reduce((s, r) => s + r.amount, 0);
  const totalOpex = opex.reduce((s, r) => s + r.amount, 0);
  const grossProfit = revenue - totalCos;
  return { income, cos, opex, revenue, otherIncome, totalCos, totalOpex, grossProfit, netIncome: grossProfit + otherIncome - totalOpex };
}

function balanceSheet(db, clientId, { to }) {
  const b = balances(db, clientId, { to });
  const assets = b.filter((r) => r.type === 'asset' && (r.dr || r.cr)).map((r) => ({ ...r, amount: r.balance }));
  const liabilities = b.filter((r) => r.type === 'liability' && (r.dr || r.cr)).map((r) => ({ ...r, amount: -r.balance }));
  const equity = b.filter((r) => r.type === 'equity' && (r.dr || r.cr)).map((r) => ({ ...r, amount: -r.balance }));
  const netIncome = b.filter((r) => r.type === 'income' || r.type === 'expense').reduce((s, r) => s - r.balance, 0);
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0) + netIncome;
  return { assets, liabilities, equity, netIncome, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

// Journal listing with lines (for General Journal and special journals)
function journalEntries(db, clientId, { from, to, source }) {
  const js = db.prepare(`SELECT j.*, u.name AS by_name FROM journals j LEFT JOIN users u ON u.id = j.created_by
    WHERE j.client_id = ? AND j.date BETWEEN ? AND ? ${source ? 'AND j.source = ?' : ''} ORDER BY j.date, j.id`)
    .all(...[clientId, from, to, ...(source ? [source] : [])]);
  const lq = db.prepare('SELECT l.*, a.code, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_id = ? ORDER BY l.debit = 0, l.id');
  return js.map((j) => ({ ...j, lines: lq.all(j.id) }));
}

function generalLedger(db, clientId, { from, to }) {
  const accts = db.prepare('SELECT * FROM accounts WHERE client_id = ? ORDER BY code').all(clientId);
  const open = db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journals j ON j.id = l.journal_id
    WHERE l.account_id = ? AND j.date < ?`);
  const mv = db.prepare(`SELECT j.date, j.id AS jid, j.ref, j.memo, l.debit, l.credit FROM journal_lines l JOIN journals j ON j.id = l.journal_id
    WHERE l.account_id = ? AND j.date BETWEEN ? AND ? ORDER BY j.date, j.id`);
  const out = [];
  for (const a of accts) {
    const pl = ['asset', 'liability', 'equity'].includes(a.type);
    const opening = pl ? open.get(a.id, from).v : 0;
    const moves = mv.all(a.id, from, to);
    if (!opening && !moves.length) continue;
    let run = opening;
    out.push({ ...a, opening, moves: moves.map((m) => ({ ...m, balance: (run += m.debit - m.credit) })), closing: run });
  }
  return out;
}

module.exports = { accountMap, isLocked, postJournal, linesForDocument, reverseJournal, balances, trialBalance, incomeStatement, balanceSheet, journalEntries, generalLedger };
