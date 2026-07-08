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

const NUMERIC = /^[0-9]+$/;
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Legacy/alternate Latin spellings → the canonical GeoNames `name_en` the backend indexes.
 * The autocomplete `en` trie prefix-matches ONLY the primary name (no alternate-names table),
 * so a legacy spelling must be canonicalized before the lookup AND for the match. Cyrillic needs
 * no such map — the backend already searches the uk + ru tries. Extend as new aliases surface.
 */
const ALT_SPELLINGS: Record<string, string> = {
  kiev: 'kyiv',
  kyev: 'kyiv',
  lvov: 'lviv',
  lwow: 'lviv',
  odessa: 'odesa',
  kharkov: 'kharkiv',
  nikolaev: 'mykolaiv',
  mykolayiv: 'mykolaiv',
  dnepr: 'dnipro',
  dnipropetrovsk: 'dnipro',
  zaporozhye: 'zaporizhzhia',
  zaporizhia: 'zaporizhzhia',
  chernigov: 'chernihiv',
  rovno: 'rivne',
  ternopol: 'ternopil',
  vinnitsa: 'vinnytsia',
  zhitomir: 'zhytomyr',
  ivano_frankovsk: 'ivano-frankivsk',
};

const autocompleteCache = new TtlCache<BackendCity[]>(config.CACHE_TTL_AUTOCOMPLETE_MS);
const cityByIdCache = new TtlCache<CityRef>(config.CACHE_TTL_AUTOCOMPLETE_MS);

const norm = (value: string): string => value.trim().toLowerCase();
/** Fold legacy Latin spellings so query and candidate compare in one canonical form. */
const canonical = (value: string): string => ALT_SPELLINGS[norm(value)] ?? norm(value);
const isCyrillic = (value: string): boolean => CYRILLIC.test(value);

export function isNumericCityId(value: string): boolean {
  return NUMERIC.test(value);
}

function toRef(city: BackendCity): CityRef {
  return { city_id: city.id, name: city.name, region: city.region, country_code: city.country_code };
}

type CityLookup =
  | { status: 'resolved'; city: CityRef; lookupLocale: Locale }
  | { status: 'ambiguous'; candidates: CityRef[]; lookupLocale: Locale }
  | { status: 'none' };

/**
 * Name → candidate city, leaning entirely on the backend's multilingual autocomplete (uk+ru+en) and
 * its population ranking. The one thing the backend can't do for us is confirm the match: it returns
 * names in the REQUESTED locale, so a cross-script query ("Lviv" → "Львів") never string-matches. So
 * we look up in the locale that MATCHES the query's script, making the top result confirmable:
 *   - exactly one exact-name match  → resolve (Kyiv/Lviv, city-vs-«район»: districts can't out-vote it).
 *   - two+ exact-name matches       → ambiguous true homonyms (same name, different oblasts).
 *   - no exact match, one candidate → resolve it.
 *   - no exact match, many          → ambiguous (a genuine partial/unclear query).
 * Autocomplete results cached (1h) keyed by (lookupLocale, lookupQuery).
 */
async function lookupCity(name: string): Promise<CityLookup> {
  const cyrillic = isCyrillic(name);
  const lookupLocale: Locale = cyrillic ? 'uk' : 'en';
  const lookupQuery = cyrillic ? name.trim() : canonical(name);

  const key = `${lookupLocale}:${lookupQuery}`;
  let candidates = autocompleteCache.get(key);
  if (!candidates) {
    candidates = await backend.autocomplete(lookupQuery, lookupLocale, 10);
    autocompleteCache.set(key, candidates);
  }
  if (candidates.length === 0) return { status: 'none' };

  const target = canonical(name);
  const exact = candidates.filter((c) => canonical(c.name) === target);
  if (exact.length === 1) return { status: 'resolved', city: toRef(exact[0]!), lookupLocale };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.map(toRef), lookupLocale };
  if (candidates.length === 1) return { status: 'resolved', city: toRef(candidates[0]!), lookupLocale };
  return { status: 'ambiguous', candidates: candidates.map(toRef), lookupLocale };
}

