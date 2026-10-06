// One look for every approval card on the Branches page (type, customer, order, amount, who asked,
// why, who already approved) and the collapsible folder helper that keeps an empty queue folded and a
// waiting one open and highlighted. The Layaway tab has its own copy of these two from before this
// file existed; Scrap, Subasta and POS use this one.
const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** esc = the page's HTML escaper. detail / actions are trusted HTML built by the caller. */
export function approvalCardHtml(esc, { type, order, customer, item, amount, requester, requestedAt, reason, detail, supervisor, awaitingFinal, actions }) {
  return '<div class="card lw-approval-card">' +
    '<div class="lw-approval-head"><span class="badge st-yellow">' + esc(type) + '</span>' +
      '<span class="muted" style="font-size:11px;">' + fmtDateTime(requestedAt) + '</span></div>' +
    '<div class="lw-approval-grid">' +
      '<div><span class="muted">Customer</span><b>' + esc(customer || '—') + '</b></div>' +
      '<div><span class="muted">Record</span><b>' + esc(order || '—') + '</b></div>' +
      (item ? '<div><span class="muted">Item</span><b>' + esc(item) + '</b></div>' : '') +
      (amount != null ? '<div><span class="muted">Amount</span><b>' + money(amount) + '</b></div>' : '') +
      '<div><span class="muted">Requested by</span><b>' + esc(requester || '—') + '</b></div>' +
    '</div>' +
    (detail ? '<div style="font-size:12px;margin-top:6px;">' + detail + '</div>' : '') +
    (reason ? '<div style="font-size:12px;margin-top:4px;"><span class="muted">Reason:</span> ' + esc(reason) + '</div>' : '') +
    (supervisor ? '<div class="muted" style="font-size:11px;margin-top:4px;">Supervisor approval: ' + esc(supervisor) + (awaitingFinal ? ' · final approval: waiting for Admin' : '') + '</div>' : '') +
    '<div class="lw-approval-actions">' + actions + '</div>' +
  '</div>';
}

/** Folds the <details> folder while nothing waits, opens + highlights it when something starts waiting. */
export function setApprovalFolder(folderId, n) {
  const f = document.getElementById(folderId);
  if (!f) return;
  const prev = Number(f.dataset.count || 0);
  f.dataset.count = String(n);
  f.classList.toggle('has-pending', n > 0);
  if (n > 0 && prev === 0) f.open = true;
  if (n === 0 && prev > 0) f.open = false;
}
