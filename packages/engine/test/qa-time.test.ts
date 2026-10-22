// QA: time. DST weeks, Sunday open, the 17:00 to 18:00 ET halt, 4h and 1D anchors, missing 1m bars, and the
// synthetic generator's calendar. Expectations come from an independent New York model (US DST rules, no Intl)
// and from hand computed UTC instants.
import { describe, expect, it } from 'vitest';
import { CONTRACTS, EngineError, ReplayEngine, aggregate, bucketStart, generateSyntheticBars, tradingDay } from '../src/index';
import type { Bar, Timeframe } from '../src/index';
import { etOffset, etWall, lcg, px, refAggregate, refBucket, refTradingDay, tk } from './qa-support';
import { NQ, utc } from './helpers';

const TFS: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];

/** The wall clock hours around a DST Sunday where New York has no trading and the offset flips (skip exact comparisons there). */
function inChangeWindow(t: number): boolean {
  const w = etWall(t);
  if (w.weekday !== 0) return false;
  return w.hour < 4; // Sunday 00:00 to 04:00 local: nonexistent or repeated hour lives here
}

// Spring forward 2023-03-12, 2024-03-10, 2025-03-09. Fall back 2023-11-05, 2024-11-03, 2025-11-02.
const WEEKS: [string, string][] = [
  ['2023-03-08T00:00:00Z', '2023-03-16T00:00:00Z'],
  ['2023-11-01T00:00:00Z', '2023-11-09T00:00:00Z'],
  ['2024-03-06T00:00:00Z', '2024-03-14T00:00:00Z'],
  ['2024-10-30T00:00:00Z', '2024-11-07T00:00:00Z'],
  ['2025-03-05T00:00:00Z', '2025-03-13T00:00:00Z'],
  ['2025-10-29T00:00:00Z', '2025-11-06T00:00:00Z'],
];

describe('bucketStart and tradingDay across DST weeks agree with an independent New York model', () => {
  for (const [from, to] of WEEKS) {
    it(`every minute from ${from.slice(0, 10)} to ${to.slice(0, 10)}: 3m..1h, 4h, 1D and tradingDay`, () => {
      let compared = 0;
      for (let t = utc(from); t < utc(to); t += 60) {
        if (inChangeWindow(t)) continue;
        for (const tf of (t % 420 === 0 ? TFS : (['4h', '1D'] as Timeframe[]))) {
          const got = bucketStart(t, tf);
          const want = refBucket(t, tf);
          if (got !== want) throw new Error(`${tf} at ${new Date(t * 1000).toISOString()}: engine ${new Date(got * 1000).toISOString()}, expected ${new Date(want * 1000).toISOString()}`);
        }
        const td = tradingDay(t);
        if (td !== refTradingDay(t)) throw new Error(`tradingDay at ${new Date(t * 1000).toISOString()}: ${td} vs ${refTradingDay(t)}`);
        compared++;
      }
      expect(compared).toBeGreaterThan(10000);
    });
  }

  it('in the nonexistent and repeated hours the buckets are still sane: <= t, idempotent, never decreasing', () => {
    for (const day of ['2024-03-10', '2024-11-03', '2023-03-12', '2023-11-05']) {
      let prev: Record<string, number> = {};
      for (let t = utc(`${day}T00:00:00Z`) - 3 * 3600; t < utc(`${day}T12:00:00Z`); t += 60) {
        for (const tf of TFS) {
          const b = bucketStart(t, tf);
          expect(b).toBeLessThanOrEqual(t);
          expect(bucketStart(b, tf), `${tf} idempotent at ${t}`).toBe(b);
          if (prev[tf] !== undefined) expect(b, `${tf} monotone at ${new Date(t * 1000).toISOString()}`).toBeGreaterThanOrEqual(prev[tf]!);
          prev[tf] = b;
        }
      }
    }
  });

  it('sampled every 29 minutes over 2020 to 2027: 4h and 1D match the model outside the change windows', () => {
    let n = 0;
    for (let t = utc('2020-01-01T00:00:00Z'); t < utc('2027-01-01T00:00:00Z'); t += 29 * 60) {
      if (inChangeWindow(t)) continue;
      for (const tf of ['4h', '1D'] as const) {
        const got = bucketStart(t, tf);
        const want = refBucket(t, tf);
        if (got !== want) throw new Error(`${tf} at ${new Date(t * 1000).toISOString()}: ${got} vs ${want}`);
      }
      if (tradingDay(t) !== refTradingDay(t)) throw new Error(`tradingDay at ${t}`);
      n++;
    }
    expect(n).toBeGreaterThan(100_000);
  }, 60_000);
});

