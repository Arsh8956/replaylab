import { describe, expect, it } from 'vitest';
import { CONTRACTS } from '../src/contracts';
import type { ContractSpec, SessionSettings } from '../src/types';
import { T0, engineOver, type Ohlc } from './helpers';

// NQ: tick 0.25, tick value $5.00, so 1 point = 4 ticks = $20.00. Slippage of 2 ticks = 0.5 points.
// Every test hand checks its numbers in the comments. Row 0 is the context bar the cursor starts on.
const R0: Ohlc = [21000, 21001, 20999, 21000]; // lastPrice 21000
const ENTRY_BAR: Ohlc = [21000, 21003, 20997, 21002]; // benign bar: touches no level used below
const SLIP2: Partial<SessionSettings> = { slippageTicks: 2 };

/** Market long qty 1 with SL 20990 (40 ticks, $200 risk) and TP 21020 (80 ticks, $400), in the position after ENTRY_BAR. */
function inLong(row2: Ohlc, settings: Partial<SessionSettings> = {}) {
  const e = engineOver([R0, ENTRY_BAR, row2], settings);
  e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990, takeProfit: 21020 });
  e.step();
  expect(e.position).not.toBeNull();
  return e;
}
/** Market short qty 1 with SL 21010 and TP 20980, in the position after ENTRY_BAR. */
function inShort(row2: Ohlc, settings: Partial<SessionSettings> = {}) {
  const e = engineOver([R0, ENTRY_BAR, row2], settings);
  e.placeOrder({ side: 'short', type: 'market', qty: 1, stopLoss: 21010, takeProfit: 20980 });
  e.step();
  expect(e.position).not.toBeNull();
  return e;
}

describe('step 1: pending manual close exits at the next bar open', () => {
  it('long: entry at the open, manual close at the next open', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003], [21005, 21008, 21002, 21006]]);
    const order = e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    expect(order).toMatchObject({ status: 'working', placedAt: T0 });

    expect(e.step().map((x) => x.type)).toEqual(['order_filled', 'position_opened']);
    // fill bar [21001, 21004, 20998, 21003]: MFE (21004-21001)/0.25 = 12, MAE (21001-20998)/0.25 = 12
    expect(e.position).toMatchObject({ side: 'long', qty: 1, entryPrice: 21001, entryTime: T0 + 60, maeTicks: 12, mfeTicks: 12, pendingClose: false });
    // lastPrice 21003: (21003-21001)/0.25 = 8 ticks, 8 * $5 = $40
    expect(e.unrealized()).toEqual({ ticks: 8, usd: 40 });

    e.closePosition();
    expect(e.position?.pendingClose).toBe(true);
    expect(e.trades).toEqual([]); // nothing happens until the next bar

    expect(e.step().map((x) => x.type)).toEqual(['trade_closed']);
    // exit at the next open 21005, not at the close 21003: (21005-21001)/0.25 = 16 ticks = $80
    expect(e.trades[0]).toMatchObject({
      side: 'long',
      entryPrice: 21001,
      exitPrice: 21005,
      exitTime: T0 + 120,
      exitReason: 'manual',
      pnlTicks: 16,
      grossUsd: 80,
      feesUsd: 0,
      netUsd: 80,
      holdSeconds: 60,
      riskUsd: null,
      rMultiple: null,
      // bar 2 trades after the exit, so its high (21008) does not count; the exit price (16 ticks) does
      maeTicks: 12,
      mfeTicks: 16,
    });
    expect(e.position).toBeNull();
  });

  it('wins over a gap through the stop: reason is manual, not stop_loss', () => {
    const e = inLong([20985, 20988, 20980, 20986]); // opens 5 points under SL 20990
    e.closePosition();
    e.step();
    // exit at the open 20985: (20985-21000)/0.25 = -60 ticks = -$300
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 20985, pnlTicks: -60, grossUsd: -300 });
  });

  it('wins over a take profit gap and takes manual slippage (2 ticks) instead of the free TP fill', () => {
    // entry: open 21000 + 0.5 slippage = 21000.5. Bar 2 opens 21025, above TP 21020.
    const e = inLong([21025, 21030, 21020, 21028], SLIP2);
    expect(e.position?.entryPrice).toBe(21000.5);
    e.closePosition();
    e.step();
    // manual: 21025 - 0.5 = 21024.5; (21024.5-21000.5)/0.25 = 96 ticks = $480. A TP gap would have been 98 ticks.
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 21024.5, pnlTicks: 96, grossUsd: 480 });
  });

  it('short: manual close is a buy at the next open, slippage against the trader', () => {
    const e = inShort([21005, 21008, 21002, 21006], SLIP2); // entry 21000 - 0.5 = 20999.5
    expect(e.position?.entryPrice).toBe(20999.5);
    e.closePosition();
    e.step();
    // exit 21005 + 0.5 = 21005.5; short pnl = (20999.5 - 21005.5)/0.25 = -24 ticks = -$120
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 21005.5, pnlTicks: -24, grossUsd: -120 });
  });
});

