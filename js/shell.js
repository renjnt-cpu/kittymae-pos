// Sign-in gate every page (except login.html) needs -- session check, employee lookup,
// NOT_REGISTERED/INACTIVE screens. This is a pared-down copy of the main ERP's shell.js:
// this site has only 4 pages, so it doesn't build the full ERP header/nav (Dashboard,
// Branches, Transfers, Bills, etc. don't exist here) -- js/posNav.js renders this site's
// own minimal nav instead, right after initShell() resolves.
import { requireSession, linkEmployee } from './auth.js';

export async function initShell() {
  const session = await requireSession();
  if (!session) return null; // requireSession already redirected to login.html

  let employee;
  try {
    employee = await linkEmployee();
  } catch (err) {
    const msg = String(err.message || err);
    document.body.innerHTML = msg.startsWith('NOT_REGISTERED')
      ? '<div class="center-screen"><div><h2>Not registered yet</h2><p>Signed in as <b>' + session.user.email + '</b>, but you\'re not in the Employees list.</p><p class="muted">Ask an Admin to add you, then sign in again.</p></div></div>'
      : msg.startsWith('INACTIVE')
        ? '<div class="center-screen"><div><h2>Account inactive</h2><p>Your record is marked Inactive. Contact an Admin.</p></div></div>'
        : '<div class="center-screen"><div><h2>Something went wrong</h2><p class="muted">' + msg + '</p></div></div>';
    return null;
  }

  return employee;
}

export function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toast(targetId, text, isError) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = '<div class="msg ' + (isError ? 'error' : 'ok') + '">' + esc(text) + '</div>';
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}
