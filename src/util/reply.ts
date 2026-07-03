/**
 * Wraps a structured payload in the MCP CallToolResult envelope. The human `content` text
 * defaults to the structured payload's first note. Shared by every tool.
 */
export function toolReply(
  structured: { notes?: string[] } & Record<string, unknown>,
  text?: string,
): { content: { type: 'text'; text: string }[]; structuredContent: typeof structured } {
  return {
    content: [{ type: 'text' as const, text: text ?? structured.notes?.[0] ?? '' }],
    structuredContent: structured,
  };
}
