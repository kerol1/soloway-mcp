import { describe, it, expect } from 'vitest';
import { computeLoadStatus } from '../../src/tools/getCalendarPrices.js';

// A far-future month is deterministic: it is never the current month, so the expected window is the
// full 1..lastDay regardless of "today" — no time mocking needed. 2099-01 has 31 days.
const MONTH = '2099-01';

describe('computeLoadStatus', () => {
  it('pending=true → partial, with loaded/missing days and a completion percent < 100', () => {
    const prices = { '2099-01-01': 100, '2099-01-02': null }; // day 2 checked, no trips
    const status = computeLoadStatus(prices, true, MONTH);

    expect(status.data_status).toBe('partial');
    expect(status.loaded_days).toEqual(['2099-01-01', '2099-01-02']); // present = resolved (priced OR null)
    expect(status.missing_days).toContain('2099-01-03'); // absent = still loading
    expect(status.missing_days).not.toContain('2099-01-01');
    expect(status.missing_days).not.toContain('2099-01-02');
    expect(status.completion_percent).toBe(Math.round((2 / 31) * 100)); // 6
    expect(status.completion_percent).toBeGreaterThan(0);
    expect(status.completion_percent).toBeLessThan(100);
  });

  it('pending=false → complete, no missing days, 100%', () => {
    const status = computeLoadStatus({ '2099-01-01': 100, '2099-01-05': null }, false, MONTH);

    expect(status.data_status).toBe('complete');
    expect(status.missing_days).toEqual([]);
    expect(status.completion_percent).toBe(100);
    expect(status.loaded_days).toEqual(['2099-01-01', '2099-01-05']);
  });

  it('loaded_days is sorted ascending regardless of insertion order', () => {
    const status = computeLoadStatus({ '2099-01-10': 1, '2099-01-02': 2, '2099-01-05': null }, false, MONTH);
    expect(status.loaded_days).toEqual(['2099-01-02', '2099-01-05', '2099-01-10']);
  });
});
