// Custom Tube client. No framework: a small router, one function per page, and the viewer's
// profile (likes, dislikes, history, watch later) kept in this browser's localStorage only.

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { hydrateIcons, icon } from './icons.js';
import { createPalette } from './palette.js';
import { createPlayer } from './player.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const SITE = 'Custom Tube';
const PROFILE_SEND = 200; // ids per /api/docs lookup, and opened videos sent with the feed
const VOTES_KEPT = 500; // likes and dislikes kept and sent in full (the server's limit)

// ---------- DOM helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- formatting ----------

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const compact = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => (/^\d{4}-\d{2}$/.test(ym || '') ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : '');
function fmtDuration(s) {
  if (!s) return '';
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const days = (Date.now() - t) / 86400000;
  if (days >= 365) return plural(Math.floor(days / 365), 'year') + ' ago';
  if (days >= 30) return plural(Math.floor(days / 30), 'month') + ' ago';
  return days >= 1 ? plural(Math.floor(days), 'day') + ' ago' : 'today';
}
const STANCES = { strong_rec: 'Strongly recommends', rec: 'Recommends', reference: 'Cites', joke: 'Joke', critical: 'Critical' };

// ---------- profile (this browser only) ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`customtube:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) ?? fallback);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`customtube:${key}`, JSON.stringify(value));
    } catch {
      // Storage can be full or blocked (private windows). The app still works for this visit.
    }
  },
};
const cleanIds = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && VID_RE.test(v)) : []);
const state = {
  likes: cleanIds(store.get('likes', [])),
  dislikes: cleanIds(store.get('dislikes', [])),
  seen: cleanIds(store.get('seen', [])),
  later: cleanIds(store.get('later', [])),
  frames: store.get('frames', true) !== false,
  prefs: null, // feed curation, see loadPrefs()
  custom: [], // videos and Shorts the viewer added by URL
  lists: [], // the viewer's own playlists: { id, name, vids, created }
  progress: {}, // vid -> [seconds watched, duration, when] for resume and progress bars
  queue: null, // { ids, name }: a list being played in order
  autoplay: true,
};

// ---------- feed curation (this browser only) ----------

const FORMAT_LABELS = { short: 'Shorts (up to 3 min)', standard: 'Regular videos', long: 'Long videos (over an hour)' };
const SOURCE_LABELS = {
  classics: ['HN classics', 'The most lasting recommendations'],
  recent: ['Recent favourites', 'Recommended on HN in the last 18 months'],
  explore: ['Explore', 'Topics you haven’t touched yet'],
  gems: ['Hidden gems', 'Few YouTube views, loved on HN (needs YouTube metadata)'],
  similar: ['Similar to your likes', 'Closest in meaning to videos you liked'],
  corec: ['Same recommenders', 'What the HN people behind your likes also recommend'],
  following: ['Topics you follow', 'Best videos from followed topics'],
  mine: ['My videos', 'Videos and Shorts you added yourself'],
};
const DEFAULT_PREFS = {
  formats: ['short', 'standard', 'long'],
  types: [], // empty = every type
  followTopics: [],
  muteTopics: [],
  muteChannels: [],
  mix: { classics: 2, recent: 2, explore: 1, gems: 1, similar: 4, corec: 2, following: 3, mine: 2 },
  news: false,
  cited: false,
};
const strList = (x, max = 200) => (Array.isArray(x) ? [...new Set(x.filter((s) => typeof s === 'string' && s && s.length <= 200))].slice(0, max) : []);

function sanitizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const mix = { ...DEFAULT_PREFS.mix };
  for (const k of Object.keys(mix)) {
    const w = Number(p.mix?.[k]);
    if (Number.isInteger(w) && w >= 0 && w <= 5) mix[k] = w;
  }
  const formats = strList(p.formats).filter((f) => f in FORMAT_LABELS);
  return {
    formats: formats.length ? formats : [...DEFAULT_PREFS.formats],
    types: strList(p.types).filter((t) => /^[a-z]+$/.test(t)),
    followTopics: strList(p.followTopics).filter((t) => /^[a-z0-9-]+$/.test(t)),
    // A topic can't be both followed and muted; following wins.
    muteTopics: strList(p.muteTopics).filter((t) => /^[a-z0-9-]+$/.test(t) && !strList(p.followTopics).includes(t)),
    muteChannels: strList(p.muteChannels),
    mix,
    news: p.news === true,
    cited: p.cited === true,
  };
}
function sanitizeCustom(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  for (const c of raw) {
    if (!c || !VID_RE.test(c.vid) || seenIds.has(c.vid)) continue;
    seenIds.add(c.vid);
    out.push({
      vid: c.vid,
      title: typeof c.title === 'string' && c.title ? c.title.slice(0, 300) : 'Untitled video',
      channel: typeof c.channel === 'string' ? c.channel.slice(0, 200) : '',
      short: c.short === true,
      added: typeof c.added === 'string' ? c.added : new Date().toISOString(),
    });
  }
  return out.slice(-500);
}
state.prefs = sanitizePrefs(store.get('prefs', null));
state.custom = sanitizeCustom(store.get('custom', []));
const LIST_ID_RE = /^[a-z0-9]{8}$/;
function sanitizeLists(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const ids = new Set();
  for (const l of raw) {
    if (!l || !LIST_ID_RE.test(l.id) || ids.has(l.id)) continue;
    ids.add(l.id);
    const name = typeof l.name === 'string' ? l.name.trim().slice(0, 80) : '';
    out.push({ id: l.id, name: name || 'Untitled list', vids: [...new Set(cleanIds(l.vids))].slice(0, 500), created: typeof l.created === 'string' ? l.created : new Date().toISOString() });
  }
  return out.slice(0, 100);
}
state.lists = sanitizeLists(store.get('lists', []));

const PROGRESS_KEPT = 300;
function sanitizeProgress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rows = Object.entries(raw).filter(
    ([vid, p]) => VID_RE.test(vid) && Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n) && n >= 0) && p[1] > 0 && p[0] <= p[1],
  );
  rows.sort((a, b) => b[1][2] - a[1][2]);
  for (const [vid, p] of rows.slice(0, PROGRESS_KEPT)) out[vid] = p;
  return out;
}
function sanitizeQueue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = [...new Set(cleanIds(raw.ids))].slice(0, 500);
  return ids.length ? { ids, name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : 'Queue' } : null;
}
state.progress = sanitizeProgress(store.get('progress', {}));
state.queue = sanitizeQueue(store.get('queue', null));
state.autoplay = store.get('autoplay', true) !== false;
const saveProgressStore = () => {
  state.progress = sanitizeProgress(state.progress);
  store.set('progress', state.progress);
};
const saveLists2 = () => store.set('lists', state.lists);
const newListId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};
function createList(name) {
  const list = { id: newListId(), name: String(name).trim().slice(0, 80) || 'Untitled list', vids: [], created: new Date().toISOString() };
  state.lists.push(list);
  saveLists2();
  renderSide();
  return list;
}
const savePrefs = () => store.set('prefs', state.prefs);
const saveCustom = () => store.set('custom', state.custom);

/** Feed request parameters for the viewer's curation, leaving defaults out. */
/**
 * The saved settings this server knows about. A kind or topic the server's data doesn't have
 * (an older or different export) is left out of the request rather than failing it, but stays
 * saved, so it comes back on a server that has it.
 */
let warnedAboutUnknown = false;
function knownPrefs(topicIds) {
  const p = { ...state.prefs };
  const types = new Set(config.curation?.types ?? []);
  if (types.size) p.types = p.types.filter((t) => types.has(t));
  if (topicIds) {
    p.followTopics = p.followTopics.filter((t) => topicIds.has(t));
    p.muteTopics = p.muteTopics.filter((t) => topicIds.has(t));
  }
  const dropped = ['types', 'followTopics', 'muteTopics'].reduce((n, k) => n + state.prefs[k].length - p[k].length, 0);
  if (dropped && !warnedAboutUnknown) {
    warnedAboutUnknown = true;
    toast(`${plural(dropped, 'saved setting')} not used: this server doesn't have ${dropped === 1 ? 'that topic or kind' : 'those topics or kinds'}`);
  }
  return p;
}

/** The feed request body for the viewer's curation, leaving defaults out. */
function curationBody(p = state.prefs) {
  const out = {};
  if (config.curation?.formats_available && p.formats.length < 3) out.formats = p.formats;
  if (p.types.length) out.types = p.types;
  if (p.followTopics.length) out.follow_topics = p.followTopics;
  if (p.muteTopics.length) out.mute_topics = p.muteTopics;
  if (p.muteChannels.length) out.mute_channels = p.muteChannels;
  const mix = Object.fromEntries(Object.entries(p.mix).filter(([k, w]) => k !== 'mine' && w !== DEFAULT_PREFS.mix[k]));
  if (Object.keys(mix).length) out.mix = mix;
  if (p.news) out.news = true;
  if (p.cited) out.cited = true;
  return out;
}

function toggleTopic(id, kind) {
  const [mine, other] = kind === 'follow' ? ['followTopics', 'muteTopics'] : ['muteTopics', 'followTopics'];
  const on = toggleIn(state.prefs[mine], id);
  if (on) state.prefs[other] = state.prefs[other].filter((t) => t !== id);
  savePrefs();
  return on;
}
function toggleChannel(name) {
  const on = toggleIn(state.prefs.muteChannels, name);
  savePrefs();
  return on;
}

/** Pull an 11-character video id (and whether it's a Short) out of anything YouTube-shaped. */
function parseYoutubeInput(input) {
  const text = String(input || '').trim();
  if (VID_RE.test(text)) return { vid: text, short: false };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let vid = null;
  let short = false;
  if (host === 'youtu.be') vid = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') vid = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0])) {
      vid = parts[1];
      short = parts[0] === 'shorts';
    }
  }
  return vid && VID_RE.test(vid) ? { vid, short } : null;
}
// A new seed per page load: reloading rerolls Home; scrolling and going back keep it.
const SEED = Math.random().toString(36).slice(2, 10) || 'seed';

function saveLists() {
  state.likes = state.likes.slice(-VOTES_KEPT);
  state.dislikes = state.dislikes.slice(-VOTES_KEPT);
  store.set('likes', state.likes);
  store.set('dislikes', state.dislikes);
  store.set('seen', state.seen.slice(-200));
  store.set('later', state.later.slice(-500));
}
function toggleIn(list, vid) {
  const i = list.indexOf(vid);
  if (i >= 0) list.splice(i, 1);
  else list.push(vid);
  return i < 0;
}
function setVote(vid, kind) {
  const [mine, other] = kind === 'like' ? [state.likes, state.dislikes] : [state.dislikes, state.likes];
  const on = toggleIn(mine, vid);
  if (on) {
    const j = other.indexOf(vid);
    if (j >= 0) other.splice(j, 1);
  }
  saveLists();
  return on;
}
function markSeen(vid) {
  state.seen = state.seen.filter((v) => v !== vid).concat(vid).slice(-200);
  saveLists();
}

// ---------- API ----------

