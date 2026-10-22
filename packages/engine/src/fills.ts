import { priceToTicks, roundToTick } from './contracts';
import type { Bar, ContractSpec, ExitReason, Order, Position } from './types';

/** All comparisons below are on whole ticks (CLAUDE.md hard rule 2); returned prices are on the tick grid. */

/** Move `price` against the trader by `slipTicks` (`dir` +1 pays more, -1 receives less). */
function slip(price: number, dir: 1 | -1, slipTicks: number, tick: number): number {
  return slipTicks === 0 ? price : roundToTick(price + dir * slipTicks * tick, tick);
}

export interface EntryFill {
  price: number;
  /** The fill was triggered by the bar's open (market, gap limit, gap stop). */
  atOpen: boolean;
}

/** SPEC §5 step 3: does the working entry order fill on this bar, and at what price. */
export function entryFill(order: Order, bar: Bar, contract: ContractSpec, slipTicks: number): EntryFill | null {
  const tick = contract.tickSize;
  const open = priceToTicks(bar.open, tick);
  const openPx = roundToTick(bar.open, tick);
  const buy = order.side === 'long';
  const dir = buy ? 1 : -1;

  if (order.type === 'market') return { price: slip(openPx, dir, slipTicks, tick), atOpen: true };

  const level = priceToTicks(order.price!, tick);
  if (order.type === 'limit') {
    if (buy) {
      if (open <= level) return { price: openPx, atOpen: true };
      if (priceToTicks(bar.low, tick) <= level) return { price: order.price!, atOpen: false };
    } else {
      if (open >= level) return { price: openPx, atOpen: true };
      if (priceToTicks(bar.high, tick) >= level) return { price: order.price!, atOpen: false };
    }
    return null;
  }

  // stop
  if (buy) {
    if (open >= level) return { price: slip(openPx, 1, slipTicks, tick), atOpen: true };
    if (priceToTicks(bar.high, tick) >= level) return { price: slip(order.price!, 1, slipTicks, tick), atOpen: false };
  } else {
    if (open <= level) return { price: slip(openPx, -1, slipTicks, tick), atOpen: true };
    if (priceToTicks(bar.low, tick) <= level) return { price: slip(order.price!, -1, slipTicks, tick), atOpen: false };
  }
  return null;
}

export interface ExitFill {
  price: number;
  reason: Extract<ExitReason, 'stop_loss' | 'take_profit'>;
  /** The exit happened at the bar's open (a gap), so the rest of the bar is not part of the trade. */
  atOpen: boolean;
}

/**
 * SPEC §5 step 2 (and the fill bar variant in step 3).
 * `full` = rules 2a to 2c. Not `full` = fill bar after an intrabar entry: only the SL can trigger.
 */
export function exitFill(pos: Position, bar: Bar, contract: ContractSpec, slipTicks: number, full: boolean): ExitFill | null {
  const tick = contract.tickSize;
  const long = pos.side === 'long';
  const dir = long ? -1 : 1; // a long exits by selling lower, a short by buying higher
  const open = priceToTicks(bar.open, tick);
  const openPx = roundToTick(bar.open, tick);
  const sl = pos.stopLoss === undefined ? undefined : priceToTicks(pos.stopLoss, tick);
  const tp = pos.takeProfit === undefined ? undefined : priceToTicks(pos.takeProfit, tick);

  if (full) {
    // 2a: gap through a level
    if (sl !== undefined && (long ? open <= sl : open >= sl)) return { price: slip(openPx, dir, slipTicks, tick), reason: 'stop_loss', atOpen: true };
    if (tp !== undefined && (long ? open >= tp : open <= tp)) return { price: openPx, reason: 'take_profit', atOpen: true };
  }
  // 2b, 2c: SL first, so it wins when both sit inside the bar
  if (sl !== undefined && (long ? priceToTicks(bar.low, tick) <= sl : priceToTicks(bar.high, tick) >= sl)) {
    return { price: slip(pos.stopLoss!, dir, slipTicks, tick), reason: 'stop_loss', atOpen: false };
  }
  if (full && tp !== undefined && (long ? priceToTicks(bar.high, tick) >= tp : priceToTicks(bar.low, tick) <= tp)) {
    return { price: pos.takeProfit!, reason: 'take_profit', atOpen: false };
  }
  return null;
}

/** Manual close and its slippage: at the bar open, against the trader. */
export function manualCloseFill(pos: Position, bar: Bar, contract: ContractSpec, slipTicks: number): number {
  return slip(roundToTick(bar.open, contract.tickSize), pos.side === 'long' ? -1 : 1, slipTicks, contract.tickSize);
}
