// QA: state. toJSON / fromJSON mid trade must give an engine that behaves exactly like the original
// when stepping on, including a working order, a modified bracket, a queued manual close, journals,
// and every timeframe cache. Also snapshot validation and isolation.
import { describe, expect, it } from 'vitest';
import { CONTRACTS, EngineError, ReplayEngine, computeStats } from '../src/index';
import type { Bar, JournalEntry, SessionSnapshot, Timeframe } from '../src/index';
import { applyToEngine, chooseAction, lcg, randomSettings, randomTickBars, stateOf, toBars } from './qa-support';
import { NQ, T0, barsFrom, type Ohlc } from './helpers';

/** Engine over `rows` plus a flat tail bar (so the last row is not the end of data), and the bars it was built on. */
function build(rows: Ohlc[], settings: Partial<import('../src/index').SessionSettings> = {}): { e: ReplayEngine; bars: Bar[] } {
  const last = rows[rows.length - 1]![3];
  const bars = barsFrom(T0, [...rows, [last, last, last, last]]);
  return { e: new ReplayEngine({ bars, contract: NQ, startTime: T0, settings }), bars };
}

const TFS: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];

/** A small random move, described as data so the same one can be applied to two engines. */
function pickAdvance(rand: () => number): { label: string; run: (e: ReplayEngine) => ReturnType<ReplayEngine['step']> } {
  const r = rand();
  if (r < 0.7) {
    const n = 1 + Math.floor(rand() * 3);
    return { label: `step(${n})`, run: (e) => e.step(n) };
  }
  if (r < 0.85) {
    const tf = (['3m', '5m', '15m'] as const)[Math.floor(rand() * 3)]!;
    return { label: `step(1,${tf})`, run: (e) => e.step(1, tf) };
  }
  if (r < 0.95) {
    const dt = Math.floor(rand() * 600);
    return { label: `stepTo(+${dt})`, run: (e) => e.stepTo(e.cursorTime + dt) };
  }
  const n = 5 + Math.floor(rand() * 15);
  return { label: `step(${n})`, run: (e) => e.step(n) };
}

const roundTrip = (e: ReplayEngine, bars: Bar[]): ReplayEngine => ReplayEngine.fromJSON(JSON.parse(JSON.stringify(e.toJSON())) as SessionSnapshot, bars, e.contract);

function view(e: ReplayEngine, bars: 'none' | 'tail' | 'full'): unknown {
  return {
    cursorTime: e.cursorTime,
    lastPrice: e.lastPrice,
    end: e.isAtEnd(),
    position: e.position,
    working: e.workingOrder,
    trades: e.trades,
    unrealized: e.unrealized(),
    bars:
      bars === 'none'
        ? null
        : TFS.map((tf) => {
            const v = e.getVisibleBars(tf);
            return bars === 'full' ? v : { n: v.length, tail: v.slice(-3) };
          }),
    snapshot: e.toJSON(),
  };
}

