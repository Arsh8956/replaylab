// QA: differential fuzz. An independent reference model written straight from SPEC section 5, in
// whole integer ticks and integer cents, runs next to the real engine over random bar paths and
// random valid action scripts on all 12 contracts. Any divergence in a fill, an exit, MAE/MFE,
// a USD figure, an event, or the open position fails the test with the seed and step.
import { describe, expect, it } from 'vitest';
import { CONTRACTS, ReplayEngine } from '../src/index';
import type { EngineEvent, Trade } from '../src/index';
import {
  CONTRACT_SYMBOLS,
  applyToEngine,
  chooseAction,
  lcg,
  px,
  randomAdvance,
  randomSettings,
  randomTickBars,
  stateOf,
  tk,
  toBars,
  type Action,
  type RB,
  type TickState,
} from './qa-support';

interface RWork {
  side: 'long' | 'short';
  type: 'market' | 'limit' | 'stop';
  qty: number;
  price?: number;
  sl?: number;
  tp?: number;
}
interface RPos {
  side: 'long' | 'short';
  qty: number;
  entry: number;
  entryTime: number;
  sl?: number;
  tp?: number;
  initSl?: number;
  mae: number;
  mfe: number;
  pending: boolean;
}
interface RTrade {
  side: 'long' | 'short';
  qty: number;
  entryTime: number;
  entry: number;
  exitTime: number;
  exit: number;
  reason: string;
  pnlTicks: number;
  grossC: number;
  feesC: number;
  netC: number;
  riskC: number | null;
  mae: number;
  mfe: number;
}

/** Reference model. Prices in ticks, money in cents, no float anywhere near a fill. */
class Ref {
  cursor: number;
  work: RWork | null = null;
  pos: RPos | null = null;
  trades: RTrade[] = [];
  events: string[] = [];

  constructor(
    readonly bars: RB[],
    start: number,
    readonly tvC: number,
    readonly slip: number,
    readonly commC: number,
  ) {
    this.cursor = start;
  }

  get state(): TickState {
    return {
      last: this.bars[this.cursor]!.c,
      pos: this.pos ? { side: this.pos.side, pending: this.pos.pending } : null,
      work: this.work ? { ...this.work } : null,
    };
  }

  act(a: Action): void {
    switch (a.k) {
      case 'none':
        return;
      case 'place':
        this.work = { ...a.req };
        return;
      case 'cancel':
        this.work = null;
        return;
      case 'modOrder': {
        const w = this.work!;
        if (a.changes.price !== undefined) w.price = a.changes.price;
        if (a.changes.sl !== undefined) {
          if (a.changes.sl === null) delete w.sl;
          else w.sl = a.changes.sl;
        }
        if (a.changes.tp !== undefined) {
          if (a.changes.tp === null) delete w.tp;
          else w.tp = a.changes.tp;
        }
        return;
      }
      case 'modBracket': {
        const p = this.pos!;
        if (a.levels.sl !== undefined) {
          if (a.levels.sl === null) delete p.sl;
          else p.sl = a.levels.sl;
        }
        if (a.levels.tp !== undefined) {
          if (a.levels.tp === null) delete p.tp;
          else p.tp = a.levels.tp;
        }
        return;
      }
      case 'close':
        this.pos!.pending = true;
        return;
    }
  }

  reveal(): void {
    this.cursor++;
    this.process(this.bars[this.cursor]!, this.cursor === this.bars.length - 1);
  }

  private touch(hi: number, lo: number): void {
    const p = this.pos!;
    const long = p.side === 'long';
    p.mfe = Math.max(p.mfe, long ? hi - p.entry : p.entry - lo);
    p.mae = Math.max(p.mae, long ? p.entry - lo : hi - p.entry);
  }

