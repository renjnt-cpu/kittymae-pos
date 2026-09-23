// Scrap tab (Branches page) -- standalone module scoped to whichever branch is
// selected on the host page (getBranchId()), following the same Form Drawer /
// Detail Drawer pattern already proven for Layaway (layawayTab.js) -- Ren's spec
// sections 271-288: "+ New Scrap" opens a right-side drawer instead of a permanent
// on-page form; after save the same drawer switches to showing the saved entry;
// "View Details" on an existing row opens the same drawer. Filters/tiles/balance
// stay on the main page (section 280 -- "keep main page clean" means no permanent
// FORM there, not that summaries/filters move into the drawer too).
import {
  listScrapEntries, getScrapCashBalances, createScrapEntry, deleteScrapEntry,
  uploadScrapAttachment, getScrapAttachmentUrl, convertScrapToSubasta, subscribeToChanges,
} from './api.js?v=20260923d';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20260923d';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, byDate, localDateStr } from './uiKit.js?v=20260923d';

// Global Filter + Sort rules (Ren, 2026-09-21, section 18): Scrap sortable by Date/
// Metal-Karat/Weight/Amount/Type/Customer.
const SC_SORT_FIELDS = [
  { key: 'entry_date', label: 'Date' }, { key: 'metal_type', label: 'Metal/Karat' }, { key: 'customer_name', label: 'Customer' },
  { key: 'entry_type', label: 'Type' }, { key: 'weight_grams', label: 'Weight' }, { key: 'total_amount', label: 'Amount' },
];
const SC_SORT_COMPARATORS = {
  entry_date: byDate('entry_date'), metal_type: (a, b) => byText('metal_type')(a, b) || byText('karat')(a, b),
  customer_name: byText('customer_name'), entry_type: byText('entry_type'), weight_grams: byNumber('weight_grams'), total_amount: byNumber('total_amount'),
};

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const weight = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 3 }) + 'g';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const GOLD_KARATS = ['24K', '22K', '21K', '20K', '18K', '16K', '14K', '10K', 'Other'];
const SILVER_KARATS = ['999', '925', 'Other'];
const karatOptionsFor = (metal) => (metal === 'Silver' ? SILVER_KARATS : GOLD_KARATS).map((k) => '<option>' + k + '</option>').join('');

// Same write-access group as this page's own canWriteHere() before extraction
// (62_position_managers_refund_scrap_subasta.sql).
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

