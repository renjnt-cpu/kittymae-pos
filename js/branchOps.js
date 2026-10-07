// Branch Operations Summary -- the analytics half of the Branches upgrade (Ren, 2026-10-07). It used to open the Branches page; it
// now lives on its own page, POS -> Branch Dashboard (branch-dashboard.html), so the Branches page can stay a fast working desk:
// one date range, ten summary cards, a per-branch comparison and a "Needs Attention" list, all fed by two server reports
// (branch_ops_summary / branch_ops_attention, migration 166) so the numbers never depend on how many rows a tab happened to load.
// Every card, flag and branch name is a way into the Branches page on the same branch and dates. Layaway deadlines/overdue and
// pending approvals deliberately ignore the date range -- they describe what needs action today.
import { getBranchOpsSummary, getBranchOpsAttention, subscribeToChanges } from './api.js?v=20261007r';
import { RANGE_PRESETS, rangeFor, describeRange } from './opsDates.js?v=20261007r';
import { loadPrefs, savePrefs, savedRange } from './opsPrefs.js?v=20261007r';
import { ATTENTION_KINDS, urgentFrom, money, num, plural } from './opsAttention.js?v=20261007r';

export { ATTENTION_KINDS };
export { getInitialRange } from './opsPrefs.js?v=20261007r';

const grams = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) + ' g';

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

/** Mounts the summary into `root`. Options:
 *  esc, branches (all active branches), visibleBranchIds (what this employee may see),
 *  getBranchId() -> the branch "Current Branch" means, selectBranch(id) -> make a branch the current one,
 *  showTab(tab, view) -> open that module (and view) of the CURRENT branch on the Branches page,
 *  openBranch(id) -> open one branch's Branches page (the comparison table's branch names),
 *  onRangeChange({preset, from, to, label}) -- called once at start and on every change,
 *  onData() -- called after new attention data arrives, onOpenSettings() -- Admin's settings button.
 * Returns { refresh, setBranch, setPreset, getRange, getUrgent }. Never throws into the host page. */