async function api(path, payload) {
  const res = await fetch(
    path,
    payload === undefined
      ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
let config = { has_youtube_metadata: false, search_mode: 'keyword', filters: { type: [], level: [], evergreen: ['1'], sort: ['best'], search_sort: ['relevance'] } };

// ---------- shared components ----------

const thumbUrl = (vid, frame) => `https://i.ytimg.com/vi/${vid}/${frame ? 'hq2' : 'hqdefault'}.jpg`;
function thumbImg(vid, { eager = false } = {}) {
  const img = h('img', { src: thumbUrl(vid, state.frames), alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async', width: 480, height: 360 });
  img.addEventListener('error', () => {
    if (img.src.endsWith('/hq2.jpg')) img.src = thumbUrl(vid, false);
  });
  return img;
}

function laterButton(vid) {
  const on = state.later.includes(vid);
  return h(
    'button',
    { type: 'button', class: `later-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': on ? 'Remove from Watch later' : 'Save to Watch later', title: on ? 'Saved to Watch later' : 'Watch later', dataset: { later: vid } },
    icon(on ? 'check' : 'clock'),
  );
}

function hnLine(item) {
  if (item.custom) return item.short ? 'Short · added by you' : 'Added by you';
  return item.recommenders ? `${plural(item.recommenders, 'HN recommender')} · ${plural(item.rec_months, 'month')}` : 'Cited on HN, not recommended';
}

/** How much of a video you've watched, as a thin bar on its thumbnail. */
function progressBar(vid) {
  const p = state.progress[vid];
  if (!p) return null;
  const bar = h('span');
  bar.style.width = `${Math.min(100, Math.round((p[0] / p[1]) * 100))}%`;
  return h('div', { class: 'progress', role: 'img', 'aria-label': p[0] >= p[1] ? 'Watched' : `${Math.round((p[0] / p[1]) * 100)}% watched` }, bar);
}

function card(item) {
  const meta = [item.channel, item.yt?.views != null ? `${compact(item.yt.views)} views` : null, item.yt?.published ? ago(item.yt.published) : null].filter(Boolean).join(' · ');
  return h(
    'article',
    { class: 'card', dataset: { vid: item.vid, channel: item.channel || '' } },
    h(
      'a',
      { class: 'card-link', href: `/watch/${item.vid}`, title: item.reason || null },
      h(
        'div',
        { class: 'thumb' },
        thumbImg(item.vid),
        item.short || item.format === 'short' ? h('span', { class: 'badge' }, 'Short') : null,
        item.yt?.duration_s ? h('span', { class: 'dur' }, fmtDuration(item.yt.duration_s)) : null,
        progressBar(item.vid),
      ),
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'card-title' }, item.title),
        h('p', { class: 'card-meta' }, meta),
        h('p', { class: 'card-meta' }, hnLine(item)),
        item.reason ? h('p', { class: 'card-reason' }, item.reason) : null,
        item.via ? h('p', { class: 'card-reason' }, `Topic match · ${item.via}`) : null,
      ),
    ),
    laterButton(item.vid),
    h('button', { type: 'button', class: 'more-btn', 'aria-label': `More actions for ${item.title}`, 'aria-haspopup': 'menu', dataset: { more: item.vid } }, icon('more')),
  );
}

// ---------- card menu and "Save to list" dialog ----------

let openMenu = null;
function closeMenu({ restoreFocus = true } = {}) {
  if (!openMenu) return;
  const { el, button, stopFollowing } = openMenu;
  openMenu = null;
  stopFollowing?.();
  el.remove();
  button?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && button?.isConnected) button.focus({ preventScroll: true });
}

function showMenu(button, items, label) {
  closeMenu({ restoreFocus: false });
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', 'aria-label': label },
    items.map(([label, run, iconName]) =>
      h('button', {
        type: 'button',
        role: 'menuitem',
        class: 'menu-item',
        onclick: () => {
          closeMenu();
          run();
        },
      }, iconName ? icon(iconName) : null, label),
    ),
  );
  document.body.append(menu);
  // Floating UI keeps the menu next to its button and inside the screen (it flips above the
  // button near the bottom edge and follows it on scroll).
  const place = () =>
    computePosition(button, menu, { placement: 'bottom-end', middleware: [offset(4), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    });
  const stopFollowing = autoUpdate(button, menu, place);
  button.setAttribute('aria-expanded', 'true');
  openMenu = { el: menu, button, stopFollowing };
  // Tabbing out of the menu closes it, leaving focus where Tab put it.
  menu.addEventListener('focusout', (e) => {
    if (openMenu?.el === menu && !menu.contains(e.relatedTarget)) closeMenu({ restoreFocus: false });
  });
  menu.querySelector('button')?.focus();
}

/** Pages listing your own saved things: hiding a video there would only confuse. */
const onSavedPage = () => ['/liked', '/later', '/history', '/mine', '/library'].includes(location.pathname) || location.pathname.startsWith('/list/');

/** Remove a card, remember where it was, and move focus to its neighbour. */
function detachCards(cards) {
  const spots = cards.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
  const focusEl = cards.length ? (cards[cards.length - 1].nextElementSibling || cards[0].previousElementSibling) : null;
  for (const c of cards) c.remove();
  focusEl?.querySelector('.card-link')?.focus();
  return () => {
    for (const { el, parent, next } of spots.reverse()) if (parent?.isConnected) parent.insertBefore(el, next?.parentNode === parent ? next : null);
  };
}

function cardMenu(button) {
  const el = button.closest('.card');
  const vid = el.dataset.vid;
  const channel = el.dataset.channel;
  const title = el.querySelector('.card-title')?.textContent ?? 'this video';
  const later = state.later.includes(vid);
  const items = [
    [later ? 'Remove from Watch later' : 'Save to Watch later', () => toggleLater(vid), 'clock'],
    ['Save to list…', () => saveToListDialog(vid, button), 'list-plus'],
  ];
  if (!onSavedPage()) {
    items.push([
      'Not interested',
      () => {
        // Remember exactly what was there, so Undo restores it rather than toggling.
        const before = { liked: state.likes.includes(vid), disliked: state.dislikes.includes(vid) };
        if (!before.disliked) setVote(vid, 'dislike');
        const reattach = detachCards([el]);
        toast('Hidden. Similar videos show up less.', () => {
          state.dislikes = state.dislikes.filter((v) => v !== vid);
          if (before.disliked) state.dislikes.push(vid);
          if (before.liked && !state.likes.includes(vid)) state.likes.push(vid);
          saveLists();
          reattach();
        });
      },
      'eye-off',
    ]);
    if (channel) {
      items.push([
        `Hide ${channel}`,
        () => {
          const wasMuted = state.prefs.muteChannels.includes(channel);
          if (!wasMuted) toggleChannel(channel);
          const reattach = detachCards([...view.querySelectorAll('.card')].filter((c) => c.dataset.channel === channel));
          toast(`${channel} won't appear in your feed`, () => {
            if (!wasMuted && state.prefs.muteChannels.includes(channel)) toggleChannel(channel);
            reattach();
          });
        },
        'ban',
      ]);
    }
  }
  showMenu(button, items, `Actions for ${title}`);
}

// Native <dialog> + showModal(): focus stays inside, Escape closes it, the page behind is inert.
const dialogOpeners = new WeakMap();
function openModal(d, opener) {
  dialogOpeners.set(d, opener ?? document.activeElement);
  if (!d.open) d.showModal();
}
for (const d of [$('#dialog'), $('#help')]) {
  d.addEventListener('close', () => {
    d.replaceChildren();
    const opener = dialogOpeners.get(d);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  // a click on the backdrop (the dialog element itself, outside its card) closes it
  d.addEventListener('click', (e) => e.target === d && d.close());
}
function closeDialog() {
  for (const d of [$('#dialog'), $('#help')]) if (d.open) d.close();
}
const anyDialogOpen = () => $('#dialog').open || $('#help').open;

function saveToListDialog(vid, opener) {
  const d = $('#dialog');
  const render = () => {
    const name = h('input', { type: 'text', id: 'new-list-name', placeholder: 'New list name', maxlength: 80, 'aria-label': 'New list name' });
    const form = h('form', { class: 'addform' }, name, h('button', { type: 'submit', class: 'pill on' }, 'Create'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      const list = createList(name.value);
      list.vids.push(vid);
      saveLists2();
      toast(`Saved to ${list.name}`);
      render();
      d.querySelector(`input[data-list="${list.id}"]`)?.focus();
    });
    d.replaceChildren(
      h(
        'div',
        { class: 'dialog-card' },
        h('h2', { id: 'dialog-title' }, 'Save to…'),
        state.lists.length
          ? h(
              'div',
              { class: 'list-options' },
              state.lists.map((l) => {
                const box = h('input', { type: 'checkbox', dataset: { list: l.id } });
                box.checked = l.vids.includes(vid);
                box.addEventListener('change', () => {
                  if (box.checked && !l.vids.includes(vid)) l.vids.push(vid);
                  if (!box.checked) l.vids = l.vids.filter((v) => v !== vid);
                  saveLists2();
                });
                return h('label', { class: 'option' }, box, h('span', {}, l.name), h('span', { class: 'count' }, l.vids.length));
              }),
            )
          : h('p', { class: 'hint' }, 'No lists yet. Make one:'),
        form,
        h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'pill', onclick: closeDialog }, 'Done')),
      ),
    );
  };
  render();
  openModal(d, opener);
  (d.querySelector('input[type="checkbox"]') || d.querySelector('#new-list-name'))?.focus();
}

function playAllLink(getVids) {
  const a = h('a', { class: 'pill', href: 'https://www.youtube.com/', target: '_blank', rel: 'noopener', title: 'Open up to 50 videos from this page as a YouTube playlist' }, icon('play'), 'Play all on YouTube');
  a.addEventListener('click', (e) => {
    const vids = [...new Set(getVids())].slice(0, 50);
    if (!vids.length) {
      e.preventDefault();
      return;
    }
    // YouTube turns watch_videos into a temporary playlist, no account or API needed.
    a.href = `https://www.youtube.com/watch_videos?video_ids=${vids.join(',')}`;
  });
  return a;
}
const vidsOnPage = () => [...view.querySelectorAll('.card[data-vid]')].map((el) => el.dataset.vid);

function pageHead(title, sub, ...extra) {
  document.title = `${title} · ${SITE}`;
  return h('div', { class: 'pagehead' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'pagehead-actions' }, extra));
}

let routeToken = 0;
const cleanups = [];
const current = (token) => token === routeToken;

/** A plain-language message for a failed request. */
function failure(err) {
  if (err instanceof TypeError) return 'You seem to be offline, or the server can’t be reached.';
  if (err.status === 429) return 'Lots of requests right now. Give it a moment.';
  return err.message;
}

/**
 * A grid that loads pages from `load(offset)` as you scroll. A failed page shows a Retry
 * button instead of ending the list. Returns a controller whose resume() re-attaches the
 * grid after the page is restored from the back/forward cache.
 */
function infiniteGrid(container, load, { empty, token }) {
  const ctx = { token };
  const grid = h('div', { class: 'grid' });
  const status = h('p', { class: 'status', role: 'status' }, 'Loading…');
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  container.append(h('h2', { class: 'visually-hidden' }, 'Videos'), grid, status, sentinel);
  // Placeholder cards until the first page arrives, so the layout doesn't jump.
  const skeletons = Array.from({ length: 8 }, () =>
    h('div', { class: 'skeleton-card', 'aria-hidden': 'true' }, h('div', { class: 'thumb' }), h('div', { class: 'bar' }), h('div', { class: 'bar short' })),
  );
  grid.append(...skeletons);
  status.hidden = true;
  let offset = 0;
  let rendered = 0;
  let busy = false;
  let done = false;
  let failed = false;
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '800px' });
  async function more() {
    if (busy || done || failed || !current(ctx.token)) return;
    busy = true;
    try {
      const page = await load(offset);
      if (!current(ctx.token)) return;
      for (const s of skeletons.splice(0)) s.remove();
      for (const item of page.items) grid.append(card(item));
      rendered += page.items.length;
      // `consumed` lets a loader add its own items (My videos) without shifting server offsets.
      offset += page.consumed ?? page.items.length;
      done = page.next_offset === null || page.next_offset === undefined || page.items.length === 0;
      status.replaceChildren(done ? (rendered ? '' : empty) : 'Loading…');
      status.hidden = done && rendered > 0;
    } catch (err) {
      if (!current(ctx.token)) return;
      for (const s of skeletons.splice(0)) s.remove();
      failed = true;
      status.hidden = false;
      status.replaceChildren(
        `Couldn’t load ${rendered ? 'more ' : ''}videos. ${failure(err)} `,
        h('button', {
          type: 'button',
          class: 'pill',
          onclick: () => {
            failed = false;
            status.replaceChildren('Loading…');
            more();
          },
        }, 'Retry'),
      );
    } finally {
      busy = false;
    }
    if (done) observer.disconnect();
    else if (!failed && sentinel.getBoundingClientRect().top < innerHeight + 800) more();
  }
  const attach = () => {
    observer.observe(sentinel);
    cleanups.push(() => observer.disconnect());
  };
  attach();
  const first = more();
  return {
    first,
    resume(newToken) {
      ctx.token = newToken;
      if (!done) attach();
    },
  };
}

