/**
 * Operational summary of a `POST /mcp` body: which JSON-RPC methods it carried, which tool a
 * `tools/call` targets, and which client named itself on `initialize`.
 *
 * This exists because nothing else can tell a real assistant session from a registry probe —
 * nginx sees an identical `POST /mcp 200` for both, so traffic to the published ChatGPT app is
 * otherwise unattributable. Method, tool and client names only: arguments are never read, so no
 * user content reaches the log (§5.4).
 */
export interface CallSummary {
  method: string;
  /** Tool name, for `tools/call` only. */
  tool?: string;
  /** Client name as self-reported on `initialize` (e.g. "ChatGPT", "Glama"). */
  client?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toSummary(message: unknown): CallSummary | undefined {
  const record = asRecord(message);
  // A response or a malformed frame carries no method — there is nothing operational to record.
  const method = asName(record?.method);
  if (!method) return undefined;
  const params = asRecord(record?.params);
  return {
    method,
    tool: method === 'tools/call' ? asName(params?.name) : undefined,
    client: method === 'initialize' ? asName(asRecord(params?.clientInfo)?.name) : undefined,
  };
}

/** JSON-RPC allows a batch, so a single body may carry several messages. */
export function summarizeMcpBody(body: unknown): CallSummary[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.map(toSummary).filter((summary): summary is CallSummary => summary !== undefined);
}
