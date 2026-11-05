// Live videos from YouTube: channel feeds (no key), topic searches (Data API key), channel lookup.
// YouTube is stubbed: every request the code makes must match a stub, or the test fails.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { loadDataset } from '../../src/data.js';
import { createApp } from '../../src/server.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { channelIdFromPage, createYoutube, parseChannelFeed, parseChannelInput } from '../../src/youtube.js';
import { fakeEmbedder, makeFixture, vidOf } from '../helpers/fixture.js';

const quiet = { info() {}, error() {} };
const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CH_GONE = 'UCgonegonegonegonegone00';

function atom(channel, entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>${channel}</title>
 <author><name>${channel}</name></author>
${entries
  .map(
    (e) => ` <entry>
  <yt:videoId>${e.vid}</yt:videoId>
  <title>${e.title}</title>
  <link rel="alternate" href="https://www.youtube.com/${e.short ? 'shorts/' : 'watch?v='}${e.vid}"/>
  <author><name>${channel}</name></author>
  <published>${e.published}</published>
  <media:group><media:community><media:statistics views="${e.views}"/></media:community></media:group>
 </entry>`,
  )
  .join('\n')}
</feed>`;
}

function stubYoutube() {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/feeds/videos.xml') {
      const id = url.searchParams.get('channel_id');
      if (id === CH_A)
        return new Response(
          atom('Alpha &amp; Co', [
            { vid: 'alphaShort1', title: 'A short &lt;one&gt;', short: true, published: '2026-11-01T10:00:00+00:00', views: 100 },
            { vid: 'alphaLong01', title: 'A long one', published: '2026-10-30T10:00:00+00:00', views: 5000 },
            { vid: 'alphaOld001', title: 'An old one', published: '2026-10-01T10:00:00+00:00', views: 7 },
          ]),
        );
      if (id === CH_B) return new Response(atom('Beta', [{ vid: vidOf(0, 0), title: 'Already in the collection', published: '2026-11-02T00:00:00+00:00', views: 1 }, { vid: 'betaVideo01', title: 'Beta video', published: '2026-11-01T00:00:00+00:00', views: 2 }]));
      return new Response('', { status: 404 });
    }
    if (url.hostname === 'www.googleapis.com') {
      if (url.searchParams.get('key') !== 'test-key') return Response.json({ error: 'bad key' }, { status: 403 });
      if (url.pathname.endsWith('/search'))
        return Response.json({
          items: [
            { id: { videoId: 'topicVid001' }, snippet: { title: 'Rust &amp; you', channelTitle: 'Gamma', channelId: 'UCgggggggggggggggggggggg', publishedAt: '2026-11-03T00:00:00Z' } },
            { id: { videoId: 'topicShort1' }, snippet: { title: 'Rust in 60s', channelTitle: 'Gamma', channelId: 'UCgggggggggggggggggggggg', publishedAt: '2026-11-02T00:00:00Z' } },
            { id: { videoId: 'liveStream1' }, snippet: { title: 'Live now', channelTitle: 'Gamma', channelId: 'UCgggggggggggggggggggggg', publishedAt: '2026-11-03T00:00:00Z', liveBroadcastContent: 'live' } },
            { id: { videoId: 'noEmbed0001' }, snippet: { title: 'Not embeddable', channelTitle: 'Delta', channelId: 'UCdddddddddddddddddddddd', publishedAt: '2026-11-02T00:00:00Z' } },
            { id: { channelId: CH_A }, snippet: { title: 'a channel result' } },
          ],
        });
      if (url.pathname.endsWith('/videos'))
        return Response.json({
          items: [
            { id: 'topicVid001', contentDetails: { duration: 'PT12M3S' }, statistics: { viewCount: '1200' }, status: { embeddable: true } },
            { id: 'topicShort1', contentDetails: { duration: 'PT58S' }, statistics: { viewCount: '99' }, status: { embeddable: true } },
            { id: 'noEmbed0001', contentDetails: { duration: 'PT5M' }, statistics: { viewCount: '5' }, status: { embeddable: false } },
          ],
        });
    }
    if (url.pathname === '/@alpha') return new Response(`<html><link rel="canonical" href="https://www.youtube.com/channel/${CH_A}"></html>`);
    if (url.pathname === '/oembed') return Response.json({ title: 'x', author_name: 'Beta', author_url: 'https://www.youtube.com/@beta' });
    if (url.pathname === '/@beta') return new Response(`<html><meta itemprop="identifier" content="${CH_B}"></html>`);
    throw new Error(`unexpected request to ${url}`);
  };
  return { calls, fetchImpl };
}

describe('parsing YouTube answers', () => {
  test('a channel feed becomes entries, with Shorts, views and decoded text', () => {
    const { channel, entries } = parseChannelFeed(atom('Alpha &amp; Co', [{ vid: 'alphaShort1', title: 'A &quot;short&quot;', short: true, published: '2026-11-01T10:00:00+00:00', views: 100 }, { vid: 'bad', title: 'x', published: '', views: 1 }]));
    assert.equal(channel, 'Alpha & Co');
    assert.deepEqual(entries, [{ vid: 'alphaShort1', title: 'A "short"', channel: 'Alpha & Co', published: '2026-11-01T10:00:00+00:00', views: 100, short: true }]);
  });

  test('channel input: ids, handles and links to channels, videos and Shorts', () => {
    assert.deepEqual(parseChannelInput(CH_A), { channelId: CH_A });
    assert.deepEqual(parseChannelInput(' @alpha '), { handle: '@alpha' });
    assert.deepEqual(parseChannelInput(`https://www.youtube.com/channel/${CH_A}/videos`), { channelId: CH_A });
    assert.deepEqual(parseChannelInput('youtube.com/@alpha/shorts'), { handle: '@alpha' });
    assert.deepEqual(parseChannelInput('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), { vid: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseChannelInput('https://youtu.be/dQw4w9WgXcQ'), { vid: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseChannelInput('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { vid: 'dQw4w9WgXcQ' });
    for (const bad of ['', 'hello', 'https://evil.com/@alpha', 'https://youtube.com/watch?v=short', '@a', 'UCshort'])
      assert.equal(parseChannelInput(bad), null, bad);
  });

  test('channel id from a channel page', () => {
    assert.equal(channelIdFromPage(`x"externalId":"${CH_B}"y`), CH_B);
    assert.equal(channelIdFromPage('<html>nothing</html>'), null);
  });

  test('the daily quota budget stops searches before YouTube does, and resets the next day', async () => {
    let t = Date.parse('2026-11-05T10:00:00Z');
    const { calls, fetchImpl } = stubYoutube();
    const yt = createYoutube({ apiKey: 'test-key', fetchImpl, dailyBudget: 202, log: quiet, now: () => t });
    await yt.searchTopic('rust');
    await yt.searchTopic('zig');
    const before = calls.length;
    await assert.rejects(yt.searchTopic('go'), { status: 503 });
    assert.equal(calls.length, before, 'no request once the budget is spent');
    await yt.searchTopic('rust'); // cached: free
    t += 24 * 3600_000;
    await yt.searchTopic('go');
    assert.deepEqual(yt.quota(), { day: '2026-11-06', spent: 101, budget: 202 });
  });

  test('Pacific midnight starts a new quota day, not UTC midnight', async () => {
    let t = Date.parse('2026-11-05T23:00:00Z'); // 15:00 in California
    const { fetchImpl } = stubYoutube();
    const yt = createYoutube({ apiKey: 'test-key', fetchImpl, dailyBudget: 101, log: quiet, now: () => t });
    await yt.searchTopic('rust');
    t = Date.parse('2026-11-06T02:00:00Z'); // a new UTC day, still 18:00 on the 5th in California
    await assert.rejects(yt.searchTopic('zig'), { status: 503 });
    t = Date.parse('2026-11-06T08:30:00Z'); // 00:30 on the 6th in California
    await yt.searchTopic('zig');
  });

  test('parallel asks for one topic or channel share one request; missing channels are remembered', async () => {
    const { calls, fetchImpl } = stubYoutube();
    const yt = createYoutube({ apiKey: 'test-key', fetchImpl, log: quiet });
    await Promise.all([yt.searchTopic('rust'), yt.searchTopic('Rust'), yt.searchTopic('rust')]);
    assert.equal(calls.length, 2, 'one search and one details call');
    assert.equal(yt.quota().spent, 101);
    await Promise.all([yt.channelUploads(CH_A), yt.channelUploads(CH_A)]);
    assert.equal(calls.length, 3);
    await assert.rejects(yt.channelUploads(CH_GONE), { status: 404 });
    await assert.rejects(yt.channelUploads(CH_GONE), { status: 404 });
    assert.equal(calls.length, 4, 'a missing channel is asked about once');
    assert.equal(yt.hasChannel(CH_GONE), true);
  });

  test('new searches are spread over the day for the whole server', async () => {
    const { fetchImpl } = stubYoutube();
    const yt = createYoutube({ apiKey: 'test-key', fetchImpl, log: quiet, now: () => 0 });
    for (let i = 0; i < 8; i++) await yt.searchTopic(`t${i}`);
    await assert.rejects(yt.searchTopic('t8'), { status: 503 });
    await yt.searchTopic('t0'); // cached ones still answer
    assert.equal(yt.quota().spent, 8 * 101);
  });

  test('API errors never put the key in the log', async () => {
    const lines = [];
    const yt = createYoutube({ apiKey: 'secret-key', fetchImpl: async () => new Response('no', { status: 403 }), log: { error: (m) => lines.push(m) } });
    await assert.rejects(yt.searchTopic('rust'), { status: 502 });
    assert.ok(lines.length && lines.every((l) => !l.includes('secret-key')), lines.join('\n'));
  });
});

