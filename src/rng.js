// Seeded randomness. The Home feed must be reproducible for one (seed, profile) pair so that
// paging through it never repeats or skips a video.

/** 32-bit FNV-1a hash of a string. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32: small, fast, good-enough PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG for one named stream, so adding a stream never shifts another one's sequence. */
export function rngFor(seed, stream) {
  return mulberry32(hashString(`${seed}\u0000${stream}`));
}

/**
 * Weighted random order without replacement (Efraimidis–Spirakis): each item gets the key
 * -ln(u) / w and items are sorted by key. Heavier items tend to come first. Items with a
 * weight <= 0 (or not finite) are dropped.
 */
export function weightedOrder(items, weightOf, rng) {
  const keyed = [];
  for (const item of items) {
    const w = weightOf(item);
    if (!(w > 0) || !Number.isFinite(w)) continue;
    const u = rng() || Number.MIN_VALUE;
    keyed.push({ item, key: -Math.log(u) / w });
  }
  keyed.sort((a, b) => a.key - b.key);
  return keyed.map((k) => k.item);
}
