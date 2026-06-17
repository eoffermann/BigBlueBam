import type { CalendarProvider, NormalizedEvent, ProviderContext } from './types.js';
import { parseIcs } from './ics-parser.js';

const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5MB cap — guards against a runaway feed.
const FETCH_TIMEOUT_MS = 15_000;

/**
 * ICS URL feed provider. The no-secret, always-available concrete path: fetch
 * the .ics over HTTP(S), parse VEVENTs, return them normalized. This is what
 * makes the Connections feature usable end to end without operator OAuth creds.
 */
export class IcsCalendarProvider implements CalendarProvider {
  readonly provider = 'ics';

  async fetchEvents(
    ctx: ProviderContext,
    _windowStart: Date,
    _windowEnd: Date,
  ): Promise<NormalizedEvent[]> {
    if (!ctx.feedUrl) {
      throw new Error('ICS connection is missing a feed URL');
    }
    // webcal:// is the calendar-subscription scheme; it is plain HTTP(S) under
    // the hood, so normalize it before fetching.
    const url = ctx.feedUrl.replace(/^webcal:\/\//i, 'https://');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/calendar, text/plain, */*' },
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Feed fetch failed: HTTP ${res.status}`);
    }

    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) {
      throw new Error(`Feed too large (> ${MAX_FEED_BYTES} bytes)`);
    }
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new Error('Response is not a valid iCalendar (.ics) document');
    }

    return parseIcs(text);
  }
}
