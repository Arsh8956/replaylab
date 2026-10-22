import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/stats';
import type { Side, Trade } from '../src/types';
import { utc } from './helpers';

let seq = 0;
/** Minimal Trade: only the fields computeStats reads are meaningful. grossUsd = net + fees. */
function trade(p: { entry: string; hold?: number; net: number; fees?: number; r?: number | null; setup?: string; side?: Side; id?: string }): Trade {
  const entryTime = utc(p.entry);
  const hold = p.hold ?? 600;
  const fees = p.fees ?? 0;
  return {
    id: p.id ?? `t${++seq}`,
    symbol: 'NQ',
    side: p.side ?? 'long',
    qty: 1,
    entryTime,
    entryPrice: 100,
    exitTime: entryTime + hold,
    exitPrice: 101,
    exitReason: 'manual',
    pnlTicks: 0,
    grossUsd: p.net + fees,
    feesUsd: fees,
    netUsd: p.net,
    riskUsd: p.r == null ? null : 100,
    rMultiple: p.r ?? null,
    maeTicks: 0,
    mfeTicks: 0,
    holdSeconds: hold,
    journal: p.setup === undefined ? {} : { setup: p.setup },
  };
}

// Five trades, chronological by exit. ET times in the comments (January, EST = UTC-5).
const A = trade({ id: 'A', entry: '2024-01-02T14:35:00Z', hold: 900, net: 200, fees: 5, r: 2, setup: 'Breakout' }); // Tue 09:35 ET, NY AM, long, exits 14:50Z
const B = trade({ id: 'B', entry: '2024-01-02T20:30:00Z', hold: 600, net: -100, fees: 5, r: -1, setup: 'Breakout', side: 'short' }); // Tue 15:30 ET, NY PM
const C = trade({ id: 'C', entry: '2024-01-03T13:00:00Z', hold: 1200, net: -300, fees: 5, r: -1.5, setup: 'Fade', side: 'short' }); // Wed 08:00 ET, London
const D = trade({ id: 'D', entry: '2024-01-05T03:30:00Z', hold: 300, net: 500, fees: 5, setup: 'Fade' }); // Thu 22:30 ET, Asia, trading day Fri
const E = trade({ id: 'E', entry: '2024-01-08T00:00:00Z', hold: 600, net: 0, fees: 5 }); // Sun 19:00 ET, Asia, trading day Mon, breakeven, no setup

