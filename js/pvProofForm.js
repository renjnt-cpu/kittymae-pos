// Payment Verification -- the "Add payment proof" form, shared by every place a proof can be sent from: the ERP Payment Verification page, the ERP Online Orders pages and
// the POS Message Pancake panel (the ERP and the POS carry an identical copy of this file). It opens as its own window on top of the page, takes the order, the
// payment details and the pictures, and -- the moment a reference or a picture is entered -- asks the database to run the whole duplicate check and shows exactly which
// earlier order and customer already used it. Saving never verifies anything: the proof goes to the verification queue for a person to check.
import { esc, money, fmtDate, manilaToday, debounce, friendly, statusBadge, riskBadge, matchCardHtml, riskRank, fmtBytes, orderSummaryLines, SOURCES, shopChip, orderRefHtml, pancakeStatusBadge, pancakeStatusLabel } from './pvFormat.js?v=20261023b';
import { prepareImage } from './pvImage.js?v=20261023b';

const FALLBACK_METHODS = ['GCash', 'Maya', 'BDO', 'BPI', 'Bank Transfer', 'Other E-Wallet', 'Other Bank', 'Cash Deposit', 'Other'].map((m) => ({ method: m, proof_required: true, reference_required: true }));
const MAX_PICS = 6;

/** opts: { api, source, askSource, prefill:{order_ref, order_shop, customer_name, customer_phone, conv_page, conv_id, amount, method, reference}, lockOrder, title,
 *          onSaved(res), onClose(), onOpenPayment(id), erpUrl } -> { close } */
