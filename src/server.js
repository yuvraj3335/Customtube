// Custom Tube HTTP server: a JSON API over the in-memory dataset, the static client, and the
// app shell for every client route (with per-page <title>/<meta> so shared links preview).

import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDataset, canonical } from './data.js';
import { buildFeed, prepareFeed } from './feed.js';
import { relatedFor } from './related.js';
import { searchVideos } from './search.js';
import { searchable } from './data.js';
import { createEmbedder } from './embedder.js';
import { createRateLimiter } from './ratelimit.js';
import { LRUCache } from 'lru-cache';
import { CONTENT_TYPES, DATES, DURATIONS, FILTER_KEYS, LEVELS, parseFilters, matchesFilters, sortOptions, sortVideos } from './filters.js';
import { DEFAULT_MIX, FORMATS, LONG_MIN_SECONDS, MIX_SOURCES, SHORT_MAX_SECONDS, curationKey, formatOf, parseCuration } from './curation.js';
import {
  HttpError,
  assertKnownParams,
  assertNonEmpty,
  badRequest,
  escapeHtml,
  parseIntParam,
  parseSeed,
  parseSlug,
  parseVid,
  parseVidList,
  send,
  sendJson,
} from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_NAME = 'Custom Tube';
const MAX_PROFILE_IDS = 200;
const MAX_QUERY = 200;
const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
};

// ---------- response shapes ----------

function ytFields(v) {
  return v.yt
    ? { duration_s: v.yt.duration_s, views: v.yt.views, likes: v.yt.likes, published: v.yt.published, embeddable: v.yt.embeddable }
    : null;
}

export function cardDto(v, extra = {}) {
  return {
    vid: v.vid,
    title: v.title,
    channel: v.channel,
    content_type: v.content_type,
    shelf_life: v.shelf_life,
    category: v.categories[0] ? { id: v.categories[0].id, name: v.categories[0].name } : null,
    recommenders: v.hn?.recommenders ?? 0,
    rec_months: v.hn?.rec_months ?? 0,
    score: v.score,
    last_rec_month: v.lastRecMonth,
    yt: ytFields(v),
    format: formatOf(v),
    ...extra,
  };
}

function videoDto(ds, v) {
  return {
    vid: v.vid,
    url: v.url,
    title: v.title,
    channel: v.channel,
    summary: v.summary,
    why_hn: v.why_hn,
    content_type: v.content_type,
    level: v.level,
    shelf_life: v.shelf_life,
    primary_topic: v.primary_topic,
    tags: v.tags,
    categories: v.categories.map((c) => ({ id: c.id, name: c.name, area: c.area, area_name: c.area_name })),
    quote: v.quote ?? null,
    hn: v.hn,
    score: v.score,
    last_rec_month: v.lastRecMonth,
    duplicate_of: v.dupOf,
    yt: ytFields(v),
    mentions: (ds.mentionsByVid.get(v.vid) ?? []).map((m) => ({
      id: m.hn_comment_id,
      url: m.hn_url,
      author: m.author,
      month: m.month,
      story_title: m.story_title,
      stance: m.stance,
      why: m.why,
      quote: m.quote,
      text: m.text,
    })),
  };
}

// ---------- app shell ----------

function headTags({ title, description, image, url }) {
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
  ];
  if (image) tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
  if (url) {
    tags.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
    tags.push(`<meta property="og:url" content="${escapeHtml(url)}">`);
  }
  return tags.join('\n');
}

const DEFAULT_DESCRIPTION = 'The YouTube videos Hacker News keeps recommending: browse by topic, search by meaning, and get a feed tuned by what you like.';

