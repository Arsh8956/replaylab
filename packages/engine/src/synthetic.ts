import { CONTRACTS, roundToTick } from './contracts';
import { EngineError } from './errors';
import { createRng } from './rng';
import { tradingDay, tradingDayStart, addDays, weekdayOfDay, zonedToUnix } from './time';
import type { Bar, UnixSeconds } from './types';

/**
 * Synthetic 1m futures bars. Seeded and deterministic; nothing here reads the clock.
 *
 * Model per minute (ET wall clock drives the shape):
 *  - volatility = base sigma * session multiplier * a slow log AR(1) factor (volatility clustering) * rare news shocks
 *  - a Markov regime: trend up, trend down, or range. Trends add drift, ranges pull price back to where the range began
 *  - volume follows a U shaped intraday profile, scaled by how active the minute is
 *  - prices are snapped to the tick grid, OHLC kept valid
 * No bars during the 17:00 to 18:00 ET halt or Fri 17:00 to Sun 18:00 ET. Holidays are not modeled.
 */

interface Profile {
  startPrice: number;
  /** Per minute return standard deviation at session multiplier 1. */
  sigma: number;
  /** Mean volume per minute at volume shape 1. */
  baseVolume: number;
}

const PROFILES: Record<string, Profile> = {
  NQ: { startPrice: 21000, sigma: 0.0003, baseVolume: 1100 },
  ES: { startPrice: 6000, sigma: 0.00025, baseVolume: 2600 },
  YM: { startPrice: 44000, sigma: 0.00023, baseVolume: 600 },
  RTY: { startPrice: 2300, sigma: 0.00034, baseVolume: 450 },
  CL: { startPrice: 70, sigma: 0.00045, baseVolume: 900 },
  GC: { startPrice: 2700, sigma: 0.00023, baseVolume: 400 },
};

/** Linear interpolation over [hour, value] control points, hour in ET 0..24, wrapping at midnight. */
function profileAt(points: readonly (readonly [number, number])[], minuteOfDay: number): number {
  const h = minuteOfDay / 60;
  let prev = points[points.length - 1]!;
  let prevH = prev[0] - 24;
  for (const pt of points) {
    if (h < pt[0]) {
      const span = pt[0] - prevH;
      return prev[1] + ((pt[1] - prev[1]) * (h - prevH)) / span;
    }
    prev = pt;
    prevH = pt[0];
  }
  const first = points[0]!;
  const span = first[0] + 24 - prevH;
  return prev[1] + ((first[1] - prev[1]) * (h - prevH)) / span;
}

// Quiet Asia, active London, busiest 09:30 to 11:00 ET, a lull at lunch, a lift into the close.
const VOL_POINTS = [
  [0, 0.4], [2.99, 0.5], [3, 0.9], [5, 0.8], [7, 0.8], [8.25, 0.95], [8.5, 1.4], [8.75, 1.0],
  [9.4, 1.0], [9.5, 2.4], [9.75, 2.0], [10.5, 1.7], [10.99, 1.5], [11, 1.25], [12, 0.9],
  [13, 0.7], [14, 0.8], [15, 1.0], [15.75, 1.15], [16, 0.7], [16.5, 0.5], [17, 0.45],
  [18, 0.6], [19, 0.45], [21, 0.38], [23, 0.38],
] as const;

// U shaped volume in the cash session: heavy open, light midday, heavier into the close; thin overnight.
const VOLUME_POINTS = [
  [0, 0.3], [2.99, 0.3], [3, 0.7], [7, 0.6], [8.5, 1.1], [9, 0.9], [9.4, 1.2], [9.5, 4.5],
  [10, 3.0], [10.5, 2.0], [11, 1.5], [12, 1.0], [13.5, 0.9], [14.5, 1.2], [15, 1.8], [15.75, 2.4],
  [16, 1.0], [16.5, 0.45], [17, 0.35], [18, 0.5], [19, 0.35], [21, 0.25], [23, 0.25],
] as const;

/** Relative volatility of a minute, by ET minute of the day (0..1439). Exported for tests, not part of the public API. */
export function sessionVolMultiplier(minuteOfDay: number): number {
  return profileAt(VOL_POINTS, minuteOfDay);
}

export function sessionVolumeShape(minuteOfDay: number): number {
  return profileAt(VOLUME_POINTS, minuteOfDay);
}

const PHI = 0.985; // volatility memory per minute (half life about 46 minutes)
const VOL_OF_VOL = 0.35; // stationary standard deviation of the log volatility factor
const ETA = VOL_OF_VOL * Math.sqrt(1 - PHI * PHI);

type Regime = -1 | 0 | 1;

export interface SyntheticOptions {
  root: string;
  start: UnixSeconds;
  days: number;
  seed: number;
  startPrice?: number;
}

