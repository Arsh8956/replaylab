// QA: money. Tick values (micro vs full), tiny ticks (CL 0.01), float drift over thousands of trades,
// cents rounding, negative prices, and an independent recomputation of computeStats in integer cents.
import { describe, expect, it } from 'vitest';
import { CONTRACTS, ReplayEngine, computeStats, roundToTick } from '../src/index';
import type { ContractSpec, Trade } from '../src/index';
import { applyToEngine, chooseAction, etWall, lcg, px, randomTickBars, refTradingDay, stateOf, tk, toBars } from './qa-support';
import { T0, barsFrom, utc } from './helpers';

// SPEC section 3, typed in again here so a typo in either place is caught.
const SPEC: Record<string, { root: string; tick: number; tickValue: number; pointValue: number }> = {
  NQ: { root: 'NQ', tick: 0.25, tickValue: 5, pointValue: 20 },
  MNQ: { root: 'NQ', tick: 0.25, tickValue: 0.5, pointValue: 2 },
  ES: { root: 'ES', tick: 0.25, tickValue: 12.5, pointValue: 50 },
  MES: { root: 'ES', tick: 0.25, tickValue: 1.25, pointValue: 5 },
  YM: { root: 'YM', tick: 1, tickValue: 5, pointValue: 5 },
  MYM: { root: 'YM', tick: 1, tickValue: 0.5, pointValue: 0.5 },
  RTY: { root: 'RTY', tick: 0.1, tickValue: 5, pointValue: 50 },
  M2K: { root: 'RTY', tick: 0.1, tickValue: 0.5, pointValue: 5 },
  CL: { root: 'CL', tick: 0.01, tickValue: 10, pointValue: 1000 },
  MCL: { root: 'CL', tick: 0.01, tickValue: 1, pointValue: 100 },
  GC: { root: 'GC', tick: 0.1, tickValue: 10, pointValue: 100 },
  MGC: { root: 'GC', tick: 0.1, tickValue: 1, pointValue: 10 },
};
const PAIRS: [string, string][] = [['NQ', 'MNQ'], ['ES', 'MES'], ['YM', 'MYM'], ['RTY', 'M2K'], ['CL', 'MCL'], ['GC', 'MGC']];

describe('contract table matches SPEC section 3 and is self consistent', () => {
  for (const [symbol, want] of Object.entries(SPEC)) {
    it(`${symbol}`, () => {
      const c = CONTRACTS[symbol]!;
      expect({ root: c.root, tick: c.tickSize, tickValue: c.tickValue, pointValue: c.pointValue, symbol: c.symbol }).toEqual({ ...want, symbol });
      // point value = tick value / tick size, to the cent
      expect(Math.round((c.tickValue / c.tickSize) * 1e6) / 1e6).toBe(c.pointValue);
      expect(Object.isFrozen(c)).toBe(true);
    });
  }
  it('has exactly the 12 symbols, and each micro shares its full size root', () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(Object.keys(SPEC).sort());
    for (const [full, micro] of PAIRS) {
      expect(CONTRACTS[micro]!.root).toBe(full);
      expect(CONTRACTS[micro]!.tickSize).toBe(CONTRACTS[full]!.tickSize);
      expect(CONTRACTS[full]!.tickValue / CONTRACTS[micro]!.tickValue).toBe(10);
    }
  });
});

describe('one trade per contract: +1 tick, +1 point, a loser, qty 7, all hand computed from the spec table', () => {
  function trade(c: ContractSpec, side: 'long' | 'short', moveTicks: number, qty: number, commission = 0): Trade {
    const tick = c.tickSize;
    const base = Math.round(1000 / tick);
    const bars = barsFrom(T0, [
      [px(base, tick), px(base + 1, tick), px(base - 1, tick), px(base, tick)],
      [px(base, tick), px(base + 1, tick), px(base - 1, tick), px(base, tick)], // entry bar at the open
      [px(base + moveTicks * (side === 'long' ? 1 : -1), tick), px(base + 5 + Math.abs(moveTicks), tick), px(base - 5 - Math.abs(moveTicks), tick), px(base, tick)],
      [px(base, tick), px(base, tick), px(base, tick), px(base, tick)],
    ]);
    const e = new ReplayEngine({ bars, contract: c, startTime: T0, settings: { commissionPerSide: commission } });
    e.placeOrder({ side, type: 'market', qty });
    e.step();
    e.closePosition();
    e.step();
    return e.trades[0]!;
  }
  for (const [symbol, want] of Object.entries(SPEC)) {
    it(`${symbol}`, () => {
      const c = CONTRACTS[symbol]!;
      const one = trade(c, 'long', 1, 1);
      expect(one.pnlTicks).toBe(1);
      expect(one.grossUsd).toBe(want.tickValue);
      const pointTicks = Math.round(1 / want.tick);
      const pt = trade(c, 'long', pointTicks, 1);
      expect(pt.pnlTicks).toBe(pointTicks);
      expect(pt.grossUsd).toBe(want.pointValue);
      const loser = trade(c, 'short', -3, 7); // short, price rises 3 ticks against, qty 7
      expect(loser.pnlTicks).toBe(-3);
      expect(loser.grossUsd).toBe(-3 * want.tickValue * 7);
      const fee = trade(c, 'long', 2, 3, 0.62);
      expect(fee.feesUsd).toBe(3.72);
      expect(fee.netUsd).toBe(Math.round(2 * want.tickValue * 3 * 100 - 372) / 100);
    });
  }
});

