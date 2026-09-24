// Shared header/nav for every page on this site, styled by css/styles.css's
// header{}/nav{}/nav a{} rules -- same structure as the main ERP's shell.js
// (colored header bar, pill-shaped nav links below), just this site's own pastel
// blue palette and 4-page link set instead of the ERP's full nav.
import { esc } from './shell.js?v=20260923h';
import { signOut } from './auth.js?v=20260923h';
import { initActivityFeed } from './activityFeed.js?v=20260923h';
import { showBirthdayBanner } from './birthdayBanner.js?v=20260923h';

// Where a clicked activity notification opens its record (spec 321) -- keyed by the
// event's record_table. Pages this app doesn't have link across to the ERP.
const ERP = 'https://renjnt-cpu.github.io/kittymae-inventory-system/';
const ACTIVITY_LINKS = {
  pos_sale: 'branches.html?tab=pos&open=',
  layaway_holds: 'branches.html?tab=layaway&open=',
  scrap_entries: 'branches.html?tab=scrap&open=',
  subasta_items: 'branches.html?tab=subasta',
  pull_out_records: ERP + 'pull-out.html?open=',
  inventory_transfers: ERP + 'transfers.html?open=',
  inventory_transactions: 'movement.html',
  refunds: ERP + 'refunds.html?open=',
  products: 'products.html',
};

export function renderPosNav(employee, activeHref) {
  const links = [
    { href: 'index.html', label: 'Look Up a SKU' },
    { href: 'products.html', label: 'SKU Catalog' },
    { href: 'branches.html', label: 'Branches' },
    { href: 'movement.html', label: 'Record Movement' },
    { href: 'capital.html', label: 'Branch Capital' },
  ];
  const active = links.find((l) => l.href === activeHref);

  // Same app-shell markup/behavior as the ERP's shell.js (App Shell, P0) --
  // just a flat link list instead of grouped sections, since 5 items don't
  // benefit from grouping.
  const shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.innerHTML =
    '<div class="app-backdrop" id="app-backdrop"></div>' +
    '<aside class="app-sidebar" id="app-sidebar">' +
      '<div class="app-sidebar-brand">💍 Kittymae POS</div>' +
      '<nav class="app-nav">' +
        '<div class="app-nav-group">' +
          links.map((l) => '<a href="' + l.href + '"' + (l.href === activeHref ? ' class="active"' : '') + '>' + l.label + '</a>').join('') +
        '</div>' +
      '</nav>' +
    '</aside>' +
    '<div class="app-main-col">' +
      '<header class="app-header">' +
        '<button type="button" class="app-menu-btn" id="app-menu-btn" aria-label="Open menu">☰</button>' +
        '<div class="app-title-block">' +
          // Ren's spec section 159 -- POS's own nav is a flat 5-item list (no groups
          // worth having), so the breadcrumb's "section" is just the app itself.
          (active ? '<div class="app-breadcrumb">Kittymae POS <span class="app-breadcrumb-sep">/</span> ' + esc(active.label) + '</div>' : '') +
          '<h1 class="app-page-title">' + esc(active ? active.label : 'Kittymae POS') + '</h1>' +
        '</div>' +
        '<div class="who" id="pos-nav-who"></div>' +
      '</header>' +
    '</div>';

  const existingMain = document.querySelector('main');
  shell.querySelector('.app-main-col').appendChild(existingMain);
  document.body.prepend(shell);

  document.getElementById('pos-nav-who').innerHTML =
    '<a class="btn small secondary" href="https://renjnt-cpu.github.io/kittymae-inventory-system/dashboard.html">Switch to ERP ↗</a> ' +
    esc(employee.full_name) + ' · ' + esc(employee.role) +
    ' <button class="btn small secondary" id="pos-nav-signout">Sign out</button>';
  document.getElementById('pos-nav-signout').addEventListener('click', signOut);

  // Global Branch Activity feed (spec 303-332) -- same module as the ERP; async so a
  // slow first fetch never delays the page, and a failure never breaks it.
  initActivityFeed({ employee, headerEl: shell.querySelector('.app-header'), esc, links: ACTIVITY_LINKS })
    .then((feed) => { window.__kmActivity = feed; document.dispatchEvent(new Event('km-activity-ready')); })
    .catch(() => {});

  const closeDrawer = () => shell.classList.remove('sidebar-open');
  shell.querySelector('#app-menu-btn').addEventListener('click', () => shell.classList.toggle('sidebar-open'));
  shell.querySelector('#app-backdrop').addEventListener('click', closeDrawer);
  shell.querySelectorAll('.app-nav a').forEach((a) => a.addEventListener('click', closeDrawer));

  // Fire-and-forget -- never blocks page render, and fails silently on its own
  // (see birthdayBanner.js) if the check or storage isn't available.
  showBirthdayBanner();
}