type EndpointResolution =
  | { kind: 'id'; id: string; ref?: CityRef }
  | { kind: 'ambiguous'; candidates: CityRef[]; lookupLocale: Locale }
  | { kind: 'none' }
  | { kind: 'missing' };

/**
 * Resolves ONE route endpoint to a city id. A numeric *_city_id is taken verbatim as the id (its
 * display CityRef is resolved later, in one batch); a name goes through {@link lookupCity}. When the
 * name was looked up in the requested locale the display `ref` is already correct (fast path, no
 * re-fetch). `missing` = neither given; `none` = name had no match; `ambiguous` = pick required.
 */
async function resolveEndpoint(
  name: string | undefined,
  cityId: string | undefined,
  locale: Locale,
): Promise<EndpointResolution> {
  if (cityId && isNumericCityId(cityId)) return { kind: 'id', id: cityId };
  if (!name) return { kind: 'missing' };
  const res = await lookupCity(name);
  if (res.status === 'none') return { kind: 'none' };
  if (res.status === 'ambiguous') return { kind: 'ambiguous', candidates: res.candidates, lookupLocale: res.lookupLocale };
  const ref = res.lookupLocale === locale ? res.city : undefined;
  return { kind: 'id', id: res.city.city_id, ref };
}

/** Batch-resolve ids (that lack a requested-locale ref) into full CityRefs via /api/search/cities. */
async function fetchRefs(ids: string[], locale: Locale): Promise<Map<string, CityRef>> {
  const missing = [...new Set(ids)].filter((id) => !cityByIdCache.get(`${locale}:${id}`));
  if (missing.length > 0) {
    const fetched = await backend.citiesByIds(missing, locale);
    for (const city of fetched) cityByIdCache.set(`${locale}:${city.id}`, toRef(city));
  }
  const out = new Map<string, CityRef>();
  for (const id of ids) {
    const ref = cityByIdCache.get(`${locale}:${id}`);
    if (ref) out.set(id, ref);
  }
  return out;
}

/** Re-fetch ambiguous candidates in the requested locale (only when it differs from the lookup one). */
async function localizeCandidates(candidates: CityRef[], lookupLocale: Locale, locale: Locale): Promise<CityRef[]> {
  if (lookupLocale === locale) return candidates;
  const byId = await fetchRefs(candidates.map((c) => c.city_id), locale);
  return candidates.map((c) => byId.get(c.city_id) ?? c);
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
 * Resolves both endpoints of a route (from + to) into a single discriminated result — the shared
 * city gate for every route-shaped tool. On success, both endpoints' display CityRefs are produced
 * in the requested locale via ONE batched /api/search/cities call (or from the fast-path ref when the
 * name was already looked up in that locale). `from` is checked before `to`, so one failure surfaces
 * at a time. Callers map each failure onto their own structured reply.
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
    if (res.kind === 'ambiguous') {
      const candidates = await localizeCandidates(res.candidates, res.lookupLocale, locale);
      return { status: 'ambiguous', field, query: query ?? '', candidates };
    }
  }

  // Both endpoints resolved to an id; localize the ones without a fast-path ref in one batch.
  const fromEp = from as { kind: 'id'; id: string; ref?: CityRef };
  const toEp = to as { kind: 'id'; id: string; ref?: CityRef };
  const need = [fromEp, toEp].filter((e) => !e.ref).map((e) => e.id);
  const refs = need.length > 0 ? await fetchRefs(need, locale) : new Map<string, CityRef>();

  const fromRef = fromEp.ref ?? refs.get(fromEp.id);
  const toRef = toEp.ref ?? refs.get(toEp.id);
  // A missing ref means a caller-supplied id doesn't exist — clean "not found", not a placeholder.
  if (!fromRef) return { status: 'none', field: 'from' };
  if (!toRef) return { status: 'none', field: 'to' };
  return { status: 'ok', from: fromRef, to: toRef };
}

/** Test-only: drop the module-level caches so call-count assertions stay isolated. */
export function _resetCityCaches(): void {
  autocompleteCache.clear();
  cityByIdCache.clear();
}
