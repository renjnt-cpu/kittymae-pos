// Payment Verification -- every Supabase call the module makes lives here, so the screens never touch `supabase` directly (and can be exercised against a stand-in
// object in tests). Nothing reads the pv_* tables: each screen asks a pv_* database function, which checks who is calling (the payment_verify.* keys), which
// branches they may see, and returns {ok:false, message} for anything that is not allowed or not valid. The ERP and the POS carry an identical copy of this file.
import { supabase } from './supabaseClient.js?v=20261018a';
import { uploadPrepared } from './pvImage.js?v=20261018a';

export const BUCKET = 'payment-proofs';

async function rpc(name, params) {
  const { data, error } = await supabase.rpc(name, params || {});
  if (error) throw new Error(error.message);
  return data;
}
/** For the simple flows: throws the database's own sentence when it said ok:false. */
export function must(res) {
  if (res && res.ok === false) { const e = new Error(res.message || 'That did not work.'); e.result = res; throw e; }
  return res;
}

// ---------------------------------------------------------------- reading
export const dashboard = (branch) => rpc('pv_dashboard', { p_branch: branch || null });
export const list = (filters, limit = 50, offset = 0, sort = 'risk') => rpc('pv_list', { p_filters: filters || {}, p_limit: limit, p_offset: offset, p_sort: sort });
export const get = (id) => rpc('pv_get', { p_id: id });
export const searchReference = (q, limit = 50) => rpc('pv_search_reference', { p_q: q, p_limit: limit });
export const report = (kind, from, to, branch) => rpc('pv_report', { p_kind: kind, p_from: from || null, p_to: to || null, p_branch: branch || null });
export const auditList = (filters, limit = 100, offset = 0) => rpc('pv_audit_list', { p_filters: filters || {}, p_limit: limit, p_offset: offset });
export const forConversation = (page, conv) => rpc('pv_for_conversation', { p_page: page, p_conv: conv });
export const syncNow = () => rpc('pv_sync_now');
export const findOrders = (q, limit = 15) => rpc('pv_find_orders', { p_q: q, p_limit: limit });
export const orderSummary = (ref, shop) => rpc('pv_order_summary', { p_ref: ref, p_shop: shop || null });
export const orderBadges = (refs, shop) => rpc('pv_order_badges', { p_refs: refs, p_shop: shop || null });
export const formOptions = () => rpc('pv_form_options');
export const accountsList = () => rpc('pv_accounts_list');
export const pancakeMethodsList = () => rpc('pv_pancake_methods_list');
export const methodRulesList = () => rpc('pv_method_rules_list');
export async function listBranches() {
  const { data, error } = await supabase.from('branches').select('id, name').order('id');
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------- settings (manage_accounts)
export const accountSave = (a) => rpc('pv_account_save', { p_id: a.id || null, p_name: a.name, p_type: a.type, p_number: a.number || null, p_active: a.active !== false });
export const pancakeMethodMap = (shop, paymentId, accountId, method) => rpc('pv_pancake_method_map', { p_shop: shop, p_payment_id: String(paymentId), p_account_id: accountId || null, p_method: method || null });
export const methodRuleSave = (method, proof, reference, active) => rpc('pv_method_rule_save', { p_method: method, p_proof: proof, p_reference: reference, p_active: active });

// ---------------------------------------------------------------- adding a proof
/** p: {source, orderRef, orderShop, customerName, customerPhone, convPage, convId, amount, method, accountId, reference, date, time, notes, images:[{storage_path,...}]} */
export const submit = (p) => rpc('pv_submit', {
  p_source: p.source || 'MANUAL_ENTRY', p_order_ref: p.orderRef || null, p_order_shop: p.orderShop || null, p_customer_name: p.customerName || null, p_customer_phone: p.customerPhone || null,
  p_conv_page: p.convPage || null, p_conv_id: p.convId || null, p_amount: p.amount === '' || p.amount === undefined ? null : p.amount, p_method: p.method || null, p_account_id: p.accountId || null,
  p_reference: p.reference || null, p_date: p.date || null, p_time: p.time || null, p_notes: p.notes || null, p_images: p.images || [],
});
export const addImage = (id, image) => rpc('pv_add_image', { p_id: id, p_image: image });
export const setImageHash = (imageId, sha256, phash) => rpc('pv_set_image_hash', { p_image_id: imageId, p_sha256: sha256 || null, p_phash: phash || null });
/** The whole duplicate check on typed values, without saving anything. */
export const checkPreview = (p) => rpc('pv_check_preview', {
  p_reference: p.reference || null, p_amount: p.amount === '' || p.amount === undefined ? null : p.amount, p_order_ref: p.orderRef || null, p_order_shop: p.orderShop || null,
  p_customer_name: p.customerName || null, p_customer_phone: p.customerPhone || null, p_method: p.method || null, p_sha256: p.sha256 || null, p_phash: p.phash || null,
});

// ---------------------------------------------------------------- deciding
export const edit = (id, patch, reason) => rpc('pv_edit', { p_id: id, p_patch: patch, p_reason: reason });
export const verify = (id, ack, note, amount) => rpc('pv_verify', { p_id: id, p_ack: !!ack, p_note: note || null, p_amount: amount === '' || amount === undefined ? null : amount });
export const overrideVerify = (id, reason, amount) => rpc('pv_override_verify', { p_id: id, p_reason: reason, p_amount: amount === '' || amount === undefined ? null : amount });
export const unverify = (id, reason) => rpc('pv_unverify', { p_id: id, p_reason: reason });
export const needsReview = (id, note) => rpc('pv_needs_review', { p_id: id, p_note: note || null });
export const reject = (id, code, note) => rpc('pv_reject', { p_id: id, p_reason_code: code, p_note: note || null });
export const markDuplicate = (id, original, reason, note) => rpc('pv_mark_duplicate', { p_id: id, p_original: original, p_reason: reason, p_note: note || null });
export const moveToOrder = (id, orderRef, shop, reason) => rpc('pv_move_to_order', { p_id: id, p_order_ref: orderRef, p_shop: shop || null, p_reason: reason });
export const recheck = (id) => rpc('pv_check', { p_id: id });

// ---------------------------------------------------------------- pictures
/** Uploads prepared pictures (see pvImage.prepareImage) to the private bucket; returns the JSON list pv_submit / pv_add_image take. */
export async function uploadImages(prepared) {
  const out = [];
  for (const p of prepared) out.push(await uploadPrepared(supabase, BUCKET, p));
  return out;
}
const urlCache = new Map();   // path -> { url, exp }
/** Short-lived addresses for private pictures, fetched in one call and kept for a while. */
export async function signedUrls(paths, ttl = 900) {
  const wanted = [...new Set((paths || []).filter(Boolean))];
  const need = wanted.filter((p) => { const c = urlCache.get(p); return !c || c.exp < Date.now() + 30000; });
  if (need.length) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(need, ttl);
    if (error) throw new Error(error.message);
    for (const row of data || []) if (row.signedUrl) urlCache.set(row.path, { url: row.signedUrl, exp: Date.now() + ttl * 1000 });
  }
  return Object.fromEntries(wanted.map((p) => [p, (urlCache.get(p) || {}).url || null]));
}
export const signedUrl = async (path) => (await signedUrls([path]))[path];

/** Fills in the src of every <img data-pv-path / data-pv-url> under `root` (see pvFormat.imgTag). Safe to call again after the markup changes. */
export async function hydrateImages(root) {
  if (!root) return;
  const direct = [...root.querySelectorAll('img[data-pv-url]:not([data-pv-done])')];
  for (const im of direct) { im.dataset.pvDone = '1'; im.addEventListener('error', () => im.classList.add('pv-img-broken'), { once: true }); im.src = im.dataset.pvUrl; }
  const stored = [...root.querySelectorAll('img[data-pv-path]:not([data-pv-done])')];
  if (!stored.length) return;
  stored.forEach((im) => { im.dataset.pvDone = '1'; im.addEventListener('error', () => im.classList.add('pv-img-broken'), { once: true }); });
  try {
    const urls = await signedUrls(stored.map((im) => im.dataset.pvPath));
    for (const im of stored) { if (urls[im.dataset.pvPath]) im.src = urls[im.dataset.pvPath]; else im.classList.add('pv-img-broken'); }
  } catch (e) { stored.forEach((im) => im.classList.add('pv-img-broken')); }
}
