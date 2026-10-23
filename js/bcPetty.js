// Branch Capital -- PETTY CASH: the funds (custodian, authorized amount, balance, low-balance alert), opening a fund, replenishment (request -> approve -> process, never automatic),
// returning unspent cash to the till, adjustments, cash advances to staff (released, then liquidated), and the permanent ledger of every movement with the balance before and after.
// Petty cash can never go below zero. Putting cash into a fund is a transfer, not an expense — the expense happens when the fund is spent.
import { esc, toast } from './shell.js?v=20261023b';
import { reasonDialog, confirmDialog } from './dialogs.js?v=20261023b';
import { branchBadge } from './branchColors.js?v=20261023b';
import {
  bcPettyOverview, bcPettyLedger, bcPettyFundSave, bcPettyOpen, bcPettyReplenishRequest, bcPettyReplenishDecide, bcPettyReplenishProcess, bcPettyReplenishCancel,
  bcPettyReturn, bcPettyAdjust, bcPettyAdvanceRelease, bcPettyAdvanceLiquidate, bcPettyAdvanceCancel, uploadReceipt, RECEIPT_ACCEPT, checkReceiptFile,
} from './bcApi.js?v=20261023b';
import { formDialog, openDrawer } from './bcUi.js?v=20261023b';
import { money, signed, fmtDate, fmtStamp, addDays, REPLENISH_SOURCES, optionsHtml, statusBadge, badge, kv, errorsText, ageText, num } from './bcFormat.js?v=20261023b';

const fin = (res) => (!res || !res.ok)
  ? { error: res && res.code === 'INSUFFICIENT_PETTY_CASH' ? 'INSUFFICIENT PETTY CASH — ' + errorsText(res) : errorsText(res) }
  : { close: res };
const TYPE_LABEL = { PETTY_CASH_OPENING: 'Opening fund', PETTY_CASH_DISBURSEMENT: 'Spent', PETTY_CASH_REPLENISHMENT: 'Replenishment', PETTY_CASH_RETURN: 'Returned', PETTY_CASH_ADJUSTMENT: 'Adjustment', PETTY_CASH_REVERSAL: 'Reversal' };