describe('hand computed anchors (UTC instants worked out on paper)', () => {
  it('spring forward week 2024: Sunday 18:00 EDT opens Monday, the Friday before was still EST', () => {
    const sunOpen = utc('2024-03-10T22:00:00Z'); // 18:00 EDT
    const friLast = utc('2024-03-08T21:59:00Z'); // 16:59 EST
    expect(bucketStart(sunOpen, '1D')).toBe(sunOpen);
    expect(bucketStart(sunOpen + 3600, '1D')).toBe(sunOpen);
    expect(bucketStart(sunOpen, '4h')).toBe(sunOpen);
    expect(bucketStart(utc('2024-03-11T05:59:00Z'), '4h')).toBe(utc('2024-03-11T02:00:00Z')); // 01:59 EDT -> 22:00 EDT bucket
    expect(bucketStart(utc('2024-03-11T05:59:00Z'), '4h')).toBe(sunOpen + 4 * 3600);
    expect(bucketStart(utc('2024-03-11T06:00:00Z'), '4h')).toBe(utc('2024-03-11T06:00:00Z')); // 02:00 EDT
    expect(bucketStart(utc('2024-03-11T14:00:00Z'), '4h')).toBe(utc('2024-03-11T14:00:00Z')); // 10:00 EDT
    expect(bucketStart(utc('2024-03-11T20:59:00Z'), '4h')).toBe(utc('2024-03-11T18:00:00Z')); // 16:59 EDT -> 14:00 EDT
    expect(bucketStart(friLast, '1D')).toBe(utc('2024-03-07T23:00:00Z')); // Friday's day began Thu 18:00 EST
    expect(bucketStart(friLast, '4h')).toBe(utc('2024-03-08T19:00:00Z')); // 14:00 EST
    expect(tradingDay(sunOpen)).toBe('2024-03-11');
    expect(tradingDay(friLast)).toBe('2024-03-08');
    expect(tradingDay(sunOpen - 1)).toBe('2024-03-10'); // 17:59:59 EDT Sunday belongs to the (empty) Sunday trading day
  });

  it('fall back week 2024: Sunday 18:00 EST opens Monday, the Friday before was EDT', () => {
    const sunOpen = utc('2024-11-03T23:00:00Z'); // 18:00 EST
    const friLast = utc('2024-11-01T20:59:00Z'); // 16:59 EDT
    expect(bucketStart(sunOpen, '1D')).toBe(sunOpen);
    expect(bucketStart(utc('2024-11-04T07:00:00Z'), '4h')).toBe(utc('2024-11-04T07:00:00Z')); // 02:00 EST
    expect(bucketStart(utc('2024-11-04T06:59:00Z'), '4h')).toBe(utc('2024-11-04T03:00:00Z')); // 01:59 EST -> 22:00 EST Sunday
    expect(bucketStart(friLast, '1D')).toBe(utc('2024-10-31T22:00:00Z')); // Thu 18:00 EDT
    expect(bucketStart(friLast, '4h')).toBe(utc('2024-11-01T18:00:00Z')); // 14:00 EDT
    expect(tradingDay(sunOpen)).toBe('2024-11-04');
    expect(tradingDay(friLast)).toBe('2024-11-01');
  });

  it('the halt: 17:00 to 17:59 ET belongs to the day that just ended, 18:00 starts the next', () => {
    const wed1659 = utc('2024-01-10T21:59:00Z');
    const wed1700 = utc('2024-01-10T22:00:00Z');
    const wed1759 = utc('2024-01-10T22:59:00Z');
    const wed1800 = utc('2024-01-10T23:00:00Z');
    expect(tradingDay(wed1659)).toBe('2024-01-10');
    expect(tradingDay(wed1700)).toBe('2024-01-10');
    expect(tradingDay(wed1759)).toBe('2024-01-10');
    expect(tradingDay(wed1800)).toBe('2024-01-11');
    expect(bucketStart(wed1759, '1D')).toBe(utc('2024-01-09T23:00:00Z'));
    expect(bucketStart(wed1800, '1D')).toBe(wed1800);
    expect(bucketStart(wed1759, '4h')).toBe(utc('2024-01-10T19:00:00Z')); // the 14:00 candle keeps the halt minutes
    expect(bucketStart(wed1800, '4h')).toBe(wed1800);
  });

  it('weekend instants never throw and keep the Friday candle open until the Sunday open', () => {
    const satNoon = utc('2024-01-06T17:00:00Z');
    expect(() => bucketStart(satNoon, '1D')).not.toThrow();
    expect(tradingDay(satNoon)).toBe('2024-01-06');
    expect(bucketStart(satNoon, '1D')).toBe(utc('2024-01-05T23:00:00Z')); // Fri 18:00 ET starts the (empty) Saturday day
    expect(tradingDay(utc('2024-01-07T22:59:00Z'))).toBe('2024-01-07'); // Sunday 17:59 ET
    expect(tradingDay(utc('2024-01-07T23:00:00Z'))).toBe('2024-01-08'); // Sunday 18:00 ET: Monday's trading day
  });

  it('1m to 1h buckets are epoch aligned straight through a DST change', () => {
    for (const t of [utc('2024-03-10T22:07:31Z'), utc('2024-11-03T23:44:59Z'), utc('2024-03-10T06:59:59Z')]) {
      expect(bucketStart(t, '1h')).toBe(Math.floor(t / 3600) * 3600);
      expect(bucketStart(t, '30m')).toBe(Math.floor(t / 1800) * 1800);
      expect(bucketStart(t, '1m')).toBe(Math.floor(t / 60) * 60);
    }
  });
});

