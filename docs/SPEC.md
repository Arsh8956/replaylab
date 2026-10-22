# ReplayLab v1 spec

Working name. FX Replay style replay for CME futures: pick a market and a past moment, replay it bar by bar without seeing the future, place simulated trades, then journal and measure them.

## 1. Scope

**In v1**
- Replay on 1m base data, viewed on 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1D (higher timeframes built only from revealed 1m bars)
- Markets: NQ, MNQ, ES, MES, YM, MYM, RTY, M2K, CL, MCL, GC, MGC
- Orders: market, limit, stop, each with an optional stop loss / take profit bracket; move SL/TP while in a trade; manual close
- One open trade at a time and one working entry order at a time
- Trade journal: setup, tags, notes, 1 to 5 rating, followed rules yes/no
- Stats dashboard (§6), equity curve, CSV export of trades
- Sessions saved and resumable (browser storage in the prototype)
- TradingView style workspace and hotkeys (§7), including draggable SL/TP and order lines on the chart
- Basic drawings: trend line, horizontal line, rectangle, measure
- Data at $0: synthetic (default), CSV import from any free export, Databento ingest capped inside its free credits (§8)

**Later**: prop firm rule tracking, multi chart sync, full drawing toolset (fib, position tool, text), indicators, accounts and cloud persistence, 1s/tick data, scaling in/out, multiple positions.

## 2. Data

- Source of record: Databento Historical, dataset `GLBX.MDP3`, schema `ohlcv-1m`, continuous front month rolled by volume (`NQ.v.0` with `stype_in="continuous"`). Unadjusted prices (real prints); rolls show up as gaps.
- Pull once, store as Parquet at `data/bars/{ROOT}/{YYYY}.parquet`. Columns: `time` int64 unix seconds UTC (bar OPEN time), `open high low close` float64, `volume` int64. Replay never calls the API.
- Micros use their full size root's bars: MNQ on NQ, MES on ES, MYM on YM, M2K on RTY, MCL on CL, MGC on GC. Same price, different tick value. Halves data cost.
- CSV import for user exports: `time,open,high,low,close,volume`, flexible header names, timezone option (IANA, default UTC), bad rows reported, never silently dropped.
- Synthetic generator: seeded and deterministic, prices on the tick grid, session shaped volatility (quiet Asia, active London, most active 09:30 to 11:00 ET), no bars during the 17:00 to 18:00 ET daily halt or the weekend (Fri 17:00 to Sun 18:00 ET). Always labeled "Synthetic" in the UI.

## 3. Contracts

| Symbol | Root | Name | Tick | Tick value | Point value |
|---|---|---|---|---|---|
| NQ | NQ | E-mini Nasdaq-100 | 0.25 | $5.00 | $20 |
| MNQ | NQ | Micro E-mini Nasdaq-100 | 0.25 | $0.50 | $2 |
| ES | ES | E-mini S&P 500 | 0.25 | $12.50 | $50 |
| MES | ES | Micro E-mini S&P 500 | 0.25 | $1.25 | $5 |
| YM | YM | E-mini Dow | 1.00 | $5.00 | $5 |
| MYM | YM | Micro E-mini Dow | 1.00 | $0.50 | $0.50 |
| RTY | RTY | E-mini Russell 2000 | 0.10 | $5.00 | $50 |
| M2K | RTY | Micro E-mini Russell 2000 | 0.10 | $0.50 | $5 |
| CL | CL | Crude Oil | 0.01 | $10.00 | $1,000 |
| MCL | CL | Micro Crude Oil | 0.01 | $1.00 | $100 |
| GC | GC | Gold | 0.10 | $10.00 | $100 |
| MGC | GC | Micro Gold | 0.10 | $1.00 | $10 |

Trading day: 18:00 America/New_York to 17:00 the next day. Sunday 18:00 opens Monday's trading day. Daily halt 17:00 to 18:00.

## 4. Engine public API (`@replaylab/engine`)

TypeScript, zero runtime dependencies, pure and deterministic. The package exports TS source directly (`"exports": "./src/index.ts"`), no build step. Everything below is exported from `src/index.ts`; nothing else is.

