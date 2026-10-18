// Branch Capital -- DAILY CASH: the cash book of a branch (the cash in the till on the day it was started), the day's expected cash, counting the cash and closing the day
// (expected vs counted, over / short, a reason when the difference is bigger than the limit, prepared / checked / approved), deposits and other cash movements, and the history of counted days.
// Closing a day locks it (and the days before it): nothing new can be dated on or before a closed day until a manager reopens it, and the reopening is kept in the history.
import { esc, toast } from './shell.js?v=20261018a';
import { reasonDialog } from './dialogs.js?v=20261018a';
import {
  bcOverview, bcBookSet, bcMovementSave, bcMovementVoid, bcMovementsList, bcReconClose, bcReconCheck, bcReconApprove, bcReconReopen, bcReconsList, uploadReceipt, RECEIPT_ACCEPT, checkReceiptFile,
} from './bcApi.js?v=20261018a';
import { formDialog, openDrawer } from './bcUi.js?v=20261018a';
import { money, signed, fmtDate, fmtStamp, addDays, MOVEMENT_KINDS, optionsHtml, statusBadge, badge, kv, errorsText, num } from './bcFormat.js?v=20261018a';
import { cashPositionHtml } from './bcToday.js?v=20261018a';

const MOVE_CHOICES = [['DEPOSIT', 'Bank deposit (cash leaves the till)'], ['REMITTANCE', 'Remittance (cash leaves the till)'], ['OTHER_CASH_OUT', 'Other cash out'], ['OTHER_CASH_IN', 'Other cash in']];

