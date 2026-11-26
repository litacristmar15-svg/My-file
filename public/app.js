// Small enhancements for fast encoding: party autofill + VAT auto-split.
(function () {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
  var form = document.getElementById('docform');
  if (!form) return;
  var parties = JSON.parse(form.dataset.parties || '[]');
  var vatRate = Number(form.dataset.vatrate || 120000);
  var vatClient = form.dataset.vatclient === '1';
  var $ = function (n) { return form.querySelector('[name="' + n + '"]'); };
  var toC = function (s) { s = String(s || '').replace(/[₱,\s]/g, ''); if (!s) return 0; var p = s.split('.'); return Number(p[0] || 0) * 100 + Number(((p[1] || '') + '00').slice(0, 2)) * (s[0] === '-' ? -1 : 1); };
  var toS = function (c) { var a = Math.abs(c); return (c < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0'); };
  $('party_name').addEventListener('change', function () {
    var p = parties.find(function (x) { return x.name.toLowerCase() === this.value.toLowerCase(); }, this);
    if (!p) return;
    $('party_tin').value = p.tin || ''; if ($('party_address')) $('party_address').value = p.address || '';
    if ($('party_vat_registered')) $('party_vat_registered').value = String(p.vat_registered);
    if (p.default_account_id && $('account_id')) $('account_id').value = String(p.default_account_id);
  });
  function split() {
    var total = toC($('total').value);
    var isVat = $('vat_mode').value;
    if (isVat === 'inclusive') {
      var vat = Math.floor((total * vatRate * 2 + (1000000 + vatRate)) / (2 * (1000000 + vatRate)));
      $('vatable').value = toS(total - vat); $('vat').value = toS(vat); $('exempt').value = '0.00'; $('zero_rated').value = '0.00';
    } else if (isVat === 'exempt') { $('vatable').value = '0.00'; $('vat').value = '0.00'; $('exempt').value = toS(total); $('zero_rated').value = '0.00'; }
    else if (isVat === 'zero') { $('vatable').value = '0.00'; $('vat').value = '0.00'; $('exempt').value = '0.00'; $('zero_rated').value = toS(total); }
  }
  $('total').addEventListener('input', split); $('vat_mode').addEventListener('change', split);
})();
