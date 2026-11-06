// Browser end-to-end test: the real client in headless Chrome against the real server.
// Uses the real data export and the real embedding model when they are present (run
// `npm run data:fetch` first), otherwise the synthetic fixture and a stand-in embedder.
// Needs Google Chrome installed (or CHROME_PATH pointing at a Chromium-family browser).
// Every request that leaves localhost is answered locally, so the test is hermetic.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadDataset } from '../../src/data.js';
import { createApp, readConfig } from '../../src/server.js';
import { createYoutube } from '../../src/youtube.js';
import { createEmbedder } from '../../src/embedder.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { fakeEmbedder, makeFixture } from '../helpers/fixture.js';

const cfg = readConfig({ ...process.env, CUSTOMTUBE_YOUTUBE_META: process.env.CUSTOMTUBE_YOUTUBE_META || '/nonexistent' });
const REAL = existsSync(path.join(cfg.dataDir, 'videos.jsonl'));
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ADDED_VID = 'e2eShort001';

// A stand-in for YouTube's embed page: it answers the "listening" handshake the way the real
// player does, reports a position, and ends the video when told to (window.name === 'end').
const FAKE_PLAYER = `<!doctype html><html><body><script>
  let id = null;
  const send = (msg) => parent.postMessage(JSON.stringify({ ...msg, id }), '*');
  addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.event !== 'listening') return;
    id = m.id;
    send({ event: 'onReady' });
    send({ event: 'infoDelivery', info: { currentTime: 125, duration: 600, playerState: 1 } });
    setTimeout(() => send({ event: 'infoDelivery', info: { currentTime: 600, duration: 600, playerState: 0 } }), 400);
  });
</script></body></html>`;

