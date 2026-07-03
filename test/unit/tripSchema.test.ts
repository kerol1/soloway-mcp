import { describe, it, expect } from 'vitest';
import { tripSchema } from '../../src/tools/searchTrips.js';

const baseTrip = {
  external_id: 'likebus:1',
  carrier: { id: 1, display_name: 'LikeBus', logo_url: null },
  departure: { city_name: 'Kyiv', station_name: null, datetime: '2026-06-29T08:00', country_code: null },
  arrival: { city_name: 'Lviv', station_name: null, datetime: '2026-06-29T15:00', country_code: null },
  duration_minutes: 420,
  prices: [{ amount: 900.5, currency: 'UAH', primary: true }],
  comparable_price_uah: { amount: 900.5, currency: 'UAH', is_uah: true },
  price_for_requested_pax: { amount: 900.5, currency: 'UAH' },
  booking_available: true,
  purchase_available: true,
  free_seats: 10,
  transfers: 0,
  transfer_note: null,
  carrier_discounts: [{ percent: 30, name: 'Діти 1-10' }],
  discount_percent_range: { min: 30, max: 30 },
};

describe('tripSchema (output conformance)', () => {
  it('accepts null country_code (domestic trips) and a non-integer price amount', () => {
    expect(tripSchema.safeParse(baseTrip).success).toBe(true);
  });

  it('rejects a trip missing a required field — so the search filter drops it', () => {
    const { external_id, ...broken } = baseTrip;
    void external_id;
    expect(tripSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a nested {uk,en} object leaking into a flat city_name', () => {
    const leaked = { ...baseTrip, departure: { ...baseTrip.departure, city_name: { uk: 'Київ', en: 'Kyiv' } } };
    expect(tripSchema.safeParse(leaked).success).toBe(false);
  });
});
