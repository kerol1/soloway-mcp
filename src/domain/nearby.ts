import type { NearbyPairWire, NearbyPairsResponse } from '../backend/types.js';

/**
 * Pure helpers for the nearby-fallback: which substituted pairs to verify and how
 * to describe them. Mirrors the site's rules (features/nearby-city-suggestions.md):
 * cases 1+2 form wave 1 and are offered together; case 3 (both sides substituted)
 * is tried ONLY when wave 1 confirmed nothing.
 */

export interface NearbyPairPlan {
  pair: NearbyPairWire;
  caseNo: 1 | 2 | 3;
}

/** Wave 1 = cases 1+2 together, capped at `max` verification searches. */
export function wave1Pairs(matrix: NearbyPairsResponse, max: number): NearbyPairPlan[] {
  return [
    ...matrix.case1.map((pair) => ({ pair, caseNo: 1 as const })),
    ...matrix.case2.map((pair) => ({ pair, caseNo: 2 as const })),
  ].slice(0, max);
}

const MAX_CASE3_VERIFY = 2;

export function case3Pairs(matrix: NearbyPairsResponse): NearbyPairPlan[] {
  return matrix.case3.slice(0, MAX_CASE3_VERIFY).map((pair) => ({ pair, caseNo: 3 as const }));
}

export interface SubstitutionOut {
  replaces: string;
  nearby_city: string;
  distance_km: number;
}

/** One entry per substituted side, in from→to order. */
export function substitutionsOf(pair: NearbyPairWire, originalFrom: string, originalTo: string): SubstitutionOut[] {
  const subs: SubstitutionOut[] = [];
  if (pair.from_sub) {
    subs.push({ replaces: originalFrom, nearby_city: pair.from_sub.city.name, distance_km: pair.from_sub.distance_km });
  }
  if (pair.to_sub) {
    subs.push({ replaces: originalTo, nearby_city: pair.to_sub.city.name, distance_km: pair.to_sub.distance_km });
  }
  return subs;
}

/** Route endpoint names after substitution (a null sub keeps the original city's name). */
export function routeNames(pair: NearbyPairWire, originalFrom: string, originalTo: string): { from: string; to: string } {
  return {
    from: pair.from_sub?.city.name ?? originalFrom,
    to: pair.to_sub?.city.name ?? originalTo,
  };
}

/** Sort key for offered alternatives: the largest detour among the pair's substitutions. */
export function alternativeDistance(subs: SubstitutionOut[]): number {
  return subs.reduce((max, sub) => Math.max(max, sub.distance_km), 0);
}
