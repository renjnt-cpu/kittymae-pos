// POS Walk In & COD tab (Branches page) -- standalone module scoped to whichever branch is selected on the host page
// (getBranchId()). Upgraded 2026-10-07 (Ren's Branches spec, Phase 5) on the same records as before -- nothing was rebuilt:
//   * the summary tiles (Sales, Gross, Discounts, Net, Items Sold, Average Sale, Cash / GCash / Bank Transfer / Terminal-Card / Other,
//     Refunds, Voids) come from the server (pos_ops_report) for the global date range, so they never depend on how many rows were loaded;
//   * New Sale: date AND time, customer type (Walk-In / COD / Existing Customer, with the same "pick the customer instead of retyping"
//     helper the other tabs use), a discount per line, stock shown per line, split payments (the shared payment rows) and a live
//     Subtotal / Discount / Total Due / Total Paid / Change Due / Remaining Balance panel. The database checks every payment rule again:
//     only known methods, a reference number for GCash / Maya / Bank Transfer / Terminal, change only on cash, and a sale that is not
//     fully paid is refused unless the person chose COD for the rest or "the customer pays the balance later" (a credit sale -- its
//     balance is then collected with Add Payment, with a date and a reference);
//   * after saving, a summary with Print Receipt / View Sale / Add Another Sale;
//   * a sale can no longer be deleted in one step: Request Void (the sale was cancelled) / Request Delete (it never should have been
//     entered) go to a supervisor and then Admin (the same chain Scrap and Subasta use; Admin can do it in one step). The request keeps a
//     snapshot of the sale -- see "Voided & deleted sales". Refunds are requested from the sale and go to the existing Refund Management;
//   * every edit asks for a reason and the kind of mistake (the audit trail + employee error analytics), and the drawer shows the sale's
//     History.
// The drawer pattern, filters and cards are the ones Layaway, Scrap and Subasta already use.
import {
  searchProducts, listActiveEmployees, createPosSale, listSales, listSalePayments, getPosSaleGroup, getPosOpsReport,
  updatePosSaleItem, updatePosSalePayments, addPosSalePayment, markCodCollected, markSalePickedUp, listPosSaleChangeLog, listPosSaleRemovals,
  listRefundReasons, listRefundsForOrder, createRefundRequest, logBranchErrorCorrection,
  listBranchAuditLog, listBranchRecordRequests, requestBranchRecordAction, approveBranchRecordStage1, approveBranchRecordFinal,
  rejectBranchRecordAction, cancelBranchRecordAction, adminApplyBranchRecordAction, subscribeToChanges, LEDGER_ROW_CAP,
} from './api.js?v=20261011b';
import { branchColor } from './branchColors.js?v=20261011b';
import { POS_PAYMENT_METHODS, POS_REF_REQUIRED, POS_CASH_METHODS, posMethodLabel } from './paymentMethods.js?v=20261011b';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, flagInvalid } from './uiKit.js?v=20261011b';
import { manilaDateStr, manilaToday } from './opsDates.js?v=20261011b';
import { confirmDialog, reasonDialog, ERROR_TYPES } from './dialogs.js?v=20261011b';
import { pageSlice, pagerHtml, wirePager } from './pager.js?v=20261011b';
import { approvalCardHtml, setApprovalFolder } from './approvalUi.js?v=20261011b';
import { attachCustomerPicker } from './customerPicker.js?v=20261011b';
import { paymentRowsHtml, mountPaymentRows } from './paymentRows.js?v=20261011b';
import { friendlyError } from './shell.js?v=20261011b';

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

const num = (v) => Number(v || 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => n === null || n === undefined ? '—' : (Number(n) < 0 ? '−₱' : '₱') + Math.abs(Number(n)).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const manilaHM = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false });
const lineNet = (r) => r2(num(r.unit_price) * r.qty - num(r.discount));
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

const CUSTOMER_TYPES = ['Walk-In', 'COD', 'Existing Customer'];
const SHOW_FILTERS = [['all', 'All sales'], ['balance', 'Balance still owed'], ['cod', 'COD waiting to be collected'], ['pickup', 'Waiting for pickup'],
  ['discounted', 'With a discount'], ['zero', 'Has a ₱0 line']];
const POS_ERROR_TYPES = ERROR_TYPES.filter((t) => t !== 'Incorrect Layaway Item'); // a layaway-only kind of mistake
const REFUND_METHODS = ['Original Payment Method', 'Cash', 'GCash', 'Maya', 'Bank Transfer', 'BDO', 'BPI', 'GoTyme', 'Maribank', 'Union Bank', 'Credit Card Reversal', 'Other'];
const ERP_REFUNDS_URL = 'https://renjnt-cpu.github.io/kittymae-inventory-system/refunds.html';
const chip = (text, tone) => '<span class="badge st-' + tone + '">' + text + '</span>';

/** Mounts the POS tab into `root` (an empty container this owns entirely), scoped to
 * `getBranchId()` at call time. `esc`/`toast` are the page's own shell.js helpers;
 * `msgId` is the page's toast container id; `employee` is the signed-in employee
 * record; `branches` is the page's active-branch list. Returns
 * { reload, unsubscribe, openDetail, openDetailAsync, applyView }. `getRange()` is the page's global date
 * range -- this tab's own From/To are driven by it. */
