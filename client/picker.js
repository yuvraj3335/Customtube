// A designed replacement for <select>: a pill button that opens a list of options, grouped, with an
// optional search box. On a laptop it floats under its button; on a phone it is a bottom sheet.
// It follows the ARIA combobox/listbox pattern: arrow keys move, Enter picks, Escape closes.

import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { icon } from './icons.js';

let open = null; // { pop, backdrop, button, stop }
let uid = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const isPhone = () => matchMedia('(width < 40rem)').matches;
const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const pickerOpen = () => Boolean(open);

export function closePicker({ restoreFocus = false } = {}) {
  if (!open) return;
  const { pop, backdrop, button, stop } = open;
  open = null;
  stop?.();
  pop.remove();
  backdrop?.remove();
  button.setAttribute('aria-expanded', 'false');
  if (restoreFocus && button.isConnected) button.focus();
}

/**
 * @param {{ id?: string, label: string, text: string, groups: { label?: string, options: { value: string, label: string, checked?: boolean, hint?: string }[] }[],
 *           searchable?: boolean, placeholder?: string, onSelect: (value: string) => void, dataset?: Record<string, string>, className?: string, prefix?: string }} opts
 *   `label` names the control for screen readers; `text` is what the button shows; `prefix` is a
 *   quiet word before it (like "Type"). Options with `checked` show a tick.
 */
