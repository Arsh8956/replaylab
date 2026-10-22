import { EngineError } from './errors';
import type { ContractSpec } from './types';

function spec(symbol: string, root: string, name: string, tickSize: number, tickValue: number, pointValue: number): ContractSpec {
  return Object.freeze({ symbol, root, name, tickSize, tickValue, pointValue });
}

/** SPEC §3. Micros share the bars of their full size root. */
export const CONTRACTS: Record<string, ContractSpec> = Object.freeze({
  NQ: spec('NQ', 'NQ', 'E-mini Nasdaq-100', 0.25, 5, 20),
  MNQ: spec('MNQ', 'NQ', 'Micro E-mini Nasdaq-100', 0.25, 0.5, 2),
  ES: spec('ES', 'ES', 'E-mini S&P 500', 0.25, 12.5, 50),
  MES: spec('MES', 'ES', 'Micro E-mini S&P 500', 0.25, 1.25, 5),
  YM: spec('YM', 'YM', 'E-mini Dow', 1, 5, 5),
  MYM: spec('MYM', 'YM', 'Micro E-mini Dow', 1, 0.5, 0.5),
  RTY: spec('RTY', 'RTY', 'E-mini Russell 2000', 0.1, 5, 50),
  M2K: spec('M2K', 'RTY', 'Micro E-mini Russell 2000', 0.1, 0.5, 5),
  CL: spec('CL', 'CL', 'Crude Oil', 0.01, 10, 1000),
  MCL: spec('MCL', 'CL', 'Micro Crude Oil', 0.01, 1, 100),
  GC: spec('GC', 'GC', 'Gold', 0.1, 10, 100),
  MGC: spec('MGC', 'GC', 'Micro Gold', 0.1, 1, 10),
});

// Nudge so exact halves that float math lands just under (2300.05 / 0.1) still round up.
const HALF_NUDGE = 1e-9;

function checkTick(tickSize: number): void {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) throw new EngineError(`tickSize must be > 0, got ${tickSize}`);
}

function decimalsOf(tickSize: number): number {
  const s = String(tickSize);
  const e = s.indexOf('e-');
  if (e >= 0) {
    const mantissa = s.slice(0, e);
    const dot = mantissa.indexOf('.');
    return Number(s.slice(e + 2)) + (dot < 0 ? 0 : mantissa.length - dot - 1);
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Price as a whole number of ticks. All engine price comparisons go through this, never raw floats. */
export function priceToTicks(price: number, tickSize: number): number {
  return Math.round(price / tickSize + HALF_NUDGE);
}

/** Nearest price on the tick grid, with float dust removed (2700.3, not 2700.3000000000002). */
export function roundToTick(price: number, tickSize: number): number {
  checkTick(tickSize);
  const ticks = priceToTicks(price, tickSize);
  return Number((ticks * tickSize).toFixed(Math.min(decimalsOf(tickSize), 12)));
}