describe('step 2a: gap through a level', () => {
  it('long, open at or under the SL: exit at the open, not at the SL', () => {
    const e = inLong([20980, 20985, 20970, 20975]);
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['trade_closed']);
    // exit 20980 (not 20990): (20980-21000)/0.25 = -80 ticks = -$400. Risk 40 ticks = $200, R = -2.
    expect(e.trades[0]).toMatchObject({
      exitReason: 'stop_loss',
      exitPrice: 20980,
      pnlTicks: -80,
      grossUsd: -400,
      netUsd: -400,
      riskUsd: 200,
      rMultiple: -2,
      maeTicks: 80, // exit at the open, so the bar's lower prices are not part of the trade
      mfeTicks: 12, // ENTRY_BAR high 21003
    });
  });

  it('long SL gap takes slippage (2 ticks) against the trader', () => {
    const e = inLong([20980, 20985, 20970, 20975], SLIP2); // entry 21000.5
    e.step();
    // exit 20980 - 0.5 = 20979.5; (20979.5-21000.5)/0.25 = -84 ticks = -$420. Risk |21000.5-20990|/0.25 = 42 ticks = $210, R = -2.
    expect(e.trades[0]).toMatchObject({ exitPrice: 20979.5, pnlTicks: -84, grossUsd: -420, riskUsd: 210, rMultiple: -2 });
    expect(e.trades[0]!.maeTicks).toBe(84); // the realized loss is always inside MAE
    expect(e.trades[0]!.mfeTicks).toBe(10); // ENTRY_BAR high 21003 - entry 21000.5 = 2.5 = 10 ticks
  });

  it('long, open at or over the TP: exit at the open, no slippage on take profit', () => {
    const e = inLong([21025, 21030, 21021, 21028], SLIP2); // entry 21000.5
    e.step();
    // exit 21025 (not 21020): (21025-21000.5)/0.25 = 98 ticks = $490, even with slippage set
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21025, pnlTicks: 98, grossUsd: 490, mfeTicks: 98 });
  });

  it('short, open at or over the SL: exit at the open', () => {
    const e = inShort([21015, 21020, 21012, 21018]);
    e.step();
    // short entry 21000, exit 21015: -(21015-21000)/0.25 = -60 ticks = -$300. Risk 40 ticks = $200, R = -1.5.
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 21015, pnlTicks: -60, grossUsd: -300, riskUsd: 200, rMultiple: -1.5 });
  });

  it('short SL gap takes slippage', () => {
    const e = inShort([21015, 21020, 21012, 21018], SLIP2); // entry 21000 - 0.5 = 20999.5
    e.step();
    // exit 21015 + 0.5 = 21015.5; (20999.5-21015.5)/0.25 = -64 ticks = -$320. Risk |20999.5-21010|/0.25 = 42 ticks = $210.
    expect(e.trades[0]).toMatchObject({ exitPrice: 21015.5, pnlTicks: -64, grossUsd: -320, riskUsd: 210 });
    expect(e.trades[0]!.rMultiple).toBeCloseTo(-320 / 210, 10);
  });

  it('short, open at or under the TP: exit at the open, no slippage', () => {
    const e = inShort([20975, 20978, 20970, 20972], SLIP2); // entry 20999.5
    e.step();
    // exit 20975: (20999.5-20975)/0.25 = 98 ticks = $490
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 20975, pnlTicks: 98, grossUsd: 490 });
  });
});

describe('step 2b: SL and TP both inside one bar, SL wins', () => {
  it('long', () => {
    const e = inLong([21005, 21025, 20985, 21010]); // low 20985 <= SL 20990 and high 21025 >= TP 21020
    e.step();
    // exit at SL 20990: (20990-21000)/0.25 = -40 ticks = -$200, R = -1
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20990, pnlTicks: -40, grossUsd: -200, rMultiple: -1 });
  });
  it('long with slippage: SL fill is slipped', () => {
    const e = inLong([21005, 21025, 20985, 21010], SLIP2); // entry 21000.5
    e.step();
    // exit 20990 - 0.5 = 20989.5: (20989.5-21000.5)/0.25 = -44 ticks = -$220
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20989.5, pnlTicks: -44, grossUsd: -220 });
  });
  it('short', () => {
    const e = inShort([20995, 21015, 20975, 20990]); // high 21015 >= SL 21010 and low 20975 <= TP 20980
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 21010, pnlTicks: -40, grossUsd: -200 });
  });
  it('short with slippage', () => {
    const e = inShort([20995, 21015, 20975, 20990], SLIP2); // entry 20999.5
    e.step();
    // exit 21010 + 0.5 = 21010.5: (20999.5-21010.5)/0.25 = -44 ticks = -$220
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 21010.5, pnlTicks: -44, grossUsd: -220 });
  });
});

describe('step 2c: a level touched inside the bar', () => {
  it('long TP only: fills at the TP price', () => {
    const e = inLong([21001, 21022, 21000, 21015]);
    e.step();
    // (21020-21000)/0.25 = 80 ticks = $400, R = 400/200 = 2
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21020, pnlTicks: 80, grossUsd: 400, rMultiple: 2 });
  });
  it('long SL only: fills at the SL price, not at the bar low', () => {
    const e = inLong([21001, 21003, 20980, 20995]);
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20990, pnlTicks: -40, grossUsd: -200 });
  });
  it('short TP only', () => {
    const e = inShort([20999, 21001, 20978, 20985]);
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 20980, pnlTicks: 80, grossUsd: 400 });
  });
  it('short SL only', () => {
    const e = inShort([21001, 21020, 21000, 21015]);
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 21010, pnlTicks: -40, grossUsd: -200 });
  });
});

