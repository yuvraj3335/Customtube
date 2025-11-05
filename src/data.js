// Loads the HackerTube data export (plus optional YouTube metadata) into memory and derives
// everything the API needs: indexes, per-video HN stats, duplicate groups, topic centroids
// and normalized search text. The whole dataset is small (6,454 videos), so it lives in RAM.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readNpyMatrix } from './npy.js';
import { dotRows, normalizeInPlace } from './vec.js';

export const REC_STANCES = new Set(['rec', 'strong_rec']);
const STANCE_ORDER = { strong_rec: 0, rec: 1, reference: 2, critical: 3, joke: 4 };
const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const REQUIRED_FILES = [
  'videos.jsonl',
  'mentions.jsonl',
  'related.jsonl',
  'taxonomy.json',
  'embeddings.npy',
  'embedding_ids.json',
];

// Two uploads count as one talk when their normalized titles match and they are either on
// the same channel or almost the same embedding (a re-upload by someone else).
const DUPLICATE_SIMILARITY = 0.95;

function readJsonl(file) {
  const out = [];
  let lineNo = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(file)} line ${lineNo}: ${err.message}`);
    }
  }
  return out;
}

export function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Lowercase text with every run of non-letters/digits turned into one space, padded with spaces. */
export function searchable(text) {
  return ` ${String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") to seconds, or null if it doesn't parse. */
export function parseIsoDuration(value) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || '');
  if (!m || value === 'P' || value === 'PT') return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

export function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

function loadYoutubeMeta(file) {
  const meta = new Map();
  for (const row of readJsonl(file)) {
    if (!row || !VID_RE.test(row.vid)) continue;
    const it = row.item;
    if (!it) {
      meta.set(row.vid, { gone: true });
      continue;
    }
    const views = Number(it.statistics?.viewCount);
    const likes = Number(it.statistics?.likeCount);
    meta.set(row.vid, {
      gone: it.status?.privacyStatus === 'private',
      embeddable: it.status?.embeddable !== false,
      duration_s: parseIsoDuration(it.contentDetails?.duration),
      views: Number.isFinite(views) ? views : null,
      likes: Number.isFinite(likes) ? likes : null,
      published: typeof it.snippet?.publishedAt === 'string' ? it.snippet.publishedAt : null,
    });
  }
  return meta;
}

/**
 * @param {{ dataDir: string, metaFile?: string|null }} options
 */