```ts
type UnixSeconds = number; // UTC; for bars this is the bar OPEN time
interface Bar { time: UnixSeconds; open: number; high: number; low: number; close: number; volume: number }
type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D';
type Side = 'long' | 'short';
type OrderType = 'market' | 'limit' | 'stop';

interface ContractSpec { symbol: string; root: string; name: string; tickSize: number; tickValue: number; pointValue: number }
interface SessionSettings {
  commissionPerSide: number; // USD per contract per side, default 0
  slippageTicks: number;     // default 0, see §5
  startingBalance: number;   // default 50000
}
interface OrderRequest { side: Side; type: OrderType; qty: number; price?: number; stopLoss?: number; takeProfit?: number }
interface Order extends OrderRequest {
  id: string; status: 'working' | 'filled' | 'cancelled';
  placedAt: UnixSeconds; filledAt?: UnixSeconds; fillPrice?: number;
}
interface Position {
  side: Side; qty: number; entryPrice: number; entryTime: UnixSeconds;
  stopLoss?: number; takeProfit?: number; initialStopLoss?: number;
  maeTicks: number; mfeTicks: number; // per contract, both >= 0
  pendingClose: boolean;
}
type ExitReason = 'stop_loss' | 'take_profit' | 'manual' | 'end_of_data';
interface JournalEntry { setup?: string; tags?: string[]; notes?: string; rating?: 1 | 2 | 3 | 4 | 5; followedRules?: boolean }
interface Trade {
  id: string; symbol: string; side: Side; qty: number;
  entryTime: UnixSeconds; entryPrice: number; exitTime: UnixSeconds; exitPrice: number; exitReason: ExitReason;
  pnlTicks: number;            // per contract
  grossUsd: number; feesUsd: number; netUsd: number;
  riskUsd: number | null; rMultiple: number | null;
  maeTicks: number; mfeTicks: number; holdSeconds: number;
  journal: JournalEntry;
}
type EngineEvent =
  | { type: 'order_filled'; time: UnixSeconds; order: Order }
  | { type: 'order_cancelled'; time: UnixSeconds; order: Order }
  | { type: 'position_opened'; time: UnixSeconds; position: Position }
  | { type: 'trade_closed'; time: UnixSeconds; trade: Trade };
interface SessionSnapshot {
  version: 1; symbol: string; startTime: UnixSeconds; cursorIndex: number;
  settings: SessionSettings; workingOrder: Order | null; position: Position | null;
  trades: Trade[]; nextId: number;
}

class ReplayEngine {
  constructor(opts: { bars: Bar[]; contract: ContractSpec; startTime: UnixSeconds; settings?: Partial<SessionSettings> });
  // bars: sorted 1m bars, may include history before startTime (shown as context).
  // Cursor starts at the last bar with time <= startTime (throws EngineError if none).
  readonly contract: ContractSpec;
  readonly settings: SessionSettings;
  get cursorTime(): UnixSeconds;            // open time of the last revealed 1m bar
  get lastPrice(): number;                  // close of the last revealed 1m bar
  getVisibleBars(tf: Timeframe): Bar[];     // revealed data only; last candle may be partial
  step(count?: number, tf?: Timeframe): EngineEvent[]; // see §5 "Stepping"
  stepTo(time: UnixSeconds): EngineEvent[]; // reveal every bar with time <= time
  placeOrder(req: OrderRequest): Order;     // throws EngineError on invalid input
  cancelOrder(id: string): void;
  modifyOrder(id: string, changes: { price?: number; stopLoss?: number | null; takeProfit?: number | null }): Order; // working entry order only (chart drag)
  modifyBracket(levels: { stopLoss?: number | null; takeProfit?: number | null }): void; // null removes
  closePosition(): void;                    // exit at next bar open (see §5)
  get workingOrder(): Order | null;
  get position(): Position | null;
  get trades(): Trade[];
  unrealized(): { ticks: number; usd: number } | null; // marked at lastPrice, all contracts
  setJournal(tradeId: string, entry: JournalEntry): void;
  isAtEnd(): boolean;
  toJSON(): SessionSnapshot;
  static fromJSON(s: SessionSnapshot, bars: Bar[], contract: ContractSpec): ReplayEngine;
}

function aggregate(bars: Bar[], tf: Timeframe): Bar[];
function bucketStart(time: UnixSeconds, tf: Timeframe): UnixSeconds;
function tradingDay(time: UnixSeconds): string; // 'YYYY-MM-DD' of the ET trading day (18:00 rollover)
function computeStats(trades: Trade[], startingBalance: number): Stats;
const CONTRACTS: Record<string, ContractSpec>;
function generateSyntheticBars(opts: { root: string; start: UnixSeconds; days: number; seed: number; startPrice?: number }): Bar[];
function parseBarsCsv(text: string, opts?: { timezone?: string }): { bars: Bar[]; errors: { line: number; message: string }[] };
function roundToTick(price: number, tickSize: number): number;
class EngineError extends Error {}
```

