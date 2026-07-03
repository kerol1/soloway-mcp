import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createApp, assertOriginGuardMounted } from './http/app.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

const app = createApp();
assertOriginGuardMounted(app); // exits non-zero (throw → unhandled) if the guard isn't load-bearing

const httpServer = app.listen(config.PORT, () => {
  logger.info(
    { name: SERVER_NAME, version: SERVER_VERSION, port: config.PORT, host: config.EXPECTED_HOST },
    'mcp.server.listening',
  );
});

// Never close a connection mid-SSE: keep-alive must sit above the client SSE deadline (§3.4).
httpServer.keepAliveTimeout = 40_000;
httpServer.headersTimeout = 41_000;

function shutdown(signal: string): void {
  logger.info({ signal }, 'mcp.server.shutdown');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
