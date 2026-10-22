import { tzOffsetSeconds, zonedParts, zonedToUnix } from './time';
import type { Bar } from './types';

export interface CsvError {
  line: number;
  message: string;
}

// ---- header handling ----

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES = {
  open: ['open', 'o', 'openprice', 'opening'],
  high: ['high', 'h', 'highprice'],
  low: ['low', 'l', 'lowprice'],
  close: ['close', 'c', 'closeprice', 'last', 'lastprice'],
  volume: ['volume', 'vol', 'v', 'tickvolume', 'totalvolume', 'qty'],
} as const;
const DATETIME_NAMES = ['datetime', 'timestamp', 'tsevent', 'ts', 'bartime', 'opentime'];

function findColumn(names: string[], candidates: readonly string[]): number {
  for (const c of candidates) {
    const i = names.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

function detectDelimiter(header: string): string {
  const counts: [string, number][] = [
    [',', header.split(',').length],
    [';', header.split(';').length],
    ['\t', header.split('\t').length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 1 ? counts[0]![0] : ',';
}

function splitLine(line: string, delim: string): string[] {
  if (!line.includes('"')) return line.split(delim).map((f) => f.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// ---- values ----

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const parseNumber = (s: string): number => (NUMBER_RE.test(s) ? Number(s) : Number.NaN);

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?$/i;
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*([AaPp][Mm])?)?$/;
const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})(?:[T\s]+(\d{2})(\d{2})(\d{2})?)?$/;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  zone?: string;
}

function parseWall(s: string): Wall | string {
  let m = ISO_RE.exec(s);
  if (m) return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), ...(m[7] ? { zone: m[7] } : {}) };
  m = US_RE.exec(s);
  if (m) {
    let h = +(m[4] ?? 0);
    const ampm = m[7]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) return 'hour must be 1 to 12 with AM/PM';
      h = (h % 12) + (ampm === 'pm' ? 12 : 0);
    }
    return { y: +m[3]!, mo: +m[1]!, d: +m[2]!, h, mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  }
  m = COMPACT_RE.exec(s);
  if (m) return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  return 'unrecognized format';
}

function zoneOffsetSeconds(zone: string): number {
  if (/^(Z|UTC)$/i.test(zone)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
  return (m[1] === '-' ? -1 : 1) * (+m[2]! * 3600 + +(m[3] ?? 0) * 60);
}

/** Unix seconds for a time cell, or an error message. */
function parseTime(raw: string, tz: string): number | string {
  const s = raw.trim();
  if (s === '') return 'invalid time (empty)';

  if (/^\d+(\.\d+)?$/.test(s) && !/^\d{8}$/.test(s)) {
    // epoch: seconds, milliseconds, microseconds or nanoseconds, told apart by digit count
    const int = s.split('.')[0]!;
    let t: number;
    if (int.length <= 11) t = Number(int);
    else if (int.length <= 14) t = Number(BigInt(int) / 1000n);
    else if (int.length <= 17) t = Number(BigInt(int) / 1000000n);
    else t = Number(BigInt(int) / 1000000000n);
    return t > 0 ? t : `invalid time "${raw}"`;
  }

  const w = parseWall(s);
  if (typeof w === 'string') return `invalid time "${raw}" (${w})`;
  if (!validDate(w.y, w.mo, w.d) || w.h > 23 || w.mi > 59 || w.s > 59) return `invalid time "${raw}" (not a real date or time)`;

  let t: number;
  if (w.zone) t = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) / 1000 - zoneOffsetSeconds(w.zone);
  else {
    t = zonedToUnix({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s }, tz);
    if (tz !== 'UTC') {
      const back = zonedParts(t, tz);
      if (back.hour !== w.h || back.minute !== w.mi || back.day !== w.d) return `time "${raw}" does not exist in ${tz} (DST gap)`;
    }
  }
  return t > 0 ? t : `invalid time "${raw}" (before 1970)`;
}

// ---- the parser ----

/**
 * Parse a bars CSV (SPEC §2). Flexible header names, any column order, `,` `;` or tab separated.
 * Bad rows are reported with their physical line number (header = line of the header row) and left out;
 * unsorted input is sorted; a repeated timestamp keeps the first row and reports the rest.
 */
