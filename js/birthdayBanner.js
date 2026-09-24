// Birthday announcement banner (Ren, 2026-09-24: "add an announcement both erp and pos
// if there is a staff who has a bday under miss kittymae only show a banner for a
// minute and can click the X if they want. based the birthday banner on hr 201 when is
// there birthday.") -- called once from each app's shared shell (shell.js/posNav.js),
// so every page in both apps shows it without each page needing its own wiring.
import { getTodaysBirthdays } from './api.js?v=20260923g';
import { localDateStr } from './uiKit.js?v=20260923g';

function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

/** At most once per calendar day (localStorage, Manila date via localDateStr()) --
 * every page in both apps calls this, so without this guard a staff member clicking
 * around would see it re-appear on every single navigation. Fails silently (never
 * blocks page load) if storage is unavailable or the check itself fails. */
export async function showBirthdayBanner() {
  const today = localDateStr();
  const storageKey = 'km_bday_banner_shown_' + today;
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

  const label = 'Happy Birthday, ' + joinNames(rows.map((r) => r.full_name)) + '!';

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:3000;background:#fff3cd;color:#7a5c00;border-bottom:1px solid #f0d878;padding:10px 44px 10px 16px;font-size:14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.12);';
  bar.textContent = label;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.style.cssText = 'position:absolute;top:0;right:0;bottom:0;background:none;border:none;font-size:16px;cursor:pointer;color:inherit;padding:0 16px;';
  bar.appendChild(closeBtn);
  document.body.prepend(bar);

  const remove = () => bar.remove();
  closeBtn.addEventListener('click', remove);
  setTimeout(remove, 60000);

  try { localStorage.setItem(storageKey, '1'); } catch (err) {}
}
