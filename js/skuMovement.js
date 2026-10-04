// SKU movement history -- a read-only drawer that shows everything that has ever moved a SKU's stock: transfers (with the transfer ID,
// route, quantity and the stock before and after), sales, online orders, stock in, adjustments, reservations and pull-outs.
// It only READS the stock ledger (inventory_transactions) and the live inventory -- nothing here can change stock or a SKU.
//
// This file is shared: the ERP app and the POS app are separate sites, so each carries an identical copy (keep them byte-identical).
// The page passes in its own Supabase client, so the copy needs no imports and no cache-busting token of its own:
//     openSkuMovement(supabase, 'SPE006', { branchId: 3, transferUrl: 'transfers.html?open=' })
// `branchId` (optional) opens the history already filtered to one branch; `transferUrl` is where a transfer ID links to.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v || 0).toLocaleString('en-PH');
const signed = (v) => (Number(v) > 0 ? '+' : '') + num(v);
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const LIMIT = 1000;
const GROUPS = [['all', 'All movements'], ['transfer', 'Transfers'], ['sales', 'Sales & orders'], ['stock', 'Stock in & adjustments'], ['holds', 'Reservations & pull-outs']];
const groupOf = (r) => (r.transfer_id || /^Branch Transfer/.test(r.transaction_type) ? 'transfer' : /^(Sale|Online Order)/.test(r.transaction_type) ? 'sales' : /^(Reservation|Pull Out)/.test(r.transaction_type) ? 'holds' : 'stock');
const LABEL = { 'Branch Transfer Out': 'Transfer out', 'Branch Transfer In': 'Transfer in' };
const tagClass = (t) => (t === 'Branch Transfer Out' ? 'sm-tag-out' : t === 'Branch Transfer In' ? 'sm-tag-in' : '');

let S = null; // { sku, product, stock, branches, byBranch, rows, names, transfers, group, branch, seq, transferUrl, supabase }

function ensureDrawer() {
  if ($('sm-drawer')) return;
  document.body.insertAdjacentHTML('beforeend', '<div class="drawer-backdrop" id="sm-backdrop"></div>' +
    '<div class="drawer sm-drawer" id="sm-drawer" role="dialog" aria-modal="true" aria-labelledby="sm-title"><div class="drawer-header"><div><h3 id="sm-title">Movement history</h3><div class="muted" id="sm-sub"></div></div>' +
    '<button type="button" class="drawer-close" id="sm-close" aria-label="Close">✕</button></div><div class="drawer-body" id="sm-body"></div></div>');
  $('sm-close').addEventListener('click', closeSkuMovement);
  $('sm-backdrop').addEventListener('click', closeSkuMovement);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('sm-drawer').classList.contains('open')) closeSkuMovement(); });
}
export function closeSkuMovement() {
  if (!$('sm-drawer')) return;
  $('sm-drawer').classList.remove('open'); $('sm-backdrop').classList.remove('open');
  S = null;
}

const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

export async function openSkuMovement(supabase, sku, opts = {}) {
  ensureDrawer();
  const seq = (S ? S.seq : 0) + 1;
  S = { sku, seq, supabase, transferUrl: opts.transferUrl || 'transfers.html?open=', group: 'all', branch: opts.branchId ? String(opts.branchId) : '', product: null, stock: [], branches: [], byBranch: {}, rows: [], names: {}, transfers: {} };
  $('sm-title').textContent = sku; $('sm-sub').textContent = 'Loading…';
  $('sm-body').innerHTML = '<p class="muted">Loading the movement history…</p>';
  $('sm-drawer').classList.add('open'); $('sm-backdrop').classList.add('open');
  try {
    const [prod, stock, branches, ledger] = await Promise.all([
      supabase.from('products').select('sku, item_name, category, product_status, reorder_level, sub_sku').eq('sku', sku).limit(1).then(check),
      supabase.from('inventory').select('branch_id, qty_available, qty_reserved').eq('sku', sku).then(check),
      supabase.from('branches').select('id, name, display_order').order('display_order').then(check),
      supabase.from('inventory_transactions').select('id, transaction_type, branch_id, qty_change, qty_before, qty_after, related_branch_id, transfer_id, reference_number, employee_id, reason, occurred_at')
        .eq('sku', sku).order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(LIMIT).then(check),
    ]);
    if (!S || S.seq !== seq) return;
    S.product = prod[0] || null; S.stock = stock; S.branches = branches; S.byBranch = Object.fromEntries(branches.map((b) => [b.id, b.name])); S.rows = ledger;
    // who did it, and which transfer it was (a person who can't see a transfer simply gets the plain reference text, not a link)
    const empIds = [...new Set(ledger.map((r) => r.employee_id).filter(Boolean))];
    if (empIds.length) { try { const list = check(await supabase.rpc('get_employee_names', { ids: empIds })); S.names = Object.fromEntries((list || []).map((e) => [e.id, e.full_name])); } catch (e) { /* names are optional */ } }
    const trIds = [...new Set(ledger.map((r) => r.transfer_id).filter(Boolean))];
    for (let i = 0; i < trIds.length; i += 100) {
      try { check(await supabase.from('inventory_transfers').select('id, transfer_number, from_branch_id, to_branch_id, status').in('id', trIds.slice(i, i + 100))).forEach((t) => { S.transfers[t.id] = t; }); } catch (e) { /* the links are optional */ }
    }
    if (!S || S.seq !== seq) return;
    draw();
  } catch (err) {
    if (S && S.seq === seq) $('sm-body').innerHTML = '<div class="msg error">Could not load the movement history: ' + esc(err.message || String(err)) + '</div>';
  }
}