describe('micro vs full size: same path, same actions, ticks identical and dollars exactly one tenth', () => {
  for (const [full, micro] of PAIRS) {
    it(`${micro} vs ${full}`, () => {
      const F = CONTRACTS[full]!;
      const M = CONTRACTS[micro]!;
      const rand = lcg(full.charCodeAt(0) * 31 + 7);
      const bars = toBars(randomTickBars(rand, F, 2500), F.tickSize);
      const settings = { slippageTicks: 1, commissionPerSide: 0 };
      const a = new ReplayEngine({ bars, contract: F, startTime: bars[3]!.time, settings });
      const b = new ReplayEngine({ bars, contract: M, startTime: bars[3]!.time, settings });
      while (!a.isAtEnd()) {
        const act = chooseAction(rand, stateOf(a));
        applyToEngine(a, act);
        applyToEngine(b, act);
        const n = 1 + Math.floor(rand() * 4);
        a.step(n);
        b.step(n);
        const ua = a.unrealized();
        const ub = b.unrealized();
        expect(ub === null).toBe(ua === null);
        if (ua && ub) {
          expect(ub.ticks).toBe(ua.ticks);
          expect(Math.round(ua.usd * 100)).toBe(Math.round(ub.usd * 100) * 10);
        }
      }
      expect(b.trades.length).toBe(a.trades.length);
      expect(a.trades.length).toBeGreaterThan(25);
      a.trades.forEach((t, i) => {
        const u = b.trades[i]!;
        expect([u.entryPrice, u.exitPrice, u.pnlTicks, u.exitReason, u.maeTicks, u.mfeTicks, u.rMultiple]).toEqual([t.entryPrice, t.exitPrice, t.pnlTicks, t.exitReason, t.maeTicks, t.mfeTicks, t.rMultiple]);
        expect(Math.round(t.grossUsd * 100)).toBe(Math.round(u.grossUsd * 100) * 10);
        if (t.riskUsd !== null) expect(Math.round(t.riskUsd * 100)).toBe(Math.round(u.riskUsd! * 100) * 10);
      });
    });
  }
});

