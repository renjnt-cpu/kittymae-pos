// Layaway tab (Branches page) -- a branch-scoped port of the standalone layaway.html
// page's exact "Hold Item(s)" / On Hold list / Monthly Monitoring / Forfeiture Watch
// feature set, reusing its multi-item-hold, proportional-payment-split, and
// rollback-on-partial-failure logic verbatim. The one real difference: there's no
// Branch field on the Hold form and no Branch column in the tables here -- the whole
// tab is already scoped to whichever branch is selected on the Branches page
// (getBranchId()), so every row it ever shows is that one branch by construction.
import {
  listLayaways, createLayawayHold, addLayawayPayment, completeLayaway, cancelLayaway,
  setLayawayForfeitDate, setLayawayHoldDate, uploadLayawayPaymentProof, getLayawayPaymentProofUrl,
  searchProducts, listLayawayHandlers, subscribeToChanges, editLayawayHold, forfeitLayawayHold,
  requestLayawayForfeitDate, listLayawayForfeitDateRequests, approveLayawayForfeitDate, rejectLayawayForfeitDate,
  requestLayawayItemChange, listLayawayItemChangeRequests, approveLayawayItemChange, rejectLayawayItemChange,
  requestLayawayPaymentDeletion, listLayawayPaymentDeletionRequests, approveLayawayPaymentDeletion, rejectLayawayPaymentDeletion,
  requestLayawayHoldDeletion, listLayawayHoldDeletionRequests, approveLayawayHoldDeletionStage1, approveLayawayHoldDeletionFinal, rejectLayawayHoldDeletion,
  markLayawayStockAvailable,
  listLayawayForfeitRequests, requestLayawayForfeit, approveLayawayForfeitStage1, approveLayawayForfeitFinal, rejectLayawayForfeit,
  cancelLayawayForfeitRequest, getLayawayReminderQueue, markLayawayContacted, setLayawayAltContact, listLayawayChangeLog,
  logBranchErrorCorrection, listActiveEmployees, getProductNames,
} from './api.js?v=20261007n';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20261007n';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, byDate, localDateStr, flagInvalid } from './uiKit.js?v=20261007n';
import { daysBetween, manilaToday, manilaDateStr } from './opsDates.js?v=20261007n';
import { getOpsConfig, layawayDeadline } from './branchOpsConfig.js?v=20261007n';
import { confirmDialog, reasonDialog, messageDialog, ERROR_TYPES } from './dialogs.js?v=20261007n';
import { layawayInfo, statusChipHtml, progressHtml, paidOf, daysText, daysToneOf, ACTIVE_STATUSES } from './layawayStatus.js?v=20261007n';
import { openCustomerHistory } from './customerHistory.js?v=20261007n';
import { pageSlice, pagerHtml, wirePager } from './pager.js?v=20261007n';
import { paymentRowsHtml, mountPaymentRows } from './paymentRows.js?v=20261007n';
import { attachCustomerPicker } from './customerPicker.js?v=20261007n';
import { friendlyError } from './shell.js?v=20261007n';

// Global Filter + Sort rules (Ren, 2026-09-21, section 20): one Sort control governs
// every status folder (On Hold/Completed/Cancelled/Forfeited) so there's exactly one
// sort UI to learn for this whole tab, not one per folder. Paid/Remaining aren't real
// columns (they're computed from layaway_payments), so their comparators call
// paidSoFar() directly instead of byNumber().
const LW_SORT_FIELDS = [
  { key: 'hold_date', label: 'Date' }, { key: 'sku', label: 'SKU' }, { key: 'customer_name', label: 'Customer' },
  { key: 'qty', label: 'Qty' }, { key: 'total_price', label: 'Total' }, { key: 'paid', label: 'Paid' },
  { key: 'remaining', label: 'Remaining Balance' }, { key: 'status', label: 'Status' },
];
function lwSortComparators() {
  return {
    hold_date: byDate('hold_date'), sku: byText('sku'), customer_name: byText('customer_name'),
    qty: byNumber('qty'), total_price: byNumber('total_price'), status: byText('status'),
    paid: (a, b) => paidSoFar(a) - paidSoFar(b),
    remaining: (a, b) => (Number(a.total_price || 0) - paidSoFar(a)) - (Number(b.total_price || 0) - paidSoFar(b)),
  };
}
// Monthly Monitoring's own rows are per-month aggregates, not layaway_holds rows, so
// they get a separate field list/state (spec section 15).
const MM_SORT_FIELDS = [
  { key: 'month', label: 'Month' }, { key: 'count', label: 'Count' }, { key: 'value', label: 'Total Value' },
  { key: 'paid', label: 'Paid' }, { key: 'remaining', label: 'Remaining' },
];
const MM_SORT_COMPARATORS = {
  month: (a, b) => a.month.localeCompare(b.month), count: byNumber('count'), value: byNumber('value'),
  paid: byNumber('paid'), remaining: (a, b) => (a.value - a.paid) - (b.value - b.paid),
};
// Payments Received is Payment History (spec section 16): sortable by date/amount/
// method/recorded-by/status.
const MM_PAY_SORT_FIELDS = [
  { key: 'paid_at', label: 'Payment Date' }, { key: 'amount', label: 'Amount' }, { key: 'payment_method', label: 'Payment Method' },
  { key: 'recordedBy', label: 'Recorded By' }, { key: 'paymentStatus', label: 'Status' },
];
const MM_PAY_SORT_COMPARATORS = {
  paid_at: byDate('paid_at'), amount: byNumber('amount'), payment_method: byText('payment_method'),
  recordedBy: byText('recordedBy'), paymentStatus: byText('paymentStatus'),
};
// Forfeiture Watch's default (most-urgent-first) is a deliberate business rule, not a
// generic "newest first" -- kept as the default sort field/direction here rather than
// overridden by the shared control's own defaults (spec section 23).
const FW_SORT_FIELDS = [
  { key: 'urgency', label: 'Days Remaining (most urgent first)' }, { key: 'customer_name', label: 'Customer' },
  { key: 'sku', label: 'SKU' }, { key: 'paid', label: 'Paid' }, { key: 'remaining', label: 'Remaining' },
];
function fwSortComparators() {
  return {
    urgency: (a, b) => a.daysPastForfeit - b.daysPastForfeit, customer_name: (a, b) => byText('customer_name')(a.h, b.h),
    sku: (a, b) => byText('sku')(a.h, b.h), paid: (a, b) => paidSoFar(a.h) - paidSoFar(b.h),
    remaining: (a, b) => (Number(a.h.total_price || 0) - paidSoFar(a.h)) - (Number(b.h.total_price || 0) - paidSoFar(b.h)),
  };
}

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
// Per Gram jewelry (Ren, 2026-09-18: "the total amount must be multiply the price per
// gram and weight") -- a Per Gram SKU's price = its rate (current_gold_rate_per_g) x
// its weight, same as SKU Catalog/POS -- used to auto-fill Unit Price when a Per Gram
// SKU is picked here, so Total (qty x Unit Price) comes out right automatically.
const effectivePrice = (p) => p.pricing_mode === 'Per Gram'
  ? (p.current_gold_rate_per_g != null && p.gross_weight_g != null ? p.current_gold_rate_per_g * p.gross_weight_g : null)
  : p.system_selling_price;
