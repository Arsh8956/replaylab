// QA: order handling. Validation attacks, atomic failures, marketable orders, manual close corners,
// journals, constructor input checks, and the spec gaps around slippage and brackets.
import { describe, expect, it } from 'vitest';
import { EngineError, ReplayEngine } from '../src/index';
import type { Bar, OrderRequest } from '../src/index';
import { NQ, T0, barsFrom, engineExact, engineOver, type Ohlc } from './helpers';

const R0: Ohlc = [21000, 21001, 20999, 21000];
const QUIET: Ohlc = [21000, 21001, 20999, 21000];
const base = (): ReplayEngine => engineOver([R0, QUIET, QUIET, QUIET]);

describe('placeOrder rejects every malformed request and leaves nothing behind', () => {
  const bad: [string, unknown][] = [
    ['qty 0', { side: 'long', type: 'market', qty: 0 }],
    ['qty -1', { side: 'long', type: 'market', qty: -1 }],
    ['qty 1.5', { side: 'long', type: 'market', qty: 1.5 }],
    ['qty NaN', { side: 'long', type: 'market', qty: NaN }],
    ['qty Infinity', { side: 'long', type: 'market', qty: Infinity }],
    ['qty string', { side: 'long', type: 'market', qty: '1' }],
    ['qty missing', { side: 'long', type: 'market' }],
    ['side missing', { type: 'market', qty: 1 }],
    ['side buy', { side: 'buy', type: 'market', qty: 1 }],
    ['type missing', { side: 'long', qty: 1 }],
    ['type stop_limit', { side: 'long', type: 'stop_limit', qty: 1 }],
    ['limit without price', { side: 'long', type: 'limit', qty: 1 }],
    ['stop without price', { side: 'short', type: 'stop', qty: 1 }],
    ['limit price 0', { side: 'long', type: 'limit', qty: 1, price: 0 }],
    ['limit price negative', { side: 'long', type: 'limit', qty: 1, price: -5 }],
    ['limit price NaN', { side: 'long', type: 'limit', qty: 1, price: NaN }],
    ['limit price Infinity', { side: 'long', type: 'limit', qty: 1, price: Infinity }],
    ['limit price string', { side: 'long', type: 'limit', qty: 1, price: '20990' }],
    ['limit price that rounds to 0', { side: 'long', type: 'limit', qty: 1, price: 0.1 }],
    ['long SL at the last price', { side: 'long', type: 'market', qty: 1, stopLoss: 21000 }],
    ['long SL above the last price', { side: 'long', type: 'market', qty: 1, stopLoss: 21001 }],
    ['long TP at the last price', { side: 'long', type: 'market', qty: 1, takeProfit: 21000 }],
    ['long TP below the last price', { side: 'long', type: 'market', qty: 1, takeProfit: 20999 }],
    ['short SL at the last price', { side: 'short', type: 'market', qty: 1, stopLoss: 21000 }],
    ['short SL below the last price', { side: 'short', type: 'market', qty: 1, stopLoss: 20999 }],
    ['short TP above the last price', { side: 'short', type: 'market', qty: 1, takeProfit: 21001 }],
    ['SL rounds onto the reference (20999.9 -> 21000)', { side: 'long', type: 'market', qty: 1, stopLoss: 20999.9 }],
    ['TP rounds onto the reference (21000.1 -> 21000)', { side: 'long', type: 'market', qty: 1, takeProfit: 21000.1 }],
    ['SL zero', { side: 'long', type: 'market', qty: 1, stopLoss: 0 }],
    ['SL negative', { side: 'long', type: 'market', qty: 1, stopLoss: -1 }],
    ['SL NaN', { side: 'long', type: 'market', qty: 1, stopLoss: NaN }],
    ['TP NaN', { side: 'long', type: 'market', qty: 1, takeProfit: NaN }],
    ['limit long SL above the limit price', { side: 'long', type: 'limit', qty: 1, price: 20990, stopLoss: 20995 }],
    ['limit long TP below the limit price', { side: 'long', type: 'limit', qty: 1, price: 20990, takeProfit: 20985 }],
    ['stop short SL below the stop price', { side: 'short', type: 'stop', qty: 1, price: 20990, stopLoss: 20985 }],
    ['null request', null],
  ];
  for (const [name, req] of bad) {
    it(`${name}`, () => {
      const e = base();
      expect(() => e.placeOrder(req as OrderRequest)).toThrow();
      expect(e.workingOrder).toBeNull();
      // the failed attempt consumed nothing: the first good order still gets the first id
      expect(e.placeOrder({ side: 'long', type: 'market', qty: 1 }).id).toBe('o1');
    });
  }

  it('errors are EngineError (the UI shows them inline)', () => {
    const e = base();
    for (const [, req] of bad.slice(0, 12)) expect(() => e.placeOrder(req as OrderRequest)).toThrow(EngineError);
  });

  it('a long SL one tick below and TP one tick above the reference is the tightest legal bracket', () => {
    const e = base();
    const o = e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20999.75, takeProfit: 21000.25 });
    expect(o).toMatchObject({ stopLoss: 20999.75, takeProfit: 21000.25 });
  });

  it('prices are rounded to the tick before use and the returned order shows the rounded values', () => {
    const e = base();
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990.1, stopLoss: 20980.13, takeProfit: 21010.4 });
    expect(o.price).toBe(20990);
    expect(o.stopLoss).toBe(20980.25);
    expect(o.takeProfit).toBe(21010.5);
    expect(Object.is(o.price, 20990)).toBe(true);
  });

  it('placeOrder never mutates the caller request, and an ignored price on a market order is harmless', () => {
    const e = base();
    const req = Object.freeze({ side: 'long', type: 'market', qty: 2, price: 99999, stopLoss: 20990.1 } as const);
    const o = e.placeOrder(req as OrderRequest);
    expect(o.price).toBeUndefined();
    expect(req.stopLoss).toBe(20990.1);
    e.step();
    expect(e.position!.entryPrice).toBe(21000);
  });

  it('only one entry at a time: a second order, or an order while in a position, is refused', () => {
    const e = base();
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(() => e.placeOrder({ side: 'short', type: 'market', qty: 1 })).toThrow(EngineError);
    e.cancelOrder('o1');
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.position).not.toBeNull();
    expect(() => e.placeOrder({ side: 'long', type: 'market', qty: 1 })).toThrow(EngineError);
    expect(() => e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21100 })).toThrow(EngineError);
  });
});

