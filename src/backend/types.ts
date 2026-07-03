/**
 * Hand-written mirrors of the Spring backend JSON response DTOs. Bodies are snake_case
 * (global Jackson SNAKE_CASE). Only the fields the MCP tools consume are modelled.
 */

export interface LocalizedText {
  uk?: string | null;
  en?: string | null;
}

export interface BackendCity {
  id: string; // internal cityId — a stringified Long
  name: string; // localized per the request locale
  region: string | null;
  country_code: string;
}

export interface CityAutocompleteResponse {
  data: BackendCity[];
}

export interface TripStop {
  city_name: LocalizedText;
  station_name: LocalizedText | null;
  datetime: string; // ISO local datetime
  country_code: string | null; // null for some (e.g. domestic) trips
}

export interface TripPrice {
  amount: number; // Java double on the wire (ceil-rounded VALUE, but floating-point TYPE)
  currency: string; // ISO 4217
  primary: boolean; // true = carrier-native; false = FX-converted UAH
}

export interface Money {
  amount: number;
  currency: string;
}

export interface CarrierSummary {
  id: number; // Java Long → JSON number
  display_name: string;
  logo_url: string | null;
}

export interface DiscountTier {
  percent: number;
  name: string | null;
}

export interface SearchTripResponse {
  external_id: string; // "<providerId>:<tripId>"
  carrier: CarrierSummary;
  departure: TripStop;
  arrival: TripStop;
  prices: TripPrice[];
  passenger_prices: Record<string, Money>; // keys are stringified pax counts ("1","2",...)
  booking_available: boolean;
  purchase_available: boolean;
  free_seats: number;
  transfers: number;
  transfer_note: string | null;
  carrier_discounts: DiscountTier[];
}

export interface CalendarPricesResponse {
  prices: Record<string, number | null>; // 'YYYY-MM-DD' -> UAH-equivalent min, null if no availability
  currency: string; // always 'UAH'
  pending: boolean; // true = some carriers still loading (re-poll)
}

export interface RouteStop {
  city_name: LocalizedText;
  station_name: LocalizedText | null;
  address: string | null;
  arrival_time: string | null;
  departure_time: string | null;
  stop_type: string; // DEPARTURE | INTERMEDIATE | ARRIVAL (mapped to a closed enum in the tool)
  bus_changed: boolean;
  in_user_segment: boolean;
}

export interface AvailableDiscount {
  id: string;
  name: string;
  percentage: number | null;
  ticket_price_with_discount: number | null;
  category: string; // AGE | STUDENT | SPECIAL | COMPANION | OTHER (mapped to a closed enum in the tool)
}

export interface TripDetailsResponse {
  stops: RouteStop[];
  available_discounts: AvailableDiscount[];
  seat_layout: unknown | null; // opaque — most carriers return null
  legal_notice: LocalizedText | null;
}
