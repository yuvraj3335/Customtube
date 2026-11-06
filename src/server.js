// Custom Tube HTTP server: a JSON API over the in-memory dataset, the static client, and the
// app shell for every client route (with per-page <title>/<meta> so shared links preview).

import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDataset, canonical } from './data.js';
import { buildFeed, prepareFeed } from './feed.js';
import { relatedFor } from './related.js';
import { searchVideos, suggest } from './search.js';
import { searchable } from './data.js';
import { createEmbedder } from './embedder.js';
import { createRateLimiter } from './ratelimit.js';
import { LRUCache } from 'lru-cache';
import { CONTENT_TYPES, DATES, DURATIONS, FILTER_KEYS, LEVELS, parseFilters, matchesFilters, sortOptions, sortVideos } from './filters.js';
import { createYoutube, parseChannelInput } from './youtube.js';
import { PAGE_TOKEN_RE } from './innertube.js';
import { DEFAULT_MIX, FORMATS, LONG_MIN_SECONDS, MIX_SOURCES, SHORT_MAX_SECONDS, curationKey, formatOf, parseCuration } from './curation.js';
import {
  HttpError,
  SECURITY_HEADERS,
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
const MAX_PROFILE_IDS = 200; // seen, docs lookups
const MAX_VOTE_IDS = 500; // likes and dislikes: the client keeps up to 500 of each
const MAX_QUERY = 200;
const LIVE_MAX_CHANNELS = 30;
const LIVE_MAX_TOPICS = 16; // searches the viewer follows plus the collection topics they follow
const LIVE_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
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
  if (/^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(pathname)) return plain('Channel');
  const fixed = { '/shorts': 'Shorts', '/channels': 'Channels', '/topics': 'Topics', '/browse': 'All videos', '/liked': 'Liked', '/later': 'Watch later', '/history': 'History', '/about': 'About', '/settings': 'Customize your feed', '/mine': 'My videos', '/library': 'Library', '/lists': 'Lists' };
  if (/^\/list\/[a-z0-9]{8}$/.test(pathname)) return plain('List');
  return fixed[pathname] ? plain(fixed[pathname]) : null;
}

// Served from the site root rather than /static/: a service worker only controls pages under
// its own path, and browsers look for the manifest by its link.
const ROOT_FILES = new Set(['sw.js', 'manifest.webmanifest']);

function loadStatic(publicDir) {
  const files = new Map();
  for (const name of readdirSync(publicDir)) {
    const type = STATIC_TYPES[path.extname(name)];
    if (!type || name === 'index.html') continue;
    files.set(ROOT_FILES.has(name) ? `/${name}` : `/static/${name}`, { body: readFileSync(path.join(publicDir, name)), type, root: ROOT_FILES.has(name) });
  }
  // Every deploy gets a version from the content of the client files. Pages ask for
  // /static/app.js?v=<version>, and the service worker names its cache after it, so a browser
  // never mixes a new page with an old cached script.
  const version = createHash('sha1')
    .update(readFileSync(path.join(publicDir, 'index.html')))
    .update([...files.keys()].sort().map((k) => `${k}:${createHash('sha1').update(files.get(k).body).digest('hex')}`).join('|'))
    .digest('hex')
    .slice(0, 12);
  const sw = files.get('/sw.js');
  if (sw) sw.body = Buffer.from(String(sw.body).replaceAll('__VERSION__', version));
  for (const f of files.values()) {
    // Compressed once here rather than on every request, with an ETag per encoding.
    const gz = gzipSync(f.body, { level: 9 });
    f.gz = gz.length < f.body.length ? gz : null;
    f.etag = `"${createHash('sha1').update(f.body).digest('base64url').slice(0, 16)}"`;
  }
  return { files, version };
}

