// Paging for the long lists on the Branches page (25 rows a page by default, 25 / 50 / 100 on request). The tabs already
// hold the branch's rows in memory -- the summaries above them come from the server, so what is shown on a page never
// changes a total -- so paging is just a slice plus a small footer.
export const PAGE_SIZE = 25;
export const PAGE_SIZES = [25, 50, 100];

/** state = { page, size? } (kept by the caller and clamped here; `size` is set by the footer's rows selector). Returns the
 * rows for the current page + what the footer needs. */
export function pageSlice(rows, state, size) {
  size = Number(size || state.size) || PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  state.page = Math.min(Math.max(1, state.page || 1), pages);
  const start = (state.page - 1) * size;
  return { rows: rows.slice(start, start + size), start, pages, total: rows.length, size, page: state.page };
}

/** Footer HTML; empty when everything fits on the smallest page size. */
export function pagerHtml(info) {
  if (info.total <= PAGE_SIZES[0]) return '';
  const from = info.start + 1, to = Math.min(info.start + info.size, info.total);
  return '<div class="pager" role="navigation" aria-label="Pages">' +
    '<button type="button" class="btn small secondary" data-pg="prev"' + (info.page <= 1 ? ' disabled' : '') + '>‹ Previous</button>' +
    '<span class="muted">Showing ' + from + '–' + to + ' of ' + info.total + ' · page ' + info.page + ' of ' + info.pages + '</span>' +
    '<label class="pager-size muted">Rows <select data-pgsize aria-label="Rows per page">' +
      PAGE_SIZES.map((n) => '<option value="' + n + '"' + (n === info.size ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' +
    '<button type="button" class="btn small secondary" data-pg="next"' + (info.page >= info.pages ? ' disabled' : '') + '>Next ›</button>' +
  '</div>';
}

/** Wires the Previous/Next buttons and the rows selector pagerHtml() rendered inside `container`. */
export function wirePager(container, state, onChange) {
  container.querySelectorAll('[data-pg]').forEach((btn) => btn.addEventListener('click', () => {
    state.page = (state.page || 1) + (btn.dataset.pg === 'next' ? 1 : -1);
    onChange();
  }));
  container.querySelectorAll('[data-pgsize]').forEach((sel) => sel.addEventListener('change', () => {
    state.size = Number(sel.value) || PAGE_SIZE;
    state.page = 1;
    onChange();
  }));
}
