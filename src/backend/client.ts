import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { Locale } from '../domain/localize.js';
import type {
  BackendCity,
  CityAutocompleteResponse,
  CalendarPricesResponse,
  TripDetailsResponse,
} from './types.js';
import { consumeTripsStream, type SseResult } from './sse.js';

/** Non-2xx from the backend (after the BasicAuthGateFilter carve-out, 401 should never happen). */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface SearchParams {
  fromId: string;
  toId: string;
  date: string;
  passengers: number;
  locale: Locale;
}

function qs(params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  // Query params are the backend's camelCase Java names (SNAKE_CASE is body-only). Sending
  // from_id/to_id would NOT bind and 400.
  for (const [key, value] of Object.entries(params)) sp.set(key, String(value));
  return sp.toString();
}

/** Thin typed wrapper over fetch. No retries on carrier-facing calls (politeness). */
export class BackendClient {
  constructor(private readonly baseUrl: string = config.BACKEND_BASE_URL) {}

  /**
   * Opens the search SSE stream and aggregates it. Never throws on timeout — returns whatever was
   * collected with partial:true (incl. an empty list if the connect itself timed out). Throws
   * BackendError only on a non-OK HTTP status.
   */
  async searchTrips(params: SearchParams): Promise<SseResult> {
    const url = `${this.baseUrl}/api/trips/stream?${qs({
      fromId: params.fromId,
      toId: params.toId,
      date: params.date,
      passengers: params.passengers,
      locale: params.locale,
    })}`;
    const controller = new AbortController();
    // Overall deadline covers connect + stream; the idle watchdog lives in the consumer.
    const overallTimer = setTimeout(() => controller.abort(), config.SSE_READ_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) throw new BackendError(res.status, `search stream ${res.status}`);
      return await consumeTripsStream(res.body, controller, {
        idleMs: config.SSE_IDLE_TIMEOUT_MS,
        overallMs: config.SSE_READ_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof BackendError) throw err;
      // AbortError (deadline during connect) or pre-response network error → degraded, not fatal.
      logger.warn({ err: String(err) }, 'search.stream.aborted_or_failed');
      return { trips: [], partial: true };
    } finally {
      clearTimeout(overallTimer);
    }
  }

  /** City name → candidates. `locale` is REQUIRED by the backend (omit → 400). */
  async autocomplete(query: string, locale: Locale, limit = 10): Promise<BackendCity[]> {
    return this.getJson<CityAutocompleteResponse>(
      `/api/search/bus/autocomplete?${qs({ query, locale, limit })}`,
      'autocomplete',
    ).then((data) => data.data ?? []);
  }

  /**
   * Batch id → full city (reverse of autocomplete). Backend caps at 10 ids and returns a BARE
   * `CityDto[]` (NOT the `{data}` envelope autocomplete uses). Used to (a) resolve a caller-supplied
   * numeric *_city_id into a real city object and (b) render a name-resolved city in the requested
   * locale when it was looked up in the other script. Empty input → no call.
   */
  async citiesByIds(ids: string[], locale: Locale): Promise<BackendCity[]> {
    if (ids.length === 0) return [];
    return this.getJson<BackendCity[]>(`/api/search/cities?${qs({ ids: ids.join(','), locale })}`, 'cities-by-id');
  }

  /** Per-date min prices for a month (UAH-equivalent). `month` = YYYY-MM. No locale param. */
  async calendarPrices(fromId: string, toId: string, month: string): Promise<CalendarPricesResponse> {
    return this.getJson<CalendarPricesResponse>(
      `/api/calendar-prices?${qs({ fromId, toId, month })}`,
      'calendar-prices',
    );
  }

  /** Stops, discounts, seat layout for one trip. `externalId` from a search result. */
  async tripDetails(externalId: string, fromId: string, toId: string, date: string, passengers: number, locale: Locale): Promise<TripDetailsResponse> {
    const path = `/api/trips/${encodeURIComponent(externalId)}/details?${qs({ fromId, toId, date, passengers, locale })}`;
    return this.getJson<TripDetailsResponse>(path, 'trip-details');
  }

  /** Shared GET → JSON with a timeout; throws BackendError on a non-OK status. */
  private async getJson<T>(path: string, label: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.HTTP_READ_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new BackendError(res.status, `${label} ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const backend = new BackendClient();
