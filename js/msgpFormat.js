// Message Pancake -- the wording, colours and small helpers the queue, the conversation panel, the reports and the POS attention panel share.
// Colour is never the only signal: every badge carries its text label (RED critical / angry, ORANGE urgent / frustrated / follow-up, YELLOW needs reply, GREEN ordering,
// BLUE inquiry, PURPLE payment, GRAY resolved / low).
import { esc } from './shell.js?v=20261011b';

export const TONES = {
  angry: { label: 'Angry', color: 'red' },
  frustrated: { label: 'Frustrated', color: 'orange' },
  concerned: { label: 'Concerned', color: 'yellow' },
  neutral: { label: 'Neutral', color: 'gray' },
  positive: { label: 'Positive', color: 'green' },
};
export const PRIORITIES = {
  critical: { label: 'CRITICAL', color: 'red' },
  high: { label: 'HIGH PRIORITY', color: 'orange' },
  normal: { label: 'Normal priority', color: 'gray' },
  low: { label: 'Low priority', color: 'gray' },
};
export const WAIT_COLOR = { normal: 'gray', attention: 'yellow', high: 'orange', urgent: 'red', none: 'gray' };
export const WAIT_LABEL = { normal: 'Normal', attention: 'Attention', high: 'High attention', urgent: 'Urgent follow-up', none: '' };
export const STATUSES = {
  unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In progress', waiting_customer: 'Waiting for customer',
  waiting_internal: 'Waiting for internal action', resolved: 'Resolved', closed: 'Closed',
};
export const ESCALATION_REASONS = ['Angry Customer', 'Repeated Follow-Up', 'Payment Problem', 'Refund', 'Large Order', 'VIP / Important Customer', 'Delivery Problem', 'Staff Needs Help', 'Other'];
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

export const badge = (text, color, title) => '<span class="badge msgp-b msgp-b-' + esc(color || 'gray') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';

/** 5 -> "5 min", 135 -> "2 h 15 min", 3000 -> "2 d 2 h" */
export function fmtWait(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return m + ' min';
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d + ' d' + (h ? ' ' + h + ' h' : '');
}

/** "3 min ago" / "2 h ago" / "Oct 4" from an ISO time. */
export function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  if (min < 1440) return Math.round(min / 60) + ' h ago';
  return stamp(iso);
}

/** "Oct 11, 4:58 AM" in Manila time. */
export function stamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "Maria Santos" -> "Maria S." for narrow places. */
export function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'Unknown';
  return parts[0] + ' ' + parts[1].charAt(0).toUpperCase() + '.';
}

export const pct = (x) => (x === null || x === undefined ? '—' : Math.round(Number(x) * 100) + '%');
export const money = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
export const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

/** The row of badges for a conversation (queue card and attention panel). */
export function badgesHtml(r, opts = {}) {
  const out = [];
  if (r.needs_reply && !opts.noNeedsReply) out.push(badge('NEEDS REPLY', 'yellow'));
  if (r.intent_label) out.push(badge(r.intent_label + (r.intent_overridden ? ' ✎' : ''), r.intent_color, r.intent_overridden ? 'Changed by staff' : 'Auto-detected'));
  for (const k of (r.intents || [])) {
    if (k === r.intent || k === 'urgent') continue;   // URGENT is shown once, from the flag
    const c = (opts.categories || {})[k];
    if (c) out.push(badge(c.label, c.color));
  }
  if (r.is_urgent) out.push(badge('URGENT', 'red'));
  const p = PRIORITIES[r.priority];
  if (p && (r.priority === 'critical' || r.priority === 'high')) out.push(badge(p.label, p.color, r.priority_overridden ? 'Changed by staff' : 'Auto'));
  const t = TONES[r.tone];
  if (t && r.tone !== 'neutral' && r.tone !== 'positive') out.push(badge('Tone: ' + t.label + (r.tone_overridden ? ' ✎' : ''), t.color, r.tone_overridden ? 'Changed by staff' : 'This conversation only'));
  if (r.possible_new_order) out.push(badge('POSSIBLE NEW ORDER', 'green'));
  if (r.payment_proof) out.push(badge('PAYMENT PROOF DETECTED', 'purple', 'Not verified — staff must check'));
  if (r.needs_review) out.push(badge('NEEDS STAFF REVIEW', 'gray', 'Low confidence'));
  if (r.escalated) out.push(badge('ESCALATED' + (r.escalation_reason ? ': ' + r.escalation_reason : ''), 'red'));
  return out.join(' ');
}

const EVENTS = {
  conversation_tracked: () => 'Conversation first seen by Message Pancake',
  customer_message: (d) => 'Customer messaged' + (d && d.count > 1 ? ' (' + d.count + ' messages)' : ''),
  staff_reply: (d) => 'Staff replied' + (d && d.by ? ' (' + d.by + ')' : '') + (d && d.response_sec != null ? ' — ' + fmtWait(Math.round(d.response_sec / 60)) + ' after the customer' : ''),
  classified: (d) => 'Detected: ' + (d && d.reason ? d.reason : (d && d.intent) || '') + (d && d.confidence != null ? ' (' + Math.round(d.confidence * 100) + '%)' : ''),
  order_linked: (d) => 'Linked to order #' + (d && d.order_ref),
  alert_opened: (d) => 'Attention alert opened (' + (d && d.priority) + ')',
  assigned: (d, who) => 'Assigned to ' + ((d && d.to) || 'someone') + (who ? ' by ' + who : ''),
  unassigned: (d, who) => 'Unassigned' + (who ? ' by ' + who : ''),
  status_changed: (d, who) => 'Status: ' + (STATUSES[d && d.from] || '') + ' → ' + (STATUSES[d && d.to] || (d && d.to)) + (who ? ' (' + who + ')' : '') + (d && d.note ? ' — ' + d.note : ''),
  resolved: (d, who) => 'Resolved' + (who ? ' by ' + who : '') + (d && d.note ? ' — ' + d.note : ''),
  reopened: (d) => 'Reopened' + (d && d.reason ? ' (' + d.reason + ')' : ''),
  snoozed: (d) => 'Snoozed for ' + fmtWait(d && d.minutes),
  snooze_cleared: () => 'Snooze cleared',
  note_added: (d, who) => 'Internal note added' + (who ? ' by ' + who : ''),
  corrected: (d, who) => (who || 'Staff') + ' changed ' + (d && d.field) + (d && d.cleared ? ' back to automatic' : ': ' + (d && d.from) + ' → ' + (d && d.to)),
  escalated: (d, who) => 'Escalated' + (who ? ' by ' + who : '') + (d && d.reason ? ': ' + d.reason : ''),
  deescalated: (d, who) => 'Escalation removed' + (who ? ' by ' + who : ''),
};
export function eventText(e) {
  const f = EVENTS[e.event];
  return f ? f(e.detail || {}, e.actor) : e.event;
}