// ---------- filters ----------

const FILTER_LABELS = {
  type: 'Type',
  level: 'Level',
  date: 'Uploaded',
  dur: 'Length',
  sort: 'Sort by',
};
const OPTION_LABELS = {
  date: { year: 'Past year', '2020s': '2020s', '2010s': '2010s', '2000s': '2000s' },
  dur: { short: 'Under 4 min', medium: '4–20 min', long: '20–60 min', xlong: 'Over an hour' },
  sort: { relevance: 'Relevance', best: 'Best first', hn: 'Most HN recommenders', recent: 'Recently recommended', date: 'Newest upload', old: 'Oldest upload', views: 'Most viewed', liked: 'Like ratio' },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function currentFilters() {
  const p = new URLSearchParams(location.search);
  const out = {};
  for (const k of ['type', 'level', 'date', 'dur', 'gems', 'evergreen', 'sort']) if (p.get(k)) out[k] = p.get(k);
  return out;
}

function filterBar({ search = false } = {}) {
  const active = currentFilters();
  const go = (key, value) => navigate(location.pathname + qs({ ...active, [key]: value }));
  const select = (key, values) => {
    if (!values?.length) return null;
    const labels = OPTION_LABELS[key] || {};
    const sel = h(
      'select',
      { 'aria-label': FILTER_LABELS[key], dataset: { filter: key } },
      key === 'sort' ? null : h('option', { value: '' }, `Any ${FILTER_LABELS[key].toLowerCase()}`),
      values.map((v) => h('option', { value: v }, labels[v] || cap(v))),
    );
    sel.value = active[key] || (key === 'sort' ? values[0] : '');
    sel.addEventListener('change', () => go(key, key === 'sort' && sel.value === values[0] ? '' : sel.value));
    return h('label', { class: 'filter' }, h('span', {}, FILTER_LABELS[key]), sel);
  };
  const check = (key, label) => {
    const box = h('input', { type: 'checkbox', dataset: { filter: key } });
    box.checked = active[key] === '1';
    box.addEventListener('change', () => go(key, box.checked ? '1' : ''));
    return h('label', { class: 'filter check' }, box, h('span', {}, label));
  };
  const f = config.filters;
  return h(
    'div',
    { class: 'filterbar' },
    select('type', f.type),
    select('dur', f.dur),
    select('date', f.date),
    select('level', f.level),
    check('evergreen', 'Hide news'),
    f.gems ? check('gems', 'Hidden gems') : null,
    select('sort', search ? f.search_sort : f.sort),
  );
}

// ---------- pages ----------

// Home is kept when you leave it, so Back returns to the same cards at the same scroll position
// (as long as your likes, dislikes and settings haven't changed in the meantime).
let homeCache = null;
const homeKey = () => JSON.stringify([state.likes, state.dislikes, state.prefs, state.custom.map((c) => c.vid), SEED]);

const homeTab = () => {
  const t = new URLSearchParams(location.search).get('tab');
  return t === 'following' ? 'following' : 'foryou';
};

async function home(token, { restore = false } = {}) {
  if (restore && homeCache?.key === homeKey() + location.search) {
    view.replaceChildren(homeCache.section);
    document.title = `${SITE}: videos Hacker News recommends`;
    homeCache.grid.resume(token);
    return;
  }
  homeCache = null;
  const tab = homeTab();
  const warm = state.likes.length > 0;
  const section = h('section', { class: 'home' });
  view.replaceChildren(section);
  document.title = `${SITE}: videos Hacker News recommends`;

  const tabs = h(
    'div',
    { class: 'home-tabs', role: 'tablist', 'aria-label': 'Feeds' },
    [
      ['foryou', 'For you', '/'],
      ['following', 'Following', '/?tab=following'],
    ].map(([id, label, href]) => h('a', { class: `chip${tab === id ? ' on' : ''}`, href, role: 'tab', 'aria-selected': String(tab === id) }, label)),
    h('a', { class: 'chip', href: '/settings' }, icon('sliders'), 'Customize'),
  );
  section.append(tabs);

  const areas = await getBrowse().catch(() => null);
  if (!current(token)) return;

  // First visit: pick a few topics so the very first feed is already yours.
  const fresh = !state.likes.length && !state.prefs.followTopics.length && !state.seen.length && !store.get('welcomed', false);
  if (fresh && tab === 'foryou' && areas) section.append(welcomePanel(areas));

  // Continue watching
  const resumable = Object.entries(state.progress)
    .filter(([vid]) => resumeAt(vid) > 0)
    .sort((a, b) => b[1][2] - a[1][2])
    .slice(0, 8)
    .map(([vid]) => vid);
  if (resumable.length && tab === 'foryou') {
    const shelf = h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, 'Continue watching')));
    section.append(shelf);
    resolveCards(resumable, token).then((items) => {
      if (items?.length && current(token)) shelf.append(h('div', { class: 'row-scroll' }, items.map(card)));
      else shelf.remove();
    });
  }

  if (tab === 'following' && !state.prefs.followTopics.length) {
    section.append(h('div', { class: 'empty' }, h('h2', {}, 'Follow a few topics'), h('p', { class: 'sub mx-auto' }, 'Videos from the topics you follow will show up here.'), areas ? topicPicker(areas, 18) : null));
    return;
  }

  section.append(
    pageHead(
      tab === 'following' ? 'From topics you follow' : warm ? 'Your feed' : 'Start here',
      tab === 'following'
        ? `${plural(state.prefs.followTopics.length, 'topic')} · manage them under Customize`
        : warm
          ? `Tuned by ${plural(state.likes.length, 'like')}${state.dislikes.length ? ` and ${plural(state.dislikes.length, 'dislike')}` : ''}. Each card says why it’s here.`
          : 'HN classics, recent favourites and topics to explore. Like a few videos to tune this feed.',
      playAllLink(vidsOnPage),
    ),
  );
  const prefs = knownPrefs(areas ? new Set(areas.flatMap((a) => a.categories.map((c) => c.id))) : null);
  const body = curationBody(prefs);
  // "Following": the same curation, with only the followed-topics source turned on.
  if (tab === 'following') body.mix = { classics: 0, recent: 0, explore: 0, gems: 0, similar: 0, corec: 0, following: 5 };
  const profile = {
    like: state.likes.slice(-VOTES_KEPT),
    dislike: state.dislikes.slice(-VOTES_KEPT),
    seen: state.seen.slice(-PROFILE_SEND),
    seed: SEED,
    ...body,
  };
  const mine = tab === 'foryou' ? myFeedPicks() : [];
  // My videos go in every `every`-th slot: weight 5 → every 2nd card, weight 1 → every 10th.
  const every = state.prefs.mix.mine > 0 ? Math.max(2, 12 - 2 * state.prefs.mix.mine) : Infinity;
  let shown = 0;
  const key = homeKey() + location.search;
  const grid = infiniteGrid(
    section,
    async (offset) => {
      let page;
      try {
        page = await api('/api/feed', { ...profile, offset, n: 24 });
      } catch (err) {
        if (err.status === 400) err.message = `${err.message}. Check or reset your settings under Customize`;
        throw err;
      }
      const items = [];
      for (const item of page.items) {
        items.push(item);
        shown++;
        if (shown % every === 0 && mine.length) items.push(mine.shift());
      }
      if (page.next_offset === null) items.push(...mine.splice(0));
      return { ...page, items, consumed: page.items.length };
    },
    {
      empty: Object.values(state.prefs.mix).every((w) => w === 0)
        ? 'Every feed source is turned off. Turn some back on in Customize feed.'
        : 'Nothing matches your feed settings. Loosen them in Customize feed, or clear your history.',
      token,
    },
  );
  homeCache = { key, section, grid };
  await grid.first;
}

/** Toggle chips for the biggest topics; following one takes effect on the next feed. */
function topicPicker(areas, n) {
  const top = areas
    .flatMap((a) => a.categories)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
  return h(
    'div',
    { class: 'chips' },
    top.map((c) => {
      const btn = h('button', { type: 'button', class: `chip${state.prefs.followTopics.includes(c.id) ? ' on' : ''}`, 'aria-pressed': String(state.prefs.followTopics.includes(c.id)), dataset: { topic: c.id } }, c.name);
      btn.addEventListener('click', () => {
        const on = toggleTopic(c.id, 'follow');
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        renderSide();
      });
      return btn;
    }),
  );
}

function welcomePanel(areas) {
  const done = () => {
    store.set('welcomed', true);
    homeCache = null;
    route({ keepScroll: true });
  };
  return h(
    'section',
    { class: 'welcome', 'aria-labelledby': 'welcome-title' },
    h('h2', { id: 'welcome-title' }, 'What are you into?'),
    h('p', { class: 'sub' }, 'Pick a few topics and your feed starts from them. You can change everything later under Customize.'),
    topicPicker(areas, 18),
    h('div', { class: 'actions mt-4' }, h('button', { type: 'button', class: 'pill primary', id: 'welcome-done', onclick: done }, icon('sparkles'), 'Build my feed'), h('button', { type: 'button', class: 'pill', onclick: done }, 'Skip')),
  );
}

/** The viewer's own videos for Home: not yet opened, allowed by the format settings, newest first. */
function myFeedPicks() {
  const formats = new Set(state.prefs.formats);
  // A Short is known from its /shorts/ link; any other added video's length is unknown, so it
  // shows unless both regular and long videos are turned off.
  const allowed = (c) => (c.short ? formats.has('short') : formats.has('standard') || formats.has('long'));
  return state.custom
    .filter((c) => !state.seen.includes(c.vid) && !state.likes.includes(c.vid) && !state.dislikes.includes(c.vid) && allowed(c))
    .filter((c) => !state.prefs.muteChannels.includes(c.channel))
    .reverse()
    .map((c) => ({ vid: c.vid, title: c.title, channel: c.channel, custom: true, short: c.short, reason: c.short ? 'A Short you added' : 'A video you added' }));
}

async function listPage(token, { title, sub, params, crumb }) {
  const section = h('section', {}, crumb || null, pageHead(title, sub, playAllLink(vidsOnPage)), filterBar());
  view.replaceChildren(section);
  await infiniteGrid(section, (offset) => api(`/api/list${qs({ ...params, ...currentFilters(), offset, n: 24 })}`), { empty: 'No videos match these filters.', token }).first;
}

let browseCache = null;
const getBrowse = async () => (browseCache ??= await api('/api/browse'));

async function categoryPage(token, id) {
  const areas = await getBrowse();
  const area = areas.find((a) => a.categories.some((c) => c.id === id));
  if (!current(token)) return;
  if (!area) return notFound('No such topic.');
  const cat = area.categories.find((c) => c.id === id);
  await listPage(token, {
    title: cat.name,
    sub: cat.description,
    params: { cat: id },
    crumb: h('a', { class: 'crumb', href: `/a/${area.id}` }, area.name),
  });
  if (current(token)) $('.pagehead-actions')?.prepend(...topicButtons(id, cat.name));
}

