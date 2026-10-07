// The Approvals inbox of POS -> Branches (Ren's Branches spec, Phase 6): every open request of every module in one place -- sale void /
// delete requests (POS), the five Layaway request types, scrap and Subasta delete requests -- each with what the spec lists (request
// type, order, customer, SKU, amount, who asked, why, when, who already approved) and the same Approve / Reject actions the module's own
// Requests view has. It owns no rules: the list comes from branch_approvals_inbox() (row-level security decides what a person sees --
// approvers everything, anyone else only their own) and every button calls the module's existing approve / reject function, which checks
// again who may do it. "Open" jumps to the record in its own tab.
import {
  getBranchApprovalsInbox, listActiveEmployees, subscribeToChanges,
  approveBranchRecordStage1, approveBranchRecordFinal, rejectBranchRecordAction, cancelBranchRecordAction,
  approveLayawayForfeitDate, rejectLayawayForfeitDate, approveLayawayItemChange, rejectLayawayItemChange,
  approveLayawayPaymentDeletion, rejectLayawayPaymentDeletion,
  approveLayawayHoldDeletionStage1, approveLayawayHoldDeletionFinal, rejectLayawayHoldDeletion,
  approveLayawayForfeitStage1, approveLayawayForfeitFinal, rejectLayawayForfeit, cancelLayawayForfeitRequest,
} from './api.js?v=20261007u';
import { confirmDialog, reasonDialog } from './dialogs.js?v=20261007u';
import { approvalCardHtml } from './approvalUi.js?v=20261007u';
import { friendlyError } from './shell.js?v=20261007u';

const MODULES = ['POS', 'Layaway', 'Scrap', 'Subasta'];
const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const grams = (n) => (n == null ? '' : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 3 }) + ' g');
const TABLES = ['layaway_forfeit_date_requests', 'layaway_item_change_requests', 'layaway_payment_deletion_requests', 'layaway_hold_deletion_requests',
  'layaway_forfeit_requests', 'branch_record_requests'];

/** Options: esc, toast (the page's), employee, branches (all active), visibleBranches (what this person may see), getBranchId(),
 * onChanged() (after any approve / reject: the page reloads its tabs and summary), onOpen({ open_table, open_id, branch_id, module }).
 * Returns { open({ module? }), close, isOpen }. */