/** Which client route a path is, and its page metadata. Returns null for unknown paths. */
function appRoute(ds, pathname) {
  const plain = (title, status = 200) => ({ status, title: `${title} · ${SITE_NAME}`, description: DEFAULT_DESCRIPTION });
  if (pathname === '/') return { status: 200, title: `${SITE_NAME}: videos Hacker News recommends`, description: DEFAULT_DESCRIPTION };
  let m = /^\/watch\/([A-Za-z0-9_-]{11})$/.exec(pathname);
  if (m) {
    const v = ds.byVid.get(m[1]);
    // Not in the collection: it may be a video the viewer added by URL, which only their
    // browser knows about, so serve the app normally and let the client decide.
    if (!v) return plain('Video');
    return {
      status: 200,
      title: `${v.title} · ${SITE_NAME}`,
      description: v.summary,
      image: `https://i.ytimg.com/vi/${v.vid}/hq2.jpg`,
      canonicalPath: `/watch/${canonical(ds, v.vid).vid}`,
    };
  }
  m = /^\/c\/([a-z0-9-]+)$/.exec(pathname);
  if (m) {
    const c = ds.categoryById.get(m[1]);
    return c ? { status: 200, title: `${c.name} · ${SITE_NAME}`, description: c.description } : plain('Topic not found', 404);
  }
  m = /^\/a\/([a-z0-9-]+)$/.exec(pathname);
  if (m) {
    const a = ds.areaById.get(m[1]);
    return a ? plain(a.name) : plain('Topic not found', 404);
  }
  m = /^\/search\/(.+)$/.exec(pathname);
  if (m) {
    let q;
    try {
      q = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    return plain(`${q.slice(0, 80)} - search`);
  }
  const fixed = { '/topics': 'Topics', '/browse': 'All videos', '/liked': 'Liked', '/later': 'Watch later', '/history': 'History', '/about': 'About', '/settings': 'Customize your feed', '/mine': 'My videos', '/library': 'Library', '/lists': 'Lists' };
  if (/^\/list\/[a-z0-9]{8}$/.test(pathname)) return plain('List');
  return fixed[pathname] ? plain(fixed[pathname]) : null;
}

function loadStatic(publicDir) {
  const files = new Map();
  for (const name of readdirSync(publicDir)) {
    const type = STATIC_TYPES[path.extname(name)];
    if (!type || name === 'index.html') continue;
    files.set(`/static/${name}`, { body: readFileSync(path.join(publicDir, name)), type });
  }
  return files;
}

// ---------- POST bodies ----------

const MAX_BODY = 64 * 1024;

/** The client disconnected; there is nobody to answer and nothing worth logging. */
class ClientGoneError extends Error {}

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'send the feed request as application/json');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, `request body is larger than ${MAX_BODY} bytes`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new ClientGoneError(); // the client hung up mid-body
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw badRequest('request body is not valid JSON');
  }
}

/**
 * Turn a JSON feed request into the same parameters the GET form uses, so both go through
 * one parser. Lists are arrays of strings, `mix` is an object of weights, flags are booleans.
 */
export function feedParamsFromJson(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('request body must be a JSON object');
  const params = new URLSearchParams();
  const lists = ['like', 'dislike', 'seen', 'formats', 'types', 'mute_topics', 'follow_topics', 'mute_channels'];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (lists.includes(key)) {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) throw badRequest(`"${key}" must be an array of strings`);
      if (!value.length) {
        // Same rule as GET: an empty filter is an error, not "no filter". Profile lists may be empty.
        if (['like', 'dislike', 'seen'].includes(key)) continue;
        throw badRequest(`"${key}" is empty`);
      }
      if (value.length > 200) throw badRequest(`"${key}" accepts at most 200 values`);
      params.set(key, (key === 'mute_channels' ? value.map(encodeURIComponent) : value).join(','));
    } else if (key === 'mix') {
      if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('"mix" must be an object of weights');
      const pairs = Object.entries(value).map(([k, w]) => {
        if (!Number.isInteger(w)) throw badRequest('"mix" weights must be whole numbers');
        return `${k}:${w}`;
      });
      if (!pairs.length) throw badRequest('"mix" is empty');
      params.set('mix', pairs.join(','));
    } else if (key === 'news' || key === 'cited') {
      if (typeof value !== 'boolean') throw badRequest(`"${key}" must be true or false`);
      params.set(key, value ? '1' : '0');
    } else if (key === 'offset' || key === 'n') {
      if (!Number.isInteger(value)) throw badRequest(`"${key}" must be a whole number`);
      params.set(key, String(value));
    } else if (key === 'seed') {
      if (typeof value !== 'string') throw badRequest('"seed" must be a string');
      params.set(key, value);
    } else {
      throw badRequest(`unknown field "${key}"`);
    }
  }
  return params;
}

