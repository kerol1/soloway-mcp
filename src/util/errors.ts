import { logger } from '../lib/logger.js';

export interface ToolError {
  // index signature required to satisfy the SDK's CallToolResult (a passthrough Result type)
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: true;
}

/** A tool handler never throws — it returns this shape so the model can relay an actionable message. */
export function toolError(message: string): ToolError {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Wraps an unexpected exception into a tool error with a generic, safe message (no internals
 * leaked to the model/user) while logging the real cause.
 */
export function unexpectedToolError(err: unknown, context: string): ToolError {
  logger.error({ err, context }, 'tool.unexpected_error');
  return toolError(
    'Sorry — something went wrong reaching SoloWay. Please try again in a moment.',
  );
}
