// Message Pancake page (Ren, 2026-10-11, upgraded the same day): the Customer Attention Queue for the online customers on Messenger -- who is ordering, who is only asking,
// who is following up, who is frustrated, who has a payment / delivery / refund problem, who has been waiting too long -- with the order they belong to, who handles it, a
// suggested reply and a full timeline. Reports for management, Settings for the owner.
// The detection is rule-based advice for staff; every decision (reply, order, payment, refund, cancellation) stays with people.
import { esc } from './shell.js?v=20261011b';
import { startQueue } from './msgpQueue.js?v=20261011b';
import { startReports } from './msgpReports.js?v=20261011b';
import { startSettings } from './msgpSettings.js?v=20261011b';
import { openDetail } from './msgpDetail.js?v=20261011b';

export async function startMessagePancake({ employee }) {
  const perms = employee.permissions || [];
  const manage = perms.includes('message_pancake.manage');
  const can = (k) => manage || perms.includes('message_pancake.' + k);
  const root = document.getElementById('msgp-root');
  if (!can('view')) {
    root.innerHTML = '<div class="empty-state"><div class="empty-state-msg">The Message Pancake inbox is for the staff who answer online customers. ' +
      (can('view_alerts') ? 'You can see the customers who need attention in the panel under the page title on every POS page.' : 'Ask an Admin if you need it.') + '</div></div>';
    return;
  }
  const tabs = [['queue', 'Customer Attention Queue', true], ['reports', 'Reports', can('analytics')], ['settings', 'Settings', manage]].filter((t) => t[2]);
  root.innerHTML = '<div class="msgp-tabs" role="tablist">' + tabs.map(([k, l], i) => '<button type="button" class="btn small' + (i ? ' secondary' : '') + '" role="tab" data-tab="' + k + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<div id="msgp-tab-queue"></div><div id="msgp-tab-reports" hidden></div><div id="msgp-tab-settings" hidden></div>';
  const panes = { queue: root.querySelector('#msgp-tab-queue'), reports: root.querySelector('#msgp-tab-reports'), settings: root.querySelector('#msgp-tab-settings') };
  const mods = {};
  const open = (id) => openDetail(id, { onChange: () => mods.queue && mods.queue.refresh() });

  mods.queue = startQueue({ root: panes.queue, employee, canManage: manage, onOpen: open });

  function show(k) {
    for (const [name, el] of Object.entries(panes)) el.hidden = name !== k;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('secondary', b.dataset.tab !== k));
    if (k === 'reports') { if (!mods.reports) mods.reports = startReports({ root: panes.reports, getBranches: () => mods.queue.getBranches() }); mods.reports.onShow(); }
    if (k === 'settings') { if (!mods.settings) mods.settings = startSettings({ root: panes.settings, onSaved: () => mods.queue.refresh() }); else mods.settings.onShow(); }
    if (k === 'queue') mods.queue.refresh();
  }
  root.querySelector('.msgp-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });

  const q = new URLSearchParams(location.search);
  if (q.get('tab') && tabs.some((t) => t[0] === q.get('tab'))) show(q.get('tab'));
  if (q.get('c') && Number(q.get('c'))) open(Number(q.get('c')));   // a link from the POS panel opens that conversation
}
