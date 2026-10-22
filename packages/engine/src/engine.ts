import { CandleSeries } from './aggregate';
import { priceToTicks, roundToTick } from './contracts';
import { EngineError } from './errors';
import { entryFill, exitFill, manualCloseFill } from './fills';
import { buildTrade, round2 } from './math';
import { bucketStart, isTimeframe } from './time';
import type {
  Bar,
  ContractSpec,
  EngineEvent,
  ExitReason,
  JournalEntry,
  Order,
  OrderRequest,
  Position,
  SessionSettings,
  SessionSnapshot,
  Timeframe,
  Trade,
  UnixSeconds,
} from './types';
import { checkPrice, normalizeJournal, normalizeRequest, resolveSettings } from './validate';

const cloneOrder = (o: Order): Order => ({ ...o });
const clonePosition = (p: Position): Position => ({ ...p });
const restoreTrade = (t: Trade): Trade => Object.freeze({ ...t, journal: normalizeJournal(t.journal ?? {}) });

interface CandleCache {
  series: CandleSeries;
  /** Index of the next 1m bar not yet fed to the series. */
  next: number;
}

export class ReplayEngine {
  readonly contract: ContractSpec;
  readonly settings: SessionSettings;

  private readonly bars: Bar[];
  private readonly startTime: UnixSeconds;
  private cursor: number;
  private working: Order | null = null;
  private pos: Position | null = null;
  private tradeList: Trade[] = [];
  private nextId = 1;
  private readonly caches = new Map<Timeframe, CandleCache>();

