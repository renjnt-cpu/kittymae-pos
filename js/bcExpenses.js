// Branch Capital -- EXPENSES: the list, the "Add Expense" form (with Paid From, Split Funding, bill link, transport details, receipts), the rule dialogs that appear when petty cash is too low
// (INSUFFICIENT PETTY CASH) or when the funding has to be confirmed (CONFIRM EXPENSE FUNDING), the duplicate warning, and the expense panel (approve / reject / receipt / reverse / correct / reimburse).
// The page never moves money silently: every choice that changes where the money comes from is shown and confirmed first, and the database re-checks all of it.
import { esc, toast } from './shell.js?v=20261023a';
import { reasonDialog, confirmDialog } from './dialogs.js?v=20261023a';
import { branchBadge } from './branchColors.js?v=20261023a';
import {
  bcExpenseSave, bcExpenseDuplicates, bcBillsLookup, bcExpensesList, bcExpenseGet, bcExpenseDecide, bcExpenseReviewDuplicate, bcExpenseCancelDraft, bcExpenseReverse,
  bcExpenseCorrect, bcExpenseEdit, bcExpenseReimburse, bcPettyReplenishRequest, uploadReceipt, bcAttachVerify, receiptUrl, RECEIPT_ACCEPT, checkReceiptFile,
} from './bcApi.js?v=20261023a';
import { formDialog, choiceDialog, openDrawer } from './bcUi.js?v=20261023a';
import {
  money, fmtDate, fmtStamp, PAID_FROM, FUNDING_SOURCES, REPLENISH_SOURCES, METHODS, TRANSPORT_TYPES, STATUSES, RECEIPT_STATUSES, LEVEL_NAMES, optionsHtml, statusBadge, receiptBadge, badge, kv, errorsText, addDays,
} from './bcFormat.js?v=20261023a';

const VOID = ['Draft', 'Cancelled', 'Rejected', 'Reversed'];   // not counted in totals
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// ======================================================================================================================================
// the rule dialogs
// ======================================================================================================================================
function linesHtml(lines) {
  return '<table class="bc-mini"><tbody>' + (lines || []).map((l) => '<tr><td>' + esc(l.source) + (l.kind === 'employee_advance' ? ' <span class="muted">(employee advance)</span>' : '') + '</td><td class="num">' + money(l.amount) + '</td></tr>').join('') + '</tbody></table>';
}

/** CONFIRM EXPENSE FUNDING -- shown before a split or a switched funding is recorded. Resolves true to record. */
async function confirmFunding(res, payload) {
  const orig = payload.original_paid_from || payload.paid_from;
  const html =
    '<div class="bc-confirm">' +
      '<div class="bc-kv"><span class="muted">Expense total</span><b>' + money(res.total) + '</b></div>' +
      '<div class="bc-kv"><span class="muted">Original intended funding source</span><span>' + esc(orig) + '</span></div>' +
      (res.petty_available !== null && res.petty_available !== undefined ? '<div class="bc-kv"><span class="muted">Petty cash available</span><span>' + money(res.petty_available) + '</span></div>' : '') +
      '<div class="bc-kv"><span class="muted">Funding decision</span><b>' + esc(res.decision || 'Split funding') + '</b></div>' +
      '<p class="muted" style="margin:10px 0 4px;">This one expense will be funded by:</p>' + linesHtml(res.lines) +
      (Number(res.petty_amount) > 0 && res.petty_after !== null && res.petty_after !== undefined ? '<div class="bc-kv"><span class="muted">Petty cash left after this</span><span>' + money(res.petty_after) + '</span></div>' : '') +
      '<p class="bc-note">' + (Number(res.sales_cash_reduction) > 0
        ? 'Expected cash will go down by <b>' + money(res.sales_cash_reduction) + '</b> — only the part taken from daily sales / cash. Gross Sales is not changed.'
        : 'Nothing is taken from daily sales / cash. Gross Sales is not changed.') + '</p>' +
    '</div>';
  const out = await choiceDialog({ title: 'CONFIRM EXPENSE FUNDING', messageHtml: html, choices: [{ key: 'ok', label: 'Confirm & Record', primary: true }], cancelLabel: 'Cancel' });
  return !!out;
}

async function duplicateWarning(matches) {
  const html = '<p>A similar expense was already recorded. This is only a warning — if it is a different expense, record it anyway.</p><div class="bc-dups">' +
    (matches || []).map((m) => '<div class="bc-dup"><b>' + money(m.amount) + '</b> · ' + esc(fmtDate(m.date)) + ' · ' + esc(m.category) + ' — ' + esc(m.description) + '<div class="muted">' + esc(m.status) + ' · ' + esc(m.why) + (m.created_by ? ' · by ' + esc(m.created_by) : '') + '</div></div>').join('') + '</div>';
  const out = await choiceDialog({ title: 'POSSIBLE DUPLICATE EXPENSE', messageHtml: html, choices: [{ key: 'go', label: 'Record it anyway', primary: true }], cancelLabel: 'Cancel' });
  return !!out;
}

/** INSUFFICIENT PETTY CASH -- the four ways forward. Nothing has been recorded when this opens. Resolves {payload} to try again, {done, res} when a draft + replenishment request were made, or null. */
async function insufficientFlow(app, res, payload, correcting) {
  const avail = Number(res.available || 0);
  const total = Number(payload.amount);
  const shortfall = r2(Number(res.petty_needed !== undefined ? res.petty_needed : total) - avail);
  const summary =
    '<div class="bc-confirm"><div class="bc-kv"><span class="muted">Petty cash available (' + esc(res.fund_name || 'fund') + ')</span><b>' + money(avail) + '</b></div>' +
    '<div class="bc-kv"><span class="muted">Expense amount</span><b>' + money(total) + '</b></div>' +
    '<div class="bc-kv"><span class="muted">Shortfall</span><b style="color:var(--warn)">' + money(shortfall) + '</b></div></div>';
  if (payload.paid_from === 'Split Funding') {
    await choiceDialog({ title: 'INSUFFICIENT PETTY CASH', messageHtml: summary + '<p>The petty cash part of this split is more than the fund holds. Lower the petty cash amount (or use another source for the rest) and try again. Nothing was recorded.</p>', choices: [], cancelLabel: 'Back to the form' });
    return null;
  }
  const choices = [{ key: 'sales_full', label: 'PAY FULL AMOUNT FROM DAILY SALES / CASH', hint: 'The whole ' + money(total) + ' is taken from daily sales / cash; petty cash is not used.' }];
  if (avail > 0) choices.push({ key: 'split', label: 'USE PETTY CASH + SALES CASH FOR THE SHORTFALL', hint: 'Petty cash ' + money(avail) + ' + daily sales / cash ' + money(shortfall) + '. One expense with two funding lines.' });
  if (!correcting) choices.push({ key: 'replenish', label: 'REQUEST PETTY CASH REPLENISHMENT', hint: 'The expense is saved as a draft and is NOT posted until the replenishment is decided and processed.',
    extraHtml: '<div class="bc-repl-box"><div class="bc-form-grid"><div class="field"><label for="ic-amt">Amount to request (₱)</label><input id="ic-amt" type="number" step="0.01" min="0.01" value="' + shortfall + '"></div>' +
      '<div class="field"><label for="ic-src">Money would come from</label><select id="ic-src">' + optionsHtml(REPLENISH_SOURCES, 'Daily Sales / Cash') + '</select></div></div></div>' });
  const picked = await choiceDialog({
    title: 'INSUFFICIENT PETTY CASH', messageHtml: summary + '<p>Petty cash cannot go below zero, and money is never moved without your say. Nothing has been recorded. How do you want to continue?</p>', choices, cancelLabel: 'CANCEL',
    read: (back, key) => {
      if (key !== 'replenish') return null;
      const amt = Number(back.querySelector('#ic-amt').value);
      if (!(amt > 0)) return { error: 'Enter the amount to request.' };
      return { amount: r2(amt), source: back.querySelector('#ic-src').value };
    },
  });
  if (!picked) return null;
  const base = Object.assign({}, payload); delete base.petty_cash_fund_id;
  if (picked.key === 'sales_full') return { payload: Object.assign(base, { paid_from: 'Daily Sales / Cash', original_paid_from: 'Petty Cash', payment_method: 'Cash' }) };
  if (picked.key === 'split') {
    return { payload: Object.assign(base, { paid_from: 'Split Funding', original_paid_from: 'Petty Cash', payment_method: 'Cash',
      funding: [{ source: 'Petty Cash', amount: avail, petty_cash_fund_id: res.fund_id }, { source: 'Daily Sales / Cash', amount: shortfall, method: 'Cash' }] }) };
  }
  // replenishment: a draft (not posted) + a request that points at it
  const draft = await bcExpenseSave(Object.assign({}, payload, { save_as_draft: true }));
  if (!draft || !draft.ok) throw new Error(errorsText(draft));
  const rq = await bcPettyReplenishRequest(res.fund_id, picked.extra.amount, picked.extra.source, 'For expense #' + draft.id + ': ' + payload.description, draft.id);
  if (!rq || !rq.ok) { await bcExpenseCancelDraft(draft.id).catch(() => {}); throw new Error(errorsText(rq)); }
  app.invalidateFunds();
  return { done: true, res: Object.assign({}, draft, { replenishment_id: rq.id, replenishment: true }) };
}

