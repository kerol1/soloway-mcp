import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerSearchTrips } from './tools/searchTrips.js';
import { registerGetCalendarPrices } from './tools/getCalendarPrices.js';
import { registerGetTripDetails } from './tools/getTripDetails.js';

export const SERVER_NAME = 'soloway';
export const SERVER_VERSION = '0.1.0';

/** ≤512 chars — cross-tool guidance shown to the model on initialize (§3.2). */
const INSTRUCTIONS =
  'SoloWay finds live intercity bus trips across Ukraine & Europe. Use search_trips for trips on a ' +
  'specific date (live prices, seats, carriers, and a booking link). Use get_calendar_prices to find the ' +
  'cheapest dates in a month. Use get_trip_details for stops, discounts, and seat info of one trip from ' +
  'search results. City names resolve automatically; if ambiguous, ask the user to pick. Always show the ' +
  'booking link — bookings happen on soloway.com.ua, not here.';

/**
 * Builds a fresh McpServer with all tools registered. Phase 0 ships only a trivial `ping`
 * tool; Phases 1–3 add search_trips / get_calendar_prices / get_trip_details.
 *
 * A new server is built per request (stateless, §3.5 default) — tool/schema registration is
 * cheap relative to a carrier fan-out, and per-request construction avoids any shared-handler
 * races across concurrently-connected transports.
 */
export function makeMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Connectivity/health check. Returns "pong" and the server version. No inputs.',
      outputSchema: { pong: z.literal(true), version: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
      structuredContent: { pong: true, version: SERVER_VERSION },
    }),
  );

  registerSearchTrips(server); // Phase 1
  registerGetCalendarPrices(server); // Phase 2
  registerGetTripDetails(server); // Phase 3

  return server;
}
