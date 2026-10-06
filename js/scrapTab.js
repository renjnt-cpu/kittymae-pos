// Scrap tab (Branches page) -- standalone module scoped to whichever branch is selected on the host
// page (getBranchId()). Upgraded 2026-10-07 (Ren's Branches spec) from a bare list into a working
// scrap desk, on the same records as before:
//   * summary tiles, the purity breakdown, "grams by branch" and the weight-on-hand roll-forward all come
//     from the server (scrap_ops_report) for the global date range -- they never depend on how many rows
//     this tab happened to load;
//   * New Scrap: type (bought / transferred in / transferred out / refiner-other), metal, purity,
//     weight, price per gram -> gross -> adjustment -> final amount, customer picked from people already
//     on file, up to three payment lines (method, amount, date sent, reference, proof) saved together with
//     the entry in one database call, and UNPAID / PARTIALLY PAID / PAID worked out from the payment lines;
//   * Scrap Payments view: every payment line (with the running balance) and every purchase still owing;
//   * the detail drawer shows the entry, its payment lines, who did what (audit trail), lets a permitted
//     person add a payment / attach proof / correct the entry (reason + what went wrong are required and
//     logged), and deleting goes through a request that a supervisor and then Admin approve.
// The drawer pattern, filters and cards are the ones Layaway already uses.
import {
  listScrapEntries, getScrapCashBalances, getScrapOpsReport, createScrapEntryV2, addScrapPayment, updateScrapEntry, updateScrapPayment,
  uploadScrapAttachment, uploadScrapPaymentProof, getScrapAttachmentUrl, convertScrapToSubasta,
  listBranchAuditLog, listBranchRecordRequests, requestBranchRecordAction, approveBranchRecordStage1, approveBranchRecordFinal,
  rejectBranchRecordAction, cancelBranchRecordAction, adminApplyBranchRecordAction, subscribeToChanges,
} from './api.js?v=20261007m';
import { PAYMENT_METHODS } from './paymentMethods.js?v=20261007m';
import { activeFiltersHtml, emptyStateHtml, wireProxyButtons, sortControlHtml, wireSortControl, applySort, byText, byNumber, flagInvalid } from './uiKit.js?v=20261007m';
import { confirmDialog, reasonDialog, ERROR_TYPES } from './dialogs.js?v=20261007m';
import { paymentStatusOf, paymentChipHtml } from './paymentStatus.js?v=20261007m';
import { pageSlice, pagerHtml, wirePager } from './pager.js?v=20261007m';
import { approvalCardHtml, setApprovalFolder } from './approvalUi.js?v=20261007m';
import { attachCustomerPicker } from './customerPicker.js?v=20261007m';
import { paymentRowsHtml, mountPaymentRows } from './paymentRows.js?v=20261007m';
import { GOLD_PURITIES, SILVER_PURITIES } from './metals.js?v=20261007m';
import { manilaToday } from './opsDates.js?v=20261007m';
import { friendlyError } from './shell.js?v=20261007m';

// Global Filter + Sort rules (Ren, 2026-09-21, section 18): Scrap sortable by Date/Metal-Purity/Customer/Type/Weight/Amount.
const SC_SORT_FIELDS = [
  { key: 'entry_date', label: 'Date' }, { key: 'metal_type', label: 'Metal/Purity' }, { key: 'customer_name', label: 'Customer' },
  { key: 'kind', label: 'Type' }, { key: 'weight_grams', label: 'Weight' }, { key: 'total_amount', label: 'Amount' }, { key: '_balance', label: 'Balance owing' },
];
const SC_SORT_COMPARATORS = {
  entry_date: (a, b) => String(a.entry_date + ' ' + (a.purchase_time || '')).localeCompare(String(b.entry_date + ' ' + (b.purchase_time || ''))) || a.id - b.id,
  metal_type: (a, b) => byText('metal_type')(a, b) || byText('karat')(a, b),
  customer_name: byText('customer_name'), kind: byText('kind'), weight_grams: byNumber('weight_grams'), total_amount: byNumber('total_amount'),
  _balance: (a, b) => a._st.balance - b._st.balance,
};

const money = (n) => n === null || n === undefined ? '—' : (Number(n) < 0 ? '−₱' : '₱') + Math.abs(Number(n)).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const grams = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' g';
const gramsPlain = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const gramsCell = (n) => (Number(n) ? gramsPlain(n) : '—');
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (isNaN(h)) return '';
  return ((h % 12) || 12) + ':' + String(m || 0).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
// "Now" as HH:MM on the Manila clock, whatever the device's own timezone is (the business day is Manila's).
const manilaNowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

const KINDS = ['Bought from Customer', 'Transferred In', 'Transferred Out', 'Refiner / Other'];
const KIND_TONE = { 'Bought from Customer': 'green', 'Transferred In': 'blue', 'Transferred Out': 'yellow', 'Refiner / Other': 'gray' };
const KIND_SHORT = { 'Bought from Customer': 'Bought', 'Transferred In': 'Transfer in', 'Transferred Out': 'Transfer out', 'Refiner / Other': 'Refiner / other' };
const SOURCE_TYPES = ['Walk-In', 'Returning Customer', 'Referral', 'Other'];
const PURITY_BUCKETS = [...GOLD_PURITIES, 'Other'];
const isMoneyKind = (k) => k === 'Bought from Customer' || k === 'Refiner / Other';
const isTransferKind = (k) => k === 'Transferred In' || k === 'Transferred Out';
const kindBadge = (k) => '<span class="badge st-' + (KIND_TONE[k] || 'gray') + '">' + (KIND_SHORT[k] || k) + '</span>';

const FIELD_LABELS = {
  entry_date: 'Date', purchase_time: 'Time', kind: 'Type', metal_type: 'Metal', karat: 'Purity', weight_grams: 'Weight (g)', price_per_gram: 'Price / gram',
  gross_amount: 'Gross amount', adjustment_amount: 'Adjustment', adjustment_reason: 'Adjustment reason', total_amount: 'Final amount',
  customer_name: 'Customer', contact_number: 'Contact', customer_address: 'Address', source_type: 'Source type', source: 'Source note', notes: 'Notes',
  payment_method: 'Method', amount: 'Amount', reference_number: 'Reference', paid_at: 'Date paid',
};

// Same write-access group as this page's own canWriteHere() before the upgrade (62_position_managers_refund_scrap_subasta.sql);
// still decides who may convert a purchase to Subasta (convert_scrap_to_subasta checks the same people).
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

function purityOptionsHtml(metal, selected) {
  const list = metal === 'Gold' ? GOLD_PURITIES : metal === 'Silver' ? SILVER_PURITIES : [];
  return list.map((p) => '<option' + (p === selected ? ' selected' : '') + '>' + p + '</option>').join('') +
    '<option value="Custom"' + (selected && !list.includes(selected) ? ' selected' : '') + '>Custom…</option>';
}

/** Mounts the Scrap tab into `root` (an empty container this owns entirely), scoped to `getBranchId()` at call
 * time. `esc`/`toast` are the page's own shell.js helpers; `msgId` is the id of the page's toast container;
 * `employee` is the signed-in employee record (with .permissions); `branches` every active branch.
 * Returns { reload, unsubscribe, openDetail, applyView }. */