/** Saves through `saver` and handles every question the database can ask (insufficient petty cash, confirm funding, duplicate). Resolves {res} or null when the person backed out. Throws for real errors. */
async function postExpense(app, payload, saver, correcting) {
  let p = payload;
  for (let i = 0; i < 6; i++) {
    const res = await saver(p);
    if (!res) throw new Error('No answer from the database. Please try again.');
    if (res.ok) return { res, payload: p };
    if (res.code === 'INSUFFICIENT_PETTY_CASH') {
      const out = await insufficientFlow(app, res, p, correcting);
      if (!out) return null;
      if (out.done) return { res: out.res, payload: p };
      p = out.payload; continue;
    }
    if (res.code === 'CONFIRM_FUNDING') {
      if (!(await confirmFunding(res, p))) return null;
      p = Object.assign({}, p, { confirmed: true }); continue;
    }
    if (res.code === 'DUPLICATE') {
      if (!(await duplicateWarning(res.matches))) return null;
      p = Object.assign({}, p, { ack_duplicate: true }); continue;
    }
    throw new Error(errorsText(res));
  }
  throw new Error('That needed too many steps. Please try again.');
}

// ======================================================================================================================================
// the Add Expense form
// ======================================================================================================================================
function transportOf(v) { return (v && typeof v === 'object') ? v : {}; }