export function openProofForm(opts) {
  const { api, prefill = {}, lockOrder = false, onSaved, onClose, onOpenPayment, erpUrl = '' } = opts;
  document.querySelectorAll('.pv-modal-wrap').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'pv-modal-wrap';
  wrap.innerHTML = '<div class="pv-modal-back"></div><div class="pv-modal" role="dialog" aria-modal="true" aria-labelledby="pvf-title">' +
    '<div class="pv-modal-head"><div><h3 id="pvf-title">' + esc(opts.title || 'Add payment proof') + '</h3><div class="muted">Saved as <b>pending</b> — a person checks it and verifies it; nothing is credited by saving.</div></div>' +
      '<button type="button" class="pv-x" data-close aria-label="Close">✕</button></div>' +
    '<div class="pv-modal-body" id="pvf-body">' + formHtml(opts) + '<div id="pvf-result" hidden></div></div>' +
    '<div class="pv-modal-foot" id="pvf-foot"><button type="button" class="btn" id="pvf-save">Save payment proof</button><button type="button" class="btn secondary" data-close>Cancel</button><span class="muted" id="pvf-status"></span></div></div>';
  document.body.appendChild(wrap);
  document.body.classList.add('pv-noscroll');
  const $ = (id) => wrap.querySelector('#' + id);

  const st = { order: null, summary: null, manual: false, images: [], methods: FALLBACK_METHODS, accounts: [], saved: null, saving: false, dirty: false, checkSeq: 0, orderSeq: 0 };
  let closed = false;

  function close(force) {
    if (closed) return;
    if (!force && st.dirty && !st.saved) { showBanner('discard'); return; }
    closed = true;
    st.images.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('paste', onPaste, true);
    wrap.remove();
    document.body.classList.remove('pv-noscroll');
    if (onClose) onClose(st.saved);
  }
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  function showBanner(kind, text) {
    const el = $('pvf-banner');
    if (!kind) { el.innerHTML = ''; return; }
    if (kind === 'discard') {
      el.innerHTML = '<div class="pv-banner pv-banner-warn"><b>Discard what you typed?</b> The pictures and details on this form have not been saved. <button type="button" class="btn small" data-keep>Keep editing</button> <button type="button" class="btn small secondary" data-discard>Discard</button></div>';
    } else {
      el.innerHTML = '<div class="pv-banner pv-banner-' + (kind === 'error' ? 'error' : 'ok') + '">' + esc(text) + '</div>';
    }
    el.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- options (methods, accounts)
  (async () => {
    try {
      const o = await api.formOptions();
      if (o && o.ok !== false) {
        if (o.methods && o.methods.length) st.methods = o.methods;
        st.accounts = o.accounts || [];
      }
    } catch (e) { /* the form still works with the built-in method list */ }
    fillSelects();
    applyPrefill();
  })();

  function fillSelects() {
    const mSel = $('pvf-method'), aSel = $('pvf-account');
    const cur = mSel.value, curA = aSel.value;
    mSel.innerHTML = '<option value="">Choose…</option>' + st.methods.map((m) => '<option value="' + esc(m.method) + '">' + esc(m.method) + '</option>').join('');
    aSel.innerHTML = '<option value="">Not sure / not listed</option>' + st.accounts.map((a) => '<option value="' + esc(a.id) + '" data-method="' + esc(a.method || '') + '">' + esc(a.name) + (a.masked ? ' (' + esc(a.masked) + ')' : '') + '</option>').join('');
    if (cur) mSel.value = cur;
    if (curA) aSel.value = curA;
    methodHint();
  }
  function methodHint() {
    const m = st.methods.find((x) => x.method === $('pvf-method').value);
    $('pvf-methodhint').textContent = m ? 'For ' + m.method + ': ' + (m.proof_required ? 'a picture' : 'a picture is optional') + (m.reference_required ? ' and the reference number are needed to verify.' : ', the reference number is optional.') : '';
  }

  // ---------------------------------------------------------------- the order
  function renderOrder() {
    const box = $('pvf-order');
    $('pvf-cust').hidden = !st.manual;
    if (st.order) {
      const o = st.order;
      const lines = st.summary ? orderSummaryLines(st.summary) : [];
      box.innerHTML = '<div class="pv-ordercard"><div class="pv-ordercard-head"><div>' + shopChip(o.shop_name) + ' ' + orderRefHtml(o) + ' · ' + esc(o.customer_name || 'Customer') + (o.customer_phone ? ' · ' + esc(o.customer_phone) : '') + '</div>' +
        (lockOrder ? '' : '<button type="button" class="btn small secondary" data-change-order>Change</button>') + '</div>' +
        '<div class="muted">' + (o.status ? 'Pancake status ' + pancakeStatusBadge(o.status) + ' · ' : '') + [o.order_amount != null ? 'order ' + money(o.order_amount) : '', o.prepaid ? 'paid online ' + money(o.prepaid) : '', o.order_date ? 'ordered ' + fmtDate(String(o.order_date).slice(0, 10)) : ''].filter(Boolean).map(esc).join(' · ') + '</div>' +
        (lines.length ? '<div class="pv-ordersum">' + lines.map((l) => '<span>' + esc(l[0]) + ' <b>' + esc(l[1]) + '</b></span>').join('') + '</div>' : '') +
        (st.summary && st.summary.payments && st.summary.payments.length ? '<div class="muted">Already on this order: ' + st.summary.payments.map((p) => esc(p.pv_code) + ' ' + money(p.amount) + (p.submitted_by ? ' (attached by ' + esc(p.submitted_by) + ')' : '') + ' ' + statusBadge(p.status)).join(' · ') + '</div>' : '') + '</div>';
      return;
    }
    box.innerHTML = '<div class="field"><label for="pvf-orderq">Find the order — order number, customer name or phone</label>' +
      '<input id="pvf-orderq" type="search" autocomplete="off" placeholder="e.g. 44430, Chris, 0920…"></div><div id="pvf-orderres" class="pv-orderres"></div>' +
      '<div class="muted"><button type="button" class="act-link" data-no-order>The customer has no order yet — type the customer instead</button></div>';
  }
  const searchOrders = debounce(async () => {
    const q = ($('pvf-orderq') || {}).value || '';
    const res = $('pvf-orderres');
    if (!res) return;
    if (q.trim().length < 2) { res.innerHTML = ''; return; }
    const seq = ++st.orderSeq;
    res.innerHTML = '<div class="muted">Looking…</div>';
    try {
      const rows = await api.findOrders(q.trim(), 12);
      if (seq !== st.orderSeq || !$('pvf-orderres')) return;
      const list = Array.isArray(rows) ? rows : (rows && rows.orders) || [];
      st.found = list;
      res.innerHTML = list.length ? list.map((o, i) => '<button type="button" class="pv-orderpick" data-pick="' + i + '"><b>#' + esc(o.order_ref) + '</b> ' + shopChip(o.shop_name) + ' ' + esc(o.customer_name || '') + '<span class="muted"> · ' +
        [o.customer_phone, pancakeStatusLabel(o.status), o.order_amount != null ? money(o.order_amount) : ''].filter(Boolean).map(esc).join(' · ') + '</span></button>').join('')
        : '<div class="muted">No order found. You can type the customer instead.</div>';
    } catch (e) { if (seq === st.orderSeq && $('pvf-orderres')) res.innerHTML = '<div class="msg error">' + esc(friendly(e)) + '</div>'; }
  }, 350);

  async function chooseOrder(o) {
    st.order = o; st.manual = false; st.summary = null; st.dirty = true;
    renderOrder();
    try {
      const s = await api.orderSummary(o.order_ref, o.order_shop_id);
      if (s && s.ok !== false && st.order === o) {
        st.summary = s; renderOrder();
        if (!$('pvf-amount').value && Number(s.remaining) > 0) $('pvf-amount').placeholder = 'Still to be paid: ' + money(s.remaining);
      }
    } catch (e) { /* the summary is a convenience */ }
    runCheck();
  }

  function applyPrefill() {
    if (st.prefilled) return;
    st.prefilled = true;
    if (prefill.amount) $('pvf-amount').value = prefill.amount;
    if (prefill.method) $('pvf-method').value = prefill.method;
    if (prefill.reference) $('pvf-ref').value = prefill.reference;
    $('pvf-date').value = prefill.date || manilaToday();
    if (prefill.customer_name) $('pvf-cname').value = prefill.customer_name;
    if (prefill.customer_phone) $('pvf-cphone').value = prefill.customer_phone;
    methodHint();
    if (prefill.order_ref) {
      (async () => {
        try {
          const rows = await api.findOrders(String(prefill.order_ref), 6);
          const list = Array.isArray(rows) ? rows : [];
          const hit = list.find((o) => String(o.order_ref) === String(prefill.order_ref) && (!prefill.order_shop || Number(o.order_shop_id) === Number(prefill.order_shop))) || list.find((o) => String(o.order_ref) === String(prefill.order_ref));
          if (hit) { await chooseOrder(hit); st.dirty = false; return; }
        } catch (e) { /* falls through to the search box */ }
        renderOrder();
      })();
    } else { st.manual = !!prefill.customer_name && !prefill.order_ref; renderOrder(); }
  }
  renderOrder();

  // ---------------------------------------------------------------- the pictures
  function renderPics() {
    const box = $('pvf-pics');
    box.innerHTML = '<div class="pv-drop" id="pvf-drop" tabindex="0" role="button" aria-label="Add pictures"><div><b>Drop the payment screenshot here</b>, click to choose a file, or press <b>Ctrl+V</b> to paste a copied picture.</div>' +
      '<div class="muted">JPG, PNG, WEBP or HEIC · 15 MB at most · up to ' + MAX_PICS + ' pictures · the original is kept exactly as it is</div>' +
      '<input type="file" id="pvf-file" accept="image/*" multiple hidden></div>' +
      (st.images.length ? '<div class="pv-pics">' + st.images.map((p, i) => '<div class="pv-pic' + (p.problem ? ' pv-pic-bad' : '') + '">' +
        (p.previewUrl ? '<img src="' + esc(p.previewUrl) + '" alt="' + esc(p.name) + '">' : '<div class="pv-noimg">No preview</div>') +
        '<div class="pv-pic-meta"><b>' + esc(p.name) + '</b><div class="muted">' + esc(fmtBytes(p.size)) + (p.width ? ' · ' + p.width + '×' + p.height : '') + '</div>' +
        (p.problem ? '<div class="pv-pic-prob">' + esc(p.problem) + '</div>' : p.pending ? '<div class="muted">Reading the picture…</div>' : '<div class="pv-pic-ok">' + (p.sha256 ? '✓ fingerprinted' : '⚠ no fingerprint') + (p.phash ? '' : ' (look-alike check off)') + '</div>') +
        (p.note && !p.problem ? '<div class="muted">' + esc(p.note) + '</div>' : '') + '</div>' +
        '<button type="button" class="pv-pic-x" data-rm="' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></div>').join('') + '</div>' : '');
  }
  async function addFiles(files) {
    const list = Array.from(files || []).filter((f) => f && (f.type || '').startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test((f && f.name) || ''));
    if (!list.length) { showBanner('error', 'That is not a picture. Add a photo or screenshot of the payment.'); return; }
    showBanner(null);
    for (const f of list) {
      if (st.images.length >= MAX_PICS) { showBanner('error', 'Up to ' + MAX_PICS + ' pictures can be added at once.'); break; }
      const slot = { name: f.name || 'proof.png', size: f.size, pending: true, previewUrl: null };
      st.images.push(slot); renderPics();
      const p = await prepareImage(f);
      const idx = st.images.indexOf(slot);
      if (idx < 0) { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); continue; }
      if (p.sha256 && st.images.some((o, k) => k !== idx && o.sha256 === p.sha256)) { st.images.splice(idx, 1); if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); showBanner('error', 'That same picture is already on this form.'); renderPics(); continue; }
      st.images[idx] = p; st.dirty = true; renderPics();
    }
    runCheck();
  }
  const onPaste = (e) => {
    if (!e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []).filter((f) => (f.type || '').startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  document.addEventListener('paste', onPaste, true);

  // ---------------------------------------------------------------- the live duplicate check
  const field = (id) => (($('pvf-' + id) || {}).value || '').trim();
  function values() {
    const o = st.order;
    return {
      reference: field('ref'), amount: field('amount'), orderRef: o ? o.order_ref : null, orderShop: o ? o.order_shop_id : null,
      customerName: o ? o.customer_name : field('cname'), customerPhone: o ? o.customer_phone : field('cphone'), method: field('method'),
    };
  }
  const key = (m) => (m.other && m.other.id) || (m.kind + '|' + ((m.other || {}).order_ref || '') + '|' + ((m.other || {}).reference || ''));
  const runCheck = debounce(async () => {
    const box = $('pvf-check');
    if (!box) return;
    const v = values();
    const imgs = st.images.filter((i) => i.sha256 || i.phash).slice(0, 4);
    if (!v.reference && !imgs.length) { box.innerHTML = '<div class="muted">Enter the reference number or add the picture — the duplicate check runs as soon as there is something to check.</div>'; st.check = null; return; }
    const seq = ++st.checkSeq;
    box.innerHTML = '<div class="muted">Checking every earlier payment…</div>';
    try {
      const calls = (imgs.length ? imgs : [null]).map((i) => api.checkPreview({ ...v, sha256: i && i.sha256, phash: i && i.phash }));
      const results = await Promise.all(calls);
      if (seq !== st.checkSeq || !$('pvf-check')) return;
      const bad = results.find((r) => r && r.ok === false);
      if (bad) { box.innerHTML = '<div class="msg error">' + esc(bad.message || 'The duplicate check could not run.') + '</div>'; return; }
      const merged = new Map(); let existing = null;
      for (const r of results) {
        existing = existing || r.existing;
        for (const m of r.matches || []) {
          const k = key(m), cur = merged.get(k);
          if (!cur || riskRank(m.severity) > riskRank(cur.severity)) merged.set(k, { ...m, types: [...new Set([...(cur ? cur.types : []), ...(m.types || [])])], blocking: !!(m.blocking || (cur && cur.blocking)) });
          else cur.types = [...new Set([...cur.types, ...(m.types || [])])];
        }
      }
      const matches = [...merged.values()].sort((a, b) => riskRank(b.severity) - riskRank(a.severity));
      st.check = { matches, existing };
      renderCheck();
    } catch (e) { if (seq === st.checkSeq && $('pvf-check')) $('pvf-check').innerHTML = '<div class="msg error">' + esc(friendly(e)) + '</div>'; }
  }, 450);
  function renderCheck() {
    const box = $('pvf-check'), c = st.check;
    if (!c) return;
    const real = c.matches.filter((m) => m.severity !== 'INFO' && !m.same_order);
    const same = c.matches.filter((m) => m.severity === 'INFO' || m.same_order);
    const ref = field('ref');
    let h = '';
    if (c.existing) h += '<div class="pv-banner pv-banner-ok"><b>PAYMENT PROOF ALREADY ATTACHED TO THIS ORDER</b> — ' + esc(c.existing.pv_code) + ' (' + esc(c.existing.status) + '). Saving will link this picture to it instead of creating a second payment.</div>';
    if (real.length) {
      const blocking = real.some((m) => m.blocking);
      h += '<div class="pv-banner pv-banner-' + (blocking ? 'error' : 'warn') + '"><b>' + (blocking ? 'DUPLICATE — ' : 'CHECK THIS — ') + 'this ' + (real.some((m) => (m.types || []).some((t) => /REFERENCE|ERP/.test(t))) ? 'reference' : 'picture') + ' is already used.</b> ' +
        (blocking ? 'You can still save it, but it will be marked POSSIBLE DUPLICATE and cannot be verified unless a supervisor or admin overrides it.' : 'You can save it; the person who verifies it must review this first.') + '</div>';
      h += real.map((m) => matchCardHtml(m, { reference: ref, open: !!(onOpenPayment || erpUrl) })).join('');
    }
    if (same.length && !c.existing) h += same.map((m) => matchCardHtml(m, { reference: ref })).join('');
    if (!real.length && !same.length && !c.existing) h = '<div class="pv-banner pv-banner-ok">✓ No other payment uses this ' + (field('ref') ? 'reference' : 'picture') + (field('ref') && st.images.some((i) => i.sha256) ? ' or picture' : '') + '.</div>';
    box.innerHTML = h;
  }

  // ---------------------------------------------------------------- saving
  async function save() {
    if (st.saving) return;
    showBanner(null);
    const v = values();
    if (!st.order && !v.customerName) { showBanner('error', 'Choose the order, or type the customer’s name.'); (($('pvf-orderq') || $('pvf-cname')) || {}).focus && ($('pvf-orderq') || $('pvf-cname')).focus(); return; }
    const pics = st.images.filter((i) => !i.problem && !i.pending);
    if (st.images.some((i) => i.pending)) { showBanner('error', 'Wait a moment — a picture is still being read.'); return; }
    if (st.images.some((i) => i.problem)) { showBanner('error', 'Remove the picture that cannot be used (' + st.images.find((i) => i.problem).problem + ')'); return; }
    if (!pics.length && !v.reference) { showBanner('error', 'Add the picture of the payment or the reference number.'); return; }
    const amount = v.amount === '' ? null : Number(v.amount);
    if (amount !== null && !(amount > 0 && amount <= 50000000)) { showBanner('error', 'Enter a valid amount paid.'); $('pvf-amount').focus(); return; }
    st.saving = true; $('pvf-save').disabled = true; $('pvf-status').textContent = pics.length ? 'Uploading ' + (pics.length === 1 ? 'the picture' : pics.length + ' pictures') + '…' : 'Saving…';
    try {
      const images = pics.length ? await api.uploadImages(pics) : [];
      $('pvf-status').textContent = 'Saving…';
      const res = await api.submit({
        source: opts.askSource ? field('source') || opts.source : (opts.source || 'MANUAL_ENTRY'), orderRef: v.orderRef, orderShop: v.orderShop, customerName: v.customerName, customerPhone: v.customerPhone,
        convPage: prefill.conv_page, convId: prefill.conv_id, amount, method: v.method, accountId: field('account') ? Number(field('account')) : null, reference: v.reference,
        date: field('date') || null, time: field('time') || null, notes: field('notes'), images,
      });
      if (!res || res.ok === false) throw new Error((res && res.message) || 'The payment proof could not be saved.');
      st.saved = res; st.dirty = false;
      showResult(res);
      if (onSaved) onSaved(res);
    } catch (e) {
      showBanner('error', friendly(e));
      $('pvf-save').disabled = false;
    } finally { st.saving = false; $('pvf-status').textContent = ''; }
  }

  function showResult(res) {
    $('pvf-body').querySelector('.pv-form').hidden = true;
    const box = $('pvf-result');
    box.hidden = false;
    const real = (res.matches || []).filter((m) => m.severity !== 'INFO' && !m.same_order);
    const ref = field('ref');
    box.innerHTML = '<div class="pv-saved"><div class="pv-saved-head">' + (res.existing ? '<h4>PAYMENT PROOF ALREADY ATTACHED TO THIS ORDER</h4>' : '<h4>Payment proof saved</h4>') +
      '<div><b>' + esc(res.pv_code) + '</b> ' + statusBadge(res.status) + ' ' + riskBadge(res.risk) + '</div></div>' +
      (res.existing ? '<p>This order already has this proof. The new picture (if any) was linked to ' + esc(res.pv_code) + ' — no second payment was created.</p>'
        : '<p>It is waiting in <b>' + (res.status === 'POSSIBLE_DUPLICATE' ? 'Possible Duplicates' : 'Pending Verification') + '</b>. A person will check the picture and the reference, then verify it.</p>') +
      (res.missing && res.missing.length ? '<div class="pv-banner pv-banner-warn">Still missing: ' + esc(res.missing.join(' and ')) + '. It cannot be verified until this is added.</div>' : '') +
      (real.length ? '<div class="pv-banner pv-banner-error"><b>POSSIBLE DUPLICATE.</b> It cannot be verified unless a supervisor or admin overrides the warning.</div>' + real.map((m) => matchCardHtml(m, { reference: ref, open: !!(onOpenPayment || erpUrl) })).join('') : '') +
      '<div class="pv-saved-actions">' + (onOpenPayment ? '<button type="button" class="btn" data-open-saved>Open this payment</button>' : erpUrl ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(erpUrl + 'payment-verification.html?open=' + res.id) + '">Open in Payment Verification ↗</a>' : '') +
      '<button type="button" class="btn secondary" data-again>Add another proof</button><button type="button" class="btn secondary" data-close>Done</button></div></div>';
    $('pvf-foot').hidden = true;
    box.scrollIntoView({ block: 'start' });
  }

  // ---------------------------------------------------------------- wiring
  wrap.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.pv-modal-back') || t.closest('[data-close]')) { close(t.closest('[data-close]') && st.saved ? true : undefined); return; }
    if (t.closest('[data-keep]')) { showBanner(null); return; }
    if (t.closest('[data-discard]')) { close(true); return; }
    if (t.closest('[data-change-order]')) { st.order = null; st.summary = null; renderOrder(); runCheck(); const q = $('pvf-orderq'); if (q) q.focus(); return; }
    if (t.closest('[data-no-order]')) { st.manual = true; st.order = null; renderOrder(); $('pvf-cname').focus(); runCheck(); return; }
    const pick = t.closest('[data-pick]');
    if (pick) { const o = (st.found || [])[Number(pick.dataset.pick)]; if (o) chooseOrder(o); return; }
    const rm = t.closest('[data-rm]');
    if (rm) { const [gone] = st.images.splice(Number(rm.dataset.rm), 1); if (gone && gone.previewUrl) URL.revokeObjectURL(gone.previewUrl); renderPics(); runCheck(); return; }
    if (t.closest('#pvf-drop') && !t.closest('input')) { $('pvf-file').click(); return; }
    if (t.closest('#pvf-save')) { save(); return; }
    if (t.closest('[data-again]')) { st.saved = null; st.images.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); }); st.images = []; st.check = null; $('pvf-result').hidden = true; $('pvf-foot').hidden = false; $('pvf-save').disabled = false;
      $('pvf-body').querySelector('.pv-form').hidden = false; ['ref', 'amount', 'notes', 'time'].forEach((k) => { $('pvf-' + k).value = ''; }); renderPics(); $('pvf-check').innerHTML = ''; showBanner(null); return; }
    const op = t.closest('[data-open-payment]');
    if (op) {
      if (onOpenPayment) { onOpenPayment(op.dataset.openPayment); close(true); } else if (erpUrl) window.open(erpUrl + 'payment-verification.html?open=' + encodeURIComponent(op.dataset.openPayment), '_blank', 'noopener');
      return;
    }
    if (t.closest('[data-open-saved]')) { if (onOpenPayment && st.saved) { onOpenPayment(st.saved.id); close(true); } }
  });
  wrap.addEventListener('input', (e) => {
    st.dirty = true;
    const id = e.target.id;
    if (id === 'pvf-orderq') searchOrders();
    else if (['pvf-ref', 'pvf-amount', 'pvf-cname', 'pvf-cphone'].includes(id)) runCheck();
  });
  wrap.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'pvf-file') { addFiles(e.target.files); e.target.value = ''; }
    else if (id === 'pvf-method') { methodHint(); runCheck(); }
    else if (id === 'pvf-account') {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.method && !$('pvf-method').value && st.methods.some((m) => m.method === opt.dataset.method)) { $('pvf-method').value = opt.dataset.method; methodHint(); }
    }
  });
  const drop = () => $('pvf-drop');
  wrap.addEventListener('dragover', (e) => { if (e.target.closest('#pvf-drop')) { e.preventDefault(); drop().classList.add('pv-drop-on'); } });
  wrap.addEventListener('dragleave', (e) => { if (e.target.closest('#pvf-drop')) drop().classList.remove('pv-drop-on'); });
  wrap.addEventListener('drop', (e) => { if (e.target.closest('#pvf-drop')) { e.preventDefault(); drop().classList.remove('pv-drop-on'); addFiles(e.dataTransfer.files); } });
  wrap.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'pvf-drop') { e.preventDefault(); $('pvf-file').click(); } });

  renderPics();
  $('pvf-check').innerHTML = '<div class="muted">Enter the reference number or add the picture — the duplicate check runs as soon as there is something to check.</div>';
  setTimeout(() => { const f = $('pvf-orderq') || $('pvf-amount'); if (f) f.focus(); }, 60);
  return { close: () => close(true) };
}

