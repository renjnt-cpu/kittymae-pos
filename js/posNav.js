// Shared minimal header for this site's non-index pages (SKU Catalog, Record
// Movement). initShell() still builds the full ERP nav (Bills/Refunds/Transfers/etc.)
// since it doesn't know this is a pared-down site -- those pages don't exist here, so
// that nav is stripped and replaced with just the 3 pages this site actually has,
// same pattern index.html (the old pos.html) already used for itself.
import { esc } from './shell.js';
import { signOut } from './auth.js';

export function renderPosNav(employee, activeHref) {
  document.querySelector('body > header')?.remove();
  document.querySelector('body > nav')?.remove();

  const links = [
    { href: 'index.html', label: 'Look Up / Record' },
    { href: 'products.html', label: 'SKU Catalog' },
    { href: 'movement.html', label: 'Record Movement' },
    { href: 'layaway.html', label: 'Layaway' },
  ];
  const nav = document.createElement('header');
  nav.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#fff;border-bottom:1px solid #eee;margin-bottom:16px;';
  nav.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<span style="font-weight:bold;">💍 Kittymae POS</span>' +
      links.map((l) => '<a href="' + l.href + '" class="btn small' + (l.href === activeHref ? '' : ' secondary') + '">' + l.label + '</a>').join('') +
    '</div>' +
    '<div id="pos-nav-who" class="muted" style="font-size:13px;"></div>';
  document.body.insertBefore(nav, document.body.firstChild);

  document.getElementById('pos-nav-who').innerHTML =
    esc(employee.full_name) + ' · ' + esc(employee.role) +
    ' <button class="btn small secondary" id="pos-nav-signout">Sign out</button>';
  document.getElementById('pos-nav-signout').addEventListener('click', signOut);
}
