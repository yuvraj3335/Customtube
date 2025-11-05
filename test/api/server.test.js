import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { request } from 'node:http';
import { loadDataset } from '../../src/data.js';
import { createApp } from '../../src/server.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { DUP_VID, fakeEmbedder, makeFixture, vidOf } from '../helpers/fixture.js';

const quiet = { info() {}, error() {} };

async function start(options) {
  const { server } = createApp({ log: quiet, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, init) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  };
  return { server, base, get, close: () => new Promise((r) => server.close(r)) };
}

describe('API without YouTube metadata', () => {
  let fx;
  let app;
  const oembedCalls = [];
  before(async () => {
    fx = makeFixture();
    const ds = loadDataset({ dataDir: fx.dataDir });
    const fetchImpl = async (url) => {
      oembedCalls.push(url);
      const vid = new URL(new URL(url).searchParams.get('url')).searchParams.get('v');
      if (vid === 'missing0000') return new Response('Not Found', { status: 404 });
      if (vid === 'broken00000') return new Response('oops', { status: 500 });
      return Response.json({ title: `Short ${vid}`, author_name: 'Some Creator', type: 'video' });
    };
    app = await start({
      ds,
      embedder: fakeEmbedder(),
      fetchImpl,
      searchLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
      oembedLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
    });
  });
  after(async () => {
    await app.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('config describes the available filters and curation', async () => {
    const { status, body } = await app.get('/api/config');
    assert.equal(status, 200);
    assert.equal(body.has_youtube_metadata, false);
    assert.equal(body.search_mode, 'semantic');
    assert.ok(!('dur' in body.filters));
    assert.equal(body.curation.formats_available, false);
    assert.deepEqual(body.curation.formats, ['short', 'standard', 'long']);
    assert.ok(body.curation.mix_sources.includes('following'));
  });

  test('feed pages are consistent and carry reasons', async () => {
    const first = await app.get('/api/feed?seed=abc&n=10');
    const second = await app.get('/api/feed?seed=abc&n=10&offset=10');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 10);
    assert.equal(first.body.next_offset, 10);
    assert.equal(first.body.total, 48);
    const ids = [...first.body.items, ...second.body.items].map((x) => x.vid);
    assert.equal(new Set(ids).size, 20);
    for (const item of first.body.items) {
      assert.ok(item.reason);
      assert.ok(item.source);
      assert.equal(item.format, null); // no durations without metadata
    }
    const again = await app.get('/api/feed?seed=abc&n=10');
    assert.deepEqual(again.body.items.map((x) => x.vid), first.body.items.map((x) => x.vid));
    const last = await app.get('/api/feed?seed=abc&n=10&offset=40');
    assert.equal(last.body.items.length, 8);
    assert.equal(last.body.next_offset, null);
  });

  test('feed curation parameters are applied end to end', async () => {
    const r = await app.get('/api/feed?seed=x&n=60&mute_topics=physics&types=talk,lecture&mix=explore:0');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length > 0);
    for (const item of r.body.items) {
      assert.ok(['talk', 'lecture'].includes(item.content_type));
      assert.notEqual(item.category.id, 'physics');
      assert.notEqual(item.source, 'explore');
    }
    const shorts = await app.get('/api/feed?formats=short');
    assert.equal(shorts.status, 400);
    assert.match(shorts.body.error, /needs YouTube metadata/);
  });

  test('feed rejects bad input with 400', async () => {
    for (const q of ['n=0', 'n=61', 'offset=-1', 'like=notavideo', 'seed=has%20space', 'zzz=1', 'mix=classics:7', 'types=movie', 'n=1&n=2']) {
      const r = await app.get(`/api/feed?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(r.body.error, q);
    }
    const ids = (k) => Array.from({ length: k }, (_, i) => `v${String(i).padStart(10, '0')}`).join(',');
    assert.equal((await app.get(`/api/feed?seen=${ids(201)}`)).status, 400);
    assert.equal((await app.get(`/api/feed?like=${ids(500)}&n=1`)).status, 200, 'up to 500 likes');
    assert.equal((await app.get(`/api/feed?like=${ids(501)}`)).status, 400);
  });

  test('list filters, sorts and pages', async () => {
    const all = await app.get('/api/list?n=60');
    assert.equal(all.body.total, 60);
    const cat = await app.get('/api/list?cat=databases&n=5');
    assert.equal(cat.body.total, 11); // 10 + c4v0, which has databases as its second topic
    assert.deepEqual(cat.body.items.map((x) => x.vid).slice(0, 2), [vidOf(4, 0), vidOf(1, 0)]); // best score first (20.04, 20.01)
    const area = await app.get('/api/list?area=science&type=talk');
    assert.ok(area.body.items.every((x) => x.content_type === 'talk'));
    const hn = await app.get('/api/list?sort=hn&n=3');
    assert.ok(hn.body.items[0].recommenders >= hn.body.items[2].recommenders);
    assert.equal((await app.get('/api/list?cat=nope')).status, 404);
    assert.equal((await app.get('/api/list?cat=databases&area=science')).status, 400);
    assert.equal((await app.get('/api/list?sort=views')).status, 400);
    assert.equal((await app.get('/api/list?dur=short')).status, 400);
  });

  test('video, related and docs', async () => {
    const v = await app.get(`/api/video?vid=${vidOf(0, 1)}`);
    assert.equal(v.status, 200);
    assert.equal(v.body.mentions.length, 2);
    assert.equal(v.body.mentions[0].stance, 'strong_rec');
    assert.equal(typeof v.body.mentions[0].id, 'number');
    const dup = await app.get(`/api/video?vid=${DUP_VID}`);
    assert.equal(dup.body.duplicate_of, vidOf(0, 0));
    assert.equal((await app.get('/api/video?vid=AAAAAAAAAAA')).status, 404);
    assert.equal((await app.get('/api/video?vid=short')).status, 400);
    assert.equal((await app.get('/api/video')).status, 400);

    const rel = await app.get(`/api/related?vid=${vidOf(2, 4)}&n=5`);
    assert.equal(rel.body.items.length, 5);
    assert.equal(rel.body.items[0].vid, vidOf(2, 5));
    assert.ok(rel.body.items[0].reason);

    const docs = await app.get(`/api/docs?vids=${vidOf(0, 2)},AAAAAAAAAAA,${vidOf(0, 1)}`);
    assert.deepEqual(docs.body.items.map((x) => x.vid), [vidOf(0, 2), vidOf(0, 1)]); // order kept, unknown skipped
  });

  test('search: semantic results, weak flag, filters, validation', async () => {
    const r = await app.get('/api/search?q=physics%20lectures');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'semantic');
    assert.equal(r.body.weak, false);
    assert.equal(r.body.items[0].category.id, 'physics');
    const weak = await app.get('/api/search?q=qqqq%20zzzz');
    assert.equal(weak.body.weak, true);
    const filtered = await app.get('/api/search?q=physics&type=demo');
    assert.ok(filtered.body.items.length > 0 && filtered.body.items.every((x) => x.content_type === 'demo'));
    assert.equal((await app.get('/api/search')).status, 400);
    assert.equal((await app.get(`/api/search?q=${'x'.repeat(201)}`)).status, 400);
    assert.equal((await app.get('/api/search?q=a&sort=views')).status, 400);
  });

  test('browse and stats', async () => {
    const b = await app.get('/api/browse');
    assert.equal(b.body.length, 2);
    assert.ok(b.body[0].categories[0].count > 0);
    const s = await app.get('/api/stats');
    assert.equal(s.body.videos, 60);
    assert.equal(s.body.duplicates, 1);
  });

  test('oembed looks up added videos and maps YouTube errors', async () => {
    const ok = await app.get('/api/oembed?vid=shortvid001');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { vid: 'shortvid001', title: 'Short shortvid001', channel: 'Some Creator', in_collection: false });
    assert.equal(oembedCalls.length, 1);
    assert.match(oembedCalls[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3Dshortvid001$/);
    await app.get('/api/oembed?vid=shortvid001');
    assert.equal(oembedCalls.length, 1, 'second lookup is cached');
    const known = await app.get(`/api/oembed?vid=${vidOf(0, 0)}`);
    assert.equal(known.body.in_collection, true);
    assert.equal(oembedCalls.length, 1, 'videos in the collection never call YouTube');
    assert.equal((await app.get('/api/oembed?vid=missing0000')).status, 404);
    assert.equal((await app.get('/api/oembed?vid=broken00000')).status, 502);
    assert.equal((await app.get('/api/oembed?vid=bad')).status, 400);
  });

  test('app shell: per-page meta, escaping, 404s and security headers', async () => {
    const home = await app.get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.body, /<title>Custom Tube: videos Hacker News recommends<\/title>/);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');

    const watch = await app.get(`/watch/${vidOf(1, 2)}`);
    assert.match(watch.body, /<title>Databases talk number 2 · Custom Tube<\/title>/);
    assert.match(watch.body, /og:image" content="https:\/\/i\.ytimg\.com\/vi\/c1v2_______\/hq2\.jpg"/);

    const search = await app.get(`/search/${encodeURIComponent('<script>alert(1)</script>')}`);
    assert.equal(search.status, 200);
    assert.ok(!search.body.includes('<script>alert'), 'query is escaped in <title>');
    assert.match(search.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    for (const p of ['/settings', '/mine', '/topics', '/c/physics', '/a/science']) assert.equal((await app.get(p)).status, 200, p);
    // An unknown but well-formed id may be a video the viewer added: the client decides.
    assert.equal((await app.get('/watch/AAAAAAAAAAA')).status, 200);
    assert.equal((await app.get('/watch/bad')).status, 404);
    assert.equal((await app.get('/c/nope')).status, 404);
    assert.equal((await app.get('/nope/deeper')).status, 404);
    assert.equal((await app.get('/api/nope')).status, 404);
    assert.equal((await app.get('/search/%E0%A4%A')).status, 404);
  });

  test('static files are served from a fixed list, nothing else', async () => {
    const js = await app.get('/static/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    // fetch() would normalize "..", so send the raw paths with http.request.
    const raw = (path) =>
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: new URL(app.base).port, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const p of ['/static/../package.json', '/static/%2e%2e/package.json', '/static/..%2fpackage.json', '/static/index.html', '/package.json', '/static/nope.js', '/static//etc/passwd']) {
      const r = await raw(p);
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('"dependencies"') && !r.body.includes('root:'), p);
    }
  });

  test('POST /api/feed takes the profile as JSON and matches GET', async () => {
    const post = (body, headers = { 'content-type': 'application/json' }) => app.get('/api/feed', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const viaGet = await app.get(`/api/feed?seed=json&n=12&like=${vidOf(1, 0)}&types=talk,demo&mix=explore:0&mute_channels=${encodeURIComponent(encodeURIComponent('Channel 1-1'))}`);
    const viaPost = await post({ seed: 'json', n: 12, like: [vidOf(1, 0)], types: ['talk', 'demo'], mix: { explore: 0 }, mute_channels: ['Channel 1-1'] });
    assert.equal(viaPost.status, 200);
    assert.deepEqual(viaPost.body, viaGet.body);
    assert.ok(viaPost.body.items.every((x) => x.channel !== 'Channel 1-1'));

    // channel names with commas and non-ASCII survive the JSON form
    const odd = await post({ mute_channels: ['A, B & Co', 'Ünïcode チャンネル'], n: 5 });
    assert.equal(odd.status, 200);

    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post({ like: 'notarray' })).status, 400);
    assert.equal((await post({ news: 'yes' })).status, 400);
    assert.equal((await post({ n: '5' })).status, 400);
    assert.equal((await post({ mix: { classics: 1.5 } })).status, 400);
    assert.equal((await post({ surprise: 1 })).status, 400);
    assert.equal((await post({ types: [] })).status, 400, 'empty filter list');
    assert.equal((await post({ mix: {} })).status, 400, 'empty mix');
    assert.equal((await post({ like: [] })).status, 200, 'an empty profile list is fine');
    const withQuery = await app.get('/api/feed?types=talk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":5}' });
    assert.equal(withQuery.status, 400, 'POST parameters in the URL would be ignored');
    assert.equal((await post({}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(JSON.stringify({ seed: 'x'.repeat(70_000) }))).status, 413);
    // a long profile that would not fit in a URL is fine as a body
    const many = Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(10, '0')}`);
    const big = await post({ like: many, dislike: many, seen: many, mute_channels: Array.from({ length: 150 }, (_, i) => `Канал номер ${i}`) });
    assert.equal(big.status, 200);
  });

  test('empty filter values are rejected, not treated as "no filter"', async () => {
    for (const q of ['/api/list?cat=', '/api/list?type=', '/api/list?sort=', '/api/search?q=x&type=', '/api/feed?types=', '/api/feed?mix=']) {
      assert.equal((await app.get(q)).status, 400, q);
    }
  });

  test('gzip, HEAD and method handling', async () => {
    const raw = await new Promise((resolve, reject) => {
      const req = request(`${app.base}/api/list?n=60`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(gunzipSync(raw.body)).items.length, 60);
    const head = await fetch(`${app.base}/api/stats`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
    assert.equal((await app.get('/api/list', { method: 'POST' })).status, 405);
    assert.equal((await app.get('/api/feed', { method: 'DELETE' })).status, 405);
  });
});

describe('rate limits and proxies', () => {
  let fx;
  let ds;
  before(() => {
    fx = makeFixture();
    ds = loadDataset({ dataDir: fx.dataDir });
  });
  after(() => rmSync(fx.dir, { recursive: true, force: true }));

  test('feed and oembed are rate limited per client', async () => {
    const app = await start({
      ds,
      embedder: fakeEmbedder(),
      fetchImpl: async () => Response.json({ title: 't', author_name: 'a' }),
      feedLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001 }),
      oembedLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.001 }),
    });
    try {
      assert.equal((await app.get('/api/feed?seed=a')).status, 200);
      assert.equal((await app.get('/api/feed?seed=b')).status, 200);
      const limited = await app.get('/api/feed?seed=c');
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await app.get('/api/oembed?vid=aaaaaaaaaaa')).status, 200);
      assert.equal((await app.get('/api/oembed?vid=bbbbbbbbbbb')).status, 429);
      // collection videos never call YouTube, so they are not limited
      assert.equal((await app.get(`/api/oembed?vid=${vidOf(0, 0)}`)).status, 200);
    } finally {
      await app.close();
    }
  });

  test('with TRUST_PROXY the limit keys on the address our proxy appended, not a forged one', async () => {
    const app = await start({ ds, embedder: fakeEmbedder(), trustProxy: 1, searchLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.001 }) });
    try {
      const search = (xff) => app.get('/api/search?q=physics', { headers: { 'x-forwarded-for': xff } });
      assert.equal((await search('1.1.1.1, 203.0.113.9')).status, 200);
      // a different forged first hop from the same real client is still the same bucket
      assert.equal((await search('9.9.9.9, 203.0.113.9')).status, 429);
      assert.equal((await search('203.0.113.10')).status, 200);
    } finally {
      await app.close();
    }
    // Two proxies (CDN + load balancer): the client is the second entry from the right.
    const two = await start({ ds, embedder: fakeEmbedder(), trustProxy: 2, searchLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.001 }) });
    try {
      const search = (xff) => two.get('/api/search?q=physics', { headers: { 'x-forwarded-for': xff } });
      assert.equal((await search('6.6.6.6, 198.51.100.1, 10.0.0.1')).status, 200);
      assert.equal((await search('7.7.7.7, 198.51.100.1, 10.0.0.1')).status, 429, 'same real client');
      assert.equal((await search('198.51.100.2, 10.0.0.1')).status, 200, 'another client behind the same CDN edge');
    } finally {
      await two.close();
    }
  });

  test('only new profiles spend the expensive budget; mix changes and new seeds reuse it', async () => {
    const app = await start({ ds, embedder: fakeEmbedder(), prepLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.001 }) });
    try {
      assert.equal((await app.get(`/api/feed?like=${vidOf(0, 0)}&seed=a`)).status, 200);
      assert.equal((await app.get(`/api/feed?like=${vidOf(0, 0)}&seed=b`)).status, 200, 'new seed');
      assert.equal((await app.get(`/api/feed?like=${vidOf(0, 0)}&seed=b&mix=explore:0,similar:5`)).status, 200, 'mix change');
      const other = await app.get(`/api/feed?like=${vidOf(0, 1)}&seed=a`);
      assert.equal(other.status, 429, 'a new profile needs the budget');
    } finally {
      await app.close();
    }
  });

  test('feed pages agree across separate server instances (no shared cache)', async () => {
    const a = await start({ ds, embedder: fakeEmbedder() });
    const b = await start({ ds, embedder: fakeEmbedder() });
    try {
      const pageA = await a.get(`/api/feed?seed=same&n=10&offset=10&like=${vidOf(2, 0)}`);
      const pageB = await b.get(`/api/feed?seed=same&n=10&offset=10&like=${vidOf(2, 0)}`);
      assert.deepEqual(pageA.body, pageB.body);
      const first = await b.get(`/api/feed?seed=same&n=10&like=${vidOf(2, 0)}`);
      assert.equal(new Set([...first.body.items, ...pageA.body.items].map((x) => x.vid)).size, 20);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('API with YouTube metadata and limits', () => {
  let fx;
  let app;
  before(async () => {
    fx = makeFixture({ withMeta: true });
    const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
    let t = 0;
    app = await start({
      ds,
      embedder: fakeEmbedder({ status: 'loading' }),
      searchLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001, now: () => t }),
      now: () => Date.parse('2026-11-01T00:00:00Z'),
    });
    t = 1;
  });
  after(async () => {
    await app.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('metadata filters, formats and sorts work', async () => {
    const cfg = await app.get('/api/config');
    assert.deepEqual(cfg.body.filters.dur, ['short', 'medium', 'long', 'xlong']);
    assert.equal(cfg.body.curation.formats_available, true);
    const shorts = await app.get('/api/list?dur=short&n=60');
    assert.ok(shorts.body.items.length > 0 && shorts.body.items.every((x) => x.yt.duration_s < 240));
    const views = await app.get('/api/list?sort=views&n=3');
    assert.equal(views.body.items[0].yt.views, 300000);
    const feedShorts = await app.get('/api/feed?formats=short&n=60');
    assert.equal(feedShorts.status, 200);
    assert.ok(feedShorts.body.items.length > 0 && feedShorts.body.items.every((x) => x.format === 'short'));
    const feedNoShorts = await app.get('/api/feed?formats=standard,long&n=60');
    assert.ok(feedNoShorts.body.items.every((x) => x.format !== 'short'));
    assert.ok((await app.get('/api/feed?n=60')).body.items.some((x) => x.source === 'gems'));
  });

  test('search falls back to keywords while the model loads, and is rate limited', async () => {
    const r = await app.get('/api/search?q=Databases%20talk%20number%203');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'keyword');
    assert.equal(r.body.items[0].vid, vidOf(1, 3));
    await app.get('/api/search?q=physics');
    const limited = await app.get('/api/search?q=physics');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('round-3 hardening', () => {
  let fx;
  let app;
  before(async () => {
    fx = makeFixture();
    const ds = loadDataset({ dataDir: fx.dataDir });
    // a video summary with "$" replacement patterns must not splice the page into <head>
    ds.byVid.get(vidOf(0, 1)).summary = "Great talk $` and $' and $&";
    app = await start({ ds, embedder: fakeEmbedder(), apiLimiter: createRateLimiter({ capacity: 3, refillPerSecond: 0.001 }) });
  });
  after(async () => {
    await app.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('"$" patterns in page data are inserted literally', async () => {
    const watch = await app.get(`/watch/${vidOf(0, 1)}`);
    assert.match(watch.body, /<meta name="description" content="Great talk \$` and \$&#39; and \$&amp;">/);
    assert.equal(watch.body.match(/<!doctype html>/gi).length, 1);
    const search = await app.get(`/search/${encodeURIComponent("x$'")}`);
    assert.match(search.body, /<title>x\$&#39; - search · Custom Tube<\/title>/);
  });

  test('a query model whose vectors do not match the data falls back to keywords', async () => {
    const fx2 = makeFixture();
    const ds2 = loadDataset({ dataDir: fx2.dataDir });
    const errors = [];
    const wrong = { status: () => 'ready', embed: async () => new Float32Array(16).fill(0.25) };
    const app2 = await start({ ds: ds2, embedder: wrong, log: { info() {}, error: (m) => errors.push(m) } });
    try {
      const r = await app2.get('/api/search?q=Databases%20talk%20number%203');
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, 'keyword');
      assert.equal(r.body.items[0].vid, vidOf(1, 3));
      assert.match(errors.join(' '), /16 dimensions but the data has 8/);
    } finally {
      await app2.close();
      rmSync(fx2.dir, { recursive: true, force: true });
    }
  });

  test('cheap API routes still have a per-client budget', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await app.get('/api/stats')).status, 200);
    const r = await app.get('/api/stats');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
});

describe('suggestions', () => {
  let fx;
  let app;
  before(async () => {
    fx = makeFixture();
    app = await start({ ds: loadDataset({ dataDir: fx.dataDir }), embedder: fakeEmbedder() });
  });
  after(async () => {
    await app.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('the last word may be a prefix; earlier words must be whole', async () => {
    const r = await app.get('/api/suggest?q=physics%20ta');
    assert.equal(r.status, 200);
    assert.ok(r.body.videos.length > 0 && r.body.videos.every((v) => /physics talk/i.test(v.title)));
    assert.deepEqual(r.body.topics.map((t) => t.id), []);
    const topic = await app.get('/api/suggest?q=databa');
    assert.deepEqual(topic.body.topics.map((t) => t.id), ['databases']);
    assert.ok(topic.body.videos.length <= 6);
    assert.deepEqual((await app.get('/api/suggest?q=x')).body, { videos: [], topics: [] });
    assert.equal((await app.get('/api/suggest')).status, 400);
    assert.equal((await app.get(`/api/suggest?q=${'a'.repeat(201)}`)).status, 400);
  });

  test('service worker and manifest are served from the root', async () => {
    const sw = await app.get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    const m = await app.get('/manifest.webmanifest');
    assert.equal(m.body.short_name, 'Custom Tube');
    assert.equal((await app.get('/static/sw.js')).status, 404);
  });
});
