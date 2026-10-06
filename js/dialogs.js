// In-page dialogs that replace the browser's confirm()/prompt() for the actions that ask
// "are you sure?" or "why?". Same text everywhere, a real Cancel, an optional "what went
// wrong" picker for corrections, and -- unlike the native boxes -- they render inside the page,
// so they work the same on a phone and can be driven from automated checks. Both functions
// resolve (never reject): confirmDialog -> true/false, reasonDialog -> {reason, errorType} or null.

let open = null; // only one dialog at a time

function build({ title, messageHtml, bodyHtml, confirmLabel, cancelLabel, danger }) {
  const back = document.createElement('div');
  back.className = 'dlg-backdrop';
  back.innerHTML =
    '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">' +
      '<h3 id="dlg-title"></h3>' +
      '<div class="dlg-msg"></div>' +
      '<form class="dlg-form" novalidate>' + (bodyHtml || '') +
        '<div class="dlg-err" role="alert" hidden></div>' +
        '<div class="dlg-actions">' +
          '<button type="submit" class="btn' + (danger ? ' danger' : '') + '"></button>' +
          '<button type="button" class="btn secondary" data-dlg-cancel></button>' +
        '</div>' +
      '</form>' +
    '</div>';
  back.querySelector('#dlg-title').textContent = title || '';
  const msg = back.querySelector('.dlg-msg');
  if (messageHtml) msg.innerHTML = messageHtml; else msg.hidden = true;
  back.querySelector('button[type=submit]').textContent = confirmLabel;
  back.querySelector('[data-dlg-cancel]').textContent = cancelLabel;
  return back;
}

function run(back, onSubmit) {
  if (open) open.close(null);
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const form = back.querySelector('form');
    const err = back.querySelector('.dlg-err');
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      open = null;
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* element gone */ } }
      resolve(value);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(null); }
    }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(null); });
    back.querySelector('[data-dlg-cancel]').addEventListener('click', () => close(null));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const out = onSubmit(form);
      if (out && out.error) { err.textContent = out.error; err.hidden = false; return; }
      close(out);
    });
    open = { close };
    document.body.appendChild(back);
    const first = form.querySelector('select, textarea, input') || form.querySelector('button[type=submit]');
    if (first) first.focus();
  });
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** message is plain text (escaped here); resolves true when confirmed, false when cancelled. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  const back = build({ title, messageHtml: message ? escHtml(message).replace(/\n/g, '<br>') : '', confirmLabel, cancelLabel, danger });
  return run(back, () => true).then((v) => v === true);
}

/** Asks for a written reason (and, when `errorTypes` is given, what kind of mistake it was).
 * message is plain text. Resolves { reason, errorType } or null when cancelled. */
export function reasonDialog({ title, message, label = 'Reason', required = true, placeholder = '', confirmLabel = 'Submit',
  cancelLabel = 'Cancel', errorTypes = null, errorLabel = 'What went wrong?', danger = false, initialReason = '', initialErrorType = null,
  extraFieldsHtml = '', readExtra = null }) {
  const body = extraFieldsHtml +
    (errorTypes && errorTypes.length
      ? '<div class="field"><label for="dlg-errtype">' + escHtml(errorLabel) + '</label><select id="dlg-errtype">' +
          errorTypes.map((t) => '<option' + (t === initialErrorType ? ' selected' : '') + '>' + escHtml(t) + '</option>').join('') + '</select></div>'
      : '') +
    '<div class="field"><label for="dlg-reason">' + escHtml(label) + (required ? ' *' : '') + '</label>' +
      '<textarea id="dlg-reason" rows="3" placeholder="' + escHtml(placeholder) + '"></textarea></div>';
  const back = build({ title, messageHtml: message ? escHtml(message).replace(/\n/g, '<br>') : '', bodyHtml: body, confirmLabel, cancelLabel, danger });
  back.querySelector('#dlg-reason').value = initialReason;
  return run(back, (form) => {
    // Extra fields (e.g. the corrected values of a payment) are read and checked first; readExtra returns { error } or the values.
    const extra = readExtra ? readExtra(form) : null;
    if (extra && extra.error) return { error: extra.error };
    const reason = form.querySelector('#dlg-reason').value.trim();
    if (required && !reason) return { error: 'Please write a reason.' };
    const typeEl = form.querySelector('#dlg-errtype');
    return { reason, errorType: typeEl ? typeEl.value : null, extra };
  });
}

/** A ready-made message the person reads and copies (nothing is ever sent from here), with an optional main action.
 * Resolves 'action' (the main button), 'close' (Close) or null (Esc / click outside). onCopy(text) -> Promise<boolean> does the
 * copying; the dialog stays open and says "Copied" so the person can still press the main action afterwards. */
export function messageDialog({ title, introHtml = '', text, copyLabel = 'Copy message', actionLabel = '', closeLabel = 'Close', onCopy }) {
  if (open) open.close(null);
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = document.createElement('div');
    back.className = 'dlg-backdrop';
    back.innerHTML =
      '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">' +
        '<h3 id="dlg-title"></h3><div class="dlg-msg"></div>' +
        '<div class="field"><label for="dlg-text">Message</label><textarea id="dlg-text" rows="6" readonly></textarea></div>' +
        '<div class="dlg-copy-note muted" role="status"></div>' +
        '<div class="dlg-actions"><button type="button" class="btn" data-dlg-copy></button><button type="button" class="btn secondary" data-dlg-action></button><button type="button" class="btn secondary" data-dlg-close></button></div>' +
      '</div>';
    back.querySelector('#dlg-title').textContent = title || '';
    const msg = back.querySelector('.dlg-msg');
    if (introHtml) msg.innerHTML = introHtml; else msg.hidden = true;
    const ta = back.querySelector('#dlg-text');
    ta.value = text || '';
    const note = back.querySelector('.dlg-copy-note');
    const act = back.querySelector('[data-dlg-action]');
    if (actionLabel) act.textContent = actionLabel; else act.hidden = true;
    back.querySelector('[data-dlg-copy]').textContent = copyLabel;
    back.querySelector('[data-dlg-close]').textContent = closeLabel;
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      open = null;
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* element gone */ } }
      resolve(value);
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(null); } }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(null); });
    back.querySelector('[data-dlg-close]').addEventListener('click', () => close('close'));
    act.addEventListener('click', () => close('action'));
    back.querySelector('[data-dlg-copy]').addEventListener('click', async () => {
      let ok = false;
      try { ok = onCopy ? await onCopy(ta.value) : false; } catch (e) { ok = false; }
      if (ok) note.textContent = 'Copied ✓ — paste it into Messenger / SMS' + (actionLabel ? ', then press "' + actionLabel + '" once you have sent it.' : '.');
      else { ta.removeAttribute('readonly'); ta.focus(); ta.select(); note.textContent = 'Your browser did not allow copying automatically — the text is selected, press Ctrl+C.'; }
    });
    open = { close };
    document.body.appendChild(back);
    back.querySelector('[data-dlg-copy]').focus();
  });
}

/** The error types a correction can be filed under (matches log_branch_error_correction()). */
export const ERROR_TYPES = ['Wrong Payment', 'Wrong SKU', 'Wrong Amount', 'Wrong Branch', 'Wrong Date', 'Wrong Purity',
  'Wrong Weight', 'Incorrect Layaway Item', 'Wrong Customer', 'Other'];
