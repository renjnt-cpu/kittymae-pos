// Search across every module (Ren's Branches spec, Phase 6): one box that looks in POS sales, Layaways, Scrap entries and Subasta items at
// once -- by SKU, item, customer, order / reference number, payment reference, contact number or the admin who recorded it -- with the
// filters the spec lists (From / To, branch, admin, status, payment method). The bar's own Search box still filters only the module on
// show; this is the "where did that customer go?" tool. A result opens the record in its own tab (switching branch first if needed).
// The lookup is search_branch_records() (row-level security applies: you only find what you may already see).
import { searchBranchRecords, listActiveEmployees } from './api.js?v=20261007t';
import { POS_PAYMENT_METHODS, posMethodLabel } from './paymentMethods.js?v=20261007t';
import { friendlyError } from './shell.js?v=20261007t';

const MODULES = ['POS', 'Layaway', 'Scrap', 'Subasta'];
const MODULE_LABEL = { POS: 'POS Walk In & COD', Layaway: 'Layaway', Scrap: 'Scrap', Subasta: 'Subasta' };
const MODULE_DOT = { POS: '#2e7d32', Layaway: '#c2185b', Scrap: '#b06a1f', Subasta: '#7c3aa8' };
const STATUSES = ['Paid', 'Not fully paid', 'COD to collect', 'Unpaid', 'On Hold', 'Completed', 'Forfeited', 'Cancelled', 'Pending', 'Listed', 'Hold', 'Sold', 'Withdrawn'];
const TONE = { Paid: 'green', Completed: 'green', Sold: 'green', 'Not fully paid': 'yellow', 'COD to collect': 'yellow', Unpaid: 'red', Pending: 'yellow', Hold: 'red',
  'On Hold': 'blue', Listed: 'blue', Forfeited: 'gray', Cancelled: 'gray', Withdrawn: 'gray' };
const money = (n) => n === null || n === undefined ? '' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '';

/** Options: esc, employee, branches (all active), visibleBranches, getBranchId(), onOpen({ module, record_table, record_id, branch_id }).
 * Returns { open({ query? }), close, isOpen }. */
