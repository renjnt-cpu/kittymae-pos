// Message Pancake page (Ren, 2026-10-11): the online customers on Messenger who need a reply or a follow-up -- who is ordering, who is just asking, who is angry,
// who has been waiting too long. The list comes from the database (msgp_list); a background job reads Pancake every 5 minutes (see migration 207).
// Staff with message_pancake.view work the list (Open in Pancake / Handled / Snooze / Not a concern). The owner (message_pancake.manage) also gets Settings:
// connect the Pancake pages (write-only token), the waiting times, the word lists, Test connection.
import { esc, toast } from './shell.js?v=20261011a';
import { confirmDialog } from './dialogs.js?v=20261011a';
import {
  msgpList, msgpSetStatus, msgpRequestCheck, msgpGetSettings, msgpSaveSettings, msgpSetToken, msgpClearToken,
} from './messagePancakeApi.js?v=20261011a';
import { CATEGORY, URGENCY, fmtWait, ago } from './msgpFormat.js?v=20261011a';

const MSG = 'msgp-msg';
const WORD_BOXES = [
  ['angry_words', 'Angry / complaint words', 'A message with one of these is marked Angry and Urgent: scam, refund, "ang tagal", "nasaan na", sira ...'],
  ['ordering_words', 'Ordering words', 'The customer wants to buy or pay: order, kukunin, COD, gcash, reserve, layaway ...'],
  ['asking_words', 'Just-asking words', 'Price, stock, size, details: magkano, available, pila, size, pic ...'],
  ['closing_words', 'Ignore when the whole message is only', 'A thank-you or okay: salamat po, ok, thank you ... (these never show on the list)'],
];

