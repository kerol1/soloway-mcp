import type { LocalizedText } from '../backend/types.js';

export type Locale = 'uk' | 'en';

/**
 * Flattens a backend `{uk,en}` LocalizedText to a single string in the requested locale.
 * Fallback order: requested locale → uk → en → null. Returns null when the value is absent
 * (e.g. a stop with no station name).
 */
export function localize(value: LocalizedText | null | undefined, locale: Locale): string | null {
  if (!value) return null;
  return value[locale] || value.uk || value.en || null;
}