describe('computeStats: golden set of five trades, starting balance 50000', () => {
  // shuffled on purpose: computeStats orders by exit time itself
  const input = [D, A, E, C, B];
  const s = computeStats(input, 50000);

  it('counts and rates', () => {
    expect(s.trades).toBe(5);
    expect(s.wins).toBe(2); // A +200, D +500
    expect(s.losses).toBe(2); // B -100, C -300
    expect(s.breakevens).toBe(1); // E
    expect(s.winRate).toBe(0.5); // 2 / (2 + 2), breakevens excluded
  });

  it('money', () => {
    expect(s.netUsd).toBe(300); // 200 - 100 - 300 + 500 + 0
    expect(s.grossProfitUsd).toBe(700); // 200 + 500
    expect(s.grossLossUsd).toBe(-400); // -100 - 300
    expect(s.feesUsd).toBe(25); // 5 * 5
    expect(s.profitFactor).toBe(1.75); // 700 / 400
    expect(s.avgWinUsd).toBe(350); // 700 / 2
    expect(s.avgLossUsd).toBe(-200); // -400 / 2
    expect(s.payoffRatio).toBe(1.75); // 350 / 200
    expect(s.expectancyUsd).toBe(60); // 300 / 5
    expect(s.largestWinUsd).toBe(500);
    expect(s.largestLossUsd).toBe(-300);
  });

  it('avgR is the mean over trades that have an R (A 2, B -1, C -1.5)', () => {
    expect(s.avgR).toBeCloseTo(-0.5 / 3, 12); // (2 - 1 - 1.5) / 3
  });

  it('streaks by exit order A+ B- C- D+ E0 (a breakeven breaks both)', () => {
    expect(s.maxConsecutiveWins).toBe(1);
    expect(s.maxConsecutiveLosses).toBe(2); // B, C
  });

  it('closed trade equity curve: starting balance at the first entry, then one point per exit', () => {
    expect(s.equityCurve).toEqual([
      { time: utc('2024-01-02T14:35:00Z'), equity: 50000 }, // first entry (A)
      { time: utc('2024-01-02T14:50:00Z'), equity: 50200 }, // A exits
      { time: utc('2024-01-02T20:40:00Z'), equity: 50100 }, // B
      { time: utc('2024-01-03T13:20:00Z'), equity: 49800 }, // C
      { time: utc('2024-01-05T03:35:00Z'), equity: 50300 }, // D
      { time: utc('2024-01-08T00:10:00Z'), equity: 50300 }, // E
    ]);
  });

  it('max drawdown: peak 50200 to trough 49800', () => {
    expect(s.maxDrawdownUsd).toBe(400);
    expect(s.maxDrawdownPct).toBeCloseTo((400 / 50200) * 100, 10); // 0.796812749...
  });

  it('average hold: (900 + 600 + 1200 + 300 + 600) / 5', () => {
    expect(s.avgHoldSeconds).toBe(720);
  });

  it('bySetup, with "(none)" for no setup', () => {
    expect(s.bySetup).toEqual({
      Breakout: { trades: 2, winRate: 0.5, netUsd: 100, expectancyUsd: 50, avgR: 0.5 }, // A, B
      Fade: { trades: 2, winRate: 0.5, netUsd: 200, expectancyUsd: 100, avgR: -1.5 }, // C, D (D has no R)
      '(none)': { trades: 1, winRate: null, netUsd: 0, expectancyUsd: 0, avgR: null }, // E breakeven
    });
  });

  it('bySession by ET entry time', () => {
    expect(s.bySession).toEqual({
      Asia: { trades: 2, winRate: 1, netUsd: 500, expectancyUsd: 250, avgR: null }, // D 22:30 ET, E Sunday 19:00 ET
      London: { trades: 1, winRate: 0, netUsd: -300, expectancyUsd: -300, avgR: -1.5 }, // C
      'NY AM': { trades: 1, winRate: 1, netUsd: 200, expectancyUsd: 200, avgR: 2 }, // A
      'NY PM': { trades: 1, winRate: 0, netUsd: -100, expectancyUsd: -100, avgR: -1 }, // B
    });
  });

  it('byWeekday uses the trading day (Sunday 19:00 ET is Monday, Thursday 22:30 ET is Friday)', () => {
    expect(s.byWeekday).toEqual({
      Mon: { trades: 1, winRate: null, netUsd: 0, expectancyUsd: 0, avgR: null }, // E
      Tue: { trades: 2, winRate: 0.5, netUsd: 100, expectancyUsd: 50, avgR: 0.5 }, // A, B
      Wed: { trades: 1, winRate: 0, netUsd: -300, expectancyUsd: -300, avgR: -1.5 }, // C
      Thu: { trades: 0, winRate: null, netUsd: 0, expectancyUsd: null, avgR: null },
      Fri: { trades: 1, winRate: 1, netUsd: 500, expectancyUsd: 500, avgR: null }, // D
    });
  });

  it('bySide', () => {
    expect(s.bySide.long).toEqual({ trades: 3, winRate: 1, netUsd: 700, expectancyUsd: 700 / 3, avgR: 2 }); // A, D, E; only A has an R
    expect(s.bySide.short).toEqual({ trades: 2, winRate: 0, netUsd: -400, expectancyUsd: -200, avgR: -1.25 }); // B, C: (-1 - 1.5) / 2
  });

  it('does not reorder or mutate its input', () => {
    expect(input.map((t) => t.id)).toEqual(['D', 'A', 'E', 'C', 'B']);
    expect(computeStats([A, B, C, D, E], 50000)).toEqual(s);
  });
});

