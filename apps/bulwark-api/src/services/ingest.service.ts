import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BulwarkIngestEventInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { bulwarkIngestEvents } from '../db/schema/index.js';
import { enqueueFireOnEvent } from '../lib/queue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep only uuid-shaped scope_fields values (SM1). A binding whose payload_path points at a
// non-id field, or an event carrying a non-uuid value, must not persist PII past the drain
// horizon, so non-conforming values are dropped here.
function sanitizeScopeFields(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && UUID_RE.test(v)) out[k] = v;
  }
  return out;
}

export interface WriteIngestResult {
  ingest_event_id: string;
  deduped: boolean;
  enqueued: boolean;
}

// Durably persist an accepted Bolt event into the inbox BEFORE firing (THEME D / STJ6), dedup
// on (organization_id, source_idempotency_key), then enqueue the fire-on-event drain. A lost
// enqueue is recovered by the radar's scheduled pending-drain (spec §4.3 step 0).
export async function writeIngestEvent(input: BulwarkIngestEventInput): Promise<WriteIngestResult> {
  const idemKey = input.source_idempotency_key ?? input.bolt_event_id ?? randomUUID();
  const loggedAt = input.logged_at ? new Date(input.logged_at) : new Date();
  const triggerAt = input.trigger_at ? new Date(input.trigger_at) : null;
  const scopeFields = sanitizeScopeFields(input.scope_fields);

  const [row] = await db
    .insert(bulwarkIngestEvents)
    .values({
      organization_id: input.org_id,
      source_idempotency_key: idemKey,
      bolt_event_id: input.bolt_event_id ?? null,
      source: input.source,
      event_type: input.event_type,
      logged_at: loggedAt,
      trigger_at: triggerAt,
      scope_fields: scopeFields,
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [bulwarkIngestEvents.organization_id, bulwarkIngestEvents.source_idempotency_key],
    })
    .returning({ id: bulwarkIngestEvents.id });

  if (!row) {
    // Redelivery: the row already exists. Look it up so the caller can still trace it; no
    // re-enqueue (the deterministic arm key makes a second drain a no-op anyway).
    const [existing] = await db
      .select({ id: bulwarkIngestEvents.id })
      .from(bulwarkIngestEvents)
      .where(
        and(
          eq(bulwarkIngestEvents.organization_id, input.org_id),
          eq(bulwarkIngestEvents.source_idempotency_key, idemKey),
        ),
      )
      .limit(1);
    return { ingest_event_id: existing?.id ?? '', deduped: true, enqueued: false };
  }

  const enqueued = await enqueueFireOnEvent({
    org_id: input.org_id,
    ingest_event_id: row.id,
  });
  return { ingest_event_id: row.id, deduped: false, enqueued };
}
