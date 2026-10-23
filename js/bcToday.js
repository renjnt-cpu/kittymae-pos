// Branch Capital -- TODAY: the "attention needed" list, the cards of the day (opening cash, sales, expenses from sales, bills, petty cash, cash for deposit, expected cash, unverified expenses,
// pending reimbursements), the sales-and-expenses statement, the cash position and the day as a timeline. For all branches: one line per branch.
// Gross sales are shown as recorded and are never reduced by an expense; an expense is its own cash-out line.
import { esc } from './shell.js?v=20261023b';
import { branchBadge } from './branchColors.js?v=20261023b';
import { bcOverview, bcTimeline, bcAttention, bcBranchesSummary } from './bcApi.js?v=20261023b';
import { money, minus, signed, fmtDate, cardHtml, badge, ageText, statusBadge, num } from './bcFormat.js?v=20261023b';
import { openExpenseForm } from './bcExpenses.js?v=20261023b';

const SEVERITY_TONE = { critical: 'bad', warning: 'warn', info: 'info' };

/** One line of the attention list; clicking it opens the thing it is about. */
function itemHtml(app, it, i) {
  return '<button type="button" class="ops-attn-item tone-' + (SEVERITY_TONE[it.severity] || 'info') + '" data-i="' + i + '">' +
    '<span class="ops-attn-dot"></span><span class="ops-attn-text"><b>' + esc(it.title) + '</b>' + (it.detail ? ' — ' + esc(it.detail) : '') +
    (it.amount !== null && it.amount !== undefined ? ' <b>' + money(it.amount) + '</b>' : '') + (it.age_days > 0 && it.kind !== 'negative_cash' ? ' <span class="muted">· ' + esc(ageText(it.age_days)) + '</span>' : '') + '</span>' +
    (it.branch_name && app.state.branch === 'all' ? '<span class="ops-attn-branch">' + esc(it.branch_name) + '</span>' : '') + '<span class="ops-attn-go">›</span></button>';
}

/** Opens what an attention line is about. */
export function openAttention(app, it) {
  const target = { branch: it.branch_id };
  switch (it.ref_type) {
    case 'expense': return app.openExpense(it.ref_id);
    case 'petty_fund': case 'replenishment': case 'advance': return app.go('petty', target);
    case 'reconciliation': return app.go('cash', Object.assign({ date: it.date }, target));
    case 'capital': return app.go('entries', target);
    case 'branch': return it.kind === 'high_day' ? app.go('expenses', target) : app.go('cash', target);
    default: return app.go('today', target);
  }
}

export function attentionHtml(app, data, limit) {
  const items = (data && data.items) || [];
  const head = '<div class="ops-attn-head"><b>BRANCH CAPITAL — ATTENTION NEEDED</b>' + (items.length ? ' ' + badge(items.length + ' item' + (items.length === 1 ? '' : 's'), data.critical ? 'red' : 'yellow') : '') + '</div>';
  if (!items.length) return '<div class="card bc-attn">' + head + '<div class="ops-attn-clear">Nothing needs attention right now.</div></div>';
  const shown = limit ? items.slice(0, limit) : items;
  return '<div class="card bc-attn">' + head + '<div class="ops-attn-list">' + shown.map((it, i) => itemHtml(app, it, i)).join('') + '</div>' +
    (limit && items.length > limit ? '<button type="button" class="btn small secondary" data-attn-all style="margin-top:8px;">Show all ' + items.length + '</button>' : '') + '</div>';
}
export function wireAttention(app, host, data, rerender) {
  host.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => openAttention(app, data.items[Number(b.dataset.i)])));
  const all = host.querySelector('[data-attn-all]');
  if (all) all.addEventListener('click', rerender);
}