  private close(b: RB, exit: number, reason: string, intrabar: boolean): void {
    const p = this.pos!;
    if (intrabar) this.touch(b.h, b.l);
    this.touch(exit, exit);
    const dir = p.side === 'long' ? 1 : -1;
    const pnlTicks = (exit - p.entry) * dir + 0;
    const grossC = pnlTicks * this.tvC * p.qty + 0;
    const feesC = this.commC * p.qty * 2;
    this.trades.push({
      side: p.side,
      qty: p.qty,
      entryTime: p.entryTime,
      entry: p.entry,
      exitTime: b.t,
      exit,
      reason,
      pnlTicks,
      grossC,
      feesC,
      netC: grossC - feesC + 0,
      riskC: p.initSl === undefined ? null : Math.abs(p.entry - p.initSl) * this.tvC * p.qty,
      mae: p.mae,
      mfe: p.mfe,
    });
    this.events.push(`T@${b.t}@${exit}@${reason}`);
    this.pos = null;
  }

  private exits(b: RB, full: boolean): void {
    const p = this.pos!;
    const long = p.side === 'long';
    const away = long ? -this.slip : this.slip; // slippage against the trader on a sell (long) or buy (short) exit
    if (full) {
      if (p.sl !== undefined && (long ? b.o <= p.sl : b.o >= p.sl)) return this.close(b, b.o + away, 'stop_loss', false);
      if (p.tp !== undefined && (long ? b.o >= p.tp : b.o <= p.tp)) return this.close(b, b.o, 'take_profit', false);
    }
    if (p.sl !== undefined && (long ? b.l <= p.sl : b.h >= p.sl)) return this.close(b, p.sl + away, 'stop_loss', true);
    if (full && p.tp !== undefined && (long ? b.h >= p.tp : b.l <= p.tp)) return this.close(b, p.tp, 'take_profit', true);
  }

  private process(b: RB, isLast: boolean): void {
    // 1. pending manual close at the open
    if (this.pos && this.pos.pending) {
      this.close(b, b.o + (this.pos.side === 'long' ? -this.slip : this.slip), 'manual', false);
    }
    // 2. exits
    if (this.pos) this.exits(b, true);
    // 3. working order
    if (!this.pos && this.work) {
      const w = this.work;
      const buy = w.side === 'long';
      let fill: number | null = null;
      let atOpen = false;
      if (w.type === 'market') {
        fill = b.o + (buy ? this.slip : -this.slip);
        atOpen = true;
      } else if (w.type === 'limit') {
        const L = w.price!;
        if (buy) {
          if (b.o <= L) {
            fill = b.o;
            atOpen = true;
          } else if (b.l <= L) fill = L;
        } else if (b.o >= L) {
          fill = b.o;
          atOpen = true;
        } else if (b.h >= L) fill = L;
      } else {
        const S = w.price!;
        if (buy) {
          if (b.o >= S) {
            fill = b.o + this.slip;
            atOpen = true;
          } else if (b.h >= S) fill = S + this.slip;
        } else if (b.o <= S) {
          fill = b.o - this.slip;
          atOpen = true;
        } else if (b.l <= S) fill = S - this.slip;
      }
      if (fill !== null) {
        this.work = null;
        this.events.push(`F@${b.t}@${fill}`);
        this.pos = { side: w.side, qty: w.qty, entry: fill, entryTime: b.t, mae: 0, mfe: 0, pending: false };
        if (w.sl !== undefined) {
          this.pos.sl = w.sl;
          this.pos.initSl = w.sl;
        }
        if (w.tp !== undefined) this.pos.tp = w.tp;
        this.events.push(`P@${b.t}`);
        this.exits(b, atOpen);
      }
    }
    // 4. excursions
    if (this.pos) this.touch(b.h, b.l);
    // 5. end of data
    if (isLast && this.pos) this.close(b, b.c, 'end_of_data', false);
  }
}

function engineEventStrings(evs: EngineEvent[], tick: number): string[] {
  return evs.map((e) => {
    if (e.type === 'order_filled') return `F@${e.time}@${tk(e.order.fillPrice!, tick)}`;
    if (e.type === 'position_opened') return `P@${e.time}`;
    if (e.type === 'trade_closed') return `T@${e.time}@${tk(e.trade.exitPrice, tick)}@${e.trade.exitReason}`;
    return `X@${e.time}`;
  });
}

function onGrid(price: number, tick: number): boolean {
  return price === px(tk(price, tick), tick);
}

