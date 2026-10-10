// Message Pancake -- the Customer Attention Queue: the tiles, the filters, the search and the customer cards.
// Everything shown comes from msgp_inbox (the database applies the branch rules); this file only draws it and sends the filters back.
import { esc, toast } from './shell.js?v=20261011b';
import { msgpInbox, msgpRequestCheck } from './messagePancakeApi.js?v=20261011b';
import { TONES, PRIORITIES, WAIT_COLOR, WAIT_LABEL, STATUSES, badge, badgesHtml, fmtWait, ago, stamp, manilaToday } from './msgpFormat.js?v=20261011b';

const MSG = 'msgp-msg';
const has = (r, k) => r.intent === k || (r.intents || []).includes(k);
const TILES = [
  ['needs_reply', 'Needs Reply', 'msgp-t-yellow', () => true],
  ['ordering_now', 'Ordering Now', 'msgp-t-green', (r) => has(r, 'ordering_now')],
  ['urgent', 'Urgent', 'msgp-t-red', (r) => r.is_urgent || r.priority === 'critical'],
  ['follow_ups', 'Follow-Ups', 'msgp-t-orange', (r) => has(r, 'follow_up')],
  ['complaints', 'Complaints', 'msgp-t-red', (r) => has(r, 'complaint') || r.tone === 'angry'],
  ['payment_issues', 'Payment Issues', 'msgp-t-purple', (r) => has(r, 'payment_issue')],
  ['refund_requests', 'Refund Requests', 'msgp-t-red', (r) => has(r, 'refund_return')],
  ['waiting_30', 'Waiting 30+ Minutes', 'msgp-t-orange', (r) => r.wait_min >= 30],
  ['resolved_today', 'Resolved Today', 'msgp-t-gray', null],
];
const VIEWS = [['needs_reply', 'Needs reply'], ['all', 'All conversations'], ['mine', 'Mine'], ['escalated', 'Escalated'], ['snoozed', 'Snoozed'], ['resolved', 'Resolved']];
const SORTS = [['queue', 'Queue order (most important first)'], ['wait', 'Longest waiting'], ['newest', 'Newest message'], ['priority', 'Priority']];