describe('exact touches count', () => {
  it('long SL: low == SL exits, one tick above does not', () => {
    const hit = inLong([21000, 21005, 20990, 21000]);
    hit.step();
    expect(hit.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20990 });

    const miss = inLong([21000, 21005, 20990.25, 21000]);
    expect(miss.step()).toEqual([]);
    expect(miss.position).not.toBeNull();
  });
  it('long TP: high == TP exits, one tick below does not', () => {
    const hit = inLong([21000, 21020, 21000, 21015]);
    hit.step();
    expect(hit.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21020 });

    const miss = inLong([21000, 21019.75, 21000, 21015]);
    expect(miss.step()).toEqual([]);
    expect(miss.position).not.toBeNull();
  });
  it('short SL: high == SL exits, one tick below does not', () => {
    const hit = inShort([21000, 21010, 20995, 21000]);
    hit.step();
    expect(hit.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 21010 });

    const miss = inShort([21000, 21009.75, 20995, 21000]);
    expect(miss.step()).toEqual([]);
  });
  it('short TP: low == TP exits, one tick above does not', () => {
    const hit = inShort([21000, 21005, 20980, 20990]);
    hit.step();
    expect(hit.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 20980 });

    const miss = inShort([21000, 21005, 20980.25, 20990]);
    expect(miss.step()).toEqual([]);
  });
  it('open == SL counts as a gap: exit at the open with slippage', () => {
    const e = inLong([20990, 20995, 20985, 20992], SLIP2); // entry 21000.5
    e.step();
    // exit 20990 - 0.5 = 20989.5: (20989.5-21000.5)/0.25 = -44 ticks
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20989.5, pnlTicks: -44 });
  });
  it('open == TP counts as a gap: exit at the open with no slippage', () => {
    const e = inLong([21020, 21022, 21018, 21021], SLIP2); // entry 21000.5
    e.step();
    // exit 21020: (21020-21000.5)/0.25 = 78 ticks
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21020, pnlTicks: 78 });
  });
  it('buy limit: low == L fills at L, one tick above does not', () => {
    const e = engineOver([R0, [21000, 21005, 20995, 21002], [21000, 21005, 20995.25, 21002]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    e.step();
    expect(e.position?.entryPrice).toBe(20995);

    const miss = engineOver([R0, [21000, 21005, 20995.25, 21002]]);
    miss.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    miss.step();
    expect(miss.position).toBeNull();
    expect(miss.workingOrder).toMatchObject({ status: 'working', price: 20995 });
  });
  it('sell limit: high == L fills at L, one tick below does not', () => {
    const e = engineOver([R0, [21000, 21005, 20998, 21002]]);
    e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005 });
    e.step();
    expect(e.position).toMatchObject({ side: 'short', entryPrice: 21005 });

    const miss = engineOver([R0, [21000, 21004.75, 20998, 21002]]);
    miss.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005 });
    miss.step();
    expect(miss.position).toBeNull();
  });
  it('buy stop: high == S fills at S, one tick below does not', () => {
    const e = engineOver([R0, [21003, 21010, 21002, 21008]]);
    e.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    e.step();
    expect(e.position?.entryPrice).toBe(21010);

    const miss = engineOver([R0, [21003, 21009.75, 21002, 21008]]);
    miss.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    miss.step();
    expect(miss.position).toBeNull();
  });
  it('sell stop: low == S fills at S, one tick above does not', () => {
    const e = engineOver([R0, [20995, 20996, 20990, 20992]]);
    e.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    e.step();
    expect(e.position).toMatchObject({ side: 'short', entryPrice: 20990 });

    const miss = engineOver([R0, [20995, 20996, 20990.25, 20992]]);
    miss.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    miss.step();
    expect(miss.position).toBeNull();
  });
  it('limit with open == L fills at the open (== L)', () => {
    const e = engineOver([R0, [20995, 21000, 20990, 20998]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    e.step();
    expect(e.position?.entryPrice).toBe(20995);
  });
});