describe('computeStats: null cases', () => {
  it('no trades', () => {
    const s = computeStats([], 50000);
    expect(s).toMatchObject({
      trades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRate: null,
      netUsd: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      feesUsd: 0,
      profitFactor: null,
      avgWinUsd: null,
      avgLossUsd: null,
      payoffRatio: null,
      expectancyUsd: null,
      avgR: null,
      largestWinUsd: null,
      largestLossUsd: null,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      maxDrawdownUsd: 0,
      maxDrawdownPct: 0,
      avgHoldSeconds: null,
      equityCurve: [],
    });
    expect(s.bySetup).toEqual({});
    expect(Object.keys(s.bySession)).toEqual(['Asia', 'London', 'NY AM', 'NY PM']);
    expect(Object.keys(s.byWeekday)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(Object.keys(s.bySide)).toEqual(['long', 'short']);
    for (const g of [...Object.values(s.bySession), ...Object.values(s.byWeekday), ...Object.values(s.bySide)]) {
      expect(g).toEqual({ trades: 0, winRate: null, netUsd: 0, expectancyUsd: null, avgR: null });
    }
  });

  it('only winners: no profit factor, no loss stats', () => {
    const s = computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: 100 }), trade({ entry: '2024-01-02T16:00:00Z', net: 50 })], 50000);
    expect(s).toMatchObject({ winRate: 1, profitFactor: null, avgWinUsd: 75, avgLossUsd: null, payoffRatio: null, largestWinUsd: 100, largestLossUsd: null, grossLossUsd: 0, maxDrawdownUsd: 0, maxDrawdownPct: 0 });
  });

  it('only losers: profit factor is 0, no win stats', () => {
    const s = computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: -100 }), trade({ entry: '2024-01-02T16:00:00Z', net: -50 })], 50000);
    expect(s).toMatchObject({ winRate: 0, profitFactor: 0, avgWinUsd: null, avgLossUsd: -75, payoffRatio: null, largestWinUsd: null, largestLossUsd: -100, grossProfitUsd: 0 });
  });

  it('only breakevens: win rate null, expectancy 0', () => {
    const s = computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: 0 })], 50000);
    expect(s).toMatchObject({ trades: 1, breakevens: 1, winRate: null, profitFactor: null, expectancyUsd: 0, avgWinUsd: null, avgLossUsd: null, largestWinUsd: null, largestLossUsd: null });
  });

  it('avgR is null when no trade has an R, and an R of 0 still counts', () => {
    expect(computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: 10 })], 50000).avgR).toBeNull();
    const s = computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: 10, r: 0 }), trade({ entry: '2024-01-02T16:00:00Z', net: 10, r: 1 })], 50000);
    expect(s.avgR).toBe(0.5);
  });
});

