// The metal / purity / weight LINES of one scrap transaction (Ren, 2026-10-07: "add metal & purity since there are multiple purity").
// A customer who sells 18K and 16K together is ONE entry with two lines: each line has its own metal, purity, weight and price per gram,
// the entry keeps one customer, one final amount and one set of payments. The New Scrap and the Edit forms share this editor; the list
// and the detail drawer share the label helpers. The database (create_scrap_entry_v3 / update_scrap_entry, migration 193) checks everything again.
import { purityOptionsHtml } from './metals.js?v=20261007u';

const METALS = ['Gold', 'Silver', 'Other'];
const MAX_LINES = 12;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const esc0 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The lines of an entry as loaded (scrap_entry_lines rows), in order; an entry without any rows (should not happen) reads as one line from its own columns. */
export function linesOf(r) {
  const l = (r.scrap_entry_lines || []).slice().sort((a, b) => a.line_no - b.line_no);
  return l.length ? l : [{ line_no: 1, metal_type: r.metal_type, karat: r.karat, weight_grams: r.weight_grams, price_per_gram: r.price_per_gram,
    gross_amount: r.gross_amount, amount: r.total_amount }];
}

/** "Gold 18K", "Gold 18K + 16K" (one metal, several purities) or "Gold 18K + Silver 925" (more than one metal). */
export function linesLabel(lines) {
  const metals = [...new Set(lines.map((l) => l.metal_type))];
  if (metals.length === 1) {
    const ks = [...new Set(lines.map((l) => l.karat || ''))].filter(Boolean);
    return metals[0] + (ks.length ? ' ' + ks.join(' + ') : '');
  }
  return lines.map((l) => ((l.metal_type || '') + ' ' + (l.karat || '')).trim()).join(' + ');
}

/** What an entry's lines amount to once normalised, for telling whether a correction changed them. */
export const normLines = (lines) => lines.map((l) => ({
  metal: l.metal_type || l.metal, karat: String(l.karat || '').trim(), weight: Number(l.weight_grams ?? l.weight),
  ppg: (l.price_per_gram ?? l.ppg) == null || (l.price_per_gram ?? l.ppg) === '' ? null : Number(l.price_per_gram ?? l.ppg),
  gross: (l.gross_amount ?? l.gross) == null || (l.gross_amount ?? l.gross) === '' ? null : r2(Number(l.gross_amount ?? l.gross)),
}));

/** Mounts the lines editor into `box`. opts: { esc, getMoney() -> whether price / amount fields apply (false for a transfer), onChange() }.
 * Returns { load(lines|null), read(), totals(), sync() }. */
