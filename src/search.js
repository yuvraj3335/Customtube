// Search: semantic when a query embedding is available (bge-small-en-v1.5, the model the
// export's vectors came from), with a keyword score and a topic match on top. Without the
// model it falls back to keyword search only.

import { searchable } from './data.js';
import { matchesFilters, sortVideos } from './filters.js';
import { dotRows, dotRowVec } from './vec.js';

// Calibrated on the real export: on-topic queries score 0.75-0.85 against their best match,
// nonsense queries about 0.64.
export const WEAK_SIMILARITY = 0.7;
const TOPIC_SIMILARITY = 0.72;
const STOPWORDS = new Set(
  'a an and are as at be by for from how i in is it of on or that the this to what when where which who why with video videos talk talks about'.split(
    ' ',
  ),
);

// Each token costs a scan of every video, so a query keeps at most this many distinct ones.
export const MAX_TOKENS = 16;

export function tokenize(q) {
  const out = [];
  for (const t of searchable(q).trim().split(' ')) {
    if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_TOKENS) break;
  }
  return out;
}

/** The forms a query word may take in a video's text: itself, and singular/plural. */
function wordForms(t) {
  const stem = t.length > 4 && t.endsWith('es') ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
  return [...new Set([t, stem, `${stem}s`, `${stem}es`])].map((w) => ` ${w} `);
}

/**
 * How well the query's words appear in a video's own text: `score` 0..1, and `full` when every
 * word is in its title, tags or channel. Whole words only ("demos" doesn't match "demoscene",
 * "go" doesn't match "google"), allowing singular/plural ("transistors" matches "transistor").
 */
function keywordScore(v, tokens, forms, phrase) {
  if (!tokens.length) return { score: 0, full: false };
  const s = v.search;
  let score = phrase.length > 4 && s.title.includes(phrase) ? 2 : 0;
  let matched = 0;
  tokens.forEach((t, i) => {
    const has = (field) => forms[i].some((w) => field.includes(w));
    const inTitle = has(s.title);
    const inTopics = has(s.topics);
    const inChannel = has(s.channel);
    if (inTitle) score += 1.5;
    if (inTopics) score += 1;
    if (inChannel) score += 1;
    if (has(s.summary)) score += 0.4;
    if (inTitle || inTopics || inChannel) matched++;
  });
  return { score: Math.min(1, score / (1.5 * tokens.length + 2)), full: matched === tokens.length };
}