export function picker({ id, label, text, groups, searchable = false, placeholder = 'Search', onSelect, dataset = {}, className = '', prefix = null }) {
  const button = el(
    'button',
    { type: 'button', id, class: `picker-btn ${className}`.trim(), 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': fold(text).startsWith(fold(label)) ? label : `${label}: ${text}` },
    prefix ? el('span', { class: 'picker-prefix' }, prefix) : null,
    el('span', { class: 'picker-text' }, text),
    icon('chevron', { class: 'picker-chevron' }),
  );
  for (const [k, v] of Object.entries(dataset)) button.dataset[k] = v;
  button.addEventListener('click', () => (open?.button === button ? closePicker({ restoreFocus: true }) : show()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  });

  function show() {
    closePicker();
    const n = ++uid;
    const listId = `picker-list-${n}`;
    const options = [];
    const list = el('div', { class: 'picker-list', role: 'listbox', id: listId, 'aria-label': label, tabindex: '-1' });
    for (const g of groups) {
      const groupEl = el('div', { role: 'group', class: 'picker-groupwrap', 'aria-label': g.label ?? null });
      if (g.label) groupEl.append(el('div', { class: 'picker-group', 'aria-hidden': 'true' }, g.label));
      for (const o of g.options) {
        const opt = el(
          'div',
          { class: 'picker-opt', role: 'option', id: `${listId}-${options.length}`, 'aria-selected': o.checked ? 'true' : 'false', 'data-value': o.value },
          el('span', { class: 'picker-opt-label' }, o.label),
          o.hint ? el('span', { class: 'picker-opt-hint' }, o.hint) : null,
          el('span', { class: 'picker-tick' }, o.checked ? icon('check') : null),
        );
        opt.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the search box
        opt.addEventListener('click', () => pick(o.value));
        options.push({ el: opt, group: groupEl, text: fold(o.label) });
        groupEl.append(opt);
      }
      list.append(groupEl);
    }
    const empty = el('p', { class: 'picker-empty', hidden: true }, 'Nothing matches');
    const search = searchable
      ? el('input', { type: 'search', class: 'picker-search', placeholder, 'aria-label': `Search ${label.toLowerCase()}`, role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' })
      : null;
    const sheet = isPhone();
    const pop = el(
      'div',
      { class: `picker-pop${sheet ? ' sheet' : ''}`, role: 'dialog', 'aria-label': label },
      sheet ? el('div', { class: 'picker-sheet-head' }, el('span', {}, label), el('button', { type: 'button', class: 'picker-close', 'aria-label': 'Close', onclick: () => closePicker({ restoreFocus: true }) }, icon('x'))) : null,
      search ? el('div', { class: 'picker-searchwrap' }, icon('search'), search) : null,
      list,
      empty,
    );
    const backdrop = sheet ? el('div', { class: 'picker-backdrop', onclick: () => closePicker({ restoreFocus: true }) }) : null;
    if (backdrop) document.body.append(backdrop);
    document.body.append(pop);

    let active = -1;
    const visible = () => options.filter((o) => !o.el.hidden);
    const owner = search ?? list;
    function setActive(i, { scroll = true } = {}) {
      const vis = visible();
      for (const o of options) o.el.classList.remove('active');
      if (!vis.length) {
        active = -1;
        owner.removeAttribute('aria-activedescendant');
        return;
      }
      active = Math.max(0, Math.min(i, vis.length - 1));
      const o = vis[active];
      o.el.classList.add('active');
      owner.setAttribute('aria-activedescendant', o.el.id);
      if (scroll) o.el.scrollIntoView({ block: 'nearest' });
    }
    function filter() {
      const q = fold(search.value.trim());
      for (const o of options) o.el.hidden = Boolean(q) && !q.split(/\s+/).every((w) => o.text.includes(w));
      for (const g of list.children) g.hidden = ![...g.querySelectorAll('.picker-opt')].some((x) => !x.hidden);
      empty.hidden = visible().length > 0;
      setActive(0);
    }
    function pick(value) {
      closePicker({ restoreFocus: true });
      onSelect(value);
    }
    const onKey = (e) => {
      const vis = visible();
      if (e.key === 'ArrowDown') setActive(active + 1);
      else if (e.key === 'ArrowUp') setActive(active - 1);
      else if (e.key === 'Home' && !search) setActive(0);
      else if (e.key === 'End' && !search) setActive(vis.length - 1);
      else if (e.key === 'PageDown') setActive(active + 8);
      else if (e.key === 'PageUp') setActive(active - 8);
      else if (e.key === 'Enter') {
        if (vis[active]) pick(vis[active].el.dataset.value);
      } else if (e.key === 'Escape') closePicker({ restoreFocus: true });
      else if (e.key === 'Tab') {
        closePicker({ restoreFocus: true });
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    list.addEventListener('keydown', onKey);
    search?.addEventListener('keydown', onKey);
    search?.addEventListener('input', filter);
    list.addEventListener('pointermove', (e) => {
      const o = e.target.closest('.picker-opt');
      if (o) setActive(visible().findIndex((x) => x.el === o), { scroll: false });
    });

    let stop = null;
    if (!sheet) {
      pop.style.minWidth = `${Math.max(button.offsetWidth, 220)}px`;
      const place = () =>
        computePosition(button, pop, {
          placement: 'bottom-start',
          strategy: 'fixed',
          middleware: [
            offset(6),
            flip({ padding: 12 }),
            shift({ padding: 12 }),
            size({ padding: 12, apply: ({ availableHeight }) => (pop.style.maxHeight = `${Math.max(180, Math.min(420, availableHeight))}px`) }),
          ],
        }).then(({ x, y }) => {
          pop.style.left = `${x}px`;
          pop.style.top = `${y}px`;
        });
      stop = autoUpdate(button, pop, place);
    }
    button.setAttribute('aria-expanded', 'true');
    open = { pop, backdrop, button, stop };
    const first = options.findIndex((o) => o.el.getAttribute('aria-selected') === 'true');
    setActive(first >= 0 && !searchable ? first : 0);
    // On a phone the keyboard would cover the sheet: focus the list, the search box is a tap away.
    (sheet ? list : owner).focus({ preventScroll: true });
  }

  return button;
}

// A click or tap outside an open picker closes it.
document.addEventListener('pointerdown', (e) => {
  if (open && !open.pop.contains(e.target) && !open.button.contains(e.target)) closePicker();
});
// Focus leaving the picker (Tab from a phone sheet, or another window) closes it.
document.addEventListener('focusin', (e) => {
  if (open && !open.pop.contains(e.target) && e.target !== open.button) closePicker();
});
