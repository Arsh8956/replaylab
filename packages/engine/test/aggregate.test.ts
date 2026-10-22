import { describe, expect, it } from 'vitest';
import { CandleSeries, aggregate } from '../src/aggregate';
import { EngineError } from '../src/errors';
import type { Bar } from '../src/types';
import { barsFrom, utc } from './helpers';

// Nine 1m bars, 10:00 to 10:08 ET (15:00Z to 15:08Z, EST). Volume is 10, 20, ... 90.
const T = utc('2024-01-02T15:00:00Z');
const nine = barsFrom(T, [
  [100, 102, 99, 101, 10],
  [101, 103, 100, 102, 20],
  [102, 104, 101, 103, 30],
  [103, 105, 102, 104, 40],
  [104, 106, 103, 105, 50],
  [105, 107, 104, 106, 60],
  [106, 108, 105, 107, 70],
  [107, 109, 106, 108, 80],
  [108, 110, 107, 109, 90],
]);

const c = (time: number, open: number, high: number, low: number, close: number, volume: number): Bar => ({ time, open, high, low, close, volume });

describe('aggregate: golden candles', () => {
  it('1m returns equal copies', () => {
    const out = aggregate(nine, '1m');
    expect(out).toEqual(nine);
    expect(out[0]).not.toBe(nine[0]);
  });

  it('3m: open of first, max high, min low, close of last, summed volume', () => {
    expect(aggregate(nine, '3m')).toEqual([
      c(T, 100, 104, 99, 103, 60), // bars 0-2
      c(T + 180, 103, 107, 102, 106, 150), // bars 3-5
      c(T + 360, 106, 110, 105, 109, 240), // bars 6-8
    ]);
  });

  it('5m', () => {
    expect(aggregate(nine, '5m')).toEqual([
      c(T, 100, 106, 99, 105, 150), // bars 0-4
      c(T + 300, 105, 110, 104, 109, 300), // bars 5-8
    ]);
  });

  it('15m, 30m and 1h collapse the nine bars into one candle', () => {
    for (const tf of ['15m', '30m', '1h'] as const) {
      expect(aggregate(nine, tf), tf).toEqual([c(T, 100, 110, 99, 109, 450)]);
    }
  });

  it('does not mutate its input and returns an empty list for no bars', () => {
    const copy = JSON.parse(JSON.stringify(nine));
    aggregate(nine, '5m');
    expect(nine).toEqual(copy);
    expect(aggregate([], '1D')).toEqual([]);
  });

  it('rejects unsorted or duplicate input', () => {
    expect(() => aggregate([nine[1]!, nine[0]!], '5m')).toThrow(EngineError);
    expect(() => aggregate([nine[0]!, nine[0]!], '5m')).toThrow(EngineError);
  });
});

describe('aggregate: missing 1m bars are skipped, never invented', () => {
  it('a thin bucket is built from what exists', () => {
    const thin = [nine[0]!, nine[4]!]; // 10:00 and 10:04, both in the 5m bucket 10:00; 3m buckets 10:00 and 10:03
    expect(aggregate(thin, '5m')).toEqual([c(T, 100, 106, 99, 105, 60)]);
    expect(aggregate(thin, '3m')).toEqual([c(T, 100, 102, 99, 101, 10), c(T + 180, 104, 106, 103, 105, 50)]);
  });

  it('an entirely missing bucket produces no candle (no zero volume filler)', () => {
    const gap = [nine[0]!, nine[1]!, nine[2]!, nine[6]!, nine[7]!, nine[8]!]; // 10:03 to 10:05 absent
    const out = aggregate(gap, '3m');
    expect(out.map((x) => x.time)).toEqual([T, T + 360]);
    expect(out).toEqual([c(T, 100, 104, 99, 103, 60), c(T + 360, 106, 110, 105, 109, 240)]);
  });
});

describe('aggregate: 4h and 1D anchored at 18:00 ET across the spring DST switch (Sun 2024-03-10)', () => {
  const at = (iso: string, o: number, h: number, l: number, cl: number, v: number): Bar => c(utc(iso), o, h, l, cl, v);
  const week: Bar[] = [
    at('2024-03-08T21:58:00Z', 100, 105, 98, 104, 1), // Fri 16:58 EST
    at('2024-03-08T21:59:00Z', 104, 106, 103, 105, 2), // Fri 16:59 EST, last bar of Friday's day
    at('2024-03-10T22:00:00Z', 110, 112, 109, 111, 3), // Sun 18:00 EDT, opens Monday's day
    at('2024-03-10T22:01:00Z', 111, 115, 110, 114, 4), // Sun 18:01 EDT
    at('2024-03-11T13:30:00Z', 114, 120, 113, 119, 5), // Mon 09:30 EDT
    at('2024-03-11T20:59:00Z', 119, 121, 118, 120, 6), // Mon 16:59 EDT
    at('2024-03-11T22:00:00Z', 122, 125, 121, 124, 7), // Mon 18:00 EDT, opens Tuesday's day
  ];

  it('1D: one candle per trading day, time = 18:00 ET start (23:00Z in EST, 22:00Z in EDT)', () => {
    expect(aggregate(week, '1D')).toEqual([
      c(utc('2024-03-07T23:00:00Z'), 100, 106, 98, 105, 3),
      c(utc('2024-03-10T22:00:00Z'), 110, 121, 109, 120, 18), // 3+4+5+6
      c(utc('2024-03-11T22:00:00Z'), 122, 125, 121, 124, 7),
    ]);
  });

  it('4h: 14:00 ET bucket is cut at the halt, Sunday 18:00 EDT opens a fresh bucket', () => {
    expect(aggregate(week, '4h')).toEqual([
      c(utc('2024-03-08T19:00:00Z'), 100, 106, 98, 105, 3), // Fri 14:00 EST bucket
      c(utc('2024-03-10T22:00:00Z'), 110, 115, 109, 114, 7), // Sun 18:00 EDT bucket (bars 3 and 4)
      c(utc('2024-03-11T10:00:00Z'), 114, 120, 113, 119, 5), // Mon 06:00 EDT bucket, holds 09:30
      c(utc('2024-03-11T18:00:00Z'), 119, 121, 118, 120, 6), // Mon 14:00 EDT bucket
      c(utc('2024-03-11T22:00:00Z'), 122, 125, 121, 124, 7), // Mon 18:00 EDT bucket
    ]);
  });
});

describe('CandleSeries (incremental builder)', () => {
  it('keeps completed candles and exposes the last one as it grows', () => {
    const s = new CandleSeries('5m');
    for (let i = 0; i < 3; i++) s.push(nine[i]!);
    expect(s.candles()).toEqual([c(T, 100, 104, 99, 103, 60)]); // partial 10:00 candle from bars 0-2 only
    for (let i = 3; i < 6; i++) s.push(nine[i]!);
    expect(s.candles()).toEqual([c(T, 100, 106, 99, 105, 150), c(T + 300, 105, 107, 104, 106, 60)]);
  });

  it('candles() snapshots are independent of later pushes', () => {
    const s = new CandleSeries('5m');
    s.push(nine[0]!);
    const before = s.candles();
    s.push(nine[1]!);
    expect(before).toEqual([c(T, 100, 102, 99, 101, 10)]);
  });

  it('matches aggregate() after every push, for every timeframe', () => {
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const) {
      const s = new CandleSeries(tf);
      nine.forEach((b, i) => {
        s.push(b);
        expect(s.candles(), `${tf} after ${i + 1} bars`).toEqual(aggregate(nine.slice(0, i + 1), tf));
      });
    }
  });
});
