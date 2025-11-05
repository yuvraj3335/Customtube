// Token bucket per client key. Search runs a model per query, so it gets a budget.

export function createRateLimiter({ capacity, refillPerSecond, maxKeys = 10_000, now = () => Date.now() }) {
  const buckets = new Map();

  /** @returns {{ ok: boolean, retryAfter: number }} */
  function take(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      b = { tokens: capacity, at: t };
    } else {
      buckets.delete(key); // keep Map order = least recently used first
    }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSecond);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerSecond) };
  }

  return { take };
}
