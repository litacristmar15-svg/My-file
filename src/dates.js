'use strict';
// Dates stored as ISO "YYYY-MM-DD" strings; displayed as MM/DD/YYYY.
const pad = (n) => String(n).padStart(2, '0');
function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function show(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addMonths(y, m, n) { const t = (y * 12 + (m - 1)) + n; return [Math.floor(t / 12), (t % 12) + 1]; }
function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
// If a deadline falls on Sat/Sun it moves to the next working day.
// (Public holidays are NOT modelled in the MVP — see DECISIONS.md.)
function nextWorkingDay(isoDate) {
  let d = isoDate;
  for (;;) { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); if (wd !== 0 && wd !== 6) return d; d = addDays(d, 1); }
}
function today() {
  // Philippine time (UTC+8)
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function isValidIso(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T00:00:00Z')); }

// Fiscal quarter q (1-4) of the fiscal year that ENDS in `year`, month `fyEnd` (12 = calendar year)
function quarterRange(year, q, fyEnd = 12) {
  const [sy, sm] = addMonths(year, fyEnd, -12 + 1 + (q - 1) * 3); // first month of quarter
  const [ey, em] = addMonths(sy, sm, 2);
  return { from: iso(sy, sm, 1), to: iso(ey, em, lastDay(ey, em)), endYear: ey, endMonth: em };
}
function fiscalYearRange(year, fyEnd = 12) {
  const [sy, sm] = addMonths(year, fyEnd, -11);
  return { from: iso(sy, sm, 1), to: iso(year, fyEnd, lastDay(year, fyEnd)) };
}

module.exports = { iso, show, lastDay, addMonths, addDays, daysBetween, nextWorkingDay, today, isValidIso, quarterRange, fiscalYearRange, pad };