describe('round trip through JSON at every single step gives the same replay as never serialising', () => {
  for (const symbol of ['NQ', 'MES', 'CL', 'RTY'] as const) {
    it(`${symbol}: serialise and restore before every step, random orders, brackets, queued closes and journals`, () => {
      const contract = CONTRACTS[symbol]!;
      for (let seed = 1; seed <= 3; seed++) {
        const rand = lcg(seed * 131 + 9);
        const bars = toBars(randomTickBars(rand, contract, 1100), contract.tickSize);
        const settings = randomSettings(rand);
        const straight = new ReplayEngine({ bars, contract, startTime: bars[3]!.time, settings });
        let chained = new ReplayEngine({ bars, contract, startTime: bars[3]!.time, settings });
        let iter = 0;
        let journals = 0;
        let sawWorking = 0;
        let sawPendingClose = 0;
        let sawBracketMove = 0;
        while (!straight.isAtEnd() && iter < 3000) {
          const action = chooseAction(rand, stateOf(straight));
          if (action.k === 'modOrder' || action.k === 'place') sawWorking++;
          if (action.k === 'close') sawPendingClose++;
          if (action.k === 'modBracket') sawBracketMove++;
          chained = roundTrip(chained, bars); // restore in the middle of whatever state we are in
          applyToEngine(straight, action);
          applyToEngine(chained, action);
          expect(view(chained, 'none'), `${symbol} seed ${seed} iter ${iter} after ${action.k}`).toEqual(view(straight, 'none'));

          chained = roundTrip(chained, bars);
          const adv = pickAdvance(rand);
          const evStraight = adv.run(straight);
          const evChained = adv.run(chained);
          expect(evChained, `${symbol} seed ${seed} iter ${iter} events after ${adv.label}`).toEqual(evStraight);
          const mode = iter % 160 === 0 ? 'full' : iter % 8 === 0 ? 'tail' : 'none';
          expect(view(chained, mode), `${symbol} seed ${seed} iter ${iter} after ${adv.label}`).toEqual(view(straight, mode));

          // journal the newest trade now and then, on both
          const ts = straight.trades;
          if (ts.length > journals && iter % 3 === 0) {
            const entry: JournalEntry = { setup: ['ORB', 'VWAP', 'fade', ''][ts.length % 4]!, tags: [`t${ts.length}`, 'x'], notes: `n${iter}`, rating: ((ts.length % 5) + 1) as 1 | 2 | 3 | 4 | 5, followedRules: ts.length % 2 === 0 };
            straight.setJournal(ts[ts.length - 1]!.id, entry);
            chained.setJournal(ts[ts.length - 1]!.id, entry);
            journals = ts.length;
          }
          iter++;
        }
        expect(sawWorking).toBeGreaterThan(20);
        expect(sawPendingClose).toBeGreaterThan(3);
        expect(sawBracketMove).toBeGreaterThan(10);
        expect(chained.trades.length).toBe(straight.trades.length);
        expect(chained.trades.length).toBeGreaterThan(10);
        expect(view(chained, 'full')).toEqual(view(straight, 'full'));
        expect(computeStats(chained.trades, 50000)).toEqual(computeStats(straight.trades, 50000));
        expect(chained.step()).toEqual([]);
        expect(chained.isAtEnd()).toBe(true);
        expect(chained.position).toBeNull();
      }
    }, 60_000);
  }

  it('forks taken in each distinct state (flat, working order, in trade, bracket moved, close queued, after exit, at the end) all continue identically', () => {
    const rows: Ohlc[] = [
      [21000, 21002, 20998, 21000],
      [21000, 21004, 20996, 21002],
      [21002, 21006, 20999, 21004],
      [21004, 21010, 21001, 21008],
      [21008, 21012, 21004, 21006],
      [21006, 21007, 20990, 20995],
      [20995, 20999, 20980, 20985],
      [20985, 20990, 20970, 20972],
      [20972, 20980, 20960, 20965],
    ];
    const run = (forkAt: string): { trades: unknown; end: unknown } => {
      const built = build(rows, { slippageTicks: 1, commissionPerSide: 0.62 });
      let e = built.e;
      const bars = built.bars;
      const fork = (name: string): void => {
        if (name === forkAt) e = roundTrip(e, bars);
      };
      fork('flat');
      e.placeOrder({ side: 'long', type: 'limit', qty: 2, price: 21000, stopLoss: 20990, takeProfit: 21030 });
      fork('working');
      e.modifyOrder(e.workingOrder!.id, { price: 21001, takeProfit: 21040 });
      fork('working modified');
      e.step();
      fork('in trade');
      e.modifyBracket({ stopLoss: 20997, takeProfit: null });
      fork('bracket moved');
      e.step(2);
      e.closePosition();
      fork('close queued');
      e.step();
      fork('after exit');
      e.step(10);
      fork('end');
      return { trades: e.trades, end: e.toJSON() };
    };
    const base = run('none');
    for (const name of ['flat', 'working', 'working modified', 'in trade', 'bracket moved', 'close queued', 'after exit', 'end']) {
      expect(run(name), `fork at ${name}`).toEqual(base);
    }
    expect((base.trades as unknown[]).length).toBe(1);
  });
});

describe('snapshot isolation and shape', () => {
  const rows: Ohlc[] = [[21000, 21002, 20998, 21000], [21000, 21004, 20996, 21002], [21002, 21006, 20999, 21004], [21004, 21010, 21001, 21008]];

  it('toJSON survives JSON.stringify exactly: no undefined, NaN or -0 smuggled in', () => {
    const { e } = build(rows, { commissionPerSide: 1.1 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    e.step();
    e.modifyBracket({ stopLoss: null });
    e.closePosition();
    const snap = e.toJSON();
    const text = JSON.stringify(snap);
    expect(JSON.parse(text)).toEqual(snap);
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    expect(snap.version).toBe(1);
    expect(snap.symbol).toBe('NQ');
    expect(snap.startTime).toBe(T0);
    expect(snap.cursorIndex).toBe(1);
    expect(snap.position).toMatchObject({ pendingClose: true });
    expect(snap.position).not.toHaveProperty('stopLoss');
    expect(snap.position).toMatchObject({ initialStopLoss: 20990 });
  });

  it('editing a snapshot after fromJSON does not reach the engine, and editing the engine does not reach an old snapshot', () => {
    const { e, bars } = build(rows);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990, stopLoss: 20980 });
    const snap = e.toJSON();
    const frozenCopy = JSON.stringify(snap);
    const f = ReplayEngine.fromJSON(snap, bars, NQ);
    snap.workingOrder!.price = 1;
    snap.settings.slippageTicks = 99;
    snap.trades.push({} as never);
    snap.nextId = 500;
    expect(f.workingOrder!.price).toBe(20990);
    expect(f.settings.slippageTicks).toBe(0);
    expect(f.trades).toEqual([]);
    e.modifyOrder(e.workingOrder!.id, { price: 20991 });
    expect(JSON.stringify(f.toJSON())).toBe(frozenCopy);
  });

  it('restored trades are frozen, journals survive, and setJournal still works', () => {
    const { e, bars } = build(rows);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21001 });
    e.step();
    e.setJournal(e.trades[0]!.id, { setup: 'ORB', tags: ['a'], rating: 3 });
    const r = roundTrip(e, bars);
    expect(r.trades[0]!.journal).toEqual({ setup: 'ORB', tags: ['a'], rating: 3 });
    expect(Object.isFrozen(r.trades[0])).toBe(true);
    expect(() => {
      (r.trades[0] as { netUsd: number }).netUsd = 1e9;
    }).toThrow();
    r.setJournal(r.trades[0]!.id, { notes: 'later' });
    expect(r.trades[0]!.journal).toEqual({ notes: 'later' });
    expect(e.trades[0]!.journal).toEqual({ setup: 'ORB', tags: ['a'], rating: 3 }); // the original is untouched
  });

  it('ids keep counting after a restore: no collision between old and new orders or trades', () => {
    const built = build([...rows, ...rows, ...rows]);
    let e = built.e;
    const bars = built.bars;
    const ids = new Set<string>();
    for (let i = 0; i < 4; i++) {
      e = roundTrip(e, bars);
      const o = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
      expect(ids.has(o.id), `order id ${o.id}`).toBe(false);
      ids.add(o.id);
      e.step();
      e.closePosition();
      e.step();
      const t = e.trades[e.trades.length - 1]!;
      expect(ids.has(t.id), `trade id ${t.id}`).toBe(false);
      ids.add(t.id);
      e = roundTrip(e, bars);
    }
    expect(new Set(e.trades.map((t) => t.id)).size).toBe(e.trades.length);
  });

  it('visible bars after a restore equal the straight engine for every timeframe (caches rebuilt from revealed bars only)', () => {
    const rand = lcg(8);
    const bars = toBars(randomTickBars(rand, NQ, 2500), NQ.tickSize);
    const e = new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time });
    for (const n of [1, 7, 60, 400, 1500]) {
      e.step(n);
      const r = roundTrip(e, bars);
      for (const tf of TFS) expect(r.getVisibleBars(tf), `${tf} after ${n}`).toEqual(e.getVisibleBars(tf));
    }
  });
});

