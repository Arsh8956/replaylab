import { priceToTicks } from './contracts';
import type { ContractSpec, ExitReason, JournalEntry, Side, Trade, UnixSeconds } from './types';

/** Round to cents, half away from zero, never returning -0. */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(Math.abs(x) * 100 + 1e-7) / 100;
  return x < 0 && r !== 0 ? -r : r;
}

export interface TradeInput {
  id: string;
  contract: ContractSpec;
  side: Side;
  qty: number;
  entryTime: UnixSeconds;
  entryPrice: number;
  exitTime: UnixSeconds;
  exitPrice: number;
  exitReason: ExitReason;
  initialStopLoss: number | undefined;
  maeTicks: number;
  mfeTicks: number;
  commissionPerSide: number;
}

/** SPEC §5 Math. Everything is computed from whole ticks; USD is rounded to cents here and nowhere later. */
export function buildTrade(i: TradeInput): Trade {
  const { tickSize, tickValue } = i.contract;
  const dir = i.side === 'long' ? 1 : -1;
  const entryTicks = priceToTicks(i.entryPrice, tickSize);
  const pnlTicks = (priceToTicks(i.exitPrice, tickSize) - entryTicks) * dir + 0; // + 0 turns -0 into 0
  const grossUsd = round2(pnlTicks * tickValue * i.qty);
  const feesUsd = round2(i.commissionPerSide * i.qty * 2);
  const netUsd = round2(grossUsd - feesUsd);
  const riskUsd = i.initialStopLoss === undefined ? null : round2(Math.abs(entryTicks - priceToTicks(i.initialStopLoss, tickSize)) * tickValue * i.qty);
  const rMultiple = riskUsd !== null && riskUsd > 0 ? grossUsd / riskUsd + 0 : null;
  const journal: JournalEntry = Object.freeze({});
  return Object.freeze({
    id: i.id,
    symbol: i.contract.symbol,
    side: i.side,
    qty: i.qty,
    entryTime: i.entryTime,
    entryPrice: i.entryPrice,
    exitTime: i.exitTime,
    exitPrice: i.exitPrice,
    exitReason: i.exitReason,
    pnlTicks,
    grossUsd,
    feesUsd,
    netUsd,
    riskUsd,
    rMultiple,
    maeTicks: i.maeTicks,
    mfeTicks: i.mfeTicks,
    holdSeconds: i.exitTime - i.entryTime,
    journal,
  });
}
