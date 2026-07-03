import { describe, it, expect } from 'vitest';
import { mapEnum } from '../../src/tools/getTripDetails.js';

const STOP_TYPES = ['DEPARTURE', 'INTERMEDIATE', 'ARRIVAL', 'OTHER'] as const;

describe('mapEnum', () => {
  it('passes through a known value', () => {
    expect(mapEnum('DEPARTURE', STOP_TYPES, 'OTHER')).toBe('DEPARTURE');
    expect(mapEnum('ARRIVAL', STOP_TYPES, 'OTHER')).toBe('ARRIVAL');
  });

  it('maps an unknown backend value to the fallback (survives new server enums)', () => {
    expect(mapEnum('REST_STOP', STOP_TYPES, 'OTHER')).toBe('OTHER');
  });

  it('maps null/undefined to the fallback', () => {
    expect(mapEnum(null, STOP_TYPES, 'OTHER')).toBe('OTHER');
    expect(mapEnum(undefined, STOP_TYPES, 'OTHER')).toBe('OTHER');
  });
});
