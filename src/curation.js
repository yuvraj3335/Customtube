// Feed curation: what the viewer allows into their Home feed and how the sources are mixed.
// All of it lives in the viewer's browser and arrives with each /api/feed request.
//
//   formats        short (YouTube Shorts length, up to 3 min), standard, long (over an hour).
//                  Needs YouTube metadata, because the export has no durations.
//   types          content types to allow (empty = all)
//   mute_topics    topic ids that never appear
//   follow_topics  topic ids that get their own "following" source
//   mute_channels  channel names that never appear
//   mix            weight 0-5 per source; 0 turns a source off
//   news, cited    "1" lets in news-only videos / videos HN cited but never recommended

import { CONTENT_TYPES } from './filters.js';
import { badRequest } from './http.js';

export const FORMATS = ['short', 'standard', 'long'];
export const SHORT_MAX_SECONDS = 180;
export const LONG_MIN_SECONDS = 3600;
export const MIX_SOURCES = ['classics', 'recent', 'explore', 'gems', 'similar', 'corec', 'following'];
export const DEFAULT_MIX = Object.freeze({ classics: 2, recent: 2, explore: 1, gems: 1, similar: 4, corec: 2, following: 3 });
const MAX_LIST = 200;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function defaultCuration() {
  return {
    formats: null,
    types: null,
    muteTopics: new Set(),
    followTopics: new Set(),
    muteChannels: new Set(),
    mix: { ...DEFAULT_MIX },
    news: false,
    cited: false,
  };
}

/** short | standard | long, or null when the duration is unknown. */
export function formatOf(v) {
  const d = v.yt?.duration_s;
  if (d === null || d === undefined) return null;
  if (d <= SHORT_MAX_SECONDS) return 'short';
  return d > LONG_MIN_SECONDS ? 'long' : 'standard';
}

function list(value, name) {
  if (value === null || value === undefined || value === '') return [];
  const parts = value.split(',');
  if (parts.length > MAX_LIST) throw badRequest(`"${name}" accepts at most ${MAX_LIST} values`);
  return parts;
}

function slugs(value, name, ds) {
  const out = new Set();
  for (const id of list(value, name)) {
    if (!SLUG_RE.test(id)) throw badRequest(`"${name}" contains an invalid topic id`);
    // The client drops saved topics a newer export no longer has before it asks.
    if (!ds.categoryById.has(id)) throw badRequest(`"${name}": no topic "${id}"`);
    out.add(id);
  }
  return out;
}

/**
 * @param {URLSearchParams} params
 * @param {{ hasMeta: boolean, categoryById: Map<string, unknown> }} ds
 */
export function parseCuration(params, ds) {
  const c = defaultCuration();

  const formats = list(params.get('formats'), 'formats');
  if (formats.length) {
    for (const f of formats) if (!FORMATS.includes(f)) throw badRequest(`"formats" must be a list of: ${FORMATS.join(', ')}`);
    const set = new Set(formats);
    if (set.size < FORMATS.length) {
      if (!ds.hasMeta) throw badRequest('"formats" needs YouTube metadata (durations), which this server doesn\'t have (see README)');
      c.formats = set;
    }
  }

  const types = list(params.get('types'), 'types');
  if (types.length) {
    for (const t of types) if (!CONTENT_TYPES.includes(t)) throw badRequest(`"types" must be a list of: ${CONTENT_TYPES.join(', ')}`);
    c.types = new Set(types);
  }

  c.muteTopics = slugs(params.get('mute_topics'), 'mute_topics', ds);
  c.followTopics = slugs(params.get('follow_topics'), 'follow_topics', ds);
  for (const id of c.followTopics) if (c.muteTopics.has(id)) throw badRequest(`topic "${id}" is both followed and muted`);

  for (const raw of list(params.get('mute_channels'), 'mute_channels')) {
    let name;
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw badRequest('"mute_channels" must be URI-encoded channel names separated by commas');
    }
    if (!name || name.length > 200) throw badRequest('"mute_channels" contains an empty or too long channel name');
    c.muteChannels.add(name);
  }

  const mix = list(params.get('mix'), 'mix');
  const given = new Set();
  for (const pair of mix) {
    const m = /^([a-z]+):(\d)$/.exec(pair);
    if (!m || !MIX_SOURCES.includes(m[1]) || Number(m[2]) > 5) {
      throw badRequest(`"mix" must look like classics:3,recent:2 with sources ${MIX_SOURCES.join(', ')} and weights 0-5`);
    }
    if (given.has(m[1])) throw badRequest(`"mix" gives "${m[1]}" more than once`);
    given.add(m[1]);
    c.mix[m[1]] = Number(m[2]);
  }

  for (const key of ['news', 'cited']) {
    const v = params.get(key);
    if (v === null || v === '') continue;
    if (v !== '1' && v !== '0') throw badRequest(`"${key}" must be 1 or 0`);
    c[key] = v === '1';
  }
  return c;
}

/** Whether a video passes the viewer's curation (before any source picks it). */
export function allowedByCuration(v, c) {
  if (!c.news && v.shelf_life === 'news') return false;
  if (!c.cited && (v.hn?.recommenders ?? 0) === 0) return false;
  if (c.types && !c.types.has(v.content_type)) return false;
  if (c.formats) {
    const f = formatOf(v);
    if (!f || !c.formats.has(f)) return false;
  }
  if (c.muteChannels.has(v.channel)) return false;
  if (c.muteTopics.size && v.categories.some((cat) => c.muteTopics.has(cat.id))) return false;
  return true;
}

/**
 * A stable cache key for a curation object. `withMix: false` leaves out the mix weights,
 * which only the cheap ordering step (buildFeed) reads, not prepareFeed.
 */
export function curationKey(c, { withMix = true } = {}) {
  const sorted = (s) => (s ? [...s].sort() : null);
  const mix = withMix ? Object.keys(c.mix).sort().map((k) => [k, c.mix[k]]) : null;
  return JSON.stringify([sorted(c.formats), sorted(c.types), sorted(c.muteTopics), sorted(c.followTopics), sorted(c.muteChannels), mix, c.news, c.cited]);
}

/**
 * Smooth weighted round-robin (as in nginx upstreams): a repeating order of source names in
 * which each appears in proportion to its weight, spread out rather than bunched.
 */
export function mixPattern(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  const current = Object.fromEntries(entries.map(([name]) => [name, 0]));
  const pattern = [];
  for (let i = 0; i < total; i++) {
    let best = null;
    for (const [name, w] of entries) {
      current[name] += w;
      if (best === null || current[name] > current[best]) best = name;
    }
    current[best] -= total;
    pattern.push(best);
  }
  return pattern;
}
