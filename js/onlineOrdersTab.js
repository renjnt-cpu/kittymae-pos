// Online Orders tab (Branches page) -- a branch-scoped view of the same Order & Item
// Status board that lives company-wide on movement.html (Record Movement), reusing
// its exact status-tab/search/history logic against api.js's branch-scoped query
// params (92_order_item_status_branch_scope.sql) instead of re-deriving it. Rows come
// from the pancake-webhook Edge Function (live) and the one-time pancake-backfill
// pull of Pancake's order history -- monitoring only, no manual Add here either.
// No Branch column (unlike movement.html's board) since every row shown is already
// scoped to the one currently-selected branch.
import {
  listOrderItemStatuses, listOrderHistoryForItem, getOrderItemStatusCounts, listDeliveredOrders,
  ORDER_ITEM_STATUS_ROW_CAP, setOrderItemStatus, deleteOrderItemStatus, subscribeToChanges,
} from './api.js?v=20260923f';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber } from './uiKit.js?v=20260923f';

// Global Filter + Sort rules (Ren, 2026-09-21, section 37): replaces this board's old
// per-column header-click sort, which silently stopped working on mobile once a
// board's table collapses to header-less cards below 760px (section 7) -- one Sort
// control now drives both. "Default" has no comparator below, so it's a deliberate
// no-op that preserves the API's own (already recency-ordered) row order, same as
// this board's original unsorted state.
const OL_SORT_FIELDS = [
  { key: 'default', label: 'Default (most recent)' }, { key: 'item_name', label: 'Item' }, { key: 'qty', label: 'Qty' },
  { key: 'status', label: 'Status' }, { key: 'order_reference', label: 'Order / Customer' }, { key: 'notes', label: 'Notes / By' },
];
const OL_SORT_COMPARATORS = {
  item_name: byText('item_name'), qty: byNumber('qty'), status: byText('status'),
  order_reference: byText('order_reference'), notes: byText('notes'),
};

// Delivered is a terminal status, always excluded from the working board above (see
// listOrderItemStatuses()'s TERMINAL_STATUSES filter) -- there are 40,000+ historical
// rows after the Pancake backfill, most of them long-delivered, so Ren asked to only
// ever show Delivered from this date onwards rather than the full history.
const DELIVERED_FROM_DATE = '2026-09-01';

// Same confirmed Pancake status_name -> tab mapping as movement.html (see that file's
// comment for how these were derived) -- kept in sync by hand since each app has its
// own copy of this module.
const PANCAKE_STATUS_TABS = [
  { label: 'New', keys: ['new'] },
  { label: 'Pending Confirmation', keys: ['pending'] },
  { label: 'Awaiting Stock', keys: ['waitting'] },
  { label: 'Ordered', keys: ['ordered'] },
  { label: 'Confirmed', keys: ['confirmed'] },
  { label: 'Awaiting Print', keys: ['wait_print'] },
  { label: 'Printed', keys: ['printed'] },
  { label: 'Packing', keys: ['packing'] },
];
const PANCAKE_MAPPED_KEYS = new Set(PANCAKE_STATUS_TABS.flatMap((t) => t.keys));

function prettyStatus(raw) {
  return String(raw || '').split('_').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ') || 'Unknown';
}
function statusBadgeClass(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel') || s.includes('return') || s.includes('fail')) return 'low';
  if (s.includes('ship') || s.includes('deliver') || s.includes('complet') || s.includes('done')) return 'ok';
  if (s.includes('wait') || s.includes('pending') || s.includes('new') || s.includes('submit')) return 'pending';
  return 'transit';
}
function historyKey(r) {
  const sku = String(r.sku || '').toLowerCase();
  if (sku && !sku.startsWith('pancake-item-')) return sku;
  return String(r.item_name || '').trim().toLowerCase();
}
const fmtDate = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// Pacific Mall (2) and APM Mall (4) -- view only for everyone but Admin here, per
// Ren's request (93_order_item_status_branch_admin_only.sql enforces the same rule
// server-side via RLS, so this is just keeping the UI from showing a control that
// would fail; every other branch keeps the normal any-employee-updates behavior).
const ADMIN_ONLY_EDIT_BRANCHES = [2, 4];