describe('tick grid and tiny ticks', () => {
  const ticks: [string, number, number][] = [['CL', 0.01, 20000], ['RTY/GC', 0.1, 40000], ['NQ/ES', 0.25, 120000], ['YM', 1, 60000]];
  for (const [name, tick, n] of ticks) {
    it(`roundToTick is exact on every grid price of ${name} (${tick}) and snaps a third of a tick either way`, () => {
      for (let k = 1; k <= n; k++) {
        const p = px(k, tick);
        if (roundToTick(p, tick) !== p) throw new Error(`grid price ${p} moved to ${roundToTick(p, tick)}`);
        if (roundToTick(p + tick * 0.3, tick) !== p) throw new Error(`${p} + 0.3 tick moved to ${roundToTick(p + tick * 0.3, tick)}`);
        if (k > 1 && roundToTick(p - tick * 0.3, tick) !== p) throw new Error(`${p} - 0.3 tick moved to ${roundToTick(p - tick * 0.3, tick)}`);
        if (tk(p, tick) !== k) throw new Error(`tk(${p}) = ${tk(p, tick)} not ${k}`);
      }
    });
  }

  it('prices that are classic float traps for 0.01 and 0.1 ticks round to what was typed', () => {
    for (const p of [4.35, 1.15, 0.57, 70.07, 69.99, 19.99, 130.13, 0.07, 0.29, 1.005 * 100 === 100.49999999999999 ? 100.5 : 100.5]) expect(roundToTick(p, 0.01)).toBe(p);
    for (const p of [8.2, 2300.3, 2700.7, 0.7, 1.1, 2.3]) expect(roundToTick(p, 0.1)).toBe(p);
  });

  it('every typed half tick price (70.075, 2300.05, ...) rounds up, whatever its float representation does', () => {
    for (const [tick, dec, n] of [[0.01, 2, 20000], [0.1, 1, 30000], [0.25, 2, 40000], [1, 0, 20000]] as const) {
      for (let k = 1; k < n; k++) {
        const half = Number(((k + 0.5) * tick).toFixed(dec + (tick === 0.25 ? 1 : 1)));
        const got = roundToTick(half, tick);
        if (got !== px(k + 1, tick)) throw new Error(`tick ${tick}: ${half} rounded to ${got}, expected ${px(k + 1, tick)}`);
      }
    }
  });

  it('exact half ticks round up (documented), never to even, and never to -0', () => {
    expect(roundToTick(21000.125, 0.25)).toBe(21000.25);
    expect(roundToTick(21000.375, 0.25)).toBe(21000.5);
    expect(roundToTick(70.075, 0.01)).toBe(70.08);
    expect(roundToTick(2300.05, 0.1)).toBe(2300.1);
    expect(Object.is(roundToTick(-0.001, 0.01), -0)).toBe(false);
    expect(Object.is(roundToTick(-0.004, 0.01), -0)).toBe(false);
  });

  it('CL: orders typed with float trap prices fill at exactly those prices and the P&L is whole ticks', () => {
    const rows: [number, number, number, number][] = [
      [70.0, 70.1, 69.9, 70.0],
      [70.0, 70.06, 69.99, 70.03], // limit buy 70.00 fills at the open
      [70.03, 70.44, 70.0, 70.4],
      [70.4, 70.5, 70.35, 70.45],
    ];
    const bars = barsFrom(T0, rows);
    const e = new ReplayEngine({ bars, contract: CONTRACTS['CL']!, startTime: T0 });
    e.placeOrder({ side: 'long', type: 'limit', qty: 3, price: 70.0, takeProfit: 70.35, stopLoss: 69.57 });
    e.step(2); // bar 1 fills at the open 70.00; bar 2 high 70.44 >= 70.35 takes profit
    const t = e.trades[0]!;
    expect(t).toMatchObject({ entryPrice: 70, exitPrice: 70.35, pnlTicks: 35, grossUsd: 1050, riskUsd: 1290, exitReason: 'take_profit' });
    expect(t.rMultiple).toBeCloseTo(1050 / 1290, 12);
  });

  it('CL with slippage: 70.07 + 3 ticks is 70.1 exactly (not 70.10000000000001)', () => {
    const rows: [number, number, number, number][] = [[70, 70.1, 69.9, 70], [70.07, 70.2, 70.0, 70.1], [70.1, 70.2, 70.0, 70.1], [70.1, 70.2, 70.0, 70.1]];
    const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['MCL']!, startTime: T0, settings: { slippageTicks: 3 } });
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.position!.entryPrice).toBe(70.1);
    expect(Object.is(e.position!.entryPrice, 70.1)).toBe(true);
  });
});

describe('prices at or below zero (CL printed -37.63 on 2020-04-20)', () => {
  const rows: [number, number, number, number][] = [
    [10.5, 10.6, 10.4, 10.5],
    [10.01, 10.3, 9.9, 10.1], // long fills 10.01
    [-5.0, -3.0, -37.63, -36.98], // opens far below the 9.00 stop
    [-36.98, -30.0, -40.32, -37.63],
  ];

  it('a gap through the stop to a negative open exits at the negative open with the right dollars', () => {
    const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['CL']!, startTime: T0 });
    e.placeOrder({ side: 'long', type: 'market', qty: 2, stopLoss: 9.0 });
    e.step(2);
    const t = e.trades[0]!;
    expect(t).toMatchObject({ entryPrice: 10.01, exitPrice: -5, exitReason: 'stop_loss', pnlTicks: -1501, grossUsd: -30020, riskUsd: 2020 });
    expect(t.rMultiple).toBeCloseTo(-30020 / 2020, 10);
    expect(t.maeTicks).toBe(1501);
  });

  it('a market order and the end of data work with prices below zero', () => {
    const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['MCL']!, startTime: T0 });
    e.stepTo(T0 + 120);
    expect(e.lastPrice).toBe(-36.98);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step(); // fills at -36.98, last bar closes -37.63
    expect(e.trades[0]).toMatchObject({ entryPrice: -36.98, exitPrice: -37.63, pnlTicks: -65, grossUsd: -65, exitReason: 'end_of_data' });
  });

  it('a short at a negative price: P&L, MAE and MFE signs', () => {
    const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['CL']!, startTime: T0 });
    e.stepTo(T0 + 120);
    e.placeOrder({ side: 'short', type: 'market', qty: 1 });
    e.step();
    const t = e.trades[0]!;
    expect(t.entryPrice).toBe(-36.98);
    expect(t.pnlTicks).toBe(65);
    expect(t.grossUsd).toBe(650);
    expect(t.mfeTicks).toBe(Math.round((-36.98 - -40.32) / 0.01));
    expect(t.maeTicks).toBe(Math.round((-30 - -36.98) / 0.01));
  });
});

