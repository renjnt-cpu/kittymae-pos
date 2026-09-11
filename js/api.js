// Thin wrappers around Supabase tables/RPCs — every page calls these instead of touching
// `supabase` directly, so the query shape lives in one place. Mirrors the old app's
// `api(name, ...args)` helper in spirit, just split into named functions since
// supabase-js's table/RPC calls aren't as uniformly shaped as google.script.run's.
import { supabase } from './supabaseClient.js';

/** Resolves the signed-in employee's id for "created_by"/"paid_by"/etc attribution.
 * Goes through the current_employee() RPC (which joins employee_auth_links) rather
 * than matching employees.auth_user_id directly -- that column is only ever set for
 * Google logins, so a direct match silently returns nothing for anyone who signed in
 * with ID+password (see 33_multi_auth_identity.sql). */
async function currentEmployeeId() {
  const { data: emp } = await supabase.rpc('current_employee');
  return emp ? emp.id : null;
}

/** Attaches {full_name} objects for "who did this" columns (creator/approver/payer/
 * custodian, etc.) via get_employee_names() -- a SECURITY DEFINER RPC that only ever
 * returns id+full_name, regardless of the caller's role. Direct embeds like
 * `employees!bills_created_by_fkey(full_name)` only resolve for Admin/Manager/self,
 * since that's all the employees table's own RLS allows (on purpose -- it also guards
 * email/contact_number/bills_access/etc.) -- this is how everyone else still gets to
 * see a plain name on a record they can already see. fieldMap maps the alias each row
 * should get (e.g. "creator") to the id column that names it (e.g. "created_by"). */
async function attachEmployeeNames(rows, fieldMap) {
  const idCols = Object.values(fieldMap);
  const ids = new Set();
  rows.forEach((r) => idCols.forEach((col) => { if (r[col]) ids.add(r[col]); }));
  if (!ids.size) return rows;
  const { data, error } = await supabase.rpc('get_employee_names', { ids: Array.from(ids) });
  if (error) throw new Error(error.message);
  const byId = {};
  (data || []).forEach((e) => { byId[e.id] = e.full_name; });
  rows.forEach((r) => {
    Object.entries(fieldMap).forEach(([alias, col]) => {
      r[alias] = r[col] && byId[r[col]] ? { full_name: byId[r[col]] } : null;
    });
  });
  return rows;
}

/** Live cross-user updates — the business is fast-paced (multiple people approving/
 * editing the same records), so every page subscribes to Postgres changes on the
 * table(s) it displays and just reloads when anything changes, instead of everyone
 * having to manually refresh to see someone else's approval/edit. RLS still applies to
 * realtime the same as any other read, so this never leaks rows a viewer couldn't
 * otherwise see. Call the returned function to unsubscribe (not currently needed since
 * these pages never tear down, but kept for correctness). */
