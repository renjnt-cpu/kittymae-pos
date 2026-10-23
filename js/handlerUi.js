// Branches -- "HANDLED BY" for POS sales (Walk-In & COD), Scrap entries and Subasta items: the staff member who is handling the record, chosen by an Admin / Manager from the
// existing employee records (never typed). One shared helper so the three tabs behave the same:
//   * a "Handled By" column with the name + employee ID (or UNASSIGNED) and a Change / Assign button for people who may assign;
//   * a searchable picker (name, employee ID, position, branch): the record's branch staff first, then the other authorized staff; "on leave" is only a label;
//   * a confirmation before anything is saved (CONFIRM ASSIGNMENT / REASSIGNMENT / REMOVAL), so an assignment is never changed by accident;
//   * a filter (All staff / My assigned orders / Unassigned / each staff member) and a one-line summary of the workload;
//   * a "Staff handler" section in the record's drawer with who assigned it, when, and the full history.
// Who sees what is decided by three keys (branch_handler.view / .assign / .view_all); the database checks them again. Inactive employees are never offered but stay on old records.
import { confirmDialog } from './dialogs.js?v=20261023b';
import { branchHandlersFor, branchHandlerHistory, listBranchHandlers, assignBranchHandler } from './handlerApi.js?v=20261023b';

const fmtDT = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }) : '—';
const kv = (k, v) => '<div class="drawer-kv"><span>' + k + '</span><b>' + v + '</b></div>';