export function initGlobalSearch({ esc, branches, visibleBranches, getBranchId, onOpen }) {
  const multi = visibleBranches.length > 1;
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  let names = {}, seq = 0, timer = null, last = [];

  const back = document.createElement('div');
  back.className = 'drawer-backdrop'; back.id = 'srch-backdrop';
  const drawer = document.createElement('div');
  drawer.className = 'drawer drawer-wide'; drawer.id = 'srch-drawer';
  drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Search all modules');
  drawer.innerHTML =
    '<div class="drawer-header"><div><h3>Search everything</h3><div class="muted">POS sales, layaways, scrap entries and Subasta items together</div></div><button type="button" class="drawer-close" id="srch-close" aria-label="Close">✕</button></div>' +
    '<div class="drawer-body">' +
      '<label class="field"><span class="sr-only">Search</span><input type="search" id="srch-q" placeholder="Customer, SKU, item, order / reference no., payment reference, contact number, admin…" autocomplete="off"></label>' +
      '<div class="srch-filters">' +
        (multi ? '<label class="field"><span>Where</span><select id="srch-where"><option value="branch">This branch</option><option value="all">All my branches</option></select></label>' : '') +
        '<label class="field"><span>From</span><input type="date" id="srch-from"></label>' +
        '<label class="field"><span>To</span><input type="date" id="srch-to"></label>' +
        '<label class="field"><span>Admin</span><select id="srch-admin"><option value="">Anyone</option></select></label>' +
        '<label class="field"><span>Status</span><select id="srch-status"><option value="">Any</option>' + STATUSES.map((s) => '<option>' + s + '</option>').join('') + '</select></label>' +
        '<label class="field"><span>Payment method</span><select id="srch-method"><option value="">Any</option>' + POS_PAYMENT_METHODS.map((m) => '<option value="' + m + '">' + esc(posMethodLabel(m)) + '</option>').join('') + '</select></label>' +
        '<button type="button" class="btn small secondary" id="srch-clear">Clear</button>' +
      '</div>' +
      '<div id="srch-results" class="srch-results"><div class="muted">Type at least 2 characters, or pick a filter.</div></div>' +
    '</div>';
  document.body.appendChild(back); document.body.appendChild(drawer);
  const $ = (id) => drawer.querySelector('#' + id);

  const args = () => {
    const where = $('srch-where') ? $('srch-where').value : 'branch';
    return {
      q: $('srch-q').value.trim(), branchIds: where === 'all' ? visibleBranches.map((b) => b.id) : [getBranchId()],
      from: $('srch-from').value || undefined, to: $('srch-to').value || undefined, admin: $('srch-admin').value || undefined,
      status: $('srch-status').value || undefined, method: $('srch-method').value || undefined, limit: 40,
    };
  };
  const ready = (a) => a.q.length >= 2 || a.from || a.to || a.admin || a.status || a.method;

  async function run() {
    const a = args(), mine = ++seq, box = $('srch-results');
    if (!ready(a)) { box.innerHTML = '<div class="muted">Type at least 2 characters, or pick a filter.</div>'; return; }
    box.innerHTML = '<div class="muted">Searching…</div>';
    try {
      const res = await searchBranchRecords(a);
      if (mine !== seq) return;
      render(res, a);
    } catch (err) {
      if (mine !== seq) return;
      box.innerHTML = '<div class="msg error">' + esc(friendlyError(String(err.message || err))) + '</div>';
    }
  }
  function render(res, a) {
    const box = $('srch-results');
    last = [];
    const mods = res.modules || {};
    const total = MODULES.reduce((s, m) => s + ((mods[m] && mods[m].total) || 0), 0);
    if (!total) { box.innerHTML = '<div class="empty-state"><div class="empty-state-msg">Nothing found' + (a.q ? ' for “' + esc(a.q) + '”' : '') + '.</div><div class="muted" style="font-size:12px;margin-top:4px;">Check the spelling, try a shorter piece (a surname, the last digits of a number), or widen the filters.</div></div>'; return; }
    const showBranch = multi && (($('srch-where') || {}).value === 'all');
    box.innerHTML = '<div class="muted" style="font-size:12px;margin:0 0 6px;">' + total + (total === 1 ? ' match' : ' matches') + '</div>' +
      MODULES.filter((m) => mods[m] && mods[m].total).map((m) => {
        const mm = mods[m];
        return '<section class="srch-group"><h4><span class="ops-tab-dot" style="background:' + MODULE_DOT[m] + ';"></span>' + esc(MODULE_LABEL[m]) + ' <span class="exp-count">(' + mm.total + ')</span></h4>' +
          mm.rows.map((r) => {
            const i = last.push(r) - 1;
            return '<button type="button" class="srch-row" data-i="' + i + '">' +
              '<span class="srch-main"><b>' + esc(r.title || r.ref || '—') + '</b>' + (r.ref ? ' <span class="muted">' + esc(r.ref) + '</span>' : '') + '</span>' +
              '<span class="srch-right">' + (r.amount != null ? '<b>' + money(r.amount) + '</b> ' : '') + (r.status ? '<span class="badge st-' + (TONE[r.status] || 'gray') + '">' + esc(r.status) + '</span>' : '') + '</span>' +
              '<span class="srch-sub muted">' + [r.customer, r.contact, fmtDate(r.day), r.admin_id ? names[r.admin_id] : '', showBranch ? branchName(r.branch_id) : '', r.methods].filter(Boolean).map(esc).join(' · ') + '</span>' +
            '</button>';
          }).join('') +
          (mm.total > mm.rows.length ? '<div class="muted" style="font-size:11px;margin:4px 0 0;">Showing the newest ' + mm.rows.length + ' of ' + mm.total + ' — narrow the search to see the rest.</div>' : '') +
        '</section>';
      }).join('');
    box.querySelectorAll('.srch-row').forEach((b) => b.addEventListener('click', () => {
      const r = last[Number(b.dataset.i)];
      if (!r) return;
      close();
      onOpen({ module: r.module, record_table: r.record_table, record_id: r.record_id, branch_id: r.branch_id });
    }));
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 350); };
  $('srch-q').addEventListener('input', schedule);
  $('srch-q').addEventListener('search', () => { clearTimeout(timer); run(); });
  $('srch-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); clearTimeout(timer); run(); } });
  ['srch-where', 'srch-from', 'srch-to', 'srch-admin', 'srch-status', 'srch-method'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', () => { clearTimeout(timer); run(); }); });
  $('srch-clear').addEventListener('click', () => {
    $('srch-q').value = ''; ['srch-from', 'srch-to'].forEach((id) => { $(id).value = ''; });
    ['srch-admin', 'srch-status', 'srch-method'].forEach((id) => { $(id).value = ''; });
    run(); $('srch-q').focus();
  });

  async function open(opts) {
    back.classList.add('open'); drawer.classList.add('open');
    if (opts && opts.query != null) $('srch-q').value = opts.query;
    if (!Object.keys(names).length) {
      try {
        const people = await listActiveEmployees();
        names = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
        $('srch-admin').innerHTML = '<option value="">Anyone</option>' + people.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.full_name) + '</option>').join('');
      } catch (e) { /* the admin filter just stays empty */ }
    }
    setTimeout(() => { $('srch-q').focus(); $('srch-q').select(); }, 200);
    run();
  }
  function close() { back.classList.remove('open'); drawer.classList.remove('open'); }
  $('srch-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && drawer.classList.contains('open')) close(); });
  return { open, close, isOpen: () => drawer.classList.contains('open') };
}
