// Global Branch Activity feed (Ren's spec 303-332) -- shared by both apps, mounted
// by the shell right after the header renders. Three surfaces, one data source:
//   1. a header bell with the unread count (328/329),
//   2. a compact floating panel of live notifications that queue, cap, and fade by
//      priority (311-317, 326/327) -- the upgraded home of the old "Forfeited
//      Layaways" box, which now sits in this panel's pinned slot (312),
//   3. an Activity History drawer with filters and Mark-as-read (319/320).
// Events arrive over the existing Supabase Realtime channel on activity_events; the
// rows themselves are written by database hooks inside the same transaction as the
// business write, so nothing can show up here that wasn't actually saved (324/325).
import { listActivity, activityUnreadCount, markActivityRead, markAllActivityRead, subscribeToChanges, getBranches } from './api.js?v=20260923p';

const FADE_MS = { normal: 10000, important: 18000, warning: 28000, critical: null };
const FADE_ANIM_MS = 420;
const money = (n) => n === null || n === undefined ? null : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const isMobile = () => window.matchMedia('(max-width:760px)').matches;
const maxVisible = () => isMobile() ? 2 : 4;

function relTime(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' minute' + (m === 1 ? '' : 's') + ' ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  return new Date(iso).toLocaleDateString('en-PH', { dateStyle: 'medium' });
}
const absTime = (iso) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