/** The cash position of the day: opening + cash in - cash out = expected cash (and what was counted, if the day is closed). */
export function cashPositionHtml(o) {
  const ins = (o.lines || []).filter((l) => l.dir === 'in');
  const outs = (o.lines || []).filter((l) => l.dir === 'out');
  const row = (l, sign) => '<tr><td>' + esc(l.label) + (l.count > 1 ? ' <span class="muted">(' + l.count + ')</span>' : '') + '</td><td class="num ' + (sign < 0 ? 'bc-neg' : '') + '">' + (sign < 0 ? '−' : '+') + money(l.amount).replace('−', '') + '</td></tr>';
  if (o.opening === null || o.opening === undefined) return '';
  const rc = o.recon;
  return '<table class="bc-mini bc-pos"><tbody>' +
    '<tr><td><b>Opening cash</b> <span class="muted">(' + esc(o.opening_basis || '') + ')</span></td><td class="num"><b>' + money(o.opening) + '</b></td></tr>' +
    '<tr class="bc-sub"><td colspan="2">Cash in</td></tr>' + (ins.length ? ins.map((l) => row(l, 1)).join('') : '<tr><td class="muted">Nothing yet</td><td></td></tr>') +
    '<tr class="bc-tot"><td>Total cash in</td><td class="num">' + money(o.cash_in) + '</td></tr>' +
    '<tr class="bc-sub"><td colspan="2">Cash out</td></tr>' + (outs.length ? outs.map((l) => row(l, -1)).join('') : '<tr><td class="muted">Nothing yet</td><td></td></tr>') +
    '<tr class="bc-tot"><td>Total cash out</td><td class="num">' + minus(o.cash_out) + '</td></tr>' +
    '<tr class="bc-grand"><td>Expected cash in the till</td><td class="num">' + money(o.expected_cash) + '</td></tr>' +
    (rc ? '<tr><td>Counted cash <span class="muted">(' + esc(rc.status) + ')</span></td><td class="num">' + money(rc.actual_cash) + '</td></tr>' +
      '<tr><td>' + (num(rc.variance) < 0 ? 'Short' : num(rc.variance) > 0 ? 'Over' : 'Difference') + '</td><td class="num ' + (num(rc.variance) !== 0 ? 'bc-neg' : '') + '">' + (num(rc.variance) === 0 ? money(0) : signed(rc.variance)) + '</td></tr>' : '') +
    '</tbody></table>';
}

function statementHtml(o) {
  const s = o.sales || {};
  const c = o.cards || {};
  const fromSales = num(c.expenses_from_sales), bills = num(c.bills_paid);
  const netCash = num(s.cash) - fromSales - bills;
  return '<table class="bc-mini bc-pos"><tbody>' +
    '<tr><td><b>Gross sales</b> <span class="muted">(POS, after discounts)</span></td><td class="num"><b>' + money(s.net) + '</b></td></tr>' +
    '<tr><td class="bc-ind">Cash collected</td><td class="num">' + money(s.cash) + '</td></tr>' +
    '<tr><td class="bc-ind">Non-cash collected (GCash, terminal, bank…)</td><td class="num">' + money(s.non_cash) + '</td></tr>' +
    '<tr><td>Less: expenses paid from daily sales / cash</td><td class="num bc-neg">' + minus(fromSales) + '</td></tr>' +
    '<tr><td>Less: bills paid from branch cash</td><td class="num bc-neg">' + minus(bills) + '</td></tr>' +
    '<tr class="bc-grand"><td>Net cash available from today\'s cash sales</td><td class="num">' + money(netCash) + '</td></tr>' +
    '</tbody></table><p class="muted" style="margin:6px 0 0;">Gross sales stay exactly as recorded. An expense is a separate cash-out entry — it never lowers the sales figure.</p>';
}

