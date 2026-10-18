// Branch Capital (Ren, 2026-10-14) -- the wrappers for the daily cash / expenses / petty cash database functions (migrations 226-230) and the receipt upload. POS-only page.
// Every rule (permissions, branches, approval tiers, closed days, never-negative petty cash) is checked again in the database; the page only hides what a person cannot use.
import { supabase } from './supabaseClient.js?v=20261018c';

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// ---- the page's first question: who am I, what may I do, which branches, the rules, the categories, the people
export const bcContext = () => rpc('bc_context');

// ---- the day
export const bcOverview = (branch, date) => rpc('bc_overview', { p_branch: branch, p_date: date || null });
export const bcTimeline = (branch, date) => rpc('bc_timeline', { p_branch: branch, p_date: date || null });
export const bcAttention = (branch) => rpc('bc_attention', { p_branch: branch || null });
export const bcBranchesSummary = (date) => rpc('bc_branches_summary', { p_date: date || null });

// ---- expenses
/** payload: {id?, branch_id, expense_date, category_id, description, amount, paid_from, payment_method, spent_by, petty_cash_fund_id?, funding?, original_paid_from?, confirmed?, ack_duplicate?, related_bill_id?, reference_number?, notes?, transport?, no_receipt_reason?, needs_reimbursement?, save_as_draft?}
 * -> {ok, id, status, ...} or {ok:false, code: VALIDATION | DAY_CLOSED | FUNDING_MISMATCH | INSUFFICIENT_PETTY_CASH | CONFIRM_FUNDING | DUPLICATE, errors, ...} */
export const bcExpenseSave = (p) => rpc('bc_expense_save', { p });
export const bcExpenseDuplicates = (p) => rpc('bc_expense_duplicates', { p });
export const bcBillsLookup = (branch, q) => rpc('bc_bills_lookup', { p_branch: branch, p_q: q || null });
export const bcExpensesList = (filter) => rpc('bc_expenses_list', { p_filter: filter || {} });
export const bcExpenseGet = (id) => rpc('bc_expense_get', { p_id: id });
export const bcExpenseDecide = (id, decision, note) => rpc('bc_expense_decide', { p_id: id, p_decision: decision, p_note: note || null });
export const bcExpenseReviewDuplicate = (id) => rpc('bc_expense_review_duplicate', { p_id: id });
export const bcExpenseCancelDraft = (id) => rpc('bc_expense_cancel_draft', { p_id: id });
export const bcExpenseReverse = (id, reason) => rpc('bc_expense_reverse', { p_id: id, p_reason: reason });
export const bcExpenseCorrect = (id, p, reason) => rpc('bc_expense_correct', { p_id: id, p, p_reason: reason });
export const bcExpenseEdit = (id, changes) => rpc('bc_expense_edit', { p_id: id, p_changes: changes });
/** p: {funding:[{source, amount, petty_cash_fund_id?}], date?} */
export const bcExpenseReimburse = (id, p) => rpc('bc_expense_reimburse', { p_id: id, p });

// ---- cash book, movements, the daily count
export const bcBookSet = (branch, start, opening, note) => rpc('bc_book_set', { p_branch: branch, p_start: start, p_opening: opening, p_note: note || null });
/** p: {branch_id, kind: DEPOSIT | REMITTANCE | OTHER_CASH_IN | OTHER_CASH_OUT, amount, movement_date?, counterpart?, reference_number?, description?, notes?} */
export const bcMovementSave = (p) => rpc('bc_movement_save', { p });
export const bcMovementVoid = (id, reason) => rpc('bc_movement_void', { p_id: id, p_reason: reason });
export const bcMovementsList = (branch, from, to) => rpc('bc_movements_list', { p_branch: branch || null, p_from: from || null, p_to: to || null });
export const bcReconClose = (branch, date, actual, reason, notes) => rpc('bc_recon_close', { p_branch: branch, p_date: date, p_actual: actual, p_reason: reason || null, p_notes: notes || null });
export const bcReconCheck = (id) => rpc('bc_recon_check', { p_id: id });
export const bcReconApprove = (id) => rpc('bc_recon_approve', { p_id: id });
export const bcReconReopen = (id, reason) => rpc('bc_recon_reopen', { p_id: id, p_reason: reason });
export const bcReconsList = (branch, from, to) => rpc('bc_recons_list', { p_branch: branch || null, p_from: from || null, p_to: to || null });

