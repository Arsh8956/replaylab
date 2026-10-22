import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/aggregate';
import { ReplayEngine } from '../src/engine';
import { EngineError } from '../src/errors';
import type { Bar, Timeframe } from '../src/types';
import { NQ, T0, utc, walkBars } from './helpers';

/** Bar i of a gentle ramp, 1m apart from `start`: O 100+i, H 102+i, L 99+i, C 101+i, V 10+i. */
function ramp(n: number, start: number = T0): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ time: start + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 + i }));
}
const mk = (bars: Bar[], startTime: number = bars[0]!.time) => new ReplayEngine({ bars, contract: NQ, startTime });
const at = (i: number) => T0 + i * 60;

describe('constructor', () => {
  it('cursor starts at the last bar with time <= startTime', () => {
    const e = mk(ramp(30), at(5) + 30); // between bar 5 and bar 6
    expect(e.cursorTime).toBe(at(5));
    expect(e.lastPrice).toBe(106); // close of bar 5 = 101 + 5
    expect(mk(ramp(30), at(5)).cursorTime).toBe(at(5));
  });
  it('startTime past the end puts the cursor on the last bar', () => {
    const e = mk(ramp(10), at(500));
    expect(e.cursorTime).toBe(at(9));
    expect(e.isAtEnd()).toBe(true);
  });
  it('throws EngineError when no bar is at or before startTime, or there are no bars', () => {
    expect(() => mk(ramp(10), at(0) - 1)).toThrow(EngineError);
    expect(() => mk([], T0)).toThrow(EngineError);
  });
  it('throws on unsorted or duplicate bars', () => {
    const bars = ramp(5);
    expect(() => mk([bars[1]!, bars[0]!, bars[2]!], at(2))).toThrow(EngineError);
    expect(() => mk([bars[0]!, bars[1]!, { ...bars[1]! }], at(2))).toThrow(EngineError);
  });
  it('history before startTime is visible as context, and nothing after it is', () => {
    const e = mk(ramp(30), at(5));
    const v = e.getVisibleBars('1m');
    expect(v).toHaveLength(6);
    expect(v[0]!.time).toBe(at(0));
    expect(v[5]!.time).toBe(at(5));
  });
  it('is not affected by later changes to the array it was given', () => {
    const bars = ramp(10);
    const e = mk(bars, at(2));
    bars.length = 0;
    expect(e.step(3)).toEqual([]);
    expect(e.cursorTime).toBe(at(5));
  });
  it('exposes the contract and settings with defaults', () => {
    const e = mk(ramp(5));
    expect(e.contract).toBe(NQ);
    expect(e.settings).toEqual({ commissionPerSide: 0, slippageTicks: 0, startingBalance: 50000 });
    const f = new ReplayEngine({ bars: ramp(5), contract: NQ, startTime: T0, settings: { commissionPerSide: 2.05, slippageTicks: 1 } });
    expect(f.settings).toEqual({ commissionPerSide: 2.05, slippageTicks: 1, startingBalance: 50000 });
  });
  it('rejects nonsense settings', () => {
    const make = (settings: object) => () => new ReplayEngine({ bars: ramp(5), contract: NQ, startTime: T0, settings });
    expect(make({ commissionPerSide: -1 })).toThrow(EngineError);
    expect(make({ commissionPerSide: Number.NaN })).toThrow(EngineError);
    expect(make({ slippageTicks: -1 })).toThrow(EngineError);
    expect(make({ slippageTicks: 0.5 })).toThrow(EngineError);
    expect(make({ startingBalance: 0 })).toThrow(EngineError);
    expect(make({ startingBalance: -5 })).toThrow(EngineError);
  });
});

