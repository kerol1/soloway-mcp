import { describe, expect, it } from 'vitest';
import {
  wave1Pairs,
  case3Pairs,
  substitutionsOf,
  routeNames,
  alternativeDistance,
} from '../../src/domain/nearby.js';
import type { NearbyPairWire, NearbyPairsResponse } from '../../src/backend/types.js';

function sub(id: number, name: string, km: number) {
  return { city: { id: String(id), name, region: null, country_code: 'UA' }, distance_km: km };
}

function pair(fromId: number, toId: number, opts: { fromSub?: ReturnType<typeof sub>; toSub?: ReturnType<typeof sub> } = {}): NearbyPairWire {
  return { from_id: fromId, to_id: toId, from_sub: opts.fromSub ?? null, to_sub: opts.toSub ?? null };
}

function matrix(partial: Partial<NearbyPairsResponse>): NearbyPairsResponse {
  return { case1: [], case2: [], case3: [], ...partial };
}

describe('nearby pair planning', () => {
  it('wave 1 joins cases 1+2 in order and honours the cap', () => {
    const m = matrix({
      case1: [pair(1, 7), pair(1, 8)],
      case2: [pair(9, 2), pair(10, 2)],
    });

    const plans = wave1Pairs(m, 3);

    expect(plans.map((p) => `${p.caseNo}:${p.pair.from_id}-${p.pair.to_id}`)).toEqual(['1:1-7', '1:1-8', '2:9-2']);
  });

  it('case 3 is capped at two pairs', () => {
    const m = matrix({ case3: [pair(9, 7), pair(10, 8), pair(11, 12)] });

    const plans = case3Pairs(m);

    expect(plans).toHaveLength(2);
    expect(plans.every((p) => p.caseNo === 3)).toBe(true);
  });
});

describe('nearby descriptions', () => {
  const bothSides = pair(9, 7, { fromSub: sub(9, 'Львів', 15), toSub: sub(7, 'Краків', 10) });

  it('lists one substitution per swapped side, from side first', () => {
    expect(substitutionsOf(bothSides, 'Пустомити', 'Величка')).toEqual([
      { replaces: 'Пустомити', nearby_city: 'Львів', distance_km: 15 },
      { replaces: 'Величка', nearby_city: 'Краків', distance_km: 10 },
    ]);
  });

  it('keeps the original name on the unsubstituted side', () => {
    const arrivalOnly = pair(1, 7, { toSub: sub(7, 'Краків', 10) });

    expect(routeNames(arrivalOnly, 'Пустомити', 'Величка')).toEqual({ from: 'Пустомити', to: 'Краків' });
    expect(substitutionsOf(arrivalOnly, 'Пустомити', 'Величка')).toEqual([
      { replaces: 'Величка', nearby_city: 'Краків', distance_km: 10 },
    ]);
  });

  it('sorts alternatives by the largest detour of the pair', () => {
    expect(alternativeDistance(substitutionsOf(bothSides, 'a', 'b'))).toBe(15);
    expect(alternativeDistance([])).toBe(0);
  });
});
