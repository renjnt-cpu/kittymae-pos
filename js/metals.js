// Metals and purities offered by the Scrap and Subasta forms, so both record -- and later report -- the same values
// (scrap_ops_report groups Gold by these karats; anything else lands in "Other").
export const METALS = ['Gold', 'Silver', 'Other'];
export const GOLD_PURITIES = ['10K', '14K', '16K', '18K', '21K', '22K', '24K'];
export const SILVER_PURITIES = ['999', '925', '800'];

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** <option>s for the purity box of a metal: a first "choose" row, the standard purities, then "Custom…". A saved purity that
 * is not on the list (e.g. "20K") selects Custom so it is never silently lost. */
export function purityOptionsHtml(metal, selected, blankLabel = '— choose —') {
  const list = metal === 'Gold' ? GOLD_PURITIES : metal === 'Silver' ? SILVER_PURITIES : [];
  const custom = !!selected && !list.includes(selected);
  return '<option value="">' + escHtml(blankLabel) + '</option>' +
    list.map((p) => '<option' + (p === selected ? ' selected' : '') + '>' + p + '</option>').join('') +
    '<option value="Custom"' + (custom ? ' selected' : '') + '>Custom…</option>';
}

/** Wires a form's metal / purity / custom-purity inputs (names `metal`, `purity`, `purityOther`; the custom box sits in a
 * wrapper with [data-purity-other]). Returns { set(metal, purity), read() }: read() is the purity text to save ('' = none). */
export function purityFields(form, blankLabel) {
  const el = (n) => form.elements[n];
  const wrap = form.querySelector('[data-purity-other]');
  function set(metal, selected) {
    el('metal').value = metal;
    el('purity').innerHTML = purityOptionsHtml(metal, selected, blankLabel);
    const custom = el('purity').value === 'Custom';
    wrap.hidden = !custom;
    el('purityOther').value = custom ? (selected || '') : '';
  }
  el('metal').addEventListener('change', () => { el('purity').innerHTML = purityOptionsHtml(el('metal').value, '', blankLabel); el('purityOther').value = ''; wrap.hidden = true; });
  el('purity').addEventListener('change', () => { wrap.hidden = el('purity').value !== 'Custom'; });
  return { set, read: () => (el('purity').value === 'Custom' ? el('purityOther').value.trim() : el('purity').value) };
}
