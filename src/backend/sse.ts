import type { SearchTripResponse } from './types.js';

export interface SseResult {
  trips: SearchTripResponse[];
  /**
   * true when the client gave up (idle watchdog or overall deadline) before the server's clean
   * EOF. NOTE: even partial=false is NOT a server-side completeness guarantee — the backend EOFs
   * cleanly with no per-carrier done/error, so slow carriers dropped at its 32s scope timeout are
   * invisible here (documented open risk).
   */
  partial: boolean;
}

export interface SseTimeouts {
  idleMs: number;
  overallMs: number;
}

/**
 * Consumes the `/api/trips/stream` SSE response: parses `:ping` heartbeats (ignored, but they
 * reset the idle watchdog), aggregates every `event: trips` JSON array, and returns on the
 * server's clean EOF (partial:false). An idle gap > idleMs or total time > overallMs aborts the
 * shared controller and yields whatever was collected with partial:true. Line-based parser
 * handles both `\n` and `\r\n`.
 */
export async function consumeTripsStream(
  body: ReadableStream<Uint8Array> | null,
  controller: AbortController,
  timeouts: SseTimeouts,
): Promise<SseResult> {
  const trips: SearchTripResponse[] = [];
  if (!body) return { trips, partial: controller.signal.aborted };

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const dispatch = () => {
    if (eventName === 'trips' && dataLines.length > 0) {
      try {
        const parsed = JSON.parse(dataLines.join('\n'));
        if (Array.isArray(parsed)) trips.push(...(parsed as SearchTripResponse[]));
      } catch {
        /* skip a malformed frame rather than failing the whole search */
      }
    }
    eventName = '';
    dataLines = [];
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), timeouts.idleMs);
  };
  const overallTimer = setTimeout(() => controller.abort(), timeouts.overallMs);
  resetIdle();

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break; // clean EOF → partial stays false
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          dispatch();
        } else if (line.startsWith(':')) {
          /* comment / heartbeat — ignore (idle already reset by the chunk) */
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } catch {
    /* aborted (idle/overall) or mid-stream network error → partial */
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return { trips, partial: controller.signal.aborted };
}
