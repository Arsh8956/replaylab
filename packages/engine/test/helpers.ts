import { CONTRACTS } from '../src/contracts';
import type { Bar, ContractSpec } from '../src/types';

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