  constructor(opts: { bars: Bar[]; contract: ContractSpec; startTime: UnixSeconds; settings?: Partial<SessionSettings> }) {
    const { bars, contract, startTime } = opts;
    if (!contract || !(contract.tickSize > 0) || !(contract.tickValue > 0)) throw new EngineError('contract needs tickSize > 0 and tickValue > 0');
    if (!Array.isArray(bars) || bars.length === 0) throw new EngineError('bars must be a non empty array');
    if (!Number.isFinite(startTime)) throw new EngineError('startTime must be a number');
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i]!.time;
      if (!Number.isFinite(t) || (i > 0 && !(t > bars[i - 1]!.time))) throw new EngineError(`bars must be sorted with strictly increasing times (problem at index ${i})`);
    }
    this.contract = contract;
    this.settings = Object.freeze(resolveSettings(opts.settings));
    this.bars = bars.slice();
    this.startTime = startTime;

    // last bar with time <= startTime (binary search)
    let lo = 0;
    let hi = this.bars.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid]!.time <= startTime) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) throw new EngineError('no bar at or before startTime');
    this.cursor = found;
  }

  // ---- read side ----

  get cursorTime(): UnixSeconds {
    return this.bars[this.cursor]!.time;
  }

  get lastPrice(): number {
    return this.bars[this.cursor]!.close;
  }

  get workingOrder(): Order | null {
    return this.working ? cloneOrder(this.working) : null;
  }

  get position(): Position | null {
    return this.pos ? clonePosition(this.pos) : null;
  }

  get trades(): Trade[] {
    return this.tradeList.slice();
  }

  isAtEnd(): boolean {
    return this.cursor >= this.bars.length - 1;
  }

  /** Revealed data only. Completed candles are cached per timeframe and extended incrementally. */
  getVisibleBars(tf: Timeframe): Bar[] {
    if (!isTimeframe(tf)) throw new EngineError(`Unknown timeframe: ${String(tf)}`);
    if (tf === '1m') return this.bars.slice(0, this.cursor + 1);
    let cache = this.caches.get(tf);
    if (!cache) {
      cache = { series: new CandleSeries(tf), next: 0 };
      this.caches.set(tf, cache);
    }
    while (cache.next <= this.cursor) cache.series.push(this.bars[cache.next++]!);
    return cache.series.candles();
  }

  unrealized(): { ticks: number; usd: number } | null {
    const p = this.pos;
    if (!p) return null;
    const tick = this.contract.tickSize;
    const ticks = (priceToTicks(this.lastPrice, tick) - priceToTicks(p.entryPrice, tick)) * (p.side === 'long' ? 1 : -1) + 0;
    return { ticks, usd: round2(ticks * this.contract.tickValue * p.qty) };
  }

  // ---- clock ----

  /** SPEC §5 Stepping: `count` base bars for 1m, otherwise until `count` candles of `tf` have completed. */
  step(count = 1, tf: Timeframe = '1m'): EngineEvent[] {
    if (!Number.isInteger(count) || count < 1) throw new EngineError('step count must be an integer >= 1');
    if (!isTimeframe(tf)) throw new EngineError(`Unknown timeframe: ${String(tf)}`);
    const events: EngineEvent[] = [];
    const last = this.bars.length - 1;
    if (this.cursor >= last) return events;

    if (tf === '1m') {
      const end = Math.min(this.cursor + count, last);
      while (this.cursor < end) this.reveal(events);
      return events;
    }

    let completed = 0;
    let bucket = bucketStart(this.bars[this.cursor + 1]!.time, tf);
    while (completed < count && this.cursor < last) {
      this.reveal(events);
      // the candle holding the bar just revealed is complete when the next base bar opens a new bucket or the data ends
      const nextBucket = this.cursor < last ? bucketStart(this.bars[this.cursor + 1]!.time, tf) : null;
      if (nextBucket === null || nextBucket !== bucket) completed++;
      if (nextBucket !== null) bucket = nextBucket;
    }
    return events;
  }

  /** Reveal every bar with time <= `time`. */
  stepTo(time: UnixSeconds): EngineEvent[] {
    if (!Number.isFinite(time)) throw new EngineError('stepTo needs a finite time');
    const events: EngineEvent[] = [];
    const last = this.bars.length - 1;
    while (this.cursor < last && this.bars[this.cursor + 1]!.time <= time) this.reveal(events);
    return events;
  }

  // ---- orders ----

  placeOrder(req: OrderRequest): Order {
    if (this.pos) throw new EngineError('already in a position');
    if (this.working) throw new EngineError('an entry order is already working');
    const clean = normalizeRequest(req, this.contract, this.lastPrice);
    const order: Order = { id: `o${this.nextId++}`, status: 'working', placedAt: this.cursorTime, ...clean };
    this.working = order;
    return cloneOrder(order);
  }

  cancelOrder(id: string): void {
    if (!this.working || this.working.id !== id) throw new EngineError(`no working order with id ${String(id)}`);
    this.working = null;
  }

  /** Working entry order only (chart drag). Same rules as placeOrder, checked against the order after the change. */
  modifyOrder(id: string, changes: { price?: number; stopLoss?: number | null; takeProfit?: number | null }): Order {
    const o = this.working;
    if (!o || o.id !== id) throw new EngineError(`no working order with id ${String(id)}`);
    const next: OrderRequest = { side: o.side, type: o.type, qty: o.qty };
    if (o.price !== undefined) next.price = o.price;
    if (o.stopLoss !== undefined) next.stopLoss = o.stopLoss;
    if (o.takeProfit !== undefined) next.takeProfit = o.takeProfit;

    if (changes.price !== undefined) {
      if (o.type === 'market') throw new EngineError('a market order has no price to change');
      next.price = changes.price;
    }
    if (changes.stopLoss !== undefined) {
      if (changes.stopLoss === null) delete next.stopLoss;
      else next.stopLoss = changes.stopLoss;
    }
    if (changes.takeProfit !== undefined) {
      if (changes.takeProfit === null) delete next.takeProfit;
      else next.takeProfit = changes.takeProfit;
    }
    const clean = normalizeRequest(next, this.contract, this.lastPrice);
    this.working = { id: o.id, status: o.status, placedAt: o.placedAt, ...clean };
    return cloneOrder(this.working);
  }

  /** Move or remove SL/TP on the open position. null removes, undefined leaves alone. Atomic. */
  modifyBracket(levels: { stopLoss?: number | null; takeProfit?: number | null }): void {
    const p = this.pos;
    if (!p) throw new EngineError('no open position');
    const tick = this.contract.tickSize;
    const last = priceToTicks(this.lastPrice, tick);
    const long = p.side === 'long';
    let stopLoss = p.stopLoss;
    let takeProfit = p.takeProfit;

    if (levels.stopLoss !== undefined) {
      if (levels.stopLoss === null) stopLoss = undefined;
      else {
        stopLoss = checkPrice('stopLoss', levels.stopLoss, tick);
        const sl = priceToTicks(stopLoss, tick);
        if (long ? !(sl < last) : !(sl > last)) throw new EngineError(`stopLoss must be ${long ? 'below' : 'above'} the last price for a ${p.side}`);
      }
    }
    if (levels.takeProfit !== undefined) {
      if (levels.takeProfit === null) takeProfit = undefined;
      else {
        takeProfit = checkPrice('takeProfit', levels.takeProfit, tick);
        const tp = priceToTicks(takeProfit, tick);
        if (long ? !(tp > last) : !(tp < last)) throw new EngineError(`takeProfit must be ${long ? 'above' : 'below'} the last price for a ${p.side}`);
      }
    }
    if (stopLoss === undefined) delete p.stopLoss;
    else p.stopLoss = stopLoss;
    if (takeProfit === undefined) delete p.takeProfit;
    else p.takeProfit = takeProfit;
  }

  /** Exit at the next bar open (SPEC §5 step 1). */
  closePosition(): void {
    if (!this.pos) throw new EngineError('no open position to close');
    this.pos.pendingClose = true;
  }

  setJournal(tradeId: string, entry: JournalEntry): void {
    const i = this.tradeList.findIndex((t) => t.id === tradeId);
    if (i < 0) throw new EngineError(`no trade with id ${String(tradeId)}`);
    this.tradeList[i] = Object.freeze({ ...this.tradeList[i]!, journal: normalizeJournal(entry) });
  }

  // ---- persistence ----

  toJSON(): SessionSnapshot {
    return {
      version: 1,
      symbol: this.contract.symbol,
      startTime: this.startTime,
      cursorIndex: this.cursor,
      settings: { ...this.settings },
      workingOrder: this.working ? cloneOrder(this.working) : null,
      position: this.pos ? clonePosition(this.pos) : null,
      trades: this.tradeList.slice(),
      nextId: this.nextId,
    };
  }

  static fromJSON(s: SessionSnapshot, bars: Bar[], contract: ContractSpec): ReplayEngine {
    if (s === null || typeof s !== 'object') throw new EngineError('snapshot must be an object');
    if (s.version !== 1) throw new EngineError(`unsupported snapshot version ${String(s.version)}`);
    if (s.symbol !== contract.symbol) throw new EngineError(`snapshot is for ${String(s.symbol)}, not ${contract.symbol}`);
    if (!Number.isInteger(s.cursorIndex) || s.cursorIndex < 0 || s.cursorIndex >= bars.length) throw new EngineError('snapshot cursorIndex is outside the bars');
    if (!Number.isInteger(s.nextId) || s.nextId < 1) throw new EngineError('snapshot nextId is invalid');
    if (!s.settings || typeof s.settings !== 'object') throw new EngineError('snapshot settings are missing');
    if (!Array.isArray(s.trades)) throw new EngineError('snapshot trades must be an array');
    const e = new ReplayEngine({ bars, contract, startTime: s.startTime, settings: s.settings });
    e.cursor = s.cursorIndex;
    e.working = s.workingOrder ? cloneOrder(s.workingOrder) : null;
    e.pos = s.position ? clonePosition(s.position) : null;
    e.tradeList = s.trades.map(restoreTrade);
    e.nextId = s.nextId;
    return e;
  }

  // ---- the bar loop (SPEC §5) ----

  private reveal(events: EngineEvent[]): void {
    this.cursor++;
    this.processBar(this.bars[this.cursor]!, this.cursor === this.bars.length - 1, events);
  }

  private processBar(bar: Bar, isLast: boolean, events: EngineEvent[]): void {
    const slipTicks = this.settings.slippageTicks;

    // 1. pending manual close at the open
    if (this.pos && this.pos.pendingClose) {
      this.closeTrade(bar, manualCloseFill(this.pos, bar, this.contract, slipTicks), 'manual', false, events);
    }

    // 2. exits on the open position
    if (this.pos) {
      const x = exitFill(this.pos, bar, this.contract, slipTicks, true);
      if (x) this.closeTrade(bar, x.price, x.reason, !x.atOpen, events);
    }

    // 3. the working entry order (only possible while flat)
    if (!this.pos && this.working) {
      const order = this.working;
      const f = entryFill(order, bar, this.contract, slipTicks);
      if (f) {
        this.working = null;
        events.push({ type: 'order_filled', time: bar.time, order: { ...order, status: 'filled', filledAt: bar.time, fillPrice: f.price } });
        const p: Position = { side: order.side, qty: order.qty, entryPrice: f.price, entryTime: bar.time, maeTicks: 0, mfeTicks: 0, pendingClose: false };
        if (order.stopLoss !== undefined) {
          p.stopLoss = order.stopLoss;
          p.initialStopLoss = order.stopLoss;
        }
        if (order.takeProfit !== undefined) p.takeProfit = order.takeProfit;
        this.pos = p;
        events.push({ type: 'position_opened', time: bar.time, position: clonePosition(p) });
        // filled at the open: rules 2a to 2c in full. Filled intrabar: only the SL can trigger on this bar.
        const x = exitFill(p, bar, this.contract, slipTicks, f.atOpen);
        if (x) this.closeTrade(bar, x.price, x.reason, !x.atOpen, events);
      }
    }

    // 4. MAE / MFE from this bar's range while the position is open
    if (this.pos) this.touch(this.pos, bar.high, bar.low);

    // 5. end of data
    if (isLast && this.pos) this.closeTrade(bar, roundToTick(bar.close, this.contract.tickSize), 'end_of_data', false, events);
  }

  /** Excursions in whole ticks per contract, measured from the entry price, never below 0. */
  private touch(p: Position, high: number, low: number): void {
    const tick = this.contract.tickSize;
    const entry = priceToTicks(p.entryPrice, tick);
    const hi = priceToTicks(high, tick);
    const lo = priceToTicks(low, tick);
    const mfe = p.side === 'long' ? hi - entry : entry - lo;
    const mae = p.side === 'long' ? entry - lo : hi - entry;
    if (mfe > p.mfeTicks) p.mfeTicks = mfe;
    if (mae > p.maeTicks) p.maeTicks = mae;
  }

  /**
   * Close the open position. `touchBar`: the exit happened inside the bar, so the whole bar's range counts toward
   * MAE/MFE (an exit at the open does not). The exit price itself always counts.
   */
  private closeTrade(bar: Bar, exitPrice: number, reason: ExitReason, touchBar: boolean, events: EngineEvent[]): void {
    const p = this.pos!;
    if (touchBar) this.touch(p, bar.high, bar.low);
    this.touch(p, exitPrice, exitPrice);
    const trade = buildTrade({
      id: `t${this.nextId++}`,
      contract: this.contract,
      side: p.side,
      qty: p.qty,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      exitTime: bar.time,
      exitPrice,
      exitReason: reason,
      initialStopLoss: p.initialStopLoss,
      maeTicks: p.maeTicks,
      mfeTicks: p.mfeTicks,
      commissionPerSide: this.settings.commissionPerSide,
    });
    this.tradeList.push(trade);
    this.pos = null;
    events.push({ type: 'trade_closed', time: bar.time, trade });
  }
}
