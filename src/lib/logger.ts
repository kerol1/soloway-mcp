import pino from 'pino';
import { config } from '../config.js';

/**
 * Single pino JSON logger. No PII / no user content is logged — only tool names,
 * timings, status codes, and operational events (§5.4).
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'soloway-mcp' },
});
