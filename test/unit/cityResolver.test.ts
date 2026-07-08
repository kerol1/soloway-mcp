import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { backend } from '../../src/backend/client.js';
import { resolveRoute, _resetCityCaches } from '../../src/domain/cityResolver.js';
import type { BackendCity } from '../../src/backend/types.js';

/**
 * A tiny fixture "city DB" with both uk + en renderings, mirroring how the backend localizes the
 * same id per the requested locale. autocomplete returns names in the LOOKUP locale (uk for a
 * Cyrillic query, en for a Latin one); citiesByIds returns names in the REQUESTED locale.
 */
const CITY: Record<string, { uk: BackendCity; en: BackendCity }> = {
  '6450': {
    uk: { id: '6450', name: 'Київ', region: 'м. Київ', country_code: 'UA' },
    en: { id: '6450', name: 'Kyiv', region: 'Kyiv City', country_code: 'UA' },
  },
  '6164': {
    uk: { id: '6164', name: 'Львів', region: 'Львівська обл.', country_code: 'UA' },
    en: { id: '6164', name: 'Lviv', region: 'Lviv Oblast', country_code: 'UA' },
  },
  // A district that shares the "Київ" prefix but NOT the exact name — must never out-vote the city.
  '10966': {
    uk: { id: '10966', name: 'Київський район', region: 'Одеська обл.', country_code: 'UA' },
    en: { id: '10966', name: 'Kyivskyi Raion', region: 'Odesa Oblast', country_code: 'UA' },
  },
  // Prefix neighbour of Львів (no exact match) — drives the genuinely-ambiguous case.
  '6165': {
    uk: { id: '6165', name: 'Львівське', region: 'Донецька обл.', country_code: 'UA' },
    en: { id: '6165', name: 'Lvivske', region: 'Donetsk Oblast', country_code: 'UA' },
  },
  // Two DIFFERENT towns literally named «Золочів» — true homonyms.
  '900': {
    uk: { id: '900', name: 'Золочів', region: 'Львівська обл.', country_code: 'UA' },
    en: { id: '900', name: 'Zolochiv', region: 'Lviv Oblast', country_code: 'UA' },
  },
  '901': {
    uk: { id: '901', name: 'Золочів', region: 'Харківська обл.', country_code: 'UA' },
    en: { id: '901', name: 'Zolochiv', region: 'Kharkiv Oblast', country_code: 'UA' },
  },
};

// autocomplete responses keyed by (locale, normalized query). The resolver canonicalizes Latin
// queries (kiev→kyiv, lvov→lviv) BEFORE calling, so only the canonical key is needed.
const AUTOCOMPLETE: Record<string, Record<string, BackendCity[]>> = {
  en: {
    kyiv: [CITY['6450']!.en, CITY['10966']!.en],
    lviv: [CITY['6164']!.en],
    zolochiv: [CITY['900']!.en, CITY['901']!.en],
  },
  uk: {
    київ: [CITY['6450']!.uk, CITY['10966']!.uk],
    львів: [CITY['6164']!.uk],
    льв: [CITY['6164']!.uk, CITY['6165']!.uk],
    золочів: [CITY['900']!.uk, CITY['901']!.uk],
  },
};

let byIdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetCityCaches();
  vi.spyOn(backend, 'autocomplete').mockImplementation((query: string, locale: 'uk' | 'en') =>
    Promise.resolve(AUTOCOMPLETE[locale]?.[query.trim().toLowerCase()] ?? []),
  );
  byIdSpy = vi
    .spyOn(backend, 'citiesByIds')
    .mockImplementation((ids: string[], locale: 'uk' | 'en') =>
      Promise.resolve(ids.map((id) => CITY[id]?.[locale]).filter((c): c is BackendCity => Boolean(c))),
    );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRoute — obvious cities auto-resolve', () => {
  it('to="Kyiv" (Latin, uk session) resolves to the CITY Київ 6450 in uk, not a district', async () => {
    const res = await resolveRoute({ from_city_id: '6164', to: 'Kyiv' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.to).toEqual({ city_id: '6450', name: 'Київ', region: 'м. Київ', country_code: 'UA' });
  });

  it('to="Київ" (Cyrillic) resolves to 6450 via the uk fast path (no citiesByIds re-fetch)', async () => {
    const res = await resolveRoute({ from: 'Львів', to: 'Київ' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.to.city_id).toBe('6450');
    expect(res.from.city_id).toBe('6164');
    expect(byIdSpy).not.toHaveBeenCalled(); // both names looked up in uk → refs already correct
  });

  it('from="Lviv" resolves to Львів 6164', async () => {
    const res = await resolveRoute({ from: 'Lviv', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.from.city_id).toBe('6164');
    expect(res.from.name).toBe('Львів');
  });

  it('from="Львів" resolves to 6164', async () => {
    const res = await resolveRoute({ from: 'Львів', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.from.city_id).toBe('6164');
  });

  it('alt spellings: from="Kiev" / to="Lvov" canonicalize to 6450 / 6164', async () => {
    const res = await resolveRoute({ from: 'Kiev', to: 'Lvov' }, 'en');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.from.city_id).toBe('6450');
    expect(res.to.city_id).toBe('6164');
    expect(res.from.name).toBe('Kyiv');
    expect(res.to.name).toBe('Lviv');
  });
});

describe('resolveRoute — numeric id echoes a full city, never the id string', () => {
  it('from_city_id="6164" resolves name "Львів" (not "6164")', async () => {
    const res = await resolveRoute({ from_city_id: '6164', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.from).toEqual({ city_id: '6164', name: 'Львів', region: 'Львівська обл.', country_code: 'UA' });
  });

  it('to_city_id="6450" resolves name "Київ" (not "6450"), with region + country', async () => {
    const res = await resolveRoute({ from_city_id: '6164', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.to.name).toBe('Київ');
    expect(res.to.region).toBe('м. Київ');
    expect(res.to.country_code).toBe('UA');
  });

  it('an unknown numeric id returns a clean "none", not a placeholder', async () => {
    const res = await resolveRoute({ from_city_id: '999999', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('none');
    if (res.status !== 'none') return;
    expect(res.field).toBe('from');
  });
});

describe('resolveRoute — disambiguation ONLY when truly ambiguous', () => {
  it('true homonyms (two «Золочів») return BOTH candidates split by region', async () => {
    const res = await resolveRoute({ from: 'Золочів', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.field).toBe('from');
    expect(res.query).toBe('Золочів');
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates.every((c) => c.name === 'Золочів')).toBe(true);
    expect(new Set(res.candidates.map((c) => c.region))).toEqual(
      new Set(['Львівська обл.', 'Харківська обл.']),
    );
  });

  it('a partial/prefix query with no exact match stays ambiguous', async () => {
    const res = await resolveRoute({ from: 'Льв', to_city_id: '6450' }, 'uk');
    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.candidates).toHaveLength(2);
  });

  it('a missing endpoint reports missing before anything else', async () => {
    const res = await resolveRoute({ to: 'Київ' }, 'uk');
    expect(res.status).toBe('missing');
    if (res.status !== 'missing') return;
    expect(res.field).toBe('from');
  });
});