export function startPetty(app) {
  const root = app.root('petty');
  let data = null;
  let seq = 0;

  async function refresh() {
    const my = ++seq;
    root.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const res = await bcPettyOverview(app.state.branch !== 'all' ? app.state.branch : null);
      if (my !== seq) return;
      data = res;
      render();
    } catch (err) { if (my === seq) root.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>'; }
  }
  async function done(text) {
    app.invalidateFunds();
    toast('bc-msg', text);
    await refresh();
    app.refreshOthers();
  }

  function fundCard(f) {
    const pct = num(f.authorized_amount) > 0 ? Math.max(0, Math.min(100, Math.round(num(f.current_balance) / num(f.authorized_amount) * 100))) : 0;
    const can = app.can;
    const btn = (a, label, cls) => '<button type="button" class="btn small ' + (cls || 'secondary') + '" data-a="' + a + '" data-fund="' + f.id + '">' + label + '</button>';
    const closed = f.status === 'Closed';
    return '<div class="card bc-fund' + (f.low ? ' bc-fund-low' : '') + '">' +
      '<div class="bc-fund-top"><div><b>' + esc(f.name) + '</b> ' + (app.state.branch === 'all' ? branchBadge(esc, f.branch_name, f.branch_id, app.branchList) : '') + (closed ? ' ' + badge('Closed', 'gray') : '') + '</div>' +
        (f.low ? badge('LOW PETTY CASH', 'red') : '') + '</div>' +
      '<div class="bc-fund-bal">' + money(f.current_balance) + '</div>' +
      '<div class="bc-fund-bar"><span style="width:' + pct + '%"></span></div>' +
      '<div class="muted">of ' + money(f.authorized_amount) + ' authorized · alert at ' + money(f.low_balance_threshold) + '</div>' +
      '<div class="bc-fund-kv">' + kv('Custodian', f.custodian ? esc(f.custodian) + (f.position ? ' <span class="muted">· ' + esc(f.position) + '</span>' : '') : '<span class="muted">Not set</span>') +
        kv('Suggested replenishment', money(f.suggested_replenishment)) + kv('Last replenished', f.last_replenished_at ? esc(fmtStamp(f.last_replenished_at)) : '<span class="muted">—</span>') +
        (num(f.unliquidated) > 0 ? kv('Cash advances not liquidated', '<b style="color:var(--warn)">' + money(f.unliquidated) + '</b>') : '') +
        (f.pending_receipts ? kv('Spent without a receipt yet', f.pending_receipts + ' · ' + money(f.pending_receipts_amount)) : '') + '</div>' +
      '<div class="bc-fund-actions">' +
        (!closed && !f.has_opening && can.replenish_petty ? btn('open', 'Open the fund…', '') : '') +
        (!closed && f.has_opening && can.use_petty ? btn('request', 'Request replenishment…', '') : '') +
        (!closed && f.has_opening && can.use_petty ? btn('advance', 'Release cash advance…') : '') +
        (!closed && can.replenish_petty && num(f.current_balance) > 0 ? btn('return', 'Return unspent cash…') : '') +
        (!closed && can.adjust_petty ? btn('adjust', 'Adjust…') : '') +
        btn('ledger', 'Ledger') + (can.manage ? btn('edit', 'Edit fund') : '') + '</div></div>';
  }

  function render() {
    const funds = data.funds || [];
    const reps = data.replenishments || [];
    const advs = data.advances || [];
    const open = reps.filter((r) => ['Requested', 'Approved'].includes(r.status));
    root.innerHTML =
      '<div class="bc-toolbar"><h3 style="margin:0;">Petty cash funds</h3><span class="bc-grow"></span>' + (app.can.manage ? '<button type="button" class="btn" id="bp-new">+ New petty cash fund</button>' : '') + '</div>' +
      (funds.length ? '<div class="bc-funds">' + funds.map(fundCard).join('') + '</div>' : '<div class="empty-state"><div class="empty-state-msg">No petty cash fund for ' + (app.state.branch === 'all' ? 'these branches' : 'this branch') + ' yet.' + (app.can.manage ? '' : ' Ask an Admin to set one up.') + '</div></div>') +

      '<h3>Replenishment requests</h3><p class="muted" style="margin-top:-4px;">A fund is only topped up when someone asks, someone else approves, and the money is handed over and processed. Nothing is automatic.</p>' +
      (reps.length ? '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>#</th><th>Fund</th><th>Amount</th><th>From</th><th>Asked by</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>' +
        reps.map((r) => {
          const mine = r.requested_by_id === app.ctx.me.id;
          const act = [];
          if (r.status === 'Requested' && app.can.replenish_petty) { act.push('<button type="button" class="btn small" data-r="approve" data-id="' + r.id + '">Approve</button>'); act.push('<button type="button" class="btn small secondary" data-r="reject" data-id="' + r.id + '">Reject…</button>'); }
          if (r.status === 'Approved' && app.can.replenish_petty) act.push('<button type="button" class="btn small" data-r="process" data-id="' + r.id + '">Process…</button>');
          if (['Requested', 'Approved'].includes(r.status) && (mine || app.can.replenish_petty)) act.push('<button type="button" class="btn small secondary" data-r="cancel" data-id="' + r.id + '">Cancel</button>');
          return '<tr><td data-label="#">' + r.id + '</td><td data-label="Fund">' + esc(r.fund_name) + (app.state.branch === 'all' ? '<div class="muted">' + esc(r.branch_name) + '</div>' : '') + '</td><td data-label="Amount"><b>' + money(r.amount) + '</b></td>' +
            '<td data-label="From">' + esc(r.source) + '</td><td data-label="Asked by">' + esc(r.requested_by || '—') + '</td>' +
            '<td data-label="Status">' + statusBadge(r.status) + (r.decision_note ? '<div class="muted">' + esc(r.decision_note) + '</div>' : '') + '</td>' +
            '<td data-label="When">' + esc(fmtStamp(r.requested_at)) + (r.expense_id ? '<div><button type="button" class="act-link" data-exp="' + r.expense_id + '">For expense #' + r.expense_id + '</button></div>' : '') + '</td>' +
            '<td data-label="Actions" class="full-row">' + act.join(' ') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No replenishment requests.</p>') +
      (open.length ? '' : '') +

      '<h3>Cash advances to staff</h3><p class="muted" style="margin-top:-4px;">Cash released from the fund before a purchase. When the person comes back, record what was really spent; the change goes back into the fund.</p>' +
      (advs.length ? '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Employee</th><th>Fund</th><th>Amount</th><th>For</th><th>Released</th><th>Status</th><th></th></tr></thead><tbody>' +
        advs.map((a) => '<tr><td data-label="Employee">' + esc(a.employee || '—') + '</td><td data-label="Fund">' + esc(a.fund_name) + '</td><td data-label="Amount"><b>' + money(a.amount) + '</b></td><td data-label="For">' + esc(a.purpose) + '</td>' +
          '<td data-label="Released">' + esc(fmtDate(String(a.released_at).slice(0, 10))) + (a.status === 'Pending Liquidation' ? ' <span class="muted">(' + esc(ageText(a.age_days)) + ')</span>' : '') + '</td>' +
          '<td data-label="Status">' + statusBadge(a.status) + (a.status === 'Liquidated' ? '<div class="muted">spent ' + money(a.actual_expense) + ', returned ' + money(a.returned_amount) + '</div>' : '') + '</td>' +
          '<td data-label="Actions" class="full-row">' + (a.status === 'Pending Liquidation' && app.can.use_petty ? '<button type="button" class="btn small" data-adv="liquidate" data-id="' + a.id + '">Liquidate…</button> <button type="button" class="btn small secondary" data-adv="cancel" data-id="' + a.id + '">Cancel…</button>' : '') +
            (a.expense_id ? ' <button type="button" class="act-link" data-exp="' + a.expense_id + '">Expense #' + a.expense_id + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No cash advances.</p>');

    const nb = root.querySelector('#bp-new');
    if (nb) nb.addEventListener('click', () => fundForm(null));
    root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => fundAction(b.dataset.a, funds.find((f) => String(f.id) === b.dataset.fund))));
    root.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => repAction(b.dataset.r, reps.find((r) => String(r.id) === b.dataset.id))));
    root.querySelectorAll('[data-adv]').forEach((b) => b.addEventListener('click', () => advAction(b.dataset.adv, advs.find((a) => String(a.id) === b.dataset.id))));
    root.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => app.openExpense(Number(b.dataset.exp))));
  }

  // ---- funds
  async function fundAction(a, f) {
    if (a === 'edit') return fundForm(f);
    if (a === 'open') return openFund(f);
    if (a === 'request') return requestReplenish(f);
    if (a === 'return') return returnCash(f);
    if (a === 'adjust') return adjust(f);
    if (a === 'advance') return releaseAdvance(f);
    if (a === 'ledger') return showLedger(f);
  }

  async function fundForm(f) {
    const people = app.ctx.people.map((p) => [p.id, p.name + (p.position ? ' — ' + p.position : '')]);
    const out = await formDialog({
      title: f ? 'Edit ' + f.name : 'New petty cash fund', confirmLabel: f ? 'Save changes' : 'Create fund',
      bodyHtml: '<div class="bc-form-grid">' +
        (f ? '' : '<div class="field bc-span2"><label for="pf-branch">Branch *</label><select id="pf-branch" name="branch_id">' + optionsHtml(app.branches.map((b) => [b.id, b.name]), app.state.branch !== 'all' ? app.state.branch : '') + '</select></div>') +
        '<div class="field bc-span2"><label for="pf-name">Fund name *</label><input type="text" id="pf-name" name="name" placeholder="e.g. Manila Petty Cash" value="' + esc(f ? f.name : '') + '"></div>' +
        '<div class="field bc-span2"><label for="pf-cust">Custodian (the person who holds the cash)</label><select id="pf-cust" name="custodian_employee_id">' + optionsHtml(people, f ? f.custodian_id : '', 'Not set') + '</select></div>' +
        '<div class="field"><label for="pf-auth">Authorized fund amount (₱) *</label><input type="number" id="pf-auth" name="authorized_amount" step="0.01" min="0" inputmode="decimal" value="' + esc(f ? f.authorized_amount : '') + '"></div>' +
        '<div class="field"><label for="pf-low">Low-balance alert at (₱)</label><input type="number" id="pf-low" name="low_balance_threshold" step="0.01" min="0" inputmode="decimal" value="' + esc(f ? f.low_balance_threshold : '') + '"></div>' +
        (f ? '<div class="field bc-span2"><label for="pf-status">Status</label><select id="pf-status" name="status">' + optionsHtml(['Active', 'Closed'], f.status) + '</select><span class="muted">A fund can only be closed when its balance is zero — return the cash first.</span></div>' : '') +
      '</div>',
      onSubmit: async (form) => {
        const q = (n) => form.elements[n];
        const p = { name: q('name').value.trim(), custodian_employee_id: q('custodian_employee_id').value || null, authorized_amount: Number(q('authorized_amount').value), low_balance_threshold: Number(q('low_balance_threshold').value || 0) };
        if (f) { p.id = f.id; p.status = q('status').value; } else p.branch_id = Number(q('branch_id').value);
        return fin(await bcPettyFundSave(p));
      },
    });
    if (out) await done(f ? 'Fund saved.' : 'Petty cash fund created. Open it with the starting amount.');
  }

  async function openFund(f) {
    const out = await formDialog({
      title: 'Open ' + f.name, confirmLabel: 'Open the fund',
      messageHtml: 'Put the starting money into the fund (up to the authorized ' + money(f.authorized_amount) + '). If it comes from daily sales / cash or Branch Capital it is a <b>transfer out of the till</b>, not an expense.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="po-amt">Opening amount (₱) *</label><input type="number" id="po-amt" step="0.01" min="0.01" inputmode="decimal" value="' + esc(f.authorized_amount) + '"></div>' +
        '<div class="field"><label for="po-src">Where the money comes from *</label><select id="po-src">' + optionsHtml(REPLENISH_SOURCES, 'Daily Sales / Cash') + '</select></div>' +
        '<div class="field"><label for="po-ref">Reference</label><input type="text" id="po-ref"></div><div class="field"><label for="po-notes">Notes</label><input type="text" id="po-notes"></div></div>',
      onSubmit: async (form) => fin(await bcPettyOpen(f.id, Number(form.querySelector('#po-amt').value), form.querySelector('#po-src').value, form.querySelector('#po-ref').value.trim(), form.querySelector('#po-notes').value.trim())),
    });
    if (out) await done('Petty cash fund opened.');
  }

  async function requestReplenish(f) {
    const out = await formDialog({
      title: 'Request replenishment — ' + f.name, confirmLabel: 'Send request',
      messageHtml: 'The fund has <b>' + money(f.current_balance) + '</b> of ' + money(f.authorized_amount) + '. It can take up to <b>' + money(f.suggested_replenishment) + '</b> more. Someone else must approve before any money moves.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="rq-amt">Amount to add (₱) *</label><input type="number" id="rq-amt" step="0.01" min="0.01" inputmode="decimal" value="' + esc(f.suggested_replenishment) + '"></div>' +
        '<div class="field"><label for="rq-src">Money would come from *</label><select id="rq-src">' + optionsHtml(REPLENISH_SOURCES, 'Daily Sales / Cash') + '</select></div>' +
        '<div class="field bc-span2"><label for="rq-notes">Notes</label><input type="text" id="rq-notes"></div></div>',
      onSubmit: async (form) => fin(await bcPettyReplenishRequest(f.id, Number(form.querySelector('#rq-amt').value), form.querySelector('#rq-src').value, form.querySelector('#rq-notes').value.trim())),
    });
    if (out) await done('Replenishment requested — it now waits for approval.');
  }

  async function returnCash(f) {
    const out = await formDialog({
      title: 'Return unspent cash — ' + f.name, confirmLabel: 'Return to the till',
      messageHtml: 'Moves cash from the fund back into the till (a transfer, not income). The fund has <b>' + money(f.current_balance) + '</b>.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="rt-amt">Amount (₱) *</label><input type="number" id="rt-amt" step="0.01" min="0.01" max="' + esc(f.current_balance) + '" inputmode="decimal"></div><div class="field"><label for="rt-notes">Notes</label><input type="text" id="rt-notes"></div></div>',
      onSubmit: async (form) => fin(await bcPettyReturn(f.id, Number(form.querySelector('#rt-amt').value), form.querySelector('#rt-notes').value.trim())),
    });
    if (out) await done('Cash returned to the till.');
  }

  async function adjust(f) {
    const out = await formDialog({
      title: 'Adjust ' + f.name, confirmLabel: 'Record adjustment', danger: true,
      messageHtml: 'For a count that does not match (the ledger keeps both numbers). Positive adds to the fund, negative removes. It can never take the fund below zero. A reason is required and the adjustment is kept in the permanent history.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="aj-amt">Adjustment (₱, + or −) *</label><input type="number" id="aj-amt" step="0.01" inputmode="decimal"></div><div class="field bc-span2"><label for="aj-reason">Reason *</label><input type="text" id="aj-reason"></div></div>',
      onSubmit: async (form) => fin(await bcPettyAdjust(f.id, Number(form.querySelector('#aj-amt').value), form.querySelector('#aj-reason').value.trim())),
    });
    if (out) await done('Adjustment recorded.');
  }

  async function releaseAdvance(f) {
    const people = app.ctx.people.map((p) => [p.id, p.name + (p.position ? ' — ' + p.position : '')]);
    const out = await formDialog({
      title: 'Release a cash advance — ' + f.name, confirmLabel: 'Release the cash',
      messageHtml: 'The fund has <b>' + money(f.current_balance) + '</b>. The cash leaves the fund now and stays "pending liquidation" until the real expense is recorded.',
      bodyHtml: '<div class="bc-form-grid"><div class="field bc-span2"><label for="ad-emp">Given to *</label><select id="ad-emp">' + optionsHtml(people, app.ctx.me.id) + '</select></div>' +
        '<div class="field"><label for="ad-amt">Amount (₱) *</label><input type="number" id="ad-amt" step="0.01" min="0.01" inputmode="decimal"></div><div class="field"><label for="ad-purpose">What it is for *</label><input type="text" id="ad-purpose"></div></div>',
      onSubmit: async (form) => fin(await bcPettyAdvanceRelease(f.id, form.querySelector('#ad-emp').value, Number(form.querySelector('#ad-amt').value), form.querySelector('#ad-purpose').value.trim())),
    });
    if (out) await done('Cash advance released.');
  }

  // ---- replenishment requests
  async function repAction(a, r) {
    if (a === 'approve') {
      if (!(await confirmDialog({ title: 'Approve this replenishment?', message: money(r.amount) + ' for ' + r.fund_name + ', from ' + r.source + '.\nApproving does not move money yet — the request still has to be processed.', confirmLabel: 'Approve' }))) return;
      return run(() => bcPettyReplenishDecide(r.id, 'approve', null), 'Approved — it now needs to be processed.');
    }
    if (a === 'reject') {
      const x = await reasonDialog({ title: 'Reject this request?', label: 'Reason', confirmLabel: 'Reject', danger: true });
      return x && run(() => bcPettyReplenishDecide(r.id, 'reject', x.reason), 'Request rejected.');
    }
    if (a === 'cancel') {
      if (!(await confirmDialog({ title: 'Cancel this request?', message: 'The request is cancelled; no money moves.', confirmLabel: 'Cancel request', cancelLabel: 'Keep it', danger: true }))) return;
      return run(() => bcPettyReplenishCancel(r.id), 'Request cancelled.');
    }
    if (a === 'process') {
      const out = await formDialog({
        title: 'Process replenishment #' + r.id, confirmLabel: 'Money handed over — process',
        messageHtml: 'Add <b>' + money(r.amount) + '</b> to ' + esc(r.fund_name) + ' from ' + esc(r.source) + '.' + (['Daily Sales / Cash', 'Branch Capital'].includes(r.source) ? ' This is a transfer out of the till, not an expense.' : ''),
        bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="pr-ref">Reference</label><input type="text" id="pr-ref"></div><div class="field"><label for="pr-notes">Notes</label><input type="text" id="pr-notes"></div></div>',
        onSubmit: async (form) => fin(await bcPettyReplenishProcess(r.id, form.querySelector('#pr-ref').value.trim(), form.querySelector('#pr-notes').value.trim())),
      });
      if (out) await done('Replenishment processed.' + (r.expense_id ? ' The draft expense #' + r.expense_id + ' can be posted now.' : ''));
    }
  }
  async function run(fn, okText) {
    try { const res = await fn(); if (!res || !res.ok) throw new Error(errorsText(res)); await done(okText); }
    catch (err) { toast('bc-msg', err.message || String(err), true); }
  }

  // ---- advances
  async function advAction(a, adv) {
    if (a === 'cancel') {
      const x = await reasonDialog({ title: 'Cancel this cash advance?', message: 'The whole ' + money(adv.amount) + ' goes back into the fund.', label: 'Reason', confirmLabel: 'Cancel advance', danger: true });
      return x && run(() => bcPettyAdvanceCancel(adv.id, x.reason), 'Advance cancelled — the cash is back in the fund.');
    }
    const cats = app.ctx.categories.filter((c) => c.active);
    const out = await formDialog({
      title: 'Liquidate the advance', confirmLabel: 'Record what was spent', wide: true,
      messageHtml: esc(adv.employee || 'The employee') + ' was given <b>' + money(adv.amount) + '</b> for "' + esc(adv.purpose) + '". Record what was really spent; the rest goes back into the fund.',
      bodyHtml: '<div class="bc-form-grid"><div class="field"><label for="lq-amt">Actually spent (₱) *</label><input type="number" id="lq-amt" step="0.01" min="0" max="' + esc(adv.amount) + '" inputmode="decimal" value="' + esc(adv.amount) + '"></div>' +
        '<div class="field"><label for="lq-cat">Category *</label><select id="lq-cat"><option value="">Choose…</option>' + cats.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select></div>' +
        '<div class="field bc-span2"><label for="lq-desc">What was bought</label><input type="text" id="lq-desc" value="' + esc(adv.purpose) + '"></div>' +
        '<div class="field"><label for="lq-date">Date</label><input type="date" id="lq-date" max="' + app.ctx.today + '" value="' + app.ctx.today + '"></div><div class="field"><label for="lq-ref">Reference / OR no.</label><input type="text" id="lq-ref"></div>' +
        '<div class="field bc-span2"><label for="lq-files">Receipt (JPG, PNG or PDF)</label><input type="file" id="lq-files" multiple accept="' + RECEIPT_ACCEPT + '"></div>' +
        '<div class="field bc-span2"><label for="lq-norc">No receipt? Say why</label><input type="text" id="lq-norc"></div></div>',
      onSubmit: async (form, ctl) => {
        const spent = Number(form.querySelector('#lq-amt').value);
        const files = Array.from(form.querySelector('#lq-files').files || []);
        for (const f of files) { const bad = checkReceiptFile(f); if (bad) return { error: bad }; }
        if (spent > 0 && !form.querySelector('#lq-cat').value) return { error: 'Choose the category of what was bought.' };
        const p = { actual_amount: spent, category_id: form.querySelector('#lq-cat').value ? Number(form.querySelector('#lq-cat').value) : null, description: form.querySelector('#lq-desc').value.trim(), expense_date: form.querySelector('#lq-date').value,
          reference_number: form.querySelector('#lq-ref').value.trim(), no_receipt_reason: files.length ? '' : form.querySelector('#lq-norc').value.trim() };
        let res = await bcPettyAdvanceLiquidate(adv.id, p);
        if (res && res.code === 'DUPLICATE') {
          if (!(await confirmDialog({ title: 'Possible duplicate expense', message: 'A similar expense was already recorded. Record this one anyway?', confirmLabel: 'Record anyway' }))) return;
          res = await bcPettyAdvanceLiquidate(adv.id, Object.assign(p, { ack_duplicate: true }));
        }
        if (!res || !res.ok) return { error: errorsText(res) };
        const problems = [];
        if (res.expense_id) for (const f of files) { try { const r = await uploadReceipt(adv.branch_id, 'expense', res.expense_id, f); if (!r || !r.ok) problems.push(f.name + ': ' + errorsText(r)); } catch (err) { problems.push(f.name + ': ' + (err.message || err)); } }
        return { close: { res, problems } };
      },
    });
    if (out) await done('Advance liquidated — ' + money(out.res.returned) + ' went back into the fund.' + (out.problems.length ? ' Receipt problem: ' + out.problems.join('; ') : ''));
  }

  // ---- the ledger
  async function showLedger(f) {
    const dr = openDrawer({ label: 'Petty cash ledger' });
    let from = addDays(app.ctx.today, -29), to = app.ctx.today;
    async function load() {
      try {
        const r = await bcPettyLedger(f.id, from, to);
        dr.set('<div class="bc-dr-head"><div><h2>' + esc(r.fund.name) + ' — ledger</h2><div class="muted">Every movement, with the balance before and after. Nothing here can be changed or deleted.</div></div><button type="button" class="btn small secondary" data-bc-close>Close ✕</button></div>' +
          '<div class="bc-badges">' + badge('Balance ' + money(r.fund.current_balance), 'blue') + (r.matches_balance ? badge('Ledger adds up to the balance ✓', 'green') : badge('Ledger does NOT match the balance', 'red')) + '</div>' +
          '<div class="bc-filter-row" style="margin:8px 0;"><div class="field"><label for="lg-from">From</label><input type="date" id="lg-from" value="' + from + '"></div><div class="field"><label for="lg-to">To</label><input type="date" id="lg-to" value="' + to + '"></div></div>' +
          '<div class="muted">Balance at the start of this range: <b>' + money(r.opening_balance) + '</b></div>' +
          (r.rows.length ? '<div class="table-scroll"><table class="bc-table bc-ledger"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Before</th><th>After</th><th>Details</th></tr></thead><tbody>' + r.rows.map((x) =>
            '<tr><td data-label="Date">' + esc(fmtDate(x.date)) + '</td><td data-label="Type">' + esc(TYPE_LABEL[x.type] || x.type) + '</td><td data-label="Amount" class="' + (num(x.amount) < 0 ? 'bc-neg' : 'bc-pos-amt') + '"><b>' + signed(x.amount) + '</b></td>' +
            '<td data-label="Before">' + money(x.balance_before) + '</td><td data-label="After"><b>' + money(x.balance_after) + '</b></td><td data-label="Details" class="full-row">' + esc(x.description || '') + (x.category ? ' <span class="muted">· ' + esc(x.category) + '</span>' : '') +
            (x.employee ? '<div class="muted">' + esc(x.employee) + (x.created_by ? ' · entered by ' + esc(x.created_by) : '') + '</div>' : '') + (x.reason ? '<div class="muted">' + esc(x.reason) + '</div>' : '') +
            (x.expense_id ? ' <button type="button" class="act-link" data-exp="' + x.expense_id + '">Expense #' + x.expense_id + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No movements in this range.</p>'));
        dr.body.querySelector('#lg-from').addEventListener('change', (e) => { from = e.target.value; load(); });
        dr.body.querySelector('#lg-to').addEventListener('change', (e) => { to = e.target.value; load(); });
        dr.body.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => { dr.close(); app.openExpense(Number(b.dataset.exp)); }));
      } catch (err) { dr.set('<div class="bc-dr-head"><h2>Ledger</h2><button type="button" class="btn small secondary" data-bc-close>Close ✕</button></div><div class="msg error">' + esc(err.message || err) + '</div>'); }
    }
    await load();
  }

  return { refresh, onShow: refresh };
}