describe('marketable limit and stop prices are accepted and fill on the next bar at the open', () => {
  const rows: Ohlc[] = [R0, [21010, 21012, 21008, 21011], [21011, 21013, 21009, 21012]];
  it('buy limit above the market: fills at the open (price improvement), not at the limit', () => {
    const e = engineOver(rows);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21050 });
    expect(e.position).toBeNull();
    e.step();
    expect(e.position!.entryPrice).toBe(21010);
  });
  it('sell limit below the market: fills at the open', () => {
    const e = engineOver(rows);
    e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 20950 });
    e.step();
    expect(e.position!.entryPrice).toBe(21010);
  });
  it('buy stop below the market triggers on the next open, with slippage; sell stop above the market likewise', () => {
    const a = engineOver(rows, { slippageTicks: 2 });
    a.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 20950 });
    a.step();
    expect(a.position!.entryPrice).toBe(21010.5);
    const b = engineOver(rows, { slippageTicks: 2 });
    b.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 21050 });
    b.step();
    expect(b.position!.entryPrice).toBe(21009.5);
  });
  it('limit entries never slip even when marketable', () => {
    const e = engineOver(rows, { slippageTicks: 5 });
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21050 });
    e.step();
    expect(e.position!.entryPrice).toBe(21010);
  });
});