### Timeframe buckets
- 1m to 1h: `floor(time / tfSeconds) * tfSeconds` (epoch aligned; works because ET offsets are whole hours).
- 4h: anchored to the 18:00 ET trading day start: 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET (the last one is cut short by the 17:00 halt). DST aware.
- 1D: one candle per trading day (18:00 to 17:00 ET), `time` = trading day start.
- A bucket's candle is built only from revealed 1m bars in it; missing 1m bars are skipped, never filled in.

## 5. Replay and fill rules

The cursor is the last revealed 1m bar. The trader acts at that bar's close; anything placed now is processed starting with the next bar.

**Stepping.** `step(n, '1m')` reveals n base bars. `step(n, tf)` for a higher tf reveals base bars until n candles of tf have completed; the current partial candle, if any, counts as the first. A candle is complete when the next base bar starts a new bucket or the data ends. Orders are processed on every base bar revealed, never on aggregated candles. Stepping at the end of data does nothing.

**On each newly revealed bar B, in this order:**
1. Pending manual close: exit at `B.open`, slippage against the trader. Reason `manual`.
2. Open position exits:
   - a. Gap through a level: long and `B.open <= SL` exits at `B.open` (slippage applies). Long and `B.open >= TP` exits at `B.open` (no slippage). Short mirrors.
   - b. Both SL and TP inside B's range: SL wins (worst case).
   - c. SL touched (`B.low <= SL` for long): exit at SL, slippage against. TP touched (`B.high >= TP` for long): exit at TP. Touching the exact price counts.
3. Working entry order (only possible when flat):
   - market: `B.open`, slippage against.
   - buy limit L: `B.open <= L` fills at `B.open`; else `B.low <= L` fills at L. Sell limit mirrors.
   - buy stop S: `B.open >= S` fills at `B.open` + slippage; else `B.high >= S` fills at S + slippage. Sell stop mirrors.
   - On fill the position opens with the order's SL/TP. In the fill bar only the SL can trigger (exit at SL, slippage against); TP waits for the next bar. Exception: if the entry filled at `B.open`, rules 2a to 2c apply to the fill bar in full (SL first).
4. MAE/MFE in ticks per contract from bar high/low for every bar the position is open, fill bar included, measured from entry price.
5. If B is the last bar and a position is open: close at `B.close`, reason `end_of_data`. A working order just stays working.

**Slippage** (`slippageTicks`) applies against the trader on market entries, stop entries, stop loss exits, and manual closes. Never on limit entries or take profit exits.

**Fees**: `commissionPerSide * qty * 2` per trade.

**Validation** (throw `EngineError`):
- qty is an integer >= 1; limit and stop need `price`; all prices > 0.
- Prices are rounded to the tick with `roundToTick` before use.
- Long: `SL < reference < TP`; short mirrored. Reference = order price for limit/stop, `lastPrice` for market.
- No new entry while in a position or while an entry order is working.
- `modifyBracket` needs an open position and levels on the correct side of `lastPrice`.
- `cancelOrder` on an unknown or non working id throws.
- `modifyOrder` follows the same rules as `placeOrder`, checked against the order after the change; unknown or non working id throws.

