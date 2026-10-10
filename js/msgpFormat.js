// Message Pancake -- the small wording helpers the page and the alert strip share.

export const CATEGORY = {
  ordering: { label: 'Ordering', hint: 'Looks like they want to buy or pay' },
  asking: { label: 'Just asking', hint: 'Price, stock, size, details' },
  angry: { label: 'Angry / complaint', hint: 'Complaint, delay or strong words' },
  waiting: { label: 'Waiting', hint: 'Said something and nobody has answered' },
};
export const URGENCY = {
  urgent: { label: 'Urgent' },
  follow_up: { label: 'Follow up' },
  new: { label: 'New' },
};

/** 5 -> "5 min", 135 -> "2 h 15 min", 3000 -> "2 d 2 h" */
export function fmtWait(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return m + ' min';
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d + ' d' + (h ? ' ' + h + ' h' : '');
}

/** "3 min ago" / "2 h ago" / "yesterday" from an ISO time, for the last-check line. */
export function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  if (min < 1440) return Math.round(min / 60) + ' h ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Maria Santos" -> "Maria S." for the narrow strip (the full name is on the page). */
export function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'Unknown';
  return parts[0] + ' ' + parts[1].charAt(0).toUpperCase() + '.';
}
