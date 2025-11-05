import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { loadDataset } from '../../src/data.js';
import { buildFeed, prepareFeed } from '../../src/feed.js';
import { parseCuration } from '../../src/curation.js';
import { relatedFor } from '../../src/related.js';
import { searchVideos, tokenize } from '../../src/search.js';
import { CATS, DIM, DUP_VID, makeFixture, vidOf } from '../helpers/fixture.js';
import { dotRows } from '../../src/vec.js';

function withData(t, opts) {
  const fx = makeFixture(opts);
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  return loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
}
const catOf = (ds, vid) => ds.byVid.get(vid).categories[0].id;
const P = (s) => new URLSearchParams(s);

test('feed is deterministic per seed, has no repeats and only eligible videos', (t) => {
  const ds = withData(t);
  const a = buildFeed(ds, { seed: 'one' });
  const b = buildFeed(ds, { seed: 'one' });
  const c = buildFeed(ds, { seed: 'two' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.vid), c.map((x) => x.vid));
  assert.equal(new Set(a.map((x) => x.vid)).size, a.length);
  for (const x of a) {
    const v = ds.byVid.get(x.vid);
    assert.ok(v.visible, `${x.vid} should be visible`);
    assert.notEqual(v.shelf_life, 'news');
    assert.ok(v.hn.recommenders > 0);
    assert.ok(x.reason.length > 5);
  }
  // 6 topics x 8 eligible videos (i = 8 is news, i = 9 cited only)
  assert.equal(a.length, 48);
  assert.ok(!a.some((x) => x.vid === DUP_VID));
  assert.ok(!a.some((x) => x.source === 'similar' || x.source === 'corec'), 'cold feed has no like-based sources');
});

test('a cached prepareFeed gives exactly the same feed for any seed', (t) => {
  const ds = withData(t);
  const profile = { likes: [vidOf(1, 0)], dislikes: [vidOf(4, 0)], seen: [vidOf(2, 0)] };
  const cur = parseCuration(P('follow_topics=physics'), ds);
  const prepared = prepareFeed(ds, profile, cur);
  for (const seed of ['a', 'b', 'c']) {
    assert.deepEqual(buildFeed(ds, { ...profile, seed }, cur, prepared), buildFeed(ds, { ...profile, seed }, cur));
  }
});

test('feed leaves out what you liked, disliked and opened', (t) => {
  const ds = withData(t);
  const likes = [vidOf(0, 0)];
  const dislikes = [vidOf(1, 0)];
  const seen = [vidOf(2, 0), vidOf(2, 1)];
  const feed = buildFeed(ds, { likes, dislikes, seen, seed: 's' });
  for (const vid of [...likes, ...dislikes, ...seen]) assert.ok(!feed.some((x) => x.vid === vid), vid);
});

test('explore never offers a topic you touched, even as a video\'s second topic', (t) => {
  const ds = withData(t);
  // c3v0 is physics first, functional-programming second
  for (const seed of ['a', 'b', 'c', 'd']) {
    const liked = buildFeed(ds, { likes: [vidOf(0, 1)], seed });
    const followed = buildFeed(ds, { seed }, parseCuration(P('follow_topics=functional-programming'), ds));
    for (const feed of [liked, followed]) {
      const explore = feed.filter((x) => x.source === 'explore');
      assert.ok(explore.length > 0);
      for (const x of explore) assert.ok(!ds.byVid.get(x.vid).categories.some((c) => c.id === 'functional-programming'), `${x.vid} in explore`);
    }
  }
});

test('near-copies of older dislikes (beyond the last 30) are still dropped', (t) => {
  const ds = withData(t);
  const old = vidOf(4, 0);
  const filler = ds.videos.filter((v) => v.visible && !v.categories.some((c) => c.id === 'biology')).slice(0, 35).map((v) => v.vid);
  const feed = buildFeed(ds, { dislikes: [old, ...filler], seed: 's' });
  for (const x of feed) assert.ok(dotRows(ds.emb, ds.dim, ds.byVid.get(x.vid).i, ds.byVid.get(old).i) < 0.88, x.vid);
});

test('likes pull the top of the feed toward the liked topic', (t) => {
  const ds = withData(t);
  const cold = buildFeed(ds, { seed: 's' }).slice(0, 12);
  const warm = buildFeed(ds, { likes: [vidOf(1, 0), vidOf(1, 1)], seed: 's' }).slice(0, 12);
  const share = (feed) => feed.filter((x) => catOf(ds, x.vid) === 'databases').length;
  assert.ok(share(warm) >= 5, `databases share warm ${share(warm)}/12`);
  assert.ok(share(warm) > share(cold), `warm ${share(warm)} vs cold ${share(cold)}`);
  assert.ok(warm.some((x) => x.source === 'similar' && /Similar to “Databases talk number/.test(x.reason)));
  assert.ok(warm.some((x) => x.source === 'corec' && /HN people who recommended/.test(x.reason)));
});