export async function initActivityFeed({ employee, headerEl, esc, links }) {
  let branchName = {};
  try { (await getBranches()).forEach((b) => { branchName[b.id] = b.name; }); } catch (e) { /* names are cosmetic */ }
  const bn = (id) => id == null ? '' : (branchName[id] || 'Branch #' + id);

  // ---- markup --------------------------------------------------------------
  const bell = document.createElement('button');
  bell.type = 'button'; bell.className = 'act-bell'; bell.id = 'act-bell'; bell.title = 'Activity';
  bell.innerHTML = '🔔<span class="act-badge" id="act-badge" hidden>0</span>';
  const who = headerEl.querySelector('.who');
  if (who) headerEl.insertBefore(bell, who); else headerEl.appendChild(bell);

  const panel = document.createElement('div');
  panel.className = 'act-panel'; panel.id = 'act-panel';
  panel.innerHTML =
    '<div class="act-panel-head"><span>ACTIVITY</span><button type="button" class="act-x-head" id="act-panel-close" aria-label="Dismiss">×</button></div>' +
    '<div id="act-pinned"></div>' +
    '<div id="act-live"></div>' +
    '<div class="act-panel-foot"><span id="act-more"></span><button type="button" class="act-link" id="act-viewall">View All Activity</button></div>';
  document.body.appendChild(panel);

  const drawerBackdrop = document.createElement('div');
  drawerBackdrop.className = 'drawer-backdrop'; drawerBackdrop.id = 'act-hist-backdrop';
  const drawer = document.createElement('div');
  drawer.className = 'drawer'; drawer.id = 'act-hist-drawer';
  drawer.innerHTML =
    '<div class="drawer-header"><h3>Activity History</h3><button type="button" class="drawer-close" id="act-hist-close" aria-label="Close">✕</button></div>' +
    '<div class="drawer-body">' +
      '<div class="act-filters">' +
        '<div class="field"><label>Module</label><select id="act-f-module"><option value="">All</option>' +
          ['POS', 'Layaway', 'Scrap', 'Subasta', 'Pull Out', 'Transfers', 'Movement', 'Refunds', 'SKU Catalog'].map((m) => '<option>' + m + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Branch</label><select id="act-f-branch"><option value="">All</option>' +
          Object.keys(branchName).map((id) => '<option value="' + id + '">' + esc(branchName[id]) + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Employee</label><input type="text" id="act-f-emp" placeholder="Name"></div>' +
        '<div class="field"><label>From</label><input type="date" id="act-f-from"></div>' +
        '<div class="field"><label>To</label><input type="date" id="act-f-to"></div>' +
        '<div class="field"><label>Action</label><input type="text" id="act-f-action" placeholder="e.g. Payment Added"></div>' +
        '<button type="button" class="btn small secondary" id="act-f-clear">Clear</button>' +
      '</div>' +
      '<div id="act-hist-list"><p class="muted">Loading…</p></div>' +
      '<div style="text-align:center;margin-top:10px;"><button type="button" class="btn small secondary" id="act-hist-more" style="display:none;">Load more</button></div>' +
    '</div>' +
    '<div class="drawer-footer">' +
      '<button type="button" class="btn small secondary" id="act-mark-all">Mark all as read</button>' +
      '<button type="button" class="btn small secondary" id="act-hist-close2">Close</button>' +
    '</div>';
  document.body.appendChild(drawerBackdrop);
  document.body.appendChild(drawer);

  const $ = (id) => document.getElementById(id);
  const pinnedSlot = $('act-pinned');
  const liveEl = $('act-live');

  // ---- state ----------------------------------------------------------------
  const seen = new Set();          // event ids already handled (318)
  const seenKeys = new Set();      // event_keys already handled (318)
  const visible = [];              // [{ev, el, timer}] currently on screen, newest first
  const pending = [];              // queued events, newest first (316/317)
  let unread = 0;
  let history = [];                // rows currently in the drawer
  let histOldest = null;
  let panelOpenByUser = false;     // Ren, 2026-09-22: a pinned warning must never pop
                                   // this open by itself -- only the bell (or a
                                   // genuinely new live toast, unchanged) does.

  // A pinned warning (e.g. Forfeited Layaways) has to surface on the bell somehow even
  // when there's no "unread" activity event behind it -- otherwise clicking the bell
  // to find it has no prompt at all now that it no longer pops itself open (Ren,
  // 2026-09-22). Falls back to the real unread count when nothing's pinned.
  function updateBadge() {
    const badge = $('act-badge');
    const pinnedShown = Array.from(pinnedSlot.children).some((c) => c.style.display !== 'none');
    if (pinnedShown) { badge.textContent = unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '!'; badge.hidden = false; }
    else { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = unread === 0; }
  }
  function refreshPanelVisibility() {
    const has = panelOpenByUser || visible.length > 0;
    panel.classList.toggle('show', has);
    $('act-more').textContent = pending.length ? '+ ' + pending.length + ' more' : '';
    updateBadge();
  }
  function togglePanel() { panelOpenByUser = !panelOpenByUser; refreshPanelVisibility(); }
  function closePanel() { panelOpenByUser = false; refreshPanelVisibility(); }
  function setUnread(n) {
    unread = Math.max(0, n);
    updateBadge();
  }

  // ---- rendering ------------------------------------------------------------
  function summaryLines(ev) {
    const d = ev.details || {};
    const lines = [];
    const push = (s) => { if (s) lines.push(s); };
    switch (ev.module) {
      case 'POS':
        push([ev.order_id ? 'Order #' + esc(ev.order_id) : null, ev.customer_name ? esc(ev.customer_name) : null].filter(Boolean).join(' · '));
        push([ev.sku ? esc(ev.sku) : null, money(ev.amount), ev.action === 'Created' ? esc(ev.new_value || d.payment || '') : null].filter(Boolean).join(' · '));
        if (ev.action !== 'Created' && ev.new_value) push(esc(ev.new_value));
        break;
      case 'Layaway':
        push([ev.customer_name ? esc(ev.customer_name) : null, ev.order_id ? 'Order ' + esc(ev.order_id) : null, ev.sku ? esc(ev.sku) : null].filter(Boolean).join(' · '));
        if (ev.action === 'Payment Added') {
          push(money(ev.amount) + (ev.new_value ? ' · ' + esc(ev.new_value) : ''));
          if (d.remaining != null) push('Remaining ' + money(d.remaining));
        } else if (ev.action === 'Amount Edited' || ev.action === 'Payment Deleted') {
          push(esc(ev.new_value || ev.previous_value || ''));
        } else {
          push([money(ev.amount) ? 'Total ' + money(ev.amount) : null, d.paid != null ? 'Paid ' + money(d.paid) : null].filter(Boolean).join(' · '));
        }
        break;
      case 'Scrap':
        push([d.metal ? esc(d.metal) : null, d.karat ? esc(d.karat) : null, d.weight_grams != null ? Number(d.weight_grams).toFixed(3) + 'g' : null].filter(Boolean).join(' '));
        push([money(ev.amount), ev.new_value ? esc(ev.new_value) : null, ev.status ? esc(ev.status) : null].filter(Boolean).join(' · '));
        break;
      case 'Subasta':
        push([d.item ? esc(d.item) : null, ev.sku ? esc(ev.sku) : null].filter(Boolean).join(' · '));
        push([ev.customer_name ? esc(ev.customer_name) : null, money(ev.amount), ev.new_value && ev.action === 'Payment Received' ? esc(ev.new_value) : null, ev.status ? esc(ev.status) : null].filter(Boolean).join(' · '));
        break;
      case 'Pull Out':
        push([ev.sku ? esc(ev.sku) : null, d.item ? esc(d.item) : null, d.qty != null ? 'Qty ' + d.qty : null].filter(Boolean).join(' · '));
        push([ev.branch_id != null ? 'From ' + esc(bn(ev.branch_id)) : null, d.reason ? esc(d.reason) : null].filter(Boolean).join(' · '));
        break;
      case 'Transfers':
        push(esc(bn(ev.branch_id)) + ' → ' + esc(bn(ev.destination_branch_id)));
        push([ev.sku ? esc(ev.sku) : null, d.items ? d.items + ' item' + (d.items === 1 ? '' : 's') : null, d.qty ? 'Qty ' + d.qty : null].filter(Boolean).join(' · '));
        break;
      case 'Movement':
        push([ev.sku ? esc(ev.sku) : null, d.item ? esc(d.item) : null].filter(Boolean).join(' · '));
        push([d.qty_change != null ? (d.qty_change > 0 ? '+' : '') + d.qty_change + ' pcs' : null, ev.previous_value != null ? ev.previous_value + ' → ' + ev.new_value : null, d.reason ? esc(d.reason) : null].filter(Boolean).join(' · '));
        break;
      case 'Refunds':
        push([ev.customer_name ? esc(ev.customer_name) : null, ev.order_id ? 'Ref ' + esc(ev.order_id) : null].filter(Boolean).join(' · '));
        push([money(ev.amount), ev.new_value ? esc(ev.new_value) : null].filter(Boolean).join(' · '));
        break;
      default:
        push([ev.sku ? esc(ev.sku) : null, ev.new_value ? esc(ev.new_value) : null].filter(Boolean).join(' · '));
    }
    return lines.filter(Boolean);
  }

  function itemHtml(ev, { withX = true, showAbs = false } = {}) {
    const whoLine = ev.employee_name ? esc(ev.employee_name) + (ev.employee_position ? ' · ' + esc(ev.employee_position) : '') : 'System';
    const whereLine = ev.module === 'Transfers' ? '' : (ev.branch_id != null ? esc(bn(ev.branch_id)) : '');
    return '<div class="act-item act-' + esc(ev.priority || 'normal') + '" data-id="' + ev.id + '">' +
      '<div class="act-title">' + esc(ev.title) + '</div>' +
      '<div class="act-who">' + whoLine + '</div>' +
      (whereLine ? '<div class="act-line">' + whereLine + '</div>' : '') +
      summaryLines(ev).map((l) => '<div class="act-line">' + l + '</div>').join('') +
      (ev.priority === 'warning' && ev.module === 'Layaway' ? '<div class="act-line" style="color:#a15c00;">This transaction should not be processed as active.</div>' : '') +
      '<div class="act-when" data-iso="' + esc(ev.created_at) + '">' + (showAbs ? absTime(ev.created_at) : relTime(ev.created_at)) + '</div>' +
      (withX ? '<button type="button" class="act-x" aria-label="Dismiss">×</button>' : '') +
    '</div>';
  }

  // ---- click-through (321): open the record in its own page/drawer ------------
  function hrefFor(ev) {
    const base = links[ev.record_table];
    if (!base) return null;
    if (typeof base === 'function') return base(ev);
    return base.endsWith('=') ? base + encodeURIComponent(ev.record_id || '') : base;
  }
  function openRecord(ev) {
    // Same page already mounted with a record hook (branches.html registers one) --
    // open in place instead of reloading.
    if (window.__kmOpenRecord && window.__kmOpenRecord(ev.record_table, ev.record_id)) return;
    const href = hrefFor(ev);
    if (href) window.location.href = href;
  }

  // ---- live toasts (313-317) ---------------------------------------------------
  function removeVisible(entry) {
    const i = visible.indexOf(entry);
    if (i >= 0) visible.splice(i, 1);
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.add('act-fading');
    setTimeout(() => {
      entry.el.remove();
      // The next queued (newest) activity takes the freed slot (317).
      if (pending.length && visible.length < maxVisible()) showToast(pending.shift());
      refreshPanelVisibility();
    }, FADE_ANIM_MS);
  }
  function showToast(ev) {
    const wrap = document.createElement('div');
    wrap.innerHTML = itemHtml(ev);
    const el = wrap.firstElementChild;
    const entry = { ev, el, timer: null };
    el.querySelector('.act-x').addEventListener('click', (e) => { e.stopPropagation(); removeVisible(entry); });
    el.addEventListener('click', () => { markRead([ev.id]); removeVisible(entry); openRecord(ev); });
    liveEl.prepend(el);
    visible.unshift(entry);
    const ms = FADE_MS[ev.priority] === undefined ? FADE_MS.normal : FADE_MS[ev.priority];
    if (ms) entry.timer = setTimeout(() => removeVisible(entry), ms); // critical: stays until dismissed (314)
    refreshPanelVisibility();
  }
  function enqueue(ev) {
    if (visible.length < maxVisible()) showToast(ev);
    else { pending.unshift(ev); refreshPanelVisibility(); }
  }
  $('act-panel-close').addEventListener('click', () => {
    pending.length = 0;
    visible.slice().forEach(removeVisible);
    closePanel();
  });

  function onNewEvent(ev) {
    if (!ev || seen.has(ev.id) || (ev.event_key && seenKeys.has(ev.event_key))) return;
    seen.add(ev.id); if (ev.event_key) seenKeys.add(ev.event_key);
    history.unshift({ ...ev, is_read: false });
    if (drawer.classList.contains('open')) renderHistory();
    // Your own actions are recorded like everyone else's but not announced back to you.
    if (ev.employee_id && ev.employee_id === employee.id) { markRead([ev.id]); return; }
    setUnread(unread + 1);
    enqueue(ev);
  }

  // ---- read tracking (329) ------------------------------------------------------
  async function markRead(ids) {
    const fresh = ids.filter((id) => { const h = history.find((x) => x.id === id); return !h || !h.is_read; });
    history.forEach((h) => { if (ids.includes(h.id)) h.is_read = true; });
    if (drawer.classList.contains('open')) renderHistory();
    if (!fresh.length) return;
    setUnread(unread - fresh.length);
    try { await markActivityRead(fresh); } catch (e) { /* badge self-corrects on the next count refresh */ }
  }
  $('act-mark-all').addEventListener('click', async () => {
    history.forEach((h) => { h.is_read = true; });
    renderHistory();
    setUnread(0);
    try { await markAllActivityRead(); } catch (e) { /* ditto */ }
  });

  // ---- history drawer (319/320) -------------------------------------------------
  function filters() {
    return {
      module: $('act-f-module').value || null,
      branchId: $('act-f-branch').value ? Number($('act-f-branch').value) : null,
      from: $('act-f-from').value || null,
      to: $('act-f-to').value || null,
      action: $('act-f-action').value.trim() || null,
    };
  }
  function renderHistory() {
    const list = $('act-hist-list');
    const empQ = $('act-f-emp').value.trim().toLowerCase();
    const rows = empQ ? history.filter((h) => (h.employee_name || '').toLowerCase().includes(empQ)) : history;
    if (!rows.length) { list.innerHTML = '<p class="muted">No activity for this filter.</p>'; return; }
    list.innerHTML = rows.map((h) => {
      const html = itemHtml(h, { withX: false, showAbs: true });
      return html.replace('class="act-item ', 'class="act-item act-hist-item' + (h.is_read ? '' : ' act-unread') + ' ');
    }).join('');
    list.querySelectorAll('.act-item').forEach((el) => el.addEventListener('click', () => {
      const ev = history.find((h) => h.id === Number(el.dataset.id));
      if (!ev) return;
      markRead([ev.id]);
      closeHistory();
      openRecord(ev);
    }));
    $('act-hist-more').style.display = history.length >= 60 ? '' : 'none';
  }
  async function loadHistory({ more = false } = {}) {
    const list = $('act-hist-list');
    if (!more) { list.innerHTML = '<p class="muted">Loading…</p>'; histOldest = null; }
    try {
      const rows = await listActivity({ ...filters(), limit: 60, before: more ? histOldest : null });
      rows.forEach((r) => { seen.add(r.id); if (r.event_key) seenKeys.add(r.event_key); });
      history = more ? history.concat(rows) : rows;
      histOldest = history.length ? history[history.length - 1].created_at : null;
      renderHistory();
      $('act-hist-more').style.display = rows.length === 60 ? '' : 'none';
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }
  function openHistory() {
    drawerBackdrop.classList.add('open');
    drawer.classList.add('open');
    loadHistory();
  }
  function closeHistory() {
    drawerBackdrop.classList.remove('open');
    drawer.classList.remove('open');
  }
  // Ren, 2026-09-22: "REMOVE NOTIFICATION SHOW THIS ON BELL ON THE UPPER RIGHT" --
  // the bell now opens/closes this lightweight panel (pinned warnings + recent live
  // activity) in place, instead of jumping straight to the full History drawer. "View
  // All Activity" inside the panel still reaches that fuller, filterable drawer.
  bell.addEventListener('click', (ev) => { ev.stopPropagation(); togglePanel(); });
  $('act-viewall').addEventListener('click', () => { closePanel(); openHistory(); });
  document.addEventListener('click', (ev) => {
    if (panelOpenByUser && !panel.contains(ev.target) && ev.target !== bell) closePanel();
  });
  $('act-hist-close').addEventListener('click', closeHistory);
  $('act-hist-close2').addEventListener('click', closeHistory);
  drawerBackdrop.addEventListener('click', closeHistory);
  $('act-hist-more').addEventListener('click', () => loadHistory({ more: true }));
  ['act-f-module', 'act-f-branch', 'act-f-from', 'act-f-to'].forEach((id) => $(id).addEventListener('change', () => loadHistory()));
  $('act-f-action').addEventListener('change', () => loadHistory());
  $('act-f-emp').addEventListener('input', renderHistory);
  $('act-f-clear').addEventListener('click', () => {
    ['act-f-module', 'act-f-branch', 'act-f-emp', 'act-f-from', 'act-f-to', 'act-f-action'].forEach((id) => { $(id).value = ''; });
    loadHistory();
  });

  // ---- boot -------------------------------------------------------------------------
  try {
    // Seed the dedup sets from what's already recorded, and prime the badge. Nothing
    // historical is toasted -- only activity that happens after this page loaded.
    const recent = await listActivity({ limit: 60 });
    recent.forEach((r) => { seen.add(r.id); if (r.event_key) seenKeys.add(r.event_key); });
    history = recent;
    histOldest = history.length ? history[history.length - 1].created_at : null;
    setUnread(await activityUnreadCount());
  } catch (e) { /* the bell still works; counts just start at 0 */ }

  const unsubscribe = subscribeToChanges('activity_events', (payload) => {
    if (payload && payload.eventType === 'INSERT' && payload.new) onNewEvent(payload.new);
  });
  // Belt-and-braces: keep the badge honest even if the realtime socket drops.
  const countTimer = setInterval(async () => { try { setUnread(await activityUnreadCount()); } catch (e) {} }, 60000);
  const tickTimer = setInterval(() => {
    document.querySelectorAll('.act-panel .act-when[data-iso]').forEach((el) => { el.textContent = relTime(el.dataset.iso); });
  }, 30000);

  refreshPanelVisibility();
  return {
    pinnedSlot,
    refreshPanelVisibility,
    openHistory,
    unsubscribe: () => { unsubscribe(); clearInterval(countTimer); clearInterval(tickTimer); },
  };
}
