// The Home feed. It is computed fresh for each (seed, likes, dislikes, seen) combination and
// holds no server-side state: the browser keeps the profile and sends it with each request.
//
// The feed interleaves several sources, each a weighted random order over eligible videos:
//   classics  - the best-scored videos (score = months recommended, strong recs count extra)
//   recent    - recommended on HN in the last 18 months of the archive
//   explore   - top videos from topics you haven't liked or opened
//   gems      - few YouTube views but recommended on HN (needs YouTube metadata)
//   similar   - nearest neighbours of what you liked (embedding cosine similarity)
//   corec     - what the same HN people who recommended your likes also recommended
//   following - the best videos in topics you follow
// Dislikes push down (or drop) videos that are very similar to the disliked ones.
// The viewer's curation (src/curation.js) decides which videos may enter at all and how
// often each source gets a turn.

import { canonical, monthIndex } from './data.js';
import { rngFor, weightedOrder } from './rng.js';
import { GEM_MAX_VIEWS } from './filters.js';
import { allowedByCuration, defaultCuration, mixPattern } from './curation.js';
import { dotRows } from './vec.js';

export const FEED_LENGTH = 720;
const PROFILE_CAP = 30; // most recent likes/dislikes used for "similar", "corec" and the soft dislike push-down
const DROP_CAP = 100; // most recent dislikes whose near-copies are dropped outright
const RECENT_MONTHS = 18;
const DISLIKE_DROP = 0.88;

const quote = (title) => `“${title.length > 60 ? `${title.slice(0, 57)}…` : title}”`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function profileVideos(ds, vids) {
  const out = [];
  const seen = new Set();
  for (const vid of vids) {
    const v = canonical(ds, vid);
    if (v && !seen.has(v.vid)) {
      seen.add(v.vid);
      out.push(v);
    }
  }
  return out;
}

/**
 * The expensive, seed-independent part of a feed: the eligible pool, dislike penalties and
 * similarity to likes. The server caches it per (profile, curation), so a new seed only pays
 * for the cheap random ordering in buildFeed.
 *
 * @param {object} ds dataset from loadDataset
 * @param {{ likes?: string[], dislikes?: string[], seen?: string[] }} profile
 * @param {ReturnType<typeof defaultCuration>} [curation]
 */
