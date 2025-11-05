// Operations: static caching, budgets, search cache, related slicing, config checks, shutdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { request } from 'node:http';
import { loadDataset } from '../../src/data.js';
import { createApp, readConfig } from '../../src/server.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { fakeEmbedder, makeFixture, vidOf } from '../helpers/fixture.js';

const quiet = { info() {}, error() {} };

async function boot(t, options = {}) {
  const fx = makeFixture();
  const ds = loadDataset({ dataDir: fx.dataDir });
  const { server } = createApp({ ds, embedder: fakeEmbedder(), log: quiet, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((r) => server.close(r));
    rmSync(fx.dir, { recursive: true, force: true });
  });
  return { base, server, ds };
}

test('static files: precompressed, ETag, 304 when unchanged', async (t) => {
  const { base } = await boot(t);
  const raw = await new Promise((resolve, reject) => {
    const req = request(`${base}/static/app.js`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(raw.headers['content-encoding'], 'gzip');
  const etag = raw.headers.etag;
  assert.match(etag, /^"[\w-]{16}"$/);
  const again = await fetch(`${base}/static/app.js`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('x-content-type-options'), 'nosniff');
  const changed = await fetch(`${base}/static/app.js`, { headers: { 'if-none-match': '"other"' } });
  assert.equal(changed.status, 200);
});

test('related: one cache entry per video, sliced to n', async (t) => {
  const { base } = await boot(t);
  const five = (await (await fetch(`${base}/api/related?vid=${vidOf(2, 4)}&n=5`)).json()).items.map((x) => x.vid);
  const twenty = (await (await fetch(`${base}/api/related?vid=${vidOf(2, 4)}&n=20`)).json()).items.map((x) => x.vid);
  assert.equal(five.length, 5);
  assert.deepEqual(twenty.slice(0, 5), five);
});

test('new feed profiles share a server-wide CPU budget', async (t) => {
  const { base } = await boot(t, {
    prepCpuBudget: createRateLimiter({ capacity: 50, refillPerSecond: 0.001 }),
    prepLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 100 }),
  });
  assert.equal((await fetch(`${base}/api/feed?like=${vidOf(0, 0)}`)).status, 200);
  const busy = await fetch(`${base}/api/feed?like=${vidOf(0, 1)}`);
  assert.equal(busy.status, 503);
  assert.ok(Number(busy.headers.get('retry-after')) >= 1);
  assert.equal((await fetch(`${base}/api/feed?like=${vidOf(0, 0)}&seed=other`)).status, 200, 'a known profile with a new seed is not charged');
});

test('search results are cached and searches share a server-wide budget', async (t) => {
  let embeds = 0;
  const counting = { ...fakeEmbedder(), embed: async (q) => (embeds++, fakeEmbedder().embed(q)) };
  const { base } = await boot(t, { embedder: counting, searchGlobalLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001 }) });
  assert.equal((await fetch(`${base}/api/search?q=physics`)).status, 200);
  assert.equal((await fetch(`${base}/api/search?q=Physics`)).status, 200, 'same query, different case: cached');
  assert.equal(embeds, 1);
  assert.equal((await fetch(`${base}/api/search?q=databases`)).status, 200);
  assert.equal((await fetch(`${base}/api/search?q=biology`)).status, 503);
});

test('shutdown closes idle keep-alive connections and resolves', async (t) => {
  const { base, server } = await boot(t);
  const agentRes = await fetch(`${base}/api/stats`, { headers: { connection: 'keep-alive' } });
  await agentRes.text();
  const t0 = Date.now();
  await server.shutdown(5000);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(server.listening, false);
});

test('config: PUBLIC_URL and MAX_CONNECTIONS are validated', () => {
  assert.equal(readConfig({ PUBLIC_URL: 'https://tube.example.com/' }).publicUrl, 'https://tube.example.com');
  assert.throws(() => readConfig({ PUBLIC_URL: 'notaurl' }), /PUBLIC_URL must be a full URL/);
  assert.throws(() => readConfig({ PUBLIC_URL: 'ftp://x.example' }), /http\(s\) origin/);
  assert.throws(() => readConfig({ MAX_CONNECTIONS: '0' }), /MAX_CONNECTIONS/);
  assert.equal(readConfig({}).maxConnections, 2000);
  assert.equal(readConfig({ CUSTOMTUBE_EMBEDDER: 'OFF' }).embedder, false);
});