describe('getVisibleBars: revealed data only', () => {
  it('1m never shows a bar after the cursor', () => {
    const e = mk(ramp(30), at(3));
    expect(e.getVisibleBars('1m').map((b) => b.time)).toEqual([at(0), at(1), at(2), at(3)]);
    e.step();
    expect(e.getVisibleBars('1m')).toHaveLength(5);
  });

  it('the last 5m candle is partial and built from revealed bars only', () => {
    const bars = ramp(30);
    bars[4] = { ...bars[4]!, high: 999, low: 1 }; // a future spike that must stay hidden
    const e = mk(bars, at(3));
    // bars 0 to 3: O 100 (bar 0), H 105 (bar 3: 102+3), L 99 (bar 0), C 104 (bar 3), V 10+11+12+13 = 46
    expect(e.getVisibleBars('5m')).toEqual([{ time: at(0), open: 100, high: 105, low: 99, close: 104, volume: 46 }]);
    e.step();
    // bar 4 is revealed: H 999, L 1, C 105, V 46 + 14 = 60
    expect(e.getVisibleBars('5m')).toEqual([{ time: at(0), open: 100, high: 999, low: 1, close: 105, volume: 60 }]);
  });

  it('3m: completed candles plus a partial one', () => {
    const e = mk(ramp(30), at(4));
    expect(e.getVisibleBars('3m')).toEqual([
      { time: at(0), open: 100, high: 104, low: 99, close: 103, volume: 33 }, // bars 0 to 2: H 102+2, C 101+2, V 10+11+12
      { time: at(3), open: 103, high: 106, low: 102, close: 105, volume: 27 }, // bars 3 and 4 so far: V 13+14
    ]);
  });

  it('missing 1m bars are skipped, never invented', () => {
    const bars = ramp(12).filter((_, i) => i < 6 || i > 8); // bars 6, 7, 8 missing
    const e = mk(bars, at(11));
    expect(e.getVisibleBars('1m').map((b) => b.time)).toEqual([0, 1, 2, 3, 4, 5, 9, 10, 11].map(at));
    // bars 6, 7, 8 are absent, so the 15:05 candle is built from bars 5 and 9 only
    expect(e.getVisibleBars('5m')).toEqual([
      { time: at(0), open: 100, high: 106, low: 99, close: 105, volume: 60 }, // bars 0 to 4: V 10+11+12+13+14
      { time: at(5), open: 105, high: 111, low: 104, close: 110, volume: 34 }, // bar 5 (V 15) + bar 9 (V 19), not 15+16+17+18+19
      { time: at(10), open: 110, high: 113, low: 109, close: 112, volume: 41 }, // bars 10 and 11: V 20+21
    ]);
  });

  it('a bucket with every bar missing produces no candle', () => {
    const bars = ramp(12).filter((_, i) => i < 5 || i > 9); // 15:05 to 15:09 absent
    const e = mk(bars, at(11));
    expect(e.getVisibleBars('5m').map((b) => b.time)).toEqual([at(0), at(10)]);
  });

  it('returns fresh arrays: editing one does not leak into the next call', () => {
    const e = mk(ramp(30), at(7));
    const a = e.getVisibleBars('5m');
    a.pop();
    a.push({ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(e.getVisibleBars('5m')).toEqual(aggregate(ramp(8), '5m'));
    const m = e.getVisibleBars('1m');
    m.length = 0;
    expect(e.getVisibleBars('1m')).toHaveLength(8);
  });

  it('the incremental cache equals aggregate() of the revealed bars at every step, for every timeframe', () => {
    // 16:50 to 16:59 ET, then the 17:00 halt, then 18:00 to 18:20 ET (Tue 2024-01-02, EST)
    const a = ramp(10, utc('2024-01-02T21:50:00Z'));
    const b = ramp(21, utc('2024-01-02T23:00:00Z')).map((x, i) => ({ ...x, open: 200 + i, high: 205 + i, low: 195 + i, close: 201 + i }));
    const bars = [...a, ...b];
    const e = mk(bars, bars[0]!.time);
    const tfs: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];
    for (let i = 0; i < bars.length; i++) {
      for (const tf of tfs) expect(e.getVisibleBars(tf), `${tf} at bar ${i}`).toEqual(aggregate(bars.slice(0, i + 1), tf));
      if (i < bars.length - 1) e.step();
    }
  });

  it('1D and 4h open a new candle at the 18:00 ET start (Sunday evening, spring forward week)', () => {
    const mkBar = (iso: string, p: number): Bar => ({ time: utc(iso), open: p, high: p + 1, low: p - 1, close: p, volume: 1 });
    const bars = [
      mkBar('2024-03-08T21:59:00Z', 100), // Fri 16:59 EST
      mkBar('2024-03-10T22:00:00Z', 110), // Sun 18:00 EDT
      mkBar('2024-03-10T22:01:00Z', 111),
    ];
    const e = mk(bars, bars[0]!.time);
    expect(e.getVisibleBars('1D').map((c) => c.time)).toEqual([utc('2024-03-07T23:00:00Z')]);
    e.step();
    expect(e.getVisibleBars('1D').map((c) => c.time)).toEqual([utc('2024-03-07T23:00:00Z'), utc('2024-03-10T22:00:00Z')]);
    expect(e.getVisibleBars('4h').map((c) => c.time)).toEqual([utc('2024-03-08T19:00:00Z'), utc('2024-03-10T22:00:00Z')]);
    e.step();
    expect(e.getVisibleBars('1D')[1]).toMatchObject({ open: 110, close: 111, high: 112, low: 109, volume: 2 });
  });
});

describe('step(count, tf) semantics', () => {
  it('defaults to one base bar; step(n) and step(n, "1m") reveal n base bars', () => {
    const e = mk(ramp(30));
    e.step();
    expect(e.cursorTime).toBe(at(1));
    e.step(3);
    expect(e.cursorTime).toBe(at(4));
    e.step(2, '1m');
    expect(e.cursorTime).toBe(at(6));
  });

  it('5m: the current partial candle counts as the first', () => {
    const e = mk(ramp(30), at(3));
    e.step(1, '5m'); // bar 4 completes the 15:00 candle
    expect(e.cursorTime).toBe(at(4));
    e.step(1, '5m'); // bars 5 to 9 complete the 15:05 candle
    expect(e.cursorTime).toBe(at(9));
    e.step(2, '5m'); // 15:10 and 15:15 candles
    expect(e.cursorTime).toBe(at(19));
  });

  it('when the cursor is on the last bar of a candle there is no partial candle to count', () => {
    const e = mk(ramp(30), at(4));
    e.step(1, '5m');
    expect(e.cursorTime).toBe(at(9));
  });

  it('when the cursor is on the first bar of a candle it counts as the partial one', () => {
    const e = mk(ramp(30), at(5));
    e.step(1, '5m');
    expect(e.cursorTime).toBe(at(9));
  });

  it('step(2, 5m) from a partial candle completes two candles', () => {
    const e = mk(ramp(30), at(3));
    e.step(2, '5m');
    expect(e.cursorTime).toBe(at(9));
  });

  it('3m, 15m, 30m, 1h', () => {
    const e3 = mk(ramp(30), at(0));
    e3.step(1, '3m'); // 15:00 candle completes at bar 2
    expect(e3.cursorTime).toBe(at(2));

    const e15 = mk(ramp(30), at(3));
    e15.step(1, '15m');
    expect(e15.cursorTime).toBe(at(14));

    const e30 = mk(ramp(30), at(0));
    e30.step(1, '30m'); // data ends at 15:29, which completes the candle
    expect(e30.cursorTime).toBe(at(29));
    expect(e30.isAtEnd()).toBe(true);

    const e60 = mk(ramp(30), at(0));
    e60.step(1, '1h');
    expect(e60.isAtEnd()).toBe(true);
  });

  it('a candle also completes when the data ends, and asking for more stops at the end', () => {
    const e = mk(ramp(12), at(3));
    e.step(100, '5m');
    expect(e.cursorTime).toBe(at(11));
    expect(e.isAtEnd()).toBe(true);
  });

  it('a gap in the data completes the candle early: no partial candle, the next one is stepped', () => {
    // bars 15:00 to 15:03, then 15:07 to 15:12. At 15:03 the next bar (15:07) is in a new 5m bucket.
    const bars = ramp(13).filter((_, i) => i <= 3 || i >= 7);
    const e = mk(bars, at(3));
    e.step(1, '5m');
    expect(e.cursorTime).toBe(at(9)); // 15:07, 15:08, 15:09 complete the 15:05 candle
  });

  it('1D and 4h stop at the end of the trading day', () => {
    const mkBar = (iso: string): Bar => ({ time: utc(iso), open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    const bars = ['2024-01-02T21:58:00Z', '2024-01-02T21:59:00Z', '2024-01-02T23:00:00Z', '2024-01-02T23:01:00Z'].map(mkBar);
    for (const tf of ['1D', '4h', '1h'] as const) {
      const e = mk(bars, bars[0]!.time);
      e.step(1, tf);
      expect(e.cursorTime, tf).toBe(utc('2024-01-02T21:59:00Z'));
      e.step(1, tf);
      expect(e.isAtEnd(), tf).toBe(true);
    }
  });

  it('orders are processed on every base bar, never on aggregated candles', () => {
    const e = mk(ramp(30), at(3));
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step(1, '5m'); // reveals only bar 4
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened']);
    // market fills at the open of the very next base bar (bar 4: open 104), not at some candle price
    expect(e.position).toMatchObject({ entryPrice: 104, entryTime: at(4) });
  });

  it('a stop hit mid candle exits on that base bar while stepping a whole candle', () => {
    // flat bars at 100 except bar 10 which dives to 80
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: at(i), open: 100, high: 100.5, low: i === 10 ? 80 : 99.5, close: 100, volume: 1 }));
    const e = mk(bars, at(0));
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 90 });
    e.step(); // fills at 100 on bar 1
    const ev = e.step(1, '1h'); // steps to the end of the 15:00 hour candle (data end)
    const closed = ev.find((x) => x.type === 'trade_closed');
    expect(closed).toMatchObject({ time: at(10), trade: { exitPrice: 90, exitReason: 'stop_loss', exitTime: at(10) } });
    expect(e.cursorTime).toBe(at(29));
  });

  it('rejects an invalid count or timeframe', () => {
    const e = mk(ramp(30));
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => e.step(n), `n ${n}`).toThrow(EngineError);
    expect(() => e.step(1, '2h' as Timeframe)).toThrow(EngineError);
    expect(e.cursorTime).toBe(at(0));
  });
});

