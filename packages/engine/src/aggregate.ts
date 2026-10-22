import { EngineError } from './errors';
import { bucketStart } from './time';
import type { Bar, Timeframe } from './types';

/**
 * Builds candles of one timeframe from 1m bars pushed in time order.
 * Completed candles are frozen and shared; the last candle (possibly partial) is copied on read.
 */
export class CandleSeries {
  private readonly done: Bar[] = [];
  private cur: Bar | null = null;
  private lastTime = -Infinity;

  constructor(readonly tf: Timeframe) {}

  /** Number of 1m bars consumed is the caller's business; this only sees what it is given. */
  push(bar: Bar): void {
    if (!(bar.time > this.lastTime)) throw new EngineError('bars must be sorted with strictly increasing times');
    this.lastTime = bar.time;
    const start = bucketStart(bar.time, this.tf);
    const cur = this.cur;
    if (cur !== null && cur.time === start) {
      if (bar.high > cur.high) cur.high = bar.high;
      if (bar.low < cur.low) cur.low = bar.low;
      cur.close = bar.close;
      cur.volume += bar.volume;
      return;
    }
    if (cur !== null) this.done.push(Object.freeze(cur));
    this.cur = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  }

  /** All candles so far; the last one may be partial. Fresh array, safe to keep. */
  candles(): Bar[] {
    const out = this.done.slice();
    if (this.cur !== null) out.push({ ...this.cur });
    return out;
  }
}

/** Aggregate sorted 1m bars into `tf` candles. Missing 1m bars are skipped, never filled in. */
export function aggregate(bars: Bar[], tf: Timeframe): Bar[] {
  const series = new CandleSeries(tf);
  for (const b of bars) series.push(b);
  return series.candles();
}
