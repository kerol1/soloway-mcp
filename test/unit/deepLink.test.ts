import { describe, it, expect } from 'vitest';
import { buildDeepLink } from '../../src/domain/deepLink.js';

describe('buildDeepLink', () => {
  it('builds a soloway.com.ua/search link with from/to/date/adults + utm', () => {
    const { url, clamped } = buildDeepLink({ fromCityId: '1', toCityId: '2', date: '2026-07-01', passengers: 2, utmSource: 'claude' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://soloway.com.ua/search');
    expect(u.searchParams.get('from')).toBe('1');
    expect(u.searchParams.get('to')).toBe('2');
    expect(u.searchParams.get('date')).toBe('2026-07-01');
    expect(u.searchParams.get('adults')).toBe('2');
    expect(u.searchParams.get('children')).toBe('0');
    expect(u.searchParams.get('utm_source')).toBe('claude');
    expect(u.searchParams.get('utm_medium')).toBe('ai-assistant');
    expect(clamped).toBe(false);
  });

  it('clamps adults to 6 and flags clamped when passengers > 6', () => {
    const { url, clamped } = buildDeepLink({ fromCityId: '1', toCityId: '2', date: '2026-07-01', passengers: 8 });
    expect(new URL(url).searchParams.get('adults')).toBe('6');
    expect(clamped).toBe(true);
  });

  it('defaults utm_source to ai-assistant', () => {
    const { url } = buildDeepLink({ fromCityId: '1', toCityId: '2', date: '2026-07-01', passengers: 1 });
    expect(new URL(url).searchParams.get('utm_source')).toBe('ai-assistant');
  });
});
