// Reusable payment lines for any form that takes money in or out: up to three rows of Method / Amount / Date / Reference / Proof,
// a live "due · paying now · balance" summary, and one read() that checks the rows the same way everywhere (each amount above 0,
// no date in the future or before the record's own date, the total never above what is due). New Scrap and Subasta "Mark Sold"
// use it today; Layaway and POS adopt it in a later phase. The component keeps no state besides the inputs: build the HTML with
// paymentRowsHtml(), put it in a container, then mountPaymentRows() on that container.
import { PAYMENT_METHODS } from './paymentMethods.js?v=20261007p';
import { paymentStatusOf, paymentChipHtml } from './paymentStatus.js?v=20261007p';
import { manilaToday } from './opsDates.js?v=20261007p';

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** The inner HTML of a "Payment" section. recorder = the name shown on each row; hint = a short note under the buttons. */
export function paymentRowsHtml({ recorder = 'you', max = 3, methods = PAYMENT_METHODS, hint = '', proof = true, dates = true, labelOf = (m) => m } = {}) {
  let h = '<div class="lw-note-box" data-pr-summary style="margin-bottom:8px;"></div>';
  for (let i = 0; i < max; i++) {
    h += '<div class="sc-payrow" data-pr-row="' + i + '"' + (i ? ' hidden' : '') + '>' +
      '<div class="sc-payrow-head"><b>Payment ' + (i + 1) + '</b><span class="muted">recorded by ' + escHtml(recorder) + '</span>' +
        (i ? '<button type="button" class="act-link" data-pr-remove>Remove</button>' : '') + '</div>' +
      '<div class="sc-row2">' +
        '<div class="field"><label>Method</label><select data-f="method">' + methods.map((m) => '<option value="' + escHtml(m) + '">' + escHtml(labelOf(m)) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Amount (₱)</label><input type="number" data-f="amount" step="0.01" min="0" inputmode="decimal"></div>' +
      '</div>' +
      '<div class="sc-row2">' +
        '<div class="field"' + (dates ? '' : ' hidden') + '><label>Date sent / paid</label><input type="date" data-f="date"></div>' +
        '<div class="field"><label data-ref-label>Reference number</label><input type="text" data-f="ref"></div>' +
      '</div>' +
      '<div class="field"' + (proof ? '' : ' hidden') + '><label>Proof of payment</label><input type="file" data-f="proof" accept="image/*,.pdf"></div>' +
    '</div>';
  }
  h += '<button type="button" class="btn small secondary" data-pr-add>+ Add another payment</button>';
  if (hint) h += '<p class="muted" style="font-size:11px;margin:6px 0 0;">' + hint + '</p>';
  return h;
}

/** root = the container holding paymentRowsHtml(). Options:
 *  getDue() -> the amount to be paid (0 = not known yet); getMinDate() -> earliest allowed payment date ('' = none), named
 *  minDateLabel in the error; dueLabel -> what the due amount is called ("Final amount", "Sale price"); emptyText -> shown
 *  while the due amount is 0; onChange() -> after any change (summary redrawn); followDue (default true) -> the first row starts on the due
 *  amount; allowOver -> read() lets the total go above the due amount (the caller asks "record anyway?").
 *  Returns { read(), reset(), sync(), setDefaultDate(ymd), total() }: call sync() whenever the due amount changed -- the first row follows it until someone
 *  types in that row's amount. read() -> { payments: [{ method, amount, reference, paidAt, file }], sum } or { error, el }.
 *  refRequired(method) -> true: that method's row must have a reference number (the label shows a star and read() checks it). */
export function mountPaymentRows(root, { getDue = () => 0, getMinDate = () => '', minDateLabel = 'record date', dueLabel = 'Final amount',
  emptyText = 'Enter the amount to see what is owed.', onChange = null, followDue = true, allowOver = false, refRequired = null } = {}) {
  const rows = [...root.querySelectorAll('[data-pr-row]')];
  const f = (i, n) => rows[i].querySelector('[data-f="' + n + '"]');
  const summary = root.querySelector('[data-pr-summary]');
  const addBtn = root.querySelector('[data-pr-add]');
  const today = () => manilaToday();
  let defaultDate = ''; // what a row's date box starts on (today unless setDefaultDate() says otherwise)
  const startDate = () => defaultDate || today();
  const shown = () => rows.map((_, i) => i).filter((i) => !rows[i].hidden);
  const paying = () => shown().reduce((s, i) => s + (Number(f(i, 'amount').value) || 0), 0);

  function syncRefLabels() {
    if (!refRequired) return;
    rows.forEach((row, i) => { const l = row.querySelector('[data-ref-label]'); if (l) l.textContent = 'Reference number' + (refRequired(f(i, 'method').value) ? ' *' : ''); });
  }
  function renderSummary() {
    syncRefLabels();
    const due = Number(getDue()) || 0, p = paying();
    const min = getMinDate() || '';
    rows.forEach((_, i) => { f(i, 'date').max = today(); f(i, 'date').min = min; });
    addBtn.hidden = !rows.some((r) => r.hidden);
    if (due > 0) {
      summary.innerHTML = escHtml(dueLabel) + ' <b>' + money(due) + '</b> · paying now <b>' + money(p) + '</b> · balance <b>' + money(Math.max(due - p, 0)) + '</b> → ' +
        (p > due + 0.01 ? '<span class="badge st-red">MORE THAN THE ' + escHtml(dueLabel.toUpperCase()) + '</span>' : paymentChipHtml(paymentStatusOf(due, p)));
    } else summary.textContent = emptyText;
    if (onChange) onChange();
  }

  function sync() {
    const a0 = f(0, 'amount');
    if (followDue && !a0.dataset.touched) { const due = Number(getDue()) || 0; a0.value = due > 0 ? due.toFixed(2) : ''; }
    renderSummary();
  }

  function clearRow(i) {
    f(i, 'method').selectedIndex = 0; f(i, 'amount').value = ''; delete f(i, 'amount').dataset.touched;
    f(i, 'date').value = startDate(); delete f(i, 'date').dataset.touched; f(i, 'ref').value = ''; f(i, 'proof').value = '';
  }
  function reset() { rows.forEach((row, i) => { row.hidden = i > 0; clearRow(i); }); renderSummary(); }

  rows.forEach((row, i) => {
    f(i, 'amount').addEventListener('input', () => { f(i, 'amount').dataset.touched = '1'; renderSummary(); });
    f(i, 'method').addEventListener('change', () => renderSummary());
    f(i, 'date').addEventListener('input', () => { f(i, 'date').dataset.touched = '1'; renderSummary(); });
    const rm = row.querySelector('[data-pr-remove]');
    if (rm) rm.addEventListener('click', () => { row.hidden = true; clearRow(i); renderSummary(); });
  });
  addBtn.addEventListener('click', () => {
    const next = rows.findIndex((r) => r.hidden);
    if (next < 0) return;
    rows[next].hidden = false;
    renderSummary();
    if (!f(next, 'amount').value) f(next, 'amount').focus();
  });

  function read() {
    const due = Number(getDue()) || 0, min = getMinDate() || '';
    const payments = [];
    let sum = 0;
    for (const i of shown()) {
      const raw = f(i, 'amount').value;
      if (raw === '') continue; // an empty row means "nothing paid on this line"
      const amount = Number(raw);
      if (!(amount > 0)) return { error: 'A payment must be more than ₱0.', el: f(i, 'amount') };
      const paidAt = f(i, 'date').value || today();
      if (paidAt > today()) return { error: 'A payment date cannot be in the future.', el: f(i, 'date') };
      if (min && paidAt < min) return { error: 'A payment date cannot be before the ' + minDateLabel + '.', el: f(i, 'date') };
      if (refRequired && refRequired(f(i, 'method').value) && !f(i, 'ref').value.trim()) return { error: f(i, 'method').value + ' payments need a reference number.', el: f(i, 'ref') };
      sum += amount;
      payments.push({ method: f(i, 'method').value, amount: r2(amount), reference: f(i, 'ref').value.trim(), paidAt, file: f(i, 'proof').files[0] || null });
    }
    if (!allowOver && due > 0 && sum > due + 0.01) return { error: 'The payments (' + money(sum) + ') add up to more than the ' + dueLabel.toLowerCase() + ' (' + money(due) + ').', el: f(0, 'amount') };
    return { payments, sum: r2(sum) };
  }

  /** Moves every date box nobody has touched to `ymd` (e.g. a layaway dated in the past: its downpayment is dated the same day). */
  function setDefaultDate(ymd) {
    defaultDate = ymd || '';
    rows.forEach((_, i) => { if (!f(i, 'date').dataset.touched) f(i, 'date').value = startDate(); });
    renderSummary();
  }

  /** The rows as typed, unchecked: [{ method, amount, reference }] (a row with no amount is skipped) -- for live totals such as change. */
  function peek() {
    return shown().map((i) => ({ method: f(i, 'method').value, amount: Number(f(i, 'amount').value) || 0, reference: f(i, 'ref').value.trim() })).filter((p) => p.amount > 0);
  }
  /** Puts one payment into the first free row (showing it). Returns false when every row is taken. */
  function addLine({ method, amount, reference = '', paidAt = '' }) {
    let i = shown().find((k) => f(k, 'amount').value === '');
    if (i === undefined) i = rows.findIndex((r) => r.hidden);
    if (i < 0) return false;
    rows[i].hidden = false;
    f(i, 'method').value = method;
    f(i, 'amount').value = amount == null ? '' : Number(amount).toFixed(2); f(i, 'amount').dataset.touched = '1';
    f(i, 'ref').value = reference || '';
    if (paidAt) { f(i, 'date').value = paidAt; f(i, 'date').dataset.touched = '1'; }
    renderSummary();
    return true;
  }
  /** Replaces every row with `list` ([{ method, amount, reference, paidAt }]). */
  function load(list) { reset(); (list || []).forEach(addLine); }

  reset();
  return { read, reset, sync, setDefaultDate, total: paying, peek, addLine, load };
}