**Math**
- `pnlTicks = round((exit - entry) / tick) * (long ? 1 : -1)`
- `grossUsd = pnlTicks * tickValue * qty`
- `riskUsd = abs(entry - initialStopLoss) / tick * tickValue * qty`, null if no SL at entry
- `rMultiple = grossUsd / riskUsd` (price based R, fees excluded), null if no risk
- USD fields rounded to cents when the Trade is created.

## 6. Stats definitions (`computeStats`)

```ts
interface GroupStats { trades: number; winRate: number | null; netUsd: number; expectancyUsd: number | null; avgR: number | null }
interface Stats {
  trades: number; wins: number; losses: number; breakevens: number;
  winRate: number | null;          // wins / (wins + losses); null if both 0
  netUsd: number; grossProfitUsd: number; grossLossUsd: number; feesUsd: number; // grossLoss <= 0
  profitFactor: number | null;     // grossProfit / |grossLoss|; null if no losses
  avgWinUsd: number | null; avgLossUsd: number | null; payoffRatio: number | null; // avgWin / |avgLoss|
  expectancyUsd: number | null;    // netUsd / trades
  avgR: number | null;             // mean rMultiple over trades that have one
  largestWinUsd: number | null; largestLossUsd: number | null;
  maxConsecutiveWins: number; maxConsecutiveLosses: number;
  maxDrawdownUsd: number; maxDrawdownPct: number; // closed trade equity from startingBalance, peak to trough, both >= 0
  avgHoldSeconds: number | null;
  equityCurve: { time: UnixSeconds; equity: number }[]; // first point = startingBalance at first entry time, then one per exit
  bySetup: Record<string, GroupStats>;   // '(none)' when no setup
  bySession: Record<'Asia' | 'London' | 'NY AM' | 'NY PM', GroupStats>;
  byWeekday: Record<'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri', GroupStats>;
  bySide: Record<Side, GroupStats>;
}
```
- Win / loss / breakeven by `netUsd` (> 0, < 0, = 0). Gross profit and loss are sums of `netUsd` over wins and losses.
- Sessions by entry time in ET: Asia 18:00 to 03:00, London 03:00 to 09:30, NY AM 09:30 to 12:00, NY PM 12:00 to 17:00.
- Weekday = weekday of the trading day (a Sunday 19:00 entry counts as Mon).
- Trades are ordered by exit time for streaks, equity, and drawdown.

## 7. Web app

Goal: anyone who has used TradingView can run a full replay session with zero instructions. We copy TradingView's layout and interaction conventions (where things live, what clicks and hotkeys do). We do NOT copy its logo, icons, colors, or styling: our own name, our own icon set (Lucide, ISC license), our own color tokens.

**Stack**: React + TypeScript + Vite, `lightweight-charts` v5 (keep the TradingView attribution logo on), `lucide-react` icons, plain CSS with tokens. No UI kit.

**Data sources** behind one interface: `SyntheticSource` (root + seed + date range), `CsvSource` (file import, shows parse errors), `ApiSource` (`VITE_API_URL`, `GET /bars`).

### 7.1 Workspace layout (desktop)

```
+-------------------------------------------------------------------------------+
| [=] | NQ v | 1m 5m 15m 1h 4h D v | Candles v | Replay | undo redo | Session v  [gear] [moon] |
+----+-------------------------------------------------------------+---+--------+
| +  | NQ . 5 . CME   O 21012.25  H 21018.00  L 21009.50  C 21016.75 | O |        |
| /  | [SELL 21016.50]  [ 1 ]  [BUY 21016.75]                        | M | right  |
| -- |                                                               | D | panel  |
| [] |   ---- TP  21040.75   +$480.00  [x] ----------------------    |   | (Order |
| ++ |   ---- 1 NQ  21016.75  +$0.00   [x] ----------------------    |   |  panel |
| U  |   ---- SL  21004.75   -$240.00  [x] ----------------------    |   |  open) |
| L  |                                                               |   |        |
| X  |        [ |<pick  >play  >|step  1x v  Jump to...  x ]        |   |        |
|    +---------------------------------------------------------------+   |        |
|    | Go to...                        09:41 ET (replay)  %  log  auto|   |        |
+----+---------------------------------------------------------------+---+--------+
| Positions & Orders | Journal | Stats                                [^] [max]   |
+-------------------------------------------------------------------------------+
```
Example lines: 1 NQ long at 21016.75, SL 12 pts (48 ticks) = -$240.00, TP 24 pts (96 ticks) = +$480.00, 2R.

