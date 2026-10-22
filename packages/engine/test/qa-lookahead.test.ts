// QA: lookahead. CLAUDE.md hard rule 1: nothing on screen and no fill may use data after the cursor.
// The sharpest check is a twin experiment: two engines over bars that are identical up to bar K and
// wildly different (or NaN) after it must be indistinguishable until the cursor passes K.
import { describe, expect, it } from 'vitest';
import { CONTRACTS, EngineError, ReplayEngine } from '../src/index';
import type { Bar, EngineEvent, Timeframe } from '../src/index';
import { applyToEngine, chooseAction, lcg, randomSettings, randomTickBars, stateOf, toBars } from './qa-support';
import { NQ, T0, engineExact, engineOver, utc, type Ohlc } from './helpers';

const TFS: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];

type Poison = 'other path' | 'NaN' | 'absurd';

function poisonAfter(bars: Bar[], k: number, kind: Poison, seed: number): Bar[] {
  const rand = lcg(seed);
  return bars.map((b, i) => {
    if (i <= k) return { ...b };
    if (kind === 'NaN') return { ...b, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN };
    if (kind === 'absurd') return { ...b, open: 1e9, high: 2e9, low: 0.25, close: 1e9 + 1, volume: 1e12 };
    const o = 5000 + Math.round(rand() * 20000) * 0.25;
    return { ...b, open: o, high: o + 500, low: o - 500, close: o + 3, volume: 1 };
  });
}

function observe(e: ReplayEngine, full = false): unknown {
  return {
    cursorTime: e.cursorTime,
    lastPrice: e.lastPrice,
    isAtEnd: e.isAtEnd(),
    position: e.position,
    working: e.workingOrder,
    trades: e.trades,
    unrealized: e.unrealized(),
    bars: TFS.map((tf) => {
      const v = e.getVisibleBars(tf);
      return full ? v : { n: v.length, tail: v.slice(-3) };
    }),
  };
}

describe('twin engines: bars after the cursor can never be observed (NaN, absurd and different futures)', () => {
  for (const symbol of ['NQ', 'MES', 'CL', 'GC'] as const) {
    for (const kind of ['other path', 'NaN', 'absurd'] as const) {
      it(`${symbol}, future replaced by ${kind}: every observable identical until the cursor passes K`, () => {
        const contract = CONTRACTS[symbol]!;
        const tick = contract.tickSize;
        for (let seed = 1; seed <= 4; seed++) {
          const rand = lcg(seed * 977);
          const rb = randomTickBars(rand, contract, 1500);
          const bars = toBars(rb, tick);
          const K = 600 + seed * 50;
          const settings = randomSettings(rand);
          const a = new ReplayEngine({ bars, contract, startTime: bars[3]!.time, settings });
          const b = new ReplayEngine({ bars: poisonAfter(bars, K, kind, seed), contract, startTime: bars[3]!.time, settings });
          let idx = 3;
          let steps = 0;
          while (idx < K - 1) {
            const action = chooseAction(rand, stateOf(a));
            applyToEngine(a, action);
            applyToEngine(b, action);
            const room = K - idx;
            const n = Math.min(room, 1 + Math.floor(rand() * 4));
            const evA = a.step(n);
            const evB = b.step(n);
            idx += n;
            expect(evB, `seed ${seed} step ${steps} events`).toEqual(evA);
            expect(observe(b, steps % 60 === 0), `seed ${seed} step ${steps} (cursor ${idx})`).toEqual(observe(a, steps % 60 === 0));
            steps++;
          }
          expect(steps).toBeGreaterThan(100);
          expect(a.trades.length).toBeGreaterThan(0);
        }
      });
    }
  }

  it('tf stepping and stepTo also never read prices beyond what they reveal', () => {
    const contract = NQ;
    const rand = lcg(31337);
    const rb = randomTickBars(rand, contract, 4000);
    const bars = toBars(rb, contract.tickSize);
    const K = 3000;
    const a = new ReplayEngine({ bars, contract, startTime: bars[3]!.time });
    const b = new ReplayEngine({ bars: poisonAfter(bars, K, 'NaN', 1), contract, startTime: bars[3]!.time });
    let guard = 0;
    while (guard++ < 500) {
      // only take a jump that stays inside K on both engines (probe on clones)
      const tf = (['3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const)[Math.floor(rand() * 7)]!;
      const probe = ReplayEngine.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), bars, contract);
      probe.step(1, tf);
      if (probe.cursorTime > bars[K]!.time) break;
      const evA = a.step(1, tf);
      const evB = b.step(1, tf);
      expect(evB).toEqual(evA);
      expect(observe(b)).toEqual(observe(a));
      if (rand() < 0.3) {
        const t = a.cursorTime + Math.floor(rand() * 900);
        if (t > bars[K]!.time) break;
        expect(b.stepTo(t)).toEqual(a.stepTo(t));
        expect(observe(b)).toEqual(observe(a));
      }
    }
    expect(a.cursorTime).toBeGreaterThan(bars[1000]!.time);
  });
});

