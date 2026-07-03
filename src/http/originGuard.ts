import type { Request, Response, NextFunction } from 'express';
import { config, type OriginRule } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * CONFORMANCE AUTHORITY for the MCP 2025-11-25 "servers MUST respond 403 for invalid Origin"
 * requirement (§3.3). This Express middleware is the ONLY place wildcard origin matching lives
 * (the SDK transport does exact-match only, kept enabled as a belt with the exact subset).
 *
 * Rules:
 *  - Origin present  → must match ALLOWED_ORIGINS (exact or suffix-wildcard). `null` is NEVER allowed
 *    (sandboxed-iframe / DNS-rebinding attacks send `Origin: null`).
 *  - Origin absent   → typical server-to-server MCP client; gated by Host === EXPECTED_HOST
 *    (defense-in-depth; nginx already pins server_name). This is the real hot path.
 *  - Disallowed Origin or mismatched Host → 403.
 */
export function originAllowed(origin: string, rules: OriginRule[] = config.originRules): boolean {
  if (origin === 'null') return false; // explicit: never allowlist the null origin
  return rules.some((rule) => {
    if (rule.exact) return origin === rule.exact;
    if (rule.wildcard) {
      const { prefix, suffix } = rule.wildcard;
      return (
        origin.length > prefix.length + suffix.length &&
        origin.startsWith(prefix) &&
        origin.endsWith(suffix)
      );
    }
    return false;
  });
}

/**
 * Host gate for no-Origin (server-to-server) requests: any host when `*` is configured
 * (sandbox/introspection runs), otherwise exact match against the EXPECTED_HOST CSV.
 */
export function hostAllowed(
  host: string | undefined,
  hosts: string[] = config.expectedHosts,
  anyHost: boolean = config.anyHostAllowed,
): boolean {
  if (anyHost) return true;
  return typeof host === 'string' && hosts.includes(host);
}

/** Tagged so a boot-time self-check can confirm this exact guard is the one wired in. */
export const ORIGIN_GUARD_TAG = Symbol.for('soloway.mcp.originGuard');

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    if (originAllowed(origin)) return next();
    logger.warn({ origin, host: req.headers.host }, 'origin.rejected');
    reject403(res, 'Origin not allowed');
    return;
  }
  // No Origin header → server-to-server. Gate on Host.
  const host = req.headers.host;
  if (hostAllowed(host)) return next();
  logger.warn({ host }, 'host.rejected');
  reject403(res, 'Host not allowed');
}
(originGuard as unknown as Record<symbol, boolean>)[ORIGIN_GUARD_TAG] = true;

function reject403(res: Response, message: string): void {
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32600, message },
    id: null,
  });
}
