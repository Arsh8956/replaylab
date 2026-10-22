import { EngineError } from './errors';
import type { Timeframe, UnixSeconds } from './types';

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];

const FIXED_SECONDS: Partial<Record<Timeframe, number>> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
};

export const ET = 'America/New_York';

export function isTimeframe(x: unknown): x is Timeframe {
  return typeof x === 'string' && (TIMEFRAMES as readonly string[]).includes(x);
}

// ---- timezone offsets (Intl only) ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new EngineError(`Unknown timezone: ${tz}`);
    }
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC in seconds at instant `t` (an integer), straight from Intl. */
function rawOffset(t: number, tz: string): number {
  const f = formatterFor(tz);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of f.formatToParts(new Date(t * 1000))) {
    switch (p.type) {
      case 'year': year = Number(p.value); break;
      case 'month': month = Number(p.value); break;
      case 'day': day = Number(p.value); break;
      case 'hour': hour = Number(p.value) % 24; break;
      case 'minute': minute = Number(p.value); break;
      case 'second': second = Number(p.value); break;
      default: break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - t;
}

// Offsets are cached per 15 minute slot: every zone transition falls on a 15 minute boundary in UTC.
const SLOT = 900;
const offsetCache = new Map<string, Map<number, number>>();

export function tzOffsetSeconds(time: UnixSeconds, tz: string): number {
  if (tz === 'UTC') return 0;
  let cache = offsetCache.get(tz);
  if (!cache) {
    formatterFor(tz); // validates the zone name up front
    cache = new Map();
    offsetCache.set(tz, cache);
  }
  const slot = Math.floor(time / SLOT);
  let off = cache.get(slot);
  if (off === undefined) {
    off = rawOffset(slot * SLOT, tz);
    cache.set(slot, off);
  }
  return off;
}

// ---- wall clock <-> unix ----

export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

export function zonedParts(time: UnixSeconds, tz: string): ZonedParts {
  const local = Math.floor(time) + tzOffsetSeconds(Math.floor(time), tz);
  const days = Math.floor(local / 86400);
  const sec = local - days * 86400;
  const d = new Date(days * 86400000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: Math.floor(sec / 3600),
    minute: Math.floor((sec % 3600) / 60),
    second: sec % 60,
    weekday: d.getUTCDay(),
  };
}

export function etParts(time: UnixSeconds): ZonedParts {
  return zonedParts(time, ET);
}

/**
 * Local seconds (wall clock read as if it were UTC) to a real instant in `tz`.
 * Ambiguous wall clock (fall back): the first occurrence. Nonexistent (spring forward gap): shifted forward.
 */
function resolveLocal(localSec: number, tz: string): UnixSeconds {
  if (tz === 'UTC') return localSec;
  const before = tzOffsetSeconds(localSec - 86400, tz);
  const after = tzOffsetSeconds(localSec + 86400, tz);
  let best: number | null = null;
  for (const off of before === after ? [before] : [before, after]) {
    const t = localSec - off;
    if (tzOffsetSeconds(t, tz) === off && (best === null || t < best)) best = t;
  }
  return best ?? localSec - before;
}

export function zonedToUnix(
  local: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  tz: string,
): UnixSeconds {
  const localSec = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0, local.second ?? 0) / 1000;
  return resolveLocal(localSec, tz);
}

// ---- timeframe buckets and trading days ----

/** Start of the candle containing `time`. 4h and 1D are anchored to 18:00 ET (SPEC §4). */
export function bucketStart(time: UnixSeconds, tf: Timeframe): UnixSeconds {
  const fixed = FIXED_SECONDS[tf];
  if (fixed !== undefined) return Math.floor(time / fixed) * fixed;
  if (tf !== '4h' && tf !== '1D') throw new EngineError(`Unknown timeframe: ${String(tf)}`);
  const t = Math.floor(time);
  const local = t + tzOffsetSeconds(t, ET);
  const day = Math.floor(local / 86400);
  const hour = Math.floor((local - day * 86400) / 3600);
  let anchorHour: number; // hour relative to local midnight of `day`; negative means the previous day
  if (tf === '1D') anchorHour = hour >= 18 ? 18 : -6;
  else anchorHour = hour >= 2 ? 2 + 4 * Math.floor((hour - 2) / 4) : -2;
  return resolveLocal(day * 86400 + anchorHour * 3600, ET);
}

function isoDay(daysSinceEpoch: number): string {
  return new Date(daysSinceEpoch * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' of the ET trading day containing `time` (18:00 ET rolls to the next date). */
export function tradingDay(time: UnixSeconds): string {
  const t = Math.floor(time);
  const local = t + tzOffsetSeconds(t, ET);
  const day = Math.floor(local / 86400);
  const hour = Math.floor((local - day * 86400) / 3600);
  return isoDay(hour >= 18 ? day + 1 : day);
}

function parseDay(day: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new EngineError(`Bad trading day: ${day}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Open of a trading day: 18:00 ET on the previous calendar day. */
export function tradingDayStart(day: string): UnixSeconds {
  const p = parseDay(day);
  return zonedToUnix({ year: p.year, month: p.month, day: p.day - 1, hour: 18 }, ET);
}

/** 0 = Sunday .. 6 = Saturday, for a 'YYYY-MM-DD' label. */
export function weekdayOfDay(day: string): number {
  const p = parseDay(day);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** The label `n` calendar days after `day`. */
export function addDays(day: string, n: number): string {
  const p = parseDay(day);
  return isoDay(Math.floor(Date.UTC(p.year, p.month - 1, p.day + n) / 86400000));
}