describe('computeStats: definitions', () => {
  it('win and loss are decided by netUsd, not gross (fees can turn a small gross win into a loss)', () => {
    const t = trade({ entry: '2024-01-02T15:00:00Z', net: -2, fees: 5 }); // gross +3, net -2
    expect(t.grossUsd).toBe(3);
    const s = computeStats([t], 50000);
    expect(s).toMatchObject({ wins: 0, losses: 1, grossLossUsd: -2, netUsd: -2 });
  });

  it('money sums are exact to the cent', () => {
    const s = computeStats([trade({ entry: '2024-01-02T15:00:00Z', net: 0.1 }), trade({ entry: '2024-01-02T16:00:00Z', net: 0.2 })], 50000);
    expect(s.netUsd).toBe(0.3); // not 0.30000000000000004
    expect(s.grossProfitUsd).toBe(0.3);
    expect(s.equityCurve[2]!.equity).toBe(50000.3);
  });

  it('streaks: W W W L L W 0 L gives 3 wins and 2 losses; a breakeven breaks a streak', () => {
    const nets = [10, 10, 10, -5, -5, 10, 0, -5];
    const trades = nets.map((net, i) => trade({ entry: `2024-01-02T${String(10 + i).padStart(2, '0')}:00:00Z`, net }));
    const s = computeStats(trades, 50000);
    expect(s.maxConsecutiveWins).toBe(3);
    expect(s.maxConsecutiveLosses).toBe(2);
    const split = computeStats([10, 0, 10].map((net, i) => trade({ entry: `2024-01-02T${10 + i}:00:00Z`, net })), 50000);
    expect(split.maxConsecutiveWins).toBe(1);
    const losses = computeStats([-1, -1, 0, -1].map((net, i) => trade({ entry: `2024-01-02T${10 + i}:00:00Z`, net })), 50000);
    expect(losses.maxConsecutiveLosses).toBe(2);
  });

  it('streaks follow exit time, not input order', () => {
    const t1 = trade({ entry: '2024-01-02T10:00:00Z', net: 10 });
    const t2 = trade({ entry: '2024-01-02T11:00:00Z', net: -10 });
    const t3 = trade({ entry: '2024-01-02T12:00:00Z', net: 10 });
    const t4 = trade({ entry: '2024-01-02T13:00:00Z', net: 10 });
    expect(computeStats([t4, t2, t1, t3], 50000).maxConsecutiveWins).toBe(2); // t3, t4
  });

  it('drawdown from the starting balance when the account starts with losses: 50000, 49000, 49500, 48500', () => {
    const s = computeStats([-1000, 500, -1000].map((net, i) => trade({ entry: `2024-01-02T${10 + i}:00:00Z`, net })), 50000);
    expect(s.maxDrawdownUsd).toBe(1500); // 50000 -> 48500
    expect(s.maxDrawdownPct).toBeCloseTo(3, 10); // 1500 / 50000
  });

  it('drawdown tracks the running peak: 52000 peak, 49000 trough', () => {
    const nets = [2000, -1000, 500, -2500, 100];
    const s = computeStats(nets.map((net, i) => trade({ entry: `2024-01-02T${10 + i}:00:00Z`, net })), 50000);
    // equity: 52000, 51000, 51500, 49000, 49100
    expect(s.maxDrawdownUsd).toBe(3000);
    expect(s.maxDrawdownPct).toBeCloseTo((3000 / 52000) * 100, 10); // 5.7692...
  });

  it('percent is taken on the same episode as the dollar drawdown', () => {
    // balance 1000: +1000 (2000), -400 (1600: $400 = 20%), +9000 (10600), -600 (10000: $600 = 5.66%)
    const s = computeStats([1000, -400, 9000, -600].map((net, i) => trade({ entry: `2024-01-02T${10 + i}:00:00Z`, net })), 1000);
    expect(s.maxDrawdownUsd).toBe(600);
    expect(s.maxDrawdownPct).toBeCloseTo((600 / 10600) * 100, 10);
  });

  it('is based on closed trades only: equity curve points are exits', () => {
    const t = trade({ entry: '2024-01-02T15:00:00Z', hold: 3600, net: -250 });
    const s = computeStats([t], 10000);
    expect(s.equityCurve).toEqual([
      { time: t.entryTime, equity: 10000 },
      { time: t.exitTime, equity: 9750 },
    ]);
    expect(s.maxDrawdownUsd).toBe(250);
    expect(s.maxDrawdownPct).toBeCloseTo(2.5, 10);
  });

  it('grouping is stable when two trades exit at the same second (input order kept)', () => {
    const a = trade({ entry: '2024-01-02T10:00:00Z', hold: 600, net: 10, id: 'a' });
    const b = trade({ entry: '2024-01-02T10:05:00Z', hold: 300, net: -10, id: 'b' }); // same exit time
    expect(a.exitTime).toBe(b.exitTime);
    const s = computeStats([a, b], 1000);
    expect(s.equityCurve.map((p) => p.equity)).toEqual([1000, 1010, 1000]);
  });
});