describe('fromJSON refuses snapshots that cannot belong to these bars', () => {
  const { e, bars } = build([[21000, 21002, 20998, 21000], [21000, 21004, 20996, 21002], [21002, 21006, 20999, 21004]]);
  e.step();
  const good = (): SessionSnapshot => JSON.parse(JSON.stringify(e.toJSON())) as SessionSnapshot;

  it('accepts the good one', () => {
    expect(() => ReplayEngine.fromJSON(good(), bars, NQ)).not.toThrow();
  });

  const cases: [string, (s: SessionSnapshot) => void][] = [
    ['version 2', (s) => ((s as { version: number }).version = 2)],
    ['wrong symbol', (s) => (s.symbol = 'ES')],
    ['negative cursorIndex', (s) => (s.cursorIndex = -1)],
    ['cursorIndex past the bars', (s) => (s.cursorIndex = bars.length)],
    ['fractional cursorIndex', (s) => (s.cursorIndex = 0.5)],
    ['string cursorIndex', (s) => ((s as { cursorIndex: unknown }).cursorIndex = '1')],
    ['NaN cursorIndex', (s) => (s.cursorIndex = NaN)],
    ['zero nextId', (s) => (s.nextId = 0)],
    ['missing settings', (s) => ((s as { settings: unknown }).settings = undefined)],
    ['trades not an array', (s) => ((s as { trades: unknown }).trades = {})],
    ['negative slippage', (s) => (s.settings.slippageTicks = -1)],
    ['fractional slippage', (s) => (s.settings.slippageTicks = 0.5)],
    ['zero starting balance', (s) => (s.settings.startingBalance = 0)],
  ];
  for (const [name, mutate] of cases) {
    it(`throws EngineError for ${name}`, () => {
      const s = good();
      mutate(s);
      expect(() => ReplayEngine.fromJSON(s, bars, NQ)).toThrow(EngineError);
    });
  }

  it('throws EngineError for null, a string, and an array', () => {
    for (const bad of [null, 'x', 5]) expect(() => ReplayEngine.fromJSON(bad as never, bars, NQ)).toThrow(EngineError);
  });

  it('a snapshot taken on more bars does not restore onto fewer bars', () => {
    const s = good();
    s.cursorIndex = 2;
    expect(() => ReplayEngine.fromJSON(s, bars.slice(0, 2), NQ)).toThrow(EngineError);
  });

  it('BUG: a snapshot holding both an open position and a working entry order is an impossible state and should be refused', () => {
    const { e: f, bars: fbars } = build([[21000, 21002, 20998, 21000], [21000, 21004, 20996, 21002], [21002, 21006, 20999, 21004]]);
    f.placeOrder({ side: 'long', type: 'market', qty: 1 });
    f.step();
    const s = JSON.parse(JSON.stringify(f.toJSON())) as SessionSnapshot;
    s.workingOrder = { id: 'o9', side: 'short', type: 'limit', qty: 1, price: 21100, status: 'working', placedAt: T0 };
    expect(() => ReplayEngine.fromJSON(s, fbars, NQ)).toThrow(EngineError);
  });
});