export function mountScrapLines(box, opts) {
  const esc = (opts && opts.esc) || esc0;
  const money = () => (opts && opts.getMoney ? !!opts.getMoney() : true);
  const changed = () => { updateTotal(); if (opts && opts.onChange) opts.onChange(); };

  box.innerHTML = '<div data-lines></div>' +
    '<div class="sc-lines-foot"><button type="button" class="btn small secondary" data-add-line>+ Add another metal / purity</button>' +
    '<span class="muted">Total weight: <b data-total-w>0.000 g</b></span></div>';
  const host = box.querySelector('[data-lines]');
  const rows = () => [...host.querySelectorAll('[data-line]')];
  const f = (row, n) => row.querySelector('[data-f="' + n + '"]');

  function rowHtml(line) {
    return '<div class="sc-line" data-line>' +
      '<div class="sc-line-head"><span data-line-title></span><button type="button" class="sc-line-del" data-del-line aria-label="Remove this line" title="Remove this line">✕</button></div>' +
      '<div class="sc-row2">' +
        '<div class="field"><label>Metal *</label><select data-f="metal">' + METALS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Purity *</label><select data-f="purity"></select></div>' +
      '</div>' +
      '<div class="field" data-purity-other hidden><label>Custom purity *</label><input type="text" data-f="purityOther" placeholder="e.g. 20K"></div>' +
      '<div class="field"><label>Weight (grams) *</label><input type="number" data-f="weight" step="0.001" min="0" inputmode="decimal"></div>' +
      '<div class="sc-row2" data-money>' +
        '<div class="field"><label>Price per gram (₱)</label><input type="number" data-f="ppg" step="0.01" min="0" inputmode="decimal"></div>' +
        '<div class="field"><label>Amount (₱)</label><input type="number" data-f="gross" step="0.01" min="0" inputmode="decimal" placeholder="weight × price"></div>' +
      '</div>' +
    '</div>';
  }

  function setPurity(row, metal, selected) {
    f(row, 'purity').innerHTML = purityOptionsHtml(metal, selected);
    const custom = f(row, 'purity').value === 'Custom';
    row.querySelector('[data-purity-other]').hidden = !custom;
    f(row, 'purityOther').value = custom ? (selected || '') : '';
  }
  /** weight × price per gram fills the amount (and locks it); without a price the amount is typed. */
  function autoAmount(row) {
    const w = Number(f(row, 'weight').value) || 0, p = Number(f(row, 'ppg').value) || 0;
    const auto = w > 0 && p > 0;
    if (auto) f(row, 'gross').value = r2(w * p).toFixed(2);
    f(row, 'gross').readOnly = auto;
  }

  function addRow(line) {
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(line);
    const row = wrap.firstElementChild;
    host.appendChild(row);
    const metal = (line && (line.metal_type || line.metal)) || 'Gold';
    f(row, 'metal').value = metal;
    setPurity(row, metal, line ? String(line.karat || '').trim() : '');
    if (line && line.weight_grams != null) f(row, 'weight').value = line.weight_grams;
    if (line && line.price_per_gram != null) f(row, 'ppg').value = line.price_per_gram;
    const gross = line ? (line.gross_amount ?? line.amount) : null;
    if (gross != null) {
      // a saved amount is shown as it was saved (locked only when it is weight × price); it is recomputed only once someone edits the line
      f(row, 'gross').value = gross;
      f(row, 'gross').readOnly = (Number(f(row, 'weight').value) || 0) > 0 && (Number(f(row, 'ppg').value) || 0) > 0;
    } else autoAmount(row);
    f(row, 'metal').addEventListener('change', () => { setPurity(row, f(row, 'metal').value, ''); changed(); });
    f(row, 'purity').addEventListener('change', () => { row.querySelector('[data-purity-other]').hidden = f(row, 'purity').value !== 'Custom'; changed(); });
    ['weight', 'ppg', 'gross', 'purityOther'].forEach((n) => f(row, n).addEventListener('input', () => { if (n === 'weight' || n === 'ppg') autoAmount(row); changed(); }));
    row.querySelector('[data-del-line]').addEventListener('click', () => { row.remove(); renumber(); changed(); });
    renumber();
    return row;
  }
  function renumber() {
    const rs = rows();
    rs.forEach((row, i) => {
      row.querySelector('[data-line-title]').textContent = rs.length > 1 ? 'Metal line ' + (i + 1) : '';
      row.querySelector('.sc-line-head').hidden = rs.length < 2;
    });
    box.querySelector('[data-add-line]').disabled = rs.length >= MAX_LINES;
    sync();
  }
  /** Shows or hides the price / amount fields (a transfer carries none). */
  function sync() {
    const m = money();
    rows().forEach((row) => { row.querySelector('[data-money]').hidden = !m; });
  }
  function updateTotal() {
    const w = rows().reduce((s, row) => s + (Number(f(row, 'weight').value) || 0), 0);
    box.querySelector('[data-total-w]').textContent = w.toLocaleString('en-PH', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' g';
  }
  const purityOf = (row) => (f(row, 'purity').value === 'Custom' ? f(row, 'purityOther').value.trim() : f(row, 'purity').value);

  box.querySelector('[data-add-line]').addEventListener('click', () => {
    const rs = rows();
    if (rs.length >= MAX_LINES) return;
    const last = rs[rs.length - 1];
    const row = addRow({ metal_type: last ? f(last, 'metal').value : 'Gold', karat: '' });
    changed();
    f(row, 'purity').focus();
  });

  return {
    /** Replaces every line: `lines` are scrap_entry_lines rows (or null for one empty Gold 18K line). */
    load(lines) {
      host.innerHTML = '';
      (lines && lines.length ? lines : [{ metal_type: 'Gold', karat: '18K' }]).forEach((l) => addRow(l));
      updateTotal();
    },
    sync,
    /** Money in the lines as typed so far: sum of the amounts, and whether every / any line has one. */
    totals() {
      const rs = rows();
      let gross = 0, weight = 0, all = rs.length > 0, any = false;
      rs.forEach((row) => {
        weight += Number(f(row, 'weight').value) || 0;
        const g = f(row, 'gross').value;
        if (g !== '') any = true;
        if (!(Number(g) > 0)) all = false;
        gross += Number(g) || 0;
      });
      return { weight, gross: r2(gross), all, any, count: rs.length };
    },
    /** The lines ready to send, or { error, el } for the first problem (el = the box to highlight). */
    read() {
      const rs = rows(), multi = rs.length > 1, m = money(), lines = [];
      for (let i = 0; i < rs.length; i++) {
        const row = rs[i], on = multi ? ' on line ' + (i + 1) : '';
        const purity = purityOf(row);
        if (!purity) return { error: 'Choose the purity' + on + ' (or type a custom one).', el: f(row, f(row, 'purity').value === 'Custom' ? 'purityOther' : 'purity') };
        const w = Number(f(row, 'weight').value);
        if (!(w > 0)) return { error: 'Enter the weight in grams (more than 0)' + on + '.', el: f(row, 'weight') };
        const ppg = f(row, 'ppg').value === '' ? null : Number(f(row, 'ppg').value);
        const gross = Number(f(row, 'gross').value);
        if (m && !(gross > 0)) return { error: 'Enter the amount' + on + ': a price per gram, or the amount.', el: f(row, ppg ? 'gross' : 'ppg') };
        lines.push({ metal: f(row, 'metal').value, karat: purity, weight: w, price_per_gram: m ? ppg : null, gross: m ? r2(gross) : null });
      }
      return { lines };
    },
  };
}
