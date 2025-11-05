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
import { createEmbedder } from '../../src/embedder.js';
import { createRateLimiter } from '../../src/ratelimit.js';
import { fakeEmbedder, makeFixture } from '../helpers/fixture.js';

const cfg = readConfig({ ...process.env, CUSTOMTUBE_YOUTUBE_META: process.env.CUSTOMTUBE_YOUTUBE_META || '/nonexistent' });
const REAL = existsSync(path.join(cfg.dataDir, 'videos.jsonl'));
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ADDED_VID = 'e2eShort001';

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
    ({ server } = createApp({
      ds,
      embedder,
      fetchImpl,
      log: { info() {}, error: console.error },
      searchLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
    }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === base) return route.continue();
      if (url.hostname === 'i.ytimg.com') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      return route.fulfill({ status: 204, body: '' }); // YouTube embeds and anything else
    });
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
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

  test('semantic search finds a topic and filters apply', async () => {
    const q = REAL ? 'distributed systems' : 'physics';
    await page.fill('#q', q);
    const res = page.waitForResponse((r) => r.url().includes('/api/search'));
    await page.press('#q', 'Enter');
    const body = await (await res).json();
    assert.equal(body.mode, 'semantic');
    assert.equal(body.weak, false);
    await page.waitForSelector('.grid .card');
    const titles = (await page.locator('.card-title').allTextContents()).slice(0, 5).join(' | ');
    assert.match(titles, REAL ? /distributed/i : /physics/i);

    const filtered = page.waitForResponse((r) => r.url().includes('/api/search') && r.url().includes('type=lecture'));
    await page.selectOption('select[data-filter="type"]', 'lecture');
    const fb = await (await filtered).json();
    assert.ok(fb.items.every((x) => x.content_type === 'lecture'));
    assert.match(page.url(), /type=lecture/);
  });

  test('customize: kinds, mix and muted topics change the feed request', async () => {
    await page.click('nav.tabs a[href="/settings"]');
    await page.waitForSelector('text=Customize your feed');
    await page.check('input[data-type="talk"]');
    await page.check('input[data-type="lecture"]');
    await page.locator('#mix-explore').fill('0');
    await page.locator('#mix-explore').dispatchEvent('change');
    const mute = page.locator('#mute-topic-select');
    const topic = await mute.locator('option').nth(1).getAttribute('value');
    await mute.selectOption(topic);
    await page.waitForSelector('.chip.removable');

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
    await page.waitForSelector('#mute-channel');
    const channel = await page.locator('.owner b').first().textContent();
    await page.click('#mute-channel');
    assert.equal(await page.textContent('#mute-channel'), 'Channel hidden');

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
    await page.click('.playall, a.pill:has-text("Play all")');
    // the click handler fills in the playlist link before the (intercepted) navigation
    const href = await page.getAttribute('a.pill:has-text("Play all")', 'href');
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
      localStorage.setItem('customtube:prefs', JSON.stringify({ types: ['talk', 'hologram'], followTopics: ['retired-topic'], muteTopics: ['retired-topic'] })),
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
    // "hologram" and the followed retired topic; the muted copy was already dropped as a follow/mute clash
    assert.match(await page.textContent('#toast'), /2 saved settings not used/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('customtube:prefs')));
    assert.deepEqual(saved.types, ['talk', 'hologram']);
    assert.deepEqual(saved.followTopics, ['retired-topic']);
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

  test('small screens have no horizontal scroll; no console errors anywhere', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const p of ['/', '/settings', '/topics', '/about']) {
      await page.goto(base + p);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${p} overflows by ${overflow}px`);
    }
    assert.deepEqual(errors, []);
  });
});