/** opts: {table, employee, esc, notify(text, isError), branchName(id), onChanged(recordId)}. */
export function createHandlers({ table, employee, esc, notify, branchName, onChanged }) {
  const perms = new Set(employee.permissions || []);
  const canView = perms.has('branch_handler.view');
  const canAssign = perms.has('branch_handler.assign');
  const canViewAll = perms.has('branch_handler.view_all');
  const byId = new Map();
  const rosters = new Map();   // branch id -> {at, rows}: the picker list, kept for a minute

  const get = (id) => byId.get(String(id)) || null;
  const nameOf = (id) => (get(id) || {}).name || '';

  /** Asks for the handlers of the records on screen. A failure never breaks the list: the column just shows nothing. */
  async function load(ids) {
    const keys = [...new Set((ids || []).map(String))];
    if (!canView) { byId.clear(); return; }
    try {
      const fresh = [];
      for (let i = 0; i < keys.length; i += 400) fresh.push(...await branchHandlersFor(table, keys.slice(i, i + 400)));
      keys.forEach((k) => byId.delete(k));
      fresh.forEach((r) => byId.set(String(r.record_id), r));
    } catch (err) { /* keep what we had; the database message is not useful in a list */ }
  }

  function matches(id, mode) {
    if (!mode || mode === 'all') return true;
    const h = get(id);
    if (mode === 'none') return !h;
    if (mode === 'mine') return !!h && h.employee_id === employee.id;
    return !!h && h.employee_id === mode;
  }

  // ---- the list column
  function cellHtml(id) {
    if (!canView) return '';
    const h = get(id);
    const who = h
      ? '<b>' + esc(h.name) + '</b>' + (h.active ? '' : ' <span class="muted" style="font-size:10px;">(no longer active)</span>') + (h.employee_code ? '<div class="muted" style="font-size:10px;">' + esc(h.employee_code) + '</div>' : '')
      : '<span class="badge st-gray">UNASSIGNED</span>';
    return who + (canAssign ? '<div><button type="button" class="btn small secondary bh-btn" data-handler-edit="' + esc(id) + '">' + (h ? 'Change' : 'Assign') + '</button></div>' : '');
  }

  // ---- the filter
  function filterFieldHtml(selectId) {
    if (!canView) return '';
    return '<div class="field"><label>Handled By</label><select id="' + selectId + '"><option value="all">All staff</option><option value="mine">My assigned orders</option><option value="none">Unassigned orders</option></select></div>';
  }
  /** Rebuilds the staff names of the filter from the records being shown (only for people who may see everyone's workload). */
  function syncFilterOptions(sel, ids) {
    if (!sel) return;
    const keep = sel.value;
    const staff = new Map();
    if (canViewAll) ids.forEach((id) => { const h = get(id); if (h) { const s = staff.get(h.employee_id) || { name: h.name, n: 0 }; s.n++; staff.set(h.employee_id, s); } });
    sel.innerHTML = '<option value="all">All staff</option><option value="mine">My assigned orders</option><option value="none">Unassigned orders</option>' +
      [...staff.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, s]) => '<option value="' + esc(id) + '">' + esc(s.name) + ' (' + s.n + ')</option>').join('');
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all';
  }
  function filterLabel(value) {
    if (!value || value === 'all') return '';
    if (value === 'mine') return 'My assigned orders';
    if (value === 'none') return 'Unassigned';
    const h = [...byId.values()].find((x) => x.employee_id === value);
    return h ? h.name : '';
  }
  /** One quiet line: Unassigned 5 · Juan 12 · Maria 8 -- each is a button that sets the filter. */
  function summaryHtml(ids) {
    if (!canView) return '';
    let unassigned = 0, mine = 0;
    const staff = new Map();
    ids.forEach((id) => {
      const h = get(id);
      if (!h) { unassigned++; return; }
      if (h.employee_id === employee.id) mine++;
      const s = staff.get(h.employee_id) || { name: h.name, n: 0 }; s.n++; staff.set(h.employee_id, s);
    });
    const chip = (val, label, n) => '<button type="button" class="filter-chip bh-chip" data-handler-filter="' + esc(val) + '"><b>' + esc(label) + '</b> ' + n + '</button>';
    const parts = [];
    if ((canViewAll || canAssign) && ids.length) parts.push(chip('none', 'Unassigned', unassigned));
    if (canViewAll) [...staff.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).forEach(([id, s]) => parts.push(chip(id, s.name, s.n)));
    if (mine && !canViewAll) parts.push(chip('mine', 'My assigned', mine));
    return parts.length ? '<div class="bh-sum"><span class="muted">Handled by:</span> ' + parts.join('') + '</div>' : '';
  }
  function wireSummary(container, selectId) {
    container.querySelectorAll('[data-handler-filter]').forEach((b) => b.addEventListener('click', () => {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      sel.value = b.dataset.handlerFilter;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }));
  }

  // ---- the drawer section
  function sectionHtml(id) {
    if (!canView) return '';
    const h = get(id);
    return '<div class="drawer-section"><h4>Handled By</h4>' +
      (h
        ? kv('Handled by', esc(h.name) + (h.active ? '' : ' <span class="muted">(no longer active)</span>')) + kv('Employee ID', esc(h.employee_code || '—')) +
          kv('Position', esc(h.position || '—')) + kv('Branch', esc(h.branch_name || 'All branches')) +
          kv('Assigned by', esc(h.assigned_by_name || '—')) + kv('Assigned', esc(fmtDT(h.assigned_at)))
        : kv('Handled by', '<span class="badge st-gray">UNASSIGNED</span>')) +
      (canAssign ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"><button type="button" class="btn small" data-handler-edit="' + esc(id) + '">' + (h ? 'Change handler' : 'Assign handler') + '</button>' +
        (h ? '<button type="button" class="btn small secondary" data-handler-remove="' + esc(id) + '">Remove handler</button>' : '') + '</div>' : '') +
      '<div class="bh-history" data-bh-history="' + esc(id) + '"><div class="muted" style="font-size:11px;margin-top:8px;">Loading the assignment history…</div></div></div>';
  }
  async function fillHistory(container, id) {
    if (!canView) return;
    const box = container.querySelector('[data-bh-history="' + CSS.escape(String(id)) + '"]');
    if (!box) return;
    try {
      const rows = await branchHandlerHistory(table, id);
      if (!document.body.contains(box)) return;
      box.innerHTML = rows.length
        ? '<div class="muted" style="font-size:11px;margin:8px 0 2px;">Assignment history</div><div class="lw-history">' + rows.map((x) => '<div class="lw-hist-row"><div class="lw-hist-when muted">' + esc(fmtDT(x.changed_at)) + '</div><div><b>' +
            (x.action === 'Assigned' ? 'Assigned to ' + esc(x.new_name) : x.action === 'Reassigned' ? 'Reassigned from ' + esc(x.previous_name) + ' to ' + esc(x.new_name) : 'Handler removed (was ' + esc(x.previous_name) + ')') +
            '</b> <span class="muted">· by ' + esc(x.changed_by_name || '—') + '</span>' + (x.notes ? '<div class="muted" style="font-size:11px;">' + esc(x.notes) + '</div>' : '') + '</div></div>').join('') + '</div>'
        : '<div class="muted" style="font-size:11px;margin-top:8px;">No one has been assigned to this record yet.</div>';
    } catch (err) { box.innerHTML = ''; }
  }

  /** Makes every Change / Assign / Remove button inside `container` work. ctxFn(id) -> {branchId, label, customer} of that record. */
  function wire(container, ctxFn) {
    container.querySelectorAll('[data-handler-edit]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); edit(b.dataset.handlerEdit, ctxFn(b.dataset.handlerEdit)); }));
    container.querySelectorAll('[data-handler-remove]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); edit(b.dataset.handlerRemove, ctxFn(b.dataset.handlerRemove), { remove: true }); }));
  }

  // ---- the picker
  async function roster(branchId) {
    const hit = rosters.get(branchId);
    if (hit && Date.now() - hit.at < 60000) return hit.rows;
    const rows = await listBranchHandlers(branchId);
    rosters.set(branchId, { at: Date.now(), rows });
    return rows;
  }

  async function edit(id, ctx, opts = {}) {
    if (!canAssign || !ctx) return;
    const cur = get(id);
    const recordLine = [ctx.label, ctx.customer].filter(Boolean).join(' · ') + (ctx.branchId != null ? ' · ' + branchName(ctx.branchId) : '');
    if (opts.remove) {
      if (!cur) return;
      if (!await confirmDialog({ title: 'CONFIRM REMOVAL', message: (ctx.label || 'Record') + '\nHandler: ' + cur.name + '\nThis record becomes unassigned. The history keeps who handled it.', confirmLabel: 'Remove handler', danger: true })) return;
      try { const r = await assignBranchHandler(table, id, null, ''); notify('Handler removed.', false); await finish(id); return r; } catch (err) { notify(String(err.message || err), true); return; }
    }
    let rows;
    try { rows = await roster(ctx.branchId); } catch (err) { notify(String(err.message || err), true); return; }
    await pickerDialog({ id, ctx, cur, rows, recordLine });
  }
  async function finish(id) {
    await load([id]);
    if (onChanged) await onChanged(id);
  }

  function pickerDialog({ id, ctx, cur, rows, recordLine }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const back = document.createElement('div');
      back.className = 'dlg-backdrop bh-back';
      const branchLabel = ctx.branchId != null ? branchName(ctx.branchId) : 'This branch';
      back.innerHTML =
        '<div class="dlg bh-dlg" role="dialog" aria-modal="true" aria-labelledby="bh-title"><h3 id="bh-title">Handled By</h3>' +
        '<div class="dlg-msg">' + esc(recordLine) + (cur ? '<br>Now handled by <b>' + esc(cur.name) + '</b>' : '<br>Not assigned to anyone yet') + '</div>' +
        '<div class="field"><label for="bh-q">Search staff</label><input type="search" id="bh-q" placeholder="Name, employee ID, position or branch…" autocomplete="off"></div>' +
        '<div class="bh-list" id="bh-list" role="listbox" aria-label="Staff"></div>' +
        '<div class="field" style="margin-top:8px;"><label for="bh-note">Note (optional)</label><input type="text" id="bh-note" maxlength="300" placeholder="Why the order is being assigned or changed"></div>' +
        '<div class="dlg-err" id="bh-err" role="alert" hidden></div>' +
        '<div class="dlg-actions"><button type="button" class="btn" id="bh-save" disabled>Save…</button>' + (cur ? '<button type="button" class="btn secondary" id="bh-remove">Remove handler</button>' : '') +
        '<button type="button" class="btn secondary" data-cancel>Cancel</button></div></div>';
      let picked = null, done = false;
      const $ = (sel) => back.querySelector(sel);
      const staffLine = (p) => esc(p.name) + ' — ' + esc(p.employee_code || '—') + ' — ' + esc(p.branch_name || 'All branches');
      function paint() {
        const q = $('#bh-q').value.trim().toLowerCase();
        const shown = rows.filter((p) => !q || [p.name, p.employee_code, p.position, p.branch_name || 'all branches company-wide'].filter(Boolean).join(' ').toLowerCase().includes(q));
        const group = (title, list) => list.length ? '<div class="bh-group">' + esc(title) + '</div>' + list.map((p) =>
          '<button type="button" class="bh-opt" role="option" data-id="' + esc(p.id) + '" aria-selected="' + (picked === p.id) + '"><span>' + staffLine(p) + '<span class="muted bh-pos">' + esc(p.position || '') + '</span></span>' +
          '<span>' + (cur && cur.employee_id === p.id ? '<span class="badge st-blue">current</span> ' : '') + (p.on_leave ? '<span class="badge st-yellow">On leave</span>' : '') + '</span></button>').join('') : '';
        const atBranch = shown.filter((p) => p.at_branch), others = shown.filter((p) => !p.at_branch);
        $('#bh-list').innerHTML = (group(branchLabel.toUpperCase() + ' STAFF', atBranch) + group(atBranch.length ? 'OTHER AUTHORIZED STAFF' : 'AUTHORIZED STAFF', others)) || '<div class="muted bh-none">No staff match.</div>';
        $('#bh-save').disabled = !picked;
      }
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* element gone */ } }
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key !== 'Escape' || document.querySelector('.dlg-backdrop:not(.bh-back)')) return;
        ev.stopPropagation(); close(null);
      }
      const showErr = (t) => { const el = $('#bh-err'); el.textContent = t; el.hidden = !t; };
      async function save() {
        const p = rows.find((x) => x.id === picked);
        if (!p) return;
        const message = cur
          ? (ctx.label || 'Record') + '\nFrom: ' + cur.name + '\nTo: ' + p.name + (p.on_leave ? '\n(' + p.name + ' is on approved leave today.)' : '')
          : (ctx.label || 'Record') + '\nHandled by: ' + p.name + (p.on_leave ? '\n(' + p.name + ' is on approved leave today.)' : '');
        if (!await confirmDialog({ title: cur ? 'CONFIRM REASSIGNMENT' : 'CONFIRM ASSIGNMENT', message, confirmLabel: 'Confirm' })) return;
        showErr(''); $('#bh-save').disabled = true;
        try {
          const r = await assignBranchHandler(table, id, p.id, $('#bh-note').value);
          notify((r.action === 'Reassigned' ? 'Reassigned to ' : 'Assigned to ') + p.name + '.', false);
          close(true);
          await finish(id);
        } catch (err) { showErr(String(err.message || err)); $('#bh-save').disabled = false; }
      }
      $('#bh-q').addEventListener('input', paint);
      $('#bh-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const first = $('#bh-list .bh-opt'); if (first) { picked = first.dataset.id; paint(); } } });
      $('#bh-list').addEventListener('click', (ev) => { const b = ev.target.closest('.bh-opt'); if (!b) return; picked = b.dataset.id; paint(); });
      $('#bh-save').addEventListener('click', save);
      const rm = $('#bh-remove');
      if (rm) rm.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'CONFIRM REMOVAL', message: (ctx.label || 'Record') + '\nHandler: ' + cur.name + '\nThis record becomes unassigned. The history keeps who handled it.', confirmLabel: 'Remove handler', danger: true })) return;
        try { await assignBranchHandler(table, id, null, $('#bh-note').value); notify('Handler removed.', false); close(true); await finish(id); } catch (err) { showErr(String(err.message || err)); }
      });
      back.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      paint();
      $('#bh-q').focus();
    });
  }

  return { canView, canAssign, canViewAll, load, get, nameOf, matches, cellHtml, filterFieldHtml, syncFilterOptions, filterLabel, summaryHtml, wireSummary, sectionHtml, fillHistory, wire };
}
