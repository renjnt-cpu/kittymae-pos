// UNPAID / PARTIALLY PAID / PAID for money still to be paid on a purchase (or received on a sale).
// Derived from the payment lines, never stored, so it can never disagree with them. Tones follow the
// page-wide status colours (green / blue / yellow / red / gray): owing the customer money is red.

/** total = the amount due, paid = the sum of the payment lines recorded so far. */
export function paymentStatusOf(total, paid) {
  const t = Number(total || 0), p = Number(paid || 0);
  if (!(t > 0)) return { key: 'na', label: '—', tone: 'gray', balance: 0, paid: p, total: t };
  const balance = Math.max(t - p, 0);
  if (p <= 0.005) return { key: 'unpaid', label: 'UNPAID', tone: 'red', balance, paid: p, total: t };
  if (balance > 0.01) return { key: 'partial', label: 'PARTIALLY PAID', tone: 'yellow', balance, paid: p, total: t };
  return { key: 'paid', label: 'PAID', tone: 'green', balance: 0, paid: p, total: t };
}

export function paymentChipHtml(st) {
  if (st.key === 'na') return '<span class="muted">—</span>';
  return '<span class="badge st-' + st.tone + '">' + st.label + '</span>';
}