// Re-uploads with different titles on different channels slip past load-time dedupe. In
// results, a hit is skipped as a copy of one already shown when the content is nearly the same
// (re-uploads measured 0.86-0.93), the titles share most of their words, and any numbered
// words are identical ("Lecture 1A" and "Lecture 1B" are both kept).
const COPY_SIMILARITY = 0.86;
const COPY_TITLE_OVERLAP = 0.75;
function titleWords(v) {
  const words = new Set();
  for (const w of v.search.title.trim().split(' ')) {
    if (w.length < 2 && !/\d/.test(w)) continue; // keep "1" in "Part 1": it tells episodes apart
    words.add(w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return words;
}
const numbered = (words) => [...words].filter((w) => /\d/.test(w)).sort().join(' ');
function isCopy(ds, h, k, words) {
  if (!h.v.hasEmbedding || !k.v.hasEmbedding || numbered(words) !== k.numbered) return false;
  let shared = 0;
  for (const w of words) if (k.words.has(w)) shared++;
  if (shared / Math.max(1, Math.min(words.size, k.words.size)) < COPY_TITLE_OVERLAP) return false;
  return dotRows(ds.emb, ds.dim, h.v.i, k.v.i) >= COPY_SIMILARITY;
}
function collapseCopies(ds, hits, limit) {
  const kept = [];
  for (const h of hits) {
    if (kept.length === limit) break;
    const words = titleWords(h.v);
    if (!kept.some((k) => isCopy(ds, h, k, words))) kept.push({ ...h, words, numbered: numbered(words) });
  }
  return kept;
}

// For a sort other than relevance, only clearly relevant hits are re-sorted (semantic search
// scores every video, and the popular weak matches would otherwise jump to the top).
const RELEVANT_GAP = 0.08;
const RELEVANT_FLOOR = 0.62;
const STRONG_TOPIC = 0.78;

/**
 * @param {object} ds
 * @param {{ q: string, qvec: Float32Array|null, filters: object, limit?: number, nowMs?: number }} args
 */
export function searchVideos(ds, { q, qvec, filters, limit = 60, nowMs = Date.now() }) {
  if (qvec && qvec.length !== ds.dim) throw new Error(`query vector has ${qvec.length} dimensions, the data has ${ds.dim}`);
  const tokens = tokenize(q);
  const forms = tokens.map(wordForms);
  const phrase = searchable(q);

  // Topics the query is about: by centroid similarity, or by the words in a topic's name.
  const topics = new Map();
  if (qvec) {
    ds.catIds.forEach((id, k) => {
      const sim = dotRowVec(ds.centroids, ds.dim, k, qvec);
      if (sim >= TOPIC_SIMILARITY) topics.set(id, sim);
    });
  }
  for (const cat of ds.categoryById.values()) {
    const nameTokens = tokenize(cat.name);
    if (nameTokens.length && nameTokens.every((t) => tokens.includes(t))) topics.set(cat.id, 1);
  }

  // Only videos containing at least one form of a query word can have a keyword score.
  const candidates = new Set();
  for (const f of forms) for (const w of f) for (const i of ds.wordIndex?.get(w.trim()) ?? []) candidates.add(i);
  const noKeyword = { score: 0, full: false };

  const hits = [];
  let bestSim = -1;
  let bestKeyword = 0;
  let anyFull = false;
  for (const v of qvec ? ds.videos : [...candidates].map((i) => ds.videos[i])) {
    if (!v.visible || !matchesFilters(v, filters, nowMs)) continue;
    const { score: kw, full } = candidates.has(v.i) ? keywordScore(v, tokens, forms, phrase) : noKeyword;
    const sim = qvec && v.hasEmbedding ? dotRowVec(ds.emb, ds.dim, v.i, qvec) : null;
    if (sim === null && kw === 0) continue;
    const topic = v.categories.find((c) => topics.has(c.id));
    const rank = (sim ?? 0) + 0.12 * kw + (full ? 0.03 : 0) + 0.012 * Math.log1p(v.score) + (topic ? 0.015 : 0);
    hits.push({ v, rank, sim, kw, full, topic });
    if (sim !== null && sim > bestSim) bestSim = sim;
    if (kw > bestKeyword) bestKeyword = kw;
    if (full) anyFull = true;
  }

  hits.sort((a, b) => b.rank - a.rank || b.v.score - a.v.score);
  let top;
  if (filters.sort && filters.sort !== 'relevance') {
    const relevant = hits.filter((h) =>
      qvec ? h.full || (h.sim !== null && h.sim >= Math.max(RELEVANT_FLOOR, bestSim - RELEVANT_GAP)) : h.kw >= bestKeyword / 2,
    );
    const byVid = new Map(relevant.map((h) => [h.v.vid, h]));
    top = sortVideos(
      relevant.map((h) => h.v),
      filters.sort,
    )
      .slice(0, limit)
      .map((v) => byVid.get(v.vid));
  } else {
    top = collapseCopies(ds, hits, limit);
  }

  // Weak: nothing close in meaning and no video carrying all the query's words.
  const weak = qvec ? bestSim < WEAK_SIMILARITY && !anyFull : hits.length === 0;
  return {
    mode: qvec ? 'semantic' : 'keyword',
    weak,
    results: top.map((h) => ({
      vid: h.v.vid,
      // Explain a hit that matched through a clearly related topic rather than its own words.
      via: h.topic && h.kw < 0.2 && (topics.get(h.topic.id) ?? 0) >= STRONG_TOPIC ? h.topic.name : null,
    })),
  };
}

/**
 * As-you-type suggestions: every word but the last must appear whole in a video's title, tags
 * or channel, and the last one may be a prefix ("distri" -> "distributed"). Keyword-only, so it
 * is fast enough to run on each keystroke. Returns videos and topics.
 */
export function suggest(ds, q, { videos = 6, topics = 4 } = {}) {
  const words = searchable(q).trim().split(' ').filter(Boolean).slice(0, MAX_TOKENS);
  if (!words.length || words.join('').length < 2) return { videos: [], topics: [] };
  const last = words[words.length - 1];
  const rest = words.slice(0, -1).filter((w) => !STOPWORDS.has(w));
  const fieldHas = (field) => rest.every((w) => field.includes(` ${w} `)) && field.includes(` ${last}`);
  const hits = [];
  for (const v of ds.videos) {
    if (!v.visible) continue;
    const s = v.search;
    const inTitle = fieldHas(s.title);
    if (!inTitle && !fieldHas(` ${s.topics.trim()} ${s.channel.trim()} `)) continue;
    hits.push({ v, rank: (inTitle ? 2 : 0) + Math.log1p(v.score) });
  }
  hits.sort((a, b) => b.rank - a.rank);
  const cats = [];
  for (const c of ds.categoryById.values()) {
    const name = searchable(c.name);
    if (fieldHas(name)) cats.push(c);
  }
  cats.sort((a, b) => b.count - a.count);
  return {
    videos: hits.slice(0, videos).map((h) => h.v.vid),
    topics: cats.slice(0, topics).map((c) => ({ id: c.id, name: c.name, count: c.count })),
  };
}