const branchName = (id) => (id ? S.byBranch[id] || 'Branch ' + id : '');
/** From → To for a stock entry: a transfer shows both ends, everything else just the branch it happened at. */
function route(r) {
  if (r.transaction_type === 'Branch Transfer Out') return { from: branchName(r.branch_id), to: branchName(r.related_branch_id) };
  if (r.transaction_type === 'Branch Transfer In') return { from: branchName(r.related_branch_id), to: branchName(r.branch_id) };
  return { from: '', to: '', at: branchName(r.branch_id) };
}
const transferText = (r) => { const t = r.transfer_id ? S.transfers[r.transfer_id] : null; return t ? t.transfer_number : (r.transfer_id ? r.reference_number || 'Transfer' : ''); };
const visibleRows = () => S.rows.filter((r) => (S.group === 'all' || groupOf(r) === S.group) && (!S.branch || String(r.branch_id) === S.branch || String(r.related_branch_id) === S.branch));

function transfersSummary() {
  const g = {};
  S.rows.filter((r) => r.transfer_id).forEach((r) => {
    const e = g[r.transfer_id] || (g[r.transfer_id] = { id: r.transfer_id, out: 0, inn: 0, last: r.occurred_at, from: '', to: '' });
    if (r.transaction_type === 'Branch Transfer Out') { e.out += -Number(r.qty_change); e.from = branchName(r.branch_id); e.to = branchName(r.related_branch_id); }
    else if (r.transaction_type === 'Branch Transfer In') { e.inn += Number(r.qty_change); if (!e.from) { e.from = branchName(r.related_branch_id); e.to = branchName(r.branch_id); } }
  });
  return Object.values(g).sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

function draw() {
  const p = S.product, trs = transfersSummary();
  const outPcs = trs.reduce((s, t) => s + t.out, 0), inPcs = trs.reduce((s, t) => s + t.inn, 0);
  const total = S.stock.reduce((s, r) => s + Number(r.qty_available || 0), 0);
  const sources = [...new Set(trs.map((t) => t.from).filter(Boolean))], dests = [...new Set(trs.map((t) => t.to).filter(Boolean))];
  const rows = visibleRows();
  $('sm-title').textContent = S.sku;
  $('sm-sub').textContent = p ? [p.item_name, p.category, p.product_status].filter(Boolean).join(' · ') : 'This SKU is not in the SKU Catalog';
  const stockBy = S.branches.map((b) => { const r = S.stock.find((x) => x.branch_id === b.id); return r ? { b, q: Number(r.qty_available || 0), res: Number(r.qty_reserved || 0) } : null; }).filter(Boolean);
  const linkOf = (r) => { const t = r.transfer_id ? S.transfers[r.transfer_id] : null; return t ? '<a href="' + esc(S.transferUrl + t.id) + '" target="_blank" rel="noopener"><b>' + esc(t.transfer_number) + '</b></a>' : esc(transferText(r) || r.reference_number || '—'); };
  const body = '<div class="sm-sum"><div class="sm-cell"><span class="muted">In stock now</span><b>' + num(total) + ' pcs</b></div><div class="sm-cell"><span class="muted">Transfers</span><b>' + trs.length + '</b></div>' +
    '<div class="sm-cell"><span class="muted">Transferred out</span><b>' + num(outPcs) + ' pcs</b></div><div class="sm-cell"><span class="muted">Transferred in</span><b class="sm-pos">' + num(inPcs) + ' pcs</b></div>' +
    '<div class="sm-cell"><span class="muted">Last movement</span><b class="sm-small">' + (S.rows[0] ? esc(when(S.rows[0].occurred_at)) : '—') + '</b></div></div>' +
    '<div class="drawer-section"><h4>Current stock by branch</h4><div class="sm-chips">' + (stockBy.length ? stockBy.map((x) => '<span class="sm-chip' + (x.q > 0 ? '' : ' sm-chip-zero') + '">' + esc(x.b.name) + ' <b>' + num(x.q) + '</b>' + (x.res ? ' <span class="muted">(' + num(x.res) + ' reserved)</span>' : '') + '</span>').join('') : '<span class="muted">This SKU has never been stocked at any branch.</span>') + '</div>' +
      (trs.length ? '<p class="muted sm-note">Sent from: <b>' + esc(sources.join(', ') || '—') + '</b> · Received at: <b>' + esc(dests.join(', ') || '—') + '</b></p>' : '') + '</div>' +
    (trs.length ? '<div class="drawer-section"><h4>Transfers with this SKU</h4><div class="table-scroll table-2col"><table class="sm-table"><thead><tr><th>Transfer</th><th>Route</th><th>Status</th><th>Out</th><th>In</th><th>Last</th></tr></thead><tbody>' +
      trs.slice(0, 50).map((t) => { const tr = S.transfers[t.id]; return '<tr><td data-label="Transfer">' + (tr ? '<a href="' + esc(S.transferUrl + tr.id) + '" target="_blank" rel="noopener"><b>' + esc(tr.transfer_number) + '</b></a>' : '<span class="muted">not visible to you</span>') + '</td><td data-label="Route">' + esc(t.from || '—') + ' → ' + esc(t.to || '—') + '</td><td data-label="Status">' + esc(tr ? tr.status : '—') + '</td><td data-label="Out">' + num(t.out) + '</td><td data-label="In">' + num(t.inn) + '</td><td data-label="Last">' + esc(when(t.last)) + '</td></tr>'; }).join('') +
      '</tbody></table></div>' + (trs.length > 50 ? '<p class="muted sm-note">Showing the latest 50 of ' + trs.length + ' transfers.</p>' : '') + '</div>' : '') +
    '<div class="drawer-section"><h4>Movement history <span class="sm-count">' + rows.length + (rows.length !== S.rows.length ? ' of ' + S.rows.length : '') + ' entr' + (rows.length === 1 ? 'y' : 'ies') + '</span></h4>' +
      '<div class="sm-filters"><div class="field"><label for="sm-group">Show</label><select id="sm-group">' + GROUPS.map(([id, l]) => '<option value="' + id + '"' + (S.group === id ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="sm-branch">Branch</label><select id="sm-branch"><option value="">All branches</option>' + S.branches.map((b) => '<option value="' + b.id + '"' + (S.branch === String(b.id) ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>&nbsp;</label><button type="button" class="btn small secondary" id="sm-csv"' + (rows.length ? '' : ' disabled') + '>Download CSV</button></div></div>' +
      (rows.length ? '<div class="table-scroll table-2col"><table class="sm-table"><thead><tr><th>Date</th><th>Movement</th><th>Transfer / reference</th><th>From → To</th><th>Qty</th><th>Stock before → after</th><th>By</th></tr></thead><tbody>' +
        rows.map((r) => { const rt = route(r); return '<tr><td data-label="Date">' + esc(when(r.occurred_at)) + '</td><td data-label="Movement"><span class="sm-tag ' + tagClass(r.transaction_type) + '">' + esc(LABEL[r.transaction_type] || r.transaction_type) + '</span></td>' +
          '<td data-label="Transfer / reference">' + (r.transfer_id ? linkOf(r) : esc(r.reference_number || '—')) + '</td>' +
          '<td data-label="From → To">' + (rt.from || rt.to ? esc(rt.from || '—') + ' → ' + esc(rt.to || '—') : esc(rt.at || '—')) + '</td>' +
          '<td data-label="Qty"><b class="' + (Number(r.qty_change) < 0 ? 'sm-neg' : 'sm-pos') + '">' + signed(r.qty_change) + '</b></td><td data-label="Stock before → after">' + num(r.qty_before) + ' → <b>' + num(r.qty_after) + '</b></td>' +
          '<td data-label="By" class="full-row">' + esc(S.names[r.employee_id] || '—') + (r.reason ? '<div class="muted sm-note">' + esc(r.reason) + '</div>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<p class="muted">' + (S.rows.length ? 'No movement matches these filters.' : 'No stock movement has been recorded for this SKU yet.') + '</p>') +
      (S.rows.length >= LIMIT ? '<p class="muted sm-note">Showing the latest ' + num(LIMIT) + ' entries.</p>' : '') +
      '<p class="muted sm-note">Every stock change is one row in the inventory ledger. This list is read-only — nothing here can change stock.</p></div>';
  $('sm-body').innerHTML = body;
  $('sm-group').addEventListener('change', (e) => { S.group = e.target.value; draw(); });
  $('sm-branch').addEventListener('change', (e) => { S.branch = e.target.value; draw(); });
  $('sm-csv').addEventListener('click', () => csv(rows));
}

// formula-safe, Excel-friendly CSV of exactly the rows on screen
function csv(rows) {
  const cell = (v) => { if (v === null || v === undefined || v === '') return ''; if (typeof v === 'number') return String(v); let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Date', 'Movement', 'Transfer / reference', 'From', 'To', 'Branch', 'Quantity change', 'Stock before', 'Stock after', 'By', 'Reason'];
  const lines = [head.map(cell).join(',')];
  rows.forEach((r) => { const rt = route(r); lines.push([when(r.occurred_at), LABEL[r.transaction_type] || r.transaction_type, r.transfer_id ? transferText(r) : r.reference_number || '', rt.from, rt.to, branchName(r.branch_id), Number(r.qty_change), Number(r.qty_before), Number(r.qty_after), S.names[r.employee_id] || '', r.reason || ''].map(cell).join(',')); });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  a.download = 'movement-history-' + S.sku.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.csv';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