describe('modifyOrder and modifyBracket are atomic and follow the placement rules', () => {
  it('modifyBracket: a good SL with a bad TP changes nothing', () => {
    const e = engineOver([R0, [21000, 21004, 20998, 21002], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990, takeProfit: 21020 });
    e.step();
    const before = e.position;
    expect(() => e.modifyBracket({ stopLoss: 20995, takeProfit: 21001 })).toThrow(EngineError); // TP below last 21002
    expect(e.position).toEqual(before);
    expect(() => e.modifyBracket({ stopLoss: 21002, takeProfit: 21030 })).toThrow(EngineError); // SL at last
    expect(e.position).toEqual(before);
    e.modifyBracket({ stopLoss: 21001.75, takeProfit: 21002.25 });
    expect(e.position).toMatchObject({ stopLoss: 21001.75, takeProfit: 21002.25, initialStopLoss: 20990 });
  });

  it('modifyBracket: null removes, undefined leaves alone, both null clears the bracket', () => {
    const e = engineOver([R0, [21000, 21004, 20998, 21002], QUIET]);
    e.placeOrder({ side: 'short', type: 'market', qty: 1, stopLoss: 21010, takeProfit: 20990 });
    e.step();
    e.modifyBracket({ stopLoss: null });
    expect(e.position!.stopLoss).toBeUndefined();
    expect(e.position!.takeProfit).toBe(20990);
    e.modifyBracket({});
    expect(e.position!.takeProfit).toBe(20990);
    e.modifyBracket({ takeProfit: null });
    expect(e.position).not.toHaveProperty('takeProfit');
    expect(e.position).not.toHaveProperty('stopLoss');
    expect(e.position!.initialStopLoss).toBe(21010);
  });

  it('modifyBracket needs an open position', () => {
    const e = base();
    expect(() => e.modifyBracket({ stopLoss: 20990 })).toThrow(EngineError);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(() => e.modifyBracket({ stopLoss: 20890 })).toThrow(EngineError);
  });

  it('modifyBracket values are judged against the last price, and rounded first', () => {
    const e = engineOver([R0, [21000, 21004, 20998, 21002], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(() => e.modifyBracket({ stopLoss: 21001.9 })).toThrow(EngineError); // rounds to 21002 = last
    expect(() => e.modifyBracket({ stopLoss: 0 })).toThrow(EngineError);
    expect(() => e.modifyBracket({ takeProfit: NaN })).toThrow(EngineError);
    e.modifyBracket({ stopLoss: 21001.8 }); // rounds to 21001.75
    expect(e.position!.stopLoss).toBe(21001.75);
  });

  it('modifyOrder: unknown, filled, cancelled ids all throw; the working order is unchanged by a failed call', () => {
    const e = base();
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 2, price: 20990, stopLoss: 20980, takeProfit: 21010 });
    expect(() => e.modifyOrder('nope', { price: 20991 })).toThrow(EngineError);
    expect(() => e.modifyOrder(o.id, { price: 20970 })).toThrow(EngineError); // SL 20980 would sit above the new price
    expect(() => e.modifyOrder(o.id, { takeProfit: 20989 })).toThrow(EngineError);
    expect(() => e.modifyOrder(o.id, { price: NaN })).toThrow(EngineError);
    expect(e.workingOrder).toEqual(o);
    const m = e.modifyOrder(o.id, { price: 20992, stopLoss: null });
    expect(m).toMatchObject({ id: o.id, price: 20992, takeProfit: 21010, qty: 2, status: 'working', placedAt: o.placedAt });
    expect(m).not.toHaveProperty('stopLoss');
    e.cancelOrder(o.id);
    expect(() => e.modifyOrder(o.id, { price: 20991 })).toThrow(EngineError);
    expect(() => e.cancelOrder(o.id)).toThrow(EngineError);
  });

  it('modifyOrder on a market order: SL/TP can change, a price cannot', () => {
    const e = base();
    const o = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(() => e.modifyOrder(o.id, { price: 21000 })).toThrow(EngineError);
    const m = e.modifyOrder(o.id, { stopLoss: 20990, takeProfit: 21010 });
    expect(m).toMatchObject({ stopLoss: 20990, takeProfit: 21010 });
    expect(() => e.modifyOrder(o.id, { stopLoss: 21000 })).toThrow(EngineError);
  });

  it('modifyOrder cannot touch an order that already filled, and cancelOrder cannot cancel a position', () => {
    const e = engineOver([R0, QUIET, QUIET]);
    const o = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(() => e.modifyOrder(o.id, { stopLoss: 20990 })).toThrow(EngineError);
    expect(() => e.cancelOrder(o.id)).toThrow(EngineError);
    expect(e.position).not.toBeNull();
  });

  it('a moved working order fills at its new price, and the old price no longer matters', () => {
    const e = engineOver([R0, [21000, 21002, 20994, 21001], [21001, 21002, 20989, 20990]]);
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    e.modifyOrder(o.id, { price: 20990 });
    e.step(); // low 20994 would have filled 20995
    expect(e.position).toBeNull();
    e.step(); // low 20989 fills 20990
    expect(e.position!.entryPrice).toBe(20990);
  });
});

