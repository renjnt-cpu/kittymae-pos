// Shared header/nav + the sign-in gate every page (except login.html) needs. No
// framework/build step, so this is plain DOM injection — called once at the top of each
// page's script, mirroring the old app's renderShell()/renderGate() split.
import { requireSession, linkEmployee, signOut, updateMyName } from './auth.js';

export async function initShell(activePage) {
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

  const pages = [
    { id: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
  ];
  if (['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || ['Sales Executive', 'Admin Assistant', 'Personal Assistant'].includes(employee.position)) {
    // Personal Assistant is view-only here -- branches.html has no add/edit RLS grant
    // for this position (no branch_id, not in POSITION_MANAGERS), so canAddHere()/
    // canWriteHere() already resolve to false for her; this just lets her find the page.
    pages.push({ id: 'branches', label: 'Branches', href: 'branches.html' });
  }
  pages.push(
    { id: 'products', label: 'SKU Catalog', href: 'products.html' },
    { id: 'movement', label: 'Record Movement', href: 'movement.html' },
    { id: 'transfers', label: 'Transfers', href: 'transfers.html' },
    { id: 'layaway', label: 'Layaway', href: 'layaway.html' },
    { id: 'bills', label: 'Bills', href: 'bills.html' },
  );
  // Refunds: anyone can request one, so it's not role-gated like the rest of this
  // block — refunds.html itself shows a simple request form to most people, and the
  // full approve/manage view only to has_refund_approval_access() accounts.
  pages.push({ id: 'refunds', label: 'Refunds', href: 'refunds.html' });
  if (['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || employee.position === 'Admin Assistant' || (employee.extra_page_access || []).includes('transactions')) {
    // Transactions doesn't fit the per-branch model (a different process, per Ren) —
    // flat company-wide log. Admin/Manager run CSV imports and manage everything;
    // Branch Supervisor, Admin Assistant, and anyone with extra_page_access
    // 'transactions' (e.g. Jessica) get in too, but transactions.html only lets them
    // fill in FB Name/Customer/Order ID, not import or delete.
    pages.push({ id: 'transactions', label: 'Transactions', href: 'transactions.html' });
  }
  if (['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || ['Personal Assistant', 'Admin Assistant'].includes(employee.position) || (employee.extra_page_access || []).includes('assets')) {
    pages.push({ id: 'assets', label: 'Asset & Supplies Custodian', href: 'assets.html' });
  }
  if (['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || employee.position === 'Admin Assistant' || (employee.extra_page_access || []).includes('lbc')) {
    // COD parcels shipped via LBC for online orders -- company-wide, not per-branch.
    pages.push({ id: 'lbc', label: 'LBC Monitoring', href: 'lbc.html' });
  }
  // Branch Capital: restricted to Manager, Branch Supervisor, and Personal Assistant
  // (plus Admin) -- Sales Executive, Admin Assistant, and rank-and-file employees no
  // longer get in at all (70_branch_capital_restricted_access.sql). Only Admin can
  // approve or delete an entry now.
  if (['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || employee.position === 'Personal Assistant') {
    pages.push({ id: 'capital', label: 'Branch Capital', href: 'capital.html' });
  }
  if (employee.role === 'Admin') {
    pages.push({ id: 'access-checklist', label: 'Access Checklist', href: 'access-checklist.html' });
  }

  // 2-month cooldown between name changes (mirrors update_my_name()'s own server-side
  // check — this is just so the button doesn't invite a click that's just going to be
  // rejected).
  let nameEditLocked = false, nameEditUnlockDate = null;
  if (employee.name_changed_at) {
    const unlock = new Date(employee.name_changed_at);
    unlock.setMonth(unlock.getMonth() + 2);
    if (unlock > new Date()) { nameEditLocked = true; nameEditUnlockDate = unlock; }
  }

  const header = document.createElement('header');
  header.innerHTML = '<h1>💎 Kittymae Jewels System</h1>' +
    '<div class="who">' +
      '<span id="who-display">' + esc(employee.full_name) + ' · ' + esc(employee.role) +
        (employee.branch_id ? ' · Branch #' + employee.branch_id : ' · All Branches') +
      '</span>' +
      (nameEditLocked
        ? ' <span class="muted" style="font-size:11px;">(can rename ' + nameEditUnlockDate.toISOString().slice(0, 10) + ')</span>'
        : ' <button class="btn small secondary" id="edit-name-btn">Edit Name</button>') +
      ' <button class="btn small secondary" id="signout-btn">Sign out</button>' +
    '</div>';

  const nav = document.createElement('nav');
  nav.innerHTML = pages.map((p) =>
    '<a href="' + p.href + '"' + (p.id === activePage ? ' class="active"' : '') + '>' + p.label + '</a>'
  ).join('');

  document.body.prepend(nav);
  document.body.prepend(header);
  header.querySelector('#signout-btn').addEventListener('click', signOut);

  const whoEl = header.querySelector('.who');
  if (header.querySelector('#edit-name-btn')) header.querySelector('#edit-name-btn').addEventListener('click', () => {
    const display = header.querySelector('#who-display');
    const editBtn = header.querySelector('#edit-name-btn');
    display.style.display = 'none';
    editBtn.style.display = 'none';
    const form = document.createElement('span');
    form.innerHTML =
      '<input type="text" id="edit-name-input" value="' + esc(employee.full_name) + '" style="padding:4px 6px;border-radius:4px;border:1px solid #ccc;font-size:12px;width:140px;">' +
      ' <button class="btn small" id="edit-name-save">Save</button>' +
      ' <button class="btn small secondary" id="edit-name-cancel">Cancel</button>';
    whoEl.insertBefore(form, editBtn);

    const cleanup = () => { form.remove(); display.style.display = ''; editBtn.style.display = ''; };
    form.querySelector('#edit-name-cancel').addEventListener('click', cleanup);
    form.querySelector('#edit-name-save').addEventListener('click', async () => {
      const newName = form.querySelector('#edit-name-input').value.trim();
      if (!newName) return;
      try {
        await updateMyName(newName);
        employee.full_name = newName;
        display.textContent = newName + ' · ' + employee.role + (employee.branch_id ? ' · Branch #' + employee.branch_id : ' · All Branches');
        // Locked for the next 2 months now — replace the button with that note instead
        // of restoring it, so the header matches what a fresh page load would show.
        const unlock = new Date();
        unlock.setMonth(unlock.getMonth() + 2);
        const lockedNote = document.createElement('span');
        lockedNote.className = 'muted';
        lockedNote.style.fontSize = '11px';
        lockedNote.textContent = '(can rename ' + unlock.toISOString().slice(0, 10) + ')';
        editBtn.replaceWith(lockedNote);
        form.remove();
        display.style.display = '';
      } catch (err) {
        alert(String(err.message || err));
      }
    });
  });

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
