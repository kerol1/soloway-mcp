import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { backend, BackendError } from '../backend/client.js';
import { resolveRoute, type CityRef } from '../domain/cityResolver.js';
import { localize, type Locale } from '../domain/localize.js';
import { comparableUah, sortKeyUah } from '../domain/currency.js';
import { buildDeepLink } from '../domain/deepLink.js';
import { cityIdInput, cityRefSchema, priceEntrySchema, moneySchema, comparableUahSchema } from '../domain/schemas.js';
import {
  wave1Pairs,
  case3Pairs,
  substitutionsOf,
  routeNames,
  alternativeDistance,
  type NearbyPairPlan,
} from '../domain/nearby.js';
import { Semaphore } from '../lib/semaphore.js';
import { logger } from '../lib/logger.js';
import { toolError, unexpectedToolError } from '../util/errors.js';
import { toolReply as reply } from '../util/reply.js';
import type { NearbyPairsResponse, SearchTripResponse } from '../backend/types.js';

const searchSlots = new Semaphore(config.MCP_MAX_CONCURRENT_SEARCHES);

export const tripSchema = z.object({
  external_id: z.string().describe('Opaque id "<providerId>:<tripId>" — pass to get_trip_details.'),
  carrier: z.object({
    id: z.number().int().describe('Carrier numeric id (Java Long → JSON number).'),
    display_name: z.string(),
    logo_url: z.string().nullable(),
  }),
  departure: z.object({
    city_name: z.string(),
    station_name: z.string().nullable(),
    datetime: z.string(),
    country_code: z.string().nullable(),
  }),
  arrival: z.object({
    city_name: z.string(),
    station_name: z.string().nullable(),
    datetime: z.string(),
    country_code: z.string().nullable(),
  }),
  duration_minutes: z.number().int().nullable().describe('arrival − departure; null if unparseable.'),
  prices: z.array(priceEntrySchema).describe('Carrier-native first (primary=true) + FX UAH if foreign. Render WITH currency.'),
  comparable_price_uah: comparableUahSchema.nullable().describe('UAH-equivalent sort key; is_uah=false → no rate (sorted last); null → no price (trip skipped).'),
  price_for_requested_pax: moneySchema.nullable().describe('Total for the requested pax in CARRIER-NATIVE currency (from passenger_prices, NOT FX).'),
  booking_available: z.boolean().describe('Can be reserved (pay-on-bus).'),
  purchase_available: z.boolean().describe('Can be bought online.'),
  free_seats: z.number().int(),
  transfers: z.number().int(),
  transfer_note: z.string().nullable(),
  carrier_discounts: z
    .array(z.object({ percent: z.number(), name: z.string().nullable() }))
    .describe(
      'Available passenger discounts for this trip (children by age, seniors, students, animals, etc.) — ' +
        'each with its percent and localized name (the NAME says who qualifies). May be empty on the very ' +
        'first ("cold") search of a route; a repeat search returns them. For the discounted PRICE per tier ' +
        'and a category, call get_trip_details.',
    ),
  discount_percent_range: z
    .object({ min: z.number(), max: z.number() })
    .nullable()
    .describe('Quick min/max discount percent across carrier_discounts (e.g. "−10% to −50%"); null if none.'),
});

const nearbyAlternativeSchema = z.object({
  case_no: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe('Which side was substituted: 1 = arrival, 2 = departure, 3 = both.'),
  from_city_id: z.string().describe('Pass as from_city_id to search_trips to list this route\'s trips.'),
  from_city_name: z.string(),
  to_city_id: z.string().describe('Pass as to_city_id to search_trips.'),
  to_city_name: z.string(),
  substitutions: z
    .array(
      z.object({
        replaces: z.string().describe('The city the user originally asked for.'),
        nearby_city: z.string().describe('The bigger city nearby that replaces it.'),
        distance_km: z.number().int().describe('Straight-line distance between them (rounded to 5 km).'),
      }),
    )
    .describe('ALWAYS relay these distances — the user must understand which city was swapped and how far it is.'),
  trips_found: z.number().int().describe('Trips CONFIRMED bookable on the date for the requested party size.'),
  min_price: moneySchema.nullable().describe('Cheapest confirmed trip, carrier-native currency.'),
  min_price_uah: z.number().nullable().describe('UAH-equivalent of the cheapest confirmed trip; null if no FX rate.'),
  booking_url: z.string().describe('Booking deep-link for THIS substituted route (tagged utm_campaign=nearby-fallback).'),
});