function formHtml(opts) {
  return '<div class="pv-form"><div id="pvf-banner"></div>' +
    '<section class="pv-sec"><h4>Order</h4><div id="pvf-order"></div></section>' +
    '<section class="pv-sec" id="pvf-cust" hidden><h4>Customer</h4><div class="pv-grid"><div class="field"><label for="pvf-cname">Customer name</label><input id="pvf-cname" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="pvf-cphone">Phone (optional)</label><input id="pvf-cphone" type="tel" autocomplete="off"></div></div></section>' +
    '<section class="pv-sec"><h4>Payment</h4><div class="pv-grid">' +
      '<div class="field"><label for="pvf-amount">Amount paid (₱)</label><input id="pvf-amount" type="number" inputmode="decimal" min="0" step="0.01"></div>' +
      '<div class="field"><label for="pvf-method">Payment method</label><select id="pvf-method"><option value="">Choose…</option></select></div>' +
      '<div class="field"><label for="pvf-account">Paid to account</label><select id="pvf-account"><option value="">Not sure / not listed</option></select></div>' +
      '<div class="field"><label for="pvf-ref">Reference number</label><input id="pvf-ref" type="text" autocomplete="off" spellcheck="false" placeholder="From the receipt"></div>' +
      '<div class="field"><label for="pvf-date">Date paid</label><input id="pvf-date" type="date"></div>' +
      '<div class="field"><label for="pvf-time">Time paid (optional)</label><input id="pvf-time" type="time"></div>' +
      (opts.askSource ? '<div class="field"><label for="pvf-source">Received from</label><select id="pvf-source">' + ['PANCAKE', 'MANUAL_ENTRY', 'OTHER'].map((k) => '<option value="' + k + '"' + (k === (opts.source || 'MANUAL_ENTRY') ? ' selected' : '') + '>' + esc(k === 'MANUAL_ENTRY' ? 'Entered by staff' : SOURCES[k]) + '</option>').join('') + '</select></div>' : '') +
    '</div><div class="muted" id="pvf-methodhint"></div>' +
    '<div class="field"><label for="pvf-notes">Notes (optional)</label><textarea id="pvf-notes" rows="2" maxlength="500" placeholder="Anything the person verifying should know"></textarea></div></section>' +
    '<section class="pv-sec"><h4>Proof pictures</h4><div id="pvf-pics"></div></section>' +
    '<section class="pv-sec"><h4>Duplicate check</h4><div id="pvf-check"></div></section></div>';
}