describe('step 3: working entry order fills', () => {
  it('buy limit: open at or under L fills at the open (price improvement)', () => {
    const e = engineOver([R0, [20990, 20993, 20988, 20992]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    const ev = e.step();
    expect(ev[0]).toMatchObject({ type: 'order_filled', time: T0 + 60, order: { status: 'filled', fillPrice: 20990, filledAt: T0 + 60 } });
    expect(e.position?.entryPrice).toBe(20990);
  });
  it('buy limit: otherwise a touch fills at L', () => {
    const e = engineOver([R0, [21000, 21010, 20990, 21008]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    e.step();
    expect(e.position?.entryPrice).toBe(20995);
  });
  it('sell limit: open at or over L fills at the open; a touch fills at L', () => {
    const gap = engineOver([R0, [21007, 21009, 21004, 21006]]);
    gap.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005 });
    gap.step();
    expect(gap.position).toMatchObject({ side: 'short', entryPrice: 21007 });

    const touch = engineOver([R0, [21000, 21006, 20999, 21003]]);
    touch.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005 });
    touch.step();
    expect(touch.position).toMatchObject({ side: 'short', entryPrice: 21005 });
  });
  it('buy stop: open at or over S fills at the open; a touch fills at S', () => {
    const gap = engineOver([R0, [21015, 21020, 21013, 21018]]);
    gap.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    gap.step();
    expect(gap.position?.entryPrice).toBe(21015);

    const touch = engineOver([R0, [21003, 21012, 21002, 21011]]);
    touch.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    touch.step();
    expect(touch.position?.entryPrice).toBe(21010);
  });
  it('sell stop: open at or under S fills at the open; a touch fills at S', () => {
    const gap = engineOver([R0, [20985, 20990, 20983, 20988]]);
    gap.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    gap.step();
    expect(gap.position).toMatchObject({ side: 'short', entryPrice: 20985 });

    const touch = engineOver([R0, [20995, 20996, 20988, 20990]]);
    touch.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    touch.step();
    expect(touch.position).toMatchObject({ side: 'short', entryPrice: 20990 });
  });
  it('an order that is not touched stays working across bars', () => {
    const e = engineOver([R0, [21000, 21003, 20996, 21001], [21001, 21004, 20997, 21002]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    expect(e.step(2)).toEqual([]);
    expect(e.workingOrder).toMatchObject({ status: 'working', price: 20995 });
  });
  it('the order is never processed on the bar it was placed on', () => {
    // cursor bar 0 already has low 20999, which touches 20999.5; still no fill until bar 1
    const e = engineOver([R0, [21003, 21005, 21002, 21004]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21000 });
    expect(e.position).toBeNull();
    e.step();
    expect(e.position).toBeNull(); // bar 1 low 21002 never reaches 21000
  });
  it('events on a same bar entry and exit: order_filled, position_opened, trade_closed', () => {
    const e = engineOver([R0, [21000, 21010, 20995, 21008]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21005 });
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    expect(ev.every((x) => x.time === T0 + 60)).toBe(true);
  });
});

describe('step 3: the fill bar (only the SL can trigger, TP waits) and its open price exception', () => {
  // Buy limit 20995 with SL 20985 and TP 21005, reference price = 20995
  const place = (rows: Ohlc[]) => {
    const e = engineOver([R0, ...rows]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995, stopLoss: 20985, takeProfit: 21005 });
    return e;
  };

  it('intrabar fill, SL touched in the fill bar: exits at the SL', () => {
    const e = place([[21000, 21010, 20984, 21008]]); // low 20984 <= 20995 fills at 20995; low <= SL 20985
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    // entry 20995, exit 20985: -40 ticks = -$200, risk 40 ticks = $200, R = -1
    expect(e.trades[0]).toMatchObject({ entryPrice: 20995, exitPrice: 20985, exitReason: 'stop_loss', pnlTicks: -40, grossUsd: -200, riskUsd: 200, rMultiple: -1 });
    expect(e.position).toBeNull();
  });

  it('intrabar fill, TP touched in the fill bar: TP waits for the next bar', () => {
    const e = place([[21000, 21010, 20990, 21008], [21001, 21006, 21000, 21004]]);
    // fill bar: fills at 20995, SL 20985 untouched (low 20990), high 21010 >= TP 21005 but the TP is ignored
    expect(e.step().map((x) => x.type)).toEqual(['order_filled', 'position_opened']);
    expect(e.position).toMatchObject({ entryPrice: 20995, takeProfit: 21005 });
    // next bar: open 21001 < TP, high 21006 >= TP: exit at 21005. (21005-20995)/0.25 = 40 ticks = $200
    expect(e.step().map((x) => x.type)).toEqual(['trade_closed']);
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21005, pnlTicks: 40, grossUsd: 200, entryTime: T0 + 60, exitTime: T0 + 120 });
  });

  it('after a waiting TP, a gap over it exits at the open', () => {
    const e = place([[21000, 21010, 20990, 21008], [21009, 21012, 21006, 21011]]);
    e.step(2);
    // open 21009 >= TP 21005: exit 21009, no slippage. (21009-20995)/0.25 = 56 ticks = $280
    expect(e.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 21009, pnlTicks: 56, grossUsd: 280 });
  });

  it('exception: a limit filled at the open runs rules 2a to 2c on the fill bar, TP included', () => {
    // buy limit 21002, bar opens 21000 <= 21002 so it fills at the open 21000. SL 20990, TP 21005.
    const e = engineOver([R0, [21000, 21010, 20995, 21008]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21002, stopLoss: 20990, takeProfit: 21005 });
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    // exit at TP 21005: (21005-21000)/0.25 = 20 ticks = $100
    expect(e.trades[0]).toMatchObject({ entryPrice: 21000, exitPrice: 21005, exitReason: 'take_profit', pnlTicks: 20, grossUsd: 100 });
  });

  it('exception, both levels in the fill bar: SL first', () => {
    const e = engineOver([R0, [21000, 21010, 20985, 21008]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 21002, stopLoss: 20990, takeProfit: 21005 });
    e.step();
    // exit at SL 20990: (20990-21000)/0.25 = -40 ticks = -$200
    expect(e.trades[0]).toMatchObject({ entryPrice: 21000, exitPrice: 20990, exitReason: 'stop_loss', pnlTicks: -40, grossUsd: -200 });
  });

  it('exception: a market entry is at the open, so the fill bar runs in full', () => {
    const e = engineOver([R0, [21000, 21010, 20995, 21008]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990, takeProfit: 21005 });
    e.step();
    expect(e.trades[0]).toMatchObject({ entryPrice: 21000, exitPrice: 21005, exitReason: 'take_profit', pnlTicks: 20 });
  });

  it('exception: a gap stop entry (filled at the open) runs the fill bar in full', () => {
    // buy stop 21010 gaps: opens 21015, fills at 21015. SL 21000, TP 21020: high 21022 >= TP so exit at 21020 the same bar.
    const e = engineOver([R0, [21015, 21022, 21012, 21018]]);
    e.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010, stopLoss: 21000, takeProfit: 21020 });
    e.step();
    // (21020-21015)/0.25 = 20 ticks = $100
    expect(e.trades[0]).toMatchObject({ entryPrice: 21015, exitPrice: 21020, exitReason: 'take_profit', pnlTicks: 20, grossUsd: 100 });
  });

  it('intrabar stop entry: TP waits too', () => {
    // buy stop 21010 touched intrabar (open 21003): fills 21010. TP 21011 is inside the bar (high 21012) but must wait.
    const e = engineOver([R0, [21003, 21012, 21002, 21011]]);
    e.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010, stopLoss: 21000, takeProfit: 21011 });
    e.step();
    expect(e.position).toMatchObject({ entryPrice: 21010 });
    expect(e.trades).toEqual([]);
  });

  it('short intrabar limit mirrors: SL (above) can trigger in the fill bar, TP waits', () => {
    // sell limit 21005, SL 21015, TP 20995. bar opens 21000 < 21005 and trades up to 21016.
    const e = engineOver([R0, [21000, 21016, 20990, 21000]]);
    e.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005, stopLoss: 21015, takeProfit: 20995 });
    e.step();
    // entry 21005, SL 21015 hit (high 21016): -40 ticks = -$200. TP 20995 (low 20990) did not matter.
    expect(e.trades[0]).toMatchObject({ side: 'short', entryPrice: 21005, exitPrice: 21015, exitReason: 'stop_loss', pnlTicks: -40, grossUsd: -200 });
  });

  it('gap through the SL on a market entry bar: enters and exits at the open', () => {
    // market long placed at lastPrice 21000 with SL 20990; the next bar opens at 20985, under the SL
    const e = engineOver([R0, [20985, 20990, 20980, 20988]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    // in at 20985, out at 20985: 0 ticks. Risk |20985-20990|/0.25 = 20 ticks = $100, R = 0
    expect(e.trades[0]).toMatchObject({ entryPrice: 20985, exitPrice: 20985, exitReason: 'stop_loss', pnlTicks: 0, grossUsd: 0, riskUsd: 100, rMultiple: 0 });
    expect(Object.is(e.trades[0]!.pnlTicks, 0)).toBe(true);
  });
});

