import { CONTRACTS } from '../src/contracts';
import { ReplayEngine } from '../src/engine';
import type { Bar, ContractSpec, SessionSettings } from '../src/types';

/** ISO string (with Z) to unix seconds. Tests only. */
export function utc(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad iso ${iso}`);
  return ms / 1000;
}

export const NQ: ContractSpec = CONTRACTS['NQ']!;
export const MNQ: ContractSpec = CONTRACTS['MNQ']!;
export const ES: ContractSpec = CONTRACTS['ES']!;

/** 2024-01-02 15:00:00 UTC = Tue 10:00 ET (EST). */
export const T0 = utc('2024-01-02T15:00:00Z');

export type Ohlc = [open: number, high: number, low: number, close: number, volume?: number];

/** Build consecutive 1m bars starting at `start`, one per OHLC tuple. */
export function barsFrom(start: number, rows: Ohlc[]): Bar[] {
  return rows.map(([open, high, low, close, volume], i) => ({
    time: start + i * 60,
    open,
    high,
    low,
    close,
    volume: volume ?? 100,
  }));
}

/**
 * Engine over `rows` with the cursor on row 0 (the context bar), NQ unless told otherwise.
 * A flat tail bar is appended so the last row is not the end of data (end_of_data would close open positions).
 * Use engineExact when the end of data matters.
 */
export function engineOver(rows: Ohlc[], settings: Partial<SessionSettings> = {}, contract: ContractSpec = NQ, start: number = T0): ReplayEngine {
  const lastClose = rows[rows.length - 1]![3];
  return engineExact([...rows, [lastClose, lastClose, lastClose, lastClose]], settings, contract, start);
}

export function engineExact(rows: Ohlc[], settings: Partial<SessionSettings> = {}, contract: ContractSpec = NQ, start: number = T0): ReplayEngine {
  return new ReplayEngine({ bars: barsFrom(start, rows), contract, startTime: start, settings });
}

/** Small deterministic LCG so engine tests do not depend on the synthetic generator. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Random walk of valid 1m NQ bars on the 0.25 grid. */
export function walkBars(n: number, seed: number, start: number = T0, startPrice = 21000): Bar[] {
  const rand = lcg(seed);
  const out: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    const step = Math.round((rand() - 0.5) * 24) * 0.25; // up to +-3 points
    const close = Math.max(100, open + step);
    const high = close > open ? close : open;
    const low = close > open ? open : close;
    out.push({
      time: start + i * 60,
      open,
      high: high + Math.round(rand() * 8) * 0.25,
      low: low - Math.round(rand() * 8) * 0.25,
      close,
      volume: 50 + Math.floor(rand() * 200),
    });
    price = close;
  }
  return out;
}
