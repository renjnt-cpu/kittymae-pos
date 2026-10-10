// Message Pancake -- the CUSTOMER ATTENTION panel for every POS page: a thin bar under the header (hidden when nobody needs attention) that opens into the list of important customers,
// plus the count on the menu link and a short "customer needs attention" notice when a new important alert appears.
// Runs for people with message_pancake.view_alerts / .view / .manage; everyone else makes no request. A failed look-up is silent -- it never gets in the way of the page.
// The feed carries alert facts only (name, priority, reason, waiting time, order number, branch) -- never the message text -- and the database applies the branch rules.
import { msgpAttention } from './messagePancakeApi.js?v=20261011b';
import { esc } from './shell.js?v=20261011b';
import { badge, fmtWait, shortName, WAIT_COLOR, PRIORITIES, TONES } from './msgpFormat.js?v=20261011b';

const POLL_MS = 120000;
const NEW_MS = 15 * 60000;
const VIEWS = [['urgent', 'Urgent'], ['follow_up', 'Follow-ups'], ['ordering', 'Ordering now'], ['complaints', 'Angry / frustrated'], ['payment', 'Payment issues'], ['delivery', 'Delivery issues'], ['waiting', 'Long waiting'], ['all', 'All needs attention']];
const RANK = { critical: 3, high: 2, normal: 1, low: 0 };

/** the Customer Attention panel / count: alert facts only */
export function canSeeMessagePancake(employee) {
  const p = (employee && employee.permissions) || [];
  return p.includes('message_pancake.view') || p.includes('message_pancake.view_alerts') || p.includes('message_pancake.manage');
}
/** the Message Pancake page (the conversations themselves) */
export function canOpenMessagePancake(employee) {
  const p = (employee && employee.permissions) || [];
  return p.includes('message_pancake.view') || p.includes('message_pancake.manage');
}