export async function startMessagePancake({ employee }) {
  const perms = employee.permissions || [];
  const canManage = perms.includes('message_pancake.manage');
  const canView = canManage || perms.includes('message_pancake.view');
  const root = document.getElementById('msgp-root');
  if (!canView) {
    root.innerHTML = '<div class="empty-state"><div class="empty-state-msg">Message Pancake is for the staff who answer online customers. Ask an Admin if you need it.</div></div>';
    return;
  }

  const st = { tab: 'list', view: 'open', cat: 'all', urg: 'all', page: 'all', q: '', open: null, other: null, settings: null, loadedAt: 0, testing: {}, checking: false };

  root.innerHTML =
    '<div class="msgp-tabs" role="tablist">' +
      '<button type="button" class="btn small" data-tab="list">Needs a reply</button>' +
      (canManage ? '<button type="button" class="btn small secondary" data-tab="settings">Settings</button>' : '') +
    '</div>' +
    '<div id="msgp-list"></div><div id="msgp-settings" hidden></div>';
  const listEl = root.querySelector('#msgp-list');
  const setEl = root.querySelector('#msgp-settings');

  // ---------- the list ----------
  async function load() {
    try {
      const o = await msgpList('open');
      st.open = o;
      st.other = st.view === 'open' ? o : await msgpList(st.view);
      st.loadedAt = Date.now();
      paintList();
      if (window.__kmMsgp) window.__kmMsgp.refresh();
    } catch (err) {
      listEl.innerHTML = '<div class="msg error">' + esc(String(err.message || err)) + '</div>';
    }
  }

  function banner(o) {
    if (!o.connected) {
      return '<div class="msg error">Message Pancake is not connected to a Pancake page yet. ' +
        (canManage ? 'Open <b>Settings</b> to connect one.' : 'Ask Ren to connect it.') + '</div>';
    }
    if (!o.enabled) return '<div class="msg error">Message Pancake is switched OFF, so no new messages are being read. ' + (canManage ? 'Switch it on in <b>Settings</b>.' : '') + '</div>';
    if (o.last_check_ok === false) return '<div class="msg error">The last check had a problem: ' + esc(o.last_check_note || 'unknown') + ' (' + esc(ago(o.last_check_at)) + ')</div>';
    const stale = o.last_check_at && (Date.now() - new Date(o.last_check_at).getTime()) > 20 * 60000;
    return '<div class="msgp-checked muted' + (stale ? ' msgp-stale' : '') + '">Last checked ' + esc(ago(o.last_check_at)) + (stale ? ' — checks are late' : '') +
      (o.last_check_note ? ' · ' + esc(o.last_check_note) : '') + '</div>';
  }

  function tile(key, label, n, cls) {
    return '<button type="button" class="tile msgp-tile ' + cls + (st.urg === key || st.cat === key ? ' on' : '') + '" data-tile="' + key + '"><div class="num">' + n + '</div><div class="lbl">' + label + '</div></button>';
  }

  function card(r) {
    const done = st.view === 'done', snoozed = st.view === 'snoozed';
    const cat = CATEGORY[r.category] || { label: r.category };
    const urg = URGENCY[r.urgency] || { label: r.urgency };
    return '<article class="msgp-card msgp-u-' + esc(r.urgency) + '" data-id="' + esc(r.id) + '">' +
      '<div class="msgp-card-top">' +
        '<span class="msgp-name">' + esc(r.customer_name) + '</span>' +
        '<span class="badge msgp-cat msgp-cat-' + esc(r.category) + '">' + esc(cat.label) + '</span>' +
        '<span class="badge msgp-urg msgp-urg-' + esc(r.urgency) + '">' + esc(urg.label) + '</span>' +
        '<span class="msgp-wait">waiting ' + esc(fmtWait(r.wait_min)) + '</span>' +
        '<span class="msgp-page muted">' + esc(r.page_label) + '</span>' +
      '</div>' +
      (r.snippet ? '<div class="msgp-snippet">“' + esc(r.snippet) + '”</div>' : '') +
      '<div class="msgp-reason muted">' + esc(r.reason || '') + (r.staff_tags && r.staff_tags.length ? ' · Pancake tags: ' + esc(r.staff_tags.join(', ')) : '') + '</div>' +
      ((done || snoozed) ? '<div class="msgp-reason muted">' + (done ? 'Marked ' + (r.status === 'dismissed' ? 'not a concern' : 'handled') + ' by ' + esc(r.status_by || 'someone') + ' · ' + esc(ago(r.status_at))
          : 'Snoozed by ' + esc(r.status_by || 'someone') + ' until ' + esc(new Date(r.snooze_until).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }))) +
          (r.note ? ' · ' + esc(r.note) : '') + '</div>' : '') +
      '<div class="msgp-actions">' +
        '<a class="btn small" href="' + esc(r.open_url) + '" target="_blank" rel="noopener noreferrer">Open in Pancake ↗</a>' +
        ((done || snoozed) ? '<button type="button" class="btn small secondary" data-act="reopen">Put back on the list</button>'
          : '<button type="button" class="btn small" data-act="handled">Handled</button>' +
            '<select class="msgp-snooze" aria-label="Snooze"><option value="">Snooze…</option><option value="60">1 hour</option><option value="180">3 hours</option><option value="1440">1 day</option></select>' +
            '<button type="button" class="btn small secondary" data-act="dismissed" title="Not a customer who needs a reply (for example a supplier or a joke)">Not a concern</button>') +
      '</div></article>';
  }

  function paintList() {
    const o = st.open;
    if (!o) return;
    const openRows = o.rows;
    const count = (f) => openRows.filter(f).length;
    const rows0 = (st.view === 'open' ? o : st.other).rows;
    const pages = [...new Set(openRows.concat(rows0).map((r) => r.page_label))];
    const q = st.q.trim().toLowerCase();
    const rows = rows0.filter((r) =>
      (st.cat === 'all' || r.category === st.cat) && (st.urg === 'all' || r.urgency === st.urg) && (st.page === 'all' || r.page_label === st.page) &&
      (!q || (r.customer_name + ' ' + (r.snippet || '')).toLowerCase().includes(q)));
    const filtering = st.cat !== 'all' || st.urg !== 'all' || st.page !== 'all' || q;
    listEl.innerHTML =
      banner(o) +
      '<div class="msgp-top"><div class="muted">Customers on Messenger whose last message nobody has answered. Checked every 5 minutes; the page refreshes by itself.</div>' +
        '<button type="button" class="btn small" id="msgp-check"' + (st.checking ? ' disabled' : '') + '>' + (st.checking ? 'Checking…' : 'Check now') + '</button></div>' +
      '<div class="tiles msgp-tiles">' +
        tile('urgent', 'Urgent', count((r) => r.urgency === 'urgent'), 'msgp-t-urgent') +
        tile('follow_up', 'Follow up', count((r) => r.urgency === 'follow_up'), 'msgp-t-follow') +
        tile('ordering', 'Ordering', count((r) => r.category === 'ordering'), '') +
        tile('asking', 'Just asking', count((r) => r.category === 'asking'), '') +
        tile('angry', 'Angry', count((r) => r.category === 'angry'), '') +
        tile('waiting', 'Waiting', count((r) => r.category === 'waiting'), '') +
      '</div>' +
      '<div class="card msgp-filters">' +
        '<div class="msgp-views">' +
          ['open', 'snoozed', 'done'].map((v) => '<button type="button" class="btn small' + (st.view === v ? '' : ' secondary') + '" data-view="' + v + '">' +
            ({ open: 'Open', snoozed: 'Snoozed', done: 'Done (3 days)' })[v] + '</button>').join('') +
        '</div>' +
        '<div class="field"><label for="msgp-q">Search name or message</label><input id="msgp-q" type="search" value="' + esc(st.q) + '" placeholder="Maria, magkano…"></div>' +
        (pages.length > 1 ? '<div class="field"><label for="msgp-page">Page</label><select id="msgp-page"><option value="all">All pages</option>' +
          pages.map((p) => '<option' + (st.page === p ? ' selected' : '') + ' value="' + esc(p) + '">' + esc(p) + '</option>').join('') + '</select></div>' : '') +
        (filtering ? '<button type="button" class="btn small secondary" id="msgp-clear">Clear filters</button>' : '') +
      '</div>' +
      (rows.length
        ? '<div class="msgp-cards">' + rows.map(card).join('') + '</div>'
        : '<div class="empty-state"><div class="empty-state-msg">' +
            (filtering ? 'Nothing matches these filters.' : (st.view === 'open' ? (o.connected && o.enabled ? 'Nobody is waiting for a reply. 🎉' : 'Nothing to show yet.') : 'Nothing here.')) + '</div></div>');
    // keep the search box focused while typing
    const qi = listEl.querySelector('#msgp-q');
    if (qi && st.qFocus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  }

  listEl.addEventListener('input', (e) => {
    if (e.target.id === 'msgp-q') { st.q = e.target.value; st.qFocus = true; paintList(); }
  });
  listEl.addEventListener('change', async (e) => {
    if (e.target.id === 'msgp-page') { st.page = e.target.value; st.qFocus = false; paintList(); return; }
    if (e.target.classList.contains('msgp-snooze') && e.target.value) {
      const id = Number(e.target.closest('[data-id]').dataset.id);
      await act(id, 'snooze', Number(e.target.value));
    }
  });
  listEl.addEventListener('click', async (e) => {
    st.qFocus = e.target.id === 'msgp-q';
    const tileBtn = e.target.closest('[data-tile]');
    if (tileBtn) {
      const k = tileBtn.dataset.tile;
      if (k === 'urgent' || k === 'follow_up') { st.urg = st.urg === k ? 'all' : k; st.cat = 'all'; } else { st.cat = st.cat === k ? 'all' : k; st.urg = 'all'; }
      st.view = 'open'; st.other = st.open; paintList(); return;
    }
    const v = e.target.closest('[data-view]');
    if (v) { st.view = v.dataset.view; await load(); return; }
    if (e.target.id === 'msgp-clear') { st.cat = st.urg = st.page = 'all'; st.q = ''; paintList(); return; }
    if (e.target.id === 'msgp-check') { await checkNow(); return; }
    const b = e.target.closest('[data-act]');
    if (b) await act(Number(b.closest('[data-id]').dataset.id), b.dataset.act);
  });

  async function act(id, action, snoozeMinutes) {
    try {
      await msgpSetStatus(id, action, snoozeMinutes);
      await load();
      toast(MSG, { handled: 'Marked handled.', dismissed: 'Taken off the list.', snooze: 'Snoozed.', reopen: 'Back on the list.' }[action] || 'Done.');
    } catch (err) { toast(MSG, err.message || String(err), true); await load(); }
  }

  async function checkNow() {
    st.checking = true; paintList();
    try {
      const r = await msgpRequestCheck(false);
      if (!r.ok) { toast(MSG, r.message, true); st.checking = false; paintList(); return; }
      toast(MSG, 'Checking Pancake now — the list updates in a few seconds.');
      setTimeout(async () => { st.checking = false; await load(); }, 9000);
    } catch (err) { st.checking = false; toast(MSG, err.message || String(err), true); paintList(); }
  }

  // ---------- settings (owner) ----------
  const VERDICT = {
    pancake_ok: ['ok', 'Works — chats and their messages can be read.'],
    pancake_ok_no_chats_to_test: ['ok', 'The token is accepted. There was no recent chat to test reading messages with — try again after a customer writes.'],
    pancake_list_ok_messages_failed: ['error', 'Chats can be listed, but their messages could not be read. Check the technical details below.'],
    botcake_token_only: ['error', 'This looks like a Botcake token. It cannot read chats, so Message Pancake cannot use it. In Pancake, open the page → Settings → Tools and copy the Page Access Token instead.'],
    token_rejected: ['error', 'Pancake did not accept this token for this page. Copy it again (Pancake → Settings → Tools) and make sure it is for this page.'],
  };
  function probeHtml(p) {
    if (!p) return '<div class="muted">Not tested yet. Save the token, then press Test connection.</div>';
    const [kind, text] = VERDICT[p.verdict] || ['error', 'Unknown result.'];
    return '<div class="msg ' + (kind === 'ok' ? 'ok' : 'error') + '">' + esc(text) + '</div>' +
      '<details class="msgp-tech"><summary>Technical details (no names, messages or token)</summary><pre>' + esc(JSON.stringify(p, null, 2)) + '</pre></details>';
  }

  function settingsHtml(d) {
    const s = d.settings;
    return '<div class="card msgp-set">' +
        '<h2>1. Connect your Pancake pages</h2>' +
        '<p class="muted">Message Pancake reads your Messenger chats through Pancake. For each page paste its <b>Page Access Token</b> (Pancake → the page → Settings → Tools). The token is saved privately in the database — it is never shown again, only whether it is saved. A Botcake token usually cannot read chats; <b>Test connection</b> tells you.</p>' +
        d.pages.map((p) =>
          '<div class="msgp-pagebox" data-page="' + esc(p.page_id) + '">' +
            '<div class="msgp-page-head"><b>' + esc(p.label) + '</b> <span class="muted">page ' + esc(p.page_id) + '</span> ' +
              (p.token_set ? '<span class="badge ok">Token saved ' + esc(ago(p.token_saved_at)) + '</span>' : '<span class="badge gray">No token</span>') + '</div>' +
            '<div class="msgp-row">' +
              '<div class="field msgp-grow"><label for="tok-' + esc(p.page_id) + '">Page Access Token</label><input id="tok-' + esc(p.page_id) + '" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (p.token_set ? 'Saved — paste a new one to replace it' : 'Paste the token here') + '" data-token></div>' +
              '<button type="button" class="btn small" data-act="save-token">Save token</button>' +
              (p.token_set ? '<button type="button" class="btn small secondary" data-act="remove-token">Remove token</button>' : '') +
            '</div>' +
            '<div class="msgp-row">' +
              '<label class="msgp-check"><input type="checkbox" data-page-enabled' + (p.enabled ? ' checked' : '') + (p.token_set ? '' : ' disabled') + '> Read this page’s messages</label>' +
              '<div class="field"><label for="prov-' + esc(p.page_id) + '">Token type</label><select id="prov-' + esc(p.page_id) + '" data-provider><option value="pancake"' + (p.provider === 'pancake' ? ' selected' : '') + '>Pancake page token</option><option value="botcake"' + (p.provider === 'botcake' ? ' selected' : '') + '>Botcake token</option></select></div>' +
              '<button type="button" class="btn small secondary" data-act="test"' + (p.token_set ? '' : ' disabled') + '>Test connection</button>' +
            '</div>' +
            '<div class="msgp-probe" data-probe>' + probeHtml(p.last_probe) + '</div>' +
          '</div>').join('') +
        '<label class="msgp-check msgp-master"><input type="checkbox" id="set-enabled"' + (s.enabled ? ' checked' : '') + '> <b>Message Pancake is ON</b> (the 5-minute check runs and the POS shows the names)</label>' +
      '</div>' +
      '<div class="card msgp-set">' +
        '<h2>2. When does a chat need attention?</h2>' +
        '<div class="msgp-row">' +
          '<div class="field"><label for="set-wait">Follow up after (minutes unanswered)</label><input id="set-wait" type="number" min="5" max="1440" value="' + esc(s.waiting_minutes) + '"></div>' +
          '<div class="field"><label for="set-urgent">Urgent after (minutes unanswered)</label><input id="set-urgent" type="number" min="10" max="4320" value="' + esc(s.urgent_minutes) + '"></div>' +
          '<div class="field"><label for="set-look">Look back (hours)</label><input id="set-look" type="number" min="1" max="168" value="' + esc(s.lookback_hours) + '"></div>' +
        '</div>' +
        '<p class="muted">An <b>angry</b> message, or a chat you tagged <b>Urgent</b> in Pancake, is urgent right away. Chats with a thank-you only, or a sticker, are ignored. When staff answer in Pancake the chat leaves the list by itself.</p>' +
      '</div>' +
      '<div class="card msgp-set">' +
        '<h2>3. The words it looks for</h2>' +
        '<p class="muted">One word or phrase per line, English / Tagalog / Bisaya. It matches whole words anywhere in the customer’s unanswered message. Angry words are checked first, then ordering, then asking. Changes apply to the next check.</p>' +
        WORD_BOXES.map(([k, label, hint]) =>
          '<div class="field msgp-words"><label for="w-' + k + '">' + esc(label) + ' <span class="muted">(' + s[k].length + ')</span></label>' +
          '<div class="muted msgp-hint">' + esc(hint) + '</div>' +
          '<textarea id="w-' + k + '" data-words="' + k + '" rows="6" spellcheck="false">' + esc(s[k].join('\n')) + '</textarea>' +
          '<button type="button" class="btn small secondary" data-act="restore" data-key="' + k + '">Restore the starter list</button></div>').join('') +
      '</div>' +
      '<div class="card msgp-set"><details><summary>Advanced: the “Open in Pancake” link</summary>' +
        '<div class="field"><label for="set-url">Link template ({page_id} and {conversation_id} are filled in)</label><input id="set-url" type="text" value="' + esc(s.open_url_template) + '"></div></details></div>' +
      '<div class="msgp-savebar"><button type="button" class="btn" id="set-save">Save settings</button></div>' +
      '<div class="card msgp-set"><h2>Recent checks</h2>' +
        (d.runs.length ? '<div class="table-scroll"><table><thead><tr><th>When</th><th>Page</th><th>Kind</th><th>Result</th><th>Note</th></tr></thead><tbody>' +
          d.runs.map((r) => '<tr><td>' + esc(new Date(r.started_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '</td><td>' + esc(r.page || '—') + '</td><td>' + (r.probe ? 'Test' : 'Check') + '</td>' +
            '<td><span class="badge ' + (r.ok ? 'ok' : 'low') + '">' + (r.ok ? 'OK' : 'Problem') + '</span>' + (r.http_status ? ' HTTP ' + esc(r.http_status) : '') + '</td><td>' + esc(r.note || '') + '</td></tr>').join('') +
          '</tbody></table></div>' : '<div class="muted">No checks yet.</div>') +
      '</div>';
  }

  async function loadSettings(keepScroll) {
    try {
      st.settings = await msgpGetSettings();
      const y = window.scrollY;
      setEl.innerHTML = settingsHtml(st.settings);
      if (keepScroll) window.scrollTo(0, y);
    } catch (err) { setEl.innerHTML = '<div class="msg error">' + esc(String(err.message || err)) + '</div>'; }
  }

  function collect() {
    const num = (id) => Number(setEl.querySelector(id).value);
    const out = {
      enabled: setEl.querySelector('#set-enabled').checked,
      waiting_minutes: num('#set-wait'), urgent_minutes: num('#set-urgent'), lookback_hours: num('#set-look'),
      open_url_template: setEl.querySelector('#set-url').value.trim(),
      pages: [...setEl.querySelectorAll('.msgp-pagebox')].map((b) => ({
        page_id: b.dataset.page, enabled: b.querySelector('[data-page-enabled]').checked, provider: b.querySelector('[data-provider]').value,
      })),
    };
    setEl.querySelectorAll('[data-words]').forEach((t) => { out[t.dataset.words] = t.value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean); });
    return out;
  }

  setEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], #set-save');
    if (!b) return;
    const box = b.closest('.msgp-pagebox');
    const pageId = box && box.dataset.page;
    try {
      if (b.id === 'set-save') {
        await msgpSaveSettings(collect());
        toast(MSG, 'Settings saved.');
        await loadSettings(true);
        await load();
      } else if (b.dataset.act === 'save-token') {
        const input = box.querySelector('[data-token]');
        await msgpSetToken(pageId, input.value);
        input.value = '';
        toast(MSG, 'Token saved. Now press Test connection.');
        await loadSettings(true);
      } else if (b.dataset.act === 'remove-token') {
        const ok = await confirmDialog({ title: 'Remove this token?', message: 'Message Pancake stops reading this page until a token is saved again.', confirmLabel: 'Remove token', danger: true });
        if (!ok) return;
        await msgpClearToken(pageId);
        toast(MSG, 'Token removed.');
        await loadSettings(true);
        await load();
      } else if (b.dataset.act === 'restore') {
        const ta = setEl.querySelector('[data-words="' + b.dataset.key + '"]');
        ta.value = st.settings.defaults[b.dataset.key].join('\n');
        toast(MSG, 'Starter list restored in the box — press Save settings to keep it.');
      } else if (b.dataset.act === 'test') {
        await testConnection(box, pageId);
      }
    } catch (err) { toast(MSG, err.message || String(err), true); }
  });

  async function testConnection(box, pageId) {
    // the provider choice is saved first, so the test and the later checks use the same setting
    const probeEl = box.querySelector('[data-probe]');
    const btn = box.querySelector('[data-act="test"]');
    btn.disabled = true;
    probeEl.innerHTML = '<div class="muted">Testing… this takes about 10 seconds.</div>';
    const startedAt = Date.now() - 2000;
    try {
      const r = await msgpRequestCheck(true);
      if (!r.ok) { probeEl.innerHTML = '<div class="msg error">' + esc(r.message) + '</div>'; return; }
      for (let i = 0; i < 15; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const d = await msgpGetSettings();
        const p = d.pages.find((x) => x.page_id === pageId);
        if (p && p.last_probe_at && new Date(p.last_probe_at).getTime() >= startedAt) { st.settings = d; probeEl.innerHTML = probeHtml(p.last_probe); return; }
      }
      probeEl.innerHTML = '<div class="msg error">No answer yet. Wait a moment and open Recent checks below.</div>';
    } catch (err) {
      probeEl.innerHTML = '<div class="msg error">' + esc(err.message || String(err)) + '</div>';
    } finally { btn.disabled = false; }
  }

  // ---------- tabs and refresh ----------
  function showTab(t) {
    st.tab = t;
    listEl.hidden = t !== 'list';
    setEl.hidden = t !== 'settings';
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('secondary', b.dataset.tab !== t));
    if (t === 'settings') loadSettings(false); else load();
  }
  root.querySelector('.msgp-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

  setInterval(() => { if (st.tab === 'list' && !document.hidden && document.activeElement && document.activeElement.id !== 'msgp-q') load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.tab === 'list' && Date.now() - st.loadedAt > 30000) load(); });

  showTab(canManage && new URLSearchParams(location.search).get('tab') === 'settings' ? 'settings' : 'list');
}
