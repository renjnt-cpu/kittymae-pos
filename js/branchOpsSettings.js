// Branch Operations settings drawer (Admin only -- set_branch_ops_setting() enforces that
// server-side too). The layaway deadline rule, the "nearing" window and the reminder schedule
// every report and tab on the Branches page shares live here. Opened from the Branch Operations
// Summary header. Includes the switch that limits each employee to their own branch(es) -- backed by
// the database (migration 170), not just by hiding buttons.
import { setBranchOpsSetting } from './api.js?v=20261007k';
import { loadOpsConfig, getOpsConfig } from './branchOpsConfig.js?v=20261007k';
import { confirmDialog } from './dialogs.js?v=20261007k';

let mounted = false;
function mount() {
  if (mounted) return;
  mounted = true;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="drawer-backdrop" id="bos-backdrop"></div>' +
    '<div class="drawer" id="bos-drawer" role="dialog" aria-label="Branch Operations settings">' +
      '<div class="drawer-header"><div><h3>Branch Operations settings</h3><div class="muted">Admin only</div></div>' +
      '<button type="button" class="drawer-close" id="bos-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body"><div id="bos-msg"></div><form id="bos-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:12px;"></form></div>' +
      '<div class="drawer-footer"><button type="submit" form="bos-form" class="btn" id="bos-save">Save settings</button>' +
      '<button type="button" class="btn secondary" id="bos-cancel">Cancel</button></div>' +
    '</div>';
  document.body.appendChild(wrap);
  const close = () => { document.getElementById('bos-backdrop').classList.remove('open'); document.getElementById('bos-drawer').classList.remove('open'); };
  document.getElementById('bos-close').addEventListener('click', close);
  document.getElementById('bos-cancel').addEventListener('click', close);
  document.getElementById('bos-backdrop').addEventListener('click', close);
}

/** Opens the drawer; `onSaved()` runs after something changed (the host refreshes its reports/tabs). */
export function openOpsSettings({ esc, onSaved }) {
  mount();
  const cfg = getOpsConfig();
  const form = document.getElementById('bos-form');
  const msg = document.getElementById('bos-msg');
  msg.innerHTML = '';
  form.innerHTML =
    '<div class="drawer-section"><h4>Layaway deadline</h4>' +
      '<div class="field"><label for="bos-months">A layaway with no Forfeit Date is due after (months)</label><input type="number" id="bos-months" min="0" max="36" step="1" value="' + cfg.forfeitMonths + '"></div>' +
      '<div class="field"><label for="bos-near">"Nearing deadline" starts this many days before it</label><input type="number" id="bos-near" min="0" max="36" step="1" value="' + cfg.nearingDays + '"></div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Customer reminders</h4>' +
      '<div class="field"><label for="bos-stages">Remind at these days before the deadline (comma-separated, 0 = due today)</label><input type="text" id="bos-stages" value="' + esc(cfg.reminderStages.join(', ')) + '"></div>' +
      '<div class="field"><label for="bos-repeat">Chase an overdue customer again every (days)</label><input type="number" id="bos-repeat" min="1" max="108" step="1" value="' + cfg.reminderRepeatDays + '"></div>' +
      '<div class="field"><label for="bos-template">Message template</label><textarea id="bos-template" rows="5">' + esc(cfg.reminderTemplate) + '</textarea>' +
        '<span class="muted">Placeholders: [Customer Name] [Order] [Balance] [Date]. Reminders are copied and sent by a person -- never automatically.</span></div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Branch visibility</h4>' +
      '<label class="pos-check"><input type="checkbox" id="bos-enforce"' + (cfg.viewEnforced ? ' checked' : '') + '> Limit each employee to their own branch(es)</label>' +
      '<p class="muted" style="margin:6px 0 0;">When on, this is enforced by the database itself: only Admin/Manager, Sales Admin Associates, supervisors with company-wide access and people granted "Branches — See every branch" can read other branches\x27 layaways, scrap, Subasta and POS records; everyone else sees only the branch they belong to.</p>' +
    '</div>';

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('bos-save');
    const num = (id) => Number(document.getElementById(id).value);
    const stages = document.getElementById('bos-stages').value.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    if (stages.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) { msg.innerHTML = '<div class="msg error">Reminder days must be whole numbers from 0 to 365, separated by commas.</div>'; return; }
    const changes = [];
    const push = (key, value, same) => { if (!same) changes.push([key, value]); };
    push('layaway_forfeit_months', num('bos-months'), num('bos-months') === cfg.forfeitMonths);
    push('layaway_nearing_days', num('bos-near'), num('bos-near') === cfg.nearingDays);
    push('layaway_reminder_stages', stages, JSON.stringify(stages) === JSON.stringify(cfg.reminderStages));
    push('layaway_reminder_repeat_days', num('bos-repeat'), num('bos-repeat') === cfg.reminderRepeatDays);
    push('layaway_reminder_template', document.getElementById('bos-template').value.trim(), document.getElementById('bos-template').value.trim() === cfg.reminderTemplate);
    const enforce = document.getElementById('bos-enforce').checked;
    if (enforce !== cfg.viewEnforced) {
      const ok = await confirmDialog({
        title: enforce ? 'Limit employees to their own branch?' : 'Let everyone see every branch again?',
        message: enforce ? 'From now on people only see the branch(es) they belong to -- in the lists, in the summary and in the database. Admin/Manager and company-wide roles are not affected.'
          : 'Branch restrictions are switched off: everyone with access to the Branches page sees every branch again.',
        confirmLabel: enforce ? 'Turn on' : 'Turn off',
      });
      if (!ok) return;
      push('branch_view_enforced', enforce, false);
    }
    if (!changes.length) { msg.innerHTML = '<div class="msg ok">Nothing changed.</div>'; return; }
    btn.disabled = true;
    try {
      for (const [key, value] of changes) await setBranchOpsSetting(key, value);
      await loadOpsConfig();
      msg.innerHTML = '<div class="msg ok">Saved.</div>';
      if (onSaved) await onSaved(changes.map((c) => c[0]));
      setTimeout(() => { document.getElementById('bos-backdrop').classList.remove('open'); document.getElementById('bos-drawer').classList.remove('open'); }, 600);
    } catch (err) {
      msg.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('bos-backdrop').classList.add('open');
  document.getElementById('bos-drawer').classList.add('open');
}
