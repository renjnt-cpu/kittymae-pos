// What needs a person's attention in a branch: the wording of each "Needs Attention" kind (from the server report
// branch_ops_attention, migrations 166/173/179), how urgent it is, where clicking it goes, and the red / amber badge each
// module pill on the Branches page shows ("Layaway 34 · 3 overdue"). Shared by the Branch Dashboard and the Branches page.
export const money = (n) => {
  n = Number(n || 0);
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};
export const num = (n) => Number(n || 0).toLocaleString('en-PH');
export const plural = (n, one, many) => num(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));

/** What each "Needs Attention" kind says, how urgent it is, and where clicking it goes
 * (tab + an optional view the tab can honor via applyView). Lowest `rank` first. */
export const ATTENTION_KINDS = {
  layaway_overdue:          { rank: 1, tone: 'bad',  tab: 'layaway', view: 'overdue',   text: (n, a) => plural(n, 'layaway item') + ' past the deadline' + (a ? ' — ' + money(a) + ' still owed' : '') },
  pending_layaway_deletion: { rank: 2, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'layaway deletion request') + ' awaiting approval' },
  pending_payment_deletion: { rank: 3, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'payment deletion request') + ' awaiting approval' },
  pending_item_change:      { rank: 4, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'item change request') + ' awaiting approval' },
  pending_forfeit_request:  { rank: 2, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n, a) => plural(n, 'forfeiture request') + ' awaiting approval' + (a ? ' — ' + money(a) + ' owed' : '') },
  pending_forfeit_date:     { rank: 5, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'forfeit date request') + ' awaiting approval' },
  reminders_due:            { rank: 5, tone: 'warn', tab: 'layaway', view: 'reminders', text: (n, a) => plural(n, 'customer') + ' due for a payment reminder' + (a ? ' — ' + money(a) + ' owed' : '') },
  layaway_nearing:          { rank: 6, tone: 'warn', tab: 'layaway', view: 'nearing',   text: (n, a) => plural(n, 'layaway item') + ' nearing the deadline' + (a ? ' — ' + money(a) + ' still owed' : '') },
  cod_pending:              { rank: 7, tone: 'warn', tab: 'pos',     view: 'cod',       text: (n, a) => plural(n, 'COD sale') + ' waiting to be collected' + (a ? ' — ' + money(a) : '') },
  zero_amount_sale:         { rank: 8, tone: 'warn', tab: 'pos',     view: 'zero',      text: (n) => plural(n, 'sale') + ' with a ₱0 line item to fix' },
  pickup_pending:           { rank: 9, tone: 'info', tab: 'pos',     view: 'pickup',    text: (n) => plural(n, 'sale') + ' waiting for pickup' },
  layaway_lacking:          { rank: 10, tone: 'info', tab: 'layaway', view: 'lacking',  text: (n) => plural(n, 'layaway item') + ' waiting for stock' },
  scrap_unpaid:             { rank: 3, tone: 'bad',  tab: 'scrap',   view: 'unpaid',    text: (n, a) => plural(n, 'scrap purchase') + ' not fully paid' + (a ? ' — ' + money(a) + ' owed to customers' : '') },
  pending_scrap_request:    { rank: 4, tone: 'warn', tab: 'scrap',   view: 'requests',  text: (n, a) => plural(n, 'scrap delete request') + ' awaiting approval' + (a ? ' — ' + money(a) : '') },
  subasta_unpaid:           { rank: 3, tone: 'bad',  tab: 'subasta', view: 'unpaid',    text: (n, a) => plural(n, 'sold Subasta item') + ' not fully paid' + (a ? ' — ' + money(a) + ' still owed by buyers' : '') },
  pending_subasta_request:  { rank: 4, tone: 'warn', tab: 'subasta', view: 'requests',  text: (n, a) => plural(n, 'Subasta delete request') + ' awaiting approval' + (a ? ' — ' + money(a) : '') },
  subasta_eligible:         { rank: 9, tone: 'info', tab: 'subasta', view: 'eligible',  text: (n) => plural(n, 'Subasta item') + ' eligible for auction but not listed yet' },
};

/** The badge for each module pill of one branch ("3 overdue", "2 unpaid", "1 to approve"), from the attention rows. */
export function urgentFrom(attention, branchId) {
  const mine = (attention || []).filter((a) => a.branch_id === branchId);
  const n = (kind) => (mine.find((a) => a.kind === kind) || {}).n || 0;
  const out = {};
  if (n('layaway_overdue')) out.layaway = { text: n('layaway_overdue') + ' overdue', tone: 'bad' };
  else {
    const pend = n('pending_forfeit_date') + n('pending_item_change') + n('pending_payment_deletion') + n('pending_layaway_deletion') + n('pending_forfeit_request');
    if (pend) out.layaway = { text: pend + ' to approve', tone: 'warn' };
    else if (n('reminders_due')) out.layaway = { text: n('reminders_due') + ' to remind', tone: 'warn' };
  }
  if (n('cod_pending')) out.pos = { text: n('cod_pending') + ' COD', tone: 'warn' };
  if (n('scrap_unpaid')) out.scrap = { text: n('scrap_unpaid') + ' unpaid', tone: 'bad' };
  else if (n('pending_scrap_request')) out.scrap = { text: n('pending_scrap_request') + ' to approve', tone: 'warn' };
  if (n('subasta_unpaid')) out.subasta = { text: n('subasta_unpaid') + ' unpaid', tone: 'bad' };
  else if (n('pending_subasta_request')) out.subasta = { text: n('pending_subasta_request') + ' to approve', tone: 'warn' };
  else if (n('subasta_eligible')) out.subasta = { text: n('subasta_eligible') + ' to list', tone: 'warn' };
  return out;
}
