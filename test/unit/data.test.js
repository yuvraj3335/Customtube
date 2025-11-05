import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDataset, monthIndex, normalizeTitle, parseIsoDuration, searchable } from '../../src/data.js';
import { dotRowVec } from '../../src/vec.js';
import { DIM, DUP_VID, makeFixture, vidOf } from '../helpers/fixture.js';

test('loads the export, sorted best first, with embeddings matched by id', (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const ds = loadDataset({ dataDir: fx.dataDir });
  assert.equal(ds.videos.length, 61);
  assert.equal(ds.dim, DIM);
  for (let i = 1; i < ds.videos.length; i++) assert.ok(ds.videos[i - 1].score >= ds.videos[i].score);
  // The fixture writes embedding rows in reverse; each video must still get its own vector.
  for (const v of ds.videos) {
    const expected = fx.vectors.get(v.vid);
    const sim = dotRowVec(ds.emb, ds.dim, v.i, Float32Array.from(expected));
    assert.ok(sim > 0.99, `${v.vid} got the wrong embedding row (sim ${sim})`);
  }
  assert.equal(ds.stats.mentions, 120);
  assert.equal(ds.maxMonth, '2026-06');
  assert.equal(ds.hasMeta, false);
});

test('marks a re-upload as a duplicate of the better-scored video and hides it', (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const ds = loadDataset({ dataDir: fx.dataDir });
  const dup = ds.byVid.get(DUP_VID);
  assert.equal(dup.dupOf, vidOf(0, 0));
  assert.equal(dup.visible, false);
  assert.equal(ds.byVid.get(vidOf(0, 0)).visible, true);
  assert.equal(ds.stats.duplicates, 1);
  assert.equal(ds.stats.videos, 60);
});

test('derives last recommendation month, sorted mentions and topic counts', (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const ds = loadDataset({ dataDir: fx.dataDir });
  const v = ds.byVid.get(vidOf(0, 1));
  assert.equal(v.lastRecMonth, '2026-06');
  assert.equal(ds.byVid.get(vidOf(0, 5)).lastRecMonth, '2020-03');
  // strong_rec sorts before rec
  assert.deepEqual(ds.mentionsByVid.get(v.vid).map((m) => m.stance), ['strong_rec', 'rec']);
  const fp = ds.categoryById.get('functional-programming');
  assert.equal(fp.count, 11); // its 10 videos plus c3v0's second topic; the duplicate is not counted
  assert.equal(ds.areaById.get('software').count, 33); // 30 + the three science i=0 videos that also carry a software topic
});

test('a deleted upload does not hide its public re-upload', (t) => {
  const fx = makeFixture({ withMeta: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  writeFileSync(fx.metaFile, `${JSON.stringify({ vid: vidOf(0, 0), item: null })}\n`, { flag: 'a' });
  const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
  assert.equal(ds.byVid.get(vidOf(0, 0)).visible, false);
  assert.equal(ds.byVid.get(DUP_VID).dupOf, null);
  assert.equal(ds.byVid.get(DUP_VID).visible, true);
});

test('a playable re-upload beats a better-scored upload that cannot be embedded', (t) => {
  const fx = makeFixture({ withMeta: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const row = JSON.parse(readFileSync(fx.metaFile, 'utf8').split('\n')[0]);
  row.item.status.embeddable = false;
  writeFileSync(fx.metaFile, `${JSON.stringify(row)}\n`, { flag: 'a' });
  const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
  assert.equal(row.vid, vidOf(0, 0));
  assert.equal(ds.byVid.get(vidOf(0, 0)).dupOf, DUP_VID);
  assert.equal(ds.byVid.get(DUP_VID).visible, true);
});

test('reads YouTube metadata and hides deleted videos', (t) => {
  const fx = makeFixture({ withMeta: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  writeFileSync(fx.metaFile, `${JSON.stringify({ vid: vidOf(1, 1), item: null })}\n`, { flag: 'a' });
  const ds = loadDataset({ dataDir: fx.dataDir, metaFile: fx.metaFile });
  assert.equal(ds.hasMeta, true);
  const v = ds.byVid.get(vidOf(0, 3));
  assert.deepEqual(v.yt, { gone: false, embeddable: true, duration_s: 4000, views: 120000, likes: 1200, published: '2013-05-01T00:00:00Z' });
  // The last line for a vid wins: c1v1 is now gone.
  assert.equal(ds.byVid.get(vidOf(1, 1)).visible, false);
});

test('fails clearly when the export is missing or malformed', (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  assert.throws(() => loadDataset({ dataDir: path.join(fx.dir, 'nope') }), /npm run data:fetch/);
  writeFileSync(path.join(fx.dataDir, 'videos.jsonl'), '{"vid":"ok"}\n{broken\n');
  assert.throws(() => loadDataset({ dataDir: fx.dataDir }), /videos\.jsonl line 1: invalid vid|videos\.jsonl line 2/);
  writeFileSync(path.join(fx.dataDir, 'videos.jsonl'), '{broken\n');
  assert.throws(() => loadDataset({ dataDir: fx.dataDir }), /videos\.jsonl line 1/);
});

test('text helpers', () => {
  assert.equal(normalizeTitle('"Simple Made Easy" - Rich Hickey (2011)'), 'simple made easy rich hickey 2011');
  assert.equal(searchable('Café, Ünïcode & C++'), ' cafe unicode c ');
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('PT'), null);
  assert.equal(parseIsoDuration('garbage'), null);
  assert.equal(monthIndex('2026-01') - monthIndex('2025-12'), 1);
  assert.equal(monthIndex('2026'), null);
});
