// QA: CSV. Malformed rows, mixed timezones, duplicate timestamps, unsorted input, DST wall clocks, and
// agreement with the Python data service on shared fixtures (packages/engine/test/fixtures).
import { describe, expect, it } from 'vitest';
import { EngineError, ReplayEngine, parseBarsCsv } from '../src/index';
import { CONTRACTS } from '../src/index';
import clNegative from './fixtures/cl-negative-2020-04-20.api.json';
import fall from './fixtures/dst-weeks-ny.fall.api.json';
import spring from './fixtures/dst-weeks-ny.spring.api.json';
import { lcg, utc } from './helpers';

const files = import.meta.glob('./fixtures/*.csv', { query: '?raw', import: 'default', eager: true });
const fixtureText = (name: string): string => {
  const key = Object.keys(files).find((k) => k.endsWith(name));
  if (!key) throw new Error(`fixture ${name} missing`);
  return files[key]!;
};

const H = 'time,open,high,low,close,volume\n';
const row = (t: string, o = 100, h = 101, l = 99, c = 100.5, v = 10): string => `${t},${o},${h},${l},${c},${v}\n`;

describe('shared fixtures: the engine CSV parser and the Python importer + HTTP endpoint must agree on every bar', () => {
  it('New York wall clock times across both DST weekends parse to exactly the bars the data service serves', () => {
    const res = parseBarsCsv(fixtureText('dst-weeks-ny.csv'), { timezone: 'America/New_York' });
    expect(res.errors).toEqual([]);
    expect(res.bars).toEqual([...spring, ...fall]);
  });

  it('hand computed instants: Sunday 18:00 after spring forward is 22:00Z, after fall back 23:00Z', () => {
    const res = parseBarsCsv(fixtureText('dst-weeks-ny.csv'), { timezone: 'America/New_York' });
    const times = res.bars.map((b) => b.time);
    expect(times).toContain(utc('2024-03-10T22:00:00Z'));
    expect(times).toContain(utc('2024-11-03T23:00:00Z'));
    expect(times).toContain(utc('2024-03-08T21:58:00Z'));
    expect(times).toContain(utc('2024-11-04T14:30:00Z'));
  });

  it('the served JSON is a valid Bar[] for the engine and a replay over it runs through the DST weekend', () => {
    const bars = [...spring, ...fall];
    for (const b of bars) {
      expect(Object.keys(b)).toEqual(['time', 'open', 'high', 'low', 'close', 'volume']);
      expect(Number.isInteger(b.time) && Number.isInteger(b.volume)).toBe(true);
    }
    const e = new ReplayEngine({ bars: spring, contract: CONTRACTS['NQ']!, startTime: spring[0]!.time });
    e.placeOrder({ side: 'long', type: 'market', qty: 1 });
    e.step(10);
    expect(e.isAtEnd()).toBe(true);
    expect(e.trades).toHaveLength(1);
    expect(e.getVisibleBars('1D').map((c) => c.time)).toEqual([utc('2024-03-07T23:00:00Z'), utc('2024-03-10T22:00:00Z')]);
  });

  it('BUG?: CL below zero (2020-04-20) is real data the data service accepts and serves; the engine CSV parser rejects every such row', () => {
    const res = parseBarsCsv(fixtureText('cl-negative-2020-04-20.csv'));
    expect(res.errors, 'rows the engine refused').toEqual([]);
    expect(res.bars).toEqual(clNegative);
  });

  it('the served negative price bars replay fine in the engine (so only the CSV door is shut)', () => {
    const e = new ReplayEngine({ bars: clNegative, contract: CONTRACTS['CL']!, startTime: clNegative[0]!.time });
    e.stepTo(clNegative[2]!.time);
    expect(e.lastPrice).toBe(-36.98);
    expect(e.getVisibleBars('5m')[0]!.low).toBe(-37.63);
  });
});

