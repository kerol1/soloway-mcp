import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { makeMcpServer } from '../server.js';
import { summarizeMcpBody } from '../lib/callSummary.js';
import { backendHeaders } from '../backend/client.js';
import { originGuard, originAllowed } from './originGuard.js';

/** /readyz asks the backend at most this often, so it doesn't hammer it on every health tick. */
const READY_TTL_MS = 30_000;
const READY_TIMEOUT_MS = 4_000;

/**
 * The /readyz probe: ready only when the backend answers 200 to a brand-scoped /api call with this server's
 * X-Brand, the same header every tool call sends. A backend that is up but refuses the brand
 * (400 BRAND_REQUIRED / BRAND_UNKNOWN) would refuse every tool call too, so it is not ready.
 * The call is the popular-cities list: public like every endpoint the tools use, answered from a cache with
 * no carrier behind it. Each probe keeps its answer for 30 s.
 */
const READY_PROBE_PATH = '/api/search/bus/popular?locale=uk&limit=1';
export function backendReadiness(baseUrl: string = config.BACKEND_BASE_URL): () => Promise<boolean> {
  let cached: { ok: boolean; at: number } | null = null;
  return async () => {
    const now = Date.now();
    if (cached && now - cached.at < READY_TTL_MS) return cached.ok;
    const ok = await backendAnswered(baseUrl);
    cached = { ok, at: now };
    return ok;
  };
}

async function backendAnswered(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${READY_PROBE_PATH}`, { headers: backendHeaders(), signal: controller.signal });
    if (res.status === 200) return true;
    logger.warn({ status: res.status }, 'readyz.not_ready');
    return false;
  } catch (err) {
    logger.warn({ err: String(err) }, 'readyz.not_ready');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  // Stateless server: GET/DELETE have no usable channel. HTTP 405 is authoritative; no JSON-RPC
  // body — do NOT reuse -32601 (that implies a parsed-but-unknown JSON-RPC method; none was parsed).
  res.status(405).end();
}

/**
 * Builds the Express app: Origin/Host guard mounted BEFORE the /mcp POST handler (§3.3), the
 * stateless streamable-HTTP transport (fresh server + transport per request, §3.5), and the
 * operational endpoints. `app.locals.originGuardMounted` records the load-bearing mount for the
 * boot-time assertion in index.ts.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const backendReady = backendReadiness();

  // Liveness (HEALTHCHECK-independent) + readiness (the backend serves this brand) + crawl exclusion.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = await backendReady();
    res.status(ready ? 200 : 503).json({ ready });
  });
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  // ChatGPT App domain verification: OpenAI GETs this exact path and expects the raw token as
  // plain text. Token is supplied via OPENAI_APPS_CHALLENGE at submission time; 404 until set.
  app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    if (!config.OPENAI_APPS_CHALLENGE) {
      res.status(404).end();
      return;
    }
    res.type('text/plain').send(config.OPENAI_APPS_CHALLENGE);
  });

  // CONFORMANCE-AUTHORITY Origin/Host guard — MUST precede the /mcp POST handler.
  app.use('/mcp', originGuard);
  app.locals.originGuardMounted = true;

  app.post('/mcp', async (req, res) => {
    const startedAt = Date.now();
    // Read the summary BEFORE the transport consumes the body (§5.4).
    const calls = summarizeMcpBody(req.body);
    const server = makeMcpServer(); // per-request (stateless default, §3.5)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      // originGuard middleware is the SOLE Origin authority (it handles wildcard subdomains). We do
      // NOT pass allowedOrigins to the SDK: its exact-match check would 403 a legitimate
      // wildcard-subdomain origin (e.g. https://foo.claude.ai) that the middleware already approved.
      // The SDK belt is kept for HOST only (exact EXPECTED_HOST CSV) — verified against 1.29.0 where
      // enableDnsRebindingProtection works with allowedHosts alone. `EXPECTED_HOST=*` (sandbox
      // introspection runs, e.g. Glama) drops the belt — the middleware already let any host in.
      enableDnsRebindingProtection: !config.anyHostAllowed,
      allowedHosts: config.expectedHosts,
    });
    res.on('close', () => {
      logger.info({ calls, status: res.statusCode, duration_ms: Date.now() - startedAt }, 'mcp.request');
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'mcp.request.failed');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

/**
 * Boot-time self-check: the originGuard is the conformance authority, so the process refuses to
 * start if it isn't mounted (flag set in createApp right at the mount) or if its logic is wrong.
 * Functional self-test avoids fragile Express-router introspection while still failing closed.
 */
export function assertOriginGuardMounted(app: Express): void {
  if (app.locals.originGuardMounted !== true) {
    throw new Error('originGuard not mounted on /mcp — refusing to start');
  }
  // Logic self-test: null + disallowed rejected, a real allowed origin accepted.
  const disallowed = originAllowed('https://evil.example');
  const nullOrigin = originAllowed('null');
  const allowed = config.exactOrigins.length > 0 ? originAllowed(config.exactOrigins[0]!) : true;
  if (disallowed || nullOrigin || !allowed) {
    throw new Error('originGuard self-test failed — refusing to start');
  }
}
