// Branch Capital -- REPORTS: the daily expense report (today / this week / this month / any dates), the branch comparison, the transportation report, the petty cash report and the audit log.
// Each can be downloaded as a CSV (Excel) with the export permission. Expenses that were rejected, cancelled, reversed or are still drafts are not counted; reversals are shown separately.
import { esc } from './shell.js?v=20261023b';
import { bcReportExpenses, bcReportTransport, bcReportPetty, bcAuditList } from './bcApi.js?v=20261023b';
import { money, signed, fmtDate, fmtStamp, fmtDay, addDays, monthStart, weekStart, cardHtml, barHtml, downloadCsv, optionsHtml, statusBadge, receiptBadge, num } from './bcFormat.js?v=20261023b';

const VIEWS = [['daily', 'Daily expenses'], ['branches', 'Branch comparison'], ['transport', 'Transportation'], ['petty', 'Petty cash'], ['audit', 'Audit log']];
const ENTITY_TYPES = [['', 'Everything'], ['expense', 'Expenses'], ['petty_fund', 'Petty cash funds'], ['replenishment', 'Replenishments'], ['advance', 'Cash advances'], ['reconciliation', 'Daily counts'], ['movement', 'Deposits & movements'], ['cash_book', 'Cash books'], ['petty_cash', 'Petty cash blocks'], ['category', 'Categories'], ['settings', 'Settings']];

