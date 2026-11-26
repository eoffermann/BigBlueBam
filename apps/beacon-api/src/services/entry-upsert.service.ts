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
  const expiryDays = await resolveDefaultExpiryDays(orgId);
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  // One transaction, so the entry write and its beacon_versions snapshot commit or roll back
  // together (#280). Concurrency, for two callers upserting the same org + slug at once:
  //   - create race: INSERT ... ON CONFLICT DO NOTHING lets exactly one insert win; the loser
  //     gets no row back and falls through to the update path, so its content is APPLIED as the
  //     next version (it used to be silently dropped with created:false).
  //   - update race: the UPDATE takes the row lock and bumps `version = version + 1` in SQL, so
  //     the second caller waits and writes N + 2 (two callers used to both write N + 1, and the
  //     second 500'd on beacon_versions_beacon_id_version_key after its entry update landed).
  return db.transaction(async (tx) => {
    const inserted = await tx
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
      // Conflict target is the per-org unique key: another org's row with this slug never
      // conflicts (#246). On conflict, nothing is returned and the update path below runs.
      .onConflictDoNothing({ target: [beaconEntries.organization_id, beaconEntries.slug] })
      .returning();

    const created = inserted[0];
    if (created) {
      await tx.insert(beaconVersions).values({
        beacon_id: created.id,
        version: 1,
        title: input.title,
        summary: input.summary ?? null,
        body_markdown: input.body_markdown,
        changed_by: userId,
        change_note: 'Initial version (upsert)',
      });
      return { data: created, created: true, idempotency_key: `slug:${slug}` };
    }

    // Update path: the row exists in this org. Only the fields the caller sent replace the stored
    // ones (body_html, visibility and metadata keep their values when omitted).
    const set: Record<string, unknown> = {
      title: input.title,
      summary: input.summary ?? null,
      body_markdown: input.body_markdown,
      version: sql`${beaconEntries.version} + 1`,
      updated_at: new Date(),
    };
    if (input.body_html) set.body_html = sanitizeHtml(input.body_html);
    if (input.visibility) set.visibility = input.visibility;
    if (input.metadata) set.metadata = input.metadata;

    const [entry] = await tx
      .update(beaconEntries)
      .set(set)
      .where(and(eq(beaconEntries.organization_id, orgId), eq(beaconEntries.slug, slug)))
      .returning();
    if (!entry) {
      throw new EntryUpsertError('INTERNAL', 'Update returned no row', 500);
    }

    // The snapshot carries the version the UPDATE just wrote, under its row lock.
    await tx.insert(beaconVersions).values({
      beacon_id: entry.id,
      version: entry.version,
      title: input.title,
      summary: input.summary ?? null,
      body_markdown: input.body_markdown,
      changed_by: userId,
      change_note: input.change_note ?? 'upserted via beacon_upsert_by_slug',
    });

    return { data: entry, created: false, idempotency_key: `slug:${slug}` };
  });
}
