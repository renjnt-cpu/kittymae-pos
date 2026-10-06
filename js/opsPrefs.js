// The two choices the Branches page and the Branch Dashboard share, remembered in this browser only: the date range (Today /
// Yesterday / This Week / ... / All Time) and the branch last looked at. Sharing them is what makes a dashboard card open the
// operational page on the same dates and branch -- the number clicked is the number found in the list.
import { RANGE_PRESETS, rangeFor, describeRange } from './opsDates.js?v=20261007o';

const STORE_KEY = 'km-branch-ops-v1';
const BRANCH_KEY = 'km-branch-sel-v1';

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}
export function savePrefs(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* private window / blocked storage: the preference just isn't remembered */ }
}
/** The remembered range choice, validated: an unknown preset or an incomplete custom range falls back to Today. */
export function savedRange(prefs) {
  let preset = RANGE_PRESETS.some((p) => p.key === prefs.preset) ? prefs.preset : 'today';
  const custom = prefs.custom && prefs.custom.from && prefs.custom.to ? prefs.custom : { from: '', to: '' };
  if (preset === 'custom' && !(custom.from && custom.to)) preset = 'today';
  return { preset, custom };
}
/** { preset, from, to, label } for a preset (+ the custom dates for 'custom'). */
export function resolveRange(preset, custom) {
  const r = rangeFor(preset, custom);
  return { preset, from: r.from, to: r.to, label: describeRange(preset, r) };
}
/** The range the pages should start with. */
export function getInitialRange() {
  const { preset, custom } = savedRange(loadPrefs());
  return resolveRange(preset, custom);
}
/** Saves a range choice without disturbing the other remembered values (such as the dashboard's branch scope). */
export function saveRange(preset, custom) {
  savePrefs({ ...loadPrefs(), preset, custom });
}

export function loadBranchPref() {
  try { const n = Number(localStorage.getItem(BRANCH_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch (e) { return null; }
}
export function saveBranchPref(id) {
  try { localStorage.setItem(BRANCH_KEY, String(id)); } catch (e) { /* not remembered */ }
}