const outputSchema = {
  resolved_from: cityRefSchema.optional(),
  resolved_to: cityRefSchema.optional(),
  needs_disambiguation: z
    .object({ field: z.enum(['from', 'to']), query: z.string(), candidates: z.array(cityRefSchema) })
    .nullable()
    .describe('Non-null when a city name was ambiguous — ask the user to pick, then pass *_city_id.'),
  status: z.enum(['ok', 'busy']).describe('"busy" = throttled (NOT an empty result); retry shortly.'),
  date: z.string(),
  passengers: z.number().int(),
  partial: z.boolean().describe('true if the search timed out before completing; results may be incomplete.'),
  booking_url: z.string().nullable().describe('soloway.com.ua/search deep-link (with utm) to complete the booking.'),
  notes: z.array(z.string()).describe('Human-relayable caveats (past date, >6 pax clamp, partial, etc.).'),
  trips: z.array(tripSchema),
  nearby_alternatives: z
    .array(nearbyAlternativeSchema)
    .describe(
      'Only when trips is EMPTY: verified routes via bigger cities within ~60 km of the requested ' +
        'endpoints. Each entry was CONFIRMED by a real search to have bookable trips on the date — ' +
        'offer them to the user with the substitution distances, and call search_trips with the given ' +
        'city ids to list the actual trips.',
    ),
};

