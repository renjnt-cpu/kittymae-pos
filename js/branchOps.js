// Branch Operations Summary -- the section the Branches page opens with (Ren, 2026-10-07):
// one global date range, ten summary cards, a per-branch comparison and a "Needs Attention"
// list, all fed by two server reports (branch_ops_summary / branch_ops_attention, migration
// 166) so the numbers never depend on how many rows a tab happened to load. The tabs below
// keep their own search/filters; this module owns only the date range (pushed to them
// through onRangeChange) and the at-a-glance picture. Layaway deadlines/overdue and pending
// approvals deliberately ignore the date range -- they describe what needs action today.
import { getBranchOpsSummary, getBranchOpsAttention, subscribeToChanges } from './api.js?v=20261007i';
import { RANGE_PRESETS, rangeFor, describeRange } from './opsDates.js?v=20261007i';

const STORE_KEY = 'km-branch-ops-v1';

const money = (n) => {
  n = Number(n || 0);
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};
const num = (n) => Number(n || 0).toLocaleString('en-PH');
const grams = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) + ' g';
const plural = (n, one, many) => num(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));

/** Sums numeric leaves of `src` into `target`, recursing into nested objects (by_method,
 * by_karat ...) -- used to roll several branches' rows into one "All Allowed Branches" row. */
function deepSum(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v === 'number') target[k] = (target[k] || 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) deepSum(target[k] = target[k] || {}, v);
  }
  return target;
}
function aggregate(rows) {
  const a = {};
  rows.forEach((r) => ['pos', 'layaway', 'scrap', 'subasta', 'received', 'pending'].forEach((sec) => deepSum(a[sec] = a[sec] || {}, r[sec])));
  return a;
}
const transactionsOf = (r) => (r.pos?.transactions || 0) + (r.layaway?.payments || 0) + (r.scrap?.entries || 0) + (r.subasta?.sold || 0);
const hasActivity = (r) => !!(transactionsOf(r) || r.layaway?.on_hold_lines || r.subasta?.listed_now || r.pending?.total);

/** What each "Needs Attention" kind says, how urgent it is, and where clicking it goes
 * (tab + an optional view the tab can honor via applyView). Lowest `rank` first. */
export const ATTENTION_KINDS = {
  layaway_overdue:          { rank: 1, tone: 'bad',  tab: 'layaway', view: 'overdue',   text: (n, a) => plural(n, 'layaway item') + ' past the deadline' + (a ? ' — ' + money(a) + ' still owed' : '') },
  pending_layaway_deletion: { rank: 2, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'layaway deletion request') + ' awaiting approval' },
  pending_payment_deletion: { rank: 3, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'payment deletion request') + ' awaiting approval' },
  pending_item_change:      { rank: 4, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'item change request') + ' awaiting approval' },
  pending_forfeit_request:  { rank: 2, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n, a) => plural(n, 'forfeiture request') + ' awaiting approval' + (a ? ' — ' + money(a) + ' owed' : '') },
  pending_forfeit_date:     { rank: 5, tone: 'warn', tab: 'layaway', view: 'approvals', text: (n) => plural(n, 'forfeit date request') + ' awaiting approval' },
  reminders_due:            { rank: 5, tone: 'warn', tab: 'layaway', view: 'reminders', text: (n, a) => plural(n, 'customer') + ' due for a payment reminder' + (a ? ' — ' + money(a) + ' owed' : '') },
  layaway_nearing:          { rank: 6, tone: 'warn', tab: 'layaway', view: 'nearing',   text: (n, a) => plural(n, 'layaway item') + ' nearing the deadline' + (a ? ' — ' + money(a) + ' still owed' : '') },
  cod_pending:              { rank: 7, tone: 'warn', tab: 'pos',     view: 'cod',       text: (n, a) => plural(n, 'COD sale') + ' waiting to be collected' + (a ? ' — ' + money(a) : '') },
  zero_amount_sale:         { rank: 8, tone: 'warn', tab: 'pos',     view: 'zero',      text: (n) => plural(n, 'sale') + ' with a ₱0 line item to fix' },
  pickup_pending:           { rank: 9, tone: 'info', tab: 'pos',     view: 'pickup',    text: (n) => plural(n, 'sale') + ' waiting for pickup' },
  layaway_lacking:          { rank: 10, tone: 'info', tab: 'layaway', view: 'lacking',  text: (n) => plural(n, 'layaway item') + ' waiting for stock' },
};

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* private window / blocked storage: preference just isn't remembered */ }
}
/** The remembered range choice, validated: an unknown preset or an incomplete custom range
 * falls back to Today. The one place both the host page and the summary read it from. */
