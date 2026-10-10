// Branch Operations settings (branch_ops_settings table, migration 166), loaded once when
// the Branches page opens so every tab uses the same layaway deadline rule the database
// reports use (layaway_deadline()). Falls back to the built-in defaults if the lookup
// fails -- a settings hiccup must never stop the page from opening.
import { getBranchOpsSettings } from './api.js?v=20261011a';
import { addMonths } from './opsDates.js?v=20261011a';

export const OPS_DEFAULTS = {
  forfeitMonths: 2,
  nearingDays: 15,
  reminderStages: [30, 14, 7, 3, 1, 0],
  reminderTemplate: 'Hi [Customer Name], this is a reminder from KittyMae regarding your reserved item under Order #[Order]. Your remaining balance is ₱[Balance], and the reservation deadline is [Date]. Please contact the branch if you need assistance.',
  reminderRepeatDays: 7,
  viewEnforced: false,
};

let cfg = { ...OPS_DEFAULTS };

export async function loadOpsConfig() {
  try {
    const s = await getBranchOpsSettings();
    cfg = {
      forfeitMonths: Number.isFinite(Number(s.layaway_forfeit_months)) ? Number(s.layaway_forfeit_months) : OPS_DEFAULTS.forfeitMonths,
      nearingDays: Number.isFinite(Number(s.layaway_nearing_days)) ? Number(s.layaway_nearing_days) : OPS_DEFAULTS.nearingDays,
      reminderStages: Array.isArray(s.layaway_reminder_stages) ? s.layaway_reminder_stages.map(Number).filter(Number.isFinite) : OPS_DEFAULTS.reminderStages,
      reminderTemplate: typeof s.layaway_reminder_template === 'string' && s.layaway_reminder_template ? s.layaway_reminder_template : OPS_DEFAULTS.reminderTemplate,
      reminderRepeatDays: Number.isFinite(Number(s.layaway_reminder_repeat_days)) && Number(s.layaway_reminder_repeat_days) > 0 ? Number(s.layaway_reminder_repeat_days) : OPS_DEFAULTS.reminderRepeatDays,
      viewEnforced: s.branch_view_enforced === true,
    };
  } catch (err) { cfg = { ...OPS_DEFAULTS }; }
  return cfg;
}
export const getOpsConfig = () => cfg;

/** The effective layaway deadline -- same rule as layaway_deadline() in the database: an
 * explicit Forfeit Date wins, otherwise the layaway date plus the configured calendar months. */
export const layawayDeadline = (forfeitDate, holdDate) => forfeitDate || addMonths(holdDate, cfg.forfeitMonths);