export function generateSyntheticBars(opts: SyntheticOptions): Bar[] {
  return generateSyntheticSeries(opts).bars;
}

/** Same bars plus the hidden regime of each minute (1 trend up, -1 trend down, 0 range). For tests, not exported from index. */
export function generateSyntheticSeries(opts: SyntheticOptions): { bars: Bar[]; regimes: Regime[] } {
  const contract = CONTRACTS[opts.root];
  if (!contract) throw new EngineError(`Unknown root: ${String(opts.root)}`);
  const profile = PROFILES[contract.root];
  if (!profile) throw new EngineError(`No synthetic profile for ${contract.root}`);
  if (!Number.isInteger(opts.days) || opts.days < 0) throw new EngineError('days must be an integer >= 0');
  if (!Number.isFinite(opts.start)) throw new EngineError('start must be a number');
  if (opts.startPrice !== undefined && !(opts.startPrice > 0)) throw new EngineError('startPrice must be > 0');

  const tick = contract.tickSize;
  const rng = createRng(opts.seed);
  const bars: Bar[] = [];
  const regimes: Regime[] = [];
  if (opts.days === 0) return { bars, regimes };

  const startPrice = roundToTick(opts.startPrice ?? profile.startPrice, tick);
  const floor = Math.max(tick * 10, startPrice * 0.2);
  let price = startPrice;
  let regime: Regime = 0;
  let anchor = price; // where a ranging stretch began; ranges pull back toward it
  let logVol = 0;
  let first = true;
  let daysDone = 0;

  let label = tradingDay(opts.start);
  let firstDay = true;
  let prevWeekday = -1;

  while (daysDone < opts.days) {
    const wd = weekdayOfDay(label);
    if (wd === 0 || wd === 6) {
      label = addDays(label, 1);
      continue;
    }
    const open = tradingDayStart(label);
    const close = zonedToUnix({ year: +label.slice(0, 4), month: +label.slice(5, 7), day: +label.slice(8, 10), hour: 17 }, 'America/New_York');
    let t = open;
    if (firstDay) t = Math.max(open, Math.ceil(opts.start / 60) * 60);
    firstDay = false;
    if (t >= close) {
      label = addDays(label, 1);
      continue;
    }

    // overnight gap into a new trading day (bigger after the weekend)
    if (!first) {
      const afterWeekend = prevWeekday === 5;
      const gap = rng.normal() * profile.sigma * (afterWeekend ? 4 : 1.5);
      price = Math.max(floor, roundToTick(price * (1 + gap), tick));
      anchor = price;
    }
    first = false;
    prevWeekday = wd;

    for (; t < close; t += 60) {
      const minuteOfDay = (1080 + (t - open) / 60) % 1440;
      const mult = sessionVolMultiplier(minuteOfDay);

      // regime switching: trends last about 80 minutes, ranges about 150
      const u = rng.next();
      if (regime === 0) {
        if (u < 1 / 150) regime = rng.next() < 0.5 ? 1 : -1;
      } else if (u < 1 / 80) {
        regime = 0;
        anchor = price;
      }

      // volatility clustering plus the occasional news shock
      logVol = PHI * logVol + ETA * rng.normal();
      if (rng.next() < 0.0008) logVol += 0.5 + rng.next() * 0.7;
      const sigma = profile.sigma * mult * Math.exp(logVol - (VOL_OF_VOL * VOL_OF_VOL) / 2);

      const z = rng.normal();
      const shock = rng.next() < 0.03 ? 2.2 : 1; // fat tails
      let ret = sigma * z * shock;
      if (regime !== 0) ret += regime * 0.18 * sigma;
      else ret -= 0.02 * ((price - anchor) / price);

      const o = price;
      const c = Math.max(floor, roundToTick(o * (1 + ret), tick));
      const wick = (extra: number) => roundToTick(o * sigma * 0.5 * Math.abs(rng.normal()) + extra * tick, tick);
      const h = Math.max(o, c, roundToTick(Math.max(o, c) + wick(rng.next() * 1.2), tick));
      const l = Math.max(tick, Math.min(o, c, roundToTick(Math.min(o, c) - wick(rng.next() * 1.2), tick)));

      // U shaped volume, scaled by how lively the minute is, with log normal noise
      const lively = Math.exp(0.5 * (logVol - (VOL_OF_VOL * VOL_OF_VOL) / 2));
      const volume = Math.max(1, Math.round(profile.baseVolume * sessionVolumeShape(minuteOfDay) * lively * Math.exp(0.35 * rng.normal() - 0.06)));

      bars.push({ time: t, open: o, high: h, low: l, close: c, volume });
      regimes.push(regime);
      price = c;
    }
    daysDone++;
    label = addDays(label, 1);
  }
  return { bars, regimes };
}
