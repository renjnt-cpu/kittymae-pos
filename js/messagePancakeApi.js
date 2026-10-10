// Message Pancake -- the wrappers for its database functions (migrations 207-213). POS-only: the ERP does not have this module.
// Everything is checked again in the database (message_pancake.* keys, branch visibility); the page only hides what the person cannot use.
import { supabase } from './supabaseClient.js?v=20261011b';

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// ---- reading
/** The queue: {view, intent, tone, priority, status, branch, assigned, min_wait, has_order, needs_reply, q, sort, limit, offset} -> {rows, counts, total, categories, thresholds, perms, ...} */
export const msgpInbox = (filter) => rpc('msgp_inbox', { p_filter: filter || {} });
/** One conversation in full: row, order, timeline, notes, metrics, suggested reply, assignable staff. */
export const msgpConversation = (id) => rpc('msgp_conversation', { p_id: id });
/** The POS Customer Attention feed (alert facts only, no message text). view: all | urgent | follow_up | ordering | complaints | payment | delivery | waiting */
export const msgpAttention = (view) => rpc('msgp_attention', { p_view: view || 'all' });
export const msgpReport = (from, to, branch) => rpc('msgp_report', { p_from: from, p_to: to, p_branch: branch || null });

// ---- working a conversation
export const msgpAssign = (id, employeeId) => rpc('msgp_assign', { p_id: id, p_employee: employeeId || null });
export const msgpSetStatus = (id, status, note) => rpc('msgp_set_status', { p_id: id, p_status: status, p_note: note || null });
export const msgpResolve = (id, note) => rpc('msgp_resolve', { p_id: id, p_note: note || null });
export const msgpReopen = (id) => rpc('msgp_reopen', { p_id: id });
export const msgpSnooze = (id, minutes) => rpc('msgp_snooze', { p_id: id, p_minutes: minutes || null });
export const msgpAddNote = (id, note) => rpc('msgp_add_note', { p_id: id, p_note: note });
/** changes: {intent?, tone?, priority?} -- null / 'auto' goes back to the detected value */
export const msgpCorrect = (id, changes) => rpc('msgp_correct', { p_id: id, p_changes: changes });
export const msgpEscalate = (id, reason, note) => rpc('msgp_escalate', { p_id: id, p_reason: reason, p_note: note || null });
export const msgpDeescalate = (id) => rpc('msgp_deescalate', { p_id: id });
/** Starts the background job once. probe=true is "Test connection" (owner only). */
export const msgpRequestCheck = (probe) => rpc('msgp_request_check', { p_probe: !!probe });

// ---- owner settings (message_pancake.manage)
export const msgpGetSettings = () => rpc('msgp_get_settings');
export const msgpSaveSettings = (settings) => rpc('msgp_save_settings', { p_settings: settings });
export const msgpSaveCategory = (cat) => rpc('msgp_save_category', { p_cat: cat });
export const msgpDeleteCategory = (key) => rpc('msgp_delete_category', { p_key: key });
export const msgpSaveWordlist = (key, words) => rpc('msgp_save_wordlist', { p_key: key, p_words: words });
/** Write-only: nothing ever returns the token. */
export const msgpSetToken = (pageId, token) => rpc('msgp_set_token', { p_page_id: pageId, p_token: token });
export const msgpClearToken = (pageId) => rpc('msgp_clear_token', { p_page_id: pageId });
