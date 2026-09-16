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
} from './api.js';

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

// Same branch-scope group as layawayTab.js's UNSCOPED_POSITIONS (kept in sync by
// hand, same reasoning): Admin/Manager and this position group can browse any
// branch's online orders via the page's branch picker like every other tab here.
// Everyone else only ever sees their OWN branch's online orders -- unlike
// POS/Scrap/Subasta, an online order carries a customer's name and phone number, so
// Ren asked this one tab to be locked down rather than left "view any branch."
const UNSCOPED_POSITIONS = ['Sales Executive', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

/** Mounts the Online Orders board into `root` (an empty container this owns
 * entirely) scoped to `getBranchId()` at call time -- read as a function rather than
 * a fixed value so switching branches elsewhere on the page (branches.html's own
 * branch picker) doesn't require re-mounting, just a reload() call. `esc`/`toast` are
 * the page's own shell.js helpers; `msgId` is the id of the page's toast container.
 * `employee`: the signed-in employee record -- used both for the Pacific Mall/APM
 * Mall edit restriction below and to lock non-managers to their own branch (see
 * isViewRestricted/effectiveBranchId).
 * Returns { reload, isViewRestricted, ownBranchId } for the host page to call after a
 * branch switch and to know whether this tab ignores the shared branch picker. */
export function initOnlineOrdersTab({ root, esc, toast, msgId, getBranchId, onCountsUpdate, employee }) {
  const isAdmin = employee.role === 'Admin';
  const isViewRestricted = !['Admin', 'Manager'].includes(employee.role) && !UNSCOPED_POSITIONS.includes(employee.position);
  // Ignores the page-wide branch picker entirely for a restricted employee -- they
  // always see their own branch's online orders no matter which branch button is
  // highlighted for the other tabs.
  const effectiveBranchId = () => isViewRestricted ? employee.branch_id : getBranchId();
  const canEdit = () => isAdmin || !ADMIN_ONLY_EDIT_BRANCHES.includes(effectiveBranchId());
  root.innerHTML =
    (isViewRestricted ? '<p class="muted" style="margin-top:0;">Locked to your own branch — the branch buttons above only affect the other tabs here.</p>' : '') +
    '<div class="field" style="max-width:380px;"><label>Search</label><input type="text" id="ol-search" placeholder="Item, SKU, order #, customer, or notes…"></div>' +
    '<div id="ol-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"></div>' +
    '<div id="ol-list" style="margin-top:10px;"><div class="muted">Loading…</div></div>';

  let orderItems = [];
  let statusCounts = { all: 0 };
  let statusFilter = 'all';
  let search = '';
  let sortKey = null, sortDir = 'desc';
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
    const branchId = effectiveBranchId();
    try {
      if (statusFilter === 'delivered') {
        let items = await listDeliveredOrders({ branchId, fromDate: DELIVERED_FROM_DATE });
        if (search) items = items.filter((r) => matchesSearch(r, search));
        orderItems = items;
        render();
        return;
      }
      const [items, counts] = await Promise.all([
        listOrderItemStatuses({ statusKeys: tabKeysFor(statusFilter), search, branchId }),
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
    if (!rows.length) {
      list.innerHTML = '<p class="muted">' + (statusFilter === 'delivered'
        ? 'No delivered orders for this branch from September 2026 onwards' + (search ? ' matching "' + esc(search) + '"' : '') + '.'
        : 'No online orders match this search/filter for this branch.') + '</p>';
      return;
    }

    if (sortKey) {
      const dirMul = sortDir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        const cmp = sortKey === 'qty' ? Number(av || 0) - Number(bv || 0) : String(av || '').localeCompare(String(bv || ''));
        return cmp * dirMul;
      });
    }

    const sortTh = (key, label) => {
      const active = sortKey === key;
      const arrow = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      return '<th><button type="button" class="btn small' + (active ? '' : ' secondary') + '" data-ol-sort="' + key + '" style="padding:2px 8px;">' + label + arrow + '</button></th>';
    };
    // distinctStatuses comes from the active-board aggregate, which excludes every
    // terminal status (including "delivered") -- so a Delivered-tab row's own current
    // status must be added in by hand, or its dropdown would silently default to
    // whatever option happens to sort first instead of showing "Delivered".
    const statusOptionsFor = (current) => {
      const opts = distinctStatuses.includes(current) ? distinctStatuses : [...distinctStatuses, current].sort();
      return opts.map((s) => '<option value="' + esc(s) + '"' + (s === current ? ' selected' : '') + '>' + esc(prettyStatus(s)) + '</option>').join('');
    };
    const truncated = rows.length >= ORDER_ITEM_STATUS_ROW_CAP;
    const subtotalQty = rows.reduce((s, r) => s + Number(r.qty || 0), 0);
    const subtotalLine = '<p class="muted" style="margin:0 0 6px;">' + rows.length + (truncated ? '+' : '') + ' item' + (rows.length === 1 && !truncated ? '' : 's') +
      (search ? ' matching "' + esc(search) + '"' : '') + ' · Qty subtotal: <strong>' + subtotalQty + (truncated ? '+' : '') + '</strong>' +
      (truncated ? ' <span style="color:#b45309;">— showing the ' + ORDER_ITEM_STATUS_ROW_CAP + ' most recent; search to narrow further</span>' : '') +
      '</p>';

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
      '<div class="table-scroll table-mini"><table><thead><tr>' +
        sortTh('item_name', 'Item') + sortTh('qty', 'Qty') + sortTh('status', 'Status') + sortTh('order_reference', 'Order / Customer') + sortTh('notes', 'Notes / By') + '<th></th>' +
      '</tr></thead><tbody>' +
      rows.map((r) =>
        '<tr>' +
          '<td data-label="Item">' +
            '<button type="button" data-history-toggle="' + r.id + '" data-history-sku="' + esc(r.sku || '') + '" data-history-name="' + esc(r.item_name) + '" ' +
              'style="background:none;border:none;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer;">' +
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
          '<td data-label="Order / Customer" style="font-size:11px;">' + esc(r.order_reference || '—') + (r.customer_name ? '<div class="muted">' + esc(r.customer_name) + '</div>' : '') + '</td>' +
          '<td data-label="Notes / By" style="font-size:11px;">' + esc(r.notes || '') +
            (r.creator ? '<div class="muted" style="font-size:10px;">Added by ' + esc(r.creator.full_name) + '</div>' : '') +
          '</td>' +
          '<td>' + (editable ? '<button class="btn small secondary" type="button" data-delete-id="' + r.id + '">Delete</button>' : '') + '</td>' +
        '</tr>' +
        '<tr class="history-row" data-history-for="' + r.id + '" style="display:none;"><td colspan="6"></td></tr>'
      ).join('') +
      '</tbody></table></div>';

    list.querySelectorAll('[data-ol-sort]').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.olSort;
      if (sortKey === key) { sortDir = sortDir === 'desc' ? 'asc' : 'desc'; }
      else { sortKey = key; sortDir = 'desc'; }
      render();
    }));
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
    if (isOpen) return;
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
        '<div class="table-scroll"><table><thead><tr><th>Order / Customer</th><th>Status</th><th>Qty</th><th>Notes</th><th>Date</th></tr></thead><tbody>' +
        matches.map((m) =>
          '<tr>' +
            '<td data-label="Order / Customer">' + esc(m.order_reference || '—') + (m.customer_name ? '<div class="muted" style="font-size:11px;">' + esc(m.customer_name) + '</div>' : '') + '</td>' +
            '<td data-label="Status"><span class="badge ' + statusBadgeClass(m.status) + '">' + esc(prettyStatus(m.status)) + '</span></td>' +
            '<td data-label="Qty">' + m.qty + '</td>' +
            '<td data-label="Notes" style="font-size:11px;">' + esc(m.notes || '—') + '</td>' +
            '<td data-label="Date" style="font-size:11px;white-space:nowrap;">' + fmtDate(m.created_at) + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div>' +
      '</div>';
  }

  return { reload: load, unsubscribe, isViewRestricted, ownBranchId: employee.branch_id };
}
