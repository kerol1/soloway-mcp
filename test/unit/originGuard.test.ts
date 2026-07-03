import { describe, it, expect } from 'vitest';
import { originAllowed, hostAllowed } from '../../src/http/originGuard.js';
import type { OriginRule } from '../../src/config.js';

const rules: OriginRule[] = [
  { raw: 'https://claude.ai', exact: 'https://claude.ai' },
  { raw: 'https://*.claude.ai', wildcard: { prefix: 'https://', suffix: '.claude.ai' } },
  { raw: 'https://*.openai.com', wildcard: { prefix: 'https://', suffix: '.openai.com' } },
];

describe('originAllowed', () => {
  it('accepts an exact origin', () => {
    expect(originAllowed('https://claude.ai', rules)).toBe(true);
  });

  it('accepts a wildcard subdomain', () => {
    expect(originAllowed('https://foo.claude.ai', rules)).toBe(true);
    expect(originAllowed('https://chat.openai.com', rules)).toBe(true);
  });

  it('rejects the null origin explicitly', () => {
    expect(originAllowed('null', rules)).toBe(false);
  });

  it('rejects a disallowed origin', () => {
    expect(originAllowed('https://evil.example', rules)).toBe(false);
  });

  it('does not let a wildcard match a bare apex or a look-alike suffix', () => {
    // bare apex must come via the exact rule, not the wildcard
    expect(originAllowed('https://claude.ai.evil.com', rules)).toBe(false);
    expect(originAllowed('https://notclaude.ai', rules)).toBe(false);
  });

  it('does not match across scheme (http vs https)', () => {
    expect(originAllowed('http://claude.ai', rules)).toBe(false);
  });
});

describe('hostAllowed', () => {
  const hosts = ['mcp.soloway.com.ua', 'localhost:8088'];

  it('accepts any host from the CSV list', () => {
    expect(hostAllowed('mcp.soloway.com.ua', hosts, false)).toBe(true);
    expect(hostAllowed('localhost:8088', hosts, false)).toBe(true);
  });

  it('rejects a host outside the list', () => {
    expect(hostAllowed('evil.example', hosts, false)).toBe(false);
    expect(hostAllowed('127.0.0.1:8088', hosts, false)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(hostAllowed(undefined, hosts, false)).toBe(false);
  });

  it('accepts everything when anyHost (`*`) is set — including a missing header', () => {
    expect(hostAllowed('anything.example:1234', hosts, true)).toBe(true);
    expect(hostAllowed(undefined, hosts, true)).toBe(true);
  });
});