describe('aggregation with missing 1m bars and partial candles', () => {
  it('missing minutes are skipped, never filled: the candle opens with the first bar that exists', () => {
    const t0 = utc('2024-01-09T23:00:00Z'); // Tue 18:00 ET
    const bars: Bar[] = [
      { time: t0 + 7 * 60, open: 10, high: 12, low: 9, close: 11, volume: 5 },
      { time: t0 + 9 * 60, open: 11, high: 15, low: 8, close: 14, volume: 7 },
      { time: t0 + 3 * 3600 + 59 * 60, open: 14, high: 14, low: 13, close: 13, volume: 1 },
      { time: t0 + 4 * 3600, open: 13, high: 20, low: 13, close: 19, volume: 2 },
    ];
    const four = aggregate(bars, '4h');
    expect(four).toEqual([
      { time: t0, open: 10, high: 15, low: 8, close: 13, volume: 13 },
      { time: t0 + 4 * 3600, open: 13, high: 20, low: 13, close: 19, volume: 2 },
    ]);
    expect(aggregate(bars, '5m')).toEqual([
      { time: t0 + 5 * 60, open: 10, high: 15, low: 8, close: 14, volume: 12 },
      { time: t0 + 3 * 3600 + 55 * 60, open: 14, high: 14, low: 13, close: 13, volume: 1 },
      { time: t0 + 4 * 3600, open: 13, high: 20, low: 13, close: 19, volume: 2 },
    ]);
    expect(aggregate(bars, '1D')).toEqual([{ time: t0, open: 10, high: 20, low: 8, close: 19, volume: 15 }]);
  });

  it('an hours long hole in the data does not create empty candles', () => {
    const t0 = utc('2024-01-09T23:00:00Z');
    const bars: Bar[] = [0, 1, 2, 600, 601].map((m, i) => ({ time: t0 + m * 60, open: 100 + i, high: 101 + i, low: 99, close: 100, volume: 1 }));
    const c = aggregate(bars, '1h');
    expect(c.map((x) => x.time)).toEqual([t0, t0 + 10 * 3600]);
    expect(aggregate(bars, '4h').map((x) => x.time)).toEqual([t0, t0 + 8 * 3600]);
  });

  it('engine candles at every cursor equal an independent aggregation of the revealed bars only, across a DST week with holes', () => {
    const rand = lcg(77);
    const all = generateSyntheticBars({ root: 'NQ', start: utc('2024-03-07T00:00:00Z'), days: 6, seed: 5 });
    // punch holes: drop ~3% of minutes plus a 2 hour outage
    const outageStart = all[3000]!.time;
    const bars = all.filter((b) => rand() > 0.03 && !(b.time >= outageStart && b.time < outageStart + 7200));
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[10]!.time });
    // the model grows one revealed bar at a time, independently per timeframe
    const model: Record<string, Bar[]> = {};
    for (const tf of TFS) model[tf] = refAggregate(bars.slice(0, 11), tf);
    let at = 10;
    let checks = 0;
    for (let i = 10; i < bars.length - 1; i += 1 + (i % 11)) {
      e.stepTo(bars[i]!.time);
      for (; at < i; at++) {
        for (const tf of TFS) {
          const next = refAggregate([bars[at + 1]!], tf)[0]!;
          const list = model[tf]!;
          const last = list[list.length - 1]!;
          if (last.time === next.time) {
            last.high = Math.max(last.high, next.high);
            last.low = Math.min(last.low, next.low);
            last.close = next.close;
            last.volume += next.volume;
          } else list.push(next);
        }
      }
      for (const tf of TFS) {
        const got = e.getVisibleBars(tf);
        const want = model[tf]!;
        const tail = Math.min(4, want.length);
        if (got.length !== want.length || JSON.stringify(got.slice(-tail)) !== JSON.stringify(want.slice(-tail))) {
          throw new Error(`${tf} differs at cursor ${i} (${new Date(bars[i]!.time * 1000).toISOString()})`);
        }
        if (checks % 40 === 0) expect(got, `${tf} full history at cursor ${i}`).toEqual(want);
      }
      checks++;
    }
    expect(checks).toBeGreaterThan(300);
  }, 60_000);

  it('the partial candle shrinks to nothing but the revealed part: high, low, close and volume stop at the cursor', () => {
    const t0 = utc('2024-01-09T23:00:00Z');
    const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({ time: t0 + i * 60, open: 100, high: 100 + i, low: 100 - i, close: 100 + (i % 2), volume: 10 }));
    const e = new ReplayEngine({ bars, contract: NQ, startTime: t0 });
    e.step(2); // bars 0..2 revealed (minutes 0,1,2)
    expect(e.getVisibleBars('5m')).toEqual([{ time: t0, open: 100, high: 102, low: 98, close: 100, volume: 30 }]);
    expect(e.getVisibleBars('1D')).toEqual([{ time: t0, open: 100, high: 102, low: 98, close: 100, volume: 30 }]);
    e.step(3); // minute 5: a new 5m candle begins
    const five = e.getVisibleBars('5m');
    expect(five).toHaveLength(2);
    expect(five[0]).toEqual({ time: t0, open: 100, high: 104, low: 96, close: 100, volume: 50 });
    expect(five[1]).toEqual({ time: t0 + 300, open: 100, high: 105, low: 95, close: 101, volume: 10 });
  });
});