export function parseBarsCsv(text: string, opts?: { timezone?: string }): { bars: Bar[]; errors: CsvError[] } {
  const tz = opts?.timezone ?? 'UTC';
  tzOffsetSeconds(0, tz); // throws EngineError for an unknown zone
  const errors: CsvError[] = [];
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);

  let h = 0;
  while (h < lines.length && lines[h]!.trim() === '') h++;
  if (h >= lines.length) return { bars: [], errors: [{ line: 1, message: 'empty file: no header row' }] };

  const delim = detectDelimiter(lines[h]!);
  const names = splitLine(lines[h]!, delim).map(norm);
  const col = {
    open: findColumn(names, ALIASES.open),
    high: findColumn(names, ALIASES.high),
    low: findColumn(names, ALIASES.low),
    close: findColumn(names, ALIASES.close),
    volume: findColumn(names, ALIASES.volume),
  };
  let timeCols: number[];
  const dt = findColumn(names, DATETIME_NAMES);
  if (dt >= 0) timeCols = [dt];
  else if (names.includes('date') && names.includes('time')) timeCols = [names.indexOf('date'), names.indexOf('time')];
  else if (names.includes('time')) timeCols = [names.indexOf('time')];
  else if (names.includes('date')) timeCols = [names.indexOf('date')];
  else timeCols = [];

  const missing: string[] = [];
  if (timeCols.length === 0) missing.push('time');
  for (const k of ['open', 'high', 'low', 'close'] as const) if (col[k] < 0) missing.push(k);
  if (missing.length > 0) {
    return { bars: [], errors: [{ line: h + 1, message: `missing required column(s): ${missing.join(', ')}` }] };
  }

  const ncols = names.length;
  const parsed: { bar: Bar; line: number }[] = [];

  for (let i = h + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    const f = splitLine(raw, delim);
    if (f.length < ncols || (f.length > ncols && f.slice(ncols).some((x) => x !== ''))) {
      errors.push({ line, message: `expected ${ncols} columns, got ${f.length}` });
      continue;
    }

    const time = parseTime(timeCols.map((c) => f[c]!).join(' '), tz);
    if (typeof time === 'string') {
      errors.push({ line, message: time });
      continue;
    }

    const price = {} as Record<'open' | 'high' | 'low' | 'close', number>;
    let problem: string | null = null;
    for (const k of ['open', 'high', 'low', 'close'] as const) {
      const cell = f[col[k]]!;
      const v = parseNumber(cell);
      if (!Number.isFinite(v)) {
        problem = `invalid ${k} "${cell}"`;
        break;
      }
      if (v <= 0) {
        problem = `${k} must be > 0 (got ${cell})`;
        break;
      }
      price[k] = v;
    }
    let volume = 0;
    if (problem === null && col.volume >= 0) {
      const cell = f[col.volume]!;
      volume = parseNumber(cell);
      if (!Number.isFinite(volume)) problem = `invalid volume "${cell}"`;
      else if (volume < 0) problem = `volume must be >= 0 (got ${cell})`;
    }
    if (problem === null) {
      const { open, high, low, close } = price;
      if (high < low) problem = `high (${high}) is below low (${low})`;
      else if (high < open) problem = `high (${high}) is below open (${open})`;
      else if (high < close) problem = `high (${high}) is below close (${close})`;
      else if (low > open) problem = `low (${low}) is above open (${open})`;
      else if (low > close) problem = `low (${low}) is above close (${close})`;
    }
    if (problem !== null) {
      errors.push({ line, message: problem });
      continue;
    }
    parsed.push({ bar: { time, open: price.open, high: price.high, low: price.low, close: price.close, volume }, line });
  }

  // sort by time (file order breaks ties), keep the first of any repeated timestamp
  parsed.sort((a, b) => a.bar.time - b.bar.time || a.line - b.line);
  const bars: Bar[] = [];
  let firstLine = 0;
  for (const p of parsed) {
    const prev = bars[bars.length - 1];
    if (prev !== undefined && prev.time === p.bar.time) {
      errors.push({ line: p.line, message: `duplicate timestamp (first seen on line ${firstLine})` });
      continue;
    }
    bars.push(p.bar);
    firstLine = p.line;
  }
  errors.sort((a, b) => a.line - b.line);
  return { bars, errors };
}
