import { eq, and, desc, lte, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bookExternalConnections,
  bookExternalEvents,
  bookEvents,
  bookCalendars,
} from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { encryptSecret, decryptSecret } from '../lib/secret-box.js';
import {
  resolveProvider,
  ProviderNotConfiguredError,
  NO_SECRET_PROVIDERS,
  type NormalizedEvent,
} from './calendar-providers/index.js';

type ConnectionRow = typeof bookExternalConnections.$inferSelect;

// ---------------------------------------------------------------------------
// Redaction — never return token/feed material to the client.
// ---------------------------------------------------------------------------

export interface RedactedConnection {
  id: string;
  user_id: string;
  provider: string;
  name: string | null;
  calendar_id: string | null;
  external_calendar_id: string;
  sync_direction: string;
  sync_status: string;
  sync_error: string | null;
  last_sync_at: Date | null;
  last_sync_event_count: number;
  /** True when a feed URL is stored (ICS); the URL itself is never returned. */
  has_feed_url: boolean;
  created_at: Date;
  updated_at: Date;
}

function redact(row: ConnectionRow): RedactedConnection {
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    name: row.name,
    calendar_id: row.calendar_id,
    external_calendar_id: row.external_calendar_id,
    sync_direction: row.sync_direction,
    sync_status: row.sync_status,
    sync_error: row.sync_error,
    last_sync_at: row.last_sync_at,
    last_sync_event_count: row.last_sync_event_count,
    has_feed_url: !!row.feed_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// List connections (redacted)
// ---------------------------------------------------------------------------

export async function listConnections(userId: string) {
  const rows = await db
    .select()
    .from(bookExternalConnections)
    .where(eq(bookExternalConnections.user_id, userId))
    .orderBy(desc(bookExternalConnections.created_at));

  return { data: rows.map(redact) };
}

// ---------------------------------------------------------------------------
// Create an ICS-feed connection (no operator secret required)
// ---------------------------------------------------------------------------

export interface CreateIcsConnectionInput {
  feed_url: string;
  name?: string;
  calendar_id?: string;
  sync_direction?: 'inbound' | 'outbound' | 'both';
}

export async function createIcsConnection(
  userId: string,
  orgId: string,
  input: CreateIcsConnectionInput,
): Promise<RedactedConnection> {
  let parsed: URL;
  try {
    parsed = new URL(input.feed_url.replace(/^webcal:\/\//i, 'https://'));
  } catch {
    throw badRequest('feed_url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('feed_url must be an http(s) or webcal URL');
  }

  // If a target calendar was supplied, verify it belongs to the caller's org.
  if (input.calendar_id) {
    const [cal] = await db
      .select({ id: bookCalendars.id })
      .from(bookCalendars)
      .where(
        and(
          eq(bookCalendars.id, input.calendar_id),
          eq(bookCalendars.organization_id, orgId),
        ),
      )
      .limit(1);
    if (!cal) throw badRequest('calendar_id does not belong to your organization');
  }

  const [connection] = await db
    .insert(bookExternalConnections)
    .values({
      user_id: userId,
      provider: 'ics',
      name: input.name ?? null,
      calendar_id: input.calendar_id ?? null,
      feed_url: encryptSecret(input.feed_url),
      // ICS feeds are read-only sources: direction is always inbound.
      sync_direction: 'inbound',
      // external_calendar_id is NOT NULL on the table; the feed host is a
      // stable, human-meaningful value for an ICS source.
      external_calendar_id: parsed.host,
      sync_status: 'pending',
    })
    .returning();

  return redact(connection!);
}

// ---------------------------------------------------------------------------
// Create an OAuth connection (Google / Microsoft) — token-bearing
// ---------------------------------------------------------------------------

export async function createOAuthConnection(
  userId: string,
  provider: 'google' | 'microsoft',
  accessToken: string,
  refreshToken: string | undefined,
  externalCalendarId: string,
  syncDirection?: 'inbound' | 'outbound' | 'both',
  calendarId?: string,
): Promise<RedactedConnection> {
  const [connection] = await db
    .insert(bookExternalConnections)
    .values({
      user_id: userId,
      provider,
      access_token: encryptSecret(accessToken),
      refresh_token: encryptSecret(refreshToken),
      external_calendar_id: externalCalendarId,
      calendar_id: calendarId ?? null,
      sync_direction: syncDirection ?? 'both',
      sync_status: 'pending',
    })
    .returning();

  return redact(connection!);
}

// ---------------------------------------------------------------------------
// Delete connection (and clean up its mirrored Book events)
// ---------------------------------------------------------------------------

export async function deleteConnection(id: string, userId: string) {
  const [connection] = await db
    .select()
    .from(bookExternalConnections)
    .where(and(eq(bookExternalConnections.id, id), eq(bookExternalConnections.user_id, userId)))
    .limit(1);

  if (!connection) throw notFound('Connection not found');

  // Hard-delete the mirrored book_events rows this connection produced. The
  // book_external_events rows cascade-delete with the connection (FK), so we
  // capture the mirror ids first, then drop the connection.
  const mirrored = await db
    .select({ book_event_id: bookExternalEvents.book_event_id })
    .from(bookExternalEvents)
    .where(eq(bookExternalEvents.connection_id, id));

  const mirrorIds = mirrored
    .map((m) => m.book_event_id)
    .filter((v): v is string => !!v);

  if (mirrorIds.length > 0) {
    await db.delete(bookEvents).where(inArrayIds(bookEvents.id, mirrorIds));
  }

  await db
    .delete(bookExternalConnections)
    .where(and(eq(bookExternalConnections.id, id), eq(bookExternalConnections.user_id, userId)));

  return { deleted: true, removed_events: mirrorIds.length };
}

// Small helper so we don't import inArray just for one call site (keeps the
// import list lean and avoids a name clash with the engine's local usage).
function inArrayIds(col: typeof bookEvents.id, ids: string[]) {
  return sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
}

// ---------------------------------------------------------------------------
// Sync engine — the heart of the feature
// ---------------------------------------------------------------------------

export interface SyncResult {
  connection_id: string;
  status: 'active' | 'error' | 'needs_config';
  imported: number;
  created: number;
  updated: number;
  removed: number;
  error: string | null;
}

/**
 * Resolve (or lazily provision) the Book calendar a connection mirrors into.
 * Order: the connection's explicit calendar_id (if it still exists in-org) →
 * the user's default personal calendar → a freshly created import calendar.
 */
async function resolveTargetCalendarId(connection: ConnectionRow, orgId: string): Promise<string> {
  if (connection.calendar_id) {
    const [cal] = await db
      .select({ id: bookCalendars.id })
      .from(bookCalendars)
      .where(and(eq(bookCalendars.id, connection.calendar_id), eq(bookCalendars.organization_id, orgId)))
      .limit(1);
    if (cal) return cal.id;
  }

  const [existing] = await db
    .select({ id: bookCalendars.id })
    .from(bookCalendars)
    .where(
      and(
        eq(bookCalendars.organization_id, orgId),
        eq(bookCalendars.owner_user_id, connection.user_id),
      ),
    )
    .orderBy(desc(bookCalendars.is_default))
    .limit(1);
  if (existing) {
    // Pin it onto the connection so future syncs and the UI agree.
    await db
      .update(bookExternalConnections)
      .set({ calendar_id: existing.id })
      .where(eq(bookExternalConnections.id, connection.id));
    return existing.id;
  }

  const [created] = await db
    .insert(bookCalendars)
    .values({
      organization_id: orgId,
      owner_user_id: connection.user_id,
      name: connection.name ?? 'Imported Calendar',
      description: 'Auto-managed calendar for an external feed connection.',
      color: '#0ea5e9',
      calendar_type: 'personal',
      is_default: false,
      timezone: 'UTC',
    })
    .returning({ id: bookCalendars.id });

  await db
    .update(bookExternalConnections)
    .set({ calendar_id: created!.id })
    .where(eq(bookExternalConnections.id, connection.id));
  return created!.id;
}

/** Resolve the owner's org id (connections are user-scoped; events are org-scoped). */
async function resolveOrgId(userId: string): Promise<string> {
  const [u] = await db.execute<{ org_id: string }>(
    sql`SELECT org_id FROM users WHERE id = ${userId} LIMIT 1`,
  );
  if (!u) throw notFound('Connection owner not found');
  return u.org_id;
}

/**
 * Core sync for a single connection. Provider-agnostic: resolves the provider,
 * pulls NormalizedEvents, upserts book_external_events keyed by external id,
 * and mirrors each into book_events on the target calendar (insert/update in
 * place). Cancelled or vanished upstream events have their mirror removed.
 *
 * Always updates last_sync_at / sync_status / counters, even on failure, so the
 * UI reflects the real outcome. Returns a structured SyncResult.
 */
export async function syncConnection(connectionId: string): Promise<SyncResult> {
  const [connection] = await db
    .select()
    .from(bookExternalConnections)
    .where(eq(bookExternalConnections.id, connectionId))
    .limit(1);

  if (!connection) throw notFound('Connection not found');

  const provider = resolveProvider(connection.provider);
  if (!provider) {
    const msg = `Unknown provider: ${connection.provider}`;
    await markSyncOutcome(connectionId, 'error', 0, msg);
    return { connection_id: connectionId, status: 'error', imported: 0, created: 0, updated: 0, removed: 0, error: msg };
  }

  // Outbound-only connections do not pull (nothing to import here yet).
  if (connection.sync_direction === 'outbound') {
    await markSyncOutcome(connectionId, 'active', 0, null);
    return { connection_id: connectionId, status: 'active', imported: 0, created: 0, updated: 0, removed: 0, error: null };
  }

  const orgId = await resolveOrgId(connection.user_id);
  const windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  let fetched: NormalizedEvent[];
  try {
    fetched = await provider.fetchEvents(
      {
        provider: connection.provider,
        feedUrl: decryptSecret(connection.feed_url),
        accessToken: decryptSecret(connection.access_token),
        refreshToken: decryptSecret(connection.refresh_token),
        externalCalendarId: connection.external_calendar_id,
      },
      windowStart,
      windowEnd,
    );
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      await markSyncOutcome(connectionId, 'needs_config', 0, err.message);
      return { connection_id: connectionId, status: 'needs_config', imported: 0, created: 0, updated: 0, removed: 0, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await markSyncOutcome(connectionId, 'error', 0, msg);
    return { connection_id: connectionId, status: 'error', imported: 0, created: 0, updated: 0, removed: 0, error: msg };
  }

  const calendarId = await resolveTargetCalendarId(connection, orgId);

  // Existing mirror map: external_event_id -> { extRowId, bookEventId }.
  const existingRows = await db
    .select({
      id: bookExternalEvents.id,
      external_event_id: bookExternalEvents.external_event_id,
      book_event_id: bookExternalEvents.book_event_id,
    })
    .from(bookExternalEvents)
    .where(eq(bookExternalEvents.connection_id, connectionId));

  const byExternalId = new Map(existingRows.map((r) => [r.external_event_id, r]));
  const seenExternalIds = new Set<string>();

  let created = 0;
  let updated = 0;
  let removed = 0;

  for (const ev of fetched) {
    seenExternalIds.add(ev.externalId);

    if (ev.status === 'cancelled') {
      // Cancelled upstream: drop the mirror + tracking row if we have them.
      const existing = byExternalId.get(ev.externalId);
      if (existing) {
        if (existing.book_event_id) {
          await db.delete(bookEvents).where(eq(bookEvents.id, existing.book_event_id));
        }
        await db.delete(bookExternalEvents).where(eq(bookExternalEvents.id, existing.id));
        removed++;
      }
      continue;
    }

    const existing = byExternalId.get(ev.externalId);
    const eventValues = {
      calendar_id: calendarId,
      organization_id: orgId,
      title: ev.title,
      description: ev.description ?? null,
      location: ev.location ?? null,
      start_at: ev.startAt,
      end_at: ev.endAt,
      all_day: ev.allDay,
      timezone: 'UTC',
      status: ev.status,
      visibility: ev.visibility,
      updated_at: new Date(),
    };

    if (existing?.book_event_id) {
      // Update the mirrored event in place.
      const [stillThere] = await db
        .update(bookEvents)
        .set(eventValues)
        .where(eq(bookEvents.id, existing.book_event_id))
        .returning({ id: bookEvents.id });
      if (stillThere) {
        updated++;
      } else {
        // Mirror was deleted out from under us — recreate it.
        const [recreated] = await db
          .insert(bookEvents)
          .values({ ...eventValues, created_by: connection.user_id })
          .returning({ id: bookEvents.id });
        await db
          .update(bookExternalEvents)
          .set({ book_event_id: recreated!.id, synced_at: new Date() })
          .where(eq(bookExternalEvents.id, existing.id));
        created++;
      }
      // Refresh the tracking row's denormalized fields.
      await db
        .update(bookExternalEvents)
        .set({
          title: ev.title,
          start_at: ev.startAt,
          end_at: ev.endAt,
          all_day: ev.allDay,
          visibility: ev.visibility,
          synced_at: new Date(),
        })
        .where(eq(bookExternalEvents.id, existing.id));
    } else {
      // New external event: create the mirror, then the tracking row.
      const [bookEv] = await db
        .insert(bookEvents)
        .values({ ...eventValues, created_by: connection.user_id })
        .returning({ id: bookEvents.id });

      if (existing) {
        // Tracking row existed without a mirror — backfill the link.
        await db
          .update(bookExternalEvents)
          .set({
            book_event_id: bookEv!.id,
            title: ev.title,
            start_at: ev.startAt,
            end_at: ev.endAt,
            all_day: ev.allDay,
            visibility: ev.visibility,
            synced_at: new Date(),
          })
          .where(eq(bookExternalEvents.id, existing.id));
      } else {
        await db.insert(bookExternalEvents).values({
          connection_id: connectionId,
          user_id: connection.user_id,
          external_event_id: ev.externalId,
          book_event_id: bookEv!.id,
          title: ev.title,
          start_at: ev.startAt,
          end_at: ev.endAt,
          all_day: ev.allDay,
          visibility: ev.visibility,
        });
      }
      created++;
    }
  }

  // Events that disappeared from the feed entirely: remove their mirrors.
  for (const row of existingRows) {
    if (!seenExternalIds.has(row.external_event_id)) {
      if (row.book_event_id) {
        await db.delete(bookEvents).where(eq(bookEvents.id, row.book_event_id));
      }
      await db.delete(bookExternalEvents).where(eq(bookExternalEvents.id, row.id));
      removed++;
    }
  }

  await markSyncOutcome(connectionId, 'active', fetched.length, null);

  return {
    connection_id: connectionId,
    status: 'active',
    imported: fetched.length,
    created,
    updated,
    removed,
    error: null,
  };
}

async function markSyncOutcome(
  connectionId: string,
  status: 'active' | 'error' | 'needs_config',
  eventCount: number,
  error: string | null,
): Promise<void> {
  await db
    .update(bookExternalConnections)
    .set({
      last_sync_at: new Date(),
      last_sync_event_count: eventCount,
      sync_status: status,
      sync_error: error,
      updated_at: new Date(),
    })
    .where(eq(bookExternalConnections.id, connectionId));
}

// ---------------------------------------------------------------------------
// Force sync (user-initiated) — ownership-checked, runs the engine inline
// ---------------------------------------------------------------------------

export async function forceSync(id: string, userId: string): Promise<SyncResult> {
  const [connection] = await db
    .select({ id: bookExternalConnections.id })
    .from(bookExternalConnections)
    .where(and(eq(bookExternalConnections.id, id), eq(bookExternalConnections.user_id, userId)))
    .limit(1);

  if (!connection) throw notFound('Connection not found');
  return syncConnection(id);
}

// ---------------------------------------------------------------------------
// Sweep — used by the worker. Sync every connection due for a refresh.
// ---------------------------------------------------------------------------

/**
 * Find connections that should sync now (inbound/both, never synced or last
 * synced more than `staleMinutes` ago, and not in a needs_config dead-end) and
 * run the engine for each. Returns per-connection results. ICS-only by default
 * — OAuth providers without creds short-circuit to needs_config and are then
 * skipped on subsequent sweeps.
 */
export async function syncDueConnections(staleMinutes = 30): Promise<SyncResult[]> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  const due = await db
    .select({ id: bookExternalConnections.id })
    .from(bookExternalConnections)
    .where(
      and(
        or(
          eq(bookExternalConnections.sync_direction, 'inbound'),
          eq(bookExternalConnections.sync_direction, 'both'),
        ),
        // Only providers that can run unattended (ICS today). OAuth providers
        // need a live token-refresh path, added with the operator creds.
        eq(bookExternalConnections.provider, 'ics'),
        or(
          isNull(bookExternalConnections.last_sync_at),
          lte(bookExternalConnections.last_sync_at, cutoff),
        ),
      ),
    );

  const results: SyncResult[] = [];
  for (const c of due) {
    try {
      results.push(await syncConnection(c.id));
    } catch (err) {
      results.push({
        connection_id: c.id,
        status: 'error',
        imported: 0,
        created: 0,
        updated: 0,
        removed: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export { NO_SECRET_PROVIDERS };
