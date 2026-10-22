import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors';
import type { OrderRequest } from '../src/types';
import { T0, engineOver, type Ohlc } from './helpers';

// NQ, tick 0.25. Row 0 closes at 21000 so lastPrice = 21000 until the first step.
const R0: Ohlc = [21000, 21001, 20999, 21000];
const ENTRY_BAR: Ohlc = [21000, 21003, 20997, 21002]; // after this bar lastPrice = 21002
const fresh = () => engineOver([R0, ENTRY_BAR, [21001, 21004, 20998, 21003]]);
const inPosition = (side: 'long' | 'short' = 'long', bracket: { stopLoss?: number; takeProfit?: number } = {}, nextRow: Ohlc = [21001, 21004, 20998, 21003]) => {
  const e = engineOver([R0, ENTRY_BAR, nextRow]);
  e.placeOrder({ side, type: 'market', qty: 1, ...bracket });
  e.step();
  expect(e.position).not.toBeNull();
  return e;
};

describe('placeOrder: validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects qty %s', (qty) => {
    expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty })).toThrow(EngineError);
  });

  it('accepts whole quantities', () => {
    expect(fresh().placeOrder({ side: 'long', type: 'market', qty: 7 }).qty).toBe(7);
  });

  it('limit and stop need a price', () => {
    expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1 })).toThrow(EngineError);
    expect(() => fresh().placeOrder({ side: 'short', type: 'stop', qty: 1 })).toThrow(EngineError);
  });

  it('rejects unknown side or type', () => {
    expect(() => fresh().placeOrder({ side: 'buy', type: 'market', qty: 1 } as unknown as OrderRequest)).toThrow(EngineError);
    expect(() => fresh().placeOrder({ side: 'long', type: 'oco', qty: 1 } as unknown as OrderRequest)).toThrow(EngineError);
  });

  it('all prices must be > 0', () => {
    for (const price of [0, -5, Number.NaN]) {
      expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price }), `price ${price}`).toThrow(EngineError);
    }
    expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 0 })).toThrow(EngineError);
    expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: -10 })).toThrow(EngineError);
    expect(() => fresh().placeOrder({ side: 'short', type: 'market', qty: 1, takeProfit: 0 })).toThrow(EngineError);
    expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 0.1 })).toThrow(EngineError); // rounds to 0 on a 0.25 grid
  });

  it('rounds price, SL and TP to the tick before use', () => {
    const o = fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995.1, stopLoss: 20985.13, takeProfit: 21005.12 });
    // 20995.1/0.25 = 83980.4 -> 83980 -> 20995; 20985.13/0.25 = 83940.52 -> 83941 -> 20985.25; 21005.12/0.25 = 84020.48 -> 84020 -> 21005
    expect(o).toMatchObject({ price: 20995, stopLoss: 20985.25, takeProfit: 21005 });
  });

  describe('SL and TP sides, market order reference = lastPrice (21000)', () => {
    it('long: SL < reference < TP', () => {
      for (const stopLoss of [21001, 21000]) {
        expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss }), `SL ${stopLoss}`).toThrow(EngineError);
      }
      for (const takeProfit of [20999, 21000]) {
        expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit }), `TP ${takeProfit}`).toThrow(EngineError);
      }
      // one tick either side of the reference is fine
      expect(fresh().placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20999.75, takeProfit: 21000.25 })).toMatchObject({ stopLoss: 20999.75, takeProfit: 21000.25 });
    });
    it('short: TP < reference < SL', () => {
      for (const stopLoss of [20999, 21000]) {
        expect(() => fresh().placeOrder({ side: 'short', type: 'market', qty: 1, stopLoss }), `SL ${stopLoss}`).toThrow(EngineError);
      }
      for (const takeProfit of [21001, 21000]) {
        expect(() => fresh().placeOrder({ side: 'short', type: 'market', qty: 1, takeProfit }), `TP ${takeProfit}`).toThrow(EngineError);
      }
      expect(fresh().placeOrder({ side: 'short', type: 'market', qty: 1, stopLoss: 21000.25, takeProfit: 20999.75 })).toMatchObject({ stopLoss: 21000.25, takeProfit: 20999.75 });
    });
    it('the check happens after rounding to the tick', () => {
      // 20999.9 rounds to 21000, which equals the reference
      expect(() => fresh().placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20999.9 })).toThrow(EngineError);
    });
  });

  describe('SL and TP sides, limit and stop reference = the order price', () => {
    it('long limit 20990: levels are checked against 20990, not against lastPrice', () => {
      expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990, stopLoss: 20991 })).toThrow(EngineError); // 20991 is under lastPrice but over the order price
      expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990, stopLoss: 20990 })).toThrow(EngineError);
      expect(() => fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990, takeProfit: 20990 })).toThrow(EngineError);
      expect(fresh().placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20990, stopLoss: 20989.75, takeProfit: 20990.25 })).toMatchObject({ price: 20990 });
    });
    it('short stop 20990', () => {
      expect(() => fresh().placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990, stopLoss: 20989.75 })).toThrow(EngineError);
      expect(() => fresh().placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990, takeProfit: 20990.25 })).toThrow(EngineError);
      expect(fresh().placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990, stopLoss: 20990.25, takeProfit: 20989.75 })).toMatchObject({ type: 'stop' });
    });
  });

  it('a market order drops any price it was given', () => {
    const o = fresh().placeOrder({ side: 'long', type: 'market', qty: 1, price: 12345 });
    expect(o.price).toBeUndefined();
  });

  it('returns a working order with a unique id and placedAt = cursor time', () => {
    const e = fresh();
    const a = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995, stopLoss: 20985, takeProfit: 21005 });
    expect(a).toEqual({ id: a.id, status: 'working', placedAt: T0, side: 'long', type: 'limit', qty: 1, price: 20995, stopLoss: 20985, takeProfit: 21005 });
    expect(a.id).toMatch(/^o\d+$/);
    expect(e.workingOrder).toEqual(a);
    e.cancelOrder(a.id);
    const b = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(b.id).not.toBe(a.id);
  });

  it('no new entry while an entry order is working', () => {
    const e = fresh();
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(() => e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21100 })).toThrow(EngineError);
    expect(() => e.placeOrder({ side: 'long', type: 'market', qty: 1 })).toThrow(EngineError);
  });

  it('no new entry while in a position, and again allowed once flat', () => {
    const e = inPosition('long', { takeProfit: 21010 }, [21002, 21011, 21001, 21003]);
    expect(() => e.placeOrder({ side: 'long', type: 'market', qty: 1 })).toThrow(EngineError);
    expect(() => e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21100 })).toThrow(EngineError);
    e.step(); // TP 21010 hit
    expect(e.position).toBeNull();
    expect(e.placeOrder({ side: 'short', type: 'market', qty: 1 }).status).toBe('working');
  });

  it('a rejected order leaves no trace', () => {
    const e = fresh();
    expect(() => e.placeOrder({ side: 'long', type: 'market', qty: 0 })).toThrow(EngineError);
    expect(e.workingOrder).toBeNull();
    expect(e.placeOrder({ side: 'long', type: 'market', qty: 1 }).status).toBe('working');
  });
});