describe('float drift: thousands of real engine trades, totals must equal an independent integer cents tally', () => {
  function manyTrades(symbol: string, seed: number, commission: number): { trades: Trade[]; tickValue: number } {
    const c = CONTRACTS[symbol]!;
    const rand = lcg(seed);
    const bars = toBars(randomTickBars(rand, c, 24000, { vol: 4 }), c.tickSize);
    const e = new ReplayEngine({ bars, contract: c, startTime: bars[2]!.time, settings: { commissionPerSide: commission } });
    while (!e.isAtEnd()) {
      if (!e.position && !e.workingOrder) {
        const last = tk(e.lastPrice, c.tickSize);
        const side = rand() < 0.5 ? 'long' : 'short';
        const sl = 1 + Math.floor(rand() * 4);
        const tp = 1 + Math.floor(rand() * 5);
        e.placeOrder({
          side,
          type: 'market',
          qty: 1 + Math.floor(rand() * 3),
          stopLoss: px(side === 'long' ? last - sl : last + sl, c.tickSize),
          takeProfit: px(side === 'long' ? last + tp : last - tp, c.tickSize),
        });
      }
      e.step();
    }
    return { trades: e.trades, tickValue: c.tickValue };
  }

  for (const [symbol, commission] of [['MES', 0.62], ['CL', 0.35], ['ES', 2.05], ['MCL', 0.37], ['RTY', 1.1]] as const) {
    it(`${symbol} with $${commission} per side: 3000+ trades, stats equal exact cents arithmetic`, () => {
      const { trades, tickValue } = manyTrades(symbol, 12345 + symbol.length * 17, commission);
      expect(trades.length).toBeGreaterThan(3000);
      // independent tally straight from ticks, quantity and commission
      let netC = 0;
      let grossC = 0;
      let feesC = 0;
      let profitC = 0;
      let lossC = 0;
      let equityC = 5_000_000;
      let peakC = equityC;
      let ddC = 0;
      const curve: number[] = [equityC];
      const tvC = Math.round(tickValue * 100);
      const commC = Math.round(commission * 100);
      for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
        const g = t.pnlTicks * tvC * t.qty;
        const f = commC * t.qty * 2;
        expect(t.grossUsd).toBe(g / 100 + 0);
        expect(t.feesUsd).toBe(f / 100);
        expect(t.netUsd).toBe((g - f) / 100 + 0);
        grossC += g;
        feesC += f;
        netC += g - f;
        if (g - f > 0) profitC += g - f;
        else if (g - f < 0) lossC += g - f;
        equityC += g - f;
        peakC = Math.max(peakC, equityC);
        ddC = Math.max(ddC, peakC - equityC);
        curve.push(equityC);
      }
      const s = computeStats(trades, 50000);
      expect(s.netUsd).toBe(netC / 100);
      expect(s.feesUsd).toBe(feesC / 100);
      expect(s.grossProfitUsd).toBe(profitC / 100);
      expect(s.grossLossUsd).toBe(lossC / 100);
      expect(s.netUsd).toBe(s.grossProfitUsd + s.grossLossUsd === netC / 100 ? netC / 100 : (profitC + lossC) / 100);
      expect(s.maxDrawdownUsd).toBe(ddC / 100);
      expect(s.equityCurve.map((p) => Math.round(p.equity * 100))).toEqual(curve);
      expect(s.equityCurve.at(-1)!.equity).toBe((5_000_000 + netC) / 100);
      expect(grossC - feesC).toBe(netC);
      expect(s.maxDrawdownPct).toBeGreaterThanOrEqual(0);
      // naive float summation of the per trade values is allowed to drift, the stats are not
      const naive = trades.reduce((a, t) => a + t.netUsd, 0);
      expect(Math.abs(naive - s.netUsd)).toBeLessThan(1e-6);
    }, 60_000);
  }
});