export function prepareFeed(ds, { likes = [], dislikes = [], seen = [] } = {}, curation = defaultCuration()) {
  const { dim, emb } = ds;
  const liked = profileVideos(ds, likes);
  const disliked = profileVideos(ds, dislikes);
  const opened = profileVideos(ds, seen);
  const excluded = new Set([...liked, ...disliked, ...opened].map((v) => v.vid));
  // Videos YouTube won't play in an embed can't be watched here, so the feed skips them.
  const pool = ds.videos.filter(
    (v) => v.visible && v.yt?.embeddable !== false && !excluded.has(v.vid) && allowedByCuration(v, curation),
  );

  // Dislike penalty: 0 drops a video, 1 leaves it alone.
  const dropDislikes = disliked.slice(-DROP_CAP).filter((d) => d.hasEmbedding);
  const recentDislikes = new Set(disliked.slice(-PROFILE_CAP));
  const dislikedChannels = new Set(disliked.map((d) => d.channel));
  const penalty = new Float32Array(ds.videos.length).fill(1);
  for (const v of pool) {
    let p = dislikedChannels.has(v.channel) ? 0.5 : 1;
    if (dropDislikes.length && v.hasEmbedding) {
      let max = -1; // closest of the last 100 dislikes: a near-copy is dropped
      let maxRecent = -1; // closest of the last 30: pushes similar videos down
      for (const d of dropDislikes) {
        const sim = dotRows(emb, dim, v.i, d.i);
        if (sim > max) max = sim;
        if (sim > maxRecent && recentDislikes.has(d)) maxRecent = sim;
      }
      if (max >= DISLIKE_DROP) p = 0;
      else if (maxRecent > 0.6) p *= 1 - (0.85 * (maxRecent - 0.6)) / (DISLIKE_DROP - 0.6);
    }
    penalty[v.i] = p;
  }

  const seeds = liked.slice(-PROFILE_CAP);
  let near = [];
  const withEmb = seeds.filter((l) => l.hasEmbedding);
  if (withEmb.length) {
    const scored = [];
    for (const v of pool) {
      if (!v.hasEmbedding) continue;
      let best = -1;
      let from = null;
      for (const l of withEmb) {
        const sim = dotRows(emb, dim, v.i, l.i);
        if (sim > best) {
          best = sim;
          from = l;
        }
      }
      scored.push({ v, sim: best, from });
    }
    scored.sort((a, b) => b.sim - a.sim);
    near = scored.slice(0, 400);
  }

  const agg = new Map();
  const inPool = new Set(pool.map((v) => v.vid));
  for (const l of seeds) {
    for (const r of ds.related.get(l.vid) ?? []) {
      const c = canonical(ds, r.vid);
      if (!c || !inPool.has(c.vid)) continue;
      const cur = agg.get(c.vid) ?? { v: c, w: 0, from: l, fromShared: 0 };
      cur.w += r.shared;
      if (r.shared > cur.fromShared) {
        cur.from = l;
        cur.fromShared = r.shared;
      }
      agg.set(c.vid, cur);
    }
  }

  const touched = new Set([...liked, ...disliked, ...opened].flatMap((v) => v.categories.map((c) => c.id)));
  for (const id of curation.followTopics) touched.add(id);
  return { pool, penalty, near, corec: [...agg.values()], touched, hasLikes: liked.length > 0 };
}

/**
 * @param {object} ds dataset from loadDataset
 * @param {{ likes?: string[], dislikes?: string[], seen?: string[], seed?: string }} profile
 * @param {ReturnType<typeof defaultCuration>} [curation]
 * @param {ReturnType<typeof prepareFeed>} [prepared] a cached prepareFeed() for the same profile and curation
 * @returns {{ vid: string, reason: string, source: string }[]}
 */
