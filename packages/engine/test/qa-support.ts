// QA support code (not a test file): random bar paths on the tick grid and a random but always valid
// action script. Everything is integer ticks so tests can compare against an independent model.
import { ReplayEngine } from '../src/index';
import type { Bar, ContractSpec, OrderRequest, SessionSettings } from '../src/index';
import { T0, lcg } from './helpers';

export type Rand = () => number;

export const START_TICKS: Record<string, number> = { NQ: 21000, ES: 6000, YM: 44000, RTY: 2300, CL: 70, GC: 2700 };

export function decimalsOf(tick: number): number {
  const s = String(tick);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Integer ticks to a clean price (no float dust). */
export function px(ticks: number, tick: number): number {
  return Number((ticks * tick).toFixed(decimalsOf(tick)));
}
/** Price to integer ticks, written independently of the engine. */
export function tk(price: number, tick: number): number {
  return Math.round(price / tick);
}

export interface RB {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Random walk in whole ticks with gaps, spikes, and the odd missing minute. */
export function randomTickBars(rand: Rand, contract: ContractSpec, n: number, opts: { vol?: number; start?: number } = {}): RB[] {
  const vol = opts.vol ?? 8;
  let price = opts.start ?? Math.round(START_TICKS[contract.root]! / contract.tickSize);
  let t = T0;
  const out: RB[] = [];
  for (let i = 0; i < n; i++) {
    const gap = rand() < 0.08 ? Math.round((rand() - 0.5) * 6 * vol) : 0;
    const o = Math.max(200, price + gap);
    const cl = Math.max(200, o + Math.round((rand() - 0.5) * 2 * vol));
    const spike = rand() < 0.05 ? 3 : 1;
    const h = Math.max(o, cl) + Math.floor(rand() * vol * 0.6 * spike);
    const l = Math.max(100, Math.min(o, cl) - Math.floor(rand() * vol * 0.6 * spike));
    out.push({ t, o, h, l, c: cl });
    price = cl;
    t += 60 * (rand() < 0.02 ? 1 + Math.floor(rand() * 50) : 1);
  }
  return out;
}

export function toBars(rb: RB[], tick: number): Bar[] {
  return rb.map((b, i) => ({ time: b.t, open: px(b.o, tick), high: px(b.h, tick), low: px(b.l, tick), close: px(b.c, tick), volume: 50 + ((i * 37) % 200) }));
}

// ---- actions ----

export interface TickReq {
  side: 'long' | 'short';
  type: 'market' | 'limit' | 'stop';
  qty: number;
  price?: number;
  sl?: number;
  tp?: number;
}
export type Action =
  | { k: 'none' }
  | { k: 'place'; req: TickReq }
  | { k: 'cancel' }
  | { k: 'modOrder'; changes: { price?: number; sl?: number | null; tp?: number | null } }
  | { k: 'modBracket'; levels: { sl?: number | null; tp?: number | null } }
  | { k: 'close'; twice: boolean };

export interface TickState {
  last: number;
  pos: { side: 'long' | 'short'; pending: boolean } | null;
  work: { side: 'long' | 'short'; type: 'market' | 'limit' | 'stop'; qty: number; price?: number; sl?: number; tp?: number } | null;
}

/** Read the engine's state in ticks (what a UI would see). */
export function stateOf(e: ReplayEngine): TickState {
  const tick = e.contract.tickSize;
  const p = e.position;
  const w = e.workingOrder;
  const work: TickState['work'] = w
    ? {
        side: w.side,
        type: w.type,
        qty: w.qty,
        ...(w.price !== undefined ? { price: tk(w.price, tick) } : {}),
        ...(w.stopLoss !== undefined ? { sl: tk(w.stopLoss, tick) } : {}),
        ...(w.takeProfit !== undefined ? { tp: tk(w.takeProfit, tick) } : {}),
      }
    : null;
  return { last: tk(e.lastPrice, tick), pos: p ? { side: p.side, pending: p.pendingClose } : null, work };
}

const int = (rand: Rand, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

function levels(rand: Rand, side: 'long' | 'short', ref: number, pSl: number, pTp: number): { sl?: number; tp?: number } {
  const out: { sl?: number; tp?: number } = {};
  const near = (hi: number): number => (rand() < 0.35 ? int(rand, 1, 3) : int(rand, 1, hi)); // often very tight
  if (rand() < pSl) out.sl = side === 'long' ? ref - near(30) : ref + near(30);
  if (rand() < pTp) out.tp = side === 'long' ? ref + near(45) : ref - near(45);
  return out;
}

/** A valid action for the state (valid per SPEC section 5), or none. Prices in ticks. */
export function chooseAction(rand: Rand, st: TickState): Action {
  const r = rand();
  if (!st.pos && !st.work) {
    if (r > 0.4) return { k: 'none' };
    const side = rand() < 0.5 ? 'long' : 'short';
    const tr = rand();
    const type = tr < 0.35 ? 'market' : tr < 0.7 ? 'limit' : 'stop';
    const qty = int(rand, 1, 5);
    let price: number | undefined;
    if (type !== 'market') {
      const buy = side === 'long';
      // limit buy / stop sell sit below the market, limit sell / stop buy above; some are marketable on purpose
      const below = (type === 'limit') === buy;
      price = below ? st.last - int(rand, -4, 25) : st.last + int(rand, -4, 25);
      if (rand() < 0.2) price = st.last; // exactly at the market: the next open usually equals it, an exact touch
      if (price < 100) price = 100;
    }
    const ref = price ?? st.last;
    const lv = levels(rand, side, ref, 0.6, 0.6);
    return { k: 'place', req: { side, type, qty, ...(price !== undefined ? { price } : {}), ...lv } };
  }
  if (st.work) {
    if (r < 0.12) return { k: 'cancel' };
    if (r < 0.4) {
      const w = st.work;
      if (w.type === 'market') {
        const lv = levels(rand, w.side, st.last, 0.7, 0.7);
        return { k: 'modOrder', changes: { sl: lv.sl ?? null, tp: lv.tp ?? null } };
      }
      const price = Math.max(100, w.price! + int(rand, -6, 6));
      if (rand() < 0.4) {
        // price only: legal only when the existing levels still sit on the right sides
        const slOk = w.sl === undefined || (w.side === 'long' ? w.sl < price : w.sl > price);
        const tpOk = w.tp === undefined || (w.side === 'long' ? w.tp > price : w.tp < price);
        if (slOk && tpOk) return { k: 'modOrder', changes: { price } };
      }
      const lv = levels(rand, w.side, price, 0.7, 0.7);
      return { k: 'modOrder', changes: { price, sl: lv.sl ?? null, tp: lv.tp ?? null } };
    }
    return { k: 'none' };
  }
  const pos = st.pos!;
  if (r < 0.07) return { k: 'close', twice: rand() < 0.4 };
  if (r < 0.35) {
    const long = pos.side === 'long';
    const out: { sl?: number | null; tp?: number | null } = {};
    const a = rand();
    if (a < 0.55) out.sl = long ? st.last - int(rand, 1, 30) : st.last + int(rand, 1, 30);
    else if (a < 0.7) out.sl = null;
    const b = rand();
    if (b < 0.55) out.tp = long ? st.last + int(rand, 1, 45) : st.last - int(rand, 1, 45);
    else if (b < 0.7) out.tp = null;
    return { k: 'modBracket', levels: out };
  }
  return { k: 'none' };
}

/** Apply an action to a real engine (prices converted from ticks). */
export function applyToEngine(e: ReplayEngine, a: Action): void {
  const tick = e.contract.tickSize;
  const P = (t: number): number => px(t, tick);
  switch (a.k) {
    case 'none':
      return;
    case 'place': {
      const q = a.req;
      const req: OrderRequest = { side: q.side, type: q.type, qty: q.qty };
      if (q.price !== undefined) req.price = P(q.price);
      if (q.sl !== undefined) req.stopLoss = P(q.sl);
      if (q.tp !== undefined) req.takeProfit = P(q.tp);
      e.placeOrder(req);
      return;
    }
    case 'cancel':
      e.cancelOrder(e.workingOrder!.id);
      return;
    case 'modOrder': {
      const c = a.changes;
      const ch: { price?: number; stopLoss?: number | null; takeProfit?: number | null } = {};
      if (c.price !== undefined) ch.price = P(c.price);
      if (c.sl !== undefined) ch.stopLoss = c.sl === null ? null : P(c.sl);
      if (c.tp !== undefined) ch.takeProfit = c.tp === null ? null : P(c.tp);
      e.modifyOrder(e.workingOrder!.id, ch);
      return;
    }
    case 'modBracket': {
      const l = a.levels;
      const lv: { stopLoss?: number | null; takeProfit?: number | null } = {};
      if (l.sl !== undefined) lv.stopLoss = l.sl === null ? null : P(l.sl);
      if (l.tp !== undefined) lv.takeProfit = l.tp === null ? null : P(l.tp);
      e.modifyBracket(lv);
      return;
    }
    case 'close':
      e.closePosition();
      if (a.twice) e.closePosition();
      return;
  }
}

/** One stepping move chosen at random: 1m steps, higher timeframe steps, or stepTo. Returns a label for messages. */
export function randomAdvance(rand: Rand, e: ReplayEngine): { label: string; events: ReturnType<ReplayEngine['step']> } {
  const r = rand();
  if (r < 0.65) {
    const n = int(rand, 1, 3);
    return { label: `step(${n})`, events: e.step(n) };
  }
  if (r < 0.8) {
    const tfs = ['3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;
    const tf = tfs[int(rand, 0, tfs.length - 1)]!;
    const n = int(rand, 1, 2);
    return { label: `step(${n},${tf})`, events: e.step(n, tf) };
  }
  if (r < 0.9) {
    const dt = int(rand, 0, 300);
    return { label: `stepTo(+${dt})`, events: e.stepTo(e.cursorTime + dt) };
  }
  const n = int(rand, 4, 25);
  return { label: `step(${n})`, events: e.step(n) };
}

export const CONTRACT_SYMBOLS = ['NQ', 'MNQ', 'ES', 'MES', 'YM', 'MYM', 'RTY', 'M2K', 'CL', 'MCL', 'GC', 'MGC'] as const;

export function randomSettings(rand: Rand): Partial<SessionSettings> {
  return { slippageTicks: int(rand, 0, 3), commissionPerSide: [0, 0.62, 2.05, 1.25][int(rand, 0, 3)]! };
}

export { lcg };

// ---- an independent America/New_York model (US DST rules since 2007), no Intl ----

const DAY = 86400;

/** UTC offset of New York in seconds at UTC instant `t`: second Sunday of March 02:00 EST to first Sunday of November 02:00 EDT. */
export function etOffset(t: number): number {
  const year = new Date(t * 1000).getUTCFullYear();
  const mar1 = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSunMar = 1 + ((7 - mar1) % 7) + 7;
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSunNov = 1 + ((7 - nov1) % 7);
  const start = Date.UTC(year, 2, secondSunMar, 7, 0, 0) / 1000; // 02:00 EST
  const end = Date.UTC(year, 10, firstSunNov, 6, 0, 0) / 1000; // 02:00 EDT
  return t >= start && t < end ? -14400 : -18000;
}

export interface Wall {
  /** Days since 1970-01-01 of the local calendar date. */
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

export function etWall(t: number): Wall {
  const local = t + etOffset(t);
  const day = Math.floor(local / DAY);
  const sec = local - day * DAY;
  return { day, hour: Math.floor(sec / 3600), minute: Math.floor((sec % 3600) / 60), weekday: (((day + 4) % 7) + 7) % 7 };
}

/** Local wall clock (days since epoch + hour) to a UTC instant. Gap: standard time reading. Repeat: first occurrence. */
export function etLocalToUtc(day: number, hour: number): number {
  const local = day * DAY + hour * 3600;
  const cands = [local + 18000, local + 14400].filter((u) => etOffset(u) === (u === local + 18000 ? -18000 : -14400));
  return cands.length > 0 ? Math.min(...cands) : local + 18000;
}

export function isoOfDay(day: number): string {
  return new Date(day * DAY * 1000).toISOString().slice(0, 10);
}

/** Candle start for a timeframe, written from SPEC section 4 with the model above. */
export function refBucket(t: number, tf: string): number {
  const fixed: Record<string, number> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };
  if (fixed[tf] !== undefined) return Math.floor(t / fixed[tf]!) * fixed[tf]!;
  const w = etWall(t);
  if (tf === '1D') return etLocalToUtc(w.hour >= 18 ? w.day : w.day - 1, 18);
  const anchors = [2, 6, 10, 14, 18, 22];
  const a = [...anchors].reverse().find((h) => h <= w.hour);
  return a === undefined ? etLocalToUtc(w.day - 1, 22) : etLocalToUtc(w.day, a);
}

/** Independent aggregation of 1m bars (missing minutes skipped). */
export function refAggregate(bars: Bar[], tf: string): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const s = refBucket(b.time, tf);
    const last = out[out.length - 1];
    if (last && last.time === s) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ time: s, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

/** ET trading day label (18:00 rollover). */
export function refTradingDay(t: number): string {
  const w = etWall(t);
  return isoOfDay(w.hour >= 18 ? w.day + 1 : w.day);
}
