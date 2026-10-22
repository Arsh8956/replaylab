import { describe, expect, it } from 'vitest';
import { CONTRACTS, roundToTick } from '../src/contracts';

describe('CONTRACTS (SPEC §3)', () => {
  const expected: Record<string, [root: string, tick: number, tickValue: number, pointValue: number]> = {
    NQ: ['NQ', 0.25, 5, 20],
    MNQ: ['NQ', 0.25, 0.5, 2],
    ES: ['ES', 0.25, 12.5, 50],
    MES: ['ES', 0.25, 1.25, 5],
    YM: ['YM', 1, 5, 5],
    MYM: ['YM', 1, 0.5, 0.5],
    RTY: ['RTY', 0.1, 5, 50],
    M2K: ['RTY', 0.1, 0.5, 5],
    CL: ['CL', 0.01, 10, 1000],
    MCL: ['CL', 0.01, 1, 100],
    GC: ['GC', 0.1, 10, 100],
    MGC: ['GC', 0.1, 1, 10],
  };

  it('lists exactly the 12 v1 markets', () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s has the spec tick, tick value, point value and root', (symbol, [root, tick, tickValue, pointValue]) => {
    const c = CONTRACTS[symbol]!;
    expect(c.symbol).toBe(symbol);
    expect(c.root).toBe(root);
    expect(c.tickSize).toBe(tick);
    expect(c.tickValue).toBe(tickValue);
    expect(c.pointValue).toBe(pointValue);
    expect(c.name.length).toBeGreaterThan(3);
  });

  it('point value is consistent with tick value / tick size', () => {
    for (const c of Object.values(CONTRACTS)) {
      expect(Math.round((c.tickValue / c.tickSize) * 1e6) / 1e6).toBe(c.pointValue);
    }
  });

  it('micros share the root (and so the bars) of their full size contract', () => {
    expect(CONTRACTS['MNQ']!.root).toBe('NQ');
    expect(CONTRACTS['MES']!.root).toBe('ES');
    expect(CONTRACTS['MYM']!.root).toBe('YM');
    expect(CONTRACTS['M2K']!.root).toBe('RTY');
    expect(CONTRACTS['MCL']!.root).toBe('CL');
    expect(CONTRACTS['MGC']!.root).toBe('GC');
  });
});

describe('roundToTick', () => {
  it('leaves on-grid prices unchanged', () => {
    expect(roundToTick(21000.25, 0.25)).toBe(21000.25);
    expect(roundToTick(70.13, 0.01)).toBe(70.13);
    expect(roundToTick(2300.1, 0.1)).toBe(2300.1);
    expect(roundToTick(44001, 1)).toBe(44001);
  });

  it('rounds to the nearest tick', () => {
    expect(roundToTick(21000.1, 0.25)).toBe(21000);
    expect(roundToTick(21000.13, 0.25)).toBe(21000.25);
    expect(roundToTick(2300.04, 0.1)).toBe(2300);
    expect(roundToTick(2300.06, 0.1)).toBe(2300.1);
    expect(roundToTick(70.126, 0.01)).toBe(70.13);
    expect(roundToTick(43999.4, 1)).toBe(43999);
  });

  it('rounds exact halves up', () => {
    expect(roundToTick(21000.125, 0.25)).toBe(21000.25);
    expect(roundToTick(44000.5, 1)).toBe(44001);
    expect(roundToTick(2300.05, 0.1)).toBe(2300.1); // 2300.05 / 0.1 is 23000.499999999996 in floats
  });

  it('returns clean decimals, no float dust', () => {
    expect(String(roundToTick(2700.30000000004, 0.1))).toBe('2700.3');
    expect(String(roundToTick(70.1 + 0.2, 0.01))).toBe('70.3');
  });

  it('rejects a non positive tick size', async () => {
    const { EngineError } = await import('../src/errors');
    expect(() => roundToTick(10, 0)).toThrow(EngineError);
    expect(() => roundToTick(10, -0.25)).toThrow(EngineError);
  });
});
