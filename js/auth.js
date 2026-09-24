// Google sign-in + employee linking. Mirrors the old Apps Script system's model — the
// Google account IS the identity, matched by email against a roster (now `employees`
// instead of the Employees sheet) — just persisted via `link_my_employee_record()`
// (01_branches_employees.sql) instead of re-derived on every single call.
import { supabase } from './supabaseClient.js?v=20260925b';

export async function signInWithGoogle() {
  const redirectTo = new URL('index.html', window.location.href).toString();
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw error;
}

/** ID+password sign-in, added alongside Google (not instead of it) for employees who
 * don't sign in with a personal Gmail. The ID number maps to a synthetic
 * "<code>@kittymaeid.com" email under the hood — see link_my_employee_record() in
 * 33_multi_auth_identity.sql, which recognizes that domain and matches by
 * employee_code instead of a real email. */
export async function signInWithIdPassword(idNumber, password) {
  const email = idNumber.trim().toLowerCase() + '@kittymaeid.com';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'login.html';
}

/**
 * Call once per page load (after sign-in). Returns the linked employees row, or throws
 * an Error whose message starts with 'NOT_REGISTERED' or 'INACTIVE' — callers should
 * check for those prefixes the same way the old app's renderGate() branched on
 * user.status.
 */
export async function linkEmployee() {
  const { data, error } = await supabase.rpc('link_my_employee_record');
  if (error) throw new Error(error.message);
  return data;
}

/** Self-service name correction — several employees were bulk-added from a roster
 * screenshot with placeholder/generic names, so anyone can fix their own display name
 * (and nothing else — see update_my_name() in 30_update_my_name.sql for why this isn't
 * a general self-edit). */
export async function updateMyName(fullName) {
  const { data, error } = await supabase.rpc('update_my_name', { p_full_name: fullName });
  if (error) throw new Error(error.message);
  return data;
}

/** Redirects to login.html if there's no active session. Call at the top of every
 * page except login.html itself. */
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}
