// Layaway tab (Branches page) -- a branch-scoped port of the standalone layaway.html
// page's exact "Hold Item(s)" / On Hold list / Monthly Monitoring / Forfeiture Watch
// feature set, reusing its multi-item-hold, proportional-payment-split, and
// rollback-on-partial-failure logic verbatim. The one real difference: there's no
// Branch field on the Hold form and no Branch column in the tables here -- the whole
// tab is already scoped to whichever branch is selected on the Branches page
// (getBranchId()), so every row it ever shows is that one branch by construction.
import {
  listLayaways, createLayawayHold, addLayawayPayment, completeLayaway, cancelLayaway, deleteLayawayPayment,
  searchProducts, listActiveEmployees, subscribeToChanges,
} from './api.js';

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const STATUS_BADGE = { 'On Hold': 'pending', 'Completed': 'ok', 'Cancelled': 'low' };
const PAYMENT_METHODS = ['Cash', 'GCash', 'Bank Transfer', 'Other'];
// A layaway with no activity forfeits 2 months (~60 days) after Date Purchased
// (hold_date) -- WARN_DAYS gives a 2-week heads-up before that so staff can chase
// payment before it's actually too late, not just after.
const FORFEITURE_DAYS = 60;
const FORFEITURE_WARN_DAYS = 45;
function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((new Date() - new Date(dateStr + 'T00:00:00')) / 86400000);
}
// Same branch-scope rule as assert_can_act_on_branch()/record_sale() -- whole staff
// can hold/pay/complete/cancel a layaway for their own branch; this group can do it
// for any branch.
const UNSCOPED_POSITIONS = ['Sales Executive', 'Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];
const POSITION_MANAGERS = ['Operations Supervisor', 'Inventory Supervisor', 'Admin Assistant'];

// 3 fixed slots (same pattern as this page's own Scrap/Subasta forms) instead of a
// dynamic add/remove list -- a layaway downpayment is rarely split more than 2 ways.
// Slots left blank/zero are just skipped on submit.
function paymentSlotsHtml() {
  let html = '';
  for (let i = 0; i < 3; i++) {
    const label = i === 0 ? 'Downpayment' : 'Downpayment ' + (i + 1);
    html +=
      '<div class="field"><label>' + label + ' Mode of Payment' + (i === 0 ? '' : ' (optional)') + '</label><select name="lwPayMethod' + i + '">' +
        '<option value="">— none —</option>' +
        PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>' + label + ' Amount</label><input type="number" name="lwPayAmount' + i + '" step="0.01" min="0"></div>' +
      '<div class="field"><label>' + label + ' Reference Number</label><input type="text" name="lwPayReference' + i + '"></div>';
  }
  return html;
}
function readPaymentSlots(f) {
  const payments = [];
  for (let i = 0; i < 3; i++) {
    const method = f['lwPayMethod' + i]?.value;
    const amount = Number(f['lwPayAmount' + i]?.value || 0);
    if (method && amount > 0) payments.push({ method, amount, reference: f['lwPayReference' + i]?.value.trim() || '' });
  }
  return payments;
}

/** Mounts the Layaway tab into `root` (an empty container this owns entirely),
 * scoped to `getBranchId()` at call time -- read as a function rather than a fixed
 * value so switching branches elsewhere on the page just needs a reload() call, not
 * a re-mount. `esc`/`toast` are the page's own shell.js helpers; `msgId` is the id of
 * the page's toast container; `employee` is the signed-in employee record.
 * Returns { reload } for the host page to call after a branch switch. Async because
 * the Hold form needs the active-staff list (for "Handled By") before it can render. */
export async function initLayawayTab({ root, esc, toast, msgId, getBranchId, employee, onCountUpdate }) {
  const isScoped = ['Admin', 'Manager'].includes(employee.role) ? false : !UNSCOPED_POSITIONS.includes(employee.position);
  const canManage = ['Admin', 'Manager'].includes(employee.role) || POSITION_MANAGERS.includes(employee.position);
  const staff = await listActiveEmployees();

  function notify(text, isError) {
    toast(msgId, text, isError);
    document.getElementById(msgId).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  root.innerHTML =
    '<div class="layout-2col">' +
      '<div class="layout-2col-side">' +
        '<div class="card">' +
          '<h3>Hold Item(s)</h3>' +
          '<p class="muted" style="margin-top:-4px;">Each item leaves the sellable pool immediately (moves to Reserved) but stays on hand until either completed as a sale or cancelled. Add more than one item to hold a whole order for one customer at once.</p>' +
          '<form id="lw-form" style="flex-direction:column;align-items:stretch;flex-wrap:nowrap;">' +
            '<label style="font-size:13px;font-weight:600;">Items *</label>' +
            '<div id="lw-items"></div>' +
            '<button type="button" class="btn small secondary" id="lw-add-item" style="align-self:flex-start;margin:-4px 0 10px;">+ Add another item</button>' +
            '<div class="field"><label>Order ID</label><input type="text" name="orderId"></div>' +
            '<div class="field"><label>Customer Name *</label><input type="text" name="customerName" required></div>' +
            '<div class="field"><label>Contact Number</label><input type="text" name="contactNumber"></div>' +
            '<div class="field"><label>Admin (Handled By)</label><select name="handledBy"><option value="">— none —</option>' +
              staff.map((s) => '<option value="' + s.id + '"' + (s.id === employee.id ? ' selected' : '') + '>' + esc(s.full_name) + '</option>').join('') +
            '</select></div>' +
            paymentSlotsHtml() +
            '<div class="field"><label>Notes</label><input type="text" name="notes"></div>' +
            '<button class="btn" type="submit">Hold Item(s)</button>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '<div class="layout-2col-main">' +
        '<div class="tiles" id="lw-tiles"></div>' +
        '<div class="card">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
            '<div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="lw-f-search" placeholder="SKU, customer, order ID, contact…"></div>' +
            '<div class="field"><label>Status</label><select id="lw-f-status"><option value="all">All Statuses</option><option>On Hold</option><option>Completed</option><option>Cancelled</option></select></div>' +
            '<button type="button" class="btn small secondary" id="lw-f-clear">Clear Filters</button>' +
          '</div>' +
        '</div>' +
        '<div id="lw-list"><div class="muted">Loading…</div></div>' +

        '<h2 style="margin-top:30px;">Monthly Monitoring</h2>' +
        '<div class="card">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
            '<div class="field"><label>From</label><input type="date" id="mm-from"></div>' +
            '<div class="field"><label>To</label><input type="date" id="mm-to"></div>' +
            '<button type="button" class="btn small secondary" id="mm-clear">All Time</button>' +
          '</div>' +
        '</div>' +
        '<div class="tiles" id="mm-tiles"></div>' +
        '<div id="mm-table"></div>' +

        '<h3 style="margin-top:22px;">Forfeiture Watch <span class="muted" style="font-weight:normal;">— On Hold items, oldest first (not affected by the date range above)</span></h3>' +
        '<p class="muted" style="margin-top:-4px;">Unpaid holds are forfeited 2 months after Date Purchased. Rows turn red once an item is close to or past that.</p>' +
        '<div id="fw-table"></div>' +
      '</div>' +
    '</div>';

  // ---- Item rows: one or more SKU/Qty/Price lines under the same order, each with
  // its own autocomplete instance (same pattern as movement.html/branches.html's POS
  // cart). ----
  function itemRowHtml() {
    return '<div class="lw-item-row" style="border:1px solid #e5e5e5;border-radius:8px;padding:8px;margin-bottom:6px;">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="flex:2;min-width:150px;position:relative;">' +
          '<label>SKU *</label>' +
          '<input type="text" class="lw-item-sku" autocomplete="off" placeholder="Type a SKU or item name…">' +
          '<div class="lw-item-sku-name muted" style="font-size:11px;"></div>' +
          '<div class="lw-item-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:20;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;"></div>' +
        '</div>' +
        '<div class="field" style="width:70px;"><label>Qty</label><input type="number" class="lw-item-qty" min="1" value="1"></div>' +
        '<div class="field" style="width:110px;"><label>Unit Price</label><input type="number" class="lw-item-price" step="0.01" min="0" placeholder="PHP"></div>' +
        '<button type="button" class="btn small secondary lw-item-remove" title="Remove this item">✕</button>' +
      '</div>' +
    '</div>';
  }
  function attachSkuAutocomplete(row) {
    const skuInput = row.querySelector('.lw-item-sku');
    const skuSuggest = row.querySelector('.lw-item-sku-suggest');
    const skuNamePreview = row.querySelector('.lw-item-sku-name');
    let searchToken = 0, searchTimer = null;
    function hide() { skuSuggest.style.display = 'none'; skuSuggest.innerHTML = ''; }
    function pick(p) {
      skuInput.value = p.sku;
      skuNamePreview.textContent = p.item_name + (p.category || p.product_line ? ' · ' + (p.category || p.product_line) : '');
      hide();
    }
    function renderSuggestions(matches) {
      if (!matches.length) { hide(); return; }
      skuSuggest.innerHTML = matches.map((p) =>
        '<div data-sku="' + esc(p.sku) + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px;">' +
          '<strong>' + esc(p.sku) + '</strong> — ' + esc(p.item_name) +
          (p.category || p.product_line ? '<div class="muted" style="font-size:11px;">' + esc(p.category || p.product_line) + '</div>' : '') +
        '</div>'
      ).join('');
      skuSuggest.style.display = '';
      skuSuggest.querySelectorAll('[data-sku]').forEach((el, i) => {
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(matches[i]); });
      });
    }
    skuInput.addEventListener('input', () => {
      skuNamePreview.textContent = '';
      const q = skuInput.value.trim();
      clearTimeout(searchTimer);
      if (!q) { hide(); return; }
      searchTimer = setTimeout(async () => {
        const token = ++searchToken;
        try {
          const results = await searchProducts(q);
          if (token !== searchToken) return;
          renderSuggestions(results);
          const exact = results.find((p) => p.sku.toLowerCase() === q.toLowerCase());
          if (exact) skuNamePreview.textContent = exact.item_name + (exact.category || exact.product_line ? ' · ' + (exact.category || exact.product_line) : '');
        } catch (err) { /* a failed lookup shouldn't block typing a SKU by hand */ }
      }, 200);
    });
    skuInput.addEventListener('blur', () => setTimeout(hide, 150));
    skuInput.addEventListener('focus', () => { if (skuSuggest.innerHTML) skuSuggest.style.display = ''; });
  }
  const itemsContainer = document.getElementById('lw-items');
  function updateItemRemoveButtons() {
    const rows = itemsContainer.querySelectorAll('.lw-item-row');
    rows.forEach((row) => { row.querySelector('.lw-item-remove').style.display = rows.length > 1 ? '' : 'none'; });
  }
  function addItemRow() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = itemRowHtml();
    const row = wrapper.firstElementChild;
    itemsContainer.appendChild(row);
    attachSkuAutocomplete(row);
    row.querySelector('.lw-item-remove').addEventListener('click', () => {
      if (itemsContainer.querySelectorAll('.lw-item-row').length <= 1) return;
      row.remove();
      updateItemRemoveButtons();
    });
    updateItemRemoveButtons();
  }
  function resetItemRows() { itemsContainer.innerHTML = ''; addItemRow(); }
  addItemRow();
  document.getElementById('lw-add-item').addEventListener('click', addItemRow);

  function readItemRows() {
    const items = [];
    itemsContainer.querySelectorAll('.lw-item-row').forEach((row) => {
      const sku = row.querySelector('.lw-item-sku').value.trim();
      if (!sku) return;
      const qty = Number(row.querySelector('.lw-item-qty').value || 0);
      const priceVal = row.querySelector('.lw-item-price').value;
      items.push({ sku, qty, unitPrice: priceVal ? Number(priceVal) : null });
    });
    return items;
  }

  document.getElementById('lw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const branchId = getBranchId();
    const btn = f.querySelector('button[type=submit]');
    const items = readItemRows();
    if (!items.length) { notify('Add at least one item (SKU) to hold.', true); return; }
    const badQty = items.find((it) => !it.qty || it.qty <= 0);
    if (badQty) { notify('Qty must be a positive number for ' + badQty.sku + '.', true); return; }

    btn.disabled = true;
    // Multiple items are separate reservations under the hood (one layaway_holds row
    // each), tied together by a shared group_id so they display and act as one order.
    const groupId = items.length > 1 ? crypto.randomUUID() : null;
    const created = [];
    try {
      for (const it of items) {
        const holdId = await createLayawayHold({
          sku: it.sku, branchId, qty: it.qty,
          customerName: f.customerName.value.trim(), contactNumber: f.contactNumber.value.trim(),
          unitPrice: it.unitPrice, notes: f.notes.value.trim(),
          orderId: f.orderId.value.trim(), handledBy: f.handledBy.value || null, groupId,
        });
        created.push({ holdId, totalPrice: it.unitPrice != null ? it.unitPrice * it.qty : null });
      }
    } catch (err) {
      // A later item failing (e.g. out of stock) shouldn't leave earlier items in this
      // same submission silently held with nothing to show for it -- undo them too.
      for (const h of created) { try { await cancelLayaway(h.holdId, 'Rolled back: a later item in the same submission failed'); } catch (e) {} }
      notify(String(err.message || err), true);
      btn.disabled = false;
      return;
    }

    const payments = readPaymentSlots(f);
    try {
      const grandTotal = created.reduce((s, h) => s + (h.totalPrice || 0), 0);
      const canProportion = created.length > 1 && grandTotal > 0 && created.every((h) => h.totalPrice != null);
      for (const p of payments) {
        if (!canProportion) {
          await addLayawayPayment(created[0].holdId, p.amount, p.method, p.reference);
          continue;
        }
        // Split one shared downpayment across each item's own hold, proportional to
        // its share of the order total; the last item absorbs any rounding remainder
        // so the recorded payments always add back up to exactly what was entered.
        let allocated = 0;
        for (let i = 0; i < created.length; i++) {
          const h = created[i];
          const isLast = i === created.length - 1;
          const share = isLast ? Math.round((p.amount - allocated) * 100) / 100 : Math.round((p.amount * h.totalPrice / grandTotal) * 100) / 100;
          if (!isLast) allocated += share;
          if (share > 0) await addLayawayPayment(h.holdId, share, p.method, p.reference);
        }
      }
    } catch (err) {
      notify(items.length + ' item(s) held, but recording payment failed: ' + (err.message || err) + '. Add it manually below.', true);
      f.reset();
      resetItemRows();
      btn.disabled = false;
      await load();
      return;
    }

    notify(items.length + ' item(s) held' + (payments.length ? ' with ' + payments.length + ' payment(s) recorded.' : '.'), false);
    f.reset();
    resetItemRows();
    btn.disabled = false;
    await load();
  });

  let allHolds = [];
  let groupMembers = {};

  document.getElementById('lw-f-search').addEventListener('input', render);
  document.getElementById('lw-f-status').addEventListener('change', render);
  document.getElementById('lw-f-clear').addEventListener('click', () => {
    document.getElementById('lw-f-search').value = '';
    document.getElementById('lw-f-status').value = 'all';
    render();
  });
  document.getElementById('mm-from').addEventListener('change', renderMonthly);
  document.getElementById('mm-to').addEventListener('change', renderMonthly);
  document.getElementById('mm-clear').addEventListener('click', () => {
    document.getElementById('mm-from').value = '';
    document.getElementById('mm-to').value = '';
    renderMonthly();
  });

  async function load() {
    const list = document.getElementById('lw-list');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      allHolds = await listLayaways(getBranchId());
      groupMembers = {};
      allHolds.forEach((h) => { if (h.group_id) (groupMembers[h.group_id] = groupMembers[h.group_id] || []).push(h); });
      Object.values(groupMembers).forEach((g) => g.sort((a, b) => a.id - b.id));
      if (onCountUpdate) onCountUpdate(allHolds.filter((h) => h.status === 'On Hold').length);
      render();
      renderMonthly();
      renderForfeitureWatch();
    } catch (err) {
      list.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
    }
  }

  function paidSoFar(h) { return (h.layaway_payments || []).reduce((s, p) => s + Number(p.amount), 0); }

  function render() {
    const fSearch = document.getElementById('lw-f-search').value.trim().toLowerCase();
    const fStatus = document.getElementById('lw-f-status').value;
    let rows = allHolds;
    if (fSearch) rows = rows.filter((h) =>
      h.sku.toLowerCase().includes(fSearch) || h.customer_name.toLowerCase().includes(fSearch) ||
      (h.contact_number || '').toLowerCase().includes(fSearch) || (h.order_id || '').toLowerCase().includes(fSearch));
    if (fStatus !== 'all') rows = rows.filter((h) => h.status === fStatus);

    const onHold = rows.filter((h) => h.status === 'On Hold');
    const totalHeld = onHold.reduce((s, h) => s + Number(h.total_price || 0), 0);
    const totalPaid = onHold.reduce((s, h) => s + paidSoFar(h), 0);
    document.getElementById('lw-tiles').innerHTML =
      tile(onHold.length, 'On Hold') +
      tile(rows.filter((h) => h.status === 'Completed').length, 'Completed') +
      tile(money(totalHeld), 'Value On Hold') +
      tile(money(totalPaid), 'Paid So Far');

    const list = document.getElementById('lw-list');
    if (!rows.length) { list.innerHTML = '<p class="muted">No layaway holds for this filter.</p>'; return; }

    list.innerHTML = '<div class="table-scroll"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<colgroup><col style="width:13%"><col style="width:9%"><col style="width:7%"><col style="width:12%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:23%"></colgroup>' +
      '<thead><tr><th>SKU</th><th>Order ID</th><th>Qty</th><th>Customer</th><th>Amount</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((h) => {
        const paid = paidSoFar(h);
        const remaining = h.total_price == null ? null : Number(h.total_price) - paid;
        const canAct = canManage || employee.branch_id === h.branch_id || UNSCOPED_POSITIONS.includes(employee.position);
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        const groupOnHold = group ? group.filter((x) => x.status === 'On Hold') : [];
        return '<tr>' +
          '<td data-label="SKU">' + esc(h.sku) + '</td>' +
          '<td data-label="Order ID">' + esc(h.order_id || '—') +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
          '</td>' +
          '<td data-label="Qty">' + h.qty + '</td>' +
          '<td data-label="Customer">' + esc(h.customer_name) + (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') +
            (h.handler ? '<div class="muted" style="font-size:10px;">Handled by ' + esc(h.handler.full_name) + '</div>' : '') + '</td>' +
          '<td data-label="Amount">' + money(h.unit_price) + '</td>' +
          '<td data-label="Total">' + money(h.total_price) + '</td>' +
          '<td data-label="Paid">' + money(paid) + (remaining !== null ? '<div class="muted" style="font-size:10px;">' + money(remaining) + ' left</div>' : '') + '</td>' +
          '<td data-label="Status"><span class="badge ' + (STATUS_BADGE[h.status] || 'pending') + '">' + esc(h.status) + '</span></td>' +
          '<td data-label="" style="font-size:11px;">' +
            (h.layaway_payments && h.layaway_payments.length
              ? h.layaway_payments.map((p) => '<div>' + money(p.amount) + ' · ' + esc(p.payment_method) + (p.reference_number ? ' (' + esc(p.reference_number) + ')' : '') +
                  (canManage ? ' <button class="btn small secondary" data-act="del-payment" data-id="' + p.id + '" style="padding:1px 6px;">✕</button>' : '') + '</div>').join('')
              : '') +
            (groupIdx === 0 && groupOnHold.length > 1 && canAct
              ? '<div style="margin-bottom:4px;display:flex;gap:4px;">' +
                  '<button class="btn small secondary" data-act="complete-group" data-group="' + esc(h.group_id) + '">Complete All (' + groupOnHold.length + ')</button>' +
                  '<button class="btn small secondary" data-act="cancel-group" data-group="' + esc(h.group_id) + '">Cancel All (' + groupOnHold.length + ')</button>' +
                '</div>'
              : '') +
            (h.status === 'On Hold' && canAct
              ? '<form class="lw-pay-form" data-hold-id="' + h.id + '" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">' +
                  '<input type="number" name="amount" step="0.01" min="0.01" placeholder="Amount" required style="width:70px;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">' +
                  '<select name="method" style="padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">' + PAYMENT_METHODS.map((m) => '<option>' + m + '</option>').join('') + '</select>' +
                  '<input type="text" name="reference" placeholder="Reference" style="width:70px;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">' +
                  '<button class="btn small" type="submit">Add Payment</button>' +
                '</form>' +
                '<div style="margin-top:4px;display:flex;gap:4px;">' +
                  '<button class="btn small secondary" data-act="complete" data-id="' + h.id + '">Complete</button>' +
                  '<button class="btn small secondary" data-act="cancel" data-id="' + h.id + '">Cancel</button>' +
                '</div>'
              : '') +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    list.querySelectorAll('.lw-pay-form').forEach((form) => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await addLayawayPayment(Number(f.dataset.holdId), Number(f.amount.value), f.method.value, f.reference.value.trim());
        notify('Payment added.', false);
        await load();
      } catch (err) {
        notify(String(err.message || err), true);
      }
    }));

    list.querySelectorAll('[data-act="complete"]').forEach((btn) => btn.addEventListener('click', async () => {
      const hold = allHolds.find((h) => h.id === Number(btn.dataset.id));
      const paid = hold ? paidSoFar(hold) : 0;
      if (hold && hold.total_price != null && paid < Number(hold.total_price)) {
        if (!confirm('Not fully paid yet (' + money(paid) + ' of ' + money(hold.total_price) + '). Complete anyway?')) return;
      } else if (!confirm('Mark this layaway as completed and sold?')) return;
      try { await completeLayaway(Number(btn.dataset.id)); notify('Layaway completed.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    }));

    list.querySelectorAll('[data-act="cancel"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Cancel this layaway? The item goes back to Available stock.')) return;
      try { await cancelLayaway(Number(btn.dataset.id)); notify('Layaway cancelled.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    }));

    list.querySelectorAll('[data-act="complete-group"]').forEach((btn) => btn.addEventListener('click', async () => {
      const members = (groupMembers[btn.dataset.group] || []).filter((h) => h.status === 'On Hold');
      if (!confirm('Mark all ' + members.length + ' items in this order as completed and sold?')) return;
      try {
        for (const h of members) await completeLayaway(h.id);
        notify(members.length + ' item(s) completed.', false);
      } catch (err) {
        notify(String(err.message || err), true);
      } finally {
        await load();
      }
    }));

    list.querySelectorAll('[data-act="cancel-group"]').forEach((btn) => btn.addEventListener('click', async () => {
      const members = (groupMembers[btn.dataset.group] || []).filter((h) => h.status === 'On Hold');
      if (!confirm('Cancel all ' + members.length + ' items in this order? They all go back to Available stock.')) return;
      try {
        for (const h of members) await cancelLayaway(h.id);
        notify(members.length + ' item(s) cancelled.', false);
      } catch (err) {
        notify(String(err.message || err), true);
      } finally {
        await load();
      }
    }));

    list.querySelectorAll('[data-act="del-payment"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Delete this payment entry?')) return;
      try { await deleteLayawayPayment(Number(btn.dataset.id)); notify('Payment removed.', false); await load(); }
      catch (err) { notify(String(err.message || err), true); }
    }));
  }

  // ---- Monthly Monitoring: a wide, per-month rollup with a date-range-filtered
  // summary above it -- separate from the live filtered list above, which is about
  // finding one hold, not seeing the shape of the whole month/year. ----
  function renderMonthly() {
    const fFrom = document.getElementById('mm-from').value;
    const fTo = document.getElementById('mm-to').value;
    let rows = allHolds;
    if (fFrom) rows = rows.filter((h) => h.hold_date >= fFrom);
    if (fTo) rows = rows.filter((h) => h.hold_date <= fTo);

    const totalValue = rows.reduce((s, h) => s + Number(h.total_price || 0), 0);
    const totalPaid = rows.reduce((s, h) => s + paidSoFar(h), 0);
    document.getElementById('mm-tiles').innerHTML =
      tile(rows.length, 'Total Layaway Hold') +
      tile(money(totalValue), 'Total Value') +
      tile(money(totalPaid), 'Total Paid') +
      tile(money(totalValue - totalPaid), 'Total Remaining');

    const byMonth = {};
    rows.forEach((h) => {
      const key = (h.hold_date || '').slice(0, 7); // "YYYY-MM"
      if (!key) return;
      const m = byMonth[key] || (byMonth[key] = { onHold: 0, completed: 0, cancelled: 0, count: 0, value: 0, paid: 0 });
      m.count++;
      m.value += Number(h.total_price || 0);
      m.paid += paidSoFar(h);
      if (h.status === 'On Hold') m.onHold++;
      else if (h.status === 'Completed') m.completed++;
      else if (h.status === 'Cancelled') m.cancelled++;
    });
    const months = Object.keys(byMonth).sort().reverse();
    const box = document.getElementById('mm-table');
    if (!months.length) { box.innerHTML = '<p class="muted">No layaway holds for this range.</p>'; return; }
    box.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Month</th><th>Total Holds</th><th>On Hold</th><th>Completed</th><th>Cancelled</th><th>Total Value</th><th>Total Paid</th><th>Remaining</th></tr></thead><tbody>' +
      months.map((key) => {
        const m = byMonth[key];
        const label = new Date(key + '-02').toLocaleDateString('en-PH', { year: 'numeric', month: 'long' });
        return '<tr>' +
          '<td data-label="Month"><b>' + label + '</b></td>' +
          '<td data-label="Total Holds">' + m.count + '</td>' +
          '<td data-label="On Hold">' + m.onHold + '</td>' +
          '<td data-label="Completed">' + m.completed + '</td>' +
          '<td data-label="Cancelled">' + m.cancelled + '</td>' +
          '<td data-label="Total Value">' + money(m.value) + '</td>' +
          '<td data-label="Total Paid">' + money(m.paid) + '</td>' +
          '<td data-label="Remaining">' + money(m.value - m.paid) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ---- Forfeiture Watch: every still-On-Hold item, oldest first, with its full
  // payment history (a layaway is paid in installments over time, so "how much so
  // far and when" matters more here than a single total) and a Date Purchased +
  // Forfeit Date pair so a row visibly turns red once it's close to or past the
  // 2-month cutoff. Independent of the date-range filter above -- this is about
  // what needs attention right now, not a historical range. ----
  function renderForfeitureWatch() {
    const rows = allHolds
      .filter((h) => h.status === 'On Hold')
      .map((h) => ({ h, daysHeld: daysSince(h.hold_date) }))
      .sort((a, b) => b.daysHeld - a.daysHeld);

    const box = document.getElementById('fw-table');
    if (!rows.length) { box.innerHTML = '<p class="muted">No items currently on hold.</p>'; return; }

    box.innerHTML = '<div class="table-scroll table-2col"><table style="table-layout:fixed;overflow-wrap:break-word;">' +
      '<thead><tr><th>Date Purchased</th><th>Item</th><th>Customer</th><th>Payments</th><th>Paid</th><th>Remaining</th><th>Days Held</th><th>Forfeit Date</th></tr></thead><tbody>' +
      rows.map(({ h, daysHeld }) => {
        const paid = paidSoFar(h);
        const remaining = h.total_price == null ? null : Number(h.total_price) - paid;
        const forfeitDate = new Date(h.hold_date + 'T00:00:00');
        forfeitDate.setDate(forfeitDate.getDate() + FORFEITURE_DAYS);
        const isOverdue = daysHeld >= FORFEITURE_DAYS;
        const isWarning = !isOverdue && daysHeld >= FORFEITURE_WARN_DAYS;
        const rowStyle = isOverdue ? 'background:#fdecea;' : isWarning ? 'background:#fff3f3;' : '';
        const payments = h.layaway_payments || [];
        const group = h.group_id ? groupMembers[h.group_id] : null;
        const groupIdx = group ? group.findIndex((x) => x.id === h.id) : -1;
        return '<tr style="' + rowStyle + '">' +
          '<td data-label="Date Purchased">' + fmtDate(h.hold_date) + '</td>' +
          '<td data-label="Item">' + esc(h.sku) +
            (group ? ' <span class="badge pending" style="font-size:9px;padding:1px 5px;" title="Part of a ' + group.length + '-item hold">' + (groupIdx + 1) + '/' + group.length + '</span>' : '') +
            (h.order_id ? '<div class="muted" style="font-size:10px;">Order ' + esc(h.order_id) + '</div>' : '') + '</td>' +
          '<td data-label="Customer">' + esc(h.customer_name) + (h.contact_number ? '<div class="muted" style="font-size:10px;">' + esc(h.contact_number) + '</div>' : '') + '</td>' +
          '<td data-label="Payments" class="full-row" style="font-size:11px;">' +
            (payments.length
              ? payments.map((p) => money(p.amount) + ' · ' + esc(p.payment_method) + (p.reference_number ? ' (' + esc(p.reference_number) + ')' : '') + ' — ' + (p.paid_at || '')).join('<br>')
              : '<span class="muted">No payments yet</span>') +
          '</td>' +
          '<td data-label="Paid">' + money(paid) + '</td>' +
          '<td data-label="Remaining">' + (remaining !== null ? money(remaining) : '—') + '</td>' +
          '<td data-label="Days Held">' + daysHeld + '</td>' +
          '<td data-label="Forfeit Date">' + fmtDate(forfeitDate.toISOString().slice(0, 10)) +
            (isOverdue ? ' <span class="badge low">FORFEITURE DUE</span>' : isWarning ? ' <span class="badge low">NEARING</span>' : '') +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function tile(num, label) { return '<div class="tile"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>'; }

  const unsubscribe = subscribeToChanges(['layaway_holds', 'layaway_payments'], load);
  await load();

  return { reload: load, unsubscribe };
}
