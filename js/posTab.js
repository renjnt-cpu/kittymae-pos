// POS (Walk-In) tab (Branches page) -- standalone module scoped to whichever branch
// is selected on the host page (getBranchId()), following the same Form Drawer /
// Detail Drawer pattern as Layaway, Scrap and Subasta -- Ren's spec sections 271-288:
// "+ New Sale" opens a right-side drawer holding the product search, the cart and
// the checkout form (the drawer is wider than the others because the product
// results and cart need the room); after Complete Sale the same drawer switches to
// the saved sale's details (273); every ledger row's "View Details" opens that same
// drawer (278); Edit (a line's amount, or the whole payment split), Mark COD
// Collected, Print Receipt and Delete Sale live inside it (279/282). Page order
// follows the MASTER UI rules: primary action, Summary tiles, Search & Filters,
// active-filter strip, the Sales-by-Admin pivot, then the ledger.
import {
  searchProducts, listActiveEmployees, createPosSale, listSales, listSalePayments,
  updatePosSaleItem, updatePosSalePayments, markCodCollected, deletePosSale, subscribeToChanges,
} from './api.js?v=20260922c';
import { branchColor } from './branchColors.js?v=20260922c';
import { POS_PAYMENT_METHODS } from './paymentMethods.js?v=20260922c';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, localDateStr, flagInvalid } from './uiKit.js?v=20260922c';

// Global Filter + Sort rules (Ren, 2026-09-21, section 12): Sales Transactions sortable
// across Date & Time/Order/Customer/SKU/Qty/Amount/Payment. The ledger is one row per
// LINE ITEM but "View Details" acts on the whole sale_group -- so sort operates at the
// group level (using its first item / totals), same as the group-level filters above
// it, and every line of a multi-item sale stays together in the sorted order.
const POS_SORT_FIELDS = [
  { key: 'sale_date', label: 'Date & Time' }, { key: 'order_number', label: 'Order' }, { key: 'customer_name', label: 'Customer' },
  { key: 'sku', label: 'SKU (first item)' }, { key: 'qty', label: 'Qty (total items)' }, { key: 'amount', label: 'Amount' },
  { key: 'line_total', label: 'Line Total (first item)' }, { key: 'payment_method', label: 'Payment Method' },
];

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
// Per Gram jewelry (Ren, 2026-09-18: "since its jewelry per piece i also sell per
// gram... we will based it per grams") -- a Per Gram SKU's price = its rate
// (current_gold_rate_per_g) x its weight, computed here (not stored) so it auto-fills
// into the cart but is still just a starting point staff can adjust by hand.
const effectivePrice = (p) => p.pricing_mode === 'Per Gram'
  ? (p.current_gold_rate_per_g != null && p.gross_weight_g != null ? p.current_gold_rate_per_g * p.gross_weight_g : null)
  : p.system_selling_price;

// Product filters -- same CHECK-constrained values as products.product_line/
// metal_purity (02_products_inventory.sql), not a separate free-text list.
const POS_PRODUCT_LINES = ['18K Saudi Gold', '18K Coated', 'Moissanite', 'Silver 925/999', 'Stainless/Fashion'];
const POS_METAL_PURITIES = ['24K', '21K', '20K', '18K', '925', '999', 'N/A'];

// Same write-access group as the host page's canWriteHere() before extraction.
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

