// Layaway tab (Branches page) -- a branch-scoped port of the standalone layaway.html
// page's exact "Hold Item(s)" / On Hold list / Monthly Monitoring / Forfeiture Watch
// feature set, reusing its multi-item-hold, proportional-payment-split, and
// rollback-on-partial-failure logic verbatim. The one real difference: there's no
// Branch field on the Hold form and no Branch column in the tables here -- the whole
// tab is already scoped to whichever branch is selected on the Branches page
// (getBranchId()), so every row it ever shows is that one branch by construction.
import {
  listLayaways, createLayawayHold, addLayawayPayment, completeLayaway, cancelLayaway, deleteLayawayPayment,
  setLayawayForfeitDate, setLayawayHoldDate, uploadLayawayPaymentProof, getLayawayPaymentProofUrl,
  searchProducts, listActiveEmployees, subscribeToChanges, editLayawayHold, deleteLayawayHold, forfeitLayawayHold,
  requestLayawayForfeitDate, listLayawayForfeitDateRequests, approveLayawayForfeitDate, rejectLayawayForfeitDate,
} from './api.js';
import { PAYMENT_METHODS } from './paymentMethods.js';

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
// A layaway with no activity forfeits 2 months (~60 days) after Date Purchased
// (hold_date) by default -- staff can override this per-hold with an explicit Forfeit
// Date (99_layaway_forfeit_date.sql). WARN_LEAD_DAYS gives a 2-week heads-up before
// whatever the effective forfeit date is, so staff can chase payment before it's
// actually too late, not just after.
const FORFEITURE_DAYS = 60;
const FORFEITURE_WARN_LEAD_DAYS = 15;
function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((new Date() - new Date(dateStr + 'T00:00:00')) / 86400000);
}
/** The default Forfeit Date when staff hasn't set an explicit one -- 60 days after
 * Date Purchased, same window this whole feature always used before it became
 * editable. */
