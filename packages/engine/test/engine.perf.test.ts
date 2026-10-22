import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/aggregate';
import { ReplayEngine } from '../src/engine';
import { generateSyntheticBars } from '../src/synthetic';
import { bucketStart } from '../src/time';
import { NQ, utc } from './helpers';

// The UI calls getVisibleBars once per frame at up to 20 bars/s over ~100k 1m bars.
const bars = generateSyntheticBars({ root: 'NQ', start: utc('2024-01-07T23:00:00Z'), days: 42, seed: 1 }); // 57,960 bars

describe('performance: step + getVisibleBars every bar', () => {
  it('steps 50,000 bars calling getVisibleBars("5m") after each, in a sane time and with correct candles', () => {
    expect(bars.length).toBeGreaterThan(50_000);
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    const t0 = Date.now();
    let last = 0;
    for (let i = 1; i <= 50_000; i++) {
      e.step();
      const v = e.getVisibleBars('5m');
      last = v.length;
      if (i % 12_500 === 0) {
        // spot check against a from scratch aggregation of exactly the revealed bars
        expect(v).toEqual(aggregate(bars.slice(0, i + 1), '5m'));
      }
    }
    const ms = Date.now() - t0;
    expect(last).toBeGreaterThan(8_000);
    expect(e.getVisibleBars('5m').at(-1)!.time).toBe(bucketStart(e.cursorTime, '5m'));
    expect(ms).toBeLessThan(5_000); // typically well under a second
  });

  it('every timeframe stays cheap: 4h and 1D (Intl based buckets) over 50,000 bars', () => {
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    const t0 = Date.now();
    for (let i = 1; i <= 50_000; i++) {
      e.step();
      if (i % 5 === 0) {
        e.getVisibleBars('4h');
        e.getVisibleBars('1D');
        e.getVisibleBars('15m');
      }
    }
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(e.getVisibleBars('1D')).toEqual(aggregate(bars.slice(0, 50_001), '1D'));
    expect(e.getVisibleBars('4h')).toEqual(aggregate(bars.slice(0, 50_001), '4h'));
  });

  it('1m view over a long history is just a slice', () => {
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[40_000]!.time });
    const t0 = Date.now();
    for (let i = 0; i < 5_000; i++) {
      e.step();
      expect(e.getVisibleBars('1m').length).toBe(40_001 + i + 1);
    }
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('stepTo over the whole file with an open order book is linear', () => {
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const t0 = Date.now();
    e.stepTo(bars[bars.length - 1]!.time);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(e.isAtEnd()).toBe(true);
    expect(e.trades).toHaveLength(1);
    expect(e.trades[0]!.exitReason).toBe('end_of_data');
  });
});
