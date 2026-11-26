'use strict';
// Default chart of accounts per client type and VAT status. Editable per client after creation.
function equityAccounts(type) {
  switch (type) {
    case 'individual': return [['3010', "Owner's Capital"], ['3020', "Owner's Drawings"], ['3900', 'Income Summary']];
    case 'partnership': case 'gpp': return [['3010', "Partners' Capital"], ['3020', "Partners' Drawings"], ['3900', 'Income Summary']];
    case 'nonstock': return [['3010', 'Fund Balance - Unrestricted'], ['3020', 'Fund Balance - Restricted'], ['3900', 'Income Summary']];
    case 'cooperative': return [['3010', 'Paid-up Share Capital'], ['3050', 'Statutory Funds'], ['3100', 'Undivided Net Surplus'], ['3900', 'Income Summary']];
    default: return [['3010', 'Share Capital'], ['3100', 'Retained Earnings'], ['3900', 'Income Summary']];
  }
}

function template(type, vat) {
  const a = [
    ['1010', 'Cash on Hand', 'asset'], ['1020', 'Cash in Bank', 'asset'], ['1100', 'Accounts Receivable', 'asset'],
    ['1200', 'Inventory', 'asset'], ['1250', 'Prepaid Expenses', 'asset'],
    ...(vat ? [['1300', 'Input VAT', 'asset']] : []),
    ['1310', 'Creditable Withholding Tax', 'asset'],
    ['1500', 'Property and Equipment', 'asset'], ['1510', 'Accumulated Depreciation', 'asset'],
    ['2010', 'Accounts Payable', 'liability'],
    ...(vat ? [['2100', 'Output VAT', 'liability'], ['2110', 'VAT Payable', 'liability']] : [['2120', 'Percentage Tax Payable', 'liability']]),
    ['2130', 'Withholding Tax Payable - Expanded', 'liability'], ['2140', 'Withholding Tax Payable - Compensation', 'liability'],
    ['2150', 'SSS/PhilHealth/Pag-IBIG Payable', 'liability'], ['2200', 'Income Tax Payable', 'liability'], ['2300', 'Loans Payable', 'liability'],
    ...equityAccounts(type).map(([c, n]) => [c, n, 'equity']),
    [ '4010', type === 'nonstock' ? 'Contributions and Donations' : 'Sales / Service Revenue', 'income'],
    ['4020', 'Other Income', 'income'], ['4030', 'Interest Income', 'income'],
    ['5010', 'Cost of Sales / Services', 'expense'],
    ['6010', 'Salaries and Wages', 'expense'], ['6015', 'SSS/PhilHealth/Pag-IBIG Contributions', 'expense'],
    ['6020', 'Rent Expense', 'expense'], ['6030', 'Utilities', 'expense'], ['6040', 'Office Supplies', 'expense'],
    ['6050', 'Transportation and Travel', 'expense'], ['6060', 'Representation and Entertainment', 'expense'],
    ['6070', 'Professional Fees', 'expense'], ['6080', 'Taxes and Licenses', 'expense'], ['6090', 'Repairs and Maintenance', 'expense'],
    ['6100', 'Depreciation Expense', 'expense'], ['6110', 'Communication', 'expense'], ['6120', 'Fuel and Oil', 'expense'],
    ['6190', 'Miscellaneous Expense', 'expense'],
  ];
  return a.map(([code, name, type]) => ({ code, name, type }));
}

function createChart(db, clientId, type, vat) {
  const ins = db.prepare('INSERT OR IGNORE INTO accounts (client_id, code, name, type) VALUES (?,?,?,?)');
  for (const a of template(type, vat)) ins.run(clientId, a.code, a.name, a.type);
}

// Fixed account roles used by the posting engine
const ROLE = { cash: '1010', ar: '1100', inputVat: '1300', cwt: '1310', ap: '2010', outputVat: '2100', revenue: '4010', ear: '6060', misc: '6190', cos: '5010' };

module.exports = { template, createChart, ROLE };
