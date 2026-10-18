// Payment Verification -- the words, colours and small formatters every screen that shows a payment proof shares (the ERP Payment Verification page, the ERP
// Online Orders pages and the POS Message Pancake panel). No imports on purpose: the ERP and the POS carry an identical copy of this file.

export const esc = (s) => (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- numbers and dates (Manila time, like the rest of the system)
export const money = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) ? '—'
  : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const moneyShort = (n) => {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a >= 1e6) return '₱' + (v / 1e6).toFixed(a >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e4) return '₱' + (v / 1e3).toFixed(0) + 'K';
  return '₱' + Math.round(v).toLocaleString('en-PH');
};
export const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
};
export const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fmtShortDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fmtTime = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
};
/** today's calendar day in Manila as YYYY-MM-DD */
export const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
export const manilaDay = (iso) => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) : '';
/** "3 days ago" / "5 hours ago" / "just now" */
export function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.floor(s / 86400);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
export const fmtBytes = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

// ---------------------------------------------------------------- statuses and risk
export const STATUS = {
  PENDING: { label: 'Pending', cls: 'pv-st-pending', hint: 'Waiting for a person to check the proof.' },
  MISSING_INFORMATION: { label: 'Missing Information', cls: 'pv-st-missing', hint: 'The amount, reference or picture is missing.' },
  NEEDS_REVIEW: { label: 'Needs Review', cls: 'pv-st-review', hint: 'Someone asked for a second look.' },
  POSSIBLE_DUPLICATE: { label: 'Possible Duplicate', cls: 'pv-st-dup', hint: 'The reference or the picture is already used by another payment.' },
  VERIFIED: { label: 'Verified', cls: 'pv-st-verified', hint: 'A person checked it and credited it to the order.' },
  PARTIALLY_VERIFIED: { label: 'Partially Verified', cls: 'pv-st-partial', hint: 'Only part of the amount on the proof was credited.' },
  UNVERIFIED: { label: 'Unverified', cls: 'pv-st-unverified', hint: 'It was verified before; the credit was taken back.' },
  REJECTED: { label: 'Rejected', cls: 'pv-st-rejected', hint: 'The proof was not accepted.' },
  DUPLICATE_CONFIRMED: { label: 'Duplicate Confirmed', cls: 'pv-st-rejected', hint: 'A person confirmed it repeats another payment.' },
  // the order-level states (pv_order_summary)
  NO_PROOF: { label: 'No proof yet', cls: 'pv-st-none', hint: 'No payment proof was recorded for this order.' },
  OVERPAID: { label: 'Overpaid', cls: 'pv-st-over', hint: 'More was verified than the order needs.' },
};
export const statusLabel = (s) => (STATUS[s] || { label: s || '—' }).label;
export const statusBadge = (s) => '<span class="badge pv-badge ' + (STATUS[s] || { cls: 'pv-st-none' }).cls + '" title="' + esc((STATUS[s] || {}).hint || '') + '">' + esc(statusLabel(s)) + '</span>';

export const RISK = {
  NONE: { label: 'None', cls: 'pv-risk-none' }, LOW: { label: 'Low', cls: 'pv-risk-low' }, MEDIUM: { label: 'Medium', cls: 'pv-risk-medium' },
  HIGH: { label: 'High', cls: 'pv-risk-high' }, VERY_HIGH: { label: 'Very high', cls: 'pv-risk-veryhigh' }, INFO: { label: 'Same order', cls: 'pv-risk-info' },
};
export const riskLabel = (r) => (RISK[r] || RISK.NONE).label;
export const riskRank = (r) => ({ INFO: 0, NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 }[r] || 0);
/** a badge for the duplicate risk; nothing at all when there is none */
export const riskBadge = (r) => (!r || r === 'NONE') ? '' : '<span class="badge pv-badge ' + (RISK[r] || RISK.LOW).cls + '">Duplicate risk: ' + esc(riskLabel(r)) + '</span>';

export const SOURCES = { ONLINE_ORDER: 'Online Orders', PANCAKE: 'Pancake chat', MANUAL_ENTRY: 'Manual entry', OTHER: 'Other', POS_SALE: 'POS sale', LAYAWAY_PAYMENT: 'Layaway payment' };
export const sourceLabel = (s) => SOURCES[s] || s || '—';

export const REJECT_REASONS = [
  ['DUPLICATE_PROOF', 'Duplicate proof'], ['REFERENCE_ALREADY_USED', 'Reference already used'], ['INVALID_PROOF', 'Invalid proof'],
  ['AMOUNT_MISMATCH', 'Amount does not match'], ['UNREADABLE_PROOF', 'Unreadable proof'], ['WRONG_ACCOUNT', 'Wrong account'],
  ['PAYMENT_NOT_FOUND', 'Payment not found'], ['EDITED_SCREENSHOT', 'Suspected edited screenshot'], ['OTHER', 'Other'],
];

