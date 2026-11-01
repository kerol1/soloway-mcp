import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendClient } from '../../src/backend/client.js';

describe('BackendClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the configured brand on every /api call', async () => {
    // No assertion reads a payload, and an empty JSON array satisfies every method — the SSE stream included.
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient('http://backend.test');

    await client.searchTrips({ fromId: '1', toId: '2', date: '2026-11-01', passengers: 1, locale: 'uk' }, 1_000);
    await client.autocomplete('Київ', 'uk');
    await client.citiesByIds(['1'], 'uk');
    await client.calendarPrices('1', '2', '2026-11');
    await client.nearbyPairs('1', '2', 'uk');
    await client.tripDetails('trip-1', '1', '2', '2026-11-01', 1, 'uk');

    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('X-Brand'), String(url)).toBe('soloway');
    }
    const streamCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/trips/stream'));
    expect(new Headers(streamCall?.[1]?.headers).get('Accept')).toBe('text/event-stream');
  });
});