describe('step(n, tf) against an independent reading of SPEC section 5 Stepping', () => {
  /** n candles complete; the partial candle counts as the first; a candle is complete when the next bar opens a new bucket or data ends. */
  function refStep(bars: Bar[], cursor: number, n: number, tf: string): number {
    let i = cursor;
    let done = 0;
    while (done < n && i < bars.length - 1) {
      i++;
      if (i === bars.length - 1 || refBucket(bars[i + 1]!.time, tf) !== refBucket(bars[i]!.time, tf)) done++;
    }
    return i;
  }

  it('random tf steps over a DST weekend with missing bars land on the same bar as the model', () => {
    const rand = lcg(4242);
    const all = generateSyntheticBars({ root: 'ES', start: utc('2024-03-07T00:00:00Z'), days: 6, seed: 9 });
    const bars = all.filter(() => rand() > 0.02);
    const e = new ReplayEngine({ bars, contract: CONTRACTS['ES']!, startTime: bars[0]!.time });
    let cursor = 0;
    const tfs: Timeframe[] = ['3m', '5m', '15m', '30m', '1h', '4h', '1D'];
    for (let k = 0; k < 400 && cursor < bars.length - 1; k++) {
      const tf = tfs[Math.floor(rand() * tfs.length)]!;
      const n = 1 + Math.floor(rand() * 3);
      cursor = refStep(bars, cursor, n, tf);
      e.step(n, tf);
      expect(e.cursorTime, `step ${k}: step(${n}, ${tf})`).toBe(bars[cursor]!.time);
    }
    expect(cursor).toBeGreaterThan(1000);
  });

  it('stepping 1D from Friday afternoon completes the Friday candle at 16:59 and not before; the Sunday open starts the next', () => {
    const bars = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-08T00:00:00Z'), days: 7, seed: 3 });
    const fri1630 = bars.findIndex((b) => b.time === utc('2024-01-12T21:30:00Z'));
    expect(fri1630).toBeGreaterThan(0);
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[fri1630]!.time });
    e.step(1, '1D');
    expect(e.cursorTime).toBe(utc('2024-01-12T21:59:00Z')); // last bar of Friday
    e.step(1, '1D');
    const sat = bars.findIndex((b) => b.time > utc('2024-01-12T21:59:00Z'));
    expect(bars[sat]!.time).toBe(utc('2024-01-14T23:00:00Z')); // Sunday 18:00 ET
    expect(e.getVisibleBars('1D').at(-1)!.time).toBe(utc('2024-01-14T23:00:00Z'));
  });
});