test('dislikes drop near-identical videos and push the topic down', (t) => {
  const ds = withData(t);
  const dislikes = [vidOf(4, 0), vidOf(4, 1), vidOf(4, 2)];
  const base = buildFeed(ds, { seed: 's' });
  const feed = buildFeed(ds, { dislikes, seed: 's' });
  const bio = (f) => f.filter((x) => catOf(ds, x.vid) === 'biology').length;
  assert.ok(bio(feed) < bio(base) - 2, `biology ${bio(feed)} vs ${bio(base)}`);

  // Nothing at or above the drop threshold (cosine 0.88 to a disliked video) may appear at all.
  const maxSim = (vid) => Math.max(...dislikes.map((d) => dotRows(ds.emb, ds.dim, ds.byVid.get(vid).i, ds.byVid.get(d).i)));
  const nearCopies = base.filter((x) => !dislikes.includes(x.vid) && maxSim(x.vid) >= 0.88);
  assert.ok(nearCopies.length >= 3, `fixture should have near-copies of the disliked videos (${nearCopies.length})`);
  for (const x of feed) assert.ok(maxSim(x.vid) < 0.88, `${x.vid} is ${maxSim(x.vid).toFixed(3)} similar to a dislike`);
});

test('curation: mix weights, muted topics and channels, followed topics, types, formats', (t) => {
  const ds = withData(t, { withMeta: true });
  const cur = (q) => parseCuration(P(q), ds);

  const onlyClassics = buildFeed(ds, { seed: 's' }, cur('mix=classics:1,recent:0,explore:0,gems:0'));
  assert.ok(onlyClassics.length > 0);
  assert.ok(onlyClassics.every((x) => x.source === 'classics'));

  const off = buildFeed(ds, { seed: 's' }, cur('mix=classics:0,recent:0,explore:0,gems:0'));
  assert.deepEqual(off, []);

  const muted = buildFeed(ds, { seed: 's' }, cur('mute_topics=physics,biology'));
  assert.ok(!muted.some((x) => ['physics', 'biology'].includes(catOf(ds, x.vid))));

  const noChannel = buildFeed(ds, { seed: 's' }, cur(`mute_channels=${encodeURIComponent(encodeURIComponent('Channel 0-0'))}`));
  assert.ok(!noChannel.some((x) => ds.byVid.get(x.vid).channel === 'Channel 0-0'));

  const followed = buildFeed(ds, { seed: 's' }, cur('follow_topics=mathematics&mix=following:5,classics:1,recent:0,explore:0,gems:0'));
  const top = followed.slice(0, 6);
  assert.ok(top.filter((x) => x.source === 'following').length >= 4);
  assert.ok(followed.filter((x) => x.source === 'following').every((x) => ds.byVid.get(x.vid).categories.some((c) => c.id === 'mathematics')));
  assert.match(followed.find((x) => x.source === 'following').reason, /a topic you follow/);

  const talks = buildFeed(ds, { seed: 's' }, cur('types=talk'));
  assert.ok(talks.length > 0 && talks.every((x) => ds.byVid.get(x.vid).content_type === 'talk'));

  const shortsOnly = buildFeed(ds, { seed: 's' }, cur('formats=short'));
  assert.ok(shortsOnly.length > 0 && shortsOnly.every((x) => ds.byVid.get(x.vid).yt.duration_s <= 180));
  const noShorts = buildFeed(ds, { seed: 's' }, cur('formats=standard,long'));
  assert.ok(noShorts.length > 0 && noShorts.every((x) => ds.byVid.get(x.vid).yt.duration_s > 180));

  const withNews = buildFeed(ds, { seed: 's' }, cur('news=1&cited=1'));
  assert.equal(withNews.length, 60);
});

test('gems source appears only with YouTube metadata', (t) => {
  const meta = withData(t, { withMeta: true });
  const gems = buildFeed(meta, { seed: 's' }).filter((x) => x.source === 'gems');
  assert.ok(gems.length > 0);
  for (const x of gems) assert.ok(meta.byVid.get(x.vid).yt.views < 100_000);
  const plain = withData(t);
  assert.ok(!buildFeed(plain, { seed: 's' }).some((x) => x.source === 'gems'));
});