function timelineHtml(app, t) {
  if (!t) return '';
  const time = (s) => String(s || '').slice(0, 5);
  const rows = (t.items || []).map((it) => {
    if (it.type === 'summary') return '<li class="bc-tl-sum"><span class="bc-tl-time"></span><span class="bc-tl-main">' + esc(it.title) + '</span><span class="bc-tl-amt ' + (num(it.till) < 0 ? 'bc-neg' : 'bc-pos-amt') + '">' + signed(it.till) + '</span></li>';
    if (it.type === 'expense') {
      const till = num(it.till);
      return '<li class="bc-tl-click" tabindex="0" data-exp="' + it.ref_id + '"><span class="bc-tl-time">' + esc(time(it.at)) + '</span><span class="bc-tl-main">' + esc(it.title) + '<div class="muted">' + money(it.total) + (it.funding ? ' · ' + esc(it.funding) : '') + ' ' + statusBadge(it.status) + '</div></span>' +
        '<span class="bc-tl-amt ' + (till ? 'bc-neg' : 'muted') + '">' + (till ? '−' + money(till).replace('−', '') : 'not from the till') + '</span></li>';
    }
    if (it.type === 'movement') return '<li><span class="bc-tl-time">' + esc(time(it.at)) + '</span><span class="bc-tl-main">' + esc(it.title) + '</span><span class="bc-tl-amt ' + (num(it.till) < 0 ? 'bc-neg' : 'bc-pos-amt') + '">' + signed(it.till) + '</span></li>';
    return '<li class="bc-tl-petty"><span class="bc-tl-time">' + esc(time(it.at)) + '</span><span class="bc-tl-main">' + esc(it.title) + '</span><span class="bc-tl-amt muted">' + signed(it.petty_amount) + ' · left ' + money(it.petty_balance_after) + '</span></li>';
  }).join('');
  const closing = t.closing;
  return '<ul class="bc-tl2">' +
    '<li class="bc-tl-edge"><span class="bc-tl-time">Open</span><span class="bc-tl-main">Opening cash</span><span class="bc-tl-amt">' + (t.opening === null || t.opening === undefined ? '—' : money(t.opening)) + '</span></li>' +
    (rows || '<li class="muted"><span class="bc-tl-time"></span><span class="bc-tl-main">No cash events recorded for this day.</span></li>') +
    (closing ? '<li class="bc-tl-edge"><span class="bc-tl-time">Close</span><span class="bc-tl-main">Counted ' + money(closing.actual_cash) + ' (expected ' + money(closing.expected_cash) + ') ' + statusBadge(closing.status) + '</span><span class="bc-tl-amt ' + (num(closing.variance) ? 'bc-neg' : '') + '">' + (num(closing.variance) ? signed(closing.variance) : 'no difference') + '</span></li>' : '') +
    '</ul>';
}