export function initApprovalsInbox({ esc, toast, employee, branches, visibleBranches, getBranchId, onChanged, onOpen }) {
  const isAdmin = employee.role === 'Admin';
  const supUp = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || (employee.position || '').toLowerCase().includes('supervisor');
  const multi = visibleBranches.length > 1;
  const state = { scope: 'branch', module: 'all', rows: [], names: {}, loading: false, error: '' };
  let unsubscribe = null, refreshTimer = null, seq = 0;
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch #' + id);
  const nameOf = (id) => (id && state.names[id]) || '—';

  const back = document.createElement('div');
  back.className = 'drawer-backdrop'; back.id = 'inbox-backdrop';
  const drawer = document.createElement('div');
  drawer.className = 'drawer drawer-wide'; drawer.id = 'inbox-drawer';
  drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Approvals');
  drawer.innerHTML =
    '<div class="drawer-header"><div><h3>Approvals</h3><div class="muted" id="inbox-sub"></div></div><button type="button" class="drawer-close" id="inbox-close" aria-label="Close">✕</button></div>' +
    '<div class="drawer-body">' +
      '<div id="inbox-msg"></div>' +
      '<div class="inbox-tools">' +
        (multi ? '<label class="field inbox-scope"><span class="sr-only">Show</span><select id="inbox-scope"><option value="branch">This branch</option><option value="all">All my branches</option></select></label>' : '') +
        '<div class="ops-seg" id="inbox-modules" role="group" aria-label="Module"></div>' +
      '</div>' +
      '<div id="inbox-list"><div class="muted">Loading…</div></div>' +
    '</div>';
  document.body.appendChild(back); document.body.appendChild(drawer);
  const $ = (id) => drawer.querySelector('#' + id);
  const notify = (text, isError) => toast('inbox-msg', text, isError);

  const idsForScope = () => (state.scope === 'all' ? visibleBranches.map((b) => b.id) : [getBranchId()]);

  async function load() {
    const mine = ++seq;
    state.loading = true;
    try {
      const [rows, people] = await Promise.all([getBranchApprovalsInbox(idsForScope()), Object.keys(state.names).length ? null : listActiveEmployees().catch(() => [])]);
      if (mine !== seq) return;
      if (people) state.names = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
      state.rows = rows; state.error = '';
    } catch (err) {
      if (mine !== seq) return;
      state.rows = []; state.error = String(err.message || err);
    }
    state.loading = false;
    render();
  }

  // ---- what each person may do with each kind of request (the database checks again) ----
  function actionsFor(r) {
    const mine = r.requested_by === employee.id, awaitingFinal = r.status === 'Supervisor Approved';
    const a = [];
    const btn = (act, label, cls) => a.push({ act, label, cls: cls || '' });
    switch (r.source) {
      case 'layaway_forfeit_date':
        if (isAdmin) { btn('approve', 'Approve'); btn('reject', 'Reject', 'secondary'); }
        break;
      case 'layaway_item_change': case 'layaway_payment_deletion':
        if (supUp) { btn('approve', 'Approve'); btn('reject', 'Reject', 'secondary'); }
        break;
      case 'layaway_deletion':
        if (!awaitingFinal && supUp) btn('stage1', 'Approve');
        if (awaitingFinal && isAdmin) btn('final', 'Final approve', 'danger');
        if ((!awaitingFinal && supUp) || (awaitingFinal && isAdmin)) btn('reject', 'Reject', 'secondary');
        break;
      case 'layaway_forfeit':
        if (!awaitingFinal && supUp && (!mine || isAdmin)) btn('stage1', 'Approve');
        if (isAdmin) btn('final', 'Final forfeit', 'danger');
        if ((!awaitingFinal && supUp) || (awaitingFinal && isAdmin)) btn('reject', 'Reject', 'secondary');
        if (mine || isAdmin) btn('withdraw', 'Withdraw', 'secondary');
        break;
      default: // record: POS / Scrap / Subasta
        if (r.status === 'Pending' && supUp && (isAdmin || !mine)) { btn('stage1', 'Approve'); if (isAdmin) btn('admin', 'Approve & finish', 'danger'); }
        if (awaitingFinal && isAdmin) btn('final', 'Final approval', 'danger');
        if (supUp && (r.status === 'Pending' || isAdmin)) btn('reject', 'Reject', 'secondary');
        if (mine || isAdmin) btn('withdraw', 'Withdraw', 'secondary');
    }
    btn('open', 'Open', 'secondary');
    return a;
  }

  const FLOWS = {
    layaway_forfeit_date: { approve: approveLayawayForfeitDate, reject: rejectLayawayForfeitDate },
    layaway_item_change: { approve: approveLayawayItemChange, reject: rejectLayawayItemChange },
    layaway_payment_deletion: { approve: approveLayawayPaymentDeletion, reject: rejectLayawayPaymentDeletion },
    layaway_deletion: { stage1: approveLayawayHoldDeletionStage1, final: approveLayawayHoldDeletionFinal, reject: rejectLayawayHoldDeletion },
    layaway_forfeit: { stage1: approveLayawayForfeitStage1, final: approveLayawayForfeitFinal, reject: rejectLayawayForfeit, withdraw: cancelLayawayForfeitRequest },
    record: { stage1: approveBranchRecordStage1, final: approveBranchRecordFinal, reject: rejectBranchRecordAction, withdraw: cancelBranchRecordAction },
  };

  /** The question asked before something that cannot be undone. */
  function confirmFor(r, act) {
    if (act === 'stage1') return { title: 'Approve this request?', message: r.source === 'layaway_forfeit' ? 'An Admin still gives the final approval before the item is forfeited.' : 'An Admin still gives the final approval before anything changes.', confirmLabel: 'Approve' };
    if (act === 'withdraw') return { title: 'Withdraw this request?', message: 'The record stays as it is.', confirmLabel: 'Withdraw' };
    if (r.source === 'layaway_item_change') return { title: 'Approve this item change?', message: 'The old item\'s reservation will be released and the new one reserved.', confirmLabel: 'Approve' };
    if (r.source === 'layaway_payment_deletion') return { title: 'Approve this payment deletion?', message: 'This permanently removes the payment record.', confirmLabel: 'Approve and delete', danger: true };
    if (r.source === 'layaway_deletion') return { title: 'Final approve this deletion?', message: r.detail && /COMPLETED/.test(r.detail) ? 'This permanently deletes this COMPLETED sale -- removes its payment history and restores the stock it sold. This cannot be undone.' : 'This permanently deletes the layaway. This cannot be undone.', confirmLabel: 'Delete permanently', danger: true };
    if (r.source === 'layaway_forfeit') return { title: 'Forfeit this layaway?', message: 'The customer loses the item: it is marked Forfeited and goes back to available stock. Payments already made stay on record.', confirmLabel: 'Forfeit', danger: true };
    if (r.source === 'layaway_forfeit_date') return { title: 'Approve this forfeit date change?', message: 'The layaway\'s forfeit date changes to the new one.', confirmLabel: 'Approve' };
    // record requests
    if (r.open_table === 'pos_sale') return { title: (r.type_label.startsWith('Void') ? 'Void' : 'Delete') + ' this sale?', message: 'Its items go back to Available stock and the sale leaves the sales list and every report. Its full record stays in Voided & deleted sales.', confirmLabel: r.type_label.startsWith('Void') ? 'Void sale' : 'Delete sale', danger: true };
    return { title: r.type_label + '?', message: 'The record is removed. What was removed stays in the audit trail.', confirmLabel: 'Approve and remove', danger: true };
  }

  async function act(r, which) {
    if (which === 'open') { close(); onOpen({ open_table: r.open_table, open_id: r.open_id, branch_id: r.branch_id, module: r.module }); return; }
    const flow = FLOWS[r.source] || {};
    const id = r.request_id;
    try {
      if (which === 'reject') {
        const out = await reasonDialog({ title: 'Reject this request?', message: 'Optional: tell the person why.', label: 'Reason', required: false, confirmLabel: 'Reject', danger: true });
        if (!out) return;
        await flow.reject(id, out.reason || null);
        notify('Request rejected.', false);
      } else {
        const q = which === 'approve' ? confirmFor(r, 'approve') : confirmFor(r, which === 'admin' ? 'final' : which);
        if (!await confirmDialog(q)) return;
        if (which === 'admin') { await flow.stage1(id); await flow.final(id); notify('Done.', false); }
        else { await (flow[which] || flow.approve)(id); notify(which === 'stage1' ? 'Approved — now waiting for Admin.' : (which === 'withdraw' ? 'Request withdrawn.' : 'Approved.'), false); }
      }
    } catch (err) { notify(friendlyError(String(err.message || err)), true); return; }
    await load();
    if (onChanged) { try { await onChanged(); } catch (e) { /* the page refresh must not break the inbox */ } }
  }

  // ---- drawing ----
  function recordDetail(r) {
    const s = r.snapshot || {};
    const parts = [];
    if (r.error_type) parts.push('Kind of mistake: <b>' + esc(r.error_type) + '</b>');
    const pays = (s.payments || []).map((p) => money(p.amount) + ' ' + esc(p.method)).join(' + ');
    if (r.open_table === 'pos_sale') {
      parts.push('rung up by ' + esc(nameOf(s.processed_by)));
      if (s.discount > 0) parts.push('discount ' + money(s.discount));
      if (pays) parts.push('paid ' + pays);
    } else if (r.module === 'Scrap' && s.kind !== 'Scrap payment') {
      parts.push(esc([s.kind, [s.metal, s.purity].filter(Boolean).join(' '), grams(s.grams)].filter(Boolean).join(' · ')));
      if (pays) parts.push('paid ' + pays);
    } else if (s.kind === 'Scrap payment' || s.kind === 'Subasta payment') {
      parts.push(esc([s.method, s.reference ? '#' + s.reference : '', s.paid_at ? 'paid ' + s.paid_at : ''].filter(Boolean).join(' · ')));
    } else if (r.module === 'Subasta') {
      if (pays) parts.push('paid ' + pays);
    }
    return parts.join(' · ');
  }
  function cardFor(r) {
    const awaitingFinal = r.status === 'Supervisor Approved';
    const s = r.snapshot || {};
    const showBranch = state.scope === 'all';
    const item = r.open_table === 'pos_sale' ? (s.items || []).map((i) => (i.qty || 1) + '× ' + (i.name || i.sku)).join(', ')
      : (r.module === 'Scrap' && s.kind !== 'Scrap payment' ? [[s.metal, s.purity].filter(Boolean).join(' '), grams(s.grams)].filter(Boolean).join(' · ')
        : (r.module === 'Subasta' ? s.item : r.sku));
    const detail = (showBranch ? '<span class="muted">' + esc(branchName(r.branch_id)) + '</span> · ' : '') + (r.source === 'record' ? recordDetail(r) : esc(r.detail || ''));
    const buttons = actionsFor(r).map((a) => '<button class="btn small' + (a.cls ? ' ' + a.cls : '') + '" data-act="' + a.act + '" data-src="' + esc(r.source) + '" data-id="' + r.request_id + '">' + esc(a.label) + '</button>').join('');
    return approvalCardHtml(esc, {
      type: r.type_label, order: r.order_ref, customer: r.customer, item: item || r.sku, amount: r.amount, requester: nameOf(r.requested_by), requestedAt: r.requested_at,
      reason: r.reason, detail: detail.replace(/^ · |( · )+$/g, ''), supervisor: awaitingFinal ? nameOf(r.supervisor_by) : '', awaitingFinal,
      actions: buttons,
    });
  }
  function render() {
    $('inbox-sub').textContent = state.scope === 'all' ? 'All branches you can see' : branchName(getBranchId());
    const counts = Object.fromEntries(MODULES.map((m) => [m, state.rows.filter((r) => r.module === m).length]));
    const modBox = $('inbox-modules');
    modBox.innerHTML = '<button type="button" data-m="all" aria-pressed="' + (state.module === 'all') + '">All <b>' + state.rows.length + '</b></button>' +
      MODULES.map((m) => '<button type="button" data-m="' + m + '" aria-pressed="' + (state.module === m) + '">' + (m === 'POS' ? 'POS' : m) + ' <b>' + counts[m] + '</b></button>').join('');
    modBox.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { state.module = b.dataset.m; render(); }));
    const list = $('inbox-list');
    if (state.error) { list.innerHTML = '<div class="msg error">The approvals could not be loaded (' + esc(state.error) + ').</div>'; return; }
    const rows = state.rows.filter((r) => state.module === 'all' || r.module === state.module);
    if (!rows.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-msg">Nothing is waiting for approval' + (state.module === 'all' ? '' : ' in ' + esc(state.module)) + '.</div>' +
        '<div class="muted" style="font-size:12px;margin-top:4px;">You see requests you made yourself; supervisors and Admin see everyone\'s.</div></div>';
      return;
    }
    const groups = MODULES.filter((m) => rows.some((r) => r.module === m));
    list.innerHTML = groups.map((m) => (groups.length > 1 ? '<h4 class="inbox-h">' + esc(m) + ' <span class="exp-count">(' + rows.filter((r) => r.module === m).length + ')</span></h4>' : '') +
      rows.filter((r) => r.module === m).map(cardFor).join('')).join('');
    list.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const r = state.rows.find((x) => x.source === b.dataset.src && String(x.request_id) === b.dataset.id);
      if (r) act(r, b.dataset.act);
    }));
  }

  function open(opts) {
    state.module = (opts && opts.module) || 'all';
    if (!multi) state.scope = 'branch';
    const sc = $('inbox-scope'); if (sc) sc.value = state.scope;
    $('inbox-msg').innerHTML = '';
    back.classList.add('open'); drawer.classList.add('open');
    render(); load();
    if (!unsubscribe) unsubscribe = subscribeToChanges(TABLES, () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 800); });
  }
  function close() {
    back.classList.remove('open'); drawer.classList.remove('open');
    if (unsubscribe) { try { unsubscribe(); } catch (e) { /* already gone */ } unsubscribe = null; }
  }
  $('inbox-close').addEventListener('click', close);
  back.addEventListener('click', close);
  const sc = $('inbox-scope');
  if (sc) sc.addEventListener('change', () => { state.scope = sc.value; load(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && drawer.classList.contains('open') && !document.querySelector('.dlg-backdrop')) close(); });
  return { open, close, isOpen: () => drawer.classList.contains('open') };
}
