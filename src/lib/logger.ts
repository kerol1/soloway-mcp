import pino from 'pino';
import { config } from '../config.js';

/**
 * Single pino JSON logger. No PII / no user content is logged — only tool names,
 * timings, status codes, and operational events (§5.4).
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'soloway-mcp' },
  // Emit "INFO"/"WARN"/"ERROR" instead of pino's numeric 30/40/50. `level` is a Loki stream
  // label shared with the backend (alloy/config.alloy), and a label whose vocabulary depends
  // on which service emitted it is a label operators cannot query across services.
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
});
