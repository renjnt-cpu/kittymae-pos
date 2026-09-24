// Birthday announcement banner (Ren, 2026-09-24: "add an announcement both erp and pos
// if there is a staff who has a bday... based the birthday banner on hr 201 when is
// there birthday" -- then, after testing: "make it big and center add also from miss
// kittymae jewels with fireworks and balloon") -- called once from each app's shared
// shell (shell.js/posNav.js), so every page in both apps shows it without each page
// needing its own wiring.
import { getTodaysBirthdays } from './api.js?v=20260923j';
import { localDateStr } from './uiKit.js?v=20260923j';

const STYLE_ID = 'km-bday-style';
const FIREWORKS = ['\u{1F386}', '\u{1F387}', '\u{1F386}'];
const BALLOONS = ['\u{1F388}', '\u{1F388}', '\u{1F388}'];

function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '@keyframes km-bday-pop { 0%,100% { transform:scale(0.85); opacity:0.55; } 50% { transform:scale(1.2); opacity:1; } }' +
    '@keyframes km-bday-float { 0% { transform:translateY(0) rotate(-4deg); } 50% { transform:translateY(-16px) rotate(4deg); } 100% { transform:translateY(0) rotate(-4deg); } }' +
    '@keyframes km-bday-in { from { transform:scale(0.8); opacity:0; } to { transform:scale(1); opacity:1; } }' +
    '.km-bday-overlay { position:fixed; inset:0; z-index:3000; display:flex; align-items:center; justify-content:center; pointer-events:none; padding:16px; box-sizing:border-box; }' +
    '.km-bday-card { pointer-events:auto; position:relative; max-width:min(92vw, 440px); background:linear-gradient(160deg,#fff7e6,#ffe9d6); border:1px solid #f6d9a8; border-radius:18px; box-shadow:0 12px 32px rgba(0,0,0,0.22); padding:38px 30px 30px; text-align:center; animation:km-bday-in 0.35s ease-out; }' +
    '.km-bday-decor { font-size:30px; line-height:1; display:flex; justify-content:center; gap:14px; margin-bottom:6px; }' +
    '.km-bday-decor span { display:inline-block; animation:km-bday-pop 1.6s ease-in-out infinite; }' +
    '.km-bday-decor span:nth-child(2) { animation-delay:0.3s; font-size:1.15em; }' +
    '.km-bday-decor span:nth-child(3) { animation-delay:0.6s; }' +
    '.km-bday-balloons { font-size:30px; line-height:1; display:flex; justify-content:center; gap:14px; margin-bottom:14px; }' +
    '.km-bday-balloons span { display:inline-block; animation:km-bday-float 3s ease-in-out infinite; }' +
    '.km-bday-balloons span:nth-child(2) { animation-delay:0.5s; }' +
    '.km-bday-balloons span:nth-child(3) { animation-delay:1s; }' +
    '.km-bday-title { font-size:26px; font-weight:800; color:#a45c00; margin-bottom:6px; }' +
    '.km-bday-subtitle { font-size:14px; color:#a97a3f; font-weight:600; letter-spacing:0.02em; }' +
    '.km-bday-close { position:absolute; top:10px; right:12px; background:none; border:none; font-size:18px; line-height:1; cursor:pointer; color:#a97a3f; padding:6px; }' +
    '@media (max-width:480px) { .km-bday-card { padding:30px 20px 22px; } .km-bday-title { font-size:21px; } .km-bday-decor, .km-bday-balloons { font-size:24px; } }';
  document.head.appendChild(style);
}

/** At most once per calendar day (localStorage, Manila date via localDateStr()) --
 * every page in both apps calls this, so without this guard a staff member clicking
 * around would see it re-appear on every single navigation. Fails silently (never
 * blocks page load) if storage is unavailable or the check itself fails. */
export async function showBirthdayBanner() {
  // Disabled (Ren, 2026-09-24: "remove the banner now before other staff can see
  // it") -- pending further testing before it goes live for real staff use again.
  return;
  // eslint-disable-next-line no-unreachable
  const today = localDateStr();
  // The _v2 suffix is deliberate: testing the first (thin-strip) design already set
  // today's plain key in real browsers, which would otherwise silently suppress the
  // redesigned banner with no way to tell from the outside. Bump this suffix again
  // only if the same situation recurs -- it doesn't need to track every future change.
  const storageKey = 'km_bday_banner_shown_v2_' + today;
  try {
    if (localStorage.getItem(storageKey)) return;
  } catch (err) { /* private window / blocked storage -- fall through and just check */ }

  let rows;
  try {
    rows = await getTodaysBirthdays();
  } catch (err) {
    return;
  }

  if (!rows || !rows.length) {
    try { localStorage.setItem(storageKey, '1'); } catch (err) {}
    return;
  }

  ensureStyle();

  const overlay = document.createElement('div');
  overlay.className = 'km-bday-overlay';
  overlay.innerHTML =
    '<div class="km-bday-card">' +
      '<button type="button" class="km-bday-close" aria-label="Dismiss">✕</button>' +
      '<div class="km-bday-decor">' + FIREWORKS.map((f) => '<span>' + f + '</span>').join('') + '</div>' +
      '<div class="km-bday-balloons">' + BALLOONS.map((b) => '<span>' + b + '</span>').join('') + '</div>' +
      '<div class="km-bday-title"></div>' +
      '<div class="km-bday-subtitle">From Miss Kittymae Jewels</div>' +
    '</div>';
  // .textContent, not innerHTML, for the name(s) -- they're real data, not markup.
  overlay.querySelector('.km-bday-title').textContent = 'Happy Birthday, ' + joinNames(rows.map((r) => r.full_name)) + '!';
  document.body.appendChild(overlay);

  const remove = () => overlay.remove();
  overlay.querySelector('.km-bday-close').addEventListener('click', remove);
  setTimeout(remove, 60000);

  try { localStorage.setItem(storageKey, '1'); } catch (err) {}
}