function topicButtons(id, name) {
  const follow = h('button', { type: 'button', class: 'pill', id: 'follow-topic' });
  const mute = h('button', { type: 'button', class: 'pill', id: 'mute-topic' });
  const render = () => {
    const f = state.prefs.followTopics.includes(id);
    const m = state.prefs.muteTopics.includes(id);
    follow.textContent = f ? 'Following' : 'Follow topic';
    follow.classList.toggle('on', f);
    follow.setAttribute('aria-pressed', String(f));
    mute.textContent = m ? 'Muted' : 'Mute topic';
    mute.classList.toggle('on', m);
    mute.setAttribute('aria-pressed', String(m));
  };
  follow.addEventListener('click', () => {
    toast(toggleTopic(id, 'follow') ? `Following ${name}. It gets its own spot in your feed.` : `Stopped following ${name}`);
    render();
  });
  mute.addEventListener('click', () => {
    toast(toggleTopic(id, 'mute') ? `${name} won't appear in your feed` : `${name} can appear in your feed again`);
    render();
  });
  render();
  return [follow, mute];
}

async function areaPage(token, id) {
  const areas = await getBrowse();
  const area = areas.find((a) => a.id === id);
  if (!current(token)) return;
  if (!area) return notFound('No such topic area.');
  const section = h(
    'section',
    {},
    h('a', { class: 'crumb', href: '/topics' }, 'Topics'),
    pageHead(area.name, plural(area.count, 'video'), playAllLink(vidsOnPage)),
    h('div', { class: 'chips' }, area.categories.map((c) => h('a', { class: 'chip', href: `/c/${c.id}` }, c.name, h('span', { class: 'count' }, c.count)))),
    filterBar(),
  );
  view.replaceChildren(section);
  await infiniteGrid(section, (offset) => api(`/api/list${qs({ area: id, ...currentFilters(), offset, n: 24 })}`), { empty: 'No videos match these filters.', token }).first;
}

// Ready-made views of the whole collection; the last three need YouTube metadata.
const QUICK_LINKS = [
  ['Recently recommended', '/browse?sort=recent'],
  ['Most HN recommenders', '/browse?sort=hn'],
  ['Hide news', '/browse?evergreen=1'],
  ['Lectures', '/browse?type=lecture'],
  ['Documentaries', '/browse?type=documentary'],
  ['Hidden gems', '/browse?gems=1', true],
  ['Over an hour', '/browse?dur=xlong', true],
  ['Under 4 minutes', '/browse?dur=short', true],
];
function browseTitle() {
  const href = location.pathname + location.search;
  return QUICK_LINKS.find(([, h2]) => h2 === href)?.[0] ?? 'All videos';
}

async function topicsPage(token) {
  const areas = await getBrowse();
  if (!current(token)) return;
  view.replaceChildren(
    h(
      'section',
      {},
      pageHead('Topics', `${plural(areas.reduce((n, a) => n + a.categories.length, 0), 'topic')} in ${areas.length} areas`),
      h(
        'div',
        { class: 'chips quick' },
        QUICK_LINKS.filter(([, , meta]) => !meta || config.has_youtube_metadata).map(([label, href]) => h('a', { class: 'chip', href }, label)),
      ),
      h(
        'div',
        { class: 'areas' },
        areas.map((a) =>
          h(
            'section',
            { class: 'area' },
            h('h2', {}, h('a', { href: `/a/${a.id}` }, a.name), h('span', { class: 'count' }, a.count)),
            h('ul', {}, a.categories.map((c) => h('li', {}, h('a', { href: `/c/${c.id}`, title: c.description }, c.name), h('span', { class: 'count' }, c.count)))),
          ),
        ),
      ),
    ),
  );
}

function commentText(text) {
  return String(text)
    .split(/(\[VIDEO\]|\[LINK\])/)
    .filter(Boolean)
    .map((part) => (part === '[VIDEO]' ? h('span', { class: 'mark video' }, '▶ this video') : part === '[LINK]' ? h('span', { class: 'mark' }, 'link') : part));
}

// ---------- playback: progress, resume, queue, autoplay ----------

/** Seconds to resume `vid` from, or 0 (not started, nearly finished, or finished). */
function resumeAt(vid) {
  const p = state.progress[vid];
  return p && p[0] > 20 && p[0] < p[1] - 20 ? p[0] : 0;
}
let lastSaved = { vid: null, t: 0 };
function saveProgress(vid, t, d) {
  // every 5 s of playback is plenty; the last few seconds count as finished
  if (lastSaved.vid === vid && Math.abs(t - lastSaved.t) < 5 && t < d - 20) return;
  lastSaved = { vid, t };
  state.progress[vid] = [Math.round(t >= d - 20 ? d : t), Math.round(d), Date.now()];
  saveProgressStore();
}

/** The next video in the active queue after `vid`, if `vid` is in it. */
function queueNext(vid) {
  const q = state.queue;
  if (!q) return null;
  const i = q.ids.indexOf(vid);
  return i >= 0 && i + 1 < q.ids.length ? q.ids[i + 1] : null;
}
function startQueue(ids, name) {
  if (!ids.length) return;
  state.queue = { ids: ids.slice(0, 500), name };
  store.set('queue', state.queue);
  navigate(`/watch/${ids[0]}?autoplay=1`);
}

/**
 * The player area: a frame from the video with a play button (YouTube loads only when you
 * press it, or right away when you arrived by autoplay), resuming where you left off, and a
 * 5-second "Up next" countdown when the video ends.
 * @param {HTMLElement} player
 * @param {{ vid: string, title: string, nextUp: () => ({ vid: string, title: string }|null) }} opts
 */
function mountPlayer(player, { vid, title, nextUp }) {
  const start = resumeAt(vid);
  const begin = () => {
    const p = createPlayer({
      vid,
      title,
      start: resumeAt(vid),
      onProgress: (t, d) => saveProgress(vid, t, d),
      onEnded: () => {
        const d = state.progress[vid]?.[1];
        if (d) saveProgress(vid, d, d);
        const next = state.autoplay ? nextUp() : null;
        if (next) countdown(player, next);
      },
    });
    cleanups.push(() => p.destroy());
    player.replaceChildren(p.iframe);
    p.iframe.focus();
  };
  const poster = h(
    'button',
    { type: 'button', class: 'poster', id: 'poster', 'aria-label': start ? `Resume ${title} at ${fmtDuration(Math.floor(start))}` : `Play ${title}` },
    thumbImg(vid, { eager: true }),
    h('span', { class: 'play' }, icon('play')),
    start ? h('span', { class: 'resume-note' }, `Resume at ${fmtDuration(Math.floor(start))}`) : null,
  );
  poster.addEventListener('click', begin);
  player.replaceChildren(poster);
  if (new URLSearchParams(location.search).get('autoplay') === '1') begin();
}

function countdown(player, next) {
  let left = 5;
  const label = h('p', {}, `Up next in ${left}`);
  let timer = null;
  const go = () => {
    clearInterval(timer);
    navigate(`/watch/${next.vid}?autoplay=1`);
  };
  const overlay = h(
    'div',
    { class: 'countdown', role: 'dialog', 'aria-label': 'Up next' },
    h(
      'div',
      {},
      label,
      h('h3', {}, next.title),
      h(
        'div',
        { class: 'actions justify-center' },
        h('button', { type: 'button', class: 'pill primary', id: 'play-next', onclick: go }, icon('next'), 'Play now'),
        h('button', {
          type: 'button',
          class: 'pill',
          id: 'cancel-next',
          onclick: () => {
            clearInterval(timer);
            overlay.remove();
          },
        }, 'Cancel'),
      ),
    ),
  );
  timer = setInterval(() => {
    left -= 1;
    label.textContent = `Up next in ${left}`;
    if (left <= 0) go();
  }, 1000);
  cleanups.push(() => clearInterval(timer));
  player.append(overlay);
  overlay.querySelector('#play-next').focus();
}

function shareButton(url, title) {
  return h('button', {
    type: 'button',
    class: 'pill',
    id: 'share',
    onclick: async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title, url });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return; // the viewer closed the share sheet
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      } catch {
        toast(url);
      }
    },
  }, icon('share'), 'Share');
}

const AVATAR_COLORS = ['#e5482d', '#2f6fdb', '#1f9d63', '#9b51e0', '#d97706', '#0e9aa7', '#c2185b', '#5c6bc0'];
function avatar(name) {
  let hsh = 0;
  for (const ch of String(name)) hsh = (hsh * 31 + ch.codePointAt(0)) >>> 0;
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, String(name).slice(0, 1).toUpperCase() || '?');
  el.style.background = AVATAR_COLORS[hsh % AVATAR_COLORS.length];
  return el;
}

/** The "Up next" column: the active queue when this video is in it, otherwise related videos. */
async function renderUpNext(upnext, vid, token, related) {
  const toggle = h('input', { type: 'checkbox', id: 'autoplay-toggle' });
  toggle.checked = state.autoplay;
  toggle.addEventListener('change', () => {
    state.autoplay = toggle.checked;
    store.set('autoplay', state.autoplay);
  });
  const head = h('div', { class: 'shelf-head' }, h('h2', {}, 'Up next'), h('label', { class: 'toggle' }, toggle, 'Autoplay'));
  const q = state.queue;
  if (q && q.ids.includes(vid)) {
    const items = await resolveCards(q.ids, token);
    if (!items) return null;
    const at = q.ids.indexOf(vid);
    upnext.replaceChildren(
      head,
      h(
        'div',
        { class: 'queue-head' },
        h('b', {}, q.name),
        h('span', { class: 'hint' }, `${at + 1} of ${q.ids.length}`),
        h('button', {
          type: 'button',
          class: 'pill mt-2',
          onclick: () => {
            state.queue = null;
            store.set('queue', null);
            route({ keepScroll: true });
          },
        }, 'Stop playing this list'),
      ),
      h('div', { class: 'list' }, items.filter((it) => it.vid !== vid).map(card)),
    );
    const next = queueNext(vid);
    const item = next && items.find((it) => it.vid === next);
    return item ? { vid: item.vid, title: item.title } : null;
  }
  upnext.replaceChildren(head, related.length ? h('div', { class: 'list' }, related.map(card)) : h('p', { class: 'status' }, 'Nothing related yet.'));
  return related[0] ? { vid: related[0].vid, title: related[0].title } : null;
}

