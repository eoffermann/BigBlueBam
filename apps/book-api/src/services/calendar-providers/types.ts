/**
 * Provider abstraction for external calendar sync (Book task #63).
 *
 * Every external calendar source — an ICS URL feed, Google Calendar, Microsoft
 * Outlook — is reduced to one operation: "give me the events in this source as
 * a flat list of NormalizedEvent". The sync engine
 * (external-sync.service.ts::syncConnection) is provider-agnostic: it asks the
 * resolved provider for events and mirrors them into Book. Adding Google/Outlook
 * later is a drop-in — implement fetchEvents() against their REST API and
 * register the class in resolveProvider().
 */

export interface NormalizedEvent {
  /**
   * Stable per-source identifier. For ICS this is the VEVENT UID; for Google
   * the event id. Used as the upsert key against
   * book_external_events.external_event_id so a re-sync updates in place.
   */
  externalId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  description?: string;
  location?: string;
  /** 'busy' | 'free' — mirrored onto the Book event visibility. */
  visibility: 'busy' | 'free';
  /** 'confirmed' | 'tentative' | 'cancelled'. Cancelled events are removed. */
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** Inputs the engine hands every provider. */
export interface ProviderContext {
  provider: string;
  feedUrl: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  externalCalendarId: string;
}

/**
 * Raised by a provider that cannot run without operator-supplied credentials
 * (Google / Microsoft OAuth). The engine catches this and records a clear
 * sync_status='needs_config' with the message, so the UI can explain exactly
 * what the operator must supply.
 */
export class ProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export interface CalendarProvider {
  readonly provider: string;
  /**
   * Pull all events in the source for a bounded window (the engine passes the
   * window so providers can page; ICS ignores it and returns the whole feed).
   */
  fetchEvents(ctx: ProviderContext, windowStart: Date, windowEnd: Date): Promise<NormalizedEvent[]>;
}
