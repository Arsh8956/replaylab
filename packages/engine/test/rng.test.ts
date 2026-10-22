import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';

describe('createRng (seeded, deterministic)', () => {
  it('same seed, same sequence; different seed, different sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
  });
  it('seeds 0 and 1 are different streams', () => {
    expect(createRng(0).next()).not.toBe(createRng(1).next());
  });
  it('next() is uniform on [0, 1): mean 0.5, variance 1/12', () => {
    const r = createRng(7);
    const n = 100_000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
      sq += x * x;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    expect(sq / n - (sum / n) ** 2).toBeCloseTo(1 / 12, 2);
  });
  it('normal() has mean 0 and standard deviation 1', () => {
    const r = createRng(9);
    const n = 100_000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const x = r.normal();
      sum += x;
      sq += x * x;
    }
    expect(sum / n).toBeCloseTo(0, 1);
    expect(Math.sqrt(sq / n - (sum / n) ** 2)).toBeCloseTo(1, 1);
  });
  it('normal() is deterministic too', () => {
    const a = createRng(5);
    const b = createRng(5);
    expect(Array.from({ length: 10 }, () => a.normal())).toEqual(Array.from({ length: 10 }, () => b.normal()));
  });
});