1. **Top toolbar** (left to right): menu (new / open / save / export session), symbol button (opens symbol search), favorite timeframe buttons + dropdown for the rest, chart type (candles, bars, line), Replay button (enters pick start mode), undo / redo, session name with save status, settings (account size, commission, slippage), theme toggle, fullscreen. Indicators button arrives in M2.
2. **Left drawing toolbar**: cursor modes (cross, dot, arrow), trend line, horizontal line, rectangle, measure, magnet toggle, lock all, hide all, remove all. Tooltips show the hotkey. Fib, position tool, text, and tool flyouts arrive in M2.
3. **Chart**:
   - Legend top left: symbol, timeframe, OHLC of the hovered bar (last bar when not hovering), change.
   - Buy / Sell buttons with a qty box under the legend for one click market orders (toggle in settings), like TradingView's on chart trading buttons.
   - Right price scale with last price label; crosshair with price and time labels; scroll and zoom like TradingView (drag, wheel, double click scale to reset).
   - Right click menu: Buy limit / Sell limit / Buy stop / Sell stop at the clicked price (only the valid ones for that side of last price), Reset chart view, Remove drawings.
   - Order lines: position line (qty, unrealized $, [x] flattens), SL and TP lines ($ result at that level, [x] removes), working order line ([x] cancels). Drag SL, TP, or a working order's price to change it (engine `modifyBracket` / `modifyOrder`). Markers on fills and exits.
4. **Floating replay bar** (bottom center of the chart, draggable, like TradingView Bar Replay): pick start (click a bar on the chart) or Jump to date, play / pause, step forward, step size (1m, 3m, 5m, 15m, 1h), speed (1, 2, 5, 10, 20 bars per second), exit replay.
5. **Chart footer**: Go to date, replay clock in ET, % / log / auto scale toggles.
6. **Right sidebar**: icon strip plus one open panel at a time, like TradingView's right toolbar.
   - Order panel: Buy / Sell header with prices, Market / Limit / Stop tabs, qty stepper, price field (limit/stop), TP and SL checkboxes with the value entered in ticks, price, or $ (switchable), live readout of risk $, reward $, and R:R, confirm button worded like "Buy 1 NQ @ 21016.75 MKT". Engine errors show inline, never swallowed.
   - Markets: the 12 contracts with tick size and tick value; click to switch (starts a new session or asks).
   - Data window: OHLCV of the hovered bar, plus open position stats.
