import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors';
import { addDays, bucketStart, etParts, tradingDay, tradingDayStart, weekdayOfDay, zonedToUnix } from '../src/time';
import { utc } from './helpers';

describe('bucketStart: epoch aligned timeframes', () => {
  it('1m floors to the minute', () => {
    expect(bucketStart(utc('2024-01-02T15:00:37Z'), '1m')).toBe(utc('2024-01-02T15:00:00Z'));
  });
  it('3m buckets are epoch aligned (:00, :03, :06 ...)', () => {
    expect(bucketStart(utc('2024-01-02T15:02:59Z'), '3m')).toBe(utc('2024-01-02T15:00:00Z'));
    expect(bucketStart(utc('2024-01-02T15:03:00Z'), '3m')).toBe(utc('2024-01-02T15:03:00Z'));
    expect(bucketStart(utc('2024-01-02T15:05:00Z'), '3m')).toBe(utc('2024-01-02T15:03:00Z'));
    expect(bucketStart(utc('2024-01-02T15:06:00Z'), '3m')).toBe(utc('2024-01-02T15:06:00Z'));
    expect(bucketStart(utc('2024-01-02T15:59:00Z'), '3m')).toBe(utc('2024-01-02T15:57:00Z'));
  });
  it('5m, 15m, 30m, 1h', () => {
    expect(bucketStart(utc('2024-01-02T15:07:00Z'), '5m')).toBe(utc('2024-01-02T15:05:00Z'));
    expect(bucketStart(utc('2024-01-02T15:29:59Z'), '15m')).toBe(utc('2024-01-02T15:15:00Z'));
    expect(bucketStart(utc('2024-01-02T15:44:00Z'), '30m')).toBe(utc('2024-01-02T15:30:00Z'));
    expect(bucketStart(utc('2024-01-02T15:59:59Z'), '1h')).toBe(utc('2024-01-02T15:00:00Z'));
  });
  it('throws EngineError on an unknown timeframe', () => {
    expect(() => bucketStart(0, '2h' as never)).toThrow(EngineError);
  });
});

