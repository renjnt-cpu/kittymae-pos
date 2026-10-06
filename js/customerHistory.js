// "Customer history" drawer: click a customer's name anywhere in Layaway and see their current
// and past layaways, payment history, completed / forfeited / cancelled orders and what they
// still owe. The data comes from layaway_customer_history() (matched by name or phone number,
// limited to the branches the signed-in employee may see), so someone without access to a
// branch never sees that branch's orders here. Mounted lazily, once, on document.body.
import { getLayawayCustomerHistory, listActiveEmployees } from './api.js?v=20261007l';
import { daysBetween, manilaToday } from './opsDates.js?v=20261007l';
import { daysText } from './layawayStatus.js?v=20261007l';

const money = (n) => n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';
const TONE = { 'On Hold': 'blue', 'Completed': 'green', 'Forfeited': 'red', 'Cancelled': 'gray', 'Mixed': 'gray' };

let mounted = false;
function mount() {
  if (mounted) return;
  mounted = true;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="drawer-backdrop" id="ch-backdrop"></div>' +
    '<div class="drawer drawer-wide" id="ch-drawer" role="dialog" aria-label="Customer history">' +
      '<div class="drawer-header"><div><h3 id="ch-title">Customer history</h3><div class="muted" id="ch-sub"></div></div>' +
      '<button type="button" class="drawer-close" id="ch-close" aria-label="Close">✕</button></div>' +
      '<div class="drawer-body" id="ch-body"></div>' +
    '</div>';
  document.body.appendChild(wrap);
  const close = () => { document.getElementById('ch-backdrop').classList.remove('open'); document.getElementById('ch-drawer').classList.remove('open'); };
  document.getElementById('ch-close').addEventListener('click', close);
  document.getElementById('ch-backdrop').addEventListener('click', close);
}

/** Opens the drawer for one customer. `branchName(id)` and `esc` come from the host tab. */
export async function openCustomerHistory({ name, contact, esc, branchName }) {
  mount();
  const title = document.getElementById('ch-title'), sub = document.getElementById('ch-sub'), body = document.getElementById('ch-body');
  title.textContent = name || 'Customer history';
  sub.textContent = contact || '';
  body.innerHTML = '<div class="muted">Loading…</div>';
  document.getElementById('ch-backdrop').classList.add('open');
  document.getElementById('ch-drawer').classList.add('open');
  try {
    const [h, people] = await Promise.all([getLayawayCustomerHistory(name, contact), listActiveEmployees().catch(() => [])]);
    const who = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
    const orders = h.orders || [];
    title.textContent = h.customer_name || name || 'Customer history';
    sub.textContent = [h.contact_number, h.alt_contact_number ? 'alt ' + h.alt_contact_number : ''].filter(Boolean).join(' · ');
    if (!orders.length) { body.innerHTML = '<p class="muted">No layaways found for this customer in the branches you can see.</p>'; return; }
    const n = (st) => orders.filter((o) => o.status === st).length;
    const cell = (label, value) => '<div class="sm-cell"><span>' + label + '</span><b>' + value + '</b></div>';
    body.innerHTML =
      '<div class="sm-sum">' +
        cell('Still owes', money(h.outstanding_balance)) + cell('Active', n('On Hold')) + cell('Completed', n('Completed')) +
        cell('Forfeited', n('Forfeited')) + cell('Cancelled', n('Cancelled')) +
      '</div>' +
      orders.map((o) => {
        const days = o.active && o.deadline ? daysBetween(manilaToday(), o.deadline) : null;
        return '<div class="drawer-section"><h4>Order ' + esc(o.order_ids || '—') + ' · ' + esc(branchName(o.branch_id)) + '</h4>' +
          '<div class="drawer-kv"><span>Status</span><b><span class="badge st-' + (TONE[o.status] || 'gray') + '">' + esc(o.status) + '</span></b></div>' +
          '<div class="drawer-kv"><span>Layaway date</span><b>' + fmtDate(o.hold_date) + '</b></div>' +
          (o.active ? '<div class="drawer-kv"><span>Deadline</span><b>' + fmtDate(o.deadline) + (days != null ? ' · ' + esc(daysText(days)) : '') + '</b></div>' : '') +
          '<div class="drawer-kv"><span>Total / Paid / Balance</span><b>' + money(o.total) + ' / ' + money(o.paid) + ' / ' + money(o.balance) + '</b></div>' +
          '<div style="margin-top:6px;">' + (o.items || []).map((it) =>
            '<div class="muted" style="font-size:12px;">' + esc(it.item_name || it.sku) + ' <span>(' + esc(it.sku) + ')</span> × ' + it.qty + ' · ' + money(it.total) +
            (it.status !== 'On Hold' ? ' · ' + esc(it.status) : '') + '</div>').join('') + '</div>' +
          ((o.payments || []).length
            ? '<div style="margin-top:8px;">' + o.payments.map((p) => '<div class="payment-line"><div>' + money(p.amount) + ' · ' + esc(p.method) +
                (p.reference ? ' · #' + esc(p.reference) : '') + '</div>' +
                '<div class="muted" style="font-size:11px;">' + fmtDate(p.paid_at) + (who[p.by] ? ' · ' + esc(who[p.by]) : '') + (p.notes ? ' · ' + esc(p.notes) : '') + '</div></div>').join('') + '</div>'
            : '<p class="muted" style="margin:6px 0 0;">No payments yet.</p>') +
        '</div>';
      }).join('');
  } catch (err) {
    body.innerHTML = '<div class="msg error">' + esc(err.message || err) + '</div>';
  }
}
