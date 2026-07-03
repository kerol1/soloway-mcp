import { config } from '../config.js';

/** The site's booking page caps passengers at 6 (frontend useSearchQueryParams clamps adults). */
export const DEEP_LINK_MAX_ADULTS = 6;

export interface DeepLinkParams {
  fromCityId: string;
  toCityId: string;
  date: string; // YYYY-MM-DD
  passengers: number;
  utmSource?: string;
}

export interface DeepLinkResult {
  url: string;
  clamped: boolean; // true when passengers > 6 and the link was clamped
}

/**
 * Builds the soloway.com.ua/search deep-link. No per-trip URL exists — the search page is the
 * booking entry point. `adults` is clamped to 6 (site cap); when the requested party exceeds 6
 * the caller surfaces a note. utm_source defaults to "ai-assistant"; utm_medium is always
 * "ai-assistant" so referrals bucket into the existing GA4 channel.
 */
export function buildDeepLink(params: DeepLinkParams): DeepLinkResult {
  const adults = Math.min(params.passengers, DEEP_LINK_MAX_ADULTS);
  const url = new URL('/search', config.PUBLIC_BASE_URL);
  url.searchParams.set('from', params.fromCityId);
  url.searchParams.set('to', params.toCityId);
  url.searchParams.set('date', params.date);
  url.searchParams.set('adults', String(adults));
  url.searchParams.set('children', '0');
  url.searchParams.set('utm_source', params.utmSource && params.utmSource.length > 0 ? params.utmSource : 'ai-assistant');
  url.searchParams.set('utm_medium', 'ai-assistant');
  return { url: url.toString(), clamped: params.passengers > DEEP_LINK_MAX_ADULTS };
}