describe('synthetic generator calendar (SPEC section 2): no bars in the halt or the weekend, in any DST week', () => {
  const starts = ['2024-03-04T00:00:00Z', '2024-03-08T20:00:00Z', '2024-10-28T00:00:00Z', '2024-11-01T19:00:00Z', '2023-03-10T12:00:00Z', '2025-10-31T12:00:00Z'];
  for (const root of ['NQ', 'CL']) {
    for (const s of starts) {
      it(`${root} from ${s}: every bar is inside a weekday 18:00 to 17:00 ET session, minute aligned, ascending`, () => {
        const bars = generateSyntheticBars({ root, start: utc(s), days: 12, seed: 11 });
        expect(bars.length).toBeGreaterThan(1000);
        let prev = 0;
        for (const b of bars) {
          const w = etWall(b.time);
          const minuteOfDay = w.hour * 60 + w.minute;
          const inHalt = minuteOfDay >= 17 * 60 && minuteOfDay < 18 * 60;
          const fri = w.weekday === 5 && minuteOfDay >= 17 * 60;
          const sat = w.weekday === 6;
          const sun = w.weekday === 0 && minuteOfDay < 18 * 60;
          if (inHalt || fri || sat || sun) throw new Error(`bar at ${new Date(b.time * 1000).toISOString()} (${w.hour}:${w.minute} ET weekday ${w.weekday}) is outside trading hours`);
          expect(b.time % 60).toBe(0);
          expect(b.time).toBeGreaterThan(prev);
          prev = b.time;
        }
        expect(bars[0]!.time).toBeGreaterThanOrEqual(utc(s));
      });
    }
  }

  it('full trading days have exactly 23 hours (1380 bars) in every week, DST or not, and the first bar of the week is Sunday 18:00 ET', () => {
    for (const s of ['2024-03-08T00:00:00Z', '2024-11-01T00:00:00Z', '2024-01-05T00:00:00Z']) {
      const bars = generateSyntheticBars({ root: 'NQ', start: utc(s), days: 10, seed: 2 });
      const byDay = new Map<string, number>();
      for (const b of bars) byDay.set(tradingDay(b.time), (byDay.get(tradingDay(b.time)) ?? 0) + 1);
      const counts = [...byDay.values()];
      expect(counts.length).toBe(10);
      // days after the first (which may be partial) are complete trading days
      for (const c of counts.slice(1)) expect(c).toBe(1380);
      const days = [...byDay.keys()];
      for (const d of days) expect([1, 2, 3, 4, 5]).toContain(new Date(`${d}T12:00:00Z`).getUTCDay());
      const sundayOpens = bars.filter((b) => etWall(b.time).weekday === 0);
      for (const b of sundayOpens.filter((x, i) => i === 0 || etWall(sundayOpens[i - 1]!.time).day !== etWall(x.time).day)) {
        expect(etWall(b.time).hour * 60 + etWall(b.time).minute).toBe(18 * 60);
      }
    }
  });

  it('a start inside the halt, on a Saturday, or Friday after 18:00 ET begins at the next real open', () => {
    const cases: [string, string][] = [
      ['2024-01-09T22:30:00Z', '2024-01-09T23:00:00Z'], // Tue 17:30 ET halt -> Tue 18:00 ET
      ['2024-01-06T15:00:00Z', '2024-01-07T23:00:00Z'], // Saturday -> Sunday 18:00 ET
      ['2024-01-05T23:30:00Z', '2024-01-07T23:00:00Z'], // Fri 18:30 ET -> Sunday 18:00 ET
      ['2024-03-09T15:00:00Z', '2024-03-10T22:00:00Z'], // Saturday of the DST weekend -> Sunday 18:00 EDT
      ['2024-11-02T15:00:00Z', '2024-11-03T23:00:00Z'], // Saturday of the fall back weekend -> Sunday 18:00 EST
    ];
    for (const [start, first] of cases) {
      const bars = generateSyntheticBars({ root: 'NQ', start: utc(start), days: 2, seed: 1 });
      expect(new Date(bars[0]!.time * 1000).toISOString(), `start ${start}`).toBe(new Date(utc(first) * 1000).toISOString());
    }
  });

  it('prices sit on the tick grid for every root (CL 0.01, RTY 0.1, YM 1), OHLC is valid, volume is a positive integer', () => {
    for (const symbol of ['NQ', 'ES', 'YM', 'RTY', 'CL', 'GC']) {
      const tick = CONTRACTS[symbol]!.tickSize;
      const bars = generateSyntheticBars({ root: symbol, start: utc('2024-03-08T12:00:00Z'), days: 8, seed: 31 });
      for (const b of bars) {
        for (const p of [b.open, b.high, b.low, b.close]) {
          if (p !== px(tk(p, tick), tick)) throw new Error(`${symbol} price ${p} is off the ${tick} grid`);
          if (!(p > 0)) throw new Error(`${symbol} non positive price ${p}`);
        }
        if (!(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close))) throw new Error(`${symbol} bad OHLC at ${b.time}`);
        if (!Number.isInteger(b.volume) || b.volume < 1) throw new Error(`${symbol} volume ${b.volume}`);
      }
    }
  });

  it('is deterministic per seed, different across seeds, and never touches its input options', () => {
    const opts = { root: 'NQ', start: utc('2024-01-08T00:00:00Z'), days: 3, seed: 8 };
    const frozen = Object.freeze({ ...opts });
    const a = generateSyntheticBars(frozen);
    const b = generateSyntheticBars({ ...opts });
    expect(a).toEqual(b);
    expect(generateSyntheticBars({ ...opts, seed: 9 })).not.toEqual(a);
    expect(generateSyntheticBars({ ...opts, days: 0 })).toEqual([]);
  });

  it('volume peaks around the 09:30 ET cash open in both a winter and a summer week (the shape follows ET, not UTC)', () => {
    for (const start of ['2024-01-08T00:00:00Z', '2024-07-08T00:00:00Z']) {
      const bars = generateSyntheticBars({ root: 'ES', start: utc(start), days: 5, seed: 6 });
      const byMinute = new Map<number, { sum: number; n: number }>();
      for (const b of bars) {
        const w = etWall(b.time);
        const m = Math.floor((w.hour * 60 + w.minute) / 30) * 30;
        const cur = byMinute.get(m) ?? { sum: 0, n: 0 };
        cur.sum += b.volume;
        cur.n++;
        byMinute.set(m, cur);
      }
      let best = -1;
      let bestAvg = 0;
      for (const [m, v] of byMinute) if (v.sum / v.n > bestAvg) (bestAvg = v.sum / v.n), (best = m);
      expect(best, `${start}: busiest half hour`).toBe(9 * 60 + 30);
    }
  });

  it('etOffset model self check (guards this file): spring forward and fall back instants', () => {
    expect(etOffset(utc('2024-03-10T06:59:59Z'))).toBe(-18000);
    expect(etOffset(utc('2024-03-10T07:00:00Z'))).toBe(-14400);
    expect(etOffset(utc('2024-11-03T05:59:59Z'))).toBe(-14400);
    expect(etOffset(utc('2024-11-03T06:00:00Z'))).toBe(-18000);
  });
});

