// Branch Capital page (Ren, 2026-10-14): the upgraded module. Branch Capital used to be only "money put into a branch"; it is now the daily money control of each branch:
//   Today (attention list, cards, cash position, timeline) · Expenses (paid from daily sales / branch capital / petty cash / bank / e-wallet / split, receipts, approvals, bills, transportation) ·
//   Petty Cash (funds, replenishment, advances, ledger) · Daily Cash (cash book, deposits, count and close the day) · Reports · Settings · Capital Entries (the original page, unchanged).
// The database side is migrations 226-230 (closed tables bc_*, petty ledger, audit log). Gross sales are only ever read; an expense is its own cash-out entry.
import { esc } from './shell.js?v=20261018c';
import { getBranches } from './api.js?v=20261018c';
import { bcContext, bcPettyOverview } from './bcApi.js?v=20261018c';
import { startToday } from './bcToday.js?v=20261018c';
import { startExpenses, openExpenseDrawer, openExpenseForm } from './bcExpenses.js?v=20261018c';
import { startPetty } from './bcPetty.js?v=20261018c';
import { startCash } from './bcCash.js?v=20261018c';
import { startReports } from './bcReports.js?v=20261018c';
import { startSettings } from './bcSettings.js?v=20261018c';
import { startEntries, legacyAccess } from './bcLegacy.js?v=20261018c';
import { addDays } from './bcFormat.js?v=20261018c';