function paymentSlotsHtml() {
  let html = '';
  for (let i = 0; i < 3; i++) {
    const isRequired = i === 0;
    const label = i === 0 ? 'Payment Method *' : 'Payment Method ' + (i + 1) + ' (optional)';
    html +=
      '<div class="field"><label>' + label + '</label><select name="scMethod' + i + '"' + (isRequired ? ' required' : '') + '>' +
        (!isRequired ? '<option value="">— none —</option>' : '') +
        PAYMENT_METHODS.map((m) => '<option' + (i === 0 && m === 'Cash' ? ' selected' : '') + '>' + m + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Amount (PHP)' + (isRequired ? ' *' : '') + '</label><input type="number" name="scAmount' + i + '" step="0.01" min="0"' + (isRequired ? ' required' : '') + '></div>';
  }
  return html;
}
function readPaymentSlots(f) {
  const payments = [];
  for (let i = 0; i < 3; i++) {
    const method = f['scMethod' + i]?.value;
    const amount = Number(f['scAmount' + i]?.value || 0);
    if (method && amount > 0) payments.push({ method, amount, reference: '' });
  }
  return payments;
}

/** Mounts the Scrap tab into `root` (an empty container this owns entirely), scoped
 * to `getBranchId()` at call time. `esc`/`toast` are the page's own shell.js
 * helpers; `msgId` is the id of the page's toast container; `employee` is the
 * signed-in employee record. Returns { reload, unsubscribe }. */
export async function initScrapTab({ root, esc, toast, msgId, getBranchId, employee, onCountUpdate }) {
  const isScoped = employee.role === 'Branch Supervisor';
  function canWriteHere() {
    return ['Admin', 'Manager'].includes(employee.role) || (isScoped && getBranchId() === employee.branch_id) ||
      POSITION_MANAGERS.includes(employee.position);
  }
  // Add gate: everything canWriteHere() allows, plus literally any active employee
  // for their own branch (scrap_any_employee_own_branch_insert), plus Sales Admin
  // Associate company-wide (scrap_sales_executive_insert -- no fixed branch_id).
  function canAddHere() {
    return canWriteHere() || employee.branch_id === getBranchId() || employee.position === 'Sales Admin Associate';
  }
  function canSeeScrapCash() {
    return ['Admin', 'Manager'].includes(employee.role) || employee.position === 'Sales Admin Associate' ||
      (isScoped && getBranchId() === employee.branch_id);
  }
  const sort = { field: 'entry_date', dir: 'desc' };

  // Page order follows Ren's MASTER UI rule 2: primary action at the top, Summary
  // directly below the module header, Search & Filters directly below Summary, then
  // the records. The tiles/balance/list all derive from the same filtered rows.
  root.innerHTML =
    '<div class="module-topbar"><div></div><div style="text-align:right;">' +
      '<button type="button" class="btn" id="sc-new-btn">+ New Scrap</button>' +
      '<div id="sc-write-note"></div>' +
    '</div></div>' +
    '<div class="tiles" id="sc-tiles"></div>' +
    '<div class="card">' +
      '<h3 style="margin-top:0;">Search &amp; Filter</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:200px;"><label>Search</label><input type="text" id="sc-f-search" placeholder="Metal, grams, customer, payment, source, date…"></div>' +
        '<div class="field"><label>Metal</label><select id="sc-f-metal"><option value="all">All</option><option>Gold</option><option>Silver</option></select></div>' +
        '<div class="field"><label>Type</label><select id="sc-f-type"><option value="all">All</option><option>In</option><option>Out</option></select></div>' +
        '<div class="field"><label>From</label><input type="date" id="sc-f-from" value="' + localDateStr() + '"></div>' +
        '<div class="field"><label>To</label><input type="date" id="sc-f-to" value="' + localDateStr() + '"></div>' +
        sortControlHtml(SC_SORT_FIELDS, sort, 'sc-sort-field', 'sc-sort-dir') +
        '<button type="button" class="btn small secondary" id="sc-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>' +
    '<div id="sc-active"></div>' +
    '<h3 style="margin:0 0 8px;">Current Balance <span class="muted" style="font-weight:normal;">— weight on hand</span></h3>' +
    '<div id="sc-balance" class="card"><div class="muted">Loading…</div></div>' +
    '<div id="sc-list"><div class="muted">Loading…</div></div>' +

    '<div class="drawer-backdrop" id="sc-form-backdrop"></div>' +
    '<div class="drawer" id="sc-form-drawer">' +
      '<div class="drawer-header"><h3>New Scrap</h3><button type="button" class="drawer-close" id="sc-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<form id="sc-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="drawer-section">' +
            '<h4>Entry</h4>' +
            '<div class="field"><label>Date</label><input type="date" name="entryDate" value="' + localDateStr() + '"></div>' +
            '<div class="field"><label>Type *</label><select name="entryType"><option value="In">In (bought from customer)</option><option value="Out">Out (sold to refiner)</option></select></div>' +
            '<div class="field"><label>Metal *</label><select name="metalType" id="sc-metal" required><option>Gold</option><option>Silver</option></select></div>' +
            '<div class="field"><label>Karat / Purity</label><select name="karat" id="sc-karat">' + karatOptionsFor('Gold') + '</select></div>' +
            '<div class="field" id="sc-karat-other-field" style="display:none;"><label>Specify</label><input type="text" name="karatOther" placeholder="Karat / purity"></div>' +
            '<div class="field"><label>Weight (grams) *</label><input type="number" name="weightGrams" step="0.001" min="0" required></div>' +
            '<div class="field"><label>Price per Gram (PHP)</label><input type="number" name="pricePerGram" step="0.01" min="0"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Customer</h4>' +
            '<div class="field"><label>Customer Name</label><input type="text" name="customerName"></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber"></div>' +
            '<div class="field"><label>Source</label><input type="text" name="source" placeholder="Walk-in, buyback, refiner name…"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Payment</h4>' +
            paymentSlotsHtml() +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Notes &amp; Attachment</h4>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
            '<div class="field"><label>Photo</label><input type="file" name="attachment" accept="image/*"></div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="sc-form">Add Entry</button>' +
        '<button type="button" class="btn secondary" id="sc-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +
    '<div class="drawer-backdrop" id="sc-detail-backdrop"></div>' +
    '<div class="drawer" id="sc-detail-drawer">' +
      '<div class="drawer-header"><h3 id="sc-detail-title">Scrap Details</h3><button type="button" class="drawer-close" id="sc-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="sc-detail-body"></div>' +
    '</div>';

  document.getElementById('sc-metal')?.addEventListener('change', (ev) => {
    document.getElementById('sc-karat').innerHTML = karatOptionsFor(ev.target.value);
    document.getElementById('sc-karat-other-field').style.display = 'none';
  });
  document.getElementById('sc-karat')?.addEventListener('change', (ev) => {
    document.getElementById('sc-karat-other-field').style.display = ev.target.value === 'Other' ? '' : 'none';
  });

  function openFormDrawer() {
    document.getElementById('sc-form-backdrop').classList.add('open');
    document.getElementById('sc-form-drawer').classList.add('open');
  }
  function closeFormDrawer() {
    document.getElementById('sc-form-backdrop').classList.remove('open');
    document.getElementById('sc-form-drawer').classList.remove('open');
  }
  document.getElementById('sc-new-btn')?.addEventListener('click', openFormDrawer);
  document.getElementById('sc-form-close').addEventListener('click', closeFormDrawer);
  document.getElementById('sc-form-cancel').addEventListener('click', closeFormDrawer);
  document.getElementById('sc-form-backdrop').addEventListener('click', closeFormDrawer);

  function closeDetailDrawer() {
    document.getElementById('sc-detail-backdrop').classList.remove('open');
    document.getElementById('sc-detail-drawer').classList.remove('open');
  }
  document.getElementById('sc-detail-close').addEventListener('click', closeDetailDrawer);
  document.getElementById('sc-detail-backdrop').addEventListener('click', closeDetailDrawer);
  function openDetail(id) {
    const r = allScrap.find((x) => x.id === id);
    if (!r) return;
    document.getElementById('sc-detail-title').textContent = r.metal_type + ' ' + (r.karat || '') + ' — ' + r.entry_type;
    const body = document.getElementById('sc-detail-body');
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    document.getElementById('sc-detail-backdrop').classList.add('open');
    document.getElementById('sc-detail-drawer').classList.add('open');
  }
  document.getElementById('sc-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    // The submit button lives in .drawer-footer (form="sc-form"), outside this
    // <form> element's own DOM subtree, so it's reached by its own selector rather
    // than f.querySelector() -- a descendant-only lookup would miss it.
    const btn = document.querySelector('#sc-form-drawer .drawer-footer button[type=submit]');
    btn.disabled = true;
    try {
      const karat = f.karat.value === 'Other' ? f.karatOther.value.trim() : f.karat.value;
      const payments = readPaymentSlots(f);
      if (!payments.length) { toast(msgId, 'Enter at least one payment method and amount.', true); return; }
      const newScrapId = await createScrapEntry({
        branchId: getBranchId(), entryDate: f.entryDate.value, entryType: f.entryType.value, metalType: f.metalType.value,
        karat, weightGrams: Number(f.weightGrams.value),
        pricePerGram: f.pricePerGram.value ? Number(f.pricePerGram.value) : null,
        customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(),
        payments,
        source: f.source.value.trim(), notes: f.notes.value.trim(),
      });
      if (f.attachment.files[0]) await uploadScrapAttachment(getBranchId(), newScrapId, f.attachment.files[0]);
      toast(msgId, 'Entry added.', false);
      f.reset();
      f.entryDate.value = localDateStr();
      document.getElementById('sc-karat').innerHTML = karatOptionsFor(f.metalType.value);
      document.getElementById('sc-karat-other-field').style.display = 'none';
      closeFormDrawer();
      await load();
      openDetail(newScrapId);
    } catch (err) {
      toast(msgId, String(err.message || err), true);
    } finally {
      btn.disabled = false;
    }
  });

  let allScrap = [], scrapCashBalances = [];

  async function load() {
    const list = document.getElementById('sc-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const [entries, cashBalances] = await Promise.all([listScrapEntries(getBranchId()), getScrapCashBalances()]);
      allScrap = entries;
      scrapCashBalances = cashBalances;
      render();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

  function renderBalance(rows) {
    const box = document.getElementById('sc-balance');
    if (!rows.length) { box.innerHTML = '<p class="muted">No scrap recorded for this filter.</p>'; return; }
    box.innerHTML = '<div class="table-scroll table-mini"><table><tr><th>Metal</th><th>Karat/Purity</th><th>Balance</th></tr>' +
      rows.map((b) => '<tr><td data-label="Metal">' + esc(b.metal_type) + '</td><td data-label="Karat/Purity">' + esc(b.karat || '—') + '</td><td data-label="Balance">' + weight(b.balance_grams) + '</td></tr>').join('') +
      '</table></div>';
  }

  function computeBalanceFromRows(rows) {
    const byKey = {};
    rows.forEach((r) => {
      const key = r.metal_type + '|' + (r.karat || '');
      const g = Number(r.weight_grams || 0);
      byKey[key] = (byKey[key] || 0) + (r.entry_type === 'In' ? g : -g);
    });
    return Object.keys(byKey).sort().map((key) => {
      const [metal_type, karat] = key.split('|');
      return { metal_type, karat: karat || null, balance_grams: byKey[key] };
    });
  }

  function tile(num, label) { return '<div class="tile"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>'; }

  function render() {
    const newBtn = document.getElementById('sc-new-btn');
    newBtn.disabled = !canAddHere();
    document.getElementById('sc-write-note').innerHTML = canAddHere()
      ? ''
      : '<p class="muted" style="font-size:11px;">View only — you can only add scrap for your own branch.</p>';

    let rows = allScrap;
    const fSearch = document.getElementById('sc-f-search').value.trim().toLowerCase();
    const fMetal = document.getElementById('sc-f-metal').value;
    const fType = document.getElementById('sc-f-type').value;
    const fFrom = document.getElementById('sc-f-from').value;
    const fTo = document.getElementById('sc-f-to').value;
    if (fSearch) rows = rows.filter((r) =>
      (r.source || '').toLowerCase().includes(fSearch) ||
      (r.notes || '').toLowerCase().includes(fSearch) ||
      r.metal_type.toLowerCase().includes(fSearch) ||
      (r.karat || '').toLowerCase().includes(fSearch) ||
      (r.customer_name || '').toLowerCase().includes(fSearch) ||
      (r.contact_number || '').toLowerCase().includes(fSearch) ||
      (r.payment_method || '').toLowerCase().includes(fSearch) ||
      (r.weight_grams !== null && String(r.weight_grams).includes(fSearch)) ||
      (r.entry_date || '').includes(fSearch));
    if (fMetal !== 'all') rows = rows.filter((r) => r.metal_type === fMetal);
    if (fType !== 'all') rows = rows.filter((r) => r.entry_type === fType);
    if (fFrom) rows = rows.filter((r) => r.entry_date >= fFrom);
    if (fTo) rows = rows.filter((r) => r.entry_date <= fTo);

    // The module pill count, the active-filter strip, the tiles, the balance and the
    // list all come from these same filtered rows (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(rows.length);
    const hasFilters = !!(fSearch || fMetal !== 'all' || fType !== 'all' || fFrom || fTo);
    const activeEl = document.getElementById('sc-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(fSearch) }, { label: 'Metal', value: esc(fMetal) }, { label: 'Type', value: esc(fType) },
      { label: 'From', value: esc(fFrom) }, { label: 'To', value: esc(fTo) },
    ], 'sc-f-clear');
    wireProxyButtons(activeEl);

    renderBalance(computeBalanceFromRows(rows));

    const rangeIn = rows.filter((r) => r.entry_type === 'In');
    const byMetalKarat = {};
    rangeIn.forEach((r) => {
      const key = r.metal_type + ' ' + (r.karat || '—');
      byMetalKarat[key] = (byMetalKarat[key] || 0) + Number(r.total_amount || 0);
    });
    const keys = Object.keys(byMetalKarat).sort();
    let tilesHtml = tile(rows.length, 'Qty') + tile(weight(rows.reduce((s, r) => s + Number(r.weight_grams || 0), 0)), 'Total Weight') +
      tile(money(rows.reduce((s, r) => s + Number(r.total_amount || 0), 0)), 'Total Amount') +
      (keys.length
        ? keys.map((k) => tile(money(byMetalKarat[k]), 'Purchased (' + k + ')')).join('')
        : tile(money(0), 'Purchased'));

    if (canSeeScrapCash()) {
      const cashRow = scrapCashBalances.find((b) => b.branch_id === getBranchId());
      tilesHtml += tile(money(cashRow ? cashRow.remaining_scrap_cash : 0), 'Remaining Scrap Cash');
    }
    document.getElementById('sc-tiles').innerHTML = tilesHtml;

    const list = document.getElementById('sc-list');
    if (!rows.length) {
      list.innerHTML = emptyStateHtml({
        message: hasFilters ? 'No scrap entries match these filters.' : 'No scrap entries recorded for this branch yet.',
        hasFilters, clearId: 'sc-f-clear',
        createLabel: canAddHere() ? '+ New Scrap' : null, createId: 'sc-new-btn',
      });
      wireProxyButtons(list);
      return;
    }

    // Filtering already picked `rows`; sort only reorders them for display (section 11).
    const sortedRows = applySort(rows, sort, SC_SORT_COMPARATORS);
    list.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:8%"><col style="width:10%"><col style="width:11%"><col style="width:20%"><col style="width:14%"></colgroup>' +
      '<thead><tr><th>Date</th><th>Customer</th><th>Metal/Karat</th><th>Type</th><th>Weight</th><th>Total</th><th>Source/Notes</th><th></th></tr></thead><tbody>' +
      sortedRows.map((r) => '<tr>' +
        '<td data-label="Date">' + (r.entry_date || '—') + '</td>' +
        '<td data-label="Customer">' + esc(r.customer_name || 'Walk-in') + '</td>' +
        '<td data-label="Metal/Karat">' + esc(r.metal_type) + ' ' + esc(r.karat || '') + '</td>' +
        '<td data-label="Type"><span class="badge ' + (r.entry_type === 'In' ? 'ok' : 'pending') + '">' + esc(r.entry_type) + '</span></td>' +
        '<td data-label="Weight">' + weight(r.weight_grams) + '</td>' +
        '<td data-label="Total">' + money(r.total_amount) +
          (r.converted_to_subasta_item_id ? '<div class="muted" style="font-size:10px;"><span class="badge ok" style="font-size:9px;">→ Subasta #' + r.converted_to_subasta_item_id + '</span></div>' : '') + '</td>' +
        '<td data-label="Source/Notes" class="full-row" style="font-size:11px;">' + esc(r.source || '') + (r.notes ? '<div class="muted">' + esc(r.notes) + '</div>' : '') + '</td>' +
        '<td class="full-row"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + r.id + '">View Details</button></td>' +
      '</tr>').join('') +
      '</tbody></table></div>';

    list.querySelectorAll('[data-act="view-details"]').forEach((btn) => btn.addEventListener('click', () => openDetail(Number(btn.dataset.id))));
  }

  function renderDetailBody(r) {
    const payments = r.scrap_payments || [];
    const paymentHtml = payments.length
      ? payments.map((p) => '<div class="payment-line">' + money(p.amount) + ' ' + esc(p.payment_method) + '</div>').join('')
      : '<p class="muted">' + esc(r.payment_method || '—') + '</p>';

    return '<div class="drawer-section"><h4>Entry</h4>' +
      '<div class="drawer-kv"><span>Date</span><b>' + (r.entry_date || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Type</span><b><span class="badge ' + (r.entry_type === 'In' ? 'ok' : 'pending') + '">' + esc(r.entry_type) + '</span></b></div>' +
      '<div class="drawer-kv"><span>Metal/Karat</span><b>' + esc(r.metal_type) + ' ' + esc(r.karat || '') + '</b></div>' +
      '<div class="drawer-kv"><span>Weight</span><b>' + weight(r.weight_grams) + '</b></div>' +
      '<div class="drawer-kv"><span>Price/Gram</span><b>' + money(r.price_per_gram) + '</b></div>' +
      '<div class="drawer-kv"><span>Total</span><b>' + money(r.total_amount) + '</b></div>' +
      (r.converted_to_subasta_item_id ? '<div class="drawer-kv"><span>Converted</span><b><span class="badge ok">→ Subasta #' + r.converted_to_subasta_item_id + '</span></b></div>' : '') +
    '</div>' +
    '<div class="drawer-section"><h4>Customer</h4>' +
      '<div class="drawer-kv"><span>Name</span><b>' + esc(r.customer_name || 'Walk-in') + '</b></div>' +
      '<div class="drawer-kv"><span>Contact</span><b>' + esc(r.contact_number || '—') + '</b></div>' +
      '<div class="drawer-kv"><span>Source</span><b>' + esc(r.source || '—') + '</b></div>' +
      (r.notes ? '<div class="drawer-kv"><span>Notes</span><b>' + esc(r.notes) + '</b></div>' : '') +
      '<div class="drawer-kv"><span>Recorded By</span><b>' + esc((r.creator && r.creator.full_name) || '—') + '</b></div>' +
    '</div>' +
    '<div class="drawer-section"><h4>Payment</h4>' + paymentHtml + '</div>' +
    (canWriteHere() || r.attachment_path ? '<div class="drawer-section"><h4>Actions</h4>' +
      (r.attachment_path ? '<button type="button" class="btn small secondary" data-act="view-photo" data-path="' + esc(r.attachment_path) + '">View Attachment</button> ' : '') +
      (canWriteHere() && !r.converted_to_subasta_item_id ? '<button type="button" class="btn small secondary" data-act="delete" data-id="' + r.id + '">Delete</button> ' : '') +
      (canWriteHere() && !r.converted_to_subasta_item_id && r.entry_type === 'In' ? '<button type="button" class="btn small secondary" data-act="convert-toggle">Convert to Subasta</button>' : '') +
      (canWriteHere() && !r.converted_to_subasta_item_id && r.entry_type === 'In'
        ? '<form id="sc-convert-form" style="display:none;flex-direction:column;gap:8px;margin-top:10px;" data-scrap-id="' + r.id + '">' +
            '<div class="field"><label>Item Description *</label><input type="text" name="itemDescription" required placeholder="What the item actually is"></div>' +
            '<div class="field"><label>Pawn Reference</label><input type="text" name="pawnReference"></div>' +
            '<div class="field"><label>Pawn Date</label><input type="date" name="pawnDate" value="' + (r.entry_date || '') + '"></div>' +
            '<div class="field"><label>Auction Eligible Date</label><input type="date" name="auctionEligibleDate"></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes" value="Converted from Scrap entry, ' + weight(r.weight_grams) + '"></div>' +
            '<button class="btn small" type="submit">Convert</button>' +
          '</form>'
        : '') +
    '</div>' : '');
  }

  function wireDetailBody(container, r) {
    const viewPhotoBtn = container.querySelector('[data-act="view-photo"]');
    if (viewPhotoBtn) viewPhotoBtn.addEventListener('click', async () => {
      try { window.open(await getScrapAttachmentUrl(viewPhotoBtn.dataset.path), '_blank'); }
      catch (err) { toast(msgId, String(err.message || err), true); }
    });

    const deleteBtn = container.querySelector('[data-act="delete"]');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this scrap entry?')) return;
      try { await deleteScrapEntry(deleteBtn.dataset.id); toast(msgId, 'Deleted.', false); closeDetailDrawer(); await load(); }
      catch (err) { toast(msgId, String(err.message || err), true); }
    });

    const convertToggle = container.querySelector('[data-act="convert-toggle"]');
    const convertForm = container.querySelector('#sc-convert-form');
    if (convertToggle && convertForm) convertToggle.addEventListener('click', () => {
      convertForm.style.display = convertForm.style.display === 'none' ? 'flex' : 'none';
    });
    if (convertForm) convertForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const scrapEntryId = Number(f.dataset.scrapId);
      try {
        const newId = await convertScrapToSubasta({
          scrapEntryId, itemDescription: f.itemDescription.value.trim(),
          pawnReference: f.pawnReference.value.trim(), pawnDate: f.pawnDate.value,
          auctionEligibleDate: f.auctionEligibleDate.value, notes: f.notes.value.trim(),
        });
        toast(msgId, 'Converted to Subasta item #' + newId + '.', false);
        closeDetailDrawer();
        await load();
      } catch (err) {
        toast(msgId, String(err.message || err), true);
      }
    });
  }

  document.getElementById('sc-f-search').addEventListener('input', render);
  document.getElementById('sc-f-metal').addEventListener('change', render);
  document.getElementById('sc-f-type').addEventListener('change', render);
  document.getElementById('sc-f-from').addEventListener('change', render);
  document.getElementById('sc-f-to').addEventListener('change', render);
  document.getElementById('sc-f-clear').addEventListener('click', () => {
    document.getElementById('sc-f-search').value = '';
    document.getElementById('sc-f-metal').value = 'all';
    document.getElementById('sc-f-type').value = 'all';
    document.getElementById('sc-f-from').value = '';
    document.getElementById('sc-f-to').value = '';
    render();
  });
  wireSortControl('sc-sort-field', 'sc-sort-dir', sort, render);

  const unsubscribe = subscribeToChanges(['scrap_entries', 'branch_capital_entries'], load);
  await load();

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec
  // 321) can open this entry's own Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail };
}
