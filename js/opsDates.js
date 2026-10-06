// Date helpers for the Branches page. Everything here is in Manila time (Asia/Manila)
// regardless of the viewer's own clock/timezone, because that is the business day the
// database reports (branch_ops_summary() buckets by Manila date) -- the tables below the
// summary must bucket by the exact same day or the cards and the lists would disagree
// for the hours around midnight (the old POS filter compared the raw UTC timestamp text
// to a date, so a sale rung up at 3 AM Manila landed on the previous day).
const MANILA = 'Asia/Manila';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit' });

/** A Date / ISO timestamp / epoch -> 'YYYY-MM-DD' in Manila time ('' if unparseable).
 * A bare 'YYYY-MM-DD' string is already a calendar date and is returned untouched. */
export function manilaDateStr(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dayFmt.format(dt);
}
export const manilaToday = () => manilaDateStr(new Date());

function parts(ymd) { const [y, m, d] = ymd.split('-').map(Number); return { y, m, d }; }
export function addDays(ymd, n) {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Calendar-month arithmetic that clamps the day like Postgres does
 * (2026-01-31 + 1 month = 2026-02-28), so the deadline shown here equals layaway_deadline(). */
export function addMonths(ymd, months) {
  const { y, m, d } = parts(ymd);
  const idx = (m - 1) + Number(months || 0);
  const ty = y + Math.floor(idx / 12), tm = ((idx % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}
const utcMs = (ymd) => { const { y, m, d } = parts(ymd); return Date.UTC(y, m - 1, d); };
/** Whole calendar days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier). */
export const daysBetween = (fromYmd, toYmd) => Math.round((utcMs(toYmd) - utcMs(fromYmd)) / 86400000);

export const RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'lastmonth', label: 'Last Month' },
  { key: 'custom', label: 'Custom' },
  { key: 'all', label: 'All Time' },
];

/** Resolves a preset key (+ the custom {from,to} for 'custom') to { from, to } dates. */
export function rangeFor(preset, custom) {
  const today = manilaToday();
  const { y, m } = parts(today);
  const firstOfMonth = today.slice(0, 8) + '01';
  switch (preset) {
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'week': {
      const dow = new Date(Date.UTC(y, m - 1, parts(today).d)).getUTCDay(); // 0 = Sunday
      return { from: addDays(today, -((dow + 6) % 7)), to: today };          // weeks run Monday-Sunday
    }
    case 'month': return { from: firstOfMonth, to: today };
    case 'lastmonth': { const end = addDays(firstOfMonth, -1); return { from: end.slice(0, 8) + '01', to: end }; }
    case 'all': return { from: addDays(today, -3650), to: today }; // ten years back: always inside the report's range limit
    case 'custom': {
      const from = custom && custom.from ? custom.from : today;
      const to = custom && custom.to ? custom.to : today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    default: return { from: today, to: today };
  }
}

const labelFmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const labelDay = (ymd) => labelFmt.format(new Date(ymd + 'T00:00:00Z'));
/** "Oct 7, 2026" / "Oct 1, 2026 – Oct 7, 2026" / "All time". */
export function describeRange(preset, range) {
  if (preset === 'all') return 'All time';
  return range.from === range.to ? labelDay(range.from) : labelDay(range.from) + ' – ' + labelDay(range.to);
}