describe('bucketStart: 4h anchored to 18:00 America/New_York', () => {
  it('winter (EST, UTC-5): anchors are 23:00Z, 03:00Z, 07:00Z, 11:00Z, 15:00Z, 19:00Z', () => {
    const cases: [string, string][] = [
      ['2024-01-02T15:00:00Z', '2024-01-02T15:00:00Z'], // 10:00 ET
      ['2024-01-02T18:59:00Z', '2024-01-02T15:00:00Z'], // 13:59 ET
      ['2024-01-02T19:00:00Z', '2024-01-02T19:00:00Z'], // 14:00 ET
      ['2024-01-02T21:59:00Z', '2024-01-02T19:00:00Z'], // 16:59 ET, the last bar before the halt: cut short bucket
      ['2024-01-02T23:00:00Z', '2024-01-02T23:00:00Z'], // 18:00 ET
      ['2024-01-03T02:59:00Z', '2024-01-02T23:00:00Z'], // 21:59 ET
      ['2024-01-03T03:00:00Z', '2024-01-03T03:00:00Z'], // 22:00 ET
      ['2024-01-03T06:59:00Z', '2024-01-03T03:00:00Z'], // 01:59 ET belongs to the 22:00 bucket
      ['2024-01-03T07:00:00Z', '2024-01-03T07:00:00Z'], // 02:00 ET
      ['2024-01-03T11:00:00Z', '2024-01-03T11:00:00Z'], // 06:00 ET
    ];
    for (const [t, expected] of cases) expect(bucketStart(utc(t), '4h'), t).toBe(utc(expected));
  });
  it('summer (EDT, UTC-4): 18:00 ET is 22:00Z', () => {
    expect(bucketStart(utc('2024-07-01T14:00:00Z'), '4h')).toBe(utc('2024-07-01T14:00:00Z')); // 10:00 EDT
    expect(bucketStart(utc('2024-07-01T13:59:00Z'), '4h')).toBe(utc('2024-07-01T10:00:00Z')); // 09:59 EDT -> 06:00 EDT
    expect(bucketStart(utc('2024-07-01T22:00:00Z'), '4h')).toBe(utc('2024-07-01T22:00:00Z')); // 18:00 EDT
  });
  it('spring forward week (Sun 2024-03-10, EST to EDT)', () => {
    expect(bucketStart(utc('2024-03-08T21:59:00Z'), '4h')).toBe(utc('2024-03-08T19:00:00Z')); // Fri 16:59 EST -> 14:00 EST
    expect(bucketStart(utc('2024-03-10T22:00:00Z'), '4h')).toBe(utc('2024-03-10T22:00:00Z')); // Sun 18:00 EDT
    expect(bucketStart(utc('2024-03-11T01:59:00Z'), '4h')).toBe(utc('2024-03-10T22:00:00Z')); // Sun 21:59 EDT
    expect(bucketStart(utc('2024-03-11T02:00:00Z'), '4h')).toBe(utc('2024-03-11T02:00:00Z')); // Sun 22:00 EDT
    expect(bucketStart(utc('2024-03-11T06:30:00Z'), '4h')).toBe(utc('2024-03-11T06:00:00Z')); // Mon 02:30 EDT -> 02:00 EDT
    expect(bucketStart(utc('2024-03-11T13:59:00Z'), '4h')).toBe(utc('2024-03-11T10:00:00Z')); // Mon 09:59 EDT -> 06:00 EDT
    expect(bucketStart(utc('2024-03-11T14:00:00Z'), '4h')).toBe(utc('2024-03-11T14:00:00Z')); // Mon 10:00 EDT
    expect(bucketStart(utc('2024-03-11T20:59:00Z'), '4h')).toBe(utc('2024-03-11T18:00:00Z')); // Mon 16:59 EDT -> 14:00 EDT
  });
  it('fall back week (Sun 2024-11-03, EDT to EST)', () => {
    expect(bucketStart(utc('2024-11-01T20:59:00Z'), '4h')).toBe(utc('2024-11-01T18:00:00Z')); // Fri 16:59 EDT -> 14:00 EDT
    expect(bucketStart(utc('2024-11-03T23:00:00Z'), '4h')).toBe(utc('2024-11-03T23:00:00Z')); // Sun 18:00 EST
    expect(bucketStart(utc('2024-11-04T03:00:00Z'), '4h')).toBe(utc('2024-11-04T03:00:00Z')); // Sun 22:00 EST
    expect(bucketStart(utc('2024-11-04T14:59:00Z'), '4h')).toBe(utc('2024-11-04T11:00:00Z')); // Mon 09:59 EST -> 06:00 EST
    expect(bucketStart(utc('2024-11-04T15:00:00Z'), '4h')).toBe(utc('2024-11-04T15:00:00Z')); // Mon 10:00 EST
  });
  it('both copies of the repeated 01:xx hour land in the same bucket (the 22:00 ET Saturday anchor)', () => {
    const anchor = utc('2024-11-03T02:00:00Z'); // Sat 22:00 EDT
    expect(bucketStart(utc('2024-11-03T05:30:00Z'), '4h')).toBe(anchor); // 01:30 EDT
    expect(bucketStart(utc('2024-11-03T06:30:00Z'), '4h')).toBe(anchor); // 01:30 EST
  });
  it('is total even inside the spring forward gap (anchor 02:00 does not exist, shifts to 03:00 EDT)', () => {
    expect(bucketStart(utc('2024-03-10T06:59:00Z'), '4h')).toBe(utc('2024-03-10T03:00:00Z')); // 01:59 EST -> Sat 22:00 EST
    expect(bucketStart(utc('2024-03-10T07:30:00Z'), '4h')).toBe(utc('2024-03-10T07:00:00Z')); // 03:30 EDT -> 03:00 EDT
  });
});