// ---- petty cash
export const bcPettyOverview = (branch) => rpc('bc_petty_overview', { p_branch: branch || null });
export const bcPettyLedger = (fund, from, to) => rpc('bc_petty_ledger', { p_fund: fund, p_from: from || null, p_to: to || null });
export const bcPettyFundSave = (p) => rpc('bc_petty_fund_save', { p });
export const bcPettyOpen = (fund, amount, source, reference, notes) => rpc('bc_petty_open', { p_fund: fund, p_amount: amount, p_source: source, p_reference: reference || null, p_notes: notes || null });
export const bcPettyReplenishRequest = (fund, amount, source, notes, expenseId) => rpc('bc_petty_replenish_request', { p_fund: fund, p_amount: amount, p_source: source, p_notes: notes || null, p_expense_id: expenseId || null });
export const bcPettyReplenishDecide = (id, decision, note) => rpc('bc_petty_replenish_decide', { p_id: id, p_decision: decision, p_note: note || null });
export const bcPettyReplenishProcess = (id, reference, notes) => rpc('bc_petty_replenish_process', { p_id: id, p_reference: reference || null, p_notes: notes || null });
export const bcPettyReplenishCancel = (id) => rpc('bc_petty_replenish_cancel', { p_id: id });
export const bcPettyReturn = (fund, amount, notes) => rpc('bc_petty_return', { p_fund: fund, p_amount: amount, p_notes: notes || null });
export const bcPettyAdjust = (fund, amount, reason) => rpc('bc_petty_adjust', { p_fund: fund, p_amount: amount, p_reason: reason });
export const bcPettyAdvanceRelease = (fund, employee, amount, purpose) => rpc('bc_petty_advance_release', { p_fund: fund, p_employee: employee, p_amount: amount, p_purpose: purpose });
/** p: {actual_amount, category_id, description?, expense_date?, reference_number?, notes?, transport?, no_receipt_reason?, ack_duplicate?} */
export const bcPettyAdvanceLiquidate = (advance, p) => rpc('bc_petty_advance_liquidate', { p_advance: advance, p });
export const bcPettyAdvanceCancel = (advance, reason) => rpc('bc_petty_advance_cancel', { p_advance: advance, p_reason: reason });

// ---- reports, audit log, settings
export const bcReportExpenses = (from, to, branch) => rpc('bc_report_expenses', { p_from: from, p_to: to, p_branch: branch || null });
export const bcReportTransport = (from, to, branch) => rpc('bc_report_transport', { p_from: from, p_to: to, p_branch: branch || null });
export const bcReportPetty = (from, to, branch) => rpc('bc_report_petty', { p_from: from, p_to: to, p_branch: branch || null });
export const bcAuditList = (filter) => rpc('bc_audit_list', { p_filter: filter || {} });
export const bcSettingsSave = (p) => rpc('bc_settings_save', { p });
export const bcCategorySave = (p) => rpc('bc_category_save', { p });

// ---- receipts (JPG / PNG / PDF, up to 10 MB): the file goes to a private bucket under <branch id>/<kind>/<record id>/, then is registered on the record
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_ACCEPT = 'image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf';
const BUCKET = 'branch-cash-receipts';

export function checkReceiptFile(file) {
  if (!RECEIPT_TYPES.includes(file.type)) return 'Only JPG, PNG or PDF files can be attached (' + file.name + ').';
  if (file.size > RECEIPT_MAX_BYTES) return file.name + ' is larger than 10 MB.';
  return null;
}

/** ownerType: expense | replenishment | movement | reconciliation. Resolves the bc_attach_add result ({ok, id} or {ok:false, errors}). */
export async function uploadReceipt(branchId, ownerType, ownerId, file) {
  const bad = checkReceiptFile(file);
  if (bad) throw new Error(bad);
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'receipt';
  const path = branchId + '/' + ownerType + '/' + ownerId + '/' + Date.now() + '-' + safe;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  return rpc('bc_attach_add', { p_owner_type: ownerType, p_owner_id: ownerId, p_file_name: file.name, p_file_path: path, p_file_type: file.type, p_file_size: file.size });
}
export const bcAttachVerify = (id) => rpc('bc_attach_verify', { p_id: id });
export const bcAttachmentsList = (ownerType, ownerId) => rpc('bc_attachments_list', { p_owner_type: ownerType, p_owner_id: ownerId });
/** A link that works for five minutes. */
export async function receiptUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
