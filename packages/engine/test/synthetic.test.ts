import { describe, expect, it } from 'vitest';
import { CONTRACTS, roundToTick } from '../src/contracts';
import { EngineError } from '../src/errors';
import { generateSyntheticBars, generateSyntheticSeries, sessionVolMultiplier } from '../src/synthetic';
import { etParts, tradingDay } from '../src/time';
import type { Bar } from '../src/types';
import { utc } from './helpers';

const SUN_OPEN = utc('2024-01-07T23:00:00Z'); // Sun 18:00 ET (EST)
const BARS_PER_DAY = 1380; // 18:00 to 17:00 ET = 23 hours

/** True if a bar open time falls in a session minute: not in the 17:00 to 18:00 ET halt, not Fri 17:00 to Sun 18:00 ET. */
function isOpenMinute(time: number): boolean {
  const p = etParts(time);
  if (p.hour === 17) return false; // daily halt
  if (p.weekday === 6) return false; // Saturday
  if (p.weekday === 5 && p.hour >= 17) return false; // Friday after the close
  if (p.weekday === 0 && p.hour < 18) return false; // Sunday before the open
  return true;
}

const week = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 5, seed: 1 });

describe('generateSyntheticBars: structure', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const again = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 5, seed: 1 });
    expect(again).toEqual(week);
    const other = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 5, seed: 2 });
    expect(other).not.toEqual(week);
    expect(other).toHaveLength(week.length);
  });

  it('5 trading days from Sunday 18:00 ET is 5 * 1380 bars, first at the start, last Friday 16:59 ET', () => {
    expect(week).toHaveLength(5 * BARS_PER_DAY);
    expect(week[0]!.time).toBe(SUN_OPEN);
    expect(week[week.length - 1]!.time).toBe(utc('2024-01-12T21:59:00Z')); // Fri 16:59 ET
  });

  it('bars are 1m apart inside a session, strictly increasing, on whole minutes', () => {
    for (let i = 1; i < week.length; i++) {
      expect(week[i]!.time).toBeGreaterThan(week[i - 1]!.time);
      expect(week[i]!.time % 60).toBe(0);
    }
  });

  it('no bars in the 17:00 to 18:00 ET halt or the weekend', () => {
    const bad = week.filter((b) => !isOpenMinute(b.time));
    expect(bad).toEqual([]);
    // the halt really is a hole: Mon 16:59 ET is followed by Mon 18:00 ET
    const i = week.findIndex((b) => b.time === utc('2024-01-08T21:59:00Z'));
    expect(week[i + 1]!.time).toBe(utc('2024-01-08T23:00:00Z'));
  });

  it('valid OHLC, positive prices, integer volume >= 1, all prices on the tick grid', () => {
    for (const b of week) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.low).toBeGreaterThan(0);
      expect(Number.isInteger(b.volume) && b.volume >= 1).toBe(true);
      for (const p of [b.open, b.high, b.low, b.close]) expect(roundToTick(p, 0.25)).toBe(p);
    }
  });

  it('the first open is the start price: defaults NQ 21000, ES 6000, YM 44000, RTY 2300, CL 70, GC 2700', () => {
    const defaults: [string, number][] = [['NQ', 21000], ['ES', 6000], ['YM', 44000], ['RTY', 2300], ['CL', 70], ['GC', 2700]];
    for (const [root, price] of defaults) {
      const bars = generateSyntheticBars({ root, start: SUN_OPEN, days: 1, seed: 3 });
      expect(bars[0]!.open, root).toBe(price);
    }
  });

  it('startPrice overrides the default and is snapped to the tick', () => {
    expect(generateSyntheticBars({ root: 'ES', start: SUN_OPEN, days: 1, seed: 3, startPrice: 5000 })[0]!.open).toBe(5000);
    expect(generateSyntheticBars({ root: 'ES', start: SUN_OPEN, days: 1, seed: 3, startPrice: 5000.1 })[0]!.open).toBe(5000);
  });

  it.each(['NQ', 'ES', 'YM', 'RTY', 'CL', 'GC'])('%s prices sit on its tick grid and bars have range', (root) => {
    const tick = CONTRACTS[root]!.tickSize;
    const bars = generateSyntheticBars({ root, start: SUN_OPEN, days: 3, seed: 11 });
    for (const b of bars) for (const p of [b.open, b.high, b.low, b.close]) expect(roundToTick(p, tick), `${root} ${p}`).toBe(p);
    const moving = bars.filter((b) => b.high > b.low).length / bars.length;
    expect(moving).toBeGreaterThan(0.9);
    expect(bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close))).toBe(true);
  });

  it('micro roots generate their full size contract bars', () => {
    expect(generateSyntheticBars({ root: 'MNQ', start: SUN_OPEN, days: 1, seed: 5 })).toEqual(generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 1, seed: 5 }));
    expect(generateSyntheticBars({ root: 'MGC', start: SUN_OPEN, days: 1, seed: 5 })[0]!.open).toBe(2700);
  });

  it('rejects an unknown root and bad day counts; 0 days is empty', () => {
    expect(() => generateSyntheticBars({ root: 'ZZ', start: SUN_OPEN, days: 1, seed: 1 })).toThrow(EngineError);
    expect(() => generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: -1, seed: 1 })).toThrow(EngineError);
    expect(() => generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 1.5, seed: 1 })).toThrow(EngineError);
    expect(() => generateSyntheticBars({ root: 'NQ', start: Number.NaN, days: 1, seed: 1 })).toThrow(EngineError);
    expect(generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 0, seed: 1 })).toEqual([]);
  });
});

