'use strict';
// Builds each client's filing calendar from registered tax types + fiscal year, using deadline RULES.
const { getRule } = require('./rules');
const { iso, lastDay, addMonths, addDays, nextWorkingDay, quarterRange, pad } = require('./dates');

function dueDate(db, form, { periodEnd, q, fyEndYear, fyEndMonth }) {
  const r = getRule(db, 'deadline.' + form, periodEnd).value;
  const [y, m] = periodEnd.split('-').map(Number);
  let d;
  switch (r.type) {
    case 'days_after_quarter_end': d = addDays(periodEnd, r.days); break;
    case 'day_of_next_month': { const [ny, nm] = addMonths(y, m, 1); d = iso(ny, nm, m === 12 && r.december_day ? r.december_day : r.day); break; }
    case 'last_day_of_month_after_quarter': { const [ny, nm] = addMonths(y, m, 1); d = iso(ny, nm, lastDay(ny, nm)); break; }
    case 'fixed_per_quarter': d = `${y}-${r.dates[q]}`; break;
    case 'fixed_next_year': d = `${fyEndYear + 1}-${r.date}`; break;
    case 'month_day_after_fy_end': { const [ny, nm] = addMonths(fyEndYear, fyEndMonth, r.months); d = iso(ny, nm, r.day); break; }
    default: throw new Error('Unknown deadline type ' + r.type);
  }
  return nextWorkingDay(d);
}

function obligations(client) {
  const t = new Set((client.tax_types || '').split(',').map((s) => s.trim()).filter(Boolean));
  const indiv = client.taxpayer_type === 'individual';
  const list = [];
  if (t.has('VAT') && client.vat_status === 'VAT') list.push({ form: '2550Q', freq: 'Q' });
  if (t.has('PT') && client.vat_status === 'NONVAT') list.push({ form: '2551Q', freq: 'Q' });
  if (t.has('IT')) {
    list.push({ form: indiv ? '1701Q' : '1702Q', freq: 'Q3' });
    list.push({ form: indiv ? '1701' : '1702', freq: 'A' });
  }
  if (t.has('EWT')) { list.push({ form: '0619-E', freq: 'M2' }, { form: '1601-EQ', freq: 'Q' }, { form: '1604-E', freq: 'A' }); }
  if (t.has('WTC')) { list.push({ form: '1601-C', freq: 'M' }, { form: '1604-C', freq: 'A' }); }
  return list;
}

// Generate filings for the fiscal year ending in `year`
function generateFilings(db, client, year) {
  const fyEnd = client.fy_end_month || 12;
  const ins = db.prepare('INSERT OR IGNORE INTO filings (client_id, form, period_label, period_end, due_date) VALUES (?,?,?,?,?)');
  let n = 0;
  const add = (form, label, periodEnd, q) => {
    const due = dueDate(db, form, { periodEnd, q, fyEndYear: year, fyEndMonth: fyEnd });
    n += Number(ins.run(client.id, form, label, periodEnd, due).changes);
  };
  for (const ob of obligations(client)) {
    if (ob.freq === 'A') {
      // 1604-C/E follow the calendar year; income tax follows the fiscal year
      const end = ob.form.startsWith('1604') ? iso(year, 12, 31) : quarterRange(year, 4, fyEnd).to;
      add(ob.form, `FY${year}`, end, 4);
      continue;
    }
    for (let q = 1; q <= 4; q++) {
      const qr = quarterRange(year, q, fyEnd);
      if (ob.freq === 'Q') add(ob.form, `FY${year}-Q${q}`, qr.to, q);
      if (ob.freq === 'Q3' && q <= 3) add(ob.form, `FY${year}-Q${q}`, qr.to, q);
      if (ob.freq === 'M' || ob.freq === 'M2') {
        for (let k = 0; k < 3; k++) {
          if (ob.freq === 'M2' && k === 2) continue; // 3rd month is covered by the quarterly return
          const [yy, mm] = addMonths(Number(qr.from.slice(0, 4)), Number(qr.from.slice(5, 7)), k);
          add(ob.form, `${yy}-${pad(mm)}`, iso(yy, mm, lastDay(yy, mm)), q);
        }
      }
    }
  }
  return n;
}

module.exports = { generateFilings, dueDate, obligations };