describe('closePosition', () => {
  it('throws when flat, also after the trade has closed', () => {
    const e = engineOver([R0, QUIET, QUIET, QUIET]);
    expect(() => e.closePosition()).toThrow(EngineError);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    e.closePosition();
    e.step();
    expect(e.trades).toHaveLength(1);
    expect(() => e.closePosition()).toThrow(EngineError);
  });

  it('calling it twice while pending is harmless and still exits once', () => {
    const e = engineOver([R0, QUIET, [21003, 21004, 21001, 21002], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 3 });
    e.step();
    e.closePosition();
    e.closePosition();
    e.closePosition();
    expect(e.position!.pendingClose).toBe(true);
    const ev = e.step();
    expect(ev.filter((x) => x.type === 'trade_closed')).toHaveLength(1);
    expect(e.trades[0]).toMatchObject({ exitPrice: 21003, exitReason: 'manual', qty: 3 });
    expect(e.step()).toEqual([]);
  });

  it('queued manual close beats a tightened stop and a TP gap on the same bar, and takes slippage', () => {
    const e = engineOver([R0, [21000, 21004, 20998, 21002], [21030, 21040, 21020, 21035]], { slippageTicks: 2 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21010 });
    e.step();
    e.modifyBracket({ stopLoss: 21001 });
    e.closePosition();
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 21029.5 }); // open 21030 less 2 ticks, not the free TP fill
  });

  it('after a manual exit the engine is flat and can trade again on the very next order', () => {
    const e = engineOver([R0, QUIET, QUIET, QUIET, QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    e.closePosition();
    e.step();
    e.placeOrder({ side: 'short', type: 'market', qty: 1 });
    e.step();
    expect(e.position).toMatchObject({ side: 'short', entryTime: T0 + 180 });
  });

  it('position_opened carries the position as it was at the fill, not its later excursions', () => {
    const e = engineOver([R0, [21000, 21010, 20990, 21005], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step();
    const opened = ev.find((x) => x.type === 'position_opened')!;
    if (opened.type !== 'position_opened') throw new Error('type');
    expect(opened.position).toMatchObject({ entryPrice: 21000, maeTicks: 0, mfeTicks: 0, pendingClose: false });
    expect(e.position).toMatchObject({ maeTicks: 40, mfeTicks: 40 });
  });
});

describe('events', () => {
  it('times are bar open times, in order, and the fill, open and close of a one bar trade share one time', () => {
    const e = engineOver([R0, [21000, 21006, 20990, 21001], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20995 });
    const ev = e.step();
    expect(ev.map((x) => [x.type, x.time])).toEqual([
      ['order_filled', T0 + 60],
      ['position_opened', T0 + 60],
      ['trade_closed', T0 + 60],
    ]);
    const filled = ev[0]!;
    if (filled.type !== 'order_filled') throw new Error('type');
    expect(filled.order).toMatchObject({ status: 'filled', filledAt: T0 + 60, fillPrice: 21000, placedAt: T0 });
    expect(e.trades[0]!.holdSeconds).toBe(0);
  });

  it('end_of_data exits are stamped with the last bar open time (not its close)', () => {
    const e = engineExact([R0, [21000, 21001, 20999, 21000], [21000, 21003, 20999, 21002]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step(5);
    const closed = ev.find((x) => x.type === 'trade_closed')!;
    expect(closed.time).toBe(T0 + 120);
    expect(e.trades[0]).toMatchObject({ exitTime: T0 + 120, exitReason: 'end_of_data', exitPrice: 21002, holdSeconds: 60 });
  });

  it('events returned to the caller are copies: editing one cannot change the engine', () => {
    const e = engineOver([R0, [21000, 21006, 20990, 21001], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step();
    for (const x of ev) {
      if (x.type === 'position_opened') x.position.entryPrice = 1;
      if (x.type === 'order_filled') x.order.fillPrice = 1;
    }
    expect(e.position!.entryPrice).toBe(21000);
  });
});

describe('journals', () => {
  const traded = (): ReplayEngine => {
    const e = engineOver([R0, [21000, 21001, 20999, 21000], QUIET]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21000.25 });
    e.step();
    return e;
  };
  it('rejects every invalid field and keeps the old journal', () => {
    const e = traded();
    const id = e.trades[0]!.id;
    e.setJournal(id, { setup: 'A', rating: 2 });
    const bad: unknown[] = [{ rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: '3' }, { tags: 'x' }, { tags: [1] }, { setup: 5 }, { notes: {} }, { followedRules: 'yes' }, null, 'x'];
    for (const b of bad) {
      expect(() => e.setJournal(id, b as never)).toThrow(EngineError);
      expect(e.trades[0]!.journal).toEqual({ setup: 'A', rating: 2 });
    }
    expect(() => e.setJournal('nope', { setup: 'x' })).toThrow(EngineError);
  });
  it('unknown fields are dropped; stored values cannot be edited from outside', () => {
    const e = traded();
    const id = e.trades[0]!.id;
    const tags = ['a', 'b'];
    e.setJournal(id, { setup: 'ORB', tags, bogus: 1 } as never);
    tags.push('c');
    expect(e.trades[0]!.journal).toEqual({ setup: 'ORB', tags: ['a', 'b'] });
    expect(() => {
      (e.trades[0]!.journal.tags as string[]).push('z');
    }).toThrow();
    expect(() => {
      (e.trades[0] as { netUsd: number }).netUsd = 5;
    }).toThrow();
  });
  it('the trades array handed out is a copy', () => {
    const e = traded();
    const t = e.trades;
    t.length = 0;
    expect(e.trades).toHaveLength(1);
  });
});

describe('constructor input checks', () => {
  const ok = (): Bar[] => barsFrom(T0, [R0, QUIET, QUIET]);
  it('refuses unsorted, duplicated, empty, and non numeric time bars', () => {
    const b = ok();
    expect(() => new ReplayEngine({ bars: [b[1]!, b[0]!], contract: NQ, startTime: T0 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: [b[0]!, { ...b[0]! }], contract: NQ, startTime: T0 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: [], contract: NQ, startTime: T0 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: [{ ...b[0]!, time: NaN }], contract: NQ, startTime: T0 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: b, contract: NQ, startTime: T0 - 1 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: b, contract: NQ, startTime: NaN })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: b, contract: { ...NQ, tickSize: 0 }, startTime: T0 })).toThrow(EngineError);
    expect(() => new ReplayEngine({ bars: b, contract: { ...NQ, tickValue: -1 }, startTime: T0 })).toThrow(EngineError);
  });
  it('refuses nonsense settings and freezes the ones it accepts', () => {
    for (const s of [{ commissionPerSide: -1 }, { commissionPerSide: NaN }, { slippageTicks: 1.5 }, { slippageTicks: -1 }, { startingBalance: 0 }, { startingBalance: -5 }, { startingBalance: NaN }]) {
      expect(() => new ReplayEngine({ bars: ok(), contract: NQ, startTime: T0, settings: s })).toThrow(EngineError);
    }
    const e = new ReplayEngine({ bars: ok(), contract: NQ, startTime: T0, settings: { slippageTicks: 2 } });
    expect(e.settings).toEqual({ commissionPerSide: 0, slippageTicks: 2, startingBalance: 50000 });
    expect(() => {
      (e.settings as { slippageTicks: number }).slippageTicks = 0;
    }).toThrow();
  });
  it('BUG?: bars with NaN prices, Infinity, negative volume or high below low are accepted and will poison every fill and the P&L', () => {
    const b = ok();
    const poisoned: Bar[][] = [
      [b[0]!, { ...b[1]!, close: NaN }],
      [b[0]!, { ...b[1]!, high: Infinity }],
      [b[0]!, { ...b[1]!, volume: -5 }],
      [b[0]!, { ...b[1]!, high: 20000, low: 22000 }],
    ];
    const accepted: string[] = [];
    for (const bars of poisoned) {
      try {
        const e = new ReplayEngine({ bars, contract: NQ, startTime: T0 });
        e.step();
        accepted.push(JSON.stringify(bars[1]));
      } catch (err) {
        if (!(err instanceof EngineError)) accepted.push(`non EngineError ${String(err)}`);
      }
    }
    expect(accepted, 'bars the engine accepted').toEqual([]);
  });
});

describe('spec gaps found while attacking (decisions needed)', () => {
  it('SPEC GAP: a market entry with slippage that gaps through its own take profit books a take_profit exit at a loss', () => {
    // long market, TP one tick above the last price 21000. Next bar opens 21001 (>= TP): the entry is at 21001 + 2 ticks of
    // slippage = 21001.5, the TP gap exit is at the open 21001 with no slippage: a "take profit" that loses 2 ticks.
    const e = engineOver([R0, [21001, 21002, 21000.5, 21001.5], QUIET], { slippageTicks: 2 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21000.25 });
    e.step();
    const t = e.trades[0]!;
    expect(t.exitReason).toBe('take_profit');
    expect(t.pnlTicks, 'a take_profit exit lost money').toBeGreaterThanOrEqual(0);
  });

  it('SPEC GAP: slippage can push a stop entry through its own take profit, booking a take_profit exit at a loss', () => {
    // buy stop 21000 with TP 21000.25 (1 tick away), slippage 3 ticks: fills 21000.75, already above the TP.
    const e = engineOver([R0, [20999, 21001, 20998, 21000.5], [21000.5, 21001, 21000, 21000.5]], { slippageTicks: 3 });
    e.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21000, takeProfit: 21000.25, stopLoss: 20990 });
    e.step(2);
    const t = e.trades[0];
    expect(t, 'trade exists').toBeDefined();
    if (t!.exitReason === 'take_profit') expect(t!.pnlTicks, 'a take_profit exit lost money').toBeGreaterThanOrEqual(0);
  });
});

describe('entry order exactly at the open: the "filled at the open" bar runs the exit rules in full (TP included)', () => {
  // each case: order, then a bar whose open EQUALS the order price and whose range also reaches the TP
  it('buy limit with open == L: TP touched in the same bar exits in the same bar', () => {
    const e = engineOver([R0, [21000, 21006, 20999, 21003], QUIET]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21000, takeProfit: 21005, stopLoss: 20990 });
    e.step();
    expect(e.trades).toHaveLength(1);
    expect(e.trades[0]).toMatchObject({ entryPrice: 21000, exitPrice: 21005, exitReason: 'take_profit', holdSeconds: 0 });
  });
  it('sell limit with open == L', () => {
    const e = engineOver([R0, [21000, 21001, 20994, 20997], QUIET]);
    e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21000, takeProfit: 20995, stopLoss: 21010 });
    e.step();
    expect(e.trades[0]).toMatchObject({ entryPrice: 21000, exitPrice: 20995, exitReason: 'take_profit' });
  });
  it('buy stop with open == S (a gap onto the stop is an open fill)', () => {
    const e = engineOver([R0, [21010, 21016, 21009, 21012], QUIET]);
    e.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010, takeProfit: 21015, stopLoss: 21000 });
    e.step();
    expect(e.trades[0]).toMatchObject({ entryPrice: 21010, exitPrice: 21015, exitReason: 'take_profit' });
  });
  it('sell stop with open == S', () => {
    const e = engineOver([R0, [20990, 20991, 20984, 20986], QUIET]);
    e.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990, takeProfit: 20985, stopLoss: 21000 });
    e.step();
    expect(e.trades[0]).toMatchObject({ entryPrice: 20990, exitPrice: 20985, exitReason: 'take_profit' });
  });
  it('one tick off the open the TP waits: buy limit 21000 with the open one tick higher fills intrabar and TP waits for the next bar', () => {
    const e = engineOver([R0, [21000.25, 21006, 20999, 21003], QUIET]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21000, takeProfit: 21005, stopLoss: 20990 });
    e.step();
    expect(e.trades).toEqual([]);
    expect(e.position).toMatchObject({ entryPrice: 21000, takeProfit: 21005 });
  });
  it('both levels in the open filled bar: the stop wins', () => {
    const e = engineOver([R0, [21000, 21010, 20988, 21003], QUIET]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21000, takeProfit: 21005, stopLoss: 20990 });
    e.step();
    expect(e.trades[0]).toMatchObject({ exitPrice: 20990, exitReason: 'stop_loss' });
  });
});