describe('cancelOrder', () => {
  it('cancels the working order, which then never fills', () => {
    const e = engineOver([R0, [21000, 21010, 20990, 21008]]);
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    e.cancelOrder(o.id);
    expect(e.workingOrder).toBeNull();
    expect(e.step()).toEqual([]);
    expect(e.position).toBeNull();
  });
  it('throws on an unknown id', () => {
    const e = fresh();
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(() => e.cancelOrder('nope')).toThrow(EngineError);
    expect(e.workingOrder).not.toBeNull();
  });
  it('throws on an already cancelled order', () => {
    const e = fresh();
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    e.cancelOrder(o.id);
    expect(() => e.cancelOrder(o.id)).toThrow(EngineError);
  });
  it('throws on a filled order', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21004, 20998, 21003]]);
    const o = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(() => e.cancelOrder(o.id)).toThrow(EngineError);
  });
  it('throws when nothing is working', () => {
    expect(() => fresh().cancelOrder('o1')).toThrow(EngineError);
  });
});

describe('modifyBracket', () => {
  it('needs an open position', () => {
    expect(() => fresh().modifyBracket({ stopLoss: 20990 })).toThrow(EngineError);
    const e = fresh();
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(() => e.modifyBracket({ stopLoss: 20800 })).toThrow(EngineError); // a working order is not a position
  });

  it('long: SL must be under lastPrice (21002), TP over it', () => {
    const e = inPosition('long', { stopLoss: 20990, takeProfit: 21020 });
    for (const stopLoss of [21002, 21003]) expect(() => e.modifyBracket({ stopLoss }), `SL ${stopLoss}`).toThrow(EngineError);
    for (const takeProfit of [21002, 21001]) expect(() => e.modifyBracket({ takeProfit }), `TP ${takeProfit}`).toThrow(EngineError);
    e.modifyBracket({ stopLoss: 21001.75, takeProfit: 21002.25 });
    expect(e.position).toMatchObject({ stopLoss: 21001.75, takeProfit: 21002.25 });
  });

  it('short: SL must be over lastPrice, TP under it', () => {
    const e = inPosition('short', { stopLoss: 21010, takeProfit: 20980 });
    for (const stopLoss of [21002, 21001]) expect(() => e.modifyBracket({ stopLoss }), `SL ${stopLoss}`).toThrow(EngineError);
    for (const takeProfit of [21002, 21003]) expect(() => e.modifyBracket({ takeProfit }), `TP ${takeProfit}`).toThrow(EngineError);
    e.modifyBracket({ stopLoss: 21002.25, takeProfit: 21001.75 });
    expect(e.position).toMatchObject({ stopLoss: 21002.25, takeProfit: 21001.75 });
  });

  it('prices must be > 0 and are rounded to the tick', () => {
    const e = inPosition('long', { stopLoss: 20990 });
    expect(() => e.modifyBracket({ stopLoss: 0 })).toThrow(EngineError);
    expect(() => e.modifyBracket({ takeProfit: -5 })).toThrow(EngineError);
    e.modifyBracket({ stopLoss: 20995.1, takeProfit: 21010.13 });
    expect(e.position).toMatchObject({ stopLoss: 20995, takeProfit: 21010.25 });
  });

  it('null removes a level, undefined leaves it alone', () => {
    const e = inPosition('long', { stopLoss: 20990, takeProfit: 21020 });
    e.modifyBracket({ takeProfit: null });
    expect(e.position?.takeProfit).toBeUndefined();
    expect(e.position?.stopLoss).toBe(20990);
    e.modifyBracket({ stopLoss: undefined });
    expect(e.position?.stopLoss).toBe(20990);
    e.modifyBracket({});
    expect(e.position?.stopLoss).toBe(20990);
    e.modifyBracket({ stopLoss: null });
    expect(e.position?.stopLoss).toBeUndefined();
  });

  it('is atomic: a bad level means nothing changes', () => {
    const e = inPosition('long', { stopLoss: 20990, takeProfit: 21020 });
    expect(() => e.modifyBracket({ stopLoss: 20995, takeProfit: 21000 })).toThrow(EngineError); // TP under lastPrice
    expect(e.position).toMatchObject({ stopLoss: 20990, takeProfit: 21020 });
  });

  it('never touches initialStopLoss', () => {
    const e = inPosition('long', { stopLoss: 20990 });
    e.modifyBracket({ stopLoss: 20999 });
    e.modifyBracket({ stopLoss: null });
    expect(e.position?.initialStopLoss).toBe(20990);
  });

  it('a moved SL is live from the next bar: exits at the new level', () => {
    const e = inPosition('long', { stopLoss: 20990, takeProfit: 21020 }, [21001, 21003, 20994, 20998]);
    e.modifyBracket({ stopLoss: 20995 });
    e.step();
    // entry 21000, exit 20995: -20 ticks = -$100 (it would not have stopped at the old 20990 since low is 20994)
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20995, pnlTicks: -20, grossUsd: -100 });
  });

  it('a moved TP is live from the next bar, and a removed TP is gone', () => {
    const moved = inPosition('long', { takeProfit: 21020 }, [21001, 21011, 21000, 21009]);
    moved.modifyBracket({ takeProfit: 21010 });
    moved.step();
    expect(moved.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21010, pnlTicks: 40, grossUsd: 200 });

    const removed = inPosition('long', { takeProfit: 21005 }, [21001, 21030, 21000, 21009]);
    removed.modifyBracket({ takeProfit: null });
    expect(removed.step()).toEqual([]);
    expect(removed.position).not.toBeNull();
  });

  it('adds an SL to a position that had none', () => {
    const e = inPosition('long', {}, [21001, 21003, 20980, 20995]);
    e.modifyBracket({ stopLoss: 20990 });
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20990 });
  });
});