7. **Bottom panel** (collapsible, resizable, maximizable; TradingView's Trading Panel / Strategy Tester spot):
   - Positions & Orders: open position and working order with close / cancel buttons, session trade list.
   - Journal: trade table (entry time, side, qty, entry, exit, ticks, net $, R, reason) with inline edits for setup, tags, rating, followed rules, notes; filter by setup; export CSV.
   - Stats: KPI tiles (net $, win rate, profit factor, expectancy $, avg R, max drawdown), equity curve, breakdown tables (setup, session, weekday, side). Every number comes from `computeStats`.

**Symbol search**: opens from the symbol button or when you start typing letters on the chart; filters by symbol and name; Enter picks. **Interval box**: typing a number on the chart opens it (`5` = 5m, `60` or `1h` = 1h, `D` = 1D), Enter applies. Both are TradingView behavior.

**New session dialog**: market, data source, start date/time (or pick on chart), account size, commission per side, slippage ticks.

### 7.2 Hotkeys

Match TradingView wherever it has a default, so muscle memory carries over. Rows marked *verify* get checked against TradingView's own hotkey list by recon-analyst before the UI build; if TradingView differs, match TradingView. All hotkeys are ignored while typing in an input, shown in tooltips, and listed in a `?` shortcuts dialog.

| Action | Key | Source |
|---|---|---|
| Replay play / pause | Shift+↓ | TradingView Bar Replay |
| Replay step forward | Shift+→ | TradingView Bar Replay |
| Change symbol | start typing letters on the chart | TradingView |
| Change timeframe | start typing a number on the chart | TradingView |
| Trend line | Alt+T | TradingView, verify |
| Horizontal line | Alt+H | TradingView, verify |
| Rectangle | Alt+Shift+R | TradingView, verify |
| Measure | Shift+click on the chart | TradingView, verify |
| Reset chart view | Alt+R | TradingView, verify |
| Undo / redo | Ctrl+Z / Ctrl+Y | TradingView |
| Buy market / Sell market / Flatten | Alt+Shift+B / Alt+Shift+S / Alt+Shift+X | ours, configurable (plain letters belong to symbol search) |
| Cancel working order, exit tool, close dialog | Esc | ours |

### 7.3 Phone width (390px)

Top toolbar collapses to symbol, timeframe, Replay, and menu. Left toolbar becomes a bottom sheet tool picker. Right panel and bottom panel open as full screen sheets. Replay bar pins above the bottom edge. Buy / Sell buttons stay on the chart. 16px gutters, no horizontal page scroll.

### 7.4 State, themes, builds

- Sessions in localStorage via `engine.toJSON()`, every access in try/catch; the app works with storage blocked. Synthetic sessions regenerate bars from their seed; CSV sessions ask for the file again on resume. M1 moves sessions to the API.
- Workspace layout (open panels, panel sizes, favorite timeframes, theme) saved per browser the same way.
- Light and dark themes from CSS tokens on `:root`; dark is the default.
- `build:single` makes one self contained HTML demo file with no external requests, for sharing.

## 8. Data service (`services/data`, Python 3.11+)

- CLI `replaylab-data`:
  - `ingest --root NQ --start 2024-01-01 --end 2024-03-31 [--yes]`: prints Databento's cost estimate first; downloads only with `--yes`. Spend cap: every download's cost is added to `data/spend.json`, and `--yes` refuses if the running total plus the new estimate would pass `--cap` (default $100.00, under the $125.00 free credits). Key from `DATABENTO_API_KEY`.
  - `import-csv FILE --root NQ [--tz America/New_York]`: normalize to the Parquet layout in §2, report bad rows.
  - `info`: roots on disk with first/last bar and bar counts.
- FastAPI: `GET /health`, `GET /markets` (roots + date ranges on disk), `GET /bars?root=NQ&start=ISO&end=ISO` returning `Bar[]` exactly as in §4 (max 31 days per request, 400 beyond).
- Tests never call Databento; the client is mocked. Fixtures are generated in the tests.

## 9. Milestones

- **M0 (Claude Code)**: engine + tests, data service, web app on synthetic + CSV data, GitHub Actions CI (engine tests + typecheck, web build, pytest). The plan, team, and research were done in chat; build order is in README.md.
- **M1 (Claude Code)**: recon pass from allowed public sources (hotkey check first), reviewed by research-motherhead and folded into this spec; real NQ and ES data (CSV export or Databento free credits); web app on the bars API; session persistence API on SQLite (one local file, nothing to install).
- **M2**: prop firm rules (trailing drawdown, daily loss limit, account presets), multi timeframe sync, full drawing toolset, indicators.
- **M3**: accounts, free tier hosting only (after the §10 data license check), shareable session results.

## 10. Risks and guardrails

- **Cost**: $0 budget. Free and open source tools only, no paid plans or hosting. Databento only inside its free credits, enforced by the CLI spend cap plus a team monthly limit set on Databento's Billing page.
- **Lookahead**: one leak makes every stat a lie. Covered by CLAUDE.md hard rule 1, qa-tester, and both pod motherheads.
- **Terms of service**: no reverse engineering TradingView or FX Replay, and no FX Replay account use for this project (`docs/research/public-landscape.md`).
- **Patent**: FX Replay holds US 12,614,322 (selecting a session/time window for backtesting). We don't build "mark a session window on the chart to auto backtest it". Patent attorney review before any launch.
- **Market data license**: v1 is for Arsh and the team. Before anyone else uses a hosted ReplayLab, check Databento's and CME's redistribution terms.
- **Charts**: the Lightweight Charts attribution logo stays on. Advanced Charts only if a company applies for a public product.
