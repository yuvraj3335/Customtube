import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { loadDataset } from '../../src/data.js';
import { matchesFilters, parseFilters, sortVideos } from '../../src/filters.js';
import { allowedByCuration, curationKey, defaultCuration, formatOf, mixPattern, parseCuration } from '../../src/curation.js';
import { makeFixture, vidOf } from '../helpers/fixture.js';

const P = (s) => new URLSearchParams(s);

function withData(t, opts) {
  const fx = makeFixture(opts);
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  return loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
}

test('parseFilters validates every value and defaults the sort', () => {
  assert.deepEqual(parseFilters(P(''), { hasMeta: false }), { sort: 'best' });
  assert.deepEqual(parseFilters(P(''), { hasMeta: false, search: true }), { sort: 'relevance' });
  assert.deepEqual(parseFilters(P('type=talk&evergreen=1&sort=hn'), { hasMeta: false }), { type: 'talk', evergreen: '1', sort: 'hn' });
  assert.throws(() => parseFilters(P('type=movie'), { hasMeta: false }), /"type" must be one of/);
  assert.throws(() => parseFilters(P('evergreen=yes'), { hasMeta: false }), /"evergreen" must be one of/);
  assert.throws(() => parseFilters(P('sort=relevance'), { hasMeta: false }), /"sort" must be one of/);
  // present but empty would widen the results, so it's an error rather than "no filter"
  assert.throws(() => parseFilters(P('type='), { hasMeta: false }), /"type" is empty/);
  assert.throws(() => parseFilters(P('sort='), { hasMeta: false }), /"sort" is empty/);
  for (const q of ['dur=short', 'date=2010s', 'gems=1', 'sort=views']) {
    assert.throws(() => parseFilters(P(q), { hasMeta: false }), /needs YouTube metadata/, q);
    assert.doesNotThrow(() => parseFilters(P(q), { hasMeta: true }), q);
  }
});

test('matchesFilters applies duration, date, gems and evergreen', (t) => {
  const ds = withData(t, { withMeta: true });
  const v = (k, i) => ds.byVid.get(vidOf(k, i));
  const now = Date.parse('2026-11-01T00:00:00Z');
  assert.ok(matchesFilters(v(0, 0), { dur: 'short' }, now)); // 60 s
  assert.ok(!matchesFilters(v(0, 1), { dur: 'short' }, now)); // 600 s
  assert.ok(matchesFilters(v(0, 1), { dur: 'medium' }, now));
  assert.ok(matchesFilters(v(0, 2), { dur: 'long' }, now)); // 1800 s
  assert.ok(matchesFilters(v(0, 3), { dur: 'xlong' }, now)); // 4000 s
  // exactly an hour is "20-60 min", not "over an hour" (the same boundary as the long format)
  const hour = { ...v(0, 3), yt: { ...v(0, 3).yt, duration_s: 3600 } };
  assert.ok(matchesFilters(hour, { dur: 'long' }, now));
  assert.ok(!matchesFilters(hour, { dur: 'xlong' }, now));
  assert.equal(formatOf(hour), 'standard');
  assert.ok(matchesFilters(v(0, 0), { date: '2010s' }, now)); // published 2010
  assert.ok(!matchesFilters(v(0, 0), { date: '2000s' }, now));
  assert.ok(!matchesFilters(v(0, 0), { date: 'year' }, now));
  assert.ok(matchesFilters(v(0, 0), { gems: '1' }, now)); // 30K views, recommended
  assert.ok(!matchesFilters(v(0, 5), { gems: '1' }, now)); // 180K views
  assert.ok(!matchesFilters(v(0, 8), { evergreen: '1' }, now)); // news
  assert.ok(matchesFilters(v(0, 0), { type: 'talk' }, now));
  assert.ok(!matchesFilters(v(0, 1), { type: 'talk' }, now));
});

test('sortVideos orders by each key and puts unknown values last', (t) => {
  const ds = withData(t, { withMeta: true });
  const list = ds.videos.filter((x) => x.visible);
  const ids = (arr) => arr.slice(0, 3).map((x) => x.vid);
  assert.deepEqual(ids(sortVideos([...list], 'views')).map((id) => ds.byVid.get(id).yt.views), [300000, 300000, 300000]);
  assert.equal(sortVideos([...list], 'old')[0].yt.published.slice(0, 4), '2010');
  assert.equal(sortVideos([...list], 'date')[0].yt.published.slice(0, 4), '2019');
  assert.equal(sortVideos([...list], 'recent')[0].lastRecMonth, '2026-06');
  const noMeta = withData(t).videos.filter((x) => x.visible);
  // Without metadata every published date is unknown: order falls back to score.
  assert.deepEqual(sortVideos([...noMeta], 'date').map((x) => x.vid), sortVideos([...noMeta], 'best').map((x) => x.vid));
});

