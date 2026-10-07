// Subasta tab (Branches page) -- standalone module scoped to whichever branch is selected on the host page
// (getBranchId()). Upgraded 2026-10-07 (Ren's Branches spec) on the same records as before:
//   * the summary tiles (Total Items, Total Weight, Pending, Listed, Sold, Unsold, Total Sales, Average Sale Price ...) come
//     from the server (subasta_ops_report) for the global date range, so they never depend on how many rows this tab loaded;
//   * an item now carries its metal / purity / category, the pawner (name, contact, pawn reference, original source), the
//     pawn details (pawn date, principal, auction eligible date) and its sale (buyer, price, split payments with proof);
//   * statuses PENDING -> ELIGIBLE (derived: the auction eligible date has been reached) -> LISTED -> SOLD, plus ON HOLD,
//     WITHDRAWN and CANCELLED. Listing before the eligible date, holding, withdrawing, cancelling and reopening each ask for
//     a reason; every status change, sale and payment goes through a database function that checks the rules, who may do
//     it, and writes the audit trail (shown as History in the drawer);
//   * Mark Sold records the sale and its payment lines together (the shared payment rows, js/paymentRows.js), a partial
//     payment leaves the balance UNPAID until the rest is added, and a payment can be corrected (reason + kind of mistake);
//   * deleting goes through a request that a supervisor and then Admin approve (the same chain Scrap uses); an item that has
//     payments, or that came from a scrap purchase, cannot be deleted -- it is Cancelled instead;
//   * people allowed to see it can open a pawner's history (every item that pawner pawned).
// The drawer pattern, filters and cards are the ones Layaway and Scrap already use.
import {
  listSubastaItems, getSubastaOpsReport, createSubastaItem, updateSubastaItem, setSubastaStatus, markSubastaSold, addSubastaPayment,
  updateSubastaPayment, uploadSubastaPaymentProof, getSubastaAttachmentUrl, getSubastaPawnerHistory, searchProducts,
  listBranchAuditLog, listBranchRecordRequests, requestBranchRecordAction, approveBranchRecordStage1, approveBranchRecordFinal,
  rejectBranchRecordAction, cancelBranchRecordAction, adminApplyBranchRecordAction, subscribeToChanges,
} from './api.js?v=20261007r';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20261007r';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, byDate, flagInvalid } from './uiKit.js?v=20261007r';
import { confirmDialog, reasonDialog, ERROR_TYPES } from './dialogs.js?v=20261007r';
import { paymentStatusOf, paymentChipHtml } from './paymentStatus.js?v=20261007r';
import { pageSlice, pagerHtml, wirePager } from './pager.js?v=20261007r';
import { approvalCardHtml, setApprovalFolder } from './approvalUi.js?v=20261007r';
import { attachCustomerPicker } from './customerPicker.js?v=20261007r';
import { paymentRowsHtml, mountPaymentRows } from './paymentRows.js?v=20261007r';
import { METALS, purityFields } from './metals.js?v=20261007r';
import { manilaToday, manilaDateStr, daysBetween } from './opsDates.js?v=20261007r';
import { friendlyError } from './shell.js?v=20261007r';

// Global Filter + Sort rules (Ren, 2026-09-21, section 19): Subasta sortable by Pawn Date / Item / SKU / Weight / Sale Price / Status.
const SB_SORT_FIELDS = [
  { key: 'pawn_date', label: 'Pawn Date' }, { key: 'item_description', label: 'Item' }, { key: 'sku', label: 'SKU' }, { key: 'pawner_name', label: 'Pawner' },
  { key: 'weight_grams', label: 'Weight' }, { key: 'auction_eligible_date', label: 'Eligible Date' }, { key: 'status', label: 'Status' }, { key: 'sale_price', label: 'Sale Price' },
];
const SB_SORT_COMPARATORS = {
  pawn_date: (a, b) => byDate('pawn_date')(a, b) || a.id - b.id, item_description: byText('item_description'), sku: byText('sku'), pawner_name: byText('pawner_name'),
  weight_grams: byNumber('weight_grams'), auction_eligible_date: byDate('auction_eligible_date'), status: (a, b) => String(a._eff).localeCompare(String(b._eff)),
  sale_price: byNumber('sale_price'),
};

const money = (n) => n === null || n === undefined ? '—' : (Number(n) < 0 ? '−₱' : '₱') + Math.abs(Number(n)).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const grams = (n) => n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' g';
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');

// PENDING gray, ELIGIBLE yellow (ready to list), LISTED blue, ON HOLD red (do not sell), SOLD green, WITHDRAWN / CANCELLED gray.
const STATUS_LABEL = { Pending: 'PENDING', Eligible: 'ELIGIBLE', Listed: 'LISTED', Hold: 'ON HOLD', Sold: 'SOLD', Withdrawn: 'WITHDRAWN', Cancelled: 'CANCELLED' };
const STATUS_TONE = { Pending: 'gray', Eligible: 'yellow', Listed: 'blue', Hold: 'red', Sold: 'green', Withdrawn: 'gray', Cancelled: 'gray' };
const statusBadge = (s) => '<span class="badge st-' + (STATUS_TONE[s] || 'gray') + '">' + (STATUS_LABEL[s] || s) + '</span>';
const OPEN = ['Pending', 'Eligible', 'Listed', 'Hold'];
const STATUS_FILTERS = [['all', 'All statuses'], ['open', 'Open (not sold or closed)'], ['pending', 'Pending'], ['eligible', 'Eligible to list'], ['Listed', 'Listed'],
  ['Hold', 'On hold'], ['Sold', 'Sold'], ['unpaid', 'Sold — not fully paid'], ['Withdrawn', 'Withdrawn'], ['Cancelled', 'Cancelled']];
const CATEGORIES = ['Ring', 'Necklace', 'Bracelet', 'Bangle', 'Earrings', 'Pendant', 'Chain', 'Watch', 'Other'];
const ORIGINS = ['From customer', 'Converted from Scrap', 'Walk-in', 'Referral', 'Other'];

const FIELD_LABELS = {
  sku: 'SKU', item_description: 'Item', category: 'Category', metal_type: 'Metal', purity: 'Purity', weight_grams: 'Weight (g)', pawner_name: 'Pawner', pawner_contact: 'Pawner contact',
  pawn_reference: 'Pawn reference', original_source: 'Original source', pawn_date: 'Pawn date', principal_amount: 'Principal', auction_eligible_date: 'Auction eligible date',
  listed_date: 'Listed date', notes: 'Notes', sale_date: 'Sale date', sale_price: 'Sale price', buyer_name: 'Buyer', buyer_contact: 'Buyer contact', status: 'Status',
  amount: 'Amount', payment_method: 'Method', reference_number: 'Reference', paid_at: 'Date paid',
};

/** Mounts the Subasta tab into `root` (an empty container this owns entirely), scoped to `getBranchId()` at call time.
 * `esc`/`toast` are the page's own shell.js helpers; `msgId` is the id of the page's toast container; `employee` is the
 * signed-in employee record (with .permissions); `branches` every active branch.
 * Returns { reload, unsubscribe, openDetail, applyView }. */
