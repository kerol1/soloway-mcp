import { describe, it, expect } from 'vitest';
import { summarizeMcpBody } from '../../src/lib/callSummary.js';

describe('summarizeMcpBody', () => {
  it('names the client that identified itself on initialize', () => {
    expect(
      summarizeMcpBody({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'ChatGPT', version: '1.0' } },
      }),
    ).toEqual([{ method: 'initialize', tool: undefined, client: 'ChatGPT' }]);
  });

  it('names the tool a tools/call targets', () => {
    expect(
      summarizeMcpBody({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_trips' } }),
    ).toEqual([{ method: 'tools/call', tool: 'search_trips', client: undefined }]);
  });

  it('never carries tool arguments into the log', () => {
    const [summary] = summarizeMcpBody({
      method: 'tools/call',
      params: { name: 'search_trips', arguments: { from: 'Київ', to: 'Львів', date: '2026-09-01' } },
    });
    expect(JSON.stringify(summary)).not.toContain('Київ');
  });

  it('records a probe that only lists tools', () => {
    expect(summarizeMcpBody({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).toEqual([
      { method: 'tools/list', tool: undefined, client: undefined },
    ]);
  });

  it('summarizes every message of a batch', () => {
    expect(
      summarizeMcpBody([
        { method: 'tools/call', params: { name: 'ping' } },
        { method: 'tools/call', params: { name: 'get_trip_details' } },
      ]).map((call) => call.tool),
    ).toEqual(['ping', 'get_trip_details']);
  });

  it('drops frames with no method rather than logging a shapeless entry', () => {
    expect(summarizeMcpBody({ jsonrpc: '2.0', id: 4, result: { ok: true } })).toEqual([]);
    expect(summarizeMcpBody(null)).toEqual([]);
    expect(summarizeMcpBody('not-json-rpc')).toEqual([]);
  });

  it('ignores a non-string tool name instead of trusting the payload', () => {
    expect(summarizeMcpBody({ method: 'tools/call', params: { name: { evil: true } } })).toEqual([
      { method: 'tools/call', tool: undefined, client: undefined },
    ]);
  });
});
