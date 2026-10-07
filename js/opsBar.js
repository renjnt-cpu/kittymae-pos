// The sticky operations bar at the top of POS -> Branches (Ren's second Branches spec, 2026-10-07). The page is a working desk, so the
// controls come first and in this order: Branch -> Search -> Date -> the four modules (POS Walk In & COD / Layaway / Scrap / Subasta)
// -> one main action button that follows the module ("+ New Sale", "+ New Layaway", ...). It owns no data: it tells the page what was
// chosen (branch, search text for the module on show, date range, module, action) and the page does the rest. Search is remembered per
// module, so what was typed for Layaway never filters Scrap.
import { RANGE_PRESETS } from './opsDates.js?v=20261007w';
import { branchButtonStyle } from './branchColors.js?v=20261007w';
import { loadPrefs, savedRange, resolveRange, saveRange } from './opsPrefs.js?v=20261007w';

/** Options: root (empty container), esc, branches (all active -- for colours), visibleBranches (what this person may see), getBranchId(),
 * onBranch(id), tabs [{ key, label, dot, placeholder }], getTab(), onTab(key), tabInfo(key) -> { count, urgent: { text, tone } | null },
 * actionInfo(key) -> { label, disabled }, onAction(key), onSearch(key, text), onRange(range), onGlobalSearch(text) (optional: adds a "Search all" button that
 * looks in every module at once). Returns the methods below. */