describe('slippage applies to market, stop, SL and manual only', () => {
  it('market entries: long pays up, short sells lower', () => {
    const long = engineOver([R0, [21001, 21004, 20998, 21003]], SLIP2);
    long.placeOrder({ side: 'long', type: 'market', qty: 1 });
    long.step();
    expect(long.position?.entryPrice).toBe(21001.5); // 21001 + 2 * 0.25

    const short = engineOver([R0, [21001, 21004, 20998, 21003]], SLIP2);
    short.placeOrder({ side: 'short', type: 'market', qty: 1 });
    short.step();
    expect(short.position?.entryPrice).toBe(21000.5); // 21001 - 2 * 0.25
  });
  it('stop entries slip, intrabar and on a gap', () => {
    const buyTouch = engineOver([R0, [21003, 21012, 21002, 21011]], SLIP2);
    buyTouch.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    buyTouch.step();
    expect(buyTouch.position?.entryPrice).toBe(21010.5);

    const buyGap = engineOver([R0, [21015, 21020, 21013, 21018]], SLIP2);
    buyGap.placeOrder({ side: 'long', type: 'stop', qty: 1, price: 21010 });
    buyGap.step();
    expect(buyGap.position?.entryPrice).toBe(21015.5);

    const sellTouch = engineOver([R0, [20995, 20996, 20988, 20990]], SLIP2);
    sellTouch.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    sellTouch.step();
    expect(sellTouch.position?.entryPrice).toBe(20989.5);

    const sellGap = engineOver([R0, [20985, 20990, 20983, 20988]], SLIP2);
    sellGap.placeOrder({ side: 'short', type: 'stop', qty: 1, price: 20990 });
    sellGap.step();
    expect(sellGap.position?.entryPrice).toBe(20984.5);
  });
  it('limit entries never slip', () => {
    const touch = engineOver([R0, [21000, 21010, 20990, 21008]], SLIP2);
    touch.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    touch.step();
    expect(touch.position?.entryPrice).toBe(20995);

    const gap = engineOver([R0, [20990, 20993, 20988, 20992]], SLIP2);
    gap.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 });
    gap.step();
    expect(gap.position?.entryPrice).toBe(20990);

    const sell = engineOver([R0, [21000, 21006, 20999, 21003]], SLIP2);
    sell.placeOrder({ side: 'short', type: 'limit', qty: 1, price: 21005 });
    sell.step();
    expect(sell.position?.entryPrice).toBe(21005);
  });
  it('take profit exits never slip', () => {
    const e = inLong([21001, 21022, 21000, 21015], SLIP2); // entry 21000.5
    e.step();
    // exit 21020: (21020-21000.5)/0.25 = 78 ticks = $390
    expect(e.trades[0]).toMatchObject({ exitPrice: 21020, pnlTicks: 78, grossUsd: 390 });
    const s = inShort([20999, 21001, 20978, 20985], SLIP2); // entry 20999.5
    s.step();
    // exit 20980: (20999.5-20980)/0.25 = 78 ticks
    expect(s.trades[0]).toMatchObject({ exitPrice: 20980, pnlTicks: 78, grossUsd: 390 });
  });
  it('stop loss exits slip against the trader (intrabar)', () => {
    const e = inLong([21001, 21003, 20980, 20995], SLIP2); // entry 21000.5
    e.step();
    // exit 20990 - 0.5 = 20989.5: -44 ticks
    expect(e.trades[0]).toMatchObject({ exitPrice: 20989.5, pnlTicks: -44, grossUsd: -220 });
    const s = inShort([21001, 21020, 21000, 21015], SLIP2); // entry 20999.5
    s.step();
    // exit 21010 + 0.5 = 21010.5: (20999.5-21010.5)/0.25 = -44 ticks
    expect(s.trades[0]).toMatchObject({ exitPrice: 21010.5, pnlTicks: -44, grossUsd: -220 });
  });
  it('manual closes slip against the trader', () => {
    const e = inLong([21005, 21008, 21002, 21006], SLIP2); // entry 21000.5
    e.closePosition();
    e.step();
    // exit 21005 - 0.5 = 21004.5: (21004.5-21000.5)/0.25 = 16 ticks = $80
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 21004.5, pnlTicks: 16, grossUsd: 80 });
  });
  it('end of data closes at the close with no slippage', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003]], SLIP2);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    // entry 21001.5, exit at close 21003: (21003-21001.5)/0.25 = 6 ticks
    expect(e.trades[0]).toMatchObject({ exitReason: 'end_of_data', entryPrice: 21001.5, exitPrice: 21003, pnlTicks: 6, grossUsd: 30 });
  });
  it('slippage defaults to 0', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003]]);
    expect(e.settings.slippageTicks).toBe(0);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.trades[0]!.entryPrice).toBe(21001);
  });
});