describe('computeStats: ET session buckets (entry times on Tue 2024-01-02, EST = UTC-5)', () => {
  const sessionOf = (iso: string) => {
    const s = computeStats([trade({ entry: iso, net: 10 })], 50000);
    return Object.entries(s.bySession)
      .filter(([, g]) => g.trades === 1)
      .map(([k]) => k);
  };
  it.each([
    ['2024-01-02T07:59:00Z', 'Asia'], // 02:59 ET
    ['2024-01-02T08:00:00Z', 'London'], // 03:00 ET
    ['2024-01-02T14:29:00Z', 'London'], // 09:29 ET
    ['2024-01-02T14:30:00Z', 'NY AM'], // 09:30 ET
    ['2024-01-02T16:59:00Z', 'NY AM'], // 11:59 ET
    ['2024-01-02T17:00:00Z', 'NY PM'], // 12:00 ET
    ['2024-01-02T21:59:00Z', 'NY PM'], // 16:59 ET
    ['2024-01-02T23:00:00Z', 'Asia'], // 18:00 ET
    ['2024-01-03T04:59:00Z', 'Asia'], // 23:59 ET
    ['2024-01-02T05:00:00Z', 'Asia'], // 00:00 ET
  ])('%s is %s', (iso, session) => {
    expect(sessionOf(iso)).toEqual([session]);
  });
  it('the 17:00 to 18:00 ET halt belongs to no session, but the trade is still in the totals', () => {
    expect(sessionOf('2024-01-02T22:00:00Z')).toEqual([]); // 17:00 ET
    expect(sessionOf('2024-01-02T22:59:00Z')).toEqual([]); // 17:59 ET
    expect(computeStats([trade({ entry: '2024-01-02T22:30:00Z', net: 10 })], 50000).trades).toBe(1);
  });
  it('uses ET wall clock in summer too (EDT = UTC-4)', () => {
    expect(sessionOf('2024-07-01T13:29:00Z')).toEqual(['London']); // 09:29 EDT
    expect(sessionOf('2024-07-01T13:30:00Z')).toEqual(['NY AM']); // 09:30 EDT
  });
});

describe('computeStats: weekday of the trading day', () => {
  const dayOf = (iso: string) => {
    const s = computeStats([trade({ entry: iso, net: 10 })], 50000);
    return Object.entries(s.byWeekday)
      .filter(([, g]) => g.trades === 1)
      .map(([k]) => k);
  };
  it.each([
    ['2024-01-07T22:59:00Z', []], // Sun 17:59 ET: trading day is Sunday, no bucket
    ['2024-01-07T23:00:00Z', ['Mon']], // Sun 18:00 ET opens Monday
    ['2024-01-08T00:00:00Z', ['Mon']], // Sun 19:00 ET
    ['2024-01-08T15:00:00Z', ['Mon']], // Mon 10:00 ET
    ['2024-01-08T22:59:00Z', ['Mon']], // Mon 17:59 ET
    ['2024-01-08T23:00:00Z', ['Tue']], // Mon 18:00 ET opens Tuesday
    ['2024-01-05T15:00:00Z', ['Fri']], // Fri 10:00 ET
    ['2024-01-05T23:00:00Z', []], // Fri 18:00 ET: Saturday, no bucket
  ])('%s is %j', (iso, expected) => {
    expect(dayOf(iso)).toEqual(expected);
  });
  it('is DST aware: Sunday 2024-03-10 18:00 EDT is 22:00Z', () => {
    expect(dayOf('2024-03-10T21:59:00Z')).toEqual([]); // 17:59 EDT Sunday
    expect(dayOf('2024-03-10T22:00:00Z')).toEqual(['Mon']);
  });
});

describe('computeStats: setup keys', () => {
  it('trims names and treats blank as "(none)"; odd names are plain keys', () => {
    const s = computeStats(
      [
        trade({ entry: '2024-01-02T15:00:00Z', net: 10, setup: ' ORB ' }),
        trade({ entry: '2024-01-02T16:00:00Z', net: 10, setup: 'ORB' }),
        trade({ entry: '2024-01-02T17:00:00Z', net: 10, setup: '   ' }),
        trade({ entry: '2024-01-02T18:00:00Z', net: 10, setup: '' }),
        trade({ entry: '2024-01-02T19:00:00Z', net: 10, setup: '__proto__' }),
      ],
      50000,
    );
    expect(Object.keys(s.bySetup).sort()).toEqual(['(none)', 'ORB', '__proto__']);
    expect(s.bySetup['ORB']!.trades).toBe(2);
    expect(s.bySetup['(none)']!.trades).toBe(2);
    expect(Object.getOwnPropertyDescriptor(s.bySetup, '__proto__')?.value.trades).toBe(1);
  });
});