export async function initScrapTab({ root, esc, toast, msgId, getBranchId, employee, branches, onCountUpdate, getRange, requestRange }) {
  // What this person may do. The database enforces every one of these again; this only decides which
  // buttons to show, using the same permission keys / rules the server functions check.
  const perms = new Set(employee.permissions || []);
  const has = (k) => perms.has(k);
  const isAdmin = employee.role === 'Admin';
  const isSupervisorUp = ['Admin', 'Manager', 'Branch Supervisor'].includes(employee.role) || (employee.position || '').toLowerCase().includes('supervisor');
  const branchName = (id) => ((branches || []).find((b) => b.id === id) || {}).name || ('Branch ' + id);
  // assert_can_act_on_branch()
  function canActOnBranch(bid) {
    if (['Admin', 'Manager'].includes(employee.role)) return true;
    if (employee.role === 'None' && ['Sales Admin Associate', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'].includes(employee.position)) return true;
    if (employee.position === 'Auditor') return true;
    return employee.branch_id != null && employee.branch_id === bid;
  }
  // _scrap_can_write(): the people the insert policies already let add scrap -- plus anyone for their own branch.
  function canAddHere() {
    return has('system.manager_or_admin') || has('role.position_manager') || has('role.admin_assistant') || has('role.sales_executive') ||
      (employee.branch_id != null && employee.branch_id === getBranchId());
  }
  const canTransfer = () => has('system.manager_or_admin') || has('role.position_manager') || has('scrap.edit');
  const canEdit = (r) => !r.converted_to_subasta_item_id && canActOnBranch(r.branch_id) &&
    (has('scrap.edit') || ((has('role.admin_assistant') || has('role.sales_executive')) && r.created_by === employee.id && !r.attachment_path));
  const canConvert = (r) => r.kind === 'Bought from Customer' && !r.converted_to_subasta_item_id &&
    (['Admin', 'Manager'].includes(employee.role) || (employee.role === 'Branch Supervisor' && r.branch_id === employee.branch_id) || POSITION_MANAGERS.includes(employee.position));
  const canSeeScrapCash = () => ['Admin', 'Manager'].includes(employee.role) || employee.position === 'Sales Admin Associate' ||
    (employee.role === 'Branch Supervisor' && getBranchId() === employee.branch_id);

  const sort = { field: 'entry_date', dir: 'desc' };
  const pg = { page: 1 }, payPg = { page: 1 };
  let view = 'entries';
  let entries = [], cashBalances = [], requests = [];
  let report = null, reportAll = null, reportErr = '', reportSeq = 0;
  let openId = null, editingId = null;

  const notify = (text, isError) => toast(msgId, text, isError);

  // Page order follows Ren's MASTER UI rule 2: primary action at the top, Summary directly below, Search & Filters,
  // then the records.
  const filterCard =
    // Relocates into the Branch page's shared #tab-filters-slot (Ren, 2026-09-24) -- starts hidden since Scrap isn't
    // the default active tab; showSubTab() there toggles it back on when this tab is selected.
    '<div class="card" id="scrap-filter-card" data-filter-tab="scrap" style="display:none;">' +
      '<h3 style="margin-top:0;">Search &amp; Filter</h3>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="min-width:200px;"><label>Search</label><input type="text" id="sc-f-search" placeholder="Customer, contact, metal, purity, reference, #id…"></div>' +
        '<div class="field"><label>Metal</label><select id="sc-f-metal"><option value="all">All</option><option>Gold</option><option>Silver</option><option>Other</option></select></div>' +
        '<div class="field"><label>Type</label><select id="sc-f-kind"><option value="all">All</option>' + KINDS.map((k) => '<option>' + k + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Payment</label><select id="sc-f-pay"><option value="all">All</option><option value="owing">Owing (unpaid + partly paid)</option>' +
          '<option value="unpaid">UNPAID</option><option value="partial">PARTIALLY PAID</option><option value="paid">PAID</option></select></div>' +
        // From/To are driven by the page's global date range (Branch Operations Summary): kept in the DOM, not shown.
        '<div class="field range-managed"><label>From</label><input type="date" id="sc-f-from"></div>' +
        '<div class="field range-managed"><label>To</label><input type="date" id="sc-f-to"></div>' +
        sortControlHtml(SC_SORT_FIELDS, sort, 'sc-sort-field', 'sc-sort-dir') +
        '<button type="button" class="btn small secondary" id="sc-f-clear">Clear Filters</button>' +
      '</div>' +
    '</div>';

  root.innerHTML =
    '<div class="module-topbar"><div></div><div style="text-align:right;">' +
      '<button type="button" class="btn" id="sc-new-btn">+ New Scrap</button>' +
      '<div id="sc-write-note"></div>' +
    '</div></div>' +
    '<div class="muted" id="sc-caption" style="margin:0 0 6px;font-size:12px;"></div>' +
    '<div class="tiles" id="sc-tiles"><div class="muted">Loading…</div></div>' +
    '<h3 style="margin:14px 0 8px;">Breakdown by purity <span class="muted" style="font-weight:normal;font-size:12px;">— bought in the selected dates</span></h3>' +
    '<div id="sc-purity"></div>' +
    '<details class="card exp" open>' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Scrap grams by branch <span class="exp-count">(bought in the selected dates)</span></summary>' +
      '<div class="exp-body" id="sc-branches-body"><div class="muted">Loading…</div></div>' +
    '</details>' +
    '<details class="card exp" open style="margin-top:10px;margin-bottom:14px;">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Current balance — weight on hand <span class="exp-count" id="sc-balance-note"></span></summary>' +
      '<div class="exp-body" id="sc-balance-body"><div class="muted">Loading…</div></div>' +
    '</details>' +
    filterCard +
    '<div id="sc-active"></div>' +
    '<div class="ops-seg" id="sc-view-seg" role="group" aria-label="Scrap view" style="margin:14px 0 10px;">' +
      '<button type="button" data-view="entries" aria-pressed="true">Entries</button>' +
      '<button type="button" data-view="payments" aria-pressed="false">Scrap Payments</button>' +
    '</div>' +
    '<div id="sc-list"><div class="muted">Loading…</div></div>' +
    '<div id="sc-pay-list" hidden></div>' +
    // Delete requests: collapsed while empty, opened and highlighted while something waits.
    '<h3 style="margin:18px 0 6px;">Approvals</h3>' +
    '<details class="card exp lw-approval" id="sc-requests-folder">' +
      '<summary><span class="exp-arrow" aria-hidden="true">▸</span>Scrap Delete Requests <span class="exp-count" id="sc-requests-count"></span></summary>' +
      '<div class="exp-body" id="sc-requests-list"><div class="muted">Loading…</div></div>' +
    '</details>' +

    '<div class="drawer-backdrop" id="sc-form-backdrop"></div>' +
    '<div class="drawer" id="sc-form-drawer">' +
      '<div class="drawer-header"><h3>New Scrap</h3><button type="button" class="drawer-close" id="sc-form-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body">' +
        '<form id="sc-form" novalidate style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
          '<div class="msg error" id="sc-form-err" role="alert" hidden></div>' +
          '<div class="drawer-section">' +
            '<h4>Entry</h4>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Date</label><input type="date" name="entryDate"></div>' +
              '<div class="field"><label>Time</label><input type="time" name="entryTime"></div>' +
            '</div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Branch</label><input type="text" id="sc-form-branch" readonly tabindex="-1"></div>' +
              '<div class="field"><label>Recorded by</label><input type="text" value="' + esc(employee.full_name || '') + '" readonly tabindex="-1"></div>' +
            '</div>' +
            '<div class="field"><label>Type *</label><select name="kind">' + KINDS.map((k) => '<option>' + k + '</option>').join('') + '</select></div>' +
            '<div class="field" data-sec="transfer" hidden><label>Other branch *</label><select name="otherBranch"></select></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Metal &amp; weight</h4>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Metal *</label><select name="metal"><option>Gold</option><option>Silver</option><option>Other</option></select></div>' +
              '<div class="field"><label>Purity *</label><select name="purity"></select></div>' +
            '</div>' +
            '<div class="field" data-purity-other hidden><label>Custom purity *</label><input type="text" name="purityOther" placeholder="e.g. 20K"></div>' +
            '<div class="field"><label>Weight (grams) *</label><input type="number" name="weight" step="0.001" min="0" inputmode="decimal"></div>' +
          '</div>' +
          '<div class="drawer-section" data-sec="money">' +
            '<h4>Price</h4>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Price per gram (₱)</label><input type="number" name="ppg" step="0.01" min="0" inputmode="decimal"></div>' +
              '<div class="field"><label>Gross amount (₱)</label><input type="number" name="gross" step="0.01" min="0" inputmode="decimal" placeholder="weight × price"></div>' +
            '</div>' +
            '<div class="field"><label>Adjustment (₱) — minus for a deduction</label><input type="number" name="adjustment" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
            '<div class="field" data-adj-reason hidden><label>Reason for the adjustment *</label><input type="text" name="adjReason" placeholder="e.g. assay deduction"></div>' +
            '<div class="field"><label>Final amount (₱)</label><input type="number" name="final" readonly tabindex="-1" placeholder="gross + adjustment"></div>' +
          '</div>' +
          '<div class="drawer-section" data-sec="money">' +
            '<h4 id="sc-cust-title">Customer</h4>' +
            '<div class="field"><label id="sc-cust-label">Customer name *</label><input type="text" name="customer" autocomplete="off"></div>' +
            '<div class="field"><label>Contact number</label><input type="text" name="contact" autocomplete="off" inputmode="tel"></div>' +
            '<div class="field"><label>Address (optional)</label><input type="text" name="address" autocomplete="off"></div>' +
            '<div class="sc-row2">' +
              '<div class="field"><label>Source</label><select name="sourceType"><option value="">— choose —</option>' + SOURCE_TYPES.map((s) => '<option>' + s + '</option>').join('') + '</select></div>' +
              '<div class="field"><label>Source note</label><input type="text" name="source" placeholder="e.g. walk-in, buyback, refiner name"></div>' +
            '</div>' +
          '</div>' +
          '<div class="drawer-section" data-sec="money">' +
            '<h4>Payment</h4>' +
            '<div id="sc-pay-box">' + paymentRowsHtml({ recorder: employee.full_name || 'you', hint: 'Leave the amount blank to record the purchase as unpaid and pay it later (e.g. a customer paid by bank transfer the next day).' }) + '</div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<h4>Notes &amp; photo</h4>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
            '<div class="field"><label>Photo</label><input type="file" name="attachment" accept="image/*"></div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="drawer-footer">' +
        '<button class="btn" type="submit" form="sc-form" id="sc-form-submit">Add Entry</button>' +
        '<button type="button" class="btn secondary" id="sc-form-cancel">Cancel</button>' +
      '</div>' +
    '</div>' +
    '<div class="drawer-backdrop" id="sc-detail-backdrop"></div>' +
    '<div class="drawer" id="sc-detail-drawer">' +
      '<div class="drawer-header"><h3 id="sc-detail-title">Scrap Details</h3><button type="button" class="drawer-close" id="sc-detail-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="sc-detail-body"></div>' +
    '</div>';

  document.getElementById('tab-filters-slot')?.appendChild(document.getElementById('scrap-filter-card'));
  const $ = (id) => document.getElementById(id);
  // Start on the page's global date range (later changes arrive as 'change' events on these inputs).
  const range0 = getRange ? getRange() : null;
  if (range0) {
    $('sc-f-from').value = range0.preset === 'all' ? '' : range0.from;
    $('sc-f-to').value = range0.preset === 'all' ? '' : range0.to;
  }

  // ---------------------------------------------------------------------------------------------
  // The pieces the New Scrap form and the Edit form share: purity list that follows the metal, the
  // weight × price → gross → adjustment → final arithmetic.
  // ---------------------------------------------------------------------------------------------
  const fe = (form, name) => form.elements[name];

  function setPurity(form, metal, selected) {
    const sel = fe(form, 'purity');
    sel.innerHTML = purityOptionsHtml(metal, selected);
    const other = form.querySelector('[data-purity-other]');
    const isCustom = sel.value === 'Custom';
    other.hidden = !isCustom;
    if (isCustom && selected && selected !== 'Custom') fe(form, 'purityOther').value = selected;
  }
  function wirePurity(form) {
    fe(form, 'metal').addEventListener('change', () => { setPurity(form, fe(form, 'metal').value, ''); fe(form, 'purityOther').value = ''; });
    fe(form, 'purity').addEventListener('change', () => { form.querySelector('[data-purity-other]').hidden = fe(form, 'purity').value !== 'Custom'; });
  }
  const readPurity = (form) => (fe(form, 'purity').value === 'Custom' ? fe(form, 'purityOther').value.trim() : fe(form, 'purity').value);

  /** weight × price per gram fills the gross amount (locked while both are set); otherwise the gross is typed.
   * final = gross + adjustment. Returns the numbers so callers do not re-parse the inputs. */
  function calcAmounts(form) {
    const w = Number(fe(form, 'weight').value) || 0, p = Number(fe(form, 'ppg').value) || 0;
    const auto = w > 0 && p > 0;
    if (auto) fe(form, 'gross').value = r2(w * p).toFixed(2);
    fe(form, 'gross').readOnly = auto;
    const adj = Number(fe(form, 'adjustment').value) || 0;
    const grossStr = fe(form, 'gross').value;
    const gross = Number(grossStr) || 0;
    const any = grossStr !== '' || adj !== 0;
    const final = any ? r2(gross + adj) : 0;
    fe(form, 'final').value = any ? final.toFixed(2) : '';
    const reasonWrap = form.querySelector('[data-adj-reason]');
    if (reasonWrap) reasonWrap.hidden = !adj;
    return { gross, adj, final, hasGross: grossStr !== '' };
  }
  function wireAmounts(form, after) {
    ['weight', 'ppg', 'gross', 'adjustment'].forEach((n) => fe(form, n).addEventListener('input', () => { const a = calcAmounts(form); if (after) after(a); }));
  }

  // ---------------------------------------------------------------------------------------------
  // New Scrap drawer
  // ---------------------------------------------------------------------------------------------
  const form = $('sc-form');
  const today = () => manilaToday();
  // The payment rows are the shared component (js/paymentRows.js): what is due is the final amount of a money entry
  // (nothing is due on a transfer), and no payment may be dated before the purchase.
  const pay = mountPaymentRows($('sc-pay-box'), {
    getDue: () => (isMoneyKind(fe(form, 'kind').value) ? Number(fe(form, 'final').value) || 0 : 0),
    getMinDate: () => fe(form, 'entryDate').value || '', minDateLabel: 'purchase date', dueLabel: 'Final amount',
    emptyText: 'Enter the weight and price to see what is owed.',
  });

  function applyKind() {
    const kind = fe(form, 'kind').value;
    const money_ = isMoneyKind(kind), transfer = isTransferKind(kind);
    form.querySelectorAll('[data-sec="money"]').forEach((el) => { el.hidden = !money_; });
    form.querySelectorAll('[data-sec="transfer"]').forEach((el) => { el.hidden = !transfer; });
    $('sc-cust-title').textContent = kind === 'Refiner / Other' ? 'Refiner / buyer' : 'Customer';
    $('sc-cust-label').textContent = kind === 'Refiner / Other' ? 'Refiner / buyer name *' : 'Customer name *';
    $('sc-form-submit').textContent = transfer ? 'Record Transfer' : 'Add Entry';
    const sel = fe(form, 'otherBranch');
    const here = getBranchId();
    sel.innerHTML = '<option value="">— choose branch —</option>' + (branches || []).filter((b) => b.id !== here)
      .map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('');
    pay.sync();
  }
  function showFormError(message, el) {
    const box = $('sc-form-err');
    box.textContent = friendlyError(message); box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (el) flagInvalid(el);
  }
  function resetForm() {
    form.reset();
    $('sc-form-err').hidden = true;
    fe(form, 'entryDate').value = today(); fe(form, 'entryDate').max = today();
    fe(form, 'entryTime').value = manilaNowHM();
    $('sc-form-branch').value = branchName(getBranchId());
    setPurity(form, 'Gold', '18K');
    fe(form, 'gross').readOnly = false;
    // Transfers are a supervisor's job (the database checks it too): hide the types this person cannot record.
    fe(form, 'kind').innerHTML = KINDS.filter((k) => !isTransferKind(k) || canTransfer()).map((k) => '<option>' + k + '</option>').join('');
    calcAmounts(form);
    pay.reset();
    applyKind();
  }

  wirePurity(form);
  // Until someone types in it, the first payment follows the final amount (most purchases are paid in full on the spot).
  wireAmounts(form, () => pay.sync());
  fe(form, 'kind').addEventListener('change', () => { calcAmounts(form); applyKind(); });
  fe(form, 'entryDate').addEventListener('change', () => pay.sync());
  attachCustomerPicker({ nameInput: fe(form, 'customer'), contactInput: fe(form, 'contact'), addressInput: fe(form, 'address') });

  const openFormDrawer = () => { resetForm(); $('sc-form-backdrop').classList.add('open'); $('sc-form-drawer').classList.add('open'); };
  const closeFormDrawer = () => { $('sc-form-backdrop').classList.remove('open'); $('sc-form-drawer').classList.remove('open'); };
  $('sc-new-btn').addEventListener('click', openFormDrawer);
  $('sc-form-close').addEventListener('click', closeFormDrawer);
  $('sc-form-cancel').addEventListener('click', closeFormDrawer);
  $('sc-form-backdrop').addEventListener('click', closeFormDrawer);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('sc-form-err').hidden = true;
    const kind = fe(form, 'kind').value, money_ = isMoneyKind(kind), transfer = isTransferKind(kind);
    const purity = readPurity(form);
    const weight = Number(fe(form, 'weight').value);
    const a = calcAmounts(form);
    const entryDate = fe(form, 'entryDate').value || today();
    const fail = (msg, el) => { showFormError(msg, el); return false; };

    if (!(weight > 0)) return void fail('Enter the weight in grams (more than 0).', fe(form, 'weight'));
    if (!purity) return void fail('Choose the purity (or type a custom one).', fe(form, fe(form, 'purity').value === 'Custom' ? 'purityOther' : 'purity'));
    if (entryDate > today()) return void fail('The date cannot be in the future.', fe(form, 'entryDate'));
    let payments = [];
    let counterpart = null;
    if (transfer) {
      counterpart = Number(fe(form, 'otherBranch').value) || null;
      if (!counterpart) return void fail('Choose the other branch for this transfer.', fe(form, 'otherBranch'));
    } else {
      if (a.final <= 0) return void fail('Enter the amount: a price per gram, or the gross amount.', fe(form, a.hasGross ? 'adjustment' : 'ppg'));
      if (a.adj && !fe(form, 'adjReason').value.trim()) return void fail('Give a reason for the price adjustment.', fe(form, 'adjReason'));
      if (kind === 'Bought from Customer' && !fe(form, 'customer').value.trim() && !fe(form, 'sourceType').value && !fe(form, 'source').value.trim()) {
        return void fail('Enter the customer name (or choose where this came from).', fe(form, 'customer'));
      }
      const got = pay.read();
      if (got.error) return void fail(got.error, got.el);
      payments = got.payments;
    }

    const btn = $('sc-form-submit');
    btn.disabled = true;
    try {
      const saved = await createScrapEntryV2({
        branchId: getBranchId(), entryDate, entryTime: fe(form, 'entryTime').value || null, kind, metal: fe(form, 'metal').value, purity, weight,
        pricePerGram: transfer ? null : (Number(fe(form, 'ppg').value) || null), gross: transfer ? null : a.gross, adjustment: transfer ? 0 : a.adj,
        adjustmentReason: a.adj ? fe(form, 'adjReason').value.trim() : null, final: transfer ? 0 : a.final,
        customerName: transfer ? null : fe(form, 'customer').value.trim(), contact: transfer ? null : fe(form, 'contact').value.trim(),
        address: transfer ? null : fe(form, 'address').value.trim(), sourceType: transfer ? null : fe(form, 'sourceType').value,
        source: transfer ? null : fe(form, 'source').value.trim(), notes: fe(form, 'notes').value.trim(), payments, counterpartBranch: counterpart,
      });
      // The entry and its payment lines are saved. Photos / proofs go up now; if one fails the entry is NOT lost.
      const warnings = [];
      const photo = fe(form, 'attachment').files[0];
      if (photo) { try { await uploadScrapAttachment(getBranchId(), saved.entryId, photo); } catch (err) { warnings.push('the photo (' + (err.message || err) + ')'); } }
      for (let i = 0; i < payments.length; i++) {
        if (!payments[i].file) continue;
        try { await uploadScrapPaymentProof(getBranchId(), saved.entryId, saved.paymentIds[i], payments[i].file); }
        catch (err) { warnings.push('the proof for payment ' + (i + 1) + ' (' + (err.message || err) + ')'); }
      }
      notify(warnings.length ? 'Saved, but ' + warnings.join(' and ') + ' could not be uploaded -- open the entry and attach it again.' : (transfer ? 'Transfer recorded.' : 'Entry added.'), !!warnings.length);
      closeFormDrawer();
      await load();
      openDetail(saved.entryId);
    } catch (err) {
      showFormError(String(err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------------------------
  function decorate(r) {
    r._paid = (r.scrap_payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
    r._money = isMoneyKind(r.kind);
    r._st = r._money ? paymentStatusOf(r.total_amount, r._paid) : paymentStatusOf(0, 0);
    r._hay = [r.id, '#' + r.id, r.customer_name, r.contact_number, r.customer_address, r.source, r.source_type, r.notes, r.metal_type, r.karat, r.kind,
      r.payment_method, r.entry_date, r.weight_grams, r.total_amount, r.creator && r.creator.full_name,
      ...(r.scrap_payments || []).map((p) => (p.reference_number || '') + ' ' + p.payment_method)].filter((x) => x != null).join(' ').toLowerCase();
    return r;
  }

  async function loadReports() {
    const mine = ++reportSeq;
    const rg = getRange(), bid = getBranchId();
    try {
      const [rep, repAll] = await Promise.all([getScrapOpsReport(rg.from, rg.to, [bid]), getScrapOpsReport(rg.from, rg.to, null)]);
      if (mine !== reportSeq) return;
      report = rep; reportAll = repAll; reportErr = '';
    } catch (err) {
      if (mine !== reportSeq) return;
      report = null; reportAll = null; reportErr = String(err.message || err);
    }
    renderSummary();
  }

  async function load() {
    const list = $('sc-list');
    if (!entries.length) list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const [ents, cash, reqs] = await Promise.all([
        listScrapEntries(getBranchId()),
        getScrapCashBalances().catch(() => cashBalances),
        listBranchRecordRequests(['scrap_entries', 'scrap_payments']).catch(() => []),
      ]);
      entries = ents.map(decorate);
      cashBalances = cash;
      requests = reqs.filter((q) => q.branch_id === getBranchId());
      render();
      refreshOpenDetail();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
    await loadReports();
  }

  // ---------------------------------------------------------------------------------------------
  // Summary (server figures): tiles, purity, grams by branch, weight on hand
  // ---------------------------------------------------------------------------------------------
  function tile(num, label, tone, sub, act) {
    return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"' + (act ? ' data-act="' + act + '" style="cursor:pointer;"' : '') + '><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div>' +
      (sub ? '<div class="muted" style="font-size:10.5px;margin-top:2px;">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function renderSummary() {
    const rg = getRange();
    $('sc-caption').textContent = branchName(getBranchId()) + ' · ' + (rg.label || (rg.from + ' – ' + rg.to));
    const tiles = $('sc-tiles');
    if (!report) {
      const msg = reportErr ? '<div class="msg error">The scrap summary could not be loaded (' + esc(reportErr) + ').</div>' : '<div class="muted">Loading…</div>';
      tiles.innerHTML = msg; $('sc-purity').innerHTML = ''; $('sc-branches-body').innerHTML = msg; $('sc-balance-body').innerHTML = msg;
      return;
    }
    const s = report.summary, out = report.outstanding || { entries: 0, balance: 0 };
    let h = tile(s.entries, 'Entries') + tile(grams(s.grams), 'Total Weight') + tile(money(s.amount), 'Total Purchased Amount') +
      tile(s.avg_price_per_gram != null ? money(s.avg_price_per_gram) : '—', 'Average Price / Gram') +
      tile(money(s.today_amount), "Today's Purchased Amount", null, s.today_entries + (s.today_entries === 1 ? ' entry' : ' entries'));
    if (canSeeScrapCash()) {
      const c = cashBalances.find((b) => b.branch_id === getBranchId());
      h += tile(money(c ? c.remaining_scrap_cash : 0), 'Remaining Scrap Cash');
    }
    const owing = Number(s.balance) > 0.005;
    const older = out.entries - s.unpaid_entries - s.partial_entries;
    h += tile(money(s.balance), 'Unpaid Balance', owing || out.entries ? 'bad' : null,
      owing ? s.unpaid_entries + ' unpaid · ' + s.partial_entries + ' partly paid' + (older > 0 ? ' · +' + older + ' older' : '') : (out.entries ? out.entries + ' older entr' + (out.entries === 1 ? 'y' : 'ies') + ' still owing (' + money(out.balance) + ')' : 'all paid'),
      owing || out.entries ? 'show-unpaid' : null);
    if (s.refined && s.refined.entries) h += tile(money(s.refined.amount), 'Sold / Refined', null, grams(s.refined.grams));
    tiles.innerHTML = h;
    tiles.querySelectorAll('[data-act="show-unpaid"]').forEach((el) => el.addEventListener('click', () => applyView('unpaid')));

    $('sc-purity').innerHTML = '<div class="sc-purity">' + PURITY_BUCKETS.map((b) => {
      const p = (report.by_purity || {})[b];
      return '<div class="sc-pur' + (p && Number(p.grams) ? '' : ' zero') + '"><div class="sc-pur-lbl">' + b + '</div><div class="sc-pur-g">' + gramsPlain(p ? p.grams : 0) + ' g</div>' +
        '<div class="muted sc-pur-a">' + (p ? money(p.amount) : '—') + '</div></div>';
    }).join('') + '</div>';

    renderByBranch();
    renderBalance();
  }

  function renderByBranch() {
    const body = $('sc-branches-body');
    const list = ((reportAll && reportAll.by_branch) || []).filter((b) => b.is_active || b.entries > 0);
    if (!list.length) { body.innerHTML = '<p class="muted">No branches to show.</p>'; return; }
    const tot = { g: {}, grams: 0, amount: 0 };
    const rows = list.map((b) => {
      PURITY_BUCKETS.forEach((k) => { tot.g[k] = (tot.g[k] || 0) + Number((b.grams || {})[k] || 0); });
      tot.grams += Number(b.total_grams); tot.amount += Number(b.total_amount);
      return '<tr class="' + (b.branch_id === getBranchId() ? 'ops-cur' : '') + '"><td data-label="Branch"><b>' + esc(b.name) + '</b>' + (b.is_active ? '' : ' <span class="badge gray">inactive</span>') + '</td>' +
        PURITY_BUCKETS.map((k) => '<td data-label="' + k + '">' + gramsCell((b.grams || {})[k]) + '</td>').join('') +
        '<td data-label="Total Grams"><b>' + gramsPlain(b.total_grams) + '</b></td><td data-label="Total Purchase Amount">' + money(b.total_amount) + '</td></tr>';
    }).join('');
    body.innerHTML = '<div class="table-scroll table-mini"><table class="ops-table"><thead><tr><th>Branch</th>' + PURITY_BUCKETS.map((k) => '<th>' + k + '</th>').join('') +
      '<th>Total Grams</th><th>Total Purchase Amount</th></tr></thead><tbody>' + rows + '</tbody><tfoot><tr><td><b>All shown</b></td>' +
      PURITY_BUCKETS.map((k) => '<td><b>' + gramsCell(tot.g[k]) + '</b></td>').join('') + '<td><b>' + gramsPlain(tot.grams) + '</b></td><td><b>' + money(tot.amount) + '</b></td></tr></tfoot></table></div>';
  }

  function renderBalance() {
    const body = $('sc-balance-body');
    const rows = (report && report.weight_on_hand) || [];
    $('sc-balance-note').textContent = report ? '(as of ' + fmtDate(report.range.to) + ')' : '';
    if (!rows.length) { body.innerHTML = '<p class="muted">No scrap recorded for this branch up to this date.</p>'; return; }
    const keys = ['opening', 'purchased', 'transferred_in', 'transferred_out', 'sold_refined', 'current'];
    const tot = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, x) => s + Number(x[k] || 0), 0)]));
    body.innerHTML = '<div class="table-scroll table-mini"><table class="ops-table"><thead><tr><th>Metal</th><th>Purity</th><th>Opening Grams</th><th>Purchased</th><th>Transferred In</th><th>Transferred Out</th><th>Sold / Refined</th><th>Current Grams</th></tr></thead><tbody>' +
      rows.map((x) => '<tr><td data-label="Metal">' + esc(x.metal) + '</td><td data-label="Purity">' + esc(x.purity || '—') + '</td>' +
        keys.slice(0, 5).map((k) => '<td data-label="' + k + '">' + gramsCell(x[k]) + '</td>').join('') + '<td data-label="Current Grams"><b>' + gramsPlain(x.current) + '</b></td></tr>').join('') +
      '</tbody><tfoot><tr><td colspan="2"><b>All metals</b></td>' + keys.slice(0, 5).map((k) => '<td><b>' + gramsCell(tot[k]) + '</b></td>').join('') + '<td><b>' + gramsPlain(tot.current) + '</b></td></tr></tfoot></table></div>' +
      '<p class="muted" style="font-size:11px;margin:8px 0 0;">' + (getRange().preset === 'all' ? '' : 'Opening is what was on hand before ' + fmtDate(report.range.from) + '. ') +
      'Current = Opening + Purchased + Transferred In − Transferred Out − Sold / Refined. Entries converted to Subasta are not counted.</p>';
  }

  // ---------------------------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------------------------
  function readFilters() {
    return {
      search: $('sc-f-search').value.trim().toLowerCase(), metal: $('sc-f-metal').value, kind: $('sc-f-kind').value, pay: $('sc-f-pay').value,
      from: $('sc-f-from').value, to: $('sc-f-to').value,
    };
  }
  function matchesNonDate(r, f) {
    if (f.metal !== 'all' && r.metal_type !== f.metal) return false;
    if (f.kind !== 'all' && r.kind !== f.kind) return false;
    if (f.pay !== 'all') {
      const k = r._st.key;
      if (f.pay === 'owing' ? !(k === 'unpaid' || k === 'partial') : k !== f.pay) return false;
    }
    return !f.search || r._hay.includes(f.search);
  }
  const inRange = (d, f) => (!f.from || String(d).slice(0, 10) >= f.from) && (!f.to || String(d).slice(0, 10) <= f.to);

  function setView(v) {
    view = v;
    $('sc-list').hidden = v !== 'entries';
    $('sc-pay-list').hidden = v !== 'payments';
    $('sc-view-seg').querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  }
  $('sc-view-seg').querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); render(); }));

  const personOf = (r) => r.customer_name || (r.kind === 'Bought from Customer' ? 'Walk-in' : (isTransferKind(r.kind) ? (r.kind === 'Transferred Out' ? 'To ' : 'From ') + branchName(r.counterpart_branch_id) : '—'));

  function render() {
    const canAdd = canAddHere();
    $('sc-new-btn').disabled = !canAdd;
    $('sc-write-note').innerHTML = canAdd ? '' : '<p class="muted" style="font-size:11px;">View only — you can only add scrap for your own branch.</p>';
    const f = readFilters();
    const rows = entries.filter((r) => matchesNonDate(r, f) && inRange(r.entry_date, f));
    // The module pill count follows these same filtered rows (MASTER UI rules 6/19/20/28).
    if (onCountUpdate) onCountUpdate(rows.length);
    // The date range is the page's global range (Branch Operations Summary), not a filter that Clear Filters could
    // undo -- it is named in the empty-state message instead.
    const hasFilters = !!(f.search || f.metal !== 'all' || f.kind !== 'all' || f.pay !== 'all');
    const activeEl = $('sc-active');
    activeEl.innerHTML = activeFiltersHtml([
      { label: 'Search', value: esc(f.search) }, { label: 'Metal', value: esc(f.metal) }, { label: 'Type', value: esc(f.kind) },
      { label: 'Payment', value: esc({ owing: 'Owing', unpaid: 'UNPAID', partial: 'PARTIALLY PAID', paid: 'PAID' }[f.pay] || f.pay) },
    ], 'sc-f-clear');
    wireProxyButtons(activeEl);
    if (view === 'entries') renderEntries(rows, hasFilters); else renderPayments(f, hasFilters);
    renderRequests();
  }

  function emptyList(container, hasFilters, what) {
    const rg = getRange();
    const rangeLabel = rg && rg.preset !== 'all' ? rg.label : '';
    container.innerHTML = emptyStateHtml({
      message: hasFilters ? 'No ' + what + ' match these filters' + (rangeLabel ? ' for ' + esc(rangeLabel) : '') + '.'
        : (rangeLabel ? 'No ' + what + ' for ' + esc(rangeLabel) + '.' : 'No ' + what + ' recorded for this branch yet.'),
      hasFilters, clearId: 'sc-f-clear', createLabel: canAddHere() ? '+ New Scrap' : null, createId: 'sc-new-btn',
    });
    wireProxyButtons(container);
    if (rangeLabel && requestRange) {
      const more = document.createElement('div');
      more.className = 'empty-state-actions'; more.style.marginTop = '8px';
      more.innerHTML = '<button type="button" class="btn small secondary">Search all dates</button>';
      more.querySelector('button').addEventListener('click', () => requestRange('all'));
      container.querySelector('.empty-state')?.appendChild(more);
    }
  }

  function renderEntries(rows, hasFilters) {
    const list = $('sc-list');
    if (!rows.length) { emptyList(list, hasFilters, 'scrap entries'); return; }
    // Filtering already picked `rows`; sort only reorders them for display (section 11).
    const info = pageSlice(applySort(rows, sort, SC_SORT_COMPARATORS), pg);
    // Auto-width columns with no-wrap on the figures (a fixed percentage column broke "₱15,750.00" in two at laptop
    // widths); the box scrolls sideways only when the screen really is too narrow, and below 1024px it is a card list.
    list.innerHTML = '<div class="table-scroll table-2col"><table class="sc-table">' +
      '<thead><tr><th class="nw">Date</th><th>Customer</th><th class="nw">Metal/Purity</th><th>Type</th><th class="nw">Weight</th><th class="nw">Price/Gram</th><th class="nw">Amount</th><th class="nw">Payment</th><th>Recorded By</th><th></th></tr></thead><tbody>' +
      info.rows.map((r) => '<tr data-row-id="' + r.id + '">' +
        '<td data-label="Date" class="nw">' + fmtDate(r.entry_date) + (r.purchase_time ? '<div class="muted" style="font-size:10.5px;">' + fmtTime(r.purchase_time) + '</div>' : '') + '</td>' +
        '<td data-label="Customer">' + esc(personOf(r)) + '</td>' +
        '<td data-label="Metal/Purity" class="nw">' + esc(r.metal_type) + ' ' + esc(r.karat || '') + '</td>' +
        '<td data-label="Type" class="nw">' + kindBadge(r.kind) + '</td>' +
        '<td data-label="Weight" class="nw">' + grams(r.weight_grams) + '</td>' +
        '<td data-label="Price/Gram" class="nw">' + (r._money ? money(r.price_per_gram) : '—') + '</td>' +
        '<td data-label="Amount" class="nw">' + (r._money ? money(r.total_amount) : '—') +
          (Number(r.adjustment_amount) ? '<div class="muted" style="font-size:10px;">adj. ' + money(r.adjustment_amount) + '</div>' : '') +
          (r.converted_to_subasta_item_id ? '<div style="font-size:10px;"><span class="badge ok" style="font-size:9px;">→ Subasta #' + r.converted_to_subasta_item_id + '</span></div>' : '') + '</td>' +
        '<td data-label="Payment" class="nw">' + paymentChipHtml(r._st) + (r._st.key === 'unpaid' || r._st.key === 'partial' ? '<div class="muted" style="font-size:10px;">' + money(r._st.balance) + ' left</div>' : '') + '</td>' +
        '<td data-label="Recorded By" class="full-row" style="font-size:12px;">' + esc((r.creator && r.creator.full_name) || '—') + '</td>' +
        '<td class="full-row nw"><button type="button" class="btn small secondary" data-act="view-details" data-id="' + r.id + '">View Details</button></td>' +
      '</tr>').join('') + '</tbody></table></div>' + pagerHtml(info);
    wirePager(list, pg, render);
    list.querySelectorAll('tr[data-row-id]').forEach((tr) => tr.addEventListener('click', (ev) => {
      if (ev.target.closest('a, input, select') || (ev.target.closest('button') && !ev.target.closest('[data-act="view-details"]'))) return;
      openDetail(Number(tr.dataset.rowId));
    }));
  }

  /** One row per payment line, with the balance still owing after it; a purchase with no payment yet is one UNPAID row. */
  function paymentLines(f) {
    const out = [];
    entries.filter((r) => r._money && matchesNonDate(r, f)).forEach((r) => {
      const entryIn = inRange(r.entry_date, f);
      const pays = r.scrap_payments || [];
      if (!pays.length) { if (entryIn) out.push({ r, p: null, after: Number(r.total_amount || 0) }); return; }
      let running = 0;
      pays.forEach((p) => {
        running += Number(p.amount);
        // inside the dates by purchase date, or only the lines actually paid inside them
        if (entryIn || inRange(p.paid_at, f)) out.push({ r, p, after: Math.max(Number(r.total_amount || 0) - running, 0) });
      });
    });
    return out.sort((a, b) => String(b.p ? b.p.paid_at : b.r.entry_date).localeCompare(String(a.p ? a.p.paid_at : a.r.entry_date)) || (b.p ? b.p.id : 0) - (a.p ? a.p.id : 0));
  }

  function renderPayments(f, hasFilters) {
    const box = $('sc-pay-list');
    const lines = paymentLines(f);
    if (!lines.length) { emptyList(box, hasFilters, 'scrap payments'); return; }
    const info = pageSlice(lines, payPg);
    const paidSum = lines.reduce((s, l) => s + (l.p ? Number(l.p.amount) : 0), 0);
    box.innerHTML = '<p class="muted" style="margin:0 0 8px;font-size:12px;">' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' · paid out ' + money(paidSum) + '</p>' +
      '<div class="table-scroll table-2col"><table class="sc-table">' +
      '<thead><tr><th>Customer</th><th class="nw">Entry</th><th class="nw">Purchase Amount</th><th class="nw">Paid</th><th class="nw">Balance</th><th class="nw">Payment Method</th><th class="nw">Payment Date</th><th>Reference</th><th class="nw">Status</th><th>Recorded By</th></tr></thead><tbody>' +
      info.rows.map(({ r, p, after }) => '<tr data-row-id="' + r.id + '">' +
        '<td data-label="Customer">' + esc(personOf(r)) + '</td>' +
        '<td data-label="Entry" class="nw">#' + r.id + '<div class="muted" style="font-size:10.5px;">' + fmtDate(r.entry_date) + '</div></td>' +
        '<td data-label="Purchase Amount" class="nw">' + money(r.total_amount) + '</td>' +
        '<td data-label="Paid" class="nw">' + (p ? money(p.amount) : '—') + '</td>' +
        '<td data-label="Balance" class="nw">' + money(after) + '</td>' +
        '<td data-label="Payment Method" class="nw">' + (p ? esc(p.payment_method) : '—') + '</td>' +
        '<td data-label="Payment Date" class="nw">' + (p ? fmtDate(p.paid_at) : '—') + '</td>' +
        '<td data-label="Reference">' + (p && p.reference_number ? esc(p.reference_number) : '—') + (p && p.attachment_path ? ' <span class="muted" title="Proof attached">📎</span>' : '') + '</td>' +
        '<td data-label="Status" class="nw">' + paymentChipHtml(r._st) + '</td>' +
        '<td data-label="Recorded By" class="full-row" style="font-size:12px;">' + esc(((p ? p.recorder : r.creator) || {}).full_name || '—') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>' + pagerHtml(info);
    wirePager(box, payPg, render);
    box.querySelectorAll('tr[data-row-id]').forEach((tr) => tr.addEventListener('click', () => openDetail(Number(tr.dataset.rowId))));
  }

  // ---------------------------------------------------------------------------------------------
  // Delete requests (Pending -> Supervisor Approved -> removed by Admin)
  // ---------------------------------------------------------------------------------------------
  async function runAction(fn, okText) {
    try { await fn(); notify(okText, false); await load(); }
    catch (err) { notify(String(err.message || err), true); }
  }

  function renderRequests() {
    $('sc-requests-count').textContent = '(' + requests.length + ')';
    setApprovalFolder('sc-requests-folder', requests.length);
    const box = $('sc-requests-list');
    if (!requests.length) { box.innerHTML = '<p class="muted">No scrap delete requests waiting.</p>'; return; }
    box.innerHTML = requests.map((q) => {
      const s = q.snapshot || {};
      const mine = q.requested_by === employee.id;
      const awaitingFinal = q.status === 'Supervisor Approved';
      const pays = Array.isArray(s.payments) ? s.payments : [];
      const isPay = q.record_table === 'scrap_payments';
      const verb = isPay ? 'remove' : 'delete';
      const buttons = [];
      if (q.status === 'Pending' && isSupervisorUp && (isAdmin || !mine)) {
        buttons.push('<button class="btn small" data-act="sup-approve" data-id="' + q.id + '">Approve</button>');
        if (isAdmin) buttons.push('<button class="btn small danger" data-act="admin-approve" data-id="' + q.id + '">Approve &amp; ' + verb + '</button>');
      }
      if (awaitingFinal && isAdmin) buttons.push('<button class="btn small danger" data-act="final-approve" data-id="' + q.id + '">Final approval — ' + verb + '</button>');
      if (isSupervisorUp && (q.status === 'Pending' || isAdmin)) buttons.push('<button class="btn small secondary" data-act="reject" data-id="' + q.id + '">Reject</button>');
      if (mine || isAdmin) buttons.push('<button class="btn small secondary" data-act="withdraw" data-id="' + q.id + '">Withdraw</button>');
      return approvalCardHtml(esc, {
        type: isPay ? 'Remove scrap payment' : 'Delete scrap entry', order: s.order, customer: s.customer,
        item: isPay ? [s.method, s.reference ? '#' + s.reference : ''].filter(Boolean).join(' ') : [s.metal, s.purity, s.grams != null ? grams(s.grams) : ''].filter(Boolean).join(' '),
        amount: s.amount, requester: q.requester && q.requester.full_name, requestedAt: q.requested_at, reason: q.reason,
        detail: (q.error_type ? 'Kind of mistake: <b>' + esc(q.error_type) + '</b>' : '') +
          (isPay ? (q.error_type ? ' · ' : '') + 'paid ' + fmtDate(s.paid_at) + (s.entry_amount != null ? ' · the purchase is ' + money(s.entry_amount) : '')
            : (pays.length ? (q.error_type ? ' · ' : '') + pays.length + ' payment line' + (pays.length === 1 ? '' : 's') + ' (' + money(pays.reduce((t, p) => t + Number(p.amount || 0), 0)) + ') would be removed with it' : '')),
        supervisor: q.supervisor && q.supervisor.full_name, awaitingFinal,
        actions: buttons.join('') || '<span class="muted" style="font-size:12px;">' + (awaitingFinal ? 'Waiting for Admin.' : 'Waiting for a supervisor.') + '</span>',
      });
    }).join('');
    box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id), act = btn.dataset.act;
      const isPay = (requests.find((x) => x.id === id) || {}).record_table === 'scrap_payments';
      if (act === 'sup-approve') return runAction(() => approveBranchRecordStage1(id), 'Approved — now waiting for Admin.');
      if (act === 'admin-approve' || act === 'final-approve') {
        if (!await confirmDialog(isPay
          ? { title: 'Remove this payment line?', message: 'The purchase goes back to owing that amount. What was removed stays in the audit trail.', confirmLabel: 'Remove payment', danger: true }
          : { title: 'Delete this scrap entry?', message: 'The entry and its payment lines are removed. What was removed stays in the audit trail.', confirmLabel: 'Delete entry', danger: true })) return;
        return runAction(async () => { if (act === 'admin-approve') await approveBranchRecordStage1(id); await approveBranchRecordFinal(id); }, isPay ? 'Payment removed.' : 'Entry deleted.');
      }
      if (act === 'reject') {
        const out = await reasonDialog({ title: 'Reject this delete request?', message: 'Optional: tell the person why.', label: 'Reason', required: false, confirmLabel: 'Reject', danger: true });
        if (!out) return;
        return runAction(() => rejectBranchRecordAction(id, out.reason || null), 'Request rejected.');
      }
      if (act === 'withdraw') {
        if (!await confirmDialog({ title: 'Withdraw this request?', message: 'The entry stays as it is.', confirmLabel: 'Withdraw' })) return;
        return runAction(() => cancelBranchRecordAction(id), 'Request withdrawn.');
      }
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Detail drawer
  // ---------------------------------------------------------------------------------------------
  function closeDetailDrawer() {
    $('sc-detail-backdrop').classList.remove('open');
    $('sc-detail-drawer').classList.remove('open');
    openId = null; editingId = null;
  }
  $('sc-detail-close').addEventListener('click', closeDetailDrawer);
  $('sc-detail-backdrop').addEventListener('click', closeDetailDrawer);

  function openDetail(id) {
    const r = entries.find((x) => x.id === id);
    if (!r) return false; // not in the loaded branch -- the host may switch branch and retry
    openId = id; editingId = null;
    $('sc-detail-title').textContent = r.kind + ' — ' + r.metal_type + ' ' + (r.karat || '');
    const body = $('sc-detail-body');
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    loadAudit(r);
    $('sc-detail-backdrop').classList.add('open');
    $('sc-detail-drawer').classList.add('open');
    return true;
  }
  /** A realtime change should not wipe a form someone is typing in. */
  function refreshOpenDetail() {
    if (openId == null || editingId != null) return;
    const body = $('sc-detail-body');
    if (body.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
    const r = entries.find((x) => x.id === openId);
    if (!r) { closeDetailDrawer(); return; }
    body.innerHTML = renderDetailBody(r);
    wireDetailBody(body, r);
    loadAudit(r);
  }

  function renderDetailBody(r) {
    const st = r._st, pays = r.scrap_payments || [];
    const pending = requests.find((q) => q.record_table === 'scrap_entries' && q.record_id === String(r.id));
    const payRequest = (p) => requests.find((q) => q.record_table === 'scrap_payments' && q.record_id === String(p.id));
    // A payment line can be corrected by the same people who can correct the entry (and, until proof is attached, whoever recorded it)
    const canEditPay = (p) => !r.converted_to_subasta_item_id && canActOnBranch(r.branch_id) &&
      (has('scrap.edit') || ((has('role.admin_assistant') || has('role.sales_executive')) && p.recorded_by === employee.id && !p.attachment_path));
    const kv = (k, v) => '<div class="drawer-kv"><span>' + k + '</span><b>' + v + '</b></div>';
    const transferNote = isTransferKind(r.kind) && r.counterpart_branch_id != null ? ' ' + (r.kind === 'Transferred Out' ? 'to ' : 'from ') + esc(branchName(r.counterpart_branch_id)) : '';

    let h = '';
    if (pending) {
      h += '<div class="lw-note-box" style="margin-bottom:12px;"><b>Delete requested</b> by ' + esc((pending.requester && pending.requester.full_name) || '—') + ' · ' + fmtDateTime(pending.requested_at) +
        '<div>' + esc(pending.reason) + '</div><div class="muted" style="margin-top:4px;">' + (pending.status === 'Supervisor Approved' ? 'Approved by ' + esc((pending.supervisor && pending.supervisor.full_name) || 'a supervisor') + ' — waiting for Admin.' : 'Waiting for a supervisor.') + '</div>' +
        ((pending.requested_by === employee.id || isAdmin) ? '<div style="margin-top:6px;"><button type="button" class="btn small secondary" data-act="withdraw-req" data-id="' + pending.id + '">Withdraw request</button></div>' : '') + '</div>';
    }
    h += '<div class="drawer-section"><h4>Entry</h4>' +
      kv('Type', kindBadge(r.kind) + transferNote) +
      kv('Date', fmtDate(r.entry_date) + (r.purchase_time ? ' · ' + fmtTime(r.purchase_time) : '')) +
      kv('Branch', esc(branchName(r.branch_id))) +
      kv('Metal / Purity', esc(r.metal_type) + ' ' + esc(r.karat || '—')) +
      kv('Weight', grams(r.weight_grams)) +
      (r._money
        ? kv('Price / gram', money(r.price_per_gram)) + kv('Gross amount', money(r.gross_amount)) +
          (Number(r.adjustment_amount) ? kv('Adjustment', money(r.adjustment_amount) + (r.adjustment_reason ? ' <span class="muted">(' + esc(r.adjustment_reason) + ')</span>' : '')) : '') +
          kv('Final amount', money(r.total_amount)) + kv('Payment', paymentChipHtml(st))
        : '') +
      kv('Recorded by', esc((r.creator && r.creator.full_name) || '—')) +
      kv('Created', fmtDateTime(r.created_at)) +
      (r.updated_by ? kv('Last edited', fmtDateTime(r.updated_at) + (r.updater ? ' · ' + esc(r.updater.full_name) : '')) : '') +
      (r.converted_to_subasta_item_id ? kv('Converted', '<span class="badge ok">→ Subasta #' + r.converted_to_subasta_item_id + '</span>') : '') +
    '</div>';

    if (r._money) {
      h += '<div class="drawer-section"><h4>' + (r.kind === 'Refiner / Other' ? 'Refiner / buyer' : 'Customer') + '</h4>' +
        kv('Name', esc(r.customer_name || 'Walk-in')) + kv('Contact', esc(r.contact_number || '—')) +
        (r.customer_address ? kv('Address', esc(r.customer_address)) : '') +
        kv('Source', esc([r.source_type, r.source].filter(Boolean).join(' · ') || '—')) +
        (r.notes ? kv('Notes', esc(r.notes)) : '') + '</div>';
    } else if (r.notes) {
      h += '<div class="drawer-section"><h4>Notes</h4>' + kv('Notes', esc(r.notes)) + '</div>';
    }

    if (r._money) {
      h += '<div class="drawer-section"><h4>Payments</h4>' +
        (pays.length ? pays.map((p) => {
          const preq = payRequest(p);
          return '<div class="sc-pay-line"><div><b>' + money(p.amount) + '</b> · ' + esc(p.payment_method) +
            '<div class="muted" style="font-size:11px;">' + fmtDate(p.paid_at) + (p.reference_number ? ' · ref ' + esc(p.reference_number) : '') + ' · by ' + esc((p.recorder && p.recorder.full_name) || '—') + '</div>' +
            (preq ? '<div class="lw-pending-flag" style="font-size:11px;">Removal requested — ' + (preq.status === 'Supervisor Approved' ? 'waiting for Admin' : 'waiting for a supervisor') + '</div>' : '') + '</div>' +
          '<div class="sc-pay-actions">' + (p.attachment_path
              ? '<button type="button" class="btn small secondary" data-act="view-proof" data-path="' + esc(p.attachment_path) + '">View proof</button>'
              : (canAddHere() ? '<button type="button" class="btn small secondary" data-act="attach-proof" data-id="' + p.id + '">Attach proof</button>' : '<span class="muted" style="font-size:11px;">no proof</span>')) +
            (canEditPay(p) ? '<button type="button" class="btn small secondary" data-act="correct-payment" data-id="' + p.id + '">Correct</button>' : '') +
            (!r.converted_to_subasta_item_id && canActOnBranch(r.branch_id) && !preq
              ? (isAdmin ? '<button type="button" class="btn small secondary" data-act="remove-payment" data-id="' + p.id + '">Remove…</button>'
                         : '<button type="button" class="btn small secondary" data-act="request-remove-payment" data-id="' + p.id + '">Request removal</button>') : '') +
          '</div></div>';
        }).join('')
          : '<p class="muted">No payment recorded yet.</p>') +
        '<div class="drawer-kv"><span>Paid</span><b>' + money(st.paid) + '</b></div><div class="drawer-kv"><span>Balance</span><b>' + money(st.balance) + '</b></div>' +
        (st.balance > 0.005 && canAddHere() && canActOnBranch(r.branch_id)
          ? '<form id="sc-addpay-form" novalidate style="margin-top:10px;display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;"><div class="lw-edit-form">' +
              '<div class="sc-row2"><div class="field"><label>Method</label><select name="method">' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select></div>' +
              '<div class="field"><label>Amount (₱)</label><input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="' + st.balance.toFixed(2) + '"></div></div>' +
              '<div class="sc-row2"><div class="field"><label>Date sent / paid</label><input type="date" name="paidAt" value="' + today() + '" min="' + esc(r.entry_date) + '" max="' + today() + '"></div>' +
              '<div class="field"><label>Reference number</label><input type="text" name="reference"></div></div>' +
              '<div class="field"><label>Proof of payment</label><input type="file" name="proof" accept="image/*,.pdf"></div>' +
              '<div class="msg error" data-addpay-err hidden></div>' +
              '<button class="btn small" type="submit">Record payment</button></div></form>'
          : '') +
      '</div>';
    }

    h += '<div class="drawer-section"><h4>Actions</h4><div style="display:flex;flex-wrap:wrap;gap:6px;">' +
      (r.attachment_path ? '<button type="button" class="btn small secondary" data-act="view-photo" data-path="' + esc(r.attachment_path) + '">View photo</button>' : '') +
      (!r.attachment_path && canAddHere() ? '<button type="button" class="btn small secondary" data-act="attach-photo">Attach photo</button>' : '') +
      (canEdit(r) ? '<button type="button" class="btn small secondary" data-act="edit">Edit</button>' : '') +
      (canConvert(r) ? '<button type="button" class="btn small secondary" data-act="convert-toggle">Convert to Subasta</button>' : '') +
      (!r.converted_to_subasta_item_id && canActOnBranch(r.branch_id) && !pending
        ? (isAdmin ? '<button type="button" class="btn small danger" data-act="delete">Delete…</button>' : '<button type="button" class="btn small secondary" data-act="request-delete">Request Delete</button>') : '') +
      '</div>' +
      (canConvert(r)
        ? '<form id="sc-convert-form" style="display:none;flex-direction:column;gap:8px;margin-top:10px;" data-scrap-id="' + r.id + '">' +
            '<div class="field"><label>Item Description *</label><input type="text" name="itemDescription" required placeholder="What the item actually is"></div>' +
            '<div class="field"><label>Pawn Reference</label><input type="text" name="pawnReference"></div>' +
            '<div class="field"><label>Pawn Date</label><input type="date" name="pawnDate" value="' + esc(r.entry_date || '') + '"></div>' +
            '<div class="field"><label>Auction Eligible Date</label><input type="date" name="auctionEligibleDate"></div>' +
            '<div class="field"><label>Notes</label><input type="text" name="notes" value="Converted from Scrap entry, ' + grams(r.weight_grams) + '"></div>' +
            '<button class="btn small" type="submit">Convert</button>' +
          '</form>'
        : '') +
    '</div>';

    h += '<div class="drawer-section"><h4>History</h4><div id="sc-audit"><div class="muted">Loading…</div></div></div>';
    return h;
  }

  // Who did what, when (branch_audit_log): created, each payment, corrections with the old -> new values.
  async function loadAudit(r) {
    const box = $('sc-audit');
    if (!box) return;
    try {
      const rows = await listBranchAuditLog('scrap_entries', r.id);
      if (openId !== r.id || !$('sc-audit')) return;
      const ev = rows.map((l) => ({ at: l.changed_at, who: l.actor && l.actor.full_name, what: l.action, detail: l.details || '', old: l.old_value, nw: l.new_value }));
      if (!ev.some((e) => e.what === 'Entry created')) ev.push({ at: r.created_at, who: r.creator && r.creator.full_name, what: 'Entry created', detail: '' });
      ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      $('sc-audit').innerHTML = '<div class="lw-history">' + ev.map((e) => {
        const diff = e.old && e.nw ? Object.keys(e.old).map((k) => '<div style="font-size:11px;">' + esc(FIELD_LABELS[k] || k) + ': <s class="muted">' + esc(e.old[k] == null ? '—' : e.old[k]) + '</s> → <b>' + esc(e.nw[k] == null ? '—' : e.nw[k]) + '</b></div>').join('') : '';
        return '<div class="lw-hist-row"><div class="lw-hist-when muted">' + fmtDateTime(e.at) + '</div><div><b>' + esc(e.what) + '</b>' + (e.who ? ' <span class="muted">· ' + esc(e.who) + '</span>' : '') +
          (e.detail ? '<div class="muted" style="font-size:11px;">' + esc(e.detail) + '</div>' : '') + diff + '</div></div>';
      }).join('') + '</div>';
    } catch (err) {
      if ($('sc-audit')) $('sc-audit').innerHTML = '<p class="muted">The history could not be loaded.</p>';
    }
  }

  function pickFile(accept, onFile) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.style.display = 'none';
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  }

  function wireDetailBody(container, r) {
    const on = (sel, fn) => container.querySelectorAll(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
    const open = async (path) => { try { window.open(await getScrapAttachmentUrl(path), '_blank'); } catch (err) { notify(String(err.message || err), true); } };
    on('[data-act="view-photo"]', (el) => open(el.dataset.path));
    on('[data-act="view-proof"]', (el) => open(el.dataset.path));
    on('[data-act="attach-photo"]', () => pickFile('image/*', async (file) => {
      try { await uploadScrapAttachment(r.branch_id, r.id, file); notify('Photo attached.', false); await load(); } catch (err) { notify(String(err.message || err), true); }
    }));
    on('[data-act="attach-proof"]', (el) => pickFile('image/*,.pdf', async (file) => {
      try { await uploadScrapPaymentProof(r.branch_id, r.id, Number(el.dataset.id), file); notify('Proof attached.', false); await load(); } catch (err) { notify(String(err.message || err), true); }
    }));
    on('[data-act="withdraw-req"]', (el) => runAction(() => cancelBranchRecordAction(Number(el.dataset.id)), 'Request withdrawn.'));
    on('[data-act="edit"]', () => openEdit(r));

    // Correcting one payment line: new values + the reason and kind of mistake, all logged.
    on('[data-act="correct-payment"]', async (el) => {
      const p = (r.scrap_payments || []).find((x) => x.id === Number(el.dataset.id));
      if (!p) return;
      const out = await reasonDialog({
        title: 'Correct this payment', message: 'Change only what was wrong. The old and new values are recorded with your name and the reason.',
        label: 'Reason', confirmLabel: 'Save correction', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment',
        extraFieldsHtml:
          '<div class="field"><label for="dlg-pmethod">Method</label><select id="dlg-pmethod">' +
            PAYMENT_METHODS.concat(PAYMENT_METHODS.includes(p.payment_method) ? [] : [p.payment_method]).map((m) => '<option' + (m === p.payment_method ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select></div>' +
          '<div class="field"><label for="dlg-pamount">Amount (₱)</label><input type="number" id="dlg-pamount" step="0.01" min="0" inputmode="decimal" value="' + esc(p.amount) + '"></div>' +
          '<div class="field"><label for="dlg-pdate">Date sent / paid</label><input type="date" id="dlg-pdate" value="' + esc(String(p.paid_at || '').slice(0, 10)) + '" min="' + esc(r.entry_date) + '" max="' + today() + '"></div>' +
          '<div class="field"><label for="dlg-pref">Reference number</label><input type="text" id="dlg-pref" value="' + esc(p.reference_number || '') + '"></div>',
        readExtra: (form) => {
          const amount = Number(form.querySelector('#dlg-pamount').value);
          const paidAt = form.querySelector('#dlg-pdate').value;
          if (!(amount > 0)) return { error: 'The payment must be more than ₱0.' };
          if (!paidAt) return { error: 'Enter the date the payment was sent.' };
          if (paidAt > today()) return { error: 'The payment date cannot be in the future.' };
          if (paidAt < r.entry_date) return { error: 'The payment date cannot be before the purchase date.' };
          if (r._paid - Number(p.amount) + amount > Number(r.total_amount || 0) + 0.01) return { error: 'The payments would add up to more than the final amount (' + money(r.total_amount) + ').' };
          return { method: form.querySelector('#dlg-pmethod').value, amount: r2(amount), paidAt, reference: form.querySelector('#dlg-pref').value.trim() };
        },
      });
      if (!out) return;
      const x = out.extra, patch = {};
      if (x.method !== p.payment_method) patch.payment_method = x.method;
      if (x.amount !== Number(p.amount)) patch.amount = x.amount;
      if (x.paidAt !== String(p.paid_at || '').slice(0, 10)) patch.paid_at = x.paidAt;
      if (x.reference !== (p.reference_number || '')) patch.reference_number = x.reference || null;
      if (!Object.keys(patch).length) { notify('Nothing was changed.', true); return; }
      await runAction(async () => { await updateScrapPayment(p.id, patch, out.reason, out.errorType); }, 'Payment corrected.');
    });
    on('[data-act="request-remove-payment"]', async (el) => {
      const out = await reasonDialog({ title: 'Request removal of this payment line?', message: 'A supervisor and then Admin must approve it. Nothing is removed until then.', label: 'Reason',
        confirmLabel: 'Send request', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment', danger: true });
      if (!out) return;
      await runAction(() => requestBranchRecordAction('scrap_payments', Number(el.dataset.id), 'Delete', out.reason, out.errorType), 'Removal request sent.');
    });
    on('[data-act="remove-payment"]', async (el) => {
      const out = await reasonDialog({ title: 'Remove this payment line?', message: 'The purchase goes back to owing that amount. The reason and what was removed stay in the audit trail.', label: 'Reason',
        confirmLabel: 'Remove payment', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: 'Wrong Payment', danger: true });
      if (!out) return;
      await runAction(() => adminApplyBranchRecordAction('scrap_payments', Number(el.dataset.id), 'Delete', out.reason, out.errorType), 'Payment removed.');
    });

    on('[data-act="request-delete"]', async () => {
      const out = await reasonDialog({ title: 'Request deletion of this scrap entry?', message: 'A supervisor and then Admin must approve it. Nothing is removed until then.', label: 'Reason',
        confirmLabel: 'Send request', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', danger: true });
      if (!out) return;
      await runAction(() => requestBranchRecordAction('scrap_entries', r.id, 'Delete', out.reason, out.errorType), 'Delete request sent.');
    });
    on('[data-act="delete"]', async () => {
      const out = await reasonDialog({ title: 'Delete this scrap entry?', message: 'This removes the entry and its payment lines. The reason and what was removed stay in the audit trail.', label: 'Reason',
        confirmLabel: 'Delete entry', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', danger: true });
      if (!out) return;
      await runAction(async () => { await adminApplyBranchRecordAction('scrap_entries', r.id, 'Delete', out.reason, out.errorType); closeDetailDrawer(); }, 'Entry deleted.');
    });

    const payForm = container.querySelector('#sc-addpay-form');
    if (payForm) payForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = payForm.querySelector('[data-addpay-err]'); err.hidden = true;
      const amount = Number(payForm.elements.amount.value);
      const paidAt = payForm.elements.paidAt.value || today();
      const fail = (m, el) => { err.textContent = friendlyError(m); err.hidden = false; if (el) flagInvalid(el); };
      if (!(amount > 0)) return fail('Enter the amount (more than ₱0).', payForm.elements.amount);
      if (amount > r._st.balance + 0.01) return fail('That is more than the balance (' + money(r._st.balance) + ').', payForm.elements.amount);
      if (paidAt > today()) return fail('The payment date cannot be in the future.', payForm.elements.paidAt);
      if (paidAt < r.entry_date) return fail('The payment date cannot be before the purchase date.', payForm.elements.paidAt);
      const btn = payForm.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const id = await addScrapPayment(r.id, { method: payForm.elements.method.value, amount: r2(amount), reference: payForm.elements.reference.value.trim(), paidAt });
        const file = payForm.elements.proof.files[0];
        let warn = '';
        if (file) { try { await uploadScrapPaymentProof(r.branch_id, r.id, id, file); } catch (e2) { warn = ' The proof could not be uploaded (' + (e2.message || e2) + ') -- attach it again from the payment line.'; } }
        notify('Payment recorded.' + warn, !!warn);
        await load();
        openDetail(r.id); // re-draw even if the cursor was still in a box (a live refresh leaves a form being typed in alone)
      } catch (e3) { fail(String(e3.message || e3)); btn.disabled = false; }
    });

    const convertToggle = container.querySelector('[data-act="convert-toggle"]');
    const convertForm = container.querySelector('#sc-convert-form');
    if (convertToggle && convertForm) convertToggle.addEventListener('click', () => { convertForm.style.display = convertForm.style.display === 'none' ? 'flex' : 'none'; });
    if (convertForm) convertForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const newId = await convertScrapToSubasta({
          scrapEntryId: Number(f.dataset.scrapId), itemDescription: f.itemDescription.value.trim(),
          pawnReference: f.pawnReference.value.trim(), pawnDate: f.pawnDate.value,
          auctionEligibleDate: f.auctionEligibleDate.value, notes: f.notes.value.trim(),
        });
        notify('Converted to Subasta item #' + newId + '.', false);
        closeDetailDrawer();
        await load();
      } catch (err) { notify(String(err.message || err), true); }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Edit (a correction: reason + what went wrong are asked for and logged)
  // ---------------------------------------------------------------------------------------------
  function openEdit(r) {
    editingId = r.id;
    const body = $('sc-detail-body');
    const transfer = isTransferKind(r.kind);
    const v = (x) => (x == null ? '' : esc(x));
    body.innerHTML =
      '<form id="sc-edit-form" novalidate class="lw-edit-form" style="display:flex;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:8px;">' +
        '<p class="muted" style="margin:0;font-size:12px;">Correcting this entry is recorded with your name, the old and new values, and the reason.</p>' +
        '<div class="msg error" data-edit-err hidden></div>' +
        '<div class="drawer-section"><h4>Entry</h4>' +
          '<div class="sc-row2"><div class="field"><label>Date</label><input type="date" name="entryDate" value="' + v(r.entry_date) + '" max="' + today() + '"' + (r.transfer_group ? ' disabled' : '') + '></div>' +
          '<div class="field"><label>Time</label><input type="time" name="entryTime" value="' + v(String(r.purchase_time || '').slice(0, 5)) + '"></div></div>' +
          (transfer ? '' : '<div class="field"><label>Type</label><select name="kind"><option' + (r.kind === 'Bought from Customer' ? ' selected' : '') + '>Bought from Customer</option><option' + (r.kind === 'Refiner / Other' ? ' selected' : '') + '>Refiner / Other</option></select></div>') +
        '</div>' +
        '<div class="drawer-section"><h4>Metal &amp; weight</h4>' +
          '<div class="sc-row2"><div class="field"><label>Metal</label><select name="metal"' + (r.transfer_group ? ' disabled' : '') + '>' + ['Gold', 'Silver', 'Other'].map((m) => '<option' + (m === r.metal_type ? ' selected' : '') + '>' + m + '</option>').join('') + '</select></div>' +
          '<div class="field"><label>Purity</label><select name="purity"' + (r.transfer_group ? ' disabled' : '') + '></select></div></div>' +
          '<div class="field" data-purity-other hidden><label>Custom purity</label><input type="text" name="purityOther"></div>' +
          '<div class="field"><label>Weight (grams)</label><input type="number" name="weight" step="0.001" min="0" value="' + v(r.weight_grams) + '"' + (r.transfer_group ? ' disabled' : '') + '></div>' +
        '</div>' +
        (transfer ? '' :
        '<div class="drawer-section"><h4>Price</h4>' +
          '<div class="sc-row2"><div class="field"><label>Price per gram (₱)</label><input type="number" name="ppg" step="0.01" min="0" value="' + v(r.price_per_gram) + '"></div>' +
          '<div class="field"><label>Gross amount (₱)</label><input type="number" name="gross" step="0.01" min="0" value="' + v(r.gross_amount) + '"></div></div>' +
          '<div class="field"><label>Adjustment (₱) — minus for a deduction</label><input type="number" name="adjustment" step="0.01" value="' + (Number(r.adjustment_amount) ? v(r.adjustment_amount) : '') + '"></div>' +
          '<div class="field" data-adj-reason hidden><label>Reason for the adjustment *</label><input type="text" name="adjReason" value="' + v(r.adjustment_reason) + '"></div>' +
          '<div class="field"><label>Final amount (₱)</label><input type="number" name="final" readonly tabindex="-1" value="' + v(r.total_amount) + '"></div>' +
          '<p class="muted" style="font-size:11px;margin:0;">Already paid: ' + money(r._paid) + ' — the final amount cannot go below it.</p>' +
        '</div>' +
        '<div class="drawer-section"><h4>' + (r.kind === 'Refiner / Other' ? 'Refiner / buyer' : 'Customer') + '</h4>' +
          '<div class="field"><label>Name</label><input type="text" name="customer" autocomplete="off" value="' + v(r.customer_name) + '"></div>' +
          '<div class="field"><label>Contact number</label><input type="text" name="contact" autocomplete="off" value="' + v(r.contact_number) + '"></div>' +
          '<div class="field"><label>Address</label><input type="text" name="address" autocomplete="off" value="' + v(r.customer_address) + '"></div>' +
          '<div class="sc-row2"><div class="field"><label>Source</label><select name="sourceType"><option value="">— none —</option>' + SOURCE_TYPES.map((s) => '<option' + (s === r.source_type ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>' +
          '<div class="field"><label>Source note</label><input type="text" name="source" value="' + v(r.source) + '"></div></div>' +
        '</div>') +
        '<div class="drawer-section"><h4>Notes</h4><div class="field"><label>Notes</label><input type="text" name="notes" value="' + v(r.notes) + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><button class="btn" type="submit">Save correction</button><button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button></div>' +
      '</form>';
    const ef = $('sc-edit-form');
    const known = [...GOLD_PURITIES, ...SILVER_PURITIES];
    setPurity(ef, r.metal_type, r.karat || '');
    if (r.karat && !known.includes(r.karat)) fe(ef, 'purityOther').value = r.karat;
    ef.querySelector('[data-purity-other]').hidden = fe(ef, 'purity').value !== 'Custom';
    wirePurity(ef);
    if (!transfer) {
      const w0 = Number(r.weight_grams) || 0, p0 = Number(r.price_per_gram) || 0;
      fe(ef, 'gross').readOnly = w0 > 0 && p0 > 0;
      ef.querySelector('[data-adj-reason]').hidden = !Number(r.adjustment_amount);
      wireAmounts(ef);
      attachCustomerPicker({ nameInput: fe(ef, 'customer'), contactInput: fe(ef, 'contact'), addressInput: fe(ef, 'address') });
    }
    ef.querySelector('[data-act="cancel-edit"]').addEventListener('click', () => { editingId = null; openDetail(r.id); });

    ef.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = ef.querySelector('[data-edit-err]'); err.hidden = true;
      const fail = (m, el) => { err.textContent = friendlyError(m); err.hidden = false; err.scrollIntoView({ block: 'nearest' }); if (el) flagInvalid(el); };
      const patch = {};
      const str = (n) => fe(ef, n).value.trim();
      const setStr = (key, name, old) => { if (str(name) !== String(old || '')) patch[key] = str(name) || null; };
      const num = (n) => (fe(ef, n).value === '' ? null : Number(fe(ef, n).value));
      const setNum = (key, nv, old) => { if ((nv == null ? null : nv) !== (old == null ? null : Number(old))) patch[key] = nv; };

      if (!r.transfer_group && fe(ef, 'entryDate').value && fe(ef, 'entryDate').value !== r.entry_date) patch.entry_date = fe(ef, 'entryDate').value;
      const t = fe(ef, 'entryTime').value;
      if (t && t !== String(r.purchase_time || '').slice(0, 5)) patch.purchase_time = t;
      if (!transfer && fe(ef, 'kind').value !== r.kind) patch.kind = fe(ef, 'kind').value;
      if (!r.transfer_group) {
        if (fe(ef, 'metal').value !== r.metal_type) patch.metal_type = fe(ef, 'metal').value;
        const purity = readPurity(ef);
        if (!purity) return fail('Choose the purity.', fe(ef, 'purity'));
        if (purity !== (r.karat || '')) patch.karat = purity;
        const w = Number(fe(ef, 'weight').value);
        if (!(w > 0)) return fail('Weight must be more than 0 grams.', fe(ef, 'weight'));
        setNum('weight_grams', w, r.weight_grams);
      }
      if (!transfer) {
        const a = calcAmounts(ef);
        if (a.final <= 0) return fail('Enter the amount.', fe(ef, 'gross'));
        if (a.final < r._paid - 0.01) return fail('The final amount cannot be less than what is already paid (' + money(r._paid) + ').', fe(ef, 'adjustment'));
        if (a.adj && !str('adjReason')) return fail('Give a reason for the price adjustment.', fe(ef, 'adjReason'));
        setNum('price_per_gram', num('ppg'), r.price_per_gram);
        setNum('gross_amount', a.gross, r.gross_amount);
        setNum('adjustment_amount', a.adj, r.adjustment_amount);
        setNum('total_amount', a.final, r.total_amount);
        if ((a.adj ? str('adjReason') : '') !== String(r.adjustment_reason || '')) patch.adjustment_reason = a.adj ? str('adjReason') : null;
        setStr('customer_name', 'customer', r.customer_name);
        setStr('contact_number', 'contact', r.contact_number);
        setStr('customer_address', 'address', r.customer_address);
        if ((fe(ef, 'sourceType').value || '') !== String(r.source_type || '')) patch.source_type = fe(ef, 'sourceType').value || null;
        setStr('source', 'source', r.source);
      }
      setStr('notes', 'notes', r.notes);
      const keys = Object.keys(patch);
      if (!keys.length) return fail('Nothing was changed.');
      const guess = patch.karat ? 'Wrong Purity' : patch.weight_grams ? 'Wrong Weight' : (patch.total_amount != null || patch.price_per_gram !== undefined || patch.gross_amount != null || patch.adjustment_amount != null) ? 'Wrong Amount'
        : patch.entry_date ? 'Wrong Date' : (patch.customer_name !== undefined || patch.contact_number !== undefined) ? 'Wrong Customer' : 'Other';
      const out = await reasonDialog({ title: 'Save this correction?', message: 'Changing: ' + keys.map((k) => FIELD_LABELS[k] || k).join(', ') + '.\nIt is recorded with your name, the old and new values and the reason.',
        label: 'Reason', confirmLabel: 'Save correction', errorTypes: ERROR_TYPES, errorLabel: 'What went wrong?', initialErrorType: guess });
      if (!out) return;
      const btn = ef.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        await updateScrapEntry(r.id, patch, out.reason, out.errorType);
        notify('Correction saved.', false);
        editingId = null;
        await load();
        openDetail(r.id);
      } catch (e2) { fail(String(e2.message || e2)); btn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Filters, range, views
  // ---------------------------------------------------------------------------------------------
  const resetPaging = () => { pg.page = 1; payPg.page = 1; };
  ['sc-f-search'].forEach((id) => $(id).addEventListener('input', () => { resetPaging(); render(); }));
  ['sc-f-metal', 'sc-f-kind', 'sc-f-pay'].forEach((id) => $(id).addEventListener('change', () => { resetPaging(); render(); }));
  // The global date range changes these two (hidden) inputs: the lists re-filter and the server figures are fetched again.
  ['sc-f-from', 'sc-f-to'].forEach((id) => $(id).addEventListener('change', () => { resetPaging(); render(); loadReports(); }));
  $('sc-f-clear').addEventListener('click', () => {
    $('sc-f-search').value = ''; $('sc-f-metal').value = 'all'; $('sc-f-kind').value = 'all'; $('sc-f-pay').value = 'all';
    resetPaging(); render(); // the date range is the page's global range -- not cleared here
  });
  wireSortControl('sc-sort-field', 'sc-sort-dir', sort, () => { resetPaging(); render(); });

  /** A summary card / Needs Attention item opens a particular view: 'unpaid' = the Scrap Payments view filtered to what is still owing. */
  function applyView(v) {
    if (v === 'unpaid') {
      $('sc-f-pay').value = 'owing'; $('sc-f-search').value = ''; $('sc-f-metal').value = 'all'; $('sc-f-kind').value = 'all';
      resetPaging(); setView('payments'); render();
      $('sc-pay-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (v === 'requests') {
      const f = $('sc-requests-folder'); f.open = true; f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      $('sc-view-seg').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const unsubscribe = subscribeToChanges(['scrap_entries', 'scrap_payments', 'branch_record_requests', 'branch_capital_entries'], load);
  setView('entries');
  await load();

  // openDetail is exposed so a clicked activity notification (activityFeed.js, spec 321) can open this entry's own
  // Detail Drawer in place.
  return { reload: load, unsubscribe, openDetail, applyView };
}