describe('fees: commissionPerSide * qty * 2, USD rounded to cents', () => {
  it('3 contracts at $2.05 per side', () => {
    const e = engineOver([R0, [21000, 21003, 20999, 21001]], { commissionPerSide: 2.05 });
    e.placeOrder({ side: 'long', type: 'market', qty: 3, takeProfit: 21002 });
    e.step();
    // 8 ticks * $5 * 3 = $120.00 gross; fees 2.05 * 3 * 2 = $12.30; net $107.70
    expect(e.trades[0]).toMatchObject({ qty: 3, pnlTicks: 8, grossUsd: 120, feesUsd: 12.3, netUsd: 107.7 });
  });
  it('fees are charged on losers too', () => {
    const e = engineOver([R0, [21000, 21003, 20985, 20990]], { commissionPerSide: 4.1 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    e.step();
    // -40 ticks = -$200 gross, fees 4.10 * 2 = 8.20, net -208.20
    expect(e.trades[0]).toMatchObject({ grossUsd: -200, feesUsd: 8.2, netUsd: -208.2 });
  });
  it('rounds to cents: 0.333 per side is 0.67 in fees', () => {
    const e = engineOver([R0, [21000, 21003, 20999, 21001]], { commissionPerSide: 0.333 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21000.25 });
    e.step();
    // 1 tick = $5.00 gross, fees 0.666 -> 0.67, net 4.33
    expect(e.trades[0]).toMatchObject({ pnlTicks: 1, grossUsd: 5, feesUsd: 0.67, netUsd: 4.33 });
  });
  it('defaults to zero commission', () => {
    const e = engineOver([R0, [21000, 21003, 20999, 21001]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21000.25 });
    e.step();
    expect(e.trades[0]).toMatchObject({ feesUsd: 0, netUsd: 5 });
  });
});

describe('step 5: end_of_data', () => {
  it('closes an open position at the last bar close', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003], [21005, 21008, 21002, 21006]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    expect(e.isAtEnd()).toBe(false);
    const ev = e.step();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'trade_closed', time: T0 + 120 });
    // exit at the close 21006: (21006-21001)/0.25 = 20 ticks = $100. MFE counts the last bar high 21008: 28 ticks.
    expect(e.trades[0]).toMatchObject({ exitReason: 'end_of_data', exitPrice: 21006, exitTime: T0 + 120, pnlTicks: 20, grossUsd: 100, maeTicks: 12, mfeTicks: 28 });
    expect(e.position).toBeNull();
    expect(e.isAtEnd()).toBe(true);
  });
  it('an entry filled on the very last bar is closed on that bar', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e.step();
    expect(ev.map((x) => x.type)).toEqual(['order_filled', 'position_opened', 'trade_closed']);
    // in 21001 out 21003: 8 ticks = $40, hold 0
    expect(e.trades[0]).toMatchObject({ exitReason: 'end_of_data', pnlTicks: 8, grossUsd: 40, holdSeconds: 0, maeTicks: 12, mfeTicks: 12 });
  });
  it('a stop loss on the last bar is a stop_loss, not end_of_data', () => {
    const e = inLong([21001, 21003, 20980, 20995]);
    e.step();
    expect(e.trades[0]!.exitReason).toBe('stop_loss');
  });
  it('a working order just stays working', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003], [21005, 21008, 21002, 21006]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    expect(e.step(2)).toEqual([]);
    expect(e.isAtEnd()).toBe(true);
    expect(e.workingOrder).toMatchObject({ status: 'working', price: 20900 });
    expect(e.trades).toEqual([]);
  });
  it('stepping at the end of data does nothing', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003]]);
    e.step();
    const t = e.cursorTime;
    expect(e.step()).toEqual([]);
    expect(e.step(5, '5m')).toEqual([]);
    expect(e.stepTo(t + 10_000)).toEqual([]);
    expect(e.cursorTime).toBe(t);
  });
});