async function watchPage(token, vid) {
  // Videos added by URL are never in the collection (adding one that is opens it instead).
  const mine = state.custom.find((c) => c.vid === vid);
  if (mine) return customWatchPage(mine);
  let d;
  try {
    d = await api(`/api/video${qs({ vid })}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    if (!current(token)) return;
    return notFound('This video is not in the collection. You can add any YouTube video under My videos.');
  }
  if (!current(token)) return;
  document.title = `${d.title} · ${SITE}`;
  markSeen(d.vid);

  let nextUp = null;
  const player = h('div', { class: 'player' });
  mountPlayer(player, { vid: d.vid, title: d.title, nextUp: () => nextUp });

  const voteBtn = (kind) => {
    const list = kind === 'like' ? state.likes : state.dislikes;
    const btn = h('button', { type: 'button', class: `pill vote${list.includes(d.vid) ? ' on' : ''}`, id: kind, 'aria-pressed': String(list.includes(d.vid)) }, icon(kind === 'like' ? 'up' : 'down'), kind === 'like' ? 'Like' : 'Dislike');
    btn.addEventListener('click', () => {
      setVote(d.vid, kind);
      refreshVoteButtons(d.vid);
      toast(kind === 'like' ? (state.likes.includes(d.vid) ? 'Liked. Your Home feed will use it.' : 'Like removed') : state.dislikes.includes(d.vid) ? 'Disliked. Similar videos show up less.' : 'Dislike removed');
    });
    return btn;
  };
  const laterPill = h('button', { type: 'button', class: 'pill', id: 'save-later', dataset: { later: d.vid } });
  renderLaterPill(laterPill, d.vid);
  const hideChannel = channelButton(d.channel);

  const hn = d.hn || {};
  const facts = [
    hn.recommenders ? `Recommended by ${plural(hn.recommenders, 'HN commenter')} in ${plural(hn.rec_months, 'month')}` : `Cited ${plural(hn.mentions || 0, 'time')} on HN`,
    hn.first_year && hn.last_year ? (hn.first_year === hn.last_year ? String(hn.first_year) : `${hn.first_year}–${hn.last_year}`) : null,
    d.yt?.views != null ? `${compact(d.yt.views)} views` : null,
    d.yt?.published ? ago(d.yt.published) : null,
    d.yt?.duration_s ? fmtDuration(d.yt.duration_s) : null,
    cap(d.content_type),
    d.shelf_life === 'evergreen' ? null : cap(d.shelf_life),
  ].filter(Boolean);

  const comments = d.mentions.map((m) =>
    h(
      'article',
      { class: 'comment' },
      avatar(m.author),
      h(
        'div',
        { class: 'comment-body' },
        h('header', {}, h('b', {}, m.author), h('span', {}, monthLabel(m.month)), m.story_title ? h('span', { class: 'story' }, `in “${m.story_title}”`) : null),
        h('p', {}, commentText(m.text)),
        h('footer', {}, h('span', { class: `stance ${m.stance}` }, STANCES[m.stance] || m.stance), h('a', { href: `https://news.ycombinator.com/item?id=${Number(m.id)}`, target: '_blank', rel: 'noopener' }, 'View on HN')),
      ),
    ),
  );

  const upnext = h('aside', { class: 'upnext', 'aria-label': 'Up next' }, h('h2', {}, 'Up next'), h('p', { class: 'status' }, 'Loading…'));
  view.replaceChildren(
    h(
      'div',
      { class: 'watch' },
      h(
        'section',
        { class: 'primary' },
        player,
        h('h1', { class: 'watch-title' }, d.title),
        h(
          'div',
          { class: 'owner' },
          h('div', {}, h('b', {}, d.channel), h('p', { class: 'sub' }, facts.join(' · '))),
          h('div', { class: 'actions' }, voteBtn('like'), voteBtn('dislike'), laterPill, h('button', { type: 'button', class: 'pill', id: 'save-list', onclick: (e) => saveToListDialog(d.vid, e.currentTarget) }, icon('list-plus'), 'Save'), shareButton(`${location.origin}/watch/${d.vid}`, d.title), hideChannel, h('a', { class: 'pill', href: `https://www.youtube.com/watch?v=${d.vid}`, target: '_blank', rel: 'noopener' }, icon('external'), 'YouTube')),
        ),
        d.duplicate_of ? h('p', { class: 'note' }, 'This is another upload of ', h('a', { href: `/watch/${d.duplicate_of}` }, 'a video in the collection'), '.') : null,
        d.yt?.embeddable === false ? h('p', { class: 'note' }, 'The uploader doesn’t allow this video to play on other sites. Open it on YouTube to watch.') : null,
        h(
          'div',
          { class: 'desc' },
          h('p', {}, d.summary),
          h('p', { class: 'why' }, d.why_hn),
          d.quote?.text ? h('blockquote', {}, `“${d.quote.text}”`, h('cite', {}, ` HN, ${d.quote.year}`)) : null,
          h(
            'div',
            { class: 'tags' },
            d.categories.map((c) => h('a', { class: 'chip', href: `/c/${c.id}` }, c.name)),
            d.tags.map((t) => h('a', { class: 'tag', href: `/search/${encodeURIComponent(t)}` }, `#${t}`)),
          ),
        ),
        h('section', { class: 'comments' }, h('h2', {}, `What Hacker News said (${d.mentions.length})`), comments),
      ),
      upnext,
    ),
  );

  try {
    const rel = await api(`/api/related${qs({ vid: d.vid, n: 20 })}`);
    if (!current(token)) return;
    nextUp = await renderUpNext(upnext, d.vid, token, rel.items);
  } catch (err) {
    if (current(token)) upnext.replaceChildren(h('h2', {}, 'Up next'), h('p', { class: 'status' }, `Couldn’t load related videos. ${failure(err)}`));
  }
}

function channelButton(channel) {
  const btn = h('button', { type: 'button', class: 'pill', id: 'mute-channel' });
  const render = () => {
    const muted = state.prefs.muteChannels.includes(channel);
    btn.textContent = muted ? 'Channel hidden' : 'Hide channel';
    btn.classList.toggle('on', muted);
    btn.setAttribute('aria-pressed', String(muted));
    btn.title = muted ? `Let ${channel} back into your feed` : `Never show ${channel} in your feed`;
  };
  btn.addEventListener('click', () => {
    toast(toggleChannel(channel) ? `${channel} won't appear in your feed` : `${channel} can appear in your feed again`);
    render();
  });
  render();
  return btn;
}

/** Watch page for a video the viewer added: just the player and its YouTube title. */
function customWatchPage(c) {
  document.title = `${c.title} · ${SITE}`;
  markSeen(c.vid);
  const player = h('div', { class: `player${c.short ? ' short' : ''}` });
  mountPlayer(player, {
    vid: c.vid,
    title: c.title,
    nextUp: () => {
      const next = queueNext(c.vid);
      if (!next) return null;
      const known = state.custom.find((x) => x.vid === next);
      return { vid: next, title: known?.title ?? 'Next in your list' };
    },
  });
  const remove = h('button', {
    type: 'button',
    class: 'pill',
    id: 'remove-mine',
    onclick: () => {
      state.custom = state.custom.filter((x) => x.vid !== c.vid);
      saveCustom();
      toast('Removed from My videos');
      navigate('/mine');
    },
  }, 'Remove from My videos');
  const laterPill = h('button', { type: 'button', class: 'pill', id: 'save-later', dataset: { later: c.vid } });
  renderLaterPill(laterPill, c.vid);
  view.replaceChildren(
    h(
      'div',
      { class: 'watch single' },
      h(
        'section',
        { class: 'primary' },
        player,
        h('h1', { class: 'watch-title' }, c.title),
        h(
          'div',
          { class: 'owner' },
          h('div', {}, h('b', {}, c.channel || 'Unknown channel'), h('p', { class: 'sub' }, `${c.short ? 'Short' : 'Video'} you added · not from Hacker News`)),
          h('div', { class: 'actions' }, laterPill, h('button', { type: 'button', class: 'pill', id: 'save-list', onclick: (e) => saveToListDialog(c.vid, e.currentTarget) }, icon('list-plus'), 'Save'), shareButton(`https://www.youtube.com/watch?v=${c.vid}`, c.title), c.channel ? channelButton(c.channel) : null, remove, h('a', { class: 'pill', href: c.short ? `https://www.youtube.com/shorts/${c.vid}` : `https://www.youtube.com/watch?v=${c.vid}`, target: '_blank', rel: 'noopener' }, icon('external'), 'YouTube')),
        ),
      ),
    ),
  );
}

function refreshVoteButtons(vid) {
  for (const [id, list] of [['like', state.likes], ['dislike', state.dislikes]]) {
    const btn = $(`#${id}`);
    if (!btn) continue;
    btn.classList.toggle('on', list.includes(vid));
    btn.setAttribute('aria-pressed', String(list.includes(vid)));
  }
}

function renderLaterPill(btn, vid) {
  const on = state.later.includes(vid);
  btn.replaceChildren(icon(on ? 'check' : 'clock'), on ? 'Saved' : 'Watch later');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
}

async function searchPage(token, q) {
  $('#q').value = q;
  document.title = `${q} - search · ${SITE}`;
  const section = h('section', {}, pageHead(`Results for “${q}”`, null, playAllLink(vidsOnPage)), filterBar({ search: true }));
  view.replaceChildren(section, h('p', { class: 'status' }, 'Searching…'));
  let res;
  try {
    res = await api(`/api/search${qs({ q, ...currentFilters() })}`);
  } catch (err) {
    if (!current(token)) return;
    view.replaceChildren(section, h('p', { class: 'status' }, err.status === 429 ? 'Lots of searches right now. Give it a minute and try again.' : `Search failed (${err.message}).`));
    return;
  }
  if (!current(token)) return;
  const notes = [];
  if (res.mode === 'keyword') notes.push(h('p', { class: 'note' }, 'Matching by keywords only: the semantic search model is still loading or unavailable.'));
  if (res.weak && res.items.length) notes.push(h('p', { class: 'note' }, `No strong matches for “${q}”. These are the closest videos.`));
  view.replaceChildren(
    section,
    ...notes,
    res.items.length ? h('div', { class: 'grid' }, res.items.map(card)) : h('p', { class: 'status' }, `No videos match “${q}”${Object.keys(currentFilters()).length ? ' with these filters' : ''}.`),
  );
}

/** Cards for a list of ids in order: your own videos from this browser, the rest from the server. */
async function resolveCards(vids, token) {
  const mine = new Map(state.custom.map((c) => [c.vid, c]));
  const lookup = [...new Set(vids.filter((vid) => !mine.has(vid)))];
  const found = new Map();
  for (let i = 0; i < lookup.length; i += PROFILE_SEND) {
    const res = await api(`/api/docs${qs({ vids: lookup.slice(i, i + PROFILE_SEND).join(',') })}`);
    if (!current(token)) return null;
    for (const item of res.items) found.set(item.vid, item);
  }
  return vids
    .map((vid) => {
      const c = mine.get(vid);
      return c ? { vid, title: c.title, channel: c.channel, custom: true, short: c.short } : found.get(vid);
    })
    .filter(Boolean);
}

async function savedPage(token, { title, empty, vids, extra, play = false }) {
  const newestFirst = vids.slice().reverse();
  const playHere = play && vids.length ? h('button', { type: 'button', class: 'pill primary', id: 'play-here', onclick: () => startQueue(vidsOnPage(), title) }, icon('play'), 'Play') : null;
  const section = h('section', {}, pageHead(title, null, playHere, vids.length ? playAllLink(vidsOnPage) : null, extra || null));
  view.replaceChildren(section);
  if (!newestFirst.length) {
    section.append(h('p', { class: 'status' }, empty));
    return;
  }
  const items = await resolveCards(newestFirst, token);
  if (!items) return;
  const sub = h('p', { class: 'sub' }, plural(items.length, 'video'));
  section.querySelector('.pagehead > div').append(sub);
  section.append(items.length ? h('div', { class: 'grid' }, items.map(card)) : h('p', { class: 'status' }, empty));
}

async function historyPage(token) {
  const clear = state.seen.length
    ? h('button', {
        type: 'button',
        class: 'pill',
        id: 'clear-history',
        onclick: () => {
          const before = state.seen;
          state.seen = [];
          saveLists();
          route({ keepScroll: true, focus: '#view' });
          toast('History cleared', () => {
            state.seen = before;
            saveLists();
            if (location.pathname === '/history') route({ keepScroll: true });
          });
        },
      }, 'Clear history')
    : null;
  await savedPage(token, { title: 'History', empty: 'Videos you open show up here.', vids: state.seen, extra: clear });
}

