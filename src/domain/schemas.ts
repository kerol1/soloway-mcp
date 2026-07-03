import { z } from 'zod';

/** Numeric-city-id refine reused on every `*_city_id` input field. */
export const cityIdInput = z
  .string()
  .regex(/^[0-9]+$/, 'City id must be numeric — call search_trips first to obtain a valid city id.');

export const cityRefSchema = z.object({
  city_id: z.string().describe('Internal SoloWay city id (a stringified Long; sent to the backend and used in the deep-link).'),
  name: z.string().describe('Resolved city name in the requested locale.'),
  region: z.string().nullable().describe('Region/oblast if known.'),
  country_code: z.string().describe('ISO 3166-1 alpha-2.'),
});

export const priceEntrySchema = z.object({
  amount: z.number().describe('Price as a JSON double (ceil-rounded VALUE, floating-point TYPE — do not assume integer). Render WITH the currency.'),
  currency: z.string().describe('ISO 4217 currency code — ALWAYS render alongside amount.'),
  primary: z.boolean().describe('true = carrier-native price; false = FX-converted UAH.'),
});

export const moneySchema = z.object({
  amount: z.number().describe('Amount in carrier-native currency (JSON double; may be non-integer).'),
  currency: z.string().describe('ISO 4217 — carrier-native. ALWAYS render alongside amount.'),
});

export const comparableUahSchema = z.object({
  amount: z.number().describe('UAH-equivalent amount used for sorting (may be non-integer).'),
  currency: z.string(),
  is_uah: z.boolean().describe('false = no UAH rate; shown for display but sorted last.'),
});