export function buildFeed(ds, profile = {}, curation = defaultCuration(), prepared = prepareFeed(ds, profile, curation)) {
  const seed = profile.seed ?? '0';
  const { pool, penalty, near, corec, touched, hasLikes } = prepared;
  const pen = (v) => penalty[v.i];

  const sources = {};
  const add = (name, entries) => {
    if (entries.length) sources[name] = { name, entries, pos: 0, done: false };
  };

  // classics
  {
    const top = pool.slice(0, 1000); // pool keeps the dataset's best-first order
    const order = weightedOrder(top, (v) => v.score ** 2 * pen(v), rngFor(seed, 'classics'));
    add(
      'classics',
      order.map((v) => ({ v, reason: `HN classic · recommended in ${plural(v.hn.rec_months, 'different month')}` })),
    );
  }

  // recent
  {
    const latest = monthIndex(ds.maxMonth);
    const fresh = pool.filter((v) => v.lastRecMonth && latest - monthIndex(v.lastRecMonth) <= RECENT_MONTHS);
    const order = weightedOrder(fresh, (v) => (v.score + 1) * pen(v), rngFor(seed, 'recent'));
    add('recent', order.map((v) => ({ v, reason: `Recommended on HN recently (${monthLabel(v.lastRecMonth)})` })));
  }

  // following
  if (curation.followTopics.size) {
    const followed = pool.filter((v) => v.categories.some((c) => curation.followTopics.has(c.id)));
    const order = weightedOrder(followed, (v) => (v.score + 1) * pen(v), rngFor(seed, 'following'));
    add(
      'following',
      order.map((v) => {
        const cat = v.categories.find((c) => curation.followTopics.has(c.id));
        return { v, reason: `From ${cat.name}, a topic you follow` };
      }),
    );
  }

  // explore: topics untouched by anything you liked, disliked, opened or follow
  {
    const byCat = new Map();
    for (const v of pool) {
      const c = v.categories[0];
      // A video is only "new" if none of its topics is one you've touched or follow.
      if (!c || v.categories.some((x) => touched.has(x.id))) continue;
      if (!byCat.has(c.id)) byCat.set(c.id, []);
      byCat.get(c.id).push(v);
    }
    const rng = rngFor(seed, 'explore');
    const cats = weightedOrder([...byCat.keys()], (id) => Math.sqrt(byCat.get(id).length), rng);
    const perCat = cats.map((id) => weightedOrder(byCat.get(id), (v) => v.score ** 1.5 * pen(v), rng).slice(0, 3));
    const entries = [];
    for (let round = 0; round < 3; round++) {
      cats.forEach((id, k) => {
        const v = perCat[k][round];
        if (v) entries.push({ v, reason: `Explore a new topic: ${ds.categoryById.get(id)?.name ?? id}` });
      });
    }
    add('explore', entries);
  }

  // gems
  if (ds.hasMeta) {
    const gems = pool.filter((v) => v.yt?.views !== null && v.yt?.views !== undefined && v.yt.views < GEM_MAX_VIEWS);
    const order = weightedOrder(gems, (v) => v.score * pen(v), rngFor(seed, 'gems'));
    add(
      'gems',
      order.map((v) => ({
        v,
        reason: `Hidden gem · ${compact(v.yt.views)} views, recommended by ${plural(v.hn.recommenders, 'HN commenter')}`,
      })),
    );
  }

  if (hasLikes) {
    const similar = weightedOrder(
      near,
      (x) => Math.exp((x.sim - 0.55) * 14) * (1 + 0.15 * Math.log1p(x.v.score)) * pen(x.v),
      rngFor(seed, 'similar'),
    );
    add('similar', similar.map((x) => ({ v: x.v, reason: `Similar to ${quote(x.from.title)}, one of your recent likes` })));

    const co = weightedOrder(corec, (x) => x.w * (1 + 0.2 * Math.log1p(x.v.score)) * pen(x.v), rngFor(seed, 'corec'));
    add('corec', co.map((x) => ({ v: x.v, reason: `HN people who recommended ${quote(x.from.title)} (a recent like) also recommend this` })));
  }

  const weights = Object.fromEntries(Object.keys(sources).map((name) => [name, curation.mix[name] ?? 0]));
  return interleave(sources, mixPattern(weights));
}

/** Take from each source in turn, skipping videos already used, and avoid three in a row from one channel. */
function interleave(sources, pattern) {
  const out = [];
  const used = new Set();
  const recentChannels = [];
  let step = 0;
  while (out.length < FEED_LENGTH) {
    const live = pattern.filter((name) => sources[name] && !sources[name].done);
    if (!live.length) break;
    const src = sources[pattern[step++ % pattern.length]];
    if (!src || src.done) continue;
    const pick = takeNext(src, used, recentChannels);
    if (!pick) {
      src.done = true;
      continue;
    }
    used.add(pick.v.vid);
    out.push({ vid: pick.v.vid, reason: pick.reason, source: src.name });
    recentChannels.push(pick.v.channel);
    if (recentChannels.length > 2) recentChannels.shift();
  }
  return out;
}

function takeNext(src, used, recentChannels) {
  while (src.pos < src.entries.length && used.has(src.entries[src.pos].v.vid)) src.pos++;
  let first = null;
  for (let k = src.pos, looked = 0; k < src.entries.length && looked < 6; k++) {
    const e = src.entries[k];
    if (used.has(e.v.vid)) continue;
    looked++;
    first ??= e;
    const repeat = recentChannels.length === 2 && recentChannels.every((c) => c === e.v.channel);
    if (!repeat) return e;
  }
  return first;
}
