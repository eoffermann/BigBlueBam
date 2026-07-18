// Source-row reader (spec 4.1). The worker reads the changed source row directly via
// Postgres (no server-to-server HTTP for source reads; it shares DATABASE_URL). Produces
// the normalized match keys, the raw_attributes snapshot Braid stores, the derived org,
// the profile kind, and the platform_user_id anchor (book attendees only).

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { normalizeMatchKeys, type NormalizedMatchKeys } from './normalize.js';
import {
  bondContacts,
  bondCompanies,
  billClients,
  bookEventAttendees,
  bookEvents,
  helpdeskUsers,
} from './schema.js';

// Accept any drizzle db (worker uses postgres-js).
type AnyDb = PostgresJsDatabase<Record<string, never>> | NodePgDatabase<Record<string, never>>;

export interface SourceRecord {
  /** Derived org (from the row itself or, for book attendees, its parent event). */
  orgId: string;
  kind: 'person' | 'company';
  matchKeys: NormalizedMatchKeys;
  /** Snapshot of the source fields Braid read, keyed for survivorship recompute. */
  rawAttributes: Record<string, unknown>;
  /** book_event_attendees.user_id: strong platform anchor when present. */
  platformUserId: string | null;
  /** Source row updated_at, used to stamp braid_identities.source_synced_at. */
  sourceUpdatedAt: Date | null;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Returns null when the source row is missing (deleted or never existed) so the caller
// can skip cleanly. Throws on an unknown source_type so an unexpected type is loud.
export async function readSourceRecord(
  db: AnyDb,
  sourceType: string,
  sourceId: string,
): Promise<SourceRecord | null> {
  switch (sourceType) {
    case 'bond.contact': {
      const [row] = await db.select().from(bondContacts).where(eq(bondContacts.id, sourceId)).limit(1);
      if (!row || row.deleted_at) return null;
      const name = [s(row.first_name), s(row.last_name)].filter(Boolean).join(' ') || null;
      return {
        orgId: row.organization_id,
        kind: 'person',
        matchKeys: normalizeMatchKeys({ email: row.email, phone: row.phone, name }),
        rawAttributes: {
          display_name: name,
          email: s(row.email),
          phone: s(row.phone),
          title: s(row.title),
        },
        platformUserId: null,
        sourceUpdatedAt: row.updated_at ?? null,
      };
    }
    case 'bond.company': {
      const [row] = await db.select().from(bondCompanies).where(eq(bondCompanies.id, sourceId)).limit(1);
      if (!row || row.deleted_at) return null;
      return {
        orgId: row.organization_id,
        kind: 'company',
        matchKeys: normalizeMatchKeys({ name: row.name, phone: row.phone }),
        rawAttributes: {
          display_name: s(row.name),
          phone: s(row.phone),
          domain: s(row.domain),
          website: s(row.website),
        },
        platformUserId: null,
        sourceUpdatedAt: row.updated_at ?? null,
      };
    }
    case 'bill.client': {
      const [row] = await db.select().from(billClients).where(eq(billClients.id, sourceId)).limit(1);
      if (!row) return null;
      // bill.client may be a person or company; the request path can't tell, so seed as
      // person (spec 1). Survivorship still merges on exact email/phone.
      return {
        orgId: row.organization_id,
        kind: 'person',
        matchKeys: normalizeMatchKeys({ email: row.email, phone: row.phone, name: row.name }),
        rawAttributes: {
          display_name: s(row.name),
          email: s(row.email),
          phone: s(row.phone),
        },
        platformUserId: null,
        sourceUpdatedAt: row.updated_at ?? null,
      };
    }
    case 'book.event_attendee': {
      const [row] = await db
        .select()
        .from(bookEventAttendees)
        .where(eq(bookEventAttendees.id, sourceId))
        .limit(1);
      if (!row) return null;
      // book_event_attendees has no organization_id: derive it from the parent event
      // (spec 4.1 / D-r2-6), the same parent the visibility branch gates through.
      const [event] = await db
        .select({ organization_id: bookEvents.organization_id })
        .from(bookEvents)
        .where(eq(bookEvents.id, row.event_id))
        .limit(1);
      if (!event) return null;
      return {
        orgId: event.organization_id,
        kind: 'person',
        matchKeys: normalizeMatchKeys({ email: row.email, name: row.name }),
        rawAttributes: {
          display_name: s(row.name),
          email: s(row.email),
        },
        platformUserId: s(row.user_id),
        sourceUpdatedAt: row.updated_at ?? null,
      };
    }
    case 'helpdesk.user': {
      const [row] = await db.select().from(helpdeskUsers).where(eq(helpdeskUsers.id, sourceId)).limit(1);
      if (!row || !row.org_id) return null;
      return {
        orgId: row.org_id,
        kind: 'person',
        matchKeys: normalizeMatchKeys({ email: row.email, name: row.display_name }),
        rawAttributes: {
          display_name: s(row.display_name),
          email: s(row.email),
        },
        platformUserId: null,
        sourceUpdatedAt: row.updated_at ?? null,
      };
    }
    default:
      throw new Error(`braid: unknown source_type ${sourceType}`);
  }
}

// Guard: only source types with a verified visibility branch + enablement are ingested
// (spec 5.5). The worker double-checks the org enabled it before processing.
export const KNOWN_SOURCE_TYPES = [
  'bond.contact',
  'bond.company',
  'bill.client',
  'book.event_attendee',
  'helpdesk.user',
] as const;

// eq/and re-exported so the engine can build source anti-join scans without re-importing.
export { and, eq };
