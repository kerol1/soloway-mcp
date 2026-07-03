import { describe, it, expect } from 'vitest';
import { localize } from '../../src/domain/localize.js';

describe('localize', () => {
  it('returns the requested locale', () => {
    expect(localize({ uk: 'Київ', en: 'Kyiv' }, 'en')).toBe('Kyiv');
    expect(localize({ uk: 'Київ', en: 'Kyiv' }, 'uk')).toBe('Київ');
  });

  it('falls back requested → uk → en → null', () => {
    expect(localize({ uk: 'Київ' }, 'en')).toBe('Київ'); // en missing → uk
    expect(localize({ en: 'Kyiv' }, 'uk')).toBe('Kyiv'); // uk missing → en
    expect(localize({}, 'uk')).toBeNull();
  });

  it('returns null for absent value (e.g. missing station)', () => {
    expect(localize(null, 'uk')).toBeNull();
    expect(localize(undefined, 'en')).toBeNull();
  });
});
