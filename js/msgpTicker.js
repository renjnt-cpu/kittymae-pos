// Message Pancake -- the red number on the menu link and the strip under the header that names the customers who are urgent / need a follow-up.
// Runs on every POS page for the people who may see Message Pancake (message_pancake.view); everyone else gets nothing and no request is made.
// A failed look-up is silent -- it must never get in the way of the page the person is working on.
import { msgpCounts } from './messagePancakeApi.js?v=20261011a';
import { esc } from './shell.js?v=20261011a';
import { CATEGORY, fmtWait, shortName } from './msgpFormat.js?v=20261011a';

const POLL_MS = 120000;
const MUTE_MS = 15 * 60000;

export function canSeeMessagePancake(employee) {
  const p = (employee && employee.permissions) || [];
  return p.includes('message_pancake.view') || p.includes('message_pancake.manage');
}

export function initMsgpTicker({ employee, shellEl, onPage }) {
  if (!canSeeMessagePancake(employee)) return null;
  const badge = shellEl.querySelector('#msgp-nav-badge');
  let strip = null;
  let mutedUntil = 0, mutedKey = '';
  if (!onPage) {
    strip = document.createElement('div');
    strip.className = 'msgp-strip';
    strip.hidden = true;
    shellEl.querySelector('.app-header').after(strip);
    strip.addEventListener('click', (e) => {
      const x = e.target.closest('[data-msgp-mute]');
      if (x) { mutedUntil = Date.now() + MUTE_MS; mutedKey = strip.dataset.key || ''; strip.hidden = true; e.preventDefault(); }
    });
  }

  function paint(c) {
    if (!c || !c.ok) { if (badge) badge.hidden = true; if (strip) strip.hidden = true; return; }
    const needs = (c.urgent || 0) + (c.follow_up || 0);
    if (badge) {
      badge.hidden = needs === 0;
      badge.textContent = needs > 99 ? '99+' : String(needs);
      badge.classList.toggle('urgent', (c.urgent || 0) > 0);
      badge.title = (c.urgent || 0) + ' urgent, ' + (c.follow_up || 0) + ' to follow up';
    }
    if (!strip) return;
    const top = c.top || [];
    const key = top.map((t) => t.id).join(',');
    if (needs === 0 || (Date.now() < mutedUntil && key === mutedKey)) { strip.hidden = true; return; }
    const names = top.slice(0, 3).map((t) =>
      '<b>' + esc(shortName(t.name)) + '</b> <span class="msgp-strip-why">' + esc((CATEGORY[t.category] || {}).label || '') + ' · ' + esc(fmtWait(t.wait_min)) + '</span>').join(' &nbsp;|&nbsp; ');
    const more = needs - Math.min(3, top.length);
    strip.dataset.key = key;
    strip.classList.toggle('urgent', (c.urgent || 0) > 0);
    strip.innerHTML =
      '<a class="msgp-strip-link" href="message-pancake.html">' +
        '<span class="msgp-strip-count">' + ((c.urgent || 0) > 0 ? esc(c.urgent) + ' urgent' + ((c.follow_up || 0) ? ', ' + esc(c.follow_up) + ' to follow up' : '') : esc(c.follow_up) + ' to follow up') + '</span> ' +
        '<span class="msgp-strip-names">' + names + (more > 0 ? ' &nbsp;+' + esc(more) + ' more' : '') + '</span> ' +
        '<span class="msgp-strip-go">Open Message Pancake →</span></a>' +
      '<button type="button" class="msgp-strip-x" data-msgp-mute aria-label="Hide for 15 minutes" title="Hide for 15 minutes">×</button>';
    strip.hidden = false;
  }

  async function tick() {
    if (document.hidden) return;
    try { paint(await msgpCounts()); } catch (err) { /* silent */ }
  }
  tick();
  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  return { refresh: tick };
}