export function startCash(app) {
  const root = app.root('cash');
  let seq = 0;
  let pending = null;   // an action asked for by another tab (e.g. "record a deposit")

  async function refresh() {
    const my = ++seq;
    if (app.state.branch === 'all') {
      root.innerHTML = '<div class="card"><h3 style="margin-top:0;">Daily cash</h3><p>Choose a branch to count its cash, close its day, or record a deposit.</p><div class="bc-branch-pick">' +
        app.branches.map((b) => '<button type="button" class="btn secondary" data-branch="' + b.id + '">' + esc(b.name) + '</button>').join('') + '</div></div>';
      root.querySelectorAll('[data-branch]').forEach((b) => b.addEventListener('click', () => app.setBranch(Number(b.dataset.branch))));
      return;
    }
    root.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const b = app.state.branch, date = app.state.date;
      const [o, recs, moves] = await Promise.all([bcOverview(b, date), bcReconsList(b, addDays(app.ctx.today, -60), app.ctx.today), bcMovementsList(b, addDays(app.ctx.today, -30), app.ctx.today)]);
      if (my !== seq) return;
      render(o, recs.rows || [], moves.rows || []);
      if (pending === 'movement') { pending = null; movementDialog(); }
    } catch (err) { if (my === seq) root.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; }
  }

  function bookCard(o) {
    if (o.state === 'no_book') {
      return '<div class="card"><h3 style="margin-top:0;">Start the cash book</h3><p>Expected cash needs a starting point. Count the cash in the till <b>today</b> (or on the day you want to start from) and enter it here. From then on the system adds the cash sales and subtracts the expenses, deposits and other cash out, so you can compare it with the real count each day.</p>' +
        (app.can.manage ? '<form id="bk-form" class="bc-form-grid"><div class="field"><label for="bk-date">Starting day</label><input type="date" id="bk-date" max="' + app.ctx.today + '" value="' + app.ctx.today + '"></div>' +
          '<div class="field"><label for="bk-open">Cash in the till at the start (₱) *</label><input type="number" id="bk-open" step="0.01" min="0" inputmode="decimal"></div>' +
          '<div class="field bc-span2"><label for="bk-note">Note</label><input type="text" id="bk-note" placeholder="e.g. counted by Ren and Carmel"></div><div class="bc-span2"><button type="submit" class="btn">Start the cash book</button></div></form>' : '<p class="muted">Only an Admin can start it.</p>') + '</div>';
    }
    const bk = o.book;
    return '<div class="card"><div class="bc-toolbar"><div><b>Cash book</b> <span class="muted">— started ' + esc(fmtDate(bk.start_date)) + ' with ' + money(bk.opening_cash) + (bk.note ? ' · ' + esc(bk.note) : '') + '</span></div><span class="bc-grow"></span>' +
      (app.can.manage ? '<button type="button" class="btn small secondary" id="bk-change">Change the start…</button>' : '') + '</div></div>';
  }

  function closeCard(o) {
    if (o.state !== 'ready') return o.state === 'before_book' ? '<div class="msg error">This day is before the cash book started, so it cannot be counted.</div>' : '';
    const rc = o.recon;
    if (rc) {
      const lvl = app.ctx.me.level;
      const act = [];
      if (rc.status === 'Closed' && app.can.close_daily) act.push('<button type="button" class="btn" data-r="check" data-id="' + rc.id + '">Check this count</button>');
      if (['Closed', 'Checked'].includes(rc.status) && app.can.approve_expense && lvl >= 2) act.push('<button type="button" class="btn" data-r="approve" data-id="' + rc.id + '">Approve the day</button>');
      if (['Closed', 'Checked', 'Approved'].includes(rc.status) && app.can.manage) act.push('<button type="button" class="btn secondary danger" data-r="reopen" data-id="' + rc.id + '">Reopen the day…</button>');
      return '<div class="card"><h3 style="margin-top:0;">The count — ' + esc(fmtDate(rc.business_date)) + ' ' + statusBadge(rc.status) + '</h3>' +
        kv('Expected cash', money(rc.expected_cash)) + kv('Counted cash', '<b>' + money(rc.actual_cash) + '</b>') +
        kv('Difference', '<b class="' + (num(rc.variance) ? 'bc-neg' : '') + '">' + (num(rc.variance) ? signed(rc.variance) + (num(rc.variance) < 0 ? ' (short)' : ' (over)') : 'none') + '</b>') +
        (rc.variance_reason ? kv('Reason given', esc(rc.variance_reason)) : '') + (rc.notes ? kv('Notes', esc(rc.notes)) : '') +
        (act.length ? '<div class="bc-dr-actions">' + act.join('') + '</div>' : '') +
        '<p class="muted" style="margin-bottom:0;">This day and the days before it are locked. Reopening needs a reason and is kept in the history.</p></div>';
    }
    if (!app.can.close_daily) return '<div class="card"><h3 style="margin-top:0;">Count the cash</h3><p class="muted">You can see the expected cash but you do not have the permission to close the day.</p></div>';
    const un = (o.cards || {}).unverified_expenses || {};
    return '<div class="card"><h3 style="margin-top:0;">Count the cash and close ' + esc(fmtDate(o.date)) + '</h3>' +
      '<p class="muted">Count what is physically in the till (after any deposits), type it here, and the system compares it with the expected cash of <b>' + money(o.expected_cash) + '</b>.</p>' +
      (un.count ? '<div class="bc-note" style="margin:0 0 10px;">' + un.count + ' expense' + (un.count === 1 ? ' is' : 's are') + ' still waiting for approval or a receipt (' + money(un.amount) + '). You can still close the day; they stay on the attention list.</div>' : '') +
      '<form id="cl-form" class="bc-form-grid"><div class="field"><label for="cl-actual">Counted cash (₱) *</label><input type="number" id="cl-actual" step="0.01" min="0" inputmode="decimal"></div>' +
      '<div class="field"><label>Difference</label><div id="cl-diff" class="bc-diff muted">Type the count</div></div>' +
      '<div class="field bc-span2" id="cl-reason-f" hidden><label for="cl-reason">Why is it different? *</label><input type="text" id="cl-reason" placeholder="Required when the difference is more than ' + money(app.ctx.settings.variance_reason_above) + '"></div>' +
      '<div class="field bc-span2"><label for="cl-notes">Notes</label><input type="text" id="cl-notes"></div><div id="cl-err" class="dlg-err bc-span2" hidden></div>' +
      '<div class="bc-span2"><button type="submit" class="btn">Close the day</button></div></form></div>';
  }

  function movementsCard(moves) {
    return '<div class="card"><div class="bc-toolbar"><h3 style="margin:0;">Deposits and other cash movements <span class="muted" style="font-weight:normal;">— last 30 days</span></h3><span class="bc-grow"></span>' +
      (app.can.add_expense ? '<button type="button" class="btn" id="mv-add">+ Record a deposit / movement</button>' : '') + '</div>' +
      (moves.length ? '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>To / from</th><th>Reference</th><th>Status</th><th></th></tr></thead><tbody>' + moves.map((m) => {
        const inn = ['OTHER_CASH_IN', 'PETTY_RETURN'].includes(m.kind);
        return '<tr class="' + (m.status === 'Voided' ? 'bc-void' : '') + '"><td data-label="Date">' + esc(fmtDate(m.date)) + '</td><td data-label="What">' + esc(MOVEMENT_KINDS[m.kind] || m.kind) + (m.description ? '<div class="muted">' + esc(m.description) + '</div>' : '') + '</td>' +
          '<td data-label="Amount" class="' + (inn ? 'bc-pos-amt' : 'bc-neg') + '"><b>' + (inn ? '+' : '−') + money(m.amount).replace('−', '') + '</b></td><td data-label="To / from">' + esc(m.counterpart || '—') + '</td><td data-label="Reference">' + esc(m.reference || '—') + (m.attachments ? ' <span class="muted">📎' + m.attachments + '</span>' : '') + '</td>' +
          '<td data-label="Status">' + statusBadge(m.status) + (m.void_reason ? '<div class="muted">' + esc(m.void_reason) + '</div>' : '') + '</td>' +
          '<td data-label="Actions" class="full-row">' + (m.status === 'Recorded' && app.can.approve_expense && !['PETTY_FUNDING', 'PETTY_RETURN'].includes(m.kind) ? '<button type="button" class="btn small secondary" data-void="' + m.id + '">Void…</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted">No deposits or cash movements in the last 30 days.</p>') + '</div>';
  }

  function historyCard(rows) {
    return '<div class="card"><h3 style="margin-top:0;">Counted days <span class="muted" style="font-weight:normal;">— last 60 days</span></h3>' +
      (rows.length ? '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Day</th><th>Expected</th><th>Counted</th><th>Difference</th><th>Status</th><th>Counted by</th><th></th></tr></thead><tbody>' + rows.map((r) =>
        '<tr class="bc-row' + (r.status === 'Reopened' ? ' bc-void' : '') + '" tabindex="0" data-rec="' + r.id + '"><td data-label="Day">' + esc(fmtDate(r.date)) + '</td><td data-label="Expected">' + money(r.expected_cash) + '</td><td data-label="Counted"><b>' + money(r.actual_cash) + '</b></td>' +
        '<td data-label="Difference" class="' + (num(r.variance) ? 'bc-neg' : '') + '">' + (num(r.variance) ? signed(r.variance) : '—') + '</td><td data-label="Status">' + statusBadge(r.status) + '</td>' +
        '<td data-label="Counted by">' + esc(r.prepared_by || '—') + (r.approved_by ? '<div class="muted">approved by ' + esc(r.approved_by) + '</div>' : r.checked_by ? '<div class="muted">checked by ' + esc(r.checked_by) + '</div>' : '') + '</td><td data-label="" class="full-row"><span class="act-link">Details ›</span></td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No days have been counted yet.</p>') + '</div>';
  }

  function render(o, recs, moves) {
    root.innerHTML = '<div class="bc-day-head"><div><h2 style="margin:0;">' + esc(o.branch_name) + '</h2><div class="muted">' + esc(fmtDate(o.date)) + (o.day_closed ? ' · ' + (o.recon ? statusBadge(o.recon.status) : badge('Locked (a later day is closed)', 'blue')) : '') + '</div></div></div>' +
      bookCard(o) +
      (o.state === 'ready' ? '<div class="card"><h3 style="margin-top:0;">Expected cash for ' + esc(fmtDate(o.date)) + '</h3>' + cashPositionHtml(o) + '</div>' : '') +
      closeCard(o) + movementsCard(moves) + historyCard(recs);

    const bk = root.querySelector('#bk-form');
    if (bk) bk.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const res = await bcBookSet(app.state.branch, bk.querySelector('#bk-date').value, Number(bk.querySelector('#bk-open').value), bk.querySelector('#bk-note').value.trim());
        if (!res || !res.ok) throw new Error(errorsText(res));
        toast('bc-msg', 'Cash book started.'); app.refreshAll();
      } catch (err) { toast('bc-msg', err.message || String(err), true); }
    });
    const chg = root.querySelector('#bk-change');
    if (chg) chg.addEventListener('click', () => changeBook(o));

    const cl = root.querySelector('#cl-form');
    if (cl) {
      const actual = cl.querySelector('#cl-actual'), diff = cl.querySelector('#cl-diff'), rf = cl.querySelector('#cl-reason-f');
      const limit = num(app.ctx.settings.variance_reason_above);
      actual.addEventListener('input', () => {
        if (actual.value === '') { diff.textContent = 'Type the count'; diff.className = 'bc-diff muted'; rf.hidden = true; return; }
        const v = Math.round((Number(actual.value) - num(o.expected_cash)) * 100) / 100;
        diff.className = 'bc-diff ' + (v === 0 ? 'bc-pos-amt' : 'bc-neg');
        diff.textContent = v === 0 ? 'Exactly right' : signed(v) + (v < 0 ? ' short' : ' over');
        rf.hidden = Math.abs(v) <= limit;
      });
      cl.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const err = cl.querySelector('#cl-err');
        err.hidden = true;
        if (actual.value === '') { err.textContent = 'Type the counted cash.'; err.hidden = false; return; }
        try {
          const res = await bcReconClose(app.state.branch, o.date, Number(actual.value), cl.querySelector('#cl-reason').value.trim(), cl.querySelector('#cl-notes').value.trim());
          if (!res.ok) {
            if (res.code === 'VARIANCE_REASON') rf.hidden = false;
            err.textContent = errorsText(res); err.hidden = false; return;
          }
          toast('bc-msg', 'Day closed' + (num(res.variance) ? ' with a difference of ' + signed(res.variance) + '.' : ' — the count matches.')); app.refreshAll();
        } catch (e2) { err.textContent = e2.message || String(e2); err.hidden = false; }
      });
    }

    root.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => reconAction(b.dataset.r, Number(b.dataset.id))));
    const add = root.querySelector('#mv-add');
    if (add) add.addEventListener('click', movementDialog);
    root.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', async () => {
      const x = await reasonDialog({ title: 'Void this cash movement?', message: 'It stays in the list as voided and no longer counts in the expected cash.', label: 'Reason', confirmLabel: 'Void it', danger: true });
      if (!x) return;
      try { const res = await bcMovementVoid(Number(b.dataset.void), x.reason); if (!res.ok) throw new Error(errorsText(res)); toast('bc-msg', 'Movement voided.'); app.refreshAll(); }
      catch (err) { toast('bc-msg', err.message || String(err), true); }
    }));
    root.querySelectorAll('[data-rec]').forEach((tr) => {
      const open = () => showDay(recs.find((r) => String(r.id) === tr.dataset.rec));
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  async function changeBook(o) {
    const bk = o.book;
    const out = await formDialog({
      title: 'Change the cash book start', confirmLabel: 'Save',
      messageHtml: 'Only possible while no day has been counted yet. After the first count the start is fixed — corrections are made by reopening and recounting.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="cb-date">Starting day</label><input type="date" id="cb-date" max="' + app.ctx.today + '" value="' + esc(bk.start_date) + '"></div><div class="field"><label for="cb-open">Cash at the start (₱)</label><input type="number" id="cb-open" step="0.01" min="0" value="' + esc(bk.opening_cash) + '"></div>' +
        '<div class="field bc-span2"><label for="cb-note">Note</label><input type="text" id="cb-note" value="' + esc(bk.note || '') + '"></div></div>',
      onSubmit: async (form) => { const res = await bcBookSet(app.state.branch, form.querySelector('#cb-date').value, Number(form.querySelector('#cb-open').value), form.querySelector('#cb-note').value.trim()); return res && res.ok ? { close: true } : { error: errorsText(res) }; },
    });
    if (out) { toast('bc-msg', 'Cash book updated.'); app.refreshAll(); }
  }

  async function reconAction(a, id) {
    try {
      if (a === 'check') { const r = await bcReconCheck(id); if (!r.ok) throw new Error(errorsText(r)); toast('bc-msg', 'Count checked.'); }
      else if (a === 'approve') { const r = await bcReconApprove(id); if (!r.ok) throw new Error(errorsText(r)); toast('bc-msg', 'Day approved.'); }
      else if (a === 'reopen') {
        const x = await reasonDialog({ title: 'Reopen this day?', message: 'The count stays in the history as reopened. The day and the days after it can take new entries again, and it must be counted again.', label: 'Reason', confirmLabel: 'Reopen the day', danger: true });
        if (!x) return;
        const r = await bcReconReopen(id, x.reason); if (!r.ok) throw new Error(errorsText(r)); toast('bc-msg', 'Day reopened.');
      }
      app.refreshAll();
    } catch (err) { toast('bc-msg', err.message || String(err), true); }
  }

  function showDay(r) {
    if (!r) return;
    const dr = openDrawer({ label: 'Counted day' });
    const lines = r.breakdown || [];
    dr.set('<div class="bc-dr-head"><div><h2>' + esc(fmtDate(r.date)) + '</h2><div class="muted">' + esc(r.branch_name) + '</div></div><button type="button" class="btn small secondary" data-bc-close>Close ✕</button></div>' +
      '<div class="bc-badges">' + statusBadge(r.status) + '</div>' +
      '<section class="card bc-dr-sec"><h3>The count</h3>' + kv('Opening cash', money(r.opening_cash)) + kv('Cash in', money(r.cash_in)) + kv('Cash out', money(r.cash_out)) + kv('Expected', money(r.expected_cash)) + kv('Counted', '<b>' + money(r.actual_cash) + '</b>') +
        kv('Difference', '<b class="' + (num(r.variance) ? 'bc-neg' : '') + '">' + (num(r.variance) ? signed(r.variance) : 'none') + '</b>') + (r.variance_reason ? kv('Reason', esc(r.variance_reason)) : '') + (r.notes ? kv('Notes', esc(r.notes)) : '') + '</section>' +
      '<section class="card bc-dr-sec"><h3>What made up the day</h3><table class="bc-mini"><tbody>' + lines.map((l) => '<tr><td>' + esc(l.label) + (l.count > 1 ? ' <span class="muted">(' + l.count + ')</span>' : '') + '</td><td class="num ' + (l.dir === 'out' ? 'bc-neg' : '') + '">' + (l.dir === 'out' ? '−' : '+') + money(l.amount).replace('−', '') + '</td></tr>').join('') + '</tbody></table>' +
        '<p class="muted" style="margin-bottom:0;">Also on that day: cash sales ' + money(r.cash_sales) + ', non-cash sales ' + money(r.non_cash_sales) + ', expenses from sales ' + money(r.expenses_from_sales) + ', bills paid ' + money(r.bills_paid) + ', deposits ' + money(r.deposits) + ', petty cash used ' + money(r.petty_cash_used) + '.</p></section>' +
      '<section class="card bc-dr-sec"><h3>Who</h3>' + kv('Counted by', esc(r.prepared_by || '—') + ' · ' + esc(fmtStamp(r.prepared_at))) + (r.checked_by ? kv('Checked by', esc(r.checked_by)) : '') + (r.approved_by ? kv('Approved by', esc(r.approved_by)) : '') +
        (r.reopened_by ? kv('Reopened by', esc(r.reopened_by) + (r.reopen_reason ? ' — ' + esc(r.reopen_reason) : '')) : '') + '</section>');
  }

  async function movementDialog() {
    const out = await formDialog({
      title: 'Record a deposit / cash movement', confirmLabel: 'Record it', wide: true,
      messageHtml: 'Cash that leaves the till (a deposit, a remittance, other cash out) lowers the expected cash; cash that comes in (other cash in) raises it. A transfer to petty cash is done from the Petty cash tab.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="mv-kind">What *</label><select id="mv-kind">' + optionsHtml(MOVE_CHOICES, 'DEPOSIT') + '</select></div>' +
        '<div class="field"><label for="mv-amt">Amount (₱) *</label><input type="number" id="mv-amt" step="0.01" min="0.01" inputmode="decimal"></div>' +
        '<div class="field"><label for="mv-date">Date</label><input type="date" id="mv-date" max="' + app.ctx.today + '" value="' + esc(app.state.date) + '"></div>' +
        '<div class="field"><label for="mv-cp" id="mv-cp-l">Bank / account</label><input type="text" id="mv-cp" placeholder="e.g. BDO Pacific Mall"></div>' +
        '<div class="field"><label for="mv-ref">Reference / slip no.</label><input type="text" id="mv-ref"></div><div class="field"><label for="mv-desc">Details</label><input type="text" id="mv-desc"></div>' +
        '<div class="field bc-span2"><label for="mv-notes">Notes</label><input type="text" id="mv-notes"></div>' +
        '<div class="field bc-span2"><label for="mv-files">Deposit slip / proof (JPG, PNG or PDF)</label><input type="file" id="mv-files" multiple accept="' + RECEIPT_ACCEPT + '"></div></div>',
      onReady: (form) => { const k = form.querySelector('#mv-kind'); k.addEventListener('change', () => { form.querySelector('#mv-cp-l').textContent = k.value === 'DEPOSIT' ? 'Bank / account' : k.value === 'REMITTANCE' ? 'Remittance partner' : 'Who / where'; }); },
      onSubmit: async (form, ctl) => {
        const files = Array.from(form.querySelector('#mv-files').files || []);
        for (const f of files) { const bad = checkReceiptFile(f); if (bad) return { error: bad }; }
        const res = await bcMovementSave({ branch_id: app.state.branch, kind: form.querySelector('#mv-kind').value, amount: Number(form.querySelector('#mv-amt').value), movement_date: form.querySelector('#mv-date').value,
          counterpart: form.querySelector('#mv-cp').value.trim(), reference_number: form.querySelector('#mv-ref').value.trim(), description: form.querySelector('#mv-desc').value.trim(), notes: form.querySelector('#mv-notes').value.trim() });
        if (!res || !res.ok) return { error: errorsText(res) };
        const problems = [];
        for (const f of files) { try { const r = await uploadReceipt(app.state.branch, 'movement', res.id, f); if (!r || !r.ok) problems.push(f.name + ': ' + errorsText(r)); } catch (err) { problems.push(f.name + ': ' + (err.message || err)); } }
        return { close: { problems } };
      },
    });
    if (out) { toast('bc-msg', 'Recorded.' + (out.problems.length ? ' Proof upload problem: ' + out.problems.join('; ') : ''), out.problems.length > 0); app.refreshAll(); }
  }

  return {
    refresh,
    onShow: (opts) => { if (opts && opts.action === 'movement') pending = 'movement'; return refresh(); },
  };
}
