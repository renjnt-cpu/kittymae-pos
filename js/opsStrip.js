// The one compact summary row POS -> Branches keeps (Ren's second Branches spec, 2026-10-07): the selected branch and, for the date range
// chosen in the bar, how busy each module is -- "PACIFIC MALL · POS 33 sales · Layaway 34 active · 3 overdue · Scrap 27 entries · Subasta 8 listed" --
// plus the few things that need action. The full analytics (cards, comparison between branches, the whole Needs Attention list) live on
// POS -> Branch Dashboard. Same server reports (branch_ops_summary / branch_ops_attention), so the numbers are the dashboard's.
import { getBranchOpsSummary, getBranchOpsAttention, subscribeToChanges } from './api.js?v=20261007v';
import { ATTENTION_KINDS, urgentFrom, money, num } from './opsAttention.js?v=20261007v';

/** Options: root, esc, branches (all active), getBranchId(), getRange() -> { from, to, label }, showTab(tab, view), onData() (the module pills re-draw their badges).
 * Returns { refresh, render, getUrgent(branchId) }. Never throws into the page. */
export function initOpsStrip({ root, esc, branches, getBranchId, getRange, showTab, onData, onOpenSettings, onOpenApprovals }) {
  const state = { summary: null, attention: [], error: '' };
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);

  function render() {
    const id = getBranchId();
    const rg = getRange();
    if (state.error) { root.innerHTML = '<div class="ops-strip muted">The branch summary could not be loaded (' + esc(state.error) + ').</div>'; return; }
    if (!state.summary) { root.innerHTML = '<div class="ops-strip muted">Loading ' + esc(branchName(id)) + '…</div>'; return; }
    const r = (state.summary.branches || []).find((x) => x.branch_id === id);
    const item = (tab, view, tone, html) => '<button type="button" class="ops-strip-item' + (tone ? ' tone-' + tone : '') + '" data-tab="' + tab + '"' + (view ? ' data-view="' + view + '"' : '') + '>' + html + '</button>';
    const sep = '<span class="ops-strip-sep" aria-hidden="true">·</span>';
    const pendingN = r && r.pending ? r.pending.total : 0;
    const parts = r
      ? [
        item('pos', '', '', '<span class="ops-strip-k">POS</span> <b>' + num(r.pos.transactions) + '</b> sale' + (r.pos.transactions === 1 ? '' : 's')),
        item('layaway', 'onhold', '', '<span class="ops-strip-k">Layaway</span> <b>' + num(r.layaway.on_hold_lines) + '</b> active') +
          (r.layaway.overdue_lines ? ' ' + item('layaway', 'overdue', 'bad', '<b>' + num(r.layaway.overdue_lines) + '</b> overdue') : ''),
        item('scrap', '', '', '<span class="ops-strip-k">Scrap</span> <b>' + num(r.scrap.entries) + '</b> ' + (r.scrap.entries === 1 ? 'entry' : 'entries')),
        item('subasta', '', '', '<span class="ops-strip-k">Subasta</span> <b>' + num(r.subasta.listed_now) + '</b> listed'),
      ]
      : ['<span class="muted">No figures for this branch.</span>'];
    // up to three things that need action in this branch, most urgent first -- the rest are on the Branch Dashboard
    const attn = state.attention.filter((a) => a.branch_id === id && ATTENTION_KINDS[a.kind]).sort((x, y) => ATTENTION_KINDS[x.kind].rank - ATTENTION_KINDS[y.kind].rank);
    const chips = attn.slice(0, 3).map((a) => {
      const k = ATTENTION_KINDS[a.kind];
      return '<button type="button" class="ops-strip-chip tone-' + k.tone + '" data-tab="' + k.tab + '" data-view="' + k.view + '">' + k.text(a.n, Number(a.amount) || 0) + '</button>';
    }).join('');
    root.innerHTML = '<div class="ops-strip" role="region" aria-label="Branch summary">' +
      '<b class="ops-strip-name">' + esc(branchName(id)) + '</b><span class="ops-strip-range muted">' + esc(rg.label || '') + '</span>' +
      parts.join(sep) +
      (onOpenApprovals ? '<button type="button" class="btn small secondary ops-strip-approvals' + (pendingN ? ' has' : '') + '" id="ops-strip-approvals" title="Every request waiting for approval, all modules">Approvals' + (pendingN ? ' <b>' + num(pendingN) + '</b>' : '') + '</button>' : '') +
      '<a class="ops-strip-link" href="branch-dashboard.html">Branch Dashboard ›</a>' +
      (onOpenSettings ? '<button type="button" class="btn small secondary ops-strip-gear" id="ops-strip-gear" title="Layaway deadline, reminders and branch visibility">⚙ Settings</button>' : '') +
      (chips ? '<div class="ops-strip-attn"><span class="muted">Needs attention:</span> ' + chips + (attn.length > 3 ? ' <a class="ops-strip-more" href="branch-dashboard.html">+' + (attn.length - 3) + ' more</a>' : '') + '</div>' : '') +
    '</div>';
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab, b.dataset.view || null)));
    root.querySelector('#ops-strip-gear')?.addEventListener('click', () => onOpenSettings());
    root.querySelector('#ops-strip-approvals')?.addEventListener('click', () => onOpenApprovals());
  }

  let token = 0;
  async function refresh() {
    const my = ++token;
    const rg = getRange();
    try {
      const [summary, attention] = await Promise.all([getBranchOpsSummary(rg.from, rg.to), getBranchOpsAttention()]);
      if (my !== token) return;
      state.summary = summary; state.attention = attention; state.error = '';
    } catch (err) {
      if (my !== token) return;
      state.error = String((err && err.message) || err);
    }
    render();
    if (onData) { try { onData(); } catch (e) { /* a pill refresh must not break the strip */ } }
  }

  // Someone elsewhere ringing up a sale / taking a payment / approving a request shows up here without a reload -- debounced (one action touches several tables).
  let timer = null;
  subscribeToChanges([
    'sales_inventory_movements', 'sale_payments', 'layaway_holds', 'layaway_payments', 'scrap_entries', 'subasta_items',
    'layaway_forfeit_date_requests', 'layaway_item_change_requests', 'layaway_payment_deletion_requests', 'layaway_hold_deletion_requests',
    'layaway_forfeit_requests', 'layaway_reminders', 'scrap_payments', 'subasta_payments', 'branch_record_requests',
  ], () => { clearTimeout(timer); timer = setTimeout(refresh, 1500); });

  render();
  refresh();
  return { refresh, render, getUrgent: (branchId) => urgentFrom(state.attention, branchId) };
}