export async function initSubastaTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate, getRange, requestRange }) {
  // What this person may do. The database enforces every one of these again; this only decides which buttons to show,
  // using the same permission keys / rules the server functions check.
  const perms = new Set(employee.permissions || []);
  const has = (k) => perms.has(k);
  const isAdmin = employee.role === 'Admin';
  const isSupervisorUp = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || (employee.position || '').toLowerCase().includes('supervisor');
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch ' + id);
  // assert_can_act_on_branch() / _can_act_on_branch()
  function canActOnBranch(bid) {
    if (['Admin', 'Manager'].includes(employee.role)) return true;
    if (employee.role === 'None' && ['Sales Admin Associate', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'].includes(employee.position)) return true;
    if (employee.position === 'Auditor') return true;
    return employee.branch_id != null && employee.branch_id === bid;
  }
  // _branch_can_add(): the people the old insert policy let add Subasta items -- plus anyone for their own branch.
  function canAddHere() {
    return has('system.manager_or_admin') || has('role.position_manager') || has('role.admin_assistant') || has('role.sales_executive') ||
      (employee.branch_id != null && employee.branch_id === getBranchId());
  }
  const canManageAt = (bid) => has('subasta.manage') && canActOnBranch(bid);
  const canSeeHistory = () => has('subasta.pawner_history');

  const sort = { field: 'pawn_date', dir: 'desc' };
  const pg = { page: 1 };
  let items = [], requests = [];
  let report = null, reportErr = '', reportSeq = 0;
  let openId = null, mode = null; // mode: null | 'edit' | 'sold' | 'history' -- a form being typed in is never redrawn by a live refresh

  const notify = (text, isError) => toast(msgId, text, isError);
  const effOf = (r) => (r.status === 'Pending' && r.auction_eligible_date && r.auction_eligible_date <= manilaToday() ? 'Eligible' : r.status);

  const filterCard =
    // Relocates into the Branch page's shared #tab-filters-slot -- starts hidden since Subasta isn't the default tab;
    // showSubTab() there toggles it back on when this tab is selected.
    '<div class="card" id="subasta-filter-card" data-filter-tab="subasta" style="display:none;">' +
      '<h3 style="margin-top:0;">Search &amp; Filter</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="sb-f-search" placeholder="Item, SKU, pawner, pawn ref, buyer, reference, #id…"></div>' +
        '<div class="field"><label>Status</label><select id="sb-f-status">' + STATUS_FILTERS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Metal</label><select id="sb-f-metal"><option value="all">All</option>' + METALS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
        // From/To are driven by the page's global date range: kept in the DOM, not shown.
        '<div class="field range-managed"><label>From</label><input type="date" id="sb-f-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="sb-f-to"></div>' +
        sortControlHtml(SB_SORT_FIELDS, sort, 'sb-sort-field', 'sb-sort-dir') +
        '<button type="button" class="btn small secondary" id="sb-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>';

  root.innerHTML =
    '<div class="module-topbar"><div></div><div style="text-align:right;">' +
      '<button type="button" class="btn" id="sb-new-btn">+ New Subasta</button>' +
      '<div id="sb-write-note"></div>' +
    '</div></div>' +
    '<div class="muted" id="sb-caption" style="margin:0 0 6px;font-size:12px;"></div>' +
    '<div class="tiles" id="sb-tiles"><div class="muted">Loading…</div></div>' +
    filterCard +
    '<div id="sb-active"></div>' +
    '<div id="sb-list" style="margin-top:10px;"><div class="muted">Loading…</div></div>' +
    // Delete requests: collapsed while empty, opened and highlighted while something waits.
    '<h3 style="margin:18px 0 6px;">Approvals</h3>' +
    '<details class="card exp lw-approval" id="sb-requests-folder">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Subasta Delete Requests <span class="exp-count" id="sb-requests-count"></span></summary>' +
      '<div class="exp-body" id="sb-requests-list"><div class="muted">Loading…</div></div>' +
    '</details>' +

    '<div class="drawer-backdrop" id="sb-form-backdrop"></div>' +
    '<div class="drawer" id="sb-form-drawer">' +
      '<div class="drawer-header"><h3>New Subasta</h3><button type="button" class="drawer-close" id="sb-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<form id="sb-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="msg error" id="sb-form-err" role="alert" hidden></div>' +
          '<div class="drawer-section"><h4>Item</h4>' +
            '<div class="field" style="position:relative;"><label>SKU</label>' +
              '<input type="text" name="sku" id="sb-sku" autocomplete="off" placeholder="Type a SKU or item name…">' +
              '<div id="sb-sku-name" class="muted" style="font-size:11px;"></div>' +
              '<div id="sb-sku-suggest" class="cust-suggest" hidden></div>' +
            '</div>' +
            '<div class="field"><label>Item description *</label><input type="text" name="itemDescription"></div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Category</label><input type="text" name="category" list="sb-cat-list" autocomplete="off"><datalist id="sb-cat-list">' + CATEGORIES.map((c) => '<option value="' + c + '">').join('') + '</datalist></div>' +
              '<div class="field"><label>Metal *</label><select name="metal"><option value="">— choose —</option>' + METALS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
            '</div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Purity</label><select name="purity"></select></div>' +
              '<div class="field"><label>Weight (grams)</label><input type="number" name="weight" step="0.001" min="0" inputmode="decimal"></div>' +
            '</div>' +
            '<div class="field" data-purity-other hidden><label>Custom purity *</label><input type="text" name="purityOther" placeholder="e.g. 20K"></div>' +
          '</div>' +
          '<div class="drawer-section"><h4>Pawner / source</h4>' +
            '<div class="field"><label>Pawner name</label><input type="text" name="pawner" autocomplete="off"></div>' +
            '<div class="field"><label>Contact number</label><input type="text" name="pawnerContact" autocomplete="off" inputmode="tel"></div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Pawn reference</label><input type="text" name="pawnReference"></div>' +
              '<div class="field"><label>Original source</label><input type="text" name="originalSource" list="sb-origin-list" autocomplete="off"><datalist id="sb-origin-list">' + ORIGINS.map((o) => '<option value="' + o + '">').join('') + '</datalist></div>' +
            '</div>' +
          '</div>' +
          '<div class="drawer-section"><h4>Pawn details</h4>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Pawn date</label><input type="date" name="pawnDate"></div>' +
              '<div class="field"><label>Principal amount (₱)</label><input type="number" name="principal" step="0.01" min="0" inputmode="decimal"></div>' +
            '</div>' +
            '<div class="field"><label>Auction eligible date</label><input type="date" name="eligibleDate"></div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Branch</label><input type="text" id="sb-form-branch" readonly tabindex="-1"></div>' +
              '<div class="field"><label>Recorded by</label><input type="text" value="' + esc(employee.full_name || '') + '" readonly tabindex="-1"></div>' +
            '</div>' +
          '</div>' +
          '<div class="drawer-section"><h4>Notes</h4><div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
            '<label class="sb-check" id="sb-listnow-wrap" hidden><input type="checkbox" name="listNow"> List it for sale right away</label>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="sb-form" id="sb-form-submit">Add Item</button>' +
        '<button type="button" class="btn secondary" id="sb-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +
    '<div class="drawer-backdrop" id="sb-detail-backdrop"></div>' +
    '<div class="drawer" id="sb-detail-drawer">' +
      '<div class="drawer-header"><h3 id="sb-detail-title">Subasta Details</h3><button type="button" class="drawer-close" id="sb-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="sb-detail-body"></div>' +
    '</div>';

  document.getElementById('tab-filters-slot')?.appendChild(document.getElementById('subasta-filter-card'));
  const $ = (id) => document.getElementById(id);
  // Start on the page's global date range (later changes arrive as 'change' events on these inputs).
  const range0 = getRange ? getRange() : null;
  if (range0) {
    $('sb-f-from').value = range0.preset === 'all' ? '' : range0.from;
    $('sb-f-to').value = range0.preset === 'all' ? '' : range0.to;
  }

  // ---------------------------------------------------------------------------------------------
  // New Subasta drawer
  // ---------------------------------------------------------------------------------------------
  const form = $('sb-form');
  const fe = (f, name) => f.elements[name];
  const today = () => manilaToday();
  const purity = purityFields(form);

  function showFormError(message, el) {
    const box = $('sb-form-err');
    box.textContent = friendlyError(message); box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (el) flagInvalid(el);
  }
  // "List it right away" is for people who may list, and only while the eligible date is not in the future (an early listing needs a reason).
  function syncListNow() {
    const wrap = $('sb-listnow-wrap');
    const may = canManageAt(getBranchId());
    wrap.hidden = !may;
    const e = fe(form, 'eligibleDate').value;
    const early = !!e && e > today();
    fe(form, 'listNow').disabled = early;
    if (early) fe(form, 'listNow').checked = false;
    wrap.title = early ? 'Not eligible for auction until ' + fmtDate(e) + ' -- list it from its details with a reason.' : '';
  }
  function resetForm() {
    form.reset();
    $('sb-form-err').hidden = true;
    fe(form, 'pawnDate').value = today(); fe(form, 'pawnDate').max = today();
    $('sb-form-branch').value = branchName(getBranchId());
    purity.set('', '');
    $('sb-sku-name').textContent = '';
    hideSuggest();
    syncListNow();
  }

  // SKU autocomplete -- connects a pawned item back to a real SKU Catalog product (picking a suggestion also fills the
  // description, weight, category and, when the catalog knows it, the metal and purity -- only where still blank).
  const skuInput = $('sb-sku'), skuSuggest = $('sb-sku-suggest'), skuNamePreview = $('sb-sku-name');
  let skuToken = 0, skuTimer = null;
  function hideSuggest() { skuSuggest.hidden = true; skuSuggest.innerHTML = ''; }
  function pickSku(p) {
    skuInput.value = p.sku;
    skuNamePreview.textContent = p.item_name + (p.category || p.product_line ? ' · ' + (p.category || p.product_line) : '');
    if (!fe(form, 'itemDescription').value.trim()) fe(form, 'itemDescription').value = p.item_name || '';
    if (!fe(form, 'weight').value && p.gross_weight_g != null && Number(p.gross_weight_g) > 0) fe(form, 'weight').value = p.gross_weight_g;
    if (!fe(form, 'category').value.trim() && (p.category || p.product_line)) fe(form, 'category').value = p.category || p.product_line;
    const mp = String(p.metal_purity || '').trim().toUpperCase();
    if (!fe(form, 'metal').value) {
      if (/^(10|14|16|18|21|22|24)K$/.test(mp)) purity.set('Gold', mp);
      else if (['999', '925', '800'].includes(digits(mp))) purity.set('Silver', digits(mp));
    }
    hideSuggest();
  }
  skuInput.addEventListener('input', () => {
    skuNamePreview.textContent = '';
    const q = skuInput.value.trim();
    clearTimeout(skuTimer);
    if (!q) { hideSuggest(); return; }
    skuTimer = setTimeout(async () => {
      const token = ++skuToken;
      try {
        const results = await searchProducts(q);
        if (token !== skuToken) return;
        if (!results.length) { hideSuggest(); return; }
        skuSuggest.innerHTML = results.slice(0, 8).map((p, i) =>
          '<button type="button" data-i="' + i + '"><b>' + esc(p.sku) + '</b> — ' + esc(p.item_name) +
            (p.category || p.product_line ? '<span class="muted"> ' + esc(p.category || p.product_line) + '</span>' : '') + '</button>').join('');
        skuSuggest.hidden = false;
        skuSuggest.querySelectorAll('[data-i]').forEach((row) => row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickSku(results[Number(row.dataset.i)]); }));
        const exact = results.find((p) => p.sku.toLowerCase() === q.toLowerCase());
        if (exact) skuNamePreview.textContent = exact.item_name + (exact.category || exact.product_line ? ' · ' + (exact.category || exact.product_line) : '');
      } catch (err) { /* a failed lookup must not block typing a SKU by hand */ }
    }, 200);
  });
  skuInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  skuInput.addEventListener('focus', () => { if (skuSuggest.innerHTML) skuSuggest.hidden = false; });
  fe(form, 'eligibleDate').addEventListener('change', syncListNow);
  attachCustomerPicker({ nameInput: fe(form, 'pawner'), contactInput: fe(form, 'pawnerContact') });

  const openFormDrawer = () => { resetForm(); $('sb-form-backdrop').classList.add('open'); $('sb-form-drawer').classList.add('open'); };
  const closeFormDrawer = () => { $('sb-form-backdrop').classList.remove('open'); $('sb-form-drawer').classList.remove('open'); };
  $('sb-new-btn').addEventListener('click', openFormDrawer);
  $('sb-form-close').addEventListener('click', closeFormDrawer);
  $('sb-form-cancel').addEventListener('click', closeFormDrawer);
  $('sb-form-backdrop').addEventListener('click', closeFormDrawer);

  /** The rules both the New form and the Edit form check before asking the database (which checks them again). */
  function itemProblem(v) {
    if (!v.itemDescription) return ['Enter the item description.', 'itemDescription'];
    if (!v.metal) return ['Choose the metal (Gold, Silver or Other).', 'metal'];
    if ((v.metal === 'Gold' || v.metal === 'Silver') && !v.purity) return ['Choose the purity (or type a custom one) -- it is needed for gold and silver.', 'purity'];
    if (v.weight != null && !(v.weight > 0)) return ['Weight must be more than 0 grams.', 'weight'];
    if ((v.metal === 'Gold' || v.metal === 'Silver') && v.weight == null) return ['Enter the weight in grams -- it is needed for gold and silver.', 'weight'];
    if (v.principal != null && v.principal < 0) return ['The principal amount cannot be negative.', 'principal'];
    if (v.pawnDate && v.pawnDate > today()) return ['The pawn date cannot be in the future.', 'pawnDate'];
    if (v.pawnDate && v.eligibleDate && v.eligibleDate < v.pawnDate) return ['The auction eligible date cannot be before the pawn date.', 'eligibleDate'];
    return null;
  }
  const numOrNull = (el) => (el.value === '' ? null : Number(el.value));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('sb-form-err').hidden = true;
    const v = {
      itemDescription: fe(form, 'itemDescription').value.trim(), metal: fe(form, 'metal').value, purity: purity.read(), weight: numOrNull(fe(form, 'weight')),
      principal: numOrNull(fe(form, 'principal')), pawnDate: fe(form, 'pawnDate').value, eligibleDate: fe(form, 'eligibleDate').value,
    };
    const bad = itemProblem(v);
    if (bad) return void showFormError(bad[0], fe(form, bad[1]));
    const btn = $('sb-form-submit');
    btn.disabled = true;
    try {
      const id = await createSubastaItem({
        branchId: getBranchId(), sku: fe(form, 'sku').value.trim(), itemDescription: v.itemDescription, category: fe(form, 'category').value.trim(), metal: v.metal,
        purity: v.purity, weight: v.weight, pawnerName: fe(form, 'pawner').value.trim(), pawnerContact: fe(form, 'pawnerContact').value.trim(),
        pawnReference: fe(form, 'pawnReference').value.trim(), originalSource: fe(form, 'originalSource').value.trim(), pawnDate: v.pawnDate || null,
        principal: v.principal, auctionEligibleDate: v.eligibleDate || null, notes: fe(form, 'notes').value.trim(),
      });
      let warn = '';
      if (fe(form, 'listNow').checked && !fe(form, 'listNow').disabled) {
        try { await setSubastaStatus(id, 'list'); } catch (err) { warn = ' It could not be listed yet (' + friendlyError(String(err.message || err)) + ') -- list it from its details.'; }
      }
      notify('Item added.' + warn, !!warn);
      closeFormDrawer();
      await load();
      openDetail(id);
    } catch (err) {
      showFormError(String(err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------------------------
  function decorate(r) {
    r._paid = (r.subasta_payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
    r._eff = effOf(r);
    r._st = r.status === 'Sold' ? paymentStatusOf(r.sale_price, r._paid) : paymentStatusOf(0, 0);
    r._hay = [r.id, '#' + r.id, r.item_description, r.sku, r.category, r.metal_type, r.purity, r.pawner_name, r.pawner_contact, r.pawn_reference, r.original_source,
      r.buyer_name, r.buyer_contact, r.notes, r.status, r._eff, r.pawn_date, r.sale_date, r.weight_grams, r.sale_price, r.creator && r.creator.full_name,
      r.processor && r.processor.full_name, ...(r.subasta_payments || []).map((p) => (p.reference_number || '') + ' ' + p.payment_method)].filter((x) => x != null).join(' ').toLowerCase();
    return r;
  }

  async function loadReport() {
    const mine = ++reportSeq;
    const rg = getRange(), bid = getBranchId();
    try {
      const rep = await getSubastaOpsReport(rg.from, rg.to, [bid]);
      if (mine !== reportSeq) return;
      report = rep; reportErr = '';
    } catch (err) {
      if (mine !== reportSeq) return;
      report = null; reportErr = String(err.message || err);
    }
    renderSummary();
  }

  async function load() {
    const list = $('sb-list');
    if (!items.length) list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const [rows, reqs] = await Promise.all([
        listSubastaItems(getBranchId()),
        listBranchRecordRequests(['subasta_items', 'subasta_payments']).catch(() => []),
      ]);
      items = rows.map(decorate);
      requests = reqs.filter((q) => q.branch_id === getBranchId());
      render();
      refreshOpenDetail();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
    await loadReport();
  }

  // ---------------------------------------------------------------------------------------------
  // Summary (server figures)
  // ---------------------------------------------------------------------------------------------
  function tile(num, label, tone, sub, act) {
    return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"' + (act ? ' data-act="' + act + '" style="cursor:pointer;"' : '') + '><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div>' +
      (sub ? '<div class="muted" style="font-size:10.5px;margin-top:2px;">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function renderSummary() {
    const rg = getRange();
    $('sb-caption').textContent = branchName(getBranchId()) + ' · ' + (rg.label || (rg.from + ' – ' + rg.to)) + ' · Sold and Sales follow these dates; the rest is what is on hand now';
    const tiles = $('sb-tiles');
    if (!report) {
      tiles.innerHTML = reportErr ? '<div class="msg error">The Subasta summary could not be loaded (' + esc(reportErr) + ').</div>' : '<div class="muted">Loading…</div>';
      return;
    }
    const s = report.snapshot, ir = report.in_range, by = s.by_status || {};
    const n = (k) => (by[k] && by[k].n) || 0;
    const sold = ir.sold || { n: 0, grams: 0, sales: 0, avg_price: null };
    const pending = n('Pending') + n('Eligible'), gone = n('Withdrawn') + n('Cancelled');
    let h = tile(s.total_items, 'Total Items', null, gone ? 'incl. ' + gone + ' withdrawn / cancelled' : '', 'all') +
      tile(grams(s.total_grams), 'Total Weight', null, 'unsold: ' + grams(s.unsold.grams)) +
      tile(pending, 'Pending', null, n('Eligible') ? n('Eligible') + ' eligible to list now' : 'waiting to be listed', 'pending') +
      tile(n('Listed'), 'Listed', null, 'for sale now', 'Listed');
    if (n('Hold')) h += tile(n('Hold'), 'On Hold', 'bad', 'do not sell', 'Hold');
    h += tile(sold.n, 'Sold', null, sold.n ? grams(sold.grams) + ' in these dates' : 'none in these dates', 'Sold') +
      tile(s.unsold.n, 'Unsold', null, 'pending + listed + on hold', 'open') +
      tile(money(sold.sales), 'Total Sales', null, 'in these dates') +
      tile(sold.avg_price != null ? money(sold.avg_price) : '—', 'Average Sale Price', null, sold.n ? 'per item sold' : '');
    if (s.unpaid && s.unpaid.entries) h += tile(money(s.unpaid.balance), 'Unpaid Balance', 'bad', s.unpaid.entries + (s.unpaid.entries === 1 ? ' sold item' : ' sold items') + ' not fully paid', 'unpaid');
    tiles.innerHTML = h;
    tiles.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => { setStatusFilter(el.dataset.act); $('sb-list').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  }

  // ---------------------------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------------------------
  function readFilters() {
    return { search: $('sb-f-search').value.trim().toLowerCase(), status: $('sb-f-status').value, metal: $('sb-f-metal').value, from: $('sb-f-from').value, to: $('sb-f-to').value };
  }
  function matchesNonDate(r, f) {
    if (f.metal !== 'all' && r.metal_type !== f.metal) return false;
    switch (f.status) {
      case 'all': break;
      case 'open': if (!OPEN.includes(r.status)) return false; break;
      case 'pending': if (r.status !== 'Pending' && r.status !== 'Eligible') return false; break;
      case 'eligible': if (r._eff !== 'Eligible') return false; break;
      case 'unpaid': if (!(r.status === 'Sold' && r._st.balance > 0.01)) return false; break;
      default: if (r.status !== f.status) return false;
    }
    return !f.search || r._hay.includes(f.search);
  }
  // The global date range narrows what has FINISHED (sold / withdrawn / cancelled) -- an item still open is on the shelf or
  // waiting to be listed whatever the dates, so it is never hidden by them.
  function inRangeItem(r, f) {
    if (!f.from && !f.to) return true;
    if (OPEN.includes(r.status)) return true;
    const d = r.status === 'Sold' ? r.sale_date : manilaDateStr(r.status_changed_at || r.updated_at || r.created_at);
    if (!d) return true;
    return (!f.from || d >= f.from) && (!f.to || d <= f.to);
  }

  function setStatusFilter(v) {
    $('sb-f-status').value = STATUS_FILTERS.some(([k]) => k === v) ? v : 'all';
    $('sb-f-search').value = ''; $('sb-f-metal').value = 'all';
    pg.page = 1; render();
  }

  function eligibleCell(r) {
    if (!r.auction_eligible_date) return '—';
    let chip = '';
    if (r.status === 'Pending' || r.status === 'Eligible') {
      const d = daysBetween(today(), r.auction_eligible_date);
      chip = d <= 0 ? '<div><span class="badge st-yellow" style="font-size:9.5px;">eligible now</span></div>' : '<div class="muted" style="font-size:10.5px;">in ' + d + (d === 1 ? ' day' : ' days') + '</div>';
    }
    return fmtDate(r.auction_eligible_date) + chip;
  }

  function render() {
    const canAdd = canAddHere();
    $('sb-new-btn').disabled = !canAdd;
    $('sb-write-note').innerHTML = canAdd ? '' : '<p class="muted" style="font-size:11px;">View only — you can only add subasta items for your own branch.</p>';
    const f = readFilters();
    items.forEach((r) => { r._eff = effOf(r); });
    const rows = items.filter((r) => matchesNonDate(r, f) && inRangeItem(r, f));
    // The module pill count follows these same filtered rows (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(rows.length);
    const hasFilters = !!(f.search || f.status !== 'all' || f.metal !== 'all');
    const activeEl = $('sb-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(f.search) }, { label: 'Status', value: f.status === 'all' ? '' : esc((STATUS_FILTERS.find(([k]) => k === f.status) || [])[1] || f.status) }, { label: 'Metal', value: esc(f.metal) },
    ], 'sb-f-clear');
    wireProxyButtons(activeEl);
    renderItems(rows, hasFilters);
    renderRequests();
  }

  function emptyList(container, hasFilters) {
    const rg = getRange();
    const rangeLabel = rg && rg.preset !== 'all' ? rg.label : '';
    container.innerHTML = emptyStateHtml({
      message: hasFilters ? 'No subasta items match these filters' + (rangeLabel ? ' (finished items are limited to ' + esc(rangeLabel) + ')' : '') + '.' : 'No subasta items recorded for this branch yet.',
      hasFilters, clearId: 'sb-f-clear', createLabel: canAddHere() ? '+ New Subasta' : null, createId: 'sb-new-btn',
    });
    wireProxyButtons(container);
    if (rangeLabel && requestRange) {
      const more = document.createElement('div');
      more.className = 'empty-state-actions'; more.style.marginTop = '8px';
      more.innerHTML = '<button type="button" class="btn small secondary">Search all dates</button>';
      more.querySelector('button').addEventListener('click', () => requestRange('all'));
      container.querySelector('.empty-state')?.appendChild(more);
    }
  }

  function renderItems(rows, hasFilters) {
    const list = $('sb-list');
    if (!rows.length) { emptyList(list, hasFilters); return; }
    const info = pageSlice(applySort(rows, sort, SB_SORT_COMPARATORS), pg);
    list.innerHTML = '<div class="table-scroll table-2col"><table class="sc-table">' +
      '<thead><tr><th>Item</th><th>Pawner</th><th class="nw">Weight</th><th class="nw">Pawn Ref / Date</th><th class="nw">Eligible</th><th class="nw">Status</th><th class="nw">Sale</th><th class="nw">Payment</th><th></th></tr></thead><tbody>' +
      info.rows.map((r) => '<tr data-row-id="' + r.id + '">' +
        '<td data-label="Item"><b>' + esc(r.item_description) + '</b><div class="muted" style="font-size:10.5px;">' +
          esc([r.sku, r.category, [r.metal_type, r.purity].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—') + '</div></td>' +
        '<td data-label="Pawner">' + (r.pawner_name ? esc(r.pawner_name) + (r.pawner_contact ? '<div class="muted" style="font-size:10.5px;">' + esc(r.pawner_contact) + '</div>' : '') : '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Weight" class="nw">' + grams(r.weight_grams) + '</td>' +
        '<td data-label="Pawn Ref / Date" class="nw">' + esc(r.pawn_reference || '—') + '<div class="muted" style="font-size:10.5px;">' + fmtDate(r.pawn_date) + '</div></td>' +
        '<td data-label="Eligible" class="nw">' + eligibleCell(r) + '</td>' +
        '<td data-label="Status" class="nw">' + statusBadge(r._eff) + (r.status === 'Hold' && r.hold_reason ? '<div class="muted" style="font-size:10px;max-width:130px;white-space:normal;">' + esc(r.hold_reason) + '</div>' : '') + '</td>' +
        '<td data-label="Sale" class="nw">' + (r.status === 'Sold' ? money(r.sale_price) + '<div class="muted" style="font-size:10.5px;">' + esc(r.buyer_name || '') + ' · ' + fmtDate(r.sale_date) + '</div>' : '—') + '</td>' +
        '<td data-label="Payment" class="nw">' + (r.status === 'Sold' ? paymentChipHtml(r._st) + (r._st.balance > 0.01 ? '<div class="muted" style="font-size:10px;">' + money(r._st.balance) + ' left</div>' : '') : '—') + '</td>' +
        '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + r.id + '">View Details</button></td>' +
      '</tr>').join('') + '</tbody></table></div>' + pagerHtml(info);
    wirePager(list, pg, render);
    list.querySelectorAll('tr[data-row-id]').forEach((tr) => tr.addEventListener('click', (ev) => {
      if (ev.target.closest('a, input, select') || (ev.target.closest('button') && !ev.target.closest('[data-act="view-details"]'))) return;
      openDetail(Number(tr.dataset.rowId));
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Delete requests (Pending -> Supervisor Approved -> removed by Admin)
  // ---------------------------------------------------------------------------------------------
  async function runAction(fn, okText) {
    try { await fn(); notify(okText, false); await load(); }
    catch (err) { notify(String(err.message || err), true); }
  }

  function renderRequests() {
    $('sb-requests-count').textContent = '(' + requests.length + ')';
    setApprovalFolder('sb-requests-folder', requests.length);
    const box = $('sb-requests-list');
    if (!requests.length) { box.innerHTML = '<p class="muted">No subasta delete requests waiting.</p>'; return; }
    box.innerHTML = requests.map((q) => {
      const s = q.snapshot || {};
      const mine = q.requested_by === employee.id;
      const awaitingFinal = q.status === 'Supervisor Approved';
      const isPay = q.record_table === 'subasta_payments';
      const verb = isPay ? 'remove' : 'delete';
      const buttons = [];
      if (q.status === 'Pending' && isSupervisorUp && (isAdmin || !mine)) {
        buttons.push('<button class="btn small" data-act="sup-approve" data-id="' + q.id + '">Approve</button>');
        if (isAdmin) buttons.push('<button class="btn small danger" data-act="admin-approve" data-id="' + q.id + '">Approve &amp; ' + verb + '</button>');
      }
      if (awaitingFinal && isAdmin) buttons.push('<button class="btn small danger" data-act="final-approve" data-id="' + q.id + '">Final approval — ' + verb + '</button>');
      if (isSupervisorUp && (q.status === 'Pending' || isAdmin)) buttons.push('<button class="btn small secondary" data-act="reject" data-id="' + q.id + '">Reject</button>');
      if (mine || isAdmin) buttons.push('<button class="btn small secondary" data-act="withdraw" data-id="' + q.id + '">Withdraw</button>');
      return approvalCardHtml(esc, {
        type: isPay ? 'Remove subasta payment' : 'Delete subasta item', order: s.order, customer: s.customer,
        item: isPay ? [s.method, s.reference ? '#' + s.reference : ''].filter(Boolean).join(' ') : [s.item, [s.metal, s.purity].filter(Boolean).join(' '), s.grams != null ? grams(s.grams) : ''].filter(Boolean).join(' · '),
        amount: s.amount, requester: q.requester && q.requester.full_name, requestedAt: q.requested_at, reason: q.reason,
        detail: (q.error_type ? 'Kind of mistake: <b>' + esc(q.error_type) + '</b>' : '') +
          (isPay ? (q.error_type ? ' · ' : '') + 'paid ' + fmtDate(s.paid_at) + (s.entry_amount != null ? ' · the sale is ' + money(s.entry_amount) : '') : ''),
        supervisor: q.supervisor && q.supervisor.full_name, awaitingFinal,
        actions: buttons.join('') || '<span class="muted" style="font-size:12px;">' + (awaitingFinal ? 'Waiting for Admin.' : 'Waiting for a supervisor.') + '</span>',
      });
    }).join('');
    box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id), act = btn.dataset.act;
      const isPay = (requests.find((x) => x.id === id) || {}).record_table === 'subasta_payments';
      if (act === 'sup-approve') return runAction(() => approveBranchRecordStage1(id), 'Approved — now waiting for Admin.');
      if (act === 'admin-approve' || act === 'final-approve') {
        if (!await confirmDialog(isPay
          ? { title: 'Remove this payment?', message: 'The sale goes back to owing that amount. What was removed stays in the audit trail.', confirmLabel: 'Remove payment', danger: true }
          : { title: 'Delete this subasta item?', message: 'The item is removed. What was removed stays in the audit trail.', confirmLabel: 'Delete item', danger: true })) return;
        return runAction(async () => { if (act === 'admin-approve') await approveBranchRecordStage1(id); await approveBranchRecordFinal(id); }, isPay ? 'Payment removed.' : 'Item deleted.');
      }
      if (act === 'reject') {
        const out = await reasonDialog({ title: 'Reject this delete request?', message: 'Optional: tell the person why.', label: 'Reason', required: false, confirmLabel: 'Reject', danger: true });
        if (!out) return;
        return runAction(() => rejectBranchRecordAction(id, out.reason || null), 'Request rejected.');
      }
      if (act === 'withdraw') {
        if (!await confirmDialog({ title: 'Withdraw this request?', message: 'The item stays as it is.', confirmLabel: 'Withdraw' })) return;
        return runAction(() => cancelBranchRecordAction(id), 'Request withdrawn.');
      }
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Detail drawer
  // ---------------------------------------------------------------------------------------------
  function closeDetailDrawer() {
    $('sb-detail-backdrop').classList.remove('open');
    $('sb-detail-drawer').classList.remove('open');
    openId = null; mode = null;
  }
  $('sb-detail-close').addEventListener('click', closeDetailDrawer);
  $('sb-detail-backdrop').addEventListener('click', closeDetailDrawer);

  function openDetail(id) {
    const r = items.find((x) => Number(x.id) === Number(id));
    if (!r) return false; // not in the loaded branch -- the host may switch branch and retry
    openId = r.id; mode = null;
    $('sb-detail-title').textContent = r.item_description + (r.pawn_reference ? ' — ' + r.pawn_reference : '');
    const body = $('sb-detail-body');
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    loadAudit(r);
    $('sb-detail-backdrop').classList.add('open');
    $('sb-detail-drawer').classList.add('open');
    return true;
  }
  /** A realtime change should not wipe a form someone is typing in. */
  function refreshOpenDetail() {
    if (openId == null || mode) return;
    const body = $('sb-detail-body');
    if (body.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
    const r = items.find((x) => x.id === openId);
    if (!r) { closeDetailDrawer(); return; }
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    loadAudit(r);
  }

  function renderDetailBody(r) {
    const eff = r._eff, st = r._st, pays = r.subasta_payments || [];
    const manage = canManageAt(r.branch_id);
    const pending = requests.find((q) => q.record_table === 'subasta_items' && q.record_id === String(r.id));
    const payRequest = (p) => requests.find((q) => q.record_table === 'subasta_payments' && q.record_id === String(p.id));
    const kv = (k, v) => '<div class="drawer-kv"><span>' + k + '</span><b>' + v + '</b></div>';
    const eligibleFuture = !!r.auction_eligible_date && r.auction_eligible_date > today();
    const finished = !OPEN.includes(r.status);
    const converted = !!r.converted_from_scrap_entry_id;
    const hasName = !!(r.pawner_name || digits(r.pawner_contact).length >= 7);

    let h = '';
    if (pending) {
      h += '<div class="lw-note-box" style="margin-bottom:12px;"><b>Delete requested</b> by ' + esc((pending.requester && pending.requester.full_name) || '—') + ' · ' + fmtDateTime(pending.requested_at) +
        '<div>' + esc(pending.reason) + '</div><div class="muted" style="margin-top:4px;">' + (pending.status === 'Supervisor Approved' ? 'Approved by ' + esc((pending.supervisor && pending.supervisor.full_name) || 'a supervisor') + ' — waiting for Admin.' : 'Waiting for a supervisor.') + '</div>' +
        ((pending.requested_by === employee.id || isAdmin) ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="withdraw-req" data-id="' + pending.id + '">Withdraw request</button></div>' : '') + '</div>';
    }
    if (r.status === 'Hold') h += '<div class="lw-note-box" style="margin-bottom:12px;background:#fdecea;"><b>On hold — do not sell.</b> ' + esc(r.hold_reason || '') + '</div>';
    if (eff === 'Eligible') h += '<div class="lw-note-box" style="margin-bottom:12px;"><b>Eligible for auction</b> since ' + fmtDate(r.auction_eligible_date) + ' — it can be listed for sale.</div>';

    h += '<div class="drawer-section"><h4>Item</h4>' +
      kv('Item', esc(r.item_description)) + kv('SKU', esc(r.sku || '—')) + kv('Category', esc(r.category || '—')) +
      kv('Metal / Purity', esc([r.metal_type, r.purity].filter(Boolean).join(' ') || '—')) + kv('Weight', grams(r.weight_grams)) +
      kv('Branch', esc(branchName(r.branch_id))) + kv('Status', statusBadge(eff)) +
      (converted ? kv('Origin', 'Converted from Scrap #' + r.converted_from_scrap_entry_id) : '') + '</div>';

    h += '<div class="drawer-section"><h4>Pawner / source</h4>' +
      kv('Pawner', esc(r.pawner_name || '—')) + kv('Contact', esc(r.pawner_contact || '—')) + kv('Pawn reference', esc(r.pawn_reference || '—')) + kv('Original source', esc(r.original_source || '—')) +
      (canSeeHistory() && hasName ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="pawner-history">Open pawner history</button></div>' : '') + '</div>';

    h += '<div class="drawer-section"><h4>Pawn details</h4>' +
      kv('Pawn date', fmtDate(r.pawn_date)) + kv('Principal amount', r.principal_amount != null ? money(r.principal_amount) : '—') +
      kv('Auction eligible date', fmtDate(r.auction_eligible_date)) + kv('Listed date', fmtDate(r.listed_date)) + '</div>';

    if (r.status === 'Sold') {
      h += '<div class="drawer-section"><h4>Sale</h4>' +
        kv('Sale date', fmtDate(r.sale_date)) + kv('Sale price', money(r.sale_price)) + kv('Buyer', esc(r.buyer_name || '—')) +
        (r.buyer_contact ? kv('Buyer contact', esc(r.buyer_contact)) : '') + kv('Payment method', esc(r.payment_method || '—')) +
        kv('Payment', paymentChipHtml(st)) + kv('Processed by', esc((r.processor && r.processor.full_name) || '—')) + '</div>';

      h += '<div class="drawer-section"><h4>Payments</h4>' +
        (pays.length ? pays.map((p) => {
          const preq = payRequest(p);
          return '<div class="sc-pay-line"><div><b>' + money(p.amount) + '</b> · ' + esc(p.payment_method) +
            '<div class="muted" style="font-size:11px;">' + fmtDate(p.paid_at) + (p.reference_number ? ' · ref ' + esc(p.reference_number) : '') + ' · by ' + esc((p.recorder && p.recorder.full_name) || '—') + '</div>' +
            (preq ? '<div class="lw-pending-flag" style="font-size:11px;">Removal requested — ' + (preq.status === 'Supervisor Approved' ? 'waiting for Admin' : 'waiting for a supervisor') + '</div>' : '') + '</div>' +
          '<div class="sc-pay-actions">' + (p.attachment_path
              ? '<button type="button" class="btn small secondary" data-act="view-proof" data-path="' + esc(p.attachment_path) + '">View proof</button>'
              : ((manage || p.recorded_by === employee.id) ? '<button type="button" class="btn small secondary" data-act="attach-proof" data-id="' + p.id + '">Attach proof</button>' : '<span class="muted" style="font-size:11px;">no proof</span>')) +
            (manage ? '<button type="button" class="btn small secondary" data-act="correct-payment" data-id="' + p.id + '">Correct</button>' : '') +
            (canActOnBranch(r.branch_id) && !preq
              ? (isAdmin ? '<button type="button" class="btn small secondary" data-act="remove-payment" data-id="' + p.id + '">Remove…</button>'
                         : '<button type="button" class="btn small secondary" data-act="request-remove-payment" data-id="' + p.id + '">Request removal</button>') : '') +
          '</div></div>';
        }).join('') : '<p class="muted">No payment recorded yet.</p>') +
        '<div class="drawer-kv"><span>Paid</span><b>' + money(st.paid) + '</b></div><div class="drawer-kv"><span>Balance</span><b>' + money(st.balance) + '</b></div>' +
        (st.balance > 0.005 && manage
          ? '<form id="sb-addpay-form" novalidate style="margin-top:10px;display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;"><div class="lw-edit-form">' +
              '<div class="sc-row2"><div class="field"><label>Method</label><select name="method">' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
              '<div class="field"><label>Amount (₱)</label><input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="' + st.balance.toFixed(2) + '"></div></div>' +
              '<div class="sc-row2"><div class="field"><label>Date sent / paid</label><input type="date" name="paidAt" value="' + today() + '" min="' + esc(r.sale_date || '') + '" max="' + today() + '"></div>' +
              '<div class="field"><label>Reference number</label><input type="text" name="reference"></div></div>' +
              '<div class="field"><label>Proof of payment</label><input type="file" name="proof" accept="image/*,.pdf"></div>' +
              '<div class="msg error" data-addpay-err hidden></div>' +
              '<button class="btn small" type="submit">Record payment</button></div></form>'
          : '') + '</div>';
    }

    if (r.notes) h += '<div class="drawer-section"><h4>Notes</h4>' + kv('Notes', esc(r.notes)) + '</div>';
    h += '<div class="drawer-section"><h4>Audit</h4>' +
      kv('Recorded by', esc((r.creator && r.creator.full_name) || '—')) + kv('Created', fmtDateTime(r.created_at)) +
      (r.updated_by ? kv('Last edited by', esc((r.updater && r.updater.full_name) || '—')) + kv('Last edited', fmtDateTime(r.updated_at)) : '') + '</div>';

    // Actions -- only what this person may do, and only what this status allows.
    const btn = (act, label, cls) => '<button type="button" class="btn small ' + (cls || 'secondary') + '" data-act="' + act + '">' + label + '</button>';
    const acts = [];
    if (manage && (r.status === 'Pending' || r.status === 'Eligible')) acts.push(btn('list', 'Mark Listed', ''));
    if (manage && (r.status === 'Listed' || ((r.status === 'Pending' || r.status === 'Eligible') && !eligibleFuture))) acts.push(btn('sold', 'Mark Sold', ''));
    if (manage && r.status === 'Listed') acts.push(btn('unlist', 'Take off the list'));
    if (manage && ['Pending', 'Eligible', 'Listed'].includes(r.status)) acts.push(btn('hold', 'Put on hold'));
    if (manage && r.status === 'Hold') acts.push(btn('release', 'Release hold'));
    if (manage && OPEN.includes(r.status)) { acts.push(btn('withdraw', 'Withdraw')); acts.push(btn('cancel', 'Cancel item')); }
    if (isAdmin && finished && !(r.status === 'Sold' && pays.length)) acts.push(btn('reopen', 'Reopen'));
    if (manage) acts.push(btn('edit', 'Edit'));
    const deletable = canActOnBranch(r.branch_id) && !pending && !converted && !pays.length;
    if (deletable) acts.push(isAdmin ? btn('delete', 'Delete…', 'danger') : btn('request-delete', 'Request Delete'));
    h += '<div class="drawer-section"><h4>Actions</h4>' + (acts.length ? '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + acts.join('') + '</div>' : '<p class="muted" style="margin:0;">No actions available to you for this item.</p>') +
      (manage && (r.status === 'Pending' || r.status === 'Eligible') && eligibleFuture ? '<p class="muted" style="font-size:11px;margin:8px 0 0;">Not eligible for auction until ' + fmtDate(r.auction_eligible_date) + ' — listing it earlier needs a reason, and it can only be sold once it is listed.</p>' : '') +
      ((pays.length || converted) && canActOnBranch(r.branch_id) ? '<p class="muted" style="font-size:11px;margin:8px 0 0;">' + (converted ? 'This item came from a scrap purchase, so it cannot be deleted — cancel it instead.' : 'An item with payments cannot be deleted — remove the payments first, or cancel it.') + '</p>' : '') + '</div>';

    h += '<div class="drawer-section"><h4>History</h4><div id="sb-audit"><div class="muted">Loading…</div></div></div>';
    return h;
  }

  // Who did what, when (branch_audit_log): created, listed, held, sold, each payment, corrections with the old -> new values.
  async function loadAudit(r) {
    const box = $('sb-audit');
    if (!box) return;
    try {
      const rows = await listBranchAuditLog('subasta_items', r.id);
      if (openId !== r.id || !$('sb-audit')) return;
      const ev = rows.map((l) => ({ at: l.changed_at, who: l.actor && l.actor.full_name, what: l.action, detail: l.details || '', old: l.old_value, nw: l.new_value }));
      if (!ev.some((e) => e.what === 'Item created')) ev.push({ at: r.created_at, who: r.creator && r.creator.full_name, what: 'Item created', detail: '' });
      ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      $('sb-audit').innerHTML = '<div class="lw-history">' + ev.map((e) => {
        const diff = e.old && e.nw ? Object.keys(e.old).map((k) => '<div style="font-size:11px;">' + esc(FIELD_LABELS[k] || k) + ': <s class="muted">' + esc(e.old[k] == null ? '—' : e.old[k]) + '</s> → <b>' + esc(e.nw[k] == null ? '—' : e.nw[k]) + '</b></div>').join('') : '';
        return '<div class="lw-hist-row"><div class="lw-hist-when muted">' + fmtDateTime(e.at) + '</div><div><b>' + esc(e.what) + '</b>' + (e.who ? ' <span class="muted">· ' + esc(e.who) + '</span>' : '') +
          (e.detail ? '<div class="muted" style="font-size:11px;">' + esc(e.detail) + '</div>' : '') + diff + '</div></div>';
      }).join('') + '</div>';
    } catch (err) {
      if ($('sb-audit')) $('sb-audit').innerHTML = '<p class="muted">The history could not be loaded.</p>';
    }
  }

  function pickFile(accept, onFile) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.style.display = 'none';
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  }

  function wireDetailBody(container, r) {
    const on = (sel, fn) => container.querySelectorAll(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
    const open = async (path) => { try { window.open(await getSubastaAttachmentUrl(path), '_blank'); } catch (err) { notify(String(err.message || err), true); } };
    on('[data-act="view-proof"]', (el) => open(el.dataset.path));
    on('[data-act="attach-proof"]', (el) => pickFile('image/*,.pdf', async (file) => {
      try { await uploadSubastaPaymentProof(r.branch_id, r.id, Number(el.dataset.id), file); notify('Proof attached.', false); await load(); } catch (err) { notify(String(err.message || err), true); }
    }));
    on('[data-act="withdraw-req"]', (el) => runAction(() => cancelBranchRecordAction(Number(el.dataset.id)), 'Request withdrawn.'));
    on('[data-act="edit"]', () => openEdit(r));
    on('[data-act="sold"]', () => openSoldForm(r));
    on('[data-act="pawner-history"]', () => openHistory(r));

    // ---- status changes ----
    const again = async (fn, okText) => { try { await fn(); notify(okText, false); await load(); openDetail(r.id); } catch (err) { notify(String(err.message || err), true); } };
    on('[data-act="list"]', async () => {
      if (r.auction_eligible_date && r.auction_eligible_date > today()) {
        const out = await reasonDialog({ title: 'List before its auction date?', message: 'This item is not eligible for auction until ' + fmtDate(r.auction_eligible_date) + '.\nGive a reason to list it early; it is recorded with your name.', label: 'Reason', confirmLabel: 'List it now' });
        if (!out) return;
        return again(() => setSubastaStatus(r.id, 'list', out.reason), 'Listed for sale.');
      }
      return again(() => setSubastaStatus(r.id, 'list'), 'Listed for sale.');
    });
    on('[data-act="unlist"]', async () => {
      if (!await confirmDialog({ title: 'Take this item off the list?', message: 'It goes back to Pending. Nothing else changes.', confirmLabel: 'Take it off' })) return;
      return again(() => setSubastaStatus(r.id, 'unlist'), 'Taken off the list.');
    });
    on('[data-act="hold"]', async () => {
      const out = await reasonDialog({ title: 'Put this item on hold?', message: 'It cannot be sold while it is on hold (for example, the pawner came to redeem it).', label: 'Reason', confirmLabel: 'Put on hold' });
      if (!out) return;
      return again(() => setSubastaStatus(r.id, 'hold', out.reason), 'Put on hold.');
    });
    on('[data-act="release"]', async () => {
      if (!await confirmDialog({ title: 'Release the hold?', message: 'The item goes back to ' + (r.listed_date ? 'Listed' : 'Pending') + '.', confirmLabel: 'Release' })) return;
      return again(() => setSubastaStatus(r.id, 'release'), 'Hold released.');
    });
    on('[data-act="withdraw"]', async () => {
      const out = await reasonDialog({ title: 'Withdraw this item?', message: 'It leaves the auction (for example, the pawner redeemed it). An Admin can reopen it later.', label: 'Reason', confirmLabel: 'Withdraw', danger: true });
      if (!out) return;
      return again(() => setSubastaStatus(r.id, 'withdraw', out.reason), 'Item withdrawn.');
    });
    on('[data-act="cancel"]', async () => {
      const out = await reasonDialog({ title: 'Cancel this item?', message: 'Use this for an item entered by mistake. It stays on record as Cancelled. An Admin can reopen it later.', label: 'Reason', confirmLabel: 'Cancel item', danger: true });
      if (!out) return;
      return again(() => setSubastaStatus(r.id, 'cancel', out.reason), 'Item cancelled.');
    });
    on('[data-act="reopen"]', async () => {
      const out = await reasonDialog({ title: 'Reopen this item?', message: r.status === 'Sold' ? 'The sale details (price, buyer) are cleared and the item goes back on the list.' : 'The item goes back to ' + (r.listed_date ? 'Listed' : 'Pending') + '.', label: 'Reason', confirmLabel: 'Reopen' });
      if (!out) return;
      return again(() => setSubastaStatus(r.id, 'reopen', out.reason), 'Item reopened.');
    });

    // ---- correcting one payment: new values + the reason and kind of mistake, all logged ----
    on('[data-act="correct-payment"]', async (el) => {
      const p = (r.subasta_payments || []).find((x) => x.id === Number(el.dataset.id));
      if (!p) return;
      const out = await reasonDialog({
        title: 'Correct this payment', message: 'Change only what was wrong. The old and new values are recorded with your name and the reason.',
        label: 'Reason', confirmLabel: 'Save correction', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment',
        extraFieldsHtml:
          '<div class="field"><label for="dlg-pmethod">Method</label><select id="dlg-pmethod">' +
            PAYMENT_METHODS.concat(PAYMENT_METHODS.includes(p.payment_method) ? [] : [p.payment_method]).map((m) => '<option' + (m === p.payment_method ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select></div>' +
          '<div class="field"><label for="dlg-pamount">Amount (₱)</label><input type="number" id="dlg-pamount" step="0.01" min="0" inputmode="decimal" value="' + esc(p.amount) + '"></div>' +
          '<div class="field"><label for="dlg-pdate">Date sent / paid</label><input type="date" id="dlg-pdate" value="' + esc(String(p.paid_at || '').slice(0, 10)) + '" min="' + esc(r.sale_date || '') + '" max="' + today() + '"></div>' +
          '<div class="field"><label for="dlg-pref">Reference number</label><input type="text" id="dlg-pref" value="' + esc(p.reference_number || '') + '"></div>',
        readExtra: (f) => {
          const amount = Number(f.querySelector('#dlg-pamount').value);
          const paidAt = f.querySelector('#dlg-pdate').value;
          if (!(amount > 0)) return { error: 'The payment must be more than ₱0.' };
          if (!paidAt) return { error: 'Enter the date the payment was sent.' };
          if (paidAt > today()) return { error: 'The payment date cannot be in the future.' };
          if (r.sale_date && paidAt < r.sale_date) return { error: 'The payment date cannot be before the sale date.' };
          if (r._paid - Number(p.amount) + amount > Number(r.sale_price || 0) + 0.01) return { error: 'The payments would add up to more than the sale price (' + money(r.sale_price) + ').' };
          return { method: f.querySelector('#dlg-pmethod').value, amount: r2(amount), paidAt, reference: f.querySelector('#dlg-pref').value.trim() };
        },
      });
      if (!out) return;
      const x = out.extra, patch = {};
      if (x.method !== p.payment_method) patch.payment_method = x.method;
      if (x.amount !== Number(p.amount)) patch.amount = x.amount;
      if (x.paidAt !== String(p.paid_at || '').slice(0, 10)) patch.paid_at = x.paidAt;
      if (x.reference !== (p.reference_number || '')) patch.reference_number = x.reference || null;
      if (!Object.keys(patch).length) { notify('Nothing was changed.', true); return; }
      await runAction(async () => { await updateSubastaPayment(p.id, patch, out.reason, out.errorType); }, 'Payment corrected.');
    });
    on('[data-act="request-remove-payment"]', async (el) => {
      const out = await reasonDialog({ title: 'Request removal of this payment?', message: 'A supervisor and then Admin must approve it. Nothing is removed until then.', label: 'Reason',
        confirmLabel: 'Send request', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment', danger: true });
      if (!out) return;
      await runAction(() => requestBranchRecordAction('subasta_payments', Number(el.dataset.id), 'Delete', out.reason, out.errorType), 'Removal request sent.');
    });
    on('[data-act="remove-payment"]', async (el) => {
      const out = await reasonDialog({ title: 'Remove this payment?', message: 'The sale goes back to owing that amount. The reason and what was removed stay in the audit trail.', label: 'Reason',
        confirmLabel: 'Remove payment', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment', danger: true });
      if (!out) return;
      await runAction(() => adminApplyBranchRecordAction('subasta_payments', Number(el.dataset.id), 'Delete', out.reason, out.errorType), 'Payment removed.');
    });

    on('[data-act="request-delete"]', async () => {
      const out = await reasonDialog({ title: 'Request deletion of this item?', message: 'A supervisor and then Admin must approve it. Nothing is removed until then.', label: 'Reason',
        confirmLabel: 'Send request', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', danger: true });
      if (!out) return;
      await runAction(() => requestBranchRecordAction('subasta_items', r.id, 'Delete', out.reason, out.errorType), 'Delete request sent.');
    });
    on('[data-act="delete"]', async () => {
      const out = await reasonDialog({ title: 'Delete this subasta item?', message: 'This removes the item. The reason and what was removed stay in the audit trail.', label: 'Reason',
        confirmLabel: 'Delete item', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', danger: true });
      if (!out) return;
      await runAction(async () => { await adminApplyBranchRecordAction('subasta_items', r.id, 'Delete', out.reason, out.errorType); closeDetailDrawer(); }, 'Item deleted.');
    });

    const payForm = container.querySelector('#sb-addpay-form');
    if (payForm) payForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = payForm.querySelector('[data-addpay-err]'); err.hidden = true;
      const amount = Number(payForm.elements.amount.value);
      const paidAt = payForm.elements.paidAt.value || today();
      const fail = (m, el) => { err.textContent = friendlyError(m); err.hidden = false; if (el) flagInvalid(el); };
      if (!(amount > 0)) return fail('Enter the amount (more than ₱0).', payForm.elements.amount);
      if (amount > r._st.balance + 0.01) return fail('That is more than the balance (' + money(r._st.balance) + ').', payForm.elements.amount);
      if (paidAt > today()) return fail('The payment date cannot be in the future.', payForm.elements.paidAt);
      if (r.sale_date && paidAt < r.sale_date) return fail('The payment date cannot be before the sale date.', payForm.elements.paidAt);
      const sbtn = payForm.querySelector('button[type=submit]'); sbtn.disabled = true;
      try {
        const id = await addSubastaPayment(r.id, { method: payForm.elements.method.value, amount: r2(amount), reference: payForm.elements.reference.value.trim(), paidAt });
        const file = payForm.elements.proof.files[0];
        let warn = '';
        if (file) { try { await uploadSubastaPaymentProof(r.branch_id, r.id, id, file); } catch (e2) { warn = ' The proof could not be uploaded (' + (e2.message || e2) + ') -- attach it again from the payment line.'; } }
        notify('Payment recorded.' + warn, !!warn);
        await load();
        openDetail(r.id); // re-draw even if the cursor was still in a box (a live refresh leaves a form being typed in alone)
      } catch (e3) { fail(String(e3.message || e3)); sbtn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Mark Sold (the sale and its payment lines are saved together)
  // ---------------------------------------------------------------------------------------------
  function openSoldForm(r) {
    mode = 'sold';
    $('sb-detail-title').textContent = 'Mark Sold — ' + r.item_description;
    const body = $('sb-detail-body');
    body.innerHTML =
      '<form id="sb-sold-form" novalidate class="lw-edit-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
        '<p class="muted" style="margin:0;font-size:12px;">' + esc(r.item_description) + ' · ' + esc([r.metal_type, r.purity].filter(Boolean).join(' ') || '—') + ' · ' + grams(r.weight_grams) + '</p>' +
        '<div class="msg error" data-sold-err hidden></div>' +
        '<div class="drawer-section"><h4>Sale</h4>' +
          '<div class="sc-row2"><div class="field"><label>Sale date</label><input type="date" name="saleDate"></div>' +
          '<div class="field"><label>Sale price (₱) *</label><input type="number" name="price" step="0.01" min="0" inputmode="decimal"></div></div>' +
          '<div class="field"><label>Buyer name *</label><input type="text" name="buyer" autocomplete="off"></div>' +
          '<div class="field"><label>Buyer contact (optional)</label><input type="text" name="buyerContact" autocomplete="off" inputmode="tel"></div>' +
          '<div class="field"><label>Processed by</label><input type="text" value="' + esc(employee.full_name || '') + '" readonly tabindex="-1"></div>' +
        '</div>' +
        '<div class="drawer-section"><h4>Payment</h4><div data-pay-box>' + paymentRowsHtml({ recorder: employee.full_name || 'you', hint: 'Split the payment across methods if the buyer paid in more than one way. Each line can carry its own reference and proof.' }) + '</div>' +
          '<label class="sb-check"><input type="checkbox" name="partial"> The buyer is paying only part of the price now — keep the balance as unpaid</label>' +
        '</div>' +
        '<div style="display:flex;gap:8px;"><button class="btn" type="submit">Mark as Sold</button><button class="btn secondary" type="button" data-act="cancel-sold">Cancel</button></div>' +
      '</form>';
    const sf = $('sb-sold-form');
    const price = () => Number(sf.elements.price.value) || 0;
    sf.elements.saleDate.value = today(); sf.elements.saleDate.max = today(); if (r.pawn_date) sf.elements.saleDate.min = r.pawn_date;
    const pay = mountPaymentRows(sf.querySelector('[data-pay-box]'), {
      getDue: price, getMinDate: () => sf.elements.saleDate.value || '', minDateLabel: 'sale date', dueLabel: 'Sale price', emptyText: 'Enter the sale price to see what is owed.',
    });
    sf.elements.price.addEventListener('input', () => pay.sync());
    sf.elements.saleDate.addEventListener('change', () => pay.sync());
    attachCustomerPicker({ nameInput: sf.elements.buyer, contactInput: sf.elements.buyerContact });
    sf.querySelector('[data-act="cancel-sold"]').addEventListener('click', () => openDetail(r.id));

    sf.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = sf.querySelector('[data-sold-err]'); err.hidden = true;
      const fail = (m, el) => { err.textContent = friendlyError(m); err.hidden = false; err.scrollIntoView({ block: 'nearest' }); if (el) flagInvalid(el); };
      const saleDate = sf.elements.saleDate.value || today();
      if (saleDate > today()) return fail('The sale date cannot be in the future.', sf.elements.saleDate);
      if (r.pawn_date && saleDate < r.pawn_date) return fail('The sale date cannot be before the pawn date (' + fmtDate(r.pawn_date) + ').', sf.elements.saleDate);
      if (!(price() > 0)) return fail('Enter the sale price (more than ₱0).', sf.elements.price);
      if (!sf.elements.buyer.value.trim()) return fail('Enter the buyer name.', sf.elements.buyer);
      const got = pay.read();
      if (got.error) return fail(got.error, got.el);
      if (!got.payments.length) return fail('Record at least one payment (method and amount) for the sale.', sf.querySelector('[data-f="amount"]'));
      const partial = sf.elements.partial.checked;
      if (!partial && Math.abs(got.sum - price()) > 0.01) return fail('The payments (' + money(got.sum) + ') must add up to the sale price (' + money(price()) + '), or tick the box to keep the balance as unpaid.', sf.querySelector('[data-f="amount"]'));
      if (partial && got.sum >= price() - 0.01) return fail('The payments already cover the whole price -- untick the partial-payment box.', sf.elements.partial);
      const sbtn = sf.querySelector('button[type=submit]'); sbtn.disabled = true;
      try {
        const saved = await markSubastaSold({ id: r.id, saleDate, salePrice: r2(price()), buyerName: sf.elements.buyer.value.trim(), buyerContact: sf.elements.buyerContact.value.trim(), payments: got.payments, allowPartial: partial });
        const warnings = [];
        for (let i = 0; i < got.payments.length; i++) {
          if (!got.payments[i].file) continue;
          try { await uploadSubastaPaymentProof(r.branch_id, r.id, saved.paymentIds[i], got.payments[i].file); }
          catch (e2) { warnings.push('the proof for payment ' + (i + 1) + ' (' + (e2.message || e2) + ')'); }
        }
        notify(warnings.length ? 'Marked sold, but ' + warnings.join(' and ') + ' could not be uploaded -- attach it again from the payment line.' : (partial ? 'Marked sold — the balance is still unpaid.' : 'Marked sold.'), !!warnings.length);
        mode = null;
        await load();
        openDetail(r.id);
      } catch (e3) { fail(String(e3.message || e3)); sbtn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Pawner history (needs the "open a pawner's history" permission -- the database checks it again)
  // ---------------------------------------------------------------------------------------------
  async function openHistory(r) {
    mode = 'history';
    $('sb-detail-title').textContent = 'Pawner history — ' + (r.pawner_name || r.pawner_contact);
    const body = $('sb-detail-body');
    body.innerHTML = '<p><button type="button" class="btn small secondary" data-act="back">‹ Back to the item</button></p><div id="sb-hist-box"><div class="muted">Loading…</div></div>';
    body.querySelector('[data-act="back"]').addEventListener('click', () => openDetail(r.id));
    try {
      const h = await getSubastaPawnerHistory(r.pawner_name, r.pawner_contact);
      if (mode !== 'history' || openId !== r.id) return;
      const t = h.totals || {}, list = h.items || [];
      $('sb-hist-box').innerHTML =
        '<div class="drawer-section"><h4>Totals</h4>' +
          '<div class="drawer-kv"><span>Items</span><b>' + (t.items || 0) + '</b></div><div class="drawer-kv"><span>Still open</span><b>' + (t.open || 0) + '</b></div>' +
          '<div class="drawer-kv"><span>Sold</span><b>' + (t.sold || 0) + '</b></div><div class="drawer-kv"><span>Principal on record</span><b>' + money(t.principal) + '</b></div></div>' +
        '<div class="drawer-section"><h4>Items</h4>' + (list.length
          ? '<div class="table-scroll"><table class="sc-table"><thead><tr><th>Item</th><th class="nw">Pawn</th><th class="nw">Principal</th><th class="nw">Status</th><th class="nw">Sold for</th></tr></thead><tbody>' +
            list.map((x) => '<tr' + (items.some((i) => i.id === x.id) ? ' data-open-id="' + x.id + '" style="cursor:pointer;"' : '') + '>' +
              '<td data-label="Item"><b>' + esc(x.item) + '</b><div class="muted" style="font-size:10.5px;">#' + x.id + ' · ' + esc(branchName(x.branch_id)) + (x.sku ? ' · ' + esc(x.sku) : '') + '</div></td>' +
              '<td data-label="Pawn" class="nw">' + esc(x.pawn_reference || '—') + '<div class="muted" style="font-size:10.5px;">' + fmtDate(x.pawn_date) + '</div></td>' +
              '<td data-label="Principal" class="nw">' + (x.principal != null ? money(x.principal) : '—') + '</td>' +
              '<td data-label="Status" class="nw">' + statusBadge(x.status) + '</td>' +
              '<td data-label="Sold for" class="nw">' + (x.sale_price != null ? money(x.sale_price) + '<div class="muted" style="font-size:10.5px;">' + fmtDate(x.sale_date) + '</div>' : '—') + '</td></tr>').join('') + '</tbody></table></div>'
          : '<p class="muted">No other items found.</p>') + '</div>';
      $('sb-hist-box').querySelectorAll('[data-open-id]').forEach((tr) => tr.addEventListener('click', () => openDetail(Number(tr.dataset.openId))));
    } catch (err) {
      if ($('sb-hist-box')) $('sb-hist-box').innerHTML = '<div class="msg error">' + esc(friendlyError(String(err.message || err))) + '</div>';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Edit (a correction: the reason and what went wrong are asked for and logged)
  // ---------------------------------------------------------------------------------------------
  function openEdit(r) {
    mode = 'edit';
    $('sb-detail-title').textContent = 'Edit — ' + r.item_description;
    const body = $('sb-detail-body');
    const v = (x) => (x == null ? '' : esc(x));
    const listedShown = ['Listed', 'Hold', 'Sold'].includes(r.status);
    body.innerHTML =
      '<form id="sb-edit-form" novalidate class="lw-edit-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
        '<p class="muted" style="margin:0;font-size:12px;">Correcting this item is recorded with your name, the old and new values, and the reason. To change its status use the buttons on the item.</p>' +
        '<div class="msg error" data-edit-err hidden></div>' +
        '<div class="drawer-section"><h4>Item</h4>' +
          '<div class="field"><label>SKU</label><input type="text" name="sku" value="' + v(r.sku) + '"></div>' +
          '<div class="field"><label>Item description *</label><input type="text" name="itemDescription" value="' + v(r.item_description) + '"></div>' +
          '<div class="sc-row2"><div class="field"><label>Category</label><input type="text" name="category" list="sb-cat-list" value="' + v(r.category) + '"></div>' +
          '<div class="field"><label>Metal *</label><select name="metal"><option value="">— choose —</option>' + METALS.map((m) => '<option' + (m === r.metal_type ? ' selected' : '') + '>' + m + '</option>').join('') + '</select></div></div>' +
          '<div class="sc-row2"><div class="field"><label>Purity</label><select name="purity"></select></div>' +
          '<div class="field"><label>Weight (grams)</label><input type="number" name="weight" step="0.001" min="0" value="' + v(r.weight_grams) + '"></div></div>' +
          '<div class="field" data-purity-other hidden><label>Custom purity *</label><input type="text" name="purityOther"></div>' +
        '</div>' +
        '<div class="drawer-section"><h4>Pawner / source</h4>' +
          '<div class="field"><label>Pawner name</label><input type="text" name="pawner" autocomplete="off" value="' + v(r.pawner_name) + '"></div>' +
          '<div class="field"><label>Contact number</label><input type="text" name="pawnerContact" autocomplete="off" value="' + v(r.pawner_contact) + '"></div>' +
          '<div class="sc-row2"><div class="field"><label>Pawn reference</label><input type="text" name="pawnReference" value="' + v(r.pawn_reference) + '"></div>' +
          '<div class="field"><label>Original source</label><input type="text" name="originalSource" list="sb-origin-list" value="' + v(r.original_source) + '"></div></div>' +
        '</div>' +
        '<div class="drawer-section"><h4>Pawn details</h4>' +
          '<div class="sc-row2"><div class="field"><label>Pawn date</label><input type="date" name="pawnDate" value="' + v(r.pawn_date) + '" max="' + today() + '"></div>' +
          '<div class="field"><label>Principal amount (₱)</label><input type="number" name="principal" step="0.01" min="0" value="' + v(r.principal_amount) + '"></div></div>' +
          '<div class="sc-row2"><div class="field"><label>Auction eligible date</label><input type="date" name="eligibleDate" value="' + v(r.auction_eligible_date) + '"></div>' +
          (listedShown ? '<div class="field"><label>Listed date</label><input type="date" name="listedDate" value="' + v(r.listed_date) + '" max="' + today() + '"></div>' : '<div></div>') + '</div>' +
        '</div>' +
        (r.status === 'Sold'
          ? '<div class="drawer-section"><h4>Sale</h4>' +
              '<div class="sc-row2"><div class="field"><label>Sale date</label><input type="date" name="saleDate" value="' + v(r.sale_date) + '" max="' + today() + '"></div>' +
              '<div class="field"><label>Sale price (₱)</label><input type="number" name="salePrice" step="0.01" min="0" value="' + v(r.sale_price) + '"></div></div>' +
              '<div class="field"><label>Buyer name *</label><input type="text" name="buyer" autocomplete="off" value="' + v(r.buyer_name) + '"></div>' +
              '<div class="field"><label>Buyer contact</label><input type="text" name="buyerContact" autocomplete="off" value="' + v(r.buyer_contact) + '"></div>' +
              '<p class="muted" style="font-size:11px;margin:0;">Already paid: ' + money(r._paid) + ' — the sale price cannot go below it. Payments are corrected on their own lines.</p></div>'
          : '') +
        '<div class="drawer-section"><h4>Notes</h4><div class="field"><label>Notes</label><input type="text" name="notes" value="' + v(r.notes) + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><button class="btn" type="submit">Save correction</button><button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button></div>' +
      '</form>';
    const ef = $('sb-edit-form');
    const epurity = purityFields(ef);
    epurity.set(r.metal_type || '', r.purity || '');
    attachCustomerPicker({ nameInput: fe(ef, 'pawner'), contactInput: fe(ef, 'pawnerContact') });
    if (r.status === 'Sold') attachCustomerPicker({ nameInput: fe(ef, 'buyer'), contactInput: fe(ef, 'buyerContact') });
    ef.querySelector('[data-act="cancel-edit"]').addEventListener('click', () => openDetail(r.id));

    ef.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = ef.querySelector('[data-edit-err]'); err.hidden = true;
      const fail = (m, el) => { err.textContent = friendlyError(m); err.hidden = false; err.scrollIntoView({ block: 'nearest' }); if (el) flagInvalid(el); };
      const str = (n) => fe(ef, n).value.trim();
      const cur = {
        itemDescription: str('itemDescription'), metal: fe(ef, 'metal').value, purity: epurity.read(), weight: numOrNull(fe(ef, 'weight')),
        principal: numOrNull(fe(ef, 'principal')), pawnDate: fe(ef, 'pawnDate').value, eligibleDate: fe(ef, 'eligibleDate').value,
      };
      const bad = itemProblem(cur);
      if (bad) return fail(bad[0], fe(ef, bad[1]));
      const patch = {};
      const setStr = (key, val, old) => { if (val !== String(old || '')) patch[key] = val || null; };
      const setNum = (key, val, old) => { if ((val == null ? null : val) !== (old == null ? null : Number(old))) patch[key] = val; };
      const setDate = (key, val, old) => { if (val !== String(old || '')) patch[key] = val || null; };
      setStr('sku', str('sku'), r.sku); setStr('item_description', cur.itemDescription, r.item_description); setStr('category', str('category'), r.category);
      setStr('metal_type', cur.metal, r.metal_type); setStr('purity', cur.purity, r.purity); setNum('weight_grams', cur.weight, r.weight_grams);
      setStr('pawner_name', str('pawner'), r.pawner_name); setStr('pawner_contact', str('pawnerContact'), r.pawner_contact);
      setStr('pawn_reference', str('pawnReference'), r.pawn_reference); setStr('original_source', str('originalSource'), r.original_source);
      setDate('pawn_date', cur.pawnDate, r.pawn_date); setNum('principal_amount', cur.principal, r.principal_amount); setDate('auction_eligible_date', cur.eligibleDate, r.auction_eligible_date);
      if (listedShown) setDate('listed_date', fe(ef, 'listedDate').value, r.listed_date);
      if (r.status === 'Sold') {
        const price = numOrNull(fe(ef, 'salePrice'));
        if (!(price > 0)) return fail('The sale price must be more than ₱0.', fe(ef, 'salePrice'));
        if (price < r._paid - 0.01) return fail('The sale price cannot be less than what is already paid (' + money(r._paid) + ').', fe(ef, 'salePrice'));
        if (!str('buyer')) return fail('A sold item needs a buyer name.', fe(ef, 'buyer'));
        const sd = fe(ef, 'saleDate').value;
        if (!sd) return fail('Enter the sale date.', fe(ef, 'saleDate'));
        if (sd > today()) return fail('The sale date cannot be in the future.', fe(ef, 'saleDate'));
        if (cur.pawnDate && sd < cur.pawnDate) return fail('The sale date cannot be before the pawn date.', fe(ef, 'saleDate'));
        setDate('sale_date', sd, r.sale_date); setNum('sale_price', price, r.sale_price); setStr('buyer_name', str('buyer'), r.buyer_name); setStr('buyer_contact', str('buyerContact'), r.buyer_contact);
      }
      setStr('notes', str('notes'), r.notes);
      const keys = Object.keys(patch);
      if (!keys.length) return fail('Nothing was changed.');
      const guess = patch.purity !== undefined ? 'Wrong Purity' : patch.weight_grams !== undefined ? 'Wrong Weight' : (patch.sale_price !== undefined || patch.principal_amount !== undefined) ? 'Wrong Amount'
        : (patch.pawn_date !== undefined || patch.sale_date !== undefined || patch.auction_eligible_date !== undefined || patch.listed_date !== undefined) ? 'Wrong Date'
        : (patch.pawner_name !== undefined || patch.buyer_name !== undefined || patch.pawner_contact !== undefined) ? 'Wrong Customer' : patch.sku !== undefined ? 'Wrong SKU' : 'Other';
      const out = await reasonDialog({ title: 'Save this correction?', message: 'Changing: ' + keys.map((k) => FIELD_LABELS[k] || k).join(', ') + '.\nIt is recorded with your name, the old and new values and the reason.',
        label: 'Reason', confirmLabel: 'Save correction', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: guess });
      if (!out) return;
      const sbtn = ef.querySelector('button[type=submit]'); sbtn.disabled = true;
      try {
        await updateSubastaItem(r.id, patch, out.reason, out.errorType);
        notify('Correction saved.', false);
        mode = null;
        await load();
        openDetail(r.id);
      } catch (e2) { fail(String(e2.message || e2)); sbtn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Filters, range, views
  // ---------------------------------------------------------------------------------------------
  $('sb-f-search').addEventListener('input', () => { pg.page = 1; render(); });
  ['sb-f-status', 'sb-f-metal'].forEach((id) => $(id).addEventListener('change', () => { pg.page = 1; render(); }));
  // The global date range changes these two (hidden) inputs: the list re-filters and the server figures are fetched again.
  ['sb-f-from', 'sb-f-to'].forEach((id) => $(id).addEventListener('change', () => { pg.page = 1; render(); loadReport(); }));
  $('sb-f-clear').addEventListener('click', () => {
    $('sb-f-search').value = ''; $('sb-f-status').value = 'all'; $('sb-f-metal').value = 'all';
    pg.page = 1; render(); // the date range is the page's global range -- not cleared here
  });
  wireSortControl('sb-sort-field', 'sb-sort-dir', sort, () => { pg.page = 1; render(); });

  /** A summary card / Needs Attention item opens a particular view: 'eligible' = items ready to list, 'unpaid' = sold items still owing, 'requests' = the approvals folder. */
  function applyView(v) {
    if (v === 'eligible' || v === 'unpaid') {
      setStatusFilter(v);
      $('sb-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (v === 'requests') {
      const f = $('sb-requests-folder'); f.open = true; f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      $('sb-tiles').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const unsubscribe = subscribeToChanges(['subasta_items', 'subasta_payments', 'branch_record_requests'], load);
  await load();

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec 321) can open this item's own
  // Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail, applyView };
}
