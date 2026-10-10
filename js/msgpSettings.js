// Message Pancake -- Settings (owner only, message_pancake.manage): the Pancake connection (write-only page token), the waiting times, the categories (add / edit), the word lists,
// the link that opens a chat, and the recent checks. The token is saved privately and never shown again.
import { esc, toast } from './shell.js?v=20261011b';
import { confirmDialog } from './dialogs.js?v=20261011b';
import {
  msgpGetSettings, msgpSaveSettings, msgpSaveCategory, msgpDeleteCategory, msgpSaveWordlist, msgpSetToken, msgpClearToken, msgpRequestCheck,
} from './messagePancakeApi.js?v=20261011b';
import { COLORS, badge, ago, stamp } from './msgpFormat.js?v=20261011b';

const MSG = 'msgp-msg';
const VERDICT = {
  pancake_ok: ['ok', 'Works — chats and their messages can be read.'],
  pancake_ok_no_chats_to_test: ['ok', 'The token is accepted. There was no recent chat to test reading messages with — try again after a customer writes.'],
  pancake_list_ok_messages_failed: ['error', 'Chats can be listed, but their messages could not be read. See the technical details.'],
  pancake_token_ok_list_failed: ['error', 'Pancake accepts this token but refused the chat list. See the technical details.'],
  botcake_token_only: ['error', 'This looks like a Botcake token. It cannot read chats. In Pancake open the page → Settings → Tools and copy the Page Access Token.'],
  token_rejected: ['error', 'Pancake did not accept this token for this page. Copy it again (Pancake → Settings → Tools) and make sure it is for this page.'],
};
const PRIORITY_OPTS = [['critical', 'Critical'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];

function probeHtml(p) {
  if (!p) return '<div class="muted">Not tested yet. Save the token, then press Test connection.</div>';
  const [kind, text] = VERDICT[p.verdict] || ['error', 'Unknown result.'];
  return '<div class="msg ' + (kind === 'ok' ? 'ok' : 'error') + '">' + esc(text) + '</div>' +
    '<details class="msgp-tech"><summary>Technical details (no names, messages or token)</summary><pre>' + esc(JSON.stringify(p, null, 2)) + '</pre></details>';
}

export function startSettings({ root, onSaved }) {
  const st = { d: null };
  root.innerHTML = '<p class="muted">Loading settings…</p>';

  async function load(keepScroll) {
    const y = window.scrollY;
    try { st.d = await msgpGetSettings(); draw(); if (keepScroll) window.scrollTo(0, y); }
    catch (err) { root.innerHTML = '<div class="msg error">' + esc(String(err.message || err)) + '</div>'; }
  }

  function catForm(c, isNew) {
    const k = isNew ? 'new' : c.key;
    return '<details class="msgp-cat"' + (isNew ? ' open' : '') + ' data-cat="' + esc(isNew ? '' : c.key) + '"><summary>' +
        (isNew ? '<b>New category</b>' : badge(c.label, c.color) + ' <span class="muted">' + (c.enabled ? '' : 'switched off · ') + 'priority ' + esc(c.base_priority) + ' · reply within ' + esc(c.reply_target_min) + ' min' + (c.show_in_pos ? ' · shows in POS' : '') + (c.kind === 'flag' ? ' · badge' : '') + '</span>') + '</summary>' +
      '<div class="msgp-row">' +
        '<div class="field msgp-grow"><label for="cat-label-' + k + '">Name</label><input id="cat-label-' + k + '" type="text" maxlength="60" value="' + esc(isNew ? '' : c.label) + '"></div>' +
        '<div class="field"><label for="cat-color-' + k + '">Colour</label><select id="cat-color-' + k + '">' + COLORS.map((x) => '<option' + ((isNew ? 'gray' : c.color) === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="cat-prio-' + k + '">Priority</label><select id="cat-prio-' + k + '">' + PRIORITY_OPTS.map(([v, l]) => '<option value="' + v + '"' + ((isNew ? 'normal' : c.base_priority) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="cat-target-' + k + '">Reply target (min)</label><input id="cat-target-' + k + '" type="number" min="1" max="1440" value="' + esc(isNew ? 30 : c.reply_target_min) + '"></div>' +
        (c.kind === 'flag' ? '' : '<div class="field"><label for="cat-rank-' + k + '">Checked in order</label><input id="cat-rank-' + k + '" type="number" min="1" max="998" value="' + esc(isNew ? 125 : c.rank) + '" title="Lower numbers win when several categories match"></div>') +
      '</div>' +
      '<div class="msgp-row"><label class="msgp-check"><input type="checkbox" id="cat-pos-' + k + '"' + ((isNew ? false : c.show_in_pos) ? ' checked' : '') + '> Show in the POS Customer Attention panel</label>' +
        '<label class="msgp-check"><input type="checkbox" id="cat-on-' + k + '"' + ((isNew ? true : c.enabled) ? ' checked' : '') + '> Switched on</label></div>' +
      '<div class="field"><label for="cat-kw-' + k + '">Words that mean this (one per line)</label><textarea id="cat-kw-' + k + '" rows="5" spellcheck="false">' + esc(isNew ? '' : c.keywords.join('\n')) + '</textarea></div>' +
      (c.kind === 'flag' ? '' : '<div class="field"><label for="cat-tpl-' + k + '">Suggested reply ({name} and {order_part} are filled in)</label><textarea id="cat-tpl-' + k + '" rows="3">' + esc(isNew ? '' : c.reply_template || '') + '</textarea></div>') +
      '<div class="msgp-actions"><button type="button" class="btn small" data-act="save-cat">' + (isNew ? 'Add category' : 'Save category') + '</button>' + (!isNew && !c.is_system ? '<button type="button" class="btn small secondary" data-act="del-cat">Delete</button>' : '') + '</div></details>';
  }

  function draw() {
    const d = st.d, s = d.settings;
    root.innerHTML =
      '<div class="card msgp-set"><h2>1. Connect your Pancake pages</h2>' +
        '<p class="muted">Message Pancake reads your Messenger chats through Pancake. Paste each page’s <b>Page Access Token</b> (Pancake → the page → Settings → Tools). It is saved privately in the database and never shown again — only whether it is saved.</p>' +
        d.pages.map((p) =>
          '<div class="msgp-pagebox" data-page="' + esc(p.page_id) + '"><div class="msgp-page-head"><b>' + esc(p.label) + '</b> <span class="muted">page ' + esc(p.page_id) + '</span> ' + (p.token_set ? '<span class="badge ok">Token saved ' + esc(ago(p.token_saved_at)) + '</span>' : '<span class="badge gray">No token</span>') + '</div>' +
          '<div class="msgp-row"><div class="field msgp-grow"><label for="tok-' + esc(p.page_id) + '">Page Access Token</label><input id="tok-' + esc(p.page_id) + '" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (p.token_set ? 'Saved — paste a new one to replace it' : 'Paste the token here') + '" data-token></div>' +
            '<button type="button" class="btn small" data-act="save-token">Save token</button>' + (p.token_set ? '<button type="button" class="btn small secondary" data-act="remove-token">Remove token</button>' : '') + '</div>' +
          '<div class="msgp-row"><label class="msgp-check"><input type="checkbox" data-page-enabled' + (p.enabled ? ' checked' : '') + (p.token_set ? '' : ' disabled') + '> Read this page’s messages</label>' +
            '<button type="button" class="btn small secondary" data-act="test"' + (p.token_set ? '' : ' disabled') + '>Test connection</button></div><div data-probe>' + probeHtml(p.last_probe) + '</div></div>').join('') +
        '<label class="msgp-check msgp-master"><input type="checkbox" id="set-enabled"' + (s.enabled ? ' checked' : '') + '> <b>Message Pancake is ON</b> (the 5-minute check runs and the POS shows the customers who need attention)</label></div>' +

      '<div class="card msgp-set"><h2>2. How long is too long?</h2>' +
        '<div class="msgp-row"><div class="field"><label for="set-att">Attention after (min)</label><input id="set-att" type="number" min="1" value="' + esc(s.wait_attention_min) + '"></div>' +
          '<div class="field"><label for="set-wait">High attention after (min)</label><input id="set-wait" type="number" min="2" value="' + esc(s.waiting_minutes) + '"></div>' +
          '<div class="field"><label for="set-urgent">Urgent follow-up after (min)</label><input id="set-urgent" type="number" min="3" value="' + esc(s.urgent_minutes) + '"></div>' +
          '<div class="field"><label for="set-crit">Critical after (min)</label><input id="set-crit" type="number" min="4" value="' + esc(s.wait_critical_min) + '"></div></div>' +
        '<div class="msgp-row"><div class="field"><label for="set-pos">Show in the POS panel after waiting (min)</label><input id="set-pos" type="number" min="5" value="' + esc(s.pos_min_wait_min) + '"></div>' +
          '<div class="field"><label for="set-conf">Ask staff to review when sure less than (%)</label><input id="set-conf" type="number" min="10" max="95" value="' + esc(Math.round(s.low_confidence * 100)) + '"></div>' +
          '<div class="field"><label for="set-look">Look back (hours)</label><input id="set-look" type="number" min="1" max="168" value="' + esc(s.lookback_hours) + '"></div>' +
          '<div class="field"><label for="set-max">Chats read per check</label><input id="set-max" type="number" min="10" max="150" value="' + esc(s.max_fetch) + '"></div></div>' +
        '<p class="muted">The waiting colours: normal, then yellow (attention), orange (high attention), red (urgent follow-up). A conversation’s priority also rises with the waiting time and the number of unanswered messages. These are internal monitoring goals only.</p></div>' +

      '<div class="card msgp-set"><h2>3. Categories</h2><p class="muted">What a customer can be about. Each has the words that point to it, a priority, a reply target and whether it appears in the POS panel. You can add your own.</p>' +
        d.categories.map((c) => catForm(c, false)).join('') + catForm({ keywords: [], reply_template: '' }, true) + '</div>' +

      '<div class="card msgp-set"><h2>4. Word lists</h2><p class="muted">One word or phrase per line, English / Tagalog / Bisaya. Whole words only. These help work out tone, payment and wording; edit them when the detection misses something.</p>' +
        d.wordlists.map((w) => '<div class="field msgp-words" data-list="' + esc(w.key) + '"><label for="wl-' + esc(w.key) + '">' + esc(w.label) + ' <span class="muted">(' + w.words.length + ')</span></label><div class="muted msgp-hint">' + esc(w.hint || '') + '</div>' +
          '<textarea id="wl-' + esc(w.key) + '" rows="5" spellcheck="false">' + esc(w.words.join('\n')) + '</textarea><button type="button" class="btn small secondary" data-act="save-list">Save this list</button></div>').join('') + '</div>' +

      '<div class="card msgp-set"><details><summary>Advanced: the “Open chat” link</summary><div class="field"><label for="set-url">Link template ({page_id} and {conversation_id} are filled in)</label><input id="set-url" type="text" value="' + esc(s.open_url_template) + '"></div></details></div>' +
      '<div class="msgp-savebar"><button type="button" class="btn" id="set-save">Save settings</button></div>' +

      '<div class="card msgp-set"><h2>Recent checks</h2>' + (d.runs.length ? '<div class="table-scroll"><table><thead><tr><th>When</th><th>Page</th><th>Kind</th><th>Result</th><th>Note</th></tr></thead><tbody>' +
        d.runs.map((r) => '<tr><td>' + esc(stamp(r.started_at)) + '</td><td>' + esc(r.page || '—') + '</td><td>' + (r.probe ? 'Test' : 'Check') + '</td><td><span class="badge ' + (r.ok ? 'ok' : 'low') + '">' + (r.ok ? 'OK' : 'Problem') + '</span></td><td>' + esc(r.note || '') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="muted">No checks yet.</div>') + '</div>';
  }

  const collect = () => {
    const n = (id) => Number(root.querySelector(id).value);
    return {
      enabled: root.querySelector('#set-enabled').checked, wait_attention_min: n('#set-att'), waiting_minutes: n('#set-wait'), urgent_minutes: n('#set-urgent'), wait_critical_min: n('#set-crit'),
      pos_min_wait_min: n('#set-pos'), low_confidence: n('#set-conf') / 100, lookback_hours: n('#set-look'), max_fetch: n('#set-max'), open_url_template: root.querySelector('#set-url').value.trim(),
      pages: [...root.querySelectorAll('.msgp-pagebox')].map((b) => ({ page_id: b.dataset.page, enabled: b.querySelector('[data-page-enabled]').checked })),
    };
  };
  const lines = (id) => root.querySelector(id).value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);

  async function testConnection(box, pageId) {
    const probeEl = box.querySelector('[data-probe]'), btn = box.querySelector('[data-act="test"]');
    btn.disabled = true; probeEl.innerHTML = '<div class="muted">Testing… this takes about 20 seconds.</div>';
    const startedAt = Date.now() - 2000;
    try {
      const r = await msgpRequestCheck(true);
      if (!r.ok) { probeEl.innerHTML = '<div class="msg error">' + esc(r.message) + '</div>'; return; }
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const d = await msgpGetSettings();
        const p = d.pages.find((x) => x.page_id === pageId);
        if (p && p.last_probe_at && new Date(p.last_probe_at).getTime() >= startedAt) { st.d = d; probeEl.innerHTML = probeHtml(p.last_probe); return; }
      }
      probeEl.innerHTML = '<div class="msg error">No answer yet. Wait a moment and open Recent checks below.</div>';
    } catch (err) { probeEl.innerHTML = '<div class="msg error">' + esc(err.message || String(err)) + '</div>'; }
    finally { btn.disabled = false; }
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act], #set-save');
    if (!b) return;
    const box = b.closest('.msgp-pagebox'), pageId = box && box.dataset.page;
    try {
      if (b.id === 'set-save') { await msgpSaveSettings(collect()); toast(MSG, 'Settings saved.'); await load(true); if (onSaved) onSaved(); }
      else if (b.dataset.act === 'save-token') { const i = box.querySelector('[data-token]'); await msgpSetToken(pageId, i.value); i.value = ''; toast(MSG, 'Token saved. Now press Test connection.'); await load(true); }
      else if (b.dataset.act === 'remove-token') {
        if (!(await confirmDialog({ title: 'Remove this token?', message: 'Message Pancake stops reading this page until a token is saved again.', confirmLabel: 'Remove token', danger: true }))) return;
        await msgpClearToken(pageId); toast(MSG, 'Token removed.'); await load(true); if (onSaved) onSaved();
      } else if (b.dataset.act === 'test') await testConnection(box, pageId);
      else if (b.dataset.act === 'save-cat') {
        const det = b.closest('[data-cat]'), key = det.dataset.cat, k = key || 'new', g = (id) => det.querySelector('#' + id + '-' + k);
        const cat = { key: key || undefined, label: g('cat-label').value, color: g('cat-color').value, base_priority: g('cat-prio').value, reply_target_min: Number(g('cat-target').value),
          show_in_pos: g('cat-pos').checked, enabled: g('cat-on').checked, keywords: g('cat-kw').value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean) };
        if (g('cat-rank')) cat.rank = Number(g('cat-rank').value);
        if (g('cat-tpl')) cat.reply_template = g('cat-tpl').value;
        await msgpSaveCategory(cat); toast(MSG, key ? 'Category saved.' : 'Category added.'); await load(true); if (onSaved) onSaved();
      } else if (b.dataset.act === 'del-cat') {
        const key = b.closest('[data-cat]').dataset.cat;
        if (!(await confirmDialog({ title: 'Delete this category?', message: 'Conversations already labelled with it keep their label; new messages will not use it.', confirmLabel: 'Delete', danger: true }))) return;
        await msgpDeleteCategory(key); toast(MSG, 'Category deleted.'); await load(true); if (onSaved) onSaved();
      } else if (b.dataset.act === 'save-list') {
        const w = b.closest('[data-list]'); await msgpSaveWordlist(w.dataset.list, lines('#wl-' + w.dataset.list)); toast(MSG, 'Word list saved. Open chats are re-read with it on the next check.'); await load(true);
      }
    } catch (err) { toast(MSG, err.message || String(err), true); }
  });
  load();
  return { onShow() { load(true); } };
}