function formBodyHtml(app, v, mode) {
  const cats = app.ctx.categories.filter((c) => c.active || String(c.id) === String(v.category_id));
  const branches = app.branches;
  const t = transportOf(v.transport);
  const today = app.ctx.today;
  return '<div class="bc-form-grid">' +
    (mode === 'correct' ? '<div class="field bc-span2"><label for="ef-reason">Why is this being corrected? *</label><textarea id="ef-reason" name="reason" rows="2" placeholder="The old record stays in the history as reversed."></textarea></div>' : '') +
    '<div class="field"><label for="ef-branch">Branch *</label><select id="ef-branch" name="branch_id"' + (mode !== 'new' ? ' disabled' : '') + '>' + optionsHtml(branches.map((b) => [b.id, b.name]), v.branch_id) + '</select></div>' +
    '<div class="field"><label for="ef-date">Date *</label><input type="date" id="ef-date" name="expense_date" max="' + today + '" value="' + esc(v.expense_date || today) + '"></div>' +
    '<div class="field"><label for="ef-cat">Category *</label><select id="ef-cat" name="category_id"><option value="">Choose…</option>' + cats.map((c) => '<option value="' + c.id + '"' + (String(c.id) === String(v.category_id) ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="ef-amount">Amount (₱) *</label><input type="number" id="ef-amount" name="amount" step="0.01" min="0.01" inputmode="decimal" value="' + esc(v.amount === undefined || v.amount === null ? '' : v.amount) + '"></div>' +
    '<div class="field bc-span2" id="ef-bill-block" hidden><label>Existing bill to pay</label><div class="bc-bill-pick"><input type="text" id="ef-bill-q" placeholder="Search bills by name or provider…" autocomplete="off"><div id="ef-bill-results"></div></div>' +
      '<input type="hidden" name="related_bill_id" id="ef-bill-id" value="' + esc(v.related_bill_id || '') + '"><div id="ef-bill-chosen" class="muted"></div></div>' +
    '<div class="bc-span2" id="ef-transport" hidden><div class="bc-form-grid">' +
      '<div class="field"><label for="ef-ttype">Transportation type</label><select id="ef-ttype" name="t_type"><option value="">Choose…</option>' + optionsHtml(TRANSPORT_TYPES, t.type) + '</select></div>' +
      '<div class="field"><label for="ef-tpurpose">Purpose of the trip</label><input type="text" id="ef-tpurpose" name="t_purpose" value="' + esc(t.purpose || '') + '"></div>' +
      '<div class="field"><label for="ef-tfrom">From</label><input type="text" id="ef-tfrom" name="t_from" value="' + esc(t.from || '') + '"></div>' +
      '<div class="field"><label for="ef-tto">To</label><input type="text" id="ef-tto" name="t_to" value="' + esc(t.to || '') + '"></div></div></div>' +
    '<div class="field bc-span2"><label for="ef-desc">What was it for? *</label><input type="text" id="ef-desc" name="description" maxlength="200" value="' + esc(v.description || '') + '"></div>' +
    '<label class="bc-check bc-span2"><input type="checkbox" id="ef-reimb" name="reimb"' + (v.needs_reimbursement ? ' checked' : '') + '> The employee paid with their own money — reimburse them later</label>' +
    '<div class="field"><label for="ef-paid">Paid from *</label><select id="ef-paid" name="paid_from">' + optionsHtml(PAID_FROM, v.paid_from || 'Daily Sales / Cash') + '</select></div>' +
    '<div class="field"><label for="ef-method">Payment method</label><select id="ef-method" name="payment_method">' + optionsHtml(METHODS, v.payment_method || 'Cash') + '</select></div>' +
    '<div class="field bc-span2" id="ef-reimb-note" hidden><span class="muted">The money moves when you reimburse the employee (from daily sales / cash, petty cash, capital…). Until then it is listed as owed.</span></div>' +
    '<div class="field bc-span2" id="ef-fund-block" hidden><label for="ef-fund">Petty cash fund</label><select id="ef-fund" name="petty_cash_fund_id"></select><span class="muted" id="ef-fund-hint"></span></div>' +
    '<div class="bc-span2" id="ef-split-block" hidden><div class="bc-split"><div class="muted">Split Funding — one expense paid from several sources. The lines must add up to the total.</div>' +
      '<div id="ef-split-rows"></div><button type="button" class="btn small secondary" id="ef-split-add">+ Add a funding line</button><div id="ef-split-sum" class="bc-split-sum"></div></div></div>' +
    '<div class="field"><label for="ef-by">Spent by</label><select id="ef-by" name="spent_by">' + optionsHtml(app.ctx.people.map((p) => [p.id, p.name]), v.spent_by || app.ctx.me.id) + '</select></div>' +
    '<div class="field"><label for="ef-ref">Reference / OR no.</label><input type="text" id="ef-ref" name="reference_number" value="' + esc(v.reference_number || '') + '"></div>' +
    '<div class="field bc-span2"><label for="ef-notes">Notes</label><input type="text" id="ef-notes" name="notes" value="' + esc(v.notes || '') + '"></div>' +
    '<div class="field bc-span2"><label for="ef-files">Receipt / proof (JPG, PNG or PDF, up to 10 MB each)</label><input type="file" id="ef-files" name="files" multiple accept="' + RECEIPT_ACCEPT + '"></div>' +
    '<div class="field bc-span2"><label for="ef-noreceipt">No receipt? Say why</label><input type="text" id="ef-noreceipt" name="no_receipt_reason" value="' + esc(v.no_receipt_reason || '') + '" placeholder="Only if there really is no receipt"><span class="muted" id="ef-rcpt-hint"></span></div>' +
    '<div class="bc-span2" id="ef-dup" hidden></div>' +
  '</div>';
}

/** opts: {preset, draftId, correctId, onDone}. mode: new | draft (posting a saved draft) | correct. */
export async function openExpenseForm(app, opts = {}) {
  let mode = 'new';
  let v = Object.assign({ branch_id: app.state.branch !== 'all' ? app.state.branch : (app.branches[0] && app.branches[0].id), expense_date: app.ctx.today, paid_from: 'Daily Sales / Cash', payment_method: 'Cash', spent_by: app.ctx.me.id }, opts.preset || {});
  let existingId = null;
  const sourceId = opts.draftId || opts.correctId;
  if (sourceId) {
    const d = await bcExpenseGet(sourceId);
    const e = d.expense;
    mode = opts.correctId ? 'correct' : 'draft';
    existingId = sourceId;
    v = { branch_id: e.branch_id, expense_date: e.expense_date, category_id: e.category_id, description: e.description, amount: e.amount, paid_from: e.paid_from === 'Split Funding' && mode === 'correct' ? 'Split Funding' : e.paid_from,
      payment_method: e.payment_method, spent_by: e.spent_by, reference_number: e.reference_number, notes: e.notes, transport: e.transport, no_receipt_reason: e.no_receipt_reason, related_bill_id: e.related_bill_id, needs_reimbursement: e.needs_reimbursement };
    v.__bill = d.expense.bill || null;
    if (mode === 'correct' && e.paid_from === 'Split Funding') v.__split = (d.funding || []).filter((f) => f.kind === 'funding').map((f) => ({ source: f.source, amount: f.amount, fund: f.petty_cash_fund_id || '' }));
    if (mode === 'correct' && e.paid_from === 'Petty Cash') v.petty_cash_fund_id = (d.funding.find((f) => f.source === 'Petty Cash') || {}).petty_cash_fund_id;
    if (mode === 'correct' && v.needs_reimbursement) v.needs_reimbursement = false;   // a corrected expense is funded now; record the reimbursement separately if it is still owed
  }
  const title = mode === 'correct' ? 'Correct expense #' + existingId : mode === 'draft' ? 'Post draft #' + existingId : 'Add Expense';
  const result = await formDialog({
    title, wide: true, confirmLabel: mode === 'correct' ? 'Reverse the old one & record this' : 'Record expense',
    extraButtonsHtml: mode === 'correct' ? '' : '<button type="submit" class="btn secondary" data-extra="draft">Save as draft</button>',
    bodyHtml: formBodyHtml(app, v, mode),
    onReady: (form, ctl) => wireForm(app, form, v, mode),
    onSubmit: async (form, ctl) => {
      const draft = ctl.extra === 'draft';
      const built = readForm(app, form, v, mode, existingId, draft);
      if (built.error) return { error: built.error };
      const saver = mode === 'correct' ? (p) => bcExpenseCorrect(existingId, p, built.reason) : bcExpenseSave;
      const out = await postExpense(app, built.payload, saver, mode === 'correct');
      if (!out) return;     // backed out of a question: the form stays as it was
      const failures = [];
      if (built.files.length && out.res.id) {
        ctl.setBusy(true);
        for (const f of built.files) {
          try { const r = await uploadReceipt(built.payload.branch_id, 'expense', out.res.id, f); if (!r || !r.ok) failures.push(f.name + ': ' + errorsText(r)); }
          catch (err) { failures.push(f.name + ': ' + (err.message || err)); }
        }
      }
      return { close: { res: out.res, failures } };
    },
  });
  if (!result) return null;
  app.invalidateFunds();
  const r = result.res;
  let text;
  if (r.replenishment) text = 'Saved as a DRAFT — not posted. Replenishment request #' + r.replenishment_id + ' was sent. Post the draft after the petty cash is replenished.';
  else if (r.status === 'Draft') text = 'Saved as a draft. It is not counted until you post it.';
  else if (r.status === 'Pending Approval') text = 'Expense recorded — waiting for ' + (LEVEL_NAMES[r.required_level] || 'approval') + ' approval.';
  else text = 'Expense recorded.' + (r.bill_payment_id ? ' The bill was updated through its own payment record.' : '');
  if (result.failures.length) text += ' Receipt upload problem: ' + result.failures.join('; ') + ' — open the expense to upload again.';
  toast('bc-msg', text, result.failures.length > 0);
  if (opts.onDone) opts.onDone(result);
  app.refreshAll();
  return result;
}

function readForm(app, form, v, mode, existingId, draft) {
  const q = (n) => form.elements[n];
  const files = Array.from(q('files').files || []);
  for (const f of files) { const bad = checkReceiptFile(f); if (bad) return { error: bad }; }
  const reason = mode === 'correct' ? q('reason').value.trim() : null;
  if (mode === 'correct' && !reason) return { error: 'Please write why this expense is being corrected.' };
  const branchId = Number(mode === 'new' ? q('branch_id').value : v.branch_id);
  const cat = app.ctx.categories.find((c) => String(c.id) === q('category_id').value);
  if (!cat) return { error: 'Choose a category.' };
  const desc = q('description').value.trim();
  if (!desc) return { error: 'Say what the money was used for.' };
  const amount = Number(q('amount').value);
  if (!(amount > 0) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { error: 'Enter the amount (more than 0, up to two decimal places).' };
  const reimb = q('reimb').checked;
  const paid = reimb ? 'Other' : q('paid_from').value;
  const p = {
    branch_id: branchId, expense_date: q('expense_date').value, category_id: cat.id, description: desc, amount, paid_from: paid, payment_method: q('payment_method').value,
    spent_by: q('spent_by').value || null, reference_number: q('reference_number').value.trim(), notes: q('notes').value.trim(), needs_reimbursement: reimb,
    no_receipt_reason: files.length ? '' : q('no_receipt_reason').value.trim(),
  };
  if (mode === 'draft') p.id = existingId;
  if (draft) p.save_as_draft = true;
  if (cat.kind === 'transportation') p.transport = { type: q('t_type').value, from: q('t_from').value.trim(), to: q('t_to').value.trim(), purpose: q('t_purpose').value.trim() };
  if (cat.kind === 'bill' || q('related_bill_id').value) { if (q('related_bill_id').value) p.related_bill_id = Number(q('related_bill_id').value); }
  if (!reimb && paid === 'Petty Cash') { const fv = q('petty_cash_fund_id').value; if (fv) p.petty_cash_fund_id = Number(fv); }
  if (!reimb && paid === 'Split Funding') {
    const lines = form.__split || [];
    if (!lines.length) return { error: 'Add the funding lines for the split.' };
    let sum = 0;
    p.funding = lines.map((l) => { sum += Number(l.amount || 0); return { source: l.source, amount: Number(l.amount), method: l.source === 'Petty Cash' ? 'Cash' : p.payment_method, petty_cash_fund_id: l.source === 'Petty Cash' && l.fund ? Number(l.fund) : undefined }; });
    if (!draft && Math.abs(sum - amount) > 0.004) return { error: 'The funding lines add up to ' + money(sum) + ' but the expense is ' + money(amount) + '. They must match.' };
    p.original_paid_from = 'Split Funding';
  }
  return { payload: p, files, reason };
}

function wireForm(app, form, v, mode) {
  const $ = (id) => form.querySelector('#' + id);
  let funds = [];
  let catKind = '';
  form.__split = (v.__split && v.__split.length) ? v.__split.map((x) => ({ source: x.source, amount: x.amount, fund: x.fund })) : [{ source: 'Petty Cash', amount: '', fund: '' }, { source: 'Daily Sales / Cash', amount: '', fund: '' }];

  const branchId = () => Number(mode === 'new' ? $('ef-branch').value : v.branch_id);
  const fundLabel = (f) => f.name + ' — ' + money(f.current_balance) + ' available';

  async function loadFunds() {
    funds = await app.funds(branchId());
    const sel = $('ef-fund');
    sel.innerHTML = funds.map((f) => '<option value="' + f.id + '"' + (String(f.id) === String(v.petty_cash_fund_id || '') ? ' selected' : '') + '>' + esc(fundLabel(f)) + '</option>').join('');
    update();
  }
  function renderSplit() {
    const rows = form.__split;
    $('ef-split-rows').innerHTML = rows.map((l, i) =>
      '<div class="bc-split-row" data-i="' + i + '"><select data-f="source" aria-label="Funding source">' + optionsHtml(FUNDING_SOURCES, l.source) + '</select>' +
      '<input type="number" step="0.01" min="0.01" inputmode="decimal" data-f="amount" aria-label="Amount" placeholder="₱" value="' + esc(l.amount) + '">' +
      (l.source === 'Petty Cash' && funds.length > 1 ? '<select data-f="fund" aria-label="Petty cash fund">' + funds.map((f) => '<option value="' + f.id + '"' + (String(f.id) === String(l.fund) ? ' selected' : '') + '>' + esc(fundLabel(f)) + '</option>').join('') + '</select>' : '') +
      (rows.length > 1 ? '<button type="button" class="bc-x" data-del="' + i + '" aria-label="Remove line">✕</button>' : '') + '</div>').join('');
    sumSplit();
  }
  function sumSplit() {
    const total = Number($('ef-amount').value || 0);
    const sum = form.__split.reduce((s, l) => s + Number(l.amount || 0), 0);
    const left = r2(total - sum);
    const el = $('ef-split-sum');
    el.innerHTML = 'Funded ' + money(sum) + ' of ' + money(total) + (Math.abs(left) < 0.005 ? ' — <b style="color:var(--ok)">adds up</b>' : ' — <b style="color:var(--warn)">' + (left > 0 ? money(left) + ' still to assign' : money(-left) + ' too much') + '</b>');
  }
  function update() {
    const cat = app.ctx.categories.find((c) => String(c.id) === $('ef-cat').value);
    catKind = cat ? cat.kind : '';
    $('ef-transport').hidden = catKind !== 'transportation';
    $('ef-bill-block').hidden = catKind !== 'bill' && !$('ef-bill-id').value;
    const reimb = $('ef-reimb').checked;
    const paid = $('ef-paid').value;
    $('ef-paid').disabled = reimb;
    $('ef-reimb-note').hidden = !reimb;
    $('ef-fund-block').hidden = reimb || paid !== 'Petty Cash';
    $('ef-split-block').hidden = reimb || paid !== 'Split Funding';
    $('ef-fund').closest('.field').style.display = (reimb || paid !== 'Petty Cash') ? 'none' : '';
    const f = funds.find((x) => String(x.id) === $('ef-fund').value) || funds[0];
    const amt = Number($('ef-amount').value || 0);
    if (paid === 'Petty Cash' && !reimb) {
      $('ef-fund-hint').innerHTML = !app.can.view_petty ? '' : !funds.length ? '<b style="color:var(--warn)">This branch has no active petty cash fund.</b>' :
        'Petty cash available: <b>' + money(f.current_balance) + '</b>' + (amt > Number(f.current_balance) ? ' — <b style="color:var(--warn)">' + money(r2(amt - f.current_balance)) + ' short. You will be asked how to continue.</b>' : '');
      $('ef-fund').style.display = funds.length > 1 ? '' : 'none';
      $('ef-fund').previousElementSibling.style.display = funds.length > 1 ? '' : 'none';
    }
    if (paid === 'Split Funding' && !reimb) renderSplit();
    $('ef-rcpt-hint').textContent = cat && cat.receipt_required ? ' This category needs a receipt (upload it above, or say why there is none).' : '';
    // paying with petty cash is always cash
    if (paid === 'Petty Cash' && !reimb) $('ef-method').value = 'Cash';
  }

  // bill picker
  let billTimer = null;
  async function searchBills() {
    const box = $('ef-bill-results');
    try {
      const r = await bcBillsLookup(branchId(), $('ef-bill-q').value.trim());
      const bills = r.bills || [];
      box.innerHTML = bills.length ? bills.map((b) => '<button type="button" class="bc-bill-opt" data-bill="' + b.id + '"><b>' + esc(b.name) + '</b> · ' + esc(b.category || '') + ' · due ' + esc(fmtDate(b.due_date)) + '<span>' + money(b.remaining) + ' left</span></button>').join('') : '<div class="muted">No unpaid bills found.</div>';
      box.__bills = bills;
    } catch (err) { box.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; }
  }
  function chooseBill(b) {
    $('ef-bill-id').value = b ? b.id : '';
    $('ef-bill-chosen').innerHTML = b ? 'Paying <b>' + esc(b.name) + '</b> — ' + money(b.remaining) + ' left of ' + money(b.amount) + ' <button type="button" class="act-link" id="ef-bill-clear">Clear</button>' : '';
    $('ef-bill-results').innerHTML = '';
    if (b && !$('ef-amount').value) { $('ef-amount').value = b.remaining; if (!$('ef-desc').value) $('ef-desc').value = 'Payment: ' + b.name; }
    update();
  }
  $('ef-bill-q').addEventListener('input', () => { clearTimeout(billTimer); billTimer = setTimeout(searchBills, 300); });
  $('ef-bill-q').addEventListener('focus', () => { if (!$('ef-bill-results').innerHTML) searchBills(); });
  form.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-bill]');
    if (opt) { chooseBill(($('ef-bill-results').__bills || []).find((b) => String(b.id) === opt.dataset.bill)); return; }
    if (e.target.id === 'ef-bill-clear') { chooseBill(null); return; }
    const del = e.target.closest('[data-del]');
    if (del) { form.__split.splice(Number(del.dataset.del), 1); renderSplit(); return; }
  });
  if (v.related_bill_id) {
    const b = v.__bill;
    $('ef-bill-id').value = v.related_bill_id;
    $('ef-bill-chosen').innerHTML = b ? 'Paying <b>' + esc(b.name) + '</b>' : 'Linked to bill #' + esc(v.related_bill_id);
  }

  // split rows
  $('ef-split-add').addEventListener('click', () => { form.__split.push({ source: 'Daily Sales / Cash', amount: '', fund: '' }); renderSplit(); });
  $('ef-split-rows').addEventListener('input', (e) => { const row = e.target.closest('[data-i]'); if (!row) return; const l = form.__split[Number(row.dataset.i)]; l[e.target.dataset.f] = e.target.value; sumSplit(); });
  $('ef-split-rows').addEventListener('change', (e) => { const row = e.target.closest('[data-i]'); if (!row) return; const l = form.__split[Number(row.dataset.i)]; l[e.target.dataset.f] = e.target.value; if (e.target.dataset.f === 'source') renderSplit(); });

  // duplicate preview (a warning only)
  let dupTimer = null;
  function previewDuplicates() {
    clearTimeout(dupTimer);
    dupTimer = setTimeout(async () => {
      const box = $('ef-dup');
      const amount = Number($('ef-amount').value);
      if (!(amount > 0) || !$('ef-cat').value) { box.hidden = true; return; }
      try {
        const r = await bcExpenseDuplicates({ branch_id: branchId(), expense_date: $('ef-date').value, category_id: $('ef-cat').value, amount, reference_number: $('ef-ref').value.trim(), description: $('ef-desc').value.trim(), id: v.id || null });
        const m = (r && r.matches) || [];
        box.hidden = !m.length;
        box.innerHTML = m.length ? '<div class="msg error" style="margin:0;"><b>Possible duplicate:</b> ' + m.map((x) => money(x.amount) + ' · ' + esc(fmtDate(x.date)) + ' · ' + esc(x.description) + ' (' + esc(x.status) + ')').join(' | ') + '. You can still record it.</div>' : '';
      } catch (err) { box.hidden = true; }
    }, 500);
  }
  ['ef-amount', 'ef-cat', 'ef-date', 'ef-ref', 'ef-desc'].forEach((id) => $(id).addEventListener('change', previewDuplicates));
  $('ef-amount').addEventListener('input', () => { if (!$('ef-split-block').hidden) sumSplit(); update(); });
  ['ef-cat', 'ef-paid', 'ef-reimb', 'ef-fund'].forEach((id) => $(id).addEventListener('change', update));
  if (mode === 'new') $('ef-branch').addEventListener('change', () => { chooseBill(null); loadFunds(); });
  update();
  loadFunds();
}