describe('visible bars never include the future', () => {
  it('getVisibleBars at every cursor position has no candle that opens after the cursor, and the last candle holds only revealed bars', () => {
    const rand = lcg(5);
    const rb = randomTickBars(rand, NQ, 1200);
    const bars = toBars(rb, NQ.tickSize);
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    for (let i = 1; i < bars.length; i++) {
      e.step();
      const cursor = bars[i]!;
      for (const tf of TFS) {
        const v = e.getVisibleBars(tf);
        const last = v[v.length - 1]!;
        expect(last.time).toBeLessThanOrEqual(cursor.time);
        // the last candle's close is the cursor bar's close, its high is not above anything revealed
        expect(last.close).toBe(cursor.close);
        const revealedInCandle = bars.slice(0, i + 1).filter((b) => b.time >= last.time && b.time <= cursor.time);
        expect(last.high).toBe(Math.max(...revealedInCandle.map((b) => b.high)));
        expect(last.low).toBe(Math.min(...revealedInCandle.map((b) => b.low)));
        expect(last.volume).toBe(revealedInCandle.reduce((s, b) => s + b.volume, 0));
      }
    }
  });

  it('completed candles never change as the cursor advances (no repainting)', () => {
    const rand = lcg(6);
    const bars = toBars(randomTickBars(rand, NQ, 900), NQ.tickSize);
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    const seen = new Map<string, Bar>();
    for (let i = 1; i < bars.length; i++) {
      e.step();
      for (const tf of ['5m', '1h', '4h', '1D'] as const) {
        const v = e.getVisibleBars(tf);
        for (const c of v.slice(0, -1)) {
          const key = `${tf}@${c.time}`;
          const prev = seen.get(key);
          if (prev) expect(c, key).toEqual(prev);
          else seen.set(key, { ...c });
        }
      }
    }
  });

  it('stepTo reveals bars with time <= t and nothing at t + 1 second early', () => {
    const e = engineExact([[100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102], [102, 104, 101, 103]]);
    e.stepTo(T0 + 119); // one second before the third bar opens
    expect(e.cursorTime).toBe(T0 + 60);
    e.stepTo(T0 + 120);
    expect(e.cursorTime).toBe(T0 + 120);
    e.stepTo(T0 + 5); // backwards: ignored
    expect(e.cursorTime).toBe(T0 + 120);
  });

  it('start time between two bars: cursor is the last bar at or before it, and the next bar stays hidden', () => {
    const bars = [100, 101, 102, 103].map((p, i): Bar => ({ time: T0 + i * 60, open: p, high: p + 1, low: p - 1, close: p, volume: 1 }));
    const e = new ReplayEngine({ bars, contract: NQ, startTime: T0 + 119 });
    expect(e.cursorTime).toBe(T0 + 60);
    expect(e.getVisibleBars('1m')).toHaveLength(2);
    expect(e.lastPrice).toBe(101);
    expect(() => new ReplayEngine({ bars, contract: NQ, startTime: T0 - 1 })).toThrow(EngineError);
  });

  it('start time after the last bar puts the cursor on the last bar: at the end, nothing to reveal', () => {
    const e = engineExact([[100, 101, 99, 100], [100, 102, 99, 101]], {}, NQ, T0);
    const f = new ReplayEngine({ bars: [{ time: T0, open: 1, high: 2, low: 1, close: 2, volume: 1 }], contract: NQ, startTime: T0 + 9999 });
    expect(f.isAtEnd()).toBe(true);
    expect(f.step()).toEqual([]);
    expect(e.isAtEnd()).toBe(false);
  });
});

