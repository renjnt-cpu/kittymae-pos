// Message Pancake -- one conversation in full (a side panel): what was detected and why, the order, who handles it and its status, the suggested reply, internal notes,
// response times and the timeline. Everything here is staff-controlled: the detection can be changed, nothing is sent to the customer, nothing touches the order,
// a payment or a refund (those buttons open the existing screens).
import { esc, toast } from './shell.js?v=20261011b';
import { reasonDialog } from './dialogs.js?v=20261011b';
import {
  msgpConversation, msgpAssign, msgpSetStatus, msgpResolve, msgpReopen, msgpSnooze, msgpAddNote, msgpCorrect, msgpEscalate, msgpDeescalate,
} from './messagePancakeApi.js?v=20261011b';
import { TONES, PRIORITIES, WAIT_COLOR, WAIT_LABEL, STATUSES, ESCALATION_REASONS, badge, badgesHtml, fmtWait, ago, stamp, money, eventText } from './msgpFormat.js?v=20261011b';

const MSG = 'msgp-msg';
const ERP = 'https://renjnt-cpu.github.io/kittymae-inventory-system/';
const OPEN_ORDER_STATES = ['new', 'pending', 'waitting'];   // an order in any other state is already being processed

export async function openDetail(id, { onChange } = {}) {
  document.querySelectorAll('.msgp-drawer-wrap').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'msgp-drawer-wrap';
  wrap.innerHTML = '<div class="msgp-drawer-back"></div><aside class="msgp-drawer" role="dialog" aria-modal="true" aria-label="Conversation"><div class="msgp-dr-body"><p class="muted">Loading…</p></div></aside>';
  document.body.appendChild(wrap);
  document.body.classList.add('msgp-noscroll');
  const drawer = wrap.querySelector('.msgp-drawer');
  const bodyEl = wrap.querySelector('.msgp-dr-body');
  const close = () => { wrap.remove(); document.body.classList.remove('msgp-noscroll'); document.removeEventListener('keydown', onKey, true); try { history.replaceState(null, '', location.pathname); } catch (e) { /* harmless */ } };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.dlg-backdrop')) close(); };
  document.addEventListener('keydown', onKey, true);
  wrap.querySelector('.msgp-drawer-back').addEventListener('click', close);
  try { history.replaceState(null, '', location.pathname + '?c=' + id); } catch (e) { /* harmless */ }

  let d = null;
  async function load() {
    try { d = await msgpConversation(id); render(); }
    catch (err) { bodyEl.innerHTML = '<div class="msgp-dr-head"><h2>Conversation</h2><button type="button" class="btn small secondary" data-close>Close</button></div><div class="msg error">' + esc(String(err.message || err)) + '</div>'; }
  }
  async function act(fn, okText) {
    try { await fn(); toast(MSG, okText || 'Saved.'); await load(); if (onChange) onChange(); }
    catch (err) { toast(MSG, err.message || String(err), true); await load(); }
  }

  function row(label, value) { return '<div class="msgp-kv"><span class="muted">' + esc(label) + '</span><span>' + value + '</span></div>'; }
  const sel = (idv, list, cur, disabled) => '<select id="' + idv + '"' + (disabled ? ' disabled' : '') + '>' + list.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';

  function render() {
    const r = d.row, o = d.order, p = d.perms;
    const cats = {}; for (const c of d.categories || []) cats[c.key] = c;
    const wcol = WAIT_COLOR[r.wait_band] || 'gray';
    const m = d.metrics || {};
    const orderLocked = o && o.found && !OPEN_ORDER_STATES.includes(o.status);
    const warnChange = r.intents.includes('order_change') || r.intents.includes('cancellation') || r.intent === 'order_change' || r.intent === 'cancellation';
    const kmco = r.page_label && /kittymae\.co/i.test(r.page_label);
    bodyEl.innerHTML =
      '<div class="msgp-dr-head"><div><h2>' + esc(r.customer_name) + '</h2><div class="muted">' + esc(r.page_label) + (r.branch_name ? ' · ' + esc(r.branch_name) : ' · branch not known yet') + (r.customer_phone ? ' · ' + esc(r.customer_phone) : '') + '</div></div>' +
        '<button type="button" class="btn small secondary" data-close aria-label="Close">Close ✕</button></div>' +
      '<div class="msgp-badges">' + badgesHtml(r, { categories: cats }) + '</div>' +
      (r.escalated ? '<div class="msg error msgp-esc"><b>Escalated: ' + esc(r.escalation_reason || '') + '</b>' + (r.escalation_note ? ' — ' + esc(r.escalation_note) : '') + (p.escalate ? ' <button type="button" class="btn small secondary" data-act="deescalate">Remove escalation</button>' : '') + '</div>' : '') +
      '<div class="msgp-dr-actions"><a class="btn" href="' + esc(r.open_url) + '" target="_blank" rel="noopener noreferrer">OPEN CHAT ↗</a>' +
        (r.status === 'resolved' || r.status === 'closed' ? (p.reply ? '<button type="button" class="btn secondary" data-act="reopen">Reopen</button>' : '') :
          (p.reply ? '<button type="button" class="btn secondary" data-act="resolve">Mark resolved…</button>' : '')) + '</div>' +

      '<section class="card msgp-dr-sec"><h3>Where it stands</h3>' +
        (r.needs_reply ? row('Waiting', badge(fmtWait(r.wait_min) + (WAIT_LABEL[r.wait_band] && r.wait_band !== 'normal' ? ' · ' + WAIT_LABEL[r.wait_band] : ''), wcol) + (r.sla_breached ? ' ' + badge('Over reply target (' + r.sla_target + ' min)', 'red') : '')) : row('Needs reply', 'No — staff replied ' + esc(ago(r.last_staff_reply_at)))) +
        row('Unanswered messages', esc(r.unanswered_count)) + row('Follow-ups', esc(r.follow_up_count)) +
        row('Last customer message', esc(stamp(r.last_customer_at))) + row('Last staff reply', esc(stamp(r.last_staff_reply_at))) +
        (r.snippet ? '<div class="msgp-snippet">“' + esc(r.snippet) + '”<div class="muted">The latest unanswered message (internal view only)</div></div>' : '') +
      '</section>' +

      '<section class="card msgp-dr-sec"><h3>What was detected</h3>' +
        '<p class="muted">Worked out from the customer’s words by the word lists — a suggestion. Staff can change any of it; the change is saved with who made it. The tone describes <b>this conversation only</b>, never the customer.</p>' +
        '<div class="msgp-detect">' +
          '<div class="field"><label for="d-intent">Intent <span class="muted">' + (r.intent_conf != null && !r.intent_overridden ? '(' + Math.round(r.intent_conf * 100) + '% sure)' : '') + '</span></label>' +
            sel('d-intent', (d.categories || []).map((c) => [c.key, c.label]), r.intent, !p.change) + (r.intent_overridden ? '<button type="button" class="act-link" data-auto="intent">Back to automatic' + (r.intent_detected ? ' (' + esc((cats[r.intent_detected] || {}).label || r.intent_detected) + ')' : '') + '</button>' : '') + '</div>' +
          '<div class="field"><label for="d-tone">Tone <span class="muted">' + (r.tone_conf != null && !r.tone_overridden ? '(' + Math.round(r.tone_conf * 100) + '% sure)' : '') + '</span></label>' +
            sel('d-tone', Object.entries(TONES).map(([k, v]) => [k, v.label]), r.tone || 'neutral', !p.change) + (r.tone_overridden ? '<button type="button" class="act-link" data-auto="tone">Back to automatic (' + esc((TONES[r.tone_detected] || {}).label || '') + ')</button>' : '') + '</div>' +
          '<div class="field"><label for="d-priority">Priority</label>' +
            sel('d-priority', Object.entries(PRIORITIES).map(([k, v]) => [k, v.label]), r.priority, !p.change) + (r.priority_overridden ? '<button type="button" class="act-link" data-auto="priority">Back to automatic</button>' : '') + '</div>' +
        '</div>' +
        row('Reason detected', esc(r.reason || '—')) +
        (r.needs_review ? '<div class="msg error">NEEDS STAFF REVIEW — the detection is not sure. Please set the intent yourself.</div>' : '') +
        ((d.analysis || []).length ? '<details class="msgp-tech"><summary>Detection history (' + d.analysis.length + ')</summary>' + d.analysis.map((a) => '<div class="msgp-hist">' + esc(stamp(a.at)) + ' — ' + esc((cats[a.intent] || {}).label || a.intent || '—') + ' · ' + esc((TONES[a.tone] || {}).label || a.tone || '') + ' · ' + esc(a.priority || '') +
          (a.intent_conf != null ? ' · ' + Math.round(a.intent_conf * 100) + '%' : '') + ' <span class="muted">(' + esc(a.source) + ') ' + esc(a.reason || '') + '</span></div>').join('') + '</details>' : '') +
      '</section>' +

      '<section class="card msgp-dr-sec"><h3>Order</h3>' + orderHtml(r, o, d.refunds || [], { orderLocked, warnChange, kmco }) + '</section>' +

      '<section class="card msgp-dr-sec"><h3>Handling</h3><div class="msgp-detect">' +
        '<div class="field"><label for="d-assign">Assigned to</label><select id="d-assign"' + (p.assign ? '' : ' disabled') + '><option value="">Nobody</option>' +
          (d.staff || []).map((s) => '<option value="' + esc(s.id) + '"' + (s.id === r.assigned_to ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
          (r.assigned_to && !(d.staff || []).some((s) => s.id === r.assigned_to) ? '<option value="' + esc(r.assigned_to) + '" selected>' + esc(r.assigned_name || 'Assigned') + '</option>' : '') + '</select>' +
          (r.pancake_assignee ? '<div class="muted">In Pancake: ' + esc(r.pancake_assignee) + '</div>' : '') + '</div>' +
        '<div class="field"><label for="d-status">Status</label>' + sel('d-status', Object.entries(STATUSES).filter(([k]) => k !== 'resolved' || r.status === 'resolved'), r.status, !p.reply) + '</div>' +
        '<div class="field"><label for="d-snooze">Snooze</label><select id="d-snooze"' + (p.reply ? '' : ' disabled') + '><option value="">' + (r.snooze_until ? 'Snoozed until ' + esc(stamp(r.snooze_until)) : 'Not snoozed') + '</option><option value="60">1 hour</option><option value="180">3 hours</option><option value="1440">1 day</option>' + (r.snooze_until ? '<option value="clear">Clear snooze</option>' : '') + '</select></div>' +
      '</div>' +
      (p.escalate && !r.escalated ? '<div><button type="button" class="btn small secondary" data-act="escalate">Escalate to supervisors…</button></div>' : '') +
      (r.resolved_at ? row('Resolved', esc(stamp(r.resolved_at)) + (r.resolved_by ? ' by ' + esc(r.resolved_by) : '') + (r.resolution_note ? ' — ' + esc(r.resolution_note) : '')) : '') +
      '</section>' +

      (d.suggested_reply ? '<section class="card msgp-dr-sec"><h3>Suggested reply</h3><p class="muted">A starting point written for this kind of message — read it, change it, then paste it into the chat. It is <b>never sent automatically</b>, and it makes no promise about delivery, payment or refunds.</p>' +
        '<textarea id="d-reply" rows="5" spellcheck="false">' + esc(d.suggested_reply) + '</textarea><div class="msgp-actions"><button type="button" class="btn small" data-act="copy">Copy reply</button><a class="btn small secondary" href="' + esc(r.open_url) + '" target="_blank" rel="noopener noreferrer">OPEN CHAT ↗</a></div></section>' : '') +

      '<section class="card msgp-dr-sec"><h3>Response times</h3>' +
        row('First response', m.first_response_min != null ? esc(fmtWait(m.first_response_min)) : '—') + row('Average response', m.avg_response_min != null ? esc(fmtWait(m.avg_response_min)) : '—') +
        row('Messages (recorded)', esc((m.customer_messages || 0) + ' from the customer, ' + (m.staff_messages || 0) + ' from staff')) +
        '<div class="muted">Measured from the messages Message Pancake has seen. Reply targets are internal monitoring goals only.</div></section>' +

      '<section class="card msgp-dr-sec"><h3>Internal notes</h3><p class="muted">Only staff see these. They are never sent to the customer.</p>' +
        (d.notes.length ? d.notes.map((n) => '<div class="msgp-note"><div>' + esc(n.note) + '</div><div class="muted">' + esc(n.by || 'Someone') + ' · ' + esc(stamp(n.at)) + '</div></div>').join('') : '<div class="muted">No notes yet.</div>') +
        (p.reply ? '<div class="field"><label for="d-note">Add a note</label><textarea id="d-note" rows="2" maxlength="2000" placeholder="e.g. Customer already sent GCash. Finance checking."></textarea></div><button type="button" class="btn small" data-act="note">Save note</button>' : '') +
      '</section>' +

      '<section class="card msgp-dr-sec"><h3>Timeline</h3>' + (d.timeline.length ? '<ol class="msgp-tl">' + d.timeline.map((e) => '<li><span class="muted">' + esc(stamp(e.at)) + '</span> ' + esc(eventText(e)) + '</li>').join('') + '</ol>' : '<div class="muted">Nothing yet.</div>') + '</section>';
  }

  function orderHtml(r, o, refunds, f) {
    if (!r.order_ref) {
      return (r.possible_new_order ? '<div class="msg ok"><b>POSSIBLE NEW ORDER</b> — the customer looks ready to buy and no order is linked yet. Nothing was created automatically.</div>' : '<p class="muted">No order is linked. Orders are linked by the chat’s own id or by an exact phone number — never by name.</p>') +
        '<div class="msgp-actions"><a class="btn small" href="branches.html?tab=pos">CREATE / START ORDER</a></div>';
    }
    if (!o || o.found === false) return row('Order', '#' + esc(r.order_ref)) + '<div class="muted">The order record could not be read.</div>';
    return row('Order', '<b>#' + esc(o.order_ref) + '</b>' + (o.order_count > 1 ? ' <span class="muted">(' + o.order_count + ' orders from this customer)</span>' : '')) +
      row('Status', esc(o.status_name || o.status)) + row('Ordered', esc(stamp(o.ordered_at))) + row('Amount', esc(money(o.amount))) + row('Payment', esc(o.payment_status)) + row('Branch', esc(o.branch || '—')) +
      (d.row.linked_via === 'phone' ? '<div class="muted">Matched by the customer’s phone number (the chat id does not match this order). Please check it is the right person.</div>' : '') +
      (f.orderLocked && f.warnChange ? '<div class="msg error"><b>Careful:</b> this order is already “' + esc(o.status_name || o.status) + '”. Check with the warehouse before changing or cancelling it — nothing is changed from here.</div>' : '') +
      '<div class="msgp-actions"><a class="btn small secondary" href="' + ERP + (f.kmco ? 'online-orders-kmco.html' : 'online-orders.html') + '" target="_blank" rel="noopener noreferrer">View online orders ↗</a>' +
        (refunds.length ? refunds.map((x) => '<a class="btn small secondary" href="' + ERP + 'refunds.html?open=' + esc(x.id) + '" target="_blank" rel="noopener noreferrer">View refund ' + esc(x.number || '#' + x.id) + ' (' + esc(x.status || '') + ') ↗</a>').join('') : '') +
        ((r.intents.includes('refund_return') || r.intent === 'refund_return') && !refunds.length ? '<a class="btn small" href="' + ERP + 'refunds.html" target="_blank" rel="noopener noreferrer">CREATE REFUND REQUEST ↗</a>' : '') +
        '<button type="button" class="btn small secondary" data-act="copyorder">Copy order #</button></div>' +
      ((r.intents.includes('payment_issue') || r.payment_proof) ? '<div class="muted">Payment screenshots and “I paid” messages are never verified here — finance confirms payments in the usual way.</div>' : '');
  }

  // ---- events
  wrap.addEventListener('change', (e) => {
    const r = d && d.row; if (!r) return;
    const idv = e.target.id;
    if (idv === 'd-intent') act(() => msgpCorrect(id, { intent: e.target.value }), 'Intent changed.');
    else if (idv === 'd-tone') act(() => msgpCorrect(id, { tone: e.target.value }), 'Tone changed.');
    else if (idv === 'd-priority') act(() => msgpCorrect(id, { priority: e.target.value }), 'Priority changed.');
    else if (idv === 'd-assign') act(() => msgpAssign(id, e.target.value || null), e.target.value ? 'Assigned.' : 'Unassigned.');
    else if (idv === 'd-status') act(() => msgpSetStatus(id, e.target.value), 'Status updated.');
    else if (idv === 'd-snooze' && e.target.value) act(() => msgpSnooze(id, e.target.value === 'clear' ? null : Number(e.target.value)), e.target.value === 'clear' ? 'Snooze cleared.' : 'Snoozed.');
  });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { close(); return; }
    const auto = e.target.closest('[data-auto]');
    if (auto) { act(() => msgpCorrect(id, { [auto.dataset.auto]: 'auto' }), 'Back to automatic.'); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'resolve') {
      const res = await reasonDialog({ title: 'Mark this conversation resolved', message: 'It leaves the attention list. If the customer writes again it comes back.', label: 'What was done? (kept with the record)', required: false, confirmLabel: 'Mark resolved' });
      if (res) act(() => msgpResolve(id, res.reason), 'Marked resolved.');
    } else if (a === 'reopen') act(() => msgpReopen(id), 'Reopened.');
    else if (a === 'deescalate') act(() => msgpDeescalate(id), 'Escalation removed.');
    else if (a === 'escalate') {
      const res = await reasonDialog({
        title: 'Escalate to the supervisors', message: 'Supervisors will see this conversation prominently until it is resolved.', label: 'What should they know?', required: false, confirmLabel: 'Escalate',
        extraFieldsHtml: '<div class="field"><label for="dlg-esc">Reason</label><select id="dlg-esc">' + ESCALATION_REASONS.map((x) => '<option>' + esc(x) + '</option>').join('') + '</select></div>',
        readExtra: (form) => ({ reason: form.querySelector('#dlg-esc').value }),
      });
      if (res) act(() => msgpEscalate(id, res.extra.reason, res.reason), 'Escalated.');
    } else if (a === 'note') {
      const t = wrap.querySelector('#d-note');
      if (t && t.value.trim()) act(() => msgpAddNote(id, t.value), 'Note saved.'); else toast(MSG, 'Write the note first.', true);
    } else if (a === 'copy' || a === 'copyorder') {
      const text = a === 'copy' ? (wrap.querySelector('#d-reply') || {}).value : (d.row.order_ref || '');
      try { await navigator.clipboard.writeText(text); toast(MSG, a === 'copy' ? 'Reply copied — paste it into the chat.' : 'Order number copied.'); }
      catch (err) { const t = wrap.querySelector('#d-reply'); if (t && a === 'copy') { t.select(); toast(MSG, 'Select the text and copy it (Ctrl+C).', true); } else toast(MSG, 'Could not copy.', true); }
    }
  });
  await load();
  drawer.focus();
  return { close };
}