async function start(options) {
  const { server } = createApp({ log: quiet, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { get, close: () => new Promise((r) => server.close(r)) };
}

describe('/api/live', () => {
  let fx;
  let ds;
  before(() => {
    fx = makeFixture();
    ds = loadDataset({ dataDir: fx.dataDir });
  });
  after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const open = (opts = {}) => {
    const stub = stubYoutube();
    const youtube = createYoutube({ apiKey: opts.key ?? null, fetchImpl: stub.fetchImpl, log: quiet });
    return start({ ds, embedder: fakeEmbedder(), youtube, liveLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }), oembedLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }), ...opts.app }).then((app) => ({ app, stub }));
  };

  test('channel feeds work without a key, round-robin across channels, newest first, cached', async () => {
    const { app, stub } = await open();
    try {
      const cfg = await app.get('/api/config');
      assert.deepEqual(cfg.body.live, { channels: true, topics: false, max_channels: 30, max_topics: 8 });
      const { status, body, headers } = await app.get(`/api/live?channels=${CH_A},${CH_B}`);
      assert.equal(status, 200);
      assert.equal(headers.get('cache-control'), 'private, max-age=60');
      // vidOf(0, 0) is in the collection already: it comes with its HN card from the regular feed
      assert.deepEqual(body.items.map((i) => i.vid), ['alphaShort1', 'alphaLong01', 'betaVideo01', 'alphaOld001']);
      assert.deepEqual(body.items[0], { vid: 'alphaShort1', title: 'A short <one>', channel: 'Alpha & Co', published: '2026-11-01T10:00:00+00:00', views: 100, short: true, source: 'channel', via: 'Alpha & Co', channelId: CH_A });
      assert.deepEqual(body.sources, [
        { kind: 'channel', id: CH_A, ok: true, name: 'Alpha & Co', count: 3 },
        { kind: 'channel', id: CH_B, ok: true, name: 'Beta', count: 2 },
      ]);
      assert.equal(stub.calls.length, 2);
      await app.get(`/api/live?channels=${CH_B},${CH_A}`);
      assert.equal(stub.calls.length, 2, 'feeds are cached');
    } finally {
      await app.close();
    }
  });

  test('a failing source is reported, the rest still load', async () => {
    const { app } = await open();
    try {
      const { status, body } = await app.get(`/api/live?channels=${CH_GONE},${CH_A}&topics=rust`);
      assert.equal(status, 200);
      assert.deepEqual(body.items.map((i) => i.vid), ['alphaShort1', 'alphaLong01', 'alphaOld001']);
      assert.deepEqual(body.sources.map((s) => [s.id, s.ok, s.error ?? null]), [
        [CH_GONE, false, 'YouTube has no such channel or video'],
        [CH_A, true, null],
        ['rust', false, 'live topics need a YouTube Data API key on the server'],
      ]);
    } finally {
      await app.close();
    }
  });

  test('topics search YouTube with a key: durations, Shorts, embeddable only, one quota-limited search per new topic', async () => {
    const { app, stub } = await open({ key: 'test-key', app: { topicLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }) } });
    try {
      assert.equal((await app.get('/api/config')).body.live.topics, true);
      const { body } = await app.get('/api/live?topics=Rust');
      assert.deepEqual(
        body.items.map((i) => [i.vid, i.title, i.duration_s, i.short, i.via]),
        [
          ['topicVid001', 'Rust & you', 723, false, 'Rust'],
          ['topicShort1', 'Rust in 60s', 58, true, 'Rust'],
        ],
      );
      const search = stub.calls.find((u) => u.pathname.endsWith('/search'));
      assert.equal(search.searchParams.get('q'), 'Rust');
      assert.equal(search.searchParams.get('videoEmbeddable'), 'true');
      // the same topic again is cached and doesn't spend this client's topic budget...
      assert.equal((await app.get('/api/live?topics=rust')).body.sources[0].ok, true);
      // ...but a second new topic does, and the budget is 1
      const second = await app.get('/api/live?topics=zig');
      assert.deepEqual(second.body.sources[0], { kind: 'topic', id: 'zig', ok: false, error: 'too many new topic searches, try again later' });
    } finally {
      await app.close();
    }
  });

  test('strict input', async () => {
    const { app, stub } = await open();
    try {
      for (const q of ['', '?channels=', '?channels=UCshort', '?channels=x&foo=1', `?topics=${'a'.repeat(61)}`, `?topics=${Array.from({ length: 9 }, (_, i) => `t${i}`).join('|')}`, `?channels=${Array.from({ length: 31 }, (_, i) => `UC${String(i).padStart(22, 'x')}`).join(',')}`]) {
        assert.equal((await app.get(`/api/live${q}`)).status, 400, q);
      }
      assert.equal(stub.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  test('each channel YouTube must be asked about counts against the client', async () => {
    const { app, stub } = await open({ app: { liveLimiter: createRateLimiter({ capacity: 3, refillPerSecond: 0.001 }) } });
    try {
      const fake = Array.from({ length: 30 }, (_, i) => `UC${String(i).padStart(22, 'z')}`).join(',');
      assert.equal((await app.get(`/api/live?channels=${fake}`)).status, 429, '30 new channels cost 7');
      assert.equal(stub.calls.length, 0);
      assert.equal((await app.get(`/api/live?channels=${CH_A}`)).status, 200);
    } finally {
      await app.close();
    }
  });

  test('refreshes are rate limited per client', async () => {
    const { app } = await open({ app: { liveLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001 }) } });
    try {
      assert.equal((await app.get(`/api/live?channels=${CH_A}`)).status, 200);
      const r = await app.get(`/api/live?channels=${CH_A}`);
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    } finally {
      await app.close();
    }
  });

  test('resolve finds a channel from an id, a handle page or a video, without a key', async () => {
    const { app } = await open();
    try {
      assert.deepEqual((await app.get(`/api/live/resolve?q=${CH_A}`)).body, { channelId: CH_A, channel: 'Alpha & Co' });
      assert.deepEqual((await app.get(`/api/live/resolve?q=${encodeURIComponent('https://www.youtube.com/@alpha')}`)).body, { channelId: CH_A, channel: 'Alpha & Co' });
      assert.deepEqual((await app.get(`/api/live/resolve?q=${encodeURIComponent('https://youtu.be/betaVideo01')}`)).body, { channelId: CH_B, channel: 'Beta' });
      assert.equal((await app.get('/api/live/resolve?q=hello')).status, 400);
      assert.equal((await app.get(`/api/live/resolve?q=${CH_GONE}`)).status, 404);
    } finally {
      await app.close();
    }
  });

  test('resolve uses the Data API when there is a key', async () => {
    const { app, stub } = await open({ key: 'test-key' });
    try {
      const r = await app.get('/api/live/resolve?q=@nobody');
      // the stub's channels endpoint is not defined: the code must call the API, not the page
      assert.equal(r.status, 502);
      assert.ok(stub.calls.some((u) => u.pathname.endsWith('/channels') && u.searchParams.get('forHandle') === '@nobody'));
      assert.ok(!stub.calls.some((u) => u.pathname === '/@nobody'));
    } finally {
      await app.close();
    }
  });
});
