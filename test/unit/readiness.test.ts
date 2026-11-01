import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendReadiness } from '../../src/http/app.js';

type FetchArgs = [url: string | URL | Request, init?: RequestInit];

/** Stubs the backend behind global fetch; every call gets `answer`'s result. */
function stubBackend(answer: (init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (_url: FetchArgs[0], init?: FetchArgs[1]) => answer(init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const popular = async () => Response.json({ data: [{ id: 1, name: 'Київ' }] });

describe('backendReadiness (/readyz)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is ready when the backend answers a public /api call for this server\'s brand', async () => {
    const fetchMock = stubBackend(popular);

    expect(await backendReadiness('http://backend.test')()).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://backend.test/api/search/bus/popular?locale=uk&limit=1');
    expect(new Headers(init?.headers).get('X-Brand')).toBe('soloway');
  });

  it.each(['BRAND_REQUIRED', 'BRAND_UNKNOWN'])(
    'is not ready when the backend refuses the brand (400 %s): every tool call would be refused the same way',
    async (reason) => {
      stubBackend(async () => Response.json({ status: 400, reason }, { status: 400 }));

      expect(await backendReadiness('http://backend.test')()).toBe(false);
    },
  );

  it('is not ready on any answer but 200, or when the backend cannot be reached', async () => {
    stubBackend(async () => new Response(null, { status: 401 }));
    expect(await backendReadiness('http://backend.test')()).toBe(false);

    stubBackend(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await backendReadiness('http://backend.test')()).toBe(false);
  });

  it('asks the backend at most once per 30 s', async () => {
    vi.useFakeTimers();
    const fetchMock = stubBackend(popular);
    const ready = backendReadiness('http://backend.test');

    await ready();
    await vi.advanceTimersByTimeAsync(29_999);
    await ready();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await ready();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a backend that does not answer within 4 s', async () => {
    vi.useFakeTimers();
    stubBackend(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const answer = backendReadiness('http://backend.test')();
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(answer).resolves.toBe(false);
  });
});
