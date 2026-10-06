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
  cancelLabel = 'Cancel', errorTypes = null, errorLabel = 'What went wrong?', danger = false, initialReason = '' }) {
  const body =
    (errorTypes && errorTypes.length
      ? '<div class="field"><label for="dlg-errtype">' + escHtml(errorLabel) + '</label><select id="dlg-errtype">' +
          errorTypes.map((t) => '<option>' + escHtml(t) + '</option>').join('') + '</select></div>'
      : '') +
    '<div class="field"><label for="dlg-reason">' + escHtml(label) + (required ? ' *' : '') + '</label>' +
      '<textarea id="dlg-reason" rows="3" placeholder="' + escHtml(placeholder) + '"></textarea></div>';
  const back = build({ title, messageHtml: message ? escHtml(message).replace(/\n/g, '<br>') : '', bodyHtml: body, confirmLabel, cancelLabel, danger });
  back.querySelector('#dlg-reason').value = initialReason;
  return run(back, (form) => {
    const reason = form.querySelector('#dlg-reason').value.trim();
    if (required && !reason) return { error: 'Please write a reason.' };
    const typeEl = form.querySelector('#dlg-errtype');
    return { reason, errorType: typeEl ? typeEl.value : null };
  });
}

/** The error types a correction can be filed under (matches log_branch_error_correction()). */
export const ERROR_TYPES = ['Wrong Payment', 'Wrong SKU', 'Wrong Amount', 'Wrong Branch', 'Wrong Date', 'Wrong Purity',
  'Wrong Weight', 'Incorrect Layaway Item', 'Wrong Customer', 'Other'];