// ---------- the app ----------

/**
 * @param {{ ds: object, embedder: { embed(text: string): Promise<Float32Array|null>, status(): string },
 *           publicDir?: string, publicUrl?: string|null, trustProxy?: number,
 *           searchLimiter?: { take(key: string): { ok: boolean, retryAfter: number } },
 *           log?: Console, now?: () => number }} options
 */
export function createApp({
  ds,
  embedder,
  publicDir = path.join(ROOT, 'public'),
  publicUrl = null,
  trustProxy = 0, // number of proxies of ours in front of the server (0 = none)
  searchLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 0.5 }),
  oembedLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.2 }),
  // A feed costs up to ~150 ms of CPU for a big profile when nothing is cached.
  feedLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 3 }),
  // Building a new profile's feed costs ~140 ms; a cached profile with a new seed ~2 ms. So new
  // profiles get a tighter budget, per client and for the whole server.
  prepLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.5 }),
  prepGlobalLimiter = createRateLimiter({ capacity: 40, refillPerSecond: 4 }),
  // Everything else in the API is cheap, but not free: a generous per-client budget.
  apiLimiter = createRateLimiter({ capacity: 240, refillPerSecond: 40 }),
  fetchImpl = globalThis.fetch,
  log = console,
  now = () => Date.now(),
}) {
  const oembedCache = new LRUCache({ max: 2000 });
  const relatedCache = new LRUCache({ max: 2000 });
  const staticFiles = loadStatic(publicDir);
  const shell = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  if (!shell.includes('<!--HEAD-->')) throw new Error('public/index.html must contain <!--HEAD-->');
  const feedCache = new LRUCache({ max: 300 }); // full feeds, per (profile, curation, seed)
  const prepCache = new LRUCache({ max: 150 }); // seed-independent work, per (profile, curation)
  const base = publicUrl ? publicUrl.replace(/\/+$/, '') : null;

  // Behind N proxies of ours, the client's address is the Nth X-Forwarded-For entry from the
  // right (each proxy appends the address it saw). Anything further left came from the client
  // and can be forged.
  const clientKey = (req) => {
    if (trustProxy > 0) {
      const hops = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (hops.length) return hops[Math.max(0, hops.length - trustProxy)];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // Up next scans every video's embedding (~5 ms), and the answer never changes.
  function cachedRelated(vid, n) {
    const key = `${vid}:${n}`;
    let out = relatedCache.get(key);
    if (!out) {
      out = relatedFor(ds, vid, n);
      relatedCache.set(key, out);
    }
    return out;
  }

  function getFeed(req, profile, curation) {
    const { seed, ...rest } = profile;
    const prepKey = JSON.stringify(rest) + curationKey(curation, { withMix: false });
    const key = `${prepKey}\u0000${curationKey(curation)}\u0000${seed}`;
    const cached = feedCache.get(key);
    if (cached) return cached;
    let prepared = prepCache.get(prepKey);
    if (!prepared) {
      const mine = prepLimiter.take(clientKey(req));
      const all = mine.ok ? prepGlobalLimiter.take('*') : mine;
      if (!all.ok) throw new HttpError(429, 'too many new feed profiles, try again shortly', { 'retry-after': String(all.retryAfter) });
      prepared = prepareFeed(ds, profile, curation);
      prepCache.set(prepKey, prepared);
    }
    const feed = buildFeed(ds, profile, curation, prepared);
    feedCache.set(key, feed);
    return feed;
  }

  // Title and channel for a video the viewer adds by URL, from YouTube's public oEmbed
  // endpoint (no API key). Only the id is sent; the result is cached.
  async function lookupOembed(vid) {
    const cached = oembedCache.get(vid);
    if (cached) return cached;
    const target = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`;
    let res;
    try {
      res = await fetchImpl(target, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    } catch (err) {
      log.error?.(`oembed lookup for ${vid} failed: ${err.message}`);
      throw new HttpError(502, 'could not reach YouTube, try again');
    }
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      throw new HttpError(404, 'YouTube has no public, embeddable video with that id');
    }
    if (!res.ok) {
      log.error?.(`oembed lookup for ${vid} returned ${res.status}`);
      throw new HttpError(502, 'YouTube lookup failed, try again');
    }
    // oEmbed answers are a few hundred bytes; refuse anything absurd rather than buffering it.
    const text = await res.text().catch(() => '');
    let body = null;
    if (text.length <= 64 * 1024) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!body || typeof body.title !== 'string') throw new HttpError(502, 'YouTube returned an unexpected answer');
    const out = {
      vid,
      title: body.title.slice(0, 300),
      channel: typeof body.author_name === 'string' ? body.author_name.slice(0, 200) : '',
      in_collection: false,
    };
    oembedCache.set(vid, out);
    return out;
  }

  const routes = {
    '/api/config': (req, res, params) => {
      assertKnownParams(params, []);
      sendJson(req, res, 200, {
        has_youtube_metadata: ds.hasMeta,
        search_mode: embedder.status() === 'ready' ? 'semantic' : 'keyword',
        embedder: embedder.status(),
        filters: {
          type: CONTENT_TYPES,
          level: LEVELS,
          ...(ds.hasMeta ? { date: DATES, dur: DURATIONS, gems: ['1'] } : {}),
          evergreen: ['1'],
          sort: sortOptions({ hasMeta: ds.hasMeta, search: false }),
          search_sort: sortOptions({ hasMeta: ds.hasMeta, search: true }),
        },
        curation: {
          formats: FORMATS,
          formats_available: ds.hasMeta,
          short_max_seconds: SHORT_MAX_SECONDS,
          long_min_seconds: LONG_MIN_SECONDS,
          types: CONTENT_TYPES,
          mix_sources: MIX_SOURCES,
          default_mix: DEFAULT_MIX,
          max_mix_weight: 5,
        },
      });
    },

    '/api/oembed': async (req, res, params) => {
      assertKnownParams(params, ['vid']);
      const vid = parseVid(params.get('vid'));
      const known = ds.byVid.get(vid);
      if (known) return sendJson(req, res, 200, { vid, title: known.title, channel: known.channel, in_collection: true });
      const limit = oembedLimiter.take(clientKey(req));
      if (!limit.ok) throw new HttpError(429, 'too many lookups, try again shortly', { 'retry-after': String(limit.retryAfter) });
      sendJson(req, res, 200, await lookupOembed(vid));
    },

    '/api/stats': (req, res, params) => {
      assertKnownParams(params, []);
      sendJson(req, res, 200, ds.stats, { 'cache-control': 'public, max-age=300' });
    },

    '/api/browse': (req, res, params) => {
      assertKnownParams(params, []);
      sendJson(
        req,
        res,
        200,
        ds.areas.map((a) => ({
          id: a.id,
          name: a.name,
          count: a.count,
          categories: a.categories.map((c) => ({ id: c.id, name: c.name, description: c.description, count: c.count })),
        })),
        { 'cache-control': 'public, max-age=300' },
      );
    },

    '/api/feed': async (req, res, params) => {
      const limit = feedLimiter.take(clientKey(req));
      if (!limit.ok) throw new HttpError(429, 'too many feed requests, try again shortly', { 'retry-after': String(limit.retryAfter) });
      if (req.method === 'POST') {
        // One source of parameters per request, so nothing in the URL is silently ignored.
        if ([...params.keys()].length) throw badRequest('a POST takes its parameters in the JSON body, not the URL');
        params = feedParamsFromJson(await readJsonBody(req));
      }
      assertKnownParams(params, [
        'like',
        'dislike',
        'seen',
        'seed',
        'offset',
        'n',
        'formats',
        'types',
        'mute_topics',
        'follow_topics',
        'mute_channels',
        'mix',
        'news',
        'cited',
      ]);
      assertNonEmpty(params, ['formats', 'types', 'mute_topics', 'follow_topics', 'mute_channels', 'mix', 'news', 'cited']);
      const curation = parseCuration(params, ds);
      const profile = {
        likes: parseVidList(params.get('like'), 'like', MAX_PROFILE_IDS),
        dislikes: parseVidList(params.get('dislike'), 'dislike', MAX_PROFILE_IDS),
        seen: parseVidList(params.get('seen'), 'seen', MAX_PROFILE_IDS),
        seed: parseSeed(params.get('seed')),
      };
      const offset = parseIntParam(params.get('offset'), 'offset', { min: 0, max: 100_000, def: 0 });
      const n = parseIntParam(params.get('n'), 'n', { min: 1, max: 60, def: 24 });
      const feed = getFeed(req, profile, curation);
      const page = feed.slice(offset, offset + n).map((x) => cardDto(ds.byVid.get(x.vid), { reason: x.reason, source: x.source }));
      sendJson(req, res, 200, { items: page, total: feed.length, next_offset: offset + n < feed.length ? offset + n : null });
    },

    '/api/list': (req, res, params) => {
      assertKnownParams(params, ['cat', 'area', 'offset', 'n', ...FILTER_KEYS]);
      assertNonEmpty(params, ['cat', 'area', ...FILTER_KEYS]);
      const cat = params.get('cat') ? parseSlug(params.get('cat'), 'cat') : null;
      const area = params.get('area') ? parseSlug(params.get('area'), 'area') : null;
      if (cat && area) throw badRequest('use either "cat" or "area", not both');
      if (cat && !ds.categoryById.has(cat)) throw new HttpError(404, `no topic "${cat}"`);
      if (area && !ds.areaById.has(area)) throw new HttpError(404, `no area "${area}"`);
      const filters = parseFilters(params, { hasMeta: ds.hasMeta });
      const offset = parseIntParam(params.get('offset'), 'offset', { min: 0, max: 100_000, def: 0 });
      const n = parseIntParam(params.get('n'), 'n', { min: 1, max: 60, def: 24 });
      const t = now();
      const list = ds.videos.filter(
        (v) =>
          v.visible &&
          (!cat || v.categories.some((c) => c.id === cat)) &&
          (!area || v.categories.some((c) => c.area === area)) &&
          matchesFilters(v, filters, t),
      );
      sortVideos(list, filters.sort);
      sendJson(req, res, 200, {
        items: list.slice(offset, offset + n).map((v) => cardDto(v)),
        total: list.length,
        next_offset: offset + n < list.length ? offset + n : null,
      });
    },

    '/api/video': (req, res, params) => {
      assertKnownParams(params, ['vid']);
      const v = ds.byVid.get(parseVid(params.get('vid')));
      if (!v) throw new HttpError(404, 'no such video');
      sendJson(req, res, 200, videoDto(ds, v));
    },

    '/api/related': (req, res, params) => {
      assertKnownParams(params, ['vid', 'n']);
      const vid = parseVid(params.get('vid'));
      if (!ds.byVid.has(vid)) throw new HttpError(404, 'no such video');
      const n = parseIntParam(params.get('n'), 'n', { min: 1, max: 40, def: 20 });
      sendJson(req, res, 200, {
        items: cachedRelated(vid, n).map((r) => cardDto(ds.byVid.get(r.vid), { reason: r.reason })),
      });
    },

    '/api/docs': (req, res, params) => {
      assertKnownParams(params, ['vids']);
      const vids = parseVidList(params.get('vids'), 'vids', MAX_PROFILE_IDS);
      // Ids come from the browser's saved lists, which can hold videos this dataset no longer has.
      sendJson(req, res, 200, {
        items: vids.map((vid) => ds.byVid.get(vid)).filter((v) => v && !v.gone).map((v) => cardDto(v)),
      });
    },

    '/api/search': async (req, res, params) => {
      assertKnownParams(params, ['q', ...FILTER_KEYS]);
      assertNonEmpty(params, FILTER_KEYS);
      const q = (params.get('q') ?? '').trim();
      if (!q) throw badRequest('"q" is required');
      // Normalization can expand a character into several words (U+FDFA becomes four), so the
      // limit applies after it too.
      if (q.length > MAX_QUERY || searchable(q).length > MAX_QUERY * 2) throw badRequest(`"q" must be at most ${MAX_QUERY} characters`);
      const filters = parseFilters(params, { hasMeta: ds.hasMeta, search: true });
      const limit = searchLimiter.take(clientKey(req));
      if (!limit.ok) {
        throw new HttpError(429, 'too many searches, try again shortly', { 'retry-after': String(limit.retryAfter) });
      }
      let qvec = null;
      try {
        qvec = await embedder.embed(q);
      } catch (err) {
        log.error?.(`query embedding failed, using keyword search: ${err.message}`);
      }
      const out = searchVideos(ds, { q, qvec, filters, nowMs: now() });
      sendJson(req, res, 200, {
        mode: out.mode,
        weak: out.weak,
        items: out.results.map((r) => cardDto(ds.byVid.get(r.vid), { via: r.via })),
      });
    },
  };

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(req, res, 400, { error: 'bad url' });
    }
    const { pathname } = url;
    // Only the feed takes a body (the profile can be too long for a URL).
    const allowed = pathname === '/api/feed' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
    if (!allowed.includes(req.method)) {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { allow: allowed.join(', ') });
    }

    if (pathname === '/healthz') return sendJson(req, res, 200, { ok: true, videos: ds.stats.videos, embedder: embedder.status() });

    if (pathname.startsWith('/api/')) {
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : null;
      if (!route) return sendJson(req, res, 404, { error: 'not found' });
      const budget = apiLimiter.take(clientKey(req));
      if (!budget.ok) return sendJson(req, res, 429, { error: 'too many requests, slow down' }, { 'retry-after': String(budget.retryAfter) });
      try {
        await route(req, res, url.searchParams);
      } catch (err) {
        if (err instanceof ClientGoneError) return res.destroy();
        if (err instanceof HttpError) return sendJson(req, res, err.status, { error: err.message }, err.headers);
        log.error?.(`${req.method} ${pathname} failed: ${err.stack || err.message}`);
        return sendJson(req, res, 500, { error: 'internal error' });
      }
      return;
    }

    const file = staticFiles.get(pathname);
    if (file) return send(req, res, 200, file.body, { 'content-type': file.type, 'cache-control': 'public, max-age=300' });

    const page = appRoute(ds, pathname);
    if (!page) {
      return send(req, res, 404, shell.replace('<!--HEAD-->', () => headTags({ title: `Not found · ${SITE_NAME}`, description: DEFAULT_DESCRIPTION })), {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
    }
    const head = headTags({
      title: page.title,
      description: page.description,
      image: page.image,
      url: base ? `${base}${page.canonicalPath ?? pathname}` : null,
    });
    return send(req, res, page.status, shell.replace('<!--HEAD-->', () => head), {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error?.(`unhandled: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, handle };
}

// ---------- entry point ----------

export function readConfig(env = process.env) {
  const dataDir = path.resolve(env.CUSTOMTUBE_DATA_DIR || path.join(ROOT, 'data/raw/hackertube-data'));
  const port = parseIntParam(env.PORT ?? '', 'PORT', { min: 0, max: 65535, def: 8080 });
  return {
    dataDir,
    metaFile: path.resolve(env.CUSTOMTUBE_YOUTUBE_META || path.join(ROOT, 'data/youtube_meta.jsonl')),
    host: env.HOST || '127.0.0.1',
    port,
    embedder: env.CUSTOMTUBE_EMBEDDER !== 'off',
    cacheDir: path.resolve(env.CUSTOMTUBE_MODEL_CACHE || path.join(ROOT, '.cache/models')),
    publicUrl: env.PUBLIC_URL || null,
    // TRUST_PROXY=N: N proxies of ours sit in front of the server (1 = a single reverse proxy).
    trustProxy: parseIntParam(env.TRUST_PROXY ?? '', 'TRUST_PROXY', { min: 0, max: 10, def: 0 }),
  };
}

async function main() {
  const cfg = readConfig();
  const t0 = Date.now();
  const ds = loadDataset({ dataDir: cfg.dataDir, metaFile: cfg.metaFile });
  const s = ds.stats;
  console.info(
    `loaded ${s.videos} videos (${s.duplicates} duplicates hidden), ${s.mentions} mentions, ${s.categories} topics in ${Date.now() - t0} ms; ` +
      `YouTube metadata: ${ds.hasMeta ? 'yes' : 'no'}`,
  );
  const embedder = createEmbedder({ cacheDir: cfg.cacheDir, enabled: cfg.embedder });
  embedder.start();
  const { server } = createApp({ ds, embedder, publicUrl: cfg.publicUrl, trustProxy: cfg.trustProxy });
  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    console.info(`Custom Tube listening on http://${addr.address}:${addr.port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