export const MATCH_TYPES = {
  EXACT_REFERENCE: 'same reference number', NORMALIZED_REFERENCE: 'same reference number', SAME_IMAGE: 'same picture',
  SIMILAR_IMAGE: 'looks like the same picture', OTHER_ERP_PAYMENT: 'same reference in POS / layaway',
};

// ---------------------------------------------------------------- duplicate matches (what pv_find_matches returns)
const hasType = (m, ...t) => ((m && m.types) || []).some((x) => t.includes(x));
/** The sentence the screens use. "Reference X is already linked to Order #123 — Customer." (worded by what matched). Mirrors the database's own wording. */
export function matchSentence(m, ref) {
  const byRef = hasType(m, 'EXACT_REFERENCE', 'NORMALIZED_REFERENCE', 'OTHER_ERP_PAYMENT'), byImg = hasType(m, 'SAME_IMAGE', 'SIMILAR_IMAGE'), same = hasType(m, 'SAME_IMAGE');
  const o = (m && m.other) || {};
  const lead = byRef && byImg ? 'Reference ' + (ref || '—') + ' and this proof picture are already linked to '
    : same ? 'This proof picture is already linked to '
      : byImg ? 'This proof picture looks the same as the one linked to '
        : 'Reference ' + (ref || '—') + ' is already linked to ';
  return lead + (o.order_ref ? 'Order #' + o.order_ref : (o.pv_code || 'another payment')) + ' — ' + (o.customer_name || 'unknown customer') + '.';
}
export const matchTags = (m) => {
  const t = [];
  for (const x of new Set((m.types || []).map((y) => MATCH_TYPES[y]).filter(Boolean))) t.push(x);
  if (m.same_customer) t.push('same customer'); else if (m.cross_customer) t.push('different customer');
  if (m.same_amount) t.push('same amount');
  return t;
};

/** One duplicate warning as a card. opts.compare / opts.open add the buttons (the caller wires data-open-payment / data-compare). */
export function matchCardHtml(m, opts = {}) {
  const o = m.other || {}, sev = m.severity || 'LOW';
  const info = sev === 'INFO' || m.same_order;
  const who = o.verified_by ? ' by ' + esc(o.verified_by) : '';
  const state = o.status === 'RECORDED' ? 'Recorded in the ' + (m.kind === 'LAYAWAY_PAYMENT' ? 'layaway' : 'POS') + ' payments'
    : (['VERIFIED', 'PARTIALLY_VERIFIED'].includes(o.status) ? statusLabel(o.status).toUpperCase() + who + (o.verified_at ? ' on ' + fmtDate(manilaDay(o.verified_at)) : '') + (o.verified_via ? ' (' + (o.verified_via === 'PANCAKE' ? 'in Pancake' : o.verified_via === 'ERP' ? 'in the ERP' : esc(o.verified_via)) + ')' : '')
      : statusLabel(o.status));
  const head = info
    ? 'This order already has this proof' + (o.pv_code ? ' (' + esc(o.pv_code) + ')' : '') + ' — it was sent again for the same order, not a second payment.'
    : esc(matchSentence(m, opts.reference));
  return '<div class="pv-match pv-sev-' + esc(String(sev).toLowerCase()) + (m.blocking ? ' pv-blocking' : '') + '">' +
    '<div class="pv-match-head">' + (info ? '<span class="badge pv-badge pv-risk-info">Same order</span>' : '<span class="badge pv-badge ' + (RISK[sev] || RISK.LOW).cls + '">' + esc(riskLabel(sev)) + '</span>') +
      (m.blocking ? ' <span class="badge pv-badge pv-st-rejected">Blocks verification</span>' : '') + ' <b>' + head + '</b></div>' +
    '<div class="pv-match-body"><div>' + (o.pv_code ? '<b>' + esc(o.pv_code) + '</b> · ' : '') + esc(sourceLabel(o.source)) + ' · ' + money(o.amount) + ' · ' + state + '</div>' +
      '<div class="muted">' + [o.branch_name, o.reference ? 'reference ' + o.reference : '', o.method, o.submitted_at ? 'sent ' + fmtDate(manilaDay(o.submitted_at)) : ''].filter(Boolean).map(esc).join(' · ') + '</div>' +
      '<div class="pv-tags">' + matchTags(m).map((t) => '<span class="pv-tag">' + esc(t) + '</span>').join('') + '</div></div>' +
    ((opts.open && o.id) || (opts.compare && o.id && o.image) ? '<div class="pv-match-actions">' +
      (opts.open && o.id ? '<button type="button" class="btn small secondary" data-open-payment="' + esc(o.id) + '">Open that payment</button>' : '') +
      (opts.compare && o.id && o.image ? '<button type="button" class="btn small secondary" data-compare="' + esc(o.id) + '">Compare pictures</button>' : '') + '</div>' : '') +
    '</div>';
}