async function aboutPage(token) {
  const s = await api('/api/stats');
  if (!current(token)) return;
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  view.replaceChildren(
    h(
      'article',
      { class: 'about' },
      pageHead('About Custom Tube', 'The YouTube videos Hacker News keeps telling each other to watch.'),
      h(
        'div',
        { class: 'stats' },
        [
          [s.videos, 'videos'],
          [s.mentions, 'HN comments'],
          [s.recommenders, 'recommenders'],
          [s.categories, `topics in ${s.areas} areas`],
        ].map(([n, label]) => h('div', { class: 'stat' }, h('b', {}, Number(n).toLocaleString('en-US')), h('span', {}, label))),
      ),
      h('h2', {}, 'How it works'),
      h(
        'ul',
        {},
        h('li', {}, h('b', {}, 'Ranking. '), 'A video’s score is the number of different months HN recommended it in, with strong recommendations counting extra, so lasting recommendations beat one viral spike.'),
        h('li', {}, h('b', {}, 'Home '), 'mixes HN classics, recent favourites and topics you haven’t explored. Once you like videos it adds similar ones (by meaning) and ones the same HN people also recommended. Dislikes push similar videos down. Your likes and history never leave this browser except as part of each feed request, and the server keeps none of it.'),
        h('li', {}, h('b', {}, 'Search '), 'matches by meaning with the bge-small-en-v1.5 model, plus keywords and topics.'),
        h('li', {}, h('b', {}, 'Privacy. '), 'No accounts and no tracking. Videos play through YouTube’s privacy-enhanced embed, and only after you press play.'),
      ),
      h('h2', {}, 'Make it yours'),
      h('p', {}, 'Pick formats (Shorts, regular, long), kinds of video, topics to follow or mute, channels to hide and how much of each source Home mixes in, under ', h('a', { href: '/settings' }, 'Customize'), '. Add any YouTube video or Short under ', h('a', { href: '/mine' }, 'My videos'), '.'),
      h('h2', {}, 'Keyboard shortcuts'),
      shortcutTable(),
      h('h2', {}, 'Credits and licence'),
      h(
        'p',
        {},
        'The data comes from the ',
        ext('https://hackertube.org/data', 'HackerTube data export'),
        ' (exported 2026-10-31), released under ',
        ext('https://opendatacommons.org/licenses/by/1-0/', 'ODC-By 1.0'),
        ', which is derived from the ',
        ext('https://huggingface.co/datasets/open-index/hacker-news', 'open-index/hacker-news'),
        ' archive. Hacker News data is provided by Y Combinator, and comments remain the work of their authors. Labels and summaries were written by an LLM, so expect a few to be off.',
      ),
      h('p', { class: 'fine' }, 'Custom Tube is an independent project, not affiliated with HackerTube, YouTube, Google, Hacker News or Y Combinator. Video titles and channel names belong to their creators.', s.has_youtube_metadata ? ' Video statistics come from the YouTube Data API.' : ''),
    ),
  );
}

const SHORTCUTS = [
  ['/', 'Search'],
  ['j / k', 'Next / previous video'],
  ['Enter', 'Open the selected video'],
  ['l', 'Like the selected or current video'],
  ['w', 'Watch later for the selected or current video'],
  ['p', 'Play (on a video page)'],
  ['?', 'Show shortcuts'],
  ['Esc', 'Close / leave the search box'],
];
function shortcutTable() {
  return h('table', { class: 'keys' }, SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, k.split(' / ').map((x, i) => [i ? ' / ' : null, h('kbd', {}, x)])), h('td', {}, d))));
}

// ---------- customize feed ----------

async function settingsPage(token) {
  const areas = await getBrowse().catch(() => []);
  if (!current(token)) return;
  const p = state.prefs;
  const catName = new Map(areas.flatMap((a) => a.categories.map((c) => [c.id, c.name])));
  const changed = (message) => {
    savePrefs();
    if (message) toast(message);
  };
  const checkbox = (checked, onChange, attrs = {}) => {
    const box = h('input', { type: 'checkbox', ...attrs });
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return box;
  };

  // Formats: Shorts, regular, long
  const formatsOk = Boolean(config.curation?.formats_available);
  const formats = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Video formats'),
    Object.entries(FORMAT_LABELS).map(([f, label]) =>
      h(
        'label',
        { class: 'option' },
        checkbox(
          p.formats.includes(f),
          (on) => {
            p.formats = on ? [...new Set([...p.formats, f])] : p.formats.filter((x) => x !== f);
            if (!p.formats.length) {
              p.formats = [f];
              formats.querySelector(`[data-format="${f}"]`).checked = true;
              toast('Keep at least one format');
              return;
            }
            changed();
          },
          { dataset: { format: f } },
        ),
        h('span', {}, label),
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      formatsOk
        ? 'Lengths come from YouTube. Videos you add yourself count as Shorts when added from a /shorts/ link.'
        : 'The HN collection has no durations yet, so these apply only to videos you add yourself. Add YouTube metadata (see README) to filter the whole feed.',
    ),
  );

  // Content types
  const typeList = config.curation?.types ?? config.filters.type ?? [];
  const types = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Kinds of video'),
    h('p', { class: 'hint' }, 'Leave all unchecked to allow every kind.'),
    h(
      'div',
      { class: 'options' },
      typeList.map((t) =>
        h(
          'label',
          { class: 'option' },
          checkbox(p.types.includes(t), (on) => {
            p.types = on ? [...new Set([...p.types, t])] : p.types.filter((x) => x !== t);
            changed();
          }, { dataset: { type: t } }),
          h('span', {}, cap(t)),
        ),
      ),
    ),
    h('label', { class: 'option' }, checkbox(p.news, (on) => ((p.news = on), changed()), { id: 'pref-news' }), h('span', {}, 'Include news-only videos')),
    h('label', { class: 'option' }, checkbox(p.cited, (on) => ((p.cited = on), changed()), { id: 'pref-cited' }), h('span', {}, 'Include videos HN only cited, never recommended')),
  );

  // Mix
  const mix = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Feed mix'),
    h('p', { class: 'hint' }, 'How often each source gets a turn. 0 turns it off.'),
    Object.entries(SOURCE_LABELS).filter(([key]) => key !== 'gems' || config.has_youtube_metadata).map(([key, [label, hint]]) => {
      const text = (w) => (Number(w) === 0 ? 'off' : `${w} of 5`);
      const out = h('output', { class: 'weight', for: `mix-${key}`, 'aria-hidden': 'true' }, String(p.mix[key]));
      const range = h('input', { type: 'range', min: 0, max: 5, step: 1, value: p.mix[key], id: `mix-${key}`, 'aria-label': `${label} weight`, 'aria-valuetext': text(p.mix[key]) });
      range.addEventListener('input', () => {
        p.mix[key] = Number(range.value);
        out.textContent = range.value;
        range.setAttribute('aria-valuetext', text(range.value));
      });
      range.addEventListener('change', () => changed());
      return h('div', { class: 'mixrow' }, h('div', {}, h('b', {}, label), h('span', { class: 'hint' }, hint)), range, out);
    }),
  );

  // Topics and channels
  const chipList = (items, label, onRemove, emptyText) =>
    items.length
      ? h(
          'div',
          { class: 'chips' },
          items.map((it) =>
            h('button', {
              type: 'button',
              class: 'chip removable',
              'aria-label': `Remove ${label(it)}`,
              title: `Remove ${label(it)}`,
              onclick: (e) => {
                const chip = e.currentTarget;
                const next = chip.nextElementSibling || chip.previousElementSibling || chip.closest('fieldset')?.querySelector('select');
                onRemove(it);
                chip.remove();
                next?.focus();
              },
            }, label(it), h('span', { 'aria-hidden': 'true' }, '×')),
          ),
        )
      : h('p', { class: 'hint' }, emptyText);
  const topicSelect = (kind) => {
    const sel = h('select', { 'aria-label': kind === 'follow' ? 'Follow a topic' : 'Mute a topic', id: `${kind}-topic-select` }, h('option', { value: '' }, kind === 'follow' ? 'Follow a topic…' : 'Mute a topic…'), areas.map((a) => h('optgroup', { label: a.name }, a.categories.map((c) => h('option', { value: c.id }, c.name)))));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const list = kind === 'follow' ? p.followTopics : p.muteTopics;
      if (!list.includes(sel.value)) toggleTopic(sel.value, kind);
      route({ keepScroll: true, focus: `#${kind}-topic-select` });
    });
    return sel;
  };
  const topics = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Topics'),
    h('h3', {}, 'Following'),
    chipList(p.followTopics, (id) => catName.get(id) ?? id, (id) => changed(toggleTopic(id, 'follow') ? null : 'Unfollowed'), 'Not following any topics. Follow one here or from its topic page.'),
    topicSelect('follow'),
    h('h3', {}, 'Muted'),
    chipList(p.muteTopics, (id) => catName.get(id) ?? id, (id) => changed(toggleTopic(id, 'mute') ? null : 'Unmuted'), 'No muted topics.'),
    topicSelect('mute'),
  );
  const channels = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Hidden channels'),
    chipList(p.muteChannels, (c) => c, (c) => changed(toggleChannel(c) ? null : 'Channel shown again'), 'No hidden channels. Use “Hide channel” on any video page.'),
  );

  // Display, backup, reset
  const frames = checkbox(state.frames, (on) => {
    state.frames = on;
    store.set('frames', on);
    toast(on ? 'Showing frames from the middle of each video' : 'Showing the uploaders’ thumbnails');
  }, { id: 'frames-toggle' });
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', class: 'visually-hidden' });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const before = snapshotProfile();
      importProfile(JSON.parse(await file.text()));
      importInput.value = '';
      route({ keepScroll: true, focus: '#export-profile' });
      toast('Settings imported', () => {
        importProfile(before);
        route({ keepScroll: true });
      });
    } catch (err) {
      toast(`Couldn't import that file (${err.message})`);
    }
  });
  const backup = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, 'Display and backup'),
    h('label', { class: 'option' }, frames, h('span', {}, 'Show a frame from each video instead of the uploader’s thumbnail')),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'pill', id: 'export-profile', onclick: exportProfile }, 'Export settings and lists'),
      h('label', { class: 'pill', for: 'import-file' }, 'Import…'),
      importInput,
      h('button', {
        type: 'button',
        class: 'pill',
        id: 'reset-prefs',
        onclick: () => {
          const before = state.prefs;
          state.prefs = sanitizePrefs(null);
          savePrefs();
          route({ keepScroll: true, focus: '#reset-prefs' });
          toast('Feed settings reset', () => {
            state.prefs = before;
            savePrefs();
            route({ keepScroll: true });
          });
        },
      }, 'Reset feed settings'),
    ),
    h('p', { class: 'hint' }, 'Everything here is stored in this browser only. Export it to move it to another browser.'),
  );

  view.replaceChildren(
    h(
      'section',
      { class: 'settings' },
      pageHead('Customize your feed', 'Choose exactly what Home shows you. Changes apply the next time you open Home.', h('a', { class: 'pill', href: '/' }, 'See my feed')),
      formats,
      types,
      mix,
      topics,
      channels,
      backup,
    ),
  );
}