export function initOpsBar({ root, esc, branches, visibleBranches, getBranchId, onBranch, tabs, getTab, onTab, tabInfo, actionInfo, onAction, onSearch, onRange, onGlobalSearch }) {
  const saved = savedRange(loadPrefs());
  const state = { preset: saved.preset, custom: saved.custom };
  const searchByTab = {};
  const currentRange = () => resolveRange(state.preset, state.custom);

  root.innerHTML =
    '<div class="ops-bar" id="ops-bar">' +
      '<div class="ops-bar-branches" id="ops-bar-branches" role="group" aria-label="Branch"></div>' +
      '<div class="ops-bar-find">' +
        '<label class="ops-search"><span class="sr-only">Search</span><input type="search" id="ops-bar-search" placeholder="Search customer, order, SKU, item, reference…" autocomplete="off" enterkeyhint="search"></label>' +
        (onGlobalSearch ? '<button type="button" class="btn small secondary ops-bar-global" id="ops-bar-global" title="Search sales, layaways, scrap and Subasta together" aria-label="Search all modules">' +
          '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
          '<span class="ops-gs-text"> Search all</span></button>' : '') +
        '<div class="ops-bar-dates">' +
          '<div class="ops-seg ops-bar-presets" id="ops-bar-presets" role="group" aria-label="Date range">' +
            RANGE_PRESETS.map((p) => '<button type="button" data-preset="' + p.key + '">' + p.label + '</button>').join('') + '</div>' +
          '<select id="ops-bar-preset-select" class="ops-bar-preset-select" aria-label="Date range">' +
            RANGE_PRESETS.map((p) => '<option value="' + p.key + '">' + p.label + '</option>').join('') + '</select>' +
          '<span class="ops-bar-custom" id="ops-bar-custom" hidden><input type="date" id="ops-bar-from" aria-label="From"><span>–</span><input type="date" id="ops-bar-to" aria-label="To"></span>' +
          '<span class="ops-bar-label" id="ops-bar-label" role="status"></span>' +
        '</div>' +
      '</div>' +
      '<div class="ops-bar-modules">' +
        '<div class="ops-bar-tabs" id="scrap-sub-tabs" role="tablist" aria-label="Module"></div>' +
        '<button type="button" class="btn ops-bar-action" id="ops-bar-action">+ New</button>' +
      '</div>' +
    '</div>';

  const $ = (id) => root.querySelector('#' + id);
  const searchEl = $('ops-bar-search');

  // ---- branch ----
  function renderBranches() {
    const box = $('ops-bar-branches');
    // Only the branches this employee may see (viewable_branch_ids(): own branch + any assigned ones, or everything for company-wide roles).
    box.innerHTML = visibleBranches.map((b) =>
      '<button type="button" class="btn" style="' + branchButtonStyle(b.id, branches, b.id === getBranchId()) + '" data-id="' + b.id + '" aria-pressed="' + (b.id === getBranchId()) + '">' + esc(b.name) + '</button>').join('');
    box.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => onBranch(Number(btn.dataset.id))));
  }

  // ---- module tabs (with their count and the red / amber badge for what needs action) ----
  function renderTabs() {
    const box = $('scrap-sub-tabs');
    box.innerHTML = tabs.map((t) => {
      const info = tabInfo(t.key) || {};
      const on = getTab() === t.key;
      return '<button type="button" role="tab" class="ops-tab' + (on ? ' active' : '') + '" data-tab="' + t.key + '" aria-selected="' + on + '">' +
        '<span class="ops-tab-dot" style="background:' + t.dot + ';"></span><span class="ops-tab-full">' + esc(t.label) + '</span><span class="ops-tab-short">' + esc(t.short || t.label) + '</span>' +
        '<span class="ops-tab-n">' + (info.count == null ? 0 : info.count) + '</span>' +
        (info.urgent ? '<span class="tab-urgent tone-' + info.urgent.tone + '">' + esc(info.urgent.text) + '</span>' : '') +
      '</button>';
    }).join('');
    box.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => onTab(btn.dataset.tab)));
    const tab = tabs.find((t) => t.key === getTab());
    if (tab && tab.placeholder) searchEl.placeholder = tab.placeholder;
  }

  // ---- the main action button follows the module on show ----
  function renderAction() {
    const info = actionInfo(getTab()) || {};
    const btn = $('ops-bar-action');
    btn.innerHTML = '<span class="ops-act-full">' + esc(info.label || '+ New') + '</span><span class="ops-act-short">+ New</span>';
    btn.disabled = !!info.disabled;
    btn.title = info.disabled ? 'You can only add records for your own branch.' : '';
  }
  $('ops-bar-action').addEventListener('click', () => onAction(getTab()));

  // ---- search (remembered per module) ----
  let searchTimer = null;
  const pushSearch = () => { searchByTab[getTab()] = searchEl.value; onSearch(getTab(), searchEl.value.trim()); };
  searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(pushSearch, 150); });
  searchEl.addEventListener('search', () => { clearTimeout(searchTimer); pushSearch(); }); // the browser's own clear (x) button
  /** Show the search text of the module now on show. */
  function syncSearch() { searchEl.value = searchByTab[getTab()] || ''; }

  if (onGlobalSearch) $('ops-bar-global').addEventListener('click', () => onGlobalSearch(searchEl.value.trim()));

  // ---- date ----
  function renderDates() {
    const r = currentRange();
    root.querySelectorAll('#ops-bar-presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
    $('ops-bar-preset-select').value = state.preset;
    $('ops-bar-custom').hidden = state.preset !== 'custom';
    $('ops-bar-from').value = state.custom.from || ''; $('ops-bar-to').value = state.custom.to || '';
    $('ops-bar-label').textContent = r.label;
  }
  function setPreset(key) {
    if (key === 'custom' && !(state.custom.from && state.custom.to)) {
      const t = resolveRange('today');
      state.custom = { from: t.from, to: t.to };
    }
    state.preset = key;
    saveRange(state.preset, state.custom);
    renderDates();
    onRange(currentRange());
  }
  root.querySelectorAll('#ops-bar-presets button').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
  $('ops-bar-preset-select').addEventListener('change', (ev) => setPreset(ev.target.value));
  const onCustom = () => {
    const from = $('ops-bar-from').value, to = $('ops-bar-to').value;
    if (!from || !to) return;
    state.custom = from <= to ? { from, to } : { from: to, to: from };
    saveRange(state.preset, state.custom);
    renderDates();
    onRange(currentRange());
  };
  $('ops-bar-from').addEventListener('change', onCustom);
  $('ops-bar-to').addEventListener('change', onCustom);

  renderBranches(); renderTabs(); renderAction(); renderDates(); syncSearch();
  return { renderBranches, renderTabs, renderAction, renderDates, syncSearch, setPreset, getRange: currentRange, getSearch: (key) => (searchByTab[key] || '').trim() };
}