describe('stepTo', () => {
  it('reveals every bar with time <= the target (inclusive)', () => {
    const e = mk(ramp(30));
    e.stepTo(at(10));
    expect(e.cursorTime).toBe(at(10));
    e.stepTo(at(12) + 59);
    expect(e.cursorTime).toBe(at(12));
  });
  it('does nothing for a target at or before the cursor', () => {
    const e = mk(ramp(30), at(10));
    expect(e.stepTo(at(10))).toEqual([]);
    expect(e.stepTo(at(2))).toEqual([]);
    expect(e.cursorTime).toBe(at(10));
  });
  it('stops at the end of data', () => {
    const e = mk(ramp(10));
    e.stepTo(at(500));
    expect(e.cursorTime).toBe(at(9));
    expect(e.isAtEnd()).toBe(true);
  });
  it('processes orders along the way and returns all the events in order', () => {
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: at(i), open: 100, high: 100.5, low: i === 10 ? 80 : 99.5, close: 100, volume: 1 }));
    const e = mk(bars, at(0));
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 90 });
    const ev = e.stepTo(at(15));
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    expect(ev.map((x) => x.time)).toEqual([at(1), at(1), at(10)]);
  });
  it('rejects a non finite time', () => {
    expect(() => mk(ramp(5)).stepTo(Number.NaN)).toThrow(EngineError);
  });
});

