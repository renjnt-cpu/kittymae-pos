// Single shared client — every page imports this instead of creating its own, so there's
// one session/auth state for the whole app (mirrors having one google.script.run-backed
// session in the old Apps Script app).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=20261012c';

// A device whose login token has expired -- or whose clock is wrong, so the app thinks the token is
// still good -- gets "JWT expired" from the server and used to land on a dead-end "Something went
// wrong" page (2026-10-11, staff could not get in). When a data request is refused for that reason,
// get a fresh token ONCE and repeat the same request. Only a request the server REFUSED is repeated
// (an expired token is rejected before anything runs), so nothing can be saved twice. If the login
// cannot be renewed the original answer is returned and the page sends the person to the login screen.
const TOKEN_REFUSED = /JWT expired|exp claim|Invalid JWT/i;
let refreshing = null;
function refreshOnce() {
  if (!refreshing) refreshing = supabase.auth.refreshSession().finally(() => { refreshing = null; });
  return refreshing;
}

async function fetchWithTokenRefresh(input, init) {
  const res = await fetch(input, init);
  if (res.status !== 401 || typeof input !== 'string' || input.includes('/auth/v1/')) return res;
  let body = '';
  try { body = await res.clone().text(); } catch (e) { return res; }
  if (!TOKEN_REFUSED.test(body)) return res;
  let token = null;
  try { const r = await refreshOnce(); token = r && r.data && r.data.session ? r.data.session.access_token : null; } catch (e) { /* cannot renew */ }
  if (!token) return res;
  const headers = new Headers((init && init.headers) || undefined);
  headers.set('Authorization', 'Bearer ' + token);
  return fetch(input, Object.assign({}, init, { headers }));
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: fetchWithTokenRefresh } });