export async function initPosTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate, getRange, requestRange }) {
  const isAdmin = employee.role === 'Admin';
  const isScoped = employee.role === 'Branch Supervisor';
  const isSupervisorUp = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || (employee.position || '').toLowerCase().includes('supervisor');
  // Editing a completed POS sale's COD / pickup status (mark_cod_collected / mark_sale_picked_up enforce this same gate server-side) -- Ren,
  // 2026-09-16/17: Admin/Manager/Branch Supervisor role, or the Branch Team Leader position.
  const canEditSale = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || employee.position === 'Branch Team Leader';
  // Correcting an already-recorded amount (Unit Price, Qty, Discount, or the payment split) is narrower (Ren's spec 121-132) -- mirrors
  // is_amount_editor() exactly. Editor and Branch Team Leader added 2026-09-22 per Ren.
  // 'Manager' added 2026-10-07 (Ren: "supervisor and manager can edit details of POS and Layaway") -- the database grants transaction.edit_amount to
  // ROLE:Manager since migration 192.
  const canEditAmount = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || ['Auditor', 'Editor', 'Branch Team Leader'].includes(employee.position) ||
    (employee.position || '').includes('Supervisor');
  // Sales Admin Associate (Ren, 2026-10-07): may edit a sale's item / customer details (a reason is logged when an amount, quantity or discount
  // changes) and request a void / delete (a Supervisor or Manager approves, then Admin) -- but not the payment split, which stays with canEditAmount.
  // The database already allowed it (the associate holds transaction.edit_amount); this only shows the Edit button.
  const canEditSaleItem = canEditAmount || employee.position === 'Sales Admin Associate';
  // assert_can_act_on_branch(): who may add a payment / request a void, delete or refund on a branch's sale.
  function canActOnBranch(bid) {
    if (['Admin', 'Manager'].includes(employee.role)) return true;
    if (employee.role === 'None' && ['Sales Admin Associate', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'].includes(employee.position)) return true;
    if (employee.position === 'Auditor') return true;
    return employee.branch_id != null && employee.branch_id === bid;
  }
  // Manila has no walk-in storefront -- a sale there is often paid for online and collected later, so the New Sale form grows a Pickup
  // Address field there (Ren, 2026-09-23). Re-evaluated each time the drawer opens, matching whichever branch is selected on the host page.
  const isManila = () => branches.find((b) => b.id === getBranchId())?.code === 'MANILA';
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
  // sales_inventory_movements only carries employee_id -- resolved to a display name the same way every other admin-attributed list does.
  const employeeNameById = Object.fromEntries((await listActiveEmployees()).map((e) => [e.id, e.full_name]));
  const nameOf = (id) => employeeNameById[id] || 'Unknown';
  const sort = { field: 'sale_date', dir: 'desc' };
  const pg = { page: 1 };
  let allPosSales = [], posPaymentsByGroup = {}, requests = [], removals = [];
  let report = null, reportErr = '', reportSeq = 0, loadSeq = 0;
  let openGroupId = null, detailMode = null; // detailMode: null | 'edit-item' | 'edit-pay' | 'add-pay' | 'refund' -- a form being typed in is never redrawn by a live refresh
  const notify = (text, isError) => toast(msgId, text, isError);

  root.innerHTML =
    // Summary sits right beside + New Sale (Ren, 2026-09-22) -- same button/popover, same ids, just relocated.
    '<div class="module-topbar"><div></div><div style="text-align:right;display:flex;gap:8px;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap;">' +
      '<button type="button" class="btn" id="pos-new-btn">+ New Sale</button>' +
      '<div style="position:relative;">' +
        '<button type="button" class="btn small secondary" id="pos-summary-toggle">Summary ▾</button>' +
        '<div id="pos-summary-panel" class="pos-summary-panel" style="display:none;"></div>' +
      '</div>' +
      '<div id="pos-write-note"></div>' +
    '</div></div>' +
    '<div class="muted" id="pos-caption" style="margin:0 0 6px;font-size:12px;"></div>' +
    '<div class="tiles tiles-compact" id="pos-tiles"><div class="muted">Loading…</div></div>' +
    // From/To drive both the pivot and the ledger; Search only narrows the ledger. Relocates into the Branch page's shared
    // #tab-filters-slot -- id/data-filter-tab are what that relocation and showSubTab()'s show/hide target.
    '<div class="card" id="pos-filter-card" data-filter-tab="pos">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:200px;"><label>Search</label><input type="text" id="pos-f-search" placeholder="SKU, item, customer, order, reference, admin…"></div>' +
        '<div class="field"><label>Show</label><select id="pos-f-show">' + SHOW_FILTERS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Payment Method</label><select id="pos-f-method"><option value="all">All</option>' +
          POS_PAYMENT_METHODS.map((m) => '<option value="' + m + '">' + esc(posMethodLabel(m)) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Admin</label><select id="pos-f-admin"><option value="all">All</option></select></div>' +
        // From/To are driven by the page's global date range, so they are kept in the DOM (the range handler reads them) but not shown.
        '<div class="field range-managed"><label>From</label><input type="date" id="pos-f-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="pos-f-to"></div>' +
        sortControlHtml(POS_SORT_FIELDS, sort, 'pos-sort-field', 'pos-sort-dir') +
        '<button type="button" class="btn small secondary" id="pos-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="pos-active"></div>' +
    '<h3 style="margin-top:0;">Sales by Admin &amp; Payment Method <span class="muted" style="font-weight:normal;font-size:12px;">— reflects the selected date range, all admins for this branch</span></h3>' +
    '<div id="pos-by-admin" style="margin-bottom:20px;"><div class="muted">Loading…</div></div>' +
    '<h3 style="margin-top:6px;">Sales Transactions <span class="muted" id="pos-range-note" style="font-weight:normal;font-size:12px;"></span></h3>' +
    '<div id="pos-list"><div class="muted">Loading…</div></div>' +
    // Void / delete requests: collapsed while empty, opened and highlighted while something waits. Refunds live in Refund Management.
    '<h3 style="margin:18px 0 6px;">Approvals</h3>' +
    '<details class="card exp lw-approval" id="pos-requests-folder">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Sale Void &amp; Delete Requests <span class="exp-count" id="pos-requests-count"></span></summary>' +
      '<div class="exp-body" id="pos-requests-list"><div class="muted">Loading…</div></div>' +
    '</details>' +
    '<details class="card exp" id="pos-removals-folder" style="margin-top:8px;">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Voided &amp; deleted sales <span class="exp-count" id="pos-removals-count"></span></summary>' +
      '<div class="exp-body" id="pos-removals-list"><div class="muted">Loading…</div></div>' +
    '</details>' +

    // ---- Form Drawer: New Sale (product search + cart + checkout), then the saved sale's summary ----
    '<div class="drawer-backdrop" id="pos-form-backdrop"></div>' +
    '<div class="drawer drawer-wide" id="pos-form-drawer">' +
      '<div class="drawer-header"><div><h3 id="pos-form-title">New Sale</h3><div class="muted" id="pos-form-branch"></div></div><button type="button" class="drawer-close" id="pos-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<div id="pos-order-msg"></div>' +
        '<div id="pos-done" hidden></div>' +
        '<div id="pos-form-wrap">' +
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
          '<form id="pos-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
            '<div class="msg error" id="pos-form-err" role="alert" hidden></div>' +
            '<div class="drawer-section">' +
              '<h4>Customer</h4>' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                '<div class="field" style="flex:1 1 140px;"><label>Customer Type</label><select name="customerType">' + CUSTOMER_TYPES.map((t) => '<option>' + t + '</option>').join('') + '</select></div>' +
                '<div class="field" style="flex:1 1 140px;"><label>Customer Name</label><input type="text" name="customerName" autocomplete="off"></div>' +
                '<div class="field" style="flex:1 1 140px;"><label>Contact Number</label><input type="text" name="contactNumber" autocomplete="off" inputmode="tel"></div>' +
              '</div>' +
              '<div class="muted" id="pos-type-hint" style="font-size:11px;"></div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                '<div class="field" style="flex:1 1 140px;"><label>Order / Reference No.</label><input type="text" name="orderId"></div>' +
                '<div class="field" style="flex:1 1 130px;"><label>Date</label><input type="date" name="saleDate"></div>' +
                '<div class="field" style="flex:1 1 100px;"><label>Time</label><input type="time" name="saleTime"></div>' +
                '<div class="field" style="flex:2 1 200px;"><label>Notes</label><input type="text" name="notes"></div>' +
                '<div class="field" id="pos-pickup-field" style="flex:2 1 200px;" hidden><label>Pickup Address</label><input type="text" name="pickupAddress" placeholder="Where the customer/courier will pick this up"></div>' +
              '</div>' +
            '</div>' +
            '<div class="drawer-section" id="pos-pay">' +
              '<h4>Payment</h4>' +
              '<div id="pos-pay-rows"></div>' +
              '<div class="field" id="pos-disc-reason-field" hidden><label>Discount reason (optional)</label><input type="text" name="discountReason" placeholder="e.g. loyal customer, bundle, damaged box"></div>' +
              '<div class="card pos-totals" id="pos-totals"></div>' +
              '<div class="pos-balance-box" id="pos-bal-box" hidden></div>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '<div class="drawer-footer" id="pos-form-footer">' +
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

  const $ = (id) => document.getElementById(id);
  $('tab-filters-slot')?.appendChild($('pos-filter-card'));
  // Start on the page's global date range (later changes arrive as 'change' events on these inputs).
  const range0 = getRange ? getRange() : null;
  if (range0) {
    $('pos-f-from').value = range0.preset === 'all' ? '' : range0.from;
    $('pos-f-to').value = range0.preset === 'all' ? '' : range0.to;
  }

  // ---------------------------------------------------------------------------------------------
  // Product search + cart (inside the New Sale drawer)
  // ---------------------------------------------------------------------------------------------
  let posCart = [];
  let catalogResults = [];
  let catalogQuery = '', catalogLine = '', catalogPurity = '', catalogInStockOnly = false;
  let catalogSearchToken = 0, catalogSearchTimer = null;
  const form = $('pos-form');
  const fe = (name) => form.elements[name];
  let pay = null;

  function renderCatalogGrid() {
    const grid = $('pos-cat-grid');
    if (!catalogQuery.trim()) { grid.innerHTML = '<p class="muted">Search a SKU or item name to start.</p>'; return; }
    let rows = catalogResults;
    if (catalogLine) rows = rows.filter((p) => p.product_line === catalogLine);
    if (catalogPurity) rows = rows.filter((p) => p.metal_purity === catalogPurity);
    if (catalogInStockOnly) rows = rows.filter((p) => (p.qty_available || 0) > 0);
    if (!rows.length) { grid.innerHTML = '<p class="muted">No matching SKUs for this search/filter.</p>'; return; }
    // Fewest pieces at THIS branch first, so a thin count is never buried below a search's more-stocked results.
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
        // Branch named + colored, since a stock count means nothing without knowing which branch it's counting.
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
    else posCart.push({ sku: product.sku, itemName: product.item_name, variant: product.sub_sku || product.metal_purity || '', qty: 1, unitPrice: effectivePrice(product) ?? null, discount: 0, stock: product.qty_available ?? null });
    renderCart();
    refreshOrder();
  }
  const cartLineGross = (it) => r2(num(it.unitPrice) * num(it.qty));
  function renderCart() {
    const box = $('pos-cart-lines');
    if (!posCart.length) {
      box.innerHTML = '<p class="muted" style="font-size:12px;">No items yet — tap a product above to add it.</p>';
      return;
    }
    box.innerHTML = posCart.map((it, i) =>
      '<div class="pos-cart-line" data-i="' + i + '">' +
        '<div style="flex:1;min-width:140px;">' +
          '<div class="pos-cart-line-name">' + esc(it.itemName) + '</div>' +
          '<div class="pos-cart-line-sku">' + esc(it.sku) + (it.variant ? ' · ' + esc(it.variant) : '') + '</div>' +
          '<div class="pos-cart-line-stock" data-stock></div>' +
        '</div>' +
        // Visible labels, not just title/aria-label -- those only surface as a hover tooltip, which doesn't exist on a touchscreen.
        '<div class="pos-cart-line-field"><label>Qty</label><input type="number" class="pos-cart-line-qty" min="1" step="1" value="' + it.qty + '" aria-label="Qty"></div>' +
        '<div class="pos-cart-line-field"><label>Price</label><input type="number" class="pos-cart-line-price" step="0.01" min="0" value="' + (it.unitPrice ?? '') + '" placeholder="PHP" aria-label="Unit Price"></div>' +
        '<div class="pos-cart-line-field"><label>Discount ₱</label><input type="number" class="pos-cart-line-disc" step="0.01" min="0" value="' + (it.discount || '') + '" placeholder="0" aria-label="Discount in pesos"></div>' +
        '<div class="pos-cart-line-field"><label>Line total</label><b class="pos-cart-line-total" data-total></b></div>' +
        '<button type="button" class="pos-cart-remove" title="Remove" aria-label="Remove">✕</button>' +
      '</div>').join('');
    box.querySelectorAll('.pos-cart-line').forEach((line) => {
      const i = Number(line.dataset.i);
      line.querySelector('.pos-cart-line-qty').addEventListener('input', (ev) => { posCart[i].qty = Number(ev.target.value || 0); refreshOrder(); });
      line.querySelector('.pos-cart-line-price').addEventListener('input', (ev) => { posCart[i].unitPrice = ev.target.value === '' ? null : Number(ev.target.value); refreshOrder(); });
      line.querySelector('.pos-cart-line-disc').addEventListener('input', (ev) => { posCart[i].discount = Number(ev.target.value || 0); refreshOrder(); });
      line.querySelector('.pos-cart-remove').addEventListener('click', () => { posCart.splice(i, 1); renderCart(); refreshOrder(); });
    });
    paintCartLines();
  }
  // Line totals + stock notes, redrawn on every keystroke without rebuilding the inputs (rebuilding would drop focus).
  function paintCartLines() {
    document.querySelectorAll('#pos-cart-lines .pos-cart-line').forEach((line) => {
      const it = posCart[Number(line.dataset.i)];
      if (!it) return;
      const gross = cartLineGross(it), disc = num(it.discount);
      const tot = line.querySelector('[data-total]');
      tot.textContent = money(Math.max(gross - disc, 0));
      tot.style.color = disc > gross + 0.005 ? '#b23c3c' : '';
      const st = line.querySelector('[data-stock]');
      if (it.stock == null) { st.textContent = ''; return; }
      const over = num(it.qty) > it.stock;
      st.textContent = it.stock <= 0 ? 'Out of stock here' : (over ? 'Only ' + it.stock + ' in stock here' : it.stock + ' in stock here');
      st.className = 'pos-cart-line-stock' + (it.stock <= 0 || over ? ' low' : '');
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
  $('pos-cat-search').addEventListener('input', (ev) => {
    catalogQuery = ev.target.value;
    clearTimeout(catalogSearchTimer);
    if (!catalogQuery.trim()) { catalogResults = []; renderCatalogGrid(); return; }
    catalogSearchTimer = setTimeout(runCatalogSearch, 200);
  });
  $('pos-cat-line').addEventListener('change', (ev) => { catalogLine = ev.target.value; renderCatalogGrid(); });
  $('pos-cat-purity').addEventListener('change', (ev) => { catalogPurity = ev.target.value; renderCatalogGrid(); });
  $('pos-cat-instock').addEventListener('change', (ev) => { catalogInStockOnly = ev.target.checked; renderCatalogGrid(); });
  $('pos-cat-more-toggle').addEventListener('click', () => {
    const more = $('pos-cat-more');
    more.style.display = more.style.display === 'none' ? '' : 'none';
  });

  // ---------------------------------------------------------------------------------------------
  // Order totals and payment (mirrors _pos_apply_payments() in the database, which checks it all again)
  // ---------------------------------------------------------------------------------------------
  const cartItems = () => posCart.filter((it) => it.sku && num(it.qty) > 0).map((it) => ({ sku: it.sku, qty: it.qty, unitPrice: it.unitPrice, discount: num(it.discount), discountReason: '' }));
  const orderTotals = () => {
    const items = cartItems();
    const gross = r2(items.reduce((s, it) => s + num(it.unitPrice) * it.qty, 0));
    const disc = r2(items.reduce((s, it) => s + num(it.discount), 0));
    return { gross, disc, due: r2(gross - disc) };
  };
  /** What the typed payment rows come to: handed over, kept, change, still owed -- before the database's own check. */
  function paymentFigures(due) {
    const lines = pay ? pay.peek() : [];
    const cash = lines.filter((p) => POS_CASH_METHODS.includes(p.method)).reduce((s, p) => s + p.amount, 0);
    const nonCash = lines.filter((p) => !POS_CASH_METHODS.includes(p.method)).reduce((s, p) => s + p.amount, 0);
    const cashKept = Math.min(cash, Math.max(due - nonCash, 0));
    const kept = r2(nonCash + cashKept);
    return { cash, nonCash, handed: r2(cash + nonCash), kept, change: r2(Math.max(cash - cashKept, 0)), remaining: r2(Math.max(due - kept, 0)), tooMuchNonCash: nonCash > due + 0.005, lines };
  }
  const isCodType = () => fe('customerType').value === 'COD';

  function renderTotals() {
    const { gross, disc, due } = orderTotals();
    const f = paymentFigures(due);
    const codAuto = isCodType() && f.remaining > 0.005;
    $('pos-totals').innerHTML =
      '<div><span class="muted">Subtotal</span><b>' + money(gross) + '</b></div>' +
      '<div><span class="muted">Discount</span><b' + (disc > 0 ? ' style="color:#a15c00;"' : '') + '>' + (disc > 0 ? '− ' : '') + money(disc) + '</b></div>' +
      '<div class="pos-tot-due"><span class="muted">Total Due</span><b>' + money(due) + '</b></div>' +
      '<div><span class="muted">Total Paid</span><b>' + money(f.handed) + '</b></div>' +
      '<div><span class="muted">Change Due</span><b style="color:' + (f.change > 0 ? '#2e7d4f' : 'inherit') + ';">' + money(f.change) + '</b></div>' +
      '<div><span class="muted">Remaining Balance</span><b style="color:' + (f.remaining > 0.005 ? '#b23c3c' : 'inherit') + ';">' + money(codAuto ? 0 : f.remaining) + '</b></div>';
    $('pos-disc-reason-field').hidden = !(disc > 0);
    // The balance workflow: a sale that is not fully paid is only completed once the rest has a plan.
    const box = $('pos-bal-box');
    const remaining = codAuto ? 0 : f.remaining;
    if (f.tooMuchNonCash) {
      box.hidden = false;
      box.innerHTML = '<b>The non-cash payments are more than the amount due.</b> Change can only be given on cash — lower the ' + esc(f.lines.filter((p) => !POS_CASH_METHODS.includes(p.method)).map((p) => posMethodLabel(p.method)).join(' / ')) + ' amount.';
    } else if (remaining > 0.005 && due > 0) {
      const had = box.querySelector('#pos-allow-balance');
      const checked = had ? had.checked : false;
      box.hidden = false;
      box.innerHTML = '<div><b>' + money(remaining) + ' is still unpaid.</b> Choose how it will be collected:</div>' +
        '<div class="pos-bal-actions"><button type="button" class="btn small secondary" id="pos-bal-cod">Collect ' + money(remaining) + ' on delivery (COD)</button></div>' +
        '<label class="pos-check"><input type="checkbox" id="pos-allow-balance"' + (checked ? ' checked' : '') + '> The customer will pay the balance later (credit). Needs their name and contact number.</label>';
      $('pos-bal-cod').addEventListener('click', () => { if (pay.addLine({ method: 'COD', amount: remaining })) refreshOrder(); else notify('All payment rows are in use — change one of them to COD.', true); });
    } else if (codAuto) {
      box.hidden = false;
      box.innerHTML = '<b>COD:</b> ' + money(f.remaining) + ' will be collected on delivery (added as a COD payment when you complete the sale).';
    } else {
      box.hidden = true; box.innerHTML = '';
    }
    paintCartLines();
  }
  /** Something about the order changed (items, prices, discounts): the first payment row follows the new total, then totals are redrawn. */
  function refreshOrder() {
    if (!pay) return;
    pay.sync(); // redraws through onChange -> renderTotals()
  }
  function syncTypeHint() {
    const t = fe('customerType').value;
    $('pos-type-hint').textContent = t === 'COD'
      ? 'COD needs the customer name and contact number. Whatever is not paid now is collected on delivery.'
      : (t === 'Existing Customer' ? 'Type the name or number to pick a customer already on file — it keeps the same person spelled the same way everywhere.' : '');
  }
  fe('customerType').addEventListener('change', () => { syncTypeHint(); renderTotals(); });
  attachCustomerPicker({ nameInput: fe('customerName'), contactInput: fe('contactNumber'), onPick: () => { fe('customerType').value = 'Existing Customer'; syncTypeHint(); renderTotals(); } });

  $('pos-pay-rows').innerHTML = paymentRowsHtml({ recorder: employee.full_name || 'you', methods: POS_PAYMENT_METHODS, proof: false, dates: false, labelOf: posMethodLabel });
  pay = mountPaymentRows($('pos-pay-rows'), {
    getDue: () => orderTotals().due, dueLabel: 'Total due', emptyText: '', followDue: true, allowOver: true,
    refRequired: (m) => POS_REF_REQUIRED.includes(m), onChange: () => { if (pay) renderTotals(); },
  });
  renderCart();
  renderTotals();

  // ---------------------------------------------------------------------------------------------
  // Drawers
  // ---------------------------------------------------------------------------------------------
  function showFormError(message, el) {
    const box = $('pos-form-err');
    box.textContent = friendlyError(message); box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (el) flagInvalid(el);
  }
  function resetForm() {
    form.reset();
    $('pos-form-err').hidden = true;
    fe('saleDate').value = manilaToday(); fe('saleDate').max = manilaToday();
    fe('saleTime').value = manilaHM();
    $('pos-pickup-field').hidden = !isManila();
    posCart = [];
    pay.reset();
    renderCart(); syncTypeHint(); refreshOrder();
  }
  function setFormMode(mode) { // 'form' | 'done'
    $('pos-form-wrap').hidden = mode !== 'form';
    $('pos-done').hidden = mode !== 'done';
    $('pos-form-footer').hidden = mode !== 'form';
    $('pos-form-title').textContent = mode === 'done' ? 'Sale Completed' : 'New Sale';
  }
  function openFormDrawer() {
    $('pos-form-branch').textContent = branchName(getBranchId());
    $('pos-order-msg').innerHTML = '';
    if (!posCart.length || !$('pos-done').hidden) resetForm();
    else { fe('saleDate').max = manilaToday(); $('pos-pickup-field').hidden = !isManila(); }
    setFormMode('form');
    $('pos-form-backdrop').classList.add('open');
    $('pos-form-drawer').classList.add('open');
    setTimeout(() => $('pos-cat-search').focus(), 250);
  }
  function closeFormDrawer() {
    $('pos-form-backdrop').classList.remove('open');
    $('pos-form-drawer').classList.remove('open');
  }
  $('pos-new-btn').addEventListener('click', openFormDrawer);
  $('pos-form-close').addEventListener('click', closeFormDrawer);
  $('pos-form-cancel').addEventListener('click', closeFormDrawer);
  $('pos-form-backdrop').addEventListener('click', closeFormDrawer);

  function closeDetailDrawer() {
    $('pos-detail-backdrop').classList.remove('open');
    $('pos-detail-drawer').classList.remove('open');
    openGroupId = null; detailMode = null;
  }
  $('pos-detail-close').addEventListener('click', closeDetailDrawer);
  $('pos-detail-backdrop').addEventListener('click', closeDetailDrawer);

  const groupById = (id) => groupPosSales(allPosSales).find((x) => String(x.groupId) === String(id));
  function openDetail(groupId) {
    const g = groupById(groupId);
    if (!g) return false; // not in the loaded range -- openDetailAsync() can fetch it
    openGroupId = g.groupId; detailMode = null;
    const first = g.items[0];
    // .textContent escapes on its own -- esc() here would double-escape.
    $('pos-detail-title').textContent = 'Sale' + (first.order_number ? ' — Order #' + first.order_number : '');
    $('pos-detail-sub').textContent = branchName(first.branch_id) + ' · ' + fmtDateTime(first.sale_date);
    const body = $('pos-detail-body');
    body.innerHTML = renderDetailBody(g);
    wireDetailBody(body, g);
    loadDetailExtras(g);
    $('pos-detail-backdrop').classList.add('open');
    $('pos-detail-drawer').classList.add('open');
    return true;
  }
  /** Opens a sale even when it is outside the loaded date range (a clicked notification, "View Sale"). false = not found / another branch. */
  async function openDetailAsync(groupId) {
    if (openDetail(groupId)) return true;
    try {
      const { rows, payments } = await getPosSaleGroup(groupId);
      if (!rows.length || rows[0].branch_id !== getBranchId()) return false;
      allPosSales = allPosSales.concat(rows);
      payments.forEach((p) => { (posPaymentsByGroup[p.sale_group_id] || (posPaymentsByGroup[p.sale_group_id] = [])).push(p); });
      return openDetail(groupId);
    } catch (err) { return false; }
  }
  function refreshDetailIfOpen() {
    if (!openGroupId || !$('pos-detail-drawer').classList.contains('open') || detailMode) return;
    if (!allPosSales.some((r) => String(r.sale_group_id) === String(openGroupId))) { closeDetailDrawer(); return; }
    openDetail(openGroupId);
  }

  // ---------------------------------------------------------------------------------------------
  // Complete Sale
  // ---------------------------------------------------------------------------------------------
  function saleWhen() {
    const d = fe('saleDate').value || manilaToday();
    const t = fe('saleTime').value || manilaHM();
    const when = new Date(d + 'T' + t + ':00+08:00');
    if (Number.isNaN(when.getTime())) return { error: 'Enter a valid sale date and time.', el: fe('saleDate') };
    if (when.getTime() > Date.now() + 10 * 60000) return { error: 'The sale date and time cannot be in the future.', el: fe('saleDate') };
    return { iso: when.toISOString() };
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('pos-form-err').hidden = true;
    const btn = $('pos-complete-btn');
    const items = cartItems();
    if (!items.length) return void showFormError('Add at least one item to sell.', $('pos-cat-search'));
    for (const it of items) {
      const idx = posCart.findIndex((c) => c.sku === it.sku);
      const qtyEl = () => document.querySelector('.pos-cart-line[data-i="' + idx + '"] .pos-cart-line-qty');
      const priceEl = () => document.querySelector('.pos-cart-line[data-i="' + idx + '"] .pos-cart-line-price');
      const discEl = () => document.querySelector('.pos-cart-line[data-i="' + idx + '"] .pos-cart-line-disc');
      if (!Number.isInteger(it.qty) || it.qty <= 0) return void showFormError('Qty must be a whole number of 1 or more for ' + it.sku + '.', qtyEl());
      if (it.unitPrice == null || it.unitPrice < 0) return void showFormError('Enter a price for ' + it.sku + '.', priceEl());
      if (it.discount < 0) return void showFormError('The discount on ' + it.sku + ' cannot be negative.', discEl());
      if (it.discount > it.qty * it.unitPrice + 0.005) return void showFormError('The discount on ' + it.sku + ' is more than its line total.', discEl());
    }
    const when = saleWhen();
    if (when.error) return void showFormError(when.error, when.el);
    const type = fe('customerType').value;
    const name = fe('customerName').value.trim(), contact = fe('contactNumber').value.trim();
    if (type === 'COD' && (!name || !contact)) return void showFormError('A COD sale needs the customer name and contact number.', !name ? fe('customerName') : fe('contactNumber'));
    if (type === 'Existing Customer' && !name) return void showFormError('Pick the existing customer (or type the name).', fe('customerName'));
    const read = pay.read();
    if (read.error) return void showFormError(read.error, read.el);
    const { due, disc } = { ...orderTotals() };
    const f = paymentFigures(due);
    if (f.tooMuchNonCash) return void showFormError('The non-cash payments are more than the amount due. Change can only be given on cash.', document.querySelector('#pos-pay-rows [data-pr-row] [data-f="amount"]'));
    let payments = read.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference }));
    let remaining = f.remaining;
    // A COD sale collects whatever is not paid now on delivery -- added here so nobody has to type it.
    if (type === 'COD' && remaining > 0.005) { payments.push({ method: 'COD', amount: remaining }); remaining = 0; }
    const allowBalance = !!document.getElementById('pos-allow-balance')?.checked;
    if (remaining > 0.005 && !allowBalance) {
      return void showFormError('The payment is short by ' + money(remaining) + '. Add a COD payment for the rest, or tick "The customer will pay the balance later".', document.getElementById('pos-allow-balance') || document.querySelector('#pos-pay-rows [data-pr-row] [data-f="amount"]'));
    }
    if (remaining > 0.005 && (!name || !contact)) return void showFormError('To leave a balance, enter the customer name and contact number.', !name ? fe('customerName') : fe('contactNumber'));
    const zero = items.find((it) => it.qty * it.unitPrice - it.discount <= 0);
    if (zero && !await confirmDialog({ title: 'A line is ₱0', message: zero.sku + ' totals ₱0. Complete the sale anyway?', confirmLabel: 'Complete sale' })) return;
    const reasonText = fe('discountReason') ? fe('discountReason').value.trim() : '';
    btn.disabled = true;
    try {
      const groupId = await createPosSale({
        branchId: getBranchId(), items: items.map((it) => ({ ...it, discountReason: it.discount > 0 ? reasonText : '' })),
        customerName: name, contactNumber: contact, orderNumber: fe('orderId').value.trim(), payments, saleDate: when.iso,
        notes: fe('notes').value.trim(), pickupAddress: isManila() ? fe('pickupAddress').value.trim() : '', customerType: type, allowBalance: remaining > 0.005,
      });
      await load();
      showDone(groupId, { due, disc, change: f.change });
      notify('Sale completed — ' + items.length + ' item(s), ' + money(due) + '.', false);
    } catch (err) {
      showFormError(String(err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  // The saved sale's summary: what was rung up, what was paid, the change, and what to do next.
  function showDone(groupId, local) {
    const g = groupById(groupId);
    const box = $('pos-done');
    let h;
    if (g) {
      const first = g.items[0], pays = posPaymentsByGroup[g.groupId] || [];
      const gross = groupGross(g), disc = groupDisc(g), total = groupSubtotal(g), paid = groupPaid(g), bal = r2(total - paid);
      const change = r2(pays.reduce((s, p) => s + (p.tendered != null ? num(p.tendered) - num(p.amount) : 0), 0));
      h = '<div class="pos-done-head"><span class="pos-done-tick" aria-hidden="true">✓</span><div><b>Sale saved</b><div class="muted">' +
          (first.order_number ? 'Order #' + esc(first.order_number) + ' · ' : '') + esc(fmtDateTime(first.sale_date)) + ' · ' + esc(branchName(first.branch_id)) + '</div></div></div>' +
        '<div class="drawer-section"><h4>Summary</h4>' +
          '<div class="drawer-kv"><span>Customer</span><b>' + esc(first.customer_name || '—') + (first.customer_type ? ' <span class="muted">(' + esc(first.customer_type) + ')</span>' : '') + '</b></div>' +
          '<div class="drawer-kv"><span>Items</span><b>' + g.items.reduce((s, r) => s + r.qty, 0) + ' pc' + (g.items.reduce((s, r) => s + r.qty, 0) === 1 ? '' : 's') + '</b></div>' +
          '<div class="drawer-kv"><span>Subtotal</span><b>' + money(gross) + '</b></div>' +
          (disc > 0 ? '<div class="drawer-kv"><span>Discount</span><b>− ' + money(disc) + '</b></div>' : '') +
          '<div class="drawer-kv"><span>Total</span><b>' + money(total) + '</b></div>' +
          '<div class="drawer-kv"><span>Paid</span><b>' + money(paid) + '</b></div>' +
          (change > 0 ? '<div class="drawer-kv"><span>Change given</span><b style="color:#2e7d4f;">' + money(change) + '</b></div>' : '') +
          (bal > 0.5 ? '<div class="drawer-kv"><span>Balance still owed</span><b style="color:#b23c3c;">' + money(bal) + '</b></div>' : '') +
          '<div style="margin-top:6px;">' + pays.map((p) => '<div class="muted" style="font-size:12px;">' + money(p.amount) + ' · ' + esc(posMethodLabel(p.payment_method)) +
            (p.payment_method === 'COD' && p.payment_status === 'Pending Collection' ? ' (to collect on delivery)' : '') + (p.reference_number ? ' · #' + esc(p.reference_number) : '') + '</div>').join('') + '</div>' +
        '</div>';
    } else {
      h = '<div class="pos-done-head"><span class="pos-done-tick" aria-hidden="true">✓</span><div><b>Sale saved</b><div class="muted">Total ' + money(local.due) + '</div></div></div>';
    }
    h += '<div class="pos-done-actions">' +
        '<button type="button" class="btn" data-done="print">Print Receipt</button>' +
        '<button type="button" class="btn secondary" data-done="view">View Sale</button>' +
        '<button type="button" class="btn secondary" data-done="again">Add Another Sale</button>' +
      '</div>';
    box.innerHTML = h;
    setFormMode('done');
    box.querySelector('[data-done="print"]').addEventListener('click', () => { const gg = groupById(groupId); if (gg) printReceipt(gg); });
    box.querySelector('[data-done="view"]').addEventListener('click', () => { closeFormDrawer(); openDetail(groupId); });
    box.querySelector('[data-done="again"]').addEventListener('click', () => { resetForm(); setFormMode('form'); $('pos-cat-search').focus(); });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------------------------
  function groupPosSales(rows) {
    const byGroup = {}, order = [];
    rows.forEach((r) => {
      if (!byGroup[r.sale_group_id]) { byGroup[r.sale_group_id] = []; order.push(r.sale_group_id); }
      byGroup[r.sale_group_id].push(r);
    });
    return order.map((gid) => ({ groupId: gid, items: byGroup[gid] }));
  }
  const groupGross = (g) => r2(g.items.reduce((s, r) => s + num(r.unit_price) * r.qty, 0));
  const groupDisc = (g) => r2(g.items.reduce((s, r) => s + num(r.discount), 0));
  const groupSubtotal = (g) => r2(groupGross(g) - groupDisc(g)); // what the customer owes after discounts
  const groupPaid = (g) => r2((posPaymentsByGroup[g.groupId] || []).reduce((s, p) => s + num(p.amount), 0));
  const groupBalance = (g) => r2(groupSubtotal(g) - groupPaid(g));
  const codPendingOf = (g) => (posPaymentsByGroup[g.groupId] || []).some((p) => p.payment_method === 'COD' && p.payment_status === 'Pending Collection');
  function posSortComparators() {
    const text = (key) => (a, b) => String(a.items[0][key] || '').localeCompare(String(b.items[0][key] || ''));
    return {
      sale_date: text('sale_date'), order_number: text('order_number'), customer_name: text('customer_name'), sku: text('sku'),
      qty: (a, b) => a.items.reduce((s, r) => s + r.qty, 0) - b.items.reduce((s, r) => s + r.qty, 0),
      amount: (a, b) => groupSubtotal(a) - groupSubtotal(b),
      line_total: (a, b) => lineNet(a.items[0]) - lineNet(b.items[0]),
      payment_method: (a, b) => String((posPaymentsByGroup[a.groupId] || [])[0]?.payment_method || '').localeCompare(String((posPaymentsByGroup[b.groupId] || [])[0]?.payment_method || '')),
    };
  }

  async function loadReport() {
    const mine = ++reportSeq;
    const rg = getRange ? getRange() : null;
    if (!rg) return;
    try {
      const rep = await getPosOpsReport(rg.from, rg.to, getBranchId());
      if (mine !== reportSeq) return;
      report = rep; reportErr = '';
    } catch (err) {
      if (mine !== reportSeq) return;
      report = null; reportErr = String(err.message || err);
    }
    renderTiles();
    renderByAdminPayment(groupPosSales(allPosSales));
  }

  async function load() {
    const mine = ++loadSeq;
    const list = $('pos-list');
    if (!allPosSales.length) list.innerHTML = '<div class="muted">Loading…</div>';
    const fromDate = $('pos-f-from').value || undefined, toDate = $('pos-f-to').value || undefined, bid = getBranchId();
    try {
      const [rows, reqs, removed] = await Promise.all([
        listSales({ branchId: bid, fromDate, toDate }),
        listBranchRecordRequests(['pos_sale']).catch(() => []),
        listPosSaleRemovals({ branchId: bid, fromDate, toDate }).catch(() => []),
      ]);
      if (mine !== loadSeq) return;
      allPosSales = rows.filter((r) => r.sale_group_id);
      const groupIds = [...new Set(allPosSales.map((r) => r.sale_group_id))];
      const payments = await listSalePayments(groupIds);
      if (mine !== loadSeq) return;
      posPaymentsByGroup = {};
      payments.forEach((p) => { (posPaymentsByGroup[p.sale_group_id] || (posPaymentsByGroup[p.sale_group_id] = [])).push(p); });
      requests = reqs.filter((q) => q.branch_id === bid);
      removals = removed;
      render();
      refreshDetailIfOpen();
    } catch (err) {
      if (mine !== loadSeq) return;
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
    loadReport();
    // Stock badges in the product results are per branch -- refresh them on reload.
    if (catalogQuery.trim()) runCatalogSearch();
  }

  // ---------------------------------------------------------------------------------------------
  // Summary tiles (server figures)
  // ---------------------------------------------------------------------------------------------
  function tile(numText, label, tone, sub, act) {
    return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"' + (act ? ' data-act="' + act + '" style="cursor:pointer;"' : '') + '><div class="num">' + esc(numText) + '</div><div class="lbl">' + esc(label) + '</div>' +
      (sub ? '<div class="muted" style="font-size:10.5px;margin-top:2px;">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function renderTiles() {
    const rg = getRange ? getRange() : null;
    $('pos-caption').textContent = branchName(getBranchId()) + (rg ? ' · ' + (rg.label || (rg.from + ' – ' + rg.to)) : '') + ' · money is counted by the day of the sale';
    const tiles = $('pos-tiles');
    if (!report) {
      tiles.innerHTML = reportErr ? '<div class="msg error">The POS summary could not be loaded (' + esc(reportErr) + ').</div>' : '<div class="muted">Loading…</div>';
      return;
    }
    const s = report.sales, c = report.collected, by = c.by_method || {}, rf = report.refunds, vd = report.voids, dl = report.deleted;
    const cash = num(by.Cash), gcash = num(by.GCash), bank = num(by['Bank Transfer']), term = num(by.Terminal);
    const other = r2(num(c.total) - cash - gcash - bank - term);
    const otherParts = Object.keys(by).filter((m) => !['Cash', 'GCash', 'Bank Transfer', 'Terminal'].includes(m)).map((m) => posMethodLabel(m) + ' ' + money(by[m]));
    let h = tile(s.count, 'Sales Count', null, 'in these dates') +
      tile(money(s.gross), 'Gross Sales', null, 'before discounts') +
      tile(money(s.discounts), 'Discounts', null, s.discounted_sales ? s.discounted_sales + (s.discounted_sales === 1 ? ' sale' : ' sales') + ' discounted' : 'none given', s.discounted_sales ? 'discounted' : '') +
      tile(money(s.net), 'Net Sales', null, 'gross − discounts') +
      tile(s.items, 'Items Sold', null, 'pieces') +
      tile(money(s.average), 'Average Sale', null, 'per sale') +
      tile(money(cash), 'Cash', null, 'collected') +
      tile(money(gcash), 'GCash', null, 'collected') +
      tile(money(bank), 'Bank Transfer', null, 'collected') +
      tile(money(term), 'Terminal / Card', null, 'collected') +
      tile(money(other), 'Other Payment', null, otherParts.join(' · ') || 'collected') +
      tile(money(rf.amount), 'Refunds', rf.pending_count ? 'warn' : null, rf.count + (rf.count === 1 ? ' approved' : ' approved') + (rf.pending_count ? ' · ' + rf.pending_count + ' waiting in Refund Management' : '')) +
      tile(money(vd.amount), 'Voids', null, vd.count + (vd.count === 1 ? ' sale voided' : ' sales voided') + (dl.count ? ' · ' + dl.count + ' deleted' : ''), vd.count || dl.count ? 'removed' : '');
    if (num(c.cod_pending) > 0) h += tile(money(c.cod_pending), 'COD to Collect', 'warn', 'sold, not yet collected', 'cod');
    if (report.balance_open && report.balance_open.count) h += tile(money(report.balance_open.amount), 'Balance Owed', 'bad', report.balance_open.count + (report.balance_open.count === 1 ? ' sale' : ' sales') + ' not fully paid (all dates)', 'balance');
    tiles.innerHTML = h;
    tiles.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => {
      const act = el.dataset.act;
      if (act === 'removed') { const f = $('pos-removals-folder'); f.open = true; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (requestRange && (act === 'cod' || act === 'balance')) requestRange('all');
      applyView(act);
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Pivot: rows = who processed the sale, columns = payment method, cell = money actually collected that way -- Pending-Collection
  // COD is kept out of the collected columns/Grand Total and tracked separately (Ren's spec 189).
  // ---------------------------------------------------------------------------------------------
  function renderByAdminPayment(groups) {
    const box = $('pos-by-admin');
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
    if (!adminIds.length) { box.innerHTML = '<p class="muted">No walk-in sales for this date range.</p>'; return; }
    const colTotals = Object.fromEntries(methods.map((m) => [m, 0]));
    const colCount = 1 + methods.length + (hasCodPending ? 1 : 0) + 1;
    let grandTotal = 0, codPendingTotal = 0;
    const byAdminRv = (report && report.by_admin) || {};
    // Each admin's row expands in place to their own orders, customers, payment breakdown, refunds, voids and sales for this same date
    // range (Ren's 2026-10-07 spec) -- built from the exact same groupsByAdmin bucket the collapsed row's totals come from.
    // table-mini: a payment-method pivot has to be read ACROSS a row, so it stays a real table you scroll sideways.
    box.innerHTML = '<div class="table-scroll table-mini"><table><thead><tr><th>Admin</th>' +
      methods.map((m) => '<th>' + esc(posMethodLabel(m)) + '</th>').join('') +
      (hasCodPending ? '<th>COD Pending</th>' : '') +
      '<th>Grand Total</th></tr></thead><tbody>' +
      adminIds.map((empId) => {
        const bucket = totalsByAdmin[empId];
        let rowTotal = 0;
        const cells = methods.map((m) => {
          const amt = bucket[m] || 0;
          colTotals[m] += amt;
          rowTotal += amt;
          return '<td data-label="' + esc(posMethodLabel(m)) + '">' + (amt ? money(amt) : '—') + '</td>';
        }).join('');
        grandTotal += rowTotal;
        const codPending = codPendingByAdmin[empId] || 0;
        codPendingTotal += codPending;
        return '<tr>' +
          '<td data-label="Admin"><button type="button" class="exp-row-btn" data-admin-toggle="' + esc(empId) + '" aria-expanded="false"><span class="exp-arrow" aria-hidden="true">▸</span><b>' + esc(nameOf(empId)) + '</b></button></td>' +
          cells +
          (hasCodPending ? '<td data-label="COD Pending">' + (codPending ? '<span class="badge pending">' + money(codPending) + '</span>' : '—') + '</td>' : '') +
          '<td data-label="Grand Total"><b>' + money(rowTotal) + '</b></td>' +
        '</tr>' +
        '<tr class="admin-detail-row" data-admin-for="' + esc(empId) + '" style="display:none;"><td colspan="' + colCount + '" class="full-row"></td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td data-label="Admin"><b>Grand Total</b></td>' +
      methods.map((m) => '<td data-label="' + esc(posMethodLabel(m)) + '"><b>' + money(colTotals[m]) + '</b></td>').join('') +
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
      const customers = new Set(adminGroups.map((g) => (g.items[0].customer_name || '').trim().toLowerCase()).filter(Boolean));
      const rv = byAdminRv[empId] || { voids: { count: 0, amount: 0 }, refunds: { count: 0, amount: 0 } };
      detailRow.querySelector('td').innerHTML =
        '<div class="pos-admin-sum">' +
          '<span><b>' + adminGroups.length + '</b> order' + (adminGroups.length === 1 ? '' : 's') + '</span>' +
          '<span><b>' + customers.size + '</b> customer' + (customers.size === 1 ? '' : 's') + '</span>' +
          '<span>Payments: ' + (methods.filter((m) => bucket0(empId, m)).map((m) => esc(posMethodLabel(m)) + ' ' + money(bucket0(empId, m))).join(' · ') || '—') + '</span>' +
          '<span>Refunds: <b>' + money(rv.refunds.amount) + '</b> (' + rv.refunds.count + ')</span>' +
          '<span>Voids: <b>' + money(rv.voids.amount) + '</b> (' + rv.voids.count + ')</span>' +
        '</div>' +
        '<div class="table-scroll table-mini" style="margin:6px 0;"><table><thead><tr><th>Date &amp; Time</th><th>Order</th><th>Customer</th><th>Amount</th><th>Payment</th><th></th></tr></thead><tbody>' +
        adminGroups.map((g) => {
          const payments = posPaymentsByGroup[g.groupId] || [];
          const methodLabel = payments.length ? payments.map((p) => esc(posMethodLabel(p.payment_method))).join(', ') : '—';
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
    function bucket0(empId, m) { return (totalsByAdmin[empId] || {})[m] || 0; }
  }

  // Summary popover for whatever's CURRENTLY VISIBLE in the ledger (search included).
  function renderPopover(groups) {
    const panel = $('pos-summary-panel');
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
      methods.map((m) => '<div class="row"><span>' + esc(posMethodLabel(m)) + '</span><b>' + money(methodTotals[m]) + '</b></div>').join('') +
      '<div class="row total"><span>Grand Total</span><b>' + money(grandTotal) + '</b></div>' +
      (codPendingTotal ? '<div class="row" style="color:#a15c00;"><span>COD Pending Collection</span><b>' + money(codPendingTotal) + '</b></div>' : '') +
      '<details class="exp" style="margin-top:10px;"><summary><span class="exp-arrow" aria-hidden="true">▸</span>Sales by Admin <span class="exp-count">(' + adminIds.length + ')</span></summary><div class="exp-body">' +
        adminIds.map((id) => '<div class="row"><span>' + esc(nameOf(id)) + '</span><b>' + money(totalsByAdmin[id]) + '</b></div>').join('') +
      '</div></details>' +
      '<details class="exp" style="margin-top:8px;"><summary><span class="exp-arrow" aria-hidden="true">▸</span>Top Selling Items</summary><div class="exp-body">' +
        topSkus.map((sku, i) => '<div class="row"><span>' + (i + 1) + '. ' + esc(skuName[sku]) + ' (' + esc(sku) + ')</span><b>' + skuQty[sku] + ' pcs</b></div>').join('') +
      '</div></details>' +
      '<p class="muted" style="margin:10px 0 0;font-size:11px;">Lines: ' + lineItems + ' · matches the Search / date / Branch filters above.</p>';
  }
  $('pos-summary-toggle').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const panel = $('pos-summary-panel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', (ev) => {
    const panel = $('pos-summary-panel');
    if (panel && panel.style.display !== 'none' && !panel.contains(ev.target) && ev.target.id !== 'pos-summary-toggle') panel.style.display = 'none';
  });

  // ---------------------------------------------------------------------------------------------
  // The ledger
  // ---------------------------------------------------------------------------------------------
  function saleChips(g) {
    const bal = groupBalance(g), pays = posPaymentsByGroup[g.groupId] || [];
    const out = [];
    const cod = codPendingOf(g);
    if (groupSubtotal(g) <= 0.005) out.push(chip('₱0', 'gray'));
    else if (bal > 0.5) out.push(chip(pays.length ? 'BALANCE ' + money(bal) : 'UNPAID', pays.length ? 'yellow' : 'red'));
    else if (!cod) out.push(chip('PAID', 'green'));
    if (cod) out.push(chip('COD TO COLLECT', 'yellow'));
    if (g.items[0].pickup_status === 'Pending Pickup') out.push(chip('PICKUP PENDING', 'blue'));
    if (groupDisc(g) > 0) out.push(chip('DISCOUNT', 'gray'));
    return out.join(' ');
  }
  function paymentStatusHtml(g) {
    const payments = posPaymentsByGroup[g.groupId] || [];
    return saleChips(g) + (payments.length ? '<div class="muted" style="font-size:10px;margin-top:2px;">' + payments.map((p) =>
      esc(posMethodLabel(p.payment_method)) + (p.payment_method === 'COD' ? (p.payment_status === 'Pending Collection' ? ' (pending)' : ' (collected)') : '') +
      (p.reference_number ? ' #' + esc(p.reference_number) : '')).join('<br>') + '</div>' : '');
  }
  function readFilters() {
    return { search: $('pos-f-search').value.trim().toLowerCase(), show: $('pos-f-show').value, method: $('pos-f-method').value, admin: $('pos-f-admin').value };
  }
  function haystack(g) {
    const first = g.items[0], pays = posPaymentsByGroup[g.groupId] || [];
    return [first.order_number, first.customer_name, first.contact_number, first.customer_type, first.notes, nameOf(first.employee_id),
      ...g.items.flatMap((r) => [r.sku, r.products && r.products.item_name]),
      ...pays.flatMap((p) => [p.payment_method, posMethodLabel(p.payment_method), p.reference_number])].filter((x) => x != null).join(' ').toLowerCase();
  }
  function matchesShow(g, show) {
    switch (show) {
      case 'balance': return groupBalance(g) > 0.5;
      case 'cod': return codPendingOf(g);
      case 'pickup': return g.items[0].pickup_status === 'Pending Pickup';
      case 'discounted': return groupDisc(g) > 0;
      case 'zero': return g.items.some((r) => num(r.unit_price) * r.qty === 0);
      default: return true;
    }
  }
  function syncAdminOptions() {
    const sel = $('pos-f-admin'), keep = sel.value;
    const ids = [...new Set(allPosSales.map((r) => r.employee_id))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    sel.innerHTML = '<option value="all">All</option>' + ids.map((id) => '<option value="' + esc(id) + '">' + esc(nameOf(id)) + '</option>').join('');
    sel.value = ids.includes(keep) ? keep : 'all';
  }

  function render() {
    $('pos-new-btn').disabled = !canAddHere();
    $('pos-write-note').innerHTML = canAddHere()
      ? ''
      : '<p class="muted" style="font-size:11px;">View only — you can only ring up sales for your own branch.</p>';
    syncAdminOptions();
    const f = readFilters();
    const allGroups = groupPosSales(allPosSales);
    renderByAdminPayment(allGroups); // date-filtered only -- not narrowed by the free-text search / status filters
    // Ren, 2026-10-02: admin in the filter search lets typing a staff name find every sale they processed (and who they sold to).
    let groups = allGroups;
    if (f.search) groups = groups.filter((g) => haystack(g).includes(f.search));
    if (f.show !== 'all') groups = groups.filter((g) => matchesShow(g, f.show));
    if (f.method !== 'all') groups = groups.filter((g) => (posPaymentsByGroup[g.groupId] || []).some((p) => p.payment_method === f.method));
    if (f.admin !== 'all') groups = groups.filter((g) => String(g.items[0].employee_id) === f.admin);
    renderPopover(groups);

    // Pill count, active-filter strip and ledger all follow these same filters (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(groups.length);
    const hasFilters = !!(f.search || f.show !== 'all' || f.method !== 'all' || f.admin !== 'all');
    const rangeNow = getRange ? getRange() : null;
    const rangeLabel = rangeNow && rangeNow.preset !== 'all' ? rangeNow.label : '';
    $('pos-range-note').textContent = (rangeLabel ? '— ' + rangeLabel : '— all dates') + (allPosSales.length >= LEDGER_ROW_CAP ? ' · showing the latest ' + LEDGER_ROW_CAP.toLocaleString('en-PH') + ' lines — narrow the dates to see older sales' : '');
    const activeEl = $('pos-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(f.search) }, { label: 'Showing', value: f.show === 'all' ? '' : esc((SHOW_FILTERS.find(([k]) => k === f.show) || [])[1] || f.show) },
      { label: 'Payment', value: f.method === 'all' ? '' : esc(posMethodLabel(f.method)) }, { label: 'Admin', value: f.admin === 'all' ? '' : esc(nameOf(f.admin)) },
    ], 'pos-f-clear');
    wireProxyButtons(activeEl);

    const box = $('pos-list');
    if (!groups.length) {
      box.innerHTML = emptyStateHtml({
        message: hasFilters ? 'No walk-in sales match these filters' + (rangeLabel ? ' for ' + esc(rangeLabel) : '') + '.'
          : (rangeLabel ? 'No walk-in sales for ' + esc(rangeLabel) + '.' : 'No walk-in sales recorded for this branch yet.'),
        hasFilters, clearId: 'pos-f-clear', createLabel: canAddHere() ? '+ New Sale' : null, createId: 'pos-new-btn',
      });
      wireProxyButtons(box);
      if (rangeLabel && requestRange) {
        const more = document.createElement('div');
        more.className = 'empty-state-actions'; more.style.marginTop = '8px';
        more.innerHTML = '<button type="button" class="btn small secondary">Search all dates</button>';
        more.querySelector('button').addEventListener('click', () => requestRange('all'));
        box.querySelector('.empty-state')?.appendChild(more);
      }
      renderRequests(); renderRemovals();
      return;
    }
    // One formal ledger row per line item (Ren, 2026-09-16); Date/Order/Customer/Payment repeat on each row of a multi-item sale. Every
    // action is in the Detail Drawer. Filtering already picked `groups`; sort only reorders them -- every line of one sale stays together.
    // The page of 25 / 50 / 100 is cut by SALE, not by line, so a sale is never split across pages.
    const sortedGroups = applySort(groups, sort, posSortComparators());
    const info = pageSlice(sortedGroups, pg);
    box.innerHTML = '<div class="table-scroll table-mini"><table>' +
      '<thead><tr><th>Date &amp; Time</th><th>Order</th><th>Customer</th><th>SKU</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Discount</th><th>Line Total</th><th>Payment</th><th></th></tr></thead><tbody>' +
      info.rows.map((g) => {
        const paidLabel = paymentStatusHtml(g);
        return g.items.map((r, idx) => '<tr>' +
          '<td data-label="Date &amp; Time">' + fmtDateTime(r.sale_date) + '</td>' +
          '<td data-label="Order">' + esc(r.order_number || '—') + '</td>' +
          '<td data-label="Customer" class="full-row">' + esc(r.customer_name || '—') + (r.customer_type ? '<div class="muted" style="font-size:10px;">' + esc(r.customer_type) + '</div>' : '') + '</td>' +
          '<td data-label="SKU">' + esc(r.sku) + '</td>' +
          '<td data-label="Item" class="full-row">' + esc(r.products?.item_name || '—') + '</td>' +
          '<td data-label="Qty">' + r.qty + '</td>' +
          '<td data-label="Unit Price">' + money(r.unit_price) + '</td>' +
          '<td data-label="Discount">' + (num(r.discount) > 0 ? '− ' + money(r.discount) : '—') + '</td>' +
          '<td data-label="Line Total">' + money(lineNet(r)) + '</td>' +
          '<td data-label="Payment" class="full-row">' + (idx === 0 ? paidLabel : '<span class="muted" style="font-size:10px;">same sale</span>') + '</td>' +
          '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-group="' + esc(g.groupId) + '">View Details</button></td>' +
        '</tr>').join('');
      }).join('') +
      '</tbody></table></div>' + pagerHtml(info);
    wirePager(box, pg, render);
    box.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(btn.dataset.group)));
    renderRequests(); renderRemovals();
  }

  // ---------------------------------------------------------------------------------------------
  // Void / delete requests (Pending -> Supervisor Approved -> done by Admin) and the history of what was removed
  // ---------------------------------------------------------------------------------------------
  async function runAction(fn, okText) {
    try { await fn(); notify(okText, false); await load(); }
    catch (err) { notify(String(err.message || err), true); }
  }
  const itemsLine = (s) => (s.items || []).map((i) => (i.qty || 1) + '× ' + (i.name || i.sku)).join(', ');
  const paymentsLine = (s) => (s.payments || []).map((p) => money(p.amount) + ' ' + posMethodLabel(p.method)).join(' + ');

  function renderRequests() {
    $('pos-requests-count').textContent = '(' + requests.length + ')';
    setApprovalFolder('pos-requests-folder', requests.length);
    const box = $('pos-requests-list');
    if (!requests.length) { box.innerHTML = '<p class="muted">No sale void or delete requests waiting.</p>'; return; }
    box.innerHTML = requests.map((q) => {
      const s = q.snapshot || {};
      const mine = q.requested_by === employee.id;
      const awaitingFinal = q.status === 'Supervisor Approved';
      const verb = q.action === 'Void' ? 'void' : 'delete';
      const buttons = [];
      if (q.status === 'Pending' && isSupervisorUp && (isAdmin || !mine)) {
        buttons.push('<button class="btn small" data-act="sup-approve" data-id="' + q.id + '">Approve</button>');
        if (isAdmin) buttons.push('<button class="btn small danger" data-act="admin-approve" data-id="' + q.id + '">Approve &amp; ' + verb + '</button>');
      }
      if (awaitingFinal && isAdmin) buttons.push('<button class="btn small danger" data-act="final-approve" data-id="' + q.id + '">Final approval — ' + verb + '</button>');
      if (isSupervisorUp && (q.status === 'Pending' || isAdmin)) buttons.push('<button class="btn small secondary" data-act="reject" data-id="' + q.id + '">Reject</button>');
      if (mine || isAdmin) buttons.push('<button class="btn small secondary" data-act="withdraw" data-id="' + q.id + '">Withdraw</button>');
      if (groupById(q.record_id)) buttons.push('<button class="btn small secondary" data-act="open" data-group="' + esc(q.record_id) + '">Open sale</button>');
      return approvalCardHtml(esc, {
        type: q.action === 'Void' ? 'Void sale' : 'Delete sale', order: s.order, customer: s.customer, item: itemsLine(s), amount: s.amount,
        requester: q.requester && q.requester.full_name, requestedAt: q.requested_at, reason: q.reason,
        detail: (q.error_type ? 'Kind of mistake: <b>' + esc(q.error_type) + '</b> · ' : '') + 'rung up by ' + esc(nameOf(s.processed_by)) + (s.discount > 0 ? ' · discount ' + esc(money(s.discount)) : '') +
          (paymentsLine(s) ? ' · paid ' + esc(paymentsLine(s)) : ''),
        supervisor: q.supervisor && q.supervisor.full_name, awaitingFinal,
        actions: buttons.join('') || '<span class="muted" style="font-size:12px;">' + (awaitingFinal ? 'Waiting for Admin.' : 'Waiting for a supervisor.') + '</span>',
      });
    }).join('');
    box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id), act = btn.dataset.act;
      const q = requests.find((x) => x.id === id);
      if (act === 'open') return void openDetail(btn.dataset.group);
      const verb = q && q.action === 'Void' ? 'void' : 'delete';
      if (act === 'sup-approve') return runAction(() => approveBranchRecordStage1(id), 'Approved — now waiting for Admin.');
      if (act === 'admin-approve' || act === 'final-approve') {
        if (!await confirmDialog({ title: (verb === 'void' ? 'Void' : 'Delete') + ' this sale?', message: 'Its items go back to Available stock and the sale leaves the sales list and every report. Its full record stays in Voided & deleted sales.', confirmLabel: verb === 'void' ? 'Void sale' : 'Delete sale', danger: true })) return;
        return runAction(async () => { if (act === 'admin-approve') await approveBranchRecordStage1(id); await approveBranchRecordFinal(id); }, verb === 'void' ? 'Sale voided.' : 'Sale deleted.');
      }
      if (act === 'reject') {
        const out = await reasonDialog({ title: 'Reject this request?', message: 'Optional: tell the person why.', label: 'Reason', required: false, confirmLabel: 'Reject', danger: true });
        if (!out) return;
        return runAction(() => rejectBranchRecordAction(id, out.reason || null), 'Request rejected.');
      }
      if (act === 'withdraw') {
        if (!await confirmDialog({ title: 'Withdraw this request?', message: 'The sale stays as it is.', confirmLabel: 'Withdraw' })) return;
        return runAction(() => cancelBranchRecordAction(id), 'Request withdrawn.');
      }
    }));
  }

  function renderRemovals() {
    $('pos-removals-count').textContent = '(' + removals.length + ')';
    const box = $('pos-removals-list');
    if (!removals.length) { box.innerHTML = '<p class="muted">No sales were voided or deleted in this date range.</p>'; return; }
    box.innerHTML = '<p class="muted" style="font-size:12px;margin:0 0 6px;">Approved requests, by the day they were approved. Each keeps a copy of the sale as it was.</p>' +
      removals.map((q) => {
        const s = q.snapshot || {};
        return '<details class="card exp pos-removal"><summary><span class="exp-arrow" aria-hidden="true">▸</span>' +
          chip(q.action === 'Void' ? 'VOID' : 'DELETED', q.action === 'Void' ? 'gray' : 'red') + ' <b>' + esc(s.order || '—') + '</b> · ' + esc(s.customer || 'no customer') + ' · ' + money(s.amount) +
          ' <span class="muted" style="font-size:11px;">' + esc(fmtDate(manilaDateStr(q.final_approved_at))) + '</span></summary><div class="exp-body" style="font-size:12px;">' +
          '<div><span class="muted">Requested by</span> <b>' + esc(q.requester && q.requester.full_name || '—') + '</b> · ' + esc(fmtDateTime(q.requested_at)) + '</div>' +
          '<div><span class="muted">Approved by</span> <b>' + esc([q.supervisor && q.supervisor.full_name, q.approver && q.approver.full_name].filter(Boolean).join(' → ') || '—') + '</b> · ' + esc(fmtDateTime(q.final_approved_at)) + '</div>' +
          '<div><span class="muted">Reason</span> ' + esc(q.reason || '—') + (q.error_type ? ' · <span class="muted">kind of mistake</span> ' + esc(q.error_type) : '') + '</div>' +
          '<div><span class="muted">Rung up by</span> ' + esc(nameOf(s.processed_by)) + ' · ' + esc(fmtDateTime(s.sale_date)) + (s.customer_type ? ' · ' + esc(s.customer_type) : '') + '</div>' +
          '<div style="margin-top:4px;"><span class="muted">Items</span> ' + esc(itemsLine(s) || '—') + (s.discount > 0 ? ' · discount ' + esc(money(s.discount)) : '') + '</div>' +
          '<div><span class="muted">Payments</span> ' + esc(paymentsLine(s) || 'none recorded') + '</div>' +
        '</div></details>';
      }).join('');
  }

  // ---------------------------------------------------------------------------------------------
  // Detail drawer body: one sale
  // ---------------------------------------------------------------------------------------------
  const openRequestFor = (g) => requests.find((q) => String(q.record_id) === String(g.groupId));
  function renderDetailBody(g) {
    const first = g.items[0];
    const payments = posPaymentsByGroup[g.groupId] || [];
    const gross = groupGross(g), disc = groupDisc(g), total = groupSubtotal(g), paid = groupPaid(g), balance = r2(total - paid);
    const change = r2(payments.reduce((s, p) => s + (p.tendered != null ? num(p.tendered) - num(p.amount) : 0), 0));
    const notes = [...new Set(g.items.map((r) => r.notes).filter(Boolean))];
    const discReasons = [...new Set(g.items.map((r) => r.discount_reason).filter(Boolean))];
    const canAct = canActOnBranch(first.branch_id);
    const pending = openRequestFor(g);
    return '<div style="margin:0 0 8px;">' + saleChips(g) + (pending ? ' ' + chip((pending.action === 'Void' ? 'VOID' : 'DELETE') + ' REQUESTED', 'red') : '') + '</div>' +
    '<div class="drawer-section"><h4>Sale</h4>' +
      '<div class="drawer-kv"><span>Date &amp; Time</span><b>' + fmtDateTime(first.sale_date) + '</b></div>' +
      '<div class="drawer-kv"><span>Order / Ref No.</span><b>' + esc(first.order_number || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Customer Type</span><b>' + esc(first.customer_type || 'Not recorded') + '</b></div>' +
      '<div class="drawer-kv"><span>Customer</span><b>' + esc(first.customer_name || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Contact</span><b>' + esc(first.contact_number || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Branch</span><b>' + esc(branchName(first.branch_id)) + '</b></div>' +
      '<div class="drawer-kv"><span>Processed By</span><b>' + esc(nameOf(first.employee_id)) + '</b></div>' +
      (notes.length ? '<div class="drawer-kv"><span>Notes</span><b>' + notes.map(esc).join(' · ') + '</b></div>' : '') +
    '</div>' +
    (first.pickup_address ? '<div class="drawer-section"><h4>Pickup</h4>' +
      '<div class="drawer-kv"><span>Address</span><b>' + esc(first.pickup_address) + '</b></div>' +
      '<div class="drawer-kv"><span>Status</span><b>' + (first.pickup_status === 'Picked Up' ? '<span class="badge ok">Picked Up</span>' : '<span class="badge pending">Pending Pickup</span>') + '</b></div>' +
      (first.pickup_status === 'Pending Pickup' && canEditSale
        ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="mark-picked-up" data-group="' + esc(g.groupId) + '">Mark Picked Up</button></div>' : '') +
    '</div>' : '') +
    '<div class="drawer-section"><h4>Items</h4>' +
      g.items.map((r) => '<div class="payment-line">' +
        '<div><b>' + esc(r.products?.item_name || r.sku) + '</b> <span class="muted">' + esc(r.sku) + '</span></div>' +
        '<div class="muted" style="font-size:12px;margin-top:2px;">' + r.qty + ' × ' + money(r.unit_price) + (num(r.discount) > 0 ? ' − ' + money(r.discount) + ' discount' : '') +
          ' = <b style="color:var(--ink);">' + money(lineNet(r)) + '</b></div>' +
        (canEditSaleItem ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="edit-item" data-id="' + r.id + '">Edit</button></div>' : '') +
      '</div>').join('') +
    '</div>' +
    '<div class="drawer-section"><h4>Payment</h4>' +
      '<div class="drawer-kv"><span>Subtotal</span><b>' + money(gross) + '</b></div>' +
      (disc > 0 ? '<div class="drawer-kv"><span>Discount</span><b>− ' + money(disc) + '</b></div>' + (discReasons.length ? '<div class="drawer-kv"><span>Discount reason</span><b>' + discReasons.map(esc).join(' · ') + '</b></div>' : '') : '') +
      '<div class="drawer-kv"><span>Total Due</span><b>' + money(total) + '</b></div>' +
      '<div class="drawer-kv"><span>Paid</span><b>' + money(paid) + '</b></div>' +
      (change > 0 ? '<div class="drawer-kv"><span>Change given</span><b style="color:#2e7d4f;">' + money(change) + '</b></div>' : '') +
      '<div class="drawer-kv"><span>' + (balance > 0.5 ? 'Balance Due' : (balance < -0.5 ? 'Paid over' : 'Balance')) + '</span><b style="color:' + (balance > 0.5 ? '#b23c3c' : (balance < -0.5 ? '#2e7d4f' : 'inherit')) + ';">' + money(Math.abs(balance) < 0.5 ? 0 : Math.abs(balance)) + '</b></div>' +
      '<div style="margin-top:8px;">' +
        (payments.length ? payments.map((p) => '<div class="payment-line">' +
          '<div>' + money(p.amount) + ' · ' + esc(posMethodLabel(p.payment_method)) +
            (p.payment_method === 'COD' ? (p.payment_status === 'Pending Collection' ? ' <span class="badge pending">Pending Collection</span>' : ' <span class="badge ok">Collected</span>') : '') +
          '</div>' +
          '<div class="muted" style="font-size:10.5px;margin-top:2px;">' + (p.reference_number ? 'Reference #' + esc(p.reference_number) + ' · ' : '') +
            'paid ' + esc(fmtDate(p.paid_at || manilaDateStr(first.sale_date))) + ' · recorded by ' + esc(p.recorded_by ? nameOf(p.recorded_by) : nameOf(first.employee_id)) +
            (p.tendered != null ? ' · cash handed over ' + esc(money(p.tendered)) : '') + '</div>' +
          // Mark Collected is a status change, not an amount edit -- canEditSale, not the narrower canEditAmount (Ren's spec 186/191).
          (p.payment_method === 'COD' && p.payment_status === 'Pending Collection' && canEditSale
            ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="mark-cod-collected" data-id="' + p.id + '">Mark Collected</button></div>' : '') +
        '</div>').join('') : '<p class="muted" style="margin:0;">No payment recorded.</p>') +
      '</div>' +
      '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">' +
        (balance > 0.5 && canAct ? '<button type="button" class="btn small" data-act="add-payment">Add Payment</button>' : '') +
        (canEditAmount ? '<button type="button" class="btn small secondary" data-act="edit-payment">Edit Payment</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Refunds</h4><div id="pos-d-refunds" class="muted" style="font-size:12px;">Loading…</div>' +
      (canAct ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="request-refund">Request Refund</button></div>' : '') +
    '</div>' +
    (pending ? '<div class="drawer-section"><h4>Waiting for approval</h4><div style="font-size:12px;"><b>' + esc(pending.action === 'Void' ? 'Void' : 'Delete') + ' requested</b> by ' +
      esc(pending.requester && pending.requester.full_name || '—') + ' on ' + esc(fmtDateTime(pending.requested_at)) + '<br><span class="muted">Reason:</span> ' + esc(pending.reason || '—') +
      '<br><span class="muted">' + (pending.status === 'Supervisor Approved' ? 'Approved by ' + esc(pending.supervisor && pending.supervisor.full_name || 'a supervisor') + ' — waiting for Admin.' : 'Waiting for a supervisor.') + '</span></div></div>' : '') +
    '<div class="drawer-section"><h4>History</h4><div id="pos-d-history" class="muted" style="font-size:12px;">Loading…</div></div>' +
    '<div class="drawer-section"><h4>Actions</h4>' +
      '<button type="button" class="btn small secondary" data-act="print">Print Receipt</button> ' +
      (canAct && !pending ? (isAdmin
        ? '<button type="button" class="btn small secondary" data-act="void-sale">Void Sale…</button> <button type="button" class="btn small secondary" data-act="delete-sale">Delete Sale…</button>'
        : '<button type="button" class="btn small secondary" data-act="void-sale">Request Void</button> <button type="button" class="btn small secondary" data-act="delete-sale">Request Delete</button>') : '') +
    '</div>';
  }

  // The parts of the drawer that need their own lookup: the sale's refunds and its history.
  async function loadDetailExtras(g) {
    const gid = g.groupId, first = g.items[0];
    const refEl = () => (openGroupId === gid ? document.getElementById('pos-d-refunds') : null);
    const histEl = () => (openGroupId === gid ? document.getElementById('pos-d-history') : null);
    listRefundsForOrder(first.order_number).then((list) => {
      const el = refEl(); if (!el) return;
      el.innerHTML = list.length
        ? list.map((r) => '<div>' + chip(esc(r.status || '—'), /approved|refunded|complete/i.test(r.status || '') ? 'green' : (/reject|cancel/i.test(r.status || '') ? 'gray' : 'yellow')) + ' <b>' + esc(r.number || 'Refund') + '</b> · ' + money(r.amount) + ' · ' + esc(fmtDate(r.requested_date)) + '</div>').join('') +
          '<div style="margin-top:4px;"><a href="' + ERP_REFUNDS_URL + '" target="_blank" rel="noopener">Open Refund Management ↗</a></div>'
        : (first.order_number ? 'No refund has been requested for this order.' : 'This sale has no Order / Ref No. — add one (Edit) so a refund can be linked to it.');
    }).catch(() => { const el = refEl(); if (el) el.textContent = 'Refunds could not be loaded.'; });
    Promise.all([listPosSaleChangeLog(gid).catch(() => []), listBranchAuditLog('pos_sale', gid).catch(() => [])]).then(([change, audit]) => {
      const el = histEl(); if (!el) return;
      const events = [];
      change.forEach((c) => events.push({ at: c.changed_at, who: c.who && c.who.full_name, action: c.action, text: c.details }));
      audit.filter((a) => a.action !== 'Payment added').forEach((a) => events.push({ at: a.changed_at, who: a.actor && a.actor.full_name, action: a.action,
        text: [a.details, a.reason && !String(a.details || '').includes(a.reason) ? 'Reason: ' + a.reason : ''].filter(Boolean).join(' · ') }));
      events.sort((x, y) => String(y.at).localeCompare(String(x.at)));
      el.innerHTML = events.length ? events.map((e) => '<div class="pos-hist-row"><div><b>' + esc(e.action) + '</b> <span class="muted">' + esc(e.who || '—') + ' · ' + esc(fmtDateTime(e.at)) + '</span></div>' +
        (e.text ? '<div class="muted" style="font-size:11px;">' + esc(e.text) + '</div>' : '') + '</div>').join('') : 'No changes recorded.';
    });
  }

  // Simple print-friendly receipt in its own window (spec 275: [View Receipt] [Print]).
  function printReceipt(g) {
    const first = g.items[0];
    const payments = posPaymentsByGroup[g.groupId] || [];
    const disc = groupDisc(g), total = groupSubtotal(g), paid = groupPaid(g), bal = r2(total - paid);
    const change = r2(payments.reduce((s, p) => s + (p.tendered != null ? num(p.tendered) - num(p.amount) : 0), 0));
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>' +
      '<style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;max-width:360px;margin:20px auto;color:#222}h2{font-size:16px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{padding:4px 0;text-align:left;font-size:12px}th{border-bottom:1px solid #999}.r{text-align:right}.tot td{border-top:1px solid #999;font-weight:bold}.muted{color:#666;font-size:11px}</style></head><body>' +
      '<h2>Kittymae Jewels</h2><div class="muted">' + esc(branchName(first.branch_id)) + '</div>' +
      '<div class="muted">' + fmtDateTime(first.sale_date) + (first.order_number ? ' · Order #' + esc(first.order_number) : '') + '</div>' +
      (first.customer_name ? '<div>Customer: ' + esc(first.customer_name) + '</div>' : '') +
      '<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>' +
      g.items.map((r) => '<tr><td>' + esc(r.products?.item_name || r.sku) + '<div class="muted">' + esc(r.sku) + ' · ' + money(r.unit_price) + (num(r.discount) > 0 ? ' − ' + money(r.discount) + ' discount' : '') + '</div></td><td class="r">' + r.qty + '</td><td class="r">' + money(lineNet(r)) + '</td></tr>').join('') +
      (disc > 0 ? '<tr><td colspan="2">Discount</td><td class="r">− ' + money(disc) + '</td></tr>' : '') +
      '<tr class="tot"><td colspan="2">Total</td><td class="r">' + money(total) + '</td></tr>' +
      '</tbody></table>' +
      (payments.length ? '<div><b>Payment</b></div>' + payments.map((p) => '<div>' + esc(posMethodLabel(p.payment_method)) + ' — ' + money(p.amount) + (p.reference_number ? ' <span class="muted">(' + esc(p.reference_number) + ')</span>' : '') + (p.payment_method === 'COD' && p.payment_status === 'Pending Collection' ? ' <span class="muted">(pending collection)</span>' : '') + '</div>').join('') : '') +
      (change > 0 ? '<div>Change: ' + money(change) + '</div>' : '') +
      (bal > 0.5 ? '<div><b>Balance due: ' + money(bal) + '</b></div>' : '') +
      '<div class="muted" style="margin-top:12px;">Processed by ' + esc(nameOf(first.employee_id)) + '</div>' +
      '<script>window.onload=function(){window.print();}<\/script></body></html>';
    const w = window.open('', '_blank');
    if (!w) { notify('Allow pop-ups to print the receipt.', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  // ---------------------------------------------------------------------------------------------
  // Detail actions and the forms that open inside the drawer (Save returns to the refreshed details, Cancel to the unchanged ones)
  // ---------------------------------------------------------------------------------------------
  const errorTypeOptions = (selected) => POS_ERROR_TYPES.map((t) => '<option' + (t === selected ? ' selected' : '') + '>' + t + '</option>').join('');
  const formErr = '<div class="msg error" data-form-err role="alert" hidden></div>';
  function setFormErr(container, message, el) {
    const box = container.querySelector('[data-form-err]');
    if (box) { box.textContent = friendlyError(message); box.hidden = false; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (el) flagInvalid(el);
  }

  function wireDetailBody(container, g) {
    const back = () => { detailMode = null; openDetail(g.groupId); };
    container.querySelector('[data-act="print"]')?.addEventListener('click', () => printReceipt(g));

    container.querySelector('[data-act="mark-picked-up"]')?.addEventListener('click', async (ev) => {
      if (!await confirmDialog({ title: 'Mark this sale picked up?', message: 'The status changes from Pending Pickup to Picked Up.', confirmLabel: 'Mark picked up' })) return;
      try { await markSalePickedUp(ev.target.dataset.group); notify('Sale marked picked up.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    });
    container.querySelectorAll('[data-act="mark-cod-collected"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Mark this COD payment collected?', message: 'Use this once the courier or customer has actually paid.', confirmLabel: 'Mark collected' })) return;
      try { await markCodCollected(Number(btn.dataset.id)); notify('COD payment marked collected.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    }));

    // ---- void / delete: a request (a supervisor and then Admin approve); Admin does every step at once ----
    const removal = (action) => async () => {
      const first = g.items[0];
      const word = action === 'Void' ? 'void' : 'delete';
      const title = isAdmin ? (action === 'Void' ? 'Void this sale?' : 'Delete this sale?') : (action === 'Void' ? 'Request to void this sale?' : 'Request to delete this sale?');
      const message = (action === 'Void'
        ? 'Use this when the sale was cancelled. '
        : 'Use this only for a sale that should never have been entered. ') +
        'The items go back to Available stock and the sale leaves the sales list and every report. Its full record (who rang it up, the items, the payments, the reason) stays in "Voided & deleted sales".' +
        (isAdmin ? '' : '\nA supervisor and then Admin must approve it. Nothing changes until then.');
      const out = await reasonDialog({ title, message, label: 'Reason', errorTypes: POS_ERROR_TYPES, errorLabel: 'What went wrong? (if it was a mistake)', initialErrorType: action === 'Delete' ? 'Other' : 'Other',
        confirmLabel: isAdmin ? (action === 'Void' ? 'Void sale' : 'Delete sale') : 'Send request', danger: true });
      if (!out) return;
      try {
        if (isAdmin) { await adminApplyBranchRecordAction('pos_sale', g.groupId, action, out.reason, out.errorType); notify('Sale ' + (action === 'Void' ? 'voided' : 'deleted') + '.', false); closeDetailDrawer(); }
        else { await requestBranchRecordAction('pos_sale', g.groupId, action, out.reason, out.errorType); notify('Request sent — a supervisor and then Admin must approve it.', false); }
        await load();
      } catch (err) { notify(String(err.message || err), true); }
    };
    container.querySelector('[data-act="void-sale"]')?.addEventListener('click', removal('Void'));
    container.querySelector('[data-act="delete-sale"]')?.addEventListener('click', removal('Delete'));

    // ---- edit one line (amount, qty, price, discount, customer, order no.) ----
    container.querySelectorAll('[data-act="edit-item"]').forEach((btn) => btn.addEventListener('click', () => {
      const r = g.items.find((x) => x.id === Number(btn.dataset.id));
      if (!r) return;
      detailMode = 'edit-item';
      container.innerHTML =
        '<form id="pos-edit-item-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' + formErr +
          '<div class="drawer-section"><h4>Line Item</h4>' +
            '<div class="field"><label>SKU</label><input type="text" name="sku" value="' + esc(r.sku) + '"></div>' +
            '<div class="field"><label>Qty</label><input type="number" name="qty" min="1" step="1" value="' + r.qty + '"></div>' +
            '<div class="field"><label>Unit Price</label><input type="number" name="unitPrice" step="0.01" min="0" value="' + (r.unit_price ?? '') + '"></div>' +
            '<div class="field"><label>Discount (₱)</label><input type="number" name="discount" step="0.01" min="0" value="' + (num(r.discount) || '') + '" placeholder="0"></div>' +
            '<div class="field"><label>Discount reason</label><input type="text" name="discountReason" value="' + esc(r.discount_reason || '') + '"></div>' +
          '</div>' +
          '<div class="drawer-section"><h4>Sale</h4>' +
            '<div class="field"><label>Customer Name</label><input type="text" name="customerName" value="' + esc(r.customer_name || '') + '"></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber" value="' + esc(r.contact_number || '') + '"></div>' +
            '<div class="field"><label>Order / Ref No.</label><input type="text" name="orderNumber" value="' + esc(r.order_number || '') + '"></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes" value="' + esc(r.notes || '') + '"></div>' +
            // Reason required when the amount, qty or discount actually changes (Ren's spec 126) -- enforced again by update_pos_sale_item().
            '<div class="field"><label>Reason (required if amount, qty or discount changes)</label><input type="text" name="reason"></div>' +
            '<div class="field"><label>What went wrong?</label><select name="errorType">' + errorTypeOptions('Wrong Amount') + '</select></div>' +
          '</div>' +
          '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn" type="submit">Save Changes</button>' +
            '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
          '</div>' +
        '</form>';
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', back);
      container.querySelector('#pos-edit-item-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const sku = f.sku.value.trim(), qty = Number(f.qty.value);
        const unitPrice = f.unitPrice.value === '' ? null : Number(f.unitPrice.value);
        const discount = Number(f.discount.value || 0);
        const reason = f.reason.value.trim();
        if (!sku) return void setFormErr(container, 'SKU is required.', f.sku);
        if (!Number.isInteger(qty) || qty <= 0) return void setFormErr(container, 'Qty must be a whole number of 1 or more.', f.qty);
        if (unitPrice == null || unitPrice < 0) return void setFormErr(container, 'Enter the price (0 or more).', f.unitPrice);
        if (discount < 0) return void setFormErr(container, 'The discount cannot be negative.', f.discount);
        if (discount > qty * unitPrice + 0.005) return void setFormErr(container, 'The discount is more than the line total.', f.discount);
        const skuChanged = sku !== r.sku;
        const amountChanged = num(r.unit_price) !== unitPrice || Number(r.qty) !== qty || num(r.discount) !== discount;
        if ((amountChanged || skuChanged) && !reason) return void setFormErr(container, 'A reason is required when changing the SKU, amount, quantity or discount.', f.reason);
        if (amountChanged && !await confirmDialog({ title: 'Confirm the change?', message: 'Old line total: ' + money(lineNet(r)) + '\nNew line total: ' + money(r2(unitPrice * qty - discount)) +
          '\nDifference: ' + money(r2(unitPrice * qty - discount - lineNet(r))) + '\n\nReason: ' + reason, confirmLabel: 'Save change' })) return;
        const save = f.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          await updatePosSaleItem({ movementId: r.id, sku, qty, unitPrice, customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(),
            orderNumber: f.orderNumber.value.trim(), notes: f.notes.value.trim(), reason, discount, discountReason: f.discountReason.value.trim() });
          let warn = '';
          if (amountChanged || skuChanged) {
            try {
              await logBranchErrorCorrection({ module: 'POS', recordTable: 'pos_sale', recordId: g.groupId, errorType: f.errorType.value, reason,
                oldValue: skuChanged ? r.sku : money(lineNet(r)), newValue: skuChanged ? sku : money(r2(unitPrice * qty - discount)) });
            } catch (e) { warn = ' (The kind of mistake could not be filed: ' + friendlyError(String(e.message || e)) + ')'; }
          }
          notify('Sale item updated.' + warn, !!warn);
          detailMode = null;
          await load();
          if (!$('pos-detail-drawer').classList.contains('open') || detailMode === null) openDetail(g.groupId);
        } catch (err) {
          setFormErr(container, String(err.message || err));
          save.disabled = false;
        }
      });
    }));

    // ---- edit the whole payment split (the amounts the store actually kept) ----
    container.querySelector('[data-act="edit-payment"]')?.addEventListener('click', () => {
      detailMode = 'edit-pay';
      const total = groupSubtotal(g);
      container.innerHTML =
        '<form id="pos-edit-payment-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' + formErr +
          '<div class="drawer-section"><h4>Payment Split</h4>' +
            '<p class="muted" style="font-size:12px;margin:0 0 6px;">Enter the amounts the store actually kept (the sale total is ' + money(total) + '). Replacing the split moves each amount to its method in one step.</p>' +
            '<div id="pos-editpay-rows"></div>' +
            '<div class="field"><label>Reason *</label><input type="text" name="paymentReason"></div>' +
            '<div class="field"><label>What went wrong?</label><select name="errorType">' + errorTypeOptions('Wrong Payment') + '</select></div>' +
          '</div>' +
          '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn" type="submit">Save Payment</button>' +
            '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
          '</div>' +
        '</form>';
      const rowsBox = container.querySelector('#pos-editpay-rows');
      rowsBox.innerHTML = paymentRowsHtml({ recorder: employee.full_name || 'you', methods: POS_PAYMENT_METHODS, proof: false, labelOf: posMethodLabel });
      const sale0 = manilaDateStr(g.items[0].sale_date);
      const epay = mountPaymentRows(rowsBox, { getDue: () => total, getMinDate: () => sale0, minDateLabel: 'sale date', dueLabel: 'Sale total', followDue: false, refRequired: (m) => POS_REF_REQUIRED.includes(m) });
      epay.load((posPaymentsByGroup[g.groupId] || []).map((p) => ({ method: p.payment_method, amount: p.amount, reference: p.reference_number || '', paidAt: p.paid_at || sale0 })));
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', back);
      container.querySelector('#pos-edit-payment-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const read = epay.read();
        if (read.error) return void setFormErr(container, read.error, read.el);
        if (!read.payments.length) return void setFormErr(container, 'At least one payment method and amount is required.');
        const reason = f.paymentReason.value.trim();
        if (!reason) return void setFormErr(container, 'A reason is required to change a sale\'s payment method.', f.paymentReason);
        const oldSummary = (posPaymentsByGroup[g.groupId] || []).map((p) => posMethodLabel(p.payment_method) + ' ' + money(p.amount)).join(', ') || '—';
        const newSummary = read.payments.map((p) => posMethodLabel(p.method) + ' ' + money(p.amount)).join(', ');
        if (!await confirmDialog({ title: 'Confirm the payment change?', message: 'Old: ' + oldSummary + '\nNew: ' + newSummary + '\n\nReason: ' + reason, confirmLabel: 'Save payment' })) return;
        const save = f.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          await updatePosSalePayments(g.groupId, read.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, paidAt: p.paidAt })), reason);
          let warn = '';
          try { await logBranchErrorCorrection({ module: 'POS', recordTable: 'pos_sale', recordId: g.groupId, errorType: f.errorType.value, reason, oldValue: oldSummary, newValue: newSummary }); }
          catch (e) { warn = ' (The kind of mistake could not be filed: ' + friendlyError(String(e.message || e)) + ')'; }
          notify('Payment updated.' + warn, !!warn);
          detailMode = null;
          await load();
          openDetail(g.groupId);
        } catch (err) {
          setFormErr(container, String(err.message || err));
          save.disabled = false;
        }
      });
    });

    // ---- add a payment (the balance of a credit sale, collected later) ----
    container.querySelector('[data-act="add-payment"]')?.addEventListener('click', () => {
      detailMode = 'add-pay';
      const balance = groupBalance(g), sale0 = manilaDateStr(g.items[0].sale_date);
      container.innerHTML =
        '<form id="pos-add-payment-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' + formErr +
          '<div class="drawer-section"><h4>Add Payment</h4>' +
            '<p class="muted" style="font-size:12px;margin:0 0 6px;">Balance still owed: <b>' + money(balance) + '</b>. COD is collected with Mark Collected on the sale.</p>' +
            '<div id="pos-addpay-rows"></div>' +
            '<div class="field"><label>Notes (optional)</label><input type="text" name="payNotes"></div>' +
          '</div>' +
          '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn" type="submit">Save Payment</button>' +
            '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
          '</div>' +
        '</form>';
      const rowsBox = container.querySelector('#pos-addpay-rows');
      rowsBox.innerHTML = paymentRowsHtml({ recorder: employee.full_name || 'you', max: 1, methods: POS_PAYMENT_METHODS.filter((m) => m !== 'COD'), proof: false, labelOf: posMethodLabel });
      const apay = mountPaymentRows(rowsBox, { getDue: () => balance, getMinDate: () => sale0, minDateLabel: 'sale date', dueLabel: 'Balance', allowOver: true, refRequired: (m) => POS_REF_REQUIRED.includes(m) });
      apay.sync();
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', back);
      container.querySelector('#pos-add-payment-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const read = apay.read();
        if (read.error) return void setFormErr(container, read.error, read.el);
        if (!read.payments.length) return void setFormErr(container, 'Enter the amount paid.', rowsBox.querySelector('[data-f="amount"]'));
        const p = read.payments[0];
        const save = f.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          await addPosSalePayment({ saleGroupId: g.groupId, method: p.method, amount: p.amount, reference: p.reference, paidAt: p.paidAt, notes: f.payNotes.value.trim() });
          notify('Payment added.', false);
          detailMode = null;
          await load();
          openDetail(g.groupId);
        } catch (err) {
          setFormErr(container, String(err.message || err));
          save.disabled = false;
        }
      });
    });

    // ---- request a refund: it goes to the existing Refund Management ----
    container.querySelector('[data-act="request-refund"]')?.addEventListener('click', async () => {
      const first = g.items[0];
      if (!first.order_number) { notify('This sale has no Order / Ref No. — add one (Edit) so the refund can be linked to it.', true); return; }
      detailMode = 'refund';
      let reasons = [];
      try { reasons = await listRefundReasons(); } catch (e) { reasons = ['Other']; }
      const pays = posPaymentsByGroup[g.groupId] || [];
      const main = pays.slice().sort((a, b) => num(b.amount) - num(a.amount))[0];
      const defMethod = main && REFUND_METHODS.includes(main.payment_method) ? main.payment_method : 'Original Payment Method';
      container.innerHTML =
        '<form id="pos-refund-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' + formErr +
          '<div class="drawer-section"><h4>Request Refund — Order #' + esc(first.order_number) + '</h4>' +
            '<p class="muted" style="font-size:12px;margin:0 0 6px;">This is filed in Refund Management, where it is approved and paid. The sale itself is not changed.</p>' +
            '<label style="font-size:12px;font-weight:600;">What is being refunded</label>' +
            g.items.map((r, i) => '<label class="pos-check" style="display:flex;"><input type="checkbox" name="item" value="' + i + '" checked> ' + esc(r.products?.item_name || r.sku) + ' <span class="muted">(' + esc(r.sku) + ' · ' + r.qty + ' × · ' + money(lineNet(r)) + ')</span></label>').join('') +
            '<div class="field"><label>Refund amount (₱) *</label><input type="number" name="amount" step="0.01" min="0" inputmode="decimal"></div>' +
            '<div class="field"><label>Refund method *</label><select name="method">' + REFUND_METHODS.map((m) => '<option' + (m === defMethod ? ' selected' : '') + '>' + m + '</option>').join('') + '</select></div>' +
            '<div class="field"><label>Reason *</label><select name="category"><option value="">— choose —</option>' + reasons.map((r) => '<option>' + esc(r) + '</option>').join('') + '</select></div>' +
            '<div class="field"><label>Details (optional)</label><input type="text" name="details" placeholder="What happened?"></div>' +
            '<div class="sc-row2"><div class="field"><label>Account name (for transfers)</label><input type="text" name="accountName"></div>' +
              '<div class="field"><label>Account number</label><input type="text" name="accountNumber"></div></div>' +
          '</div>' +
          '<div class="drawer-section" style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn" type="submit">File Refund Request</button>' +
            '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' +
          '</div>' +
        '</form>';
      const rf = container.querySelector('#pos-refund-form');
      const checked = () => [...rf.querySelectorAll('input[name="item"]:checked')].map((c) => g.items[Number(c.value)]);
      const sumChecked = () => r2(checked().reduce((s, r) => s + lineNet(r), 0));
      rf.amount.value = sumChecked() ? sumChecked().toFixed(2) : '';
      rf.querySelectorAll('input[name="item"]').forEach((c) => c.addEventListener('change', () => { rf.amount.value = sumChecked() ? sumChecked().toFixed(2) : ''; }));
      container.querySelector('[data-act="cancel-edit"]').addEventListener('click', back);
      let dupAck = false;
      rf.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const amount = Number(rf.amount.value);
        if (!(amount > 0)) return void setFormErr(container, 'Enter the amount to refund (more than ₱0).', rf.amount);
        if (!rf.category.value) return void setFormErr(container, 'Choose the reason for the refund.', rf.category);
        const lines = checked();
        const itemsSum = sumChecked();
        const save = rf.querySelector('button[type=submit]');
        save.disabled = true;
        try {
          const res = await createRefundRequest({
            order_reference: first.order_number, customer_name: first.customer_name || 'Walk-in customer', customer_contact: first.contact_number || null,
            refund_amount: amount, refund_method: rf.method.value, reason_category: rf.category.value, reason: rf.details.value.trim() || null,
            requested_date: manilaToday(), branch_id: first.branch_id, account_name: rf.accountName.value.trim() || null, account_number: rf.accountNumber.value.trim() || null,
            items: lines.map((r) => ({ sku: r.sku, item_name: r.products?.item_name || r.sku, quantity: r.qty, unit_price: r.unit_price, refund_amount: amount + 0.004 >= itemsSum ? lineNet(r) : 0 })),
            duplicate_ack: dupAck,
          });
          if (res && res.ok) {
            notify('Refund request ' + (res.refund_request_number || '') + ' filed — it is waiting for approval in Refund Management.', false);
            detailMode = null;
            openDetail(g.groupId);
            return;
          }
          if (res && res.duplicate) {
            save.disabled = false;
            if (await confirmDialog({ title: 'Possible duplicate refund request', message: 'A similar refund request already exists for this order. File this one anyway?', confirmLabel: 'File anyway' })) { dupAck = true; rf.requestSubmit(); }
            return;
          }
          setFormErr(container, ((res && res.errors) || ['The refund request could not be filed.']).join(' '));
          save.disabled = false;
        } catch (err) {
          setFormErr(container, String(err.message || err));
          save.disabled = false;
        }
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Filters, live updates, views
  // ---------------------------------------------------------------------------------------------
  const rerender = () => { pg.page = 1; render(); };
  $('pos-f-search').addEventListener('input', rerender);
  ['pos-f-show', 'pos-f-method', 'pos-f-admin'].forEach((id) => $(id).addEventListener('change', rerender));
  // The date range changes the rows that are loaded (the ledger and the summary both come from the database for that range).
  let rangeTimer = null;
  const onRangeChange = () => { clearTimeout(rangeTimer); rangeTimer = setTimeout(() => { pg.page = 1; load(); }, 60); };
  $('pos-f-from').addEventListener('change', onRangeChange);
  $('pos-f-to').addEventListener('change', onRangeChange);
  $('pos-f-clear').addEventListener('click', () => {
    $('pos-f-search').value = '';
    $('pos-f-show').value = 'all'; $('pos-f-method').value = 'all'; $('pos-f-admin').value = 'all';
    rerender(); // the date range is the page's global range -- not cleared here
  });
  wireSortControl('pos-sort-field', 'pos-sort-dir', sort, render);

  const unsubscribe = subscribeToChanges(['sales_inventory_movements', 'sale_payments', 'branch_record_requests', 'refunds'], load);
  await load();

  // Needs Attention / summary-card click: narrow the ledger to what was clicked. These are "what is still open today" views, so they
  // look across all dates (the host widens the range).
  function applyView(view) {
    $('pos-f-search').value = ''; $('pos-f-method').value = 'all'; $('pos-f-admin').value = 'all';
    $('pos-f-show').value = SHOW_FILTERS.some(([k]) => k === view) ? view : 'all';
    pg.page = 1;
    render();
    if (view === 'requests') { const f = $('pos-requests-folder'); f.open = true; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    $('pos-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec 321) can open a sale's own Detail Drawer in place;
  // openDetailAsync also finds a sale outside the loaded date range. Both take the sale_group_id.
  return { reload: load, unsubscribe, openDetail, openDetailAsync, applyView };
}