describe('step 4: MAE and MFE (ticks per contract from entry, >= 0)', () => {
  it('counts every bar the position is open, fill bar included, and not a manual exit bar', () => {
    const e = engineOver([
      R0,
      [21000, 21003, 20996, 21002], // fill at open 21000: MFE (21003-21000)/0.25 = 12, MAE (21000-20996)/0.25 = 16
      [21002, 21008, 20999, 21006], // MFE (21008-21000)/0.25 = 32, MAE low 20999 is only 4 ticks
      [21005, 21050, 20900, 21010], // manual exit at the open 21005, the wild range after it is not the trade's
    ]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step(2);
    expect(e.position).toMatchObject({ maeTicks: 16, mfeTicks: 32 });
    e.closePosition();
    e.step();
    // exit price 21005 is 20 ticks of profit, below the 32 already seen
    expect(e.trades[0]).toMatchObject({ exitReason: 'manual', exitPrice: 21005, maeTicks: 16, mfeTicks: 32 });
  });
  it('fill bar counts its whole range even for an intrabar limit fill', () => {
    const e = engineOver([R0, [21000, 21010, 20990, 21008]]);
    e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20995 }); // fills at 20995
    e.step();
    // MAE (20995-20990)/0.25 = 20 ticks, MFE (21010-20995)/0.25 = 60 ticks
    expect(e.position).toMatchObject({ entryPrice: 20995, maeTicks: 20, mfeTicks: 60 });
  });
  it('short: adverse is up, favorable is down', () => {
    const e = engineOver([R0, [21000, 21004, 20994, 21002]]);
    e.placeOrder({ side: 'short', type: 'market', qty: 1 });
    e.step();
    // entry 21000: MAE (21004-21000)/0.25 = 16, MFE (21000-20994)/0.25 = 24
    expect(e.position).toMatchObject({ maeTicks: 16, mfeTicks: 24 });
  });
  it('never negative: a bar that stays on the profit side adds nothing to MAE', () => {
    const e = engineOver([R0, [21000, 21004, 21000, 21003], [21005, 21010, 21004, 21008]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step(2);
    // MAE: low 21000 == entry gives 0; bar 2 low 21004 is above entry so it must not go negative
    expect(e.position).toMatchObject({ maeTicks: 0, mfeTicks: 40 }); // (21010-21000)/0.25
  });
  it('an intrabar exit bar counts its whole range', () => {
    const e = engineOver([R0, [21000, 21002, 20999, 21001], [21000, 21004, 20985, 20990]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    e.step(2);
    // exit 20990; bar 2 low 20985 => MAE (21000-20985)/0.25 = 60; MFE max(8, (21004-21000)/0.25 = 16) = 16
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 20990, maeTicks: 60, mfeTicks: 16 });
  });
  it('MAE always covers a realized loss and MFE a realized gain (slipped exit included)', () => {
    const e = inLong([20980, 20985, 20970, 20975], SLIP2);
    e.step();
    const t = e.trades[0]!;
    expect(t.maeTicks).toBeGreaterThanOrEqual(-t.pnlTicks);
  });
});

describe('R multiple and risk', () => {
  it('2 contracts: risk $400, gross $800, R = 2', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21022, 21000, 21015]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 2, stopLoss: 20990, takeProfit: 21020 });
    e.step(2);
    // risk 40 ticks * $5 * 2 = $400. gross 80 ticks * $5 * 2 = $800.
    expect(e.trades[0]).toMatchObject({ qty: 2, riskUsd: 400, grossUsd: 800, rMultiple: 2 });
  });
  it('R ignores fees (price based)', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21022, 21000, 21015]], { commissionPerSide: 5 });
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990, takeProfit: 21020 });
    e.step(2);
    expect(e.trades[0]).toMatchObject({ grossUsd: 400, feesUsd: 10, netUsd: 390, rMultiple: 2 });
  });
  it('no SL at entry: riskUsd and rMultiple are null', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21022, 21000, 21015]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, takeProfit: 21020 });
    e.step(2);
    expect(e.trades[0]).toMatchObject({ riskUsd: null, rMultiple: null });
  });
  it('an SL added later does not create risk (still null) and does not set initialStopLoss', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21003, 20980, 20995]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step();
    e.modifyBracket({ stopLoss: 20990 });
    expect(e.position?.initialStopLoss).toBeUndefined();
    e.step();
    expect(e.trades[0]).toMatchObject({ exitReason: 'stop_loss', riskUsd: null, rMultiple: null });
  });
  it('risk uses the initial SL even after the SL moves', () => {
    const e = engineOver([R0, ENTRY_BAR, [21001, 21003, 20990, 20996]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    e.step();
    e.modifyBracket({ stopLoss: 20995 });
    expect(e.position).toMatchObject({ stopLoss: 20995, initialStopLoss: 20990 });
    e.step();
    // stopped at 20995: -20 ticks = -$100; risk stays 40 ticks = $200, R = -0.5
    expect(e.trades[0]).toMatchObject({ exitPrice: 20995, pnlTicks: -20, grossUsd: -100, riskUsd: 200, rMultiple: -0.5 });
  });
  it('zero distance risk gives a null R', () => {
    // market long, SL 20990, bar opens exactly at 20990: in and out at the open, entry == SL so risk is 0
    const e = engineOver([R0, [20990, 20995, 20985, 20992]]);
    e.placeOrder({ side: 'long', type: 'market', qty: 1, stopLoss: 20990 });
    e.step();
    expect(e.trades[0]).toMatchObject({ riskUsd: 0, rMultiple: null });
  });
});