function compareTrade(t: Trade, r: RTrade, tick: number, ctx: string): void {
  expect(
    {
      side: t.side,
      qty: t.qty,
      entryTime: t.entryTime,
      entryPrice: tk(t.entryPrice, tick),
      exitTime: t.exitTime,
      exitPrice: tk(t.exitPrice, tick),
      exitReason: t.exitReason,
      pnlTicks: t.pnlTicks,
      grossUsd: t.grossUsd,
      feesUsd: t.feesUsd,
      netUsd: t.netUsd,
      riskUsd: t.riskUsd,
      maeTicks: t.maeTicks,
      mfeTicks: t.mfeTicks,
      holdSeconds: t.holdSeconds,
    },
    ctx,
  ).toEqual({
    side: r.side,
    qty: r.qty,
    entryTime: r.entryTime,
    entryPrice: r.entry,
    exitTime: r.exitTime,
    exitPrice: r.exit,
    exitReason: r.reason,
    pnlTicks: r.pnlTicks,
    grossUsd: r.grossC / 100 + 0,
    feesUsd: r.feesC / 100,
    netUsd: r.netC / 100 + 0,
    riskUsd: r.riskC === null ? null : r.riskC / 100,
    maeTicks: r.mae,
    mfeTicks: r.mfe,
    holdSeconds: r.exitTime - r.entryTime,
  });
  expect(Object.is(t.pnlTicks, -0), `${ctx} pnlTicks is -0`).toBe(false);
  expect(Object.is(t.netUsd, -0), `${ctx} netUsd is -0`).toBe(false);
  expect(onGrid(t.entryPrice, tick) && onGrid(t.exitPrice, tick), `${ctx} prices on the tick grid without float dust`).toBe(true);
  if (r.riskC === null || r.riskC === 0) expect(t.rMultiple, ctx).toBeNull();
  else expect(t.rMultiple!, ctx).toBeCloseTo(r.grossC / r.riskC, 10);
  // internal consistency of the Trade record itself
  expect(t.netUsd, ctx).toBe((r.grossC - r.feesC) / 100 + 0);
  expect(Object.isFrozen(t), `${ctx} trade frozen`).toBe(true);
}

function compareState(e: ReplayEngine, r: Ref, rb: RB[], tick: number, tvC: number, ctx: string): void {
  expect(e.cursorTime, ctx).toBe(rb[r.cursor]!.t);
  expect(e.lastPrice, ctx).toBe(px(rb[r.cursor]!.c, tick));
  expect(e.isAtEnd(), ctx).toBe(r.cursor === rb.length - 1);
  expect(e.getVisibleBars('1m').length, ctx).toBe(r.cursor + 1);

  const p = e.position;
  if (!r.pos) expect(p, ctx).toBeNull();
  else {
    expect(p, ctx).not.toBeNull();
    expect(
      {
        side: p!.side,
        qty: p!.qty,
        entry: tk(p!.entryPrice, tick),
        entryTime: p!.entryTime,
        sl: p!.stopLoss === undefined ? undefined : tk(p!.stopLoss, tick),
        tp: p!.takeProfit === undefined ? undefined : tk(p!.takeProfit, tick),
        initSl: p!.initialStopLoss === undefined ? undefined : tk(p!.initialStopLoss, tick),
        mae: p!.maeTicks,
        mfe: p!.mfeTicks,
        pending: p!.pendingClose,
      },
      ctx,
    ).toEqual({ ...r.pos });
  }
  const w = e.workingOrder;
  if (!r.work) expect(w, ctx).toBeNull();
  else {
    expect(w, ctx).not.toBeNull();
    expect(
      {
        side: w!.side,
        type: w!.type,
        qty: w!.qty,
        price: w!.price === undefined ? undefined : tk(w!.price, tick),
        sl: w!.stopLoss === undefined ? undefined : tk(w!.stopLoss, tick),
        tp: w!.takeProfit === undefined ? undefined : tk(w!.takeProfit, tick),
        status: w!.status,
      },
      ctx,
    ).toEqual({ ...r.work, status: 'working' });
  }
  const u = e.unrealized();
  if (!r.pos) expect(u, ctx).toBeNull();
  else {
    const ticks = (rb[r.cursor]!.c - r.pos.entry) * (r.pos.side === 'long' ? 1 : -1);
    expect(u, ctx).toEqual({ ticks: ticks + 0, usd: (ticks * tvC * r.pos.qty) / 100 + 0 });
  }
  expect(e.trades.length, ctx).toBe(r.trades.length);
}