export function startToday(app) {
  const root = app.root('today');
  let seq = 0;
  let showAll = false;

  async function refresh() {
    const my = ++seq;
    root.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (app.state.branch === 'all') await renderAll(my); else await renderBranch(my);
    } catch (err) { if (my === seq) root.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; }
  }

  async function renderAll(my) {
    const [sum, att] = await Promise.all([bcBranchesSummary(app.state.date), bcAttention(null)]);
    if (my !== seq) return;
    const rows = sum.rows || [];
    const tot = rows.reduce((a, r) => ({ net: a.net + num(r.net_sales), cash: a.cash + num(r.cash_sales), exp: a.exp + num(r.expenses_total), fs: a.fs + num(r.expenses_from_sales), petty: a.petty + num(r.petty_remaining), exp_cash: a.exp_cash + (r.expected_cash === null || r.expected_cash === undefined ? 0 : num(r.expected_cash)) }), { net: 0, cash: 0, exp: 0, fs: 0, petty: 0, exp_cash: 0 });
    const dayBadge = (r) => r.state === 'no_book' ? badge('Cash book not started', 'gray') : r.state === 'before_book' ? badge('Before the book', 'gray') : r.recon_status ? statusBadge(r.recon_status) : badge('Open', 'yellow');
    root.innerHTML =
      attentionHtml(app, att, showAll ? 0 : 8) +
      '<div class="card"><h3 style="margin-top:0;">All branches — ' + esc(fmtDate(app.state.date)) + '</h3><div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Branch</th><th>Gross sales</th><th>Cash sales</th><th>Expenses</th><th>From sales cash</th><th>Petty cash left</th><th>Expected cash</th><th>Day</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="bc-row" tabindex="0" data-branch="' + r.branch_id + '"><td data-label="Branch">' + branchBadge(esc, r.branch_name, r.branch_id, app.branchList) + '</td>' +
        '<td data-label="Gross sales">' + money(r.net_sales) + '</td><td data-label="Cash sales">' + money(r.cash_sales) + '</td>' +
        '<td data-label="Expenses">' + money(r.expenses_total) + (r.expenses_count ? ' <span class="muted">(' + r.expenses_count + ')</span>' : '') + '</td><td data-label="From sales cash">' + money(r.expenses_from_sales) + '</td>' +
        '<td data-label="Petty cash left">' + (num(r.petty_authorized) ? money(r.petty_remaining) : '<span class="muted">no fund</span>') + '</td>' +
        '<td data-label="Expected cash">' + (r.expected_cash === null || r.expected_cash === undefined ? '<span class="muted">—</span>' : '<b' + (num(r.expected_cash) < 0 ? ' class="bc-neg"' : '') + '>' + money(r.expected_cash) + '</b>') + '</td>' +
        '<td data-label="Day">' + dayBadge(r) + (r.variance !== null && r.variance !== undefined && num(r.variance) !== 0 ? ' <span class="bc-neg">' + signed(r.variance) + '</span>' : '') + '</td></tr>').join('') +
      '<tr class="bc-total"><td data-label="Branch"><b>All branches</b></td><td data-label="Gross sales"><b>' + money(tot.net) + '</b></td><td data-label="Cash sales"><b>' + money(tot.cash) + '</b></td><td data-label="Expenses"><b>' + money(tot.exp) + '</b></td><td data-label="From sales cash"><b>' + money(tot.fs) + '</b></td><td data-label="Petty cash left"><b>' + money(tot.petty) + '</b></td><td data-label="Expected cash"><b>' + money(tot.exp_cash) + '</b></td><td></td></tr>' +
      '</tbody></table></div><p class="muted" style="margin-bottom:0;">Choose a branch above (or tap a row) to see its cards, cash position and timeline. Expected cash counts only the branches whose cash book has been started.</p></div>';
    wireAttention(app, root, att, () => { showAll = true; refresh(); });
    root.querySelectorAll('[data-branch]').forEach((tr) => {
      const go = () => app.setBranch(Number(tr.dataset.branch));
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  }

  async function renderBranch(my) {
    const b = app.state.branch, date = app.state.date;
    const [o, tl, att] = await Promise.all([bcOverview(b, date), bcTimeline(b, date).catch(() => null), bcAttention(b)]);
    if (my !== seq) return;
    const c = o.cards || {}, s = o.sales || {};
    const hasFund = num(c.petty_authorized) > 0;
    const lowFund = (o.funds || []).some((f) => f.low);
    const cards = [
      cardHtml({ label: 'Opening cash', value: o.opening === null || o.opening === undefined ? '—' : money(o.opening), sub: o.opening === null || o.opening === undefined ? 'cash book not started' : esc(o.opening_basis || '') }),
      cardHtml({ label: 'Gross sales', value: money(s.net), sub: 'POS, never reduced by expenses' }),
      cardHtml({ label: 'Cash sales', value: money(s.cash), sub: 'non-cash ' + money(s.non_cash) }),
      cardHtml({ label: 'Expenses from sales', value: money(c.expenses_from_sales), sub: 'taken from daily sales / cash', tone: num(c.expenses_from_sales) > 0 ? 'warn' : '' }),
      cardHtml({ label: 'Bills paid from branch cash', value: money(c.bills_paid) }),
    ];
    if (num(c.expenses_from_capital) > 0) cards.push(cardHtml({ label: 'Expenses from capital', value: money(c.expenses_from_capital) }));
    if (app.can.view_petty) {
      if (hasFund) {
        cards.push(cardHtml({ label: 'Petty cash fund', value: money(c.petty_authorized), sub: 'authorized' }));
        cards.push(cardHtml({ label: 'Petty cash used', value: money(c.petty_used), sub: 'today' }));
        cards.push(cardHtml({ label: 'Petty cash remaining', value: money(c.petty_remaining), sub: lowFund ? 'LOW PETTY CASH' : 'in the fund', tone: lowFund ? 'bad' : '' }));
      } else cards.push(cardHtml({ label: 'Petty cash', value: 'No fund', sub: 'none set up for this branch' }));
    }
    cards.push(
      cardHtml({ label: 'Cash for deposit', value: o.cash_before_deposit === null || o.cash_before_deposit === undefined ? '—' : money(o.cash_before_deposit), sub: 'deposited today ' + money(c.deposits) }),
      cardHtml({ label: 'Expected cash', value: o.expected_cash === null || o.expected_cash === undefined ? '—' : money(o.expected_cash), sub: 'what should be in the till', tone: num(o.expected_cash) < 0 ? 'bad' : '' }),
      cardHtml({ label: 'Unverified expenses', value: String((c.unverified_expenses || {}).count || 0), sub: money((c.unverified_expenses || {}).amount) + ' waiting', tone: ((c.unverified_expenses || {}).count || 0) > 0 ? 'warn' : '' }),
      cardHtml({ label: 'Pending reimbursements', value: String((c.pending_reimbursements || {}).count || 0), sub: money((c.pending_reimbursements || {}).amount) + ' owed to staff', tone: ((c.pending_reimbursements || {}).count || 0) > 0 ? 'warn' : '' }));

    const banner = o.state === 'no_book'
      ? '<div class="msg error"><b>The cash book for ' + esc(o.branch_name) + ' has not been started.</b> Expected cash needs a starting point — the cash that was in the till on a chosen day. Sales and expenses below are still real; they just have no opening balance yet. ' +
        (app.can.manage ? '<button type="button" class="btn small" data-go="cash">Start the cash book</button>' : 'Ask an Admin to start it.') + '</div>'
      : o.state === 'before_book' ? '<div class="msg error">This day is before the cash book started (' + esc(fmtDate((o.book || {}).start_date)) + '), so there is no opening cash for it.</div>' : '';

    root.innerHTML =
      '<div class="bc-day-head"><div><h2 style="margin:0;">' + esc(o.branch_name) + '</h2><div class="muted">' + esc(fmtDate(o.date)) + (o.day_closed ? ' · ' + (o.recon ? statusBadge(o.recon.status) : badge('Closed', 'blue')) : '') + '</div></div>' +
        '<div class="bc-actions">' + (app.can.add_expense ? '<button type="button" class="btn" data-act="expense">+ Add Expense</button>' : '') +
        (app.can.add_expense ? '<button type="button" class="btn secondary" data-go="cash-move">Deposit / cash movement</button>' : '') +
        (app.can.close_daily ? '<button type="button" class="btn secondary" data-go="cash">Count & close the day</button>' : '') + '</div></div>' +
      banner + attentionHtml(app, att, showAll ? 0 : 6) +
      '<div class="lw-cards bc-cards">' + cards.join('') + '</div>' +
      '<div class="bc-two"><div class="card"><h3 style="margin-top:0;">Sales and expenses</h3>' + statementHtml(o) + '</div>' +
      '<div class="card"><h3 style="margin-top:0;">Cash position of the day</h3>' + (cashPositionHtml(o) || '<p class="muted">Start the cash book to see the opening cash, the cash in and out, and the expected cash.</p>') + '</div></div>' +
      '<div class="card"><h3 style="margin-top:0;">The day, in order</h3>' + timelineHtml(app, tl) + '</div>';

    wireAttention(app, root, att, () => { showAll = true; refresh(); });
    root.querySelectorAll('[data-act="expense"]').forEach((x) => x.addEventListener('click', () => openExpenseForm(app)));
    root.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => app.go('cash', x.dataset.go === 'cash-move' ? { action: 'movement' } : {})));
    root.querySelectorAll('[data-exp]').forEach((li) => {
      const open = () => app.openExpense(Number(li.dataset.exp));
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  return { refresh, onShow: refresh };
}
