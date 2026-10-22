import { etParts, tradingDay, weekdayOfDay } from './time';
import type { GroupStats, Side, Stats, Trade } from './types';

type SessionName = 'Asia' | 'London' | 'NY AM' | 'NY PM';
type WeekdayName = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri';

const WEEKDAYS: Record<number, WeekdayName> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' };
const cents = (usd: number): number => Math.round(usd * 100);

/** Sessions by ET entry time (SPEC §6). The 17:00 to 18:00 halt belongs to none. */
function sessionOf(entryTime: number): SessionName | null {
  const p = etParts(entryTime);
  const m = p.hour * 60 + p.minute;
  if (m >= 18 * 60 || m < 3 * 60) return 'Asia';
  if (m < 9 * 60 + 30) return 'London';
  if (m < 12 * 60) return 'NY AM';
  if (m < 17 * 60) return 'NY PM';
  return null;
}

/** Weekday of the ET trading day (Sunday 18:00 and later is Monday). Saturday and Sunday trading days have no bucket. */
function weekdayOf(entryTime: number): WeekdayName | null {
  return WEEKDAYS[weekdayOfDay(tradingDay(entryTime))] ?? null;
}

class Group {
  n = 0;
  private wins = 0;
  private losses = 0;
  private netCents = 0;
  private rSum = 0;
  private rCount = 0;

  add(t: Trade): void {
    this.n++;
    if (t.netUsd > 0) this.wins++;
    else if (t.netUsd < 0) this.losses++;
    this.netCents += cents(t.netUsd);
    if (t.rMultiple !== null && t.rMultiple !== undefined) {
      this.rSum += t.rMultiple;
      this.rCount++;
    }
  }

  stats(): GroupStats {
    const decided = this.wins + this.losses;
    const netUsd = this.netCents / 100;
    return {
      trades: this.n,
      winRate: decided > 0 ? this.wins / decided : null,
      netUsd,
      expectancyUsd: this.n > 0 ? netUsd / this.n : null,
      avgR: this.rCount > 0 ? this.rSum / this.rCount : null,
    };
  }
}

function groups<K extends string>(keys: readonly K[]): Record<K, Group> {
  const out = {} as Record<K, Group>;
  for (const k of keys) out[k] = new Group();
  return out;
}

function finish<K extends string>(g: Record<K, Group>): Record<K, GroupStats> {
  const out = {} as Record<K, GroupStats>;
  for (const k of Object.keys(g) as K[]) out[k] = g[k].stats();
  return out;
}

/** SPEC §6. Trades are ordered by exit time for streaks, equity, and drawdown. */
export function computeStats(trades: Trade[], startingBalance: number): Stats {
  const ordered = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.exitTime - b.t.exitTime || a.i - b.i)
    .map((x) => x.t);

  const all = new Group();
  const sessions = groups<SessionName>(['Asia', 'London', 'NY AM', 'NY PM']);
  const weekdays = groups<WeekdayName>(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const sides = groups<Side>(['long', 'short']);
  const setups = new Map<string, Group>();

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let netCents = 0;
  let profitCents = 0;
  let lossCents = 0;
  let feesCents = 0;
  let largestWin: number | null = null;
  let largestLoss: number | null = null;
  let holdSum = 0;
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  let rSum = 0;
  let rCount = 0;

  let equity = cents(startingBalance);
  let peak = equity;
  let maxDd = 0;
  let maxDdPeak = equity;
  const curve: { time: number; equity: number }[] = [];
  if (ordered.length > 0) curve.push({ time: ordered[0]!.entryTime, equity: equity / 100 });

  for (const t of ordered) {
    const net = cents(t.netUsd);
    netCents += net;
    feesCents += cents(t.feesUsd);
    holdSum += t.holdSeconds;
    if (t.rMultiple !== null && t.rMultiple !== undefined) {
      rSum += t.rMultiple;
      rCount++;
    }

    if (net > 0) {
      wins++;
      profitCents += net;
      if (largestWin === null || t.netUsd > largestWin) largestWin = t.netUsd;
      streakW++;
      streakL = 0;
    } else if (net < 0) {
      losses++;
      lossCents += net;
      if (largestLoss === null || t.netUsd < largestLoss) largestLoss = t.netUsd;
      streakL++;
      streakW = 0;
    } else {
      breakevens++;
      streakW = 0;
      streakL = 0;
    }
    if (streakW > maxW) maxW = streakW;
    if (streakL > maxL) maxL = streakL;

    equity += net;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDd) {
      maxDd = peak - equity;
      maxDdPeak = peak;
    }
    curve.push({ time: t.exitTime, equity: equity / 100 });

    all.add(t);
    sides[t.side].add(t);
    const session = sessionOf(t.entryTime);
    if (session) sessions[session].add(t);
    const weekday = weekdayOf(t.entryTime);
    if (weekday) weekdays[weekday].add(t);
    const setup = (t.journal?.setup ?? '').trim() || '(none)';
    let g = setups.get(setup);
    if (!g) setups.set(setup, (g = new Group()));
    g.add(t);
  }

  const n = ordered.length;
  const grossProfitUsd = profitCents / 100;
  const grossLossUsd = lossCents / 100;
  const avgWinUsd = wins > 0 ? grossProfitUsd / wins : null;
  const avgLossUsd = losses > 0 ? grossLossUsd / losses : null;

  return {
    trades: n,
    wins,
    losses,
    breakevens,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    netUsd: netCents / 100,
    grossProfitUsd,
    grossLossUsd,
    feesUsd: feesCents / 100,
    profitFactor: losses > 0 ? grossProfitUsd / Math.abs(grossLossUsd) : null,
    avgWinUsd,
    avgLossUsd,
    payoffRatio: avgWinUsd !== null && avgLossUsd !== null ? avgWinUsd / Math.abs(avgLossUsd) : null,
    expectancyUsd: n > 0 ? netCents / 100 / n : null,
    avgR: rCount > 0 ? rSum / rCount : null,
    largestWinUsd: largestWin,
    largestLossUsd: largestLoss,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    maxDrawdownUsd: maxDd / 100,
    maxDrawdownPct: maxDd > 0 && maxDdPeak > 0 ? (maxDd * 100) / maxDdPeak : 0,
    avgHoldSeconds: n > 0 ? holdSum / n : null,
    equityCurve: curve,
    bySetup: Object.fromEntries([...setups].map(([k, g]) => [k, g.stats()])),
    bySession: finish(sessions),
    byWeekday: finish(weekdays),
    bySide: finish(sides),
  };
}