/** Mounts the Online Orders board into `root` (an empty container this owns
 * entirely) scoped to `getBranchId()` at call time -- read as a function rather than
 * a fixed value so switching branches elsewhere on the page (branches.html's own
 * branch picker) doesn't require re-mounting, just a reload() call. `esc`/`toast` are
 * the page's own shell.js helpers; `msgId` is the id of the page's toast container.
 * `employee`: the signed-in employee record -- used for the Pacific Mall/APM Mall
 * edit restriction below.
 * Returns { reload } for the host page to call after a branch switch. Every
 * employee can browse any branch's online orders via the shared branch picker, same
 * as every other tab here (Ren, 2026-09-22: previously locked to an employee's own
 * branch since an online order carries a customer's name and phone number). */
export function initOnlineOrdersTab({ root, esc, toast, msgId, getBranchId, onCountsUpdate, employee }) {
  const isAdmin = employee.role === 'Admin';
  const canEdit = () => isAdmin || !ADMIN_ONLY_EDIT_BRANCHES.includes(getBranchId());
  const sort = { field: 'default', dir: 'desc' };
  // Summary tiles -> Search & Filters -> active-filter strip -> Status tabs ->
  // Records (Ren's MASTER UI rule 2), all from the same filtered rows.
  root.innerHTML =
    '<div class="tiles" id="ol-tiles"></div>' +
    '<div class="card" style="margin-bottom:14px;">' +
      '<h3 style="margin-top:0;">Search &amp; Filter</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="ol-search" placeholder="Item, SKU, order #, customer, or notes…"></div>' +
        '<div class="field"><label>From</label><input type="date" id="ol-f-from"></div>' +
        '<div class="field"><label>To</label><input type="date" id="ol-f-to"></div>' +
        sortControlHtml(OL_SORT_FIELDS, sort, 'ol-sort-field', 'ol-sort-dir') +
        '<button type="button" class="btn small secondary" id="ol-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="ol-active"></div>' +
    '<div id="ol-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"></div>' +
    '<div id="ol-list" style="margin-top:10px;"><div class="muted">Loading…</div></div>';

  let orderItems = [];
  let statusCounts = { all: 0 };
  let statusFilter = 'all';
  let search = '';
  let fFrom = '';
  let fTo = '';
  let searchTimer = null;

  function tabKeysFor(filterId) {
    if (filterId === 'all') return null;
    const mapped = PANCAKE_STATUS_TABS.find((t) => t.label === filterId);
    return mapped ? mapped.keys : [filterId];
  }

  // Substring match against the same fields listOrderItemStatuses()'s server-side
  // search covers -- used client-side only for the Delivered tab, since
  // listDeliveredOrders() is a small, deliberately narrow query (one status, one
  // date-bounded range) that doesn't need its own server-side search plumbing.
  function matchesSearch(r, term) {
    const t = term.toLowerCase();
    return (r.item_name || '').toLowerCase().includes(t) || (r.sku || '').toLowerCase().includes(t) ||
      (r.order_reference || '').toLowerCase().includes(t) || (r.customer_name || '').toLowerCase().includes(t) ||
      (r.notes || '').toLowerCase().includes(t);
  }

  async function load() {
    const branchId = getBranchId();
    try {
      if (statusFilter === 'delivered') {
        // fFrom can only narrow the Delivered tab's own Sep-2026-onward floor, never
        // widen it further back -- DELIVERED_FROM_DATE stays the hard limit.
        const effectiveFrom = fFrom && fFrom > DELIVERED_FROM_DATE ? fFrom : DELIVERED_FROM_DATE;
        let items = await listDeliveredOrders({ branchId, fromDate: effectiveFrom, toDate: fTo || null });
        if (search) items = items.filter((r) => matchesSearch(r, search));
        orderItems = items;
        render();
        return;
      }
      const [items, counts] = await Promise.all([
        listOrderItemStatuses({ statusKeys: tabKeysFor(statusFilter), search, branchId, fromDate: fFrom || null, toDate: fTo || null }),
        getOrderItemStatusCounts(branchId),
      ]);
      orderItems = items;
      statusCounts = counts;
      if (onCountsUpdate) onCountsUpdate(statusCounts.all);
      render();
    } catch (err) {
      document.getElementById('ol-list').innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

  document.getElementById('ol-search').addEventListener('input', (ev) => {
    search = ev.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  document.getElementById('ol-f-from').addEventListener('change', (ev) => { fFrom = ev.target.value; load(); });
  document.getElementById('ol-f-to').addEventListener('change', (ev) => { fTo = ev.target.value; load(); });
  document.getElementById('ol-f-clear').addEventListener('click', () => {
    document.getElementById('ol-search').value = '';
    document.getElementById('ol-f-from').value = '';
    document.getElementById('ol-f-to').value = '';
    search = ''; fFrom = ''; fTo = ''; statusFilter = 'all'; // every supported filter, in one go (MASTER UI rule 9)
    load();
  });
  wireSortControl('ol-sort-field', 'ol-sort-dir', sort, render);

  // Debounced for the same reason as movement.html's board -- a single pancake-resync
  // pass can upsert hundreds of rows in a burst, and Realtime fires once per row.
  let realtimeReloadTimer = null;
  const unsubscribe = subscribeToChanges('order_item_status', () => {
    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(load, 800);
  });

  load();

  function render() {
    const distinctStatuses = Object.keys(statusCounts).filter((s) => s !== 'all').sort();
    const leftoverStatuses = distinctStatuses.filter((s) => !PANCAKE_MAPPED_KEYS.has(s));

    const tabs = document.getElementById('ol-tabs');
    const countFor = (keys) => keys === null ? statusCounts.all :
      keys.reduce((sum, k) => sum + (statusCounts[k] || 0), 0);
    const tabBtn = (id, label, keys) =>
      '<button type="button" class="btn small' + (statusFilter === id ? '' : ' secondary') + '" data-ol-tab="' + esc(id) + '">' +
        esc(label) + ' <span class="muted" style="font-weight:normal;">' + countFor(keys) + '</span></button>';
    const deliveredBtn = '<button type="button" class="btn small' + (statusFilter === 'delivered' ? '' : ' secondary') + '" data-ol-tab="delivered">Delivered <span class="muted" style="font-weight:normal;">(Sep 2026+)</span></button>';
    tabs.innerHTML = tabBtn('all', 'All', null) +
      PANCAKE_STATUS_TABS.map((t) => tabBtn(t.label, t.label, t.keys)).join('') +
      leftoverStatuses.map((s) => tabBtn(s, prettyStatus(s), [s])).join('') +
      deliveredBtn;
    tabs.querySelectorAll('[data-ol-tab]').forEach((btn) => btn.addEventListener('click', () => {
      statusFilter = btn.dataset.olTab;
      load();
    }));

    let rows = orderItems;
    const list = document.getElementById('ol-list');
    const truncated = rows.length >= ORDER_ITEM_STATUS_ROW_CAP;
    // Summary tiles sit above the filter card (MASTER UI rules 2/3) and always show
    // the same filtered rows as the list -- including when that's zero.
    const tile = (num, label) => '<div class="tile"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
    document.getElementById('ol-tiles').innerHTML =
      tile(rows.length + (truncated ? '+' : ''), 'Items' + (search ? ' (filtered)' : '')) +
      tile(new Set(rows.map((r) => r.order_reference).filter(Boolean)).size + (truncated ? '+' : ''), 'Orders') +
      tile(rows.reduce((s, r) => s + Number(r.qty || 0), 0) + (truncated ? '+' : ''), 'Qty Subtotal');
    const activeEl = document.getElementById('ol-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(search) }, { label: 'From', value: esc(fFrom) }, { label: 'To', value: esc(fTo) },
      { label: 'Status', value: statusFilter === 'all' ? '' : esc(statusFilter === 'delivered' ? 'Delivered' : prettyStatus(statusFilter)) },
    ], 'ol-f-clear');
    wireProxyButtons(activeEl);
    if (!rows.length) {
      list.innerHTML = emptyStateHtml({
        message: statusFilter === 'delivered'
          ? 'No delivered orders for this branch from September 2026 onwards' + (search ? ' matching "' + esc(search) + '"' : '') + '.'
          : 'No online orders match this search/filter for this branch.',
        hasFilters: !!(search || fFrom || fTo || statusFilter !== 'all'), clearId: 'ol-f-clear',
      });
      wireProxyButtons(list);
      return;
    }

    // Filtering already picked `rows` above; sort only reorders them for display
    // (section 11) -- via the shared Sort control in the filter card, not a per-column
    // header click (which would be invisible once this table collapses to cards).
    rows = applySort(rows, sort, OL_SORT_COMPARATORS);

    // distinctStatuses comes from the active-board aggregate, which excludes every
    // terminal status (including "delivered") -- so a Delivered-tab row's own current
    // status must be added in by hand, or its dropdown would silently default to
    // whatever option happens to sort first instead of showing "Delivered".
    const statusOptionsFor = (current) => {
      const opts = distinctStatuses.includes(current) ? distinctStatuses : [...distinctStatuses, current].sort();
      return opts.map((s) => '<option value="' + esc(s) + '"' + (s === current ? ' selected' : '') + '>' + esc(prettyStatus(s)) + '</option>').join('');
    };
    // The KPI tiles themselves now render into #ol-tiles above the filter card (see
    // the top of render()); only the row-cap note stays with the list.
    const subtotalLine = truncated ? '<p class="muted" style="margin:0 0 6px;color:#b45309;">Showing the ' + ORDER_ITEM_STATUS_ROW_CAP + ' most recent; search to narrow further.</p>' : '';

    const topCounts = new Map();
    rows.forEach((r) => {
      const key = historyKey(r);
      const entry = topCounts.get(key) || {
        item_name: r.item_name,
        sku: (r.sku && !r.sku.toLowerCase().startsWith('pancake-item-')) ? r.sku : null,
        orders: 0, qty: 0,
      };
      entry.orders += 1;
      entry.qty += Number(r.qty || 0);
      topCounts.set(key, entry);
    });
    const top5 = [...topCounts.values()].sort((a, b) => b.orders - a.orders).slice(0, 5);
    const filtered = statusFilter !== 'all' || search;
    const top5Line = top5.length ? (
      '<div style="background:#f6f6f6;border-radius:8px;padding:10px 14px;margin-bottom:10px;">' +
        '<div style="font-weight:600;font-size:12px;margin-bottom:6px;">Top ' + top5.length + ' Products — Most Orders' +
          (filtered ? ' <span class="muted" style="font-weight:normal;">(current filter)</span>' : '') +
          (truncated ? ' <span class="muted" style="font-weight:normal;">(from the ' + ORDER_ITEM_STATUS_ROW_CAP + ' most recent)</span>' : '') + '</div>' +
        '<ol style="margin:0;padding-left:18px;font-size:12px;">' +
          top5.map((t) => '<li>' + esc(t.item_name) + (t.sku ? ' <span class="muted">(' + esc(t.sku) + ')</span>' : '') +
            ' — <strong>' + t.orders + '</strong> order' + (t.orders === 1 ? '' : 's') + ' <span class="muted">· Qty ' + t.qty + '</span></li>').join('') +
        '</ol>' +
      '</div>'
    ) : '';

    const editable = canEdit();
    list.innerHTML = top5Line + subtotalLine +
      (editable ? '' : '<p class="muted" style="margin:0 0 6px;">View only for this branch — only Admin can change status or delete here.</p>') +
      // table-2col (not table-mini -- that's for genuinely short 3-column tables like
      // Scrap/Subasta's Current Balance) since this has 6 columns with multi-line
      // content (Item+SKU, Order/Customer, Notes/By), the same shape that broke into
      // letter-per-line headers on Layaway's status tables before that fix.
      '<div class="table-scroll table-2col"><table><thead><tr>' +
        '<th>Item</th><th>Qty</th><th>Status</th><th>Order / Customer</th><th>Notes / By</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map((r) =>
        '<tr>' +
          '<td data-label="Item" class="full-row">' +
            '<button type="button" class="exp-row-btn" data-history-toggle="' + r.id + '" data-history-sku="' + esc(r.sku || '') + '" data-history-name="' + esc(r.item_name) + '" aria-expanded="false">' +
              '<span class="exp-arrow" aria-hidden="true">▸</span>' +
              '<strong style="text-decoration:underline;text-decoration-style:dotted;">' + esc(r.item_name) + '</strong>' +
            '</button>' +
            (r.sku ? '<div class="muted" style="font-size:11px;">' + esc(r.sku) + '</div>' : '') +
          '</td>' +
          '<td data-label="Qty">' + r.qty + '</td>' +
          '<td data-label="Status">' +
            (editable
              ? '<select data-status-for="' + r.id + '" class="badge ' + statusBadgeClass(r.status) + '" style="border:none;font:inherit;">' + statusOptionsFor(r.status) + '</select>'
              : '<span class="badge ' + statusBadgeClass(r.status) + '">' + esc(prettyStatus(r.status)) + '</span>') +
          '</td>' +
          '<td data-label="Order / Customer" class="full-row" style="font-size:11px;">' + esc(r.order_reference || '—') + (r.customer_name ? '<div class="muted">' + esc(r.customer_name) + '</div>' : '') + '</td>' +
          '<td data-label="Notes / By" class="full-row" style="font-size:11px;">' + esc(r.notes || '') +
            (r.creator ? '<div class="muted" style="font-size:10px;">Added by ' + esc(r.creator.full_name) + '</div>' : '') +
          '</td>' +
          '<td class="full-row">' + (editable ? '<button class="btn small secondary" type="button" data-delete-id="' + r.id + '">Delete</button>' : '') + '</td>' +
        '</tr>' +
        '<tr class="history-row" data-history-for="' + r.id + '" style="display:none;"><td colspan="6" class="full-row"></td></tr>'
      ).join('') +
      '</tbody></table></div>';

    list.querySelectorAll('[data-status-for]').forEach((sel) => sel.addEventListener('change', async () => {
      const id = sel.dataset.statusFor;
      sel.disabled = true;
      try {
        await setOrderItemStatus(id, sel.value);
        toast(msgId, 'Status updated.', false);
        await load();
      } catch (err) {
        toast(msgId, String(err.message || err), true);
        sel.disabled = false;
      }
    }));
    list.querySelectorAll('[data-delete-id]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Delete this item?')) return;
      try {
        await deleteOrderItemStatus(btn.dataset.deleteId);
        toast(msgId, 'Deleted.', false);
        await load();
      } catch (err) {
        toast(msgId, String(err.message || err), true);
      }
    }));
    list.querySelectorAll('[data-history-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      toggleHistory(btn.dataset.historyToggle, btn.dataset.historySku, btn.dataset.historyName);
    }));
  }

  async function toggleHistory(id, sku, itemName) {
    const row = document.querySelector('tr[data-history-for="' + id + '"]');
    const isOpen = row.style.display !== 'none';
    document.querySelectorAll('.history-row').forEach((r) => { r.style.display = 'none'; r.querySelector('td').innerHTML = ''; });
    // Accordion-style (only one item's history open at a time) -- every trigger's
    // caret resets, then the one just opened (if any) flips back to expanded.
    document.querySelectorAll('[data-history-toggle]').forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
    if (isOpen) return;
    document.querySelector('[data-history-toggle="' + id + '"]')?.setAttribute('aria-expanded', 'true');
    row.style.display = '';
    row.querySelector('td').innerHTML = '<div class="muted" style="padding:8px 4px;">Loading history…</div>';
    let matches;
    try {
      matches = await listOrderHistoryForItem({ sku, itemName });
    } catch (err) {
      row.querySelector('td').innerHTML = '<div class="msg error" style="margin:8px 4px;">' + esc(err.message || err) + '</div>';
      return;
    }
    row.querySelector('td').innerHTML =
      '<div style="padding:8px 4px;">' +
        '<div class="muted" style="font-size:11px;margin-bottom:6px;">' + matches.length + ' order' + (matches.length === 1 ? '' : 's') + ' for this item, across every status and branch</div>' +
        '<div class="table-scroll table-2col"><table><thead><tr><th>Order / Customer</th><th>Status</th><th>Qty</th><th>Notes</th><th>Date</th></tr></thead><tbody>' +
        matches.map((m) =>
          '<tr>' +
            '<td data-label="Order / Customer" class="full-row">' + esc(m.order_reference || '—') + (m.customer_name ? '<div class="muted" style="font-size:11px;">' + esc(m.customer_name) + '</div>' : '') + '</td>' +
            '<td data-label="Status"><span class="badge ' + statusBadgeClass(m.status) + '">' + esc(prettyStatus(m.status)) + '</span></td>' +
            '<td data-label="Qty">' + m.qty + '</td>' +
            '<td data-label="Notes" class="full-row" style="font-size:11px;">' + esc(m.notes || '—') + '</td>' +
            '<td data-label="Date" style="font-size:11px;white-space:nowrap;">' + fmtDate(m.created_at) + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div>' +
      '</div>';
  }

  return { reload: load, unsubscribe };
}
