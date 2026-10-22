import { describe, expect, it } from 'vitest';
import { CONTRACTS } from '../src/contracts';
import { ReplayEngine } from '../src/engine';
import { EngineError } from '../src/errors';
import type { SessionSnapshot } from '../src/types';
import { MNQ, NQ, T0, engineOver, walkBars, type Ohlc } from './helpers';

const R0: Ohlc = [21000, 21001, 20999, 21000];

describe('unrealized', () => {
  it('is null when flat', () => {
    expect(engineOver([R0, [21000, 21003, 20997, 21002]]).unrealized()).toBeNull();
  });
  it('long, 2 contracts: ticks are per contract, USD covers all contracts', () => {
    const e = engineOver([R0, [21000, 21004, 20999, 21003], [21003, 21005, 21001, 21004]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 2 });
    e.step(); // entry 21000, lastPrice 21003: 12 ticks
    expect(e.unrealized()).toEqual({ ticks: 12, usd: 120 }); // 12 * $5 * 2
    e.step(); // lastPrice 21004: 16 ticks
    expect(e.unrealized()).toEqual({ ticks: 16, usd: 160 });
  });
  it('short loses when price rises', () => {
    const e = engineOver([R0, [21000, 21004, 20999, 21003], [21003, 21005, 21001, 21004]]);
    e.placeOrder({ side: 'short', type: 'market', qty: 2 });
    e.step();
    expect(e.unrealized()).toEqual({ ticks: -12, usd: -120 });
  });
  it('uses the contract tick value (MNQ $0.50, 3 contracts, +8 ticks = $12)', () => {
    const e = engineOver([R0, [21000, 21004, 20999, 21002], [21002, 21003, 21001, 21002]], {}, MNQ);
    e.placeOrder({ side: 'long', type: 'market', qty: 3 });
    e.step();
    expect(e.unrealized()).toEqual({ ticks: 8, usd: 12 });
  });
  it('is null again after the trade closes', () => {
    const e = engineOver([R0, [21000, 21004, 20999, 21003]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21001 });
    e.step();
    expect(e.unrealized()).toBeNull();
  });
});

describe('setJournal', () => {
  function withTrade() {
    const e = engineOver([R0, [21000, 21004, 20999, 21003]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21001 });
    e.step();
    return e;
  }
  it('a new trade has an empty journal', () => {
    expect(withTrade().trades[0]!.journal).toEqual({});
  });
  it('stores the entry on the trade', () => {
    const e = withTrade();
    const id = e.trades[0]!.id;
    e.setJournal(id, { setup: 'ORB', tags: ['a', 'b'], notes: 'clean', rating: 4, followedRules: false });
    expect(e.trades[0]!.journal).toEqual({ setup: 'ORB', tags: ['a', 'b'], notes: 'clean', rating: 4, followedRules: false });
  });
  it('replaces the whole entry rather than merging', () => {
    const e = withTrade();
    const id = e.trades[0]!.id;
    e.setJournal(id, { setup: 'ORB', rating: 5 });
    e.setJournal(id, { notes: 'later' });
    expect(e.trades[0]!.journal).toEqual({ notes: 'later' });
  });
  it('keeps its own copy of what it was given', () => {
    const e = withTrade();
    const id = e.trades[0]!.id;
    const entry = { tags: ['x'] };
    e.setJournal(id, entry);
    entry.tags.push('y');
    expect(e.trades[0]!.journal.tags).toEqual(['x']);
  });
  it('throws on an unknown trade id', () => {
    expect(() => withTrade().setJournal('t999', { setup: 'x' })).toThrow(EngineError);
  });
  it('validates field types and the 1 to 5 rating', () => {
    const e = withTrade();
    const id = e.trades[0]!.id;
    for (const rating of [0, 6, 2.5, -1]) expect(() => e.setJournal(id, { rating } as never), `rating ${rating}`).toThrow(EngineError);
    expect(() => e.setJournal(id, { tags: 'a' } as never)).toThrow(EngineError);
    expect(() => e.setJournal(id, { tags: [1] } as never)).toThrow(EngineError);
    expect(() => e.setJournal(id, { notes: 5 } as never)).toThrow(EngineError);
    expect(() => e.setJournal(id, { setup: 5 } as never)).toThrow(EngineError);
    expect(() => e.setJournal(id, { followedRules: 'yes' } as never)).toThrow(EngineError);
    expect(e.trades[0]!.journal).toEqual({});
  });
  it('trades handed out cannot be mutated behind the engine back', () => {
    const e = withTrade();
    const t = e.trades[0]!;
    expect(() => {
      (t as { netUsd: number }).netUsd = 1;
    }).toThrow(TypeError);
    expect(() => {
      t.journal.notes = 'sneaky';
    }).toThrow(TypeError);
    expect(e.trades).not.toBe(e.trades); // fresh array each call
  });
});