test('search: semantic, keyword fallback, weak flag, topic match and filters', (t) => {
  const ds = withData(t);
  const qvec = (k) => {
    const v = new Float32Array(DIM);
    v[k] = 1;
    return v;
  };
  const sem = searchVideos(ds, { q: 'something about physics', qvec: qvec(3), filters: { sort: 'relevance' } });
  assert.equal(sem.mode, 'semantic');
  assert.equal(sem.weak, false);
  assert.ok(sem.results.slice(0, 10).every((r) => ds.byVid.get(r.vid).categories.some((c) => c.id === 'physics')));
  assert.ok(sem.results.some((r) => r.via === 'Physics'));

  const off = new Float32Array(DIM).fill(1 / Math.sqrt(DIM));
  const weak = searchVideos(ds, { q: 'zzzz qqqq', qvec: off, filters: { sort: 'relevance' } });
  assert.equal(weak.weak, true);
  assert.ok(weak.results.length > 0, 'weak searches still return the closest videos');

  const kw = searchVideos(ds, { q: 'Databases talk number 3', qvec: null, filters: { sort: 'relevance' } });
  assert.equal(kw.mode, 'keyword');
  assert.equal(kw.results[0].vid, vidOf(1, 3));
  const none = searchVideos(ds, { q: 'qqqqq', qvec: null, filters: { sort: 'relevance' } });
  assert.deepEqual(none, { mode: 'keyword', weak: true, results: [] });

  const lectures = searchVideos(ds, { q: 'physics', qvec: qvec(3), filters: { type: 'lecture', sort: 'relevance' } });
  assert.ok(lectures.results.length > 0 && lectures.results.every((r) => ds.byVid.get(r.vid).content_type === 'lecture'));
  assert.ok(!sem.results.some((r) => r.vid === DUP_VID));
  assert.deepEqual(tokenize('How do the Transistors work?'), ['do', 'transistors', 'work']);
  // duplicates collapse and the count is capped, so a hostile query can't multiply the work
  assert.deepEqual(tokenize('ab ab ab ab'), ['ab']);
  assert.equal(tokenize(Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')).length, 16);
  assert.ok(tokenize('\uFDFA'.repeat(200)).length <= 16);

  // results never show a near-copy twice, but episodes ("number 1", "number 2") all stay
  assert.ok(sem.results.length >= 10, `${sem.results.length} results`);
  const copy = ds.byVid.get(vidOf(3, 1));
  const before = copy.search.title;
  copy.search.title = ds.byVid.get(vidOf(3, 2)).search.title; // same words and number as c3v2
  const collapsed = searchVideos(ds, { q: 'physics', qvec: qvec(3), filters: { sort: 'relevance' } }).results.map((r) => r.vid);
  assert.equal(collapsed.filter((v) => v === vidOf(3, 1) || v === vidOf(3, 2)).length, 1);
  copy.search.title = before;

  // whole words only, at any length
  const v = ds.byVid.get(vidOf(0, 2));
  // retitle a video after load, keeping the word index in step
  const retitle = (title) => {
    v.search.title = title;
    for (const w of title.trim().split(' ')) {
      if (!ds.wordIndex.has(w)) ds.wordIndex.set(w, []);
      if (!ds.wordIndex.get(w).includes(v.i)) ds.wordIndex.get(w).push(v.i);
    }
  };
  retitle(' going google go somewhere ');
  const go = searchVideos(ds, { q: 'go', qvec: null, filters: { sort: 'relevance' } });
  assert.deepEqual(go.results.map((r) => r.vid), [vidOf(0, 2)]);
  retitle(' going google demoscene ');
  assert.equal(searchVideos(ds, { q: 'go', qvec: null, filters: { sort: 'relevance' } }).results.length, 0);
  assert.equal(searchVideos(ds, { q: 'goog', qvec: null, filters: { sort: 'relevance' } }).results.length, 0, 'no prefix matches');
  // singular and plural forms match each other
  retitle(' how a transistor works ');
  assert.equal(searchVideos(ds, { q: 'transistors', qvec: null, filters: { sort: 'relevance' } }).results[0].vid, vidOf(0, 2));
  retitle(' many demos ');
  assert.equal(searchVideos(ds, { q: 'demo', qvec: null, filters: { sort: 'relevance' } }).results[0].vid, vidOf(0, 2));
});

test('related: shared recommenders first, then nearest by embedding, never itself or a duplicate', (t) => {
  const ds = withData(t);
  const rel = relatedFor(ds, vidOf(2, 4), 8);
  assert.equal(rel.length, 8);
  assert.equal(rel[0].vid, vidOf(2, 5));
  assert.equal(rel[0].reason, '3 HN recommenders in common');
  assert.ok(!rel.some((r) => r.vid === vidOf(2, 4)));
  const similar = rel.filter((r) => r.reason === 'Similar topic');
  assert.ok(similar.length >= 4);
  assert.ok(similar.every((r) => catOf(ds, r.vid) === CATS[2].id));
  // asking for the duplicate gives the original's neighbours, without the original or the duplicate
  const viaDup = relatedFor(ds, DUP_VID, 10);
  assert.ok(!viaDup.some((r) => r.vid === DUP_VID || r.vid === vidOf(0, 0)));
  assert.deepEqual(relatedFor(ds, 'nonexistent', 5), []);
});
