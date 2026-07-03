import { z } from 'zod';

/**
 * Environment configuration, zod-validated and frozen. Parsing failures throw on boot
 * (fail-fast) so a misconfigured container never serves traffic. See .env.example.
 */
const boolish = (def: string) =>
  z
    .string()
    .default(def)
    .transform((value) => value === 'true' || value === '1')
    .pipe(z.boolean());

const RawConfig = z.object({
  PORT: z.coerce.number().int().positive().default(8088),
  BACKEND_BASE_URL: z.string().url().default('http://backend:8080'),
  PUBLIC_BASE_URL: z.string().url().default('https://soloway.com.ua'),
  // CSV of accepted Host header values for no-Origin (server-to-server) requests; `*` accepts any
  // host AND disables the SDK's DNS-rebinding belt (sandbox/introspection runs — never production).
  EXPECTED_HOST: z.string().min(1).default('mcp.soloway.com.ua'),
  ALLOWED_ORIGINS: z
    .string()
    .default('https://claude.ai,https://*.claude.ai,https://chatgpt.com,https://*.openai.com,https://soloway.com.ua'),
  SSE_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(39_000),
  SSE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(13_000),
  HTTP_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  SEARCH_MAX_RESULTS: z.coerce.number().int().positive().default(40),
  SEARCH_MAX_PASSENGERS: z.coerce.number().int().positive().default(10),
  MCP_MAX_CONCURRENT_SEARCHES: z.coerce.number().int().positive().default(8),
  MCP_BUSY_WAIT_MS: z.coerce.number().int().nonnegative().default(1_500),
  DEFAULT_LOCALE: z.enum(['uk', 'en']).default('uk'),
  CACHE_TTL_AUTOCOMPLETE_MS: z.coerce.number().int().positive().default(3_600_000),
  CACHE_TTL_CALENDAR_MS: z.coerce.number().int().positive().default(900_000),
  CACHE_TTL_CALENDAR_PENDING_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_ENABLED: boolish('false'),
  NODE_ENV: z.string().default('production'),
  // Plain-text token served at /.well-known/openai-apps-challenge for ChatGPT App domain
  // verification (set from the OpenAI dashboard at submission time; empty → 404).
  OPENAI_APPS_CHALLENGE: z.string().default(''),
});

/** An allowed origin: either an exact string or a `{prefix, suffix}` suffix-wildcard pattern. */
export interface OriginRule {
  raw: string;
  exact?: string;
  wildcard?: { prefix: string; suffix: string };
}

function parseOriginRules(csv: string): OriginRule[] {
  return csv
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((raw) => {
      const star = raw.indexOf('*');
      if (star === -1) return { raw, exact: raw };
      // e.g. "https://*.claude.ai" → prefix "https://", suffix ".claude.ai"
      return { raw, wildcard: { prefix: raw.slice(0, star), suffix: raw.slice(star + 1) } };
    });
}

const parsed = RawConfig.parse(process.env);
const originRules = parseOriginRules(parsed.ALLOWED_ORIGINS);
const expectedHosts = parsed.EXPECTED_HOST.split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

export const config = Object.freeze({
  ...parsed,
  originRules,
  /** Exact (non-wildcard) origins only — passed to the SDK's exact-match belt (§3.3). */
  exactOrigins: originRules.flatMap((rule) => (rule.exact ? [rule.exact] : [])),
  /** Parsed EXPECTED_HOST CSV. */
  expectedHosts,
  /** `*` in EXPECTED_HOST: accept any Host and drop the SDK DNS-rebinding belt (sandbox only). */
  anyHostAllowed: expectedHosts.includes('*'),
});

export type Config = typeof config;