// ---------------------------------------------------------------- the audit trail in words
export const EVENT_LABELS = {
  PROOF_RECEIVED: 'Proof received', PROOF_RESENT: 'Same proof sent again', IMAGE_ADDED: 'Picture added', PROOF_OPENED: 'Proof opened',
  DUPLICATE_CHECKED: 'Duplicate check', DUPLICATE_DETECTED: 'Duplicate detected', REFERENCE_EDITED: 'Reference corrected', DETAILS_EDITED: 'Details corrected',
  VERIFIED: 'Verified', OVERRIDE: 'Verified with override', UNVERIFIED: 'Marked unverified', NEEDS_REVIEW: 'Needs review', REJECTED: 'Rejected',
  DUPLICATE_CONFIRMED: 'Duplicate confirmed', MOVED: 'Moved to another order', VERIFIED_IN_PANCAKE: 'Verified in Pancake',
  PANCAKE_CHANGED: 'Changed in Pancake', ACCOUNT_ADDED: 'Account added', ACCOUNT_CHANGED: 'Account changed', PANCAKE_METHOD_MAPPED: 'Pancake method linked',
  METHOD_RULE_CHANGED: 'Method rule changed',
};
export const eventLabel = (t) => EVENT_LABELS[t] || String(t || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const FIELD_LABELS = { reference: 'Reference', amount: 'Amount', payment_date: 'Payment date', payment_time: 'Payment time', method: 'Method', account_id: 'Account', customer_name: 'Customer', customer_phone: 'Phone' };
/** One readable line (plain text) for an event's details; the caller escapes it. */
export function eventDetail(e) {
  const d = (e && (e.detail || {})) || {};
  const t = e && (e.type || e.event_type);
  const parts = [];
  switch (t) {
    case 'PROOF_RECEIVED':
      if (d.source) parts.push(sourceLabel(d.source)); if (d.order) parts.push('Order #' + d.order); if (d.amount != null) parts.push(money(d.amount)); if (d.method) parts.push(d.method);
      if (d.reference) parts.push('reference ' + d.reference); if (d.images != null) parts.push(plural(d.images, 'picture')); break;
    case 'PROOF_RESENT': parts.push(d.note || 'Linked to the existing payment'); break;
    case 'DUPLICATE_DETECTED': case 'DUPLICATE_CHECKED':
      parts.push(d.matches ? plural(d.matches, 'possible match', 'possible matches') + (d.risk && d.risk !== 'NONE' ? ' — ' + riskLabel(d.risk) + ' risk' : '') : 'Nothing found');
      if (d.orders && d.orders.length) parts.push('Orders: ' + d.orders.map((x) => '#' + x).join(', '));
      if (d.status_change) parts.push('Status ' + statusLabel(d.status_change.from) + ' → ' + statusLabel(d.status_change.to)); break;
    case 'REFERENCE_EDITED': case 'DETAILS_EDITED':
      for (const [k, v] of Object.entries(d.changes || {})) parts.push((FIELD_LABELS[k] || k) + ': ' + (v.from == null || v.from === '' ? '(empty)' : (k === 'amount' ? money(v.from) : v.from)) + ' → ' + (v.to == null || v.to === '' ? '(empty)' : (k === 'amount' ? money(v.to) : v.to)));
      if (d.reason) parts.push('Reason: ' + d.reason); break;
    case 'VERIFIED': case 'OVERRIDE':
      if (d.amount != null) parts.push(money(d.amount)); if (d.reference) parts.push('reference ' + d.reference); if (d.order) parts.push('Order #' + d.order);
      if (d.reason) parts.push('Reason: ' + d.reason); if (d.original_orders && d.original_orders.length) parts.push('Reference also used on Order ' + d.original_orders.map((x) => '#' + x).join(', ')); if (d.note) parts.push(d.note); break;
    case 'UNVERIFIED': parts.push('Reason: ' + (d.reason || '—')); break;
    case 'NEEDS_REVIEW': if (d.note) parts.push(d.note); break;
    case 'REJECTED': parts.push(d.reason || ''); if (d.note) parts.push(d.note); break;
    case 'DUPLICATE_CONFIRMED':
      parts.push('Duplicate of ' + (d.original || 'another payment') + (d.original_order ? ' (Order #' + d.original_order + (d.original_customer ? ' — ' + d.original_customer : '') + ')' : ''));
      if (d.reason) parts.push('Reason: ' + d.reason); if (d.note) parts.push(d.note); break;
    case 'MOVED': parts.push('Order #' + (d.from_order || '—') + ' → Order #' + (d.to_order || '—') + (d.to_customer ? ' (' + d.to_customer + ')' : '')); if (d.reason) parts.push('Reason: ' + d.reason); break;
    case 'ACCOUNT_ADDED': case 'ACCOUNT_CHANGED': if (d.account) parts.push(d.account); if (d.type) parts.push(d.type); if (d.active === false) parts.push('turned off'); break;
    case 'PANCAKE_METHOD_MAPPED': parts.push('Pancake method ' + (d.pancake_payment_id || '') + (d.method ? ' → ' + d.method : '') + (d.rows_updated != null ? ' (' + plural(d.rows_updated, 'payment') + ' updated)' : '')); break;
    case 'METHOD_RULE_CHANGED': parts.push(d.method + ': proof ' + (d.proof_required ? 'required' : 'optional') + ', reference ' + (d.reference_required ? 'required' : 'optional') + (d.active === false ? ', turned off' : '')); break;
    default: if (d.note) parts.push(d.note); if (d.reason) parts.push(d.reason);
  }
  return parts.filter(Boolean).join(' · ');
}
export const EVENT_TYPES_FOR_FILTER = ['PROOF_RECEIVED', 'PROOF_RESENT', 'IMAGE_ADDED', 'PROOF_OPENED', 'DUPLICATE_DETECTED', 'DUPLICATE_CHECKED', 'REFERENCE_EDITED', 'DETAILS_EDITED', 'VERIFIED', 'OVERRIDE',
  'UNVERIFIED', 'NEEDS_REVIEW', 'REJECTED', 'DUPLICATE_CONFIRMED', 'MOVED', 'VERIFIED_IN_PANCAKE', 'ACCOUNT_ADDED', 'ACCOUNT_CHANGED', 'PANCAKE_METHOD_MAPPED', 'METHOD_RULE_CHANGED'];

// ---------------------------------------------------------------- order summary (pv_order_summary)
/** The plain-language lines for an order's payments: expected, verified, pending, rejected, still to pay / overpaid. */
export function orderSummaryLines(s) {
  if (!s || s.ok === false) return [];
  const lines = [];
  lines.push(['Order amount to be paid online', money(s.expected)]);
  lines.push(['Verified', money(s.verified)]);
  lines.push(['Pending verification', money(s.pending)]);
  if (Number(s.rejected) > 0) lines.push(['Rejected', money(s.rejected)]);
  if (s.expected != null) lines.push([Number(s.excess) > 0 ? 'Overpaid by' : 'Still to be paid', Number(s.excess) > 0 ? money(s.excess) : money(s.remaining)]);
  return lines;
}

// ---------------------------------------------------------------- pictures
/** An <img> for a proof picture ({kind,url,path,thumb} as the database returns it). The web address of a Pancake picture is used as is; a stored file is a private
 * one, so the tag only carries its path and pvApi.hydrateImages() swaps in a short-lived signed address after the markup is on the page. */
export function imgTag(im, { full = false, cls = 'pv-img', alt = 'Payment proof' } = {}) {
  if (!im) return '<span class="pv-noimg">No picture</span>';
  const path = full ? (im.path || im.storage_path) : (im.thumb || im.thumb_path || im.path || im.storage_path);
  const attr = im.url ? 'data-pv-url="' + esc(im.url) + '"' : path ? 'data-pv-path="' + esc(path) + '"' : '';
  if (!attr) return '<span class="pv-noimg">No picture</span>';
  return '<img class="' + cls + '" ' + attr + ' alt="' + esc(alt) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
}

// ---------------------------------------------------------------- small helpers
/** CSV for the exports (Excel opens a BOM-prefixed UTF-8 file correctly). rows are arrays of values. */
export function toCsv(header, rows) {
  const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const debounce = (fn, ms) => { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.cancel = () => clearTimeout(t); return f; };
export const PV_CODE = (n) => 'PV-' + String(n).padStart(6, '0');
/** Turns anything thrown into a sentence a person can act on. */
const TECHNICAL = /violates|constraint|relation "|syntax error|null value|permission denied|JSON|invalid input|duplicate key|does not exist|PGRST|JWT|Failed to fetch|NetworkError|timeout/i;
export const friendly = (err) => {
  const t = String((err && err.message) || err);
  return TECHNICAL.test(t) ? 'Something went wrong and nothing was saved. Please try again — if it keeps happening, tell an Admin. (Details: ' + t + ')' : t;
};