describe('toJSON / fromJSON', () => {
  const bars = walkBars(400, 11);
  const settings = { commissionPerSide: 1.5, slippageTicks: 1 };
  const fresh = () => new ReplayEngine({ bars, contract: NQ, startTime: bars[0]!.time, settings });

  /** Deterministic driver: opens a trade when flat, adjusts it, closes it manually now and then. */
  function act(e: ReplayEngine, n: number): unknown[] {
    const out: unknown[] = [];
    if (e.position === null && e.workingOrder === null && !e.isAtEnd()) {
      const lp = e.lastPrice;
      const long = n % 2 === 0;
      e.placeOrder(
        long
          ? { side: 'long', type: 'market', qty: 1 + (n % 3), stopLoss: lp - 6, takeProfit: lp + 8 }
          : { side: 'short', type: 'limit', qty: 1, price: lp + 1, stopLoss: lp + 7, takeProfit: lp - 9 },
      );
    } else if (e.position !== null && n % 5 === 0 && !e.position.pendingClose) {
      e.closePosition();
    } else if (e.position !== null && n % 3 === 0) {
      const lp = e.lastPrice;
      e.modifyBracket(e.position.side === 'long' ? { stopLoss: lp - 4 } : { stopLoss: lp + 4 });
    }
    out.push(...e.step(1 + (n % 4)));
    return out;
  }

  function buildMidTrade() {
    const a = fresh();
    a.step(10);
    a.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: a.lastPrice - 60, takeProfit: a.lastPrice + 60 });
    a.step(3);
    a.closePosition();
    a.step();
    expect(a.trades).toHaveLength(1);
    a.setJournal(a.trades[0]!.id, { setup: 'ORB', tags: ['x'], rating: 4, followedRules: true, notes: 'n' });
    a.placeOrder({ side: 'short', type: 'market', qty: 2, stopLoss: a.lastPrice + 60, takeProfit: a.lastPrice - 60 });
    a.step(4);
    a.modifyBracket({ stopLoss: a.lastPrice + 55 });
    expect(a.position).not.toBeNull();
    return a;
  }

  it('snapshot has the SPEC shape and survives JSON', () => {
    const a = buildMidTrade();
    const snap = a.toJSON();
    expect(snap).toMatchObject({ version: 1, symbol: 'NQ', startTime: bars[0]!.time, cursorIndex: 18, settings });
    expect(snap.settings).toEqual({ commissionPerSide: 1.5, slippageTicks: 1, startingBalance: 50000 });
    expect(snap.position).toMatchObject({ side: 'short', qty: 2 });
    expect(snap.workingOrder).toBeNull();
    expect(snap.trades).toHaveLength(1);
    expect(snap.nextId).toBeGreaterThan(1);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('round trip mid trade restores everything, then stepping on gives identical results', () => {
    const a = buildMidTrade();
    const snap: SessionSnapshot = JSON.parse(JSON.stringify(a.toJSON()));
    const b = ReplayEngine.fromJSON(snap, bars, NQ);

    expect(b.cursorTime).toBe(a.cursorTime);
    expect(b.lastPrice).toBe(a.lastPrice);
    expect(b.position).toEqual(a.position);
    expect(b.workingOrder).toEqual(a.workingOrder);
    expect(b.trades).toEqual(a.trades);
    expect(b.settings).toEqual(a.settings);
    expect(b.unrealized()).toEqual(a.unrealized());
    for (const tf of ['1m', '3m', '5m', '1h', '4h', '1D'] as const) expect(b.getVisibleBars(tf), tf).toEqual(a.getVisibleBars(tf));

    let n = 0;
    while (!a.isAtEnd() && n < 500) {
      const ea = act(a, n);
      const eb = act(b, n);
      expect(eb, `events at round ${n}`).toEqual(ea);
      expect(b.position, `position at round ${n}`).toEqual(a.position);
      n++;
    }
    expect(a.isAtEnd()).toBe(true);
    expect(b.isAtEnd()).toBe(true);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(b.trades).toEqual(a.trades);
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('restores a working order and a pending manual close', () => {
    const a = fresh();
    a.step(5);
    a.placeOrder({ side: 'long', type: 'limit', qty: 1, price: a.lastPrice - 20, stopLoss: a.lastPrice - 40 });
    const withOrder = ReplayEngine.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), bars, NQ);
    expect(withOrder.workingOrder).toEqual(a.workingOrder);
    expect(withOrder.position).toBeNull();

    const c = fresh();
    c.step(5);
    c.placeOrder({ side: 'long', type: 'market', qty: 1 });
    c.step();
    c.closePosition();
    const restored = ReplayEngine.fromJSON(JSON.parse(JSON.stringify(c.toJSON())), bars, NQ);
    expect(restored.position?.pendingClose).toBe(true);
    const ea = c.step();
    const eb = restored.step();
    expect(eb).toEqual(ea);
    expect(ea[0]).toMatchObject({ type: 'trade_closed', trade: { exitReason: 'manual' } });
  });

  it('ids keep counting after a restore (no collisions)', () => {
    const a = buildMidTrade();
    const known = new Set([a.trades[0]!.id]);
    const b = ReplayEngine.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), bars, NQ);
    b.closePosition();
    b.step();
    const next = b.trades[1]!.id;
    expect(known.has(next)).toBe(false);
    const o = b.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(o.id).not.toBe(next);
    expect(o.id).not.toBe(a.trades[0]!.id);
  });

  it('snapshots and engines are independent copies', () => {
    const a = buildMidTrade();
    const snap = a.toJSON();
    const frozenCopy = JSON.parse(JSON.stringify(snap));
    a.step(10); // engine moves on, snapshot must not
    expect(JSON.parse(JSON.stringify(snap))).toEqual(frozenCopy);

    const b = ReplayEngine.fromJSON(snap, bars, NQ);
    snap.position!.qty = 99;
    snap.cursorIndex = 0;
    snap.settings.slippageTicks = 50;
    expect(b.position?.qty).toBe(2);
    expect(b.settings.slippageTicks).toBe(1);
  });

  it('rejects bad snapshots', () => {
    const good = buildMidTrade().toJSON();
    const bad = (patch: Partial<SessionSnapshot> | object) => () => ReplayEngine.fromJSON({ ...good, ...patch } as SessionSnapshot, bars, NQ);
    expect(bad({ version: 2 })).toThrow(EngineError);
    expect(bad({ symbol: 'ES' })).toThrow(EngineError);
    expect(bad({ cursorIndex: -1 })).toThrow(EngineError);
    expect(bad({ cursorIndex: 400 })).toThrow(EngineError);
    expect(bad({ cursorIndex: 2.5 })).toThrow(EngineError);
    expect(bad({ startTime: bars[0]!.time - 1000 })).toThrow(EngineError);
    expect(bad({ settings: { commissionPerSide: -1, slippageTicks: 0, startingBalance: 50000 } })).toThrow(EngineError);
    expect(() => ReplayEngine.fromJSON(null as never, bars, NQ)).toThrow(EngineError);
    expect(() => ReplayEngine.fromJSON(good, bars, CONTRACTS['ES']!)).toThrow(EngineError);
  });

  it('a fresh engine snapshot', () => {
    const snap = fresh().toJSON();
    expect(snap).toEqual({ version: 1, symbol: 'NQ', startTime: bars[0]!.time, cursorIndex: 0, settings: { commissionPerSide: 1.5, slippageTicks: 1, startingBalance: 50000 }, workingOrder: null, position: null, trades: [], nextId: 1 });
    expect(snap.startTime).toBe(T0);
  });
});