describe('aggregate and generateSyntheticBars input handling', () => {
  it('aggregate neither mutates its input nor hands back the input objects, for every timeframe', () => {
    const t0 = utc('2024-01-09T23:00:00Z');
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: t0 + i * 60, open: 100 + i, high: 105 + i, low: 95 + i, close: 101 + i, volume: 3 }));
    const before = JSON.stringify(bars);
    for (const tf of TFS) {
      const out = aggregate(bars, tf);
      for (const c of out) for (const b of bars) expect(c).not.toBe(b);
      for (const c of out) {
        try {
          c.high = 1e9;
        } catch {
          /* frozen candles are fine */
        }
      }
      expect(JSON.stringify(bars)).toBe(before);
    }
    expect(aggregate([], '1D')).toEqual([]);
  });

  it('aggregate refuses unsorted or duplicated bars with an EngineError instead of building nonsense', () => {
    const t0 = utc('2024-01-09T23:00:00Z');
    const a: Bar = { time: t0, open: 1, high: 2, low: 0.5, close: 1, volume: 1 };
    const b: Bar = { ...a, time: t0 + 60 };
    expect(() => aggregate([b, a], '5m')).toThrow(EngineError);
    expect(() => aggregate([a, { ...a }], '5m')).toThrow(EngineError);
  });

  it('generateSyntheticBars honours startPrice (on the tick grid) and rejects nonsense options', () => {
    const base = { start: utc('2024-01-08T00:00:00Z'), days: 1, seed: 1 };
    expect(generateSyntheticBars({ ...base, root: 'NQ', startPrice: 21000.1 })[0]!.open).toBe(21000);
    expect(generateSyntheticBars({ ...base, root: 'CL', startPrice: 70.123 })[0]!.open).toBe(70.12);
    expect(generateSyntheticBars({ ...base, root: 'MNQ' })[0]!.open).toBe(21000); // a micro uses its root's profile
    for (const bad of [{ root: 'XX' }, { root: 'NQ', days: -1 }, { root: 'NQ', days: 1.5 }, { root: 'NQ', startPrice: 0 }, { root: 'NQ', startPrice: -5 }, { root: 'NQ', start: NaN }]) {
      expect(() => generateSyntheticBars({ ...base, ...bad })).toThrow(EngineError);
    }
  });

  it('nearby seeds give clearly different paths (no accidental correlation between seed 1 and seed 2)', () => {
    const a = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-08T00:00:00Z'), days: 2, seed: 1 });
    const b = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-08T00:00:00Z'), days: 2, seed: 2 });
    let same = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i]!.close === b[i]!.close) same++;
    expect(same / a.length).toBeLessThan(0.2);
  });
});
