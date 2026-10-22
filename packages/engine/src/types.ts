// Public types from SPEC §4 and §6. Types only: no runtime code in this file.

export type UnixSeconds = number; // UTC; for bars this is the bar OPEN time
export interface Bar {
  time: UnixSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D';
export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit' | 'stop';

export interface ContractSpec {
  symbol: string;
  root: string;
  name: string;
  tickSize: number;
  tickValue: number;
  pointValue: number;
}

export interface SessionSettings {
  commissionPerSide: number; // USD per contract per side, default 0
  slippageTicks: number; // default 0, see SPEC §5
  startingBalance: number; // default 50000
}

export interface OrderRequest {
  side: Side;
  type: OrderType;
  qty: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
}
export interface Order extends OrderRequest {
  id: string;
  status: 'working' | 'filled' | 'cancelled';
  placedAt: UnixSeconds;
  filledAt?: UnixSeconds;
  fillPrice?: number;
}

export interface Position {
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: UnixSeconds;
  stopLoss?: number;
  takeProfit?: number;
  initialStopLoss?: number;
  maeTicks: number; // per contract, both >= 0
  mfeTicks: number;
  pendingClose: boolean;
}

export type ExitReason = 'stop_loss' | 'take_profit' | 'manual' | 'end_of_data';

export interface JournalEntry {
  setup?: string;
  tags?: string[];
  notes?: string;
  rating?: 1 | 2 | 3 | 4 | 5;
  followedRules?: boolean;
}

export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryTime: UnixSeconds;
  entryPrice: number;
  exitTime: UnixSeconds;
  exitPrice: number;
  exitReason: ExitReason;
  pnlTicks: number; // per contract
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  riskUsd: number | null;
  rMultiple: number | null;
  maeTicks: number;
  mfeTicks: number;
  holdSeconds: number;
  journal: JournalEntry;
}

export type EngineEvent =
  | { type: 'order_filled'; time: UnixSeconds; order: Order }
  | { type: 'order_cancelled'; time: UnixSeconds; order: Order }
  | { type: 'position_opened'; time: UnixSeconds; position: Position }
  | { type: 'trade_closed'; time: UnixSeconds; trade: Trade };

export interface SessionSnapshot {
  version: 1;
  symbol: string;
  startTime: UnixSeconds;
  cursorIndex: number;
  settings: SessionSettings;
  workingOrder: Order | null;
  position: Position | null;
  trades: Trade[];
  nextId: number;
}

// SPEC §6
export interface GroupStats {
  trades: number;
  winRate: number | null;
  netUsd: number;
  expectancyUsd: number | null;
  avgR: number | null;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  netUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  feesUsd: number;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  payoffRatio: number | null;
  expectancyUsd: number | null;
  avgR: number | null;
  largestWinUsd: number | null;
  largestLossUsd: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  avgHoldSeconds: number | null;
  equityCurve: { time: UnixSeconds; equity: number }[];
  bySetup: Record<string, GroupStats>;
  bySession: Record<'Asia' | 'London' | 'NY AM' | 'NY PM', GroupStats>;
  byWeekday: Record<'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri', GroupStats>;
  bySide: Record<Side, GroupStats>;
}
