// A small synthetic export in the same format as the real data export, so tests run without
// the real 50 MB download and can assert exact behaviour.
//
// 6 topics in 2 areas, 10 videos per topic. Each topic has its own direction in an 8-d
// embedding space, so "similar" is predictable. Per topic, video i has:
//   score 20 - 2i, recommenders 0 for i = 9 (cited only), shelf_life "news" for i = 8,
//   a recent recommendation for i < 3, a duration that cycles short/standard/long.
// One extra video re-uploads c0v0 under another channel (a duplicate).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeNpyMatrix } from '../../src/npy.js';
import { mulberry32 } from '../../src/rng.js';

export const DIM = 8;
export const AREAS = [
  { id: 'software', name: 'Software', cats: ['functional-programming', 'databases', 'distributed-systems'] },
  { id: 'science', name: 'Science', cats: ['physics', 'biology', 'mathematics'] },
];
export const CATS = AREAS.flatMap((a) => a.cats.map((id) => ({ id, area: a.id, area_name: a.name, name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) })));
const TYPES = ['talk', 'lecture', 'explainer', 'demo'];
const DURATIONS = [60, 600, 1800, 4000]; // short, standard, standard, long

export const vidOf = (k, i) => `c${k}v${i}`.padEnd(11, '_');
export const DUP_VID = 'dupOfc0v0__';

function vector(k, rng, noise = 0.15) {
  const v = Array.from({ length: DIM }, () => (rng() - 0.5) * 2 * noise);
  v[k] += 1;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Write the fixture export to a new temp dir. Returns paths and the generated rows. */
export function makeFixture({ withMeta = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'customtube-fixture-'));
  const dataDir = path.join(dir, 'export');
  mkdirSync(dataDir);
  const rng = mulberry32(42);
  const videos = [];
  const vectors = new Map();
  const mentions = [];
  const related = [];
  const meta = [];

  CATS.forEach((cat, k) => {
    for (let i = 0; i < 10; i++) {
      const vid = vidOf(k, i);
      const recs = i === 9 ? 0 : 6 - Math.floor(i / 2);
      const other = CATS[(k + 3) % CATS.length];
      videos.push({
        vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title: `${cat.name} talk number ${i}`,
        channel: `Channel ${k}-${i % 3}`,
        summary: `A ${TYPES[i % 4]} about ${cat.name.toLowerCase()}, part ${i}.`,
        why_hn: `HN likes it for ${cat.name.toLowerCase()}.`,
        content_type: TYPES[i % 4],
        level: 'general',
        shelf_life: i === 8 ? 'news' : 'evergreen',
        primary_topic: cat.name.toLowerCase(),
        tags: [cat.id, `tag${i}`],
        categories: [
          { id: cat.id, name: cat.name, area: cat.area, area_name: cat.area_name },
          ...(i === 0 ? [{ id: other.id, name: other.name, area: other.area, area_name: other.area_name }] : []),
        ],
        quote: { text: 'worth watching', hn_comment_id: k * 100 + i, year: '2020' },
        hn: { mentions: 2, recommenders: recs, rec_months: Math.max(recs, 0), strong_recs: 0, stances: {}, first_year: 2015, last_year: i < 3 ? 2026 : 2020 },
        score: 20 - 2 * i + k * 0.01,
      });
      vectors.set(vid, vector(k, rng));
      mentions.push(
        { hn_comment_id: k * 1000 + i * 2, hn_url: `https://news.ycombinator.com/item?id=${k * 1000 + i * 2}`, vid, author: `user${k}${i}`, month: i < 3 ? '2026-06' : '2020-03', story_title: `Story about ${cat.name}`, stance: recs ? 'rec' : 'reference', why: 'good intro', quote: '', text: `Watch this [VIDEO] and also [LINK] <b>not bold</b>` },
        { hn_comment_id: k * 1000 + i * 2 + 1, hn_url: `https://news.ycombinator.com/item?id=${k * 1000 + i * 2 + 1}`, vid, author: `other${k}${i}`, month: '2018-01', story_title: 'Another story', stance: 'strong_rec', why: '', quote: '', text: 'Great.' },
      );
      related.push({
        vid,
        related: [
          ...(i < 9 ? [{ vid: vidOf(k, i + 1), shared_recommenders: 3 }] : []),
          { vid: vidOf((k + 1) % CATS.length, i), shared_recommenders: 1 },
        ],
      });
      meta.push({
        vid,
        item: {
          id: vid,
          snippet: { publishedAt: `${2010 + i}-05-01T00:00:00Z` },
          contentDetails: { duration: `PT${Math.floor(DURATIONS[i % 4] / 60)}M${DURATIONS[i % 4] % 60}S` },
          statistics: { viewCount: String((i + 1) * 30_000), likeCount: String((i + 1) * 300) },
          status: { embeddable: true, privacyStatus: 'public' },
        },
      });
    }
  });

  // A re-upload of c0v0 on another channel with the same title and vector.
  const original = videos[0];
  videos.push({ ...original, vid: DUP_VID, url: `https://www.youtube.com/watch?v=${DUP_VID}`, channel: 'Reuploads Inc', score: 1 });
  vectors.set(DUP_VID, vectors.get(original.vid));
  meta.push({ ...meta[0], vid: DUP_VID });

  const taxonomy = {
    version: 'test',
    areas: AREAS.map((a) => ({ id: a.id, name: a.name, categories: a.cats.map((id) => ({ id, name: CATS.find((c) => c.id === id).name, description: `All about ${id.replace(/-/g, ' ')}` })) })),
  };

  // Embedding rows in reverse order, to prove the loader re-orders them by id.
  const ids = [...vectors.keys()].reverse();
  const flat = ids.flatMap((vid) => vectors.get(vid));
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path.join(dataDir, 'videos.jsonl'), jsonl(videos));
  writeFileSync(path.join(dataDir, 'mentions.jsonl'), jsonl(mentions));
  writeFileSync(path.join(dataDir, 'related.jsonl'), jsonl(related));
  writeFileSync(path.join(dataDir, 'taxonomy.json'), JSON.stringify(taxonomy));
  writeFileSync(path.join(dataDir, 'embeddings.npy'), writeNpyMatrix(ids.length, DIM, flat, '<f2'));
  writeFileSync(path.join(dataDir, 'embedding_ids.json'), JSON.stringify(ids));
  const metaFile = path.join(dir, 'youtube_meta.jsonl');
  if (withMeta) writeFileSync(metaFile, jsonl(meta));
  return { dir, dataDir, metaFile: withMeta ? metaFile : null, vectors, videos };
}

/** An embedder stand-in: maps a query to the topic whose name it mentions, else a fixed off-topic vector. */
export function fakeEmbedder({ status = 'ready' } = {}) {
  return {
    status: () => status,
    async embed(text) {
      if (status !== 'ready') return null;
      const k = CATS.findIndex((c) => text.toLowerCase().includes(c.name.toLowerCase()) || text.toLowerCase().includes(c.id));
      const v = new Float32Array(DIM);
      if (k >= 0) v[k] = 1;
      else v.fill(1 / Math.sqrt(DIM)); // equally far from every topic: a weak match
      return v;
    },
  };
}
