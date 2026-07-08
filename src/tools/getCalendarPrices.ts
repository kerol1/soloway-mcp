import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { backend, BackendError } from '../backend/client.js';
import { resolveRoute, type CityRef } from '../domain/cityResolver.js';
import { buildDeepLink } from '../domain/deepLink.js';
import { cityIdInput, cityRefSchema } from '../domain/schemas.js';
import { TtlCache } from '../lib/cache.js';
import { toolError, unexpectedToolError } from '../util/errors.js';
import { toolReply as reply } from '../util/reply.js';
import type { Locale } from '../domain/localize.js';
import type { CalendarPricesResponse } from '../backend/types.js';

const calendarCache = new TtlCache<CalendarPricesResponse>(config.CACHE_TTL_CALENDAR_MS);

const inputSchema = {
  from: z.string().min(2).max(50).optional().describe('Departure city name. Provide this OR from_city_id.'),
  to: z.string().min(2).max(50).optional().describe('Arrival city name. Provide this OR to_city_id.'),
  from_city_id: cityIdInput.optional().describe('Exact numeric departure city id (overrides "from").'),
  to_city_id: cityIdInput.optional().describe('Exact numeric arrival city id (overrides "to").'),
  month: z.string().regex(/^\d{4}-\d{2}$/).describe('Month to price, YYYY-MM (e.g. 2026-07).'),
  locale: z.enum(['uk', 'en']).default(config.DEFAULT_LOCALE).describe('Language for resolved city names.'),
  utm_source: z.string().max(40).optional().describe('Attribution tag for the booking link. Defaults to "ai-assistant".'),
};

const dayPriceSchema = z.object({
  date: z.string().describe('YYYY-MM-DD'),
  min_price: z.number().nullable().describe('Cheapest UAH price that day, or null if no availability.'),
});

const outputSchema = {
  resolved_from: cityRefSchema.optional(),
  resolved_to: cityRefSchema.optional(),
  needs_disambiguation: z
    .object({ field: z.enum(['from', 'to']), query: z.string(), candidates: z.array(cityRefSchema) })
    .nullable()
    .describe('Non-null when a city name was ambiguous — ask the user to pick, then pass *_city_id.'),
  month: z.string(),
  currency: z.string().describe('Always UAH (calendar prices are UAH-equivalent).'),
  pending: z.boolean().describe('true = some carriers still loading; call again shortly for a fuller month.'),
  data_status: z.enum(['complete', 'partial']).describe('"complete" = final/authoritative; "partial" = still loading (mirrors pending).'),
  coverage: z.enum(['full', 'today_onward']).describe('Date-range coverage (separate from load status): "today_onward" = current month omits past days (not "no buses").'),
  prices: z.array(dayPriceSchema).describe('Per-day cheapest price, ascending by date. A day with min_price=null was checked and has NO trips (distinct from a day still loading — see missing_days).'),
  loaded_days: z.array(z.string()).describe('Days already resolved (the dates present in prices, priced or null).'),
  missing_days: z.array(z.string()).describe('Days in the queried window not yet loaded — re-poll for these. Empty when data_status="complete".'),
  completion_percent: z.number().describe('Percent of the queried window resolved so far (0–100; 100 when complete).'),
  cheapest: z.object({ date: z.string(), min_price: z.number() }).nullable().describe('Cheapest day in the month, or null if none priced.'),
  booking_url: z.string().nullable().describe('Deep-link to search the cheapest day (with utm).'),
  notes: z.array(z.string()),
};

interface CalendarOverrides {
  resolved_from?: CityRef;
  resolved_to?: CityRef;
  needs_disambiguation?: { field: 'from' | 'to'; query: string; candidates: CityRef[] };
  pending?: boolean;
  data_status?: 'complete' | 'partial';
  coverage?: 'full' | 'today_onward';
  prices?: { date: string; min_price: number | null }[];
  loaded_days?: string[];
  missing_days?: string[];
  completion_percent?: number;
  cheapest?: { date: string; min_price: number } | null;
  booking_url?: string | null;
  notes?: string[];
}

function makeCalendar(month: string, over: CalendarOverrides) {
  return {
    resolved_from: over.resolved_from,
    resolved_to: over.resolved_to,
    needs_disambiguation: over.needs_disambiguation ?? null,
    month,
    currency: 'UAH',
    pending: over.pending ?? false,
    data_status: over.data_status ?? ('complete' as const),
    coverage: over.coverage ?? ('full' as const),
    prices: over.prices ?? [],
    loaded_days: over.loaded_days ?? [],
    missing_days: over.missing_days ?? [],
    completion_percent: over.completion_percent ?? 100,
    cheapest: over.cheapest ?? null,
    booking_url: over.booking_url ?? null,
    notes: over.notes ?? [],
  };
}

function currentMonthKyiv(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }).slice(0, 7); // YYYY-MM
}

function todayInKyiv(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD
}

/**
 * The dates the backend is expected to price for a month, mirroring its buildDateRange: a past month
 * yields none; the current month starts at today (Kyiv tz); a future month covers the 1st onward.
 */
function monthWindow(month: string): string[] {
  const current = currentMonthKyiv();
  if (month < current) return [];
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year!, mon!, 0)).getUTCDate(); // day 0 of next month = last of this
  const startDay = month === current ? Number(todayInKyiv().slice(8, 10)) : 1;
  const days: string[] = [];
  for (let day = startDay; day <= lastDay; day++) days.push(`${month}-${String(day).padStart(2, '0')}`);
  return days;
}