function savedRange(prefs) {
  let preset = RANGE_PRESETS.some((p) => p.key === prefs.preset) ? prefs.preset : 'today';
  const custom = prefs.custom && prefs.custom.from && prefs.custom.to ? prefs.custom : { from: '', to: '' };
  if (preset === 'custom' && !(custom.from && custom.to)) preset = 'today';
  return { preset, custom };
}
/** The range the Branches page should start with (before the summary has mounted), so the
 * tabs' very first render already uses it. */
export function getInitialRange() {
  const { preset, custom } = savedRange(loadPrefs());
  const r = rangeFor(preset, custom);
  return { preset, from: r.from, to: r.to, label: describeRange(preset, r) };
}

/** Mounts the summary into `root`. Options:
 *  esc, branches (all active branches), visibleBranchIds (what this employee may see),
 *  getBranchId() -> selected branch id, selectBranch(id), showTab(tab, view),
 *  onRangeChange({preset, from, to, label}) -- called once at start and on every change,
 *  onData() -- called after new attention data arrives (tab pills re-render their badges).
 * Returns { refresh, setBranch, getRange, getUrgent }. Never throws into the host page. */
export function initBranchOps({ root, esc, branches, visibleBranchIds, getBranchId, selectBranch, showTab, onRangeChange, onData, onOpenSettings }) {
  const prefs = loadPrefs();
  const multi = visibleBranchIds.length > 1;
  const saved = savedRange(prefs);
  const state = {
    preset: saved.preset, custom: saved.custom,
    scope: multi && prefs.scope === 'all' ? 'all' : 'current',
    summary: null, attention: [], error: null, loading: false,
  };

  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  const currentRange = () => {
    const r = rangeFor(state.preset, state.custom);
    return { preset: state.preset, from: r.from, to: r.to, label: describeRange(state.preset, r) };
  };

  root.innerHTML =
    '<section class="card ops-wrap" aria-label="Branch Operations Summary">' +
      '<div class="ops-head">' +
        '<div><h2 class="ops-title">Branch Operations Summary</h2><div class="muted" id="ops-sub" role="status"></div></div>' +
        '<div class="ops-controls">' +
          (multi ? '<div class="ops-seg" role="group" aria-label="Branch scope" id="ops-scope">' +
            '<button type="button" data-scope="current">Current Branch</button><button type="button" data-scope="all">All Allowed Branches</button></div>' : '') +
          (onOpenSettings ? '<button type="button" class="btn small secondary" id="ops-settings-btn" title="Layaway deadline, reminders and branch visibility">⚙ Settings</button>' : '') +
          '<div class="ops-seg" role="group" aria-label="Date range" id="ops-presets">' +
            RANGE_PRESETS.map((p) => '<button type="button" data-preset="' + p.key + '">' + p.label + '</button>').join('') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ops-custom" id="ops-custom" hidden>' +
        '<div class="field"><label for="ops-from">From</label><input type="date" id="ops-from"></div>' +
        '<div class="field"><label for="ops-to">To</label><input type="date" id="ops-to"></div>' +
      '</div>' +
      '<div class="ops-cards" id="ops-cards" aria-live="polite"></div>' +
      '<details class="exp ops-compare" id="ops-compare-wrap" open><summary><span class="exp-arrow" aria-hidden="true">▸</span>Branch comparison <span class="exp-count" id="ops-compare-count"></span></summary>' +
        '<div class="exp-body" id="ops-compare"></div></details>' +
      '<div id="ops-attention"></div>' +
    '</section>';

  const $ = (id) => root.querySelector('#' + id);
  $('ops-from').value = state.custom.from || '';
  $('ops-to').value = state.custom.to || '';

  function persist() { savePrefs({ preset: state.preset, custom: state.custom, scope: state.scope }); }

  // ---- data scoping ----
  function visibleRows() { return ((state.summary && state.summary.branches) || []).filter((r) => r.is_active || hasActivity(r)); }
  function scopedRows() {
    const rows = visibleRows();
    return state.scope === 'all' ? rows : rows.filter((r) => r.branch_id === getBranchId());
  }
  function scopedAttention() {
    return state.scope === 'all' ? state.attention : state.attention.filter((a) => a.branch_id === getBranchId());
  }

  // ---- rendering ----
  function renderControls() {
    root.querySelectorAll('#ops-presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
    root.querySelectorAll('#ops-scope button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === state.scope)));
    $('ops-custom').hidden = state.preset !== 'custom';
    const where = state.scope === 'all' ? 'All allowed branches' : branchName(getBranchId());
    $('ops-sub').textContent = where + ' · ' + currentRange().label + (state.loading ? ' · updating…' : '');
  }

  function card({ label, value, sub, tab, view, tone, tag, extra }) {
    return '<button type="button" class="ops-card' + (tone ? ' tone-' + tone : '') + '" data-tab="' + tab + '"' + (view ? ' data-view="' + view + '"' : '') + '>' +
      '<span class="ops-card-lbl"><span>' + label + '</span>' + (tag ? '<span class="ops-tag">' + tag + '</span>' : '') + '</span>' +
      '<span class="ops-card-num">' + value + '</span>' +
      (sub ? '<span class="ops-card-sub">' + sub + '</span>' : '') +
      (extra || '') +
    '</button>';
  }

  function renderCards() {
    const box = $('ops-cards');
    if (state.error) {
      box.innerHTML = '<div class="msg error" style="grid-column:1/-1;margin:0;">Could not load the summary: ' + esc(state.error) +
        ' <button type="button" class="btn small secondary" id="ops-retry">Try again</button></div>';
      const retry = box.querySelector('#ops-retry'); if (retry) retry.addEventListener('click', refresh);
      return;
    }
    if (!state.summary) { box.innerHTML = '<div class="muted" style="grid-column:1/-1;">Loading…</div>'; return; }
    const a = aggregate(scopedRows());
    const pos = a.pos || {}, lay = a.layaway || {}, scr = a.scrap || {}, sub = a.subasta || {}, rec = a.received || {}, pen = a.pending || {};
    const avgSale = pos.transactions ? pos.net / pos.transactions : 0;
    const avgGram = scr.grams ? scr.purchased / scr.grams : 0;
    const topMethods = Object.entries(rec.by_method || {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([m, v]) => esc(m) + ' ' + money(v)).join(' · ');
    const penParts = [['forfeit_date', 'forfeit date'], ['item_change', 'item change'], ['payment_deletion', 'payment deletion'], ['layaway_deletion', 'layaway deletion']]
      .filter(([k]) => pen[k]).map(([k, l]) => num(pen[k]) + ' ' + l);
    box.innerHTML = [
      card({ label: 'POS Sales', value: money(pos.net), sub: plural(pos.items || 0, 'item') + ' sold', tab: 'pos' }),
      card({ label: 'POS Transactions', value: num(pos.transactions), sub: pos.transactions ? 'avg ' + money(avgSale) + ' per sale' : 'no sales in this range', tab: 'pos' }),
      card({ label: 'Layaway On Hold', value: num(lay.on_hold_lines), tag: 'right now', tab: 'layaway', tone: lay.overdue_lines ? 'bad' : '',
        sub: money(lay.on_hold_balance) + ' still owed · ' + plural(lay.on_hold_orders || 0, 'order'),
        extra: lay.overdue_lines ? '<span class="ops-flag">' + plural(lay.overdue_lines, 'item') + ' overdue</span>' : (lay.nearing_lines ? '<span class="ops-flag warn">' + num(lay.nearing_lines) + ' nearing the deadline</span>' : '') }),
      card({ label: 'Layaway Payments Received', value: money(lay.collected), sub: plural(lay.payments || 0, 'payment'), tab: 'layaway' }),
      card({ label: 'Scrap Purchased', value: money(scr.purchased), sub: plural(scr.entries || 0, 'entry', 'entries'), tab: 'scrap' }),
      card({ label: 'Scrap Grams', value: grams(scr.grams), sub: scr.grams ? 'avg ' + money(avgGram) + ' per gram' : 'none bought in this range', tab: 'scrap' }),
      card({ label: 'Subasta Listed', value: num(sub.listed_now), tag: 'right now', sub: num(sub.pending_now) + ' pending', tab: 'subasta' }),
      card({ label: 'Subasta Sold', value: num(sub.sold), sub: sub.sold ? money(sub.sales) + ' in sales' : 'none sold in this range', tab: 'subasta' }),
      card({ label: 'Total Branch Cash Received', value: money(rec.total), sub: topMethods || 'nothing received in this range', tab: 'pos' }),
      card({ label: 'Pending Approvals', value: num(pen.total), tag: 'right now', tab: 'layaway', view: 'approvals', tone: pen.total ? 'warn' : '',
        sub: penParts.length ? penParts.join(' · ') : 'nothing waiting' }),
    ].join('');
    box.querySelectorAll('.ops-card').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab, b.dataset.view || null)));
  }

  function renderCompare() {
    const wrap = $('ops-compare-wrap');
    wrap.hidden = !multi;
    if (!multi) return;
    const rows = visibleRows();
    $('ops-compare-count').textContent = '(' + rows.length + ')';
    const box = $('ops-compare');
    if (!state.summary) { box.innerHTML = '<div class="muted">Loading…</div>'; return; }
    if (!rows.length) { box.innerHTML = '<p class="muted">No branches to compare.</p>'; return; }
    const tot = { pos: 0, open: 0, coll: 0, scrapAmt: 0, scrapG: 0, subs: 0, tx: 0 };
    const cur = getBranchId();
    box.innerHTML = '<div class="table-scroll table-mini"><table class="ops-table"><thead><tr>' +
      '<th>Branch</th>' +
      '<th title="Net sales rung up in the date range">POS Sales</th>' +
      '<th title="Value of layaways opened in the date range (not cancelled or forfeited)">Layaway Value</th>' +
      '<th title="Layaway payments received in the date range">Layaway Collections</th>' +
      '<th title="Scrap bought in the date range">Scrap Amount</th>' +
      '<th title="Scrap grams bought in the date range">Scrap Grams</th>' +
      '<th title="Subasta items sold in the date range">Subasta Sales</th>' +
      '<th title="POS sales + layaway payments + scrap entries + Subasta sales in the date range">Total Transactions</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) => {
        const tx = transactionsOf(r);
        tot.pos += r.pos.net; tot.open += r.layaway.opened_value; tot.coll += r.layaway.collected;
        tot.scrapAmt += r.scrap.purchased; tot.scrapG += r.scrap.grams; tot.subs += r.subasta.sales; tot.tx += tx;
        return '<tr class="' + (r.branch_id === cur ? 'ops-cur' : '') + '">' +
          '<td data-label="Branch"><button type="button" class="exp-row-btn" data-branch="' + r.branch_id + '"><b>' + esc(r.name) + '</b>' + (r.is_active ? '' : ' <span class="badge gray">inactive</span>') + '</button></td>' +
          '<td data-label="POS Sales">' + money(r.pos.net) + '</td>' +
          '<td data-label="Layaway Value">' + money(r.layaway.opened_value) + '</td>' +
          '<td data-label="Layaway Collections">' + money(r.layaway.collected) + '</td>' +
          '<td data-label="Scrap Amount">' + money(r.scrap.purchased) + '</td>' +
          '<td data-label="Scrap Grams">' + grams(r.scrap.grams) + '</td>' +
          '<td data-label="Subasta Sales">' + money(r.subasta.sales) + '</td>' +
          '<td data-label="Total Transactions">' + num(tx) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td><b>All shown</b></td><td><b>' + money(tot.pos) + '</b></td><td><b>' + money(tot.open) + '</b></td><td><b>' + money(tot.coll) +
      '</b></td><td><b>' + money(tot.scrapAmt) + '</b></td><td><b>' + grams(tot.scrapG) + '</b></td><td><b>' + money(tot.subs) + '</b></td><td><b>' + num(tot.tx) + '</b></td></tr></tfoot></table></div>';
    box.querySelectorAll('[data-branch]').forEach((b) => b.addEventListener('click', () => selectBranch(Number(b.dataset.branch))));
  }

  function renderAttention() {
    const box = $('ops-attention');
    if (state.error) { box.innerHTML = ''; return; }
    const items = scopedAttention().filter((a) => ATTENTION_KINDS[a.kind]).sort((x, y) => ATTENTION_KINDS[x.kind].rank - ATTENTION_KINDS[y.kind].rank || x.branch_id - y.branch_id);
    const head = '<div class="ops-attn-head"><b>Needs Attention</b>' + (items.length ? ' <span class="badge low">' + items.length + '</span>' : '') +
      '<span class="muted" style="margin-left:8px;">right now — not affected by the date range</span></div>';
    if (!state.summary && !state.attention.length) { box.innerHTML = head + '<div class="muted">Loading…</div>'; return; }
    if (!items.length) { box.innerHTML = head + '<div class="ops-attn-clear">✓ Nothing needs attention right now.</div>'; return; }
    box.innerHTML = head + '<div class="ops-attn-list">' + items.map((a, i) => {
      const k = ATTENTION_KINDS[a.kind];
      return '<button type="button" class="ops-attn-item tone-' + k.tone + '" data-i="' + i + '">' +
        '<span class="ops-attn-dot" aria-hidden="true"></span>' +
        '<span class="ops-attn-text">' + k.text(a.n, Number(a.amount) || 0) + '</span>' +
        (state.scope === 'all' ? '<span class="ops-attn-branch">' + esc(branchName(a.branch_id)) + '</span>' : '') +
        '<span class="ops-attn-go" aria-hidden="true">›</span></button>';
    }).join('') + '</div>';
    box.querySelectorAll('.ops-attn-item').forEach((b) => b.addEventListener('click', async () => {
      const a = items[Number(b.dataset.i)], k = ATTENTION_KINDS[a.kind];
      if (a.branch_id !== getBranchId()) await selectBranch(a.branch_id);
      showTab(k.tab, k.view);
    }));
  }

  function renderAll() { renderControls(); renderCards(); renderCompare(); renderAttention(); }

  // ---- loading ----
  let token = 0;
  async function refresh() {
    const my = ++token;
    const r = currentRange();
    state.loading = true; state.error = null;
    renderControls();
    try {
      const [summary, attention] = await Promise.all([getBranchOpsSummary(r.from, r.to), getBranchOpsAttention()]);
      if (my !== token) return; // a newer refresh (e.g. another range click) superseded this one
      state.summary = summary; state.attention = attention;
    } catch (err) {
      if (my !== token) return;
      state.error = String((err && err.message) || err);
    }
    state.loading = false;
    renderAll();
    if (onData) { try { onData(); } catch (e) { /* the host's pill refresh must not break the summary */ } }
  }

  function announceRange() { if (onRangeChange) { try { onRangeChange(currentRange()); } catch (e) { console.error(e); } } }
  function setPreset(key) {
    if (key === 'custom' && !(state.custom.from && state.custom.to)) {
      const t = rangeFor('today');
      state.custom = { from: t.from, to: t.to };
      $('ops-from').value = state.custom.from; $('ops-to').value = state.custom.to;
    }
    state.preset = key; persist();
    renderControls(); announceRange(); refresh();
  }
  root.querySelectorAll('#ops-presets button').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
  const settingsBtn = root.querySelector('#ops-settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => onOpenSettings());
  root.querySelectorAll('#ops-scope button').forEach((b) => b.addEventListener('click', () => { state.scope = b.dataset.scope; persist(); renderAll(); }));
  const onCustom = () => {
    const from = $('ops-from').value, to = $('ops-to').value;
    if (!from || !to) return;
    state.custom = from <= to ? { from, to } : { from: to, to: from };
    persist(); renderControls(); announceRange(); refresh();
  };
  $('ops-from').addEventListener('change', onCustom);
  $('ops-to').addEventListener('change', onCustom);

  // Someone elsewhere ringing up a sale / taking a payment / approving a request should show
  // up here without a manual reload -- debounced, since one action touches several tables.
  let timer = null;
  subscribeToChanges([
    'sales_inventory_movements', 'sale_payments', 'layaway_holds', 'layaway_payments', 'scrap_entries', 'subasta_items',
    'layaway_forfeit_date_requests', 'layaway_item_change_requests', 'layaway_payment_deletion_requests', 'layaway_hold_deletion_requests',
    'layaway_forfeit_requests', 'layaway_reminders',
  ], () => { clearTimeout(timer); timer = setTimeout(refresh, 1500); });

  renderAll();
  announceRange();
  refresh();

  return {
    refresh,
    setBranch: () => renderAll(),
    setPreset,
    getRange: currentRange,
    /** Badges for a tab pill ("Layaway 34 · 3 overdue"), for one branch. */
    getUrgent(branchId) {
      const mine = state.attention.filter((a) => a.branch_id === branchId);
      const n = (kind) => (mine.find((a) => a.kind === kind) || {}).n || 0;
      const out = {};
      if (n('layaway_overdue')) out.layaway = { text: n('layaway_overdue') + ' overdue', tone: 'bad' };
      else {
        const pend = n('pending_forfeit_date') + n('pending_item_change') + n('pending_payment_deletion') + n('pending_layaway_deletion') + n('pending_forfeit_request');
        if (pend) out.layaway = { text: pend + ' to approve', tone: 'warn' };
        else if (n('reminders_due')) out.layaway = { text: n('reminders_due') + ' to remind', tone: 'warn' };
      }
      if (n('cod_pending')) out.pos = { text: n('cod_pending') + ' COD', tone: 'warn' };
      return out;
    },
  };
}