// 3 fixed payment slots (method / amount / reference), all optional -- covers any real
// split without a dynamic add/remove list. Blank/zero slots are ignored on submit.
function paymentSlotsHtml(prefix, existing) {
  const rows = existing && existing.length ? existing : [];
  let html = '';
  for (let i = 0; i < 3; i++) {
    const row = rows[i] || {};
    const label = i === 0 ? 'Payment Method (optional)' : 'Payment Method ' + (i + 1) + ' (optional)';
    html +=
      '<div class="field"><label>' + label + '</label><select name="' + prefix + 'Method' + i + '">' +
        '<option value="">— none —</option>' +
        POS_PAYMENT_METHODS.map((m) => '<option' + (row.method === m ? ' selected' : '') + '>' + m + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Amount (PHP)</label><input type="number" name="' + prefix + 'Amount' + i + '" step="0.01" min="0"' + (row.amount ? ' value="' + row.amount + '"' : '') + '></div>' +
      '<div class="field"><label>Reference Number</label><input type="text" name="' + prefix + 'Reference' + i + '"' + (row.reference ? ' value="' + row.reference + '"' : '') + '></div>';
  }
  return html;
}
function readPaymentSlots(f, prefix) {
  const payments = [];
  for (let i = 0; i < 3; i++) {
    const method = f[prefix + 'Method' + i]?.value;
    const amount = Number(f[prefix + 'Amount' + i]?.value || 0);
    const reference = f[prefix + 'Reference' + i]?.value?.trim() || '';
    if (method && amount > 0) payments.push({ method, amount, reference });
  }
  return payments;
}

/** Mounts the POS tab into `root` (an empty container this owns entirely), scoped to
 * `getBranchId()` at call time. `esc`/`toast` are the page's own shell.js helpers;
 * `msgId` is the page's toast container id; `employee` is the signed-in employee
 * record; `branches` is the page's active-branch list. Returns
 * { reload, unsubscribe, openDetail }. */
export async function initPosTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate }) {
  const isScoped = employee.role === 'Branch Supervisor';
  // Editing/deleting a completed POS sale (update_pos_sale_item/delete_pos_sale
  // enforce this same gate server-side) -- Ren, 2026-09-16/17: Admin/Manager/Branch
  // Supervisor role, or the Branch Team Leader position.
  const canEditSale = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || employee.position === 'Branch Team Leader';
  // Correcting an already-recorded amount (Unit Price, Qty, or the payment split) is
  // narrower (Ren's spec 121-132) -- mirrors is_amount_editor() exactly. Editor and
  // Branch Team Leader added 2026-09-22 per Ren: "AUDITOR, EDITOR, SUPERVISOR, BRANCH
  // TEAM LEADER CAN EDIT THE TRANSACTION" (Editor/Supervisor already carried the
  // matching transaction.edit_amount DB grant; Branch Team Leader's grant was added
  // alongside this change so the UI and the server-side gate agree).
  const canEditAmount = ['Admin', 'Branch Supervisor'].includes(employee.role) || ['Auditor', 'Editor', 'Branch Team Leader'].includes(employee.position) ||
    (employee.position || '').includes('Supervisor');
  function canWriteHere() {
    return ['Admin', 'Manager'].includes(employee.role) || (isScoped && getBranchId() === employee.branch_id) ||
      POSITION_MANAGERS.includes(employee.position);
  }
  // Ringing up a sale: everything canWriteHere() allows, plus any active employee for
  // their own branch, plus Sales Admin Associate company-wide (assert_can_act_on_branch()).
  function canAddHere() {
    return canWriteHere() || employee.branch_id === getBranchId() || employee.position === 'Sales Admin Associate';
  }
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  // sales_inventory_movements only carries employee_id -- resolved to a display name
  // the same way every other admin-attributed list does (get_employee_names()).
  const employeeNameById = Object.fromEntries((await listActiveEmployees()).map((e) => [e.id, e.full_name]));
  const sort = { field: 'sale_date', dir: 'desc' };

  root.innerHTML =
    // Summary sits right beside + New Sale (Ren, 2026-09-22: "UNDER POS PUT SUMMARY
    // BESIDE NEW SALE") instead of down by the ledger heading -- same button/popover,
    // same ids, just relocated; scope/data (spec 41-51) is unchanged.
    '<div class="module-topbar"><div></div><div style="text-align:right;display:flex;gap:8px;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap;">' +
      '<button type="button" class="btn" id="pos-new-btn">+ New Sale</button>' +
      '<div style="position:relative;">' +
        '<button type="button" class="btn small secondary" id="pos-summary-toggle">Summary ▾</button>' +
        '<div id="pos-summary-panel" class="pos-summary-panel" style="display:none;"></div>' +
      '</div>' +
      '<div id="pos-write-note"></div>' +
    '</div></div>' +
    '<div class="tiles" id="pos-tiles"></div>' +
    // From/To drive both the pivot and the ledger; Search only narrows the ledger
    // (Ren, 2026-09-16: "the date range must be put above so once they filter it
    // also reflect all the data").
    '<div class="card">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:200px;"><label>Search</label><input type="text" id="pos-f-search" placeholder="SKU, item, customer, order…"></div>' +
        '<div class="field"><label>From</label><input type="date" id="pos-f-from"></div>' +
        '<div class="field"><label>To</label><input type="date" id="pos-f-to"></div>' +
        // Catches a line a staff member rang up without ever entering a Unit Price
        // (Ren, 2026-09-22) -- shows the whole sale a zero-total line belongs to, not
        // just that one row, since View Details/fixing it happens at the sale level.
        '<label class="pos-check" style="align-self:center;"><input type="checkbox" id="pos-f-zero"> Zero-amount lines only</label>' +
        sortControlHtml(POS_SORT_FIELDS, sort, 'pos-sort-field', 'pos-sort-dir') +
        '<button type="button" class="btn small secondary" id="pos-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="pos-active"></div>' +
    '<h3 style="margin-top:0;">Sales by Admin &amp; Payment Method <span class="muted" style="font-weight:normal;font-size:12px;">— reflects the From/To date range above, all admins for this branch</span></h3>' +
    '<div id="pos-by-admin" style="margin-bottom:20px;"><div class="muted">Loading…</div></div>' +
    '<h3 style="margin-top:6px;">Sales Transactions</h3>' +
    '<div id="pos-list"><div class="muted">Loading…</div></div>' +

    // ---- Form Drawer: New Sale (product search + cart + checkout) ----
    '<div class="drawer-backdrop" id="pos-form-backdrop"></div>' +
    '<div class="drawer drawer-wide" id="pos-form-drawer">' +
      '<div class="drawer-header"><div><h3>New Sale</h3><div class="muted" id="pos-form-branch"></div></div><button type="button" class="drawer-close" id="pos-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<div id="pos-order-msg"></div>' +
        '<div class="drawer-section">' +
          '<h4>Items</h4>' +
          '<div class="pos-toolbar">' +
            '<div class="field" style="flex:1;min-width:180px;"><label>Search Products</label><input type="text" id="pos-cat-search" autocomplete="off" placeholder="SKU or item name…"></div>' +
            '<div class="field"><label>Product Line</label><select id="pos-cat-line"><option value="">All</option>' + POS_PRODUCT_LINES.map((l) => '<option>' + l + '</option>').join('') + '</select></div>' +
            '<button type="button" class="btn small secondary" id="pos-cat-more-toggle">More filters</button>' +
          '</div>' +
          '<div class="pos-toolbar-more" id="pos-cat-more" style="display:none;">' +
            '<div class="field"><label>Purity</label><select id="pos-cat-purity"><option value="">All</option>' + POS_METAL_PURITIES.map((p) => '<option>' + p + '</option>').join('') + '</select></div>' +
            '<label class="pos-check"><input type="checkbox" id="pos-cat-instock"> In stock at this branch</label>' +
          '</div>' +
          '<div id="pos-cat-grid" class="pos-grid"><p class="muted">Search a SKU or item name to start.</p></div>' +
          '<label style="font-size:13px;font-weight:600;display:block;margin-top:12px;">Cart *</label>' +
          '<div id="pos-cart-lines"></div>' +
        '</div>' +
        '<form id="pos-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="drawer-section">' +
            '<h4>Customer</h4>' +
            '<div class="field"><label>Order / Reference No.</label><input type="text" name="orderId"></div>' +
            '<div class="field"><label>Date</label><input type="date" name="saleDate"></div>' +
            '<div class="field"><label>Customer Name</label><input type="text" name="customerName"></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber"></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Payment</h4>' +
            paymentSlotsHtml('pos', []) +
            '<div class="card" style="background:#f7f5f0;margin:6px 0 0;padding:10px 14px;">' +
              '<div style="display:flex;justify-content:space-between;font-size:13px;"><span>Subtotal</span><b id="pos-subtotal">₱0.00</b></div>' +
              '<div style="display:flex;justify-content:space-between;font-size:13px;"><span>Paid</span><b id="pos-paid">₱0.00</b></div>' +
              '<div style="display:flex;justify-content:space-between;font-size:13px;"><span id="pos-balance-label">Balance Due</span><b id="pos-balance">₱0.00</b></div>' +
            '</div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="pos-form" id="pos-complete-btn">Complete Sale</button>' +
        '<button type="button" class="btn secondary" id="pos-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +
    // ---- Detail Drawer: one completed sale (a sale_group) ----
    '<div class="drawer-backdrop" id="pos-detail-backdrop"></div>' +
    '<div class="drawer drawer-wide" id="pos-detail-drawer">' +
      '<div class="drawer-header"><div><h3 id="pos-detail-title">Sale Details</h3><div class="muted" id="pos-detail-sub"></div></div><button type="button" class="drawer-close" id="pos-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="pos-detail-body"></div>' +
    '</div>';

  // ---- product search + cart (P1 responsive redesign, now inside the drawer) ----
  let posCart = [];
  let catalogResults = [];
  let catalogQuery = '', catalogLine = '', catalogPurity = '', catalogInStockOnly = false;
  let catalogSearchToken = 0, catalogSearchTimer = null;

  function renderCatalogGrid() {
    const grid = document.getElementById('pos-cat-grid');
    if (!catalogQuery.trim()) { grid.innerHTML = '<p class="muted">Search a SKU or item name to start.</p>'; return; }
    let rows = catalogResults;
    if (catalogLine) rows = rows.filter((p) => p.product_line === catalogLine);
    if (catalogPurity) rows = rows.filter((p) => p.metal_purity === catalogPurity);
    if (catalogInStockOnly) rows = rows.filter((p) => (p.qty_available || 0) > 0);
    if (!rows.length) { grid.innerHTML = '<p class="muted">No matching SKUs for this search/filter.</p>'; return; }
    // Fewest pieces at THIS branch first, so a thin count is never buried below a
    // search's more-stocked results (same ordering as SKU Catalog's branch sort).
    rows = rows.slice().sort((a, b) => Number(a.qty_available || 0) - Number(b.qty_available || 0));
    const bc = branchColor(getBranchId(), branches);
    const bName = branchName(getBranchId());
    grid.innerHTML = rows.map((p) => {
      const stock = p.qty_available;
      return '<div class="pos-card" data-sku="' + esc(p.sku) + '">' +
        '<div class="pos-card-thumb">💍</div>' +
        '<div class="pos-card-name">' + esc(p.item_name) + '</div>' +
        '<div class="pos-card-meta">' + esc(p.sku) + (p.product_line ? ' · ' + esc(p.product_line) : '') + (p.metal_purity ? ' · ' + esc(p.metal_purity) : '') + '</div>' +
        (p.gross_weight_g != null ? '<div class="pos-card-meta">' + p.gross_weight_g + 'g</div>' : '') +
        '<div class="pos-card-price">' + money(effectivePrice(p)) + (p.pricing_mode === 'Per Gram' ? ' <span class="muted" style="font-size:10px;">(' + money(p.current_gold_rate_per_g) + '/g)</span>' : '') + '</div>' +
        // Branch named + colored, since a stock count means nothing without knowing
        // which branch it's counting.
        (stock != null ? '<div class="pos-card-stock' + (stock <= 0 ? ' low' : '') + '" style="' + (stock > 0 ? 'background:' + bc.bg + ';color:' + bc.text + ';font-weight:700;' : '') + '">' +
          esc(bName) + ': ' + (stock > 0 ? stock + ' in stock' : 'Out of stock') + '</div>' : '') +
      '</div>';
    }).join('');
    grid.querySelectorAll('.pos-card').forEach((card) => card.addEventListener('click', () => addToCart(card.dataset.sku)));
  }
  function addToCart(sku) {
    const product = catalogResults.find((p) => p.sku === sku);
    if (!product) return;
    const existing = posCart.find((c) => c.sku === sku);
    if (existing) existing.qty += 1;
    else posCart.push({ sku: product.sku, itemName: product.item_name, qty: 1, unitPrice: effectivePrice(product) ?? null });
    renderCart();
    updateTotals();
  }
  function renderCart() {
    const box = document.getElementById('pos-cart-lines');
    if (!posCart.length) {
      box.innerHTML = '<p class="muted" style="font-size:12px;">No items yet — tap a product above to add it.</p>';
      return;
    }
    box.innerHTML = posCart.map((it, i) =>
      '<div class="pos-cart-line" data-i="' + i + '">' +
        '<div style="flex:1;min-width:0;">' +
          '<div class="pos-cart-line-name">' + esc(it.itemName) + '</div>' +
          '<div class="pos-cart-line-sku">' + esc(it.sku) + '</div>' +
        '</div>' +
        '<input type="number" class="pos-cart-line-qty" min="1" value="' + it.qty + '" title="Qty" aria-label="Qty">' +
        '<input type="number" class="pos-cart-line-price" step="0.01" min="0" value="' + (it.unitPrice ?? '') + '" placeholder="PHP" title="Unit Price" aria-label="Unit Price">' +
        '<button type="button" class="pos-cart-remove" title="Remove" aria-label="Remove">✕</button>' +
      '</div>').join('');
    box.querySelectorAll('.pos-cart-line').forEach((line) => {
      const i = Number(line.dataset.i);
      line.querySelector('.pos-cart-line-qty').addEventListener('input', (ev) => { posCart[i].qty = Number(ev.target.value || 0); updateTotals(); });
      line.querySelector('.pos-cart-line-price').addEventListener('input', (ev) => { posCart[i].unitPrice = ev.target.value ? Number(ev.target.value) : null; updateTotals(); });
      line.querySelector('.pos-cart-remove').addEventListener('click', () => { posCart.splice(i, 1); renderCart(); updateTotals(); });
    });
  }
  async function runCatalogSearch() {
    const q = catalogQuery.trim();
    if (!q) { catalogResults = []; renderCatalogGrid(); return; }
    const token = ++catalogSearchToken;
    try {
      const results = await searchProducts(q, getBranchId());
      if (token !== catalogSearchToken) return;
      catalogResults = results;
      renderCatalogGrid();
    } catch (err) { /* a failed lookup shouldn't block the rest of the page */ }
  }
  document.getElementById('pos-cat-search').addEventListener('input', (ev) => {
    catalogQuery = ev.target.value;
    clearTimeout(catalogSearchTimer);
    if (!catalogQuery.trim()) { catalogResults = []; renderCatalogGrid(); return; }
    catalogSearchTimer = setTimeout(runCatalogSearch, 200);
  });
  document.getElementById('pos-cat-line').addEventListener('change', (ev) => { catalogLine = ev.target.value; renderCatalogGrid(); });
  document.getElementById('pos-cat-purity').addEventListener('change', (ev) => { catalogPurity = ev.target.value; renderCatalogGrid(); });
  document.getElementById('pos-cat-instock').addEventListener('change', (ev) => { catalogInStockOnly = ev.target.checked; renderCatalogGrid(); });
  document.getElementById('pos-cat-more-toggle').addEventListener('click', () => {
    const more = document.getElementById('pos-cat-more');
    more.style.display = more.style.display === 'none' ? '' : 'none';
  });

  const cartItems = () => posCart.filter((it) => it.sku && it.qty > 0).map((it) => ({ sku: it.sku, qty: it.qty, unitPrice: it.unitPrice }));
  const posForm = document.getElementById('pos-form');
  posForm.saleDate.value = localDateStr();
  function updateTotals() {
    const items = cartItems();
    const subtotal = items.reduce((s, it) => s + (it.unitPrice || 0) * (it.qty || 0), 0);
    const paid = readPaymentSlots(posForm, 'pos').reduce((s, p) => s + p.amount, 0);
    const balance = subtotal - paid;
    document.getElementById('pos-subtotal').textContent = money(subtotal);
    document.getElementById('pos-paid').textContent = money(paid);
    document.getElementById('pos-balance-label').textContent = balance > 0 ? 'Balance Due' : 'Change Due';
    document.getElementById('pos-balance').textContent = money(Math.abs(balance));
    document.getElementById('pos-balance').style.color = balance > 0 ? '#b23c3c' : (balance < 0 ? '#2e7d4f' : '');
  }
  posForm.addEventListener('input', updateTotals);
  renderCart();
  updateTotals();

  // ---- drawers ----
  function openFormDrawer() {
    document.getElementById('pos-form-branch').textContent = branchName(getBranchId());
    document.getElementById('pos-form-backdrop').classList.add('open');
    document.getElementById('pos-form-drawer').classList.add('open');
    setTimeout(() => document.getElementById('pos-cat-search').focus(), 250);
  }
  function closeFormDrawer() {
    document.getElementById('pos-form-backdrop').classList.remove('open');
    document.getElementById('pos-form-drawer').classList.remove('open');
  }
  document.getElementById('pos-new-btn').addEventListener('click', openFormDrawer);
  document.getElementById('pos-form-close').addEventListener('click', closeFormDrawer);
  document.getElementById('pos-form-cancel').addEventListener('click', closeFormDrawer);
  document.getElementById('pos-form-backdrop').addEventListener('click', closeFormDrawer);

  function closeDetailDrawer() {
    document.getElementById('pos-detail-backdrop').classList.remove('open');
    document.getElementById('pos-detail-drawer').classList.remove('open');
  }
  document.getElementById('pos-detail-close').addEventListener('click', closeDetailDrawer);
  document.getElementById('pos-detail-backdrop').addEventListener('click', closeDetailDrawer);
  function openDetail(groupId) {
    const g = groupPosSales(allPosSales).find((x) => String(x.groupId) === String(groupId));
    if (!g) return;
    const first = g.items[0];
    // .textContent escapes on its own -- esc() here would double-escape.
    document.getElementById('pos-detail-title').textContent = 'Sale' + (first.order_number ? ' — Order #' + first.order_number : '');
    document.getElementById('pos-detail-sub').textContent = branchName(first.branch_id) + ' · ' + fmtDateTime(first.sale_date);
    const body = document.getElementById('pos-detail-body');
    body.innerHTML = renderDetailBody(g);
    wireDetailBody(body, g);
    document.getElementById('pos-detail-backdrop').classList.add('open');
    document.getElementById('pos-detail-drawer').classList.add('open');
  }
  function refreshDetailIfOpen(groupId) {
    if (!document.getElementById('pos-detail-drawer').classList.contains('open')) return;
    if (!allPosSales.some((r) => String(r.sale_group_id) === String(groupId))) { closeDetailDrawer(); return; }
    openDetail(groupId);
  }

  posForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = document.getElementById('pos-complete-btn');
    const items = cartItems();
    // pos-order-msg lives inside the drawer so a validation/save error is visible on
    // a phone, where the drawer covers the page's own message area.
    if (!items.length) {
      toast('pos-order-msg', 'Add at least one item to sell.', true);
      flagInvalid(document.getElementById('pos-cat-search'));
      return;
    }
    const badQty = items.find((it) => !it.qty || it.qty <= 0);
    if (badQty) {
      toast('pos-order-msg', 'Qty must be a positive number for ' + badQty.sku + '.', true);
      const idx = posCart.findIndex((it) => it.sku === badQty.sku);
      flagInvalid(document.querySelector('.pos-cart-line[data-i="' + idx + '"] .pos-cart-line-qty'));
      return;
    }
    const payments = readPaymentSlots(f, 'pos');
    btn.disabled = true;
    try {
      const groupId = await createPosSale({
        branchId: getBranchId(), items,
        customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(),
        orderNumber: f.orderId.value.trim(), payments, saleDate: f.saleDate.value || null,
        notes: f.notes.value.trim(),
      });
      toast(msgId, 'Sale completed — ' + items.length + ' item(s), ' + money(items.reduce((s, it) => s + (it.unitPrice || 0) * it.qty, 0)) + '.', false);
      f.reset();
      posForm.saleDate.value = localDateStr();
      posCart = [];
      renderCart();
      updateTotals();
      closeFormDrawer();
      await load();
      // The same drawer system now shows the saved sale (spec 273).
      if (groupId) openDetail(groupId);
    } catch (err) {
      toast('pos-order-msg', String(err.message || err), true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- ledger data ----
  let allPosSales = [], posPaymentsByGroup = {};

  async function load() {
    const list = document.getElementById('pos-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const rows = await listSales({ branchId: getBranchId() });
      allPosSales = rows.filter((r) => r.sale_group_id);
      const groupIds = [...new Set(allPosSales.map((r) => r.sale_group_id))];
      const payments = await listSalePayments(groupIds);
      posPaymentsByGroup = {};
      payments.forEach((p) => { (posPaymentsByGroup[p.sale_group_id] || (posPaymentsByGroup[p.sale_group_id] = [])).push(p); });
      render();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
    // Stock badges in the product results are per branch -- refresh them on reload.
    if (catalogQuery.trim()) runCatalogSearch();
  }

  function groupPosSales(rows) {
    const byGroup = {}, order = [];
    rows.forEach((r) => {
      if (!byGroup[r.sale_group_id]) { byGroup[r.sale_group_id] = []; order.push(r.sale_group_id); }
      byGroup[r.sale_group_id].push(r);
    });
    return order.map((gid) => ({ groupId: gid, items: byGroup[gid] }));
  }
  const groupSubtotal = (g) => g.items.reduce((s, r) => s + Number(r.unit_price || 0) * r.qty, 0);
  const groupPaid = (g) => (posPaymentsByGroup[g.groupId] || []).reduce((s, p) => s + Number(p.amount), 0);
  function posSortComparators() {
    const text = (key) => (a, b) => String(a.items[0][key] || '').localeCompare(String(b.items[0][key] || ''));
    return {
      sale_date: text('sale_date'), order_number: text('order_number'), customer_name: text('customer_name'), sku: text('sku'),
      qty: (a, b) => a.items.reduce((s, r) => s + r.qty, 0) - b.items.reduce((s, r) => s + r.qty, 0),
      amount: (a, b) => groupSubtotal(a) - groupSubtotal(b),
      line_total: (a, b) => (Number(a.items[0].unit_price || 0) * a.items[0].qty) - (Number(b.items[0].unit_price || 0) * b.items[0].qty),
      payment_method: (a, b) => String((posPaymentsByGroup[a.groupId] || [])[0]?.payment_method || '').localeCompare(String((posPaymentsByGroup[b.groupId] || [])[0]?.payment_method || '')),
    };
  }

  // Pivot: rows = who processed the sale, columns = payment method, cell = money
  // actually collected that way -- Pending-Collection COD is kept out of the
  // collected columns/Grand Total and tracked separately (Ren's spec 189).
  function renderByAdminPayment(rows) {
    const box = document.getElementById('pos-by-admin');
    const groups = groupPosSales(rows);
    const totalsByAdmin = {}, codPendingByAdmin = {}, methodsSeen = [], groupsByAdmin = {};
    groups.forEach((g) => {
      const empId = g.items[0].employee_id;
      (groupsByAdmin[empId] = groupsByAdmin[empId] || []).push(g);
      const bucket = totalsByAdmin[empId] || (totalsByAdmin[empId] = {});
      (posPaymentsByGroup[g.groupId] || []).forEach((p) => {
        if (p.payment_method === 'COD' && p.payment_status === 'Pending Collection') {
          codPendingByAdmin[empId] = (codPendingByAdmin[empId] || 0) + Number(p.amount);
          return;
        }
        if (!methodsSeen.includes(p.payment_method)) methodsSeen.push(p.payment_method);
        bucket[p.payment_method] = (bucket[p.payment_method] || 0) + Number(p.amount);
      });
    });
    const methods = POS_PAYMENT_METHODS.filter((m) => methodsSeen.includes(m)).concat(methodsSeen.filter((m) => !POS_PAYMENT_METHODS.includes(m)));
    const adminIds = Object.keys(totalsByAdmin).sort((a, b) => (employeeNameById[a] || '').localeCompare(employeeNameById[b] || ''));
    const hasCodPending = Object.values(codPendingByAdmin).some((v) => v > 0);
    if (!adminIds.length) { box.innerHTML = '<p class="muted">No walk-in sales for this filter.</p>'; return; }
    const colTotals = Object.fromEntries(methods.map((m) => [m, 0]));
    const colCount = 1 + methods.length + (hasCodPending ? 1 : 0) + 1;
    let grandTotal = 0, codPendingTotal = 0;
    // Each admin's row expands in place to their own sale groups for this same filter
    // (Ren's 2026-09-22 expand/collapse spec, "Summary by Admin/User") -- built from
    // the exact same groupsByAdmin bucket the collapsed row's own totals come from, so
    // the two always reconcile (section "SUMMARY SYNC").
    box.innerHTML = '<div class="table-scroll"><table><thead><tr><th>Admin</th>' +
      methods.map((m) => '<th>' + esc(m) + '</th>').join('') +
      (hasCodPending ? '<th>COD Pending</th>' : '') +
      '<th>Grand Total</th></tr></thead><tbody>' +
      adminIds.map((empId) => {
        const bucket = totalsByAdmin[empId];
        let rowTotal = 0;
        const cells = methods.map((m) => {
          const amt = bucket[m] || 0;
          colTotals[m] += amt;
          rowTotal += amt;
          return '<td data-label="' + esc(m) + '">' + (amt ? money(amt) : '—') + '</td>';
        }).join('');
        grandTotal += rowTotal;
        const codPending = codPendingByAdmin[empId] || 0;
        codPendingTotal += codPending;
        return '<tr>' +
          '<td data-label="Admin"><button type="button" class="exp-row-btn" data-admin-toggle="' + esc(empId) + '" aria-expanded="false"><span class="exp-arrow" aria-hidden="true">▸</span><b>' + esc(employeeNameById[empId] || 'Unknown') + '</b></button></td>' +
          cells +
          (hasCodPending ? '<td data-label="COD Pending">' + (codPending ? '<span class="badge pending">' + money(codPending) + '</span>' : '—') + '</td>' : '') +
          '<td data-label="Grand Total"><b>' + money(rowTotal) + '</b></td>' +
        '</tr>' +
        '<tr class="admin-detail-row" data-admin-for="' + esc(empId) + '" style="display:none;"><td colspan="' + colCount + '" class="full-row"></td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td data-label="Admin"><b>Grand Total</b></td>' +
      methods.map((m) => '<td data-label="' + esc(m) + '"><b>' + money(colTotals[m]) + '</b></td>').join('') +
      (hasCodPending ? '<td data-label="COD Pending"><b>' + money(codPendingTotal) + '</b></td>' : '') +
      '<td data-label="Grand Total"><b>' + money(grandTotal) + '</b></td></tr></tfoot></table></div>';

    box.querySelectorAll('[data-admin-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const empId = btn.dataset.adminToggle;
      const detailRow = box.querySelector('.admin-detail-row[data-admin-for="' + empId + '"]');
      const opening = detailRow.style.display === 'none';
      btn.setAttribute('aria-expanded', String(opening));
      detailRow.style.display = opening ? '' : 'none';
      if (!opening || detailRow.dataset.built) return;
      detailRow.dataset.built = '1';
      const adminGroups = (groupsByAdmin[empId] || []).slice().sort((a, b) => (b.items[0].sale_date || '').localeCompare(a.items[0].sale_date || ''));
      detailRow.querySelector('td').innerHTML =
        '<div class="table-scroll table-mini" style="margin:6px 0;"><table><thead><tr><th>Date &amp; Time</th><th>Order</th><th>Customer</th><th>Amount</th><th>Payment</th><th></th></tr></thead><tbody>' +
        adminGroups.map((g) => {
          const payments = posPaymentsByGroup[g.groupId] || [];
          const methodLabel = payments.length ? payments.map((p) => esc(p.payment_method)).join(', ') : '—';
          return '<tr>' +
            '<td data-label="Date &amp; Time">' + fmtDateTime(g.items[0].sale_date) + '</td>' +
            '<td data-label="Order">' + esc(g.items[0].order_number || '—') + '</td>' +
            '<td data-label="Customer">' + esc(g.items[0].customer_name || '—') + '</td>' +
            '<td data-label="Amount">' + money(groupSubtotal(g)) + '</td>' +
            '<td data-label="Payment">' + methodLabel + '</td>' +
            '<td class="full-row"><button type="button" class="btn small secondary" data-admin-view-group="' + esc(g.groupId) + '">View Details</button></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
      detailRow.querySelectorAll('[data-admin-view-group]').forEach((vb) => vb.addEventListener('click', () => openDetail(vb.dataset.adminViewGroup)));
    }));
  }

  // Summary popover for whatever's CURRENTLY VISIBLE in the ledger (search included).
  function renderSummary(groups) {
    const panel = document.getElementById('pos-summary-panel');
    if (!groups.length) { panel.innerHTML = '<p class="muted" style="margin:0;">No transactions for this filter.</p>'; return; }
    let itemsSold = 0, lineItems = 0, grandTotal = 0, codPendingTotal = 0;
    const skuQty = {}, skuName = {}, totalsByAdmin = {}, methodTotals = {};
    groups.forEach((g) => {
      const empId = g.items[0].employee_id;
      totalsByAdmin[empId] = (totalsByAdmin[empId] || 0);
      g.items.forEach((r) => {
        lineItems++;
        itemsSold += r.qty;
        skuQty[r.sku] = (skuQty[r.sku] || 0) + r.qty;
        skuName[r.sku] = r.products?.item_name || r.sku;
      });
      (posPaymentsByGroup[g.groupId] || []).forEach((p) => {
        if (p.payment_method === 'COD' && p.payment_status === 'Pending Collection') { codPendingTotal += Number(p.amount); return; }
        methodTotals[p.payment_method] = (methodTotals[p.payment_method] || 0) + Number(p.amount);
        totalsByAdmin[empId] += Number(p.amount);
        grandTotal += Number(p.amount);
      });
    });
    const methods = POS_PAYMENT_METHODS.filter((m) => methodTotals[m]).concat(Object.keys(methodTotals).filter((m) => !POS_PAYMENT_METHODS.includes(m)));
    const adminIds = Object.keys(totalsByAdmin).sort((a, b) => (employeeNameById[a] || '').localeCompare(employeeNameById[b] || ''));
    const topSkus = Object.keys(skuQty).sort((a, b) => skuQty[b] - skuQty[a]).slice(0, 5);
    panel.innerHTML =
      '<h4>Transactions</h4>' +
      '<div class="row"><span>Total Orders</span><b>' + groups.length + '</b></div>' +
      '<div class="row"><span>Items Sold</span><b>' + itemsSold + '</b></div>' +
      '<div class="row"><span>Unique SKUs</span><b>' + Object.keys(skuQty).length + '</b></div>' +
      '<h4 style="margin-top:12px;">Sales</h4>' +
      methods.map((m) => '<div class="row"><span>' + esc(m) + '</span><b>' + money(methodTotals[m]) + '</b></div>').join('') +
      '<div class="row total"><span>Grand Total</span><b>' + money(grandTotal) + '</b></div>' +
      (codPendingTotal ? '<div class="row" style="color:#a15c00;"><span>COD Pending Collection</span><b>' + money(codPendingTotal) + '</b></div>' : '') +
      '<details class="exp" style="margin-top:10px;"><summary><span class="exp-arrow" aria-hidden="true">▸</span>Sales by Admin <span class="exp-count">(' + adminIds.length + ')</span></summary><div class="exp-body">' +
        adminIds.map((id) => '<div class="row"><span>' + esc(employeeNameById[id] || 'Unknown') + '</span><b>' + money(totalsByAdmin[id]) + '</b></div>').join('') +
      '</div></details>' +
      '<details class="exp" style="margin-top:8px;"><summary><span class="exp-arrow" aria-hidden="true">▸</span>Top Selling Items</summary><div class="exp-body">' +
        topSkus.map((sku, i) => '<div class="row"><span>' + (i + 1) + '. ' + esc(skuName[sku]) + ' (' + esc(sku) + ')</span><b>' + skuQty[sku] + ' pcs</b></div>').join('') +
      '</div></details>' +
      '<p class="muted" style="margin:10px 0 0;font-size:11px;">Lines: ' + lineItems + ' · matches the Search/From/To/Branch filters above.</p>';
  }
  document.getElementById('pos-summary-toggle').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const panel = document.getElementById('pos-summary-panel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', (ev) => {
    const panel = document.getElementById('pos-summary-panel');
    if (panel && panel.style.display !== 'none' && !panel.contains(ev.target) && ev.target.id !== 'pos-summary-toggle') panel.style.display = 'none';
  });

  function tile(num, label) { return '<div class="tile"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>'; }

  function paymentStatusHtml(g) {
    const payments = posPaymentsByGroup[g.groupId] || [];
    const paid = groupPaid(g);
    return (paid >= groupSubtotal(g) ? 'Paid in full' : money(paid) + ' paid') +
      (payments.length ? '<div class="muted" style="font-size:10px;">' + payments.map((p) =>
        esc(p.payment_method) +
        (p.payment_method === 'COD' ? (p.payment_status === 'Pending Collection' ? ' <span class="badge pending">Pending Collection</span>' : ' <span class="badge ok">Collected</span>') : '')
      ).join('<br>') + '</div>' : '');
  }

  function render() {
    document.getElementById('pos-new-btn').disabled = !canAddHere();
    document.getElementById('pos-write-note').innerHTML = canAddHere()
      ? ''
      : '<p class="muted" style="font-size:11px;">View only — you can only ring up sales for your own branch.</p>';

    const fSearch = document.getElementById('pos-f-search').value.trim().toLowerCase();
    const fFrom = document.getElementById('pos-f-from').value;
    const fTo = document.getElementById('pos-f-to').value;
    const fZero = document.getElementById('pos-f-zero').checked;
    let rows = allPosSales;
    if (fFrom) rows = rows.filter((r) => r.sale_date >= fFrom);
    if (fTo) rows = rows.filter((r) => r.sale_date <= fTo + 'T23:59:59');
    renderByAdminPayment(rows); // date-filtered only -- not narrowed by the free-text search/zero-amount filter
    let groups = groupPosSales(rows);
    if (fSearch) groups = groups.filter((g) => g.items.some((r) =>
      r.sku.toLowerCase().includes(fSearch) || (r.products?.item_name || '').toLowerCase().includes(fSearch) ||
      (r.customer_name || '').toLowerCase().includes(fSearch) || (r.order_number || '').toLowerCase().includes(fSearch)));
    // Surfaces the whole sale a ₱0 line belongs to (not just that one row) -- a
    // multi-item sale with one missing price is still one thing to go fix.
    if (fZero) groups = groups.filter((g) => g.items.some((r) => Number(r.unit_price || 0) * r.qty === 0));
    renderSummary(groups);

    // Pill count, tiles, active-filter strip and ledger all follow these same filters
    // (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(groups.length);
    const totalAmount = groups.reduce((s, g) => s + groupSubtotal(g), 0);
    document.getElementById('pos-tiles').innerHTML = tile(groups.length, 'Sales') + tile(money(totalAmount), 'Total Amount');
    const hasFilters = !!(fSearch || fFrom || fTo || fZero);
    const activeEl = document.getElementById('pos-active');
    activeEl.innerHTML = activeFiltersHtml([{ label: 'Search', value: esc(fSearch) }, { label: 'From', value: esc(fFrom) }, { label: 'To', value: esc(fTo) }, { label: 'Zero-amount only', value: fZero ? 'Yes' : '' }], 'pos-f-clear');
    wireProxyButtons(activeEl);

    const box = document.getElementById('pos-list');
    if (!groups.length) {
      box.innerHTML = emptyStateHtml({
        message: hasFilters ? 'No walk-in sales match these filters.' : 'No walk-in sales recorded for this branch yet.',
        hasFilters, clearId: 'pos-f-clear', createLabel: canAddHere() ? '+ New Sale' : null, createId: 'pos-new-btn',
      });
      wireProxyButtons(box);
      return;
    }
    // One formal ledger row per line item (Ren, 2026-09-16: "arrange this POS as
    // formal line those records easily find it"); Date/Order/Customer/Payment repeat
    // on each row of a multi-item sale so the mobile card view keeps working. Every
    // action moved into the Detail Drawer. Filtering already picked `groups`; sort
    // only reorders them -- every line of one sale stays together (section 11).
    const sortedGroups = applySort(groups, sort, posSortComparators());
    box.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<thead><tr><th>Date &amp; Time</th><th>Order</th><th>Customer</th><th>SKU</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Line Total</th><th>Payment</th><th></th></tr></thead><tbody>' +
      sortedGroups.map((g) => {
        const paidLabel = paymentStatusHtml(g);
        return g.items.map((r) => '<tr>' +
          '<td data-label="Date &amp; Time">' + fmtDateTime(r.sale_date) + '</td>' +
          '<td data-label="Order">' + esc(r.order_number || '—') + '</td>' +
          '<td data-label="Customer" class="full-row">' + esc(r.customer_name || '—') + '</td>' +
          '<td data-label="SKU">' + esc(r.sku) + '</td>' +
          '<td data-label="Item" class="full-row">' + esc(r.products?.item_name || '—') + '</td>' +
          '<td data-label="Qty">' + r.qty + '</td>' +
          '<td data-label="Unit Price">' + money(r.unit_price) + '</td>' +
          '<td data-label="Line Total">' + money(Number(r.unit_price || 0) * r.qty) + '</td>' +
          '<td data-label="Payment" class="full-row">' + paidLabel + '</td>' +
          '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-group="' + esc(g.groupId) + '">View Details</button></td>' +
        '</tr>').join('');
      }).join('') +
      '</tbody></table></div>';
    box.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(btn.dataset.group)));
  }

  // ---- Detail Drawer body: one sale ----
  function renderDetailBody(g) {
    const first = g.items[0];
    const payments = posPaymentsByGroup[g.groupId] || [];
    const subtotal = groupSubtotal(g), paid = groupPaid(g), balance = subtotal - paid;
    const notes = [...new Set(g.items.map((r) => r.notes).filter(Boolean))];
    return '<div class="drawer-section"><h4>Sale</h4>' +
      '<div class="drawer-kv"><span>Date &amp; Time</span><b>' + fmtDateTime(first.sale_date) + '</b></div>' +
      '<div class="drawer-kv"><span>Order / Ref No.</span><b>' + esc(first.order_number || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Customer</span><b>' + esc(first.customer_name || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Contact</span><b>' + esc(first.contact_number || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Branch</span><b>' + esc(branchName(first.branch_id)) + '</b></div>' +
      '<div class="drawer-kv"><span>Processed By</span><b>' + esc(employeeNameById[first.employee_id] || 'Unknown') + '</b></div>' +
      (notes.length ? '<div class="drawer-kv"><span>Notes</span><b>' + notes.map(esc).join(' · ') + '</b></div>' : '') +
    '</div>' +
    '<div class="drawer-section"><h4>Items</h4>' +
      g.items.map((r) => '<div class="payment-line">' +
        '<div><b>' + esc(r.products?.item_name || r.sku) + '</b> <span class="muted">' + esc(r.sku) + '</span></div>' +
        '<div class="muted" style="font-size:12px;margin-top:2px;">' + r.qty + ' × ' + money(r.unit_price) + ' = <b style="color:var(--ink);">' + money(Number(r.unit_price || 0) * r.qty) + '</b></div>' +
        (canEditAmount ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="edit-item" data-id="' + r.id + '">Edit</button></div>' : '') +
      '</div>').join('') +
    '</div>' +
    '<div class="drawer-section"><h4>Payment</h4>' +
      '<div class="drawer-kv"><span>Subtotal</span><b>' + money(subtotal) + '</b></div>' +
      '<div class="drawer-kv"><span>Paid</span><b>' + money(paid) + '</b></div>' +
      '<div class="drawer-kv"><span>' + (balance > 0 ? 'Balance Due' : 'Change Due') + '</span><b style="color:' + (balance > 0 ? '#b23c3c' : (balance < 0 ? '#2e7d4f' : 'inherit')) + ';">' + money(Math.abs(balance)) + '</b></div>' +
      '<div style="margin-top:8px;">' +
        (payments.length ? payments.map((p) => '<div class="payment-line">' +
          '<div>' + money(p.amount) + ' · ' + esc(p.payment_method) +
            (p.payment_method === 'COD' ? (p.payment_status === 'Pending Collection' ? ' <span class="badge pending">Pending Collection</span>' : ' <span class="badge ok">Collected</span>') : '') +
          '</div>' +
          (p.reference_number ? '<div class="muted" style="font-size:10px;margin-top:2px;">Receipt/Txn #' + esc(p.reference_number) + '</div>' : '') +
          // Mark Collected is a status change, not an amount edit -- canEditSale, not
          // the narrower canEditAmount (Ren's spec 186/191).
          (p.payment_method === 'COD' && p.payment_status === 'Pending Collection' && canEditSale
            ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="mark-cod-collected" data-id="' + p.id + '">Mark Collected</button></div>' : '') +
        '</div>').join('') : '<p class="muted" style="margin:0;">No payment recorded.</p>') +
      '</div>' +
      (canEditAmount ? '<div style="margin-top:8px;"><button type="button" class="btn small secondary" data-act="edit-payment">Edit Payment</button></div>' : '') +
    '</div>' +
    '<div class="drawer-section"><h4>Actions</h4>' +
      '<button type="button" class="btn small secondary" data-act="print">Print Receipt</button> ' +
      (canEditSale ? '<button type="button" class="btn small secondary" data-act="delete-sale">Delete Sale</button>' : '') +
    '</div>';
  }

  // Edit forms rendered INSIDE the drawer body (spec 279) -- Save returns to the
  // refreshed details, Cancel to the unchanged details.
  function editItemFormHtml(r) {
    return '<form id="pos-edit-item-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
      '<div class="drawer-section"><h4>Line Item</h4>' +
        '<div class="field"><label>SKU</label><input type="text" name="sku" value="' + esc(r.sku) + '"></div>' +
        '<div class="field"><label>Qty</label><input type="number" name="qty" min="1" value="' + r.qty + '"></div>' +
        '<div class="field"><label>Unit Price</label><input type="number" name="unitPrice" step="0.01" min="0" value="' + (r.unit_price ?? '') + '"></div>' +
      '</div>' +
      '<div class="drawer-section"><h4>Sale</h4>' +
        '<div class="field"><label>Customer Name</label><input type="text" name="customerName" value="' + esc(r.customer_name || '') + '"></div>' +
        '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber" value="' + esc(r.contact_number || '') + '"></div>' +
        '<div class="field"><label>Order / Ref No.</label><input type="text" name="orderNumber" value="' + esc(r.order_number || '') + '"></div>' +
        '<div class="field"><label>Notes</label><input type="text" name="notes" value="' + esc(r.notes || '') + '"></div>' +
        // Reason required when Amount or Qty actually changes (Ren's spec 126) --
        // enforced again server-side by update_pos_sale_item() regardless.
        '<div class="field"><label>Reason (required if amount/qty changes)</label><input type="text" name="reason"></div>' +
      '</div>' +
      '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn" type="submit">Save Changes</button>' +
        '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
      '</div>' +
    '</form>';
  }
  function editPaymentFormHtml(g) {
    const existing = posPaymentsByGroup[g.groupId] || [];
    return '<form id="pos-edit-payment-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
      '<div class="drawer-section"><h4>Payment Split</h4>' +
        paymentSlotsHtml('editPay', existing.map((p) => ({ method: p.payment_method, amount: p.amount, reference: p.reference_number }))) +
        '<div class="field"><label>Reason *</label><input type="text" name="paymentReason" required></div>' +
      '</div>' +
      '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn" type="submit">Save Payment</button>' +
        '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
      '</div>' +
    '</form>';
  }

  // Simple print-friendly receipt in its own window (spec 275: [View Receipt] [Print]).
  function printReceipt(g) {
    const first = g.items[0];
    const payments = posPaymentsByGroup[g.groupId] || [];
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>' +
      '<style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;max-width:360px;margin:20px auto;color:#222}h2{font-size:16px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{padding:4px 0;text-align:left;font-size:12px}th{border-bottom:1px solid #999}.r{text-align:right}.tot td{border-top:1px solid #999;font-weight:bold}.muted{color:#666;font-size:11px}</style></head><body>' +
      '<h2>Kittymae Jewels</h2><div class="muted">' + esc(branchName(first.branch_id)) + '</div>' +
      '<div class="muted">' + fmtDateTime(first.sale_date) + (first.order_number ? ' · Order #' + esc(first.order_number) : '') + '</div>' +
      (first.customer_name ? '<div>Customer: ' + esc(first.customer_name) + '</div>' : '') +
      '<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>' +
      g.items.map((r) => '<tr><td>' + esc(r.products?.item_name || r.sku) + '<div class="muted">' + esc(r.sku) + ' · ' + money(r.unit_price) + '</div></td><td class="r">' + r.qty + '</td><td class="r">' + money(Number(r.unit_price || 0) * r.qty) + '</td></tr>').join('') +
      '<tr class="tot"><td colspan="2">Total</td><td class="r">' + money(groupSubtotal(g)) + '</td></tr>' +
      '</tbody></table>' +
      (payments.length ? '<div><b>Payment</b></div>' + payments.map((p) => '<div>' + esc(p.payment_method) + ' — ' + money(p.amount) + (p.reference_number ? ' <span class="muted">(' + esc(p.reference_number) + ')</span>' : '') + (p.payment_method === 'COD' && p.payment_status === 'Pending Collection' ? ' <span class="muted">(pending collection)</span>' : '') + '</div>').join('') : '') +
      '<div class="muted" style="margin-top:12px;">Processed by ' + esc(employeeNameById[first.employee_id] || '—') + '</div>' +
      '<script>window.onload=function(){window.print();}<\/script></body></html>';
    const w = window.open('', '_blank');
    if (!w) { toast(msgId, 'Allow pop-ups to print the receipt.', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  function wireDetailBody(container, g) {
    container.querySelector('[data-act="print"]')?.addEventListener('click', () => printReceipt(g));

    container.querySelector('[data-act="delete-sale"]')?.addEventListener('click', async () => {
      if (!confirm('Delete this whole sale? All its items go back to Available stock and this cannot be undone.')) return;
      try { await deletePosSale(g.groupId); toast(msgId, 'Sale deleted.', false); closeDetailDrawer(); await load(); }
      catch (err) { toast(msgId, String(err.message || err), true); }
    });

    container.querySelectorAll('[data-act="mark-cod-collected"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Mark this COD payment as collected?')) return;
      try { await markCodCollected(Number(btn.dataset.id)); toast(msgId, 'COD payment marked collected.', false); await load(); refreshDetailIfOpen(g.groupId); }
      catch (err) { toast(msgId, String(err.message || err), true); }
    }));

    container.querySelectorAll('[data-act="edit-item"]').forEach((btn) => btn.addEventListener('click', () => {
      const r = g.items.find((x) => x.id === Number(btn.dataset.id));
      if (!r) return;
      container.innerHTML = editItemFormHtml(r);
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', () => openDetail(g.groupId));
      container.querySelector('#pos-edit-item-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const sku = f.sku.value.trim();
        const qty = Number(f.qty.value);
        const unitPrice = f.unitPrice.value ? Number(f.unitPrice.value) : null;
        const reason = f.reason.value.trim();
        if (!sku || !qty || qty <= 0) {
          toast(msgId, 'SKU and a positive Qty are required.', true);
          flagInvalid(!sku ? f.sku : f.qty);
          return;
        }
        const amountChanged = Number(r.unit_price) !== Number(unitPrice) || Number(r.qty) !== qty;
        if (amountChanged && !reason) {
          toast(msgId, 'A reason is required when changing the amount or quantity.', true);
          flagInvalid(f.reason);
          return;
        }
        // Plain confirm() shows raw text -- no esc() here.
        if (amountChanged && !confirm('Confirm amount change?\n\nOld Amount: ' + money(r.unit_price) + '\nNew Amount: ' + money(unitPrice) +
          '\nDifference: ' + money(Number(unitPrice || 0) - Number(r.unit_price || 0)) + '\n\nReason: ' + reason)) return;
        const save = f.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          await updatePosSaleItem({ movementId: r.id, sku, qty, unitPrice, customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(), orderNumber: f.orderNumber.value.trim(), notes: f.notes.value.trim(), reason });
          toast(msgId, 'Sale item updated.', false);
          await load();
          refreshDetailIfOpen(g.groupId);
        } catch (err) {
          toast(msgId, String(err.message || err), true);
          save.disabled = false;
        }
      });
    }));

    container.querySelector('[data-act="edit-payment"]')?.addEventListener('click', () => {
      container.innerHTML = editPaymentFormHtml(g);
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', () => openDetail(g.groupId));
      // Changing the method moves the amount off the old column and onto the new one
      // in one call (update_pos_sale_payments replaces the whole split) -- Ren's spec 33.
      container.querySelector('#pos-edit-payment-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const payments = readPaymentSlots(f, 'editPay');
        if (!payments.length) { toast(msgId, 'At least one payment method and amount is required.', true); return; }
        const reason = f.paymentReason.value.trim();
        if (!reason) { toast(msgId, 'A reason is required to change a sale\'s payment method.', true); return; }
        const oldSummary = (posPaymentsByGroup[g.groupId] || []).map((p) => p.payment_method + ' ' + money(p.amount)).join(', ') || '—';
        const newSummary = payments.map((p) => p.method + ' ' + money(p.amount)).join(', ');
        if (!confirm('Confirm payment method change?\n\nOld: ' + oldSummary + '\nNew: ' + newSummary + '\n\nReason: ' + reason)) return;
        const save = f.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          await updatePosSalePayments(g.groupId, payments, reason);
          toast(msgId, 'Payment updated.', false);
          await load();
          refreshDetailIfOpen(g.groupId);
        } catch (err) {
          toast(msgId, String(err.message || err), true);
          save.disabled = false;
        }
      });
    });
  }

  document.getElementById('pos-f-search').addEventListener('input', render);
  document.getElementById('pos-f-from').addEventListener('change', render);
  document.getElementById('pos-f-to').addEventListener('change', render);
  document.getElementById('pos-f-zero').addEventListener('change', render);
  document.getElementById('pos-f-clear').addEventListener('click', () => {
    document.getElementById('pos-f-search').value = '';
    document.getElementById('pos-f-from').value = '';
    document.getElementById('pos-f-to').value = '';
    document.getElementById('pos-f-zero').checked = false;
    render();
  });
  wireSortControl('pos-sort-field', 'pos-sort-dir', sort, render);

  const unsubscribe = subscribeToChanges(['sales_inventory_movements', 'sale_payments'], load);
  await load();

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec
  // 321) can open a sale's own Detail Drawer in place. Takes the sale_group_id.
  return { reload: load, unsubscribe, openDetail };
}
