// ---------------------------------------------------------------------------
// beacon_upsert_by_slug service (AGENTIC_TODO §14 Wave 4)
//
// Idempotent create-or-update on (organization_id, slug). Slugs are unique per
// org (beacon_entries_org_slug_key, migration 0289, issue #246), so the natural
// key is the caller's org plus the slug: another org's row with the same slug is
// invisible here and never touched. Update path bumps `version` to match existing `beacon_update` behavior and writes
// a new `beacon_versions` snapshot.
//
// Response envelope: `{ data, created, idempotency_key }`. The idempotency
// key is `slug:<slug>` so log lines for retried webhooks collate.
// ---------------------------------------------------------------------------

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconEntries, beaconVersions } from '../db/schema/index.js';
import { sanitizeHtml } from '../lib/sanitize.js';

export class EntryUpsertError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'EntryUpsertError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EntryUpsertInput {
  slug: string;
  title: string;
  summary?: string | null;
  body_markdown: string;
  body_html?: string | null;
  visibility?: 'Public' | 'Organization' | 'Project' | 'Private';
  project_id?: string | null;
  metadata?: Record<string, unknown>;
  /** Human-friendly note attached to the new version row on update. */
  change_note?: string | null;
}

export interface EntryUpsertResult {
  data: typeof beaconEntries.$inferSelect;
  created: boolean;
  idempotency_key: string;
}

/**
 * Resolve the effective default_expiry_days for a new beacon. Inlined here
 * rather than imported from beacon.service.ts to keep the upsert path
 * self-contained. Falls back to 90 days when no org-level override exists.
 */
async function resolveDefaultExpiryDays(orgId: string): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT default_expiry_days FROM beacon_expiry_policies
        WHERE (scope = 'Organization' AND organization_id = ${orgId})
           OR scope = 'System'
        ORDER BY scope = 'Organization' DESC
        LIMIT 1`,
  )) as unknown as { rows?: Array<{ default_expiry_days: number }> };
  const row = Array.isArray(rows)
    ? (rows[0] as { default_expiry_days: number } | undefined)
    : rows.rows?.[0];
  return row?.default_expiry_days ?? 90;
}

/**
 * Upsert a Beacon entry by slug within the caller's org.
 *
 * This used to treat slug as a global natural key, so a caller naming another
 * org's slug resolved that org's row, overwrote it and got it back (BCN-1,
 * #246). The lookup, the ON CONFLICT target and the update predicate are all
 * org-scoped now: a slug held by another org reads as "does not exist" and the
 * insert path creates the caller's own row under the per-org unique key.
 */
export async function upsertEntryBySlug(
  input: EntryUpsertInput,
  userId: string,
  orgId: string,
): Promise<EntryUpsertResult> {
  if (!input.slug || input.slug.trim() === '') {
    throw new EntryUpsertError(
      'VALIDATION_ERROR',
      'slug is required and must be non-empty',
      400,
    );
  }
  if (!input.title || input.title.trim() === '') {
    throw new EntryUpsertError(
      'VALIDATION_ERROR',
      'title is required and must be non-empty',
      400,
    );
  }
  if (!input.body_markdown || input.body_markdown.trim() === '') {
    throw new EntryUpsertError(
      'VALIDATION_ERROR',
      'body_markdown is required and must be non-empty',
      400,
    );
  }

  const slug = input.slug.trim();

  // Pre-check so we can discriminate create vs. update before we decide
  // whether to emit a new beacon_versions row and bump `version`.
  const [existing] = await db
    .select()
    .from(beaconEntries)
    .where(and(eq(beaconEntries.organization_id, orgId), eq(beaconEntries.slug, slug)))
    .limit(1);

  if (!existing) {
    const expiryDays = await resolveDefaultExpiryDays(orgId);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    // Race-safe insert: if a parallel writer grabbed the same slug between
    // our pre-check and this statement, ON CONFLICT (organization_id, slug)
    // gives us the existing row (in this org only). `xmax = 0` is true only for the freshly-inserted row.
    const inserted = await db
      .insert(beaconEntries)
      .values({
        slug,
        title: input.title,
        summary: input.summary ?? null,
        body_markdown: input.body_markdown,
        body_html: input.body_html ? sanitizeHtml(input.body_html) : null,
        version: 1,
        status: 'Draft',
        visibility: input.visibility ?? 'Project',
        created_by: userId,
        owned_by: userId,
        project_id: input.project_id ?? null,
        organization_id: orgId,
        expires_at: expiresAt,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [beaconEntries.organization_id, beaconEntries.slug],
        set: {
          // Deliberately narrow set: the conflict branch only happens when
          // a parallel writer raced us. Let the canonical update path
          // below handle the richer update semantics (version bump,
          // version snapshot). Here we just keep the row non-stale.
          updated_at: new Date(),
        },
      })
      .returning({
        // Drizzle's returning() types do not accept a full table reference
        // under @bigbluebam/db-stubs; cast so we still get the whole row
        // back without enumerating every column by hand.
        entry: beaconEntries as unknown as import('drizzle-orm').SQL<typeof beaconEntries.$inferSelect>,
        created: sql<boolean>`(xmax = 0)`.as('created'),
      });

    const row = inserted[0];
    if (!row) {
      throw new EntryUpsertError('INTERNAL', 'Upsert returned no row', 500);
    }
    const entry = row.entry as typeof beaconEntries.$inferSelect;
    const created = row.created === true;

    if (created) {
      await db.insert(beaconVersions).values({
        beacon_id: entry.id,
        version: 1,
        title: input.title,
        summary: input.summary ?? null,
        body_markdown: input.body_markdown,
        changed_by: userId,
        change_note: 'Initial version (upsert)',
      });
    }

    return {
      data: entry,
      created,
      idempotency_key: `slug:${slug}`,
    };
  }

  // Update path: existing row with same slug in this org. Bump version and
  // write a snapshot to mirror beacon_update.
  const newVersion = existing.version + 1;
  const [entry] = await db
    .update(beaconEntries)
    .set({
      title: input.title,
      summary: input.summary ?? null,
      body_markdown: input.body_markdown,
      body_html: input.body_html ? sanitizeHtml(input.body_html) : existing.body_html,
      version: newVersion,
      visibility: input.visibility ?? existing.visibility,
      metadata: input.metadata ?? existing.metadata,
      updated_at: new Date(),
    })
    // The org predicate is redundant with the scoped lookup above on purpose:
    // a future regression there cannot become a cross-tenant overwrite here.
    .where(and(eq(beaconEntries.id, existing.id), eq(beaconEntries.organization_id, orgId)))
    .returning();

  if (!entry) {
    throw new EntryUpsertError('INTERNAL', 'Update returned no row', 500);
  }

  await db.insert(beaconVersions).values({
    beacon_id: entry.id,
    version: newVersion,
    title: input.title,
    summary: input.summary ?? null,
    body_markdown: input.body_markdown,
    changed_by: userId,
    change_note: input.change_note ?? 'upserted via beacon_upsert_by_slug',
  });

  return {
    data: entry,
    created: false,
    idempotency_key: `slug:${slug}`,
  };
}
