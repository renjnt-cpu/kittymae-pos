// Shared header/nav for every page on this site, styled by css/styles.css's
// header{}/nav{}/nav a{} rules -- same structure as the main ERP's shell.js
// (colored header bar, pill-shaped nav links below), just this site's own pastel
// blue palette and 4-page link set instead of the ERP's full nav.
import { esc } from './shell.js';
import { signOut } from './auth.js';

export function renderPosNav(employee, activeHref) {
  const links = [
    { href: 'index.html', label: 'Look Up a SKU' },
    { href: 'products.html', label: 'SKU Catalog' },
    { href: 'movement.html', label: 'Record Movement' },
    { href: 'layaway.html', label: 'Layaway' },
  ];

  const header = document.createElement('header');
  header.innerHTML = '<h1>💍 Kittymae POS</h1>' +
    '<div class="who">' +
      '<span id="pos-nav-who"></span>' +
    '</div>';

  const nav = document.createElement('nav');
  nav.innerHTML = links.map((l) =>
    '<a href="' + l.href + '"' + (l.href === activeHref ? ' class="active"' : '') + '>' + l.label + '</a>'
  ).join('');

  document.body.prepend(nav);
  document.body.prepend(header);

  document.getElementById('pos-nav-who').innerHTML =
    esc(employee.full_name) + ' · ' + esc(employee.role) +
    ' <button class="btn small secondary" id="pos-nav-signout">Sign out</button>';
  document.getElementById('pos-nav-signout').addEventListener('click', signOut);
}
