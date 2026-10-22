/** Seeded PRNG (mulberry32) with a Box-Muller normal. Deterministic across runs and platforms. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal. */
  normal(): number;
}

export function createRng(seed: number): Rng {
  // Spread nearby seeds apart before they enter the generator.
  let state = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  let spare: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };

  return { next, normal };
}
