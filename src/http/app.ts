import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { makeMcpServer } from '../server.js';
import { originGuard, originAllowed } from './originGuard.js';

/** Cached backend-readiness probe so /readyz doesn't hammer the backend on every health tick. */
let readyCache: { ok: boolean; at: number } | null = null;
const READY_TTL_MS = 30_000;

async function backendReachable(): Promise<boolean> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache.ok;
  let ok = false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4_000);
  try {
    // EXACT path only — SecurityConfig permits exactly /actuator/health, not the /health/** group.
    const res = await fetch(`${config.BACKEND_BASE_URL}/actuator/health`, { signal: ac.signal });
    ok = res.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  readyCache = { ok, at: now };
  return ok;
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

  // Liveness (HEALTHCHECK-independent) + readiness (backend reachability) + crawl exclusion.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = await backendReachable();
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
