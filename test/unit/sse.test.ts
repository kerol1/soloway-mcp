import { describe, it, expect } from 'vitest';
import { consumeTripsStream } from '../../src/backend/sse.js';

const enc = new TextEncoder();

/** Builds a ReadableStream of the given string chunks; closes after the last one. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

/** A stream that emits chunks then hangs forever; errors when the AbortController fires. */
function hangingStream(chunks: string[], signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      // intentionally never close
    },
  });
}

function trip(id: string, amount: number) {
  return { external_id: id, prices: [{ amount, currency: 'UAH', primary: true }] };
}

describe('consumeTripsStream', () => {
  it('aggregates multiple `event: trips` frames and reports partial=false on clean EOF', async () => {
    const frames = [
      `event: trips\ndata: ${JSON.stringify([trip('a:1', 900)])}\n\n`,
      `: ping\n\n`, // heartbeat comment — ignored
      `event: trips\ndata: ${JSON.stringify([trip('b:2', 800), trip('b:3', 700)])}\n\n`,
    ];
    const controller = new AbortController();
    const res = await consumeTripsStream(streamOf(frames), controller, { idleMs: 1000, overallMs: 5000 });
    expect(res.partial).toBe(false);
    expect(res.trips.map((t) => t.external_id)).toEqual(['a:1', 'b:2', 'b:3']);
  });

  it('handles CRLF line endings', async () => {
    const frame = `event: trips\r\ndata: ${JSON.stringify([trip('x:9', 500)])}\r\n\r\n`;
    const controller = new AbortController();
    const res = await consumeTripsStream(streamOf([frame]), controller, { idleMs: 1000, overallMs: 5000 });
    expect(res.trips).toHaveLength(1);
    expect(res.partial).toBe(false);
  });

  it('skips a malformed frame without failing the whole search', async () => {
    const frames = [
      `event: trips\ndata: {not-json}\n\n`,
      `event: trips\ndata: ${JSON.stringify([trip('ok:1', 600)])}\n\n`,
    ];
    const controller = new AbortController();
    const res = await consumeTripsStream(streamOf(frames), controller, { idleMs: 1000, overallMs: 5000 });
    expect(res.trips.map((t) => t.external_id)).toEqual(['ok:1']);
  });

  it('returns partial=true with collected trips when the idle watchdog fires', async () => {
    const controller = new AbortController();
    const stream = hangingStream([`event: trips\ndata: ${JSON.stringify([trip('p:1', 950)])}\n\n`], controller.signal);
    const res = await consumeTripsStream(stream, controller, { idleMs: 40, overallMs: 5000 });
    expect(res.partial).toBe(true);
    expect(res.trips.map((t) => t.external_id)).toEqual(['p:1']);
  });
});
