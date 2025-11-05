// "Up next" for a video: first the videos most often recommended by the same HN people
// (at least two shared recommenders), then the nearest videos by embedding, then the
// remaining one-shared-recommender co-recommendations.

import { canonical } from './data.js';
import { dotRows } from './vec.js';

export function relatedFor(ds, vid, n = 20) {
  const target = canonical(ds, vid);
  if (!target) return [];
  const used = new Set([target.vid, vid]);
  const out = [];
  const push = (v, reason) => {
    if (out.length >= n || !v || !v.visible || used.has(v.vid)) return;
    used.add(v.vid);
    out.push({ vid: v.vid, reason });
  };

  const corec = ds.related.get(target.vid) ?? ds.related.get(vid) ?? [];
  const strong = corec.filter((r) => r.shared >= 2);
  const weak = corec.filter((r) => r.shared < 2);
  for (const r of strong) push(canonical(ds, r.vid), `${r.shared} HN recommenders in common`);

  if (out.length < n && target.hasEmbedding) {
    const { dim, emb } = ds;
    const scored = [];
    for (const v of ds.videos) {
      if (!v.visible || !v.hasEmbedding || used.has(v.vid)) continue;
      scored.push({ v, sim: dotRows(emb, dim, target.i, v.i) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const room = n - out.length - Math.min(weak.length, Math.floor((n - out.length) / 4));
    for (const { v } of scored.slice(0, Math.max(room, 0))) push(v, 'Similar topic');
  }
  for (const r of weak) push(canonical(ds, r.vid), 'Also recommended by an HN recommender of this video');
  return out;
}