test('parseCuration validates and normalizes curation parameters', (t) => {
  const ds = withData(t);
  const c = parseCuration(P('types=talk,demo&mute_topics=physics&follow_topics=databases&mute_channels=Channel%25201-0,A%252CB&mix=classics:0,similar:5&news=1'), ds);
  assert.deepEqual([...c.types], ['talk', 'demo']);
  assert.deepEqual([...c.muteTopics], ['physics']);
  assert.deepEqual([...c.followTopics], ['databases']);
  assert.deepEqual([...c.muteChannels], ['Channel 1-0', 'A,B']); // names are URI-encoded inside the list
  assert.equal(c.mix.classics, 0);
  assert.equal(c.mix.similar, 5);
  assert.equal(c.mix.recent, 2); // default kept
  assert.equal(c.news, true);
  assert.equal(c.cited, false);

  // unknown topic ids are rejected (the client prunes stale ones first), malformed ones too
  assert.throws(() => parseCuration(P('mute_topics=gone-topic'), ds), /no topic "gone-topic"/);
  assert.throws(() => parseCuration(P('follow_topics=physics,gone-topic'), ds), /no topic "gone-topic"/);
  assert.throws(() => parseCuration(P('mix=classics:1,classics:5'), ds), /more than once/);
  assert.throws(() => parseCuration(P('mute_topics=Bad_Id'), ds), /invalid topic id/);
  assert.throws(() => parseCuration(P('types=movie'), ds), /"types" must be a list/);
  assert.throws(() => parseCuration(P('mix=classics:9'), ds), /"mix" must look like/);
  assert.throws(() => parseCuration(P('mix=bogus:1'), ds), /"mix" must look like/);
  assert.throws(() => parseCuration(P('news=yes'), ds), /"news" must be 1 or 0/);
  assert.throws(() => parseCuration(P('follow_topics=physics&mute_topics=physics'), ds), /both followed and muted/);
  assert.throws(() => parseCuration(P('mute_channels=%E0%A4%A'), ds), /URI-encoded/);
  // formats: all three is the same as none; a subset needs durations
  assert.equal(parseCuration(P('formats=short,standard,long'), ds).formats, null);
  assert.throws(() => parseCuration(P('formats=short'), ds), /needs YouTube metadata/);
  assert.throws(() => parseCuration(P('formats=tiny'), ds), /"formats" must be a list/);
});

test('allowedByCuration applies formats, types, topics, channels, news and cited', (t) => {
  const ds = withData(t, { withMeta: true });
  const v = (k, i) => ds.byVid.get(vidOf(k, i));
  const c = defaultCuration();
  assert.ok(allowedByCuration(v(0, 0), c));
  assert.ok(!allowedByCuration(v(0, 8), c), 'news hidden by default');
  assert.ok(!allowedByCuration(v(0, 9), c), 'cited-only hidden by default');
  assert.ok(allowedByCuration(v(0, 8), { ...c, news: true }));
  assert.ok(allowedByCuration(v(0, 9), { ...c, cited: true }));

  assert.equal(formatOf(v(0, 0)), 'short');
  assert.equal(formatOf(v(0, 1)), 'standard');
  assert.equal(formatOf(v(0, 3)), 'long');
  const noShorts = parseCuration(P('formats=standard,long'), ds);
  assert.ok(!allowedByCuration(v(0, 0), noShorts));
  assert.ok(allowedByCuration(v(0, 1), noShorts));
  const onlyShorts = parseCuration(P('formats=short'), ds);
  assert.ok(allowedByCuration(v(0, 0), onlyShorts));
  assert.ok(!allowedByCuration(v(0, 3), onlyShorts));

  assert.ok(!allowedByCuration(v(0, 1), parseCuration(P('types=talk'), ds)));
  assert.ok(!allowedByCuration(v(0, 1), parseCuration(P('mute_topics=functional-programming'), ds)));
  // c3v0 is tagged with functional-programming as its second topic: muting it hides c3v0 too
  assert.ok(!allowedByCuration(v(3, 0), parseCuration(P('mute_topics=functional-programming'), ds)));
  assert.ok(!allowedByCuration(v(0, 1), parseCuration(P(`mute_channels=${encodeURIComponent(encodeURIComponent('Channel 0-1'))}`), ds)));
});

test('curationKey is order-independent; mixPattern spreads sources by weight', () => {
  const a = { ...defaultCuration(), types: new Set(['talk', 'demo']) };
  const b = { ...defaultCuration(), types: new Set(['demo', 'talk']) };
  assert.equal(curationKey(a), curationKey(b));
  assert.notEqual(curationKey(a), curationKey(defaultCuration()));

  const p = mixPattern({ a: 3, b: 1, c: 0 });
  assert.equal(p.length, 4);
  assert.deepEqual(p.filter((x) => x === 'a').length, 3);
  assert.ok(!p.includes('c'));
  const q = mixPattern({ x: 2, y: 2 });
  assert.deepEqual(q, ['x', 'y', 'x', 'y']); // interleaved, not bunched
  assert.deepEqual(mixPattern({ x: 0 }), []);
});