describe('bucketStart: 1D is one candle per trading day (18:00 to 17:00 ET)', () => {
  it('winter', () => {
    expect(bucketStart(utc('2024-01-02T15:00:00Z'), '1D')).toBe(utc('2024-01-01T23:00:00Z')); // Tue 10:00 ET -> Mon 18:00 ET
    expect(bucketStart(utc('2024-01-02T22:30:00Z'), '1D')).toBe(utc('2024-01-01T23:00:00Z')); // 17:30 ET still Mon 18:00's bucket
    expect(bucketStart(utc('2024-01-02T23:00:00Z'), '1D')).toBe(utc('2024-01-02T23:00:00Z')); // Tue 18:00 opens a new day
    expect(bucketStart(utc('2024-01-03T04:00:00Z'), '1D')).toBe(utc('2024-01-02T23:00:00Z')); // Tue 23:00 ET
  });
  it('Sunday 18:00 opens Monday', () => {
    expect(bucketStart(utc('2024-01-07T23:00:00Z'), '1D')).toBe(utc('2024-01-07T23:00:00Z'));
    expect(bucketStart(utc('2024-01-08T15:00:00Z'), '1D')).toBe(utc('2024-01-07T23:00:00Z')); // Mon 10:00 ET
  });
  it('spring forward week: day lengths stay 23h of bars, starts move from 23:00Z to 22:00Z', () => {
    expect(bucketStart(utc('2024-03-08T21:59:00Z'), '1D')).toBe(utc('2024-03-07T23:00:00Z')); // Fri 16:59 EST
    expect(bucketStart(utc('2024-03-10T22:00:00Z'), '1D')).toBe(utc('2024-03-10T22:00:00Z')); // Sun 18:00 EDT
    expect(bucketStart(utc('2024-03-11T13:30:00Z'), '1D')).toBe(utc('2024-03-10T22:00:00Z')); // Mon 09:30 EDT
    expect(bucketStart(utc('2024-03-11T20:59:00Z'), '1D')).toBe(utc('2024-03-10T22:00:00Z')); // Mon 16:59 EDT
    expect(bucketStart(utc('2024-03-11T22:00:00Z'), '1D')).toBe(utc('2024-03-11T22:00:00Z')); // Mon 18:00 EDT
  });
  it('fall back week: starts move from 22:00Z to 23:00Z', () => {
    expect(bucketStart(utc('2024-11-01T20:59:00Z'), '1D')).toBe(utc('2024-10-31T22:00:00Z')); // Fri 16:59 EDT
    expect(bucketStart(utc('2024-11-03T23:00:00Z'), '1D')).toBe(utc('2024-11-03T23:00:00Z')); // Sun 18:00 EST
    expect(bucketStart(utc('2024-11-04T14:30:00Z'), '1D')).toBe(utc('2024-11-03T23:00:00Z')); // Mon 09:30 EST
    expect(bucketStart(utc('2024-11-04T23:00:00Z'), '1D')).toBe(utc('2024-11-04T23:00:00Z')); // Mon 18:00 EST
  });
});

describe('tradingDay (18:00 ET rollover)', () => {
  it('before and after the 18:00 rollover', () => {
    expect(tradingDay(utc('2024-01-02T15:00:00Z'))).toBe('2024-01-02'); // Tue 10:00 ET
    expect(tradingDay(utc('2024-01-02T22:59:00Z'))).toBe('2024-01-02'); // 17:59 ET
    expect(tradingDay(utc('2024-01-02T23:00:00Z'))).toBe('2024-01-03'); // 18:00 ET is Wednesday's day
  });
  it('Sunday 18:00 ET opens Monday', () => {
    expect(tradingDay(utc('2024-01-07T22:59:00Z'))).toBe('2024-01-07');
    expect(tradingDay(utc('2024-01-07T23:00:00Z'))).toBe('2024-01-08');
    expect(tradingDay(utc('2024-01-08T00:00:00Z'))).toBe('2024-01-08'); // Sun 19:00 ET
  });
  it('is DST aware (Sunday 18:00 EDT is 22:00Z, not 23:00Z)', () => {
    expect(tradingDay(utc('2024-03-10T21:59:00Z'))).toBe('2024-03-10');
    expect(tradingDay(utc('2024-03-10T22:00:00Z'))).toBe('2024-03-11');
    expect(tradingDay(utc('2024-11-03T22:59:00Z'))).toBe('2024-11-03'); // Sun 17:59 EST (after fall back)
    expect(tradingDay(utc('2024-11-03T23:00:00Z'))).toBe('2024-11-04');
  });
  it('handles month, year and leap day boundaries', () => {
    expect(tradingDay(utc('2024-12-31T23:00:00Z'))).toBe('2025-01-01');
    expect(tradingDay(utc('2024-02-28T23:00:00Z'))).toBe('2024-02-29');
    expect(tradingDay(utc('2024-02-29T23:00:00Z'))).toBe('2024-03-01');
  });
  it('tradingDayStart is 18:00 ET of the previous calendar day', () => {
    expect(tradingDayStart('2024-01-02')).toBe(utc('2024-01-01T23:00:00Z'));
    expect(tradingDayStart('2024-03-11')).toBe(utc('2024-03-10T22:00:00Z')); // Monday after spring forward
    expect(tradingDayStart('2024-03-01')).toBe(utc('2024-02-29T23:00:00Z'));
  });
});