const store = {
  get(k) { try { return sessionStorage.getItem('bc.' + k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem('bc.' + k, v); } catch (e) { /* private window */ } },
};

export async function startBranchCapital({ employee }) {
  const root = document.getElementById('capital-root');
  let ctx = null;
  try { ctx = await bcContext(); } catch (err) { ctx = { ok: false, error: String(err.message || err) }; }
  const legacy = legacyAccess(employee);
  if (!ctx.ok && !legacy) {
    root.innerHTML = '<div class="center-screen"><div><h2>No access</h2><p class="muted">' + esc(ctx.error || 'Branch Capital is limited to Manager, Branch Supervisor, Personal Assistant and Admin.') + '</p></div></div>';
    return;
  }

  const branchList = await getBranches().catch(() => (ctx.branches || []));
  const branches = ctx.ok ? ctx.branches.filter((b) => b.is_active !== false) : [];
  const state = { branch: 'all', date: ctx.ok ? ctx.today : '', tab: 'today' };
  if (ctx.ok) {
    // the branch to start on: the only one the person can see, else the one they chose last time, else their own branch (a person who can see every branch starts on "All branches")
    const saved = store.get('branch');
    if (branches.length === 1) state.branch = branches[0].id;
    else if (saved && saved !== 'all' && branches.some((b) => String(b.id) === saved)) state.branch = Number(saved);
    else if (saved === 'all') state.branch = 'all';
    else if (!ctx.can.view_all && ctx.me.branch_id && branches.some((b) => b.id === ctx.me.branch_id)) state.branch = ctx.me.branch_id;
  }

  const TABS = [
    ['today', 'Today', ctx.ok],
    ['expenses', 'Expenses', ctx.ok],
    ['petty', 'Petty Cash', ctx.ok && ctx.can.view_petty],
    ['cash', 'Daily Cash', ctx.ok],
    ['reports', 'Reports', ctx.ok && ctx.can.view_reports],
    ['settings', 'Settings', ctx.ok && ctx.can.manage],
    ['entries', 'Capital Entries', legacy],
  ].filter((t) => t[2]);
  const NO_TOOLBAR = ['entries', 'settings'];
  const NO_DATE = ['expenses', 'petty', 'reports'];

  root.innerHTML =
    '<div id="bc-msg"></div>' +
    '<div class="card bc-topbar" id="bc-top"' + (ctx.ok ? '' : ' hidden') + '>' +
      '<div class="field"><label for="bc-branch">Branch</label><select id="bc-branch">' +
        (branches.length > 1 ? '<option value="all">All branches</option>' : '') + branches.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
      '<div class="field" id="bc-date-f"><label for="bc-date">Day</label><div class="bc-datebox"><button type="button" class="btn small secondary" id="bc-prev" aria-label="Previous day">‹</button>' +
        '<input type="date" id="bc-date" max="' + esc(ctx.today || '') + '" value="' + esc(state.date) + '"><button type="button" class="btn small secondary" id="bc-next" aria-label="Next day">›</button>' +
        '<button type="button" class="btn small secondary" id="bc-today">Today</button></div></div>' +
      '<span class="bc-grow"></span><button type="button" class="btn small secondary" id="bc-refresh">Refresh</button></div>' +
    '<div class="bc-tabs" role="tablist">' + TABS.map(([k, l]) => '<button type="button" class="btn small secondary" role="tab" data-tab="' + k + '">' + esc(l) + '</button>').join('') + '</div>' +
    TABS.map(([k]) => '<div class="bc-pane" id="bc-pane-' + k + '" hidden></div>').join('');

  const $ = (id) => root.querySelector('#' + id);
  const panes = Object.fromEntries(TABS.map(([k]) => [k, root.querySelector('#bc-pane-' + k)]));
  const mods = {};
  const stale = {};
  const fundCache = new Map();

  const app = {
    employee, ctx, can: ctx.ok ? ctx.can : {}, branches, branchList, state,
    branchName: (id) => (branchList.find((b) => b.id === id) || branches.find((b) => b.id === id) || {}).name || ('Branch #' + id),
    root: (tab) => panes[tab],
    funds(branchId) {
      if (!fundCache.has(branchId)) fundCache.set(branchId, bcPettyOverview(branchId).then((r) => (r.funds || []).filter((f) => f.status === 'Active')).catch(() => []));
      return fundCache.get(branchId);
    },
    invalidateFunds() { fundCache.clear(); },
    setBranch(id) {
      state.branch = id;
      $('bc-branch').value = String(id);
      store.set('branch', String(id));
      markAllStale();
      refreshCurrent();
    },
    go(tab, opts = {}) {
      if (opts.branch && state.branch !== opts.branch) { state.branch = opts.branch; $('bc-branch').value = String(opts.branch); store.set('branch', String(opts.branch)); markAllStale(); }
      if (opts.date) { state.date = opts.date; $('bc-date').value = opts.date; markAllStale(); }
      show(tab, opts);
    },
    openExpense(id) { openExpenseDrawer(app, id, { onChange: () => app.refreshAll() }); },
    newExpense(opts) { return openExpenseForm(app, opts); },
    refreshAll() { markAllStale(); refreshCurrent(); },
    refreshOthers() { Object.keys(mods).forEach((k) => { if (k !== state.tab) stale[k] = true; }); },
  };

  function markAllStale() { TABS.forEach(([k]) => { stale[k] = true; }); }
  function refreshCurrent() {
    const m = mods[state.tab];
    if (m) { stale[state.tab] = false; m.refresh(); }
  }

  const factories = {
    today: () => startToday(app), expenses: () => startExpenses(app), petty: () => startPetty(app), cash: () => startCash(app),
    reports: () => startReports(app), settings: () => startSettings(app),
    entries: () => startEntries({ employee, root: panes.entries, getBranches: async () => branchList }),
  };

  function show(tab, opts) {
    if (!panes[tab]) tab = TABS[0][0];
    state.tab = tab;
    store.set('tab', tab);
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== tab;
    root.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('secondary', b.dataset.tab !== tab); b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
    if (ctx.ok) {
      $('bc-top').hidden = NO_TOOLBAR.includes(tab);
      $('bc-date-f').hidden = NO_DATE.includes(tab);
    }
    try { const u = new URL(location.href); u.searchParams.set('tab', tab); history.replaceState(null, '', u.pathname + u.search); } catch (e) { /* harmless */ }
    if (!mods[tab]) { mods[tab] = factories[tab](); stale[tab] = false; mods[tab].onShow(opts); return; }
    if (stale[tab] || (opts && Object.keys(opts).length)) { stale[tab] = false; mods[tab].onShow(opts); }
  }

  root.querySelector('.bc-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });

  if (ctx.ok) {
    const sel = $('bc-branch');
    sel.value = String(state.branch);
    sel.addEventListener('change', () => { state.branch = sel.value === 'all' ? 'all' : Number(sel.value); store.set('branch', sel.value); markAllStale(); refreshCurrent(); });
    const dateEl = $('bc-date');
    const setDate = (d) => { if (!d || d > ctx.today) d = ctx.today; state.date = d; dateEl.value = d; markAllStale(); refreshCurrent(); };
    dateEl.addEventListener('change', () => setDate(dateEl.value));
    $('bc-prev').addEventListener('click', () => setDate(addDays(state.date, -1)));
    $('bc-next').addEventListener('click', () => setDate(addDays(state.date, 1)));
    $('bc-today').addEventListener('click', () => setDate(ctx.today));
    $('bc-refresh').addEventListener('click', () => { app.invalidateFunds(); app.refreshAll(); });
  }

  const q = new URLSearchParams(location.search);
  const first = TABS.some((t) => t[0] === q.get('tab')) ? q.get('tab') : (TABS.some((t) => t[0] === store.get('tab')) ? store.get('tab') : TABS[0][0]);
  if (ctx.ok && q.get('branch') && branches.some((b) => String(b.id) === q.get('branch'))) { state.branch = Number(q.get('branch')); $('bc-branch').value = q.get('branch'); }
  show(first);
  if (ctx.ok && Number(q.get('e'))) app.openExpense(Number(q.get('e')));
  window.__kmBc = app;   // handy for support / automated checks
  return app;
}
