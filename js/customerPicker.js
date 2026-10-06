// "Pick the customer instead of typing them again": as someone types a name or a contact number, the
// customers already on file (Layaway, POS, Scrap, Refunds -- search_branch_customers(), which only ever
// returns what the signed-in employee may already read) are offered underneath, and picking one fills the
// name / contact / address boxes. Nothing new is collected and no customer table is created: the same
// person simply ends up spelled the same way everywhere.
import { searchBranchCustomers } from './api.js?v=20261007p';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** nameInput / contactInput / addressInput are the form's own <input>s (contact + address are optional). */
export function attachCustomerPicker({ nameInput, contactInput, addressInput, onPick }) {
  let seq = 0;

  function bind(input, minLen, isContact) {
    if (!input) return;
    const anchor = input.closest('.field') || input.parentElement;
    anchor.style.position = 'relative';
    const box = document.createElement('div');
    box.className = 'cust-suggest';
    box.hidden = true;
    anchor.appendChild(box);
    let timer = null;
    const hide = () => { box.hidden = true; box.innerHTML = ''; };

    function show(matches) {
      if (!matches.length) { hide(); return; }
      box.innerHTML = matches.map((m, i) =>
        '<button type="button" data-i="' + i + '">' +
          '<b>' + esc(m.name) + '</b>' + (m.contact ? ' · ' + esc(m.contact) : '') +
          '<span class="muted"> ' + (m.last_seen ? 'last seen ' + esc(m.last_seen) : '') + ' · ' + esc((m.sources || []).join(', ')) + '</span>' +
        '</button>').join('');
      box.hidden = false;
      box.querySelectorAll('button').forEach((btn) => btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); // keep focus where it is; the click below does the work
        const m = matches[Number(btn.dataset.i)];
        nameInput.value = m.name || '';
        if (contactInput && m.contact) contactInput.value = m.contact;
        if (addressInput && m.address) addressInput.value = m.address;
        hide();
        [nameInput, contactInput, addressInput].forEach((el) => el && el.dispatchEvent(new Event('input', { bubbles: true })));
        if (onPick) onPick(m);
      }));
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const enough = isContact ? q.replace(/\D/g, '').length >= minLen : q.length >= minLen;
      if (!enough) { hide(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const matches = await searchBranchCustomers(q, 6);
          if (mine === seq && document.activeElement === input) show(matches);
        } catch (err) { hide(); } // a failed lookup just means no suggestions
      }, 250);
    });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  }

  bind(nameInput, 2, false);
  bind(contactInput, 4, true);
}