const PROFILE_VERSION = 2; // 2 added lists
function snapshotProfile() {
  return structuredClone({ app: 'customtube', version: PROFILE_VERSION, exported: new Date().toISOString(), likes: state.likes, dislikes: state.dislikes, later: state.later, seen: state.seen, prefs: state.prefs, custom: state.custom, lists: state.lists, progress: state.progress });
}
function exportProfile() {
  const data = snapshotProfile();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `customtube-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importProfile(data) {
  if (!data || data.app !== 'customtube') throw new Error('not a Custom Tube export');
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > PROFILE_VERSION) throw new Error(`unsupported export version ${data.version}`);
  state.likes = cleanIds(data.likes);
  state.dislikes = cleanIds(data.dislikes).filter((v) => !state.likes.includes(v));
  state.later = cleanIds(data.later);
  state.seen = cleanIds(data.seen).slice(-200);
  state.prefs = sanitizePrefs(data.prefs);
  state.custom = sanitizeCustom(data.custom);
  state.lists = sanitizeLists(data.lists);
  state.progress = sanitizeProgress(data.progress);
  saveProgressStore();
  saveLists();
  savePrefs();
  saveCustom();
  saveLists2();
}

// ---------- my videos ----------

async function minePage() {
  document.title = `My videos · ${SITE}`;
  const input = h('input', { type: 'text', id: 'add-url', placeholder: 'Paste a YouTube video or Shorts link', 'aria-label': 'YouTube link', autocomplete: 'off', maxlength: 500 });
  const status = h('p', { class: 'hint', id: 'add-status', role: 'status' });
  const form = h('form', { class: 'addform', id: 'add-video' }, input, h('button', { type: 'submit', class: 'pill on' }, 'Add'));
  const addButton = form.querySelector('button');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (addButton.disabled) return;
    const parsed = parseYoutubeInput(input.value);
    if (!parsed) {
      status.textContent = 'That doesn’t look like a YouTube link.';
      return;
    }
    if (state.custom.some((c) => c.vid === parsed.vid)) {
      status.textContent = 'Already in My videos.';
      return;
    }
    status.textContent = 'Looking it up on YouTube…';
    addButton.disabled = true;
    try {
      const info = await api(`/api/oembed${qs({ vid: parsed.vid })}`);
      // a second submit (or another tab) may have added it while we waited
      if (state.custom.some((c) => c.vid === parsed.vid)) {
        status.textContent = 'Already in My videos.';
        return;
      }
      if (info.in_collection) {
        status.textContent = '';
        toast('That one is already in the HN collection. Opening it.');
        navigate(`/watch/${parsed.vid}`);
        return;
      }
      state.custom.push({ vid: parsed.vid, title: info.title, channel: info.channel, short: parsed.short, added: new Date().toISOString() });
      saveCustom();
      toast(`Added “${info.title}”`);
      route({ keepScroll: true, focus: '#add-url' });
    } catch (err) {
      status.textContent = err.status === 429 ? 'Too many lookups. Try again in a minute.' : failure(err);
    } finally {
      addButton.disabled = false;
    }
  });
  const items = state.custom.slice().reverse().map((c) => ({ vid: c.vid, title: c.title, channel: c.channel, custom: true, short: c.short }));
  view.replaceChildren(
    h(
      'section',
      {},
      pageHead('My videos', 'Add any YouTube video or Short. They join your Home feed (set how often under Customize feed).', items.length ? playAllLink(vidsOnPage) : null),
      form,
      status,
      items.length ? h('div', { class: 'grid' }, items.map(card)) : h('p', { class: 'status' }, 'Nothing added yet.'),
    ),
  );
}

// ---------- library and lists ----------

function listCover(vids) {
  return h('div', { class: 'mosaic' }, vids.slice(0, 4).map((v) => thumbImg(v)), vids.length ? null : h('span', { class: 'mosaic-empty' }, 'Empty'));
}
function listCard(l) {
  return h('a', { class: 'listcard', href: `/list/${l.id}`, dataset: { listId: l.id } }, listCover(l.vids), h('h3', { class: 'card-title' }, l.name), h('p', { class: 'card-meta' }, plural(l.vids.length, 'video')));
}
function newListForm(after) {
  const name = h('input', { type: 'text', id: 'create-list-name', placeholder: 'New list name', maxlength: 80, 'aria-label': 'New list name' });
  const form = h('form', { class: 'addform', id: 'create-list' }, name, h('button', { type: 'submit', class: 'pill on' }, 'Create list'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    const l = createList(name.value);
    toast(`Created ${l.name}`);
    after(l);
  });
  return form;
}

async function libraryPage(token) {
  document.title = `Library · ${SITE}`;
  const sections = [
    ['Watch later', '/later', state.later.slice().reverse()],
    ['Liked', '/liked', state.likes.slice().reverse()],
    ['History', '/history', state.seen.slice().reverse()],
    ['My videos', '/mine', state.custom.map((c) => c.vid).reverse()],
  ];
  const preview = sections.flatMap(([, , vids]) => vids.slice(0, 4));
  const items = await resolveCards(preview, token);
  if (!items) return;
  const byVid = new Map(items.map((i) => [i.vid, i]));
  view.replaceChildren(
    h(
      'section',
      { class: 'library' },
      pageHead('Library', 'Everything here lives in this browser only.'),
      h(
        'section',
        { class: 'shelf' },
        h('div', { class: 'shelf-head' }, h('h2', {}, 'Lists'), h('a', { href: '/lists' }, state.lists.length ? `All ${state.lists.length}` : 'Make one')),
        state.lists.length ? h('div', { class: 'grid' }, state.lists.slice(-4).reverse().map(listCard)) : h('p', { class: 'hint' }, 'Group videos into your own playlists with “Save to list”.'),
      ),
      sections.map(([title, href, vids]) => {
        const cards = vids.slice(0, 4).map((v) => byVid.get(v)).filter(Boolean);
        return h(
          'section',
          { class: 'shelf' },
          h('div', { class: 'shelf-head' }, h('h2', {}, title, h('span', { class: 'count' }, vids.length)), h('a', { href }, href === '/mine' ? 'Add videos' : 'See all')),
          cards.length ? h('div', { class: 'grid' }, cards.map(card)) : h('p', { class: 'hint' }, 'Nothing here yet.'),
        );
      }),
    ),
  );
}

function listsPage() {
  document.title = `Lists · ${SITE}`;
  view.replaceChildren(
    h(
      'section',
      {},
      h('a', { class: 'crumb', href: '/library' }, 'Library'),
      pageHead('Lists', 'Your own playlists. Play any of them on YouTube.'),
      newListForm((l) => navigate(`/list/${l.id}`)),
      state.lists.length ? h('div', { class: 'grid lists' }, state.lists.slice().reverse().map(listCard)) : h('p', { class: 'status' }, 'No lists yet.'),
    ),
  );
}

async function listPageOne(token, id) {
  const list = state.lists.find((l) => l.id === id);
  if (!list) return notFound('This list doesn’t exist in this browser.');
  document.title = `${list.name} · ${SITE}`;
  const items = await resolveCards(list.vids, token);
  if (!items) return;
  const save = () => saveLists2();
  const rename = h('button', {
    type: 'button',
    class: 'pill',
    id: 'rename-list',
    onclick: () => {
      // Edit the name in place: Enter saves, Escape cancels.
      const heading = view.querySelector('.pagehead h1');
      const input = h('input', { type: 'text', id: 'list-name', value: list.name, maxlength: 80, 'aria-label': 'List name', class: 'title-input' });
      const finish = (saveIt) => {
        if (saveIt && input.value.trim()) {
          list.name = input.value.trim().slice(0, 80);
          save();
        }
        route({ keepScroll: true, focus: '#rename-list' });
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true), { once: true });
      heading.replaceWith(input);
      input.select();
    },
  }, 'Rename');
  const del = h('button', {
    type: 'button',
    class: 'pill',
    id: 'delete-list',
    onclick: () => {
      const index = state.lists.indexOf(list);
      state.lists.splice(index, 1);
      save();
      navigate('/lists');
      toast(`Deleted ${list.name}`, () => {
        state.lists.splice(index, 0, list);
        save();
        navigate(`/list/${list.id}`);
      });
    },
  }, 'Delete');
  const move = (vid, delta) => {
    const i = list.vids.indexOf(vid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.vids.length) return;
    [list.vids[i], list.vids[j]] = [list.vids[j], list.vids[i]];
    save();
    // Keep focus on the same control of the moved video (or its other arrow at the ends).
    const k = j + 1;
    const first = delta < 0 ? 'up' : 'down';
    const atEnd = (delta < 0 && j === 0) || (delta > 0 && j === list.vids.length - 1);
    route({ keepScroll: true, focus: `.list-row:nth-child(${k}) [data-act="${atEnd ? (first === 'up' ? 'down' : 'up') : first}"]` });
  };
  const rows = items.map((item, i) =>
    h(
      'li',
      { class: 'list-row' },
      h('span', { class: 'num' }, i + 1),
      card(item),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { type: 'button', class: 'icon-btn small', dataset: { act: 'up' }, 'aria-label': `Move ${item.title} up`, disabled: i === 0, onclick: () => move(item.vid, -1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn small', dataset: { act: 'down' }, 'aria-label': `Move ${item.title} down`, disabled: i === items.length - 1, onclick: () => move(item.vid, 1) }, '↓'),
        h('button', {
          type: 'button',
          class: 'icon-btn small',
          dataset: { act: 'remove' },
          'aria-label': `Remove ${item.title} from this list`,
          onclick: () => {
            const at = list.vids.indexOf(item.vid);
            list.vids = list.vids.filter((v) => v !== item.vid);
            save();
            const n = Math.min(at, list.vids.length - 1) + 1;
            route({ keepScroll: true, focus: n > 0 ? `.list-row:nth-child(${n}) [data-act="remove"]` : '#rename-list' });
            toast(`Removed from ${list.name}`, () => {
              if (!list.vids.includes(item.vid)) list.vids.splice(at, 0, item.vid);
              save();
              if (location.pathname === `/list/${list.id}`) route({ keepScroll: true });
            });
          },
        }, '✕'),
      ),
    ),
  );
  view.replaceChildren(
    h(
      'section',
      {},
      h('a', { class: 'crumb', href: '/lists' }, 'Lists'),
      pageHead(
        list.name,
        plural(items.length, 'video'),
        items.length ? h('button', { type: 'button', class: 'pill primary', id: 'play-list', onclick: () => startQueue(items.map((i) => i.vid), list.name) }, icon('play'), 'Play') : null,
        items.length ? playAllLink(() => list.vids) : null,
        rename,
        del,
      ),
      items.length ? h('ol', { class: 'list rows' }, rows) : h('p', { class: 'status' }, 'This list is empty. Use “Save to list” on any video.'),
    ),
  );
}

function notFound(message = 'Page not found.') {
  document.title = `Not found · ${SITE}`;
  view.replaceChildren(h('section', { class: 'empty' }, h('h1', {}, 'Not found'), h('p', {}, message), h('a', { class: 'pill', href: '/' }, 'Go home')));
}

// ---------- sidebar ----------

/** Your lists and followed topics under the section nav (desktop only). */
function renderSide() {
  const side = $('#side-extra');
  if (!side) return;
  const sections = [];
  if (state.lists.length) {
    sections.push(
      h('section', {}, h('h2', {}, 'Your lists'), state.lists.slice(-6).reverse().map((l) => h('a', { href: `/list/${l.id}` }, icon('queue'), h('span', { class: 'truncate' }, l.name)))),
    );
  }
  if (state.prefs.followTopics.length) {
    if (!browseCache) {
      // names come with the topic list; draw again once it's here
      getBrowse().then(renderSide, () => {});
    }
    const names = new Map((browseCache ?? []).flatMap((a) => a.categories.map((c) => [c.id, c.name])));
    sections.push(
      h('section', {}, h('h2', {}, 'Following'), state.prefs.followTopics.slice(0, 10).map((id) => h('a', { href: `/c/${id}` }, h('span', { class: 'dot' }), h('span', { class: 'truncate' }, names.get(id) ?? id)))),
    );
  }
  sections.push(h('section', {}, h('a', { href: '/mine' }, icon('plus'), 'Add a video'), h('a', { href: '/history' }, icon('history'), 'History'), h('a', { href: '/about' }, icon('sparkles'), 'About')));
  side.replaceChildren(...sections);
}

// ---------- router ----------

// The router restores scroll itself: on Back/Forward to where you were, otherwise to the top.
history.scrollRestoration = 'manual';
const rememberScroll = () => history.replaceState({ ...(history.state || {}), scrollY }, '', location.pathname + location.search);

function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const target = url.pathname + url.search;
  rememberScroll();
  if (replace) history.replaceState(null, '', target);
  else if (target !== location.pathname + location.search) history.pushState(null, '', target);
  route();
}

/**
 * Render the page for the current URL.
 * restore: Back/Forward (reuse a cached Home, put the scroll back).
 * keepScroll + focus: re-render in place after an edit, then focus `focus` (a selector).
 */
async function route({ restore = false, keepScroll = false, focus = null } = {}) {
  const y = restore ? (history.state?.scrollY ?? 0) : keepScroll ? scrollY : 0;
  const token = ++routeToken;
  while (cleanups.length) cleanups.pop()();
  selected = -1;
  const { pathname } = location;
  closeMenu();
  closeDialog();
  renderSide();
  const section = ['/liked', '/later', '/history', '/mine', '/lists', '/library'].includes(pathname) || pathname.startsWith('/list/') ? '/library' : pathname.startsWith('/c/') || pathname.startsWith('/a/') || pathname === '/browse' ? '/topics' : pathname;
  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === section;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!pathname.startsWith('/search/')) $('#q').value = '';
  if (!keepScroll) view.replaceChildren(h('p', { class: 'status' }, 'Loading…'));
  if (!restore && !keepScroll) window.scrollTo(0, 0);
  let m;
  try {
    if (pathname === '/') await home(token, { restore });
    else if ((m = /^\/watch\/([A-Za-z0-9_-]{11})$/.exec(pathname))) await watchPage(token, m[1]);
    else if ((m = /^\/c\/([a-z0-9-]+)$/.exec(pathname))) await categoryPage(token, m[1]);
    else if ((m = /^\/a\/([a-z0-9-]+)$/.exec(pathname))) await areaPage(token, m[1]);
    else if ((m = /^\/search\/(.+)$/.exec(pathname))) {
      let q = null;
      try {
        q = decodeURIComponent(m[1]);
      } catch {
        // a hand-typed URL like /search/100%
      }
      if (q === null) notFound('That search link is malformed.');
      else await searchPage(token, q);
    }
    else if (pathname === '/topics') await topicsPage(token);
    else if (pathname === '/browse') await listPage(token, { title: browseTitle(), sub: 'From the whole collection. Change the filters below to narrow it.', params: {}, crumb: h('a', { class: 'crumb', href: '/topics' }, 'Topics') });
    else if (pathname === '/library') await libraryPage(token);
    else if (pathname === '/lists') listsPage();
    else if ((m = /^\/list\/([a-z0-9]{8})$/.exec(pathname))) await listPageOne(token, m[1]);
    else if (pathname === '/liked') await savedPage(token, { title: 'Liked', empty: 'Videos you like show up here and shape your Home feed.', vids: state.likes });
    else if (pathname === '/later') await savedPage(token, { title: 'Watch later', empty: 'Save videos with the clock button.', vids: state.later, play: true });
    else if (pathname === '/history') await historyPage(token);
    else if (pathname === '/about') await aboutPage(token);
    else if (pathname === '/settings') await settingsPage(token);
    else if (pathname === '/mine') await minePage(token);
    else notFound();
  } catch (err) {
    if (current(token)) view.replaceChildren(h('p', { class: 'status' }, `Something went wrong. ${failure(err)}`));
  }
  if (!current(token)) return;
  if (restore || keepScroll) window.scrollTo(0, y);
  // Move focus into the new page (or to what the edit asked for) so keyboard and screen-reader
  // users start there instead of at the top of the document.
  const target = focus ? $(focus) : null;
  if (target) target.focus({ preventScroll: true });
  else if (!restore && !keepScroll && document.activeElement !== $('#q')) view.focus({ preventScroll: true });
}

addEventListener('popstate', () => route({ restore: true }));

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  if (openMenu && !e.target.closest('.menu')) closeMenu();
  const more = e.target.closest('[data-more]');
  if (more) {
    e.preventDefault();
    cardMenu(more);
    return;
  }
  const later = e.target.closest('[data-later]');
  if (later) {
    e.preventDefault();
    toggleLater(later.dataset.later);
    return;
  }
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

function toggleLater(vid) {
  const on = toggleIn(state.later, vid);
  saveLists();
  for (const b of document.querySelectorAll(`.later-btn[data-later="${vid}"]`)) b.replaceWith(laterButton(vid));
  const pill = $('#save-later');
  if (pill && pill.dataset.later === vid) renderLaterPill(pill, vid);
  if (!on && location.pathname === '/later') route({ keepScroll: true, focus: '.card .card-link' });
  toast(on ? 'Saved to Watch later' : 'Removed from Watch later');
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  $('#q').blur();
  navigate(q ? `/search/${encodeURIComponent(q)}${qs(location.pathname.startsWith('/search/') ? currentFilters() : {})}` : '/');
});

// ---------- theme, toast, shortcuts ----------

const savedTheme = store.get('theme', null);
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const syncThemeButton = () => $('#theme').setAttribute('aria-pressed', String(isDark()));
syncThemeButton();
$('#theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  syncThemeButton();
});

let toastTimer;
function toast(message, undo) {
  const t = $('#toast');
  t.replaceChildren(h('span', {}, message));
  if (undo) {
    t.append(
      h('button', {
        type: 'button',
        class: 'toast-undo',
        onclick: () => {
          t.classList.remove('on');
          undo();
        },
      }, 'Undo'),
    );
  }
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), undo ? 5000 : 2200);
}

let selected = -1;
const listItems = () => [...view.querySelectorAll('.card')];
function select(i) {
  const items = listItems();
  if (!items.length) return;
  selected = Math.max(0, Math.min(i, items.length - 1));
  items.forEach((el, j) => el.classList.toggle('kbd', j === selected));
  // Real focus, so Enter opens it and screen readers announce it.
  items[selected].querySelector('.card-link')?.focus({ preventScroll: true });
  items[selected].scrollIntoView({ block: 'nearest' });
}
function toggleHelp(force) {
  const help = $('#help');
  const show = force ?? !help.open;
  if (!show) {
    if (help.open) help.close();
    return;
  }
  help.replaceChildren(
    h(
      'div',
      { class: 'help-card' },
      h('h2', { id: 'help-title' }, 'Keyboard shortcuts'),
      shortcutTable(),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'pill', onclick: () => help.close() }, 'Close')),
    ),
  );
  openModal(help);
  help.querySelector('button')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const el = document.activeElement;
  const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  if (e.key === 'Escape') {
    if (typing) el.blur();
    closeMenu();
    return; // dialogs close themselves on Escape
  }
  if (openMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const items = [...openMenu.el.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return;
  }
  // Shortcuts never fire while typing, or while a dialog or menu is open.
  if (typing || anyDialogOpen() || openMenu) return;
  const sel = listItems()[selected];
  const watching = /^\/watch\/([A-Za-z0-9_-]{11})$/.exec(location.pathname)?.[1] ?? null;
  const target = sel?.dataset.vid || watching;
  switch (e.key) {
    case '/':
      e.preventDefault();
      $('#q').focus();
      $('#q').select();
      break;
    case 'j':
      select(selected + 1);
      break;
    case 'k':
      select(selected - 1);
      break;
    case 'l':
      if (target) {
        const on = setVote(target, 'like');
        refreshVoteButtons(target);
        toast(on ? 'Liked' : 'Like removed');
      }
      break;
    case 'w':
      if (target) toggleLater(target);
      break;
    case 'p':
      $('#poster')?.click();
      break;
    case '?':
      toggleHelp();
      break;
    default:
      return;
  }
});

// ---------- other tabs ----------

// Another tab changed something: reload that part of the profile so this tab doesn't write
// back a stale copy over it.
addEventListener('storage', (e) => {
  if (!e.key?.startsWith('customtube:')) return;
  const key = e.key.slice('customtube:'.length);
  if (key === 'likes' || key === 'dislikes' || key === 'seen' || key === 'later') state[key] = cleanIds(store.get(key, []));
  else if (key === 'prefs') state.prefs = sanitizePrefs(store.get('prefs', null));
  else if (key === 'custom') state.custom = sanitizeCustom(store.get('custom', []));
  else if (key === 'lists') state.lists = sanitizeLists(store.get('lists', []));
  else if (key === 'frames') state.frames = store.get('frames', true) !== false;
  else if (key === 'progress') state.progress = sanitizeProgress(store.get('progress', {}));
  else if (key === 'queue') state.queue = sanitizeQueue(store.get('queue', null));
  else if (key === 'autoplay') state.autoplay = store.get('autoplay', true) !== false;
  else return;
  if (['/library', '/liked', '/later', '/history', '/mine', '/lists', '/settings'].includes(location.pathname) || location.pathname.startsWith('/list/')) {
    route({ keepScroll: true });
  }
});

// ---------- quick search (⌘K) ----------

const palette = createPalette({
  h,
  api,
  navigate,
  thumbUrl: (vid) => thumbUrl(vid, false),
  commands: () => [
    { label: 'Home', icon: 'home', run: () => navigate('/') },
    { label: 'Following', icon: 'sparkles', keywords: 'topics feed', run: () => navigate('/?tab=following') },
    { label: 'Topics', icon: 'topics', run: () => navigate('/topics') },
    { label: 'Library', icon: 'library', run: () => navigate('/library') },
    { label: 'Watch later', icon: 'clock', run: () => navigate('/later') },
    { label: 'History', icon: 'history', run: () => navigate('/history') },
    { label: 'Customize your feed', icon: 'sliders', keywords: 'settings preferences shorts mix mute', run: () => navigate('/settings') },
    { label: 'Add a YouTube video', icon: 'plus', keywords: 'my videos url link short', run: () => navigate('/mine') },
    { label: 'Recently recommended', icon: 'trending', keywords: 'new latest', run: () => navigate('/browse?sort=recent') },
    { label: 'Toggle dark mode', icon: 'moon', keywords: 'theme light dark', run: () => $('#theme').click() },
    ...state.lists.map((l) => ({ label: `List: ${l.name}`, icon: 'queue', run: () => navigate(`/list/${l.id}`) })),
  ],
});
const paletteDialog = $('#palette');
let paletteOpener = null;
paletteDialog.addEventListener('close', () => paletteOpener?.isConnected && paletteOpener.focus({ preventScroll: true }));
paletteDialog.addEventListener('click', (e) => e.target === paletteDialog && paletteDialog.close());
function openPalette(initial) {
  paletteOpener = document.activeElement;
  palette.open(initial);
}
$('#palette-open').addEventListener('click', () => openPalette($('#q').value));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!paletteDialog.open) openPalette();
  }
});

// ---------- boot ----------

hydrateIcons();

// Installable app with an offline shell (only over HTTPS or on localhost, as browsers require).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Links from older builds or shares may use /#/path. Move them to real paths.
if (location.hash.startsWith('#/')) {
  // Only same-origin paths: "#//evil.example" would otherwise be a different origin.
  const moved = new URL(location.hash.slice(1), location.origin);
  if (moved.origin === location.origin && !location.hash.startsWith('#//')) history.replaceState(null, '', moved.pathname + moved.search);
  else history.replaceState(null, '', location.pathname + location.search);
}

api('/api/config')
  .then((c) => {
    config = c;
  })
  .catch(() => {
    // Without config the filter bar shows only the basic options; the rest still works.
  })
  .finally(route);
