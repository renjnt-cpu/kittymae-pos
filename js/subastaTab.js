// Subasta tab (Branches page) -- standalone module scoped to whichever branch is
// selected on the host page (getBranchId()), following the same Form Drawer /
// Detail Drawer pattern as Layaway (layawayTab.js) and Scrap (scrapTab.js) -- Ren's
// spec sections 271-288: "+ New Subasta" opens a right-side drawer instead of a
// permanent on-page form; after save the same drawer switches to the saved item's
// details; "View Details" on a row opens that same drawer; Edit happens inside the
// drawer and returns to the refreshed details (279). Page order follows the MASTER
// UI rules: primary action, Summary tiles, Search & Filters, records.
import {
  listSubastaItems, createSubastaItem, updateSubastaItem, deleteSubastaItem, searchProducts, subscribeToChanges,
} from './api.js?v=20260923k';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20260923k';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, byDate, localDateStr } from './uiKit.js?v=20260923k';

// Global Filter + Sort rules (Ren, 2026-09-21, section 19): Subasta sortable by Pawn
// Date/Item/SKU/Weight/Sale Price/Status.
const SB_SORT_FIELDS = [
  { key: 'pawn_date', label: 'Pawn Date' }, { key: 'item_description', label: 'Item' }, { key: 'sku', label: 'SKU' },
  { key: 'weight_grams', label: 'Weight' }, { key: 'status', label: 'Status' }, { key: 'sale_price', label: 'Sale Price' },
];
const SB_SORT_COMPARATORS = {
  pawn_date: byDate('pawn_date'), item_description: byText('item_description'), sku: byText('sku'),
  weight_grams: byNumber('weight_grams'), status: byText('status'), sale_price: byNumber('sale_price'),
};

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const weight = (n) => n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 3 }) + 'g';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const SUB_STATUS_BADGE = { Pending: 'pending', Listed: 'transit', Sold: 'ok', Cancelled: 'low' };
const SUB_STATUSES = ['Pending', 'Listed', 'Sold', 'Cancelled'];
const SUB_STATUS_OPTIONS = (selected) => SUB_STATUSES.map((s) => '<option' + (s === selected ? ' selected' : '') + '>' + s + '</option>').join('');

// Same write-access group as the host page's canWriteHere() before extraction
// (62_position_managers_refund_scrap_subasta.sql).
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

