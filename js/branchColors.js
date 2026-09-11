// Ren's pastel palette, in his given order -- shared by two independent things:
// branches (a subset, assigned by display_order so a given branch is always the
// same color everywhere) and Record Movement's Movement Type (the full set, since
// there are exactly 9 movement types for 9 colors).
export const PASTEL_COLORS = [
  { name: 'Pink Pastel',   bg: '#fbdce7', text: '#a83e64' },
  { name: 'Blue Pastel',   bg: '#dcebfb', text: '#2f6690' },
  { name: 'Orange Pastel', bg: '#fde2c8', text: '#b06a1f' },
  { name: 'Lavender',      bg: '#e4e0fb', text: '#5b52a3' },
  { name: 'Purple Pastel', bg: '#ecd9f7', text: '#7c3aa8' },
  { name: 'Peach Pastel',  bg: '#ffe6d9', text: '#c06a3f' },
  { name: 'Green Pastel',  bg: '#dcf3df', text: '#2e7d4f' },
  { name: 'Beige Pastel',  bg: '#f3ecd9', text: '#8a7440' },
  { name: 'Red Pastel',    bg: '#fbdcdc', text: '#b23c3c' },
];

/** branches must be the real list from getBranches() (sorted by display_order,
 * no synthetic "All Branches" entry) so a branch's color is stable everywhere. */
export function branchColor(branchId, branches) {
  const idx = branches.findIndex((b) => b.id === branchId);
  return PASTEL_COLORS[(idx < 0 ? 0 : idx) % PASTEL_COLORS.length];
}

export function branchBadge(esc, name, branchId, branches) {
  const c = branchColor(branchId, branches);
  return '<span class="badge" style="background:' + c.bg + ';color:' + c.text + ';">' + esc(name) + '</span>';
}

/** Inline style for a branch selector button -- filled when selected, a colored
 * outline chip when not, so a branch's color reads even before you pick it. */
export function branchButtonStyle(branchId, branches, isSelected) {
  const c = branchColor(branchId, branches);
  return isSelected
    ? 'background:' + c.bg + ';color:' + c.text + ';border:1px solid ' + c.text + ';'
    : 'background:#fff;color:' + c.text + ';border:1px solid ' + c.bg + ';';
}

/** Inline style for a branch <option> in a <select>. */
export function branchOptionStyle(branchId, branches) {
  const c = branchColor(branchId, branches);
  return 'background:' + c.bg + ';color:' + c.text + ';';
}
