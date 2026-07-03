import type { TripPrice } from '../backend/types.js';

export interface ComparableUah {
  amount: number;
  currency: string;
  is_uah: boolean;
}

/**
 * UAH-equivalent used as the ascending sort key. The search response has no comparable field;
 * we recompute it from prices[]. NEVER folds a non-UAH amount into the UAH key.
 *
 * - domestic trip → the UAH entry (primary=true) → is_uah:true
 * - foreign trip  → the FX-converted UAH entry (primary=false) → is_uah:true
 * - no UAH entry (FX rate missing — rare; live search usually drops these) → native price kept
 *   for DISPLAY with is_uah:false (sorted last, never used as a UAH key)
 * - empty prices[] → null (trip is skipped, never crashes on prices[0])
 */
export function comparableUah(prices: TripPrice[] | undefined | null): ComparableUah | null {
  if (!prices || prices.length === 0) return null;
  const uah = prices.find((price) => price.currency === 'UAH');
  if (uah) return { amount: uah.amount, currency: 'UAH', is_uah: true };
  const first = prices[0]!;
  return { amount: first.amount, currency: first.currency, is_uah: false };
}

/** Ascending sort key: UAH-comparable trips by UAH amount; non-UAH-comparable trips sort LAST. */
export function sortKeyUah(comparable: ComparableUah | null): number {
  return comparable && comparable.is_uah ? comparable.amount : Number.POSITIVE_INFINITY;
}