export function startReports(app) {
  const root = app.root('reports');
  const st = { view: 'daily', preset: 'month', from: monthStart(app.ctx.today), to: app.ctx.today, entity: '', entityId: '' };
  let seq = 0;
  const memo = {};

  root.innerHTML =
    '<div class="card bc-filters"><div class="bc-filter-row">' +
      '<div class="bc-quick" id="rp-views">' + VIEWS.map(([k, l]) => '<button type="button" class="btn small' + (k === st.view ? '' : ' secondary') + '" data-view="' + k + '">' + esc(l) + '</button>').join('') + '</div></div>' +
    '<div class="bc-filter-row" id="rp-range-row">' +
      '<span class="bc-quick" id="rp-presets"><button type="button" class="btn small secondary" data-p="today">Today</button><button type="button" class="btn small secondary" data-p="week">This week</button><button type="button" class="btn small" data-p="month">This month</button><button type="button" class="btn small secondary" data-p="last">Last month</button></span>' +
      '<div class="field"><label for="rp-from">From</label><input type="date" id="rp-from" value="' + st.from + '"></div><div class="field"><label for="rp-to">To</label><input type="date" id="rp-to" value="' + st.to + '"></div>' +
      '<div class="field" id="rp-ent-f" hidden><label for="rp-ent">Record type</label><select id="rp-ent">' + optionsHtml(ENTITY_TYPES, '') + '</select></div><div class="field" id="rp-eid-f" hidden><label for="rp-eid">Record no.</label><input type="text" id="rp-eid" inputmode="numeric" placeholder="e.g. 12"></div>' +
      '<span class="bc-grow"></span>' + (app.can.export ? '<button type="button" class="btn secondary" id="rp-csv">Download CSV</button>' : '') +
    '</div></div><div id="rp-body"></div>';
  const $ = (id) => root.querySelector('#' + id);
  let current = null;   // { filename, headers, rows } for the CSV button

  function setPreset(p) {
    const t = app.ctx.today;
    st.preset = p;
    if (p === 'today') { st.from = t; st.to = t; }
    else if (p === 'week') { st.from = weekStart(t); st.to = t; }
    else if (p === 'month') { st.from = monthStart(t); st.to = t; }
    else if (p === 'last') { const ms = monthStart(t); st.to = addDays(ms, -1); st.from = monthStart(st.to); }
    $('rp-from').value = st.from; $('rp-to').value = st.to;
    root.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('secondary', b.dataset.p !== p));
  }
  root.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { setPreset(b.dataset.p); refresh(); }));
  ['rp-from', 'rp-to'].forEach((id) => $(id).addEventListener('change', () => { st.from = $('rp-from').value; st.to = $('rp-to').value; st.preset = ''; root.querySelectorAll('[data-p]').forEach((b) => b.classList.add('secondary')); refresh(); }));
  $('rp-ent').addEventListener('change', () => { st.entity = $('rp-ent').value; refresh(); });
  $('rp-eid').addEventListener('change', () => { st.entityId = $('rp-eid').value.trim(); refresh(); });
  $('rp-views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    st.view = b.dataset.view;
    root.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('secondary', x.dataset.view !== st.view));
    refresh();
  });
  const csvBtn = $('rp-csv');
  if (csvBtn) csvBtn.addEventListener('click', () => { if (current) downloadCsv(current.filename, current.headers, current.rows); });

  const table = (heads, rows, cls) => '<div class="table-scroll table-2col"><table class="bc-table ' + (cls || '') + '"><thead><tr>' + heads.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c, i) => '<td data-label="' + esc(heads[i]) + '">' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const branchId = () => (app.state.branch !== 'all' ? app.state.branch : null);
  const rangeText = () => (st.from === st.to ? fmtDate(st.from) : fmtDate(st.from) + ' – ' + fmtDate(st.to));
  const scopeText = () => (app.state.branch === 'all' ? 'all branches' : app.branchName(app.state.branch));

  async function expenses() {
    const key = st.from + '|' + st.to + '|' + branchId();
    if (!memo[key] || Date.now() - memo[key].at > 20000) memo[key] = { at: Date.now(), data: await bcReportExpenses(st.from, st.to, branchId()) };
    return memo[key].data;
  }

  async function refresh() {
    const my = ++seq;
    $('rp-range-row').querySelectorAll('.field,.bc-quick').forEach((el) => { el.hidden = false; });
    $('rp-ent-f').hidden = $('rp-eid-f').hidden = st.view !== 'audit';
    if (csvBtn) csvBtn.hidden = false;
    const body = $('rp-body');
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      let html = '';
      if (st.view === 'daily') html = await dailyView();
      else if (st.view === 'branches') html = await branchesView();
      else if (st.view === 'transport') html = await transportView();
      else if (st.view === 'petty') html = await pettyView();
      else html = await auditView();
      if (my === seq) body.innerHTML = html;
    } catch (err) { if (my === seq) { current = null; body.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; } }
  }

  async function dailyView() {
    const r = await expenses();
    const t = r.totals;
    const maxDay = Math.max(1, ...r.by_day.map((d) => num(d.amount)));
    const maxCat = Math.max(1, ...r.by_category.map((d) => num(d.amount)));
    current = { filename: 'branch-expenses-' + st.from + '-to-' + st.to + '.csv', headers: ['ID', 'Date', 'Branch', 'Category', 'What for', 'Amount', 'Paid from', 'Method', 'Spent by', 'Status', 'Receipt', 'Reference'],
      rows: r.rows.map((x) => [x.id, x.date, x.branch, x.category, x.description, x.amount, x.paid_from, x.method, x.spent_by || '', x.status, x.receipt, x.reference || '']) };
    return '<h3 style="margin-top:0;">Daily expense report — ' + esc(rangeText()) + ' <span class="muted" style="font-weight:normal;">· ' + esc(scopeText()) + '</span></h3>' +
      '<div class="lw-cards bc-cards">' +
        cardHtml({ label: 'Total expenses', value: money(t.amount), sub: t.count + ' expense' + (t.count === 1 ? '' : 's') }) +
        cardHtml({ label: 'From daily sales / cash', value: money(t.from_sales) }) + cardHtml({ label: 'From petty cash', value: money(t.from_petty) }) +
        cardHtml({ label: 'From branch capital', value: money(t.from_capital) }) + cardHtml({ label: 'Other sources', value: money(t.from_other), sub: 'bank, e-wallet…' }) +
        cardHtml({ label: 'Transportation', value: money(t.transport) }) + cardHtml({ label: 'Bills paid', value: money(t.bills) }) +
        cardHtml({ label: 'Receipts missing', value: String(t.receipts_missing), tone: t.receipts_missing ? 'warn' : '' }) + cardHtml({ label: 'Waiting for approval', value: String(t.pending_approval), tone: t.pending_approval ? 'warn' : '' }) +
        cardHtml({ label: 'Reversed (not counted)', value: money(r.reversed.amount), sub: r.reversed.count + ' reversed' }) + '</div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">By day</h3>' + (r.by_day.length ? table(['Day', '#', 'Total'], r.by_day.map((d) => [esc(fmtDay(d.date)), d.count, barHtml(d.amount, maxDay, money(d.amount))])) : '<p class="muted">No expenses in this range.</p>') + '</div>' +
      '<div class="card"><h3 style="margin-top:0;">By category</h3>' + (r.by_category.length ? table(['Category', '#', 'Total'], r.by_category.map((d) => [esc(d.category), d.count, barHtml(d.amount, maxCat, money(d.amount))])) : '<p class="muted">—</p>') + '</div></div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">Where the money came from</h3>' + table(['Source', 'Total'], r.by_source.map((d) => [esc(d.source), money(d.amount)])) + '</div>' +
      '<div class="card"><h3 style="margin-top:0;">By person</h3>' + (r.by_person.length ? table(['Spent by', '#', 'Total'], r.by_person.map((d) => [esc(d.person), d.count, money(d.amount)])) : '<p class="muted">—</p>') + '</div></div>' +
      '<div class="card"><h3 style="margin-top:0;">The expenses <span class="muted" style="font-weight:normal;">(' + r.rows.length + (r.rows.length >= 2000 ? ', latest 2,000' : '') + ')</span></h3>' +
        (r.rows.length ? table(['Date', 'Branch', 'Category', 'What for', 'Amount', 'Paid from', 'By', 'Status', 'Receipt'], r.rows.slice(0, 300).map((x) => [esc(fmtDate(x.date)), esc(x.branch), esc(x.category), esc(x.description), '<b>' + money(x.amount) + '</b>', esc(x.paid_from), esc(x.spent_by || '—'), statusBadge(x.status), receiptBadge(x.receipt) || '—']), 'bc-row-click') +
          (r.rows.length > 300 ? '<p class="muted">Showing 300 of ' + r.rows.length + '. The CSV has all of them.</p>' : '') : '<p class="muted">Nothing recorded in this range.</p>') + '</div>';
  }

  async function branchesView() {
    const r = await expenses();
    const rows = r.by_branch;
    const max = Math.max(1, ...rows.map((b) => num(b.amount)));
    current = { filename: 'branch-comparison-' + st.from + '-to-' + st.to + '.csv', headers: ['Branch', 'Expenses', 'Total', 'From sales cash', 'From petty cash', 'From capital', 'Transportation', 'Gross sales', '% of sales'],
      rows: rows.map((b) => [b.branch, b.count, b.amount, b.from_sales, b.from_petty, b.from_capital, b.transport, b.net_sales, b.pct_of_sales === null || b.pct_of_sales === undefined ? '' : b.pct_of_sales]) };
    return '<h3 style="margin-top:0;">Branch comparison — ' + esc(rangeText()) + '</h3><div class="card">' +
      table(['Branch', '#', 'Total expenses', 'From sales cash', 'From petty cash', 'From capital', 'Transportation', 'Gross sales', 'Expenses as % of sales'],
        rows.map((b) => [esc(b.branch), b.count, barHtml(b.amount, max, money(b.amount)), money(b.from_sales), money(b.from_petty), money(b.from_capital), money(b.transport), money(b.net_sales), b.pct_of_sales === null || b.pct_of_sales === undefined ? '<span class="muted">—</span>' : b.pct_of_sales + '%'])) +
      '<p class="muted" style="margin-bottom:0;">Gross sales are the POS sales of the same dates, shown for comparison only — expenses never reduce them.</p></div>';
  }

  async function transportView() {
    const r = await bcReportTransport(st.from, st.to, branchId());
    const t = r.totals;
    const maxType = Math.max(1, ...r.by_type.map((d) => num(d.amount)));
    current = { filename: 'transportation-' + st.from + '-to-' + st.to + '.csv', headers: ['ID', 'Date', 'Branch', 'Type', 'From', 'To', 'Purpose', 'Amount', 'Paid from', 'Spent by', 'Status', 'Receipt'],
      rows: r.rows.map((x) => [x.id, x.date, x.branch, x.type, x.from || '', x.to || '', x.purpose || '', x.amount, x.paid_from, x.spent_by || '', x.status, x.receipt]) };
    return '<h3 style="margin-top:0;">Transportation report — ' + esc(rangeText()) + ' <span class="muted" style="font-weight:normal;">· ' + esc(scopeText()) + '</span></h3>' +
      '<div class="lw-cards bc-cards">' + cardHtml({ label: 'Total transportation', value: money(t.amount), sub: t.count + ' trip' + (t.count === 1 ? '' : 's') }) + cardHtml({ label: 'Without a receipt', value: String(t.no_receipt), tone: t.no_receipt ? 'warn' : '' }) + '</div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">By type</h3>' + (r.by_type.length ? table(['Type', '#', 'Total'], r.by_type.map((d) => [esc(d.type), d.count, barHtml(d.amount, maxType, money(d.amount))])) : '<p class="muted">No transportation expenses in this range.</p>') + '</div>' +
      '<div class="card"><h3 style="margin-top:0;">By branch</h3>' + (r.by_branch.length ? table(['Branch', '#', 'Total'], r.by_branch.map((d) => [esc(d.branch), d.count, money(d.amount)])) : '<p class="muted">—</p>') + '</div></div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">By person</h3>' + (r.by_person.length ? table(['Person', '#', 'Total'], r.by_person.map((d) => [esc(d.person), d.count, money(d.amount)])) : '<p class="muted">—</p>') + '</div>' +
      '<div class="card"><h3 style="margin-top:0;">Most used routes</h3>' + (r.by_route.length ? table(['From', 'To', '#', 'Total'], r.by_route.map((d) => [esc(d.from || '—'), esc(d.to || '—'), d.count, money(d.amount)])) : '<p class="muted">No routes were written down.</p>') + '</div></div>' +
      '<div class="card"><h3 style="margin-top:0;">The trips</h3>' + (r.rows.length ? table(['Date', 'Branch', 'Type', 'From → To', 'Purpose', 'Amount', 'By', 'Receipt'], r.rows.slice(0, 300).map((x) => [esc(fmtDate(x.date)), esc(x.branch), esc(x.type), esc((x.from || '—') + ' → ' + (x.to || '—')), esc(x.purpose || ''), '<b>' + money(x.amount) + '</b>', esc(x.spent_by || '—'), receiptBadge(x.receipt) || '—'])) : '<p class="muted">Nothing in this range.</p>') + '</div>';
  }

  async function pettyView() {
    if (!app.can.view_petty) return '<div class="empty-state"><div class="empty-state-msg">The petty cash report is for the people who can see petty cash.</div></div>';
    const r = await bcReportPetty(st.from, st.to, branchId());
    const max = Math.max(1, ...r.by_category.map((d) => num(d.amount)));
    current = { filename: 'petty-cash-' + st.from + '-to-' + st.to + '.csv', headers: ['Entry', 'Date', 'Fund', 'Branch', 'Type', 'Amount', 'Balance before', 'Balance after', 'Category', 'Details', 'Person', 'Reference'],
      rows: r.rows.map((x) => [x.id, x.date, x.fund, x.branch, x.type, x.amount, x.balance_before, x.balance_after, x.category || '', x.description || '', x.employee || '', x.reference || '']) };
    return '<h3 style="margin-top:0;">Petty cash report — ' + esc(rangeText()) + ' <span class="muted" style="font-weight:normal;">· ' + esc(scopeText()) + '</span></h3><div class="card">' +
      (r.funds.length ? table(['Fund', 'Custodian', 'Start', 'Added', 'Spent', 'Returned', 'Adjusted', 'End', 'Now', 'Out as advances', 'Missing receipts'],
        r.funds.map((f) => [esc(f.fund) + '<div class="muted">' + esc(f.branch) + '</div>', esc(f.custodian || '—'), money(f.opening), money(num(f.opened) + num(f.replenished)), '<b>' + money(f.used) + '</b> <span class="muted">(' + f.count_used + ')</span>', money(f.returned), signed(f.adjusted), money(f.closing), '<b>' + money(f.current_balance) + '</b>', money(f.unliquidated), String(f.pending_receipts)])) : '<p class="muted">No petty cash fund.</p>') + '</div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">Spent by category</h3>' + (r.by_category.length ? table(['Category', '#', 'Total'], r.by_category.map((d) => [esc(d.category), d.count, barHtml(d.amount, max, money(d.amount))])) : '<p class="muted">Nothing spent in this range.</p>') + '</div><div></div></div>' +
      '<div class="card"><h3 style="margin-top:0;">Every movement</h3>' + (r.rows.length ? table(['Date', 'Fund', 'Type', 'Amount', 'Before', 'After', 'Details'], r.rows.slice(0, 300).map((x) => [esc(fmtDate(x.date)), esc(x.fund), esc(String(x.type).replace('PETTY_CASH_', '').toLowerCase()), '<b class="' + (num(x.amount) < 0 ? 'bc-neg' : 'bc-pos-amt') + '">' + signed(x.amount) + '</b>', money(x.balance_before), money(x.balance_after), esc(x.description || '')])) : '<p class="muted">No movements in this range.</p>') + '</div>';
  }

  async function auditView() {
    if (!app.can.view_reports) return '<div class="empty-state"><div class="empty-state-msg">The audit log is for the people who can see reports.</div></div>';
    const r = await bcAuditList({ branch_id: branchId(), entity_type: st.entity || null, entity_id: st.entityId || null, from: st.from, to: st.to, limit: 500 });
    current = { filename: 'branch-capital-audit-' + st.from + '-to-' + st.to + '.csv', headers: ['When', 'Who', 'Role', 'Branch', 'Record type', 'Record', 'Action', 'Reason', 'Before', 'After'],
      rows: r.rows.map((x) => [x.at, x.actor || '', x.role || '', x.branch_name || '', x.entity_type, x.entity_id, String(x.action).replace(/_/g, ' '), x.reason || '', x.old ? JSON.stringify(x.old) : '', x.new ? JSON.stringify(x.new) : '']) };
    return '<h3 style="margin-top:0;">Audit log — ' + esc(rangeText()) + ' <span class="muted" style="font-weight:normal;">· ' + esc(scopeText()) + '</span></h3><div class="card">' +
      (r.rows.length ? table(['When', 'Who', 'Branch', 'Record', 'What happened', 'Reason / change'], r.rows.map((x) => [esc(fmtStamp(x.at)), esc(x.actor || '—') + (x.role ? '<div class="muted">' + esc(x.role) + '</div>' : ''), esc(x.branch_name || '—'),
        esc(String(x.entity_type).replace(/_/g, ' ')) + ' #' + esc(x.entity_id || ''), '<b>' + esc(String(x.action).replace(/_/g, ' ')) + '</b>',
        esc(x.reason || '') + (x.new && x.new.amount !== undefined ? ' <span class="muted">' + (x.old && x.old.amount !== undefined ? money(x.old.amount) + ' → ' : '') + money(x.new.amount) + '</span>' : '')])) + (r.rows.length >= 500 ? '<p class="muted">Showing the latest 500. Narrow the dates to see older ones.</p>' : '') : '<p class="muted">No audit entries match.</p>') + '</div>';
  }

  return { refresh, onShow: refresh };
}
