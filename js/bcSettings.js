// Branch Capital -- SETTINGS (Admin): who has to approve which expense amounts (approval tiers), when a receipt is needed, how big a cash difference needs an explanation, what counts as a high expense,
// the duplicate warning, and the expense categories. Changes take effect for new expenses and are kept in the audit log.
import { esc, toast } from './shell.js?v=20261018a';
import { bcSettingsSave, bcCategorySave, bcContext } from './bcApi.js?v=20261018a';
import { formDialog } from './bcUi.js?v=20261018a';
import { money, optionsHtml, badge, errorsText } from './bcFormat.js?v=20261018a';

const LEVELS = [['none', 'No approval needed'], ['supervisor', 'Supervisor or higher'], ['manager', 'Manager or higher'], ['admin', 'Admin only']];
const KINDS = [['general', 'General expense'], ['transportation', 'Transportation (asks for type / from / to)'], ['bill', 'Bill payment (links to a bill)']];

export function startSettings(app) {
  const root = app.root('settings');
  let tiers = [];

  function draw() {
    const s = app.ctx.settings;
    tiers = (s.approval_tiers || []).map((t) => ({ up_to: t.up_to, approval: t.approval }));
    root.innerHTML =
      '<div class="card"><h3 style="margin-top:0;">Who approves an expense</h3><p class="muted">The amount decides who has to approve it. Nobody can approve their own expense (an Admin can). The last tier covers everything above the one before it.</p>' +
      '<div id="st-tiers"></div><button type="button" class="btn small secondary" id="st-add-tier">+ Add a tier</button></div>' +
      '<div class="card"><h3 style="margin-top:0;">Receipts and limits</h3><div class="bc-form-grid">' +
        '<div class="field"><label for="st-rcpt">A receipt is needed for expenses above (₱)</label><input type="number" id="st-rcpt" step="0.01" min="0" value="' + esc(s.receipt_required_above) + '"><span class="muted">0 means every expense in a category that needs receipts.</span></div>' +
        '<div class="field"><label for="st-policy">When there is no receipt</label><select id="st-policy">' + optionsHtml([['reason_allowed', 'A written reason can replace the receipt'], ['strict', 'A receipt is always required']], s.receipt_policy) + '</select></div>' +
        '<div class="field"><label for="st-var">Explain a cash difference bigger than (₱)</label><input type="number" id="st-var" step="0.01" min="0" value="' + esc(s.variance_reason_above) + '"></div>' +
        '<div class="field"><label for="st-hs">Flag a single expense of (₱) or more</label><input type="number" id="st-hs" step="0.01" min="0" value="' + esc(s.high_expense_single) + '"></div>' +
        '<div class="field"><label for="st-hd">Flag a day with expenses of (₱) or more</label><input type="number" id="st-hd" step="0.01" min="0" value="' + esc(s.high_expense_day) + '"></div>' +
        '<label class="bc-check bc-span2"><input type="checkbox" id="st-dup"' + (s.duplicate_check ? ' checked' : '') + '> Warn about a possible duplicate expense (same day and amount, same reference, or same description) — a warning only, nothing is rejected automatically</label>' +
      '</div><div id="st-err" class="dlg-err" hidden></div><div style="margin-top:10px;"><button type="button" class="btn" id="st-save">Save settings</button></div></div>' +
      '<div class="card"><div class="bc-toolbar"><h3 style="margin:0;">Expense categories</h3><span class="bc-grow"></span><button type="button" class="btn" id="st-newcat">+ New category</button></div>' +
      '<div class="table-scroll table-2col"><table class="bc-table"><thead><tr><th>Name</th><th>Behaviour</th><th>Receipt</th><th>Status</th><th></th></tr></thead><tbody>' +
      app.ctx.categories.map((c) => '<tr class="' + (c.active ? '' : 'bc-void') + '"><td data-label="Name"><b>' + esc(c.name) + '</b>' + (c.is_system ? ' <span class="muted">(built in)</span>' : '') + '</td><td data-label="Behaviour">' + esc((KINDS.find((k) => k[0] === c.kind) || [0, c.kind])[1]) + '</td>' +
        '<td data-label="Receipt">' + (c.receipt_required ? 'Needed' : '<span class="muted">Not needed</span>') + '</td><td data-label="Status">' + badge(c.active ? 'Active' : 'Hidden', c.active ? 'green' : 'gray') + '</td>' +
        '<td data-label="" class="full-row"><button type="button" class="btn small secondary" data-cat="' + c.id + '">Edit</button></td></tr>').join('') + '</tbody></table></div>' +
      '<p class="muted" style="margin-bottom:0;">A category that was used is never deleted — hide it instead and it disappears from the form but stays on the old expenses.</p></div>';
    drawTiers();
    root.querySelector('#st-add-tier').addEventListener('click', () => {
      readTiers();
      const open = tiers.pop();   // the last tier ("above ...") always stays last
      const prev = tiers.length ? Number(tiers[tiers.length - 1].up_to) : 0;
      tiers.push({ up_to: prev + 1000, approval: 'manager' });
      tiers.push(open);
      drawTiers();
    });
    root.querySelector('#st-save').addEventListener('click', save);
    root.querySelector('#st-newcat').addEventListener('click', () => catForm(null));
    root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => catForm(app.ctx.categories.find((c) => String(c.id) === b.dataset.cat))));
  }

  function drawTiers() {
    root.querySelector('#st-tiers').innerHTML = tiers.map((t, i) => {
      const last = i === tiers.length - 1;
      return '<div class="bc-tier-row" data-i="' + i + '">' + (last ? '<span class="bc-tier-up">Above ' + (i ? money(tiers[i - 1].up_to) : 'zero') + '</span>' :
        '<span class="bc-tier-up">Up to ₱ <input type="number" step="0.01" min="0.01" inputmode="decimal" data-f="up_to" aria-label="Up to amount" value="' + esc(t.up_to === null ? '' : t.up_to) + '"></span>') +
        '<select data-f="approval" aria-label="Who approves">' + optionsHtml(LEVELS, t.approval) + '</select>' +
        (!last && tiers.length > 2 ? '<button type="button" class="bc-x" data-del="' + i + '" aria-label="Remove tier">✕</button>' : '') + '</div>';
    }).join('');
    root.querySelectorAll('#st-tiers [data-del]').forEach((b) => b.addEventListener('click', () => { readTiers(); tiers.splice(Number(b.dataset.del), 1); drawTiers(); }));
  }
  function readTiers() {
    root.querySelectorAll('#st-tiers [data-i]').forEach((row) => {
      const t = tiers[Number(row.dataset.i)];
      const up = row.querySelector('[data-f="up_to"]');
      if (up) t.up_to = up.value === '' ? t.up_to : Number(up.value);
      t.approval = row.querySelector('[data-f="approval"]').value;
    });
  }

  async function save() {
    const err = root.querySelector('#st-err');
    err.hidden = true;
    readTiers();
    const p = { approval_tiers: tiers.map((t, i) => ({ up_to: i === tiers.length - 1 ? null : Number(t.up_to), approval: t.approval })),
      receipt_required_above: Number(root.querySelector('#st-rcpt').value || 0), receipt_policy: root.querySelector('#st-policy').value, variance_reason_above: Number(root.querySelector('#st-var').value || 0),
      high_expense_single: Number(root.querySelector('#st-hs').value || 0), high_expense_day: Number(root.querySelector('#st-hd').value || 0), duplicate_check: root.querySelector('#st-dup').checked };
    try {
      const res = await bcSettingsSave(p);
      if (!res || !res.ok) { err.textContent = errorsText(res); err.hidden = false; return; }
      await reloadContext();
      toast('bc-msg', 'Settings saved.');
      draw();
    } catch (e) { err.textContent = e.message || String(e); err.hidden = false; }
  }

  async function reloadContext() {
    const c = await bcContext();
    if (c && c.ok) { app.ctx.settings = c.settings; app.ctx.categories = c.categories; }
  }

  async function catForm(c) {
    const out = await formDialog({
      title: c ? 'Edit category' : 'New expense category', confirmLabel: 'Save',
      bodyHtml: '<div class="bc-form-grid"><div class="field bc-span2"><label for="ct-name">Name *</label><input type="text" id="ct-name" value="' + esc(c ? c.name : '') + '"></div>' +
        '<div class="field bc-span2"><label for="ct-kind">Behaviour</label><select id="ct-kind"' + (c && c.is_system ? ' disabled' : '') + '>' + optionsHtml(KINDS, c ? c.kind : 'general') + '</select></div>' +
        '<label class="bc-check bc-span2"><input type="checkbox" id="ct-rcpt"' + (!c || c.receipt_required ? ' checked' : '') + '> A receipt is needed for this category</label>' +
        (c ? '<label class="bc-check bc-span2"><input type="checkbox" id="ct-active"' + (c.active ? ' checked' : '') + '> Show it on the Add Expense form</label>' : '') + '</div>',
      onSubmit: async (form) => {
        const p = { name: form.querySelector('#ct-name').value.trim(), kind: form.querySelector('#ct-kind').value, receipt_required: form.querySelector('#ct-rcpt').checked };
        if (c) { p.id = c.id; p.active = form.querySelector('#ct-active').checked; }
        const res = await bcCategorySave(p);
        return res && res.ok ? { close: true } : { error: errorsText(res) };
      },
    });
    if (out) { await reloadContext(); toast('bc-msg', 'Category saved.'); draw(); }
  }

  draw();
  return { refresh: draw, onShow: draw };
}