// ======================================================================================================================================
// the list
// ======================================================================================================================================
export function startExpenses(app) {
  const root = app.root('expenses');
  const f = { from: addDays(app.ctx.today, -13), to: app.ctx.today, category: '', status: '', paid_from: '', receipt: '', q: '', mine: false };
  root.innerHTML =
    '<div class="card bc-filters">' +
      '<div class="bc-filter-row">' +
        '<div class="field"><label for="bx-from">From</label><input type="date" id="bx-from" value="' + f.from + '"></div>' +
        '<div class="field"><label for="bx-to">To</label><input type="date" id="bx-to" value="' + f.to + '"></div>' +
        '<div class="field"><label for="bx-cat">Category</label><select id="bx-cat">' + optionsHtml(app.ctx.categories.map((c) => [c.id, c.name]), '', 'All') + '</select></div>' +
        '<div class="field"><label for="bx-status">Status</label><select id="bx-status">' + optionsHtml(STATUSES, '', 'All') + '</select></div>' +
        '<div class="field"><label for="bx-paid">Paid from</label><select id="bx-paid">' + optionsHtml(PAID_FROM, '', 'All') + '</select></div>' +
        '<div class="field"><label for="bx-rcpt">Receipt</label><select id="bx-rcpt">' + optionsHtml(RECEIPT_STATUSES, '', 'All') + '</select></div>' +
        '<div class="field bc-grow"><label for="bx-q">Search</label><input type="search" id="bx-q" placeholder="Description, reference, notes…"></div>' +
      '</div>' +
      '<div class="bc-filter-row">' +
        '<label class="bc-check"><input type="checkbox" id="bx-mine"> Only the ones I recorded or spent</label>' +
        '<span class="bc-quick"><button type="button" class="btn small secondary" data-range="0">Today</button><button type="button" class="btn small secondary" data-range="6">7 days</button><button type="button" class="btn small secondary" data-range="29">30 days</button></span>' +
        '<span class="bc-grow"></span>' +
        (app.can.add_expense ? '<button type="button" class="btn" id="bx-add">+ Add Expense</button>' : '') +
      '</div>' +
    '</div>' +
    '<div id="bx-sum" class="muted bc-sumline"></div><div id="bx-list"></div>';
  const $ = (id) => root.querySelector('#' + id);

  function readFilters() {
    f.from = $('bx-from').value; f.to = $('bx-to').value; f.category = $('bx-cat').value; f.status = $('bx-status').value; f.paid_from = $('bx-paid').value; f.receipt = $('bx-rcpt').value; f.q = $('bx-q').value.trim(); f.mine = $('bx-mine').checked;
  }
  let timer = null;
  ['bx-from', 'bx-to', 'bx-cat', 'bx-status', 'bx-paid', 'bx-rcpt', 'bx-mine'].forEach((id) => $(id).addEventListener('change', () => refresh()));
  $('bx-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 350); });
  root.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { $('bx-to').value = app.ctx.today; $('bx-from').value = addDays(app.ctx.today, -Number(b.dataset.range)); refresh(); }));
  if ($('bx-add')) $('bx-add').addEventListener('click', () => openExpenseForm(app));

  let seq = 0;
  async function refresh() {
    readFilters();
    const my = ++seq;
    $('bx-list').innerHTML = '<p class="muted">Loading…</p>';
    try {
      const res = await bcExpensesList({ branch_id: app.state.branch !== 'all' ? app.state.branch : null, from: f.from, to: f.to, category_id: f.category || null, status: f.status || null, paid_from: f.paid_from || null, receipt_status: f.receipt || null, q: f.q || null, mine: f.mine, limit: 500 });
      if (my !== seq) return;
      render(res.rows || []);
    } catch (err) { if (my === seq) $('bx-list').innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; }
  }

  function portions(r) {
    const parts = [];
    if (Number(r.petty_portion) > 0) parts.push('Petty ' + money(r.petty_portion));
    if (Number(r.sales_portion) > 0) parts.push('Sales/Cash ' + money(r.sales_portion));
    if (Number(r.capital_portion) > 0) parts.push('Capital ' + money(r.capital_portion));
    if (Number(r.other_portion) > 0) parts.push('Other ' + money(r.other_portion));
    if (!parts.length) return esc(r.paid_from);
    return parts.length > 1 ? '<span title="Split funding">' + parts.map(esc).join('<br>') + '</span>' : esc(parts[0]);
  }
  function render(rows) {
    const counted = rows.filter((r) => !VOID.includes(r.status));
    const total = counted.reduce((s, r) => s + Number(r.amount), 0);
    $('bx-sum').innerHTML = rows.length ? '<b>' + counted.length + '</b> counted expense' + (counted.length === 1 ? '' : 's') + ' · <b>' + money(total) + '</b> <span class="muted">(drafts, rejected, cancelled and reversed are listed but not counted)</span>' + (rows.length >= 500 ? ' · showing the latest 500' : '') : '';
    if (!rows.length) { $('bx-list').innerHTML = '<div class="empty-state"><div class="empty-state-msg">No expenses for these filters.</div></div>'; return; }
    $('bx-list').innerHTML = '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Date</th><th>Branch</th><th>Category</th><th>What for</th><th>Amount</th><th>Paid from</th><th>By</th><th>Status</th><th>Receipt</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="bc-row' + (VOID.includes(r.status) ? ' bc-void' : '') + '" tabindex="0" data-id="' + r.id + '">' +
        '<td data-label="Date">' + esc(fmtDate(r.expense_date)) + '</td>' +
        '<td data-label="Branch">' + (app.state.branch === 'all' ? branchBadge(esc, r.branch_name, r.branch_id, app.branchList) : esc(r.branch_name)) + '</td>' +
        '<td data-label="Category" class="full-row">' + esc(r.category) + '</td>' +
        '<td data-label="What for" class="full-row">' + esc(r.description) + (r.bill_name ? '<div class="muted">Bill: ' + esc(r.bill_name) + '</div>' : '') +
          (r.duplicate_flag ? ' ' + badge('Possible duplicate', 'red') : '') + (r.needs_reimbursement && !r.reimbursed ? ' ' + badge('Owed to employee', 'yellow') : '') + '</td>' +
        '<td data-label="Amount"><b>' + money(r.amount) + '</b></td>' +
        '<td data-label="Paid from">' + portions(r) + (r.funding_decision && r.funding_decision !== 'As intended' ? '<div class="muted">' + esc(r.funding_decision) + '</div>' : '') + '</td>' +
        '<td data-label="By">' + esc(r.spent_by_name || '—') + '</td>' +
        '<td data-label="Status">' + statusBadge(r.status) + '</td>' +
        '<td data-label="Receipt">' + (receiptBadge(r.receipt_status) || '<span class="muted">—</span>') + (r.attachments ? ' <span class="muted">📎' + r.attachments + '</span>' : '') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>';
    $('bx-list').querySelectorAll('.bc-row').forEach((tr) => {
      const open = () => openExpenseDrawer(app, Number(tr.dataset.id), { onChange: refresh });
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }
  return { refresh, onShow: refresh };
}

// ======================================================================================================================================
// the expense panel
// ======================================================================================================================================
export async function openExpenseDrawer(app, id, { onChange } = {}) {
  const dr = openDrawer({ label: 'Expense' });
  let d = null;
  async function load() {
    try { d = await bcExpenseGet(id); render(); }
    catch (err) { dr.set('<div class="bc-dr-head"><h2>Expense</h2><button type="button" class="btn small secondary" data-bc-close>Close ✕</button></div><div class="msg error">' + esc(err.message || err) + '</div>'); }
  }
  async function act(fn, okText) {
    try {
      const res = await fn();
      if (res && res.ok === false) throw new Error(errorsText(res));
      toast('bc-msg', okText || 'Saved.');
      app.invalidateFunds();
      await load();
      if (onChange) onChange();
      app.refreshOthers();
    } catch (err) { toast('bc-msg', err.message || String(err), true); await load(); }
  }

  function render() {
    const e = d.expense, can = app.can, me = app.ctx.me;
    const voided = ['Cancelled', 'Reversed'].includes(e.status);
    const live = !['Draft', 'Cancelled', 'Reversed', 'Rejected'].includes(e.status);
    const reviewable = ['Pending Approval', 'Needs Receipt', 'Recorded'].includes(e.status);
    const own = e.created_by === me.id || e.spent_by === me.id;
    const canEdit = can.add_expense && !voided && (own || can.approve_expense);
    const needLevel = Number(e.approval_level_required || 0);
    const actions = [];
    if (e.status === 'Draft' && can.add_expense) { actions.push('<button type="button" class="btn" data-a="post">Post expense…</button>'); actions.push('<button type="button" class="btn secondary" data-a="cancel-draft">Cancel draft</button>'); }
    if (reviewable && can.approve_expense) {
      actions.push('<button type="button" class="btn" data-a="approve">Approve</button>');
      actions.push('<button type="button" class="btn secondary" data-a="reject">Reject…</button>');
      actions.push('<button type="button" class="btn secondary" data-a="needs-receipt">Ask for a receipt…</button>');
    }
    if (canEdit && e.status !== 'Draft') actions.push('<button type="button" class="btn secondary" data-a="edit">Edit details…</button>');
    if (live && can.approve_expense) { actions.push('<button type="button" class="btn secondary" data-a="correct">Correct…</button>'); actions.push('<button type="button" class="btn secondary danger" data-a="reverse">Reverse…</button>'); }
    if (e.needs_reimbursement && !e.reimbursed_at && !voided && e.status !== 'Draft' && can.approve_expense) actions.push('<button type="button" class="btn" data-a="reimburse">Reimburse the employee…</button>');
    if (e.duplicate_flag && !e.duplicate_reviewed_at && can.approve_expense && !voided) actions.push('<button type="button" class="btn secondary" data-a="dup-ok">Duplicate checked — it is fine</button>');
    const bill = e.bill;
    const t = e.transport || null;
    dr.set(
      '<div class="bc-dr-head"><div><h2>' + money(e.amount) + ' · ' + esc(e.category) + '</h2><div class="muted">Expense #' + e.id + ' · ' + esc(e.branch_name) + ' · ' + esc(fmtDate(e.expense_date)) + '</div></div>' +
        '<button type="button" class="btn small secondary" data-bc-close aria-label="Close">Close ✕</button></div>' +
      '<div class="bc-badges">' + statusBadge(e.status) + receiptBadge(e.receipt_status) + (e.duplicate_flag && !e.duplicate_reviewed_at ? badge('Possible duplicate', 'red') : '') +
        (e.needs_reimbursement ? badge(e.reimbursed_at ? 'Reimbursed' : 'Owed to employee', e.reimbursed_at ? 'green' : 'yellow') : '') +
        (e.funding_decision && e.funding_decision !== 'As intended' ? badge(e.funding_decision, 'blue') : '') + '</div>' +
      '<p class="bc-desc">' + esc(e.description) + '</p>' +
      (e.rejected_reason ? '<div class="msg error">Rejected: ' + esc(e.rejected_reason) + '</div>' : '') +
      (e.status === 'Needs Receipt' && e.review_note ? '<div class="msg error">Receipt requested: ' + esc(e.review_note) + '</div>' : '') +
      (e.status === 'Reversed' ? '<div class="msg error">Reversed ' + esc(fmtStamp(e.reversed_at)) + ' by ' + esc(e.reversed_by_name || '—') + ': ' + esc(e.reverse_reason || '') + '</div>' : '') +
      (d.corrected_from ? '<div class="muted">This corrects expense #' + d.corrected_from + '.</div>' : '') + (d.corrected_by ? '<div class="muted">Corrected by expense #' + d.corrected_by + '.</div>' : '') +
      (actions.length ? '<div class="bc-dr-actions">' + actions.join('') + '</div>' : '') +

      '<section class="card bc-dr-sec"><h3>Details</h3>' +
        kv('Spent by', esc(e.spent_by_name || '—')) + kv('Recorded by', esc(e.created_by_name || '—') + ' · ' + esc(fmtStamp(e.created_at))) +
        (e.received_by ? kv('Received by / paid to', esc(e.received_by)) : '') + (e.reference_number ? kv('Reference / OR no.', esc(e.reference_number)) : '') +
        kv('Payment method', esc(e.payment_method)) + kv('Paid from', esc(e.paid_from) + (e.original_paid_from && e.original_paid_from !== e.paid_from ? ' <span class="muted">(intended: ' + esc(e.original_paid_from) + ')</span>' : '')) +
        (e.petty_available_at_entry !== null && e.petty_available_at_entry !== undefined && e.funding_decision && e.funding_decision !== 'As intended' ? kv('Petty cash available at the time', money(e.petty_available_at_entry)) : '') +
        (e.funding_confirmed_at ? kv('Funding confirmed', esc(fmtStamp(e.funding_confirmed_at))) : '') +
        kv('Approval needed', esc(LEVEL_NAMES[needLevel] || 'None') + (e.approved_by_name ? ' — approved by ' + esc(e.approved_by_name) + ' · ' + esc(fmtStamp(e.approved_at)) : needLevel && e.status === 'Pending Approval' ? ' — <b>not yet approved</b>' : '')) +
        (e.notes ? kv('Notes', esc(e.notes)) : '') + (e.no_receipt_reason ? kv('Why no receipt', esc(e.no_receipt_reason)) : '') +
      '</section>' +

      '<section class="card bc-dr-sec"><h3>Where the money came from</h3>' +
        ((d.funding || []).length ? '<table class="bc-mini"><thead><tr><th>Source</th><th class="num">Amount</th><th>Effect</th></tr></thead><tbody>' + d.funding.map((l) =>
          '<tr><td>' + esc(l.source) + (l.fund_name ? ' <span class="muted">· ' + esc(l.fund_name) + '</span>' : '') + (l.kind === 'employee_advance' ? ' <span class="muted">(employee advance)</span>' : '') + '</td><td class="num">' + money(l.amount) + '</td><td>' +
          (l.affects_till ? '<span title="Counted as cash out of the till">Reduces expected cash</span>' : l.source === 'Petty Cash' ? 'Petty cash' : '<span class="muted">Not till cash</span>') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">Not funded yet' + (e.status === 'Draft' ? ' — this is a draft.' : '.') + '</p>') +
        '<p class="muted" style="margin-bottom:0;">Gross Sales is never reduced by an expense. Only the part paid from daily sales / cash lowers the expected cash of the day.</p>' +
      '</section>' +

      (bill ? '<section class="card bc-dr-sec"><h3>Bill paid</h3>' + kv('Bill', esc(bill.name)) + kv('Bill amount', money(bill.amount)) + kv('Paid so far', money(bill.paid_amount)) + kv('Bill status', esc(bill.payment_status || bill.status)) +
        '<p class="muted" style="margin-bottom:0;">The payment is recorded on the bill itself (Bills module); no second bill was created.</p></section>' : '') +

      (t ? '<section class="card bc-dr-sec"><h3>Transportation</h3>' + kv('Type', esc(t.type || '—')) + kv('From', esc(t.from || '—')) + kv('To', esc(t.to || '—')) + kv('Purpose', esc(t.purpose || '—')) + '</section>' : '') +

      '<section class="card bc-dr-sec"><h3>Receipts / proof</h3><div id="bd-files">' + ((d.attachments || []).length ? d.attachments.map((a) =>
        '<div class="bc-file"><button type="button" class="act-link" data-open="' + esc(a.file_path) + '">📎 ' + esc(a.file_name) + '</button><span class="muted"> · ' + esc(a.uploaded_by || '—') + ' · ' + esc(fmtStamp(a.created_at)) + '</span> ' +
        (a.verified ? badge('Verified by ' + (a.verified_by || '—'), 'green') : (can.approve_expense ? '<button type="button" class="btn small secondary" data-verify="' + a.id + '">Verify</button>' : badge('Not verified', 'gray'))) + '</div>').join('') : '<p class="muted">No receipt uploaded.</p>') + '</div>' +
        (can.add_expense && !voided ? '<div class="field" style="margin-top:8px;"><label for="bd-up">Add a receipt (JPG, PNG or PDF)</label><input type="file" id="bd-up" multiple accept="' + RECEIPT_ACCEPT + '"></div>' : '') +
      '</section>' +

      ((d.petty || []).length ? '<section class="card bc-dr-sec"><h3>Petty cash ledger entries</h3><table class="bc-mini"><thead><tr><th>Type</th><th class="num">Amount</th><th class="num">Balance after</th></tr></thead><tbody>' +
        d.petty.map((x) => '<tr><td>' + esc(String(x.type).replace('PETTY_CASH_', '').toLowerCase()) + '</td><td class="num">' + money(x.amount) + '</td><td class="num">' + money(x.balance_after) + '</td></tr>').join('') + '</tbody></table></section>' : '') +

      '<section class="card bc-dr-sec"><h3>History</h3><ul class="bc-tl">' + ((d.audit || []).length ? d.audit.map((a) =>
        '<li><b>' + esc(String(a.action).replace(/_/g, ' ')) + '</b> · ' + esc(a.actor || '—') + (a.role ? ' (' + esc(a.role) + ')' : '') + ' · <span class="muted">' + esc(fmtStamp(a.at)) + '</span>' + (a.reason ? '<div class="muted">' + esc(a.reason) + '</div>' : '') + '</li>').join('') : '<li class="muted">No history yet.</li>') + '</ul></section>');

    const body = dr.body;
    body.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => doAction(b.dataset.a)));
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      try { window.open(await receiptUrl(b.dataset.open), '_blank', 'noopener'); } catch (err) { toast('bc-msg', err.message || String(err), true); }
    }));
    body.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', () => act(() => bcAttachVerify(Number(b.dataset.verify)), 'Receipt verified.')));
    const up = body.querySelector('#bd-up');
    if (up) up.addEventListener('change', async () => {
      const files = Array.from(up.files || []);
      if (!files.length) return;
      up.disabled = true;
      const problems = [];
      for (const file of files) {
        try { const r = await uploadReceipt(e.branch_id, 'expense', e.id, file); if (!r || !r.ok) problems.push(file.name + ': ' + errorsText(r)); } catch (err) { problems.push(file.name + ': ' + (err.message || err)); }
      }
      if (problems.length) toast('bc-msg', problems.join('; '), true); else toast('bc-msg', 'Receipt uploaded.');
      await load(); if (onChange) onChange(); app.refreshOthers();
    });
  }

  async function doAction(a) {
    const e = d.expense;
    if (a === 'approve') return act(() => bcExpenseDecide(id, 'approve', null), 'Approved.');
    if (a === 'reject') {
      const r = await reasonDialog({ title: 'Reject this expense?', message: 'The expense stays in the history as rejected. The person who recorded it will see the reason.', label: 'Reason', confirmLabel: 'Reject', danger: true });
      return r && act(() => bcExpenseDecide(id, 'reject', r.reason), 'Rejected.');
    }
    if (a === 'needs-receipt') {
      const r = await reasonDialog({ title: 'Ask for a receipt', message: 'The expense stays as it is and is marked "Needs Receipt" until a receipt is uploaded.', label: 'Note for the person (optional)', required: false, confirmLabel: 'Ask for receipt' });
      return r && act(() => bcExpenseDecide(id, 'needs_receipt', r.reason), 'Receipt requested.');
    }
    if (a === 'reverse') {
      const r = await reasonDialog({ title: 'Reverse expense #' + e.id + '?', message: 'Nothing is deleted. The expense is marked reversed, the cash or petty cash goes back (as a new entry dated today), and a linked bill payment is voided. Use this for an expense that should not have been recorded.', label: 'Reason', confirmLabel: 'Reverse expense', danger: true });
      return r && act(() => bcExpenseReverse(id, r.reason), 'Expense reversed.');
    }
    if (a === 'correct') { dr.close(); await openExpenseForm(app, { correctId: id, onDone: () => { if (onChange) onChange(); } }); return; }
    if (a === 'post') { dr.close(); await openExpenseForm(app, { draftId: id, onDone: () => { if (onChange) onChange(); } }); return; }
    if (a === 'cancel-draft') {
      if (!(await confirmDialog({ title: 'Cancel this draft?', message: 'The draft is cancelled. Nothing was ever posted, so no money moves. Any open replenishment request for it is cancelled too.', confirmLabel: 'Cancel draft', cancelLabel: 'Keep it', danger: true }))) return;
      return act(() => bcExpenseCancelDraft(id), 'Draft cancelled.');
    }
    if (a === 'dup-ok') return act(() => bcExpenseReviewDuplicate(id), 'Marked as checked.');
    if (a === 'edit') return editDetails(e);
    if (a === 'reimburse') return reimburse(e);
  }

  async function editDetails(e) {
    const cats = app.ctx.categories.filter((c) => c.active || c.id === e.category_id);
    const t = e.transport || {};
    const out = await formDialog({
      title: 'Edit expense #' + e.id, confirmLabel: 'Save changes', wide: true,
      messageHtml: 'Only the descriptive details can be edited. The amount, the date and where the money came from are changed with <b>Correct…</b> so the history stays complete.',
      bodyHtml: '<div class="bc-form-grid">' +
        '<div class="field bc-span2"><label for="ed-desc">What was it for?</label><input type="text" id="ed-desc" name="description" maxlength="200" value="' + esc(e.description) + '"></div>' +
        '<div class="field"><label for="ed-cat">Category</label><select id="ed-cat" name="category_id">' + cats.map((c) => '<option value="' + c.id + '"' + (c.id === e.category_id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="ed-by">Spent by</label><select id="ed-by" name="spent_by">' + optionsHtml(app.ctx.people.map((p) => [p.id, p.name]), e.spent_by) + '</select></div>' +
        '<div class="field"><label for="ed-ref">Reference / OR no.</label><input type="text" id="ed-ref" name="reference_number" value="' + esc(e.reference_number || '') + '"></div>' +
        '<div class="field"><label for="ed-recv">Received by / paid to</label><input type="text" id="ed-recv" name="received_by" value="' + esc(e.received_by || '') + '"></div>' +
        '<div class="field bc-span2"><label for="ed-notes">Notes</label><input type="text" id="ed-notes" name="notes" value="' + esc(e.notes || '') + '"></div>' +
        '<div class="field bc-span2"><label for="ed-norc">Why there is no receipt</label><input type="text" id="ed-norc" name="no_receipt_reason" value="' + esc(e.no_receipt_reason || '') + '"></div>' +
        (e.category_kind === 'transportation' ? '<div class="field"><label for="ed-tt">Transport type</label><select id="ed-tt" name="t_type"><option value="">—</option>' + optionsHtml(TRANSPORT_TYPES, t.type) + '</select></div><div class="field"><label for="ed-tp">Purpose</label><input type="text" id="ed-tp" name="t_purpose" value="' + esc(t.purpose || '') + '"></div>' +
          '<div class="field"><label for="ed-tf">From</label><input type="text" id="ed-tf" name="t_from" value="' + esc(t.from || '') + '"></div><div class="field"><label for="ed-tto">To</label><input type="text" id="ed-tto" name="t_to" value="' + esc(t.to || '') + '"></div>' : '') +
      '</div>',
      onSubmit: async (form) => {
        const q = (n) => form.elements[n];
        const changes = { description: q('description').value.trim(), category_id: Number(q('category_id').value), spent_by: q('spent_by').value, reference_number: q('reference_number').value.trim(), received_by: q('received_by').value.trim(), notes: q('notes').value.trim(), no_receipt_reason: q('no_receipt_reason').value.trim() };
        if (!changes.description) return { error: 'Say what the money was used for.' };
        if (q('t_type')) changes.transport = { type: q('t_type').value, purpose: q('t_purpose').value.trim(), from: q('t_from').value.trim(), to: q('t_to').value.trim() };
        const res = await bcExpenseEdit(e.id, changes);
        if (!res || !res.ok) return { error: errorsText(res) };
        return { close: true };
      },
    });
    if (out) { toast('bc-msg', 'Details saved.'); await load(); if (onChange) onChange(); }
  }

  async function reimburse(e) {
    const funds = await app.funds(e.branch_id);
    const out = await formDialog({
      title: 'Reimburse the employee', confirmLabel: 'Record reimbursement',
      messageHtml: esc(e.spent_by_name || 'The employee') + ' paid <b>' + money(e.amount) + '</b> out of pocket. Choose where the money to pay them back comes from. This is when the cash really leaves.',
      bodyHtml: '<div class="field"><label for="rb-src">Paid back from</label><select id="rb-src">' + optionsHtml(FUNDING_SOURCES, 'Daily Sales / Cash') + '</select></div>' +
        '<div class="field" id="rb-fund-f"><label for="rb-fund">Petty cash fund</label><select id="rb-fund">' + funds.map((f) => '<option value="' + f.id + '">' + esc(f.name + ' — ' + money(f.current_balance)) + '</option>').join('') + '</select></div>',
      onReady: (form) => { const sync = () => { form.querySelector('#rb-fund-f').style.display = form.querySelector('#rb-src').value === 'Petty Cash' ? '' : 'none'; }; form.querySelector('#rb-src').addEventListener('change', sync); sync(); },
      onSubmit: async (form) => {
        const src = form.querySelector('#rb-src').value;
        const line = { source: src, amount: Number(e.amount) };
        if (src === 'Petty Cash') { const fv = form.querySelector('#rb-fund').value; if (!fv) return { error: 'This branch has no petty cash fund to pay from.' }; line.petty_cash_fund_id = Number(fv); }
        const res = await bcExpenseReimburse(e.id, { funding: [line] });
        if (!res || !res.ok) {
          if (res && res.code === 'INSUFFICIENT_PETTY_CASH') return { error: 'INSUFFICIENT PETTY CASH — the fund has ' + money(res.available) + '. Choose another source.' };
          return { error: errorsText(res) };
        }
        return { close: true };
      },
    });
    if (out) { toast('bc-msg', 'Reimbursement recorded.'); app.invalidateFunds(); await load(); if (onChange) onChange(); app.refreshOthers(); }
  }

  await load();
}
