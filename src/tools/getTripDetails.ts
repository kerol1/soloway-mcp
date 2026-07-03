import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { backend, BackendError } from '../backend/client.js';
import { resolveRoute, type CityRef } from '../domain/cityResolver.js';
import { localize, type Locale } from '../domain/localize.js';
import { buildDeepLink } from '../domain/deepLink.js';
import { cityIdInput, cityRefSchema } from '../domain/schemas.js';
import { toolError, unexpectedToolError } from '../util/errors.js';
import { toolReply as reply } from '../util/reply.js';
import type { AvailableDiscount, RouteStop } from '../backend/types.js';

const STOP_TYPES = ['DEPARTURE', 'INTERMEDIATE', 'ARRIVAL', 'OTHER'] as const;
const DISCOUNT_CATEGORIES = ['AGE', 'STUDENT', 'SPECIAL', 'COMPANION', 'OTHER'] as const;
type StopType = (typeof STOP_TYPES)[number];
type DiscountCategory = (typeof DISCOUNT_CATEGORIES)[number];

/** Unknown backend enum value → 'OTHER' so a new server value can't fail outputSchema validation. */
export function mapEnum<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const inputSchema = {
  external_id: z.string().min(1).describe('Opaque trip id "<providerId>:<tripId>" from a search_trips result.'),
  from: z.string().min(2).max(50).optional().describe('Departure city name (same route as the search). OR from_city_id.'),
  to: z.string().min(2).max(50).optional().describe('Arrival city name. OR to_city_id.'),
  from_city_id: cityIdInput.optional().describe('Numeric departure city id (overrides "from").'),
  to_city_id: cityIdInput.optional().describe('Numeric arrival city id (overrides "to").'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Travel date YYYY-MM-DD (same as the search).'),
  passengers: z.number().int().min(1).max(config.SEARCH_MAX_PASSENGERS).default(1).describe('Passenger count (same as the search).'),
  locale: z.enum(['uk', 'en']).default(config.DEFAULT_LOCALE).describe('Language for stop/city names.'),
  utm_source: z.string().max(40).optional().describe('Attribution tag for the booking link. Defaults to "ai-assistant".'),
};

const stopSchema = z.object({
  city_name: z.string().nullable(),
  station_name: z.string().nullable(),
  address: z.string().nullable(),
  arrival_time: z.string().nullable(),
  departure_time: z.string().nullable(),
  stop_type: z.enum(STOP_TYPES),
  bus_changed: z.boolean(),
  in_user_segment: z.boolean(),
});

const discountSchema = z.object({
  id: z.string(),
  name: z.string(),
  percentage: z.number().nullable(),
  ticket_price_with_discount: z.number().nullable(),
  category: z.enum(DISCOUNT_CATEGORIES),
});

const outputSchema = {
  resolved_from: cityRefSchema.optional(),
  resolved_to: cityRefSchema.optional(),
  needs_disambiguation: z
    .object({ field: z.enum(['from', 'to']), query: z.string(), candidates: z.array(cityRefSchema) })
    .nullable(),
  external_id: z.string(),
  stops: z.array(stopSchema).describe('All route stops in order.'),
  available_discounts: z
    .array(discountSchema)
    .describe(
      'Carrier per-passenger discounts for this trip. Each has name (localized, e.g. "Діти 1-10 років / ' +
        'Kinder 1-10"), percentage, ticket_price_with_discount, and category (AGE covers children & seniors; ' +
        'STUDENT, COMPANION = companion/pet, SPECIAL, OTHER). The NAME is authoritative for who qualifies — ' +
        'category is best-effort and may be OTHER for some tiers (e.g. seniors, disability).',
    ),
  seat_layout: z.unknown().describe('Opaque seat-map (carrier-specific); null for most carriers.'),
  legal_notice: z.string().nullable().describe('Carrier legal disclaimer in the requested locale, if any.'),
  booking_url: z.string().nullable().describe('Deep-link to search/book this route + date (with utm).'),
  notes: z.array(z.string()),
};

interface DetailsOverrides {
  resolved_from?: CityRef;
  resolved_to?: CityRef;
  needs_disambiguation?: { field: 'from' | 'to'; query: string; candidates: CityRef[] };
  stops?: z.infer<typeof stopSchema>[];
  available_discounts?: z.infer<typeof discountSchema>[];
  seat_layout?: unknown;
  legal_notice?: string | null;
  booking_url?: string | null;
  notes?: string[];
}

function makeDetails(externalId: string, over: DetailsOverrides) {
  return {
    resolved_from: over.resolved_from,
    resolved_to: over.resolved_to,
    needs_disambiguation: over.needs_disambiguation ?? null,
    external_id: externalId,
    stops: over.stops ?? [],
    available_discounts: over.available_discounts ?? [],
    seat_layout: over.seat_layout ?? null,
    legal_notice: over.legal_notice ?? null,
    booking_url: over.booking_url ?? null,
    notes: over.notes ?? [],
  };
}

function mapStop(stop: RouteStop, locale: Locale): z.infer<typeof stopSchema> {
  return {
    city_name: localize(stop.city_name, locale),
    station_name: localize(stop.station_name, locale),
    address: stop.address,
    arrival_time: stop.arrival_time,
    departure_time: stop.departure_time,
    stop_type: mapEnum<StopType>(stop.stop_type, STOP_TYPES, 'OTHER'),
    bus_changed: stop.bus_changed,
    in_user_segment: stop.in_user_segment,
  };
}

function mapDiscount(discount: AvailableDiscount): z.infer<typeof discountSchema> {
  return {
    id: discount.id,
    name: discount.name,
    percentage: discount.percentage,
    ticket_price_with_discount: discount.ticket_price_with_discount,
    category: mapEnum<DiscountCategory>(discount.category, DISCOUNT_CATEGORIES, 'OTHER'),
  };
}

export function registerGetTripDetails(server: McpServer): void {
  server.registerTool(
    'get_trip_details',
    {
      title: 'Get trip details',
      description:
        'Returns stops (with times), the carrier\'s per-passenger discounts (children by age band, students, ' +
        'seniors, people with disabilities, companions/pets, etc. — each with its percentage and the discounted ' +
        'ticket price), seat layout (if any), and legal notice for ONE trip from a search_trips result. Use this ' +
        'to tell a user about child/student/senior fares for a specific trip. Pass the trip\'s external_id plus ' +
        'the same route context (from/to + date + passengers) used in the search. If the trip id has expired, ' +
        're-run search_trips to get a fresh one. Booking completes on soloway.com.ua.',
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
            makeDetails(args.external_id, {
              needs_disambiguation: { field: route.field, query: route.query, candidates: route.candidates },
              notes: [`The ${route.field} city "${route.query}" is ambiguous — pick one and call again with ${route.field}_city_id.`],
            }),
          );
        }

        const { from: fromRef, to: toRef } = route;
        let details;
        try {
          details = await backend.tripDetails(args.external_id, fromRef.city_id, toRef.city_id, args.date, passengers, locale);
        } catch (err) {
          if (err instanceof BackendError && (err.status === 404 || err.status === 410)) {
            return toolError('This trip is no longer available (its id has expired). Re-run search_trips to get a fresh trip and try again.');
          }
          throw err;
        }

        const bookingUrl = buildDeepLink({ fromCityId: fromRef.city_id, toCityId: toRef.city_id, date: args.date, passengers, utmSource: args.utm_source }).url;
        const stops = (details.stops ?? []).map((stop) => mapStop(stop, locale));
        const text = `Trip ${args.external_id}: ${stops.length} stop${stops.length === 1 ? '' : 's'}, ${(details.available_discounts ?? []).length} discount option(s).`;

        return reply(
          makeDetails(args.external_id, {
            resolved_from: fromRef, resolved_to: toRef,
            stops,
            available_discounts: (details.available_discounts ?? []).map(mapDiscount),
            seat_layout: details.seat_layout ?? null,
            legal_notice: localize(details.legal_notice, locale),
            booking_url: bookingUrl,
          }),
          text,
        );
      } catch (err) {
        if (err instanceof BackendError) return toolError(`SoloWay returned an error (${err.status}) for this trip. Please try again shortly.`);
        return unexpectedToolError(err, 'get_trip_details');
      }
    },
  );
}