export interface LoadStatus {
  loaded_days: string[];
  missing_days: string[];
  completion_percent: number;
  data_status: 'complete' | 'partial';
}

/**
 * Turns the backend's (prices, pending) into an explicit load status. A present day (priced or null)
 * is resolved; an absent day in the queried window is still loading. When !pending the backend is
 * authoritative that it settled, so we report complete regardless of any window/tz drift.
 */
export function computeLoadStatus(prices: Record<string, number | null>, pending: boolean, month: string): LoadStatus {
  const loaded_days = Object.keys(prices).sort();
  if (!pending) return { loaded_days, missing_days: [], completion_percent: 100, data_status: 'complete' };
  const expected = monthWindow(month);
  const loaded = new Set(loaded_days);
  const missing_days = expected.filter((date) => !loaded.has(date));
  const inWindow = expected.length - missing_days.length;
  const completion_percent = expected.length === 0 ? 100 : Math.round((inWindow / expected.length) * 100);
  return { loaded_days, missing_days, completion_percent, data_status: 'partial' };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One bounded re-poll on pending; caches only settled results (pending is transient). */
async function fetchCalendar(fromId: string, toId: string, month: string): Promise<CalendarPricesResponse> {
  const key = `${fromId}:${toId}:${month}`;
  const cached = calendarCache.get(key);
  if (cached) return cached;
  let res = await backend.calendarPrices(fromId, toId, month);
  if (res.pending) {
    await sleep(1500);
    res = await backend.calendarPrices(fromId, toId, month);
  }
  if (!res.pending) calendarCache.set(key, res);
  return res;
}

export function registerGetCalendarPrices(server: McpServer): void {
  server.registerTool(
    'get_calendar_prices',
    {
      title: 'Get cheapest dates in a month',
      description:
        'Returns the cheapest bus price per day for a route across a whole month (UAH), so you can find the ' +
        'best day to travel. City names resolve automatically; ambiguous names return candidates to pick from. ' +
        'For the current month, past days are omitted (coverage="today_onward") — that is not "no buses". If ' +
        'pending=true some carriers are still loading; call again shortly. Use search_trips for the actual trips ' +
        'on a chosen day.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const locale = (args.locale ?? config.DEFAULT_LOCALE) as Locale;
        const route = await resolveRoute(
          { from: args.from, to: args.to, from_city_id: args.from_city_id, to_city_id: args.to_city_id },
          locale,
        );
        if (route.status === 'missing') return toolError(`Please provide the ${route.field} city (a name or a numeric ${route.field}_city_id).`);
        if (route.status === 'none') return toolError(`Could not find a city matching the ${route.field} name. Try a different spelling.`);
        if (route.status === 'ambiguous') {
          return reply(
            makeCalendar(args.month, {
              needs_disambiguation: { field: route.field, query: route.query, candidates: route.candidates },
              notes: [`The ${route.field} city "${route.query}" is ambiguous — pick one and call again with ${route.field}_city_id.`],
            }),
          );
        }

        const { from: fromRef, to: toRef } = route;
        const res = await fetchCalendar(fromRef.city_id, toRef.city_id, args.month);

        const prices = Object.entries(res.prices)
          .map(([date, min_price]) => ({ date, min_price }))
          .sort((a, b) => a.date.localeCompare(b.date));

        let cheapest: { date: string; min_price: number } | null = null;
        for (const { date, min_price } of prices) {
          if (min_price != null && (cheapest === null || min_price < cheapest.min_price)) cheapest = { date, min_price };
        }

        const load = computeLoadStatus(res.prices, res.pending, args.month);
        const coverage = args.month === currentMonthKyiv() ? ('today_onward' as const) : ('full' as const);
        const notes: string[] = [];
        if (coverage === 'today_onward') notes.push('This is the current month, so days before today are omitted (not "no buses").');
        if (res.pending) {
          notes.push(
            `Still loading ${load.missing_days.length} day(s) (${load.completion_percent}% of the month resolved) — ` +
              'call again shortly for the missing_days. A day shown with min_price=null was checked and has no trips.',
          );
        }

        const bookingUrl = cheapest
          ? buildDeepLink({ fromCityId: fromRef.city_id, toCityId: toRef.city_id, date: cheapest.date, passengers: 1, utmSource: args.utm_source }).url
          : null;

        const text = cheapest
          ? `Cheapest ${fromRef.name} → ${toRef.name} in ${args.month}: ${cheapest.min_price} UAH on ${cheapest.date}.`
          : `No priced days found for ${fromRef.name} → ${toRef.name} in ${args.month}.${res.pending ? ' Some carriers are still loading — try again shortly.' : ''}`;

        return reply(
          makeCalendar(args.month, {
            resolved_from: fromRef, resolved_to: toRef,
            pending: res.pending, data_status: load.data_status, coverage, prices,
            loaded_days: load.loaded_days, missing_days: load.missing_days, completion_percent: load.completion_percent,
            cheapest, booking_url: bookingUrl, notes,
          }),
          text,
        );
      } catch (err) {
        if (err instanceof BackendError) return toolError(`SoloWay returned an error (${err.status}) for the calendar. Please try again shortly.`);
        return unexpectedToolError(err, 'get_calendar_prices');
      }
    },
  );
}
