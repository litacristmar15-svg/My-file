'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, fmt, splitVatInclusive, mulRate, divRound } = require('../src/money');

test('parseMoney handles pesos, commas, ₱ sign and negatives — into integer centavos', () => {
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('₱ 1,000'), 100000);
  assert.equal(parseMoney('0.5'), 50);
  assert.equal(parseMoney('(250.00)'), -25000);
  assert.equal(parseMoney(''), 0);
  assert.throws(() => parseMoney('12.345'));
  assert.throws(() => parseMoney('abc'));
});

test('fmt uses Philippine number formatting with parentheses for negatives', () => {
  assert.equal(fmt(123456789), '1,234,567.89');
  assert.equal(fmt(-5000), '(50.00)');
  assert.equal(fmt(7), '0.07');
});

test('VAT split of a VAT-inclusive amount (12/112) rounds half-up to the centavo', () => {
  assert.deepEqual(splitVatInclusive(11200, 120000), { net: 10000, vat: 1200 }); // ₱112 → ₱100 + ₱12
  assert.deepEqual(splitVatInclusive(100000, 120000), { net: 89286, vat: 10714 }); // ₱1,000 → 892.86 + 107.14
  const s = splitVatInclusive(123457, 120000); assert.equal(s.net + s.vat, 123457); // always adds back up
});

test('rounding: half-up, away from zero, no float drift', () => {
  assert.equal(divRound(5, 2), 3); assert.equal(divRound(-5, 2), -3); assert.equal(divRound(4, 3), 1);
  assert.equal(mulRate(1, 500000), 1); // 0.5 centavo → 1
  assert.equal(mulRate(999999999999, 120000), 120000000000); // big amounts, no overflow
  assert.equal(mulRate(10, 30000), 0); // 0.3 centavo → 0
});