const STATUS_BADGE = { 'On Hold': 'pending', 'Completed': 'ok', 'Cancelled': 'low', 'Forfeited': 'low' };
// A layaway with no explicit Forfeit Date is due a set number of calendar months after its
// layaway date (hold_date) -- 2 by default, changeable in Branch Operations settings
// (branchOpsConfig.js, the same rule as layaway_deadline() in the database, so these rows and
// the Branch Operations Summary always agree). Staff can still override it per hold with an
// explicit Forfeit Date. The "nearing" window (default 15 days) gives a heads-up before the
// deadline so staff can chase payment before it's actually too late, not just after.
// Today is the MANILA calendar day, not the viewer's clock.
function daysSince(dateStr) {
  if (!dateStr) return 0;
  return daysBetween(dateStr, manilaToday());
}
/** The default Forfeit Date when staff hasn't set an explicit one. */
function defaultForfeitDate(holdDateStr) {
  return layawayDeadline(null, holdDateStr);
}
// Same branch-scope rule as assert_can_act_on_branch()/record_sale() -- whole staff
// can hold/pay/complete/cancel a layaway for their own branch; this group can do it
// for any branch.
const UNSCOPED_POSITIONS = ['Sales Admin Associate', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

// ---- Layout (Ren's second Branches spec, 2026-10-07): the tab is no longer one long page. A compact header (title, quick
// filters, clickable summary cards) sits over seven sub-tabs -- Overview, On Hold, Payments, Due / Forfeiture, Completed,
// Forfeited, Requests -- and only the chosen one is drawn. Every section below is the one that already existed, moved into
// its tab: the same rules, approvals, audit trail and server calls. ----
const SUBTABS = [['overview', 'Overview'], ['onhold', 'On Hold'], ['payments', 'Payments'], ['due', 'Due / Forfeiture'], ['completed', 'Completed'], ['forfeited', 'Forfeited'], ['requests', 'Requests']];
const QUICK = [['all', 'All'], ['attention', 'Needs Attention'], ['soon', 'Due Soon'], ['overdue', 'Overdue'], ['partial', 'Partially Paid'], ['paid', 'Paid in Full']];
// Due / Forfeiture sections, most urgent first (days left: < 0, 0, 1-3, 4-7, 8+); tone = the colour of the heading.
const DUE_SECTIONS = [['overdue', 'Overdue', 'red'], ['today', 'Due today', 'red'], ['d3', 'Due in 3 days', 'orange'], ['d7', 'Due in 7 days', 'yellow'], ['later', 'Due later', 'green']];
const DUE_FILTERS = [['all', 'All'], ['overdue', 'Overdue'], ['today', 'Due today'], ['soon', 'Due within 7 days'], ['nearing', 'Nearing the deadline'], ['later', 'Due later']];
const money0 = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const dueBucket = (days) => (days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 3 ? 'd3' : days <= 7 ? 'd7' : 'later');


/** Mounts the Layaway tab into `root` (an empty container this owns entirely),
 * scoped to `getBranchId()` at call time -- read as a function rather than a fixed
 * value so switching branches elsewhere on the page just needs a reload() call, not
 * a re-mount. `esc`/`toast` are the page's own shell.js helpers; `msgId` is the id of
 * the page's toast container; `employee` is the signed-in employee record.
 * Returns { reload } for the host page to call after a branch switch. Async because
 * the Hold form needs the active-staff list (for "Handled By") before it can render. */
export async function initLayawayTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate, getRange, requestRange }) {
  const isScoped = ['Admin', 'Manager'].includes(employee.role) ? false : !UNSCOPED_POSITIONS.includes(employee.position);
  // Branch Supervisor was missing from this line despite being a manager-level role
  // everywhere else in the app -- it now covers deleting a payment and editing a
  // hold's details, matching edit_layaway_hold's own server-side gate exactly.
  const canManage = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || POSITION_MANAGERS.includes(employee.position);
  // Ren's spec sections 121-132, confirmed 2026-09-21: correcting an already-recorded
  // amount (a hold's Unit Price/Qty/Total, or deleting a recorded payment) is narrower
  // than canManage above -- only the Auditor position or anyone holding a
  // Supervisor-named position/role. Mirrors is_amount_editor() in the database
  // exactly, including the layaway_payments delete RLS policy.
  // 'Admin' and 'Branch Team Leader' added 2026-09-24 -- both were missing here even
  // though the server (is_amount_editor()/transaction.edit_amount) already granted
  // them, so Admin couldn't see this Edit button at all and Branch Team Leader was
  // fully blocked from it (Ren: "supervisor and branch team leader can also edit").
  const canEditAmount = employee.role === 'Admin' || employee.position === 'Auditor' || employee.role === 'Branch Supervisor' ||
    employee.position === 'Branch Team Leader' || (employee.position || '').includes('Supervisor');
  // A Completed hold's SKU/Qty/Price are locked (its stock has already left
  // "reserved" and become an actual sale) -- but Admin/Auditor can still fix the
  // surrounding DETAILS (customer name, contact, Order ID, notes), narrower than
  // canEditAmount above (Ren, 2026-09-25: "give access auditor/glenn to edit
  // completed details"). Mirrors edit_layaway_hold()'s own Completed-status gate.
  const canEditCompletedDetails = employee.role === 'Admin' || employee.position === 'Auditor';
  // Changing a hold's ITEM specifically is narrower still (Ren, 2026-09-24: "but for
  // approval of supervisor") -- Branch Team Leader keeps canEditAmount above for
  // everything else, but an item change needs a Supervisor (or Admin/Manager) to
  // approve it first. Mirrors can_approve_layaway_item_change() exactly.
  const canApproveItemChange = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || (employee.position || '').includes('Supervisor');
  // Cancelling (the "final delete" of a layaway) is narrower still -- Admin only
  // (Ren, 2026-09-16: "i will be the one to final delete not supervisor or manager
  // now"), reversing the same-day-earlier change that let Manager/Branch Supervisor
  // do it too. Matches cancel_layaway's own server-side gate exactly.
  const canFinalDelete = employee.role === 'Admin';
  const staff = await listLayawayHandlers();
  // Three independent { field, dir } states -- one per distinct dataset on this tab
  // (spec section 9: same state drives desktop/tablet/mobile, but a dataset switch
  // like On Hold list -> Monthly rollup -> Forfeiture Watch is a genuinely different
  // list, not a breakpoint, so each earns its own state). Declared before
  // root.innerHTML below, which already reads them via sortControlHtml().
  const sort = { field: 'hold_date', dir: 'desc' };
  const mmSort = { field: 'month', dir: 'desc' };
  const mmPaySort = { field: 'paid_at', dir: 'desc' };
  const fwSort = { field: 'urgency', dir: 'desc' };
  // Paging state, one per paged list (25 rows a page; the footer offers 50 and 100), the sub-tab on show, and the chosen
  // section filter of Due / Forfeiture. Requests (the approval queues) are only for people who can act on them.
  const pgOnHold = { page: 1 }, pgPay = { page: 1 }, pgDue = { page: 1 }, pgDone = { page: 1 }, pgForf = { page: 1 }, pgCanc = { page: 1 };
  let subTab = 'overview';
  let dueFilter = 'all';
  const canSeeRequests = canFinalDelete || canApproveItemChange;

  function notify(text, isError) {
    toast(msgId, text, isError);
    document.getElementById(msgId).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // One section of the Requests tab (the approval queues): a heading with its count and its list. The render functions
  // further down fill `<id>-count` and `<id>-list`; an empty queue is a single quiet line, never an empty card.
  const reqSection = (id, title) =>
    '<section class="lw-req lw-approval" id="' + id + '-folder" data-count="0">' +
      '<h4>' + title + ' <span class="exp-count" id="' + id + '-count"></span></h4>' +
      '<div id="' + id + '-list"><div class="muted">Loading…</div></div>' +
    '</section>';

  root.innerHTML =
    // Search is owned by the sticky bar on the Branches page: it writes into this proxy, which every list reads.
    '<input type="text" id="lw-f-search" class="km-search-proxy" tabindex="-1" aria-hidden="true" autocomplete="off">' +
    // The page's action button ("+ New Layaway") clicks this one; it is not shown here.
    '<div class="module-topbar"><div></div><div style="text-align:right;"><button type="button" class="btn" id="lw-new-btn">+ New Layaway</button></div></div>' +

    // Compact header: title, quick filters, clickable summary cards.
    '<div class="lw-head">' +
      '<div class="lw-head-row"><h3 class="lw-title" id="lw-title">Layaway</h3>' +
        '<div class="lw-quick" id="lw-quick" role="group" aria-label="Quick filters">' +
          QUICK.map(([k, l]) => '<button type="button" data-q="' + k + '" aria-pressed="' + (k === 'all') + '">' + l + '</button>').join('') +
        '</div></div>' +
      '<div class="lw-cards" id="lw-cards"><div class="muted">Loading…</div></div>' +
    '</div>' +
    '<div class="lw-subtabs" id="lw-subtabs" role="tablist" aria-label="Layaway sections"></div>' +

    // ---- OVERVIEW: short on purpose -- what needs attention, the last 5 payments, the last 5 layaways ----
    '<section class="lw-panel" id="lw-p-overview" data-panel="overview">' +
      '<div class="lw-ov">' +
        '<div class="card lw-ov-card"><h4>Needs attention</h4><div id="lw-attn"></div></div>' +
        '<div class="card lw-ov-card"><h4>Recent payments <span class="muted">· last 5</span></h4><div id="lw-recent-pay"></div></div>' +
        '<div class="card lw-ov-card"><h4>Recent layaways <span class="muted">· last 5</span></h4><div id="lw-recent-lay"></div></div>' +
      '</div>' +
      '<details class="card exp" id="lw-monthly-wrap" style="margin-top:12px;">' +
        '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Monthly monitoring <span class="exp-count">(a per-month rollup for the dates chosen above)</span></summary>' +
        '<div class="exp-body">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
            // From/To (here and in Payments below) are driven by the page's global date range: kept in the DOM, not shown.
            '<div class="field range-managed"><label>From</label><input type="date" id="mm-from"></div>' +
            '<div class="field range-managed"><label>To</label><input type="date" id="mm-to"></div>' +
            sortControlHtml(MM_SORT_FIELDS, mmSort, 'mm-sort-field', 'mm-sort-dir') +
            '<button type="button" class="btn small secondary range-managed" id="mm-clear">All Time</button>' +
          '</div>' +
          '<div class="tiles" id="mm-tiles"></div>' +
          '<div id="mm-table"></div>' +
        '</div>' +
      '</details>' +
    '</section>' +

    // ---- ON HOLD: the working list -- filters, then a paged table ----
    '<section class="lw-panel" id="lw-p-onhold" data-panel="onhold" hidden>' +
      '<div class="card lw-toolbar"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field"><label>Status</label><select id="lw-f-status"><option value="all">All active</option><option value="attention">Needs attention</option><option value="past">Past deadline (overdue + forfeiture due)</option><option value="lacking">Waiting for stock</option>' +
          ACTIVE_STATUSES.map((s) => '<option value="' + s + '">' + s + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Due</label><select id="lw-f-due"><option value="all">Any time</option><option value="today">Due today</option><option value="d3">Due in 3 days</option><option value="d7">Due in 7 days</option><option value="d14">Due in 14 days</option><option value="overdue">Overdue</option></select></div>' +
        '<div class="field"><label>Payment</label><select id="lw-f-pay"><option value="all">Any</option><option value="unpaid">Nothing paid yet</option><option value="partial">Partially paid</option><option value="paid">Paid in full</option></select></div>' +
        '<div class="field"><label>Recorded by</label><select id="lw-f-by"><option value="all">Anyone</option></select></div>' +
        sortControlHtml(LW_SORT_FIELDS, sort, 'lw-sort-field', 'lw-sort-dir') +
        '<button type="button" class="btn small secondary" id="lw-f-clear">Clear Filters</button>' +
      '</div></div>' +
      '<div id="lw-active"></div>' +
      '<div id="lw-list"><div class="muted">Loading…</div></div>' +
    '</section>' +

    // ---- PAYMENTS: every payment by its own date ----
    '<section class="lw-panel" id="lw-p-payments" data-panel="payments" hidden>' +
      '<div class="lw-cards" id="mm-pay-tiles"></div>' +
      '<div class="card lw-toolbar"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field range-managed"><label>From</label><input type="date" id="mm-pay-f-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="mm-pay-f-to"></div>' +
        '<div class="field"><label>Method</label><select id="mm-pay-f-method"><option value="all">All</option>' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Status</label><select id="mm-pay-f-status"><option value="all">All</option><option>Downpayment</option><option>Partial</option><option>Paid in Full</option></select></div>' +
        '<div class="field"><label>Reference</label><select id="mm-pay-f-ref"><option value="all">Any</option><option value="missing">Missing (non-cash)</option></select></div>' +
        '<div class="field"><label>Recorded By</label><select id="mm-pay-f-recordedby"><option value="all">All</option></select></div>' +
        sortControlHtml(MM_PAY_SORT_FIELDS, mmPaySort, 'mm-pay-sort-field', 'mm-pay-sort-dir') +
        '<button type="button" class="btn small secondary" id="mm-pay-f-clear">Clear Filters</button>' +
      '</div></div>' +
      '<div id="mm-pay-active"></div>' +
      '<div id="mm-payments-table"></div>' +
    '</section>' +

    // ---- DUE / FORFEITURE: who to remind, then every On Hold item by how close its deadline is ----
    '<section class="lw-panel" id="lw-p-due" data-panel="due" hidden>' +
      '<p class="muted lw-note">Unpaid layaways are due ' + getOpsConfig().forfeitMonths + ' months after the layaway date unless a Forfeit Date is set. Nothing is ever forfeited automatically: an overdue item needs a forfeiture request, a Supervisor\'s approval and Admin\'s final approval. The date purchased is fixed once set (Admin only can correct it); a Forfeit Date change by anyone else needs Admin approval. This list is not limited by the dates chosen above.</p>' +
      // Customers to Remind (Ren, 2026-10-07): who is due a reminder; reminders are never sent automatically. Open when someone is due.
      '<details class="card exp lw-remind" id="lw-remind-folder">' +
        '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Customers to Remind <span class="exp-count" id="lw-remind-count"></span></summary>' +
        '<div class="exp-body" id="lw-remind-list"><div class="muted">Loading…</div></div>' +
      '</details>' +
      '<div class="card lw-toolbar"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field"><label>Show</label><select id="lw-due-filter">' + DUE_FILTERS.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select></div>' +
        sortControlHtml(FW_SORT_FIELDS, fwSort, 'fw-sort-field', 'fw-sort-dir') +
      '</div></div>' +
      '<div id="fw-table"></div>' +
    '</section>' +

    // ---- COMPLETED / FORFEITED (and cancelled) ----
    '<section class="lw-panel" id="lw-p-completed" data-panel="completed" hidden><div class="muted lw-note" id="lw-done-note"></div><div id="lw-list-completed"></div></section>' +
    '<section class="lw-panel" id="lw-p-forfeited" data-panel="forfeited" hidden>' +
      '<div class="muted lw-note" id="lw-forf-note"></div>' +
      '<h4 class="lw-sec-h">Forfeited <span class="exp-count" id="lw-forfeited-count"></span></h4><div id="lw-list-forfeited"></div>' +
      '<h4 class="lw-sec-h" style="margin-top:20px;">Cancelled <span class="exp-count" id="lw-cancelled-count"></span></h4><div id="lw-list-cancelled"></div>' +
    '</section>' +

    // ---- REQUESTS: every approval queue in one place (Ren, 2026-10-07) ----
    (canSeeRequests
      ? '<section class="lw-panel" id="lw-p-requests" data-panel="requests" hidden>' +
          '<h4 class="lw-req-title">Requests <span class="muted" id="lw-approvals-total" style="font-weight:normal;"></span></h4>' +
          (canApproveItemChange ? reqSection('lw-pending-forfeitreq', 'Forfeiture Requests') : '') +
          (canFinalDelete ? reqSection('lw-pending-forfeit', 'Forfeit Date Requests') : '') +
          (canApproveItemChange ? reqSection('lw-pending-itemchange', 'Item Change Requests') + reqSection('lw-pending-paymentdel', 'Payment Deletion Requests') + reqSection('lw-pending-holddel', 'Layaway Deletion Requests') : '') +
        '</section>'
      : '') +

    // Form Drawer (Ren's UI redesign pilot, section 203): same fields as before, now in five numbered parts (Items, Customer,
    // Payment, Deadline, Review) with the running order total, downpayment and balance, and "Hold Item(s)" always in the sticky
    // footer -- on a phone too.
    '<div class="drawer-backdrop" id="lw-form-backdrop"></div>' +
    '<div class="drawer" id="lw-form-drawer">' +
      '<div class="drawer-header"><h3>New Layaway</h3><button type="button" class="drawer-close" id="lw-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<div class="lw-steps" id="lw-steps" role="navigation" aria-label="Form parts">' +
          [['items', 'Items'], ['customer', 'Customer'], ['payment', 'Payment'], ['deadline', 'Deadline'], ['review', 'Review']].map(([k, l], i) => '<button type="button" data-step="' + k + '"><b>' + (i + 1) + '</b> ' + l + '</button>').join('') +
        '</div>' +
        '<p class="muted" style="margin-top:0;">Each item leaves the sellable pool immediately (moves to Reserved) but stays on hand until either completed as a sale or cancelled. Add more than one item to hold a whole order for one customer at once.</p>' +
        '<form id="lw-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="msg error" id="lw-form-err" role="alert" hidden></div>' +
          '<div class="drawer-section" id="lw-sec-items">' +
            '<h4>1 · Items</h4>' +
            '<div id="lw-items"></div>' +
            '<button type="button" class="btn small secondary" id="lw-add-item" style="align-self:flex-start;margin-top:-4px;">+ Add another item</button>' +
          '</div>' +
          '<div class="drawer-section" id="lw-sec-customer">' +
            '<h4>2 · Customer</h4>' +
            '<div class="field"><label>Order ID</label><input type="text" name="orderId"></div>' +
            // Defaults to today but editable -- lets staff backdate a hold that is only being encoded now for an item actually
            // held earlier (Ren, 2026-09-21).
            '<div class="field"><label>Date</label><input type="date" name="holdDate" value="' + localDateStr() + '"></div>' +
            '<div class="field"><label>Customer Name *</label><input type="text" name="customerName" required autocomplete="off"></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber" autocomplete="off" inputmode="tel"></div>' +
            '<div class="field"><label>Alternative Contact Number (optional)</label><input type="text" name="altContactNumber" autocomplete="off" inputmode="tel"></div>' +
          '</div>' +
          '<div class="drawer-section" id="lw-sec-payment">' +
            '<h4>3 · Payment</h4>' +
            '<div id="lw-pay-box">' + paymentRowsHtml({ recorder: employee.full_name || 'you', hint: 'Leave the amount blank if the customer is not paying anything yet. Split it across methods if they paid in more than one way; each line can carry its own reference and proof.' }) + '</div>' +
            '<div class="field" style="margin-top:8px;"><label>Payment Notes (optional)</label><input type="text" name="paymentNotes"></div>' +
          '</div>' +
          '<div class="drawer-section" id="lw-sec-deadline">' +
            '<h4>4 · Deadline</h4>' +
            '<div class="field"><label>Forfeit Date (optional)</label><input type="date" name="forfeitDate"></div>' +
            '<div class="muted" id="lw-deadline-note" style="font-size:12px;"></div>' +
          '</div>' +
          '<div class="drawer-section" id="lw-sec-review">' +
            '<h4>5 · Review</h4>' +
            '<div id="lw-review"></div>' +
            '<div class="field" style="margin-top:8px;"><label>Admin (Handled By)</label><select name="handledBy"><option value="">— none —</option>' +
              staff.map((s) => '<option value="' + s.id + '"' + (s.id === employee.id ? ' selected' : '') + '>' + esc(s.full_name) + '</option>').join('') +
            '</select></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="lw-form" id="lw-form-submit">Hold Item(s)</button>' +
        '<button type="button" class="btn secondary" id="lw-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +

    // Detail Drawer -- one shared instance, its body/title replaced per record each time openDetail() is called (Ren's UI
    // redesign pilot, section 204).
    '<div class="drawer-backdrop" id="lw-detail-backdrop"></div>' +
    '<div class="drawer" id="lw-detail-drawer">' +
      '<div class="drawer-header"><h3 id="lw-detail-title">Layaway Details</h3><button type="button" class="drawer-close" id="lw-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="lw-detail-body"></div>' +
    '</div>';

  const $ = (id) => document.getElementById(id);
  const searchText = () => ($('lw-f-search').value || '').trim().toLowerCase();
  /** The page's date range as { from, to, label } -- empty strings for "All Time". */
  const rangeNow = () => { const r = getRange ? getRange() : null; return r && r.preset !== 'all' ? { from: r.from, to: r.to, label: r.label } : { from: '', to: '', label: '' }; };
  /** Is this date / timestamp inside the page's date range (Manila days)? */
  const inRange = (d) => { const r = rangeNow(); if (!r.from) return true; const x = d ? manilaDateStr(d) : ''; return !!x && x >= r.from && x <= r.to; };

  // ---- Item rows: one or more SKU/Qty/Price lines under the same order, each with
  // its own autocomplete instance (same pattern as movement.html/branches.html's POS
  // cart). ----
  function itemRowHtml() {
    return '<div class="lw-item-row" style="border:1px solid #e5e5e5;border-radius:8px;padding:8px;margin-bottom:6px;">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="flex:2;min-width:150px;position:relative;">' +
          '<label>SKU *</label>' +
          '<input type="text" class="lw-item-sku" autocomplete="off" placeholder="Type a SKU or item name…">' +
          '<div class="lw-item-sku-name muted" style="font-size:11px;"></div>' +
          '<div class="lw-item-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:20;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;"></div>' +
        '</div>' +
        '<div class="field" style="width:70px;"><label>Qty</label><input type="number" class="lw-item-qty" min="1" value="1"></div>' +
        '<div class="field" style="width:110px;"><label>Unit Price</label><input type="number" class="lw-item-price" step="0.01" min="0" placeholder="PHP"></div>' +
        '<div class="field" style="width:130px;"><label>Stock Status</label><select class="lw-item-stock"><option value="In Stock">In Stock</option><option value="Lacking">Lacking (source later)</option></select></div>' +
        '<button type="button" class="btn small secondary lw-item-remove" title="Remove this item">✕</button>' +
      '</div>' +
    '</div>';
  }
  // Correct a mistake on an On Hold layaway (Admin/Manager/Branch Supervisor only,
  // matching edit_layaway_hold's own server-side gate) -- hidden by default, toggled
  // open by the row's "Edit" button. Reuses the exact same .lw-item-sku/-suggest/-name
  // class names as itemRowHtml() so attachSkuAutocomplete() works on it unmodified.
  function editHoldFormHtml(h) {
    // Completed: SKU/Qty/Price are locked (that stock already left "reserved" and
    // became an actual sale -- changing them here can't be reflected back into it),
    // so only Admin/Auditor even reach this form at all (canEditCompletedDetails,
    // gating the Completed-only Edit Details section that calls this), and even they
    // can only correct the surrounding details, not these three (Ren, 2026-09-25:
    // "give access auditor/glenn to edit completed details"). Disabled
    // rather than removed so the field still shows its real value; edit_layaway_hold()
    // enforces the same lock server-side regardless.
    const locked = h.status === 'Completed';
    return '<div class="lw-edit-form" data-hold-id="' + h.id + '" style="display:none;border:1px solid #e5e5e5;border-radius:8px;padding:8px;margin-top:6px;background:#fafafa;">' +
      (locked ? '<p class="muted" style="margin:0 0 6px;">Completed — SKU, Qty, and Unit Price are locked. Only the details below can be corrected.</p>' : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="flex:2;min-width:150px;position:relative;">' +
          '<label>SKU *</label>' +
          '<input type="text" class="lw-item-sku" name="sku" autocomplete="off" value="' + esc(h.sku) + '"' + (locked ? ' disabled' : '') + '>' +
          '<div class="lw-item-sku-name muted" style="font-size:11px;"></div>' +
          '<div class="lw-item-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:20;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;"></div>' +
        '</div>' +
        '<div class="field" style="width:70px;"><label>Qty</label><input type="number" name="qty" min="1" value="' + h.qty + '"' + (locked ? ' disabled' : '') + '></div>' +
        '<div class="field" style="width:110px;"><label>Unit Price</label><input type="number" class="lw-item-price" name="unitPrice" step="0.01" min="0" value="' + (h.unit_price ?? '') + '"' + (locked ? ' disabled' : '') + '></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:6px;">' +
        '<div class="field" style="flex:1;min-width:120px;"><label>Customer Name *</label><input type="text" name="customerName" value="' + esc(h.customer_name) + '"></div>' +
        '<div class="field" style="width:120px;"><label>Contact Number</label><input type="text" name="contactNumber" value="' + esc(h.contact_number || '') + '"></div>' +
        '<div class="field" style="width:120px;"><label>Order ID</label><input type="text" name="orderId" value="' + esc(h.order_id || '') + '"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:6px;"><label>Notes</label><input type="text" name="notes" value="' + esc(h.notes || '') + '"></div>' +
      // Reason required when Amount or Qty actually changes (Ren's spec section
      // 126) -- enforced again server-side by edit_layaway_hold() regardless. Moot on
      // a Completed hold (those fields are disabled so they can never actually
      // change), but harmless to still show.
      (locked ? '' : '<div class="field" style="margin-top:6px;"><label>Reason (required if amount/qty changes)</label><input type="text" name="reason"></div>') +
      '<div style="display:flex;gap:4px;margin-top:6px;">' +
        '<button type="button" class="btn small" data-act="save-edit-hold" data-id="' + h.id + '">Save</button>' +
        '<button type="button" class="btn small secondary" data-act="close-edit-hold" data-id="' + h.id + '">Cancel</button>' +
      '</div>' +
    '</div>';
  }
  function attachSkuAutocomplete(row) {
    // Idempotent: addItemRow() only ever calls this on a freshly-created node, but the
    // edit-hold form is a persistent node re-shown (not re-created) on every "Edit"
    // click -- without this guard, repeated open/close cycles would stack duplicate
    // input/blur/focus listeners on the same SKU field.
    if (row.dataset.skuAutocompleteAttached) return;
    row.dataset.skuAutocompleteAttached = '1';
    const skuInput = row.querySelector('.lw-item-sku');
    const skuSuggest = row.querySelector('.lw-item-sku-suggest');
    const skuNamePreview = row.querySelector('.lw-item-sku-name');
    let searchToken = 0, searchTimer = null;
    function hide() { skuSuggest.style.display = 'none'; skuSuggest.innerHTML = ''; }
    function pick(p) {
      skuInput.value = p.sku;
      skuNamePreview.textContent = p.item_name + (p.category || p.product_line ? ' · ' + (p.category || p.product_line) : '');
      // Auto-fills Unit Price for a Per Gram SKU (rate x weight) so the row's Total
      // (qty x Unit Price) comes out right without staff computing it by hand -- still
      // just a starting point, the field stays editable same as any other item.
      const priceInput = row.querySelector('.lw-item-price');
      const price = effectivePrice(p);
      if (priceInput && p.pricing_mode === 'Per Gram' && price != null) priceInput.value = price.toFixed(2);
      hide();
    }
    function renderSuggestions(matches) {
      if (!matches.length) { hide(); return; }
      skuSuggest.innerHTML = matches.map((p) =>
        '<div data-sku="' + esc(p.sku) + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px;">' +
          '<strong>' + esc(p.sku) + '</strong> — ' + esc(p.item_name) +
          (p.category || p.product_line ? '<div class="muted" style="font-size:11px;">' + esc(p.category || p.product_line) + '</div>' : '') +
        '</div>'
      ).join('');
      skuSuggest.style.display = '';
      skuSuggest.querySelectorAll('[data-sku]').forEach((el, i) => {
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(matches[i]); });
      });
    }
    skuInput.addEventListener('input', () => {
      skuNamePreview.textContent = '';
      const q = skuInput.value.trim();
      clearTimeout(searchTimer);
      if (!q) { hide(); return; }
      searchTimer = setTimeout(async () => {
        const token = ++searchToken;
        try {
          const results = await searchProducts(q);
          if (token !== searchToken) return;
          renderSuggestions(results);
          const exact = results.find((p) => p.sku.toLowerCase() === q.toLowerCase());
          if (exact) skuNamePreview.textContent = exact.item_name + (exact.category || exact.product_line ? ' · ' + (exact.category || exact.product_line) : '');
        } catch (err) { /* a failed lookup shouldn't block typing a SKU by hand */ }
      }, 200);
    });
    skuInput.addEventListener('blur', () => setTimeout(hide, 150));
    skuInput.addEventListener('focus', () => { if (skuSuggest.innerHTML) skuSuggest.style.display = ''; });
  }
  const itemsContainer = document.getElementById('lw-items');
  function updateItemRemoveButtons() {
    const rows = itemsContainer.querySelectorAll('.lw-item-row');
    rows.forEach((row) => { row.querySelector('.lw-item-remove').style.display = rows.length > 1 ? '' : 'none'; });
  }
  function addItemRow() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = itemRowHtml();
    const row = wrapper.firstElementChild;
    itemsContainer.appendChild(row);
    attachSkuAutocomplete(row);
    row.querySelector('.lw-item-remove').addEventListener('click', () => {
      if (itemsContainer.querySelectorAll('.lw-item-row').length <= 1) return;
      row.remove();
      updateItemRemoveButtons();
    });
    updateItemRemoveButtons();
  }
  function resetItemRows() { itemsContainer.innerHTML = ''; addItemRow(); }
  addItemRow();
  document.getElementById('lw-add-item').addEventListener('click', addItemRow);

  // ---- New Layaway form: the shared payment rows, the running order total / downpayment / balance, step shortcuts ----
  const lwForm = $('lw-form');
  let pay = null; // assigned right after mounting (the component calls onChange once while it mounts)

  /** The order as typed so far: items with a SKU, and the total of those that have a price (qty x unit price). */
  function orderTotals() {
    let total = 0, rows = 0, priced = 0;
    itemsContainer.querySelectorAll('.lw-item-row').forEach((row) => {
      if (!row.querySelector('.lw-item-sku').value.trim()) return;
      rows++;
      const price = row.querySelector('.lw-item-price').value;
      if (price !== '') { priced++; total += Number(price) * (Number(row.querySelector('.lw-item-qty').value) || 0); }
    });
    return { total: Math.round(total * 100) / 100, rows, priced };
  }
  function updateReview() {
    const o = orderTotals();
    const paying = pay ? pay.total() : 0;
    const holdDate = lwForm.elements.holdDate.value || localDateStr();
    const forfeit = lwForm.elements.forfeitDate.value;
    const deadline = forfeit || layawayDeadline(null, holdDate);
    const kv = (k, v) => '<div class="drawer-kv"><span>' + k + '</span><b>' + v + '</b></div>';
    $('lw-review').innerHTML =
      kv('Items', o.rows) +
      kv('Order total', o.priced ? money(o.total) + (o.priced < o.rows ? ' <span class="muted">(' + (o.rows - o.priced) + ' without a price)</span>' : '') : '—') +
      kv('Downpayment', money(paying)) +
      kv('Remaining balance', o.priced ? money(Math.max(o.total - paying, 0)) : '—') +
      kv('Deadline', fmtDate(deadline));
    $('lw-deadline-note').textContent = forfeit ? 'Forfeit date set by hand.' : 'Default: ' + getOpsConfig().forfeitMonths + ' months after the layaway date (' + fmtDate(deadline) + ').';
  }
  pay = mountPaymentRows($('lw-pay-box'), {
    getDue: () => orderTotals().total, getMinDate: () => lwForm.elements.holdDate.value || '', minDateLabel: 'layaway date', dueLabel: 'Order total',
    emptyText: 'Add the items and their prices to see the order total.', followDue: false, onChange: updateReview,
  });
  pay.setDefaultDate(lwForm.elements.holdDate.value);
  // Whenever an item, a price or a payment changes: the payment summary (what is owed) and the review box are redrawn.
  const refreshOrder = () => { if (pay) pay.sync(); updateReview(); };
  lwForm.addEventListener('input', refreshOrder);
  lwForm.addEventListener('change', refreshOrder);
  itemsContainer.addEventListener('click', () => setTimeout(refreshOrder, 0)); // an item row was removed
  $('lw-add-item').addEventListener('click', () => setTimeout(refreshOrder, 0));
  lwForm.elements.holdDate.addEventListener('change', () => pay.setDefaultDate(lwForm.elements.holdDate.value));
  // Pick a customer already on file instead of typing them again (the same person ends up spelled the same everywhere).
  attachCustomerPicker({ nameInput: lwForm.elements.customerName, contactInput: lwForm.elements.contactNumber });
  $('lw-steps').querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => $('lw-sec-' + b.dataset.step).scrollIntoView({ behavior: 'smooth', block: 'start' })));
  /** Back to a blank form (after a save). */
  function resetNewForm() {
    lwForm.reset();
    $('lw-form-err').hidden = true;
    resetItemRows();
    pay.reset();
    pay.setDefaultDate(lwForm.elements.holdDate.value);
    updateReview();
  }

  // Generic open/close for the Form Drawer.
  function openFormDrawer() {
    $('lw-form-err').hidden = true;
    updateReview();
    document.getElementById('lw-form-backdrop').classList.add('open');
    document.getElementById('lw-form-drawer').classList.add('open');
  }
  function closeFormDrawer() {
    document.getElementById('lw-form-backdrop').classList.remove('open');
    document.getElementById('lw-form-drawer').classList.remove('open');
  }
  document.getElementById('lw-new-btn').addEventListener('click', openFormDrawer);
  document.getElementById('lw-form-close').addEventListener('click', closeFormDrawer);
  document.getElementById('lw-form-cancel').addEventListener('click', closeFormDrawer);
  document.getElementById('lw-form-backdrop').addEventListener('click', closeFormDrawer);

  // Detail Drawer -- body content is rebuilt fresh by renderDetailBody()/
  // wireDetailBody() every time a specific hold's "View Details" is clicked (see
  // renderHoldTable() below), not a static block like the form drawer above.
  function closeDetailDrawer() {
    document.getElementById('lw-detail-backdrop').classList.remove('open');
    document.getElementById('lw-detail-drawer').classList.remove('open');
  }
  document.getElementById('lw-detail-close').addEventListener('click', closeDetailDrawer);
  document.getElementById('lw-detail-backdrop').addEventListener('click', closeDetailDrawer);
  function openDetail(holdId) {
    const h = allHolds.find((x) => x.id === holdId);
    if (!h) return false; // not in the loaded branch -- the host may switch branch and retry
    // .textContent escapes on its own -- esc() here would double-escape (e.g. an
    // actual "&" in a customer's name showing up literally as "&amp;").
    document.getElementById('lw-detail-title').textContent = h.customer_name + ' — ' + h.sku;
    const body = document.getElementById('lw-detail-body');
    body.innerHTML = renderDetailBody(h);
    wireDetailBody(body, h);
    document.getElementById('lw-detail-backdrop').classList.add('open');
    document.getElementById('lw-detail-drawer').classList.add('open');
    return true;
  }
  // Called after any action taken from inside the detail drawer -- keeps it open with
  // fresh data if the hold still exists (e.g. a payment was just added), or closes it
  // if the action removed the hold from view entirely (deleted, or moved to a
  // folder the drawer has no reason to track further).
  function refreshDetailIfOpen(holdId) {
    if (!document.getElementById('lw-detail-drawer').classList.contains('open')) return;
    const h = allHolds.find((x) => x.id === holdId);
    if (!h) { closeDetailDrawer(); return; }
    openDetail(holdId);
  }

  function readItemRows() {
    const items = [];
    itemsContainer.querySelectorAll('.lw-item-row').forEach((row) => {
      const sku = row.querySelector('.lw-item-sku').value.trim();
      if (!sku) return;
      const qty = Number(row.querySelector('.lw-item-qty').value || 0);
      const priceVal = row.querySelector('.lw-item-price').value;
      const stockStatus = row.querySelector('.lw-item-stock').value;
      items.push({ sku, qty, unitPrice: priceVal ? Number(priceVal) : null, stockStatus, row });
    });
    return items;
  }

  document.getElementById('lw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const branchId = getBranchId();
    // The submit button lives in .drawer-footer (form="lw-form"), outside this <form> element's own DOM subtree, so it is
    // reached by its own id -- f.querySelector() here would always return null.
    const btn = document.getElementById('lw-form-submit');
    const errBox = document.getElementById('lw-form-err');
    errBox.hidden = true;
    // A problem is shown in the drawer itself, at the top of the form, and the field is pointed at -- a toast behind the
    // drawer is easy to miss on a phone.
    const formErr = (msg, el) => { errBox.textContent = friendlyError(msg); errBox.hidden = false; errBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); if (el) flagInvalid(el); };
    const items = readItemRows();
    if (!items.length) return void formErr('Add at least one item (SKU) to hold.', itemsContainer.querySelector('.lw-item-row .lw-item-sku'));
    const badQty = items.find((it) => !it.qty || it.qty <= 0);
    if (badQty) return void formErr('Qty must be a positive number for ' + badQty.sku + '.', badQty.row.querySelector('.lw-item-qty'));
    // The downpayment rows are checked BEFORE anything is held, so a typo in them never leaves a hold with no payment behind it.
    const got = pay.read();
    if (got.error) return void formErr(got.error, got.el);
    const payments = got.payments;

    btn.disabled = true;
    // Multiple items are separate reservations under the hood (one layaway_holds row each), tied together by a shared
    // group_id so they display and act as one order.
    const groupId = items.length > 1 ? crypto.randomUUID() : null;
    const created = [];
    try {
      for (const it of items) {
        const holdId = await createLayawayHold({
          sku: it.sku, branchId, qty: it.qty,
          customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(), altContactNumber: f.altContactNumber.value.trim(),
          unitPrice: it.unitPrice, notes: f.notes.value.trim(),
          orderId: f.orderId.value.trim(), handledBy: f.handledBy.value || null, groupId,
          stockStatus: it.stockStatus, forfeitDate: f.forfeitDate.value || null, holdDate: f.holdDate.value || null,
        });
        created.push({ holdId, totalPrice: it.unitPrice != null ? it.unitPrice * it.qty : null });
      }
    } catch (holdErr) {
      // A later item failing (e.g. out of stock) shouldn't leave earlier items in this same submission silently held with
      // nothing to show for it -- undo them too.
      for (const h of created) { try { await cancelLayaway(h.holdId, 'Rolled back: a later item in the same submission failed'); } catch (e) {} }
      formErr(String(holdErr.message || holdErr));
      btn.disabled = false;
      return;
    }

    try {
      const grandTotal = created.reduce((s, h) => s + (h.totalPrice || 0), 0);
      const canProportion = created.length > 1 && grandTotal > 0 && created.every((h) => h.totalPrice != null);
      for (const p of payments) {
        // Uploaded once per row even when the payment is split below -- it's proof of the one transaction that happened, just
        // recorded against more than one item's hold for bookkeeping.
        const attachmentPath = p.file ? await uploadLayawayPaymentProof(branchId, created[0].holdId, p.file) : null;
        if (!canProportion) {
          await addLayawayPayment(created[0].holdId, p.amount, p.method, p.reference, attachmentPath, p.paidAt || f.holdDate.value || null, f.paymentNotes.value.trim());
          continue;
        }
        // Split one shared downpayment across each item's own hold, proportional to its share of the order total; the last
        // item absorbs any rounding remainder so the recorded payments always add back up to exactly what was entered.
        let allocated = 0;
        for (let i = 0; i < created.length; i++) {
          const h = created[i];
          const isLast = i === created.length - 1;
          const share = isLast ? Math.round((p.amount - allocated) * 100) / 100 : Math.round((p.amount * h.totalPrice / grandTotal) * 100) / 100;
          if (!isLast) allocated += share;
          if (share > 0) await addLayawayPayment(h.holdId, share, p.method, p.reference, attachmentPath, p.paidAt || f.holdDate.value || null, f.paymentNotes.value.trim());
        }
      }
    } catch (payErr) {
      notify(items.length + ' item(s) held, but recording payment failed: ' + (payErr.message || payErr) + '. Add it from the item\'s own View Details.', true);
      resetNewForm();
      btn.disabled = false;
      closeFormDrawer();
      await load();
      return;
    }

    notify(items.length + ' item(s) held' + (payments.length ? ' with ' + payments.length + ' payment(s) recorded.' : '.'), false);
    resetNewForm();
    btn.disabled = false;
    closeFormDrawer();
    await load();
  });

  let allHolds = [];
  let groupMembers = {};
  let pendingForfeitRequests = []; // every Pending row this employee can see (RLS: all for Admin/Manager, own for anyone else)
  let pendingItemChangeRequests = []; // every Pending row this employee can see (RLS: all for a Supervisor/Admin/Manager, own for anyone else)
  let pendingPaymentDeletionRequests = []; // every Pending row this employee can see (RLS: all for a Supervisor/Admin/Manager, own for anyone else)
  let pendingHoldDeletionRequests = []; // every Pending/Supervisor Approved row this employee can see (RLS: all for a Supervisor/Admin/Manager, own for anyone else)
  let forfeitRequests = [];   // forfeiture requests (any status) for this branch's holds, newest first
  let openForfeitByHold = {}; // hold id -> its Pending / Supervisor Approved forfeiture request
  let remindQueue = [];       // orders in the reminder window, due ones first (layaway_reminder_queue)
  let remindShowAll = false;  // also list orders that were contacted recently and are not due yet
  let peopleById = {};        // active employee names, for "who" labels
  let itemNames = {};         // sku -> item name (holds only keep the SKU)

  // Search and the date range come from the sticky bar on the Branches page (through the hidden search box above and the
  // hidden range inputs); these listeners just redraw whichever sub-tab is showing.
  const resetPages = () => [pgOnHold, pgPay, pgDue, pgDone, pgForf, pgCanc].forEach((p) => { p.page = 1; });
  $('lw-f-search').addEventListener('input', () => { resetPages(); renderActive(); });
  ['lw-f-status', 'lw-f-due', 'lw-f-pay', 'lw-f-by'].forEach((id) => $(id).addEventListener('change', () => { resetPages(); renderActive(); }));
  $('lw-f-clear').addEventListener('click', () => {
    ['lw-f-status', 'lw-f-due', 'lw-f-pay', 'lw-f-by'].forEach((id) => { $(id).value = 'all'; }); // search and dates belong to the sticky bar -- not cleared here
    resetPages(); renderActive();
  });
  wireSortControl('lw-sort-field', 'lw-sort-dir', sort, () => { resetPages(); renderActive(); });
  // The page fires 'change' on the first input of each pair when the global date range moves.
  ['mm-from', 'mm-to', 'mm-pay-f-from', 'mm-pay-f-to'].forEach((id) => $(id).addEventListener('change', () => { resetPages(); renderActive(); }));
  $('mm-clear').addEventListener('click', () => { $('mm-from').value = ''; $('mm-to').value = ''; renderMonthly(); });
  wireSortControl('mm-sort-field', 'mm-sort-dir', mmSort, renderMonthly);
  wireSortControl('mm-pay-sort-field', 'mm-pay-sort-dir', mmPaySort, () => { pgPay.page = 1; renderMonthlyPayments(); });
  wireSortControl('fw-sort-field', 'fw-sort-dir', fwSort, () => { pgDue.page = 1; renderForfeitureWatch(); });
  $('lw-due-filter').addEventListener('change', () => { dueFilter = $('lw-due-filter').value; pgDue.page = 1; renderForfeitureWatch(); });
  ['mm-pay-f-method', 'mm-pay-f-status', 'mm-pay-f-ref', 'mm-pay-f-recordedby'].forEach((id) => $(id).addEventListener('change', () => { pgPay.page = 1; renderMonthlyPayments(); }));
  $('mm-pay-f-clear').addEventListener('click', () => {
    ['mm-pay-f-method', 'mm-pay-f-status', 'mm-pay-f-ref', 'mm-pay-f-recordedby'].forEach((id) => { $(id).value = 'all'; }); // (search + dates are the page's)
    pgPay.page = 1; renderMonthlyPayments();
  });
  $('lw-quick').querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => setQuick(b.dataset.q)));

  // Folder helper for the approval queues: a queue is highlighted the moment something is waiting in it (Ren, 2026-10-07), and
  // the Requests tab shows the total.
  function requestsCount() {
    return pendingForfeitRequests.length + pendingItemChangeRequests.length + pendingPaymentDeletionRequests.length + pendingHoldDeletionRequests.length +
      forfeitRequests.filter((r) => r.status === 'Pending' || r.status === 'Supervisor Approved').length;
  }
  function setApprovalFolder(folderId, n) {
    const f = document.getElementById(folderId);
    if (!f) return;
    f.dataset.count = String(n);
    f.classList.toggle('has-pending', n > 0);
    const total = requestsCount();
    const tot = document.getElementById('lw-approvals-total');
    if (tot) { tot.textContent = total ? '(' + total + ' waiting)' : '(nothing waiting)'; tot.classList.toggle('lw-pending-flag', total > 0); }
    renderSubtabs();
  }

  async function load() {
    const list = document.getElementById('lw-list');
    if (!allHolds.length) list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const branchId = getBranchId();
      document.getElementById('lw-title').textContent = 'Layaway — ' + branchNameOf(branchId);
      // The lookups are independent -- run them together (they used to run one after another).
      const [holds, queue, freqs] = await Promise.all([
        listLayaways(branchId),
        getLayawayReminderQueue([branchId]).catch(() => []),
        listLayawayForfeitRequests().catch(() => []),
      ]);
      allHolds = holds;
      groupMembers = {};
      allHolds.forEach((h) => { if (h.group_id) (groupMembers[h.group_id] = groupMembers[h.group_id] || []).push(h); });
      Object.values(groupMembers).forEach((g) => g.sort((a, b) => a.id - b.id));
      const holdIds = new Set(allHolds.map((h) => h.id));
      forfeitRequests = freqs.filter((r) => holdIds.has(r.hold_id));
      openForfeitByHold = {};
      forfeitRequests.filter((r) => r.status === 'Pending' || r.status === 'Supervisor Approved').forEach((r) => { openForfeitByHold[r.hold_id] = r; });
      remindQueue = queue;
      itemNames = await getProductNames(allHolds.map((h) => h.sku)).catch(() => itemNames);
      // The approval queues are loaded every time (they feed the Requests count and Needs Attention) but only drawn when shown.
      await Promise.all([loadPendingForfeitRequests(), loadPendingItemChangeRequests(), loadPendingPaymentDeletionRequests(), loadPendingHoldDeletionRequests()]);
      renderPendingForfeitWorkflow();
      renderSubtabs();
      renderActive();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

  // Who-is-who for labels that are not embedded in a row (last reminder, change history).
  listActiveEmployees().then((people) => { peopleById = Object.fromEntries(people.map((p) => [p.id, p.full_name])); renderReminders(); }).catch(() => {});

  /** Only relevant while a hold can still be forfeited, so filtered down to this
   * branch's On Hold rows (allHolds is already scoped by getBranchId()) rather than
   * every request RLS would otherwise hand back (e.g. every branch's, for Admin). */
  async function loadPendingForfeitRequests() {
    try {
      const holdIds = new Set(allHolds.map((h) => h.id));
      pendingForfeitRequests = (await listLayawayForfeitDateRequests())
        .filter((r) => r.status === 'Pending' && holdIds.has(r.hold_id));
    } catch (err) {
      pendingForfeitRequests = [];
    }
    if (canFinalDelete) renderPendingForfeitRequests();
  }

  /** Same reasoning as loadPendingForfeitRequests() above -- filtered down to this
   * branch's holds rather than every request RLS would otherwise hand back. */
  async function loadPendingItemChangeRequests() {
    try {
      const holdIds = new Set(allHolds.map((h) => h.id));
      pendingItemChangeRequests = (await listLayawayItemChangeRequests())
        .filter((r) => r.status === 'Pending' && holdIds.has(r.hold_id));
    } catch (err) {
      pendingItemChangeRequests = [];
    }
    if (canApproveItemChange) renderPendingItemChangeRequests();
  }

  // One look for every approval card (Ren, 2026-10-07): type, order, customer, SKU, amount,
  // requested by, reason and date -- plus who already approved it -- then the actions.
  const holdOf = (id) => allHolds.find((x) => x.id === id) || {};
  function approvalCardHtml({ type, order, customer, sku, amount, requester, requestedAt, reason, detail, supervisor, awaitingFinal, actions }) {
    return '<div class="card lw-approval-card">' +
      '<div class="lw-approval-head"><span class="badge st-yellow">' + esc(type) + '</span>' +
        '<span class="muted" style="font-size:11px;">' + fmtDateTime(requestedAt) + '</span></div>' +
      '<div class="lw-approval-grid">' +
        '<div><span class="muted">Customer</span><b>' + esc(customer || '—') + '</b></div>' +
        '<div><span class="muted">Order</span><b>' + esc(order || '—') + '</b></div>' +
        '<div><span class="muted">SKU</span><b>' + esc(sku || '—') + '</b></div>' +
        (amount != null ? '<div><span class="muted">Amount</span><b>' + money(amount) + '</b></div>' : '') +
        '<div><span class="muted">Requested by</span><b>' + esc(requester || '—') + '</b></div>' +
      '</div>' +
      (detail ? '<div style="font-size:12px;margin-top:6px;">' + detail + '</div>' : '') +
      (reason ? '<div style="font-size:12px;margin-top:4px;"><span class="muted">Reason:</span> ' + esc(reason) + '</div>' : '') +
      (supervisor ? '<div class="muted" style="font-size:11px;margin-top:4px;">Supervisor approval: ' + esc(supervisor) + (awaitingFinal ? ' · final approval: waiting for Admin' : '') + '</div>' : '') +
      '<div class="lw-approval-actions">' + actions + '</div>' +
    '</div>';
  }
  const rejectDialog = (title) => reasonDialog({ title, message: 'Optional: tell the person why.', label: 'Reason', required: false, confirmLabel: 'Reject', danger: true });
  async function runAction(fn, okText, after) {
    try { await fn(); notify(okText, false); await (after ? after() : load()); }
    catch (err) { notify(String(err.message || err), true); }
  }

  function renderPendingForfeitRequests() {
    const countEl = document.getElementById('lw-pending-forfeit-count');
    const box = document.getElementById('lw-pending-forfeit-list');
    if (!countEl || !box) return; // not rendered at all for a non-Admin
    countEl.textContent = '(' + pendingForfeitRequests.length + ')';
    setApprovalFolder('lw-pending-forfeit-folder', pendingForfeitRequests.length);
    if (!pendingForfeitRequests.length) { box.innerHTML = '<p class="muted">No pending forfeit date requests.</p>'; return; }

    box.innerHTML = pendingForfeitRequests.map((r) => {
      const h = r.layaway_holds || {};
      return approvalCardHtml({
        type: 'Forfeit date change', order: holdOf(r.hold_id).order_id, customer: h.customer_name, sku: h.sku,
        requester: r.requester && r.requester.full_name, requestedAt: r.requested_at, reason: r.reason,
        detail: 'Forfeit Date: <span class="muted" style="text-decoration:line-through;">' + fmtDate(r.previous_date) + '</span> → <strong>' + fmtDate(r.proposed_date) + '</strong>',
        actions: '<button class="btn small" data-act="approve-forfeit-date" data-id="' + r.id + '">Approve</button>' +
                 '<button class="btn small secondary" data-act="reject-forfeit-date" data-id="' + r.id + '">Reject</button>',
      });
    }).join('');

    box.querySelectorAll('[data-act="approve-forfeit-date"]').forEach((btn) => btn.addEventListener('click', () =>
      runAction(() => approveLayawayForfeitDate(Number(btn.dataset.id)), 'Forfeit date approved.')));
    box.querySelectorAll('[data-act="reject-forfeit-date"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await rejectDialog('Reject this forfeit date change?');
      if (!out) return;
      await runAction(() => rejectLayawayForfeitDate(Number(btn.dataset.id), out.reason || null), 'Forfeit date request rejected.');
    }));
  }

  function renderPendingItemChangeRequests() {
    const countEl = document.getElementById('lw-pending-itemchange-count');
    const box = document.getElementById('lw-pending-itemchange-list');
    if (!countEl || !box) return; // not rendered at all for someone who can't approve
    countEl.textContent = '(' + pendingItemChangeRequests.length + ')';
    setApprovalFolder('lw-pending-itemchange-folder', pendingItemChangeRequests.length);
    if (!pendingItemChangeRequests.length) { box.innerHTML = '<p class="muted">No pending item change requests.</p>'; return; }

    box.innerHTML = pendingItemChangeRequests.map((r) => {
      const h = r.layaway_holds || {};
      return approvalCardHtml({
        type: 'Item change', order: holdOf(r.hold_id).order_id, customer: h.customer_name, sku: r.previous_sku,
        requester: r.requester && r.requester.full_name, requestedAt: r.requested_at, reason: r.reason,
        detail: 'Item: <span class="muted" style="text-decoration:line-through;">' + esc(r.previous_sku) + '</span> → <strong>' + esc(r.proposed_sku) + '</strong>',
        actions: '<button class="btn small" data-act="approve-item-change" data-id="' + r.id + '">Approve</button>' +
                 '<button class="btn small secondary" data-act="reject-item-change" data-id="' + r.id + '">Reject</button>',
      });
    }).join('');

    box.querySelectorAll('[data-act="approve-item-change"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Approve this item change?', message: 'The old item\'s reservation will be released and the new one reserved.', confirmLabel: 'Approve' })) return;
      await runAction(() => approveLayawayItemChange(Number(btn.dataset.id)), 'Item change approved.');
    }));
    box.querySelectorAll('[data-act="reject-item-change"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await rejectDialog('Reject this item change?');
      if (!out) return;
      await runAction(() => rejectLayawayItemChange(Number(btn.dataset.id), out.reason || null), 'Item change request rejected.', loadPendingItemChangeRequests);
    }));
  }

  /** Same reasoning as loadPendingItemChangeRequests() above -- filtered down to this
   * branch's holds. The payment itself may already be gone (deleted on approval), so
   * everything shown here comes from the request row's own snapshot fields, not a join
   * to layaway_payments. */
  async function loadPendingPaymentDeletionRequests() {
    try {
      const holdIds = new Set(allHolds.map((h) => h.id));
      pendingPaymentDeletionRequests = (await listLayawayPaymentDeletionRequests())
        .filter((r) => r.status === 'Pending' && holdIds.has(r.hold_id));
    } catch (err) {
      pendingPaymentDeletionRequests = [];
    }
    if (canApproveItemChange) renderPendingPaymentDeletionRequests();
  }

  function renderPendingPaymentDeletionRequests() {
    const countEl = document.getElementById('lw-pending-paymentdel-count');
    const box = document.getElementById('lw-pending-paymentdel-list');
    if (!countEl || !box) return; // not rendered at all for someone who can't approve
    countEl.textContent = '(' + pendingPaymentDeletionRequests.length + ')';
    setApprovalFolder('lw-pending-paymentdel-folder', pendingPaymentDeletionRequests.length);
    if (!pendingPaymentDeletionRequests.length) { box.innerHTML = '<p class="muted">No pending payment deletion requests.</p>'; return; }

    box.innerHTML = pendingPaymentDeletionRequests.map((r) => {
      const h = r.layaway_holds || {};
      return approvalCardHtml({
        type: 'Payment deletion', order: holdOf(r.hold_id).order_id, customer: h.customer_name, sku: holdOf(r.hold_id).sku, amount: r.payment_amount,
        requester: r.requester && r.requester.full_name, requestedAt: r.requested_at, reason: r.reason,
        detail: 'Payment: <strong>' + money(r.payment_amount) + '</strong> via ' + esc(r.payment_method) + (r.payment_reference ? ' (Ref: ' + esc(r.payment_reference) + ')' : ''),
        actions: '<button class="btn small" data-act="approve-payment-del" data-id="' + r.id + '">Approve</button>' +
                 '<button class="btn small secondary" data-act="reject-payment-del" data-id="' + r.id + '">Reject</button>',
      });
    }).join('');

    box.querySelectorAll('[data-act="approve-payment-del"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Approve this payment deletion?', message: 'This permanently removes the payment record.', confirmLabel: 'Approve and delete', danger: true })) return;
      await runAction(() => approveLayawayPaymentDeletion(Number(btn.dataset.id)), 'Payment deletion approved.');
    }));
    box.querySelectorAll('[data-act="reject-payment-del"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await rejectDialog('Reject this payment deletion?');
      if (!out) return;
      await runAction(() => rejectLayawayPaymentDeletion(Number(btn.dataset.id), out.reason || null), 'Payment deletion request rejected.', loadPendingPaymentDeletionRequests);
    }));
  }

  /** Same reasoning as loadPendingPaymentDeletionRequests() above -- filtered down to
   * this branch's holds, from the request's own snapshot fields (the hold is gone once
   * a request is fully Approved). Covers BOTH stages (Pending and Supervisor Approved)
   * so the same folder shows the whole queue at every point in its lifecycle. */
  async function loadPendingHoldDeletionRequests() {
    try {
      const holdIds = new Set(allHolds.map((h) => h.id));
      pendingHoldDeletionRequests = (await listLayawayHoldDeletionRequests())
        .filter((r) => (r.status === 'Pending' || r.status === 'Supervisor Approved') && holdIds.has(r.hold_id));
    } catch (err) {
      pendingHoldDeletionRequests = [];
    }
    if (canApproveItemChange) renderPendingHoldDeletionRequests();
  }

  function renderPendingHoldDeletionRequests() {
    const countEl = document.getElementById('lw-pending-holddel-count');
    const box = document.getElementById('lw-pending-holddel-list');
    if (!countEl || !box) return; // not rendered at all for someone who can't approve
    countEl.textContent = '(' + pendingHoldDeletionRequests.length + ')';
    setApprovalFolder('lw-pending-holddel-folder', pendingHoldDeletionRequests.length);
    if (!pendingHoldDeletionRequests.length) { box.innerHTML = '<p class="muted">No pending layaway deletion requests.</p>'; return; }

    box.innerHTML = pendingHoldDeletionRequests.map((r) => {
      const awaitingFinal = r.status === 'Supervisor Approved';
      return approvalCardHtml({
        type: 'Layaway deletion', order: r.hold_order_id, customer: r.hold_customer_name, sku: r.hold_sku, amount: r.hold_total_price,
        requester: r.requester && r.requester.full_name, requestedAt: r.requested_at, reason: r.reason,
        detail: r.hold_status === 'Completed' ? '<span class="badge" style="background:#ffe0e0;color:#a00;">Undoes a COMPLETED sale</span>' : '',
        supervisor: awaitingFinal ? (r.supervisorApprover ? r.supervisorApprover.full_name : 'approved') : '', awaitingFinal,
        actions: (!awaitingFinal
            ? '<button class="btn small" data-act="approve-hold-del-stage1" data-id="' + r.id + '">Approve</button>'
            : (canFinalDelete ? '<button class="btn small" data-act="approve-hold-del-final" data-id="' + r.id + '">Final Approve</button>' : '')) +
          (!awaitingFinal || canFinalDelete ? '<button class="btn small secondary" data-act="reject-hold-del" data-id="' + r.id + '">Reject</button>' : ''),
      });
    }).join('');

    box.querySelectorAll('[data-act="approve-hold-del-stage1"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Approve for final review?', message: 'An Admin still needs to give final approval before anything is deleted.', confirmLabel: 'Approve' })) return;
      await runAction(() => approveLayawayHoldDeletionStage1(Number(btn.dataset.id)), 'Approved -- awaiting final Admin approval.');
    }));
    box.querySelectorAll('[data-act="approve-hold-del-final"]').forEach((btn) => btn.addEventListener('click', async () => {
      const row = pendingHoldDeletionRequests.find((r) => r.id === Number(btn.dataset.id));
      const msg = row && row.hold_status === 'Completed'
        ? 'This permanently deletes this COMPLETED sale -- removes its payment history and restores the stock it sold. This cannot be undone.'
        : 'This permanently deletes the layaway. This cannot be undone.';
      if (!await confirmDialog({ title: 'Final approve this deletion?', message: msg, confirmLabel: 'Delete permanently', danger: true })) return;
      await runAction(() => approveLayawayHoldDeletionFinal(Number(btn.dataset.id)), 'Layaway deleted.', async () => { await load(); closeDetailDrawer(); });
    }));
    box.querySelectorAll('[data-act="reject-hold-del"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await rejectDialog('Reject this deletion request?');
      if (!out) return;
      await runAction(() => rejectLayawayHoldDeletion(Number(btn.dataset.id), out.reason || null), 'Deletion request rejected.', loadPendingHoldDeletionRequests);
    }));
  }

  // Forfeiture requests (Ren, 2026-10-07): Request -> Supervisor approval -> Admin final
  // forfeit. Nothing is ever forfeited automatically.
  function renderPendingForfeitWorkflow() {
    const countEl = document.getElementById('lw-pending-forfeitreq-count');
    const box = document.getElementById('lw-pending-forfeitreq-list');
    if (!countEl || !box) return; // not rendered for someone who cannot approve
    const open = forfeitRequests.filter((r) => r.status === 'Pending' || r.status === 'Supervisor Approved');
    countEl.textContent = '(' + open.length + ')';
    setApprovalFolder('lw-pending-forfeitreq-folder', open.length);
    if (!open.length) { box.innerHTML = '<p class="muted">No pending forfeiture requests.</p>'; return; }

    box.innerHTML = open.map((r) => {
      const awaitingFinal = r.status === 'Supervisor Approved';
      const mine = r.requested_by === employee.id;
      const canStage1 = !awaitingFinal && canApproveItemChange && (!mine || canFinalDelete);
      const canReject = (!awaitingFinal && canApproveItemChange) || (awaitingFinal && canFinalDelete);
      return approvalCardHtml({
        type: 'Forfeiture', order: r.hold_order_id, customer: r.hold_customer_name, sku: r.hold_sku,
        amount: r.hold_total_price != null ? Math.max(Number(r.hold_total_price) - Number(r.hold_paid || 0), 0) : null,
        requester: r.requester && r.requester.full_name, requestedAt: r.requested_at, reason: r.reason,
        detail: 'Deadline was <b>' + fmtDate(r.deadline) + '</b> · paid ' + money(r.hold_paid) + ' of ' + money(r.hold_total_price) + ' <span class="muted">(amount shown = still owed)</span>',
        supervisor: awaitingFinal ? (r.supervisorApprover ? r.supervisorApprover.full_name : 'approved') : '', awaitingFinal,
        actions: (canStage1 ? '<button class="btn small" data-act="ff-stage1" data-id="' + r.id + '">Approve</button>' : '') +
          (canFinalDelete ? '<button class="btn small" data-act="ff-final" data-id="' + r.id + '">Final Forfeit</button>' : '') +
          (canReject ? '<button class="btn small secondary" data-act="ff-reject" data-id="' + r.id + '">Reject</button>' : '') +
          (mine || canFinalDelete ? '<button class="btn small secondary" data-act="ff-withdraw" data-id="' + r.id + '">Withdraw</button>' : '') +
          '<button class="btn small secondary" data-act="ff-view" data-hold="' + r.hold_id + '">View Layaway</button>',
      });
    }).join('');

    box.querySelectorAll('[data-act="ff-view"]').forEach((btn) => btn.addEventListener('click', () => openDetail(Number(btn.dataset.hold))));
    box.querySelectorAll('[data-act="ff-stage1"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Approve this forfeiture?', message: 'An Admin still gives the final approval before the item is forfeited.', confirmLabel: 'Approve' })) return;
      await runAction(() => approveLayawayForfeitStage1(Number(btn.dataset.id)), 'Approved -- awaiting final Admin approval.');
    }));
    box.querySelectorAll('[data-act="ff-final"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Forfeit this layaway?', message: 'The customer loses the item: it is marked Forfeited and goes back to available stock. Payments already made stay on record.', confirmLabel: 'Forfeit', danger: true })) return;
      await runAction(() => approveLayawayForfeitFinal(Number(btn.dataset.id)), 'Layaway forfeited.');
    }));
    box.querySelectorAll('[data-act="ff-reject"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await rejectDialog('Reject this forfeiture request?');
      if (!out) return;
      await runAction(() => rejectLayawayForfeit(Number(btn.dataset.id), out.reason || null), 'Forfeiture request rejected.');
    }));
    box.querySelectorAll('[data-act="ff-withdraw"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Withdraw this request?', message: 'The layaway goes back to being overdue, with no forfeiture request.', confirmLabel: 'Withdraw' })) return;
      await runAction(() => cancelLayawayForfeitRequest(Number(btn.dataset.id)), 'Request withdrawn.');
    }));
  }

  function paidSoFar(h) { return (h.layaway_payments || []).reduce((s, p) => s + Number(p.amount), 0); }

  // Ren's spec section 1: an explicit "Payment Status" per payment line. There's no
  // stored status column -- a payment is always a completed fact once saved (no
  // draft/void state exists) -- so this is computed from the running total against
  // the hold's total_price, keyed by payment id so callers can look it up per row.
  function paymentStatusFor(payments, totalPrice) {
    const sorted = payments.slice().sort((a, b) => (a.paid_at || '').localeCompare(b.paid_at || '') || a.id - b.id);
    let running = 0;
    const byId = {};
    sorted.forEach((p, idx) => {
      running += Number(p.amount);
      byId[p.id] = (totalPrice != null && running >= Number(totalPrice) - 0.01)
        ? 'Paid in Full'
        : (idx === 0 ? 'Downpayment' : 'Partial');
    });
    return byId;
  }

  // Status, % paid, deadline and the "45 days left" / "OVERDUE 2 DAYS" text for one hold --
  // the single place every list/drawer/report on this tab gets them (js/layawayStatus.js).
  const infoOf = (h) => layawayInfo(h, { openForfeitRequest: !!openForfeitByHold[h.id] });
  const branchNameOf = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  function customerLinkHtml(name, contact) {
    return '<button type="button" class="lw-cust-link" data-cust-name="' + esc(name) + '" data-cust-contact="' + esc(contact || '') + '" title="See this customer\'s layaway history">' + esc(name) + '</button>';
  }
  /** Any customer name rendered with customerLinkHtml() inside `scope` opens the history drawer. */
  function wireCustomerLinks(scope) {
    scope.querySelectorAll('.lw-cust-link').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCustomerHistory({ name: b.dataset.custName, contact: b.dataset.custContact, esc, branchName: branchNameOf });
    }));
  }
  const daysClass = (info) => 'lw-days ' + (info.daysTone || '');

  // ---- Reminders (Ren, 2026-10-07): the message to send, and a log of who was contacted.
  // Nothing is ever sent from here -- "Copy Message" only copies text, "Mark Contacted" only
  // records that a person did the contacting. ----
  function fillTemplate(o) {
    const bal = Number(o.balance || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return getOpsConfig().reminderTemplate
      .replace(/\[Customer Name\]/g, o.customer_name || '')
      .replace(/\[Order\]/g, o.order_ids || ('#' + o.first_hold_id))
      .replace(/\[Balance\]/g, bal)
      .replace(/\[Date\]/g, fmtDate(o.deadline));
  }
  /** Same stage rule as layaway_reminder_queue(): -1 once overdue, else the tightest configured stage reached. */
  function reminderStageFor(days) {
    if (days < 0) return -1;
    const stages = getOpsConfig().reminderStages.slice().sort((a, b) => a - b);
    const hit = stages.find((s) => days <= s);
    return hit === undefined ? Math.max(0, Math.min(days, 365)) : hit;
  }
  /** One reminder-queue-shaped row for any hold (its whole order, if it is part of a multi-item hold). */
  function orderRowFor(h) {
    const members = (h.group_id ? groupMembers[h.group_id] : null) || [h];
    const live = members.filter((m) => m.status === 'On Hold');
    const use = live.length ? live : members;
    const infos = use.map(infoOf);
    const balance = infos.reduce((s, i) => s + (i.remaining || 0), 0);
    const deadline = infos.map((i) => i.deadline).sort()[0];
    const days = daysBetween(manilaToday(), deadline);
    const last = remindersOf(h)[0]; // newest first -- "Last contacted ..." in the Remind Customer window
    return {
      first_hold_id: Math.min(...use.map((m) => m.id)), customer_name: h.customer_name, contact_number: h.contact_number,
      alt_contact_number: h.alt_contact_number, order_ids: [...new Set(use.map((m) => m.order_id).filter(Boolean))].join(', '),
      balance, deadline, days_remaining: days, stage: reminderStageFor(days), lines: use.length,
      last_reminder_at: last ? last.contacted_at : null, last_reminder_by: last ? last.contacted_by : null, last_channel: last ? last.channel : null,
    };
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  async function copyReminder(o) {
    const text = fillTemplate(o);
    if (await copyText(text)) notify('Message copied -- paste it into Messenger / SMS, then press Mark Contacted once you have sent it.', false);
    else await reasonDialog({ title: 'Copy this message', message: 'Your browser did not allow copying automatically. Select the text below and copy it.', label: 'Message', required: false, confirmLabel: 'Close', cancelLabel: 'Cancel', initialReason: text });
  }
  /** Asks how the customer was contacted, then logs it (mark_layaway_contacted). */
  async function markContacted(o, after) {
    const out = await reasonDialog({
      title: 'Mark ' + o.customer_name + ' as contacted', message: 'Record that you reached out about this layaway. Nothing is sent from here.',
      errorTypes: ['Messenger', 'SMS', 'Call', 'Viber', 'In person', 'Copied message', 'Other'], errorLabel: 'How did you contact them?',
      label: 'Note (optional)', required: false, confirmLabel: 'Mark contacted',
    });
    if (!out) return;
    await runAction(() => markLayawayContacted(o.first_hold_id, o.stage, out.errorType || 'Manual', out.reason || null), 'Marked as contacted.', after);
  }
  function remindersOf(h) {
    const members = (h.group_id ? groupMembers[h.group_id] : null) || [h];
    return members.flatMap((m) => m.layaway_reminders || []).sort((a, b) => b.contacted_at.localeCompare(a.contacted_at));
  }
  const lastContactText = (list) => {
    if (!list.length) return '';
    const r = list[0];
    return fmtDateTime(r.contacted_at) + ' · ' + esc(r.channel) + (r.contacter ? ' · ' + esc(r.contacter.full_name) : (peopleById[r.contacted_by] ? ' · ' + esc(peopleById[r.contacted_by]) : ''));
  };

  /** "Remind Customer" (Ren, 2026-10-07): the message to send, ready to copy -- nothing is ever sent from here. Mark Contacted records
   * who reached out, how, and when, so the next person does not remind them again the same day. `o` is a reminder-queue row. */
  async function remindCustomer(o, after) {
    const lastBy = o.last_reminder_by ? (peopleById[o.last_reminder_by] || '') : '';
    const last = o.last_reminder_at
      ? 'Last contacted <b>' + fmtDateTime(o.last_reminder_at) + '</b>' + (o.last_channel ? ' · ' + esc(o.last_channel) : '') + (lastBy ? ' · by ' + esc(lastBy) : '')
      : 'Not contacted yet.';
    const res = await messageDialog({
      title: 'Remind ' + o.customer_name,
      introHtml: '<div style="font-size:12px;">' + esc(o.contact_number || 'No contact number on file') + (o.alt_contact_number ? ' · alt ' + esc(o.alt_contact_number) : '') + '</div>' +
        '<div style="font-size:12px;margin-top:2px;">' + last + '</div>',
      text: fillTemplate(o), copyLabel: 'Copy Message', actionLabel: 'Mark Contacted', closeLabel: 'Close', onCopy: copyText,
    });
    if (res === 'action') await markContacted(o, after);
  }

  /** Edit Customer: the customer's name / contact / order id / notes (the item, quantity and price are not touched). */
  async function editCustomer(h) {
    const out = await reasonDialog({
      title: 'Edit customer details', message: 'Changes the name, contact number, order ID and notes of this layaway. The item, quantity and price stay as they are.',
      label: 'Reason (optional)', required: false, confirmLabel: 'Save',
      extraFieldsHtml:
        '<div class="field"><label for="dlg-cname">Customer name *</label><input type="text" id="dlg-cname" value="' + esc(h.customer_name) + '"></div>' +
        '<div class="field"><label for="dlg-ccontact">Contact number</label><input type="text" id="dlg-ccontact" value="' + esc(h.contact_number || '') + '"></div>' +
        '<div class="field"><label for="dlg-corder">Order ID</label><input type="text" id="dlg-corder" value="' + esc(h.order_id || '') + '"></div>' +
        '<div class="field"><label for="dlg-cnotes">Notes</label><input type="text" id="dlg-cnotes" value="' + esc(h.notes || '') + '"></div>',
      readExtra: (form) => {
        const name = form.querySelector('#dlg-cname').value.trim();
        if (!name) return { error: 'The customer name cannot be empty.' };
        const x = { customerName: name, contactNumber: form.querySelector('#dlg-ccontact').value.trim(), orderId: form.querySelector('#dlg-corder').value.trim(), notes: form.querySelector('#dlg-cnotes').value.trim() };
        if (x.customerName === h.customer_name && x.contactNumber === (h.contact_number || '') && x.orderId === (h.order_id || '') && x.notes === (h.notes || '')) return { error: 'Nothing was changed.' };
        return x;
      },
    });
    if (!out) return;
    const x = out.extra;
    await runAction(() => editLayawayHold({ holdId: h.id, sku: h.sku, qty: h.qty, unitPrice: h.unit_price, customerName: x.customerName, contactNumber: x.contactNumber, orderId: x.orderId, notes: x.notes, reason: out.reason }),
      'Customer details updated.', async () => { await load(); refreshDetailIfOpen(h.id); });
  }

  /** Change Deadline: Admin sets the Forfeit Date directly; anyone else asks, and Admin approves (nothing changes until then). */
  async function changeDeadline(h) {
    const cur = h.forfeit_date || defaultForfeitDate(h.hold_date);
    const admin = canFinalDelete;
    const out = await reasonDialog({
      title: admin ? 'Change the deadline' : 'Request a new deadline',
      message: admin ? 'Sets this layaway\'s Forfeit Date. The change is logged with your name.' : 'Admin has to approve the change. Nothing changes until then.',
      label: admin ? 'Reason (optional)' : 'Why does it need to move?', required: !admin, confirmLabel: admin ? 'Save deadline' : 'Send request',
      extraFieldsHtml: '<div class="field"><label for="dlg-deadline">New deadline</label><input type="date" id="dlg-deadline" value="' + esc(cur) + '"></div>',
      readExtra: (form) => {
        const d = form.querySelector('#dlg-deadline').value;
        if (!d) return { error: 'Pick the new date.' };
        if (d === cur) return { error: 'That is the deadline it already has.' };
        return { date: d };
      },
    });
    if (!out) return;
    await runAction(() => (admin ? setLayawayForfeitDate(h.id, out.extra.date) : requestLayawayForfeitDate(h.id, out.extra.date, out.reason)),
      admin ? 'Deadline updated.' : 'Deadline change submitted -- awaiting Admin approval.', async () => { await load(); refreshDetailIfOpen(h.id); });
  }

  // Who did what, when -- one chronological trail for the hold (and the rest of its order):
  // created, every payment, edits/approvals from the change log, date changes, reminders,
  // and how it ended. Built from data already loaded plus the change log (fetched on open).
  function historyEvents(h, logRows) {
    const members = (h.group_id ? groupMembers[h.group_id] : null) || [h];
    const ev = [];
    // The change log also records a customer contact and the final forfeit (with the reason); show each once.
    const logHas = (a) => (logRows || []).some((l) => l.action === a);
    const nm = (o, id) => (o && o.full_name) || peopleById[id] || '';
    members.forEach((m) => {
      ev.push({ at: m.created_at, who: nm(m.creator, m.created_by), what: 'Layaway created', detail: m.sku + (m.order_id ? ' · order ' + m.order_id : '') });
      (m.layaway_payments || []).forEach((p) => ev.push({ at: p.created_at, who: nm(p.employees, p.employee_id), what: 'Payment recorded', detail: money(p.amount) + ' ' + p.payment_method + (p.reference_number ? ' #' + p.reference_number : '') + (p.notes ? ' — ' + p.notes : '') }));
      (m.layaway_forfeit_date_log || []).forEach((l) => ev.push({ at: l.changed_at, who: nm(l.employees, l.changed_by), what: 'Forfeit date changed', detail: (l.old_date ? fmtDate(l.old_date) : 'default') + ' → ' + fmtDate(l.new_date) }));
      (m.layaway_hold_date_log || []).forEach((l) => ev.push({ at: l.changed_at, who: nm(l.employees, l.changed_by), what: 'Layaway date changed', detail: fmtDate(l.old_date) + ' → ' + fmtDate(l.new_date) }));
      if (!logHas('Customer Contacted')) (m.layaway_reminders || []).forEach((r) => ev.push({ at: r.contacted_at, who: nm(r.contacter, r.contacted_by), what: 'Customer contacted', detail: r.channel + (r.note ? ' — ' + r.note : '') }));
      if (m.completed_at) ev.push({ at: m.completed_at, who: nm(m.completer, m.completed_by), what: 'Completed', detail: m.sku });
      if (m.cancelled_at) ev.push({ at: m.cancelled_at, who: nm(m.canceller, m.cancelled_by), what: 'Cancelled', detail: m.sku });
      if (m.forfeited_at && !logHas('Forfeited')) ev.push({ at: m.forfeited_at, who: nm(m.forfeiter, m.forfeited_by), what: 'Forfeited', detail: m.sku });
    });
    (logRows || []).forEach((l) => ev.push({ at: l.changed_at, who: l.who ? l.who.full_name : (peopleById[l.changed_by] || ''), what: l.action, detail: l.details || '' }));
    return ev.filter((e) => e.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  function historyHtml(events) {
    if (!events.length) return '<p class="muted" style="margin:0;">No history yet.</p>';
    return '<div class="lw-history">' + events.map((e) =>
      '<div class="lw-hist-row"><div class="lw-hist-when muted">' + fmtDateTime(e.at) + '</div><div><b>' + esc(e.what) + '</b>' +
      (e.who ? ' <span class="muted">· ' + esc(e.who) + '</span>' : '') + (e.detail ? '<div class="muted" style="font-size:11px;">' + esc(e.detail) + '</div>' : '') + '</div></div>').join('') + '</div>';
  }

  // The Detail Drawer (Ren's spec section 204; sections reorganised 2026-10-07): Customer, Order, Items, Payment, Payment history,
  // Reminders, then the actions this person is allowed -- the same fields, rules and server calls as before.
  function renderDetailBody(h) {
    const info = infoOf(h);
    const paid = info.paid;
    const remaining = info.remaining;
    const paymentStatusById = paymentStatusFor(h.layaway_payments || [], h.total_price);
    const canAct = canManage || employee.branch_id === h.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
    const group = h.group_id ? groupMembers[h.group_id] : null;
    const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
    const groupOnHold = group ? group.filter((x) => x.status === 'On Hold') : [];
    const openReq = openForfeitByHold[h.id];
    const reminders = remindersOf(h);
    const live = h.status === 'On Hold';
    const canRequestForfeit = live && canAct && !openReq && (info.overdue || canFinalDelete);
    const canEditDetails = (live && canEditAmount) || (h.status === 'Completed' && canEditCompletedDetails);
    const kv = (k, v) => '<div class="drawer-kv"><span>' + k + '</span><b>' + v + '</b></div>';

    return (openReq
        ? '<div class="drawer-section"><h4>Forfeiture request</h4>' +
            '<div class="lw-note-box"><b>' + esc(openReq.status) + '</b> — requested by ' + esc((openReq.requester && openReq.requester.full_name) || '—') + ' on ' + fmtDateTime(openReq.requested_at) +
            '<div style="margin-top:2px;">Reason: ' + esc(openReq.reason) + '</div>' +
            (openReq.status === 'Supervisor Approved' ? '<div class="muted">Approved by ' + esc((openReq.supervisorApprover && openReq.supervisorApprover.full_name) || '—') + ' · waiting for Admin\'s final approval</div>' : '<div class="muted">Waiting for a Supervisor\'s approval, then Admin\'s final approval.</div>') +
            '</div></div>'
        : '') +
      '<div class="drawer-section"><h4>Customer</h4>' +
        kv('Name', customerLinkHtml(h.customer_name, h.contact_number)) +
        kv('Contact', h.contact_number ? esc(h.contact_number) : '<span class="muted">—</span>') +
        kv('Alt. contact', (h.alt_contact_number ? esc(h.alt_contact_number) : '<span class="muted">—</span>') +
          (canAct ? ' <button type="button" class="btn small secondary" data-act="edit-alt" style="padding:1px 8px;">' + (h.alt_contact_number ? 'Change' : 'Add') + '</button>' : '')) +
        kv('Branch', esc(branchNameOf(h.branch_id))) +
        (h.creator ? kv('Processed by', esc(h.creator.full_name)) : '') +
        (h.handler ? kv('Handled by', esc(h.handler.full_name)) : '') +
        (h.notes ? kv('Notes', esc(h.notes)) : '') +
      '</div>' +
      '<div class="drawer-section"><h4>Order</h4>' +
        kv('Order ID', orderCell(h)) +
        kv('Created', fmtDate(h.hold_date)) +
        (info.active ? kv('Deadline', fmtDate(info.deadline)) + (info.daysText ? kv('Days remaining', '<span class="' + daysClass(info) + '">' + esc(info.daysText) + '</span>') : '') : '') +
        kv('Status', statusChipHtml(info)) +
        // Who closed this hold out and when (Ren's spec section 8) -- set server-side by complete_layaway() / cancel_layaway() / forfeit_layaway_hold().
        (h.status === 'Completed' && h.completed_at ? kv('Completed', (h.completer ? esc(h.completer.full_name) + ' · ' : '') + fmtDateTime(h.completed_at)) : '') +
        (h.status === 'Cancelled' && h.cancelled_at ? kv('Cancelled', (h.canceller ? esc(h.canceller.full_name) + ' · ' : '') + fmtDateTime(h.cancelled_at)) : '') +
        (h.status === 'Forfeited' && h.forfeited_at ? kv('Forfeited', (h.forfeiter ? esc(h.forfeiter.full_name) + ' · ' : '') + fmtDateTime(h.forfeited_at)) : '') +
      '</div>' +
      '<div class="drawer-section"><h4>Items</h4>' +
        kv('SKU', esc(h.sku) + (h.stock_status === 'Lacking' ? ' <span class="badge low">Lacking</span>' : '')) +
        (itemNames[h.sku] ? kv('Item', esc(itemNames[h.sku])) : '') +
        kv('Qty', h.qty) + kv('Unit price', money(h.unit_price)) + kv('Total', money(h.total_price)) +
        (group ? kv('In this order', group.length + ' items') : '') +
      '</div>' +
      '<div class="drawer-section"><h4>Payment</h4>' +
        kv('Total', money(h.total_price)) + kv('Paid', money(paid)) +
        (remaining !== null ? kv('Outstanding', money(remaining)) : '') +
        (info.pct != null ? kv('Paid so far', info.pct + '%') + '<div style="margin:2px 0 6px;">' + progressHtml(info.pct) + '</div>' : '') +
      '</div>' +
      '<div class="drawer-section"><h4>Payment history</h4>' +
        (h.layaway_payments && h.layaway_payments.length
          // Each payment gets its own block with Amount / Method on a leading line (Ren's spec sections 16/66: do not compress several
          // payments into one narrow line); date, reference and who recorded it follow.
          ? h.layaway_payments.map((p) => '<div class="payment-line">' +
              '<div><b>' + money(p.amount) + '</b> · ' + esc(p.payment_method) +
                ' <span class="badge ' + (paymentStatusById[p.id] === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:9px;padding:1px 5px;">' + paymentStatusById[p.id] + '</span></div>' +
              '<div class="muted" style="font-size:11px;margin-top:2px;">' + fmtDate(p.paid_at) + (p.reference_number ? ' · Ref ' + esc(p.reference_number) : '') + (p.employees ? ' · recorded by ' + esc(p.employees.full_name) : '') + '</div>' +
              (p.notes ? '<div class="muted" style="font-size:11px;margin-top:2px;">Note: ' + esc(p.notes) + '</div>' : '') +
              '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' +
                (p.attachment_path ? '<button type="button" class="btn small secondary" data-act="view-proof" data-path="' + esc(p.attachment_path) + '" style="padding:1px 6px;">Proof</button>' : '') +
                (canEditAmount ? '<button class="btn small secondary" data-act="del-payment" data-id="' + p.id + '" style="padding:1px 6px;" title="Request deleting this payment">✕</button>' : '') +
              '</div>' +
            '</div>').join('')
          : '<p class="muted" style="margin:0;">No payments yet.</p>') +
      '</div>' +
      (live
        ? '<div class="drawer-section"><h4>Reminders</h4>' +
            (reminders.length
              ? '<div style="font-size:12px;margin-bottom:6px;">Last contacted: ' + lastContactText(reminders) + (reminders.length > 1 ? ' <span class="muted">(' + reminders.length + ' contacts in all)</span>' : '') +
                (reminders[0].note ? '<div class="muted">Note: ' + esc(reminders[0].note) + '</div>' : '') + '</div>'
              : '<div class="muted" style="font-size:12px;margin-bottom:6px;">Not contacted yet.</div>') +
            ((canAct || canManage) ? '<button type="button" class="btn small secondary" data-act="remind">Remind Customer</button>' : '') +
          '</div>'
        : '') +
      (groupIdx === 0 && groupOnHold.length > 1 && (canAct || canManage)
        ? '<div class="drawer-section"><h4>This Order (' + group.length + ' items)</h4><div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            (canAct ? '<button class="btn small secondary" data-act="complete-group" data-group="' + esc(h.group_id) + '">Complete All (' + groupOnHold.length + ')</button>' : '') +
            // Cancelling/removing a hold is Admin-only -- matching cancel_layaway's own server-side gate (Ren, 2026-09-16).
            (canFinalDelete ? '<button class="btn small secondary" data-act="cancel-group" data-group="' + esc(h.group_id) + '">Cancel All (' + groupOnHold.length + ')</button>' : '') +
          '</div></div>'
        : '') +
      (live && (canAct || canManage)
        ? '<div class="drawer-section"><h4>Actions</h4>' +
            '<div class="lw-actions">' +
              (canAct ? '<button type="button" class="btn small" data-act="toggle-addpay">+ Add Payment</button>' : '') +
              ((canAct || canManage) ? '<button type="button" class="btn small secondary" data-act="remind">Remind Customer</button>' : '') +
              (canEditDetails ? '<button type="button" class="btn small secondary" data-act="edit-customer">Edit Customer</button>' : '') +
              (canEditAmount ? '<button class="btn small secondary" data-act="edit-hold" data-id="' + h.id + '">Edit Item</button>' : '') +
              (canAct ? '<button type="button" class="btn small secondary" data-act="change-deadline">Change Deadline</button>' : '') +
              (canAct ? '<button class="btn small secondary" data-act="complete" data-id="' + h.id + '">Complete</button>' : '') +
              // Only meaningful for a Lacking hold -- nothing to reserve once it's already In Stock. Supervisor-tier (Ren, 2026-09-28) plus Auditor
              // (2026-09-30); matches mark_layaway_stock_available()'s server-side gate exactly.
              ((canApproveItemChange || employee.position === 'Auditor') && h.stock_status === 'Lacking'
                ? '<button class="btn small secondary" data-act="mark-available" data-id="' + h.id + '">Mark In Stock</button>' : '') +
              (canFinalDelete ? '<button class="btn small secondary" data-act="cancel" data-id="' + h.id + '">Cancel</button>' : '') +
              // Forfeiture is never one click (Ren, 2026-10-07): staff REQUEST it once the layaway is overdue, a Supervisor approves, Admin
              // gives the final approval. Admin can also forfeit from here (records the request and approves it in one go).
              (canRequestForfeit ? '<button class="btn small secondary" data-act="' + (canFinalDelete ? 'forfeit-now' : 'request-forfeit') + '" data-id="' + h.id + '">' + (canFinalDelete ? 'Forfeit…' : 'Request Forfeit') + '</button>' : '') +
              // Delete is distinct from Cancel -- a Supervisor-tier REQUEST that Admin finally approves (Ren, 2026-09-26).
              (canApproveItemChange ? '<button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Request Delete</button>' : '') +
            '</div>' +
            (canAct
              ? '<form class="lw-addpay" data-hold-id="' + h.id + '" style="display:none;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;margin-top:10px;">' +
                  '<div data-addpay-box>' + paymentRowsHtml({ recorder: employee.full_name || 'you', hint: 'Split it across methods if the customer paid in more than one way; each line can carry its own reference and proof.' }) + '</div>' +
                  '<div class="field"><label>Notes (optional)</label><input type="text" name="notes"></div>' +
                  '<div class="msg error" data-addpay-err hidden></div>' +
                  '<div style="display:flex;gap:6px;"><button class="btn small" type="submit">Record payment</button><button type="button" class="btn small secondary" data-act="cancel-addpay">Cancel</button></div>' +
                '</form>'
              : '') +
            (canEditAmount ? editHoldFormHtml(h) : '') +
          '</div>'
        : '') +
      // Completed's own Edit (details-only: Customer/Contact/Order ID/Notes, SKU/Qty/Price stay locked) -- separate section since there is no
      // payment form / Complete / Cancel / Forfeit here (Ren, 2026-09-25).
      (h.status === 'Completed' && canEditCompletedDetails
        ? '<div class="drawer-section"><h4>Edit Details</h4>' +
            '<button class="btn small secondary" data-act="edit-hold" data-id="' + h.id + '">Edit</button>' +
            editHoldFormHtml(h) +
          '</div>'
        : '') +
      // Deleting a Completed / Cancelled / Forfeited hold is the same Supervisor-requests / Admin-approves flow (Ren, 2026-09-26: "both cases").
      ((h.status === 'Cancelled' || h.status === 'Forfeited' || h.status === 'Completed') && canApproveItemChange
        ? '<div class="drawer-section"><button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Request Delete</button></div>'
        : '') +
      '<div class="drawer-section"><h4>History</h4><div id="lw-history-box"><div class="muted">Loading…</div></div></div>';
  }


  // Same wiring the old per-row cell used to attach across the whole table, now
  // scoped to just the one hold's drawer body -- refreshDetailIfOpen() re-renders
  // this same drawer with fresh data after an in-place action (Add Payment, Delete
  // Payment, Edit), or closeDetailDrawer() after an action that moves the hold to a
  // different status folder entirely.
  async function loadHistory(h) {
    const box = document.getElementById('lw-history-box');
    if (!box) return;
    try {
      const members = (h.group_id ? groupMembers[h.group_id] : null) || [h];
      const rows = await listLayawayChangeLog(members.map((m) => m.id));
      if (document.getElementById('lw-history-box') !== box) return; // the drawer moved on to another record
      box.innerHTML = historyHtml(historyEvents(h, rows));
    } catch (err) {
      box.innerHTML = historyHtml(historyEvents(h, [])) + '<div class="muted" style="font-size:11px;margin-top:4px;">(Edit/approval history could not be loaded: ' + esc(err.message || err) + ')</div>';
    }
  }

  function wireDetailBody(container, h) {
    wireCustomerLinks(container);
    loadHistory(h);

    // + Add Payment: the shared payment rows (method / amount / date / reference / proof -- up to three lines when the customer paid in
    // more than one way). Each line is its own payment record, exactly as a single payment was before.
    const addPay = container.querySelector('.lw-addpay');
    if (addPay) {
      const owed = infoOf(h).remaining;
      const rows = mountPaymentRows(addPay.querySelector('[data-addpay-box]'), {
        getDue: () => (owed == null ? 0 : owed), getMinDate: () => '', dueLabel: 'Balance', emptyText: 'No balance is set for this layaway.', allowOver: true,
      });
      container.querySelector('[data-act="toggle-addpay"]')?.addEventListener('click', () => {
        const opening = addPay.style.display === 'none';
        addPay.style.display = opening ? 'flex' : 'none';
        if (opening) { rows.reset(); rows.sync(); addPay.querySelector('[data-f="amount"]').focus(); }
      });
      container.querySelector('[data-act="cancel-addpay"]')?.addEventListener('click', () => { addPay.style.display = 'none'; });
      addPay.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const errBox = addPay.querySelector('[data-addpay-err]'); errBox.hidden = true;
        const fail = (m, el) => { errBox.textContent = friendlyError(m); errBox.hidden = false; if (el) flagInvalid(el); };
        const got = rows.read();
        if (got.error) return fail(got.error, got.el);
        if (!got.payments.length) return fail('Enter the amount of the payment.', addPay.querySelector('[data-f="amount"]'));
        // A payment bigger than what is still owed is almost always a typo (an extra zero) -- make the person look at it before it
        // becomes part of the record.
        if (owed != null && got.sum > owed + 0.01) {
          const ok = await confirmDialog({ title: 'This is more than the balance', confirmLabel: 'Record anyway',
            message: money(got.sum) + ' is ' + money(got.sum - owed) + ' more than what is still owed (' + money(owed) + ').\nRecord it anyway?' });
          if (!ok) return;
        }
        const btn = addPay.querySelector('button[type=submit]'); btn.disabled = true;
        let saved = 0;
        try {
          for (const p of got.payments) {
            const attachmentPath = p.file ? await uploadLayawayPaymentProof(h.branch_id, h.id, p.file) : null;
            await addLayawayPayment(h.id, p.amount, p.method, p.reference, attachmentPath, p.paidAt, addPay.elements.notes.value.trim());
            saved++;
          }
          notify(saved === 1 ? 'Payment added.' : saved + ' payments added.', false);
          await load();
          refreshDetailIfOpen(h.id);
        } catch (e) {
          notify((saved ? saved + ' payment(s) were saved, then: ' : '') + String(e.message || e), true);
          btn.disabled = false;
          if (saved) { await load(); refreshDetailIfOpen(h.id); }
        }
      });
    }
    container.querySelectorAll('[data-act="view-proof"]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const url = await getLayawayPaymentProofUrl(btn.dataset.path);
        window.open(url, '_blank');
      } catch (err) {
        notify(String(err.message || err), true);
      }
    }));

    container.querySelector('[data-act="edit-alt"]')?.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Alternative contact number', message: 'A second number to reach this customer on (applies to every item in this order).',
        label: 'Number', required: false, confirmLabel: 'Save', initialReason: h.alt_contact_number || '' });
      if (!out) return;
      await runAction(() => setLayawayAltContact(h.id, out.reason), 'Alternative contact saved.', async () => { await load(); refreshDetailIfOpen(h.id); });
    });
    // (two buttons carry this action: one under Reminders, one among the actions)
    container.querySelectorAll('[data-act="remind"]').forEach((b) => b.addEventListener('click', () => remindCustomer(orderRowFor(h), async () => { await load(); refreshDetailIfOpen(h.id); })));
    container.querySelector('[data-act="edit-customer"]')?.addEventListener('click', () => editCustomer(h));
    container.querySelector('[data-act="change-deadline"]')?.addEventListener('click', () => changeDeadline(h));

    const completeBtn = container.querySelector('[data-act="complete"]');
    if (completeBtn) completeBtn.addEventListener('click', async () => {
      const paid = paidSoFar(h);
      // A hard block, not a skippable warning (Ren, 2026-09-22: "do not complete if
      // not complete payment amount" -- found a real hold marked Completed with only
      // a third of its price paid, via the old "Complete anyway?" confirm). The
      // server enforces this too (complete_layaway), so this is just the fast,
      // no-round-trip version of the same rule.
      if (h.total_price != null && paid < Number(h.total_price)) {
        notify('Not fully paid yet -- ' + money(h.total_price - paid) + ' still owed (' + money(paid) + ' of ' + money(h.total_price) + ' collected). Add the remaining payment before completing.', true);
        return;
      }
      if (!await confirmDialog({ title: 'Complete this layaway?', message: 'It is marked completed and sold.', confirmLabel: 'Complete' })) return;
      try { await completeLayaway(h.id); notify('Layaway completed.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    const cancelBtn = container.querySelector('[data-act="cancel"]');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Cancel this layaway?', message: 'The item goes back to Available stock.', confirmLabel: 'Cancel layaway', cancelLabel: 'Keep it', danger: true })) return;
      try { await cancelLayaway(h.id); notify('Layaway cancelled.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    const markAvailableBtn = container.querySelector('[data-act="mark-available"]');
    if (markAvailableBtn) markAvailableBtn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Mark this item as In Stock?', message: 'This reserves a real unit right now so it can\'t be sold to someone else before this layaway is completed.', confirmLabel: 'Mark In Stock' })) return;
      try {
        await markLayawayStockAvailable(h.id);
        notify('Item marked In Stock and reserved.', false);
        await load();
        refreshDetailIfOpen(h.id);
      } catch (err) { notify(String(err.message || err), true); }
    });

    // Forfeiture is a request, never a click (Ren, 2026-10-07). Admin's "Forfeit…" records the
    // request AND approves it in one go, so the trail still shows both steps.
    container.querySelector('[data-act="request-forfeit"]')?.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Request forfeiture', message: 'This layaway is past its deadline. A Supervisor reviews the request, then Admin gives the final approval -- nothing is forfeited until then.', label: 'Why should it be forfeited?', confirmLabel: 'Send request' });
      if (!out) return;
      await runAction(() => requestLayawayForfeit(h.id, out.reason), 'Forfeiture requested -- waiting for a Supervisor.', async () => { await load(); refreshDetailIfOpen(h.id); });
    });
    container.querySelector('[data-act="forfeit-now"]')?.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Forfeit this layaway', message: 'The customer loses the item: it is marked Forfeited and goes back to available stock. Payments already made stay on record.', label: 'Reason', confirmLabel: 'Forfeit', danger: true });
      if (!out) return;
      await runAction(async () => { const id = await requestLayawayForfeit(h.id, out.reason); await approveLayawayForfeitFinal(id); }, 'Layaway forfeited.', async () => { await load(); closeDetailDrawer(); });
    });

    const completeGroupBtn = container.querySelector('[data-act="complete-group"]');
    if (completeGroupBtn) completeGroupBtn.addEventListener('click', async () => {
      const members = (groupMembers[h.group_id] || []).filter((x) => x.status === 'On Hold');
      if (!await confirmDialog({ title: 'Complete the whole order?', message: 'All ' + members.length + ' items in this order are marked completed and sold.', confirmLabel: 'Complete all' })) return;
      try {
        for (const m of members) await completeLayaway(m.id);
        notify(members.length + ' item(s) completed.', false);
      } catch (err) {
        notify(String(err.message || err), true);
      } finally {
        await load();
        closeDetailDrawer();
      }
    });

    const cancelGroupBtn = container.querySelector('[data-act="cancel-group"]');
    if (cancelGroupBtn) cancelGroupBtn.addEventListener('click', async () => {
      const members = (groupMembers[h.group_id] || []).filter((x) => x.status === 'On Hold');
      if (!await confirmDialog({ title: 'Cancel the whole order?', message: 'All ' + members.length + ' items go back to Available stock.', confirmLabel: 'Cancel all', cancelLabel: 'Keep them', danger: true })) return;
      try {
        for (const m of members) await cancelLayaway(m.id);
        notify(members.length + ' item(s) cancelled.', false);
      } catch (err) {
        notify(String(err.message || err), true);
      } finally {
        await load();
        closeDetailDrawer();
      }
    });

    const deleteBtn = container.querySelector('[data-act="delete-hold"]');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Request deleting this layaway', message: 'Needs Supervisor review, then final Admin approval, before anything is actually deleted.', label: 'Reason', confirmLabel: 'Send request', danger: true });
      if (!out) return;
      await runAction(() => requestLayawayHoldDeletion(h.id, out.reason), 'Deletion requested — pending Supervisor review, then final Admin approval.', async () => { await load(); refreshDetailIfOpen(h.id); });
    });

    container.querySelectorAll('[data-act="del-payment"]').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Request deleting this payment', message: 'A Supervisor must approve before it is actually removed.', label: 'Reason', confirmLabel: 'Send request', danger: true,
        errorTypes: ERROR_TYPES, errorLabel: 'What kind of mistake was it?' });
      if (!out) return;
      // The mistake type travels with the reason so whoever approves the deletion can file the correction.
      await runAction(() => requestLayawayPaymentDeletion(Number(btn.dataset.id), '[' + out.errorType + '] ' + out.reason), 'Deletion requested — pending Supervisor approval.', async () => { await load(); refreshDetailIfOpen(h.id); });
    }));

    const editBtn = container.querySelector('[data-act="edit-hold"]');
    if (editBtn) editBtn.addEventListener('click', () => {
      const form = container.querySelector('.lw-edit-form[data-hold-id="' + h.id + '"]');
      if (!form) return;
      const opening = form.style.display === 'none';
      form.style.display = opening ? '' : 'none';
      if (opening) attachSkuAutocomplete(form);
    });
    const closeEditBtn = container.querySelector('[data-act="close-edit-hold"]');
    if (closeEditBtn) closeEditBtn.addEventListener('click', () => {
      const form = container.querySelector('.lw-edit-form[data-hold-id="' + h.id + '"]');
      if (form) form.style.display = 'none';
    });
    const saveEditBtn = container.querySelector('[data-act="save-edit-hold"]');
    if (saveEditBtn) saveEditBtn.addEventListener('click', async () => {
      const form = container.querySelector('.lw-edit-form[data-hold-id="' + h.id + '"]');
      if (!form) return;
      const sku = form.querySelector('[name=sku]').value.trim();
      const qty = Number(form.querySelector('[name=qty]').value);
      const unitPrice = form.querySelector('[name=unitPrice]').value ? Number(form.querySelector('[name=unitPrice]').value) : null;
      const customerName = form.querySelector('[name=customerName]').value.trim();
      const contactNumber = form.querySelector('[name=contactNumber]').value.trim();
      const orderId = form.querySelector('[name=orderId]').value.trim();
      const notes = form.querySelector('[name=notes]').value.trim();
      // Not present at all on a Completed hold's form (SKU/Qty/Price are disabled
      // there, so a reason can never actually be needed) -- optional chaining avoids
      // crashing on the missing field instead of just never requiring one.
      let reason = form.querySelector('[name=reason]')?.value.trim() || '';
      if (!sku || !qty || qty <= 0 || !customerName) { notify('SKU, a positive Qty, and Customer Name are required.', true); return; }
      const skuChanged = sku !== h.sku;
      const amountChanged = Number(h.unit_price) !== Number(unitPrice) || Number(h.qty) !== qty;
      // Branch Team Leader keeps this same form for everything else, but changing the
      // item itself needs Supervisor approval first (Ren, 2026-09-24) -- unless they
      // separately qualify as a direct approver (e.g. a Branch Team Leader whose role
      // is already Branch Supervisor), matching edit_layaway_hold()'s own gate exactly.
      if (skuChanged && employee.position === 'Branch Team Leader' && !canApproveItemChange) {
        const out = await reasonDialog({ title: 'Request an item change', message: 'Changing the item needs a Supervisor\'s approval: ' + h.sku + ' → ' + sku + '.', label: 'Reason', initialReason: reason, confirmLabel: 'Send request' });
        if (!out) return;
        await runAction(() => requestLayawayItemChange(h.id, sku, '[Incorrect Layaway Item] ' + out.reason), 'Item change submitted for Supervisor approval.', async () => { await load(); refreshDetailIfOpen(h.id); });
        return;
      }
      // Ren's spec sections 126/127: reason required whenever the amount/qty (or the item)
      // actually changes, with the old vs new shown before saving -- and the kind of mistake
      // is filed so the owner can see who keeps making which errors.
      let errorType = null;
      if (amountChanged || skuChanged) {
        const guess = skuChanged ? 'Wrong SKU' : (Number(h.qty) !== qty ? 'Wrong Amount' : 'Wrong Amount');
        const out = await reasonDialog({
          title: 'Confirm this correction',
          message: (skuChanged ? 'Item: ' + h.sku + ' → ' + sku + '\n' : '') +
            (amountChanged ? 'Amount: ' + money(h.unit_price) + ' × ' + h.qty + ' → ' + money(unitPrice) + ' × ' + qty + '\nDifference in total: ' + money(Number(unitPrice || 0) * qty - Number(h.unit_price || 0) * Number(h.qty)) : ''),
          label: 'Reason', initialReason: reason, confirmLabel: 'Save correction', errorTypes: [guess, ...ERROR_TYPES.filter((t) => t !== guess)], errorLabel: 'What kind of mistake was it?',
        });
        if (!out) return;
        reason = out.reason; errorType = out.errorType;
      }
      try {
        await editLayawayHold({ holdId: h.id, sku, qty, unitPrice, customerName, contactNumber, orderId, notes, reason });
        if (errorType) {
          // Best effort -- the correction itself already succeeded; a failed note must not look like a failed edit.
          try {
            await logBranchErrorCorrection({ module: 'Layaway', recordTable: 'layaway_holds', recordId: h.id, errorType, reason,
              oldValue: h.sku + ' ×' + h.qty + ' @' + (h.unit_price ?? ''), newValue: sku + ' ×' + qty + ' @' + (unitPrice ?? '') });
          } catch (e) { console.warn('Could not file the error correction', e); }
        }
        notify('Layaway updated.', false);
        await load();
        refreshDetailIfOpen(h.id);
      } catch (err) {
        notify(String(err.message || err), true);
      }
    });
  }

  // ===================================================================================================
  // Rendering. load() fetches once; renderActive() draws only the sub-tab on show (plus the cards and tab counts).
  // ===================================================================================================

  // ---- Search and filters. Search covers customer, contact, order, SKU, item name, notes, who recorded it and every payment
  // reference; the On Hold filters narrow that list further. ----
  function holdHay(h) {
    return [h.sku, itemNames[h.sku], h.customer_name, h.contact_number, h.alt_contact_number, h.order_id, h.notes,
      h.creator && h.creator.full_name, h.handler && h.handler.full_name,
      ...(h.layaway_payments || []).map((p) => (p.reference_number || '') + ' ' + ((p.employees && p.employees.full_name) || ''))].filter(Boolean).join(' ').toLowerCase();
  }
  const matchesSearch = (h, q) => !q || holdHay(h).includes(q);
  // The On Hold list's Status filter: a real status (PARTIALLY PAID, OVERDUE ...) or a grouping the summary cards / Needs Attention
  // items open (everything past its deadline; items still waiting for stock; anything that needs a person's attention).
  function matchesStatusFilter(h, f) {
    if (f === 'all') return true;
    if (f === 'lacking') return h.stock_status === 'Lacking';
    const info = infoOf(h);
    if (f === 'past') return info.overdue;
    if (f === 'attention') return info.overdue || info.key === 'NEARING DEADLINE' || h.stock_status === 'Lacking' || !!openForfeitByHold[h.id];
    return info.key === f;
  }
  function matchesDue(h, f) {
    if (f === 'all') return true;
    const info = infoOf(h);
    if (!info.active || info.key === 'PAID IN FULL') return false;
    if (f === 'overdue') return info.days < 0;
    if (f === 'today') return info.days === 0;
    return info.days >= 0 && info.days <= { d3: 3, d7: 7, d14: 14 }[f];
  }
  function matchesPay(h, f) {
    if (f === 'all') return true;
    const info = infoOf(h);
    if (f === 'paid') return info.key === 'PAID IN FULL';
    if (f === 'unpaid') return info.paid <= 0.005 && info.key !== 'PAID IN FULL';
    return info.paid > 0.005 && info.key !== 'PAID IN FULL';
  }
  const STATUS_FILTER_LABELS = { past: 'Past deadline', lacking: 'Waiting for stock', attention: 'Needs attention' };
  const DUE_LABELS = { today: 'Due today', d3: 'Due in 3 days', d7: 'Due in 7 days', d14: 'Due in 14 days', overdue: 'Overdue' };
  const PAY_LABELS = { unpaid: 'Nothing paid yet', partial: 'Partially paid', paid: 'Paid in full' };
  const isMissingRef = (p) => !p.reference_number && !['Cash', 'Store Sales Cash'].includes(p.payment_method);
  /** Every payment on every hold of this branch, with its hold, its running status and who recorded it. */
  function allPayments() {
    const out = [];
    allHolds.forEach((h) => {
      // Status computed against the hold's FULL payment history, so a payment near a range boundary still shows the right running-total status.
      const statusById = paymentStatusFor(h.layaway_payments || [], h.total_price);
      (h.layaway_payments || []).forEach((p) => out.push({ ...p, hold: h, paymentStatus: statusById[p.id], recordedBy: p.employees ? p.employees.full_name : '' }));
    });
    return out;
  }

  // ---- Quick filters (header) -- they set the On Hold filters and open that tab ----
  function setQuick(k) {
    ['lw-f-status', 'lw-f-due', 'lw-f-pay', 'lw-f-by'].forEach((id) => { $(id).value = 'all'; });
    if (k === 'attention') $('lw-f-status').value = 'attention';
    else if (k === 'soon') $('lw-f-due').value = 'd7';
    else if (k === 'overdue') $('lw-f-status').value = 'past';
    else if (k === 'partial') $('lw-f-status').value = 'PARTIALLY PAID';
    else if (k === 'paid') $('lw-f-status').value = 'PAID IN FULL';
    resetPages();
    setSubTab('onhold');
  }
  /** Marks the quick filter that matches the current filters (none, if they were set some other way). */
  function syncQuick() {
    const v = { s: $('lw-f-status').value, d: $('lw-f-due').value, p: $('lw-f-pay').value, b: $('lw-f-by').value };
    let on = '';
    if (v.d === 'all' && v.p === 'all' && v.b === 'all') on = { all: 'all', attention: 'attention', past: 'overdue', 'PARTIALLY PAID': 'partial', 'PAID IN FULL': 'paid' }[v.s] || '';
    else if (v.s === 'all' && v.p === 'all' && v.b === 'all' && v.d === 'd7') on = 'soon';
    $('lw-quick').querySelectorAll('[data-q]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === on)));
  }

  // ---- Header cards (clickable) ----
  function setDueFilter(v) { dueFilter = v; const sel = $('lw-due-filter'); if (sel) sel.value = v; pgDue.page = 1; }
  function renderCards() {
    const q = searchText();
    const rows = allHolds.filter((h) => matchesSearch(h, q));
    const onHoldAll = rows.filter((h) => h.status === 'On Hold');
    const infos = onHoldAll.map(infoOf);
    const overdueN = infos.filter((i) => i.overdue).length;
    const soonN = infos.filter((i) => i.active && i.key !== 'PAID IN FULL' && i.days >= 0 && i.days <= 7).length;
    const card = (label, value, sub, act, tone) => '<button type="button" class="lw-card' + (tone ? ' tone-' + tone : '') + '" data-act="' + act + '">' +
      '<span class="lw-card-l">' + label + '</span><span class="lw-card-n">' + value + '</span>' + (sub ? '<span class="lw-card-s">' + sub + '</span>' : '') + '</button>';
    const box = $('lw-cards');
    box.innerHTML =
      card('On Hold', onHoldAll.length, plural2(onHoldAll.length, 'item'), 'onhold') +
      card('Value On Hold', money0(onHoldAll.reduce((s, h) => s + Number(h.total_price || 0), 0)), 'total price', 'onhold') +
      card('Paid So Far', money0(infos.reduce((s, i) => s + i.paid, 0)), 'on these layaways', 'payments') +
      card('Outstanding', money0(infos.reduce((s, i) => s + (i.remaining || 0), 0)), 'still owed', 'onhold') +
      card('Due Soon', soonN, 'within 7 days', 'soon', soonN ? 'warn' : '') +
      card('Overdue', overdueN, 'past the deadline', 'overdue', overdueN ? 'bad' : '') +
      card('Completed', rows.filter((h) => h.status === 'Completed').length, 'all time', 'completed');
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'onhold') setQuick('all');
      else if (a === 'payments') setSubTab('payments');
      else if (a === 'soon') { setDueFilter('soon'); setSubTab('due'); }
      else if (a === 'overdue') { setDueFilter('overdue'); setSubTab('due'); }
      else if (a === 'completed') setSubTab('completed');
    }));
  }
  const plural2 = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ---- Sub-tabs ----
  function renderSubtabs() {
    const live = allHolds.filter((h) => h.status === 'On Hold').map(infoOf);
    const dueN = live.filter((i) => i.key !== 'PAID IN FULL' && i.days <= 7).length;
    const overdueN = live.filter((i) => i.overdue).length;
    const counts = {
      onhold: live.length, due: dueN, completed: allHolds.filter((h) => h.status === 'Completed').length,
      forfeited: allHolds.filter((h) => h.status === 'Forfeited').length, requests: canSeeRequests ? requestsCount() : 0,
    };
    const tone = { due: overdueN ? 'bad' : (dueN ? 'warn' : ''), requests: counts.requests ? 'warn' : '' };
    const box = $('lw-subtabs');
    box.innerHTML = SUBTABS.filter(([k]) => k !== 'requests' || canSeeRequests).map(([k, label]) =>
      '<button type="button" role="tab" data-t="' + k + '" class="lw-subtab' + (k === subTab ? ' active' : '') + '" aria-selected="' + (k === subTab) + '">' + label +
      (counts[k] != null ? ' <span class="lw-subtab-n' + (tone[k] ? ' tone-' + tone[k] : '') + '">' + counts[k] + '</span>' : '') + '</button>').join('');
    box.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => setSubTab(b.dataset.t)));
  }
  function setSubTab(key) {
    if (!SUBTABS.some(([k]) => k === key) || (key === 'requests' && !canSeeRequests)) key = 'overview';
    subTab = key;
    root.querySelectorAll('.lw-panel').forEach((p) => { p.hidden = p.dataset.panel !== key; });
    renderSubtabs();
    renderActive();
  }
  function renderActive() {
    const draw = { overview: renderOverview, onhold: renderOnHold, payments: renderMonthlyPayments, due: renderDue, completed: renderCompleted, forfeited: renderForfeited, requests: renderRequestsPanel }[subTab];
    draw();
    syncQuick();
    renderCards();
    // The module pill count follows the search, like every other tab (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(allHolds.filter((h) => h.status === 'On Hold' && matchesSearch(h, searchText())).length);
  }
  function renderDue() { renderReminders(); renderForfeitureWatch(); }
  function renderRequestsPanel() {
    if (canFinalDelete) renderPendingForfeitRequests();
    if (canApproveItemChange) { renderPendingItemChangeRequests(); renderPendingPaymentDeletionRequests(); renderPendingHoldDeletionRequests(); renderPendingForfeitWorkflow(); }
  }

  // ---- Shared pieces of the tables ----
  const itemsCell = (h) => esc(h.sku) + ' <span class="muted" style="font-size:10px;">× ' + h.qty + '</span>' +
    (h.stock_status === 'Lacking' ? ' <span class="badge low" title="Not physically in stock yet -- needs to be sourced before this can be completed">Lacking</span>' : '') +
    (itemNames[h.sku] ? '<div class="muted" style="font-size:10px;">' + esc(itemNames[h.sku]) + '</div>' : '');
  function orderCell(h) {
    const group = h.group_id ? groupMembers[h.group_id] : null;
    const idx = group ? group.findIndex((x) => x.id === h.id) : -1;
    return esc(h.order_id || '—') +
      // An On Hold item has already left the sellable pool (moves to Reserved), so it is visibly tagged, not just implied by the
      // Status column (Ren's spec section 229: "It must be immediately visible.").
      (h.status === 'On Hold' ? ' <span class="badge transit" style="font-size:9px;padding:1px 5px;" title="This item is held for this customer -- not available for another sale.">Reserved</span>' : '') +
      (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (idx + 1) + '/' + group.length + '</span>' : '');
  }
  /** "₱7,500 / ₱10,000" over a bar and the percentage -- nearly-completed layaways stand out. */
  const progressCell = (info) => (info.pct == null ? '<span class="muted">—</span>' : '<div class="lw-prog2"><div class="lw-prog2-t">' + money0(info.paid) + ' / ' + money0(info.total) + '</div>' + progressHtml(info.pct) + '</div>');
  const lastPayOf = (h) => (h.layaway_payments || []).slice().sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || '') || b.id - a.id)[0];
  const doneDate = (ts) => (ts ? fmtDate(manilaDateStr(ts)) : '—');
  function wireHoldRows(container) {
    container.querySelectorAll('tr[data-hold-id]').forEach((tr) => tr.addEventListener('click', (ev) => {
      if (ev.target.closest('a, input, select, textarea') || (ev.target.closest('button') && !ev.target.closest('[data-act="view-details"]'))) return;
      openDetail(Number(tr.dataset.holdId));
    }));
    container.querySelectorAll('[data-act="view-details"]').forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.id))));
    wireCustomerLinks(container);
  }
  /** One paged table: `tableHtml(rowsOfThisPage)` builds it, the footer pages it (25 / 50 / 100 rows). */
  function pagedTable(containerId, rows, state, tableHtml, rerender, emptyHtml) {
    const box = document.getElementById(containerId);
    if (!rows.length) { box.innerHTML = emptyHtml; return; }
    const info = pageSlice(rows, state);
    box.innerHTML = tableHtml(info.rows) + pagerHtml(info);
    wirePager(box, state, rerender);
    wireHoldRows(box);
  }
  const noneHtml = (what) => '<p class="muted">No ' + what + '.</p>';

  // ---- OVERVIEW: short on purpose ----
  function renderOverview() {
    renderMonthly();
    const live = allHolds.filter((h) => h.status === 'On Hold').map((h) => ({ h, i: infoOf(h) }));
    const overdue = live.filter((x) => x.i.overdue).length;
    const soon = live.filter((x) => x.i.key !== 'PAID IN FULL' && x.i.days >= 0 && x.i.days <= 7).length;
    const lacking = live.filter((x) => x.h.stock_status === 'Lacking').length;
    const toRemind = remindQueue.filter((o) => o.due).length;
    const approvals = canSeeRequests ? requestsCount() : 0;
    const missingRef = allPayments().filter(isMissingRef).length;
    const items = [];
    if (overdue) items.push({ tone: 'bad', act: 'overdue', text: plural2(overdue, 'layaway') + ' past the deadline' });
    if (soon) items.push({ tone: 'warn', act: 'soon', text: plural2(soon, 'layaway') + ' due within 7 days' });
    if (approvals) items.push({ tone: 'warn', act: 'requests', text: approvals + ' pending approval' + (approvals === 1 ? '' : 's') });
    if (toRemind) items.push({ tone: 'warn', act: 'remind', text: plural2(toRemind, 'customer') + ' due for a reminder' });
    if (missingRef) items.push({ tone: 'info', act: 'missingref', text: missingRef + ' payment' + (missingRef === 1 ? '' : 's') + ' missing a reference number' });
    if (lacking) items.push({ tone: 'info', act: 'lacking', text: plural2(lacking, 'item') + ' waiting for stock' });
    const attn = $('lw-attn');
    attn.innerHTML = items.length
      ? '<div class="lw-attn-list">' + items.map((x) => '<button type="button" class="lw-attn-item tone-' + x.tone + '" data-act="' + x.act + '"><span class="lw-attn-dot" aria-hidden="true"></span><span>' + esc(x.text) + '</span><span aria-hidden="true">›</span></button>').join('') + '</div>'
      : '<div class="lw-attn-clear">✓ Nothing needs attention right now.</div>';
    attn.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'overdue' || a === 'soon') { setDueFilter(a); setSubTab('due'); }
      else if (a === 'requests') setSubTab('requests');
      else if (a === 'remind') { setDueFilter('all'); setSubTab('due'); const f = $('lw-remind-folder'); if (f) { f.open = true; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
      else if (a === 'lacking') { setQuick('all'); $('lw-f-status').value = 'lacking'; renderActive(); }
      else if (a === 'missingref') { if (requestRange) requestRange('all'); $('mm-pay-f-ref').value = 'missing'; pgPay.page = 1; setSubTab('payments'); }
    }));

    const pays = allPayments().sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || '') || b.id - a.id).slice(0, 5);
    $('lw-recent-pay').innerHTML = pays.length
      ? '<div class="lw-recent-list">' + pays.map((p) => '<button type="button" class="lw-recent" data-hold="' + p.hold.id + '"><span class="muted">' + fmtDate(p.paid_at) + '</span><b>' + esc(p.hold.customer_name) + '</b><span>' + money(p.amount) + ' · ' + esc(p.payment_method) + '</span></button>').join('') + '</div>'
      : '<p class="muted" style="margin:0;">No payments yet.</p>';
    const lays = allHolds.slice().sort((a, b) => (b.hold_date || '').localeCompare(a.hold_date || '') || b.id - a.id).slice(0, 5);
    $('lw-recent-lay').innerHTML = lays.length
      ? '<div class="lw-recent-list">' + lays.map((h) => { const i = infoOf(h); return '<button type="button" class="lw-recent" data-hold="' + h.id + '"><span class="muted">' + fmtDate(h.hold_date) + '</span><b>' + esc(h.customer_name) + '</b><span>' + money(h.total_price) + ' · ' + statusChipHtml(i) + '</span></button>'; }).join('') + '</div>'
      : '<p class="muted" style="margin:0;">No layaways yet.</p>';
    root.querySelectorAll('.lw-recent').forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.hold))));
  }

  // ---- ON HOLD ----
  function renderOnHold() {
    const q = searchText();
    const fStatus = $('lw-f-status').value, fDue = $('lw-f-due').value, fPay = $('lw-f-pay').value;
    // Recorded By's options are real data (whoever created these layaways), rebuilt only when that set changes so a selection survives.
    const byEl = $('lw-f-by');
    const names = [...new Set(allHolds.filter((h) => h.status === 'On Hold').map((h) => h.creator && h.creator.full_name).filter(Boolean))].sort();
    if (byEl.dataset.optionsFor !== names.join('|')) {
      const keep = byEl.value;
      byEl.dataset.optionsFor = names.join('|');
      byEl.innerHTML = '<option value="all">Anyone</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
      byEl.value = names.includes(keep) ? keep : 'all';
    }
    const fBy = byEl.value;
    const rows = allHolds.filter((h) => h.status === 'On Hold' && matchesSearch(h, q) && matchesStatusFilter(h, fStatus) && matchesDue(h, fDue) && matchesPay(h, fPay) &&
      (fBy === 'all' || (h.creator && h.creator.full_name === fBy)));
    const filtered = !!(q || fStatus !== 'all' || fDue !== 'all' || fPay !== 'all' || fBy !== 'all');
    const activeEl = $('lw-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Status', value: fStatus === 'all' ? '' : esc(STATUS_FILTER_LABELS[fStatus] || fStatus) },
      { label: 'Due', value: fDue === 'all' ? '' : esc(DUE_LABELS[fDue]) },
      { label: 'Payment', value: fPay === 'all' ? '' : esc(PAY_LABELS[fPay]) },
      { label: 'Recorded by', value: fBy === 'all' ? '' : esc(fBy) },
    ], 'lw-f-clear');
    wireProxyButtons(activeEl);
    const list = $('lw-list');
    if (!rows.length) {
      list.innerHTML = emptyStateHtml({
        message: filtered ? 'No On Hold layaways match these filters.' : 'No layaways on hold for this branch right now.',
        hasFilters: filtered, clearId: 'lw-f-clear', createLabel: '+ New Layaway', createId: 'lw-new-btn',
      });
      wireProxyButtons(list);
      return;
    }
    // One sort state; filtering picks WHICH rows show, sort only reorders them (spec section 11).
    pagedTable('lw-list', applySort(rows, sort, lwSortComparators()), pgOnHold, onHoldTableHtml, renderOnHold, '');
  }
  function onHoldTableHtml(rows) {
    return '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th>Order</th><th>Customer</th><th class="nw">Contact</th><th>Items</th><th class="nw">Total</th><th class="nw">Paid</th><th class="nw">Balance</th><th class="nw">Payment Progress</th><th class="nw">Deadline</th><th>Days Left</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((h) => {
        const info = infoOf(h);
        const open = openForfeitByHold[h.id];
        return '<tr class="lw-row' + (info.rowTone ? ' lw-row-' + info.rowTone : '') + '" data-hold-id="' + h.id + '">' +
          '<td data-label="Order">' + orderCell(h) + '</td>' +
          '<td data-label="Customer" class="full-row">' + customerLinkHtml(h.customer_name, h.contact_number) + '</td>' +
          '<td data-label="Contact" class="nw">' + esc(h.contact_number || '—') + '</td>' +
          '<td data-label="Items">' + itemsCell(h) + '</td>' +
          '<td data-label="Total" class="nw">' + money(h.total_price) + '</td>' +
          '<td data-label="Paid" class="nw">' + money(info.paid) + '</td>' +
          '<td data-label="Balance" class="nw">' + (info.remaining !== null ? money(info.remaining) : '—') + '</td>' +
          '<td data-label="Payment Progress" class="nw">' + progressCell(info) + '</td>' +
          '<td data-label="Deadline" class="nw">' + fmtDate(info.deadline) + '</td>' +
          '<td data-label="Days Left">' + (info.daysText ? '<span class="' + daysClass(info) + '">' + esc(info.daysText) + '</span>' : '—') + '</td>' +
          '<td data-label="Status">' + statusChipHtml(info) + (open ? '<div class="muted" style="font-size:10px;">' + esc(open.status) + '</div>' : '') + '</td>' +
          '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ---- COMPLETED ----
  function rangeNote(el, shown, total, what) {
    const rg = rangeNow();
    el.innerHTML = rg.label
      ? what + ' in <b>' + esc(rg.label) + '</b>: ' + shown + ' of ' + total + ' ever' + (requestRange ? ' · <button type="button" class="act-link" data-all-dates>Show all dates</button>' : '')
      : total + ' ' + what.toLowerCase() + ' (all time)';
    el.querySelector('[data-all-dates]')?.addEventListener('click', () => requestRange('all'));
  }
  function renderCompleted() {
    const q = searchText();
    const all = allHolds.filter((h) => h.status === 'Completed' && matchesSearch(h, q));
    const rows = all.filter((h) => inRange(h.completed_at || h.hold_date)).sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')) || b.id - a.id);
    rangeNote($('lw-done-note'), rows.length, all.length, 'Completed');
    pagedTable('lw-list-completed', rows, pgDone, (page) =>
      '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th class="nw">Order</th><th>Customer</th><th>Items</th><th class="nw">Total</th><th class="nw">Final Payment</th><th class="nw">Completed</th><th class="nw">Processed By</th><th></th></tr></thead><tbody>' +
      page.map((h) => { const last = lastPayOf(h); return '<tr data-hold-id="' + h.id + '">' +
        '<td data-label="Order" class="nw">' + orderCell(h) + '</td>' +
        '<td data-label="Customer" class="full-row">' + customerLinkHtml(h.customer_name, h.contact_number) + '</td>' +
        '<td data-label="Items">' + itemsCell(h) + '</td>' +
        '<td data-label="Total" class="nw">' + money(h.total_price) + '</td>' +
        '<td data-label="Final Payment" class="nw">' + (last ? money(last.amount) + '<div class="muted" style="font-size:10px;">' + esc(last.payment_method) + ' · ' + fmtDate(last.paid_at) + '</div>' : '—') + '</td>' +
        '<td data-label="Completed" class="nw">' + doneDate(h.completed_at) + '</td>' +
        '<td data-label="Processed By" class="nw">' + esc((h.completer && h.completer.full_name) || (h.creator && h.creator.full_name) || '—') + '</td>' +
        '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View</button></td>' +
      '</tr>'; }).join('') + '</tbody></table></div>', renderCompleted, noneHtml('completed layaways' + (rangeNow().label ? ' in this date range' : '')));
  }

  // ---- FORFEITED (and cancelled) ----
  function renderForfeited() {
    const q = searchText();
    const forfAll = allHolds.filter((h) => h.status === 'Forfeited' && matchesSearch(h, q));
    const cancAll = allHolds.filter((h) => h.status === 'Cancelled' && matchesSearch(h, q));
    const forf = forfAll.filter((h) => inRange(h.forfeited_at || h.hold_date)).sort((a, b) => String(b.forfeited_at || '').localeCompare(String(a.forfeited_at || '')) || b.id - a.id);
    const canc = cancAll.filter((h) => inRange(h.cancelled_at || h.hold_date)).sort((a, b) => String(b.cancelled_at || '').localeCompare(String(a.cancelled_at || '')) || b.id - a.id);
    rangeNote($('lw-forf-note'), forf.length + canc.length, forfAll.length + cancAll.length, 'Forfeited or cancelled');
    $('lw-forfeited-count').textContent = '(' + forf.length + ')';
    $('lw-cancelled-count').textContent = '(' + canc.length + ')';
    const approvedReq = (h) => forfeitRequests.find((r) => r.hold_id === h.id && r.status === 'Approved');
    pagedTable('lw-list-forfeited', forf, pgForf, (page) =>
      '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th class="nw">Order</th><th>Customer</th><th>Items</th><th class="nw">Total</th><th class="nw">Paid</th><th class="nw">Balance Before Forfeit</th><th class="nw">Forfeit Date</th><th>Reason</th><th>Approved By</th><th></th></tr></thead><tbody>' +
      page.map((h) => { const info = infoOf(h), req = approvedReq(h); return '<tr data-hold-id="' + h.id + '">' +
        '<td data-label="Order" class="nw">' + orderCell(h) + '</td>' +
        '<td data-label="Customer" class="full-row">' + customerLinkHtml(h.customer_name, h.contact_number) + '</td>' +
        '<td data-label="Items">' + itemsCell(h) + '</td>' +
        '<td data-label="Total" class="nw">' + money(h.total_price) + '</td>' +
        '<td data-label="Paid" class="nw">' + money(info.paid) + '</td>' +
        '<td data-label="Balance Before Forfeit" class="nw">' + money(Math.max(Number(h.total_price || 0) - info.paid, 0)) + '</td>' +
        '<td data-label="Forfeit Date" class="nw">' + doneDate(h.forfeited_at) + '</td>' +
        '<td data-label="Reason" class="full-row" style="font-size:12px;">' + (req ? esc(req.reason) : '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Approved By" style="font-size:12px;">' + ([req && req.supervisorApprover && req.supervisorApprover.full_name, h.forfeiter && h.forfeiter.full_name].filter(Boolean).map(esc).join(' → ') || '<span class="muted">—</span>') + '</td>' +
        '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View</button></td>' +
      '</tr>'; }).join('') + '</tbody></table></div>', renderForfeited, noneHtml('forfeited layaways' + (rangeNow().label ? ' in this date range' : '')));
    pagedTable('lw-list-cancelled', canc, pgCanc, (page) =>
      '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th class="nw">Order</th><th>Customer</th><th>Items</th><th class="nw">Total</th><th class="nw">Paid</th><th class="nw">Cancelled</th><th class="nw">By</th><th></th></tr></thead><tbody>' +
      page.map((h) => '<tr data-hold-id="' + h.id + '">' +
        '<td data-label="Order" class="nw">' + orderCell(h) + '</td>' +
        '<td data-label="Customer" class="full-row">' + customerLinkHtml(h.customer_name, h.contact_number) + '</td>' +
        '<td data-label="Items">' + itemsCell(h) + '</td>' +
        '<td data-label="Total" class="nw">' + money(h.total_price) + '</td>' +
        '<td data-label="Paid" class="nw">' + money(paidSoFar(h)) + '</td>' +
        '<td data-label="Cancelled" class="nw">' + doneDate(h.cancelled_at) + '</td>' +
        '<td data-label="By" class="nw">' + esc((h.canceller && h.canceller.full_name) || '—') + '</td>' +
        '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View</button></td>' +
      '</tr>').join('') + '</tbody></table></div>', renderForfeited, noneHtml('cancelled layaways' + (rangeNow().label ? ' in this date range' : '')));
  }


  // ---- Monthly Monitoring: a wide, per-month rollup with a date-range-filtered
  // summary above it -- separate from the live filtered list above, which is about
  // finding one hold, not seeing the shape of the whole month/year. ----
  function renderMonthly() {
    const fFrom = document.getElementById('mm-from').value;
    const fTo = document.getElementById('mm-to').value;
    // Cancelled/Forfeited excluded here too, same as the On Hold list above --
    // otherwise a dead hold's value/paid amounts would still bleed into Total Value/
    // Total Paid/Remaining even with its own status column gone.
    let rows = allHolds.filter((h) => h.status !== 'Cancelled' && h.status !== 'Forfeited');
    if (fFrom) rows = rows.filter((h) => h.hold_date >= fFrom);
    if (fTo) rows = rows.filter((h) => h.hold_date <= fTo);

    const totalValue = rows.reduce((s, h) => s + Number(h.total_price || 0), 0);
    const totalPaid = rows.reduce((s, h) => s + paidSoFar(h), 0);
    document.getElementById('mm-tiles').innerHTML =
      tile(rows.length, 'Total Layaway Hold') +
      tile(money(totalValue), 'Total Value') +
      tile(money(totalPaid), 'Total Paid') +
      tile(money(totalValue - totalPaid), 'Total Remaining');

    const byMonth = {};
    rows.forEach((h) => {
      const key = (h.hold_date || '').slice(0, 7); // "YYYY-MM"
      if (!key) return;
      const m = byMonth[key] || (byMonth[key] = { onHold: 0, completed: 0, count: 0, value: 0, paid: 0 });
      m.count++;
      m.value += Number(h.total_price || 0);
      m.paid += paidSoFar(h);
      if (h.status === 'On Hold') m.onHold++;
      else if (h.status === 'Completed') m.completed++;
      // Cancelled holds are excluded from this rollup for now too (Ren, 2026-09-16:
      // "still cancelled show in the layaway in the POS" -- referring to this table's
      // own Cancelled column, kept the first time around since it's an aggregate
      // count rather than individual rows; removed now to match "remove cancelled...
      // for now" fully).
    });
    // Filtering (the date range above) picks which months are included; sort only
    // reorders them -- Total Holds/Value/Paid/Remaining stay whatever the range
    // produced regardless of sort field (spec section 11).
    const monthRows = applySort(Object.keys(byMonth).map((key) => ({ month: key, ...byMonth[key] })), mmSort, MM_SORT_COMPARATORS);
    const box = document.getElementById('mm-table');
    if (!monthRows.length) { box.innerHTML = '<p class="muted">No layaway holds for this range.</p>'; return; }
    box.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Month</th><th>Total Holds</th><th>On Hold</th><th>Completed</th><th>Total Value</th><th>Total Paid</th><th>Remaining</th></tr></thead><tbody>' +
      monthRows.map((m) => {
        const key = m.month;
        const label = new Date(key + '-02').toLocaleDateString('en-PH', { year: 'numeric', month: 'long' });
        return '<tr>' +
          '<td data-label="Month"><b>' + label + '</b></td>' +
          '<td data-label="Total Holds">' + m.count + '</td>' +
          '<td data-label="On Hold">' + m.onHold + '</td>' +
          '<td data-label="Completed">' + m.completed + '</td>' +
          '<td data-label="Total Value">' + money(m.value) + '</td>' +
          '<td data-label="Total Paid">' + money(m.paid) + '</td>' +
          '<td data-label="Remaining">' + money(m.value - m.paid) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ---- PAYMENTS: every payment by its OWN date (Ren, 2026-09-18), inside the page's date range -- listed one by one, not rolled into a
  // number. Every hold regardless of status is included: a payment that actually happened stays on this ledger even if the hold it was
  // against was later cancelled. Search covers customer, order, SKU, item, reference and who recorded it. ----
  function renderMonthlyPayments() {
    const box = document.getElementById('mm-payments-table');
    const q = searchText();
    const rg = rangeNow();
    const fMethod = $('mm-pay-f-method').value, fStatus = $('mm-pay-f-status').value, fRef = $('mm-pay-f-ref').value;
    const recordedByEl = $('mm-pay-f-recordedby');
    const fRecordedBy = recordedByEl.value;
    const inPeriod = allPayments().filter((p) => !rg.from || (p.paid_at >= rg.from && p.paid_at <= rg.to));
    // Recorded By's options are real data, rebuilt from whatever is in range, but only when that set changes, so a mid-typing selection survives.
    const names = [...new Set(inPeriod.map((p) => p.recordedBy).filter(Boolean))].sort();
    if (recordedByEl.dataset.optionsFor !== names.join('|')) {
      recordedByEl.dataset.optionsFor = names.join('|');
      recordedByEl.innerHTML = '<option value="all">All</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
      recordedByEl.value = names.includes(fRecordedBy) ? fRecordedBy : 'all';
    }
    let filtered = inPeriod;
    if (q) filtered = filtered.filter((p) => matchesSearch(p.hold, q) || String(p.amount).includes(q));
    if (fMethod !== 'all') filtered = filtered.filter((p) => p.payment_method === fMethod);
    if (fStatus !== 'all') filtered = filtered.filter((p) => p.paymentStatus === fStatus);
    if (fRef === 'missing') filtered = filtered.filter(isMissingRef);
    if (recordedByEl.value !== 'all') filtered = filtered.filter((p) => p.recordedBy === recordedByEl.value);

    const activeEl = $('mm-pay-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Method', value: fMethod === 'all' ? '' : esc(fMethod) }, { label: 'Status', value: fStatus === 'all' ? '' : esc(fStatus) },
      { label: 'Reference', value: fRef === 'missing' ? 'Missing (non-cash)' : '' }, { label: 'Recorded By', value: recordedByEl.value === 'all' ? '' : esc(recordedByEl.value) },
    ], 'mm-pay-f-clear');
    wireProxyButtons(activeEl);

    // Summary cards follow the same filters as the table.
    const today = manilaToday();
    const sumOf = (list) => list.reduce((s, p) => s + Number(p.amount || 0), 0);
    const total = sumOf(filtered); // the total follows the FILTERS, not the sort (section 11)
    const downs = filtered.filter((p) => p.paymentStatus === 'Downpayment');
    const fulls = filtered.filter((p) => p.paymentStatus === 'Paid in Full');
    const stat = (label, value, sub) => '<div class="lw-card static"><span class="lw-card-l">' + label + '</span><span class="lw-card-n">' + value + '</span>' + (sub ? '<span class="lw-card-s">' + sub + '</span>' : '') + '</div>';
    $('mm-pay-tiles').innerHTML =
      stat('Payments Today', money0(sumOf(filtered.filter((p) => p.paid_at === today))), 'received today') +
      stat('Collected This Period', money0(total), rg.label ? esc(rg.label) : 'all time') +
      stat('Downpayments', money0(sumOf(downs)), plural2(downs.length, 'payment')) +
      stat('Paid in Full', fulls.length, 'closing payments') +
      stat('Payment Count', filtered.length, 'payments');

    const sorted = applySort(filtered, mmPaySort, MM_PAY_SORT_COMPARATORS);
    if (!sorted.length) {
      const rangeLabel = rg.label;
      box.innerHTML = '<p class="muted">No payments match these filters' + (rangeLabel ? ' for ' + esc(rangeLabel) : '') + '.</p>' +
        (rangeLabel && requestRange ? '<button type="button" class="btn small secondary" id="mm-pay-all-dates">Search all dates</button>' : '');
      box.querySelector('#mm-pay-all-dates')?.addEventListener('click', () => requestRange('all'));
      return;
    }
    pagedTable('mm-payments-table', sorted, pgPay, (page) =>
      '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th class="nw">Date</th><th class="nw">Order</th><th>Customer</th><th>SKU</th><th class="nw">Amount</th><th class="nw">Method</th><th>Reference</th><th class="nw">Status</th><th class="nw">Recorded By</th></tr></thead><tbody>' +
      page.map((p) => '<tr data-hold-id="' + p.hold.id + '">' +
        '<td data-label="Date" class="nw">' + fmtDate(p.paid_at) + '</td>' +
        '<td data-label="Order" class="nw">' + esc(p.hold.order_id || '—') + '</td>' +
        '<td data-label="Customer" class="full-row">' + customerLinkHtml(p.hold.customer_name, p.hold.contact_number) + '</td>' +
        '<td data-label="SKU">' + esc(p.hold.sku) + '</td>' +
        '<td data-label="Amount" class="nw"><b>' + money(p.amount) + '</b></td>' +
        '<td data-label="Method" class="nw">' + esc(p.payment_method) + '</td>' +
        '<td data-label="Reference">' + (p.reference_number ? esc(p.reference_number) : (isMissingRef(p) ? '<span class="badge st-yellow" style="font-size:9px;">missing</span>' : '—')) + (p.notes ? '<div class="muted" style="font-size:10px;">' + esc(p.notes) + '</div>' : '') + '</td>' +
        '<td data-label="Status" class="nw"><span class="badge ' + (p.paymentStatus === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:10px;">' + p.paymentStatus + '</span></td>' +
        '<td data-label="Recorded By" class="nw">' + (p.employees ? esc(p.employees.full_name) : '—') + '</td>' +
      '</tr>').join('') +
      '</tbody><tfoot><tr style="font-weight:bold;background:#f7f7f7;"><td colspan="4">Total · ' + sorted.length + ' payment' + (sorted.length === 1 ? '' : 's') + '</td><td class="nw">' + money(total) + '</td><td colspan="4"></td></tr></tfoot>' +
      '</table></div>', renderMonthlyPayments, '');
  }

  // ---- Forfeiture Watch: every still-On-Hold item, most urgent first, with the dates that
  // matter (Date Purchased, Forfeit Date + who last moved it), what is still owed, the days
  // left, the status, the last payment and the last time the customer was contacted. Yellow =
  // nearing the deadline, red = overdue. Nothing here forfeits anything by itself -- an overdue
  // row offers "Request Forfeit" (Supervisor approves, Admin gives the final approval).
  // Forfeit Date defaults to the layaway date + N months (Settings) but staff who can act on
  // the hold can move it per item -- every change is logged (layaway_forfeit_date_log, embedded
  // by listLayaways()) and shown right there, so it is always visible who moved a deadline and
  // when. Independent of the date-range filter above -- this is about what needs attention
  // right now, not a historical range. ----
  function renderForfeitureWatch() {
    // Sorted most-urgent-first: already-overdue items surface above ones still safely within
    // their window, matching what a forfeiture watch list is for. effectiveForfeit/daysPastForfeit
    // are computed once up front so both the sort and the columns can use them.
    const q = searchText();
    const unsorted = allHolds
      .filter((h) => h.status === 'On Hold' && matchesSearch(h, q))
      .map((h) => {
        const effectiveForfeit = h.forfeit_date || defaultForfeitDate(h.hold_date);
        return { h, effectiveForfeit, daysPastForfeit: daysSince(effectiveForfeit) };
      })
      .filter((x) => matchesDueFilter(infoOf(x.h), dueFilter));
    // The sections keep their order (most urgent first); the chosen sort orders the rows INSIDE each section.
    const sectionOrder = DUE_SECTIONS.map((s) => s[0]);
    const rows = applySort(unsorted, fwSort, fwSortComparators()).sort((a, b) => sectionOrder.indexOf(bucketOf(a.h)) - sectionOrder.indexOf(bucketOf(b.h)));

    const box = document.getElementById('fw-table');
    if (!rows.length) { box.innerHTML = '<p class="muted">' + (dueFilter === 'all' && !q ? 'No items currently on hold.' : 'No layaways match this view.') + '</p>'; return; }
    const pageInfo = pageSlice(rows, pgDue);
    const tableHead = '<div class="table-scroll table-2col"><table class="lw-watch" style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:8%"><col style="width:6%"><col style="width:9%"><col style="width:9%"><col style="width:6%"><col style="width:8%"><col style="width:6%"><col style="width:7%"><col style="width:13%"><col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:6%"></colgroup>' +
      '<thead><tr><th>Date Purchased</th><th>Order</th><th>SKU / Item</th><th>Customer</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Days Remaining</th><th>Forfeit Date</th><th>Status</th><th>Last Payment</th><th>Last Reminder</th><th></th></tr></thead><tbody>';
    const rowHtml = ({ h, effectiveForfeit, daysPastForfeit }) => {
        const info = infoOf(h);
        const canAct = canManage || employee.branch_id === h.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        const history = (h.layaway_forfeit_date_log || []).slice().sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
        const lastEdit = history.length ? history[history.length - 1] : null;
        const hdHistory = (h.layaway_hold_date_log || []).slice().sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
        const hdLastEdit = hdHistory.length ? hdHistory[hdHistory.length - 1] : null;
        const pendingForfeit = pendingForfeitRequests.find((r) => r.hold_id === h.id);
        const openReq = openForfeitByHold[h.id];
        const payments = (h.layaway_payments || []).slice().sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || '') || b.id - a.id);
        const lastPay = payments[0];
        const reminders = remindersOf(h);
        const canRequestForfeit = canAct && !openReq && (info.overdue || canFinalDelete);
        return '<tr class="lw-row' + (info.rowTone ? ' lw-row-' + info.rowTone : '') + '">' +
          '<td data-label="Date Purchased">' +
            // Fixed once set (Ren, 2026-09-17: "once they add date of the layaway not
            // its already fix") -- only Admin can still correct it; everyone else
            // gets a plain read-only date, matching set_layaway_hold_date()'s own
            // Admin-only gate.
            (canFinalDelete
              ? '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">' +
                  '<input type="date" class="fw-hold-date-input" data-hold-id="' + h.id + '" value="' + h.hold_date + '" style="font-size:12px;padding:3px 5px;border:1px solid #ddd;border-radius:6px;">' +
                  '<button type="button" class="btn small secondary fw-hold-date-save" data-hold-id="' + h.id + '" style="padding:2px 8px;">Save</button>' +
                '</div>'
              : fmtDate(h.hold_date)) +
            (hdLastEdit
              ? '<div class="muted" style="font-size:10px;margin-top:2px;">Edited by ' + esc(hdLastEdit.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(hdLastEdit.changed_at) + '</div>'
              : '<div class="muted" style="font-size:10px;margin-top:2px;">Never edited</div>') +
            (hdHistory.length
              ? '<button type="button" class="btn small secondary fw-hold-date-history" data-hold-id="' + h.id + '" aria-expanded="false" style="font-size:10px;padding:1px 6px;margin-top:2px;"><span class="exp-arrow" aria-hidden="true" style="width:7px;">▸</span> History (' + hdHistory.length + ')</button>' +
                '<div class="fw-hold-date-history-list" data-hold-id="' + h.id + '" style="display:none;font-size:10px;margin-top:4px;border-top:1px dashed #ddd;padding-top:4px;">' +
                  hdHistory.map((l) => (l.old_date ? fmtDate(l.old_date) : '<span class="muted">—</span>') + ' → <strong>' + fmtDate(l.new_date) + '</strong> by ' + esc(l.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(l.changed_at)).join('<br>') +
                '</div>'
              : '') +
          '</td>' +
          '<td data-label="Order">' + esc(h.order_id || '—') +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') + '</td>' +
          '<td data-label="SKU / Item">' + esc(h.sku) +
            (h.stock_status === 'Lacking' ? ' <span class="badge low" title="Not physically in stock yet -- needs to be sourced before this can be completed">Lacking</span>' : '') +
            (itemNames[h.sku] ? '<div class="muted" style="font-size:10px;">' + esc(itemNames[h.sku]) + '</div>' : '') + '</td>' +
          '<td data-label="Customer">' + customerLinkHtml(h.customer_name, h.contact_number) +
            (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Total">' + money(h.total_price) + '</td>' +
          '<td data-label="Paid">' + money(info.paid) + '<div class="lw-prog">' + progressHtml(info.pct) + '</div></td>' +
          '<td data-label="Remaining">' + (info.remaining !== null ? money(info.remaining) : '—') + '</td>' +
          '<td data-label="Days Remaining">' + (info.daysText ? '<span class="' + daysClass(info) + '">' + esc(info.daysText) + '</span>' : '—') + '</td>' +
          '<td data-label="Forfeit Date" class="full-row">' +
            // Admin edits directly; anyone else who can act on this hold submits a
            // request instead (Ren, 2026-09-17: "for approval of me if they want to
            // edit it") -- set_layaway_forfeit_date() is Admin-only server-side too,
            // so this isn't just a UI-level restriction.
            (canFinalDelete
              ? '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">' +
                  '<input type="date" class="fw-forfeit-input" data-hold-id="' + h.id + '" value="' + effectiveForfeit + '" style="font-size:12px;padding:3px 5px;border:1px solid #ddd;border-radius:6px;">' +
                  '<button type="button" class="btn small secondary fw-forfeit-save" data-hold-id="' + h.id + '" style="padding:2px 8px;">Save</button>' +
                '</div>'
              : canAct
                ? '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">' +
                    '<input type="date" class="fw-forfeit-request-input" data-hold-id="' + h.id + '" value="' + effectiveForfeit + '" style="font-size:12px;padding:3px 5px;border:1px solid #ddd;border-radius:6px;">' +
                    '<button type="button" class="btn small secondary fw-forfeit-request" data-hold-id="' + h.id + '" style="padding:2px 8px;">Request Change</button>' +
                  '</div>'
                : fmtDate(effectiveForfeit)) +
            (pendingForfeit
              ? '<div class="muted" style="font-size:10px;margin-top:2px;">Pending: → ' + fmtDate(pendingForfeit.proposed_date) + ' (awaiting Admin approval)</div>'
              : '') +
            (lastEdit
              ? '<div class="muted" style="font-size:10px;margin-top:2px;">Edited by ' + esc(lastEdit.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(lastEdit.changed_at) + '</div>'
              : '<div class="muted" style="font-size:10px;margin-top:2px;">Never edited (default ' + getOpsConfig().forfeitMonths + '-month date)</div>') +
            (history.length
              ? '<button type="button" class="btn small secondary fw-forfeit-history" data-hold-id="' + h.id + '" aria-expanded="false" style="font-size:10px;padding:1px 6px;margin-top:2px;"><span class="exp-arrow" aria-hidden="true" style="width:7px;">▸</span> History (' + history.length + ')</button>' +
                '<div class="fw-forfeit-history-list" data-hold-id="' + h.id + '" style="display:none;font-size:10px;margin-top:4px;border-top:1px dashed #ddd;padding-top:4px;">' +
                  history.map((l) => (l.old_date ? fmtDate(l.old_date) : '<span class="muted">default</span>') + ' → <strong>' + fmtDate(l.new_date) + '</strong> by ' + esc(l.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(l.changed_at)).join('<br>') +
                '</div>'
              : '') +
          '</td>' +
          '<td data-label="Status">' + statusChipHtml(info) + (openReq ? '<div class="muted" style="font-size:10px;margin-top:2px;">' + esc(openReq.status) + '</div>' : '') + '</td>' +
          '<td data-label="Last Payment" style="font-size:11px;">' + (lastPay
            ? money(lastPay.amount) + ' · ' + esc(lastPay.payment_method) + '<div class="muted" style="font-size:10px;">' + fmtDate(lastPay.paid_at) + (lastPay.employees ? ' · ' + esc(lastPay.employees.full_name) : '') + '</div>'
            : '<span class="muted">No payments yet</span>') + '</td>' +
          '<td data-label="Last Reminder" class="full-row" style="font-size:11px;">' + (reminders.length ? lastContactText(reminders) : '<span class="muted">Never</span>') + '</td>' +
          '<td class="full-row"><div style="display:flex;flex-direction:column;gap:4px;">' +
            '<button type="button" class="btn small secondary fw-view" data-hold-id="' + h.id + '">View Details</button>' +
            (canRequestForfeit ? '<button type="button" class="btn small secondary ' + (canFinalDelete ? 'fw-forfeit-now' : 'fw-forfeit-ask') + '" data-hold-id="' + h.id + '">' + (canFinalDelete ? 'Forfeit…' : 'Request Forfeit') + '</button>' : '') +
          '</div></td>' +
        '</tr>';
    };
    // One pager over the whole list (most urgent first); a heading starts each section (Overdue / Due today / Due in 3 days / ...) and
    // its count is the section's full size, not just what is on this page.
    const counts = {};
    rows.forEach((x) => { const b = bucketOf(x.h); counts[b] = (counts[b] || 0) + 1; });
    let html = '', current = null;
    pageInfo.rows.forEach((x) => {
      const b = bucketOf(x.h);
      if (b !== current) {
        if (current) html += '</tbody></table></div>';
        const sec = DUE_SECTIONS.find((s) => s[0] === b);
        html += '<h4 class="lw-due-h tone-' + sec[2] + '">' + sec[1] + ' <span class="exp-count">(' + counts[b] + ')</span></h4>' + tableHead;
        current = b;
      }
      html += rowHtml(x);
    });
    if (current) html += '</tbody></table></div>';
    box.innerHTML = html + pagerHtml(pageInfo);
    wirePager(box, pgDue, renderForfeitureWatch);

    box.querySelectorAll('.fw-forfeit-save').forEach((btn) => btn.addEventListener('click', async () => {
      const holdId = Number(btn.dataset.holdId);
      const input = box.querySelector('.fw-forfeit-input[data-hold-id="' + holdId + '"]');
      if (!input.value) { notify('Pick a date first.', true); return; }
      btn.disabled = true;
      try {
        await setLayawayForfeitDate(holdId, input.value);
        notify('Forfeit date updated.', false);
        await load();
      } catch (err) {
        notify(String(err.message || err), true);
        btn.disabled = false;
      }
    }));
    box.querySelectorAll('.fw-forfeit-request').forEach((btn) => btn.addEventListener('click', async () => {
      const holdId = Number(btn.dataset.holdId);
      const input = box.querySelector('.fw-forfeit-request-input[data-hold-id="' + holdId + '"]');
      if (!input.value) { notify('Pick a date first.', true); return; }
      const out = await reasonDialog({ title: 'Request a new forfeit date', message: 'New date: ' + fmtDate(input.value) + '. Admin has to approve the change.', label: 'Why does it need to move?', confirmLabel: 'Send request' });
      if (!out) return;
      btn.disabled = true;
      try {
        await requestLayawayForfeitDate(holdId, input.value, out.reason);
        notify('Forfeit date change submitted -- awaiting Admin approval.', false);
        await loadPendingForfeitRequests();
        renderForfeitureWatch();
      } catch (err) {
        notify(String(err.message || err), true);
        btn.disabled = false;
      }
    }));
    box.querySelectorAll('.fw-view').forEach((btn) => btn.addEventListener('click', () => openDetail(Number(btn.dataset.holdId))));
    box.querySelectorAll('.fw-forfeit-ask').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Request forfeiture', message: 'This layaway is past its deadline. A Supervisor reviews the request, then Admin gives the final approval -- nothing is forfeited until then.', label: 'Why should it be forfeited?', confirmLabel: 'Send request' });
      if (!out) return;
      await runAction(() => requestLayawayForfeit(Number(btn.dataset.holdId), out.reason), 'Forfeiture requested -- waiting for a Supervisor.');
    }));
    box.querySelectorAll('.fw-forfeit-now').forEach((btn) => btn.addEventListener('click', async () => {
      const out = await reasonDialog({ title: 'Forfeit this layaway', message: 'The customer loses the item: it is marked Forfeited and goes back to available stock. Payments already made stay on record.', label: 'Reason', confirmLabel: 'Forfeit', danger: true });
      if (!out) return;
      await runAction(async () => { const id = await requestLayawayForfeit(Number(btn.dataset.holdId), out.reason); await approveLayawayForfeitFinal(id); }, 'Layaway forfeited.');
    }));
    box.querySelectorAll('.fw-forfeit-history').forEach((btn) => btn.addEventListener('click', () => {
      const div = box.querySelector('.fw-forfeit-history-list[data-hold-id="' + btn.dataset.holdId + '"]');
      const opening = div.style.display === 'none';
      div.style.display = opening ? '' : 'none';
      btn.setAttribute('aria-expanded', String(opening));
    }));
    box.querySelectorAll('.fw-hold-date-save').forEach((btn) => btn.addEventListener('click', async () => {
      const holdId = Number(btn.dataset.holdId);
      const input = box.querySelector('.fw-hold-date-input[data-hold-id="' + holdId + '"]');
      if (!input.value) { notify('Pick a date first.', true); return; }
      btn.disabled = true;
      try {
        await setLayawayHoldDate(holdId, input.value);
        notify('Date Purchased updated.', false);
        await load();
      } catch (err) {
        notify(String(err.message || err), true);
        btn.disabled = false;
      }
    }));
    box.querySelectorAll('.fw-hold-date-history').forEach((btn) => btn.addEventListener('click', () => {
      const div = box.querySelector('.fw-hold-date-history-list[data-hold-id="' + btn.dataset.holdId + '"]');
      const opening = div.style.display === 'none';
      div.style.display = opening ? '' : 'none';
      btn.setAttribute('aria-expanded', String(opening));
    }));
    wireCustomerLinks(box);
  }

  // Which Due / Forfeiture sections to show (the "Show" box, and the cards / Needs Attention items that open this tab on one of them).
  function matchesDueFilter(info, f) {
    if (f === 'all') return true;
    if (info.key === 'PAID IN FULL') return f === 'later'; // nothing is due on a layaway that is fully paid
    const d = info.days;
    if (f === 'overdue') return d < 0;
    if (f === 'today') return d === 0;
    if (f === 'soon') return d >= 0 && d <= 7;
    if (f === 'nearing') return d >= 0 && d <= getOpsConfig().nearingDays;
    if (f === 'later') return d > 7;
    return true;
  }
  const bucketOf = (h) => { const i = infoOf(h); return i.key === 'PAID IN FULL' ? 'later' : dueBucket(i.days); };
  /** The last payment on an order (any of its items), for the Customers to Remind table. */
  function lastPayForOrder(o) {
    const h = allHolds.find((x) => x.id === o.first_hold_id);
    const members = h ? ((h.group_id ? groupMembers[h.group_id] : null) || [h]) : [];
    return members.flatMap((m) => m.layaway_payments || []).sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || '') || b.id - a.id)[0] || null;
  }

  // ---- Customers to Remind (Ren, 2026-10-07). Who is due a reminder (the rule lives in layaway_reminder_queue(): the deadline is within
  // the largest reminder stage, and no reminder has gone out for the stage reached). "Remind Customer" shows the message and lets the
  // person copy it and mark who contacted the customer; nothing is ever sent from here. ----
  function renderReminders() {
    const folder = document.getElementById('lw-remind-folder');
    const box = document.getElementById('lw-remind-list');
    const countEl = document.getElementById('lw-remind-count');
    if (!folder || !box) return;
    const q = searchText();
    const queue = remindQueue.filter((o) => !q || [o.customer_name, o.contact_number, o.alt_contact_number, o.order_ids].filter(Boolean).join(' ').toLowerCase().includes(q));
    const due = queue.filter((o) => o.due);
    const rest = queue.filter((o) => !o.due);
    countEl.textContent = '(' + due.length + ' due' + (rest.length ? ', ' + rest.length + ' contacted recently' : '') + ')';
    const prev = Number(folder.dataset.count || 0);
    folder.dataset.count = String(due.length);
    folder.classList.toggle('has-pending', due.length > 0);
    if (due.length > 0 && prev === 0) folder.open = true;
    if (due.length === 0 && prev > 0) folder.open = false;
    const show = remindShowAll ? queue : due;
    if (!show.length) {
      box.innerHTML = '<p class="muted" style="margin:0;">' + (queue.length ? 'Everyone in the reminder window has been contacted for their current stage.' : 'No customers are within the reminder window (' + getOpsConfig().reminderStages.slice().sort((a, b) => b - a)[0] + ' days before the deadline, or overdue).') + '</p>' +
        (rest.length ? '<button type="button" class="btn small secondary" data-act="toggle-remind-all" style="margin-top:8px;">Show contacted (' + rest.length + ')</button>' : '');
      box.querySelector('[data-act="toggle-remind-all"]')?.addEventListener('click', () => { remindShowAll = true; renderReminders(); });
      return;
    }
    const canContact = (o) => canManage || employee.branch_id === o.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
    box.innerHTML = '<div class="table-scroll table-2col"><table class="sc-table lw-tbl">' +
      '<thead><tr><th>Customer</th><th class="nw">Contact</th><th class="nw">Order</th><th class="nw">Outstanding</th><th class="nw">Deadline</th><th class="nw">Days Left</th><th class="nw">Last Payment</th><th>Last Reminder</th><th></th></tr></thead><tbody>' +
      show.map((o, i) => {
        const overdue = o.days_remaining < 0;
        const lastBy = o.last_reminder_by ? (peopleById[o.last_reminder_by] || '') : '';
        const lp = lastPayForOrder(o);
        return '<tr class="lw-row' + (overdue ? ' lw-row-red' : (o.days_remaining <= 6 ? ' lw-row-orange' : (o.days_remaining <= getOpsConfig().nearingDays ? ' lw-row-yellow' : ''))) + '">' +
          '<td data-label="Customer" class="full-row">' + customerLinkHtml(o.customer_name, o.contact_number) + (o.lines > 1 ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;">' + o.lines + ' items</span>' : '') + '</td>' +
          '<td data-label="Contact" class="nw">' + esc(o.contact_number || '—') + (o.alt_contact_number ? '<div class="muted" style="font-size:10px;">alt ' + esc(o.alt_contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Order" class="nw">' + esc(o.order_ids || '—') + '</td>' +
          '<td data-label="Outstanding" class="nw"><b>' + money(o.balance) + '</b></td>' +
          '<td data-label="Deadline" class="nw">' + fmtDate(o.deadline) + '</td>' +
          '<td data-label="Days Left" class="nw"><span class="lw-days ' + daysToneOf(o.days_remaining) + '">' + esc(daysText(o.days_remaining)) + '</span></td>' +
          '<td data-label="Last Payment" class="nw" style="font-size:11px;">' + (lp ? money(lp.amount) + '<div class="muted" style="font-size:10px;">' + fmtDate(lp.paid_at) + '</div>' : '<span class="muted">None yet</span>') + '</td>' +
          '<td data-label="Last Reminder" class="full-row" style="font-size:11px;">' + (o.last_reminder_at ? fmtDateTime(o.last_reminder_at) + (o.last_channel ? ' · ' + esc(o.last_channel) : '') + (lastBy ? '<div class="muted" style="font-size:10px;">by ' + esc(lastBy) + '</div>' : '') : '<span class="muted">Never</span>') + '</td>' +
          '<td class="full-row nw">' + (canContact(o) ? '<button type="button" class="btn small" data-act="remind" data-i="' + i + '">Remind Customer</button>' : '<button type="button" class="btn small secondary" data-act="remind" data-i="' + i + '">See Message</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (rest.length ? '<button type="button" class="btn small secondary" data-act="toggle-remind-all" style="margin-top:8px;">' + (remindShowAll ? 'Hide contacted' : 'Show contacted (' + rest.length + ')') + '</button>' : '');
    box.querySelectorAll('[data-act="remind"]').forEach((b) => b.addEventListener('click', () => remindCustomer(show[Number(b.dataset.i)])));
    box.querySelector('[data-act="toggle-remind-all"]')?.addEventListener('click', () => { remindShowAll = !remindShowAll; renderReminders(); });
    wireCustomerLinks(box);
  }

  function tile(num, label, tone) { return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>'; }

  const unsubscribe = subscribeToChanges(['layaway_holds', 'layaway_payments', 'layaway_forfeit_date_log', 'layaway_hold_date_log', 'layaway_forfeit_date_requests'], load);
  await load();

  // Needs Attention / summary-card click (and the Branch Dashboard's cards): take the person straight to what was clicked --
  // overdue and nearing items open Due / Forfeiture on that section, pending requests open Requests, items waiting for stock are the
  // Lacking rows of On Hold, and "onhold" / "payments" open those tabs.
  function applyView(view) {
    if (view === 'overdue' || view === 'nearing') { setDueFilter(view); setSubTab('due'); }
    else if (view === 'lacking') { setQuick('all'); $('lw-f-status').value = 'lacking'; renderActive(); }
    else if (view === 'reminders') { setDueFilter('all'); setSubTab('due'); const f = $('lw-remind-folder'); if (f) f.open = true; }
    else if (view === 'approvals') setSubTab(canSeeRequests ? 'requests' : 'onhold');
    else if (view === 'onhold') setQuick('all');
    else if (view === 'payments') setSubTab('payments');
    else setSubTab('overview');
    ($('lw-subtabs') || root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec 321) can open this hold's own Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail, applyView };
}
