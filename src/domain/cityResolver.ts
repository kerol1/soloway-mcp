import { config } from '../config.js';
import { backend } from '../backend/client.js';
import { TtlCache } from '../lib/cache.js';
import type { BackendCity } from '../backend/types.js';
import type { Locale } from './localize.js';

export interface CityRef {
  city_id: string;
  name: string;
  region: string | null;
  country_code: string;
}

export type CityResolution =
  | { status: 'resolved'; city: CityRef }
  | { status: 'ambiguous'; candidates: CityRef[] }
  | { status: 'none' };

const NUMERIC = /^[0-9]+$/;
const autocompleteCache = new TtlCache<BackendCity[]>(config.CACHE_TTL_AUTOCOMPLETE_MS);

export function isNumericCityId(value: string): boolean {
  return NUMERIC.test(value);
}

function toRef(city: BackendCity): CityRef {
  return { city_id: city.id, name: city.name, region: city.region, country_code: city.country_code };
}

/**
 * Resolves a human city name to an internal cityId. Returns `resolved` (single match),
 * `ambiguous` (the caller asks the user to pick + pass the chosen *_city_id), or `none`.
 * Autocomplete results are cached (1h) keyed by (lowercased query, locale).
 */
export async function resolveCity(name: string, locale: Locale): Promise<CityResolution> {
  const key = `${locale}:${name.trim().toLowerCase()}`;
  let candidates = autocompleteCache.get(key);
  if (!candidates) {
    candidates = await backend.autocomplete(name.trim(), locale, 10);
    autocompleteCache.set(key, candidates);
  }
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length === 1) return { status: 'resolved', city: toRef(candidates[0]!) };
  // Exact (case-insensitive) name match collapses a common ambiguity (e.g. "Kyiv" amongst suburbs).
  const exact = candidates.filter((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return { status: 'resolved', city: toRef(exact[0]!) };
  return { status: 'ambiguous', candidates: candidates.map(toRef) };
}

/**
 * Resolves ONE route endpoint from either a numeric city id (used verbatim, no lookup) or a name.
 * `missing` = neither given; `none` = name had no match; `ambiguous` = >1 candidate.
 */
export async function resolveEndpoint(
  name: string | undefined,
  cityId: string | undefined,
  locale: Locale,
): Promise<
  | { kind: 'ref'; ref: CityRef }
  | { kind: 'ambiguous'; candidates: CityRef[] }
  | { kind: 'none' }
  | { kind: 'missing' }
> {
  if (cityId && isNumericCityId(cityId)) return { kind: 'ref', ref: { city_id: cityId, name: cityId, region: null, country_code: '' } };
  if (!name) return { kind: 'missing' };
  const res = await resolveCity(name, locale);
  if (res.status === 'resolved') return { kind: 'ref', ref: res.city };
  if (res.status === 'ambiguous') return { kind: 'ambiguous', candidates: res.candidates };
  return { kind: 'none' };
}

export interface RouteEndpoints {
  from?: string;
  to?: string;
  from_city_id?: string;
  to_city_id?: string;
}

export type RouteResolution =
  | { status: 'ok'; from: CityRef; to: CityRef }
  | { status: 'missing'; field: 'from' | 'to' }
  | { status: 'none'; field: 'from' | 'to' }
  | { status: 'ambiguous'; field: 'from' | 'to'; query: string; candidates: CityRef[] };

/**
 * Resolves both endpoints of a route (from + to) in parallel into a single discriminated result —
 * the shared city-resolution gate for every route-shaped tool (search, calendar, …). Callers map
 * each failure onto their own structured reply.
 */
export async function resolveRoute(args: RouteEndpoints, locale: Locale): Promise<RouteResolution> {
  const [from, to] = await Promise.all([
    resolveEndpoint(args.from, args.from_city_id, locale),
    resolveEndpoint(args.to, args.to_city_id, locale),
  ]);
  for (const [field, res, query] of [
    ['from', from, args.from] as const,
    ['to', to, args.to] as const,
  ]) {
    if (res.kind === 'missing') return { status: 'missing', field };
    if (res.kind === 'none') return { status: 'none', field };
    if (res.kind === 'ambiguous') return { status: 'ambiguous', field, query: query ?? '', candidates: res.candidates };
  }
  return { status: 'ok', from: (from as { kind: 'ref'; ref: CityRef }).ref, to: (to as { kind: 'ref'; ref: CityRef }).ref };
}