export function initBranchOps({ root, esc, branches, visibleBranchIds, getBranchId, selectBranch, showTab, openBranch, onRangeChange, onData, onOpenSettings }) {
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
          '<div class="ops-seg ops-presets" role="group" aria-label="Date range" id="ops-presets">' +
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

  function persist() { savePrefs({ ...loadPrefs(), preset: state.preset, custom: state.custom, scope: state.scope }); }

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

  // A card opens its module on the Branches page; a flag inside a card ("2 items overdue") opens the exact view that needs action.
  function card({ label, value, sub, tab, view, tone, tag, flags }) {
    return '<button type="button" class="ops-card' + (tone ? ' tone-' + tone : '') + '" data-tab="' + tab + '"' + (view ? ' data-view="' + view + '"' : '') + '>' +
      '<span class="ops-card-lbl"><span>' + label + '</span>' + (tag ? '<span class="ops-tag">' + tag + '</span>' : '') + '</span>' +
      '<span class="ops-card-num">' + value + '</span>' +
      (sub ? '<span class="ops-card-sub">' + sub + '</span>' : '') +
      (flags || []).map((f) => '<span class="ops-flag' + (f.tone ? ' ' + f.tone : '') + '" role="link" tabindex="0" data-flag-tab="' + f.tab + '" data-flag-view="' + f.view + '">' + f.text + '</span>').join('') +
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
    const penParts = [['forfeit_date', 'forfeit date'], ['item_change', 'item change'], ['payment_deletion', 'payment deletion'], ['layaway_deletion', 'layaway deletion'],
      ['forfeit_request', 'forfeiture'], ['record_request', 'scrap/subasta/POS delete']]
      .filter(([k]) => pen[k]).map(([k, l]) => num(pen[k]) + ' ' + l);
    // "Pending Approvals" opens the queue that is actually waiting: the most urgent pending item of the branch(es) in view.
    const firstPending = scopedAttention().filter((x) => String(x.kind).startsWith('pending_') && ATTENTION_KINDS[x.kind])
      .sort((x, y) => ATTENTION_KINDS[x.kind].rank - ATTENTION_KINDS[y.kind].rank)[0];
    const pendTarget = firstPending ? ATTENTION_KINDS[firstPending.kind] : { tab: 'layaway', view: 'approvals' };
    box.innerHTML = [
      card({ label: 'POS Sales', value: money(pos.net), sub: plural(pos.items || 0, 'item') + ' sold' + (pos.discounts > 0 ? ' · ' + money(pos.discounts) + ' in discounts' : ''), tab: 'pos' }),
      card({ label: 'POS Transactions', value: num(pos.transactions), sub: pos.transactions ? 'avg ' + money(avgSale) + ' per sale' : 'no sales in this range', tab: 'pos' }),
      card({ label: 'Layaway On Hold', value: num(lay.on_hold_lines), tag: 'right now', tab: 'layaway', view: 'onhold', tone: lay.overdue_lines ? 'bad' : '',
        sub: money(lay.on_hold_balance) + ' still owed · ' + plural(lay.on_hold_orders || 0, 'order'),
        flags: lay.overdue_lines ? [{ text: plural(lay.overdue_lines, 'item') + ' overdue', tab: 'layaway', view: 'overdue' }]
          : (lay.nearing_lines ? [{ text: num(lay.nearing_lines) + ' nearing the deadline', tone: 'warn', tab: 'layaway', view: 'nearing' }] : []) }),
      card({ label: 'Layaway Payments Received', value: money(lay.collected), sub: plural(lay.payments || 0, 'payment'), tab: 'layaway', view: 'payments' }),
      card({ label: 'Scrap Purchased', value: money(scr.purchased), sub: plural(scr.entries || 0, 'entry', 'entries'), tab: 'scrap', tone: scr.unpaid_entries ? 'bad' : '',
        flags: scr.unpaid_entries ? [{ text: money(scr.unpaid_balance) + ' unpaid · ' + plural(scr.unpaid_entries, 'purchase'), tab: 'scrap', view: 'unpaid' }] : [] }),
      card({ label: 'Scrap Grams', value: grams(scr.grams), sub: scr.grams ? 'avg ' + money(avgGram) + ' per gram' : 'none bought in this range', tab: 'scrap' }),
      card({ label: 'Subasta Listed', value: num(sub.listed_now), tag: 'right now', sub: num(sub.pending_now) + ' pending' + (sub.hold_now ? ' · ' + num(sub.hold_now) + ' on hold' : ''), tab: 'subasta', tone: sub.eligible_now ? 'warn' : '',
        flags: sub.eligible_now ? [{ text: plural(sub.eligible_now, 'item') + ' eligible to list', tone: 'warn', tab: 'subasta', view: 'eligible' }] : [] }),
      card({ label: 'Subasta Sold', value: num(sub.sold), sub: sub.sold ? money(sub.sales) + ' in sales' : 'none sold in this range', tab: 'subasta', tone: sub.unpaid_entries ? 'bad' : '',
        flags: sub.unpaid_entries ? [{ text: money(sub.unpaid_balance) + ' unpaid · ' + plural(sub.unpaid_entries, 'sold item'), tab: 'subasta', view: 'unpaid' }] : [] }),
      card({ label: 'Total Branch Cash Received', value: money(rec.total), sub: topMethods || 'nothing received in this range', tab: 'pos' }),
      card({ label: 'Pending Approvals', value: num(pen.total), tag: 'right now', tab: pendTarget.tab, view: pendTarget.view, tone: pen.total ? 'warn' : '',
        sub: penParts.length ? penParts.join(' · ') : 'nothing waiting' }),
    ].join('');
    box.querySelectorAll('.ops-card').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab, b.dataset.view || null)));
    // a flag is its own link (a span inside the card button): it must not also trigger the card
    const openFlag = (ev, el) => { ev.stopPropagation(); ev.preventDefault(); showTab(el.dataset.flagTab, el.dataset.flagView || null); };
    box.querySelectorAll('[data-flag-tab]').forEach((f) => {
      f.addEventListener('click', (ev) => openFlag(ev, f));
      f.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') openFlag(ev, f); });
    });
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
    const tot = { pos: 0, ptx: 0, active: 0, open: 0, coll: 0, owed: 0, scrapAmt: 0, scrapG: 0, subs: 0, tx: 0 };
    const cur = getBranchId();
    box.innerHTML = '<div class="table-scroll table-mini"><table class="ops-table"><thead><tr>' +
      '<th>Branch</th>' +
      '<th title="Net sales rung up in the date range">POS Sales</th>' +
      '<th title="Number of POS sales in the date range">POS Transactions</th>' +
      '<th title="Layaway lines On Hold right now">Layaway Active</th>' +
      '<th title="Value of layaways opened in the date range (not cancelled or forfeited)">Layaway Value</th>' +
      '<th title="Layaway payments received in the date range">Layaway Collections</th>' +
      '<th title="What is still owed on layaways On Hold right now">Outstanding Layaway</th>' +
      '<th title="Scrap bought in the date range">Scrap Amount</th>' +
      '<th title="Scrap grams bought in the date range">Scrap Grams</th>' +
      '<th title="Subasta items sold in the date range">Subasta Sales</th>' +
      '<th title="POS sales + layaway payments + scrap entries + Subasta sales in the date range">Total Transactions</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) => {
        const tx = transactionsOf(r);
        tot.pos += r.pos.net; tot.ptx += r.pos.transactions; tot.active += r.layaway.on_hold_lines; tot.open += r.layaway.opened_value; tot.coll += r.layaway.collected;
        tot.owed += r.layaway.on_hold_balance; tot.scrapAmt += r.scrap.purchased; tot.scrapG += r.scrap.grams; tot.subs += r.subasta.sales; tot.tx += tx;
        return '<tr class="' + (r.branch_id === cur ? 'ops-cur' : '') + '">' +
          '<td data-label="Branch"><button type="button" class="exp-row-btn" data-branch="' + r.branch_id + '" title="Open ' + esc(r.name) + ' on the Branches page"><b>' + esc(r.name) + '</b>' + (r.is_active ? '' : ' <span class="badge gray">inactive</span>') + ' ›</button></td>' +
          '<td data-label="POS Sales">' + money(r.pos.net) + '</td>' +
          '<td data-label="POS Transactions">' + num(r.pos.transactions) + '</td>' +
          '<td data-label="Layaway Active">' + num(r.layaway.on_hold_lines) + '</td>' +
          '<td data-label="Layaway Value">' + money(r.layaway.opened_value) + '</td>' +
          '<td data-label="Layaway Collections">' + money(r.layaway.collected) + '</td>' +
          '<td data-label="Outstanding Layaway">' + money(r.layaway.on_hold_balance) + '</td>' +
          '<td data-label="Scrap Amount">' + money(r.scrap.purchased) + '</td>' +
          '<td data-label="Scrap Grams">' + grams(r.scrap.grams) + '</td>' +
          '<td data-label="Subasta Sales">' + money(r.subasta.sales) + '</td>' +
          '<td data-label="Total Transactions">' + num(tx) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td><b>All shown</b></td><td><b>' + money(tot.pos) + '</b></td><td><b>' + num(tot.ptx) + '</b></td><td><b>' + num(tot.active) + '</b></td><td><b>' + money(tot.open) +
      '</b></td><td><b>' + money(tot.coll) + '</b></td><td><b>' + money(tot.owed) + '</b></td><td><b>' + money(tot.scrapAmt) + '</b></td><td><b>' + grams(tot.scrapG) +
      '</b></td><td><b>' + money(tot.subs) + '</b></td><td><b>' + num(tot.tx) + '</b></td></tr></tfoot></table></div>';
    box.querySelectorAll('[data-branch]').forEach((b) => b.addEventListener('click', () => (openBranch || selectBranch)(Number(b.dataset.branch))));
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
    if (onData) { try { onData(); } catch (e) { /* the host's refresh must not break the summary */ } }
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
    'layaway_forfeit_requests', 'layaway_reminders', 'scrap_payments', 'subasta_payments', 'branch_record_requests',
  ], () => { clearTimeout(timer); timer = setTimeout(refresh, 1500); });

  renderAll();
  announceRange();
  refresh();

  return {
    refresh,
    setBranch: () => renderAll(),
    setPreset,
    getRange: currentRange,
    /** Badges for a module pill ("Layaway 34 · 3 overdue"), for one branch. */
    getUrgent: (branchId) => urgentFrom(state.attention, branchId),
  };
}
