// Filter and sort options shared by /api/list and /api/search. Every option is validated:
// an unknown value is a 400, never silently ignored (ignoring it would widen the results).
// Options that need YouTube metadata (dates, durations, view counts) are rejected when the
// server has none, rather than matching nothing.

import { badRequest } from './http.js';

export const CONTENT_TYPES = [
  'talk',
  'lecture',
  'course',
  'documentary',
  'explainer',
  'interview',
  'podcast',
  'tutorial',
  'demo',
  'news',
  'commentary',
  'comedy',
  'music',
  'other',
];
export const LEVELS = ['general', 'intro', 'intermediate', 'advanced'];
export const DATES = ['year', '2020s', '2010s', '2000s'];
export const DURATIONS = ['short', 'medium', 'long', 'xlong'];
const BASE_SORTS = ['best', 'hn', 'recent'];
const META_SORTS = ['date', 'old', 'views', 'liked'];
export const FILTER_KEYS = ['type', 'level', 'date', 'dur', 'gems', 'evergreen', 'sort'];
const META_KEYS = new Set(['date', 'dur', 'gems']);

export const GEM_MAX_VIEWS = 100_000;
// "Over an hour" means more than 3,600 s, the same boundary as the "long" feed format.
const DURATION_TESTS = {
  short: (d) => d < 240,
  medium: (d) => d >= 240 && d < 1200,
  long: (d) => d >= 1200 && d <= 3600,
  xlong: (d) => d > 3600,
};

export function sortOptions({ hasMeta, search }) {
  return [...(search ? ['relevance'] : []), ...BASE_SORTS, ...(hasMeta ? META_SORTS : [])];
}

/**
 * @param {URLSearchParams} params
 * @param {{ hasMeta: boolean, search?: boolean }} options
 */
export function parseFilters(params, { hasMeta, search = false }) {
  const f = {};
  const pick = (key, allowed) => {
    const value = params.get(key);
    if (value === null) return;
    if (value === '') throw badRequest(`"${key}" is empty`);
    if (META_KEYS.has(key) && !hasMeta) {
      throw badRequest(`"${key}" needs YouTube metadata, which this server doesn't have (see README)`);
    }
    if (!allowed.includes(value)) throw badRequest(`"${key}" must be one of: ${allowed.join(', ')}`);
    f[key] = value;
  };
  pick('type', CONTENT_TYPES);
  pick('level', LEVELS);
  pick('date', DATES);
  pick('dur', DURATIONS);
  pick('gems', ['1']);
  pick('evergreen', ['1']);
  const sort = params.get('sort');
  if (sort === '') throw badRequest('"sort" is empty');
  if (sort) {
    const allowed = sortOptions({ hasMeta, search });
    if (META_SORTS.includes(sort) && !hasMeta) {
      throw badRequest(`sort "${sort}" needs YouTube metadata, which this server doesn't have (see README)`);
    }
    if (!allowed.includes(sort)) throw badRequest(`"sort" must be one of: ${allowed.join(', ')}`);
    f.sort = sort;
  } else {
    f.sort = search ? 'relevance' : 'best';
  }
  return f;
}

function inDate(published, date, nowMs) {
  if (!published) return false;
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return false;
  if (date === 'year') return nowMs - t <= 365 * 86400 * 1000 && t <= nowMs;
  const year = new Date(t).getUTCFullYear();
  const decade = { '2020s': 2020, '2010s': 2010, '2000s': 2000 }[date];
  return year >= decade && year < decade + 10;
}

export function matchesFilters(v, f, nowMs = Date.now()) {
  if (f.type && v.content_type !== f.type) return false;
  if (f.level && v.level !== f.level) return false;
  if (f.evergreen && v.shelf_life === 'news') return false;
  if (f.date && !inDate(v.yt?.published, f.date, nowMs)) return false;
  if (f.dur) {
    const d = v.yt?.duration_s;
    if (d === null || d === undefined || !DURATION_TESTS[f.dur](d)) return false;
  }
  if (f.gems) {
    const views = v.yt?.views;
    if (views === null || views === undefined || views >= GEM_MAX_VIEWS) return false;
    if ((v.hn?.recommenders ?? 0) === 0) return false;
  }
  return true;
}

const byScore = (a, b) => b.score - a.score || a.vid.localeCompare(b.vid);
const time = (v) => {
  const t = Date.parse(v.yt?.published ?? '');
  return Number.isFinite(t) ? t : null;
};
// Videos missing the sort key go last, whatever the direction.
const missingLast = (ka, kb, cmp) => (ka === null ? (kb === null ? 0 : 1) : kb === null ? -1 : cmp(ka, kb));

/** Sort a list of videos in place for one of the list sort options ("relevance" is search-only). */
export function sortVideos(list, sort) {
  switch (sort) {
    case 'hn':
      return list.sort((a, b) => (b.hn?.recommenders ?? 0) - (a.hn?.recommenders ?? 0) || byScore(a, b));
    case 'recent':
      return list.sort(
        (a, b) => missingLast(a.lastRecMonth, b.lastRecMonth, (x, y) => y.localeCompare(x)) || byScore(a, b),
      );
    case 'date':
      return list.sort((a, b) => missingLast(time(a), time(b), (x, y) => y - x) || byScore(a, b));
    case 'old':
      return list.sort((a, b) => missingLast(time(a), time(b), (x, y) => x - y) || byScore(a, b));
    case 'views':
      return list.sort((a, b) => missingLast(a.yt?.views ?? null, b.yt?.views ?? null, (x, y) => y - x) || byScore(a, b));
    case 'liked': {
      // Like ratio is noisy for tiny view counts, so those sort as if unknown.
      const ratio = (v) => (v.yt?.views >= 1000 && v.yt?.likes !== null ? v.yt.likes / v.yt.views : null);
      return list.sort((a, b) => missingLast(ratio(a), ratio(b), (x, y) => y - x) || byScore(a, b));
    }
    default:
      return list.sort(byScore);
  }
}
