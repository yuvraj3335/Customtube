// Loads the video data export (plus optional YouTube metadata) into memory and derives
// everything the API needs: indexes, per-video HN stats, duplicate groups, topic centroids
// and normalized search text. The whole dataset is small (6,454 videos), so it lives in RAM.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LRUCache } from 'lru-cache';
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

// Two uploads count as one talk when their normalized titles match (or, on one channel, one
// title contains the other) and they are on the same channel or nearly the same embedding.
// Re-uploads of one talk measured 0.89-0.95 on the real export; different talks with the same
// generic title ("Lecture 1") are far lower.
const DUPLICATE_SIMILARITY = 0.88;
const CONTAINED_TITLE_MIN = 12; // characters, so "Intro" doesn't contain-match everything

/** File text without a UTF-8 byte-order mark. */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${err.message}`);
  }
}

/** JSON Lines. With `skipBad`, unparseable lines are counted instead of failing the load. */
function readJsonl(file, { skipBad = false } = {}) {
  const out = [];
  let bad = 0;
  let lineNo = 0;
  const text = readText(file);
  // Walk the lines in place rather than split(): the comments file is ~35 MB, and an array of
  // every line would double the memory needed while loading.
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    lineNo++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (!skipBad) throw new Error(`${path.basename(file)} line ${lineNo}: ${err.message}`);
      bad++;
    }
  }
  return { rows: out, bad };
}

const nonNegative = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFC') // compose, but keep accents: "й" and "и" are different letters
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

// Names that are mostly punctuation, kept as words so "c++" and "c#" are searchable.
const SYMBOL_WORDS = [
  [/(^|[^\p{L}\p{N}])c\+\+/gu, '$1 cplusplus '],
  [/(^|[^\p{L}\p{N}])c#/gu, '$1 csharp '],
  [/(^|[^\p{L}\p{N}])f#/gu, '$1 fsharp '],
  [/(^|[^\p{L}\p{N}])\.net\b/gu, '$1 dotnet '],
];

/** Lowercase text with every run of non-letters/digits turned into one space, padded with spaces. */
export function searchable(text) {
  let s = String(text ?? '').toLowerCase();
  for (const [re, word] of SYMBOL_WORDS) s = s.replace(re, word);
  return ` ${s
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

function loadYoutubeMeta(file, warnings) {
  const meta = new Map();
  // The fetch script appends as it goes, so an interrupted run can leave a cut-off last line.
  const { rows, bad } = readJsonl(file, { skipBad: true });
  if (bad) warnings.push(`${path.basename(file)}: skipped ${bad} unreadable line(s); run the fetch again to fill them in`);
  for (const row of rows) {
    if (!row || !VID_RE.test(row.vid)) continue;
    const it = row.item;
    if (!it) {
      meta.set(row.vid, { gone: true });
      continue;
    }
    // YouTube sends counts as strings; "" or junk means unknown, not zero.
    const count = (s) => (typeof s === 'string' && /^\d+$/.test(s) ? Number(s) : null);
    const duration = parseIsoDuration(it.contentDetails?.duration);
    meta.set(row.vid, {
      gone: it.status?.privacyStatus === 'private',
      embeddable: it.status?.embeddable !== false,
      // P0D is what live streams and premieres report: unknown length, not a 0-second Short.
      duration_s: duration > 0 ? duration : null,
      views: count(it.statistics?.viewCount),
      likes: count(it.statistics?.likeCount),
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
  const warnings = [];

  // ---- taxonomy first, so videos can be checked against it ----
  const taxonomy = readJson(file('taxonomy.json'));
  const knownCategories = new Set((taxonomy.areas ?? []).flatMap((a) => (a?.categories ?? []).map((c) => c?.id)).filter((id) => typeof id === 'string'));

  // ---- videos ----
  const videos = readJsonl(file('videos.jsonl')).rows;
  const byVid = new Map();
  let fixedNumbers = 0;
  let droppedCategories = 0;
  for (const v of videos) {
    if (!v || typeof v !== 'object' || !VID_RE.test(v.vid)) throw new Error(`videos.jsonl: invalid vid ${JSON.stringify(v?.vid)}`);
    if (byVid.has(v.vid)) throw new Error(`videos.jsonl: duplicate vid ${v.vid}`);
    byVid.set(v.vid, v);
    // Numbers drive every ranking; a NaN, Infinity, negative or string would poison sorts.
    if (nonNegative(v.score) === null) {
      v.score = 0;
      fixedNumbers++;
    }
    v.hn = v.hn && typeof v.hn === 'object' ? v.hn : {};
    for (const k of ['mentions', 'recommenders', 'rec_months', 'strong_recs']) {
      if (nonNegative(v.hn[k]) === null) {
        if (v.hn[k] !== undefined) fixedNumbers++;
        v.hn[k] = 0;
      }
    }
    for (const k of ['title', 'channel', 'summary', 'why_hn', 'primary_topic']) if (typeof v[k] !== 'string') v[k] = '';
    const cats = Array.isArray(v.categories) ? v.categories.filter((c) => c && typeof c.id === 'string') : [];
    v.categories = cats.filter((c) => knownCategories.has(c.id));
    droppedCategories += cats.length - v.categories.length;
    v.tags = Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [];
  }
  if (fixedNumbers) warnings.push(`videos.jsonl: ${fixedNumbers} invalid score/count value(s) read as 0`);
  if (droppedCategories) warnings.push(`videos.jsonl: ${droppedCategories} category reference(s) not in taxonomy.json were ignored`);
  videos.sort((a, b) => b.score - a.score || a.vid.localeCompare(b.vid));
  videos.forEach((v, i) => {
    v.i = i;
    v.dupOf = null;
  });

  // ---- mentions ----
  const mentionsByVid = new Map();
  let mentionCount = 0;
  const recommenders = new Set();
  let maxMonth = null;
  for (const m of readJsonl(file('mentions.jsonl')).rows) {
    const v = m && byVid.get(m.vid);
    if (!v || !isMonth(m.month)) continue;
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
  for (const r of readJsonl(file('related.jsonl')).rows) {
    if (!r || !byVid.has(r.vid) || !Array.isArray(r.related)) continue;
    related.set(
      r.vid,
      r.related
        .filter((x) => x && byVid.has(x.vid) && x.vid !== r.vid)
        .map((x) => ({ vid: x.vid, shared: Number(x.shared_recommenders) || 0 })),
    );
  }

  // ---- embeddings, re-ordered to match `videos` ----
  const matrix = readNpyMatrix(readFileSync(file('embeddings.npy')));
  const ids = readJson(file('embedding_ids.json'));
  if (!Array.isArray(ids) || ids.length !== matrix.rows) {
    throw new Error(`embedding_ids.json has ${ids?.length} ids but embeddings.npy has ${matrix.rows} rows`);
  }
  const dim = matrix.cols;
  const emb = new Float32Array(videos.length * dim);
  const hasEmbedding = new Uint8Array(videos.length);
  const badRows = [];
  let repeatedIds = 0;
  ids.forEach((vid, row) => {
    const v = byVid.get(vid);
    if (!v) return;
    if (hasEmbedding[v.i]) {
      repeatedIds++; // the first row for an id wins
      return;
    }
    const vec = matrix.data.subarray(row * dim, row * dim + dim);
    // A NaN/Infinity or zero row would turn every similarity with it into NaN and scramble
    // sorts; the video is kept but treated as having no embedding.
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += vec[k] * vec[k];
    if (!Number.isFinite(norm) || norm < 0.25) {
      badRows.push(vid);
      return;
    }
    emb.set(vec, v.i * dim);
    normalizeInPlace(emb, v.i * dim, dim);
    hasEmbedding[v.i] = 1;
  });
  if (badRows.length) warnings.push(`embeddings.npy: ${badRows.length} unusable row(s) (NaN, Infinity or zero), e.g. ${badRows.slice(0, 3).join(', ')}`);
  if (repeatedIds) warnings.push(`embedding_ids.json: ${repeatedIds} repeated id(s); the first row was used`);
  const withoutEmbedding = videos.filter((v) => !hasEmbedding[v.i]).length;

  // ---- optional YouTube metadata ----
  const meta = metaFile && existsSync(metaFile) ? loadYoutubeMeta(metaFile, warnings) : null;

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
  // Prefer an upload that can play embedded, then the best-scored one (`videos` is sorted
  // best first and sort is stable).
  const keeperOrder = (a, b) => Number(a.yt?.embeddable === false) - Number(b.yt?.embeddable === false);
  const similar = (a, b) => a.hasEmbedding && b.hasEmbedding && dotRows(emb, dim, a.i, b.i) >= DUPLICATE_SIMILARITY;
  let duplicates = 0;
  const markDuplicates = (group, sameUpload) => {
    group.sort(keeperOrder);
    const keepers = [];
    for (const v of group) {
      if (v.dupOf) continue;
      const original = keepers.find((k) => sameUpload(k, v));
      if (original) {
        v.dupOf = original.vid;
        duplicates++;
      } else {
        keepers.push(v);
      }
    }
  };
  const titleOf = new Map();
  const byTitle = new Map();
  const byChannel = new Map();
  for (const v of videos) {
    // A deleted or private upload can't stand in for a public re-upload of the same talk.
    if (v.gone) continue;
    const key = normalizeTitle(v.title);
    if (!key) continue; // no title: nothing to compare
    titleOf.set(v, key);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(v);
    if (v.channel) {
      if (!byChannel.has(v.channel)) byChannel.set(v.channel, []);
      byChannel.get(v.channel).push(v);
    }
  }
  // 1. the same title: same channel, or nearly the same content
  for (const group of byTitle.values()) {
    if (group.length > 1) markDuplicates(group, (k, v) => k.channel === v.channel || similar(k, v));
  }
  // 2. on one channel, one title contains the other ("Bret Victor - Inventing on Principle" vs
  //    "Inventing on Principle") and the content is nearly the same
  const contains = (a, b) => {
    const [x, y] = [titleOf.get(a), titleOf.get(b)];
    const shorter = x.length <= y.length ? x : y;
    const longer = shorter === x ? y : x;
    return shorter.length >= CONTAINED_TITLE_MIN && ` ${longer} `.includes(` ${shorter} `);
  };
  for (const group of byChannel.values()) {
    if (group.length > 1 && group.length < 500) markDuplicates(group, (k, v) => contains(k, v) && similar(k, v));
  }

  // Word -> indexes of videos whose title, topics, channel or summary contain it, so a keyword
  // search only scores the videos that can match.
  const wordIndex = new Map();
  for (const v of videos) {
    const words = new Set(`${v.search.title}${v.search.topics}${v.search.channel}${v.search.summary}`.split(' '));
    for (const w of words) {
      if (!w) continue;
      let list = wordIndex.get(w);
      if (!list) wordIndex.set(w, (list = []));
      list.push(v.i);
    }
  }

  // `visible`: shown anywhere. The Home feed narrows this further (see src/curation.js).
  for (const v of videos) v.visible = !v.dupOf && !v.gone;

  // ---- taxonomy, with counts and embedding centroids ----
  const areas = [];
  const categoryById = new Map();
  const areaById = new Map();
  for (const a of (taxonomy.areas ?? []).filter((x) => x && typeof x.id === 'string')) {
    const area = { id: a.id, name: String(a.name ?? a.id), count: 0, categories: [] };
    for (const c of (a.categories ?? []).filter((x) => x && typeof x.id === 'string')) {
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
    warnings,
    simRow: makeSimRows(emb, dim, videos.length),
    wordIndex,
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

/**
 * simRow(i): the cosine similarity of video i to every video, as a Float32Array indexed like
 * `videos`. One row costs ~2 ms; rows are cached (26 KB each, 1,500 rows ~40 MB), so a video
 * that many profiles like or dislike is computed once.
 */
function makeSimRows(emb, dim, n) {
  const cache = new LRUCache({ max: 1500 });
  return (i) => {
    let row = cache.get(i);
    if (row) return row;
    row = new Float32Array(n);
    const a = i * dim;
    for (let j = 0; j < n; j++) {
      const b = j * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += emb[a + k] * emb[b + k];
      row[j] = s;
    }
    cache.set(i, row);
    return row;
  };
}

/** The upload that stands for `vid` (itself unless it is a duplicate). */
export function canonical(ds, vid) {
  const v = ds.byVid.get(vid);
  if (!v) return null;
  return v.dupOf ? ds.byVid.get(v.dupOf) : v;
}
