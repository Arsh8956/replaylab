import { priceToTicks, roundToTick } from './contracts';
import { EngineError } from './errors';
import type { ContractSpec, JournalEntry, OrderRequest, SessionSettings } from './types';

export const DEFAULT_SETTINGS: SessionSettings = { commissionPerSide: 0, slippageTicks: 0, startingBalance: 50000 };

export function resolveSettings(partial: Partial<SessionSettings> | undefined): SessionSettings {
  const s = { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
  if (!(Number.isFinite(s.commissionPerSide) && s.commissionPerSide >= 0)) throw new EngineError('commissionPerSide must be a number >= 0');
  if (!(Number.isInteger(s.slippageTicks) && s.slippageTicks >= 0)) throw new EngineError('slippageTicks must be a whole number >= 0');
  if (!(Number.isFinite(s.startingBalance) && s.startingBalance > 0)) throw new EngineError('startingBalance must be a number > 0');
  return { commissionPerSide: s.commissionPerSide, slippageTicks: s.slippageTicks, startingBalance: s.startingBalance };
}

/** A usable price: finite, > 0 before and after rounding to the tick. */
export function checkPrice(name: string, value: unknown, tickSize: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new EngineError(`${name} must be a number > 0`);
  const rounded = roundToTick(value, tickSize);
  if (!(rounded > 0)) throw new EngineError(`${name} must be a number > 0`);
  return rounded;
}

/**
 * SPEC §5 Validation for an entry order: returns the cleaned request (prices on the tick grid,
 * absent levels omitted) or throws EngineError. `lastPrice` is the reference for market orders.
 */
export function normalizeRequest(req: OrderRequest, contract: ContractSpec, lastPrice: number): OrderRequest {
  const tick = contract.tickSize;
  if (req.side !== 'long' && req.side !== 'short') throw new EngineError(`side must be 'long' or 'short'`);
  if (req.type !== 'market' && req.type !== 'limit' && req.type !== 'stop') throw new EngineError(`type must be 'market', 'limit' or 'stop'`);
  if (!Number.isInteger(req.qty) || req.qty < 1) throw new EngineError('qty must be an integer >= 1');

  const out: OrderRequest = { side: req.side, type: req.type, qty: req.qty };
  if (req.type !== 'market') {
    if (req.price == null) throw new EngineError(`${req.type} orders need a price`);
    out.price = checkPrice('price', req.price, tick);
  }
  if (req.stopLoss != null) out.stopLoss = checkPrice('stopLoss', req.stopLoss, tick);
  if (req.takeProfit != null) out.takeProfit = checkPrice('takeProfit', req.takeProfit, tick);

  const ref = priceToTicks(out.price ?? lastPrice, tick);
  const long = req.side === 'long';
  if (out.stopLoss !== undefined) {
    const sl = priceToTicks(out.stopLoss, tick);
    if (long ? !(sl < ref) : !(sl > ref)) throw new EngineError(`stopLoss must be ${long ? 'below' : 'above'} ${out.price === undefined ? 'the last price' : 'the order price'} for a ${req.side}`);
  }
  if (out.takeProfit !== undefined) {
    const tp = priceToTicks(out.takeProfit, tick);
    if (long ? !(tp > ref) : !(tp < ref)) throw new EngineError(`takeProfit must be ${long ? 'above' : 'below'} ${out.price === undefined ? 'the last price' : 'the order price'} for a ${req.side}`);
  }
  return out;
}

/** Journal entries are replaced whole; only known fields are kept, each type checked. */
export function normalizeJournal(entry: JournalEntry): JournalEntry {
  if (entry === null || typeof entry !== 'object') throw new EngineError('journal entry must be an object');
  const out: JournalEntry = {};
  if (entry.setup !== undefined) {
    if (typeof entry.setup !== 'string') throw new EngineError('journal setup must be a string');
    out.setup = entry.setup;
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== 'string')) throw new EngineError('journal tags must be an array of strings');
    out.tags = Object.freeze([...entry.tags]) as string[];
  }
  if (entry.notes !== undefined) {
    if (typeof entry.notes !== 'string') throw new EngineError('journal notes must be a string');
    out.notes = entry.notes;
  }
  if (entry.rating !== undefined) {
    if (!Number.isInteger(entry.rating) || entry.rating < 1 || entry.rating > 5) throw new EngineError('journal rating must be a whole number from 1 to 5');
    out.rating = entry.rating;
  }
  if (entry.followedRules !== undefined) {
    if (typeof entry.followedRules !== 'boolean') throw new EngineError('journal followedRules must be true or false');
    out.followedRules = entry.followedRules;
  }
  return Object.freeze(out);
}