describe('contract math: pnl = ticks * tickValue * qty, hand checked per contract', () => {
  // [symbol, entry, exit, qty, expected ticks per contract, expected gross USD]
  const cases: [string, number, number, number, number, number][] = [
    ['NQ', 21000, 21002.5, 2, 10, 100], // 10 ticks * $5 * 2
    ['MNQ', 21000, 21003.75, 3, 15, 22.5], // 15 * $0.50 * 3
    ['ES', 6000, 6010.5, 2, 42, 1050], // 42 * $12.50 * 2
    ['MES', 6000, 5995.25, 4, -19, -95], // -19 * $1.25 * 4
    ['YM', 44000, 44012, 1, 12, 60], // tick 1.00: 12 * $5
    ['MYM', 44000, 43990, 5, -10, -25], // -10 * $0.50 * 5
    ['RTY', 2300, 2301.7, 1, 17, 85], // tick 0.10: 17 * $5
    ['M2K', 2300, 2301.7, 10, 17, 85], // 17 * $0.50 * 10
    ['CL', 70, 70.35, 1, 35, 350], // tick 0.01: 35 * $10
    ['MCL', 70, 70.35, 2, 35, 70], // 35 * $1 * 2
    ['GC', 2700, 2702.5, 1, 25, 250], // tick 0.10: 25 * $10
    ['MGC', 2700, 2702.5, 3, 25, 75], // 25 * $1 * 3
  ];
  it.each(cases)('%s long %d to %d x%d', (symbol, entry, exit, qty, ticks, usd) => {
    const contract: ContractSpec = CONTRACTS[symbol]!;
    // bar 1 opens at the entry (market fill at the open); winners end at their TP, losers at their SL
    const win = exit > entry;
    const row1: Ohlc = win ? [entry, exit, entry, exit] : [entry, entry, exit, exit];
    const e = engineOver([[entry, entry, entry, entry], row1], {}, contract);
    e.placeOrder({ side: 'long', type: 'market', qty, ...(win ? { takeProfit: exit } : { stopLoss: exit }) });
    e.step();
    expect(e.trades[0]).toMatchObject({ symbol, entryPrice: entry, exitPrice: exit, pnlTicks: ticks, grossUsd: usd, netUsd: usd });
  });
  it('short: ES sells 6000, covers 5990.25 for 39 ticks * $12.50 * 2 = $975', () => {
    const e = engineOver([[6000, 6000, 6000, 6000], [6000, 6000, 5990.25, 5990.25]], {}, CONTRACTS['ES']!);
    e.placeOrder({ side: 'short', type: 'market', qty: 2, takeProfit: 5990.25 });
    e.step();
    expect(e.trades[0]).toMatchObject({ side: 'short', pnlTicks: 39, grossUsd: 975 });
  });
});

describe('events and returned objects', () => {
  it('carry copies: mutating a returned order or position cannot change the engine', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003]]);
    const placed = e.placeOrder({ side: 'long', type: 'limit', qty: 1, price: 20900 });
    placed.price = 1;
    expect(e.workingOrder?.price).toBe(20900);
    const w = e.workingOrder!;
    w.qty = 99;
    expect(e.workingOrder?.qty).toBe(1);

    const e2 = engineOver([R0, [21001, 21004, 20998, 21003], [21003, 21004, 21002, 21003]]);
    e2.placeOrder({ side: 'long', type: 'market', qty: 1 });
    const ev = e2.step();
    const opened = ev.find((x) => x.type === 'position_opened');
    if (opened?.type !== 'position_opened') throw new Error('no position_opened');
    opened.position.stopLoss = 1;
    expect(e2.position?.stopLoss).toBeUndefined();
    const p = e2.position!;
    p.qty = 50;
    expect(e2.position?.qty).toBe(1);
  });
  it('the order_filled event carries the filled order', () => {
    const e = engineOver([R0, [21001, 21004, 20998, 21003], [21003, 21004, 21002, 21003]]);
    e.placeOrder({ side: 'short', type: 'market', qty: 2, stopLoss: 21010 });
    const [filled] = e.step();
    expect(filled).toMatchObject({
      type: 'order_filled',
      order: { side: 'short', type: 'market', qty: 2, stopLoss: 21010, status: 'filled', fillPrice: 21001, filledAt: T0 + 60 },
    });
    expect(e.workingOrder).toBeNull();
  });
});