describe('generateSyntheticBars: days are trading days', () => {
  it('skips the weekend: Fri, Mon, Tue from Thursday 18:00 ET', () => {
    const start = utc('2024-01-04T23:00:00Z'); // Thu 18:00 ET opens Friday's trading day
    const bars = generateSyntheticBars({ root: 'NQ', start, days: 3, seed: 4 });
    expect(bars).toHaveLength(3 * BARS_PER_DAY);
    expect([...new Set(bars.map((b) => tradingDay(b.time)))]).toEqual(['2024-01-05', '2024-01-08', '2024-01-09']);
    expect(bars.every((b) => isOpenMinute(b.time))).toBe(true);
    const lastFri = bars.findIndex((b) => b.time === utc('2024-01-05T21:59:00Z'));
    expect(bars[lastFri + 1]!.time).toBe(utc('2024-01-07T23:00:00Z')); // next bar is Sunday 18:00 ET
  });

  it('a mid day start makes a partial first day that counts as day 1', () => {
    const start = utc('2024-01-02T15:00:00Z'); // Tue 10:00 ET
    const bars = generateSyntheticBars({ root: 'NQ', start, days: 2, seed: 4 });
    expect(bars[0]!.time).toBe(start);
    expect(bars).toHaveLength(7 * 60 + BARS_PER_DAY); // 10:00 to 16:59 ET, then all of Wednesday's day
    expect(bars.every((b) => isOpenMinute(b.time))).toBe(true);
  });

  it('a start inside the halt begins at 18:00 ET, a start on Saturday at Sunday 18:00 ET', () => {
    const halt = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-02T22:30:00Z'), days: 1, seed: 4 }); // Tue 17:30 ET
    expect(halt[0]!.time).toBe(utc('2024-01-02T23:00:00Z'));
    expect(halt).toHaveLength(BARS_PER_DAY);
    const sat = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-06T15:00:00Z'), days: 1, seed: 4 });
    expect(sat[0]!.time).toBe(SUN_OPEN);
    expect(sat).toHaveLength(BARS_PER_DAY);
  });

  it('handles the spring forward week (Sun 2024-03-10): every trading day still has 1380 bars at the right UTC times', () => {
    const start = utc('2024-03-04T00:00:00Z'); // Sunday 2024-03-03 19:00 EST, in the Monday trading day
    const bars = generateSyntheticBars({ root: 'ES', start, days: 8, seed: 6 });
    expect(bars.every((b) => isOpenMinute(b.time))).toBe(true);
    const fri = bars.findIndex((b) => b.time === utc('2024-03-08T21:59:00Z')); // Fri 16:59 EST
    expect(bars[fri + 1]!.time).toBe(utc('2024-03-10T22:00:00Z')); // Sun 18:00 EDT
    const days = new Map<string, number>();
    for (const b of bars) days.set(tradingDay(b.time), (days.get(tradingDay(b.time)) ?? 0) + 1);
    const counts = [...days.values()];
    expect(counts).toHaveLength(8);
    expect(counts.slice(1)).toEqual(Array(7).fill(BARS_PER_DAY)); // the first day is partial (starts 19:00 ET)
    expect(counts[0]).toBe(BARS_PER_DAY - 60);
  });

  it('handles the fall back week (Sun 2024-11-03): Sunday 18:00 EST is 23:00Z', () => {
    const start = utc('2024-10-28T22:00:00Z'); // Mon 18:00 EDT opens Tuesday's day
    const bars = generateSyntheticBars({ root: 'ES', start, days: 8, seed: 6 });
    expect(bars.every((b) => isOpenMinute(b.time))).toBe(true);
    const fri = bars.findIndex((b) => b.time === utc('2024-11-01T20:59:00Z')); // Fri 16:59 EDT
    expect(bars[fri + 1]!.time).toBe(utc('2024-11-03T23:00:00Z')); // Sun 18:00 EST
    const days = new Map<string, number>();
    for (const b of bars) days.set(tradingDay(b.time), (days.get(tradingDay(b.time)) ?? 0) + 1);
    expect([...days.values()]).toEqual(Array(8).fill(BARS_PER_DAY));
  });

  it('is continuous across days: the next day opens close to the previous close', () => {
    const bars = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 20, seed: 8 });
    let worst = 0;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.time - bars[i - 1]!.time > 60) worst = Math.max(worst, Math.abs(bars[i]!.open / bars[i - 1]!.close - 1));
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe('generateSyntheticBars: market character (60 NQ trading days, seed 21)', () => {
  const bars = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 60, seed: 21 });
  const minuteOfDay = (b: Bar) => {
    const p = etParts(b.time);
    return p.hour * 60 + p.minute;
  };
  const meanOver = (from: number, to: number, f: (b: Bar, i: number) => number) => {
    // [from, to) in ET minutes of the day, wrapping past midnight when from > to
    let sum = 0;
    let n = 0;
    bars.forEach((b, i) => {
      const m = minuteOfDay(b);
      const inside = from <= to ? m >= from && m < to : m >= from || m < to;
      if (inside) {
        sum += f(b, i);
        n++;
      }
    });
    return sum / n;
  };
  const rangePct = (b: Bar) => (b.high - b.low) / b.open;
  const H = (h: number, m = 0) => h * 60 + m;

  it('session shaped volatility: quiet Asia < active London < busiest 09:30 to 11:00 ET', () => {
    const asia = meanOver(H(18), H(3), rangePct);
    const london = meanOver(H(3), H(9, 30), rangePct);
    const peak = meanOver(H(9, 30), H(11), rangePct);
    const lateNy = meanOver(H(11), H(17), rangePct);
    expect(london).toBeGreaterThan(asia * 1.3);
    expect(peak).toBeGreaterThan(london * 1.4);
    expect(peak).toBeGreaterThan(lateNy * 1.3);
  });

  it('the documented multiplier agrees: Asia lowest, 09:30 to 11:00 highest', () => {
    const avg = (from: number, to: number) => {
      let s = 0;
      let n = 0;
      for (let m = from; m < to; m++, n++) s += sessionVolMultiplier(m);
      return s / n;
    };
    expect(avg(H(18), H(24))).toBeLessThan(avg(H(3), H(9, 30)));
    expect(avg(H(3), H(9, 30))).toBeLessThan(avg(H(9, 30), H(11)));
    expect(avg(H(11), H(17))).toBeLessThan(avg(H(9, 30), H(11)));
  });

  it('U shaped intraday volume: heavy open, light midday, heavier into the close; Asia lightest', () => {
    const vol = (b: Bar) => b.volume;
    const open = meanOver(H(9, 30), H(10), vol);
    const mid = meanOver(H(12), H(13, 30), vol);
    const close = meanOver(H(15), H(16), vol);
    const asia = meanOver(H(20), H(23), vol);
    expect(open).toBeGreaterThan(mid * 1.8);
    expect(close).toBeGreaterThan(mid * 1.2);
    expect(asia).toBeLessThan(mid);
  });

  it('volatility clusters: |returns| (net of the session profile) are positively autocorrelated', () => {
    const z: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.time - bars[i - 1]!.time !== 60) continue; // skip day boundaries
      z.push(Math.abs(Math.log(bars[i]!.close / bars[i - 1]!.close)) / sessionVolMultiplier(minuteOfDay(bars[i]!)));
    }
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    const v = z.reduce((a, b) => a + (b - mean) ** 2, 0) / z.length;
    const ac = (lag: number) => z.reduce((a, _, i) => (i >= lag ? a + (z[i]! - mean) * (z[i - lag]! - mean) : a), 0) / ((z.length - lag) * v);
    expect(ac(1)).toBeGreaterThan(0.1);
    expect(ac(5)).toBeGreaterThan(0.05);
    expect(ac(30)).toBeGreaterThan(0.01);
  });

  it('trends persist: variance of 60 minute returns is well above 60x the 1 minute variance (random walk = 1.0)', () => {
    const closes = bars.map((b) => b.close);
    let v1 = 0;
    let n1 = 0;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.time - bars[i - 1]!.time !== 60) continue;
      v1 += Math.log(closes[i]! / closes[i - 1]!) ** 2;
      n1++;
    }
    v1 /= n1;
    let v60 = 0;
    let n60 = 0;
    for (let i = 60; i < bars.length; i++) {
      if (bars[i]!.time - bars[i - 60]!.time !== 3600) continue;
      v60 += Math.log(closes[i]! / closes[i - 60]!) ** 2;
      n60++;
    }
    expect(v60 / n60 / (60 * v1)).toBeGreaterThan(1.1);
  });

  it('has both trending and ranging regimes, and they behave differently', () => {
    const { bars: sb, regimes } = generateSyntheticSeries({ root: 'NQ', start: SUN_OPEN, days: 60, seed: 21 });
    expect(sb).toHaveLength(regimes.length);
    const share = (r: number) => regimes.filter((x) => x === r).length / regimes.length;
    expect(share(1)).toBeGreaterThan(0.08); // up trends
    expect(share(-1)).toBeGreaterThan(0.08); // down trends
    expect(share(0)).toBeGreaterThan(0.3); // ranges
    // efficiency (net move / path length) of regime stretches that lasted at least 30 minutes
    const trend: number[] = [];
    const range: number[] = [];
    const upNet: number[] = [];
    const downNet: number[] = [];
    for (let i = 0; i < regimes.length; ) {
      let j = i;
      while (j + 1 < regimes.length && regimes[j + 1] === regimes[i]) j++;
      if (j - i >= 29) {
        let path = 0;
        for (let k = i + 1; k <= j; k++) path += Math.abs(sb[k]!.close - sb[k - 1]!.close);
        const net = sb[j]!.close - sb[i]!.close;
        if (path > 0) (regimes[i] === 0 ? range : trend).push(Math.abs(net) / path);
        if (regimes[i] === 1) upNet.push(net);
        if (regimes[i] === -1) downNet.push(net);
      }
      i = j + 1;
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(trend.length).toBeGreaterThan(50);
    expect(range.length).toBeGreaterThan(50);
    expect(mean(trend)).toBeGreaterThan(mean(range) * 2.5);
    expect(mean(upNet)).toBeGreaterThan(0);
    expect(mean(downNet)).toBeLessThan(0);
  });

  it('daily moves look like an index future: 0.5% to 2.5% daily close to close volatility', () => {
    const byDay = new Map<string, number>();
    for (const b of bars) byDay.set(tradingDay(b.time), b.close);
    const closes = [...byDay.values()];
    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    expect(sd).toBeGreaterThan(0.005);
    expect(sd).toBeLessThan(0.025);
  });

  it('price stays in a sane band', () => {
    const lo = Math.min(...bars.map((b) => b.low));
    const hi = Math.max(...bars.map((b) => b.high));
    expect(lo).toBeGreaterThan(21000 * 0.6);
    expect(hi).toBeLessThan(21000 * 1.6);
  });

  it('generates 100k bars quickly', () => {
    const t0 = Date.now();
    const many = generateSyntheticBars({ root: 'NQ', start: SUN_OPEN, days: 73, seed: 99 });
    expect(many.length).toBeGreaterThan(100_000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