export function initMsgpTicker({ employee, shellEl, onPage }) {
  if (!canSeeMessagePancake(employee)) return null;
  const navBadge = shellEl.querySelector('#msgp-nav-badge');
  let box = null, view = 'urgent', openPanel = false, last = null;
  const seen = (() => { try { return JSON.parse(localStorage.getItem('msgp-seen') || '{}'); } catch (e) { return {}; } })();
  const saveSeen = () => { try { const keep = Object.fromEntries(Object.entries(seen).slice(-200)); localStorage.setItem('msgp-seen', JSON.stringify(keep)); } catch (e) { /* storage may be blocked */ } };

  if (!onPage) {
    box = document.createElement('div');
    box.className = 'msgp-attn';
    box.hidden = true;
    shellEl.querySelector('.app-header').after(box);
    box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-attn-toggle]')) { openPanel = !openPanel; if (openPanel) await tick(true); paint(last); return; }
      const v = e.target.closest('[data-attn-view]');
      if (v) { view = v.dataset.attnView; await tick(true); return; }
      if (e.target.closest('[data-attn-close]')) { openPanel = false; paint(last); }
    });
  }

  function cardHtml(r, inbox) {
    const p = PRIORITIES[r.priority] || PRIORITIES.normal;
    const href = inbox ? 'message-pancake.html?c=' + encodeURIComponent(r.id) : r.open_url;
    const intents = [r.intent_label].concat(r.follow_up_count > 0 && r.intent !== 'follow_up' ? ['Follow-Up'] : []);
    return '<div class="msgp-ac msgp-ac-' + esc(r.priority) + '"><div class="msgp-ac-main">' +
      '<div class="msgp-ac-top"><span class="msgp-dot msgp-dot-' + esc(p.color) + '" aria-hidden="true"></span><b>' + esc(r.customer_name) + '</b> ' + badge(p.label, p.color) + (r.escalated ? ' ' + badge('ESCALATED', 'red') : '') + '</div>' +
      '<div class="msgp-ac-why">' + esc(intents.filter(Boolean).join(' · ')) + (r.tone === 'angry' || r.tone === 'frustrated' ? ' · ' + esc((TONES[r.tone] || {}).label) : '') + '</div>' +
      (r.reason ? '<div class="msgp-ac-reason">' + esc(r.reason) + '</div>' : '') +
      '<div class="msgp-ac-meta">' + badge('Waiting ' + fmtWait(r.wait_min), WAIT_COLOR[r.wait_band] || 'gray') + ' ' +
        (r.order_ref ? '<span>Order #' + esc(r.order_ref) + '</span>' : (r.possible_new_order ? '<span>No order created yet</span>' : '')) + (r.branch_name ? ' <span class="muted">' + esc(r.branch_name) + '</span>' : '') + '</div></div>' +
      '<a class="btn small' + (r.priority === 'critical' ? '' : ' secondary') + '" href="' + esc(href) + '"' + (inbox ? '' : ' target="_blank" rel="noopener noreferrer"') + '>' + (r.possible_new_order && !r.order_ref ? 'OPEN CHAT' : 'VIEW MESSAGE') + '</a></div>';
  }

  function paint(a) {
    last = a;
    if (!a || !a.ok) { if (navBadge) navBadge.hidden = true; if (box) box.hidden = true; return; }
    const c = a.counts || {};
    const all = c.all || 0;
    if (navBadge) {
      navBadge.hidden = all === 0; navBadge.textContent = all > 99 ? '99+' : String(all);
      navBadge.classList.toggle('urgent', (c.critical || 0) > 0);
      navBadge.title = (c.critical || 0) + ' critical, ' + (c.high || 0) + ' high priority, ' + all + ' in all';
    }
    if (!box) return;
    if (all === 0) { box.hidden = true; return; }
    const names = (a.rows || []).slice(0, 3).map((r) => '<b>' + esc(shortName(r.customer_name)) + '</b> <span class="msgp-strip-why">' + esc(r.intent_label || '') + ' · ' + esc(fmtWait(r.wait_min)) + '</span>').join(' &nbsp;|&nbsp; ');
    const more = all - Math.min(3, (a.rows || []).length);
    box.classList.toggle('urgent', (c.critical || 0) > 0);
    box.hidden = false;
    box.innerHTML =
      '<button type="button" class="msgp-attn-bar" data-attn-toggle aria-expanded="' + openPanel + '"><span class="msgp-attn-title">CUSTOMER ATTENTION</span> ' +
        '<span class="msgp-strip-count">' + ((c.critical || 0) ? c.critical + ' critical' + ((c.high || 0) ? ', ' : '') : '') + ((c.high || 0) ? c.high + ' high priority' : '') + (!(c.critical || c.high) ? all + ' waiting' : '') + '</span> ' +
        '<span class="msgp-strip-names">' + names + (more > 0 ? ' &nbsp;+' + more + ' more' : '') + '</span><span class="msgp-attn-caret" aria-hidden="true">' + (openPanel ? '▴' : '▾') + '</span></button>' +
      (openPanel ? '<div class="msgp-attn-panel"><div class="msgp-attn-tabs" role="tablist">' +
        VIEWS.map(([k, l]) => '<button type="button" class="btn small' + (view === k ? '' : ' secondary') + '" data-attn-view="' + k + '">' + esc(l) + ' ' + (c[k] != null ? '<span class="msgp-attn-n">' + c[k] + '</span>' : '') + '</button>').join('') +
        '</div><div class="msgp-attn-list">' + ((a.rows || []).length ? a.rows.map((r) => cardHtml(r, a.inbox)).join('') : '<div class="muted">Nobody in this group right now.</div>') + '</div>' +
        '<div class="msgp-attn-foot">' + (a.inbox ? '<a href="message-pancake.html">Open the full queue →</a>' : '') + '<button type="button" class="act-link" data-attn-close>Close</button></div></div>' : '');
  }

  // a short notice when a NEW important alert appears (or one gets more important) -- never for the same alert twice, never a pile-up
  function notice(a) {
    if (!a || !a.ok) return;
    const silent = onPage;   // on the Message Pancake page itself the queue is already in front of the person: remember the alerts as seen, say nothing
    const fresh = (a.rows || []).filter((r) => {
      const rk = RANK[r.priority] || 0, prev = seen[r.alert_id];
      const isNew = prev === undefined || prev < rk;
      seen[r.alert_id] = Math.max(prev ?? -1, rk);
      return isNew && rk >= 2 && Date.now() - new Date(r.alert_updated_at).getTime() < NEW_MS;
    });
    saveSeen();
    if (silent || !fresh.length || document.querySelector('.msgp-toast')) return;
    const r = fresh[0];
    const t = document.createElement('div');
    t.className = 'msgp-toast' + (r.priority === 'critical' ? ' urgent' : '');
    t.setAttribute('role', 'status');
    t.innerHTML = '<b>CUSTOMER NEEDS ATTENTION</b><div>' + esc(r.customer_name) + ' — ' + esc(r.intent_label || '') + (fresh.length > 1 ? ' <span class="muted">(+' + (fresh.length - 1) + ' more)</span>' : '') +
      '</div><div class="muted">Waiting ' + esc(fmtWait(r.wait_min)) + (r.order_ref ? ' · Order #' + esc(r.order_ref) : '') + '</div><a class="btn small" href="' + esc(a.inbox ? 'message-pancake.html?c=' + encodeURIComponent(r.id) : r.open_url) + '">OPEN</a> <button type="button" class="act-link" data-x>Dismiss</button>';
    t.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) t.remove(); });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 15000);
  }

  async function tick(force) {
    if (document.hidden && !force) return;
    try { const a = await msgpAttention(openPanel ? view : 'all'); if (!openPanel || view === 'all') notice(a); paint(a); } catch (err) { /* silent */ }
  }
  tick(true);
  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  return { refresh: () => tick(true) };
}
