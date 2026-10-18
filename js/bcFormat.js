// Branch Capital -- small shared helpers: money and dates (Philippine peso, Manila time), the badges for statuses and receipts, the fixed lists (paid from, payment method, transport type),
// summary cards, and the CSV download used by the reports. No data access here.
import { esc } from './shell.js?v=20261018a';

export { esc };

export function money(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v < 0 ? '−₱' : '₱') + Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** A cash-out amount written with a minus sign (nothing at all for zero, so a day without expenses does not read "−₱0.00"). */
export function minus(n) {
  const v = Math.abs(Number(n || 0));
  return v > 0 ? '−' + money(v) : money(0);
}
/** Signed: +₱1,000.00 / −₱200.00 (for cash in / out and variances). */
export function signed(n) {
  const v = Number(n || 0);
  return (v > 0 ? '+' : '') + money(v);
}
export const num = (n) => Number(n || 0);

const parts = (iso) => String(iso || '').slice(0, 10).split('-').map(Number);
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
}
export function fmtStamp(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function addDays(iso, n) {
  const [y, m, d] = parts(iso);
  const t = new Date(y, m - 1, d + n);
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
export const monthStart = (iso) => String(iso).slice(0, 8) + '01';
/** Monday of the week the date falls in. */
export function weekStart(iso) {
  const [y, m, d] = parts(iso);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(iso, -((dow + 6) % 7));
}
export const ageText = (days) => (days === null || days === undefined) ? '' : days <= 0 ? 'today' : days === 1 ? '1 day' : days + ' days';

export const PAID_FROM = ['Daily Sales / Cash', 'Branch Capital', 'Petty Cash', 'Bank Account', 'GCash / E-Wallet', 'Split Funding', 'Other'];
export const FUNDING_SOURCES = PAID_FROM.filter((p) => p !== 'Split Funding');
export const REPLENISH_SOURCES = ['Daily Sales / Cash', 'Branch Capital', 'Bank Account', 'GCash / E-Wallet', 'Other'];
export const METHODS = ['Cash', 'GCash', 'Maya', 'Bank Transfer', 'Check', 'Card', 'Other'];
export const TRANSPORT_TYPES = ['Taxi', 'Grab', 'Jeepney', 'Bus', 'Fuel', 'Parking', 'Toll', 'Courier', 'Delivery', 'Other'];
export const STATUSES = ['Draft', 'Recorded', 'Pending Approval', 'Approved', 'Rejected', 'Needs Receipt', 'Liquidated', 'Cancelled', 'Reversed'];
export const RECEIPT_STATUSES = ['Not Required', 'Receipt Required', 'Receipt Uploaded', 'No Receipt', 'Receipt Verified'];
export const MOVEMENT_KINDS = { DEPOSIT: 'Bank deposit', REMITTANCE: 'Remittance', OTHER_CASH_IN: 'Other cash in', OTHER_CASH_OUT: 'Other cash out', PETTY_FUNDING: 'Transfer to petty cash', PETTY_RETURN: 'Petty cash returned' };
export const LEVEL_NAMES = { 0: 'No approval', 1: 'Supervisor', 2: 'Manager', 3: 'Admin' };

const STATUS_COLOR = { Draft: 'gray', Recorded: 'blue', 'Pending Approval': 'yellow', Approved: 'green', Rejected: 'red', 'Needs Receipt': 'red', Liquidated: 'green', Cancelled: 'gray', Reversed: 'gray',
  Requested: 'yellow', Processed: 'green', 'Pending Liquidation': 'yellow', Closed: 'blue', Checked: 'blue', Reopened: 'gray', Voided: 'gray', Active: 'green' };
const RECEIPT_COLOR = { 'Not Required': 'gray', 'Receipt Required': 'yellow', 'Receipt Uploaded': 'blue', 'No Receipt': 'red', 'Receipt Verified': 'green' };
export const badge = (text, color) => '<span class="badge st-' + (color || 'gray') + '">' + esc(text) + '</span>';
export const statusBadge = (s) => badge(s, STATUS_COLOR[s] || 'gray');
export const receiptBadge = (s) => s && s !== 'Not Required' ? badge(s, RECEIPT_COLOR[s] || 'gray') : '';

export const optionsHtml = (list, selected, blank) => (blank !== undefined ? '<option value="">' + esc(blank) + '</option>' : '') +
  list.map((o) => { const v = Array.isArray(o) ? o[0] : o; const l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');

/** A summary card (same look as the lease / layaway cards). tone: bad | warn | ok | '' */
export function cardHtml({ label, value, sub, tone, id }) {
  return '<div class="lw-card static' + (tone ? ' tone-' + tone : '') + '"' + (id ? ' id="' + id + '"' : '') + '><span class="lw-card-l">' + esc(label) + '</span><span class="lw-card-n">' + value + '</span>' + (sub ? '<span class="lw-card-s">' + sub + '</span>' : '') + '</div>';
}
export const kv = (label, valueHtml) => '<div class="bc-kv"><span class="muted">' + esc(label) + '</span><span>' + valueHtml + '</span></div>';

/** Errors from a function result ({ok:false, errors:[...]}) as one readable sentence. */
export function errorsText(res, fallback) {
  if (res && Array.isArray(res.errors) && res.errors.length) return res.errors.join(' ');
  return fallback || 'That did not work. Please try again.';
}

/** Downloads rows as a CSV file Excel opens correctly (UTF-8 with a BOM). headers: [label]; rows: arrays of plain values. */
export function downloadCsv(filename, headers, rows) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = '﻿' + [headers].concat(rows).map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A horizontal bar for report rows: width = value / max. */
export function barHtml(value, max, label) {
  const pct = max > 0 ? Math.max(2, Math.round(Number(value) / max * 100)) : 0;
  return '<div class="bc-bar"><span style="width:' + pct + '%"></span><b>' + label + '</b></div>';
}