describe('no lookahead: future bar values change nothing up to the cursor', () => {
  const K = 199; // index 200 starts a 5m bucket (and 15m, 30m, ...) so tf stepping stops exactly at K
  const real = walkBars(400, 7);
  const corrupted = real.map((b, i) => (i > K ? { ...b, open: b.open * 3 + 500, high: b.high * 3 + 900, low: 1, close: b.close * 0.5 + 7, volume: 9_999_999 } : b));

  function drive(bars: Bar[], advance: (e: ReplayEngine) => boolean) {
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time, settings: { slippageTicks: 1, commissionPerSide: 1 } });
    const log: unknown[] = [];
    let guard = 0;
    while (e.cursorTime < bars[K]!.time && guard++ < 1000) {
      if (e.position === null && e.workingOrder === null && e.cursorTime > bars[0]!.time && Math.floor((e.cursorTime - bars[0]!.time) / 60) % 7 === 0) {
        const lp = e.lastPrice;
        const long = Math.floor((e.cursorTime - bars[0]!.time) / 60) % 2 === 0;
        e.placeOrder(
          long
            ? { side: 'long', type: 'limit', qty: 1, price: lp - 1, stopLoss: lp - 5, takeProfit: lp + 6 }
            : { side: 'short', type: 'stop', qty: 2, price: lp - 2, stopLoss: lp + 4, takeProfit: lp - 7 },
        );
      }
      if (!advance(e)) break;
      log.push(e.position, e.workingOrder);
    }
    return { e, log };
  }

  it('stepping one base bar at a time', () => {
    const a = drive(real, (e) => (e.step(), true));
    const b = drive(corrupted, (e) => (e.step(), true));
    expect(a.e.cursorTime).toBe(real[K]!.time);
    expect(b.log).toEqual(a.log);
    expect(b.e.trades).toEqual(a.e.trades);
    expect(a.e.trades.length).toBeGreaterThan(0);
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const) expect(b.e.getVisibleBars(tf), tf).toEqual(a.e.getVisibleBars(tf));
    expect(b.e.lastPrice).toBe(a.e.lastPrice);
    expect(b.e.toJSON()).toEqual(a.e.toJSON());
  });

  it('stepping by 5m candles', () => {
    const a = drive(real, (e) => (e.step(1, '5m'), true));
    const b = drive(corrupted, (e) => (e.step(1, '5m'), true));
    expect(a.e.cursorTime).toBe(real[K]!.time);
    expect(b.log).toEqual(a.log);
    expect(b.e.toJSON()).toEqual(a.e.toJSON());
  });
});