const inputSchema = {
  from: z.string().min(2).max(50).optional().describe('Departure city name (e.g. "Kyiv", "Київ"). Provide this OR from_city_id.'),
  to: z.string().min(2).max(50).optional().describe('Arrival city name. Provide this OR to_city_id.'),
  from_city_id: cityIdInput.optional().describe('Exact numeric departure city id (from a prior disambiguation). Overrides "from".'),
  to_city_id: cityIdInput.optional().describe('Exact numeric arrival city id. Overrides "to".'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Travel date YYYY-MM-DD (departure day, carrier-local).'),
  passengers: z.number().int().min(1).max(config.SEARCH_MAX_PASSENGERS).default(1).describe('Total passengers. Search supports up to 10; the booking LINK caps at 6 (7+ → link clamped + note).'),
  locale: z.enum(['uk', 'en']).default(config.DEFAULT_LOCALE).describe('Language for city/station names.'),
  sort: z.enum(['price', 'departure']).default('price').describe('Order by cheapest UAH-equivalent (default) or earliest departure.'),
  limit: z.number().int().min(1).max(config.SEARCH_MAX_RESULTS).default(config.SEARCH_MAX_RESULTS).describe('Max trips to return.'),
  utm_source: z.string().max(40).optional().describe('Attribution tag for the booking link (e.g. "claude"). Defaults to "ai-assistant".'),
};

function todayInKyiv(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD
}

function durationMinutes(departure: string, arrival: string): number | null {
  const dep = Date.parse(departure);
  const arr = Date.parse(arrival);
  if (Number.isNaN(dep) || Number.isNaN(arr)) return null;
  const mins = Math.round((arr - dep) / 60000);
  return mins >= 0 ? mins : null;
}

function discountRange(discounts: { percent: number }[]): { min: number; max: number } | null {
  const percents = discounts.map((d) => d.percent).filter((p) => p > 0);
  if (percents.length === 0) return null;
  return { min: Math.min(...percents), max: Math.max(...percents) };
}

function mapTrip(raw: SearchTripResponse, locale: Locale, passengers: number) {
  const comparable = comparableUah(raw.prices);
  const carrierDiscounts = raw.carrier_discounts ?? [];
  return {
    trip: {
      external_id: raw.external_id,
      carrier: raw.carrier,
      departure: {
        city_name: localize(raw.departure.city_name, locale) ?? '',
        station_name: localize(raw.departure.station_name, locale),
        datetime: raw.departure.datetime,
        country_code: raw.departure.country_code,
      },
      arrival: {
        city_name: localize(raw.arrival.city_name, locale) ?? '',
        station_name: localize(raw.arrival.station_name, locale),
        datetime: raw.arrival.datetime,
        country_code: raw.arrival.country_code,
      },
      duration_minutes: durationMinutes(raw.departure.datetime, raw.arrival.datetime),
      prices: raw.prices,
      comparable_price_uah: comparable,
      price_for_requested_pax: raw.passenger_prices?.[String(passengers)] ?? null,
      booking_available: raw.booking_available,
      purchase_available: raw.purchase_available,
      free_seats: raw.free_seats,
      transfers: raw.transfers,
      transfer_note: raw.transfer_note,
      carrier_discounts: carrierDiscounts,
      discount_percent_range: discountRange(carrierDiscounts),
    },
    comparable,
  };
}

type MappedTrip = ReturnType<typeof mapTrip>;
type TripOut = MappedTrip['trip'];

type NearbyAlternativeOut = z.infer<typeof nearbyAlternativeSchema>;

interface StructuredOverrides {
  resolved_from?: CityRef;
  resolved_to?: CityRef;
  needs_disambiguation?: { field: 'from' | 'to'; query: string; candidates: CityRef[] };
  status?: 'ok' | 'busy';
  partial?: boolean;
  booking_url?: string | null;
  notes?: string[];
  trips?: TripOut[];
  nearby_alternatives?: NearbyAlternativeOut[];
}

/** Single source of the search_trips structured payload; branches pass only their deltas. */
function makeStructured(date: string, passengers: number, over: StructuredOverrides) {
  return {
    resolved_from: over.resolved_from,
    resolved_to: over.resolved_to,
    needs_disambiguation: over.needs_disambiguation ?? null,
    status: over.status ?? ('ok' as const),
    date,
    passengers,
    partial: over.partial ?? false,
    booking_url: over.booking_url ?? null,
    notes: over.notes ?? [],
    trips: over.trips ?? [],
    nearby_alternatives: over.nearby_alternatives ?? [],
  };
}

/** Earliest-departure tiebreak (then external_id for stability) — shared by both sort modes. */
function byDeparture(a: MappedTrip, b: MappedTrip): number {
  const cmp = a.trip.departure.datetime.localeCompare(b.trip.departure.datetime);
  return cmp !== 0 ? cmp : a.trip.external_id.localeCompare(b.trip.external_id);
}

function renderAlternativeLine(alt: NearbyAlternativeOut): string {
  const swap = alt.substitutions
    .map((sub) => `${sub.nearby_city} is ${sub.distance_km} km from ${sub.replaces}`)
    .join(', ');
  const price = alt.min_price ? ` from ${alt.min_price.amount} ${alt.min_price.currency}` : '';
  return `${alt.from_city_name} → ${alt.to_city_name} (${swap}): ${alt.trips_found} trip(s)${price}`;
}

function renderText(
  fromName: string,
  toName: string,
  date: string,
  trips: { prices: { amount: number; currency: string; primary: boolean }[]; carrier: { display_name: string }; departure: { datetime: string } }[],
  notes: string[],
  alternatives: NearbyAlternativeOut[] = [],
): string {
  if (trips.length === 0) {
    const base = `No trips found for ${fromName} → ${toName} on ${date}.`;
    const alts = alternatives.length
      ? ` Verified nearby alternatives: ${alternatives.map(renderAlternativeLine).join('; ')}. Offer these with the distances; booking links are in nearby_alternatives.`
      : '';
    return `${base}${alts}${notes.length ? ' ' + notes.join(' ') : ''}`;
  }
  const cheapest = trips[0]!;
  const native = cheapest.prices.find((p) => p.primary) ?? cheapest.prices[0]!;
  const uah = cheapest.prices.find((p) => p.currency === 'UAH');
  const priceText =
    uah && native.currency !== 'UAH'
      ? `${native.amount} ${native.currency} (~${uah.amount} UAH)`
      : `${native.amount} ${native.currency}`;
  const head = `Found ${trips.length} trip${trips.length === 1 ? '' : 's'} ${fromName} → ${toName} on ${date}. Cheapest: ${cheapest.carrier.display_name} from ${priceText}.`;
  return notes.length ? `${head} ${notes.join(' ')}` : head;
}

interface NearbyVerifyContext {
  date: string;
  passengers: number;
  locale: Locale;
  utmSource?: string;
  originalFrom: string;
  originalTo: string;
}

/**
 * Verifies one substituted pair with a REAL (tighter-deadline) search. Returns the
 * alternative only when bookable trips for the party size were confirmed — the
 * agent must never relay a suggestion that leads to a second empty page.
 */
async function verifyNearbyPair(plan: NearbyPairPlan, ctx: NearbyVerifyContext): Promise<NearbyAlternativeOut | null> {
  const slot = await searchSlots.acquire(config.MCP_BUSY_WAIT_MS);
  if (!slot) return null; // saturated — silently skip, the fallback is best-effort

  const fromId = String(plan.pair.from_id);
  const toId = String(plan.pair.to_id);
  let trips: SearchTripResponse[];
  try {
    const result = await backend.searchTrips(
      { fromId, toId, date: ctx.date, passengers: ctx.passengers, locale: ctx.locale },
      config.MCP_NEARBY_SEARCH_TIMEOUT_MS,
    );
    trips = result.trips;
  } catch {
    return null; // a failed pair is dropped, never fails the whole tool
  } finally {
    searchSlots.release();
  }

  const bookable = trips.filter(
    (trip) => trip.free_seats >= ctx.passengers && (trip.booking_available || trip.purchase_available),
  );
  if (bookable.length === 0) return null;

  const cheapest = bookable
    .map((trip) => ({ trip, comparable: comparableUah(trip.prices) }))
    .sort((a, b) => sortKeyUah(a.comparable) - sortKeyUah(b.comparable))[0]!;
  const primaryPrice = cheapest.trip.prices.find((price) => price.primary) ?? cheapest.trip.prices[0] ?? null;

  const names = routeNames(plan.pair, ctx.originalFrom, ctx.originalTo);
  const deep = buildDeepLink({
    fromCityId: fromId,
    toCityId: toId,
    date: ctx.date,
    passengers: ctx.passengers,
    utmSource: ctx.utmSource,
    utmCampaign: 'nearby-fallback',
  });
  return {
    case_no: plan.caseNo,
    from_city_id: fromId,
    from_city_name: names.from,
    to_city_id: toId,
    to_city_name: names.to,
    substitutions: substitutionsOf(plan.pair, ctx.originalFrom, ctx.originalTo),
    trips_found: bookable.length,
    min_price: primaryPrice ? { amount: primaryPrice.amount, currency: primaryPrice.currency } : null,
    min_price_uah: cheapest.comparable?.is_uah ? cheapest.comparable.amount : null,
    booking_url: deep.url,
  };
}

/**
 * Nearby fallback for an empty search: fetch the substituted-pair matrix (in-memory
 * on the backend) and verify wave 1 (cases 1+2) in parallel; case 3 (both sides
 * substituted) is tried only when wave 1 confirmed nothing — the site's rule.
 * Any failure (incl. a backend without the endpoint yet) degrades to no suggestions.
 */
async function findNearbyAlternatives(ctx: NearbyVerifyContext, fromId: string, toId: string): Promise<NearbyAlternativeOut[]> {
  let matrix: NearbyPairsResponse;
  try {
    matrix = await backend.nearbyPairs(fromId, toId, ctx.locale);
  } catch (err) {
    logger.warn({ err: String(err) }, 'nearby.pairs.unavailable');
    return [];
  }

  const verify = async (plans: NearbyPairPlan[]) =>
    (await Promise.all(plans.map((plan) => verifyNearbyPair(plan, ctx)))).filter(
      (alt): alt is NearbyAlternativeOut => alt !== null,
    );

  let alternatives = await verify(wave1Pairs(matrix, config.MCP_NEARBY_MAX_VERIFY));
  if (alternatives.length === 0) alternatives = await verify(case3Pairs(matrix));
  return alternatives.sort(
    (a, b) => alternativeDistance(a.substitutions) - alternativeDistance(b.substitutions),
  );
}

export function registerSearchTrips(server: McpServer): void {
  server.registerTool(
    'search_trips',
    {
      title: 'Search bus trips',
      description:
        'Search live intercity bus trips between two cities on a specific date. Returns real-time prices, ' +
        'available seats, carriers, whether each trip can be booked (pay-on-bus) or bought online, transfer ' +
        'info, and a booking link. City names resolve automatically; if a name is ambiguous you get candidate ' +
        'cities to pick from — pass the chosen city_id via from_city_id/to_city_id. Each trip also lists the ' +
        'carrier\'s available passenger discounts (children by age, seniors, students, etc.) in carrier_discounts ' +
        'plus a quick discount_percent_range — surface these when listing options. Bookings complete on ' +
        'soloway.com.ua, not here. Searches work for any party size, but the booking link supports at most 6 ' +
        'passengers (the site cap) — for 7+ the link is clamped to 6 and a note is added. When NOTHING runs ' +
        'on the exact pair, the tool automatically verifies routes via bigger cities within ~60 km of the ' +
        'requested endpoints and returns confirmed ones in nearby_alternatives (each with substitution ' +
        'distances, trip count, cheapest price and its own booking link) — offer these instead of a bare ' +
        '"no trips" answer. If nothing runs nearby either, check other dates with get_calendar_prices ' +
        'and offer the nearest date that has trips.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const locale = (args.locale ?? config.DEFAULT_LOCALE) as Locale;
        const passengers = args.passengers ?? 1;

        const route = await resolveRoute(
          { from: args.from, to: args.to, from_city_id: args.from_city_id, to_city_id: args.to_city_id },
          locale,
        );
        if (route.status === 'missing') return toolError(`Please provide the ${route.field} city (a name or a numeric ${route.field}_city_id).`);
        if (route.status === 'none') return toolError(`Could not find a city matching the ${route.field} name. Try a different spelling.`);
        if (route.status === 'ambiguous') {
          return reply(
            makeStructured(args.date, passengers, {
              needs_disambiguation: { field: route.field, query: route.query, candidates: route.candidates },
              notes: [`The ${route.field} city "${route.query}" is ambiguous — ask the user to pick one and call again with ${route.field}_city_id.`],
            }),
          );
        }

        const { from: fromRef, to: toRef } = route;
        const notes: string[] = [];

        // Past-date: degraded-but-useful, never a hard error.
        if (args.date < todayInKyiv()) {
          return reply(
            makeStructured(args.date, passengers, {
              resolved_from: fromRef, resolved_to: toRef,
              notes: [`The date ${args.date} is in the past — no trips to show.`],
            }),
          );
        }

        // Concurrency back-pressure: graceful "busy", not an empty result.
        const slot = await searchSlots.acquire(config.MCP_BUSY_WAIT_MS);
        if (!slot) {
          return reply(
            makeStructured(args.date, passengers, {
              resolved_from: fromRef, resolved_to: toRef, status: 'busy',
              notes: ['The search service is busy right now — please retry in a few seconds.'],
            }),
          );
        }

        let result;
        try {
          result = await backend.searchTrips({ fromId: fromRef.city_id, toId: toRef.city_id, date: args.date, passengers, locale });
        } finally {
          searchSlots.release();
        }

        const mapped = result.trips
          .map((raw) => mapTrip(raw, locale, passengers))
          .filter((m) => m.comparable !== null); // skip price-less trips

        const sort = args.sort ?? 'price';
        mapped.sort((a, b) => {
          if (sort === 'departure') return byDeparture(a, b);
          const byPrice = sortKeyUah(a.comparable) - sortKeyUah(b.comparable);
          return byPrice !== 0 ? byPrice : byDeparture(a, b);
        });

        const limit = args.limit ?? config.SEARCH_MAX_RESULTS;
        // Defense-in-depth: validate each trip against the output schema and drop any that don't
        // conform, so one carrier's incomplete record can never fail the whole search's output
        // validation (degraded-but-useful over a hard error).
        let droppedInvalid = 0;
        const trips = mapped
          .slice(0, limit)
          .map((m) => m.trip)
          .filter((trip) => {
            if (tripSchema.safeParse(trip).success) return true;
            droppedInvalid++;
            return false;
          });

        const deep = buildDeepLink({ fromCityId: fromRef.city_id, toCityId: toRef.city_id, date: args.date, passengers, utmSource: args.utm_source });
        if (deep.clamped) notes.push(`Live availability is shown for ${passengers} passengers; the booking link supports a maximum of 6 — split the party across two bookings or contact support.`);
        if (result.partial) notes.push('The search timed out before completing — results may be incomplete; try again for the full list.');
        if (droppedInvalid > 0) {
          logger.warn({ dropped: droppedInvalid, from: fromRef.city_id, to: toRef.city_id }, 'search.trips.dropped_invalid');
          notes.push(`${droppedInvalid} trip(s) were omitted due to incomplete data.`);
        }

        // Nearby fallback — only on a CLEAN empty result (a partial empty may just be
        // a timeout; the retry note already covers it). Mirrors the site's behavior.
        let nearbyAlternatives: NearbyAlternativeOut[] = [];
        if (trips.length === 0 && !result.partial) {
          if (config.MCP_NEARBY_ENABLED) {
            nearbyAlternatives = await findNearbyAlternatives(
              {
                date: args.date, passengers, locale,
                utmSource: args.utm_source,
                originalFrom: fromRef.name, originalTo: toRef.name,
              },
              fromRef.city_id, toRef.city_id,
            );
          }
          if (nearbyAlternatives.length > 0) {
            notes.push(
              `No direct trips ${fromRef.name} → ${toRef.name} on ${args.date}; ` +
                `${nearbyAlternatives.length} verified nearby alternative route(s) are in nearby_alternatives — ` +
                'offer them to the user with the substitution distances.',
            );
          } else {
            // Nothing on this date and nothing nearby — the date itself may be the
            // problem. Point the assistant at the calendar tool so it can offer the
            // nearest date that DOES have trips ("none today, but 2 days later from …").
            notes.push(
              `No trips ${fromRef.name} → ${toRef.name} on ${args.date} and no nearby alternatives confirmed. ` +
                `The route may run on other dates: call get_calendar_prices for this route (month ${args.date.slice(0, 7)}) ` +
                'and offer the user the nearest date with available trips.',
            );
          }
        }

        const structured = makeStructured(args.date, passengers, {
          resolved_from: fromRef, resolved_to: toRef,
          partial: result.partial, booking_url: deep.url, notes, trips,
          nearby_alternatives: nearbyAlternatives,
        });
        return reply(structured, renderText(fromRef.name, toRef.name, args.date, trips, notes, nearbyAlternatives));
      } catch (err) {
        if (err instanceof BackendError) return toolError(`SoloWay returned an error (${err.status}) for this search. Please try again shortly.`);
        return unexpectedToolError(err, 'search_trips');
      }
    },
  );
}