export function startQueue({ root, employee, canManage, onOpen }) {
  const st = { view: 'needs_reply', tile: null, intent: '', tone: '', priority: '', status: '', branch: '', assigned: '', minWait: '', hasOrder: '', q: '', sort: 'queue', more: false, data: null, loadedAt: 0, checking: false, qFocus: false };
  try { const s = JSON.parse(sessionStorage.getItem('msgp-queue') || 'null'); if (s) Object.assign(st, { view: s.view || st.view, sort: s.sort || st.sort, more: !!s.more }); } catch (e) { /* storage may be blocked */ }
  const save = () => { try { sessionStorage.setItem('msgp-queue', JSON.stringify({ view: st.view, sort: st.sort, more: st.more })); } catch (e) { /* harmless */ } };

  root.innerHTML = '<div id="msgp-q-banner"></div><div class="msgp-top"><div class="muted">Customers on Messenger, most important first. The detection reads the customer’s words — it is a suggestion for staff, never a decision. Checked every 5 minutes.</div>' +
    '<button type="button" class="btn small" id="msgp-check">Check now</button></div><div id="msgp-q-body"></div>';
  const body = root.querySelector('#msgp-q-body');

  const filterObj = () => {
    const f = { view: st.view, sort: st.sort, limit: 300 };
    if (st.intent) f.intent = st.intent; if (st.tone) f.tone = st.tone; if (st.priority) f.priority = st.priority; if (st.status) f.status = st.status;
    if (st.branch) f.branch = st.branch; if (st.assigned) f.assigned = st.assigned; if (st.minWait) f.min_wait = Number(st.minWait);
    if (st.hasOrder) f.has_order = st.hasOrder === 'yes'; if (st.q.trim()) f.q = st.q.trim();
    return f;
  };

  async function load(keepFocus) {
    try {
      st.data = await msgpInbox(filterObj());
      st.loadedAt = Date.now();
      draw(keepFocus);
      if (window.__kmMsgp) window.__kmMsgp.refresh();
    } catch (err) { body.innerHTML = '<div class="msg error">' + esc(String(err.message || err)) + '</div>'; }
  }

  function banner(d) {
    if (!d.connected) return '<div class="msg error">Message Pancake is not connected to a Pancake page yet. ' + (canManage ? 'Open <b>Settings</b> to connect one.' : 'Ask Ren to connect it.') + '</div>';
    if (!d.enabled) return '<div class="msg error">Message Pancake is switched OFF, so no new messages are being read.' + (canManage ? ' Switch it on in <b>Settings</b>.' : '') + '</div>';
    if (d.last_check_ok === false) return '<div class="msg error">The last check had a problem: ' + esc(d.last_check_note || 'unknown') + ' (' + esc(ago(d.last_check_at)) + ')</div>';
    const stale = d.last_check_at && (Date.now() - new Date(d.last_check_at).getTime()) > 20 * 60000;
    return '<div class="msgp-checked muted' + (stale ? ' msgp-stale' : '') + '">Last checked ' + esc(ago(d.last_check_at)) + (stale ? ' — checks are late' : '') + '</div>';
  }

  function tileHtml(t, counts) {
    const [key, label, cls] = t;
    const on = st.tile === key;
    return '<button type="button" class="tile msgp-tile ' + cls + (on ? ' on' : '') + '" data-tile="' + key + '" aria-pressed="' + on + '"><div class="num">' + (counts[key] ?? 0) + '</div><div class="lbl">' + esc(label) + '</div></button>';
  }

  function options(list, cur, allLabel) {
    return '<option value="">' + esc(allLabel) + '</option>' + list.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
  }

  function cardHtml(r, cats) {
    const wcol = WAIT_COLOR[r.wait_band] || 'gray';
    return '<article class="msgp-card msgp-p-' + esc(r.priority) + (r.needs_reply ? '' : ' msgp-done') + '" data-id="' + esc(r.id) + '" tabindex="0">' +
      '<div class="msgp-card-top"><span class="msgp-name">' + esc(r.customer_name) + '</span><span class="msgp-page muted">' + esc(r.page_label) + (r.branch_name ? ' · ' + esc(r.branch_name) : '') + '</span></div>' +
      '<div class="msgp-badges">' + badgesHtml(r, { categories: cats }) + '</div>' +
      (r.snippet ? '<div class="msgp-snippet">“' + esc(r.snippet) + '”</div>' : '') +
      (r.reason ? '<div class="msgp-reason"><b>Reason detected:</b> ' + esc(r.reason) + (r.intent_conf != null ? ' <span class="muted">(' + Math.round(r.intent_conf * 100) + '% sure)</span>' : '') + '</div>' : '') +
      '<div class="msgp-meta">' +
        (r.needs_reply ? badge('Waiting ' + fmtWait(r.wait_min) + (WAIT_LABEL[r.wait_band] && r.wait_band !== 'normal' ? ' · ' + WAIT_LABEL[r.wait_band] : ''), wcol) + (r.sla_breached ? ' ' + badge('Over reply target (' + r.sla_target + ' min)', 'red') : '') : '<span class="muted">Staff replied ' + esc(ago(r.last_staff_reply_at)) + '</span>') +
        (r.unanswered_count > 1 ? ' <span>' + r.unanswered_count + ' unanswered messages</span>' : '') +
        (r.follow_up_count > 0 ? ' <span>' + r.follow_up_count + ' follow-up' + (r.follow_up_count > 1 ? 's' : '') + '</span>' : '') +
        (r.order_ref ? ' <span class="msgp-order">Order #' + esc(r.order_ref) + '</span>' : (r.possible_new_order ? '' : ' <span class="muted">No order linked</span>')) +
        ' <span class="muted">' + esc(STATUSES[r.status] || r.status) + (r.assigned_name ? ' · ' + esc(r.assigned_name) : r.pancake_assignee ? ' · Pancake: ' + esc(r.pancake_assignee) : '') + '</span>' +
      '</div>' +
      '<div class="msgp-actions"><a class="btn small" href="' + esc(r.open_url) + '" target="_blank" rel="noopener noreferrer">OPEN CHAT ↗</a><button type="button" class="btn small secondary" data-open>Details &amp; actions</button></div>' +
    '</article>';
  }

  function draw(keepFocus) {
    const d = st.data;
    if (!d) return;
    root.querySelector('#msgp-q-banner').innerHTML = banner(d);
    const cats = {}; for (const c of d.categories || []) cats[c.key] = c;
    const catList = (d.categories || []).filter((c) => c.kind === 'intent' && c.enabled).map((c) => [c.key, c.label]);
    let rows = d.rows || [];
    const tile = TILES.find((t) => t[0] === st.tile);
    if (tile) {
      if (tile[0] === 'resolved_today') { const today = manilaToday(); rows = rows.filter((r) => r.resolved_at && new Date(r.resolved_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) === today); }
      else if (tile[3]) rows = rows.filter(tile[3]);
    }
    const filtering = st.tile || st.intent || st.tone || st.priority || st.status || st.branch || st.assigned || st.minWait || st.hasOrder || st.q.trim();
    body.innerHTML =
      '<div class="tiles msgp-tiles">' + TILES.map((t) => tileHtml(t, d.counts || {})).join('') + '</div>' +
      '<div class="card msgp-filters">' +
        '<div class="msgp-views" role="group" aria-label="View">' + VIEWS.map(([v, l]) => '<button type="button" class="btn small' + (st.view === v && !st.tile ? '' : ' secondary') + '" data-view="' + v + '">' + esc(l) + '</button>').join('') + '</div>' +
        '<div class="field msgp-grow"><label for="msgp-q">Search customer, order #, phone number or message</label><input id="msgp-q" type="search" value="' + esc(st.q) + '" placeholder="Maria, 45821, 0917…, magkano"></div>' +
        '<div class="field"><label for="msgp-sort">Sort</label><select id="msgp-sort">' + options(SORTS, st.sort, 'Queue order').replace('<option value="">Queue order</option>', '') + '</select></div>' +
        '<button type="button" class="btn small secondary" id="msgp-more">' + (st.more ? 'Fewer filters ▴' : 'More filters ▾') + '</button>' +
        (filtering ? '<button type="button" class="btn small secondary" id="msgp-clear">Clear filters</button>' : '') +
        (st.more ? '<div class="msgp-more">' +
          '<div class="field"><label for="f-intent">Intent</label><select id="f-intent">' + options(catList, st.intent, 'Any') + '</select></div>' +
          '<div class="field"><label for="f-tone">Tone</label><select id="f-tone">' + options(Object.entries(TONES).map(([k, v]) => [k, v.label]), st.tone, 'Any') + '</select></div>' +
          '<div class="field"><label for="f-priority">Priority</label><select id="f-priority">' + options(Object.entries(PRIORITIES).map(([k, v]) => [k, v.label]), st.priority, 'Any') + '</select></div>' +
          '<div class="field"><label for="f-status">Status</label><select id="f-status">' + options(Object.entries(STATUSES), st.status, 'Any') + '</select></div>' +
          ((d.branches || []).length > 1 && d.perms && d.perms.all_branches ? '<div class="field"><label for="f-branch">Branch</label><select id="f-branch">' + options((d.branches || []).map((b) => [b.id, b.name]), st.branch, 'All') + '</select></div>' : '') +
          '<div class="field"><label for="f-assigned">Assigned to</label><select id="f-assigned">' + options([['me', 'Me'], ['none', 'Nobody']], st.assigned, 'Anyone') + '</select></div>' +
          '<div class="field"><label for="f-wait">Waiting at least</label><select id="f-wait">' + options([[10, '10 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours']], st.minWait, 'Any time') + '</select></div>' +
          '<div class="field"><label for="f-order">Order</label><select id="f-order">' + options([['yes', 'Has an order'], ['no', 'No order yet']], st.hasOrder, 'Any') + '</select></div>' +
        '</div>' : '') +
      '</div>' +
      '<div class="msgp-count muted">' + rows.length + ' conversation' + (rows.length === 1 ? '' : 's') + (d.total > (d.rows || []).length ? ' (showing the first ' + (d.rows || []).length + ' of ' + d.total + ')' : '') + '</div>' +
      (rows.length
        ? '<div class="msgp-cards">' + rows.map((r) => cardHtml(r, cats)).join('') + '</div>'
        : '<div class="empty-state"><div class="empty-state-msg">' + (filtering ? 'Nothing matches these filters.' : (st.view === 'needs_reply' ? (d.connected && d.enabled ? 'Nobody is waiting for a reply. 🎉' : 'Nothing to show yet.') : 'Nothing here.')) + '</div></div>');
    if (keepFocus) { const qi = body.querySelector('#msgp-q'); if (qi) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); } }
  }

  // ---- events
  let searchTimer = null;
  body.addEventListener('input', (e) => {
    if (e.target.id === 'msgp-q') { st.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => load(true), 350); }
  });
  body.addEventListener('change', (e) => {
    const map = { 'f-intent': 'intent', 'f-tone': 'tone', 'f-priority': 'priority', 'f-status': 'status', 'f-branch': 'branch', 'f-assigned': 'assigned', 'f-wait': 'minWait', 'f-order': 'hasOrder', 'msgp-sort': 'sort' };
    const k = map[e.target.id];
    if (!k) return;
    st[k] = e.target.value; st.tile = null; save(); load();
  });
  body.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-tile]');
    if (tile) {
      const k = tile.dataset.tile;
      st.tile = st.tile === k ? null : k;
      st.view = k === 'resolved_today' && st.tile ? 'resolved' : 'needs_reply';
      load(); return;
    }
    const v = e.target.closest('[data-view]');
    if (v) { st.view = v.dataset.view; st.tile = null; save(); load(); return; }
    if (e.target.id === 'msgp-more') { st.more = !st.more; save(); draw(); return; }
    if (e.target.id === 'msgp-clear') { Object.assign(st, { tile: null, intent: '', tone: '', priority: '', status: '', branch: '', assigned: '', minWait: '', hasOrder: '', q: '' }); load(); return; }
    if (e.target.closest('a')) return;
    const card = e.target.closest('.msgp-card');
    if (card) onOpen(Number(card.dataset.id));
  });
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('msgp-card')) onOpen(Number(e.target.dataset.id)); });
  root.querySelector('#msgp-check').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
    try {
      const r = await msgpRequestCheck(false);
      if (!r.ok) toast(MSG, r.message, true); else { toast(MSG, 'Checking Pancake now — the list updates in a few seconds.'); await new Promise((res) => setTimeout(res, 9000)); await load(); }
    } catch (err) { toast(MSG, err.message || String(err), true); }
    b.disabled = false; b.textContent = 'Check now';
  });

  setInterval(() => { if (!document.hidden && !document.querySelector('.msgp-drawer') && document.activeElement && document.activeElement.id !== 'msgp-q' && root.offsetParent !== null) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && root.offsetParent !== null && Date.now() - st.loadedAt > 30000) load(); });
  load();
  return { refresh: load, getBranches: () => (st.data && st.data.branches) || [], getData: () => st.data };
}