export function subscribeToChanges(tables, onChange) {
  const list = Array.isArray(tables) ? tables : [tables];
  const channel = supabase.channel('live-' + list.join('-') + '-' + Math.random().toString(36).slice(2));
  list.forEach((table) => {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
  });
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

export async function getBranches() {
  const { data, error } = await supabase.from('branches').select('*').eq('is_active', true).order('display_order');
  if (error) throw new Error(error.message);
  return data;
}

/** branchId omitted/null = every branch the caller's role can see (RLS still applies —
 * a Branch Supervisor/Staff session only ever gets their own branch's rows back). */
export async function getInventory(branchId) {
  let query = supabase
    .from('inventory')
    .select('sku, branch_id, qty_available, qty_reserved, total_grams_on_hand, last_updated_at, ' +
      'products(item_name, product_line, reorder_level, product_status, supplier_price, system_selling_price, gross_weight_g, supplier_gold_rate_per_g, current_gold_rate_per_g)')
    .order('sku');
  if (branchId) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

// Also used by pos.html's SKU lookup (not just movement.html's autocomplete),
// hence the fuller column list below -- extra fields a caller doesn't need are
// harmless to select. sanitizeForOrFilter() guards the same PostgREST .or()
// injection risk documented in listOrderItemStatuses() further down this file.
export async function searchProducts(query) {
  const term = sanitizeForOrFilter(query || '');
  const pat = '%' + term + '%';
  const { data, error } = await supabase
    .from('products')
    .select('sku, sub_sku, item_name, category, product_line, system_selling_price, gross_weight_g, product_status')
    .or('sku.ilike.' + pat + ',item_name.ilike.' + pat)
    .limit(50);
  if (error) throw new Error(error.message);
  return data;
}

// Same lesson as ORDER_ITEM_STATUS_ROW_CAP below: with 7,392 SKUs (nearly all
// Active by default), select('*') with no limit was silently truncated at
// Supabase's default 1000-row cap -- products.html would only ever show
// alphabetically-first ~1000 SKUs, with no error or notice that ~6,000+ were
// missing. Capped explicitly here instead, with a UI notice when it's hit.
export const PRODUCTS_ROW_CAP = 1000;

/** Full SKU Catalog listing for products.html — everyone with a session can read
 * every row (products_read_all), so no branch/role filtering here. search/status
 * scope the query server-side instead of fetching everything and filtering
 * client-side, same reasoning as listOrderItemStatuses(). */
export async function listProducts({ search = '', status = 'Active' } = {}) {
  let query = supabase.from('products').select('*');
  if (status !== 'all') query = query.eq('product_status', status);
  const term = sanitizeForOrFilter(search || '');
  if (term) {
    const pat = '%' + term + '%';
    query = query.or('sku.ilike.' + pat + ',sub_sku.ilike.' + pat + ',item_name.ilike.' + pat);
  }
  const { data, error } = await query.order('sku').limit(PRODUCTS_ROW_CAP);
  if (error) throw new Error(error.message);
  return data;
}

/** New SKUs are added in the Google Sheet, not here — this only patches a detail on an
 * existing row. Keys are all optional camelCase — only the ones present are patched.
 * productStatus ('Active'/'Discontinued') also goes through this. */
export async function updateProduct(sku, fields) {
  const patch = { updated_at: new Date().toISOString() };
  const map = {
    itemName: 'item_name', subSku: 'sub_sku', price: 'system_selling_price',
    productLine: 'product_line', metalPurity: 'metal_purity',
    grossWeightG: 'gross_weight_g', valueTier: 'value_tier', reorderLevel: 'reorder_level',
    category: 'category', sizeLength: 'size_length', stoneGemDetails: 'stone_gem_details',
    notes: 'notes', productStatus: 'product_status',
  };
  Object.entries(map).forEach(([key, col]) => {
    if (!(key in fields)) return;
    let v = fields[key];
    if ((col === 'gross_weight_g' || col === 'system_selling_price') && (v === '' || v === null || v === undefined)) v = null;
    else if (col === 'gross_weight_g' || col === 'system_selling_price') v = Number(v);
    if (col === 'reorder_level') v = v ? Number(v) : 0;
    patch[col] = v === '' ? null : v;
  });
  const { error } = await supabase.from('products').update(patch).eq('sku', sku);
  if (error) throw new Error(error.message);
}

/**
 * The one Record-a-Movement entry point for Phase 1's frontend — covers Stock In /
 * Stock Out / Damage / Missing / Adjustment / Correction. Sale and the two Transfer
 * types are deliberately not reachable through this function (see 06_functions.sql's
 * own guard against posting them directly). Sale now goes through recordSale() below
 * instead (66_sales_recording.sql) — it needs customer/price fields this function
 * doesn't have, and its own branch-scope rule (whole staff/own branch + Sales
 * Executive/position-managers unscoped) rather than record_inventory_transaction's
 * plain Branch-Supervisor/Staff-only gate.
 */
export async function recordMovement({ sku, branchId, transactionType, qtyChange, referenceNumber, reason, notes }) {
  const { data, error } = await supabase.rpc('record_inventory_transaction', {
    p_sku: sku,
    p_branch_id: branchId,
    p_transaction_type: transactionType,
    p_qty_change: qtyChange,
    p_reference_number: referenceNumber || null,
    p_reason: reason || null,
    p_notes: notes || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Deducts inventory and logs the sale atomically (record_sale() in
 * 66_sales_recording.sql) — the same function backs both this page's Sale movement
 * type and a completed Layaway (see completeLayaway() further down, which calls the
 * DB's complete_layaway() instead since that path must NOT deduct inventory a second
 * time -- the layaway hold already removed it from qty_available). */
export async function recordSale({ sku, branchId, qty, orderNumber, unitPrice, customerName, contactNumber }) {
  const { data, error } = await supabase.rpc('record_sale', {
    p_sku: sku,
    p_branch_id: branchId,
    p_qty: qty,
    p_order_number: orderNumber || null,
    p_unit_price: unitPrice || null,
    p_customer_name: customerName || null,
    p_contact_number: contactNumber || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Raw sales rows for the Dashboard's per-branch sales analytics — joined with
 * products for item name and branches for the name label, same shape as
 * getInventory(). RLS scopes this to whatever the caller is allowed to see
 * (sales_movements_read_scoped / sales_movements_sales_exec_view). */
export async function listSales({ branchId, fromDate, toDate } = {}) {
  let query = supabase.from('sales_inventory_movements')
    .select('*, products(item_name, product_line), branches(name)')
    .order('sale_date', { ascending: false });
  if (branchId != null) query = query.eq('branch_id', branchId);
  if (fromDate) query = query.gte('sale_date', fromDate);
  if (toDate) query = query.lte('sale_date', toDate + 'T23:59:59');
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

export async function getTransactionHistory(sku, branchId) {
  let query = supabase
    .from('inventory_transactions')
    .select('*')
    .eq('sku', sku)
    .order('occurred_at', { ascending: false })
    .limit(200);
  if (branchId) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

export async function listTransfers() {
  const { data, error } = await supabase
    .from('inventory_transfers')
    .select('*, inventory_transfer_items(*)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data;
}

/** items: [{ sku, qty }] */
export async function createTransferRequest(fromBranchId, toBranchId, items) {
  const { data, error } = await supabase.rpc('create_transfer_request', {
    p_from_branch_id: fromBranchId,
    p_to_branch_id: toBranchId,
    p_items: items.map((i) => ({ sku: i.sku, qty: i.qty })),
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function approveTransfer(transferId) {
  const { error } = await supabase.rpc('approve_transfer', { p_transfer_id: transferId });
  if (error) throw new Error(error.message);
}

export async function startPreparingTransfer(transferId) {
  const { error } = await supabase.rpc('start_preparing_transfer', { p_transfer_id: transferId });
  if (error) throw new Error(error.message);
}

/** items: [{ sku, sentQty }] */
export async function shipTransfer(transferId, items) {
  const { error } = await supabase.rpc('mark_in_transit', {
    p_transfer_id: transferId,
    p_sent_items: items.map((i) => ({ sku: i.sku, sent_qty: i.sentQty })),
  });
  if (error) throw new Error(error.message);
}

/** items: [{ sku, receivedQty }] */
export async function receiveTransfer(transferId, items) {
  const { error } = await supabase.rpc('receive_transfer', {
    p_transfer_id: transferId,
    p_received_items: items.map((i) => ({ sku: i.sku, received_qty: i.receivedQty })),
  });
  if (error) throw new Error(error.message);
}

export async function rejectTransfer(transferId, reason) {
  const { error } = await supabase.rpc('reject_transfer', { p_transfer_id: transferId, p_reason: reason });
  if (error) throw new Error(error.message);
}

export async function cancelTransfer(transferId, reason) {
  const { error } = await supabase.rpc('cancel_transfer', { p_transfer_id: transferId, p_reason: reason });
  if (error) throw new Error(error.message);
}

// ---- Bills (monthly business + personal expense monitoring — unrelated to inventory,
// Admin-only, plain CRUD since there's no concurrency to protect against here) ----

export async function listBills() {
  const { data, error } = await supabase.from('bills')
    .select('*')
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by', payer: 'paid_by' });
}

/** Returns the new bill's id — needed so a photo picked in the same Add Bill submit
 * can be uploaded and linked to the row right after it's created. */
export async function createBill({ name, category, accountName, accountNumber, amount, dueDate, status, isRecurring, notes }) {
  const empId = await currentEmployeeId();
  const { data, error } = await supabase.from('bills').insert({
    name, category, account_name: accountName || null, account_number: accountNumber || null,
    amount: amount || null, due_date: dueDate || null,
    status: status || 'Unpaid', is_recurring: !!isRecurring, notes: notes || null,
    created_by: empId,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function setBillStatus(id, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  patch.paid_date = status === 'Paid' ? new Date().toISOString().slice(0, 10) : null;
  if (status === 'Paid') {
    patch.paid_by = await currentEmployeeId();
  } else {
    patch.paid_by = null;
  }
  const { error } = await supabase.from('bills').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Generic field edit — this is what makes a recurring bill reusable: instead of
 * re-adding it every month, edit the same row's amount/due date and it's ready again. */
export async function updateBill(id, { name, category, accountName, accountNumber, amount, dueDate, status, isRecurring, notes }) {
  const { error } = await supabase.from('bills').update({
    name, category, account_name: accountName || null, account_number: accountNumber || null,
    amount: amount || null, due_date: dueDate || null,
    status, is_recurring: !!isRecurring, notes: notes || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Cleans up the attachment in storage first (if any) so deleting a bill never leaves
 * an orphaned file behind — storage isn't cascade-deleted automatically by a row delete. */
export async function deleteBill(id) {
  const { data: bill } = await supabase.from('bills').select('attachment_path').eq('id', id).single();
  if (bill && bill.attachment_path) {
    await supabase.storage.from('bill-attachments').remove([bill.attachment_path]);
  }
  const { error } = await supabase.from('bills').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Uploads a proof-of-payment/refund photo to the private bill-attachments bucket and
 * links it to the bill row. Path is prefixed by bill id so files are naturally grouped
 * and never collide across bills. */
export async function uploadBillAttachment(billId, file) {
  const path = billId + '/' + Date.now() + '_' + file.name;
  const { error: upErr } = await supabase.storage.from('bill-attachments').upload(path, file, { upsert: true });
  if (upErr) throw new Error(upErr.message);
  const { error: updErr } = await supabase.from('bills')
    .update({ attachment_path: path, updated_at: new Date().toISOString() }).eq('id', billId);
  if (updErr) throw new Error(updErr.message);
  return path;
}

/** Bucket is private, so viewing a photo means minting a short-lived signed URL on
 * demand rather than storing a permanent public link. */
export async function getBillAttachmentUrl(path) {
  const { data, error } = await supabase.storage.from('bill-attachments').createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function removeBillAttachment(billId, path) {
  await supabase.storage.from('bill-attachments').remove([path]);
  const { error } = await supabase.from('bills')
    .update({ attachment_path: null, updated_at: new Date().toISOString() }).eq('id', billId);
  if (error) throw new Error(error.message);
}

// ---- Subasta (auction of unredeemed pawned items) — per branch, Admin/Manager see
// everything, Branch Supervisor sees/manages only their own branch (RLS-enforced). ----

/** branchId narrows the query server-side -- branches.html only ever shows one
 * branch at a time, so fetching every branch's full history on every load/switch
 * (and re-filtering it client-side) got slower as the table grew for no reason. */
export async function listSubastaItems(branchId) {
  let query = supabase.from('subasta_items')
    .select('*, branches(name), subasta_payments(*)')
    .order('auction_eligible_date', { ascending: true, nullsFirst: false });
  if (branchId != null) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

/** One payment method label for quick display/search -- the individual rows in
 * payments are still the source of truth (sums, cash-only balances, etc.). */
function summarizePaymentMethod(payments) {
  if (!payments || !payments.length) return null;
  const methods = [...new Set(payments.map((p) => p.method))];
  return methods.length === 1 ? methods[0] : 'Multiple';
}

export async function createSubastaItem({ branchId, sku, itemDescription, weightGrams, pawnReference, pawnDate, auctionEligibleDate, notes }) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('subasta_items').insert({
    branch_id: branchId, sku: sku || null, item_description: itemDescription,
    weight_grams: weightGrams || null, pawn_reference: pawnReference || null, pawn_date: pawnDate || null,
    auction_eligible_date: auctionEligibleDate || null, notes: notes || null,
    created_by: empId,
  });
  if (error) throw new Error(error.message);
}

/** payments (optional [{method, amount}]) lets a sale be split across methods -- when
 * given, it replaces any existing rows for this item and salePrice is recomputed as
 * their sum rather than trusting a separately-typed figure. */
export async function updateSubastaItem(id, { branchId, sku, itemDescription, weightGrams, pawnReference, pawnDate, auctionEligibleDate, status, saleDate, salePrice, buyerName, notes, payments }) {
  const effectiveSalePrice = payments && payments.length ? payments.reduce((s, p) => s + Number(p.amount || 0), 0) : (salePrice || null);
  const { error } = await supabase.from('subasta_items').update({
    branch_id: branchId, sku: sku || null, item_description: itemDescription,
    weight_grams: weightGrams || null, pawn_reference: pawnReference || null, pawn_date: pawnDate || null,
    auction_eligible_date: auctionEligibleDate || null, status,
    sale_date: saleDate || null, sale_price: effectiveSalePrice, buyer_name: buyerName || null,
    payment_method: payments && payments.length ? summarizePaymentMethod(payments) : null,
    notes: notes || null, updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);

  if (payments) {
    const { error: delErr } = await supabase.from('subasta_payments').delete().eq('subasta_item_id', id);
    if (delErr) throw new Error(delErr.message);
    if (payments.length) {
      const rows = payments.filter((p) => p.amount > 0).map((p) => ({ subasta_item_id: id, payment_method: p.method, amount: p.amount }));
      if (rows.length) {
        const { error: insErr } = await supabase.from('subasta_payments').insert(rows);
        if (insErr) throw new Error(insErr.message);
      }
    }
  }
}

export async function deleteSubastaItem(id) {
  const { error } = await supabase.from('subasta_items').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---- Scrap (scrap gold/silver bought in or sold on) — per branch, same access pattern
// as Subasta. v_scrap_balance sums each branch+metal's running weight on hand. ----

/** branchId narrows the query server-side -- see listSubastaItems() for why. */
export async function listScrapEntries(branchId) {
  let query = supabase.from('scrap_entries')
    .select('*, branches(name), scrap_payments(*)')
    .order('entry_date', { ascending: false });
  if (branchId != null) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

export async function getScrapBalances() {
  const { data, error } = await supabase.from('v_scrap_balance').select('*');
  if (error) throw new Error(error.message);
  return data;
}

/** Scrap-purpose Branch Capital minus net cash spent/received on Scrap -- see
 * v_scrap_cash_balance (43_scrap_cash_balance.sql) for the running-balance formula. */
export async function getScrapCashBalances() {
  const { data, error } = await supabase.from('v_scrap_cash_balance').select('*');
  if (error) throw new Error(error.message);
  return data;
}

/** payments ([{method, amount}], at least one required) replaces the old single
 * paymentMethod/totalAmount fields -- total_amount is their sum and payment_method a
 * quick summary label ('Multiple' when more than one method is used). Returns the new
 * entry's id so a photo picked in the same Add form submit can be uploaded and linked
 * right after it's created (mirrors bills' attachment flow). */
export async function createScrapEntry({ branchId, entryDate, entryType, metalType, karat, weightGrams, pricePerGram, customerName, contactNumber, payments, source, notes }) {
  const empId = await currentEmployeeId();
  const totalAmount = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const { data, error } = await supabase.from('scrap_entries').insert({
    branch_id: branchId, entry_date: entryDate || new Date().toISOString().slice(0, 10),
    entry_type: entryType || 'In', metal_type: metalType, karat: karat || null,
    weight_grams: weightGrams, price_per_gram: pricePerGram || null, total_amount: totalAmount || null,
    customer_name: customerName || null, contact_number: contactNumber || null,
    payment_method: summarizePaymentMethod(payments),
    source: source || null, notes: notes || null, created_by: empId,
  }).select('id').single();
  if (error) throw new Error(error.message);

  if (payments.length) {
    const rows = payments.filter((p) => p.amount > 0).map((p) => ({ scrap_entry_id: data.id, payment_method: p.method, amount: p.amount }));
    if (rows.length) {
      const { error: payErr } = await supabase.from('scrap_payments').insert(rows);
      if (payErr) throw new Error(payErr.message);
    }
  }
  return data.id;
}

export async function deleteScrapEntry(id) {
  const { data: entry } = await supabase.from('scrap_entries').select('attachment_path').eq('id', id).single();
  if (entry && entry.attachment_path) {
    await supabase.storage.from('scrap-attachments').remove([entry.attachment_path]);
  }
  const { error } = await supabase.from('scrap_entries').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Path is "<branch_id>/<scrap_entry_id>/<file>" so Branch Supervisor storage access
 * can be scoped by branch, matching scrap_entries' own RLS. */
export async function uploadScrapAttachment(branchId, scrapId, file) {
  const path = branchId + '/' + scrapId + '/' + Date.now() + '_' + file.name;
  const { error: upErr } = await supabase.storage.from('scrap-attachments').upload(path, file, { upsert: true });
  if (upErr) throw new Error(upErr.message);
  const { error: updErr } = await supabase.from('scrap_entries').update({ attachment_path: path }).eq('id', scrapId);
  if (updErr) throw new Error(updErr.message);
  return path;
}

export async function getScrapAttachmentUrl(path) {
  const { data, error } = await supabase.storage.from('scrap-attachments').createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ---- Transactions (GCash + Bank Transfer statement lines) — Admin/Manager see and
// manage everything (including CSV import); Admin Assistant sees everything too but
// can only fill in fb_name/customer_name/order_id (the RLS update policy allows the
// whole row, but transactions.html only exposes those three fields to that position). ----

export async function listTransactions() {
  const { data, error } = await supabase.from('transactions')
    .select('*, branches(name), accounts(name, type)')
    .order('transaction_datetime', { ascending: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

/** Ren holds 5 separate GCash accounts, 2 BDO, 4 BPI, and 1 Maya -- each transaction
 * belongs to one specific account, not a generic "GCash"/"Bank Transfer" bucket. */
export async function listAccounts() {
  const { data, error } = await supabase.from('accounts')
    .select('*').eq('is_active', true).order('type').order('name');
  if (error) throw new Error(error.message);
  return data;
}

export async function createAccount({ name, type, number }) {
  const { error } = await supabase.from('accounts').insert({ name, type, number: number || null });
  if (error) throw new Error(error.message);
}

export async function updateAccountNumber(id, number) {
  const { error } = await supabase.from('accounts').update({ number: number || null }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Manual single-entry add (the original one-at-a-time form) — always a Credit, since
 * this represents money received from a customer, same as before. Bulk statement rows
 * come in through importTransactions() instead, which can be either debit or credit. */
export async function createTransaction({ accountId, transactionDatetime, amount, referenceNumber, fbName, customerName, orderId, notes }) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('transactions').insert({
    account_id: accountId, transaction_datetime: transactionDatetime || new Date().toISOString(),
    credit: amount, reference_number: referenceNumber || null,
    fb_name: fbName || null, customer_name: customerName || null, order_id: orderId || null,
    notes: notes || null, source: 'Manual', created_by: empId,
  });
  if (error) throw new Error(error.message);
}

/** Bulk-inserts parsed CSV/Word statement rows (see transactions.html's parsers for the
 * expected row shape: datetime/description/referenceNumber/debit/credit/balance, plus
 * optional fbName/customerName/orderId if the uploaded file already had them filled
 * in). Batches of 500 to stay well under PostgREST's payload limits for a large
 * multi-month statement. Returns the number of rows inserted. */
export async function importTransactions(accountId, rows) {
  const empId = await currentEmployeeId();
  const payload = rows.map((r) => ({
    account_id: accountId, transaction_datetime: r.datetime, description: r.description || null,
    reference_number: r.referenceNumber || null, debit: r.debit ?? null, credit: r.credit ?? null,
    balance: r.balance ?? null, fb_name: r.fbName || null, customer_name: r.customerName || null,
    order_id: r.orderId || null, source: 'CSV Import', created_by: empId,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await supabase.from('transactions').insert(payload.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  return payload.length;
}

/** The Admin Assistant reconciliation step — attaches who the payment was from and
 * which order it belongs to, after the raw statement line has already been imported. */
export async function updateTransactionReconciliation(id, { fbName, customerName, orderId }) {
  const { error } = await supabase.from('transactions')
    .update({ fb_name: fbName || null, customer_name: customerName || null, order_id: orderId || null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteTransaction(id) {
  const { error } = await supabase.from('transactions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---- Refunds — per branch, same access pattern as Payments. Optional proof photo in a
// private bucket, path "<branch_id>/<refund_id>/<file>" so RLS can scope by branch. ----

export async function listRefunds() {
  const { data, error } = await supabase.from('refunds')
    .select('*, refund_attachments(id, attachment_path, amount, reference_number, uploaded_at)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by', approver: 'approved_by' });
}

/** Returns the new refund's id so an optional request-time photo (proof of purchase,
 * photo of the item, etc.) picked in the same Add form submit can be uploaded and
 * linked right after -- separate from refund_attachments, which is the approver's
 * later "proof of payment" once it's actually been paid out. */
export async function createRefund({ customerName, orderReference, itemDescription, purchaseDate, dateRequested, refundAmount, refundMethod, accountName, accountNumber, reason, notes }) {
  const empId = await currentEmployeeId();
  const { data, error } = await supabase.from('refunds').insert({
    customer_name: customerName, order_reference: orderReference || null,
    item_description: itemDescription || null, purchase_date: purchaseDate || null,
    date_requested: dateRequested || new Date().toISOString().slice(0, 10),
    refund_amount: refundAmount, refund_method: refundMethod || 'GCash',
    account_name: accountName || null, account_number: accountNumber || null,
    reason: reason || null, notes: notes || null, created_by: empId,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

/** Path is "<refund_id>/request_<timestamp>_<file>" -- distinguishable from
 * refund_attachments' "<refund_id>/<timestamp>_<file>" proof-of-payment paths in the
 * same bucket, though they'd never collide anyway. */
export async function uploadRefundRequestPhoto(refundId, file) {
  const path = refundId + '/request_' + Date.now() + '_' + file.name;
  const { error: upErr } = await supabase.storage.from('refund-attachments').upload(path, file, { upsert: true });
  if (upErr) throw new Error(upErr.message);
  const { error } = await supabase.from('refunds').update({ request_attachment_path: path }).eq('id', refundId);
  if (error) throw new Error(error.message);
  return path;
}

/** Records who clicked Approve (mirrors bills.paid_by) -- once set, later status changes
 * (Completed, Reopened back to Approved) don't touch it, since the approval already
 * happened and shouldn't be reattributed to whoever completes/reopens it later. */
export async function setRefundStatus(id, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'Approved') {
    patch.approved_by = await currentEmployeeId();
  }
  const { error } = await supabase.from('refunds').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteRefund(id) {
  const { data: attachments } = await supabase.from('refund_attachments').select('attachment_path').eq('refund_id', id);
  const { data: refund } = await supabase.from('refunds').select('request_attachment_path').eq('id', id).single();
  const paths = (attachments || []).map((a) => a.attachment_path).concat(refund && refund.request_attachment_path ? [refund.request_attachment_path] : []);
  if (paths.length) {
    await supabase.storage.from('refund-attachments').remove(paths);
  }
  const { error } = await supabase.from('refunds').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Refunds for a large amount are sometimes paid out in staggered installments, each
 * with its own amount + proof-of-payment screenshot -- so this ADDS an attachment row
 * (amount + photo together) rather than replacing a single column. Callers are expected
 * to only allow this once the refund is Approved (or later), matching real payout
 * timing, and to only allow marking a refund Completed once the attached amounts sum
 * to the full requested refund_amount — see refunds.html's remaining-balance check. */
/** photo is optional -- a Proof of Payment entry can be saved with just the amount and
 * reference number when no image is available yet. */
export async function addRefundAttachment(refundId, amount, file, referenceNumber) {
  let path = null;
  if (file) {
    path = refundId + '/' + Date.now() + '_' + file.name;
    const { error: upErr } = await supabase.storage.from('refund-attachments').upload(path, file, { upsert: true });
    if (upErr) throw new Error(upErr.message);
  }
  const empId = await currentEmployeeId();
  const { error: insErr } = await supabase.from('refund_attachments')
    .insert({ refund_id: refundId, attachment_path: path, amount, reference_number: referenceNumber || null, uploaded_by: empId });
  if (insErr) throw new Error(insErr.message);
  return path;
}

export async function removeRefundAttachment(attachmentId, path) {
  if (path) await supabase.storage.from('refund-attachments').remove([path]);
  const { error } = await supabase.from('refund_attachments').delete().eq('id', attachmentId);
  if (error) throw new Error(error.message);
}

export async function getRefundAttachmentUrl(path) {
  const { data, error } = await supabase.storage.from('refund-attachments').createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ---- Asset & Supplies Custodian registry — one row per item, assigned to the employee
// accountable for it. Company-wide, Admin + Manager only (like Payments/Branch Capital). ----

/** Plain roster for the Custodian dropdown — unlike getEmployeesForChecklist(), this
 * includes Admin, since Ren can just as well be the custodian of an item. Goes through
 * get_employee_names() (see attachEmployeeNames() above) rather than a direct table
 * read, since the employees table's own RLS only lets Admin/Manager/self read other
 * rows -- everyone with Asset & Supplies Custodian access still needs to see the full
 * roster to pick a custodian. */
export async function listActiveEmployees() {
  const { data, error } = await supabase.rpc('get_employee_names');
  if (error) throw new Error(error.message);
  return (data || []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function listAssetCustodianItems() {
  const { data, error } = await supabase.from('asset_custodian_items')
    .select('*, branches(name)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { custodian: 'custodian_id', creator: 'created_by' });
}

export async function createAssetCustodianItem({ itemName, itemType, branchId, custodianId, quantity, unitValue, condition, dateAssigned, notes }) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('asset_custodian_items').insert({
    item_name: itemName, item_type: itemType || 'Asset', branch_id: branchId || null,
    custodian_id: custodianId || null, quantity: quantity || 1, unit_value: unitValue || null,
    condition: condition || 'Good', date_assigned: dateAssigned || null, notes: notes || null,
    created_by: empId,
  });
  if (error) throw new Error(error.message);
}

export async function updateAssetCustodianItem(id, { itemName, itemType, branchId, custodianId, quantity, unitValue, condition, dateAssigned, notes }) {
  const { error } = await supabase.from('asset_custodian_items').update({
    item_name: itemName, item_type: itemType, branch_id: branchId || null,
    custodian_id: custodianId || null, quantity: quantity || 1, unit_value: unitValue || null,
    condition, date_assigned: dateAssigned || null, notes: notes || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteAssetCustodianItem(id) {
  const { error } = await supabase.from('asset_custodian_items').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---- LBC monitoring (COD parcels shipped via LBC for online orders) — company-wide,
// not branch-scoped, same shape as Transactions. ----

export async function listLbcShipments() {
  const { data, error } = await supabase.from('lbc_shipments')
    .select('*, branches(name)')
    .order('ship_date', { ascending: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

export async function createLbcShipment({ branchId, orderId, customerName, trackingNumber, shipDate, codAmount, notes }) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('lbc_shipments').insert({
    branch_id: branchId || null, order_id: orderId, customer_name: customerName,
    tracking_number: trackingNumber || null, ship_date: shipDate || new Date().toISOString().slice(0, 10),
    cod_amount: codAmount || null, notes: notes || null, created_by: empId,
  });
  if (error) throw new Error(error.message);
}

export async function updateLbcShipment(id, { branchId, orderId, customerName, trackingNumber, shipDate, codAmount, status, remitted, remittedDate, notes }) {
  const { error } = await supabase.from('lbc_shipments').update({
    branch_id: branchId || null, order_id: orderId, customer_name: customerName,
    tracking_number: trackingNumber || null, ship_date: shipDate || null,
    cod_amount: codAmount || null, status, remitted: !!remitted, remitted_date: remittedDate || null,
    notes: notes || null, updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setLbcStatus(id, status) {
  const { error } = await supabase.from('lbc_shipments').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setLbcRemitted(id, remitted) {
  const { error } = await supabase.from('lbc_shipments')
    .update({ remitted, remitted_date: remitted ? new Date().toISOString().slice(0, 10) : null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteLbcShipment(id) {
  const { error } = await supabase.from('lbc_shipments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---- Branch Capital (money Ren injects into a branch — the inverse of Bills) ----
// Admin-only, same access model as Bills.

export async function listBranchCapitalEntries() {
  const { data, error } = await supabase.from('branch_capital_entries')
    .select('*, branches(name)')
    .order('entry_date', { ascending: false });
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

/** fromDate/toDate optional (both omitted = all-time, same numbers the old fixed
 * view always showed) -- get_branch_capital_totals() in
 * 69_branch_capital_total_time_range.sql. */
export async function getBranchCapitalBalances(fromDate, toDate) {
  const { data, error } = await supabase.rpc('get_branch_capital_totals', { p_from: fromDate || null, p_to: toDate || null });
  if (error) throw new Error(error.message);
  return data;
}

/** Total Capital (above) is cumulative money ever put in, never reduced by anything
 * spent. This is what's actually left -- total capital minus the one outflow this app
 * tracks (net Cash spent/received on Scrap), same formula as v_scrap_cash_balance but
 * covering every purpose, not just Scrap-purpose entries. */
export async function getBranchCapitalRemaining() {
  const { data, error } = await supabase.from('v_branch_capital_remaining').select('*');
  if (error) throw new Error(error.message);
  return data;
}

export async function createBranchCapitalEntry({ branchId, entryDate, amount, purpose, notes, status }) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('branch_capital_entries').insert({
    branch_id: branchId, entry_date: entryDate || new Date().toISOString().slice(0, 10),
    amount, purpose: purpose || null, notes: notes || null, created_by: empId,
    status: status || 'Approved',
  });
  if (error) throw new Error(error.message);
}

export async function deleteBranchCapitalEntry(id) {
  const { error } = await supabase.from('branch_capital_entries').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function approveBranchCapitalEntry(id) {
  const empId = await currentEmployeeId();
  const { error } = await supabase.from('branch_capital_entries')
    .update({ status: 'Approved', approved_by: empId, approved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Admin sets a person's position directly from the Access Checklist -- position drives
 * several access rules (Sales Executive, Admin Assistant, ...) so this is where an
 * Admin actually assigns it, rather than every position change needing a DB edit. */
export async function updateEmployeePosition(employeeId, position) {
  const { error } = await supabase.from('employees').update({ position: position || null }).eq('id', employeeId);
  if (error) throw new Error(error.message);
}

// ---- Access checklist (Admin-only sign-off record — see access-checklist.html) ----

/** Everyone except Admin, since Admin has full access by definition and isn't
 * worth verifying. Pulled live so a role/branch/bills_access change shows up
 * here immediately -- the checklist tracks today's roster, not a snapshot. */
export async function getEmployeesForChecklist() {
  const { data, error } = await supabase.from('employees')
    .select('id, full_name, role, position, bills_access, refund_approval_access, extra_page_access, branches(name)')
    .neq('role', 'Admin')
    .eq('status', 'Active')
    .order('full_name');
  if (error) throw new Error(error.message);
  return data;
}

export async function getAccessChecklist() {
  const { data, error } = await supabase.from('access_checklist_verifications').select('employee_id, item_key, checked, levels');
  if (error) throw new Error(error.message);
  return data;
}

/** levels is an array of any combination of 'view'|'encode'|'edit'|'approver' -- Ren
 * can pick more than one for a task entirely at his own discretion (e.g. Edit AND
 * Approver). Empty array means "No access." A row's mere existence means Ren has an
 * explicit override recorded for this task -- absence means the page falls back to
 * the computed default. */
export async function setAccessChecklistItem(employeeId, itemKey, checked, levels) {
  const empId = checked ? await currentEmployeeId() : null;
  const { error } = await supabase.from('access_checklist_verifications').upsert({
    employee_id: employeeId, item_key: itemKey, checked, levels: checked ? (levels || []) : [],
    checked_by: empId,
    checked_at: checked ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'employee_id,item_key' });
  if (error) throw new Error(error.message);
}

// ---- Layaway (67_layaway.sql) -- an item held for a customer while they pay it off
// in installments. Every write goes through the SECURITY DEFINER functions below;
// direct table writes are closed by default-deny RLS, same as inventory/sales.

export async function listLayaways(branchId) {
  let query = supabase.from('layaway_holds')
    .select('*, branches(name), layaway_payments(*)')
    .order('hold_date', { ascending: false });
  if (branchId != null) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

export async function createLayawayHold({ sku, branchId, qty, customerName, contactNumber, unitPrice, notes }) {
  const { data, error } = await supabase.rpc('create_layaway_hold', {
    p_sku: sku, p_branch_id: branchId, p_qty: qty, p_customer_name: customerName,
    p_contact_number: contactNumber || null, p_unit_price: unitPrice || null, p_notes: notes || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function addLayawayPayment(holdId, amount, paymentMethod, referenceNumber) {
  const { data, error } = await supabase.rpc('add_layaway_payment', {
    p_hold_id: holdId, p_amount: amount, p_payment_method: paymentMethod, p_reference_number: referenceNumber || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function completeLayaway(holdId, orderNumber) {
  const { error } = await supabase.rpc('complete_layaway', { p_hold_id: holdId, p_order_number: orderNumber || null });
  if (error) throw new Error(error.message);
}

export async function cancelLayaway(holdId, reason) {
  const { error } = await supabase.rpc('cancel_layaway', { p_hold_id: holdId, p_reason: reason || null });
  if (error) throw new Error(error.message);
}

/** Managerial-only correction, matching scrap_payments_managerial_delete's pattern --
 * fixing a mistaken payment entry, not part of the normal add-payment flow. */
export async function deleteLayawayPayment(paymentId) {
  const { error } = await supabase.from('layaway_payments').delete().eq('id', paymentId);
  if (error) throw new Error(error.message);
}

// ---- Order & Item Status (Record Movement) -- a monitoring board mirroring
// Pancake's own Orders view, item-focused rather than customer-focused. Rows come
// from the pancake-webhook Edge Function (live) and the one-time pancake-backfill
// pull of Pancake's order history (78_order_item_status_raw_payload.sql). Company-
// wide read/status-update, Admin/Manager can delete (75_order_item_status_tracker.sql).

// Terminal states -- the order is fully done, nothing left to pull/pack/ship -- are
// excluded from the working board by default. Excluded at the query level (not just
// client-side) because after the historical backfill this table holds 40,000+ rows;
// most of them are exactly these terminal ones, and fetching all of them on every
// page load doesn't scale. Use listOrderHistoryForItem() to see an item's full
// history including these.
const TERMINAL_STATUSES = ['delivered', 'canceled', 'returned', 'shipped'];

// raw_payload is a multi-KB JSONB blob per row kept only for confirming Pancake's
// status_name/field mappings from real data (see 78_order_item_status_raw_payload.sql)
// -- never needed by the UI, so it's deliberately left out of this column list rather
// than using select('*'), which would otherwise pull it for every one of 40,000+ rows
// on every page load.
const ORDER_ITEM_STATUS_COLUMNS = 'id, order_reference, sku, item_name, qty, branch_id, customer_name, status, notes, created_by, created_at, updated_at, branches(name)';

// A single status like "new" alone has tens of thousands of active orders after the
// historical Pancake backfill -- fetching everything active (even with terminal
// statuses excluded) still silently hit Supabase's default 1000-row cap, which is
// exactly how Awaiting Stock's real 90 orders were showing as ~27: most of them
// just fell outside whatever the most-recent 1000 rows happened to be. Capped here
// explicitly, and paired with a UI message when a query is scoped to fewer rows
// than actually match (search further to narrow it down), same lesson the original
// Sheets-based system already learned about this business's real data volume.
export const ORDER_ITEM_STATUS_ROW_CAP = 500;

/** Strips characters that are structurally significant to PostgREST's .or() filter
 * syntax (comma separates conditions, parentheses group them) out of free-text
 * search input before it's embedded in one -- otherwise a search term containing
 * either could reshape the filter instead of just being searched for. Also escapes
 * SQL LIKE wildcards so a literal % or _ in a search term isn't treated as one. */
function sanitizeForOrFilter(s) {
  return s.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

/** statusKeys: null for "All", or the array of raw status_name values the current
 * tab maps to (PANCAKE_STATUS_TABS entries are all single-key now, but this still
 * takes an array for any tab that ever needs more than one). search: free text,
 * matched against item/SKU/order/customer/notes -- same fields the old client-side
 * filter checked, just done server-side now so a tab load only pulls what that tab
 * actually needs instead of the whole active dataset. */
export async function listOrderItemStatuses({ statusKeys = null, search = '' } = {}) {
  let query = supabase.from('order_item_status')
    .select(ORDER_ITEM_STATUS_COLUMNS)
    .not('status', 'in', '(' + TERMINAL_STATUSES.join(',') + ')');
  if (statusKeys) query = query.in('status', statusKeys);
  const term = sanitizeForOrFilter(search || '');
  if (term) {
    const pat = '%' + term + '%';
    query = query.or(
      'item_name.ilike.' + pat + ',sku.ilike.' + pat + ',order_reference.ilike.' + pat +
      ',customer_name.ilike.' + pat + ',notes.ilike.' + pat
    );
  }
  const { data, error } = await query.order('created_at', { ascending: false }).limit(ORDER_ITEM_STATUS_ROW_CAP);
  if (error) throw new Error(error.message);
  return attachEmployeeNames(data, { creator: 'created_by' });
}

/** Per-status counts for the tab badges -- a lightweight aggregate (see
 * 80_order_item_status_counts_fn.sql) instead of counting a client-side array,
 * since that array is now capped/scoped to one tab at a time and would give wrong
 * counts for every OTHER tab. */
export async function getOrderItemStatusCounts() {
  const { data, error } = await supabase.rpc('order_item_status_counts');
  if (error) throw new Error(error.message);
  const counts = { all: 0 };
  (data || []).forEach((row) => { counts[row.status] = Number(row.cnt); counts.all += Number(row.cnt); });
  return counts;
}

/** Full history for one item across EVERY status, including the terminal ones the
 * default board query above excludes -- a targeted on-demand query rather than
 * something filtered from the already-loaded board data, since that data no longer
 * contains delivered/canceled/etc. rows at all. Matches by SKU when it's a real one
 * (not the webhook's synthetic per-order-line "pancake-item-<id>" SKU), else by
 * item_name -- same fallback historyKey() uses in movement.html, kept in sync by hand. */
export async function listOrderHistoryForItem({ sku, itemName }) {
  let query = supabase.from('order_item_status').select(ORDER_ITEM_STATUS_COLUMNS);
  query = (sku && !sku.toLowerCase().startsWith('pancake-item-'))
    ? query.ilike('sku', sku)
    : query.ilike('item_name', itemName);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

/** Just the status, for the quick inline dropdown on each row -- doesn't require
 * opening the full edit form for the common case of moving an item to its next stage. */
export async function setOrderItemStatus(id, status) {
  const { error } = await supabase.from('order_item_status')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteOrderItemStatus(id) {
  const { error } = await supabase.from('order_item_status').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