function defaultForfeitDate(holdDateStr) {
  const d = new Date(holdDateStr + 'T00:00:00');
  d.setDate(d.getDate() + FORFEITURE_DAYS);
  return d.toISOString().slice(0, 10);
}
// Same branch-scope rule as assert_can_act_on_branch()/record_sale() -- whole staff
// can hold/pay/complete/cancel a layaway for their own branch; this group can do it
// for any branch.
const UNSCOPED_POSITIONS = ['Sales Executive', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];
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
export async function initLayawayTab({ root, esc, toast, msgId, getBranchId, employee, onCountUpdate }) {
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
  const canEditAmount = employee.position === 'Auditor' || employee.role === 'Branch Supervisor' || (employee.position || '').includes('Supervisor');
  // Cancelling (the "final delete" of a layaway) is narrower still -- Admin only
  // (Ren, 2026-09-16: "i will be the one to final delete not supervisor or manager
  // now"), reversing the same-day-earlier change that let Manager/Branch Supervisor
  // do it too. Matches cancel_layaway's own server-side gate exactly.
  const canFinalDelete = employee.role === 'Admin';
  const staff = await listActiveEmployees();

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
    '<h3 style="margin-top:0;">Status</h3>' +
    '<details class="card">' +
      '<summary style="cursor:pointer;font-weight:bold;">Completed <span class="muted" id="lw-completed-count" style="font-weight:normal;"></span></summary>' +
      '<div id="lw-list-completed" style="margin-top:10px;"></div>' +
    '</details>' +
    '<details class="card" style="margin-top:10px;">' +
      '<summary style="cursor:pointer;font-weight:bold;">Cancelled <span class="muted" id="lw-cancelled-count" style="font-weight:normal;"></span></summary>' +
      '<div id="lw-list-cancelled" style="margin-top:10px;"></div>' +
    '</details>' +
    // Forfeited: a customer never came back to pay before the Forfeit Date, as
    // opposed to Cancelled (a deliberate back-out) -- Ren, 2026-09-17, wanted
    // these told apart instead of both landing in the same Cancelled bucket.
    '<details class="card" style="margin-top:10px;">' +
      '<summary style="cursor:pointer;font-weight:bold;">Forfeited <span class="muted" id="lw-forfeited-count" style="font-weight:normal;"></span></summary>' +
      '<div id="lw-list-forfeited" style="margin-top:10px;"></div>' +
    '</details>' +

    // Admin-only review queue (Ren, 2026-09-17: "for approval of me if they want
    // to edit it") -- open by default since a pending request is something to
    // act on, not just browse, same convention as SKU Catalog's Pending Edit
    // Requests.
    (canFinalDelete
      ? '<details class="card" id="lw-pending-forfeit-folder" style="margin-top:10px;" open>' +
          '<summary style="cursor:pointer;font-weight:bold;">Pending Forfeit Date Requests <span class="muted" id="lw-pending-forfeit-count" style="font-weight:normal;"></span></summary>' +
          '<div id="lw-pending-forfeit-list" style="margin-top:10px;"><div class="muted">Loading…</div></div>' +
        '</details>'
      : '') +

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
            '<div class="field"><label>Date</label><input type="date" name="holdDate" value="' + new Date().toISOString().slice(0, 10) + '"></div>' +
            '<div class="field"><label>Customer Name *</label><input type="text" name="customerName" required></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Payment</h4>' +
            paymentSlotsHtml() +
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

    '<h2 style="margin-top:26px;">Monthly Monitoring</h2>' +
    '<div class="card">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field"><label>From</label><input type="date" id="mm-from"></div>' +
        '<div class="field"><label>To</label><input type="date" id="mm-to"></div>' +
        '<button type="button" class="btn small secondary" id="mm-clear">All Time</button>' +
      '</div>' +
    '</div>' +
    '<div class="tiles" id="mm-tiles"></div>' +
    '<div id="mm-table"></div>' +
    // Ren, 2026-09-18: "when filter range show this who also pay the date when
    // filter" -- the rollup above is by hold_date (when the item was purchased);
    // this is the same From/To range applied to payments' OWN dates instead, so
    // "who paid, how much, and when" for that period is checkable directly,
    // rather than only inferable from the aggregate Total Paid number.
    '<h3 style="margin-top:20px;">Payments Received <span class="muted" style="font-weight:normal;">— by payment date, same range as above</span></h3>' +
    '<div id="mm-payments-table"></div>' +

    '<h2 style="margin-top:30px;">On Hold</h2>' +
    '<div class="tiles" id="lw-tiles"></div>' +
    '<div class="card">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="lw-f-search" placeholder="SKU, customer, order ID, contact…"></div>' +
        '<button type="button" class="btn small secondary" id="lw-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="lw-list"><div class="muted">Loading…</div></div>' +

    '<h3 style="margin-top:22px;">Forfeiture Watch <span class="muted" style="font-weight:normal;">— On Hold items, oldest first (not affected by the date range above)</span></h3>' +
    '<p class="muted" style="margin-top:-4px;">Unpaid holds are forfeited 2 months after Date Purchased. Rows turn red once an item is close to or past that. Date Purchased is fixed once set (Admin only can correct it); a Forfeit Date change by anyone else needs Admin approval.</p>' +
    '<div id="fw-table"></div>';

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
    return '<div class="lw-edit-form" data-hold-id="' + h.id + '" style="display:none;border:1px solid #e5e5e5;border-radius:8px;padding:8px;margin-top:6px;background:#fafafa;">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="flex:2;min-width:150px;position:relative;">' +
          '<label>SKU *</label>' +
          '<input type="text" class="lw-item-sku" name="sku" autocomplete="off" value="' + esc(h.sku) + '">' +
          '<div class="lw-item-sku-name muted" style="font-size:11px;"></div>' +
          '<div class="lw-item-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:20;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;"></div>' +
        '</div>' +
        '<div class="field" style="width:70px;"><label>Qty</label><input type="number" name="qty" min="1" value="' + h.qty + '"></div>' +
        '<div class="field" style="width:110px;"><label>Unit Price</label><input type="number" class="lw-item-price" name="unitPrice" step="0.01" min="0" value="' + (h.unit_price ?? '') + '"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:6px;">' +
        '<div class="field" style="flex:1;min-width:120px;"><label>Customer Name *</label><input type="text" name="customerName" value="' + esc(h.customer_name) + '"></div>' +
        '<div class="field" style="width:120px;"><label>Contact Number</label><input type="text" name="contactNumber" value="' + esc(h.contact_number || '') + '"></div>' +
        '<div class="field" style="width:120px;"><label>Order ID</label><input type="text" name="orderId" value="' + esc(h.order_id || '') + '"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:6px;"><label>Notes</label><input type="text" name="notes" value="' + esc(h.notes || '') + '"></div>' +
      // Reason required when Amount or Qty actually changes (Ren's spec section
      // 126) -- enforced again server-side by edit_layaway_hold() regardless.
      '<div class="field" style="margin-top:6px;"><label>Reason (required if amount/qty changes)</label><input type="text" name="reason"></div>' +
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
    if (!h) return;
    // .textContent escapes on its own -- esc() here would double-escape (e.g. an
    // actual "&" in a customer's name showing up literally as "&amp;").
    document.getElementById('lw-detail-title').textContent = h.customer_name + ' — ' + h.sku;
    const body = document.getElementById('lw-detail-body');
    body.innerHTML = renderDetailBody(h);
    wireDetailBody(body, h);
    document.getElementById('lw-detail-backdrop').classList.add('open');
    document.getElementById('lw-detail-drawer').classList.add('open');
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
      items.push({ sku, qty, unitPrice: priceVal ? Number(priceVal) : null, stockStatus });
    });
    return items;
  }

  document.getElementById('lw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const branchId = getBranchId();
    const btn = f.querySelector('button[type=submit]');
    const items = readItemRows();
    if (!items.length) { notify('Add at least one item (SKU) to hold.', true); return; }
    const badQty = items.find((it) => !it.qty || it.qty <= 0);
    if (badQty) { notify('Qty must be a positive number for ' + badQty.sku + '.', true); return; }

    btn.disabled = true;
    // Multiple items are separate reservations under the hood (one layaway_holds row
    // each), tied together by a shared group_id so they display and act as one order.
    const groupId = items.length > 1 ? crypto.randomUUID() : null;
    const created = [];
    try {
      for (const it of items) {
        const holdId = await createLayawayHold({
          sku: it.sku, branchId, qty: it.qty,
          customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(),
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
          await addLayawayPayment(created[0].holdId, p.amount, p.method, p.reference, attachmentPath, f.holdDate.value || null);
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
          if (share > 0) await addLayawayPayment(h.holdId, share, p.method, p.reference, attachmentPath, f.holdDate.value || null);
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

  document.getElementById('lw-f-search').addEventListener('input', render);
  document.getElementById('lw-f-clear').addEventListener('click', () => {
    document.getElementById('lw-f-search').value = '';
    render();
  });
  document.getElementById('mm-from').addEventListener('change', renderMonthly);
  document.getElementById('mm-to').addEventListener('change', renderMonthly);
  document.getElementById('mm-clear').addEventListener('click', () => {
    document.getElementById('mm-from').value = '';
    document.getElementById('mm-to').value = '';
    renderMonthly();
  });

  async function load() {
    const list = document.getElementById('lw-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      allHolds = await listLayaways(getBranchId());
      groupMembers = {};
      allHolds.forEach((h) => { if (h.group_id) (groupMembers[h.group_id] = groupMembers[h.group_id] || []).push(h); });
      Object.values(groupMembers).forEach((g) => g.sort((a, b) => a.id - b.id));
      if (onCountUpdate) onCountUpdate(allHolds.filter((h) => h.status === 'On Hold').length);
      render();
      renderMonthly();
      await loadPendingForfeitRequests(); // must resolve before renderForfeitureWatch reads pendingForfeitRequests
      renderForfeitureWatch();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

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

  function renderPendingForfeitRequests() {
    const countEl = document.getElementById('lw-pending-forfeit-count');
    const box = document.getElementById('lw-pending-forfeit-list');
    if (!countEl || !box) return; // not rendered at all for a non-Admin
    countEl.textContent = '(' + pendingForfeitRequests.length + ')';
    if (!pendingForfeitRequests.length) { box.innerHTML = '<p class="muted">No pending forfeit date requests.</p>'; return; }

    box.innerHTML = pendingForfeitRequests.map((r) => {
      const h = r.layaway_holds || {};
      return '<div class="card" style="margin-bottom:8px;background:#fffaf0;">' +
        '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
          '<div><b>' + esc(h.sku || '—') + '</b> — ' + esc(h.customer_name || '—') + ' <span class="muted" style="font-size:11px;">requested by ' + (r.requester ? esc(r.requester.full_name) : '—') + '</span></div>' +
          '<div class="muted" style="font-size:11px;">' + fmtDateTime(r.requested_at) + '</div>' +
        '</div>' +
        '<div style="font-size:12px;margin-top:6px;">Forfeit Date: <span class="muted" style="text-decoration:line-through;">' + fmtDate(r.previous_date) + '</span> → <strong>' + fmtDate(r.proposed_date) + '</strong></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;">' +
          '<button class="btn small" data-act="approve-forfeit-date" data-id="' + r.id + '">Approve</button>' +
          '<button class="btn small secondary" data-act="reject-forfeit-date" data-id="' + r.id + '">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');

    box.querySelectorAll('[data-act="approve-forfeit-date"]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await approveLayawayForfeitDate(Number(btn.dataset.id));
        notify('Forfeit date approved.', false);
        await load();
      } catch (err) {
        notify(String(err.message || err), true);
      }
    }));
    box.querySelectorAll('[data-act="reject-forfeit-date"]').forEach((btn) => btn.addEventListener('click', async () => {
      const reason = prompt('Reason for rejecting (optional)?') || null;
      try {
        await rejectLayawayForfeitDate(Number(btn.dataset.id), reason);
        notify('Forfeit date request rejected.', false);
        await loadPendingForfeitRequests();
        renderForfeitureWatch();
      } catch (err) {
        notify(String(err.message || err), true);
      }
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

  // One table per status folder (Ren, 2026-09-16: "make a folder per layaway status
  // for cancelled, delete, completed, on hold") -- render() below computes the 3
  // search-filtered buckets and the tiles, then calls this once per folder. UI
  // redesign pilot (Ren, 2026-09-21: "REDESIGNING BOTH DESKTOP AND MOBILE VIEW"):
  // the row itself now only carries scan-at-a-glance fields; everything else
  // (payment history, notes, every action) lives in the Detail Drawer opened by
  // "View Details" -- see renderDetailBody()/wireDetailBody() below.
  function renderHoldTable(containerId, rows) {
    const list = document.getElementById(containerId);
    if (!rows.length) { list.innerHTML = '<p class="muted">None' + (containerId === 'lw-list' ? ' for this filter.' : '.') + '</p>'; return; }

    list.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:14%"><col style="width:14%"><col style="width:8%"><col style="width:20%"><col style="width:11%"><col style="width:11%"><col style="width:11%"><col style="width:11%"></colgroup>' +
      '<thead><tr><th>SKU</th><th>Order ID</th><th>Qty</th><th>Customer</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((h) => {
        const paid = paidSoFar(h);
        const remaining = h.total_price == null ? null : Number(h.total_price) - paid;
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        return '<tr>' +
          '<td data-label="SKU">' + esc(h.sku) +
            (h.stock_status === 'Lacking' ? ' <span class="badge low" title="Not physically in stock yet -- needs to be sourced before this can be completed">Lacking</span>' : '') +
          '</td>' +
          '<td data-label="Order ID">' + esc(h.order_id || '—') +
            // An On Hold item has already left the sellable pool (moves to Reserved --
            // see the New Layaway form's own note), so it's visibly tagged right next
            // to the Order ID, not just implied by the Status column, matching Ren's
            // spec section 229: "Do not hide the reserved state inside notes only. It
            // must be immediately visible."
            (h.status === 'On Hold' ? ' <span class="badge transit" style="font-size:9px;padding:1px 5px;" title="This item is held for this customer -- not available for another sale.">Reserved</span>' : '') +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
          '</td>' +
          '<td data-label="Qty">' + h.qty + '</td>' +
          '<td data-label="Customer" class="full-row">' + esc(h.customer_name) + (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Total">' + money(h.total_price) + '</td>' +
          '<td data-label="Paid">' + money(paid) + (remaining !== null ? '<div class="muted" style="font-size:10px;">' + money(remaining) + ' left</div>' : '') + '</td>' +
          '<td data-label="Status"><span class="badge ' + (STATUS_BADGE[h.status] || 'pending') + '">' + esc(h.status) + '</span></td>' +
          '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + h.id + '">View Details</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    list.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(Number(btn.dataset.id))));
  }

  // Everything a row's own cells used to cram into one column, now the Detail
  // Drawer's body -- same fields, same actions, same server calls, just laid out as
  // a proper standalone record view (Ren's spec section 204).
  function renderDetailBody(h) {
    const paid = paidSoFar(h);
    const remaining = h.total_price == null ? null : Number(h.total_price) - paid;
    const paymentStatusById = paymentStatusFor(h.layaway_payments || [], h.total_price);
    const canAct = canManage || employee.branch_id === h.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
    const group = h.group_id ? groupMembers[h.group_id] : null;
    const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
    const groupOnHold = group ? group.filter((x) => x.status === 'On Hold') : [];

    return '<div class="drawer-section">' +
        '<h4>Item</h4>' +
        '<div class="drawer-kv"><span>SKU</span><b>' + esc(h.sku) + (h.stock_status === 'Lacking' ? ' <span class="badge low">Lacking</span>' : '') + '</b></div>' +
        '<div class="drawer-kv"><span>Order ID</span><b>' + esc(h.order_id || '—') +
          (h.status === 'On Hold' ? ' <span class="badge transit">Reserved</span>' : '') +
          (group ? ' <span class="badge pending">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
        '</b></div>' +
        '<div class="drawer-kv"><span>Qty</span><b>' + h.qty + '</b></div>' +
        '<div class="drawer-kv"><span>Unit Price</span><b>' + money(h.unit_price) + '</b></div>' +
        '<div class="drawer-kv"><span>Total</span><b>' + money(h.total_price) + '</b></div>' +
        '<div class="drawer-kv"><span>Paid</span><b>' + money(paid) + '</b></div>' +
        (remaining !== null ? '<div class="drawer-kv"><span>Remaining</span><b>' + money(remaining) + '</b></div>' : '') +
        '<div class="drawer-kv"><span>Status</span><b><span class="badge ' + (STATUS_BADGE[h.status] || 'pending') + '">' + esc(h.status) + '</span></b></div>' +
        // Who closed this hold out and when (Ren's spec section 8: Layaway
        // completed/forfeited need User Name + Date/Time in the audit trail) --
        // completed_by/cancelled_by/forfeited_by are set server-side by
        // complete_layaway()/cancel_layaway()/forfeit_layaway_hold().
        (h.status === 'Completed' && h.completed_at ? '<div class="drawer-kv"><span>Completed</span><b>' + (h.completer ? esc(h.completer.full_name) + ' · ' : '') + fmtDateTime(h.completed_at) + '</b></div>' : '') +
        (h.status === 'Cancelled' && h.cancelled_at ? '<div class="drawer-kv"><span>Cancelled</span><b>' + (h.canceller ? esc(h.canceller.full_name) + ' · ' : '') + fmtDateTime(h.cancelled_at) + '</b></div>' : '') +
        (h.status === 'Forfeited' && h.forfeited_at ? '<div class="drawer-kv"><span>Forfeited</span><b>' + (h.forfeiter ? esc(h.forfeiter.full_name) + ' · ' : '') + fmtDateTime(h.forfeited_at) + '</b></div>' : '') +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Customer</h4>' +
        '<div class="drawer-kv"><span>Name</span><b>' + esc(h.customer_name) + '</b></div>' +
        (h.contact_number ? '<div class="drawer-kv"><span>Contact</span><b>' + esc(h.contact_number) + '</b></div>' : '') +
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
              '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' +
                (p.attachment_path ? '<button type="button" class="btn small secondary" data-act="view-proof" data-path="' + esc(p.attachment_path) + '" style="padding:1px 6px;">Proof</button>' : '') +
                (canEditAmount ? '<button class="btn small secondary" data-act="del-payment" data-id="' + p.id + '" style="padding:1px 6px;">✕</button>' : '') +
                '<span class="muted" style="font-size:10px;">' + fmtDate(p.paid_at) + (p.employees ? ' · ' + esc(p.employees.full_name) : '') + '</span>' +
              '</div>' +
            '</div>').join('')
          : '<p class="muted" style="margin:0;">No payments yet.</p>') +
      '</div>' +
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
              ? '<form class="lw-pay-form" data-hold-id="' + h.id + '" data-branch-id="' + h.branch_id + '" style="display:flex;flex-wrap:wrap;gap:6px;">' +
                  '<input type="number" name="amount" step="0.01" min="0.01" placeholder="Amount" required style="width:80px;padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  '<select name="method" style="padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select>' +
                  '<input type="text" name="reference" placeholder="Receipt/Txn #" style="width:100px;padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  // Defaults to today but editable -- lets staff record the real date a
                  // payment actually happened instead of whenever it got typed in
                  // (Ren, 2026-09-18: "add date when they pay").
                  '<input type="date" name="paidAt" value="' + new Date().toISOString().slice(0, 10) + '" title="Date Paid" style="padding:5px 7px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
                  '<input type="file" name="proof" accept="image/*,.pdf" style="max-width:140px;font-size:12px;" title="Proof of Payment">' +
                  '<button class="btn small" type="submit">Add Payment</button>' +
                '</form>'
              : '') +
            '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">' +
              (canAct ? '<button class="btn small secondary" data-act="complete" data-id="' + h.id + '">Complete</button>' : '') +
              (canEditAmount ? '<button class="btn small secondary" data-act="edit-hold" data-id="' + h.id + '">Edit</button>' : '') +
              (canFinalDelete ? '<button class="btn small secondary" data-act="cancel" data-id="' + h.id + '">Cancel</button>' : '') +
              // Forfeited is a separate final disposition from Cancelled -- the
              // customer never came back to pay by the Forfeit Date, as opposed to a
              // deliberate back-out (Ren, 2026-09-17: wanted these told apart in
              // their own folder). Same Admin-only gate and stock-release effect as
              // Cancel, matching forfeit_layaway_hold()'s own server-side gate.
              (canFinalDelete ? '<button class="btn small secondary" data-act="forfeit" data-id="' + h.id + '">Forfeit</button>' : '') +
              // Delete is distinct from Cancel -- permanently erases the row (blocked
              // server-side if it has any payments, or is Completed), for pure
              // data-entry mistakes rather than a real customer cancellation (Ren,
              // 2026-09-16: "make a folder ... for cancelled, delete, completed, on
              // hold").
              (canFinalDelete ? '<button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Delete</button>' : '') +
            '</div>' +
            (canEditAmount ? editHoldFormHtml(h) : '') +
          '</div>'
        : '') +
      ((h.status === 'Cancelled' || h.status === 'Forfeited') && canFinalDelete
        ? '<div class="drawer-section"><button class="btn small secondary" data-act="delete-hold" data-id="' + h.id + '">Delete</button></div>'
        : '');
  }

  // Same wiring the old per-row cell used to attach across the whole table, now
  // scoped to just the one hold's drawer body -- refreshDetailIfOpen() re-renders
  // this same drawer with fresh data after an in-place action (Add Payment, Delete
  // Payment, Edit), or closeDetailDrawer() after an action that moves the hold to a
  // different status folder entirely.
  function wireDetailBody(container, h) {
    const payForm = container.querySelector('.lw-pay-form');
    if (payForm) payForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const file = f.proof.files[0] || null;
        const attachmentPath = file ? await uploadLayawayPaymentProof(Number(f.dataset.branchId), Number(f.dataset.holdId), file) : null;
        await addLayawayPayment(Number(f.dataset.holdId), Number(f.amount.value), f.method.value, f.reference.value.trim(), attachmentPath, f.paidAt.value);
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

    const completeBtn = container.querySelector('[data-act="complete"]');
    if (completeBtn) completeBtn.addEventListener('click', async () => {
      const paid = paidSoFar(h);
      if (h.total_price != null && paid < Number(h.total_price)) {
        if (!confirm('Not fully paid yet (' + money(paid) + ' of ' + money(h.total_price) + '). Complete anyway?')) return;
      } else if (!confirm('Mark this layaway as completed and sold?')) return;
      try { await completeLayaway(h.id); notify('Layaway completed.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    const cancelBtn = container.querySelector('[data-act="cancel"]');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      if (!confirm('Cancel this layaway? The item goes back to Available stock.')) return;
      try { await cancelLayaway(h.id); notify('Layaway cancelled.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    const forfeitBtn = container.querySelector('[data-act="forfeit"]');
    if (forfeitBtn) forfeitBtn.addEventListener('click', async () => {
      if (!confirm('Mark this layaway as Forfeited? The customer never paid it off -- the item goes back to Available stock.')) return;
      try { await forfeitLayawayHold(h.id); notify('Layaway forfeited.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    const completeGroupBtn = container.querySelector('[data-act="complete-group"]');
    if (completeGroupBtn) completeGroupBtn.addEventListener('click', async () => {
      const members = (groupMembers[h.group_id] || []).filter((x) => x.status === 'On Hold');
      if (!confirm('Mark all ' + members.length + ' items in this order as completed and sold?')) return;
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
      if (!confirm('Cancel all ' + members.length + ' items in this order? They all go back to Available stock.')) return;
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
      if (!confirm('Permanently delete this layaway? This cannot be undone (blocked automatically if it has any payments recorded).')) return;
      try { await deleteLayawayHold(h.id); notify('Layaway deleted.', false); await load(); closeDetailDrawer(); }
      catch (err) { notify(String(err.message || err), true); }
    });

    container.querySelectorAll('[data-act="del-payment"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Delete this payment entry?')) return;
      try { await deleteLayawayPayment(Number(btn.dataset.id)); notify('Payment removed.', false); await load(); refreshDetailIfOpen(h.id); }
      catch (err) { notify(String(err.message || err), true); }
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
      const reason = form.querySelector('[name=reason]').value.trim();
      if (!sku || !qty || qty <= 0 || !customerName) { notify('SKU, a positive Qty, and Customer Name are required.', true); return; }
      const amountChanged = Number(h.unit_price) !== Number(unitPrice) || Number(h.qty) !== qty;
      // Ren's spec section 126: reason required whenever the amount/qty actually
      // changes -- checked here too (not just server-side) so the user isn't
      // surprised by a rejected save after already reviewing the confirmation below.
      if (amountChanged && !reason) { notify('A reason is required when changing the amount or quantity.', true); return; }
      // Ren's spec section 127: confirm old vs new amount before saving.
      if (amountChanged && !confirm(
        'Confirm amount change?\n\nOld Amount: ' + money(h.unit_price) + '\nNew Amount: ' + money(unitPrice) +
        '\nDifference: ' + money(Number(unitPrice || 0) - Number(h.unit_price || 0)) + '\n\nReason: ' + reason
      )) return;
      try {
        await editLayawayHold({ holdId: h.id, sku, qty, unitPrice, customerName, contactNumber, orderId, notes, reason });
        notify('Layaway updated.', false);
        await load();
        refreshDetailIfOpen(h.id);
      } catch (err) {
        notify(String(err.message || err), true);
      }
    });
  }

  function render() {
    const fSearch = document.getElementById('lw-f-search').value.trim().toLowerCase();
    let rows = allHolds;
    if (fSearch) rows = rows.filter((h) =>
      h.sku.toLowerCase().includes(fSearch) || h.customer_name.toLowerCase().includes(fSearch) ||
      (h.contact_number || '').toLowerCase().includes(fSearch) || (h.order_id || '').toLowerCase().includes(fSearch));

    const onHold = rows.filter((h) => h.status === 'On Hold');
    const completed = rows.filter((h) => h.status === 'Completed');
    const cancelled = rows.filter((h) => h.status === 'Cancelled');
    const forfeited = rows.filter((h) => h.status === 'Forfeited');
    const totalHeld = onHold.reduce((s, h) => s + Number(h.total_price || 0), 0);
    const totalPaid = onHold.reduce((s, h) => s + paidSoFar(h), 0);
    document.getElementById('lw-tiles').innerHTML =
      tile(onHold.length, 'On Hold') +
      tile(completed.length, 'Completed') +
      tile(money(totalHeld), 'Value On Hold') +
      tile(money(totalPaid), 'Paid So Far');
    document.getElementById('lw-completed-count').textContent = '(' + completed.length + ')';
    document.getElementById('lw-cancelled-count').textContent = '(' + cancelled.length + ')';
    document.getElementById('lw-forfeited-count').textContent = '(' + forfeited.length + ')';

    renderHoldTable('lw-list', onHold);
    renderHoldTable('lw-list-completed', completed);
    renderHoldTable('lw-list-cancelled', cancelled);
    renderHoldTable('lw-list-forfeited', forfeited);
  }

  // ---- Monthly Monitoring: a wide, per-month rollup with a date-range-filtered
  // summary above it -- separate from the live filtered list above, which is about
  // finding one hold, not seeing the shape of the whole month/year. ----
  function renderMonthly() {
    const fFrom = document.getElementById('mm-from').value;
    const fTo = document.getElementById('mm-to').value;
    renderMonthlyPayments(fFrom, fTo);
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
    const months = Object.keys(byMonth).sort().reverse();
    const box = document.getElementById('mm-table');
    if (!months.length) { box.innerHTML = '<p class="muted">No layaway holds for this range.</p>'; return; }
    box.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Month</th><th>Total Holds</th><th>On Hold</th><th>Completed</th><th>Total Value</th><th>Total Paid</th><th>Remaining</th></tr></thead><tbody>' +
      months.map((key) => {
        const m = byMonth[key];
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
  // -- same From/To inputs as the rollup above, but applied to each PAYMENT's own
  // paid_at instead of its hold's hold_date, and listing them individually rather than
  // rolling them into one number. Every hold regardless of status is included here
  // (unlike the rollup, which excludes Cancelled/Forfeited) -- a payment that actually
  // happened stays on this ledger even if the hold it was against was later cancelled.
  function renderMonthlyPayments(fFrom, fTo) {
    const box = document.getElementById('mm-payments-table');
    const payments = [];
    allHolds.forEach((h) => {
      // Status computed against this hold's FULL payment history, not just the
      // filtered range, so a payment near a range boundary still shows the right
      // running-total status (Ren's spec section 1: explicit Payment Status).
      const statusById = paymentStatusFor(h.layaway_payments || [], h.total_price);
      (h.layaway_payments || []).forEach((p) => {
        if (fFrom && p.paid_at < fFrom) return;
        if (fTo && p.paid_at > fTo) return;
        payments.push({ ...p, hold: h, paymentStatus: statusById[p.id] });
      });
    });
    payments.sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || ''));
    if (!payments.length) { box.innerHTML = '<p class="muted">No payments recorded for this range.</p>'; return; }
    const total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    box.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Date</th><th>Branch</th><th>SKU</th><th>Customer</th><th>Amount</th><th>Method</th><th>Status</th><th>Recorded By</th></tr></thead><tbody>' +
      payments.map((p) => '<tr>' +
        '<td data-label="Date">' + fmtDate(p.paid_at) + '</td>' +
        '<td data-label="Branch">' + esc(p.hold.branches ? p.hold.branches.name : '—') + '</td>' +
        '<td data-label="SKU">' + esc(p.hold.sku) + '</td>' +
        '<td data-label="Customer">' + esc(p.hold.customer_name) + '</td>' +
        '<td data-label="Amount">' + money(p.amount) + '</td>' +
        '<td data-label="Method">' + esc(p.payment_method) + (p.reference_number ? ' · Receipt/Txn #' + esc(p.reference_number) : '') + '</td>' +
        '<td data-label="Status"><span class="badge ' + (p.paymentStatus === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:10px;">' + p.paymentStatus + '</span></td>' +
        '<td data-label="Recorded By">' + (p.employees ? esc(p.employees.full_name) : '—') + '</td>' +
      '</tr>').join('') +
      '</tbody><tfoot><tr style="font-weight:bold;background:#f7f7f7;"><td colspan="4">Total</td><td>' + money(total) + '</td><td colspan="3"></td></tr></tfoot>' +
      '</table></div>';
  }

  // ---- Forfeiture Watch: every still-On-Hold item, oldest first, with its full
  // payment history (a layaway is paid in installments over time, so "how much so
  // far and when" matters more here than a single total) and a Date Purchased +
  // Forfeit Date pair so a row visibly turns red once it's close to or past the
  // cutoff. Forfeit Date defaults to hold_date + 60 days but staff who can act on the
  // hold (same canAct gate as Complete/Cancel) can override it per-item -- every
  // change is logged (layaway_forfeit_date_log, embedded by listLayaways()) and shown
  // right there so it's always visible who moved a deadline and when, and whether it
  // was ever moved at all. Independent of the date-range filter above -- this is
  // about what needs attention right now, not a historical range. ----
  function renderForfeitureWatch() {
    // Days Held replaced with days remaining until the forfeit due date (Ren,
    // 2026-09-16: "instead of days held. show the remaining days until due date") --
    // effectiveForfeit/daysPastForfeit now computed once up front (was previously
    // computed again per-row below) so both the sort and the new column can use it.
    // Sorted most-urgent-first: already-overdue items surface above ones still
    // safely within their window, matching what a forfeiture watch list is for.
    const rows = allHolds
      .filter((h) => h.status === 'On Hold')
      .map((h) => {
        const effectiveForfeit = h.forfeit_date || defaultForfeitDate(h.hold_date);
        return { h, effectiveForfeit, daysPastForfeit: daysSince(effectiveForfeit) };
      })
      .sort((a, b) => b.daysPastForfeit - a.daysPastForfeit);

    const box = document.getElementById('fw-table');
    if (!rows.length) { box.innerHTML = '<p class="muted">No items currently on hold.</p>'; return; }

    box.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<thead><tr><th>Date Purchased</th><th>Item</th><th>Customer</th><th>Payments</th><th>Paid</th><th>Remaining</th><th>Days Remaining</th><th>Forfeit Date</th></tr></thead><tbody>' +
      rows.map(({ h, effectiveForfeit, daysPastForfeit }) => {
        const paid = paidSoFar(h);
        const remaining = h.total_price == null ? null : Number(h.total_price) - paid;
        const isOverdue = daysPastForfeit >= 0;
        const isWarning = !isOverdue && daysPastForfeit >= -FORFEITURE_WARN_LEAD_DAYS;
        const rowStyle = isOverdue ? 'background:#fdecea;' : isWarning ? 'background:#fff3f3;' : '';
        const payments = h.layaway_payments || [];
        const paymentStatusById = paymentStatusFor(payments, h.total_price);
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        const canAct = canManage || employee.branch_id === h.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
        const history = (h.layaway_forfeit_date_log || []).slice().sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
        const lastEdit = history.length ? history[history.length - 1] : null;
        const hdHistory = (h.layaway_hold_date_log || []).slice().sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
        const hdLastEdit = hdHistory.length ? hdHistory[hdHistory.length - 1] : null;
        const pendingForfeit = pendingForfeitRequests.find((r) => r.hold_id === h.id);
        return '<tr style="' + rowStyle + '">' +
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
              ? '<button type="button" class="btn small secondary fw-hold-date-history" data-hold-id="' + h.id + '" style="font-size:10px;padding:1px 6px;margin-top:2px;">History (' + hdHistory.length + ')</button>' +
                '<div class="fw-hold-date-history-list" data-hold-id="' + h.id + '" style="display:none;font-size:10px;margin-top:4px;border-top:1px dashed #ddd;padding-top:4px;">' +
                  hdHistory.map((l) => (l.old_date ? fmtDate(l.old_date) : '<span class="muted">—</span>') + ' → <strong>' + fmtDate(l.new_date) + '</strong> by ' + esc(l.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(l.changed_at)).join('<br>') +
                '</div>'
              : '') +
          '</td>' +
          '<td data-label="Item">' + esc(h.sku) +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
            (h.stock_status === 'Lacking' ? ' <span class="badge low" title="Not physically in stock yet -- needs to be sourced before this can be completed">Lacking</span>' : '') +
            (h.order_id ? '<div class="muted" style="font-size:10px;">Order ' + esc(h.order_id) + '</div>' : '') + '</td>' +
          '<td data-label="Customer">' + esc(h.customer_name) + (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') +
            // Forfeit right from this watch list (Ren, 2026-09-17: "add a forfeited
            // click side of the details of the customer") -- same action/gate as the
            // On Hold list's own Forfeit button, just reachable without scrolling
            // back up to it.
            (canFinalDelete ? '<button type="button" class="btn small secondary fw-forfeit-hold" data-hold-id="' + h.id + '" style="margin-top:4px;">Forfeit</button>' : '') +
          '</td>' +
          '<td data-label="Payments" class="full-row" style="font-size:11px;">' +
            (payments.length
              ? payments.map((p) => money(p.amount) + ' · ' + esc(p.payment_method) + (p.reference_number ? ' · Receipt/Txn #' + esc(p.reference_number) : '') +
                  ' <span class="badge ' + (paymentStatusById[p.id] === 'Paid in Full' ? 'ok' : 'pending') + '" style="font-size:9px;padding:1px 5px;">' + paymentStatusById[p.id] + '</span>' +
                  ' — ' + (p.paid_at || '') +
                  (p.employees ? ' · ' + esc(p.employees.full_name) : '') +
                  (p.attachment_path ? ' <button type="button" class="btn small secondary fw-view-proof" data-path="' + esc(p.attachment_path) + '" style="padding:0 5px;">Proof</button>' : '')).join('<br>')
              : '<span class="muted">No payments yet</span>') +
          '</td>' +
          '<td data-label="Paid">' + money(paid) + '</td>' +
          '<td data-label="Remaining">' + (remaining !== null ? money(remaining) : '—') + '</td>' +
          '<td data-label="Days Remaining">' + (isOverdue ? '<span class="badge low">Overdue ' + daysPastForfeit + 'd</span>' : (-daysPastForfeit) + 'd left') + '</td>' +
          '<td data-label="Forfeit Date">' +
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
            (isOverdue ? ' <span class="badge low">FORFEITURE DUE</span>' : isWarning ? ' <span class="badge low">NEARING</span>' : '') +
            (lastEdit
              ? '<div class="muted" style="font-size:10px;margin-top:2px;">Edited by ' + esc(lastEdit.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(lastEdit.changed_at) + '</div>'
              : '<div class="muted" style="font-size:10px;margin-top:2px;">Never edited (default 60-day date)</div>') +
            (history.length
              ? '<button type="button" class="btn small secondary fw-forfeit-history" data-hold-id="' + h.id + '" style="font-size:10px;padding:1px 6px;margin-top:2px;">History (' + history.length + ')</button>' +
                '<div class="fw-forfeit-history-list" data-hold-id="' + h.id + '" style="display:none;font-size:10px;margin-top:4px;border-top:1px dashed #ddd;padding-top:4px;">' +
                  history.map((l) => (l.old_date ? fmtDate(l.old_date) : '<span class="muted">default</span>') + ' → <strong>' + fmtDate(l.new_date) + '</strong> by ' + esc(l.employees?.full_name || 'Unknown') + ' · ' + fmtDateTime(l.changed_at)).join('<br>') +
                '</div>'
              : '') +
          '</td>' +
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
      btn.disabled = true;
      try {
        await requestLayawayForfeitDate(holdId, input.value);
        notify('Forfeit date change submitted -- awaiting Admin approval.', false);
        await loadPendingForfeitRequests();
        renderForfeitureWatch();
      } catch (err) {
        notify(String(err.message || err), true);
        btn.disabled = false;
      }
    }));
    box.querySelectorAll('.fw-forfeit-hold').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Mark this layaway as Forfeited? The customer never paid it off -- the item goes back to Available stock.')) return;
      try { await forfeitLayawayHold(Number(btn.dataset.holdId)); notify('Layaway forfeited.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    }));
    box.querySelectorAll('.fw-forfeit-history').forEach((btn) => btn.addEventListener('click', () => {
      const div = box.querySelector('.fw-forfeit-history-list[data-hold-id="' + btn.dataset.holdId + '"]');
      div.style.display = div.style.display === 'none' ? '' : 'none';
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
      div.style.display = div.style.display === 'none' ? '' : 'none';
    }));
    box.querySelectorAll('.fw-view-proof').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const url = await getLayawayPaymentProofUrl(btn.dataset.path);
        window.open(url, '_blank');
      } catch (err) {
        notify(String(err.message || err), true);
      }
    }));
  }

  function tile(num, label) { return '<div class="tile"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>'; }

  const unsubscribe = subscribeToChanges(['layaway_holds', 'layaway_payments', 'layaway_forfeit_date_log', 'layaway_hold_date_log', 'layaway_forfeit_date_requests'], load);
  await load();

  return { reload: load, unsubscribe };
}