function runCase(symbol: string, seed: number, nBars: number, vol: number): { trades: number; reasons: Record<string, number> } {
  const contract = CONTRACTS[symbol]!;
  const tick = contract.tickSize;
  const tvC = Math.round(contract.tickValue * 100);
  const rand = lcg(seed * 7919 + symbol.length * 131 + symbol.charCodeAt(0));
  const rb = randomTickBars(rand, contract, nBars, { vol });
  const bars = toBars(rb, tick);
  const settings = randomSettings(rand);
  const slip = settings.slippageTicks!;
  const commC = Math.round(settings.commissionPerSide! * 100);
  const startIdx = 3;
  const e = new ReplayEngine({ bars, contract, startTime: bars[startIdx]!.time, settings });
  const r = new Ref(rb, startIdx, tvC, slip, commC);
  const reasons: Record<string, number> = {};
  const idxOfTime = new Map(rb.map((b, i) => [b.t, i]));
  let checkedTrades = 0;

  for (let iter = 0; !e.isAtEnd() && iter < 4000; iter++) {
    const ctx = `${symbol} seed ${seed} iter ${iter}`;
    const action = chooseAction(rand, r.state);
    try {
      applyToEngine(e, action);
    } catch (err) {
      throw new Error(`${ctx}: engine rejected a spec-valid action ${JSON.stringify(action)} with state ${JSON.stringify(r.state)}: ${(err as Error).message}`);
    }
    r.act(action);
    compareState(e, r, rb, tick, tvC, `${ctx} after ${action.k}`);

    const adv = randomAdvance(rand, e);
    const target = idxOfTime.get(e.cursorTime)!;
    r.events = [];
    while (r.cursor < target) r.reveal();
    const label = `${ctx} after ${adv.label}`;
    expect(engineEventStrings(adv.events, tick), label).toEqual(r.events);
    compareState(e, r, rb, tick, tvC, label);
    const ts = e.trades;
    for (; checkedTrades < ts.length; checkedTrades++) {
      compareTrade(ts[checkedTrades]!, r.trades[checkedTrades]!, tick, `${label} trade ${checkedTrades}`);
      reasons[ts[checkedTrades]!.exitReason] = (reasons[ts[checkedTrades]!.exitReason] ?? 0) + 1;
    }
  }
  // the end of data is reached: nothing open, nothing moves
  expect(e.isAtEnd()).toBe(true);
  expect(e.position, `${symbol} seed ${seed}: position left open at the end`).toBeNull();
  expect(e.step()).toEqual([]);
  expect(e.stepTo(1e12)).toEqual([]);
  return { trades: e.trades.length, reasons };
}

describe('engine vs independent SPEC section 5 reference model (random paths, random valid actions)', () => {
  for (const symbol of CONTRACT_SYMBOLS) {
    it(`${symbol}: 8 seeds x 3000 bars, every fill, exit, MAE/MFE, USD figure and event matches`, () => {
      let trades = 0;
      const reasons: Record<string, number> = {};
      for (let seed = 1; seed <= 8; seed++) {
        const res = runCase(symbol, seed, 3000, 8);
        trades += res.trades;
        for (const [k, v] of Object.entries(res.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
      }
      // the fuzz must actually exercise the interesting exits, or it proves nothing
      expect(trades).toBeGreaterThan(60);
      expect(reasons['stop_loss'] ?? 0).toBeGreaterThan(10);
      expect(reasons['take_profit'] ?? 0).toBeGreaterThan(10);
      expect(reasons['manual'] ?? 0).toBeGreaterThan(0);
    });
  }

  it('wild bars (volatility 40 ticks, big gaps, big spikes) on NQ and CL', () => {
    for (const symbol of ['NQ', 'CL']) for (let seed = 100; seed < 106; seed++) runCase(symbol, seed, 700, 40);
  });

  it('dead quiet bars (volatility 1 tick) on ES and GC: lots of exact touches', () => {
    for (const symbol of ['ES', 'GC']) for (let seed = 200; seed < 206; seed++) runCase(symbol, seed, 700, 1);
  });
});
