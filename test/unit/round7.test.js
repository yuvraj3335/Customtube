// Tests added after a mutation-testing review: each one fails if the behaviour it names is
// broken (cache keys, limiter refill, boundaries, escaping, feed rules, paging, loader rules).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDataset, monthIndex } from '../../src/data.js';
import { buildFeed } from '../../src/feed.js';
import { formatOf, parseCuration } from '../../src/curation.js';
import { matchesFilters, sortVideos } from '../../src/filters.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { searchVideos } from '../../src/search.js';
import { relatedFor } from '../../src/related.js';
import { createApp } from '../../src/server.js';
import { DIM, fakeEmbedder, makeFixture, vidOf } from '../helpers/fixture.js';

const P = (s) => new URLSearchParams(s);
const quiet = { info() {}, error() {} };
const withYt = (v, yt) => ({ ...v, yt: { ...v.yt, ...yt } });

function withData(t, opts) {
  const fx = makeFixture(opts);
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  return loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
}

describe('feed cache keys', () => {
  let fx;
  let base;
  let server;
  before(async () => {
    fx = makeFixture({ withMeta: true });
    ({ server } = createApp({ ds: loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile }), embedder: fakeEmbedder(), log: quiet }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(fx.dir, { recursive: true, force: true });
  });
  const ids = async (q) => (await (await fetch(`${base}/api/feed?n=60&${q}`)).json()).items.map((x) => x.vid);

  test('every input that changes the feed is part of the cache key', async () => {
    const plain = await ids('seed=a');
    assert.notDeepEqual(await ids('seed=b'), plain, 'seed');
    const classics = await (await fetch(`${base}/api/feed?n=60&seed=a&mix=classics:1,recent:0,explore:0,gems:0`)).json();
    assert.ok(classics.items.every((x) => x.source === 'classics'), 'mix');
    const muted = await ids(`seed=a&mute_channels=${encodeURIComponent(encodeURIComponent('Channel 0-0'))}`);
    assert.notDeepEqual(muted, plain, 'mute_channels');
    assert.notDeepEqual(await ids('seed=a&follow_topics=physics'), plain, 'follow_topics');
    assert.notDeepEqual(await ids('seed=a&news=1'), plain, 'news');
    assert.notDeepEqual(await ids('seed=a&cited=1'), plain, 'cited');
    assert.notDeepEqual(await ids('seed=a&types=talk'), plain, 'types');
    assert.notDeepEqual(await ids('seed=a&formats=short'), plain, 'formats');
    assert.notDeepEqual(await ids('seed=a&mute_topics=physics'), plain, 'mute_topics');
    assert.deepEqual(await ids('seed=a'), plain, 'and the same inputs still give the same feed');
  });

  test('POST mute_channels are matched by name, even with commas', async () => {
    const res = await fetch(`${base}/api/feed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 60, mute_channels: ['Channel 0-0'] }) });
    const body = await res.json();
    assert.ok(body.items.length > 0);
    assert.ok(!body.items.some((x) => x.channel === 'Channel 0-0'));
  });

  test('a full last page has no next page', async () => {
    const all = await (await fetch(`${base}/api/list?n=60`)).json();
    assert.equal(all.items.length, 60);
    assert.equal(all.next_offset, null);
    const feed = await (await fetch(`${base}/api/feed?n=48&news=0`)).json();
    assert.equal(feed.total, 48);
    assert.equal(feed.next_offset, null);
  });
});

test('rate limiter refills over time and evicts the least recently used key', () => {
  let now = 0;
  const lim = createRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 2, now: () => now });
  assert.ok(lim.take('a').ok);
  assert.ok(lim.take('a').ok);
  assert.equal(lim.take('a').ok, false);
  now = 1000;
  assert.ok(lim.take('a').ok, 'one token back after a second');
  assert.equal(lim.take('a').ok, false);
  // fill b, touch a, add c: b (least recently used) is evicted, a is kept
  now = 1000;
  lim.take('b');
  lim.take('a');
  lim.take('c');
  assert.equal(lim.take('a').ok, false, 'a kept its (empty) bucket');
  assert.ok(lim.take('b').ok, 'b was evicted, so it starts full');
});

test('format and duration boundaries', (t) => {
  const ds = withData(t, { withMeta: true });
  const v = ds.byVid.get(vidOf(0, 0));
  const at = (d) => withYt(v, { duration_s: d });
  assert.equal(formatOf(at(180)), 'short');
  assert.equal(formatOf(at(181)), 'standard');
  assert.equal(formatOf(at(3600)), 'standard');
  assert.equal(formatOf(at(3601)), 'long');
  assert.ok(matchesFilters(at(239), { dur: 'short' }));
  assert.ok(!matchesFilters(at(240), { dur: 'short' }));
  assert.ok(matchesFilters(at(240), { dur: 'medium' }));
  assert.ok(matchesFilters(at(1199), { dur: 'medium' }));
  assert.ok(!matchesFilters(at(1200), { dur: 'medium' }));
  assert.ok(matchesFilters(at(1200), { dur: 'long' }));
  const now = Date.parse('2026-11-01T00:00:00Z');
  const pub = (iso) => withYt(v, { published: iso });
  assert.ok(matchesFilters(pub('2026-10-02T00:00:00Z'), { date: 'year' }, now), '30 days ago');
  assert.ok(!matchesFilters(pub('2026-11-02T00:00:00Z'), { date: 'year' }, now), 'tomorrow');
  assert.ok(!matchesFilters(pub('2025-10-01T00:00:00Z'), { date: 'year' }, now), 'over a year ago');
  assert.ok(!matchesFilters({ ...withYt(v, { views: 10 }), hn: { ...v.hn, recommenders: 0 } }, { gems: '1' }), 'gems need a recommendation');
  assert.ok(!matchesFilters({ ...v, level: 'advanced' }, { level: 'intro' }));
});

test('like-ratio sort ignores tiny view counts and puts unknowns last', (t) => {
  const ds = withData(t, { withMeta: true });
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => ds.byVid.get(vidOf(0, i)));
  const list = [withYt(a, { views: 500, likes: 400 }), withYt(b, { views: 10_000, likes: 900 }), withYt(c, { views: 10_000, likes: 100 }), { ...d, yt: null }];
  assert.deepEqual(sortVideos(list, 'liked').map((x) => x.vid), [b.vid, c.vid, a.vid, d.vid]);
});

test('HTML attribute values escape quotes', async (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const ds = loadDataset({ dataDir: fx.dataDir });
  ds.byVid.get(vidOf(0, 1)).summary = 'He said "hi" & <left>';
  const { server } = createApp({ ds, embedder: fakeEmbedder(), log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/watch/${vidOf(0, 1)}`)).text();
    assert.match(html, /<meta name="description" content="He said &quot;hi&quot; &amp; &lt;left&gt;">/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('feed rules: no non-embeddable videos, a real "recent" window, never three in a row from one channel', (t) => {
  const ds = withData(t, { withMeta: true });
  ds.byVid.get(vidOf(2, 0)).yt.embeddable = false;
  // crowd one channel so the channel rule has work to do
  for (let i = 0; i < 8; i++) ds.byVid.get(vidOf(1, i)).channel = 'Crowded';
  for (const seed of ['a', 'b', 'c']) {
    const feed = buildFeed(ds, { seed });
    assert.ok(!feed.some((x) => x.vid === vidOf(2, 0)));
    for (const x of feed.filter((f) => f.source === 'recent')) {
      const v = ds.byVid.get(x.vid);
      assert.ok(monthIndex(ds.maxMonth) - monthIndex(v.lastRecMonth) <= 18, `${x.vid} is not recent`);
    }
    const ch = feed.map((x) => ds.byVid.get(x.vid).channel);
    for (let i = 2; i < ch.length; i++) {
      // the rule looks 6 entries ahead; a source with nothing else left may still repeat
      if (ch[i] === ch[i - 1] && ch[i] === ch[i - 2]) {
        const rest = ch.slice(i).filter((c) => c !== ch[i]);
        assert.equal(rest.length, 0, `three in a row from ${ch[i]} at ${i} with others available`);
      }
    }
  }
});

test('reasons state true facts', (t) => {
  const ds = withData(t, { withMeta: true });
  const feed = buildFeed(ds, { likes: [vidOf(1, 0)], seed: 's' }, parseCuration(P('follow_topics=physics'), ds));
  for (const x of feed) {
    const v = ds.byVid.get(x.vid);
    if (x.source === 'classics') assert.match(x.reason, new RegExp(`recommended in ${v.hn.rec_months} different month`));
    if (x.source === 'following') assert.ok(v.categories.some((c) => c.id === 'physics') && /Physics/.test(x.reason));
    if (x.source === 'gems') assert.ok(v.yt.views < 100_000 && x.reason.includes(`recommended by ${v.hn.recommenders}`));
    if (x.source === 'similar' || x.source === 'corec') assert.match(x.reason, /Databases talk number 0/);
  }
});

test('similar keeps the most similar, not the least', (t) => {
  const ds = withData(t);
  const feed = buildFeed(ds, { likes: [vidOf(4, 0)], seed: 's' }, parseCuration(P('mix=similar:1,classics:0,recent:0,explore:0,corec:0'), ds));
  assert.ok(feed.length > 0);
  // the first similar picks come from the liked topic
  assert.ok(feed.slice(0, 6).every((x) => ds.byVid.get(x.vid).categories[0].id === 'biology'));
});

test('search with a sort keeps only relevant hits, ordered by that sort', (t) => {
  const ds = withData(t);
  const qvec = new Float32Array(DIM);
  qvec[3] = 1; // physics
  const r = searchVideos(ds, { q: 'physics', qvec, filters: { sort: 'hn' } });
  assert.ok(r.results.length > 0);
  const vs = r.results.map((x) => ds.byVid.get(x.vid));
  assert.ok(vs.every((v) => v.categories.some((c) => c.id === 'physics')), 'only physics');
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i - 1].hn.recommenders >= vs[i].hn.recommenders, 'by recommenders');
  // keyword mode: hits under half the best keyword score are dropped
  const kw = searchVideos(ds, { q: 'databases talk number 3', qvec: null, filters: { sort: 'best' } });
  assert.ok(kw.results.length < 60 && kw.results.length > 0);
  // results never include hidden videos, even with copy-collapsing out of the picture
  const all = searchVideos(ds, { q: 'functional', qvec: null, filters: { sort: 'best' } });
  assert.ok(all.results.every((x) => ds.byVid.get(x.vid).visible));
});

test('related keeps room for co-recommendations, skips hidden videos and respects n', (t) => {
  const ds = withData(t);
  ds.byVid.get(vidOf(2, 6)).visible = false;
  const rel = relatedFor(ds, vidOf(2, 5), 8);
  assert.equal(rel.length, 8);
  assert.ok(!rel.some((r) => r.vid === vidOf(2, 6)));
  assert.ok(rel.some((r) => r.reason === 'Also recommended by an HN recommender of this video'), 'weak co-recs still get a slot');
  assert.equal(relatedFor(ds, vidOf(2, 5), 3).length, 3);
});

test('loader rules: private videos hidden, zero vectors rejected, repeated ids keep the first, only recommendations set lastRecMonth', (t) => {
  const fx = makeFixture({ withMeta: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const f = (n) => path.join(fx.dataDir, n);
  const meta = readFileSync(fx.metaFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  meta[1].item.status.privacyStatus = 'private'; // c0v1
  writeFileSync(fx.metaFile, meta.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const npy = readFileSync(f('embeddings.npy'));
  const ids = JSON.parse(readFileSync(f('embedding_ids.json'), 'utf8'));
  const zeroRow = ids.indexOf(vidOf(5, 5));
  npy.fill(0, npy.length - (ids.length - zeroRow) * DIM * 2, npy.length - (ids.length - zeroRow - 1) * DIM * 2);
  writeFileSync(f('embeddings.npy'), npy);
  const mentions = readFileSync(f('mentions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const m of mentions) if (m.vid === vidOf(3, 9) && m.stance === 'reference') m.month = '2026-08'; // a reference, not a rec
  writeFileSync(f('mentions.jsonl'), mentions.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
  assert.equal(ds.byVid.get(vidOf(0, 1)).visible, false, 'private');
  assert.equal(ds.byVid.get(vidOf(5, 5)).hasEmbedding, false, 'zero vector');
  assert.equal(ds.byVid.get(vidOf(3, 9)).lastRecMonth, '2018-01', 'the strong_rec in 2018 is the last recommendation; the 2026 reference does not count');
});

test('on one channel, a title contained in another (and the same content) is a duplicate', (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const f = path.join(fx.dataDir, 'videos.jsonl');
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = rows.find((r) => r.vid === vidOf(4, 1));
  const b = rows.find((r) => r.vid === vidOf(4, 2));
  a.title = 'Biology talk number one';
  b.title = 'Famous Speaker - Biology talk number one (full)';
  b.channel = a.channel;
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ds = loadDataset({ dataDir: fx.dataDir });
  const dup = [ds.byVid.get(vidOf(4, 1)), ds.byVid.get(vidOf(4, 2))].filter((v) => v.dupOf);
  assert.equal(dup.length, 1);
});

test('oEmbed: 401/403 are "not found", junk answers are 502, long titles are cut', async (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const answers = {
    forbidden01: () => new Response('no', { status: 403 }),
    unauthoriz1: () => new Response('no', { status: 401 }),
    emptyobj001: () => Response.json({}),
    hugebody001: () => new Response(`{"title":"${'x'.repeat(70_000)}"}`, { headers: { 'content-type': 'application/json' } }),
    longtitle01: () => Response.json({ title: 't'.repeat(400), author_name: 'a'.repeat(300) }),
  };
  const fetchImpl = async (url) => answers[new URL(new URL(url).searchParams.get('url')).searchParams.get('v')]();
  const { server } = createApp({ ds: loadDataset({ dataDir: fx.dataDir }), embedder: fakeEmbedder(), fetchImpl, log: quiet, oembedLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 100 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (vid) => fetch(`http://127.0.0.1:${server.address().port}/api/oembed?vid=${vid}`);
  try {
    assert.equal((await get('forbidden01')).status, 404);
    assert.equal((await get('unauthoriz1')).status, 404);
    assert.equal((await get('emptyobj001')).status, 502);
    assert.equal((await get('hugebody001')).status, 502);
    const long = await (await get('longtitle01')).json();
    assert.equal(long.title.length, 300);
    assert.equal(long.channel.length, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a duplicate upload\'s canonical link points at the original', async (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const { server } = createApp({ ds: loadDataset({ dataDir: fx.dataDir }), embedder: fakeEmbedder(), log: quiet, publicUrl: 'https://tube.example' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/watch/dupOfc0v0__`)).text();
    assert.match(html, /<link rel="canonical" href="https:\/\/tube\.example\/watch\/c0v0_______">/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

describe('more boundaries the first mutation pass missed', () => {
  test('npy: Fortran order, 3-D shapes, version-2 headers and short float16 files are rejected', async () => {
    const { readNpyMatrix, writeNpyMatrix } = await import('../../src/npy.js');
    const good = writeNpyMatrix(2, 2, [1, 2, 3, 4], '<f2');
    const swap = (from, to) => {
      const b = Buffer.from(good);
      const at = b.indexOf(from);
      b.write(to, at, 'latin1');
      return b;
    };
    assert.throws(() => readNpyMatrix(swap("'fortran_order': False", "'fortran_order': True ")), /fortran/);
    assert.throws(() => readNpyMatrix(swap('(2, 2), ', '(2, 2, 1)')), /2-D/);
    assert.throws(() => readNpyMatrix(good.subarray(0, good.length - 2)), /shorter/);
    // version 2: a 4-byte header length
    const header = good.subarray(10, good.length - 8);
    const v2 = Buffer.concat([good.subarray(0, 8), Buffer.alloc(4), header, good.subarray(good.length - 8)]);
    v2[6] = 2;
    v2.writeUInt32LE(header.length, 8);
    assert.deepEqual([...readNpyMatrix(v2).data], [1, 2, 3, 4]);
  });

  test('security headers on every response', async (t) => {
    const fx = makeFixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const { server } = createApp({ ds: loadDataset({ dataDir: fx.dataDir }), embedder: fakeEmbedder(), log: quiet });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      for (const p of ['/', '/api/stats', '/static/favicon.svg', '/api/nope']) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
        assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/, p);
      }
      const big = await fetch(`http://127.0.0.1:${server.address().port}/api/list?n=60`, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(big.headers.get('vary'), 'Accept-Encoding');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('curation list limits and channel names', (t) => {
    const ds = withData(t);
    const many = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    assert.throws(() => parseCuration(P(`mute_channels=${many}`), ds), /at most 200/);
    assert.throws(() => parseCuration(P(`mute_channels=${encodeURIComponent('x'.repeat(201))}`), ds), /too long/);
    assert.throws(() => parseCuration(P('mute_channels=a,,b'), ds), /empty or too long/);
    // without metadata a video has no format, so a formats filter would match nothing
    assert.equal(formatOf(ds.byVid.get(vidOf(0, 0))), null);
  });

  test('API: area filter, hidden deleted videos in docs, related n, POST channel names, embeddable in cards', async (t) => {
    const fx = makeFixture({ withMeta: true });
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    writeFileSync(fx.metaFile, `${JSON.stringify({ vid: vidOf(0, 4), item: null })}\n`, { flag: 'a' });
    const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
    ds.byVid.get(vidOf(0, 5)).yt.embeddable = false;
    ds.byVid.get(vidOf(1, 1)).channel = 'A, B & Co';
    const { server } = createApp({ ds, embedder: fakeEmbedder(), log: quiet });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = async (p, init) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`, init)).json();
    try {
      const area = await get('/api/list?area=science&n=60');
      assert.ok(area.items.length > 0 && area.items.every((x) => ds.byVid.get(x.vid).categories.some((c) => c.area === 'science')));
      const docs = await get(`/api/docs?vids=${vidOf(0, 4)},${vidOf(0, 3)}`);
      assert.deepEqual(docs.items.map((x) => x.vid), [vidOf(0, 3)], 'a deleted video is not returned');
      assert.equal((await get(`/api/related?vid=${vidOf(2, 4)}&n=3`)).items.length, 3);
      assert.equal((await get(`/api/related?vid=${vidOf(2, 4)}&n=7`)).items.length, 7, 'n is part of the related cache key');
      const feed = await get('/api/feed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 60, mute_channels: ['A, B & Co'] }) });
      assert.ok(!feed.items.some((x) => x.channel === 'A, B & Co'));
      const card = (await get(`/api/docs?vids=${vidOf(0, 5)}`)).items[0];
      assert.equal(card.yt.embeddable, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('dislike penalties: same channel halves, a similar video is pushed down but kept', async (t) => {
    const { prepareFeed } = await import('../../src/feed.js');
    const ds = withData(t);
    const d = ds.byVid.get(vidOf(0, 1));
    const prep = prepareFeed(ds, { dislikes: [d.vid] });
    const sameChannelOther = ds.videos.find((v) => v.visible && v.channel === d.channel && v.categories[0].id !== 'functional-programming');
    if (sameChannelOther) assert.ok(prep.penalty[sameChannelOther.i] <= 0.5 + 1e-6);
    const unrelated = ds.byVid.get(vidOf(3, 2));
    assert.equal(prep.penalty[unrelated.i], 1);
    // a moderately similar video (cosine between 0.6 and 0.88) gets a factor between 0 and 1
    ds.simRow = () => {
      const row = new Float32Array(ds.videos.length).fill(0.1);
      row[unrelated.i] = 0.75;
      return row;
    };
    const soft = prepareFeed(ds, { dislikes: [d.vid] });
    assert.ok(soft.penalty[unrelated.i] > 0 && soft.penalty[unrelated.i] < 1, `${soft.penalty[unrelated.i]}`);
  });

  test('area counts count a video once, and related never lists a video as its own neighbour', (t) => {
    const ds = withData(t);
    const fp = ds.categoryById.get('functional-programming');
    const area = ds.areaById.get('software');
    assert.ok(area.count <= ds.videos.filter((v) => v.visible).length);
    assert.equal(area.count, ds.videos.filter((v) => v.visible && v.categories.some((c) => c.area === 'software')).length);
    assert.ok(fp.count > 0);
    for (const [vid, list] of ds.related) assert.ok(!list.some((r) => r.vid === vid), vid);
  });

  test('a repeated embedding id keeps its first row', (t) => {
    const fx = makeFixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const f = (n) => path.join(fx.dataDir, n);
    const ids = JSON.parse(readFileSync(f('embedding_ids.json'), 'utf8'));
    const first = ids[0];
    const second = ids[1];
    ids[1] = first; // row 1 now also claims to be `first`; `second` loses its row
    writeFileSync(f('embedding_ids.json'), JSON.stringify(ids));
    const ds = loadDataset({ dataDir: fx.dataDir });
    assert.equal(ds.byVid.get(second).hasEmbedding, false);
    assert.ok(ds.warnings.some((w) => /repeated id/.test(w)));
    assert.ok(ds.byVid.get(first).hasEmbedding);
  });

  test('search returns at most the limit', (t) => {
    const ds = withData(t);
    const q = new Float32Array(DIM).fill(1 / Math.sqrt(DIM));
    assert.equal(searchVideos(ds, { q: 'anything', qvec: q, filters: { sort: 'relevance' }, limit: 7 }).results.length, 7);
  });
});
