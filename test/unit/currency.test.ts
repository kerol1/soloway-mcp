import { describe, it, expect } from 'vitest';
import { comparableUah, sortKeyUah } from '../../src/domain/currency.js';

describe('comparableUah', () => {
  it('returns the UAH entry for a domestic trip', () => {
    const c = comparableUah([{ amount: 900, currency: 'UAH', primary: true }]);
    expect(c).toEqual({ amount: 900, currency: 'UAH', is_uah: true });
  });

  it('picks the FX-converted UAH entry for a foreign trip', () => {
    const c = comparableUah([
      { amount: 1200, currency: 'CZK', primary: true },
      { amount: 1300, currency: 'UAH', primary: false },
    ]);
    expect(c).toEqual({ amount: 1300, currency: 'UAH', is_uah: true });
  });

  it('keeps the native price for display but marks is_uah=false when no UAH entry', () => {
    const c = comparableUah([{ amount: 1200, currency: 'CZK', primary: true }]);
    expect(c).toEqual({ amount: 1200, currency: 'CZK', is_uah: false });
  });

  it('returns null for empty prices (trip is skipped, never indexes prices[0])', () => {
    expect(comparableUah([])).toBeNull();
    expect(comparableUah(undefined)).toBeNull();
  });

  it('tolerates non-integer amounts', () => {
    const c = comparableUah([{ amount: 499.5, currency: 'UAH', primary: true }]);
    expect(c?.amount).toBe(499.5);
  });
});

describe('sortKeyUah', () => {
  it('uses the UAH amount for UAH-comparable trips', () => {
    expect(sortKeyUah({ amount: 850, currency: 'UAH', is_uah: true })).toBe(850);
  });

  it('sorts non-UAH-comparable and null trips LAST (+Infinity)', () => {
    expect(sortKeyUah({ amount: 500, currency: 'CZK', is_uah: false })).toBe(Number.POSITIVE_INFINITY);
    expect(sortKeyUah(null)).toBe(Number.POSITIVE_INFINITY);
  });
});
