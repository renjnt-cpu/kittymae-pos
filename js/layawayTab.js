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
} from './api.js?v=20261007k';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20261007k';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, byDate, localDateStr, flagInvalid } from './uiKit.js?v=20261007k';
import { daysBetween, manilaToday } from './opsDates.js?v=20261007k';
import { getOpsConfig, layawayDeadline } from './branchOpsConfig.js?v=20261007k';
import { confirmDialog, reasonDialog, ERROR_TYPES } from './dialogs.js?v=20261007k';
import { layawayInfo, statusChipHtml, progressHtml, paidOf, daysText, ACTIVE_STATUSES } from './layawayStatus.js?v=20261007k';
import { openCustomerHistory } from './customerHistory.js?v=20261007k';

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

// 3 fixed slots (same pattern as this page's own Scrap/Subasta forms) instead of a
// dynamic add/remove list -- a layaway downpayment is rarely split more than 2 ways.
// Slots left blank/zero are just skipped on submit.
function paymentSlotsHtml() {
  let html = '';
  for (let i = 0; i < 3; i++) {
    const label = i === 0 ? 'Downpayment' : 'Downpayment ' + (i + 1);
    html +=
      '<div class="field"><label>' + label + ' Mode of Payment' + (i === 0 ? '' : ' (optional)') + '</label><select name="lwPayMethod' + i + '">' +
        '<option value="">— none —</option>' +
        PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>' + label + ' Amount</label><input type="number" name="lwPayAmount' + i + '" step="0.01" min="0"></div>' +
      '<div class="field"><label>' + label + ' Reference Number</label><input type="text" name="lwPayReference' + i + '"></div>' +
      '<div class="field"><label>' + label + ' Proof of Payment</label><input type="file" name="lwPayProof' + i + '" accept="image/*,.pdf"></div>';
  }
  return html;
}
function readPaymentSlots(f) {
  const payments = [];
  for (let i = 0; i < 3; i++) {
    const method = f['lwPayMethod' + i]?.value;
    const amount = Number(f['lwPayAmount' + i]?.value || 0);
    if (method && amount > 0) payments.push({
      method, amount, reference: f['lwPayReference' + i]?.value.trim() || '',
      file: f['lwPayProof' + i]?.files[0] || null,
    });
  }
  return payments;
}

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

  function notify(text, isError) {
    toast(msgId, text, isError);
    document.getElementById(msgId).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  root.innerHTML =
    // Status now leads the whole tab, full width, ahead of Hold Item Entry (Ren,
    // 2026-09-21, section 110/116: "Status section must appear directly after Sales
    // Summary... Hold Item Entry is still required, but it must now appear after the
    // Status section" -- the earlier .layout-2col arrangement paired Hold Item Entry
    // and Status side-by-side in two columns, which can't express an "above/below"
    // order at desktop widths at all; this drops that two-column wrapper for this tab
    // in favor of one straight top-to-bottom flow of full-width sections, which is
    // also what "landscape" (section 111-118) means for a many-column record: give it
    // the whole width instead of a cramped 300px sidebar. One folder per status
    // besides On Hold itself (Ren, 2026-09-16: "make a folder per layaway status for
    // cancelled, delete, completed, on hold"), collapsed by default. The On Hold
    // list's own Search box further narrows what shows inside each.
    // MASTER UI rule 2 (Ren, 2026-09-21) sets the order for every branch module:
    // primary action, then Summary, then Search & Filters, then Status navigation,
    // then Records -- so "+ New Layaway" leads, the On Hold summary/search/list come
    // next, the per-status folders follow them, and the Monthly Monitoring and
    // Forfeiture Watch reports close the tab.

    // Form Drawer (Ren's UI redesign pilot, section 203: "The current Hold Item form
    // takes too much vertical space... Replace: Hold Item(s) long form on page, with:
    // [+ New Layaway]... Open a right-side drawer") -- same fields as before, grouped
    // into labeled sections, submit button relocated to a sticky footer via
    // form="lw-form" (a submit button outside its <form> tag, tied to it by id, is
    // standard HTML -- nothing about the form's own submit handler below changes).
    '<button type="button" class="btn" id="lw-new-btn" style="margin-top:20px;">+ New Layaway</button>' +
    '<div class="drawer-backdrop" id="lw-form-backdrop"></div>' +
    '<div class="drawer" id="lw-form-drawer">' +
      '<div class="drawer-header"><h3>New Layaway</h3><button type="button" class="drawer-close" id="lw-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<p class="muted" style="margin-top:0;">Each item leaves the sellable pool immediately (moves to Reserved) but stays on hand until either completed as a sale or cancelled. Add more than one item to hold a whole order for one customer at once.</p>' +
        '<form id="lw-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="drawer-section">' +
            '<h4>Item(s)</h4>' +
            '<label style="font-size:13px;font-weight:600;">Items *</label>' +
            '<div id="lw-items"></div>' +
            '<button type="button" class="btn small secondary" id="lw-add-item" style="align-self:flex-start;margin-top:-4px;">+ Add another item</button>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Customer</h4>' +
            '<div class="field"><label>Order ID</label><input type="text" name="orderId"></div>' +
            // Defaults to today but editable -- lets staff backdate a hold that's only
            // being encoded now for an item actually held earlier (Ren, 2026-09-21:
            // "under layaway hold item add date"), same reasoning as Add Payment's own
            // Date Paid field. Previously hold_date always silently defaulted to
            // CURRENT_DATE with no way to set it at creation time -- fixing it after
            // the fact required an Admin to use Forfeiture Watch's own Date Purchased
            // editor.
            '<div class="field"><label>Date</label><input type="date" name="holdDate" value="' + localDateStr() + '"></div>' +
            '<div class="field"><label>Customer Name *</label><input type="text" name="customerName" required></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber"></div>' +
            '<div class="field"><label>Alternative Contact Number (optional)</label><input type="text" name="altContactNumber"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Payment</h4>' +
            paymentSlotsHtml() +
            '<div class="field"><label>Payment Notes (optional)</label><input type="text" name="paymentNotes"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Forfeit &amp; Handling</h4>' +
            '<div class="field"><label>Forfeit Date (optional)</label><input type="date" name="forfeitDate"></div>' +
            '<div class="field"><label>Admin (Handled By)</label><select name="handledBy"><option value="">— none —</option>' +
              staff.map((s) => '<option value="' + s.id + '"' + (s.id === employee.id ? ' selected' : '') + '>' + esc(s.full_name) + '</option>').join('') +
            '</select></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="lw-form">Hold Item(s)</button>' +
        '<button type="button" class="btn secondary" id="lw-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +

    // Detail Drawer -- one shared instance, its body/title replaced per record each
    // time openDetail() is called (Ren's UI redesign pilot, section 204: "Use Detail
    // Drawer for Records... When user clicks a row: Open a right-side detail drawer").
    '<div class="drawer-backdrop" id="lw-detail-backdrop"></div>' +
    '<div class="drawer" id="lw-detail-drawer">' +
      '<div class="drawer-header"><h3 id="lw-detail-title">Layaway Details</h3><button type="button" class="drawer-close" id="lw-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="lw-detail-body"></div>' +
    '</div>' +

    // Summary (tiles) -> Search -> active-filter strip -> Records, all from the same
    // search-filtered rows (MASTER UI rules 2/3/6/19).
    '<div class="tiles" id="lw-tiles" style="margin-top:14px;"></div>' +
    // Customers to Remind (Ren, 2026-10-07): who is due a reminder, with Mark Contacted and
    // Copy Message -- reminders are never sent automatically. Open when someone is due.
    '<details class="card exp lw-remind" id="lw-remind-folder">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Customers to Remind <span class="exp-count" id="lw-remind-count"></span></summary>' +
      '<div class="exp-body" id="lw-remind-list"><div class="muted">Loading…</div></div>' +
    '</details>' +
    // Relocates into the Branch page's shared #tab-filters-slot (Ren, 2026-09-24) --
    // starts hidden since Layaway isn't the default active tab; showSubTab() there
    // toggles it back on when this tab is selected.
    '<div class="card" id="layaway-filter-card" data-filter-tab="layaway" style="display:none;">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="lw-f-search" placeholder="SKU, customer, order ID, contact…"></div>' +
        '<div class="field"><label>Status</label><select id="lw-f-status"><option value="all">All active</option><option value="past">Past deadline (overdue + forfeiture due)</option><option value="lacking">Waiting for stock</option>' +
          ACTIVE_STATUSES.map((s) => '<option value="' + s + '">' + s + '</option>').join('') + '</select></div>' +
        sortControlHtml(LW_SORT_FIELDS, sort, 'lw-sort-field', 'lw-sort-dir') +
        '<button type="button" class="btn small secondary" id="lw-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="lw-active"></div>' +
    '<h3 style="margin:0 0 8px;">On Hold</h3>' +
    '<div id="lw-list"><div class="muted">Loading…</div></div>' +

    // Status navigation: one folder per status besides On Hold itself (Ren,
    // 2026-09-16: "make a folder per layaway status for cancelled, delete, completed,
    // on hold"), collapsed by default; the Search box above narrows every folder.
    // Ren's spec, 2026-09-22: every collapsible folder/group uses the same
    // expand/collapse pattern (details.exp -- see css/styles.css) -- an aria-hidden
    // caret that rotates open, native <details> keyboard/screen-reader semantics.
    '<details class="card exp" style="margin-top:14px;">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Completed <span class="exp-count" id="lw-completed-count"></span></summary>' +
      '<div class="exp-body" id="lw-list-completed"></div>' +
    '</details>' +
    '<details class="card exp" style="margin-top:10px;">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Cancelled <span class="exp-count" id="lw-cancelled-count"></span></summary>' +
      '<div class="exp-body" id="lw-list-cancelled"></div>' +
    '</details>' +
    // Forfeited: a customer never came back to pay before the Forfeit Date, as
    // opposed to Cancelled (a deliberate back-out) -- Ren, 2026-09-17, wanted
    // these told apart instead of both landing in the same Cancelled bucket.
    '<details class="card exp" style="margin-top:10px;">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Forfeited <span class="exp-count" id="lw-forfeited-count"></span></summary>' +
      '<div class="exp-body" id="lw-list-forfeited"></div>' +
    '</details>' +
    // Admin-only review queue (Ren, 2026-09-17: "for approval of me if they want
    // to edit it") -- open by default since a pending request is something to
    // act on, not just browse, same convention as SKU Catalog's Pending Edit
    // Requests.
    // Approvals (Ren, 2026-10-07): every approval queue, each collapsed while empty and
    // highlighted + opened while something waits (setApprovalFolder() below).
    ((canFinalDelete || canApproveItemChange) ? '<h3 style="margin:18px 0 6px;">Approvals <span class="muted" id="lw-approvals-total" style="font-weight:normal;"></span></h3>' : '') +
    (canApproveItemChange
      ? '<details class="card exp lw-approval" id="lw-pending-forfeitreq-folder" style="margin-top:10px;">' +
          '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Pending Forfeiture Requests <span class="exp-count" id="lw-pending-forfeitreq-count"></span></summary>' +
          '<div class="exp-body" id="lw-pending-forfeitreq-list"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +
    (canFinalDelete
      ? '<details class="card exp lw-approval" id="lw-pending-forfeit-folder" style="margin-top:10px;">' +
          '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Pending Forfeit Date Requests <span class="exp-count" id="lw-pending-forfeit-count"></span></summary>' +
          '<div class="exp-body" id="lw-pending-forfeit-list"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +
    // Supervisor-tier review queue (Ren, 2026-09-24: "but for approval of supervisor")
    // -- same convention as Pending Forfeit Date Requests above, open by default since
    // a pending item change is something to act on, not just browse.
    (canApproveItemChange
      ? '<details class="card exp lw-approval" id="lw-pending-itemchange-folder" style="margin-top:10px;">' +
          '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Pending Item Change Requests <span class="exp-count" id="lw-pending-itemchange-count"></span></summary>' +
          '<div class="exp-body" id="lw-pending-itemchange-list"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +
    // Ren, 2026-09-26: "delete details with reason should be approved with supervisor"
    // -- same review-queue convention as Item Change above, same approver population.
    (canApproveItemChange
      ? '<details class="card exp lw-approval" id="lw-pending-paymentdel-folder" style="margin-top:10px;">' +
          '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Pending Payment Deletion Requests <span class="exp-count" id="lw-pending-paymentdel-count"></span></summary>' +
          '<div class="exp-body" id="lw-pending-paymentdel-list"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +
    // Ren, 2026-09-26: "give approval also to supervisor approval to remove but i am
    // the final approver" -- two-stage review queue, visible to any Supervisor-tier
    // viewer (they can act on Pending rows) but Final Approve/the final-stage Reject
    // only render for canFinalDelete (Admin) -- see renderPendingHoldDeletionRequests().
    (canApproveItemChange
      ? '<details class="card exp lw-approval" id="lw-pending-holddel-folder" style="margin-top:10px;">' +
          '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Pending Layaway Deletion Requests <span class="exp-count" id="lw-pending-holddel-count"></span></summary>' +
          '<div class="exp-body" id="lw-pending-holddel-list"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +

    '<h2 style="margin-top:26px;">Monthly Monitoring</h2>' +
    '<div class="card">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        // From/To (here and in Payments Received below) are driven by the page's global date
        // range (Branch Operations Summary): kept in the DOM, not shown.
        '<div class="field range-managed"><label>From</label><input type="date" id="mm-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="mm-to"></div>' +
        sortControlHtml(MM_SORT_FIELDS, mmSort, 'mm-sort-field', 'mm-sort-dir') +
        '<button type="button" class="btn small secondary range-managed" id="mm-clear">All Time</button>' +
      '</div>' +
    '</div>' +
    '<div class="tiles" id="mm-tiles"></div>' +
    '<div id="mm-table"></div>' +
    // Ren, 2026-09-18: "when filter range show this who also pay the date when
    // filter" -- who paid, how much, and when is checkable directly, rather than
    // only inferable from the aggregate Total Paid number above. Given its own full
    // filter set (Ren, 2026-09-22: Date/Amount/Method/Status/Recorded By), separate
    // from the rollup's own From/To -- branch isn't one of them since this whole tab
    // is already scoped to one branch, so a Branch filter here would never narrow
    // anything.
    '<h3 style="margin-top:20px;">Payments Received <span class="muted" style="font-weight:normal;">— by payment date</span></h3>' +
    '<div class="card">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:180px;"><label>Search</label><input type="text" id="mm-pay-f-search" placeholder="Order ID, SKU, customer, amount, receipt #…"></div>' +
        '<div class="field range-managed"><label>From</label><input type="date" id="mm-pay-f-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="mm-pay-f-to"></div>' +
        '<div class="field"><label>Method</label><select id="mm-pay-f-method"><option value="all">All</option>' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Status</label><select id="mm-pay-f-status"><option value="all">All</option><option>Downpayment</option><option>Partial</option><option>Paid in Full</option></select></div>' +
        '<div class="field"><label>Recorded By</label><select id="mm-pay-f-recordedby"><option value="all">All</option></select></div>' +
        sortControlHtml(MM_PAY_SORT_FIELDS, mmPaySort, 'mm-pay-sort-field', 'mm-pay-sort-dir') +
        '<button type="button" class="btn small secondary" id="mm-pay-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="mm-pay-active"></div>' +
    '<div class="tiles" id="mm-pay-tiles"></div>' +
    '<div id="mm-payments-table"></div>' +

    '<h3 style="margin-top:22px;">Forfeiture Watch <span class="muted" style="font-weight:normal;">— On Hold items, most urgent first (not affected by the date range above)</span></h3>' +
    '<p class="muted" style="margin-top:-4px;">Unpaid holds are due ' + getOpsConfig().forfeitMonths + ' months after Date Purchased unless a Forfeit Date is set. Yellow = nearing the deadline, red = overdue. Nothing is ever forfeited automatically: an overdue item needs a forfeiture request, a Supervisor\'s approval and Admin\'s final approval. Date Purchased is fixed once set (Admin only can correct it); a Forfeit Date change by anyone else needs Admin approval.</p>' +
    '<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' + sortControlHtml(FW_SORT_FIELDS, fwSort, 'fw-sort-field', 'fw-sort-dir') + '</div></div>' +
    '<div id="fw-table"></div>';

  document.getElementById('tab-filters-slot')?.appendChild(document.getElementById('layaway-filter-card'));
  // Start on the page's global date range (later changes arrive as 'change' events on these inputs).
  const range0 = getRange ? getRange() : null;
  if (range0) {
    const from0 = range0.preset === 'all' ? '' : range0.from, to0 = range0.preset === 'all' ? '' : range0.to;
    ['mm', 'mm-pay-f'].forEach((p) => { document.getElementById(p + '-from').value = from0; document.getElementById(p + '-to').value = to0; });
  }

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

  // Generic open/close for the Form Drawer -- the form itself and every listener on
  // it (below) are unchanged from before this was a drawer; only where it lives in
  // the page (and whether it's currently visible) is different.
  function openFormDrawer() {
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
    // The submit button lives in .drawer-footer (form="lw-form"), outside this
    // <form> element's own DOM subtree, so it's reached by its own selector --
    // f.querySelector() here always returned null (silently throwing on
    // btn.disabled below, before any validation or network call ever ran).
    const btn = document.querySelector('#lw-form-drawer .drawer-footer button[type=submit]');
    const items = readItemRows();
    if (!items.length) {
      notify('Add at least one item (SKU) to hold.', true);
      flagInvalid(itemsContainer.querySelector('.lw-item-row .lw-item-sku'));
      return;
    }
    const badQty = items.find((it) => !it.qty || it.qty <= 0);
    if (badQty) {
      notify('Qty must be a positive number for ' + badQty.sku + '.', true);
      flagInvalid(badQty.row.querySelector('.lw-item-qty'));
      return;
    }

    btn.disabled = true;
    // Multiple items are separate reservations under the hood (one layaway_holds row
    // each), tied together by a shared group_id so they display and act as one order.
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
    } catch (err) {
      // A later item failing (e.g. out of stock) shouldn't leave earlier items in this
      // same submission silently held with nothing to show for it -- undo them too.
      for (const h of created) { try { await cancelLayaway(h.holdId, 'Rolled back: a later item in the same submission failed'); } catch (e) {} }
      notify(String(err.message || err), true);
      btn.disabled = false;
      return;
    }

    const payments = readPaymentSlots(f);
    try {
      const grandTotal = created.reduce((s, h) => s + (h.totalPrice || 0), 0);
      const canProportion = created.length > 1 && grandTotal > 0 && created.every((h) => h.totalPrice != null);
      for (const p of payments) {
        // Uploaded once per slot even when the payment is split below -- it's proof
        // of the one transaction that happened, just recorded against more than one
        // item's hold for bookkeeping.
        const attachmentPath = p.file ? await uploadLayawayPaymentProof(branchId, created[0].holdId, p.file) : null;
        if (!canProportion) {
          await addLayawayPayment(created[0].holdId, p.amount, p.method, p.reference, attachmentPath, f.holdDate.value || null, f.paymentNotes.value.trim());
          continue;
        }
        // Split one shared downpayment across each item's own hold, proportional to
        // its share of the order total; the last item absorbs any rounding remainder
        // so the recorded payments always add back up to exactly what was entered.
        let allocated = 0;
        for (let i = 0; i < created.length; i++) {
          const h = created[i];
          const isLast = i === created.length - 1;
          const share = isLast ? Math.round((p.amount - allocated) * 100) / 100 : Math.round((p.amount * h.totalPrice / grandTotal) * 100) / 100;
          if (!isLast) allocated += share;
          if (share > 0) await addLayawayPayment(h.holdId, share, p.method, p.reference, attachmentPath, f.holdDate.value || null, f.paymentNotes.value.trim());
        }
      }
    } catch (err) {
      notify(items.length + ' item(s) held, but recording payment failed: ' + (err.message || err) + '. Add it from the item\'s own View Details.', true);
      f.reset();
      resetItemRows();
      btn.disabled = false;
      closeFormDrawer();
      await load();
      return;
    }

    notify(items.length + ' item(s) held' + (payments.length ? ' with ' + payments.length + ' payment(s) recorded.' : '.'), false);
    f.reset();
    resetItemRows();
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

  document.getElementById('lw-f-search').addEventListener('input', render);
  document.getElementById('lw-f-status').addEventListener('change', render);
  document.getElementById('lw-f-clear').addEventListener('click', () => {
    document.getElementById('lw-f-search').value = '';
    document.getElementById('lw-f-status').value = 'all';
    render();
  });
  wireSortControl('lw-sort-field', 'lw-sort-dir', sort, render);
  document.getElementById('mm-from').addEventListener('change', renderMonthly);
  document.getElementById('mm-to').addEventListener('change', renderMonthly);
  document.getElementById('mm-clear').addEventListener('click', () => {
    document.getElementById('mm-from').value = '';
    document.getElementById('mm-to').value = '';
    renderMonthly();
  });
  wireSortControl('mm-sort-field', 'mm-sort-dir', mmSort, renderMonthly);
  wireSortControl('mm-pay-sort-field', 'mm-pay-sort-dir', mmPaySort, renderMonthlyPayments);
  wireSortControl('fw-sort-field', 'fw-sort-dir', fwSort, renderForfeitureWatch);
  document.getElementById('mm-pay-f-search').addEventListener('input', renderMonthlyPayments);
  document.getElementById('mm-pay-f-from').addEventListener('change', renderMonthlyPayments);
  document.getElementById('mm-pay-f-to').addEventListener('change', renderMonthlyPayments);
  document.getElementById('mm-pay-f-method').addEventListener('change', renderMonthlyPayments);
  document.getElementById('mm-pay-f-status').addEventListener('change', renderMonthlyPayments);
  document.getElementById('mm-pay-f-recordedby').addEventListener('change', renderMonthlyPayments);
  document.getElementById('mm-pay-f-clear').addEventListener('click', () => {
    document.getElementById('mm-pay-f-search').value = '';
    // (From/To are the page's global date range -- not cleared here)
    document.getElementById('mm-pay-f-method').value = 'all';
    document.getElementById('mm-pay-f-status').value = 'all';
    document.getElementById('mm-pay-f-recordedby').value = 'all';
    renderMonthlyPayments();
  });

  // Folder helper for the approval queues: collapsed while empty, highlighted and opened the
  // moment something is waiting (Ren, 2026-10-07: "collapsed when zero / highlighted when > 0").
  function setApprovalFolder(folderId, n) {
    const f = document.getElementById(folderId);
    if (!f) return;
    const prev = Number(f.dataset.count || 0);
    f.dataset.count = String(n);
    f.classList.toggle('has-pending', n > 0);
    if (n > 0 && prev === 0) f.open = true;
    if (n === 0 && prev > 0) f.open = false;
    const total = [...document.querySelectorAll('.lw-approval')].reduce((s, el) => s + Number(el.dataset.count || 0), 0);
    const tot = document.getElementById('lw-approvals-total');
    if (tot) { tot.textContent = total ? '(' + total + ' waiting)' : '(nothing waiting)'; tot.classList.toggle('lw-pending-flag', total > 0); }
  }

  async function load() {
    const list = document.getElementById('lw-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const branchId = getBranchId();
      // The four lookups are independent -- run them together (they used to run one after another).
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
      render();
      renderMonthly();
      renderReminders();
      await Promise.all([loadPendingForfeitRequests(), loadPendingItemChangeRequests(), loadPendingPaymentDeletionRequests(), loadPendingHoldDeletionRequests()]);
      renderForfeitureWatch();
      renderPendingForfeitWorkflow();
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
  const daysClass = (info) => info.overdue ? 'lw-days bad' : info.rowTone === 'yellow' ? 'lw-days warn' : 'lw-days';

  // One table per status folder (Ren, 2026-09-16: "make a folder per layaway status
  // for cancelled, delete, completed, on hold") -- render() below computes the 3
  // search-filtered buckets and the tiles, then calls this once per folder. UI
  // redesign pilot (Ren, 2026-09-21: "REDESIGNING BOTH DESKTOP AND MOBILE VIEW"):
  // the row itself now only carries scan-at-a-glance fields; everything else
  // (payment history, notes, every action) lives in the Detail Drawer opened by
  // "View Details" -- see renderDetailBody()/wireDetailBody() below. Columns follow Ren's
  // 2026-10-07 spec: layaway date, deadline, % paid, remaining balance, days left, status.
  function renderHoldTable(containerId, rows) {
    const list = document.getElementById(containerId);
    if (!rows.length) { list.innerHTML = '<p class="muted">None' + (containerId === 'lw-list' ? ' for this filter.' : '.') + '</p>'; return; }

    list.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:9%"><col style="width:15%"><col style="width:16%"><col style="width:9%"><col style="width:12%"><col style="width:9%"><col style="width:14%"><col style="width:10%"><col style="width:6%"></colgroup>' +
      '<thead><tr><th>Date</th><th>SKU / Order</th><th>Customer</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Deadline</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((h) => {
        const info = infoOf(h);
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        return '<tr class="lw-row' + (info.rowTone ? ' lw-row-' + info.rowTone : '') + '">' +
          '<td data-label="Date">' + fmtDate(h.hold_date) + '</td>' +
          '<td data-label="SKU / Order">' + esc(h.sku) +
            (h.stock_status === 'Lacking' ? ' <span class="badge low" title="Not physically in stock yet -- needs to be sourced before this can be completed">Lacking</span>' : '') +
            '<div class="muted" style="font-size:10px;">Order ' + esc(h.order_id || '—') +
            // An On Hold item has already left the sellable pool (moves to Reserved --
            // see the New Layaway form's own note), so it's visibly tagged right next
            // to the Order ID, not just implied by the Status column, matching Ren's
            // spec section 229: "Do not hide the reserved state inside notes only. It
            // must be immediately visible."
            (h.status === 'On Hold' ? ' <span class="badge transit" style="font-size:9px;padding:1px 5px;" title="This item is held for this customer -- not available for another sale.">Reserved</span>' : '') +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
            ' · qty ' + h.qty + '</div></td>' +
          '<td data-label="Customer" class="full-row">' + customerLinkHtml(h.customer_name, h.contact_number) +
            (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Total">' + money(h.total_price) + '</td>' +
          '<td data-label="Paid">' + money(info.paid) + '<div class="lw-prog">' + progressHtml(info.pct) + '</div></td>' +
          '<td data-label="Remaining">' + (info.remaining !== null ? money(info.remaining) : '—') + '</td>' +
          '<td data-label="Deadline">' + (info.active ? fmtDate(info.deadline) + (info.daysText ? '<div class="' + daysClass(info) + '">' + esc(info.daysText) + '</div>' : '') : '—') + '</td>' +
          '<td data-label="Status" class="full-row">' + statusChipHtml(info) + '</td>' +
          '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View Details</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    list.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(Number(btn.dataset.id))));
    wireCustomerLinks(list);
  }


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
    return {
      first_hold_id: Math.min(...use.map((m) => m.id)), customer_name: h.customer_name, contact_number: h.contact_number,
      alt_contact_number: h.alt_contact_number, order_ids: [...new Set(use.map((m) => m.order_id).filter(Boolean))].join(', '),
      balance, deadline, days_remaining: days, stage: reminderStageFor(days), lines: use.length,
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

  // Everything a row's own cells used to cram into one column, now the Detail
  // Drawer's body -- same fields, same actions, same server calls, just laid out as
  // a proper standalone record view (Ren's spec section 204).
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
    const canRequestForfeit = h.status === 'On Hold' && canAct && !openReq && (info.overdue || canFinalDelete);

    return '<div class="drawer-section">' +
        '<h4>Item</h4>' +
        '<div class="drawer-kv"><span>SKU</span><b>' + esc(h.sku) + (h.stock_status === 'Lacking' ? ' <span class="badge low">Lacking</span>' : '') + '</b></div>' +
        '<div class="drawer-kv"><span>Order ID</span><b>' + esc(h.order_id || '—') +
          (h.status === 'On Hold' ? ' <span class="badge transit">Reserved</span>' : '') +
          (group ? ' <span class="badge pending">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
        '</b></div>' +
        '<div class="drawer-kv"><span>Branch</span><b>' + esc(branchNameOf(h.branch_id)) + '</b></div>' +
        '<div class="drawer-kv"><span>Qty</span><b>' + h.qty + '</b></div>' +
        '<div class="drawer-kv"><span>Unit Price</span><b>' + money(h.unit_price) + '</b></div>' +
        '<div class="drawer-kv"><span>Total</span><b>' + money(h.total_price) + '</b></div>' +
        '<div class="drawer-kv"><span>Paid</span><b>' + money(paid) + (info.pct != null ? ' <span class="muted">(' + info.pct + '%)</span>' : '') + '</b></div>' +
        (remaining !== null ? '<div class="drawer-kv"><span>Remaining</span><b>' + money(remaining) + '</b></div>' : '') +
        (info.pct != null ? '<div style="margin:2px 0 6px;">' + progressHtml(info.pct) + '</div>' : '') +
        '<div class="drawer-kv"><span>Status</span><b>' + statusChipHtml(info) + '</b></div>' +
        '<div class="drawer-kv"><span>Layaway date</span><b>' + fmtDate(h.hold_date) + '</b></div>' +
        (info.active ? '<div class="drawer-kv"><span>Deadline</span><b>' + fmtDate(info.deadline) + (info.daysText ? ' · <span class="' + daysClass(info) + '">' + esc(info.daysText) + '</span>' : '') + '</b></div>' : '') +
        // Who closed this hold out and when (Ren's spec section 8: Layaway
        // completed/forfeited need User Name + Date/Time in the audit trail) --
        // completed_by/cancelled_by/forfeited_by are set server-side by
        // complete_layaway()/cancel_layaway()/forfeit_layaway_hold().
        (h.status === 'Completed' && h.completed_at ? '<div class="drawer-kv"><span>Completed</span><b>' + (h.completer ? esc(h.completer.full_name) + ' · ' : '') + fmtDateTime(h.completed_at) + '</b></div>' : '') +
        (h.status === 'Cancelled' && h.cancelled_at ? '<div class="drawer-kv"><span>Cancelled</span><b>' + (h.canceller ? esc(h.canceller.full_name) + ' · ' : '') + fmtDateTime(h.cancelled_at) + '</b></div>' : '') +
        (h.status === 'Forfeited' && h.forfeited_at ? '<div class="drawer-kv"><span>Forfeited</span><b>' + (h.forfeiter ? esc(h.forfeiter.full_name) + ' · ' : '') + fmtDateTime(h.forfeited_at) + '</b></div>' : '') +
      '</div>' +
      (openReq
        ? '<div class="drawer-section"><h4>Forfeiture request</h4>' +
            '<div class="lw-note-box"><b>' + esc(openReq.status) + '</b> — requested by ' + esc((openReq.requester && openReq.requester.full_name) || '—') + ' on ' + fmtDateTime(openReq.requested_at) +
            '<div style="margin-top:2px;">Reason: ' + esc(openReq.reason) + '</div>' +
            (openReq.status === 'Supervisor Approved' ? '<div class="muted">Approved by ' + esc((openReq.supervisorApprover && openReq.supervisorApprover.full_name) || '—') + ' · waiting for Admin\'s final approval</div>' : '<div class="muted">Waiting for a Supervisor\'s approval, then Admin\'s final approval.</div>') +
            '</div></div>'
        : '') +
      '<div class="drawer-section">' +
        '<h4>Customer</h4>' +
        '<div class="drawer-kv"><span>Name</span><b>' + customerLinkHtml(h.customer_name, h.contact_number) + '</b></div>' +
        (h.contact_number ? '<div class="drawer-kv"><span>Contact</span><b>' + esc(h.contact_number) + '</b></div>' : '') +
        '<div class="drawer-kv"><span>Alt. contact</span><b>' + (h.alt_contact_number ? esc(h.alt_contact_number) : '<span class="muted">—</span>') +
          (canAct ? ' <button type="button" class="btn small secondary" data-act="edit-alt" style="padding:1px 8px;">' + (h.alt_contact_number ? 'Change' : 'Add') + '</button>' : '') + '</b></div>' +
        (h.creator ? '<div class="drawer-kv"><span>Processed by</span><b>' + esc(h.creator.full_name) + '</b></div>' : '') +
        (h.handler ? '<div class="drawer-kv"><span>Handled By</span><b>' + esc(h.handler.full_name) + '</b></div>' : '') +
        (h.notes ? '<div class="drawer-kv"><span>Notes</span><b>' + esc(h.notes) + '</b></div>' : '') +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Payment History</h4>' +
        (h.layaway_payments && h.layaway_payments.length
          // Reference relabeled "Receipt/Txn #" and a Payment Status badge per Ren's
          // spec section 1. Each payment gets its own bordered .payment-line block
          // (section 16/66: "Do not compress multiple payments into one narrow
          // line") with Amount/Method on their own leading line and Receipt kept as
          // its own clearly-labeled piece, instead of one run-on sentence.
          ? h.layaway_payments.map((p) => '<div class="payment-line">' +
              '<div>' + money(p.amount) + ' · ' + esc(p.payment_method) +
                ' <span class="badge ' + (paymentStatusById[p.id] === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:9px;padding:1px 5px;">' + paymentStatusById[p.id] + '</span>' +
              '</div>' +
              (p.reference_number ? '<div class="muted" style="font-size:10px;margin-top:2px;">Receipt/Txn #' + esc(p.reference_number) + '</div>' : '') +
              (p.notes ? '<div class="muted" style="font-size:10px;margin-top:2px;">Note: ' + esc(p.notes) + '</div>' : '') +
              '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' +
                (p.attachment_path ? '<button type="button" class="btn small secondary" data-act="view-proof" data-path="' + esc(p.attachment_path) + '" style="padding:1px 6px;">Proof</button>' : '') +
                (canEditAmount ? '<button class="btn small secondary" data-act="del-payment" data-id="' + p.id + '" style="padding:1px 6px;">✕</button>' : '') +
                '<span class="muted" style="font-size:10px;">' + fmtDate(p.paid_at) + (p.employees ? ' · recorded by ' + esc(p.employees.full_name) : '') + '</span>' +
              '</div>' +
            '</div>').join('')
          : '<p class="muted" style="margin:0;">No payments yet.</p>') +
      '</div>' +
      (h.status === 'On Hold'
        ? '<div class="drawer-section"><h4>Customer reminders</h4>' +
            (reminders.length
              ? '<div class="muted" style="font-size:12px;margin-bottom:6px;">Last contacted: ' + lastContactText(reminders) + (reminders.length > 1 ? ' <span>(' + reminders.length + ' contacts in all)</span>' : '') + '</div>'
              : '<div class="muted" style="font-size:12px;margin-bottom:6px;">Not contacted yet.</div>') +
            ((canAct || canManage)
              ? '<div style="display:flex;flex-wrap:wrap;gap:6px;"><button type="button" class="btn small secondary" data-act="copy-reminder">Copy Message</button>' +
                '<button type="button" class="btn small secondary" data-act="mark-contacted">Mark Contacted</button></div>'
              : '') +
          '</div>'
        : '') +
      (groupIdx === 0 && groupOnHold.length > 1 && (canAct || canManage)
        ? '<div class="drawer-section"><h4>This Order (' + group.length + ' items)</h4><div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            (canAct ? '<button class="btn small secondary" data-act="complete-group" data-group="' + esc(h.group_id) + '">Complete All (' + groupOnHold.length + ')</button>' : '') +
            // Cancelling/removing a hold is Admin-only -- narrower than everything
            // else here, matching cancel_layaway's own server-side gate (Ren,
            // 2026-09-16: "i will be the one to final delete not supervisor or
            // manager now").
            (canFinalDelete ? '<button class="btn small secondary" data-act="cancel-group" data-group="' + esc(h.group_id) + '">Cancel All (' + groupOnHold.length + ')</button>' : '') +
          '</div></div>'
        : '') +
      (h.status === 'On Hold' && (canAct || canManage)
        ? '<div class="drawer-section"><h4>Actions</h4>' +
            (canAct
              ? '<form class="lw-pay-form" data-hold-id="' + h.id + '" data-branch-id="' + h.branch_id + '" data-remaining="' + (remaining == null ? '' : remaining) + '" style="display:flex;flex-wrap:wrap;gap:6px;">' +
                  '<input type="number" name="amount" step="0.01" min="0.01" placeholder="Amount" required style="width:80px;padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  '<select name="method" style="padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select>' +
                  '<input type="text" name="reference" placeholder="Receipt/Txn #" style="width:100px;padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  // Defaults to today but editable -- lets staff record the real date a
                  // payment actually happened instead of whenever it got typed in
                  // (Ren, 2026-09-18: "add date when they pay").
                  '<input type="date" name="paidAt" value="' + localDateStr() + '" title="Date Paid" style="padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  '<input type="text" name="notes" placeholder="Note (optional)" style="width:130px;padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  '<input type="file" name="proof" accept="image/*,.pdf" style="max-width:140px;font-size:12px;" title="Proof of Payment">' +
                  '<button class="btn small" type="submit">Add Payment</button>' +
                '</form>'
              : '') +
            '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">' +
              (canAct ? '<button class="btn small secondary" data-act="complete" data-id="' + h.id + '">Complete</button>' : '') +
              // Only meaningful for a Lacking hold -- nothing to reserve once it's
              // already In Stock. Supervisor-tier (Ren, 2026-09-28: "give edit for
              // supervisor if the item can change to available item from lacking"),
              // plus Auditor (Ren, 2026-09-30: "add this the same access to auditor and
              // supervisor") -- mirrors canEditAmount's own Admin/Auditor/Supervisor-tier
              // pairing. Matches mark_layaway_stock_available()'s server-side gate exactly.
              ((canApproveItemChange || employee.position === 'Auditor') && h.stock_status === 'Lacking'
                ? '<button class="btn small secondary" data-act="mark-available" data-id="' + h.id + '">Mark In Stock</button>' : '') +
              (canEditAmount ? '<button class="btn small secondary" data-act="edit-hold" data-id="' + h.id + '">Edit</button>' : '') +
              (canFinalDelete ? '<button class="btn small secondary" data-act="cancel" data-id="' + h.id + '">Cancel</button>' : '') +
              // Forfeiture is never one click any more (Ren, 2026-10-07: "Request Forfeit /
              // Approve Forfeit / Final Forfeit"): staff REQUEST it once the layaway is
              // overdue, a Supervisor approves, Admin gives the final approval. Admin can
              // also forfeit straight from here (records the request and approves it in one go).
              (canRequestForfeit ? '<button class="btn small secondary" data-act="' + (canFinalDelete ? 'forfeit-now' : 'request-forfeit') + '" data-id="' + h.id + '">' + (canFinalDelete ? 'Forfeit…' : 'Request Forfeit') + '</button>' : '') +
              // Delete is distinct from Cancel -- permanently erases the row (blocked
              // server-side if it has any payments), for pure data-entry mistakes
              // rather than a real customer cancellation (Ren, 2026-09-16: "make a
              // folder ... for cancelled, delete, completed, on hold"). Now a
              // Supervisor-tier-initiated request rather than an instant Admin action
              // (Ren, 2026-09-26: "give approval also to supervisor... but i am the
              // final approver") -- see the Pending Layaway Deletion Requests folder.
              (canApproveItemChange ? '<button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Delete</button>' : '') +
            '</div>' +
            (canEditAmount ? editHoldFormHtml(h) : '') +
          '</div>'
        : '') +
      // Completed's own Edit (details-only: Customer/Contact/Order ID/Notes, SKU/Qty/
      // Price stay locked -- see canEditCompletedDetails/editHoldFormHtml's own
      // comments) -- separate section from On Hold's "Actions" above since there's no
      // payment form/Complete/Cancel/Forfeit here, just the one narrower correction
      // (Ren, 2026-09-25: "give access auditor/glenn to edit completed details").
      (h.status === 'Completed' && canEditCompletedDetails
        ? '<div class="drawer-section"><h4>Edit Details</h4>' +
            '<button class="btn small secondary" data-act="edit-hold" data-id="' + h.id + '">Edit</button>' +
            editHoldFormHtml(h) +
          '</div>'
        : '') +
      // Deleting a Completed hold reverses a real sale (Ren, 2026-09-23: "give me
      // access only for me to those completed to delete details", after cleaning up a
      // duplicate-completion by hand) -- same Supervisor-tier-requests/Admin-finally-
      // approves flow as the On Hold case above now covers this too (Ren, 2026-09-26:
      // "both cases"), so the button is a request here as well, not an instant delete.
      ((h.status === 'Cancelled' || h.status === 'Forfeited' || h.status === 'Completed') && canApproveItemChange
        ? '<div class="drawer-section"><button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Delete</button></div>'
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

    const payForm = container.querySelector('.lw-pay-form');
    if (payForm) payForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const btn = f.querySelector('button[type=submit]');
      const amount = Number(f.amount.value);
      const owed = f.dataset.remaining === '' ? null : Number(f.dataset.remaining);
      // A payment bigger than what is still owed is almost always a typo (an extra zero) --
      // make the person look at it before it becomes part of the record.
      if (owed != null && amount > owed + 0.01) {
        const ok = await confirmDialog({ title: 'This is more than the balance', confirmLabel: 'Record anyway',
          message: money(amount) + ' is ' + money(amount - owed) + ' more than what is still owed (' + money(owed) + ').\nRecord it anyway?' });
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        const file = f.proof.files[0] || null;
        const attachmentPath = file ? await uploadLayawayPaymentProof(Number(f.dataset.branchId), Number(f.dataset.holdId), file) : null;
        await addLayawayPayment(Number(f.dataset.holdId), amount, f.method.value, f.reference.value.trim(), attachmentPath, f.paidAt.value, f.notes.value.trim());
        notify('Payment added.', false);
        await load();
        refreshDetailIfOpen(h.id);
      } catch (err) {
        notify(String(err.message || err), true);
        btn.disabled = false;
      }
    });
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
    container.querySelector('[data-act="copy-reminder"]')?.addEventListener('click', () => copyReminder(orderRowFor(h)));
    container.querySelector('[data-act="mark-contacted"]')?.addEventListener('click', () =>
      markContacted(orderRowFor(h), async () => { await load(); refreshDetailIfOpen(h.id); }));

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


  // The On Hold list's Status filter: a real status (PARTIALLY PAID, OVERDUE ...) or one of two
  // groupings the summary's Needs Attention items open (everything past its deadline; items
  // still waiting for stock).
  function matchesStatusFilter(h, f) {
    if (f === 'all') return true;
    if (f === 'lacking') return h.stock_status === 'Lacking';
    const info = infoOf(h);
    if (f === 'past') return info.overdue;
    return info.key === f;
  }
  const STATUS_FILTER_LABELS = { past: 'Past deadline', lacking: 'Waiting for stock' };

  function render() {
    const fSearch = document.getElementById('lw-f-search').value.trim().toLowerCase();
    const fStatus = document.getElementById('lw-f-status').value;
    let rows = allHolds;
    if (fSearch) rows = rows.filter((h) =>
      h.sku.toLowerCase().includes(fSearch) || h.customer_name.toLowerCase().includes(fSearch) ||
      (h.contact_number || '').toLowerCase().includes(fSearch) || (h.order_id || '').toLowerCase().includes(fSearch));

    const onHoldAll = rows.filter((h) => h.status === 'On Hold');
    // The Status filter narrows only the On Hold list; the pill count, tiles and folders stay the
    // whole branch's (so "Layaway 34" keeps meaning 34 on hold, whatever is being looked at).
    const onHold = onHoldAll.filter((h) => matchesStatusFilter(h, fStatus));
    const completed = rows.filter((h) => h.status === 'Completed');
    const cancelled = rows.filter((h) => h.status === 'Cancelled');
    const forfeited = rows.filter((h) => h.status === 'Forfeited');
    // The module pill count and the active-filter strip follow the same search as
    // the tiles/folders/list below (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(onHoldAll.length);
    const activeEl = document.getElementById('lw-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(fSearch) },
      { label: 'Status', value: fStatus === 'all' ? '' : esc(STATUS_FILTER_LABELS[fStatus] || fStatus) },
    ], 'lw-f-clear');
    wireProxyButtons(activeEl);
    const infos = onHoldAll.map(infoOf);
    const totalHeld = onHoldAll.reduce((s, h) => s + Number(h.total_price || 0), 0);
    const totalPaid = infos.reduce((s, i) => s + i.paid, 0);
    const overdueN = infos.filter((i) => i.overdue).length;
    const nearingN = infos.filter((i) => i.key === 'NEARING DEADLINE').length;
    document.getElementById('lw-tiles').innerHTML =
      tile(onHoldAll.length, 'On Hold') +
      (overdueN ? tile(overdueN, 'Overdue', 'bad') : tile(0, 'Overdue')) +
      (nearingN ? tile(nearingN, 'Nearing Deadline', 'warn') : tile(0, 'Nearing Deadline')) +
      tile(money(infos.reduce((s, i) => s + (i.remaining || 0), 0)), 'Balance Owed') +
      tile(completed.length, 'Completed') +
      tile(money(totalHeld), 'Value On Hold') +
      tile(money(totalPaid), 'Paid So Far');
    document.getElementById('lw-completed-count').textContent = '(' + completed.length + ')';
    document.getElementById('lw-cancelled-count').textContent = '(' + cancelled.length + ')';
    document.getElementById('lw-forfeited-count').textContent = '(' + forfeited.length + ')';

    // One sort state, applied to every status folder alike (spec section 20) --
    // filtering picks WHICH rows show, sort only reorders them, same rule for On
    // Hold and every folder below it.
    const cmp = lwSortComparators();
    renderHoldTable('lw-list', applySort(onHold, sort, cmp));
    if (!onHold.length) {
      const list = document.getElementById('lw-list');
      const filtered = !!fSearch || fStatus !== 'all';
      list.innerHTML = emptyStateHtml({
        message: filtered ? 'No On Hold layaways match these filters.' : 'No layaways on hold for this branch right now.',
        hasFilters: filtered, clearId: 'lw-f-clear', createLabel: '+ New Layaway', createId: 'lw-new-btn',
      });
      wireProxyButtons(list);
    }
    renderHoldTable('lw-list-completed', applySort(completed, sort, cmp));
    renderHoldTable('lw-list-cancelled', applySort(cancelled, sort, cmp));
    renderHoldTable('lw-list-forfeited', applySort(forfeited, sort, cmp));
  }


  // ---- Monthly Monitoring: a wide, per-month rollup with a date-range-filtered
  // summary above it -- separate from the live filtered list above, which is about
  // finding one hold, not seeing the shape of the whole month/year. ----
  function renderMonthly() {
    const fFrom = document.getElementById('mm-from').value;
    const fTo = document.getElementById('mm-to').value;
    renderMonthlyPayments();
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

  // Ren, 2026-09-18: "when filter range show this who also pay the date when filter"
  // -- applied to each PAYMENT's own paid_at (not its hold's hold_date), listing them
  // individually rather than rolling them into one number. Every hold regardless of
  // status is included here (unlike the rollup, which excludes Cancelled/Forfeited)
  // -- a payment that actually happened stays on this ledger even if the hold it was
  // against was later cancelled. Own full filter set (Ren, 2026-09-22), independent
  // of the rollup's From/To above it.
  function renderMonthlyPayments() {
    const box = document.getElementById('mm-payments-table');
    const fSearch = document.getElementById('mm-pay-f-search').value.trim().toLowerCase();
    const fFrom = document.getElementById('mm-pay-f-from').value;
    const fTo = document.getElementById('mm-pay-f-to').value;
    const fMethod = document.getElementById('mm-pay-f-method').value;
    const fStatus = document.getElementById('mm-pay-f-status').value;
    const recordedByEl = document.getElementById('mm-pay-f-recordedby');
    const fRecordedBy = recordedByEl.value;
    const payments = [];
    allHolds.forEach((h) => {
      // Status computed against this hold's FULL payment history, not just the
      // filtered range, so a payment near a range boundary still shows the right
      // running-total status (Ren's spec section 1: explicit Payment Status).
      const statusById = paymentStatusFor(h.layaway_payments || [], h.total_price);
      (h.layaway_payments || []).forEach((p) => {
        if (fFrom && p.paid_at < fFrom) return;
        if (fTo && p.paid_at > fTo) return;
        payments.push({ ...p, hold: h, paymentStatus: statusById[p.id], recordedBy: p.employees ? p.employees.full_name : '' });
      });
    });
    // Recorded By's own option list is real data, not a fixed enum -- rebuilt from
    // whatever's actually in range, but only when that set changes, so a mid-typing
    // selection isn't wiped out by every re-render.
    const names = [...new Set(payments.map((p) => p.recordedBy).filter(Boolean))].sort();
    if (recordedByEl.dataset.optionsFor !== names.join('|')) {
      recordedByEl.dataset.optionsFor = names.join('|');
      recordedByEl.innerHTML = '<option value="all">All</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
      recordedByEl.value = names.includes(fRecordedBy) ? fRecordedBy : 'all';
    }
    let filtered = payments;
    if (fSearch) filtered = filtered.filter((p) =>
      p.hold.sku.toLowerCase().includes(fSearch) || p.hold.customer_name.toLowerCase().includes(fSearch) ||
      String(p.amount).includes(fSearch) || (p.reference_number || '').toLowerCase().includes(fSearch) ||
      (p.hold.order_id || '').toLowerCase().includes(fSearch));
    if (fMethod !== 'all') filtered = filtered.filter((p) => p.payment_method === fMethod);
    if (fStatus !== 'all') filtered = filtered.filter((p) => p.paymentStatus === fStatus);
    if (recordedByEl.value !== 'all') filtered = filtered.filter((p) => p.recordedBy === recordedByEl.value);

    const activeEl = document.getElementById('mm-pay-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(fSearch) },
      { label: 'Method', value: fMethod === 'all' ? '' : esc(fMethod) }, { label: 'Status', value: fStatus === 'all' ? '' : esc(fStatus) },
      { label: 'Recorded By', value: recordedByEl.value === 'all' ? '' : esc(recordedByEl.value) },
    ], 'mm-pay-f-clear');
    wireProxyButtons(activeEl);

    const total = filtered.reduce((s, p) => s + Number(p.amount || 0), 0); // total follows the FILTERS, not sort (section 11)
    // Summary tiles (Ren, 2026-10-07): follow the same filters as the table.
    const today = manilaToday();
    const sumOf = (list) => list.reduce((s, p) => s + Number(p.amount || 0), 0);
    const downs = filtered.filter((p) => p.paymentStatus === 'Downpayment');
    const fulls = filtered.filter((p) => p.paymentStatus === 'Paid in Full');
    const outstanding = allHolds.filter((h) => h.status === 'On Hold').reduce((s, h) => s + (infoOf(h).remaining || 0), 0);
    document.getElementById('mm-pay-tiles').innerHTML =
      tile(money(total), 'Total Received') +
      tile(money(sumOf(filtered.filter((p) => p.paid_at === today))), 'Received Today') +
      tile(money(sumOf(downs)), 'Downpayments (' + downs.length + ')') +
      tile(fulls.length, 'Paid in Full (payments)') +
      tile(money(outstanding), 'Outstanding Balance');
    const sortedPayments = applySort(filtered, mmPaySort, MM_PAY_SORT_COMPARATORS);
    if (!sortedPayments.length) {
      const rangeNow = getRange ? getRange() : null;
      const rangeLabel = rangeNow && rangeNow.preset !== 'all' ? rangeNow.label : '';
      box.innerHTML = '<p class="muted">No payments match these filters' + (rangeLabel ? ' for ' + esc(rangeLabel) : '') + '.</p>' +
        (rangeLabel && requestRange ? '<button type="button" class="btn small secondary" id="mm-pay-all-dates">Search all dates</button>' : '');
      box.querySelector('#mm-pay-all-dates')?.addEventListener('click', () => requestRange('all'));
      return;
    }
    box.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Date</th><th>Branch</th><th>Order ID</th><th>SKU</th><th>Customer</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th><th>Recorded By</th><th>Notes</th></tr></thead><tbody>' +
      sortedPayments.map((p) => '<tr>' +
        '<td data-label="Date">' + fmtDate(p.paid_at) + '</td>' +
        '<td data-label="Branch">' + esc(p.hold.branches ? p.hold.branches.name : '—') + '</td>' +
        '<td data-label="Order ID">' + esc(p.hold.order_id || '—') + '</td>' +
        '<td data-label="SKU">' + esc(p.hold.sku) + '</td>' +
        '<td data-label="Customer">' + customerLinkHtml(p.hold.customer_name, p.hold.contact_number) + '</td>' +
        '<td data-label="Amount">' + money(p.amount) + '</td>' +
        '<td data-label="Method">' + esc(p.payment_method) + '</td>' +
        '<td data-label="Reference">' + (p.reference_number ? esc(p.reference_number) : '—') + '</td>' +
        '<td data-label="Status"><span class="badge ' + (p.paymentStatus === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:10px;">' + p.paymentStatus + '</span></td>' +
        '<td data-label="Recorded By">' + (p.employees ? esc(p.employees.full_name) : '—') + '</td>' +
        '<td data-label="Notes">' + (p.notes ? esc(p.notes) : '') + '</td>' +
      '</tr>').join('') +
      '</tbody><tfoot><tr style="font-weight:bold;background:#f7f7f7;"><td colspan="5">Total</td><td>' + money(total) + '</td><td colspan="5"></td></tr></tfoot>' +
      '</table></div>';
    wireCustomerLinks(box);
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
    const unsorted = allHolds
      .filter((h) => h.status === 'On Hold')
      .map((h) => {
        const effectiveForfeit = h.forfeit_date || defaultForfeitDate(h.hold_date);
        return { h, effectiveForfeit, daysPastForfeit: daysSince(effectiveForfeit) };
      });
    const rows = applySort(unsorted, fwSort, fwSortComparators());

    const box = document.getElementById('fw-table');
    if (!rows.length) { box.innerHTML = '<p class="muted">No items currently on hold.</p>'; return; }

    box.innerHTML = '<div class="table-scroll table-2col"><table class="lw-watch" style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:8%"><col style="width:6%"><col style="width:9%"><col style="width:9%"><col style="width:6%"><col style="width:8%"><col style="width:6%"><col style="width:7%"><col style="width:13%"><col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:6%"></colgroup>' +
      '<thead><tr><th>Date Purchased</th><th>Order</th><th>SKU / Item</th><th>Customer</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Days Remaining</th><th>Forfeit Date</th><th>Status</th><th>Last Payment</th><th>Last Reminder</th><th></th></tr></thead><tbody>' +
      rows.map(({ h, effectiveForfeit, daysPastForfeit }) => {
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
      }).join('') + '</tbody></table></div>';

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

  // ---- Customers to Remind (Ren, 2026-10-07). Who is due a reminder (the rule lives in
  // layaway_reminder_queue(): the deadline is within the largest reminder stage, and no reminder
  // has gone out for the stage reached). Copy Message copies the text; Mark Contacted records that
  // a person reached out. Nothing is ever sent from here. ----
  function renderReminders() {
    const folder = document.getElementById('lw-remind-folder');
    const box = document.getElementById('lw-remind-list');
    const countEl = document.getElementById('lw-remind-count');
    if (!folder || !box) return;
    const due = remindQueue.filter((o) => o.due);
    const rest = remindQueue.filter((o) => !o.due);
    countEl.textContent = '(' + due.length + ' due' + (rest.length ? ', ' + rest.length + ' contacted recently' : '') + ')';
    const prev = Number(folder.dataset.count || 0);
    folder.dataset.count = String(due.length);
    folder.classList.toggle('has-pending', due.length > 0);
    if (due.length > 0 && prev === 0) folder.open = true;
    if (due.length === 0 && prev > 0) folder.open = false;
    const show = remindShowAll ? remindQueue : due;
    if (!show.length) {
      box.innerHTML = '<p class="muted" style="margin:0;">' + (remindQueue.length ? 'Everyone in the reminder window has been contacted for their current stage.' : 'No customers are within the reminder window (' + getOpsConfig().reminderStages.slice().sort((a, b) => b - a)[0] + ' days before the deadline, or overdue).') + '</p>' +
        (rest.length ? '<button type="button" class="btn small secondary" data-act="toggle-remind-all" style="margin-top:8px;">Show contacted (' + rest.length + ')</button>' : '');
      box.querySelector('[data-act="toggle-remind-all"]')?.addEventListener('click', () => { remindShowAll = true; renderReminders(); });
      return;
    }
    const canContact = (o) => canManage || employee.branch_id === o.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
    box.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:17%"><col style="width:11%"><col style="width:10%"><col style="width:11%"><col style="width:11%"><col style="width:12%"><col style="width:16%"><col style="width:12%"></colgroup>' +
      '<thead><tr><th>Customer</th><th>Contact</th><th>Order</th><th>Remaining Balance</th><th>Deadline</th><th>Days Remaining</th><th>Last Reminder</th><th></th></tr></thead><tbody>' +
      show.map((o, i) => {
        const overdue = o.days_remaining < 0;
        const lastBy = o.last_reminder_by ? (peopleById[o.last_reminder_by] || '') : '';
        return '<tr class="lw-row' + (overdue ? ' lw-row-red' : (o.days_remaining <= getOpsConfig().nearingDays ? ' lw-row-yellow' : '')) + '">' +
          '<td data-label="Customer">' + customerLinkHtml(o.customer_name, o.contact_number) + (o.lines > 1 ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;">' + o.lines + ' items</span>' : '') + '</td>' +
          '<td data-label="Contact">' + esc(o.contact_number || '—') + (o.alt_contact_number ? '<div class="muted" style="font-size:10px;">alt ' + esc(o.alt_contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Order">' + esc(o.order_ids || '—') + '</td>' +
          '<td data-label="Remaining Balance"><b>' + money(o.balance) + '</b></td>' +
          '<td data-label="Deadline">' + fmtDate(o.deadline) + '</td>' +
          '<td data-label="Days Remaining"><span class="' + (overdue ? 'lw-days bad' : 'lw-days warn') + '">' + esc(daysText(o.days_remaining)) + '</span></td>' +
          '<td data-label="Last Reminder" class="full-row" style="font-size:11px;">' + (o.last_reminder_at ? fmtDateTime(o.last_reminder_at) + (o.last_channel ? ' · ' + esc(o.last_channel) : '') + (lastBy ? '<div class="muted" style="font-size:10px;">by ' + esc(lastBy) + '</div>' : '') : '<span class="muted">Never</span>') + '</td>' +
          '<td class="full-row"><div style="display:flex;flex-wrap:wrap;gap:4px;">' +
            '<button type="button" class="btn small secondary" data-act="remind-copy" data-i="' + i + '">Copy Message</button>' +
            (canContact(o) ? '<button type="button" class="btn small" data-act="remind-done" data-i="' + i + '">Mark Contacted</button>' : '') +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>' +
      (rest.length ? '<button type="button" class="btn small secondary" data-act="toggle-remind-all" style="margin-top:8px;">' + (remindShowAll ? 'Hide contacted' : 'Show contacted (' + rest.length + ')') + '</button>' : '');
    box.querySelectorAll('[data-act="remind-copy"]').forEach((b) => b.addEventListener('click', () => copyReminder(show[Number(b.dataset.i)])));
    box.querySelectorAll('[data-act="remind-done"]').forEach((b) => b.addEventListener('click', () => markContacted(show[Number(b.dataset.i)])));
    box.querySelector('[data-act="toggle-remind-all"]')?.addEventListener('click', () => { remindShowAll = !remindShowAll; renderReminders(); });
    wireCustomerLinks(box);
  }


  function tile(num, label, tone) { return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>'; }

  const unsubscribe = subscribeToChanges(['layaway_holds', 'layaway_payments', 'layaway_forfeit_date_log', 'layaway_hold_date_log', 'layaway_forfeit_date_requests'], load);
  await load();

  // Needs Attention / summary-card click: take the person straight to what was clicked.
  // Overdue and nearing items live in Forfeiture Watch; pending requests in their approval
  // folders (opened); waiting-for-stock items are the Lacking rows of the On Hold list.
  function applyView(view) {
    let target = null;
    const setList = (status) => {
      const search = document.getElementById('lw-f-search'); if (search) search.value = '';
      const sel = document.getElementById('lw-f-status'); if (sel) sel.value = status;
      render();
      return document.getElementById('lw-list');
    };
    if (view === 'overdue') target = setList('past');
    else if (view === 'nearing') target = setList('NEARING DEADLINE');
    else if (view === 'lacking') target = setList('lacking');
    else if (view === 'reminders') {
      target = document.getElementById('lw-remind-folder');
      if (target) target.open = true;
    } else if (view === 'approvals') {
      const folders = ['lw-pending-forfeitreq-folder', 'lw-pending-holddel-folder', 'lw-pending-paymentdel-folder', 'lw-pending-itemchange-folder', 'lw-pending-forfeit-folder']
        .map((id) => document.getElementById(id)).filter(Boolean);
      target = folders.find((f) => Number(f.dataset.count || 0) > 0) || folders[0] || null;
      if (target) target.open = true;
    }
    (target || document.getElementById('tab-panel-layaway'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }


  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec
  // 321) can open this hold's own Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail, applyView };
}
