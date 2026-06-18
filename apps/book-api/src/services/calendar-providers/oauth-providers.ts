import type { CalendarProvider, NormalizedEvent, ProviderContext } from './types.js';
import { ProviderNotConfiguredError } from './types.js';
import { env } from '../../env.js';

/**
 * Google Calendar provider — DROP-IN SLOT.
 *
 * The connection record, sync engine, data mapping, and UI are all live; the
 * only thing missing is operator-supplied OAuth. Until GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET are configured, fetchEvents() fails fast with a clear
 * message that the engine records as sync_status='needs_config'.
 *
 * To activate: set the env vars, wire the OAuth authorization-code exchange in
 * the connect route (so access_token/refresh_token land on the connection),
 * then replace the throw below with a Google Calendar Events.list() call that
 * maps each item to a NormalizedEvent. The rest of the pipeline is unchanged.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly provider = 'google';

  async fetchEvents(
    ctx: ProviderContext,
    _windowStart: Date,
    _windowEnd: Date,
  ): Promise<NormalizedEvent[]> {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new ProviderNotConfiguredError(
        'Google Calendar sync requires operator-supplied GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      );
    }
    if (!ctx.accessToken) {
      throw new ProviderNotConfiguredError(
        'Google connection has no access token. Complete the OAuth consent flow first.',
      );
    }
    // Drop-in point: call Google Calendar API events.list here and map results.
    throw new ProviderNotConfiguredError(
      'Google Calendar event fetch is not yet implemented (OAuth credentials present, fetch path pending).',
    );
  }
}

/**
 * Microsoft Outlook / Graph provider — DROP-IN SLOT. Same shape as Google:
 * activates when MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET are configured
 * and the OAuth flow has stored tokens on the connection.
 */
export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly provider = 'microsoft';

  async fetchEvents(
    ctx: ProviderContext,
    _windowStart: Date,
    _windowEnd: Date,
  ): Promise<NormalizedEvent[]> {
    if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
      throw new ProviderNotConfiguredError(
        'Microsoft Outlook sync requires operator-supplied MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
      );
    }
    if (!ctx.accessToken) {
      throw new ProviderNotConfiguredError(
        'Microsoft connection has no access token. Complete the OAuth consent flow first.',
      );
    }
    throw new ProviderNotConfiguredError(
      'Microsoft Graph event fetch is not yet implemented (OAuth credentials present, fetch path pending).',
    );
  }
}
