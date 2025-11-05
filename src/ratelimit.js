// Token bucket per client key. Search runs a model per query, so it gets a budget.

export function createRateLimiter({ capacity, refillPerSecond, maxKeys = 10_000, now = () => Date.now() }) {
  const buckets = new Map();

  /**
   * Take `cost` tokens (default 1). A cost can be "milliseconds of CPU" for a CPU budget.
   * @returns {{ ok: boolean, retryAfter: number }}
   */
  function take(key, cost = 1) {
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
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - b.tokens) / refillPerSecond)) };
  }

  /** Spend tokens after the fact (the bucket may go negative), e.g. CPU time actually used. */
  function charge(key, cost) {
    const b = buckets.get(key);
    if (b) b.tokens -= cost;
  }

  return { take, charge };
}
