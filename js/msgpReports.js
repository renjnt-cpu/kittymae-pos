// Message Pancake -- the management reports (message_pancake.analytics): message volumes, reply times, follow-up rate, complaints, payment and refund issues, tone trends,
// messages by branch, assigned / resolved conversations, and the inquiry -> ordering -> order funnel.
// The tone is a rule-based guess and is shown as a trend only; it is NOT used to judge staff (the staff tables show assigned / resolved / open conversations and reply times).
import { esc, toast } from './shell.js?v=20261012a';
import { msgpReport } from './messagePancakeApi.js?v=20261012a';
import { manilaToday, fmtWait } from './msgpFormat.js?v=20261012a';

const MSG = 'msgp-msg';
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const minTxt = (m) => (m == null ? '—' : fmtWait(m));

export function startReports({ root, getBranches }) {
  const today = manilaToday();
  const st = { from: addDays(today, -6), to: today, branch: '', data: null };

  root.innerHTML = '<div class="card msgp-filters"><div class="field"><label for="rp-from">From</label><input type="date" id="rp-from"></div><div class="field"><label for="rp-to">To</label><input type="date" id="rp-to"></div>' +
    '<div class="field" id="rp-branch-wrap"><label for="rp-branch">Branch</label><select id="rp-branch"><option value="">All branches</option></select></div>' +
    '<button type="button" class="btn small" id="rp-run">Show report</button><button type="button" class="btn small secondary" id="rp-csv" disabled>Download CSV</button></div><div id="rp-out"><p class="muted">Pick the dates and press Show report.</p></div>';
  const out = root.querySelector('#rp-out');
  root.querySelector('#rp-from').value = st.from; root.querySelector('#rp-to').value = st.to;

  function fillBranches() {
    const sel = root.querySelector('#rp-branch');
    const list = getBranches() || [];
    if (sel.options.length <= 1) sel.innerHTML = '<option value="">All branches</option>' + list.map((b) => '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('');
    sel.value = st.branch;
  }

  const card = (label, value, hint) => '<div class="tile"><div class="num">' + esc(value) + '</div><div class="lbl">' + esc(label) + (hint ? ' <span class="muted">' + esc(hint) + '</span>' : '') + '</div></div>';
  const table = (head, rows) => rows.length ? '<div class="table-scroll"><table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<div class="muted">Nothing in this period.</div>';

  // who answered the most customers: real people only (the database leaves out Botcake, the page itself, ...), best first, with a bar scaled to the leader
  function topAdmins(list) {
    if (!list || !list.length) return '<div class="muted">No replies in this period.</div>';
    const max = Math.max(1, ...list.map((x) => x.customers));
    return '<div class="table-scroll"><table class="msgp-top"><thead><tr><th>#</th><th>Admin (as named in Pancake)</th><th>Customers assisted</th><th>Replies sent</th><th>Average first reply</th></tr></thead><tbody>' +
      list.map((x, i) => '<tr' + (i === 0 ? ' class="msgp-top-first"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(x.staff) + '</td>' +
        '<td><div class="msgp-bar"><span style="width:' + Math.max(2, Math.round(100 * x.customers / max)) + '%"></span><b>' + esc(x.customers) + '</b></div></td>' +
        '<td>' + esc(x.messages) + '</td><td>' + esc(minTxt(x.avg_response_min)) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  function draw(d) {
    const t = d.totals, f = d.funnel;
    out.innerHTML =
      '<div class="tiles msgp-tiles">' +
        card('Messages received', t.messages_received) + card('Conversations', t.conversations) + card('Unanswered right now', t.unanswered_now) +
        card('Average reply time', minTxt(t.avg_response_min), t.median_response_min != null ? '(median ' + fmtWait(t.median_response_min) + ')' : '') + card('Times a customer was never answered', t.unanswered_streaks) +
        card('Orders from messages', t.orders_from_messages) + card('Follow-up rate', t.follow_up_rate_pct == null ? '—' : t.follow_up_rate_pct + '%') +
        card('Complaints', t.complaints) + card('Payment issues', t.payment_issues) + card('Delivery issues', t.delivery_issues) + card('Refund requests', t.refund_requests) + card('Cancellation requests', t.cancellations) + card('Escalated', t.escalated) +
      '</div>' +
      '<div class="card"><h3>Top admins — customers assisted</h3><p class="muted">The admins who replied to the most different customers in this period. Only real people are counted: Botcake, BotcakeAI and the page itself are left out. It counts activity, not quality — one long, careful chat counts once.</p>' +
        topAdmins(d.top_admins) + '</div>' +
      '<div class="card"><h3>Inquiry → order</h3>' + table(['Conversations', 'Wanted to order', 'Linked to an order', 'Order paid', 'Order delivered'], [[f.conversations, f.ordering, f.with_order, f.order_paid, f.order_delivered]]) +
        '<div class="muted">“Paid” and “delivered” come from the order’s own Pancake fields. Orders are linked by the chat id or an exact phone number.</div></div>' +
      '<div class="card"><h3>What customers wrote about</h3>' + table(['Category', 'Conversations'], (d.intents || []).map((x) => [x.label, x.n])) + '</div>' +
      '<div class="card"><h3>Customer tone by day</h3><p class="muted">How many conversations looked Positive / Neutral / Concerned / Frustrated / Angry each day. A rule-based guess about conversations, not about people.</p>' +
        table(['Day', 'Positive', 'Neutral', 'Concerned', 'Frustrated', 'Angry'], (d.tone_trend || []).map((x) => [x.day, x.positive, x.neutral, x.concerned, x.frustrated, x.angry])) + '</div>' +
      '<div class="card"><h3>Messages by branch</h3>' + table(['Branch', 'Conversations', 'Unanswered now', 'Complaints', 'Payment issues', 'Refund requests'], (d.by_branch || []).map((x) => [x.branch, x.conversations, x.unanswered_now, x.complaints, x.payment_issues, x.refund_requests])) + '</div>' +
      '<div class="card"><h3>Handling (management)</h3><p class="muted">Who was given which conversations, and how many they closed. Not a score: conversations differ a lot, and the detection is only a guide.</p>' +
        table(['Assigned to', 'Conversations', 'Replied / resolved', 'Still open'], (d.by_assignee || []).map((x) => [x.name, x.assigned, x.resolved, x.open])) +
        '<h3>Resolved by</h3>' + table(['Who', 'Resolved in this period'], (d.resolved_by || []).map((x) => [x.name, x.resolved])) +
        '<h3>Replies in Pancake</h3>' + table(['Staff (as named in Pancake)', 'First replies', 'Average reply time'], (d.replies_by_staff || []).map((x) => [x.staff, x.replies, minTxt(x.avg_response_min)])) + '</div>';
    root.querySelector('#rp-csv').disabled = false;
  }

  async function run() {
    st.from = root.querySelector('#rp-from').value; st.to = root.querySelector('#rp-to').value; st.branch = root.querySelector('#rp-branch').value;
    out.innerHTML = '<p class="muted">Working it out…</p>';
    try { st.data = await msgpReport(st.from, st.to, st.branch ? Number(st.branch) : null); draw(st.data); }
    catch (err) { out.innerHTML = '<div class="msg error">' + esc(String(err.message || err)) + '</div>'; }
  }

  function csv() {
    const d = st.data; if (!d) return;
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['Message Pancake report', d.from + ' to ' + d.to].map(q).join(','), '', ['Measure', 'Value'].map(q).join(',')];
    for (const [k, v] of Object.entries(d.totals)) lines.push([k, v].map(q).join(','));
    lines.push('', ['Top admins', 'Customers assisted', 'Replies sent', 'First replies', 'Average first reply (min)'].map(q).join(','));
    for (const x of d.top_admins || []) lines.push([x.staff, x.customers, x.messages, x.first_replies, x.avg_response_min].map(q).join(','));
    lines.push('', ['Category', 'Conversations'].map(q).join(','));
    for (const x of d.intents || []) lines.push([x.label, x.n].map(q).join(','));
    lines.push('', ['Day', 'Positive', 'Neutral', 'Concerned', 'Frustrated', 'Angry'].map(q).join(','));
    for (const x of d.tone_trend || []) lines.push([x.day, x.positive, x.neutral, x.concerned, x.frustrated, x.angry].map(q).join(','));
    lines.push('', ['Branch', 'Conversations', 'Unanswered now', 'Complaints', 'Payment issues', 'Refund requests'].map(q).join(','));
    for (const x of d.by_branch || []) lines.push([x.branch, x.conversations, x.unanswered_now, x.complaints, x.payment_issues, x.refund_requests].map(q).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'message-pancake-report-' + d.from + '-to-' + d.to + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    toast(MSG, 'Report downloaded.');
  }

  root.querySelector('#rp-run').addEventListener('click', run);
  root.querySelector('#rp-csv').addEventListener('click', csv);
  return { onShow() { fillBranches(); if (!st.data) run(); } };
}