describe(`Custom Tube in a browser (${REAL ? 'real data' : 'fixture data'})`, () => {
  let fx;
  let server;
  let base;
  let browser;
  let page;
  const errors = [];

  before(async () => {
    let ds;
    let embedder;
    if (REAL) {
      ds = loadDataset({ dataDir: cfg.dataDir });
      embedder = createEmbedder({ cacheDir: cfg.cacheDir, log: { info() {}, error: console.error } });
      await embedder.start();
      assert.equal(embedder.status(), 'ready', 'the embedding model should load');
    } else {
      fx = makeFixture();
      ds = loadDataset({ dataDir: fx.dataDir });
      embedder = fakeEmbedder();
    }
    const fetchImpl = async () => Response.json({ title: 'My e2e Short', author_name: 'E2E Creator' });
    // A YouTube channel the viewer can follow: its handle page and its uploads feed.
    const LIVE_CH = 'UCe2ee2ee2ee2ee2ee2ee2ee';
    const ytFetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/@e2echannel') return new Response(`<link rel="canonical" href="https://www.youtube.com/channel/${LIVE_CH}">`);
      if (url.pathname === '/feeds/videos.xml' && url.searchParams.get('channel_id') === LIVE_CH)
        return new Response(
          `<feed><title>E2E Channel</title><entry><yt:videoId>liveE2Evid1</yt:videoId><title>Fresh upload from E2E</title><link rel="alternate" href="https://www.youtube.com/watch?v=liveE2Evid1"/><author><name>E2E Channel</name></author><published>${new Date(Date.now() - 3600_000).toISOString()}</published><media:statistics views="1234"/></entry><entry><yt:videoId>liveE2Eshrt</yt:videoId><title>A quick E2E Short</title><link rel="alternate" href="https://www.youtube.com/shorts/liveE2Eshrt"/><author><name>E2E Channel</name></author><published>${new Date(Date.now() - 7200_000).toISOString()}</published><media:statistics views="99"/></entry></feed>`,
        );
      return new Response('', { status: 404 });
    };
    // All of YouTube, as the keyless search returns it: two pages per search.
    const webSearch = {
      async search(q, { page = null, within = null } = {}) {
        const n = page ? 2 : 1;
        // each query (and followed topics, which ask for recent videos) finds its own videos
        const tag = [...q].reduce((x, c) => (x * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36).padStart(7, '0').slice(-7);
        const items = [0, 1].map((i) => ({ vid: `${within ? 't' : 'w'}${tag}${n}${i}x`, title: `${q} on YouTube, part ${n}.${i}`, channel: 'Web Channel', channelId: 'UCwebwebwebwebwebwebwebw', published: new Date(Date.now() - 86_400_000).toISOString(), duration_s: 420, views: 4200, short: false }));
        return { items, next: page ? null : 'NEXT_PAGE_TOKEN_e2e_000' };
      },
    };
    ({ server } = createApp({
      ds,
      embedder,
      fetchImpl,
      youtube: createYoutube({ fetchImpl: ytFetch, innertube: webSearch, log: { error: console.error } }),
      log: { info() {}, error: console.error },
      searchLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
    }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    // Service workers would take requests out of the tests' control; one test below covers them.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === base) return route.continue();
      if (url.origin === 'https://www.youtube-nocookie.com' && url.pathname.startsWith('/embed/')) return route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PLAYER });
      if (url.hostname === 'i.ytimg.com') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      return route.fulfill({ status: 204, body: '' }); // YouTube embeds and anything else
    });
    page = await context.newPage();
    page.on('console', (m) => {
      // the malformed-link test expects its 404
      if (m.type() === 'error' && !m.location().url.includes('/search/100%25%')) errors.push(`${m.text()} @ ${m.location().url}`);
    });
    page.on('pageerror', (e) => errors.push(e.message));
  });

  after(async () => {
    await browser?.close();
    await new Promise((r) => (server ? server.close(r) : r()));
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  test('home shows a feed with reasons and loads more on scroll', async () => {
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.goto(base + '/');
    assert.equal((await feed).status(), 200);
    await page.waitForSelector('.card');
    const first = await page.locator('.card').count();
    assert.ok(first >= 12, `${first} cards`);
    assert.ok((await page.locator('.card-reason').first().textContent()).length > 5);
    assert.match(await page.title(), /Custom Tube/);
    if (REAL) {
      const more = page.waitForResponse((r) => r.url().includes('/api/feed') && r.request().postDataJSON()?.offset === 24);
      await page.mouse.wheel(0, 20000);
      await more;
      await page.waitForFunction((n) => document.querySelectorAll('.card').length > n, first);
    }
  });

  test('a video page shows HN comments, related videos and plays on click', async () => {
    const vid = await page.locator('.card').first().getAttribute('data-vid');
    await page.locator('.card .card-link').first().click();
    await page.waitForURL(`**/watch/${vid}`);
    await page.waitForSelector('.comment');
    assert.ok((await page.locator('.comment').count()) >= 1);
    await page.waitForSelector('.upnext .card');
    assert.equal(await page.locator('iframe').count(), 0, 'YouTube loads only after pressing play');
    await page.click('#poster');
    const src = await page.locator('.player iframe').getAttribute('src');
    assert.ok(src.startsWith(`https://www.youtube-nocookie.com/embed/${vid}`), src);
  });

  test('liking a video steers the Home feed', async () => {
    const vid = page.url().split('/').pop();
    await page.click('#like');
    assert.equal(await page.getAttribute('#like', 'aria-pressed'), 'true');
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('nav.tabs a[href="/"]');
    const res = await feed;
    const sent = res.request().postDataJSON();
    assert.equal(res.request().method(), 'POST');
    assert.ok(sent.like.includes(vid));
    assert.ok(sent.seen.includes(vid));
    const body = await res.json();
    assert.ok(body.items.some((x) => x.source === 'similar'), 'similar videos join the feed');
    assert.ok(!body.items.some((x) => x.vid === vid), 'the liked video itself is not repeated');
    await page.waitForSelector('text=Your feed');
  });

  test('hundreds of likes: none of them comes back in the feed', async () => {
    const list = await (await fetch(`${base}/api/list?n=60`)).json();
    const more = await (await fetch(`${base}/api/list?n=60&offset=60`)).json();
    const many = [...list.items, ...more.items].map((x) => x.vid);
    const saved = await page.evaluate(() => localStorage.getItem('customtube:likes'));
    await page.evaluate((ids) => localStorage.setItem('customtube:likes', JSON.stringify(ids)), many);
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.goto(base + '/');
    const res = await feed;
    assert.equal(res.request().postDataJSON().like.length, many.length);
    const body = await res.json();
    assert.ok(!body.items.some((x) => many.includes(x.vid)));
    await page.evaluate((s) => localStorage.setItem('customtube:likes', s), saved);
  });

  test('search covers all of YouTube, page after page, and its videos play', async () => {
    const asked = [];
    const onResponse = (r) => r.url().includes('/api/yt/search') && asked.push([new URL(r.url()).searchParams.get('page'), r.status()]);
    page.on('response', onResponse);
    await page.fill('#q', 'zig compilers');
    await page.press('#q', 'Enter');
    await page.waitForSelector('.home-tabs .chip.on:has-text("All of YouTube")');
    // the second page loads by itself (the grid is short), with YouTube's token sent back
    await page.waitForSelector('.card-title:has-text("zig compilers on YouTube, part 2.1")');
    page.off('response', onResponse);
    assert.deepEqual(asked, [[null, 200], ['NEXT_PAGE_TOKEN_e2e_000', 200]]);
    assert.equal(await page.locator('.grid .card').count(), 4);
    await page.click('.card-title:has-text("part 1.0")');
    await page.waitForSelector('h1:has-text("zig compilers on YouTube, part 1.0")');
    await page.goBack();
  });

  test('semantic search finds a topic and filters apply', async () => {
    const q = REAL ? 'distributed systems' : 'physics';
    await page.fill('#q', q);
    await page.press('#q', 'Enter');
    await page.waitForSelector('.home-tabs a:has-text("Hacker News picks")');
    const res = page.waitForResponse((r) => r.url().includes('/api/search'));
    await page.click('.home-tabs a:has-text("Hacker News picks")');
    const body = await (await res).json();
    assert.equal(body.mode, 'semantic');
    assert.equal(body.weak, false);
    await page.waitForSelector('.grid .card');
    const titles = (await page.locator('.card-title').allTextContents()).slice(0, 5).join(' | ');
    assert.match(titles, REAL ? /distributed/i : /physics/i);

    const filtered = page.waitForResponse((r) => r.url().includes('/api/search') && r.url().includes('type=lecture'));
    await page.click('.picker-btn[data-filter="type"]');
    await page.click('.picker-pop .picker-opt[data-value="lecture"]');
    const fb = await (await filtered).json();
    assert.ok(fb.items.every((x) => x.content_type === 'lecture'));
    assert.match(page.url(), /type=lecture/);
    assert.match(page.url(), /in=hn/, 'a filter keeps the Hacker News tab');
    // a new search from this tab stays on it, filters too
    await page.fill('#q', 'compilers');
    await page.press('#q', 'Enter');
    await page.waitForURL(/\/search\/compilers\?/);
    assert.match(page.url(), /in=hn/);
    assert.match(page.url(), /type=lecture/);
    await page.waitForSelector('.home-tabs .chip.on:has-text("Hacker News picks")');
  });

  test('customize: kinds, mix and muted topics change the feed request', async () => {
    await page.click('nav.tabs a[href="/settings"]');
    await page.waitForSelector('text=Customize your feed');
    await page.check('input[data-type="talk"]');
    await page.check('input[data-type="lecture"]');
    await page.locator('#mix-explore').fill('0');
    await page.locator('#mix-explore').dispatchEvent('change');
    // the topic picker: a searchable list, not a native select
    await page.click('#mute-topic-select');
    const search = page.locator('.picker-pop .picker-search');
    await search.fill('zzz no such topic');
    await page.waitForSelector('.picker-pop .picker-empty:not([hidden])');
    await search.fill('');
    const first = page.locator('.picker-pop .picker-opt').first();
    const topic = await first.getAttribute('data-value');
    const name = (await first.locator('.picker-opt-label').textContent()).trim();
    // typing part of a topic's name narrows the list to it; Enter picks it
    await search.fill(name.split(/\s+/)[0]);
    assert.ok(!(await first.isHidden()));
    await search.press('Enter');
    await page.waitForSelector('.picker-pop', { state: 'detached' });
    await page.waitForSelector('.chip.removable');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mute-topic-select', 'focus returns to the picker');

    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('text=See my feed');
    const res = await feed;
    const sent = res.request().postDataJSON();
    assert.deepEqual(sent.types, ['talk', 'lecture']);
    assert.equal(sent.mix.explore, 0);
    assert.deepEqual(sent.mute_topics, [topic]);
    const body = await res.json();
    assert.ok(body.items.length > 0);
    for (const item of body.items) {
      assert.ok(['talk', 'lecture'].includes(item.content_type), item.content_type);
      assert.notEqual(item.source, 'explore');
    }
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:prefs')));
    assert.deepEqual(prefs.types, ['talk', 'lecture']);
  });

  test('follow a topic from its page; hide a channel from a video page', async () => {
    await page.goto(base + '/topics');
    await page.locator('.area li a').first().click();
    await page.waitForSelector('#follow-topic');
    const topicId = page.url().split('/').pop();
    await page.click('#follow-topic');
    assert.equal(await page.textContent('#follow-topic'), 'Following');
    await page.waitForSelector('.card');
    await page.locator('.card .card-link').first().click();
    await page.waitForSelector('#watch-more');
    const channel = await page.locator('.owner .channel-link').first().textContent();
    await page.click('#watch-more');
    await page.click(`.menu-item:has-text("Hide ")`);
    await page.waitForSelector('#toast.on');
    assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:prefs')).muteChannels)).includes(channel));

    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('nav.tabs a[href="/"]');
    const res = await feed;
    const sent = res.request().postDataJSON();
    assert.deepEqual(sent.follow_topics, [topicId]);
    assert.deepEqual(sent.mute_channels, [channel]);
    const body = await res.json();
    assert.ok(!body.items.some((x) => x.channel === channel));
  });

  test('card menu: not interested hides the card and can be undone; hide channel', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    const first = page.locator('.card').first();
    const vid = await first.getAttribute('data-vid');
    await first.hover();
    await first.locator('.more-btn').click();
    await page.waitForSelector('.menu');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'menu-item', 'focus moves into the menu');
    await page.click('.menu-item:has-text("Not interested")');
    assert.equal(await page.locator(`.card[data-vid="${vid}"]`).count(), 0);
    assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:dislikes')))).includes(vid));
    await page.click('.toast-undo');
    await page.waitForSelector(`.card[data-vid="${vid}"]`);
    assert.ok(!(await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:dislikes')))).includes(vid));

    const second = page.locator('.card').nth(1);
    const channel = await second.getAttribute('data-channel');
    await second.hover();
    await second.locator('.more-btn').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.menu').count(), 0, 'Escape closes the menu');
    await second.hover();
    await second.locator('.more-btn').click();
    await page.click(`.menu-item:has-text("Hide ")`);
    assert.equal(await page.locator(`.card[data-channel="${channel.replace(/"/g, '\\"')}"]`).count(), 0);
    assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:prefs')).muteChannels)).includes(channel));
    await page.evaluate(() => localStorage.removeItem('customtube:prefs'));
  });

  test('lists: save from a card, reorder, remove, play all, delete with undo', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    const vids = await page.$$eval('.card', (els) => els.slice(0, 3).map((e) => e.dataset.vid));
    for (const [i, vid] of vids.entries()) {
      const c = page.locator(`.card[data-vid="${vid}"]`);
      await c.hover();
      await c.locator('.more-btn').click();
      await page.click('.menu-item:has-text("Save to list")');
      if (i === 0) {
        await page.fill('#new-list-name', 'E2E list');
        await page.press('#new-list-name', 'Enter');
      } else {
        await page.check('#dialog input[type="checkbox"]');
      }
      await page.click('#dialog button:has-text("Done")');
    }
    await page.click('nav.tabs a[href="/library"]');
    await page.click('.listcard');
    await page.waitForSelector('.list-row');
    const order = () => page.$$eval('.list-row .card', (els) => els.map((e) => e.dataset.vid));
    assert.deepEqual(await order(), vids);
    await page.click('.list-row >> nth=0 >> [aria-label^="Move"][aria-label$="down"]');
    await page.waitForFunction((v) => document.querySelector('.list-row .card')?.dataset.vid === v, vids[1]);
    assert.deepEqual(await order(), [vids[1], vids[0], vids[2]]);
    await page.click('.list-row >> nth=2 >> [aria-label$="from this list"]');
    await page.waitForFunction(() => document.querySelectorAll('.list-row').length === 2);
    await page.click('a.pill:has-text("Open on YouTube")');
    // the click handler fills in the playlist link before the (intercepted) navigation
    const href = await page.getAttribute('a.pill:has-text("Open on YouTube")', 'href');
    assert.equal(href, `https://www.youtube.com/watch_videos?video_ids=${vids[1]},${vids[0]}`);
    await page.click('#delete-list');
    await page.waitForURL('**/lists');
    await page.click('.toast-undo');
    await page.waitForSelector('.list-row');
    assert.equal(await page.locator('.list-row').count(), 2);
  });

  test('my videos: add a Short by URL, see it in Home, play it', async () => {
    // Allow every kind again so the feed is not empty with the strict test settings.
    await page.evaluate(() => localStorage.removeItem('customtube:prefs'));
    await page.goto(base + '/mine');
    await page.fill('#add-url', `https://www.youtube.com/shorts/${ADDED_VID}?feature=share`);
    const lookup = page.waitForResponse((r) => r.url().includes('/api/oembed'));
    await page.click('#add-video button[type="submit"]');
    assert.equal((await lookup).status(), 200);
    await page.waitForSelector(`.card[data-vid="${ADDED_VID}"]`);
    assert.match(await page.locator(`.card[data-vid="${ADDED_VID}"] .card-title`).textContent(), /My e2e Short/);

    await page.fill('#add-url', 'not a link');
    await page.click('#add-video button[type="submit"]');
    assert.match(await page.textContent('#add-status'), /doesn’t look like a YouTube link/);

    await page.click('nav.tabs a[href="/"]');
    await page.waitForSelector(`.card[data-vid="${ADDED_VID}"]`);
    await page.goto(base + '/library');
    await page.waitForSelector(`.shelf .card[data-vid="${ADDED_VID}"]`);
    await page.click('nav.tabs a[href="/"]');
    await page.waitForSelector(`.card[data-vid="${ADDED_VID}"]`);
    await page.locator(`.card[data-vid="${ADDED_VID}"] .card-link`).click();
    await page.waitForSelector('.player.short');
    await page.click('#poster');
    assert.match(await page.locator('.player iframe').getAttribute('src'), new RegExp(`/embed/${ADDED_VID}`));
  });

  test('saved settings the server does not know are left out of the request, kept, and reported', async () => {
    await page.evaluate(() =>
      localStorage.setItem('customtube:prefs', JSON.stringify({ types: ['talk', 'hologram'], followTopics: ['retired-topic'], muteTopics: ['another-retired-topic'] })),
    );
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.goto(base + '/');
    const res = await feed;
    assert.equal(res.status(), 200);
    const sent = res.request().postDataJSON();
    assert.deepEqual(sent.types, ['talk']);
    assert.equal(sent.follow_topics, undefined);
    assert.equal(sent.mute_topics, undefined);
    await page.waitForSelector('.card');
    await page.waitForSelector('#toast.on');
    assert.match(await page.textContent('#toast'), /3 saved settings not used/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:prefs')));
    assert.deepEqual(saved.types, ['talk', 'hologram']);
    assert.deepEqual(saved.followTopics, ['retired-topic']);
    assert.deepEqual(saved.muteTopics, ['another-retired-topic']);
    await page.evaluate(() => localStorage.removeItem('customtube:prefs'));
  });

  test('a video you added shows up in Watch later', async () => {
    await page.goto(base + '/mine');
    await page.waitForSelector(`.card[data-vid="${ADDED_VID}"]`);
    await page.locator(`.card[data-vid="${ADDED_VID}"] .later-btn`).click({ force: true });
    await page.click('nav.tabs a[href="/library"]');
    await page.click('.shelf-head a[href="/later"]');
    await page.waitForSelector(`.card[data-vid="${ADDED_VID}"]`);
    await page.locator(`.card[data-vid="${ADDED_VID}"] .later-btn`).click({ force: true });
  });

  test('export and import settings', async () => {
    await page.goto(base + '/settings');
    const download = page.waitForEvent('download');
    await page.click('#export-profile');
    const file = await (await download).path();
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.app, 'customtube');
    assert.ok(data.custom.some((c) => c.vid === ADDED_VID && c.short === true));
    assert.ok(data.likes.length >= 1);

    await page.evaluate(() => localStorage.clear());
    await page.setInputFiles('#import-file', file);
    await page.waitForSelector('text=Settings imported');
    const custom = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:custom')));
    assert.ok(custom.some((c) => c.vid === ADDED_VID));
  });

  test('keyboard shortcuts, watch later and history', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    const vid = await page.locator('.card.kbd').getAttribute('data-vid');
    await page.keyboard.press('w');
    await page.click('nav.tabs a[href="/library"]');
    await page.click('.shelf-head a[href="/later"]');
    await page.waitForSelector(`.card[data-vid="${vid}"]`);
    await page.click('nav.tabs a[href="/library"]');
    await page.click('.shelf-head a[href="/history"]');
    await page.waitForSelector('#clear-history');
    await page.click('#clear-history');
    await page.waitForSelector('text=Videos you open show up here.');
  });

  test('Back returns to the same Home cards at the same scroll position', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    await page.mouse.wheel(0, 2500);
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 24);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const n = await page.locator('.card').count();
    const target = page.locator('.card').nth(n - 3);
    await target.scrollIntoViewIfNeeded(); // where the click will happen
    await page.waitForLoadState('networkidle');
    const before = await page.evaluate(() => ({ y: Math.round(scrollY), n: document.querySelectorAll('.card').length, first: document.querySelector('.card').dataset.vid }));
    await target.locator('.card-link').click();
    await page.waitForSelector('.comment');
    await page.goBack();
    await page.waitForSelector('.card');
    const after = await page.evaluate(() => ({ y: Math.round(scrollY), n: document.querySelectorAll('.card').length, first: document.querySelector('.card').dataset.vid }));
    assert.equal(after.first, before.first);
    assert.ok(after.n >= before.n, `${after.n} cards after vs ${before.n} before`);
    assert.ok(Math.abs(after.y - before.y) < 5, `scroll ${after.y} vs ${before.y}`);
  });

  test('keyboard: j focuses a card; Enter elsewhere does not open it; focus moves into each new page', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('j');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'card-link');
    await page.focus('nav.tabs a[href="/topics"]');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/topics');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'view', 'focus moved to the new page');
  });

  test('dialogs: focus stays inside, shortcuts are off, Escape returns focus to the opener', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    const c = page.locator('.card').first();
    const vid = await c.getAttribute('data-vid');
    await c.hover();
    await c.locator('.more-btn').click();
    await page.click('.menu-item:has-text("Save to list")');
    assert.ok(await page.evaluate(() => document.querySelector('#dialog').open));
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.querySelector('#dialog').contains(document.activeElement)), 'focus trapped');
    const likesBefore = await page.evaluate(() => localStorage.getItem('customtube:likes'));
    await page.locator('#new-list-name').blur();
    await page.keyboard.press('l');
    assert.equal(await page.evaluate(() => localStorage.getItem('customtube:likes')), likesBefore, 'shortcut ignored while open');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.evaluate(() => document.querySelector('#dialog').open)));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.more), vid, 'focus back on the ⋯ button');
    await page.keyboard.press('?');
    assert.ok(await page.evaluate(() => document.querySelector('#help').open));
    await page.click('#help button:has-text("Close")');
  });

  test('undo of "Not interested" keeps an earlier dislike; a failed page offers Retry', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    const c = page.locator('.card').nth(2);
    const vid = await c.getAttribute('data-vid');
    await page.evaluate((v) => localStorage.setItem('customtube:dislikes', JSON.stringify([v])), vid);
    await page.goto(base + '/topics');
    await page.click('.quick a[href="/browse?sort=recent"]');
    await page.waitForSelector('.card');
    const d = page.locator('.card').first();
    const dv = await d.getAttribute('data-vid');
    await page.evaluate((v) => {
      const list = JSON.parse(localStorage.getItem('customtube:dislikes'));
      list.push(v);
      localStorage.setItem('customtube:dislikes', JSON.stringify(list));
    }, dv);
    await page.goto(base + '/browse?sort=recent');
    await page.waitForSelector(`.card[data-vid="${dv}"]`);
    const card = page.locator(`.card[data-vid="${dv}"]`);
    await card.hover();
    await card.locator('.more-btn').click();
    await page.click('.menu-item:has-text("Not interested")');
    await page.click('.toast-undo');
    const dislikes = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:dislikes')));
    const feedReq = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.goto(base + '/');
    assert.ok((await feedReq).request().postDataJSON().dislike.includes(dv), 'dislikes are sent with the feed request');
    assert.ok(dislikes.includes(dv) && dislikes.includes(vid), 'earlier dislikes survive Undo');
    await page.evaluate(() => localStorage.removeItem('customtube:dislikes'));
    await page.waitForTimeout(350); // the toast fades out
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#toast')).visibility), 'hidden');

    let fail = true;
    await page.route('**/api/feed', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }) : route.continue()));
    await page.goto(base + '/');
    await page.waitForSelector('button:has-text("Retry")');
    fail = false;
    await page.click('button:has-text("Retry")');
    await page.waitForSelector('.card');
    await page.unroute('**/api/feed');
    // the injected 500 is logged by the browser; it was expected here
    for (let i = errors.length - 1; i >= 0; i--) if (/status of 500 .*\/api\/feed$/.test(errors[i])) errors.splice(i, 1);
  });

  test('two tabs: a change in one reaches the other without a reload, and is not overwritten', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const [a, b] = await page.$$eval('.home .grid .card', (els) => els.slice(0, 2).map((e) => e.dataset.vid));
    await page.evaluate(() => {
      localStorage.setItem('customtube:likes', '[]');
      localStorage.setItem('customtube:later', '[]');
    });
    const other = await page.context().newPage();
    await other.goto(base + '/library'); // opened once, then never reloaded
    await other.waitForSelector('.shelf');
    // tab 1 likes a video: tab 2 hears about it through the storage event
    await page.locator(`.home .grid .card[data-vid="${a}"] .card-link`).first().click();
    await page.click('#like');
    await other.waitForFunction((v) => document.querySelector('.shelf') && JSON.parse(localStorage.getItem('customtube:likes')).includes(v), a);
    // tab 2 now saves something; its write must keep tab 1's like
    await other.evaluate((v) => {
      const btn = document.createElement('button');
      btn.dataset.later = v;
      document.body.append(btn);
      btn.click();
    }, b);
    const likes = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:likes')));
    assert.ok(likes.includes(a), 'the like from the first tab survives the second tab\'s write');
    assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:later')))).includes(b));
    await other.close();
  });

  test('malformed search links and double-clicked Add are handled', async () => {
    await page.goto(base + '/search/100%25%');
    await page.waitForSelector('text=That search link is malformed.');
    await page.goto(base + '/mine');
    await page.route('**/api/oembed*', async (route) => {
      await new Promise((r) => setTimeout(r, 300));
      await route.continue();
    });
    await page.fill('#add-url', 'https://youtu.be/dblClick001');
    await page.dblclick('#add-video button[type="submit"]');
    await page.waitForSelector('.card[data-vid="dblClick001"]');
    await page.unroute('**/api/oembed*');
    const custom = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:custom')));
    assert.equal(custom.filter((c) => c.vid === 'dblClick001').length, 1);
  });

  test('player: progress is saved, the card shows it, revisiting offers resume, and the next video autoplays', async () => {
    await page.evaluate(() => {
      localStorage.removeItem('customtube:progress');
      localStorage.removeItem('customtube:queue');
      localStorage.setItem('customtube:autoplay', 'true');
    });
    await page.goto(base + '/');
    await page.waitForSelector('.card');
    const vid = await page.locator('.home .grid .card').first().getAttribute('data-vid');
    await page.goto(`${base}/watch/${vid}`);
    await page.waitForSelector('.upnext .card');
    // autoplay picks from Up next, skipping videos already watched in this chain or opened before
    const upNext = await page.$$eval('.upnext .card', (els) => els.map((e) => e.dataset.vid));
    await page.click('#poster');
    const src = await page.locator('.player iframe').getAttribute('src');
    assert.match(src, /enablejsapi=1/);
    // the fake player ends the video after 400 ms: a countdown to the next video appears
    await page.waitForSelector('.countdown');
    const saved = await page.evaluate((v) => JSON.parse(localStorage.getItem('customtube:progress'))[v], vid);
    assert.equal(saved[0], 600, 'finished');
    await page.click('#play-next');
    await page.waitForURL((u) => u.searchParams.get('autoplay') === '1' && !u.pathname.endsWith(vid));
    assert.ok(upNext.includes(page.url().split('/watch/')[1].split('?')[0]), 'the next video comes from Up next');
    await page.waitForSelector('.player iframe'); // autoplay: no poster click needed

    // a half-watched video offers to resume, and starts there
    await page.evaluate((v) => localStorage.setItem('customtube:progress', JSON.stringify({ [v]: [125, 600, Date.now()] })), vid);
    await page.goto(`${base}/watch/${vid}`);
    assert.match(await page.textContent('.resume-note'), /Resume at 2:05/);
    await page.click('#poster');
    assert.match(await page.locator('.player iframe').getAttribute('src'), /start=125/);
    await page.click('#cancel-next', { timeout: 5000 });
    assert.equal(await page.locator('.countdown').count(), 0, 'cancel removes the countdown');

    // and it shows on Home under Continue watching, with a progress bar
    await page.evaluate((v) => localStorage.setItem('customtube:progress', JSON.stringify({ [v]: [125, 600, Date.now()] })), vid);
    await page.goto(base + '/');
    await page.waitForSelector(`.row-scroll .card[data-vid="${vid}"] .progress`);
  });

  test('lists play in order inside the app', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const vids = await page.$$eval('.home .grid .card', (els) => els.slice(0, 3).map((e) => e.dataset.vid));
    await page.evaluate((ids) => localStorage.setItem('customtube:lists', JSON.stringify([{ id: 'qqqq1111', name: 'Queue test', vids: ids, created: new Date().toISOString() }])), vids);
    await page.goto(base + '/list/qqqq1111');
    await page.click('#play-list');
    await page.waitForURL(`**/watch/${vids[0]}?autoplay=1`);
    await page.waitForSelector('.queue-head');
    assert.match(await page.textContent('.queue-head'), /Queue test.*1 of 3/s);
    await page.waitForSelector('.countdown');
    assert.match(await page.textContent('.countdown h3'), /\S/);
    await page.click('#play-next');
    await page.waitForURL(`**/watch/${vids[1]}?autoplay=1`);
    await page.waitForSelector('.queue-head');
    assert.match(await page.textContent('.queue-head'), /2 of 3/);
    await page.click('.queue-head button');
    await page.waitForFunction(() => !document.querySelector('.queue-head'));
  });

  test('quick search: Ctrl+K, suggestions as you type, Enter opens', async () => {
    await page.goto(base + '/topics');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette[open]');
    const suggested = page.waitForResponse((r) => r.url().includes('/api/suggest') && r.url().includes(REAL ? 'distri' : 'physi'));
    await page.keyboard.type(REAL ? 'distri' : 'physi');
    await suggested;
    await page.waitForSelector('.palette-item img');
    assert.ok((await page.locator('.palette-group:has-text("Videos")').count()) === 1);
    await page.keyboard.press('ArrowDown'); // from "Search for …" to the first video
    await page.keyboard.press('Enter');
    await page.waitForURL('**/watch/**');
    await page.keyboard.press('Control+k');
    const libr = page.waitForResponse((r) => r.url().includes('/api/suggest?q=libr'));
    await page.keyboard.type('libr');
    await libr;
    // the "Library" page command, not a video whose title mentions a library
    const command = page.locator('.palette-item:not(:has(img))').filter({ has: page.locator('.label', { hasText: /^Library$/ }) });
    await command.click();
    await page.waitForURL('**/library');
  });

  test('first visit: pick topics, build the feed, and see them under Following', async () => {
    await page.evaluate(() => localStorage.clear());
    await page.goto(base + '/');
    await page.waitForSelector('.welcome');
    const chips = page.locator('.welcome .chip[data-topic]');
    const ids = [await chips.nth(0).getAttribute('data-topic'), await chips.nth(1).getAttribute('data-topic')];
    await chips.nth(0).click();
    await chips.nth(1).click();
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('#welcome-done');
    const sent = (await feed).request().postDataJSON();
    assert.deepEqual(sent.follow_topics, ids);
    assert.equal(await page.locator('.welcome').count(), 0);
    const following = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('.home-tabs a:has-text("Following")');
    const fsent = (await following).request().postDataJSON();
    assert.equal(fsent.mix.following, 5);
    assert.equal(fsent.mix.classics, 0);
    const body = await (await following).json();
    assert.ok(body.items.length > 0 && body.items.every((x) => x.source === 'following'));
    assert.equal(await page.locator('.side-extra a[href^="/c/"]').count(), 2, 'followed topics in the sidebar');
  });

  test('share copies the link', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const vid = await page.locator('.home .grid .card').first().getAttribute('data-vid');
    await page.goto(`${base}/watch/${vid}`);
    await page.click('#share');
    await page.waitForSelector('#toast.on');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/watch/${vid}`);
  });

  test('installable: the service worker serves the app shell offline', async () => {
    const ctx = await browser.newContext();
    await ctx.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.fulfill({ status: 204, body: '' })));
    const p = await ctx.newPage();
    await p.goto(base + '/');
    await p.evaluate(() => navigator.serviceWorker.ready);
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, 'Custom Tube');
    await ctx.setOffline(true);
    await p.goto(base + '/library');
    await p.waitForSelector('nav.tabs a[href="/library"].on');
    assert.match(await p.title(), /Custom Tube/);
    await ctx.close();
  });

  test('round 9: autoplay never ping-pongs, Stop list keeps the player, Following shows videos, Play all stays in the app, quick search drops stale replies', async () => {
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('customtube:welcomed', 'true');
      sessionStorage.clear();
    });
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const start = await page.locator('.home .grid .card').first().getAttribute('data-vid');
    await page.goto(`${base}/watch/${start}?autoplay=1`);
    const visited = [start];
    for (let hop = 0; hop < 5; hop++) {
      await page.waitForSelector('.countdown');
      await page.click('#play-next');
      await page.waitForURL(/autoplay=1/);
      await page.waitForFunction((prev) => !location.pathname.endsWith(prev), visited[visited.length - 1]);
      visited.push(page.url().split('/watch/')[1].split('?')[0]);
    }
    assert.equal(new Set(visited).size, visited.length, `autoplay revisited a video: ${visited.join(' > ')}`);

    // a list: Stop keeps the same player element
    await page.evaluate((ids) => localStorage.setItem('customtube:lists', JSON.stringify([{ id: 'stop1111', name: 'Stop test', vids: ids, created: new Date().toISOString() }])), visited.slice(0, 3));
    await page.goto(base + '/list/stop1111');
    await page.click('#play-list');
    await page.waitForSelector('.queue-head');
    await page.waitForSelector('.player iframe');
    await page.evaluate(() => (document.querySelector('.player iframe').dataset.mark = 'same'));
    await page.click('#stop-list');
    await page.waitForFunction(() => !document.querySelector('.queue-head'));
    assert.equal(await page.evaluate(() => document.querySelector('.player iframe')?.dataset.mark), 'same');

    // Following with no follows: pick, then Show videos
    await page.goto(base + '/?tab=following');
    await page.waitForSelector('#show-following');
    await page.locator('.welcome .chip[data-topic]').first().click();
    const feed = page.waitForResponse((r) => r.url().includes('/api/feed'));
    await page.click('#show-following');
    assert.equal((await feed).request().postDataJSON().mix.following, 5);
    await page.waitForSelector('.home .grid .card');

    // Play all on Home plays in the app
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const first = await page.locator('.home .grid .card').first().getAttribute('data-vid');
    await page.click('#play-feed');
    await page.waitForURL(`**/watch/${first}?autoplay=1`);
    await page.waitForSelector('.queue-head');

    // quick search: a slow reply for an old query never replaces the current list
    await page.route('**/api/suggest?q=rust*', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    await page.keyboard.press('Control+k');
    await page.keyboard.type('rust');
    await page.waitForTimeout(150);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(900);
    const labels = await page.locator('.palette-item .label').allTextContents();
    assert.ok(!labels.some((l) => /rust/i.test(l)), labels.join(' | '));
    await page.keyboard.press('Escape');
    await page.unroute('**/api/suggest?q=rust*');
  });

  test('round 11: a second click closes a menu; a reply that lands just after the next keystroke is dropped', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('.home .grid .card');
    const c = page.locator('.home .grid .card').first();
    await c.hover();
    await c.locator('.more-btn').click();
    assert.equal(await page.locator('.menu').count(), 1);
    await c.locator('.more-btn').click();
    assert.equal(await page.locator('.menu').count(), 0, 'second click closes it');

    await page.route('**/api/suggest?q=lin', async (route) => {
      await new Promise((r) => setTimeout(r, 150));
      await route.continue();
    });
    await page.keyboard.press('Control+k');
    await page.keyboard.type('lin');
    await page.waitForTimeout(200);
    await page.keyboard.type('u');
    await page.waitForTimeout(400);
    assert.ok(!(await page.locator('.palette-item .label').allTextContents()).includes('Search for “lin”'));
    await page.keyboard.press('Escape');
    await page.unroute('**/api/suggest?q=lin');
  });

  test('live: follow a YouTube channel in Customize, its new uploads join Home, follow state on the watch page', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/settings#live');
    assert.ok(!(await page.isDisabled('#live-topic-input')), 'following a search needs no key');
    await page.fill('#live-topic-input', 'e2e search');
    await page.click('#live-topic-form button[type=submit]');
    await page.waitForSelector('#live .chip.removable:has-text("e2e search")');
    await page.fill('#live-channel-input', 'https://www.youtube.com/@e2echannel');
    const resolved = page.waitForResponse((r) => r.url().includes('/api/live/resolve'));
    await page.click('#live-channel-form button[type=submit]');
    assert.equal((await resolved).status(), 200);
    await page.waitForSelector('#live .chip.removable');
    assert.match(await page.locator('#live .chip.removable').first().textContent(), /E2E Channel/);

    const live = page.waitForResponse((r) => r.url().includes('/api/live?channels=UCe2ee2ee2ee2ee2ee2ee2ee'));
    await page.goto(base + '/');
    assert.equal((await live).status(), 200);
    const card = page.locator('.card[data-vid="liveE2Evid1"]');
    await card.waitFor();
    assert.match(await card.textContent(), /New from E2E Channel/);
    assert.match(await card.textContent(), /1K views · today/);
    assert.equal(await page.locator('#refresh-live').count(), 1);
    // the followed search brings this month's videos from all of YouTube in a shelf of their own
    const found = page.locator('.shelf', { has: page.locator('h2:has-text("Fresh on YouTube in your topics")') });
    await found.locator('.card-title:has-text("e2e search on YouTube, part 1.0")').waitFor();

    await card.locator('.card-link').click();
    await page.waitForURL('**/watch/liveE2Evid1');
    assert.match(await page.locator('.owner').textContent(), /new on YouTube/);
    assert.equal((await page.textContent('#follow-channel')).trim(), 'Following');
    await page.click('#follow-channel');
    assert.equal((await page.textContent('#follow-channel')).trim(), 'Follow');
    // the live video stays openable from history after unfollowing
    await page.goto(base + '/history');
    await page.locator('.card[data-vid="liveE2Evid1"]').waitFor();
    await page.goto(base + '/settings#live');
    await page.click('#live .chip.removable:has-text("e2e search")');
    await page.waitForSelector('#live .chip.removable:has-text("e2e search")', { state: 'detached' });
    assert.equal(await page.locator('#live .chip.removable').count(), 0);
  });

  test('channels: a channel page follows it, its Shorts get a Home shelf and play in the Shorts player', async () => {
    await page.goto(base + '/channels');
    await page.locator('#hn-channels .channel-card').first().waitFor();
    assert.ok((await page.locator('#hn-channels .channel-card').count()) > 0);

    await page.goto(base + '/channel/UCe2ee2ee2ee2ee2ee2ee2ee');
    assert.equal(await page.textContent('.channel-head h1'), 'E2E Channel');
    assert.equal(await page.locator('.channel-page .short-card[data-vid="liveE2Eshrt"]').count(), 1);
    assert.equal(await page.locator('.channel-page .card[data-vid="liveE2Evid1"]').count(), 1);
    assert.equal((await page.textContent('#follow-channel')).trim(), 'Follow');
    await page.click('#follow-channel');
    assert.equal((await page.textContent('#follow-channel')).trim(), 'Following');
    // the "You" panel lists it under Subscriptions, and closes again on navigation
    await page.click('#you');
    // while it's open, page shortcuts are off: j must not select a card behind it
    await page.keyboard.press('j');
    assert.equal(await page.locator('.card.kbd').count(), 0, 'j selected a card behind the open panel');
    await page.locator('#side-extra a[href="/channel/UCe2ee2ee2ee2ee2ee2ee2ee"]').waitFor();
    await page.click('#side-extra a[href="/channel/UCe2ee2ee2ee2ee2ee2ee2ee"]');
    await page.waitForFunction(() => !document.querySelector('#side-extra').matches(':popover-open'));

    await page.goto(base + '/');
    const short = page.locator('.live-shelves .short-card[data-vid="liveE2Eshrt"]');
    await short.waitFor();
    await short.click();
    await page.waitForURL('**/shorts?v=liveE2Eshrt');
    await page.waitForSelector('.short-frame iframe');
    assert.match(await page.getAttribute('.short-frame iframe', 'src'), /\/embed\/liveE2Eshrt\?/);
    assert.equal(await page.locator('.short-frame iframe').count(), 1, 'only the Short in view plays');
    assert.ok(await page.evaluate(() => document.body.classList.contains('shorts-mode')));
    // leave in the app (no reload): the player, observer and shorts mode must all go
    await page.click('nav.tabs a[href="/library"]');
    await page.waitForURL('**/library');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('shorts-mode'))), 'leaving Shorts restores the page');
    assert.equal(await page.locator('.short-frame iframe').count(), 0);
  });

  test('small screens have no horizontal scroll; no console errors anywhere', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const p of ['/', '/settings', '/topics', '/about', '/channels', '/shorts', '/channel/UCe2ee2ee2ee2ee2ee2ee2ee', '/library', 'first video']) {
      if (p === 'first video') {
        // a watch page: its one-row action strip must scroll inside itself, not widen the page
        await page.goto(base + '/');
        await page.goto(base + (await page.locator('.card-link').first().getAttribute('href')));
        await page.waitForSelector('.owner .actions');
      } else {
        await page.goto(base + p);
      }
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${p} overflows by ${overflow}px`);
    }
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });
});