/** Whether an If-None-Match header matches `etag` (weak comparison, lists and "*" allowed). */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
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
      if (size > MAX_BODY) {
        req.resume(); // drain the rest so the client can read the 413
        throw new HttpError(413, `request body is larger than ${MAX_BODY} bytes`, { connection: 'close' });
      }
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
      // Exact limits per list are checked when the values are parsed.
      if (value.length > MAX_VOTE_IDS) throw badRequest(`"${key}" accepts at most ${MAX_VOTE_IDS} values`);
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
  // Building new profiles may use at most ~30% of one core, measured in real CPU milliseconds.
  prepCpuBudget = createRateLimiter({ capacity: 1000, refillPerSecond: 300 }),
  // Searches across all clients (each costs ~5-15 ms).
  searchGlobalLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 30 }),
  // As-you-type suggestions (each ~2-3 ms), across all clients.
  suggestGlobalLimiter = createRateLimiter({ capacity: 200, refillPerSecond: 100 }),
  // Everything else in the API is cheap, but not free: a generous per-client budget.
  apiLimiter = createRateLimiter({ capacity: 240, refillPerSecond: 40 }),
  fetchImpl = globalThis.fetch,
  // Live videos from YouTube (channel feeds; topic searches with a Data API key).
  youtube = null,
  // A live feed fetches up to ~40 channel feeds the first time, then reads them from cache.
  liveLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 0.2 }),
  // New topic searches asked of YouTube, per client (with a Data API key, the server's daily quota
  // has its own server-wide budget in youtube.js).
  topicLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 / 15 }),
  // Search-box pages from all of YouTube, per client.
  ytSearchLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 0.5 }),
  maxConnections = 2000,
  log = console,
  now = () => Date.now(),
}) {
  const yt = youtube ?? createYoutube({ fetchImpl, log, now });
  // The collection's channels, by how much HN recommends them (built once, on first use).
  let channelIndex = null;
  const channelsOf = () => {
    if (channelIndex) return channelIndex;
    const by = new Map();
    for (const v of ds.videos) {
      if (!v.visible || !v.channel) continue;
      let c = by.get(v.channel);
      if (!c) by.set(v.channel, (c = { channel: v.channel, videos: [], recommenders: 0 }));
      c.videos.push(v);
      c.recommenders += v.hn?.recommenders ?? 0; // recommendations: one person recommending two videos counts twice
    }
    for (const c of by.values()) c.videos.sort((a, b) => b.score - a.score || a.vid.localeCompare(b.vid));
    const ranked = [...by.values()].sort((a, b) => b.recommenders - a.recommenders || b.videos.length - a.videos.length || a.channel.localeCompare(b.channel));
    channelIndex = { by, ranked };
    return channelIndex;
  };
  const oembedCache = new LRUCache({ max: 2000 });
  const relatedCache = new LRUCache({ max: 2000 });
  const searchCache = new LRUCache({ max: 500 });
  const suggestCache = new LRUCache({ max: 2000 });
  const { files: staticFiles, version } = loadStatic(publicDir);
  const shell = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace('/static/app.js"', `/static/app.js?v=${version}"`)
    .replace('/static/styles.css"', `/static/styles.css?v=${version}"`);
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

  // Up next scans every video's embedding (~5 ms), and the answer never changes. One entry per
  // video, at the largest size; smaller requests are a slice.
  const RELATED_MAX = 40;
  function cachedRelated(vid, n) {
    let out = relatedCache.get(vid);
    if (!out) {
      out = relatedFor(ds, vid, RELATED_MAX);
      relatedCache.set(vid, out);
    }
    return out.slice(0, n);
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
      if (!mine.ok) throw new HttpError(429, 'too many new feed profiles, try again shortly', { 'retry-after': String(mine.retryAfter) });
      // Server-wide: refuse while the CPU budget for new profiles is spent, then charge what
      // this one really took.
      const cpu = prepCpuBudget.take('*', 50);
      if (!cpu.ok) throw new HttpError(503, 'busy building feeds, try again shortly', { 'retry-after': String(cpu.retryAfter) });
      const t0 = performance.now();
      prepared = prepareFeed(ds, profile, curation);
      prepCpuBudget.charge('*', Math.max(0, performance.now() - t0 - 50));
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
        live: { channels: true, topics: yt.canSearch, search: true, topics_keyless: Boolean(yt.keylessTopics), max_channels: LIVE_MAX_CHANNELS, max_topics: LIVE_MAX_TOPICS },
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

    '/api/live': async (req, res, params) => {
      assertKnownParams(params, ['channels', 'topics']);
      assertNonEmpty(params, ['channels', 'topics']);
      const channels = [...new Set((params.get('channels') ?? '').split(',').filter(Boolean))];
      for (const c of channels) if (!LIVE_CHANNEL_RE.test(c)) throw badRequest('"channels" must be YouTube channel ids (UC…) separated by commas');
      if (channels.length > LIVE_MAX_CHANNELS) throw badRequest(`at most ${LIVE_MAX_CHANNELS} channels`);
      const topics = [...new Set((params.get('topics') ?? '').split('|').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean))];
      for (const t of topics) if (t.length > 60 || /[\u0000-\u001f]/.test(t)) throw badRequest('each topic is at most 60 characters');
      if (topics.length > LIVE_MAX_TOPICS) throw badRequest(`at most ${LIVE_MAX_TOPICS} topics, separated by |`);
      if (!channels.length && !topics.length) throw badRequest('give "channels" or "topics"');
      const who = clientKey(req);
      // Each channel YouTube must be asked about counts, so made-up ids can't flood YouTube.
      const uncached = channels.filter((id) => !yt.hasChannel(id)).length;
      const limit = liveLimiter.take(who, 1 + uncached / 5);
      if (!limit.ok) throw new HttpError(429, 'too many live refreshes, try again shortly', { 'retry-after': String(limit.retryAfter) });
      const sources = [
        ...channels.map((id) => ({ kind: 'channel', id, run: () => yt.channelUploads(id) })),
        ...topics.map((q) => ({
          kind: 'topic',
          id: q,
          run: () => {
            if (!yt.hasTopic(q)) {
              const t = topicLimiter.take(who);
              if (!t.ok) throw new HttpError(429, 'too many new topic searches, try again later');
            }
            return yt.searchTopic(q);
          },
        })),
      ];
      const settled = await Promise.allSettled(sources.map((src) => Promise.resolve().then(src.run)));
      const lists = [];
      const status = sources.map((src, i) => {
        const r = settled[i];
        if (r.status === 'rejected') {
          if (!(r.reason instanceof HttpError)) log.error?.(`live ${src.kind} failed: ${r.reason?.message}`);
          return { kind: src.kind, id: src.id, ok: false, error: r.reason instanceof HttpError ? r.reason.message : 'failed' };
        }
        const via = src.kind === 'channel' ? r.value.channel : src.id;
        lists.push(r.value.items.map((it) => ({ ...it, source: src.kind, via, ...(src.kind === 'channel' ? { channelId: src.id } : {}) })));
        return { kind: src.kind, id: src.id, ok: true, name: via, count: r.value.items.length };
      });
      // Round-robin across sources (each newest first), so one busy channel can't fill the feed.
      const items = [];
      const seenVids = new Set();
      for (let i = 0; lists.some((l) => i < l.length); i++) {
        for (const l of lists) {
          const it = l[i];
          if (!it || seenVids.has(it.vid)) continue;
          seenVids.add(it.vid);
          // Videos already in the collection come with their HN card from the regular feed.
          if (!ds.byVid.has(it.vid)) items.push(it);
        }
      }
      sendJson(req, res, 200, { items, sources: status }, { 'cache-control': 'private, max-age=60' });
    },

    // Any video on YouTube, for the search box: one page at a time, `page` being the previous
    // page's `next` token.
    '/api/yt/search': async (req, res, params) => {
      assertKnownParams(params, ['q', 'page']);
      assertNonEmpty(params, ['q', 'page']);
      const q = (params.get('q') ?? '').trim().replace(/\s+/g, ' ');
      if (!q || q.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(q)) throw badRequest(`"q" is 1 to ${MAX_QUERY} characters`);
      const page = params.get('page');
      if (page !== null && !PAGE_TOKEN_RE.test(page)) throw badRequest('"page" must be the "next" token of an earlier page');
      if (!yt.hasPage(q, page)) {
        const limit = ytSearchLimiter.take(clientKey(req));
        if (!limit.ok) throw new HttpError(429, 'too many searches, try again shortly', { 'retry-after': String(limit.retryAfter) });
      }
      const out = await yt.searchVideos(q, { page });
      sendJson(req, res, 200, { q, items: out.items.map((it) => ({ ...it, in_collection: ds.byVid.has(it.vid) })), next: out.next }, { 'cache-control': 'private, max-age=300' });
    },

    '/api/live/resolve': async (req, res, params) => {
      assertKnownParams(params, ['q']);
      const target = parseChannelInput(params.get('q'));
      if (!target) throw badRequest('paste a YouTube channel link, a @handle, a channel id (UC…) or a link to one of its videos');
      const limit = oembedLimiter.take(clientKey(req));
      if (!limit.ok) throw new HttpError(429, 'too many lookups, try again shortly', { 'retry-after': String(limit.retryAfter) });
      sendJson(req, res, 200, await yt.resolveChannel(target));
    },

    '/api/channels': (req, res, params) => {
      assertKnownParams(params, ['n', 'offset']);
      assertNonEmpty(params, ['n', 'offset']);
      const n = parseIntParam(params.get('n'), 'n', { min: 1, max: 100, def: 24 });
      const offset = parseIntParam(params.get('offset'), 'offset', { min: 0, max: 100_000, def: 0 });
      const { ranked } = channelsOf();
      const items = ranked.slice(offset, offset + n).map((c) => ({ channel: c.channel, videos: c.videos.length, recommenders: c.recommenders, top: c.videos.slice(0, 3).map((v) => v.vid) }));
      sendJson(req, res, 200, { items, next_offset: offset + n < ranked.length ? offset + n : null, total: ranked.length }, { 'cache-control': 'public, max-age=300' });
    },

    '/api/channel': (req, res, params) => {
      assertKnownParams(params, ['name', 'n']);
      assertNonEmpty(params, ['name', 'n']);
      const name = params.get('name');
      if (!name || name.length > 200) throw badRequest('"name" is a channel name, at most 200 characters');
      const n = parseIntParam(params.get('n'), 'n', { min: 1, max: 60, def: 24 });
      const c = channelsOf().by.get(name);
      sendJson(req, res, 200, { channel: name, total: c?.videos.length ?? 0, recommenders: c?.recommenders ?? 0, items: (c?.videos ?? []).slice(0, n).map((v) => cardDto(v)) }, { 'cache-control': 'public, max-age=300' });
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
        likes: parseVidList(params.get('like'), 'like', MAX_VOTE_IDS),
        dislikes: parseVidList(params.get('dislike'), 'dislike', MAX_VOTE_IDS),
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

    '/api/suggest': (req, res, params) => {
      assertKnownParams(params, ['q']);
      const q = (params.get('q') ?? '').trim();
      if (!q) throw badRequest('"q" is required');
      if (q.length > MAX_QUERY || searchable(q).length > MAX_QUERY * 2) throw badRequest(`"q" must be at most ${MAX_QUERY} characters`);
      const key = q.toLowerCase();
      let body = suggestCache.get(key);
      if (!body) {
        const all = suggestGlobalLimiter.take('*');
        if (!all.ok) throw new HttpError(503, 'busy, try again shortly', { 'retry-after': String(all.retryAfter) });
        const out = suggest(ds, q);
        body = { videos: out.videos.map((vid) => cardDto(ds.byVid.get(vid))), topics: out.topics };
        suggestCache.set(key, body);
      }
      sendJson(req, res, 200, body);
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
      const cacheKey = JSON.stringify([q.toLowerCase(), filters, embedder.status() === 'ready']);
      const hit = searchCache.get(cacheKey);
      if (hit) return sendJson(req, res, 200, hit);
      const all = searchGlobalLimiter.take('*');
      if (!all.ok) throw new HttpError(503, 'lots of searches right now, try again shortly', { 'retry-after': String(all.retryAfter) });
      let qvec = null;
      try {
        qvec = await embedder.embed(q);
      } catch (err) {
        log.error?.(`query embedding failed, using keyword search: ${err.message}`);
      }
      if (qvec && qvec.length !== ds.dim) {
        // A model that doesn't match the data's vectors would make every similarity garbage.
        log.error?.(`query vectors have ${qvec.length} dimensions but the data has ${ds.dim}; using keyword search`);
        qvec = null;
      }
      const out = searchVideos(ds, { q, qvec, filters, nowMs: now() });
      const body = { mode: out.mode, weak: out.weak, items: out.results.map((r) => cardDto(ds.byVid.get(r.vid), { via: r.via })) };
      // "Past year" moves with the clock, so those results aren't cached.
      if (!filters.date) searchCache.set(cacheKey, body);
      sendJson(req, res, 200, body);
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

    if (pathname === '/healthz') {
      // "degraded": serving, but search is keyword-only because the model isn't available.
      const status = embedder.status();
      return sendJson(req, res, 200, { ok: true, degraded: status === 'failed', videos: ds.stats.videos, embedder: status });
    }

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
    if (file) {
      // The service worker must be re-checked on every load, or app updates never reach users.
      // A versioned URL (?v=<this deploy>) never changes, so it can be cached for good.
      const pinned = url.searchParams.get('v') === version;
      const cache = file.root ? 'no-cache' : pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
      const gzip = Boolean(file.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || ''));
      const etag = gzip ? file.etag.replace(/"$/, '-gz"') : file.etag;
      const headers = { ...SECURITY_HEADERS, 'content-type': file.type, 'cache-control': cache, etag, vary: 'Accept-Encoding' };
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        return res.end();
      }
      const payload = gzip ? file.gz : file.body;
      if (gzip) headers['content-encoding'] = 'gzip';
      headers['content-length'] = payload.length;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : payload);
    }

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
      'x-app-shell': '1', // the service worker keeps only this as its offline page
    });
  }

  // Timeouts are checked every 2 s (Node's default 30 s made a 10 s header timeout fire at ~32 s).
  const server = http.createServer({ connectionsCheckingInterval: 2000 }, (req, res) => {
    if (server.closing) res.setHeader('connection', 'close');
    handle(req, res).catch((err) => {
      log.error?.(`unhandled: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = maxConnections;

  /** Stop taking connections, let in-flight requests finish, force-close after `graceMs`. */
  server.shutdown = (graceMs = 10_000) =>
    new Promise((resolve) => {
      server.closing = true;
      const force = setTimeout(() => server.closeAllConnections(), graceMs);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
  return { server, handle };
}

// ---------- entry point ----------

function parsePublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL must be a full URL like https://tube.example.com (got ${JSON.stringify(value)})`);
  }
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash) throw new Error('PUBLIC_URL must be an http(s) origin with no query or fragment');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function readConfig(env = process.env) {
  const dataDir = path.resolve(env.CUSTOMTUBE_DATA_DIR || path.join(ROOT, 'data/raw/export'));
  const port = parseIntParam(env.PORT ?? '', 'PORT', { min: 0, max: 65535, def: 8080 });
  return {
    dataDir,
    metaFile: path.resolve(env.CUSTOMTUBE_YOUTUBE_META || path.join(ROOT, 'data/youtube_meta.jsonl')),
    host: env.HOST || '127.0.0.1',
    port,
    embedder: !/^(off|0|false|no)$/i.test(env.CUSTOMTUBE_EMBEDDER ?? ''),
    cacheDir: path.resolve(env.CUSTOMTUBE_MODEL_CACHE || path.join(ROOT, '.cache/models')),
    publicUrl: env.PUBLIC_URL ? parsePublicUrl(env.PUBLIC_URL) : null,
    maxConnections: parseIntParam(env.MAX_CONNECTIONS ?? '', 'MAX_CONNECTIONS', { min: 1, max: 1_000_000, def: 2000 }),
    // TRUST_PROXY=N: N proxies of ours sit in front of the server (1 = a single reverse proxy).
    trustProxy: parseIntParam(env.TRUST_PROXY ?? '', 'TRUST_PROXY', { min: 0, max: 10, def: 0 }),
    // A YouTube Data API key turns on live topic searches (channel feeds work without one).
    youtubeApiKey: env.YOUTUBE_API_KEY?.trim() || null,
    youtubeDailyBudget: parseIntParam(env.YOUTUBE_DAILY_QUOTA ?? '', 'YOUTUBE_DAILY_QUOTA', { min: 0, max: 1_000_000, def: 8000 }),
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
  for (const w of ds.warnings) console.warn(`data warning: ${w}`);
  const embedder = createEmbedder({ cacheDir: cfg.cacheDir, enabled: cfg.embedder });
  embedder.start();
  const youtube = createYoutube({ apiKey: cfg.youtubeApiKey, dailyBudget: cfg.youtubeDailyBudget });
  console.info(`live YouTube: channel feeds and search on; followed topics via ${cfg.youtubeApiKey ? 'the Data API' : 'keyless search'}`);
  const { server } = createApp({ ds, embedder, youtube, publicUrl: cfg.publicUrl, trustProxy: cfg.trustProxy, maxConnections: cfg.maxConnections });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Set PORT to a free port.` : `Could not listen on ${cfg.host}:${cfg.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    console.info(`Custom Tube listening on http://${addr.address}:${addr.port}`);
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`${signal}: finishing open requests, then exiting`);
    server.shutdown(10_000).then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