describe('cents rounding of fees', () => {
  const rows: [number, number, number, number][] = [
    [100, 100, 100, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 100, 100, 100],
  ];
  function fees(commission: number, qty: number): { fees: number; net: number } {
    const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['MES']!, startTime: T0, settings: { commissionPerSide: commission } });
    e.placeOrder({ side: 'long', type: 'market', qty });
    e.step();
    e.closePosition();
    e.step();
    return { fees: e.trades[0]!.feesUsd, net: e.trades[0]!.netUsd };
  }
  const table: [number, number, number][] = [
    [0.62, 1, 1.24],
    [0.62, 7, 8.68],
    [2.05, 3, 12.3],
    [0.333, 3, 2.0],
    [0.0025, 1, 0.01], // 0.005 half a cent: away from zero
    [0.00249, 1, 0.0],
    [1.255, 1, 2.51],
    [0.1, 3, 0.6],
    [0.7, 3, 4.2],
    [4.35, 1, 8.7],
    [1.005, 1, 2.01],
    [0.285, 5, 2.85],
  ];
  for (const [c, q, want] of table) {
    it(`commission ${c} x ${q} contracts x 2 sides = $${want}`, () => {
      const r = fees(c, q);
      expect(r.fees).toBe(want);
      expect(r.net).toBe(Math.round((0 - want) * 100) / 100 + 0);
    });
  }
  it('a breakeven trade has +0 not -0 in every numeric field, long and short', () => {
    for (const side of ['long', 'short'] as const) {
      const e = new ReplayEngine({ bars: barsFrom(T0, rows), contract: CONTRACTS['NQ']!, startTime: T0 });
      e.placeOrder({ side, type: 'market', qty: 1, stopLoss: side === 'long' ? 98 : 102 });
      e.step();
      e.closePosition();
      e.step();
      const t = e.trades[0]!;
      for (const v of [t.pnlTicks, t.grossUsd, t.netUsd, t.feesUsd, t.rMultiple!]) expect(Object.is(v, -0), `${side} ${JSON.stringify(t)}`).toBe(false);
      expect(t.rMultiple).toBe(0);
    }
  });
});

// ---- computeStats against an independent model ----

interface Spec {
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  netC: number;
  rMultiple: number | null;
  setup?: string;
}

function mkTrade(i: number, s: Spec): Trade {
  return {
    id: `t${i}`,
    symbol: 'NQ',
    side: s.side,
    qty: 1,
    entryTime: s.entryTime,
    entryPrice: 100,
    exitTime: s.exitTime,
    exitPrice: 100,
    exitReason: 'manual',
    pnlTicks: 0,
    grossUsd: s.netC / 100,
    feesUsd: 0,
    netUsd: s.netC / 100,
    riskUsd: s.rMultiple === null ? null : 100,
    rMultiple: s.rMultiple,
    maeTicks: 0,
    mfeTicks: 0,
    holdSeconds: s.exitTime - s.entryTime,
    journal: s.setup === undefined ? {} : { setup: s.setup },
  };
}

