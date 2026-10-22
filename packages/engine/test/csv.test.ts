import { describe, expect, it } from 'vitest';
import { parseBarsCsv } from '../src/csv';
import { EngineError } from '../src/errors';
import { utc } from './helpers';

const HEADER = 'time,open,high,low,close,volume';
const T = 1704207600; // 2024-01-02T15:00:00Z

describe('parseBarsCsv: the standard layout', () => {
  it('parses time,open,high,low,close,volume with ISO UTC times', () => {
    const r = parseBarsCsv([HEADER, '2024-01-02T15:00:00Z,21000,21002.5,20999,21001,150', '2024-01-02T15:01:00Z,21001,21003,21000.25,21002.75,200'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([
      { time: T, open: 21000, high: 21002.5, low: 20999, close: 21001, volume: 150 },
      { time: T + 60, open: 21001, high: 21003, low: 21000.25, close: 21002.75, volume: 200 },
    ]);
  });
  it('handles CRLF, a BOM, a trailing newline and blank lines', () => {
    const text = `﻿${HEADER}\r\n2024-01-02T15:00:00Z,1,2,0.5,1.5,10\r\n\r\n2024-01-02T15:01:00Z,1,2,0.5,1.5,10\r\n`;
    const r = parseBarsCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.bars.map((b) => b.time)).toEqual([T, T + 60]);
  });
  it('empty input reports one error, header only reports none', () => {
    expect(parseBarsCsv('')).toEqual({ bars: [], errors: [{ line: 1, message: expect.stringMatching(/empty/i) }] });
    expect(parseBarsCsv(HEADER)).toEqual({ bars: [], errors: [] });
  });
});

describe('parseBarsCsv: header variants', () => {
  const row = '2024-01-02T15:00:00Z,21000,21002.5,20999,21001,150';
  const expectedBar = { time: T, open: 21000, high: 21002.5, low: 20999, close: 21001, volume: 150 };

  it.each([
    ['Timestamp,Open,High,Low,Close,Vol'],
    ['DATETIME, OPEN , HIGH , LOW , CLOSE , VOLUME'],
    ['"time","open","high","low","close","volume"'],
    ['ts_event,open,high,low,close,volume'],
    ['Date Time,Open Price,High Price,Low Price,Close Price,Volume'],
    ['time,o,h,l,c,v'],
  ])('accepts the header %s', (header) => {
    const r = parseBarsCsv(`${header}\n${row}`);
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([expectedBar]);
  });

  it('any column order, extra columns ignored', () => {
    const r = parseBarsCsv('symbol,close,volume,time,open,high,low,oi\nNQH4,21001,150,2024-01-02T15:00:00Z,21000,21002.5,20999,77');
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([expectedBar]);
  });

  it('semicolon and tab separated files', () => {
    const semi = parseBarsCsv('time;open;high;low;close;volume\n2024-01-02T15:00:00Z;21000;21002.5;20999;21001;150');
    expect(semi.bars).toEqual([expectedBar]);
    const tab = parseBarsCsv('time\topen\thigh\tlow\tclose\tvolume\n2024-01-02T15:00:00Z\t21000\t21002.5\t20999\t21001\t150');
    expect(tab.bars).toEqual([expectedBar]);
  });

  it('quoted fields', () => {
    const r = parseBarsCsv(`${HEADER}\n"2024-01-02T15:00:00Z","21000","21002.5","20999","21001","150"`);
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([expectedBar]);
  });

  it('separate Date and Time columns are combined', () => {
    const r = parseBarsCsv('Date,Time,Open,High,Low,Close,Volume\n2024-01-02,15:00:00,21000,21002.5,20999,21001,150');
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([expectedBar]);
    const us = parseBarsCsv('Date,Time,Open,High,Low,Close,Volume\n01/02/2024,15:00,21000,21002.5,20999,21001,150');
    expect(us.bars).toEqual([expectedBar]);
  });

  it('a missing volume column means volume 0', () => {
    const r = parseBarsCsv('time,open,high,low,close\n2024-01-02T15:00:00Z,21000,21002.5,20999,21001');
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([{ ...expectedBar, volume: 0 }]);
  });

  it('a missing required column is one header error and no bars', () => {
    const r = parseBarsCsv('time,open,low,close,volume\n2024-01-02T15:00:00Z,21000,20999,21001,150');
    expect(r.bars).toEqual([]);
    expect(r.errors).toEqual([{ line: 1, message: expect.stringMatching(/high/) }]);
    const none = parseBarsCsv('foo,bar,baz\n1,2,3');
    expect(none.bars).toEqual([]);
    expect(none.errors).toHaveLength(1);
    expect(none.errors[0]!.line).toBe(1);
  });

  it('a header that is not on line 1 (leading blank lines) still reports real line numbers', () => {
    const r = parseBarsCsv(`\n\n${HEADER}\n2024-01-02T15:00:00Z,1,2,0.5,1.5,10\nbad,1,2,0.5,1.5,10`);
    expect(r.bars).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([5]);
  });
});

describe('parseBarsCsv: time formats and the timezone option', () => {
  const one = (time: string, timezone?: string) => parseBarsCsv(`${HEADER}\n${time},1,2,0.5,1.5,10`, timezone ? { timezone } : undefined);

  it('naive times default to UTC', () => {
    expect(one('2024-01-02 15:00:00').bars[0]!.time).toBe(T);
    expect(one('2024-01-02T15:00:00').bars[0]!.time).toBe(T);
    expect(one('2024-01-02 15:00').bars[0]!.time).toBe(T);
    expect(one('2024-01-02 15:00:00.000').bars[0]!.time).toBe(T);
    expect(one('2024/01/02 15:00:00').bars[0]!.time).toBe(T);
  });
  it('timezone option: America/New_York', () => {
    expect(one('2024-01-02 10:00:00', 'America/New_York').bars[0]!.time).toBe(T); // EST, UTC-5
    expect(one('2024-07-01 10:00:00', 'America/New_York').bars[0]!.time).toBe(utc('2024-07-01T14:00:00Z')); // EDT, UTC-4
    expect(one('2024-01-02 09:00:00', 'Asia/Tokyo').bars[0]!.time).toBe(utc('2024-01-02T00:00:00Z'));
  });
  it('explicit Z or offset wins over the timezone option', () => {
    expect(one('2024-01-02T15:00:00Z', 'Asia/Tokyo').bars[0]!.time).toBe(T);
    expect(one('2024-01-02T10:00:00-05:00', 'Asia/Tokyo').bars[0]!.time).toBe(T);
    expect(one('2024-01-02T20:00:00+05:00').bars[0]!.time).toBe(T);
    expect(one('2024-01-02 10:00:00-0500').bars[0]!.time).toBe(T);
  });
  it('US style and compact formats', () => {
    expect(one('01/02/2024 15:00:00').bars[0]!.time).toBe(T);
    expect(one('1/2/2024 3:00 PM').bars[0]!.time).toBe(T);
    expect(one('01/02/2024 12:00 AM').bars[0]!.time).toBe(utc('2024-01-02T00:00:00Z'));
    expect(one('01/02/2024 12:30 PM').bars[0]!.time).toBe(utc('2024-01-02T12:30:00Z'));
    expect(one('20240102 150000').bars[0]!.time).toBe(T);
  });
  it('epoch seconds, milliseconds, microseconds and nanoseconds (timezone is irrelevant)', () => {
    expect(one('1704207600', 'Asia/Tokyo').bars[0]!.time).toBe(T);
    expect(one('1704207600000').bars[0]!.time).toBe(T);
    expect(one('1704207600000000').bars[0]!.time).toBe(T);
    expect(one('1704207600000000000').bars[0]!.time).toBe(T);
    expect(one('1704207600.75').bars[0]!.time).toBe(T);
  });
  it('DST: the offset follows the date, not a fixed number', () => {
    const r = parseBarsCsv(`${HEADER}\n2024-03-10 01:59:00,1,2,0.5,1.5,10\n2024-03-10 03:00:00,1,2,0.5,1.5,10`, { timezone: 'America/New_York' });
    expect(r.errors).toEqual([]);
    expect(r.bars.map((b) => b.time)).toEqual([utc('2024-03-10T06:59:00Z'), utc('2024-03-10T07:00:00Z')]); // 1 minute apart in real time
  });
  it('a wall clock time that does not exist (spring forward gap) is reported, not shifted', () => {
    const r = parseBarsCsv(`${HEADER}\n2024-03-10 02:30:00,1,2,0.5,1.5,10`, { timezone: 'America/New_York' });
    expect(r.bars).toEqual([]);
    expect(r.errors).toEqual([{ line: 2, message: expect.stringMatching(/exist|gap|DST/i) }]);
  });
  it('an ambiguous wall clock time (fall back) takes the first occurrence; the repeat is a reported duplicate', () => {
    const r = parseBarsCsv(`${HEADER}\n2024-11-03 01:30:00,1,2,0.5,1.5,10\n2024-11-03 01:30:00,1,2,0.5,1.5,10`, { timezone: 'America/New_York' });
    expect(r.bars.map((b) => b.time)).toEqual([utc('2024-11-03T05:30:00Z')]);
    expect(r.errors).toEqual([{ line: 3, message: expect.stringMatching(/duplicate/i) }]);
  });
  it('an unknown timezone throws EngineError', () => {
    expect(() => parseBarsCsv(`${HEADER}\n2024-01-02 15:00:00,1,2,0.5,1.5,10`, { timezone: 'Mars/Base' })).toThrow(EngineError);
  });
  it.each(['not-a-time', '2024-13-01 10:00:00', '2024-02-30 10:00:00', '2024-01-02 25:00:00', '2024-01-02 10:61:00', '13/45/2024 10:00', '0', '-5', ''])('rejects the time "%s"', (bad) => {
    const r = one(bad);
    expect(r.bars).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(2);
  });
});

describe('parseBarsCsv: bad rows are reported with line numbers, never silently dropped', () => {
  const text = [
    HEADER, // 1
    '2024-01-02T15:00:00Z,1,2,0.5,1.5,10', // 2 good
    '2024-01-02T15:01:00Z,abc,2,0.5,1.5,10', // 3 bad open
    '', // 4 blank, skipped but counted
    '2024-01-02T15:02:00Z,1,2,0.5', // 5 too few columns
    'not-a-time,1,2,0.5,1.5,10', // 6 bad time
    '2024-01-02T15:04:00Z,1,2,3,1.5,10', // 7 high below low
    '2024-01-02T15:05:00Z,1,2,0.5,1.5,10', // 8 good
  ].join('\n');

  it('keeps the good rows and lists every bad one by physical line number', () => {
    const r = parseBarsCsv(text);
    expect(r.bars.map((b) => b.time)).toEqual([T, T + 300]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 5, 6, 7]);
    expect(r.errors[0]!.message).toMatch(/open/i);
    expect(r.errors[1]!.message).toMatch(/column/i);
    expect(r.errors[2]!.message).toMatch(/time/i);
    expect(r.errors[3]!.message).toMatch(/high/i);
    for (const e of r.errors) expect(e.message.length).toBeGreaterThan(5);
  });

  it.each([
    ['empty price', '2024-01-02T15:00:00Z,,2,0.5,1.5,10', /open/i],
    ['text price', '2024-01-02T15:00:00Z,1,two,0.5,1.5,10', /high/i],
    ['NaN price', '2024-01-02T15:00:00Z,1,2,NaN,1.5,10', /low/i],
    ['Infinity price', '2024-01-02T15:00:00Z,1,2,0.5,Infinity,10', /close/i],
    ['zero price', '2024-01-02T15:00:00Z,0,2,0.5,1.5,10', /open/i],
    ['negative price', '2024-01-02T15:00:00Z,1,2,-0.5,1.5,10', /low/i],
    ['high under open', '2024-01-02T15:00:00Z,3,2,0.5,1.5,10', /high/i],
    ['high under close', '2024-01-02T15:00:00Z,1,2,0.5,2.5,10', /high/i],
    ['low over open', '2024-01-02T15:00:00Z,0.25,2,0.5,1.5,10', /low/i],
    ['low over close', '2024-01-02T15:00:00Z,1,2,0.5,0.25,10', /low/i],
    ['negative volume', '2024-01-02T15:00:00Z,1,2,0.5,1.5,-1', /volume/i],
    ['text volume', '2024-01-02T15:00:00Z,1,2,0.5,1.5,lots', /volume/i],
    ['too many columns is fine only when the header has them', '2024-01-02T15:00:00Z,1,2,0.5,1.5,10,99', /column/i],
  ])('%s', (_name, row, pattern) => {
    const r = parseBarsCsv(`${HEADER}\n${row}`);
    expect(r.bars).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.message).toMatch(pattern);
  });

  it('every input row is either a bar or an error', () => {
    const rows = Array.from({ length: 200 }, (_, i) => (i % 7 === 3 ? `bad${i},1,2,0.5,1.5,10` : `2024-01-02T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z,1,2,0.5,1.5,10`));
    const r = parseBarsCsv([HEADER, ...rows].join('\n'));
    expect(r.bars.length + r.errors.length).toBe(200);
    expect(r.errors.length).toBe(rows.filter((x) => x.startsWith('bad')).length);
  });
});