describe('modifyOrder', () => {
  const placeLimit = () => {
    const e = engineOver([R0, [21000, 21005, 20996, 21002], [21001, 21004, 20998, 21003]]);
    const o = e.placeOrder({ side: 'long', type: 'limit', qty: 2, price: 20995, stopLoss: 20985, takeProfit: 21005 });
    return { e, o };
  };

  it('moves the price and returns the updated order', () => {
    const { e, o } = placeLimit();
    const m = e.modifyOrder(o.id, { price: 20996 });
    expect(m).toEqual({ id: o.id, status: 'working', placedAt: T0, side: 'long', type: 'limit', qty: 2, price: 20996, stopLoss: 20985, takeProfit: 21005 });
    expect(e.workingOrder).toEqual(m);
  });

  it('the new price is the one that fills: low 20996 fills a 20996 limit but not the old 20995', () => {
    const { e, o } = placeLimit();
    e.modifyOrder(o.id, { price: 20996 });
    e.step();
    expect(e.position).toMatchObject({ entryPrice: 20996, qty: 2, stopLoss: 20985, takeProfit: 21005 });
  });

  it('changes SL and TP; null removes, undefined leaves alone', () => {
    const { e, o } = placeLimit();
    e.modifyOrder(o.id, { stopLoss: 20980, takeProfit: 21010 });
    expect(e.workingOrder).toMatchObject({ stopLoss: 20980, takeProfit: 21010 });
    e.modifyOrder(o.id, { takeProfit: null });
    expect(e.workingOrder?.takeProfit).toBeUndefined();
    expect(e.workingOrder).not.toHaveProperty('takeProfit');
    expect(e.workingOrder?.stopLoss).toBe(20980);
    e.modifyOrder(o.id, { stopLoss: undefined, price: undefined });
    expect(e.workingOrder).toMatchObject({ stopLoss: 20980, price: 20995 });
  });

  it('rounds to the tick', () => {
    const { e, o } = placeLimit();
    expect(e.modifyOrder(o.id, { price: 20996.1, stopLoss: 20984.9 })).toMatchObject({ price: 20996, stopLoss: 20985 });
  });

  it('is checked against the order after the change, and a rejected change leaves the order as it was', () => {
    const { e, o } = placeLimit();
    const before = e.workingOrder;
    expect(() => e.modifyOrder(o.id, { price: 20985 })).toThrow(EngineError); // price == SL
    expect(() => e.modifyOrder(o.id, { price: 21005 })).toThrow(EngineError); // price == TP
    expect(() => e.modifyOrder(o.id, { price: 21010 })).toThrow(EngineError); // price over TP
    expect(() => e.modifyOrder(o.id, { stopLoss: 20995 })).toThrow(EngineError); // SL == price
    expect(() => e.modifyOrder(o.id, { takeProfit: 20990 })).toThrow(EngineError); // TP under price
    expect(() => e.modifyOrder(o.id, { price: 0 })).toThrow(EngineError);
    expect(() => e.modifyOrder(o.id, { stopLoss: -1 })).toThrow(EngineError);
    expect(e.workingOrder).toEqual(before);
  });

  it('moving price and a level together is valid when the result is', () => {
    const { e, o } = placeLimit();
    expect(e.modifyOrder(o.id, { price: 21000, stopLoss: 20999, takeProfit: 21001 })).toMatchObject({ price: 21000, stopLoss: 20999, takeProfit: 21001 });
  });

  it('a market order takes SL/TP changes against lastPrice, but has no price to move', () => {
    const e = fresh();
    const o = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(() => e.modifyOrder(o.id, { price: 21000 })).toThrow(EngineError);
    expect(() => e.modifyOrder(o.id, { stopLoss: 21000 })).toThrow(EngineError); // lastPrice 21000
    expect(e.modifyOrder(o.id, { stopLoss: 20990, takeProfit: 21010 })).toMatchObject({ type: 'market', stopLoss: 20990, takeProfit: 21010 });
  });

  it('throws on an unknown, cancelled or filled id', () => {
    const { e, o } = placeLimit();
    expect(() => e.modifyOrder('nope', { price: 20990 })).toThrow(EngineError);
    e.cancelOrder(o.id);
    expect(() => e.modifyOrder(o.id, { price: 20990 })).toThrow(EngineError);

    const f = fresh();
    const m = f.placeOrder({ side: 'long', type: 'market', qty: 1 });
    f.step();
    expect(() => f.modifyOrder(m.id, { stopLoss: 20990 })).toThrow(EngineError);
  });

  it('returns a copy', () => {
    const { e, o } = placeLimit();
    const m = e.modifyOrder(o.id, { price: 20996 });
    m.price = 1;
    expect(e.workingOrder?.price).toBe(20996);
  });
});

describe('closePosition', () => {
  it('needs an open position', () => {
    expect(() => fresh().closePosition()).toThrow(EngineError);
  });
  it('is idempotent while pending', () => {
    const e = inPosition();
    e.closePosition();
    e.closePosition();
    expect(e.position?.pendingClose).toBe(true);
    e.step();
    expect(e.trades).toHaveLength(1);
  });
  it('the position keeps its SL and TP while the close is pending (they do not fire before the close)', () => {
    const e = inPosition('long', { stopLoss: 20990, takeProfit: 21020 });
    e.closePosition();
    expect(e.position).toMatchObject({ stopLoss: 20990, takeProfit: 21020, pendingClose: true });
  });
});
