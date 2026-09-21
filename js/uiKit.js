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
