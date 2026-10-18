// Branch Capital -- the side panel and the dialogs. In-page (no browser confirm / prompt), so they behave the same on a phone and can be driven from automated checks.
// formDialog: a form with Save / Cancel; the submit handler decides when it closes (so a rule from the database can be shown without losing what was typed).
// choiceDialog: a message with several buttons, one of which is picked (used for "INSUFFICIENT PETTY CASH" and "CONFIRM EXPENSE FUNDING").
import { esc } from './shell.js?v=20261018b';

const stack = [];   // open dialogs, last one is on top
function onKey(ev) {
  if (ev.key !== 'Escape' || !stack.length) return;
  ev.stopImmediatePropagation();
  stack[stack.length - 1].close(null);
}
document.addEventListener('keydown', onKey, true);

function frame({ title, messageHtml, wide }) {
  const back = document.createElement('div');
  back.className = 'dlg-backdrop';
  back.innerHTML = '<div class="dlg' + (wide ? ' bc-dlg-wide' : '') + '" role="dialog" aria-modal="true"><h3></h3><div class="dlg-msg"></div><div class="bc-dlg-slot"></div></div>';
  back.querySelector('h3').textContent = title || '';
  const msg = back.querySelector('.dlg-msg');
  if (messageHtml) msg.innerHTML = messageHtml; else msg.hidden = true;
  return back;
}
function mount(back, close, focusSel) {
  stack.push({ close });
  document.body.appendChild(back);
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(null); });
  const first = back.querySelector(focusSel || 'select, textarea, input');
  if (first) { try { first.focus(); } catch (e) { /* not focusable */ } }
}

/** onSubmit(form, ctl) may return {error} to show a message and stay open, {close: value} to close, or nothing (the handler uses ctl.close / ctl.setError itself). ctl.setBusy(true) disables the buttons.
 * Resolves with the value given to close, or null when cancelled. */
export function formDialog({ title, messageHtml = '', bodyHtml = '', confirmLabel = 'Save', cancelLabel = 'Cancel', danger = false, wide = false, extraButtonsHtml = '', onSubmit, onReady }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const back = frame({ title, messageHtml, wide });
    back.querySelector('.bc-dlg-slot').innerHTML =
      '<form class="dlg-form" novalidate>' + bodyHtml + '<div class="dlg-err" role="alert" hidden></div>' +
      '<div class="dlg-actions"><button type="submit" class="btn' + (danger ? ' danger' : '') + '"></button>' + extraButtonsHtml + '<button type="button" class="btn secondary" data-cancel></button></div></form>';
    const form = back.querySelector('form');
    const errEl = back.querySelector('.dlg-err');
    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.textContent = confirmLabel;
    form.querySelector('[data-cancel]').textContent = cancelLabel;
    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      const i = stack.findIndex((s) => s.close === close);
      if (i >= 0) stack.splice(i, 1);
      back.remove();
      if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* element gone */ } }
      resolve(value === undefined ? null : value);
    }
    const ctl = {
      close,
      form,
      setError(text) { if (text) { errEl.textContent = text; errEl.hidden = false; errEl.scrollIntoView({ block: 'nearest' }); } else { errEl.hidden = true; } },
      setBusy(b) { form.querySelectorAll('button').forEach((x) => { x.disabled = !!b; }); submitBtn.textContent = b ? 'Working…' : confirmLabel; },
    };
    form.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      ctl.extra = (ev.submitter && ev.submitter.dataset.extra) || null;   // which extra button was pressed (e.g. "draft")
      ctl.setError('');
      ctl.setBusy(true);
      try {
        const out = onSubmit ? await onSubmit(form, ctl) : { close: true };
        if (out && out.error) ctl.setError(out.error);
        else if (out && 'close' in out) { close(out.close); return; }
      } catch (err) {
        ctl.setError(String(err && err.message ? err.message : err));
      }
      if (!done) ctl.setBusy(false);
    });
    mount(back, close);
    if (onReady) onReady(form, ctl);
  });
}

/** choices: [{key, label, primary?, danger?, hint?}]. Resolves the chosen key, or null (Cancel / Esc / click outside). */
export function choiceDialog({ title, messageHtml = '', choices, cancelLabel = 'Cancel', bodyHtml = '', read }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const back = frame({ title, messageHtml });
    back.querySelector('.bc-dlg-slot').innerHTML = bodyHtml + '<div class="dlg-err" role="alert" hidden></div><div class="bc-choices">' +
      choices.map((c) => '<button type="button" class="btn' + (c.primary ? '' : ' secondary') + (c.danger ? ' danger' : '') + '" data-key="' + esc(c.key) + '">' + esc(c.label) + '</button>' + (c.hint ? '<div class="muted bc-choice-hint">' + esc(c.hint) + '</div>' : '') + (c.extraHtml || '')).join('') +
      '</div><div class="dlg-actions"><button type="button" class="btn secondary" data-cancel>' + esc(cancelLabel) + '</button></div>';
    const errEl = back.querySelector('.dlg-err');
    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      const i = stack.findIndex((s) => s.close === close);
      if (i >= 0) stack.splice(i, 1);
      back.remove();
      if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* element gone */ } }
      resolve(value === undefined ? null : value);
    }
    back.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    back.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
      // `read` lets a choice carry what was typed in bodyHtml: it returns {error} or the extra values
      const extra = read ? read(back, b.dataset.key) : null;
      if (extra && extra.error) { errEl.textContent = extra.error; errEl.hidden = false; return; }
      close({ key: b.dataset.key, extra });
    }));
    mount(back, close, '[data-key]');
  });
}

/** A side panel (right on desktop, full screen on a phone). Returns {body, close, set(html)}; set() replaces the content. One panel at a time. */
export function openDrawer({ label = 'Details', onClose } = {}) {
  document.querySelectorAll('.bc-drawer-wrap').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'bc-drawer-wrap';
  wrap.innerHTML = '<div class="bc-drawer-back"></div><aside class="bc-drawer" role="dialog" aria-modal="true" aria-label="' + esc(label) + '"><div class="bc-dr-body"><p class="muted">Loading…</p></div></aside>';
  document.body.appendChild(wrap);
  document.body.classList.add('bc-noscroll');
  const body = wrap.querySelector('.bc-dr-body');
  const keyHandler = (e) => { if (e.key === 'Escape' && !stack.length && !document.querySelector('.dlg-backdrop')) close(); };
  function close() {
    wrap.remove();
    document.body.classList.remove('bc-noscroll');
    document.removeEventListener('keydown', keyHandler, true);
    if (onClose) onClose();
  }
  document.addEventListener('keydown', keyHandler, true);
  wrap.querySelector('.bc-drawer-back').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-bc-close]')) close(); });
  return { body, close, set(html) { body.innerHTML = html; }, isOpen: () => document.body.contains(wrap) };
}
