// Message Pancake -- the wrappers for its database functions (migration 207). POS-only: the ERP does not have this module.
// Everything is checked again in the database (message_pancake.view / message_pancake.manage); the page only hides what the person cannot use.
import { supabase } from './supabaseClient.js?v=20261011a';

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

/** view: 'open' | 'snoozed' | 'done' */
export const msgpList = (view) => rpc('msgp_list', { p_view: view });
/** The badge / strip: counts + the five most pressing names. */
export const msgpCounts = () => rpc('msgp_counts');
/** action: 'handled' | 'dismissed' | 'snooze' | 'reopen' */
export const msgpSetStatus = (id, action, snoozeMinutes, note) =>
  rpc('msgp_set_status', { p_id: id, p_action: action, p_note: note || null, p_snooze_minutes: snoozeMinutes || null });
/** Starts the background job once. probe=true is "Test connection" (owner only). */
export const msgpRequestCheck = (probe) => rpc('msgp_request_check', { p_probe: !!probe });

// Owner only (message_pancake.manage)
export const msgpGetSettings = () => rpc('msgp_get_settings');
export const msgpSaveSettings = (settings) => rpc('msgp_save_settings', { p_settings: settings });
/** Write-only: nothing ever returns the token. */
export const msgpSetToken = (pageId, token) => rpc('msgp_set_token', { p_page_id: pageId, p_token: token });
export const msgpClearToken = (pageId) => rpc('msgp_clear_token', { p_page_id: pageId });