describe('computeStats: independent model over random trade books', () => {
  const SESSION = (t: number): string | null => {
    const w = etWall(t);
    const m = w.hour * 60 + w.minute;
    if (m >= 18 * 60 || m < 3 * 60) return 'Asia';
    if (m < 9 * 60 + 30) return 'London';
    if (m < 12 * 60) return 'NY AM';
    if (m < 17 * 60) return 'NY PM';
    return null;
  };
  const WEEKDAY = (t: number): string | null => {
    const d = new Date(`${refTradingDay(t)}T12:00:00Z`).getUTCDay();
    return ({ 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' } as Record<number, string>)[d] ?? null;
  };

  it('2000 random trades across DST weeks: every scalar, every group, the equity curve and the drawdown', () => {
    const rand = lcg(2024);
    const specs: Spec[] = [];
    const starts = [utc('2024-03-03T00:00:00Z'), utc('2024-10-27T00:00:00Z')];
    for (let i = 0; i < 2000; i++) {
      const base = starts[i % 2]!;
      const entry = base + Math.floor(rand() * 14 * 86400);
      const net = Math.round((rand() - 0.46) * 40000) * (rand() < 0.08 ? 0 : 1); // cents, some exact zeros
      specs.push({
        side: rand() < 0.5 ? 'long' : 'short',
        entryTime: entry,
        exitTime: entry + 60 * (1 + Math.floor(rand() * 120)),
        netC: net,
        rMultiple: rand() < 0.15 ? null : (rand() - 0.4) * 3,
        ...(rand() < 0.7 ? { setup: ['ORB', 'VWAP', 'fade', ' ORB '][Math.floor(rand() * 4)]! } : rand() < 0.5 ? { setup: '' } : {}),
      });
    }
    const trades = specs.map((s, i) => mkTrade(i, s));
    const shuffled = [...trades].sort(() => rand() - 0.5); // input order must not matter
    const st = computeStats(shuffled, 50000);

    const ordered = [...specs.map((s, i) => ({ s, i }))].sort((a, b) => a.s.exitTime - b.s.exitTime || a.i - b.i).map((x) => x.s);
    let wins = 0, losses = 0, be = 0, gp = 0, gl = 0, net = 0, hold = 0, sw = 0, sl = 0, mw = 0, ml = 0, eq = 5_000_000, peak = eq, dd = 0, ddPeak = eq;
    let big: number | null = null, small: number | null = null, rs = 0, rn = 0;
    const curve = [eq];
    for (const s of ordered) {
      net += s.netC;
      hold += s.exitTime - s.entryTime;
      if (s.rMultiple !== null) (rs += s.rMultiple), rn++;
      if (s.netC > 0) (wins++, (gp += s.netC), (sw++), (sl = 0), (big = big === null ? s.netC : Math.max(big, s.netC)));
      else if (s.netC < 0) (losses++, (gl += s.netC), (sl++), (sw = 0), (small = small === null ? s.netC : Math.min(small, s.netC)));
      else (be++, (sw = 0), (sl = 0));
      mw = Math.max(mw, sw);
      ml = Math.max(ml, sl);
      eq += s.netC;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) (dd = peak - eq), (ddPeak = peak);
      curve.push(eq);
    }
    expect(st.trades).toBe(2000);
    expect([st.wins, st.losses, st.breakevens]).toEqual([wins, losses, be]);
    expect(st.netUsd).toBe(net / 100);
    expect(st.grossProfitUsd).toBe(gp / 100);
    expect(st.grossLossUsd).toBe(gl / 100);
    expect(st.winRate).toBeCloseTo(wins / (wins + losses), 12);
    expect(st.profitFactor).toBeCloseTo(gp / Math.abs(gl), 10);
    expect(st.avgWinUsd).toBeCloseTo(gp / 100 / wins, 10);
    expect(st.avgLossUsd).toBeCloseTo(gl / 100 / losses, 10);
    expect(st.payoffRatio).toBeCloseTo(gp / wins / (Math.abs(gl) / losses), 10);
    expect(st.expectancyUsd).toBeCloseTo(net / 100 / 2000, 10);
    expect(st.avgR).toBeCloseTo(rs / rn, 10);
    expect(st.largestWinUsd).toBe(big! / 100);
    expect(st.largestLossUsd).toBe(small! / 100);
    expect([st.maxConsecutiveWins, st.maxConsecutiveLosses]).toEqual([mw, ml]);
    expect(st.maxDrawdownUsd).toBe(dd / 100);
    expect(st.maxDrawdownPct).toBeCloseTo((dd * 100) / ddPeak, 10);
    expect(st.avgHoldSeconds).toBeCloseTo(hold / 2000, 8);
    expect(st.equityCurve.map((p) => Math.round(p.equity * 100))).toEqual(curve);
    expect(st.equityCurve[0]!.time).toBe(ordered[0]!.entryTime);
    expect(st.equityCurve.slice(1).map((p) => p.time)).toEqual(ordered.map((s) => s.exitTime));

    // groups
    const exp = (pick: (s: Spec) => string | null, keys: string[]): Record<string, { n: number; netC: number; wins: number; losses: number }> => {
      const out: Record<string, { n: number; netC: number; wins: number; losses: number }> = {};
      for (const k of keys) out[k] = { n: 0, netC: 0, wins: 0, losses: 0 };
      for (const s of specs) {
        const k = pick(s);
        if (k === null || out[k] === undefined) continue;
        out[k]!.n++;
        out[k]!.netC += s.netC;
        if (s.netC > 0) out[k]!.wins++;
        if (s.netC < 0) out[k]!.losses++;
      }
      return out;
    };
    const check = (got: Record<string, { trades: number; netUsd: number; winRate: number | null }>, want: ReturnType<typeof exp>, label: string): void => {
      for (const [k, w] of Object.entries(want)) {
        expect(got[k]!.trades, `${label} ${k} trades`).toBe(w.n);
        expect(got[k]!.netUsd, `${label} ${k} net`).toBe(w.netC / 100);
        if (w.wins + w.losses === 0) expect(got[k]!.winRate, `${label} ${k} winRate`).toBeNull();
        else expect(got[k]!.winRate!, `${label} ${k} winRate`).toBeCloseTo(w.wins / (w.wins + w.losses), 12);
      }
    };
    check(st.bySession, exp((s) => SESSION(s.entryTime), ['Asia', 'London', 'NY AM', 'NY PM']), 'session');
    check(st.byWeekday, exp((s) => WEEKDAY(s.entryTime), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']), 'weekday');
    check(st.bySide, exp((s) => s.side, ['long', 'short']), 'side');
    const setups = exp((s) => (s.setup ?? '').trim() || '(none)', ['(none)', 'ORB', 'VWAP', 'fade']);
    check(st.bySetup, setups, 'setup');
    expect(Object.keys(st.bySetup).sort()).toEqual(['(none)', 'ORB', 'VWAP', 'fade']);
  });

  it('session boundaries by ET entry time, in a standard time week and a daylight time week', () => {
    // entry (UTC) for an ET wall time on a given Tuesday in winter (EST, +5) and summer (EDT, +4)
    const cases: [string, number, string][] = [
      ['02:59', 0, 'Asia'], ['03:00', 0, 'London'], ['09:29', 0, 'London'], ['09:30', 0, 'NY AM'], ['11:59', 0, 'NY AM'],
      ['12:00', 0, 'NY PM'], ['16:59', 0, 'NY PM'], ['18:00', 0, 'Asia'], ['23:59', 0, 'Asia'], ['00:00', 0, 'Asia'],
    ];
    for (const [tuesday, off] of [['2024-01-09', 5], ['2024-07-09', 4], ['2024-03-12', 4], ['2024-11-05', 5]] as const) {
      for (const [hhmm, , want] of cases) {
        const [h, m] = hhmm.split(':').map(Number) as [number, number];
        const t = utc(`${tuesday}T00:00:00Z`) + (h + off) * 3600 + m * 60;
        const st = computeStats([mkTrade(0, { side: 'long', entryTime: t, exitTime: t + 60, netC: 100, rMultiple: 1 })], 50000);
        const hit = Object.entries(st.bySession).filter(([, g]) => g.trades === 1).map(([k]) => k);
        expect(hit, `${tuesday} ${hhmm} ET`).toEqual([want]);
      }
    }
  });

  it('weekday follows the trading day: Sunday 18:00 ET is Monday, Friday afternoon is Friday, Friday 18:00 and the weekend have no bucket', () => {
    const at = (iso: string): string[] => {
      const t = utc(iso);
      const st = computeStats([mkTrade(0, { side: 'long', entryTime: t, exitTime: t + 60, netC: 100, rMultiple: null })], 50000);
      return Object.entries(st.byWeekday).filter(([, g]) => g.trades === 1).map(([k]) => k);
    };
    expect(at('2024-01-07T23:00:00Z')).toEqual(['Mon']); // Sunday 18:00 EST
    expect(at('2024-03-10T22:00:00Z')).toEqual(['Mon']); // Sunday 18:00 EDT, the night clocks changed
    expect(at('2024-11-03T23:00:00Z')).toEqual(['Mon']); // Sunday 18:00 EST, the night clocks changed back
    expect(at('2024-01-07T22:59:00Z')).toEqual([]); // Sunday 17:59 ET: still the Sunday trading day
    expect(at('2024-01-12T21:59:00Z')).toEqual(['Fri']); // Friday 16:59 ET
    expect(at('2024-01-12T23:00:00Z')).toEqual([]); // Friday 18:00 ET opens Saturday's trading day
    expect(at('2024-01-13T15:00:00Z')).toEqual([]); // Saturday
    expect(at('2024-01-09T23:00:00Z')).toEqual(['Wed']); // Tuesday 18:00 ET opens Wednesday
  });

  it('BUG?: the builder notes say an entry inside the 17:00 to 18:00 halt gets no session and no weekday bucket', () => {
    const t = utc('2024-01-09T22:30:00Z'); // Tuesday 17:30 ET
    const st = computeStats([mkTrade(0, { side: 'long', entryTime: t, exitTime: t + 60, netC: 100, rMultiple: null })], 50000);
    expect(Object.values(st.bySession).reduce((s, g) => s + g.trades, 0)).toBe(0);
    expect(Object.values(st.byWeekday).reduce((s, g) => s + g.trades, 0), 'weekday bucket for a halt entry').toBe(0);
  });

  it('maxDrawdownPct is measured on the same episode as maxDrawdownUsd (pins the builder choice, a SPEC question: see report)', () => {
    // equity: 50000 -> 49500 (-1%) ... later 60000 -> 54000 (-$6000, -10%)
    const mk = (net: number[]): Trade[] => net.map((n, i) => mkTrade(i, { side: 'long', entryTime: 1000 + i * 100, exitTime: 1050 + i * 100, netC: n * 100, rMultiple: null }));
    const st = computeStats(mk([-500, 10500, -6000]), 50000);
    expect(st.maxDrawdownUsd).toBe(6000);
    expect(st.maxDrawdownPct).toBeCloseTo(10, 10);
    const small = computeStats(mk([-40000, 70000, -20000]), 50000); // first episode: -80% of 50000, second: -$20000 = 16.7%
    expect(small.maxDrawdownUsd).toBe(40000);
    expect(small.maxDrawdownPct).toBeCloseTo(80, 10);
  });

  it('degenerate books: empty, one trade, all wins, all losses, only breakevens', () => {
    const e = computeStats([], 50000);
    expect(e).toMatchObject({ trades: 0, winRate: null, netUsd: 0, profitFactor: null, expectancyUsd: null, avgR: null, maxDrawdownUsd: 0, maxDrawdownPct: 0, avgHoldSeconds: null });
    expect(e.equityCurve).toEqual([]);
    const mk = (nets: number[]): Trade[] => nets.map((n, i) => mkTrade(i, { side: 'long', entryTime: 1000 + i * 100, exitTime: 1050 + i * 100, netC: n, rMultiple: null }));
    const w = computeStats(mk([100, 200]), 1000);
    expect([w.winRate, w.profitFactor, w.avgLossUsd, w.payoffRatio, w.largestLossUsd, w.maxDrawdownUsd]).toEqual([1, null, null, null, null, 0]);
    const l = computeStats(mk([-100, -250]), 1000);
    expect([l.winRate, l.profitFactor, l.avgWinUsd, l.payoffRatio, l.largestWinUsd]).toEqual([0, 0, null, null, null]);
    expect(l.maxDrawdownUsd).toBe(3.5);
    expect(l.maxDrawdownPct).toBeCloseTo(0.35, 10);
    const z = computeStats(mk([0, 0, 0]), 1000);
    expect([z.winRate, z.breakevens, z.profitFactor, z.expectancyUsd]).toEqual([null, 3, null, 0]);
  });

  it('BUG?: maxDrawdownPct stays within 0 to 100 even for a book that loses more than the account (builder notes say 0 to 100)', () => {
    const t = [-60000, -10000].map((n, i) => mkTrade(i, { side: 'short', entryTime: 1000 + i * 100, exitTime: 1050 + i * 100, netC: n * 100, rMultiple: null }));
    const st = computeStats(t, 50000);
    expect(st.maxDrawdownUsd).toBe(70000);
    expect(st.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(st.maxDrawdownPct, 'losing more than the whole account is more than 100 percent of the starting balance').toBeLessThanOrEqual(100);
  });

  it('equity curve points may share a timestamp and keep exit order (two exits on the same bar)', () => {
    const a = mkTrade(0, { side: 'long', entryTime: 100, exitTime: 200, netC: 500, rMultiple: null });
    const b = mkTrade(1, { side: 'long', entryTime: 150, exitTime: 200, netC: -200, rMultiple: null });
    const st = computeStats([b, a], 1000);
    // equal exit times: input order breaks the tie, never an NaN or a reorder by value
    expect(st.equityCurve.map((p) => p.time)).toEqual([150, 200, 200]);
    expect(st.equityCurve.map((p) => p.equity)).toEqual([1000, 998, 1003]);
  });

  it('computeStats does not mutate its input or the trades in it', () => {
    const a = mkTrade(0, { side: 'long', entryTime: 100, exitTime: 300, netC: 500, rMultiple: 1 });
    const b = mkTrade(1, { side: 'short', entryTime: 50, exitTime: 200, netC: -200, rMultiple: -1 });
    const input = [a, b];
    const before = JSON.stringify(input);
    computeStats(input, 1000);
    expect(JSON.stringify(input)).toBe(before);
    expect(input[0]).toBe(a);
  });
});
