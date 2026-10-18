// Message Pancake -- the "Payment verification" part of a conversation: which payment proofs were already sent to Payment Verification for this chat (or its order), their
// status, and the SEND TO PAYMENT VERIFICATION button that opens the payment-proof form with the customer and the order filled in. Nothing is verified from here: a person
// in Payment Verification (in the ERP) checks the picture and the reference. The staff who send proofs need only the "add a payment proof" key; seeing the status needs the
// "view" key.
import { esc, money, statusBadge, riskBadge, fmtShortDateTime, friendly } from './pvFormat.js?v=20261018a';
import * as pvApi from './pvApi.js?v=20261018a';
import { openProofForm } from './pvProofForm.js?v=20261018a';

const ERP = 'https://renjnt-cpu.github.io/kittymae-inventory-system/';

export async function mountPayments(box, { row: r, employee, onChange }) {
  if (!box) return;
  const perms = (employee && employee.permissions) || [];
  const can = (k) => (employee && employee.role === 'Admin') || perms.includes(k);
  const canView = can('payment_verify.view'), canSubmit = can('payment_verify.submit');
  if (!canView && !canSubmit) { box.remove(); return; }
  box.innerHTML = '<h3>Payment verification</h3><p class="muted">Loading…</p>';
  let res = null, err = null;
  try { res = await pvApi.forConversation(r.page_id, r.conversation_id); } catch (e) { err = friendly(e); }
  if (!box.isConnected) return;
  if (err || !res || res.ok === false) {
    box.innerHTML = '<h3>Payment verification</h3><p class="muted">' + esc(err || (res && res.message) || 'It is not available right now.') + '</p>';
    return;
  }
  const pays = res.payments || [];
  const open = (id) => ERP + 'payment-verification.html?open=' + encodeURIComponent(id);
  box.innerHTML = '<h3>Payment verification</h3>' +
    (pays.length ? '<p class="muted">Payment proofs already sent to Payment Verification for this customer’s chat or order:</p>' + pays.map((p) =>
      '<div class="msgp-kv"><span><b>' + esc(p.pv_code) + '</b> ' + esc(money(p.amount)) + (p.order_ref ? ' · order #' + esc(p.order_ref) : '') + '<div class="muted">' +
        (p.reference ? 'reference ' + esc(p.reference) + ' · ' : '') + esc(fmtShortDateTime(p.submitted_at)) + '</div></span><span>' + statusBadge(p.status) + ' ' + riskBadge(p.risk) +
        (res.can_view ? ' <a class="act-link" target="_blank" rel="noopener noreferrer" href="' + esc(open(p.id)) + '">Open ↗</a>' : '') + '</span></div>').join('')
      : '<p class="muted">' + (r.payment_proof ? 'The customer may have sent a payment screenshot. ' : '') + 'No payment proof has been sent to Payment Verification for this chat yet.</p>') +
    (res.can_submit ? '<div class="msgp-actions"><button type="button" class="btn" data-send-pay>SEND TO PAYMENT VERIFICATION</button>' +
      (res.can_view ? '<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="' + ERP + 'payment-verification.html">Open Payment Verification ↗</a>' : '') + '</div>' +
      '<div class="muted">Save the customer’s payment screenshot (or copy it) and add it here — the system checks at once whether the reference or picture was already used. Nothing is verified from here.</div>' : '');
  const send = box.querySelector('[data-send-pay]');
  if (send) send.addEventListener('click', () => openProofForm({
    api: pvApi, source: 'PANCAKE', title: 'Send to Payment Verification', erpUrl: ERP,
    prefill: { order_ref: res.linked_order_ref || r.order_ref || null, order_shop: res.linked_order_shop || null, customer_name: res.customer_name || r.customer_name, customer_phone: res.customer_phone || r.customer_phone, conv_page: r.page_id, conv_id: r.conversation_id },
    onSaved: () => { mountPayments(box, { row: r, employee, onChange }); if (onChange) onChange(); },
  }));
}
