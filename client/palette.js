// Quick search (⌘K / Ctrl+K): app commands matched fuzzily with Fuse.js, plus videos and topics
// suggested by the server as you type. Arrow keys move, Enter opens, Escape closes.

import Fuse from 'fuse.js';
import { icon } from './icons.js';

/**
 * @param {{ h: Function, api: Function, navigate: (href: string) => void, thumbUrl: (vid: string) => string,
 *           commands: () => { label: string, hint?: string, icon: string, run: () => void, keywords?: string }[] }} deps
 */
export function createPalette({ h, api, navigate, thumbUrl, commands }) {
  const dialog = document.getElementById('palette');
  let items = [];
  let active = 0;
  let seq = 0;
  let timer = null;

  const input = h('input', {
    type: 'text',
    id: 'palette-q',
    placeholder: 'Search videos, topics, or type a command…',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-autocomplete': 'list',
    'aria-label': 'Quick search',
  });
  const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  dialog.append(
    h('div', { class: 'palette-input' }, icon('search'), input),
    list,
    h('div', { class: 'palette-foot' }, h('span', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' to move'), h('span', {}, h('kbd', {}, '↵'), ' to open'), h('span', {}, h('kbd', {}, 'esc'), ' to close')),
  );

  function render(groups) {
    items = groups.flatMap((g) => g.items);
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren();
    let n = 0;
    for (const g of groups) {
      if (!g.items.length) continue;
      list.append(h('li', { class: 'palette-group', role: 'presentation' }, g.title));
      for (const it of g.items) {
        const index = n++;
        const li = h(
          'li',
          {
            class: 'palette-item',
            role: 'option',
            id: `palette-opt-${index}`,
            'aria-selected': String(index === active),
            onmousemove: () => select(index),
            onclick: () => choose(index),
          },
          it.vid ? h('img', { src: thumbUrl(it.vid), alt: '', loading: 'lazy' }) : icon(it.icon || 'search'),
          h('span', { class: 'label' }, it.label),
          it.meta ? h('span', { class: 'meta' }, it.meta) : null,
        );
        list.append(li);
      }
    }
    if (!items.length) list.append(h('li', { class: 'palette-group', role: 'presentation' }, 'No matches'));
    input.setAttribute('aria-expanded', String(items.length > 0));
    if (items.length) input.setAttribute('aria-activedescendant', `palette-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function select(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    for (const el of list.querySelectorAll('.palette-item')) el.setAttribute('aria-selected', String(el.id === `palette-opt-${active}`));
    input.setAttribute('aria-activedescendant', `palette-opt-${active}`);
    document.getElementById(`palette-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    dialog.close();
    it.run();
  }

  async function update() {
    // Any reply still on its way is now stale, even if this query asks for nothing.
    const mine = ++seq;
    const q = input.value.trim();
    const cmds = commands();
    const fuse = new Fuse(cmds, { keys: ['label', 'keywords'], threshold: 0.4, ignoreLocation: true });
    const matched = q ? fuse.search(q, { limit: 5 }).map((r) => r.item) : cmds.slice(0, 6);
    const searchAll = q ? [{ label: `Search for “${q}”`, icon: 'search', run: () => navigate(`/search/${encodeURIComponent(q)}`) }] : [];
    render([
      { title: 'Search', items: searchAll },
      { title: 'Go to', items: matched },
    ]);
    if (q.length < 2) return;
    let res;
    try {
      res = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
    } catch {
      return; // suggestions are a bonus; the search and commands still work
    }
    if (mine !== seq || !dialog.open) return;
    render([
      { title: 'Search', items: searchAll },
      {
        title: 'Videos',
        items: res.videos.map((v) => ({ vid: v.vid, label: v.title, meta: v.channel, run: () => navigate(`/watch/${v.vid}`) })),
      },
      { title: 'Topics', items: res.topics.map((t) => ({ label: t.name, icon: 'topics', meta: `${t.count} videos`, run: () => navigate(`/c/${t.id}`) })) },
      { title: 'Go to', items: matched },
    ]);
  }

  input.addEventListener('input', () => {
    active = 0;
    seq++; // a reply for the previous text is stale from this keystroke on, not from the debounce
    clearTimeout(timer);
    timer = setTimeout(update, 90);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') select(active + 1);
    else if (e.key === 'ArrowUp') select(active - 1);
    else if (e.key === 'Enter') choose(active);
    else return;
    e.preventDefault();
  });

  return {
    open(initial = '') {
      if (dialog.open) return;
      input.value = initial;
      active = 0;
      dialog.showModal();
      input.focus();
      update();
    },
  };
}