describe('cross pipeline consistency: what the data service rejects, the engine parser should reject too', () => {
  it('BUG?: a time that is not on a whole minute (09:30:30) is a bad row in the data service but a bar here', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:30:30Z'));
    expect(res.bars, 'engine accepted a non minute aligned bar').toEqual([]);
    expect(res.errors).toHaveLength(1);
  });

  it('BUG?: a fractional volume (1.5) is a bad row in the data service (volume is int64) but a bar here', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:30:00Z', 100, 101, 99, 100.5, 1.5));
    expect(res.bars.every((b) => Number.isInteger(b.volume)), 'engine accepted a fractional volume').toBe(true);
  });

  it('both reject: zero prices, open or close outside the range, high below low, negative volume', () => {
    const text = H + row('2024-01-02T14:30:00Z', 0, 1, 0, 1) + row('2024-01-02T14:31:00Z', 105, 101, 99, 100) + row('2024-01-02T14:32:00Z', 100, 98, 99, 100) + row('2024-01-02T14:33:00Z', 100, 101, 99, 100, -1);
    const res = parseBarsCsv(text);
    expect(res.bars).toEqual([]);
    expect(res.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
  });
});

describe('malformed rows', () => {
  it('a stray quote only spoils its own line (the rows after it survive)', () => {
    const good = Array.from({ length: 10 }, (_, i) => row(`2024-01-02T15:${String(i).padStart(2, '0')}:00Z`)).join('');
    const text = H + row('2024-01-02T14:30:00Z') + '2024-01-02T14:31:00Z,"100,101,99,100.5,10\n' + good;
    const res = parseBarsCsv(text);
    expect(res.bars).toHaveLength(11);
    expect(res.errors.map((e) => e.line)).toEqual([3]);
  });

  it('numbers that look like numbers but are not: thousands separators, hex, units, spaces, unicode digits, empty', () => {
    const cells = ['21,000.25', '0x10', '21000.25USD', '21 000', '٢١٠٠٠', '', 'NaN', 'Infinity', '1e', '--5', '1.2.3', '$21000'];
    const text = H + cells.map((c, i) => `2024-01-02T14:${String(30 + i).padStart(2, '0')}:00Z,"${c}",101,99,100,5\n`).join('');
    const res = parseBarsCsv(text);
    expect(res.bars).toEqual([]);
    expect(res.errors.map((e) => e.line)).toEqual(cells.map((_, i) => i + 2));
  });

  it('numbers that are fine: leading plus, exponent, bare decimals', () => {
    const text = H + '2024-01-02T14:30:00Z,+100,1.01e2,.99e2,100.,5\n';
    const res = parseBarsCsv(text);
    expect(res.errors).toEqual([]);
    expect(res.bars[0]).toMatchObject({ open: 100, high: 101, low: 99, close: 100 });
  });

  it('impossible calendar dates and clock times are bad rows', () => {
    const stamps = ['2024-02-30T14:30:00Z', '2023-02-29 14:30:00', '2024-13-01 00:00:00', '2024-01-32 00:00:00', '2024-01-02 24:00:00', '2024-01-02 23:60:00', '2024-01-02 23:59:60', '01/32/2024 10:00', '13/01/2024 10:00', '2024-1-2T', 'yesterday', '9:30', '2024-01-02T14:30:00+25:00x'];
    const res = parseBarsCsv(H + stamps.map((s) => row(s)).join(''));
    expect(res.bars).toEqual([]);
    expect(res.errors).toHaveLength(stamps.length);
  });

  it('wrong field counts: short rows, long rows with data, long rows with only empty extras', () => {
    const text = H + '2024-01-02T14:30:00Z,1,2\n' + '2024-01-02T14:31:00Z,100,101,99,100,5,extra\n' + '2024-01-02T14:32:00Z,100,101,99,100,5,,\n';
    const res = parseBarsCsv(text);
    expect(res.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(res.bars).toHaveLength(1);
  });

  it('a 12 AM / 12 PM clock is read correctly (12:30 AM is 00:30, 12:30 PM is 12:30)', () => {
    const text = 'Date,Time,Open,High,Low,Close,Volume\n01/02/2024,12:30:00 AM,1,2,0.5,1,5\n01/02/2024,12:30:00 PM,1,2,0.5,1,5\n01/02/2024,1:05:00 PM,1,2,0.5,1,5\n01/02/2024,13:05:00 PM,1,2,0.5,1,5\n';
    const res = parseBarsCsv(text);
    expect(res.bars.map((b) => b.time)).toEqual([utc('2024-01-02T00:30:00Z'), utc('2024-01-02T12:30:00Z'), utc('2024-01-02T13:05:00Z')]);
    expect(res.errors.map((e) => e.line)).toEqual([5]);
  });

  it('Databento style nanosecond ISO stamps and an extra symbol column parse', () => {
    const text = 'ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol\n2024-01-02T14:30:00.000000000Z,33,1,42,21000.25,21001,20999.5,21000.75,120,NQH4\n';
    const res = parseBarsCsv(text);
    expect(res.errors).toEqual([]);
    expect(res.bars).toEqual([{ time: utc('2024-01-02T14:30:00Z'), open: 21000.25, high: 21001, low: 20999.5, close: 21000.75, volume: 120 }]);
  });

  it('every input row is accounted for, even in a 20000 row file with 5 percent damage', () => {
    const rand = lcg(3);
    const lines: string[] = [];
    let expectedBad = 0;
    for (let i = 0; i < 20000; i++) {
      const t = new Date((utc('2024-01-02T14:30:00Z') + i * 60) * 1000).toISOString().replace('.000Z', 'Z');
      const r = rand();
      if (r < 0.01) (lines.push(`${t},abc,1,1,1,1`), expectedBad++);
      else if (r < 0.02) (lines.push(`${t},1,2`), expectedBad++);
      else if (r < 0.03) (lines.push(`garbage ${i},1,2,0.5,1,5`), expectedBad++);
      else if (r < 0.04) (lines.push(`${t},1,0.5,2,1,5`), expectedBad++);
      else if (r < 0.05) (lines.push(`${t},1,2,0.5,1,-5`), expectedBad++);
      else lines.push(`${t},1,2,0.5,1,5`);
    }
    const res = parseBarsCsv(H + lines.join('\n') + '\n');
    expect(res.errors).toHaveLength(expectedBad);
    expect(res.bars.length + res.errors.length).toBe(20000);
    expect(res.errors.map((e) => e.line)).toEqual([...res.errors.map((e) => e.line)].sort((a, b) => a - b));
  });
});

describe('timezones', () => {
  it('rows with their own offset, rows with Z, naive rows and epoch rows can share a file; each is read in its own terms', () => {
    const text =
      H +
      row('2024-01-02T09:32:00-05:00') + // 14:32Z
      row('2024-01-02T14:30:00Z') + // 14:30Z
      row('2024-01-02T20:31:00+05:30') + // 15:01Z
      row('2024-01-02 09:31:00') + // naive, tz option New York: 14:31Z
      row('1704205980'); // epoch 14:33Z
    const res = parseBarsCsv(text, { timezone: 'America/New_York' });
    expect(res.errors).toEqual([]);
    const base = utc('2024-01-02T14:30:00Z');
    expect(res.bars.map((b) => b.time)).toEqual([base, base + 60, base + 120, base + 180, base + 31 * 60]);
  });

  it('naive times are DST aware per row: the same wall time in January and July differ by an hour in UTC', () => {
    const res = parseBarsCsv(H + row('2024-01-09 09:30:00') + row('2024-07-09 09:30:00'), { timezone: 'America/New_York' });
    expect(res.bars.map((b) => b.time)).toEqual([utc('2024-01-09T14:30:00Z'), utc('2024-07-09T13:30:00Z')]);
  });

  it('spring forward: every minute of the missing hour is a reported bad row, and the minutes either side are fine', () => {
    const lines = [];
    for (let m = 0; m < 180; m++) lines.push(`2024-03-10 0${Math.floor(m / 60) + 1}:${String(m % 60).padStart(2, '0')}:00,100,101,99,100,1`);
    const res = parseBarsCsv(H + lines.join('\n') + '\n', { timezone: 'America/New_York' });
    // 01:00 to 01:59 exist (60), 02:00 to 02:59 do not (60), 03:00 to 03:59 exist (60)
    expect(res.bars).toHaveLength(120);
    expect(res.errors).toHaveLength(60);
    expect(res.errors.every((e) => e.line >= 62 && e.line <= 121)).toBe(true);
  });

  it('same wall clock text in two different zones lands on different instants', () => {
    const t = H + row('2024-03-11 09:30:00');
    const ny = parseBarsCsv(t, { timezone: 'America/New_York' }).bars[0]!.time;
    const chi = parseBarsCsv(t, { timezone: 'America/Chicago' }).bars[0]!.time;
    const tokyo = parseBarsCsv(t, { timezone: 'Asia/Tokyo' }).bars[0]!.time;
    expect([ny, chi, tokyo]).toEqual([utc('2024-03-11T13:30:00Z'), utc('2024-03-11T14:30:00Z'), utc('2024-03-11T00:30:00Z')]);
  });

  it('an invalid timezone name is an EngineError, not a silent UTC', () => {
    expect(() => parseBarsCsv(H + row('2024-01-02 09:30:00'), { timezone: 'Mars/Olympus' })).toThrow(EngineError);
    expect(() => parseBarsCsv(H + row('2024-01-02 09:30:00'), { timezone: 'EST5EDT' })).not.toThrow();
  });
});

describe('duplicates and unsorted input', () => {
  it('a completely reversed file comes out ascending and complete', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`2024-01-02T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`)).reverse().join('');
    const res = parseBarsCsv(H + rows);
    expect(res.errors).toEqual([]);
    expect(res.bars).toHaveLength(300);
    expect(res.bars.map((b) => b.time)).toEqual([...res.bars.map((b) => b.time)].sort((a, b) => a - b));
  });

  it('triplicates keep the first line, report the other two with their own physical lines', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:30:00Z', 1, 2, 0.5, 1, 11) + row('2024-01-02T14:30:00Z', 1, 2, 0.5, 1, 22) + row('2024-01-02T14:30:00Z', 1, 2, 0.5, 1, 33));
    expect(res.bars).toHaveLength(1);
    expect(res.bars[0]!.volume).toBe(11);
    expect(res.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(res.errors[0]!.message).toContain('line 2');
  });

  it('in an unsorted file the first LINE wins, not the first time', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:31:00Z', 1, 2, 0.5, 1, 1) + row('2024-01-02T14:30:00Z') + row('2024-01-02T14:31:00Z', 1, 2, 0.5, 1, 2));
    expect(res.bars.map((b) => b.volume)).toEqual([10, 1]);
    expect(res.errors.map((e) => e.line)).toEqual([4]);
  });

  it('a bad row is not allowed to shadow a good duplicate of the same timestamp', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:30:00Z', 100, 90, 99, 100) + row('2024-01-02T14:30:00Z', 100, 101, 99, 100, 7));
    expect(res.bars).toHaveLength(1);
    expect(res.bars[0]!.volume).toBe(7);
    expect(res.errors.map((e) => e.line)).toEqual([2]);
  });

  it('duplicate detection is on the instant, so Z, offset and epoch spellings of one minute collide', () => {
    const res = parseBarsCsv(H + row('2024-01-02T14:30:00Z') + row('2024-01-02T09:30:00-05:00') + row('1704205800') + row('1704205800000'));
    expect(res.bars).toHaveLength(1);
    expect(res.errors).toHaveLength(3);
  });
});

describe('file level', () => {
  it('huge files: 100k rows parse in a few seconds', () => {
    const parts: string[] = [H];
    const t0 = utc('2024-01-02T14:30:00Z');
    for (let i = 0; i < 100_000; i++) parts.push(`${t0 + i * 60},100,101,99,100.5,${i % 90}\n`);
    const t = Date.now();
    const res = parseBarsCsv(parts.join(''));
    expect(res.bars).toHaveLength(100_000);
    expect(res.errors).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('inputs that are not CSV at all give errors, never a throw', () => {
    for (const text of ['\u0000\u0000\u0000', '{"bars": []}', '<html></html>', '\n\n\n', 'a', ',,,,,', 'time\n']) {
      const res = parseBarsCsv(text);
      expect(res.bars).toEqual([]);
    }
  });

  it('returns fresh data each call: nothing is shared between parses', () => {
    const a = parseBarsCsv(H + row('2024-01-02T14:30:00Z'));
    a.bars[0]!.close = 5;
    a.bars.length = 0;
    const b = parseBarsCsv(H + row('2024-01-02T14:30:00Z'));
    expect(b.bars[0]!.close).toBe(100.5);
  });
});
