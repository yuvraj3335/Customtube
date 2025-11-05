// Query embeddings with bge-small-en-v1.5 through transformers.js (ONNX runtime, CPU).
// The export's vectors were made with the same model, CLS pooling, L2-normalized and no
// instruction prefix, so queries are embedded the same way. The model (~34 MB) downloads
// from Hugging Face on first use and is cached under .cache/models.
//
// Loading happens in the background. Until it is ready (or if it fails), embed() returns
// null and search falls back to keywords.

import { LRUCache } from 'lru-cache';
import { normalizeInPlace } from './vec.js';

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';

export function createEmbedder({ cacheDir, enabled = true, log = console, retryMs = 30_000, maxRetryMs = 10 * 60_000 }) {
  let state = enabled ? 'idle' : 'off';
  let extractor = null;
  let loading = null;
  let nextRetry = retryMs;
  let queue = Promise.resolve();
  const cache = new LRUCache({ max: 500 });

  function start() {
    if (state !== 'idle') return loading ?? Promise.resolve();
    state = 'loading';
    const t0 = Date.now();
    loading = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = cacheDir;
        extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
        state = 'ready';
        log.info?.(`embedder ready (${MODEL_ID}, ${Date.now() - t0} ms)`);
      } catch (err) {
        state = 'failed';
        log.error?.(`embedder failed to load, search falls back to keywords; retrying in ${Math.round(nextRetry / 1000)} s: ${err.message}`);
        // A failed first download (no network at boot) shouldn't mean keyword-only until a
        // restart: try again, backing off up to every 10 minutes.
        const timer = setTimeout(() => {
          state = 'idle';
          loading = null;
          start();
        }, nextRetry);
        timer.unref?.();
        nextRetry = Math.min(nextRetry * 2, maxRetryMs);
      }
    })();
    return loading;
  }

  /** @returns {Promise<Float32Array|null>} */
  async function embed(text) {
    if (state !== 'ready') return null;
    const key = text.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    // ONNX sessions are not re-entrant; run one query at a time.
    const run = queue.then(async () => {
      const out = await extractor(key, { pooling: 'cls', normalize: true });
      const vec = Float32Array.from(out.data);
      normalizeInPlace(vec);
      return vec;
    });
    queue = run.catch(() => {});
    const vec = await run;
    cache.set(key, vec);
    return vec;
  }

  return {
    start,
    embed,
    status: () => state,
    ready: () => loading ?? Promise.resolve(),
  };
}
