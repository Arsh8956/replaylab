import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as api from '../src/index';

describe('public API surface (SPEC §4)', () => {
  it('exports exactly the runtime values the spec lists, nothing else', () => {
    expect(Object.keys(api).sort()).toEqual(
      ['CONTRACTS', 'EngineError', 'ReplayEngine', 'aggregate', 'bucketStart', 'computeStats', 'generateSyntheticBars', 'parseBarsCsv', 'roundToTick', 'tradingDay'].sort(),
    );
  });
  it('the exports are the real things', () => {
    expect(typeof api.ReplayEngine).toBe('function');
    expect(typeof api.ReplayEngine.fromJSON).toBe('function');
    expect(new api.EngineError('x')).toBeInstanceOf(Error);
    expect(Object.keys(api.CONTRACTS)).toHaveLength(12);
    for (const fn of [api.aggregate, api.bucketStart, api.computeStats, api.generateSyntheticBars, api.parseBarsCsv, api.roundToTick, api.tradingDay]) {
      expect(typeof fn).toBe('function');
    }
  });
  it('EngineError has a name and is catchable as Error', () => {
    try {
      throw new api.EngineError('boom');
    } catch (e) {
      expect(e).toBeInstanceOf(api.EngineError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe('EngineError');
      expect((e as Error).message).toBe('boom');
    }
  });
  it('the engine source is pure: no clock, no Math.random, no DOM or Node globals', () => {
    const files = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(files).length).toBeGreaterThan(8);
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(files)) {
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const bad of ['Date.now', 'Math.random', 'new Date()', 'performance.now', 'window.', 'document.', 'process.', "from 'node:", 'require(']) {
        if (code.includes(bad)) offenders.push(`${file}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('has no runtime dependencies and the package fields the spec asks for', () => {
    expect((pkg as Record<string, unknown>)['dependencies']).toBeUndefined();
    expect(pkg.name).toBe('@replaylab/engine');
    expect(pkg.type).toBe('module');
    expect(pkg.exports).toBe('./src/index.ts');
    expect(pkg.types).toBe('./src/index.ts');
  });
});