describe('fills and P&L never use the bar the order was placed on', () => {
  it('a limit that the cursor bar itself would have filled does not fill on that bar', () => {
    // cursor bar low 20990 would have touched a buy limit at 20995; the order is only live from the next bar
    const e = engineOver([[21000, 21002, 20990, 21001], [21001, 21003, 21000, 21002]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    expect(e.workingOrder).not.toBeNull();
    expect(e.trades).toEqual([]);
    expect(e.step()).toEqual([]); // next bar never reaches 20995
    expect(e.workingOrder).not.toBeNull();
  });

  it('a market order fills at the NEXT bar open, not at the last price it was priced from', () => {
    const e = engineOver([[21000, 21002, 20998, 21001], [21010, 21012, 21008, 21011]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.position!.entryPrice).toBe(21010);
    expect(e.position!.entryTime).toBe(T0 + 60);
  });

  it('unrealized P&L is marked at the last revealed close, never at a later bar', () => {
    const e = engineOver([[100, 101, 99, 100], [100, 110, 90, 105], [105, 200, 1, 150]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.unrealized()).toEqual({ ticks: 20, usd: 100 }); // (105 - 100) / 0.25 ticks, $5 each
    e.step();
    expect(e.unrealized()).toEqual({ ticks: 200, usd: 1000 });
  });

  it('a stop loss moved onto the current bar range cannot trigger on a bar that already happened', () => {
    // bar 1 low was 20990. Long from 21000, SL moved to 20995 after bar 1 closed: not hit by bar 1.
    const e = engineOver([[21000, 21001, 20999, 21000], [21000, 21002, 20990, 21001], [21001, 21004, 21000, 21003]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.position).not.toBeNull();
    e.modifyBracket({ stopLoss: 20995 });
    expect(e.trades).toEqual([]);
    e.step(); // bar 2 low 21000 > 20995
    expect(e.trades).toEqual([]);
    expect(e.position!.stopLoss).toBe(20995);
  });

  it('MAE and MFE of an open position do not include the next bar until it is revealed', () => {
    const e = engineOver([[21000, 21001, 20999, 21000], [21000, 21002, 20998, 21001], [21001, 21100, 20900, 21000]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.position).toMatchObject({ maeTicks: 8, mfeTicks: 8 });
    e.step();
    expect(e.position).toMatchObject({ maeTicks: 400, mfeTicks: 400 });
  });
});

describe('returned data cannot be used to corrupt the replay', () => {
  it('mutating arrays returned by getVisibleBars does not change later results', () => {
    const e = engineOver([[100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102]]);
    e.step();
    const v1 = e.getVisibleBars('1m');
    v1.length = 0;
    const v5 = e.getVisibleBars('5m');
    v5.push({ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(e.getVisibleBars('1m')).toHaveLength(2);
    expect(e.getVisibleBars('5m')).toHaveLength(1);
  });

  it('mutating the partial candle returned for a higher timeframe does not corrupt the next candle build', () => {
    const e = engineOver([[100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102]]);
    e.step();
    const c = e.getVisibleBars('15m');
    c[c.length - 1]!.high = 9999;
    e.step();
    expect(e.getVisibleBars('15m').at(-1)!.high).toBe(103);
  });

  it('completed higher timeframe candles are frozen (cannot be edited by a caller)', () => {
    const t0 = utc('2024-01-09T23:00:00Z');
    const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({ time: t0 + i * 60, open: 1, high: 2, low: 0.5, close: 1, volume: 1 }));
    const e = new ReplayEngine({ bars, contract: NQ, startTime: t0 });
    e.step(11);
    const first = e.getVisibleBars('5m')[0]!;
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('BUG: 1m bars returned by getVisibleBars are the engine own objects, so editing one changes the replay', () => {
    const e = engineOver([[21000, 21001, 20999, 21000], [21000, 21002, 20998, 21001]]);
    e.step();
    const v = e.getVisibleBars('1m');
    try {
      v[1]!.close = 1;
    } catch {
      return; // frozen: fine
    }
    expect(e.lastPrice, 'a caller edited a visible 1m bar and the engine saw it').toBe(21001);
  });

  it('BUG: editing the caller bars array after construction changes later fills (the engine keeps references to the caller bar objects)', () => {
    const bars = [
      { time: T0, open: 21000, high: 21001, low: 20999, close: 21000, volume: 1 },
      { time: T0 + 60, open: 21000, high: 21002, low: 20998, close: 21001, volume: 1 },
      { time: T0 + 120, open: 21001, high: 21003, low: 21000, close: 21002, volume: 1 },
    ];
    const e = new ReplayEngine({ bars, contract: NQ, startTime: T0 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    bars[1]!.open = 21500; // the UI mutates its own array after handing it over
    e.step();
    expect(e.position!.entryPrice, 'fill used a price edited after construction').toBe(21000);
  });
});

describe('the end of the data', () => {
  const rows: Ohlc[] = [[100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102]];

  it('stepping at the end is a no-op for every kind of step', () => {
    const e = engineExact(rows);
    e.step(10);
    expect(e.isAtEnd()).toBe(true);
    const before = JSON.stringify(e.toJSON());
    expect(e.step()).toEqual([]);
    expect(e.step(5, '1D')).toEqual([]);
    expect(e.stepTo(1e12)).toEqual([]);
    expect(JSON.stringify(e.toJSON())).toBe(before);
  });

  it('an overshooting step stops at the last bar and closes the position there exactly once', () => {
    const e = engineExact(rows);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step(1000);
    expect(ev.filter((x: EngineEvent) => x.type === 'trade_closed')).toHaveLength(1);
    expect(e.trades).toHaveLength(1);
    expect(e.trades[0]).toMatchObject({ exitReason: 'end_of_data', exitTime: T0 + 120, exitPrice: 102 });
    expect(e.position).toBeNull();
    expect(e.cursorTime).toBe(T0 + 120);
  });

  it('a working order placed on the last bar just stays working', () => {
    const e = engineExact(rows);
    e.step(2);
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 95 });
    expect(e.step()).toEqual([]);
    expect(e.workingOrder?.id).toBe(o.id);
    expect(() => e.placeOrder({ side: 'short', type: 'market', qty: 1 })).toThrow(EngineError);
    e.cancelOrder(o.id);
    expect(e.workingOrder).toBeNull();
  });

  it('a market order placed on the last bar never fills and never invents a bar', () => {
    const e = engineExact(rows);
    e.step(2);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(e.step(3)).toEqual([]);
    expect(e.position).toBeNull();
    expect(e.workingOrder).not.toBeNull();
  });

  it('a manual close queued on the second to last bar executes at the last bar OPEN as manual, not end_of_data', () => {
    const e = engineExact([[100, 101, 99, 100], [100, 102, 99, 101], [110, 112, 108, 111]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    e.closePosition();
    e.step();
    expect(e.trades).toHaveLength(1);
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 110 });
  });

  it('step arguments are validated before anything moves', () => {
    const e = engineExact(rows);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => e.step(bad)).toThrow(EngineError);
      expect(e.cursorTime).toBe(T0);
    }
    expect(() => e.step(1, '2m' as Timeframe)).toThrow(EngineError);
    expect(() => e.stepTo(NaN)).toThrow(EngineError);
    expect(() => e.getVisibleBars('1W' as Timeframe)).toThrow(EngineError);
    expect(e.cursorTime).toBe(T0);
  });
});