describe('etParts', () => {
  it('reads ET wall clock fields and weekday (0 = Sunday)', () => {
    expect(etParts(utc('2024-01-02T15:00:00Z'))).toEqual({ year: 2024, month: 1, day: 2, hour: 10, minute: 0, second: 0, weekday: 2 });
    expect(etParts(utc('2024-01-07T23:00:00Z'))).toMatchObject({ day: 7, hour: 18, weekday: 0 });
  });
  it('switches offset at the DST instant', () => {
    expect(etParts(utc('2024-03-10T06:59:59Z'))).toMatchObject({ hour: 1, minute: 59, second: 59 });
    expect(etParts(utc('2024-03-10T07:00:00Z'))).toMatchObject({ hour: 3, minute: 0, second: 0 });
    expect(etParts(utc('2024-11-03T05:59:59Z'))).toMatchObject({ hour: 1, minute: 59 });
    expect(etParts(utc('2024-11-03T06:00:00Z'))).toMatchObject({ hour: 1, minute: 0 }); // second 01:00, now EST
  });
});

describe('zonedToUnix', () => {
  it('converts wall clock in a zone to unix seconds', () => {
    expect(zonedToUnix({ year: 2024, month: 1, day: 2, hour: 10 }, 'America/New_York')).toBe(utc('2024-01-02T15:00:00Z'));
    expect(zonedToUnix({ year: 2024, month: 7, day: 1, hour: 10 }, 'America/New_York')).toBe(utc('2024-07-01T14:00:00Z'));
    expect(zonedToUnix({ year: 2024, month: 1, day: 2, hour: 9 }, 'Asia/Tokyo')).toBe(utc('2024-01-02T00:00:00Z'));
    expect(zonedToUnix({ year: 2024, month: 1, day: 2, hour: 9, minute: 30, second: 15 }, 'UTC')).toBe(utc('2024-01-02T09:30:15Z'));
  });
  it('picks the first occurrence of an ambiguous local time (fall back)', () => {
    expect(zonedToUnix({ year: 2024, month: 11, day: 3, hour: 1, minute: 30 }, 'America/New_York')).toBe(utc('2024-11-03T05:30:00Z'));
  });
  it('shifts a nonexistent local time forward (spring forward gap)', () => {
    expect(zonedToUnix({ year: 2024, month: 3, day: 10, hour: 2, minute: 30 }, 'America/New_York')).toBe(utc('2024-03-10T07:30:00Z'));
  });
  it('throws EngineError on an unknown timezone', () => {
    expect(() => zonedToUnix({ year: 2024, month: 1, day: 2 }, 'Mars/Olympus')).toThrow(EngineError);
  });
});

describe('day label helpers', () => {
  it('addDays crosses month, year and leap day', () => {
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('weekdayOfDay: 0 = Sunday', () => {
    expect(weekdayOfDay('2024-01-07')).toBe(0);
    expect(weekdayOfDay('2024-01-08')).toBe(1);
    expect(weekdayOfDay('2024-01-06')).toBe(6);
  });
  it('rejects a malformed day', () => {
    expect(() => tradingDayStart('2024-1-2')).toThrow(EngineError);
  });
});
