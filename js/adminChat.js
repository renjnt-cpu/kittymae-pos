// Internal Admin chat (Ren, 2026-09-24: "is it possible to have internal admin chat...
// will it affect the slow movement or lag in the system?" -> "Just the two of us for
// now") -- a small floating widget, called once from each app's shared shell (shell.js/
// posNav.js) so it's available on every page without each page needing its own wiring.
// Realtime push (subscribeToChanges), not polling, and capped history (see api.js) --
// the two things that actually matter for the lag concern Ren raised before asking for
// this.
import { listAdminChatMessages, sendAdminChatMessage, subscribeToChanges } from './api.js?v=20260923m';

const STYLE_ID = 'km-chat-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '.km-chat-toggle { position:fixed; bottom:20px; right:20px; z-index:2500; width:52px; height:52px; border-radius:50%; background:var(--rose); color:var(--ink); border:none; box-shadow:0 4px 12px rgba(0,0,0,0.2); cursor:pointer; font-size:12px; font-weight:700; }' +
    '.km-chat-badge { position:absolute; top:-4px; right:-4px; background:#c62828; color:#fff; border-radius:10px; min-width:18px; height:18px; padding:0 4px; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; line-height:1; }' +
    '.km-chat-panel { position:fixed; bottom:82px; right:20px; z-index:2500; width:320px; max-width:calc(100vw - 32px); height:440px; max-height:calc(100vh - 120px); background:#fff; border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,0.25); display:flex; flex-direction:column; overflow:hidden; }' +
    '.km-chat-head { background:var(--rose); color:var(--ink); padding:10px 14px; font-weight:700; font-size:14px; display:flex; justify-content:space-between; align-items:center; }' +
    '.km-chat-close { background:none; border:none; font-size:16px; cursor:pointer; color:inherit; padding:2px 4px; }' +
    '.km-chat-messages { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }' +
    '.km-chat-msg { max-width:82%; }' +
    '.km-chat-msg.mine { align-self:flex-end; text-align:right; }' +
    '.km-chat-msg-meta { font-size:10px; color:var(--muted); margin-bottom:2px; }' +
    '.km-chat-msg-body { display:inline-block; background:#f1f1f1; border-radius:10px; padding:6px 10px; font-size:13px; text-align:left; white-space:pre-wrap; word-break:break-word; }' +
    '.km-chat-msg.mine .km-chat-msg-body { background:var(--rose-lt); }' +
    '.km-chat-form { display:flex; gap:6px; padding:10px; border-top:1px solid #eee; }' +
    '.km-chat-form input { flex:1; border:1px solid #ddd; border-radius:6px; padding:8px 10px; font-size:13px; }' +
    '.km-chat-form button { background:var(--rose); color:var(--ink); border:none; border-radius:6px; padding:8px 14px; font-size:13px; cursor:pointer; }';
  document.head.appendChild(style);
}

const fmtTime = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '';

/** Admin-only (Ren, 2026-09-24: "just the two of us for now") -- gated client-side on
 * role, same as canFinalDelete/canRecordPurchase elsewhere; the real gate is the
 * database's is_admin() RLS policy, this just avoids building the widget's DOM for
 * everyone else. */
export function initAdminChat(employee) {
  if (employee.role !== 'Admin') return;

  ensureStyle();

  let messages = [];
  let unread = 0;
  let isOpen = false;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'km-chat-toggle';
  toggle.setAttribute('aria-label', 'Admin Chat');
  toggle.innerHTML = 'Chat<span class="km-chat-badge" id="km-chat-badge" style="display:none;"></span>';
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.className = 'km-chat-panel';
  panel.style.display = 'none';
  panel.innerHTML =
    '<div class="km-chat-head"><span>Admin Chat</span><button type="button" class="km-chat-close" aria-label="Close">✕</button></div>' +
    '<div class="km-chat-messages" id="km-chat-messages"></div>' +
    '<form class="km-chat-form" id="km-chat-form">' +
      '<input type="text" id="km-chat-input" placeholder="Message…" autocomplete="off" maxlength="2000">' +
      '<button type="submit">Send</button>' +
    '</form>';
  document.body.appendChild(panel);

  const messagesBox = panel.querySelector('#km-chat-messages');
  const badge = toggle.querySelector('#km-chat-badge');

  function renderMessages() {
    messagesBox.innerHTML = '';
    messages.forEach((m) => {
      const mine = m.sender_id === employee.id;
      const line = document.createElement('div');
      line.className = 'km-chat-msg' + (mine ? ' mine' : '');
      const meta = document.createElement('div');
      meta.className = 'km-chat-msg-meta';
      meta.textContent = (mine ? 'You' : (m.sender ? m.sender.full_name : 'Unknown')) + ' · ' + fmtTime(m.created_at);
      const body = document.createElement('div');
      body.className = 'km-chat-msg-body';
      body.textContent = m.message;
      line.appendChild(meta);
      line.appendChild(body);
      messagesBox.appendChild(line);
    });
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  function updateBadge() {
    if (unread > 0) { badge.textContent = String(unread); badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  async function refresh() {
    try {
      messages = await listAdminChatMessages();
    } catch (err) {
      return; // a failed refresh shouldn't break the widget -- just try again next event
    }
    if (isOpen) renderMessages();
  }

  function openPanel() {
    isOpen = true;
    panel.style.display = 'flex';
    unread = 0;
    updateBadge();
    renderMessages();
    panel.querySelector('#km-chat-input').focus();
  }
  function closePanel() {
    isOpen = false;
    panel.style.display = 'none';
  }
  toggle.addEventListener('click', () => (isOpen ? closePanel() : openPanel()));
  panel.querySelector('.km-chat-close').addEventListener('click', closePanel);

  panel.querySelector('#km-chat-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = panel.querySelector('#km-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await sendAdminChatMessage(text);
      // Don't wait on the realtime round-trip just to see your own message --
      // refresh immediately; the subscription below is what picks up the other
      // admin's incoming messages.
      await refresh();
    } catch (err) {
      input.value = text;
      alert('Message not sent: ' + String(err.message || err));
    }
  });

  refresh();
  subscribeToChanges('admin_chat_messages', async (payload) => {
    await refresh();
    if (!isOpen && payload.eventType === 'INSERT' && payload.new && payload.new.sender_id !== employee.id) {
      unread += 1;
      updateBadge();
    }
  });
}
