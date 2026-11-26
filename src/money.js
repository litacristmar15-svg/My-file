'use strict';
// All money is stored as INTEGER centavos. Rates are stored as integer parts-per-million (ppm):
// 12% = 120000. Never use floating point for money.

function parseMoney(input) {
  if (input === null || input === undefined) return 0;
  let s = String(input).replace(/[₱,\s]/g, '');
  if (s === '') return 0;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) throw new Error('Invalid amount: ' + input);
  const [w, f = ''] = s.split('.');
  const v = Number(w || '0') * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}

function groupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 1234567 -> "12,345.67"; negatives shown in parentheses (accounting style)
function fmt(c) {
  c = Number(c) || 0;
  const neg = c < 0;
  const a = Math.abs(c);
  const s = groupThousands(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
  return neg ? '(' + s + ')' : s;
}
const peso = (c) => '₱' + fmt(c);
// Plain decimal for inputs / CSV: 1234567 -> "12345.67"
function toDecimal(c) {
  c = Number(c) || 0;
  const neg = c < 0; const a = Math.abs(c);
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}

// Integer division with ROUND HALF UP (away from zero). BigInt to avoid overflow.
function divRound(n, d) {
  n = BigInt(n); d = BigInt(d);
  const neg = (n < 0n) !== (d < 0n);
  if (n < 0n) n = -n; if (d < 0n) d = -d;
  const q = (n * 2n + d) / (2n * d);
  return Number(neg ? -q : q);
}

// amount (centavos) x rate (ppm), rounded half up to the centavo
const mulRate = (amount, ppm) => divRound(BigInt(amount) * BigInt(ppm), 1000000n);

// VAT-inclusive total -> { net, vat }. vat = total x r / (1 + r)
function splitVatInclusive(total, ppm) {
  const vat = divRound(BigInt(total) * BigInt(ppm), 1000000n + BigInt(ppm));
  return { net: total - vat, vat };
}

const pct = (ppm) => (ppm / 10000).toString() + '%';

module.exports = { parseMoney, fmt, peso, toDecimal, divRound, mulRate, splitVatInclusive, pct };
