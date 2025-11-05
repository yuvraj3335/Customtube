// Search: semantic when a query embedding is available (bge-small-en-v1.5, the model the
// export's vectors came from), with a keyword score and a topic match on top. Without the
// model it falls back to keyword search only.

import { searchable } from './data.js';
import { matchesFilters, sortVideos } from './filters.js';
import { dotRowVec } from './vec.js';

// Calibrated on the real export: on-topic queries score 0.75-0.85 against their best match,
// nonsense queries about 0.64.
export const WEAK_SIMILARITY = 0.7;
const TOPIC_SIMILARITY = 0.72;
const STOPWORDS = new Set(
  'a an and are as at be by for from how i in is it of on or that the this to what when where which who why with video videos talk talks about'.split(
    ' ',
  ),
);

export function tokenize(q) {
  return searchable(q)
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** 0..1: how well the query's words appear in a video's own text. */
function keywordScore(v, tokens, phrase) {
  if (!tokens.length) return 0;
  const s = v.search;
  let score = phrase.length > 4 && s.title.includes(phrase) ? 2 : 0;
  for (const t of tokens) {
    // Words of 4+ letters also match as prefixes ("compil" -> "compilers"); shorter ones must
    // match whole words, so "go" doesn't hit "google".
    const word = t.length >= 4 ? ` ${t}` : ` ${t} `;
    if (s.title.includes(word)) score += 1.5;
    if (s.topics.includes(word)) score += 1;
    if (s.channel.includes(word)) score += 1;
    if (s.summary.includes(word)) score += 0.4;
  }
  return Math.min(1, score / (1.5 * tokens.length + 2));
}

/**
 * @param {object} ds
 * @param {{ q: string, qvec: Float32Array|null, filters: object, limit?: number, nowMs?: number }} args
 */
export function searchVideos(ds, { q, qvec, filters, limit = 60, nowMs = Date.now() }) {
  const tokens = tokenize(q);
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

  const hits = [];
  let bestSim = -1;
  let bestKeyword = 0;
  for (const v of ds.videos) {
    if (!v.visible || !matchesFilters(v, filters, nowMs)) continue;
    const kw = keywordScore(v, tokens, phrase);
    const sim = qvec && v.hasEmbedding ? dotRowVec(ds.emb, ds.dim, v.i, qvec) : null;
    if (sim === null && kw === 0) continue;
    const topic = v.categories.find((c) => topics.has(c.id));
    const rank = (sim ?? 0) + 0.12 * kw + 0.012 * Math.log1p(v.score) + (topic ? 0.015 : 0);
    hits.push({ v, rank, sim, kw, topic });
    if (sim !== null && sim > bestSim) bestSim = sim;
    if (kw > bestKeyword) bestKeyword = kw;
  }

  hits.sort((a, b) => b.rank - a.rank || b.v.score - a.v.score);
  let top = hits.slice(0, limit);
  if (filters.sort && filters.sort !== 'relevance') {
    // Re-sort the relevant hits by the chosen order rather than sorting the whole catalogue.
    const byVid = new Map(top.map((h) => [h.v.vid, h]));
    top = sortVideos(
      top.map((h) => h.v),
      filters.sort,
    ).map((v) => byVid.get(v.vid));
  }

  const weak = qvec ? bestSim < WEAK_SIMILARITY && bestKeyword < 0.5 : hits.length === 0;
  return {
    mode: qvec ? 'semantic' : 'keyword',
    weak,
    results: top.map((h) => ({
      vid: h.v.vid,
      // Explain a hit that matched through its topic rather than its own words.
      via: h.topic && h.kw < 0.2 ? h.topic.name : null,
    })),
  };
}