describe('parseBarsCsv: unsorted and duplicate input', () => {
  it('returns bars sorted by time (unsorted input is not an error)', () => {
    const r = parseBarsCsv([HEADER, '2024-01-02T15:02:00Z,3,4,2,3.5,30', '2024-01-02T15:00:00Z,1,2,0.5,1.5,10', '2024-01-02T15:01:00Z,2,3,1,2.5,20'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.bars.map((b) => b.volume)).toEqual([10, 20, 30]);
    expect(r.bars.map((b) => b.time)).toEqual([T, T + 60, T + 120]);
  });
  it('keeps the first of a duplicate timestamp and reports the later line', () => {
    const r = parseBarsCsv([HEADER, '2024-01-02T15:00:00Z,1,2,0.5,1.5,10', '2024-01-02T15:01:00Z,2,3,1,2.5,20', '2024-01-02T15:00:00Z,9,9,9,9,99'].join('\n'));
    expect(r.bars.map((b) => b.volume)).toEqual([10, 20]);
    expect(r.errors).toEqual([{ line: 4, message: expect.stringMatching(/duplicate.*line 2/i) }]);
  });
  it('duplicates are found after sorting too: the same instant written two ways', () => {
    const r = parseBarsCsv([HEADER, '2024-01-02T15:00:00Z,1,2,0.5,1.5,10', '1704207600,1,2,0.5,1.5,10'].join('\n'));
    expect(r.bars).toHaveLength(1);
    expect(r.errors).toEqual([{ line: 3, message: expect.stringMatching(/duplicate/i) }]);
  });
  it('parses a large file', () => {
    const lines = [HEADER];
    for (let i = 0; i < 20000; i++) lines.push(`${T + i * 60},100,101,99,100.5,5`);
    const r = parseBarsCsv(lines.join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.bars).toHaveLength(20000);
    expect(r.bars[19999]!.time).toBe(T + 19999 * 60);
  });
});