export function loadDataset({ dataDir, metaFile = null }) {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(path.join(dataDir, f)));
  if (missing.length) {
    throw new Error(
      `Data export not found in ${dataDir} (missing ${missing.join(', ')}). ` +
        'Download it with `npm run data:fetch`, or set CUSTOMTUBE_DATA_DIR.',
    );
  }
  const file = (name) => path.join(dataDir, name);

  // ---- videos ----
  const videos = readJsonl(file('videos.jsonl'));
  const byVid = new Map();
  for (const v of videos) {
    if (!VID_RE.test(v.vid)) throw new Error(`videos.jsonl: invalid vid ${JSON.stringify(v.vid)}`);
    if (byVid.has(v.vid)) throw new Error(`videos.jsonl: duplicate vid ${v.vid}`);
    byVid.set(v.vid, v);
  }
  videos.sort((a, b) => b.score - a.score || a.vid.localeCompare(b.vid));
  videos.forEach((v, i) => {
    v.i = i;
    v.dupOf = null;
    v.categories = Array.isArray(v.categories) ? v.categories : [];
    v.tags = Array.isArray(v.tags) ? v.tags : [];
  });

  // ---- mentions ----
  const mentionsByVid = new Map();
  let mentionCount = 0;
  const recommenders = new Set();
  let maxMonth = null;
  for (const m of readJsonl(file('mentions.jsonl'))) {
    const v = byVid.get(m.vid);
    if (!v) continue;
    mentionCount++;
    if (!mentionsByVid.has(m.vid)) mentionsByVid.set(m.vid, []);
    mentionsByVid.get(m.vid).push(m);
    if (REC_STANCES.has(m.stance)) {
      recommenders.add(m.author);
      if (!v.lastRecMonth || m.month > v.lastRecMonth) v.lastRecMonth = m.month;
    }
    if (!v.lastMonth || m.month > v.lastMonth) v.lastMonth = m.month;
    if (!maxMonth || m.month > maxMonth) maxMonth = m.month;
  }
  for (const list of mentionsByVid.values()) {
    list.sort(
      (a, b) =>
        (STANCE_ORDER[a.stance] ?? 9) - (STANCE_ORDER[b.stance] ?? 9) ||
        b.month.localeCompare(a.month) ||
        a.hn_comment_id - b.hn_comment_id,
    );
  }

  // ---- related (co-recommended) ----
  const related = new Map();
  for (const r of readJsonl(file('related.jsonl'))) {
    if (!byVid.has(r.vid) || !Array.isArray(r.related)) continue;
    related.set(
      r.vid,
      r.related
        .filter((x) => byVid.has(x.vid) && x.vid !== r.vid)
        .map((x) => ({ vid: x.vid, shared: Number(x.shared_recommenders) || 0 })),
    );
  }

  // ---- embeddings, re-ordered to match `videos` ----
  const matrix = readNpyMatrix(readFileSync(file('embeddings.npy')));
  const ids = JSON.parse(readFileSync(file('embedding_ids.json'), 'utf8'));
  if (!Array.isArray(ids) || ids.length !== matrix.rows) {
    throw new Error(`embedding_ids.json has ${ids?.length} ids but embeddings.npy has ${matrix.rows} rows`);
  }
  const dim = matrix.cols;
  const emb = new Float32Array(videos.length * dim);
  const hasEmbedding = new Uint8Array(videos.length);
  ids.forEach((vid, row) => {
    const v = byVid.get(vid);
    if (!v) return;
    emb.set(matrix.data.subarray(row * dim, row * dim + dim), v.i * dim);
    normalizeInPlace(emb, v.i * dim, dim);
    hasEmbedding[v.i] = 1;
  });
  const withoutEmbedding = videos.filter((v) => !hasEmbedding[v.i]).length;

  // ---- optional YouTube metadata ----
  const meta = metaFile && existsSync(metaFile) ? loadYoutubeMeta(metaFile) : null;

  // ---- derived per-video fields ----
  for (const v of videos) {
    const yt = meta?.get(v.vid) ?? null;
    v.yt = yt && !yt.gone ? yt : null;
    v.gone = Boolean(yt?.gone);
    v.hasEmbedding = Boolean(hasEmbedding[v.i]);
    v.lastRecMonth = v.lastRecMonth ?? null;
    v.lastMonth = v.lastMonth ?? null;
    v.search = {
      title: searchable(v.title),
      channel: searchable(v.channel),
      topics: searchable([v.primary_topic, ...v.tags].join(' ')),
      summary: searchable(`${v.summary} ${v.why_hn}`),
    };
  }

  // ---- duplicate uploads ----
  const byTitle = new Map();
  for (const v of videos) {
    // A deleted or private upload can't stand in for a public re-upload of the same talk.
    if (v.gone) continue;
    const key = normalizeTitle(v.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(v);
  }
  let duplicates = 0;
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    // Prefer an upload that can play embedded, then the best-scored one (`videos` is sorted
    // best first and sort is stable).
    group.sort((a, b) => Number(a.yt?.embeddable === false) - Number(b.yt?.embeddable === false));
    const keepers = [];
    for (const v of group) {
      const original = keepers.find(
        (k) =>
          k.channel === v.channel ||
          (k.hasEmbedding && v.hasEmbedding && dotRows(emb, dim, k.i, v.i) >= DUPLICATE_SIMILARITY),
      );
      if (original) {
        v.dupOf = original.vid;
        duplicates++;
      } else {
        keepers.push(v);
      }
    }
  }

  // `visible`: shown anywhere. The Home feed narrows this further (see src/curation.js).
  for (const v of videos) v.visible = !v.dupOf && !v.gone;

  // ---- taxonomy, with counts and embedding centroids ----
  const taxonomy = JSON.parse(readFileSync(file('taxonomy.json'), 'utf8'));
  const areas = [];
  const categoryById = new Map();
  const areaById = new Map();
  for (const a of taxonomy.areas ?? []) {
    const area = { id: a.id, name: a.name, count: 0, categories: [] };
    for (const c of a.categories ?? []) {
      const cat = { id: c.id, name: c.name, description: c.description ?? '', area: a.id, area_name: a.name, count: 0 };
      cat.search = searchable(`${c.name} ${c.description ?? ''}`);
      area.categories.push(cat);
      categoryById.set(cat.id, cat);
    }
    areas.push(area);
    areaById.set(area.id, area);
  }
  const catIndex = new Map([...categoryById.keys()].map((id, k) => [id, k]));
  const centroids = new Float32Array(categoryById.size * dim);
  for (const v of videos) {
    if (!v.visible) continue;
    const areasSeen = new Set();
    v.categories.forEach((c, rank) => {
      const cat = categoryById.get(c.id);
      if (!cat) return;
      cat.count++;
      if (!areasSeen.has(cat.area)) {
        areaById.get(cat.area).count++;
        areasSeen.add(cat.area);
      }
      if (!v.hasEmbedding) return;
      const w = rank === 0 ? 1 : 0.5;
      const k = catIndex.get(c.id);
      for (let d = 0; d < dim; d++) centroids[k * dim + d] += w * emb[v.i * dim + d];
    });
  }
  for (let k = 0; k < categoryById.size; k++) normalizeInPlace(centroids, k * dim, dim);
  for (const area of areas) area.categories.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  areas.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const visible = videos.filter((v) => v.visible);
  const years = videos.flatMap((v) => [v.hn?.first_year, v.hn?.last_year]).filter(Number.isFinite);

  return {
    dataDir,
    videos,
    byVid,
    dim,
    emb,
    mentionsByVid,
    related,
    areas,
    areaById,
    categoryById,
    catIds: [...catIndex.keys()],
    centroids,
    hasMeta: Boolean(meta),
    maxMonth,
    stats: {
      videos: visible.length,
      total_videos: videos.length,
      duplicates,
      without_embedding: withoutEmbedding,
      mentions: mentionCount,
      recommenders: recommenders.size,
      areas: areas.length,
      categories: categoryById.size,
      first_year: years.length ? Math.min(...years) : null,
      last_year: years.length ? Math.max(...years) : null,
      latest_month: maxMonth,
      has_youtube_metadata: Boolean(meta),
    },
  };
}

/** The upload that stands for `vid` (itself unless it is a duplicate). */
export function canonical(ds, vid) {
  const v = ds.byVid.get(vid);
  if (!v) return null;
  return v.dupOf ? ds.byVid.get(v.dupOf) : v;
}
