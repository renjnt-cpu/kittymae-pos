// One definition of a layaway's status, shared by the On Hold list, the detail drawer,
// Forfeiture Watch and the reminder queue (Ren, 2026-10-07). Everything is DERIVED from the
// hold's own data -- nothing new is stored, so the stored status ('On Hold', 'Completed',
// 'Cancelled', 'Forfeited') that dashboards and refunds read stays exactly as it was.
//
//   COMPLETED / CANCELLED / FORFEITED   the stored final states
//   PAID IN FULL      still On Hold, balance cleared (ready to complete)
//   FORFEITURE DUE    past the deadline AND a forfeiture request is waiting for a decision
//   OVERDUE           past the deadline, balance still owed
//   NEARING DEADLINE  deadline within the "nearing" window (default 15 days)
//   PARTIALLY PAID    something paid, balance owed, deadline not close
//   ON HOLD           nothing paid yet
import { getOpsConfig, layawayDeadline } from './branchOpsConfig.js?v=20261007j';
import { daysBetween, manilaToday } from './opsDates.js?v=20261007j';

/** Colour family per status -- green done/paid, blue active, yellow nearing, red overdue/lost, grey cancelled. */
export const STATUS_TONE = {
  'ON HOLD': 'blue', 'PARTIALLY PAID': 'blue', 'PAID IN FULL': 'green', 'COMPLETED': 'green',
  'NEARING DEADLINE': 'yellow', 'OVERDUE': 'red', 'FORFEITURE DUE': 'red', 'FORFEITED': 'red', 'CANCELLED': 'gray',
};
export const ACTIVE_STATUSES = ['ON HOLD', 'PARTIALLY PAID', 'PAID IN FULL', 'NEARING DEADLINE', 'OVERDUE', 'FORFEITURE DUE'];

export const paidOf = (h) => (h.layaway_payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);

/** "45 days left" / "Due today" / "OVERDUE 2 DAYS" -- only meaningful while the layaway is still On Hold. */
export function daysText(days) {
  if (days > 0) return days + (days === 1 ? ' day left' : ' days left');
  if (days === 0) return 'Due today';
  const n = -days;
  return 'OVERDUE ' + n + (n === 1 ? ' DAY' : ' DAYS');
}

/** Everything the UI needs to show about one hold. `openForfeitRequest` = a Pending/Supervisor
 * Approved forfeiture request exists for it. */
export function layawayInfo(h, { openForfeitRequest = false } = {}) {
  const paid = paidOf(h);
  const priced = h.total_price != null;
  const total = Number(h.total_price || 0);
  const remaining = priced ? Math.max(total - paid, 0) : null;
  const pct = priced && total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : null;
  const deadline = layawayDeadline(h.forfeit_date, h.hold_date);
  const days = daysBetween(manilaToday(), deadline); // > 0 left, 0 today, < 0 overdue
  const near = getOpsConfig().nearingDays;
  const paidInFull = priced && total > 0 && paid >= total - 0.01;

  let key;
  if (h.status === 'Completed') key = 'COMPLETED';
  else if (h.status === 'Cancelled') key = 'CANCELLED';
  else if (h.status === 'Forfeited') key = 'FORFEITED';
  else if (paidInFull) key = 'PAID IN FULL';
  else if (days < 0) key = openForfeitRequest ? 'FORFEITURE DUE' : 'OVERDUE';
  else if (days <= near) key = 'NEARING DEADLINE';
  else if (paid > 0) key = 'PARTIALLY PAID';
  else key = 'ON HOLD';

  const active = h.status === 'On Hold';
  const tone = STATUS_TONE[key];
  return {
    key, tone, paid, total, remaining, pct, deadline, days, active,
    daysText: active && !paidInFull ? daysText(days) : '',
    // Row tint in lists: only the two things that need action
    rowTone: key === 'OVERDUE' || key === 'FORFEITURE DUE' ? 'red' : key === 'NEARING DEADLINE' ? 'yellow' : '',
    overdue: active && !paidInFull && days < 0,
  };
}

export const statusChipHtml = (info) => '<span class="badge st-' + info.tone + '">' + info.key + '</span>';

/** A thin paid-percentage bar with the number beside it. */
export function progressHtml(pct) {
  if (pct == null) return '<span class="muted">—</span>';
  return '<span class="lw-bar" role="img" aria-label="' + pct + '% paid"><span style="width:' + pct + '%"></span></span> <span class="lw-pct">' + pct + '%</span>';
}
