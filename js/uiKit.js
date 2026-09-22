// Shared UI helpers for Ren's MASTER UI / FILTER / RESPONSIVE rules (2026-09-21,
// sections 28-31): one "active filters" strip that sits under every module's filter
// card, and one empty-state block that always offers the next sensible action
// (clear the filters, or create the first record). Pure HTML builders plus a tiny
// wiring helper -- no state of their own, so every module uses them identically.
// Chip/message text is inserted as-is: callers escape any user-entered value first.

export function activeFiltersHtml(chips, clearId) {
  const on = chips.filter((c) => c.value !== '' && c.value !== null && c.value !== undefined && c.value !== 'all');
  if (!on.length) return '';
  return '<div class="active-filters" role="status"><span class="active-filters-label">Active filters:</span>' +
    on.map((c) => '<span class="filter-chip">' + c.label + ': <b>' + c.value + '</b></span>').join('') +
    (clearId ? ' <button type="button" class="act-link" data-clear-for="' + clearId + '">Clear all</button>' : '') +
    '</div>';
}

export function emptyStateHtml({ message, hasFilters, clearId, createLabel, createId }) {
  return '<div class="empty-state">' +
    '<div class="empty-state-msg">' + message + '</div>' +
    ((hasFilters && clearId) || (createLabel && createId)
      ? '<div class="empty-state-actions">' +
          (hasFilters && clearId ? '<button type="button" class="btn small secondary" data-clear-for="' + clearId + '">Clear filters</button>' : '') +
          (createLabel && createId ? '<button type="button" class="btn small" data-click-for="' + createId + '">' + createLabel + '</button>' : '') +
        '</div>'
      : '') +
  '</div>';
}

/** Buttons rendered by the two helpers above proxy their click to the module's own
 * existing control (its Clear Filters button, or its "+ New" button) by id, so the
 * module keeps exactly one clear/create code path. */
export function wireProxyButtons(root) {
  root.querySelectorAll('[data-clear-for], [data-click-for]').forEach((b) => b.addEventListener('click', () => {
    const target = document.getElementById(b.dataset.clearFor || b.dataset.clickFor);
    if (target) target.click();
  }));
}

// ---- Global Filter + Sort rules (Ren, 2026-09-21, 37 sections) ----
// One field-select + direction-toggle control is the ONLY sort UI anywhere in the
// system -- never a per-column clickable <th> alone -- because every list collapses to
// a header-less mobile card view below 760px (css/styles.css: ".table-scroll thead tr
// {display:none}"). A control that only works via the table header would silently stop
// working on a phone (spec section 7). The same { field, dir } object drives desktop,
// tablet and mobile alike (section 9) -- one state, rendered once, never duplicated
// per breakpoint.

/** Renders the Sort field-select + direction-toggle button. `fields` is
 * [{ key, label }]; `sort` is the module's live { field, dir } state (read here only
 * to mark the current selection/label -- callers still own the object). Always placed
 * right before a module's own Clear Filters button, so "Sort By" + "Clear Filters"
 * sit together at the end of every filter row (consistent position, section 3/32). */
export function sortControlHtml(fields, sort, selectId, dirId) {
  const opts = fields.map((f) => '<option value="' + f.key + '"' + (sort.field === f.key ? ' selected' : '') + '>' + f.label + '</option>').join('');
  return '<div class="field"><label>Sort By</label><select id="' + selectId + '">' + opts + '</select></div>' +
    '<div class="field"><label>Direction</label><button type="button" class="btn small secondary" id="' + dirId + '" aria-label="Toggle sort direction">' +
      (sort.dir === 'asc' ? '↑ Ascending' : '↓ Descending') + '</button></div>';
}

/** Wires the two controls sortControlHtml() renders to the live `sort` object,
 * calling `onChange` (the module's own render()) whenever either changes. The
 * dropdown and the button mutate the SAME object applySort() below reads, so there is
 * exactly one source of truth for sort order regardless of screen size (section 9). */
export function wireSortControl(selectId, dirId, sort, onChange) {
  const sel = document.getElementById(selectId);
  const btn = document.getElementById(dirId);
  if (sel) sel.addEventListener('change', () => { sort.field = sel.value; onChange(); });
  if (btn) btn.addEventListener('click', () => {
    sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    btn.textContent = sort.dir === 'asc' ? '↑ Ascending' : '↓ Descending';
    onChange();
  });
}

/** Applies `sort` to an already-FILTERED array via the field's own comparator from
 * `comparators` ({ key: (a,b)=>number }, same contract as Array.prototype.sort). An
 * unrecognized/missing field is a no-op, so a stale stored sort.field never throws.
 * Always returns a new array -- never mutates `rows` -- because callers commonly reuse
 * the filtered (pre-sort) array for tiles/totals right after sorting it: sorting must
 * never change what's counted or summed (section 11), only the display order. */
export function applySort(rows, sort, comparators) {
  const cmp = comparators[sort && sort.field];
  if (!cmp) return rows;
  const dirMul = sort && sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => cmp(a, b) * dirMul);
}

// Shared comparator builders so a module writes byText('customer_name') instead of
// hand-rolling localeCompare/subtraction every time a new sortable field is added.
export const byText = (key) => (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''));
export const byNumber = (key) => (a, b) => Number(a[key] || 0) - Number(b[key] || 0);
// Date/datetime strings (ISO "YYYY-MM-DD" or timestamptz) sort correctly as plain
// text, so this is really just byText with a clearer name at call sites.
export const byDate = (key) => (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''));

// "Today" (or an arbitrary Date) as a local YYYY-MM-DD string -- NOT
// date.toISOString().slice(0, 10), which reports UTC's calendar day. In Manila
// (UTC+8) that's wrong for 8 hours every day (local midnight through 7:59am is
// still "yesterday" in UTC) and, for any Date built from a local-midnight string
// (new Date('2026-09-25T00:00:00')) plus a day offset, wrong ALWAYS -- local
// midnight is always the previous UTC calendar day at a positive UTC offset. Found
// 2026-09-21 when a POS sale rung up in the middle of the night saved under
// yesterday's date and didn't show up where staff expected it.
export function localDateStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Points directly at the field a validation toast is talking about -- a toast alone
// says what's wrong but not where, easy to miss on a long form or a phone screen
// (Ren, 2026-09-22: repeated "cannot save" reports that turned out to be a missed
// required-field toast, not an actual save failure). Scrolls it into view, focuses
// it, and outlines it in red until the person actually touches it.
export function flagInvalid(el) {
  if (!el) return;
  el.style.outline = '2px solid #d32f2f';
  el.style.outlineOffset = '1px';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  const clear = () => { el.style.outline = ''; el.style.outlineOffset = ''; el.removeEventListener('input', clear); el.removeEventListener('change', clear); };
  el.addEventListener('input', clear);
  el.addEventListener('change', clear);
}