// 3 fixed sale-payment slots, all optional (a Subasta item's payment is only known
// once it's Sold) -- same shape the host page's paymentSlotsHtml('sub', ...) used.
function paymentSlotsHtml(existing) {
  const rows = existing && existing.length ? existing : [];
  let html = '';
  for (let i = 0; i < 3; i++) {
    const row = rows[i] || {};
    const label = i === 0 ? 'Sale Payment Method (optional)' : 'Sale Payment Method ' + (i + 1) + ' (optional)';
    html +=
      '<div class="field"><label>' + label + '</label><select name="sbMethod' + i + '">' +
        '<option value="">— none —</option>' +
        PAYMENT_METHODS.map((m) => '<option' + (row.method === m ? ' selected' : '') + '>' + m + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Amount (PHP)</label><input type="number" name="sbAmount' + i + '" step="0.01" min="0"' + (row.amount ? ' value="' + row.amount + '"' : '') + '></div>';
  }
  return html;
}
function readPaymentSlots(f) {
  const payments = [];
  for (let i = 0; i < 3; i++) {
    const method = f['sbMethod' + i]?.value;
    const amount = Number(f['sbAmount' + i]?.value || 0);
    if (method && amount > 0) payments.push({ method, amount, reference: '' });
  }
  return payments;
}

/** Mounts the Subasta tab into `root` (an empty container this owns entirely),
 * scoped to `getBranchId()` at call time. `esc`/`toast` are the page's own shell.js
 * helpers; `msgId` is the page's toast container id; `employee` is the signed-in
 * employee record; `branches` is the page's active-branch list (for the Branch
 * picker in the edit form). Returns { reload, unsubscribe, openDetail }. */
export async function initSubastaTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate }) {
  const isScoped = employee.role === 'Branch Supervisor';
  function canWriteHere() {
    return ['Admin', 'Manager'].includes(employee.role) || (isScoped && getBranchId() === employee.branch_id) ||
      POSITION_MANAGERS.includes(employee.position);
  }
  // Add gate: everything canWriteHere() allows, plus any active employee for their
  // own branch (subasta_any_employee_own_branch_insert), plus Sales Admin Associate
  // company-wide -- "whole staff" can add, the group above can edit/delete.
  function canAddHere() {
    return canWriteHere() || employee.branch_id === getBranchId() || employee.position === 'Sales Admin Associate';
  }
  const branchOptions = (selected) => (branches || []).map((b) =>
    '<option value="' + b.id + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  const sort = { field: 'pawn_date', dir: 'desc' };

  root.innerHTML =
    '<div class="module-topbar"><div></div><div style="text-align:right;">' +
      '<button type="button" class="btn" id="sb-new-btn">+ New Subasta</button>' +
      '<div id="sb-write-note"></div>' +
    '</div></div>' +
    '<div class="tiles" id="sb-tiles"></div>' +
    '<div class="card">' +
      '<h3 style="margin-top:0;">Search &amp; Filter</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="sb-f-search" placeholder="Item, SKU, pawn ref, buyer, grams, date…"></div>' +
        '<div class="field"><label>Status</label><select id="sb-f-status"><option value="all">All Statuses</option>' + SUB_STATUS_OPTIONS() + '</select></div>' +
        '<div class="field"><label>Pawned From</label><input type="date" id="sb-f-from"></div>' +
        '<div class="field"><label>Pawned To</label><input type="date" id="sb-f-to"></div>' +
        sortControlHtml(SB_SORT_FIELDS, sort, 'sb-sort-field', 'sb-sort-dir') +
        '<button type="button" class="btn small secondary" id="sb-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="sb-active"></div>' +
    '<div id="sb-list"><div class="muted">Loading…</div></div>' +

    '<div class="drawer-backdrop" id="sb-form-backdrop"></div>' +
    '<div class="drawer" id="sb-form-drawer">' +
      '<div class="drawer-header"><h3>New Subasta</h3><button type="button" class="drawer-close" id="sb-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<form id="sb-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="drawer-section">' +
            '<h4>Item</h4>' +
            '<div class="field" style="position:relative;">' +
              '<label>SKU</label>' +
              '<input type="text" name="sku" id="sb-sku" autocomplete="off" placeholder="Type a SKU or item name…">' +
              '<div id="sb-sku-name" class="muted" style="font-size:11px;"></div>' +
              '<div id="sb-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:20;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;"></div>' +
            '</div>' +
            '<div class="field"><label>Item Description *</label><input type="text" name="itemDescription" required></div>' +
            '<div class="field"><label>Weight (grams)</label><input type="number" name="weightGrams" step="0.001" min="0"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Pawn</h4>' +
            '<div class="field"><label>Pawn Reference</label><input type="text" name="pawnReference"></div>' +
            '<div class="field"><label>Pawn Date</label><input type="date" name="pawnDate"></div>' +
            '<div class="field"><label>Auction Eligible Date</label><input type="date" name="auctionEligibleDate"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Notes</h4>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="sb-form">Add Item</button>' +
        '<button type="button" class="btn secondary" id="sb-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +
    '<div class="drawer-backdrop" id="sb-detail-backdrop"></div>' +
    '<div class="drawer" id="sb-detail-drawer">' +
      '<div class="drawer-header"><h3 id="sb-detail-title">Subasta Details</h3><button type="button" class="drawer-close" id="sb-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="sb-detail-body"></div>' +
    '</div>';

  // ---- SKU autocomplete in the form drawer -- connects a pawned item back to a real
  // SKU Catalog product (picking a suggestion also fills Item Description/Weight when
  // still blank) instead of a freehand SKU that might not match anything. ----
  const skuInput = document.getElementById('sb-sku');
  const skuSuggest = document.getElementById('sb-sku-suggest');
  const skuNamePreview = document.getElementById('sb-sku-name');
  let skuSearchToken = 0, skuSearchTimer = null;
  function hideSuggest() { skuSuggest.style.display = 'none'; skuSuggest.innerHTML = ''; }
  function pickSku(p) {
    const f = document.getElementById('sb-form');
    skuInput.value = p.sku;
    skuNamePreview.textContent = p.item_name + (p.category || p.product_line ? ' · ' + (p.category || p.product_line) : '');
    if (!f.itemDescription.value.trim()) f.itemDescription.value = p.item_name;
    if (!f.weightGrams.value && p.gross_weight_g != null) f.weightGrams.value = p.gross_weight_g;
    hideSuggest();
  }
  skuInput.addEventListener('input', () => {
    skuNamePreview.textContent = '';
    const q = skuInput.value.trim();
    clearTimeout(skuSearchTimer);
    if (!q) { hideSuggest(); return; }
    skuSearchTimer = setTimeout(async () => {
      const token = ++skuSearchToken;
      try {
        const results = await searchProducts(q);
        if (token !== skuSearchToken) return;
        if (!results.length) { hideSuggest(); return; }
        skuSuggest.innerHTML = results.slice(0, 8).map((p, i) =>
          '<div data-i="' + i + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px;">' +
            '<strong>' + esc(p.sku) + '</strong> — ' + esc(p.item_name) +
            (p.category || p.product_line ? '<div class="muted" style="font-size:11px;">' + esc(p.category || p.product_line) + '</div>' : '') +
          '</div>').join('');
        skuSuggest.style.display = '';
        skuSuggest.querySelectorAll('[data-i]').forEach((row, i) => row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickSku(results[i]); }));
        const exact = results.find((p) => p.sku.toLowerCase() === q.toLowerCase());
        if (exact) skuNamePreview.textContent = exact.item_name + (exact.category || exact.product_line ? ' · ' + (exact.category || exact.product_line) : '');
      } catch (err) { /* a failed lookup shouldn't block typing a SKU by hand */ }
    }, 200);
  });
  skuInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  skuInput.addEventListener('focus', () => { if (skuSuggest.innerHTML) skuSuggest.style.display = ''; });

  // ---- drawers ----
  function openFormDrawer() {
    document.getElementById('sb-form-backdrop').classList.add('open');
    document.getElementById('sb-form-drawer').classList.add('open');
  }
  function closeFormDrawer() {
    document.getElementById('sb-form-backdrop').classList.remove('open');
    document.getElementById('sb-form-drawer').classList.remove('open');
  }
  document.getElementById('sb-new-btn').addEventListener('click', openFormDrawer);
  document.getElementById('sb-form-close').addEventListener('click', closeFormDrawer);
  document.getElementById('sb-form-cancel').addEventListener('click', closeFormDrawer);
  document.getElementById('sb-form-backdrop').addEventListener('click', closeFormDrawer);

  function closeDetailDrawer() {
    document.getElementById('sb-detail-backdrop').classList.remove('open');
    document.getElementById('sb-detail-drawer').classList.remove('open');
  }
  document.getElementById('sb-detail-close').addEventListener('click', closeDetailDrawer);
  document.getElementById('sb-detail-backdrop').addEventListener('click', closeDetailDrawer);
  function openDetail(id) {
    const r = allSubasta.find((x) => Number(x.id) === Number(id));
    if (!r) return;
    // .textContent escapes on its own -- esc() here would double-escape.
    document.getElementById('sb-detail-title').textContent = r.item_description + (r.pawn_reference ? ' — ' + r.pawn_reference : '');
    const body = document.getElementById('sb-detail-body');
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    document.getElementById('sb-detail-backdrop').classList.add('open');
    document.getElementById('sb-detail-drawer').classList.add('open');
  }
  // After an in-drawer action (Edit save): keep the drawer open on fresh data if the
  // item still exists, else close it.
  function refreshDetailIfOpen(id) {
    if (!document.getElementById('sb-detail-drawer').classList.contains('open')) return;
    if (!allSubasta.find((x) => Number(x.id) === Number(id))) { closeDetailDrawer(); return; }
    openDetail(id);
  }

  document.getElementById('sb-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    // The submit button lives in .drawer-footer (form="sb-form"), outside this <form>
    // element's own subtree, so it's reached by its own selector.
    const btn = document.querySelector('#sb-form-drawer .drawer-footer button[type=submit]');
    btn.disabled = true;
    try {
      const created = await createSubastaItem({
        branchId: getBranchId(), sku: f.sku.value.trim(),
        itemDescription: f.itemDescription.value.trim(), weightGrams: f.weightGrams.value ? Number(f.weightGrams.value) : null,
        pawnReference: f.pawnReference.value.trim(), pawnDate: f.pawnDate.value || null,
        auctionEligibleDate: f.auctionEligibleDate.value || null, notes: f.notes.value.trim(),
      });
      toast(msgId, 'Item added.', false);
      f.reset();
      skuNamePreview.textContent = '';
      hideSuggest();
      closeFormDrawer();
      await load();
      // Show the saved record in the same drawer system (spec 273) when the API
      // hands back the new row/id.
      const newId = created && typeof created === 'object' ? created.id : created;
      if (newId != null) openDetail(newId);
    } catch (err) {
      toast(msgId, String(err.message || err), true);
    } finally {
      btn.disabled = false;
    }
  });

  let allSubasta = [];

  async function load() {
    const list = document.getElementById('sb-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      allSubasta = await listSubastaItems(getBranchId());
      render();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

  function tile(num, label) { return '<div class="tile"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>'; }

  function render() {
    const newBtn = document.getElementById('sb-new-btn');
    newBtn.disabled = !canAddHere();
    document.getElementById('sb-write-note').innerHTML = canAddHere()
      ? ''
      : '<p class="muted" style="font-size:11px;">View only — you can only add subasta items for your own branch.</p>';

    let rows = allSubasta;
    const fSearch = document.getElementById('sb-f-search').value.trim().toLowerCase();
    const fStatus = document.getElementById('sb-f-status').value;
    const fFrom = document.getElementById('sb-f-from').value;
    const fTo = document.getElementById('sb-f-to').value;
    if (fSearch) rows = rows.filter((r) =>
      r.item_description.toLowerCase().includes(fSearch) ||
      (r.pawn_reference || '').toLowerCase().includes(fSearch) ||
      (r.buyer_name || '').toLowerCase().includes(fSearch) ||
      (r.sku || '').toLowerCase().includes(fSearch) ||
      (r.weight_grams !== null && String(r.weight_grams).includes(fSearch)) ||
      (r.pawn_date || '').includes(fSearch) ||
      (r.sale_date || '').includes(fSearch));
    if (fStatus !== 'all') rows = rows.filter((r) => r.status === fStatus);
    if (fFrom) rows = rows.filter((r) => r.pawn_date && r.pawn_date >= fFrom);
    if (fTo) rows = rows.filter((r) => r.pawn_date && r.pawn_date <= fTo);

    // Pill count, active-filter strip, tiles and list all follow these same filters
    // (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(rows.length);
    const hasFilters = !!(fSearch || fStatus !== 'all' || fFrom || fTo);
    const activeEl = document.getElementById('sb-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(fSearch) }, { label: 'Status', value: esc(fStatus) },
      { label: 'Pawned From', value: esc(fFrom) }, { label: 'Pawned To', value: esc(fTo) },
    ], 'sb-f-clear');
    wireProxyButtons(activeEl);

    const counts = SUB_STATUSES.reduce((acc, s) => { acc[s] = rows.filter((r) => r.status === s).length; return acc; }, {});
    const soldTotal = rows.filter((r) => r.status === 'Sold').reduce((s, r) => s + Number(r.sale_price || 0), 0);
    const todayStr = localDateStr();
    const soldToday = rows.filter((r) => r.status === 'Sold' && r.sale_date === todayStr).reduce((s, r) => s + Number(r.sale_price || 0), 0);
    const totalWeight = rows.reduce((s, r) => s + Number(r.weight_grams || 0), 0);
    document.getElementById('sb-tiles').innerHTML =
      tile(rows.length, 'Qty') + tile(weight(totalWeight), 'Total Weight') +
      tile(counts.Pending, 'Pending') + tile(counts.Listed, 'Listed') + tile(counts.Sold, 'Sold') + tile(money(soldTotal), 'Sold Total') + tile(money(soldToday), 'Sold Today');

    const list = document.getElementById('sb-list');
    if (!rows.length) {
      list.innerHTML = emptyStateHtml({
        message: hasFilters ? 'No subasta items match these filters.' : 'No subasta items recorded for this branch yet.',
        hasFilters, clearId: 'sb-f-clear',
        createLabel: canAddHere() ? '+ New Subasta' : null, createId: 'sb-new-btn',
      });
      wireProxyButtons(list);
      return;
    }

    // Scan-at-a-glance columns only; everything else lives in the Detail Drawer.
    // Filtering already picked `rows`; sort only reorders them for display (section 11).
    const sortedRows = applySort(rows, sort, SB_SORT_COMPARATORS);
    list.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:26%"><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:13%"><col style="width:12%"></colgroup>' +
      '<thead><tr><th>Item</th><th>Weight</th><th>Pawn Ref</th><th>Pawn Date</th><th>Status</th><th>Sale Price</th><th></th></tr></thead><tbody>' +
      sortedRows.map((r) => '<tr>' +
        '<td data-label="Item">' + esc(r.item_description) + (r.sku ? '<div class="muted" style="font-size:10px;">' + esc(r.sku) + '</div>' : '') + '</td>' +
        '<td data-label="Weight">' + weight(r.weight_grams) + '</td>' +
        '<td data-label="Pawn Ref">' + esc(r.pawn_reference || '—') + '</td>' +
        '<td data-label="Pawn Date">' + (r.pawn_date || '—') + '</td>' +
        '<td data-label="Status"><span class="badge ' + (SUB_STATUS_BADGE[r.status] || 'pending') + '">' + esc(r.status) + '</span></td>' +
        '<td data-label="Sale Price">' + money(r.sale_price) + '</td>' +
        '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + r.id + '">View Details</button></td>' +
      '</tr>').join('') +
      '</tbody></table></div>';
    list.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(btn.dataset.id)));
  }

  function renderDetailBody(r) {
    const payments = r.subasta_payments || [];
    const paymentHtml = payments.length
      ? payments.map((p) => '<div class="payment-line">' + money(p.amount) + ' · ' + esc(p.payment_method) + '</div>').join('')
      : '<p class="muted" style="margin:0;">' + (r.payment_method ? esc(r.payment_method) : 'No payment recorded.') + '</p>';
    return '<div class="drawer-section"><h4>Item</h4>' +
      '<div class="drawer-kv"><span>Item</span><b>' + esc(r.item_description) + '</b></div>' +
      '<div class="drawer-kv"><span>SKU</span><b>' + esc(r.sku || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Weight</span><b>' + weight(r.weight_grams) + '</b></div>' +
      '<div class="drawer-kv"><span>Branch</span><b>' + esc(branchName(r.branch_id)) + '</b></div>' +
      '<div class="drawer-kv"><span>Status</span><b><span class="badge ' + (SUB_STATUS_BADGE[r.status] || 'pending') + '">' + esc(r.status) + '</span></b></div>' +
      (r.converted_from_scrap_entry_id ? '<div class="drawer-kv"><span>Origin</span><b>Converted from Scrap #' + r.converted_from_scrap_entry_id + '</b></div>' : '') +
    '</div>' +
    '<div class="drawer-section"><h4>Pawn</h4>' +
      '<div class="drawer-kv"><span>Pawn Reference</span><b>' + esc(r.pawn_reference || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Pawn Date</span><b>' + (r.pawn_date || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Auction Eligible</span><b>' + (r.auction_eligible_date || '—') + '</b></div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Sale</h4>' +
      '<div class="drawer-kv"><span>Sale Date</span><b>' + (r.sale_date || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Sale Price</span><b>' + money(r.sale_price) + '</b></div>' +
      '<div class="drawer-kv"><span>Buyer</span><b>' + esc(r.buyer_name || '—') + '</b></div>' +
      '<div style="margin-top:8px;">' + paymentHtml + '</div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Notes</h4>' +
      (r.notes ? '<div class="drawer-kv"><span>Notes</span><b>' + esc(r.notes) + '</b></div>' : '') +
      '<div class="drawer-kv"><span>Recorded By</span><b>' + esc((r.creator && r.creator.full_name) || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Created</span><b>' + fmtDateTime(r.created_at) + '</b></div>' +
    '</div>' +
    (canWriteHere()
      ? '<div class="drawer-section"><h4>Actions</h4>' +
          '<button type="button" class="btn small secondary" data-act="edit">Edit</button> ' +
          '<button type="button" class="btn small secondary" data-act="delete" data-id="' + r.id + '">Delete</button>' +
        '</div>'
      : '');
  }

  // Edit form rendered INSIDE the detail drawer body (spec 279): Save returns to the
  // refreshed details, Cancel returns to the unchanged details.
  function editFormHtml(r) {
    const existingPayments = (r.subasta_payments || []).map((p) => ({ method: p.payment_method, amount: p.amount }));
    return '<form id="sb-edit-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
      '<div class="drawer-section"><h4>Item</h4>' +
        '<div class="field"><label>Branch</label><select name="branchId"' + (isScoped ? ' disabled' : '') + '>' + branchOptions(r.branch_id) + '</select></div>' +
        '<div class="field"><label>SKU</label><input type="text" name="sku" value="' + esc(r.sku || '') + '"></div>' +
        '<div class="field"><label>Item Description *</label><input type="text" name="itemDescription" value="' + esc(r.item_description) + '" required></div>' +
        '<div class="field"><label>Weight (grams)</label><input type="number" name="weightGrams" step="0.001" min="0" value="' + (r.weight_grams ?? '') + '"></div>' +
      '</div>' +
      '<div class="drawer-section"><h4>Pawn</h4>' +
        '<div class="field"><label>Pawn Reference</label><input type="text" name="pawnReference" value="' + esc(r.pawn_reference || '') + '"></div>' +
        '<div class="field"><label>Pawn Date</label><input type="date" name="pawnDate" value="' + (r.pawn_date || '') + '"></div>' +
        '<div class="field"><label>Auction Eligible Date</label><input type="date" name="auctionEligibleDate" value="' + (r.auction_eligible_date || '') + '"></div>' +
      '</div>' +
      '<div class="drawer-section"><h4>Sale</h4>' +
        '<div class="field"><label>Status</label><select name="status">' + SUB_STATUS_OPTIONS(r.status) + '</select></div>' +
        '<div class="field"><label>Sale Date</label><input type="date" name="saleDate" value="' + (r.sale_date || '') + '"></div>' +
        '<div class="field"><label>Buyer</label><input type="text" name="buyerName" value="' + esc(r.buyer_name || '') + '"></div>' +
        paymentSlotsHtml(existingPayments) +
      '</div>' +
      '<div class="drawer-section"><h4>Notes</h4>' +
        '<div class="field"><label>Notes</label><input type="text" name="notes" value="' + esc(r.notes || '') + '"></div>' +
      '</div>' +
      '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn" type="submit">Save Changes</button>' +
        '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
      '</div>' +
    '</form>';
  }

  function wireDetailBody(container, r) {
    const editBtn = container.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener('click', () => {
      document.getElementById('sb-detail-title').textContent = 'Edit — ' + r.item_description;
      container.innerHTML = editFormHtml(r);
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', () => openDetail(r.id));
      container.querySelector('#sb-edit-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await updateSubastaItem(r.id, {
            branchId: isScoped ? employee.branch_id : Number(f.branchId.value),
            sku: f.sku.value.trim(),
            itemDescription: f.itemDescription.value.trim(), weightGrams: f.weightGrams.value ? Number(f.weightGrams.value) : null,
            pawnReference: f.pawnReference.value.trim(),
            pawnDate: f.pawnDate.value || null, auctionEligibleDate: f.auctionEligibleDate.value || null,
            status: f.status.value, saleDate: f.saleDate.value || null,
            payments: readPaymentSlots(f),
            buyerName: f.buyerName.value.trim(), notes: f.notes.value.trim(),
          });
          toast(msgId, 'Item updated.', false);
          await load();
          refreshDetailIfOpen(r.id);
        } catch (err) {
          toast(msgId, String(err.message || err), true);
          btn.disabled = false;
        }
      });
    });

    const deleteBtn = container.querySelector('[data-act="delete"]');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this item?')) return;
      try { await deleteSubastaItem(deleteBtn.dataset.id); toast(msgId, 'Deleted.', false); closeDetailDrawer(); await load(); }
      catch (err) { toast(msgId, String(err.message || err), true); }
    });
  }

  document.getElementById('sb-f-search').addEventListener('input', render);
  document.getElementById('sb-f-status').addEventListener('change', render);
  document.getElementById('sb-f-from').addEventListener('change', render);
  document.getElementById('sb-f-to').addEventListener('change', render);
  document.getElementById('sb-f-clear').addEventListener('click', () => {
    document.getElementById('sb-f-search').value = '';
    document.getElementById('sb-f-status').value = 'all';
    document.getElementById('sb-f-from').value = '';
    document.getElementById('sb-f-to').value = '';
    render();
  });
  wireSortControl('sb-sort-field', 'sb-sort-dir', sort, render);

  const unsubscribe = subscribeToChanges('subasta_items', load);
  await load();

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec
  // 321) can open this item's own Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail };
}
