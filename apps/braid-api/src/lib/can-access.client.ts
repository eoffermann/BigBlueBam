import { env } from '../env.js';

// Per-viewer visibility preflight for Braid (spec 2.1 plane 2 / 2.5).
//
// A golden profile is consolidated cross-app PII. Before serving any member
// identity's field to an asker we confirm the asker can see that source record,
// using the Bam API's internal can_access preflight (the SAME rules the
// agent-facing can_access tool uses, apps/api/src/services/visibility.service.ts).
// Ported from apps/basis-api/src/lib/can-access.client.ts.
//
// Fail-closed on every non-2xx, timeout, missing secret, or transport error: a
// deny must never leak as an allow (spec 2.5). The braid source_type strings
// (bond.contact, bond.company, bill.client, helpdesk.user, book.event_attendee)
// double as can_access entity_type values; book.event_attendee gates through its
// parent book.event in the visibility service (spec 2.5).

const UPSTREAM_TIMEOUT_MS = 4000;

export async function preflightAccess(
  askerUserId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/visibility/can-access`;
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false; // no secret -> cannot verify -> fail closed
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        asker_user_id: askerUserId,
        entity_type: entityType,
        entity_id: entityId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { allowed?: boolean };
    return json.allowed === true;
  } catch {
    return false; // unreachable / aborted -> fail closed
  } finally {
    clearTimeout(timer);
  }
}

// Batched preflight for a set of (entity_type, entity_id) pairs. Bounded fan-out
// so a large member list cannot stampede the preflight endpoint. Returns the set
// of entity_ids the asker may see (fail-closed: anything not confirmed is absent).
// The per-source_type batching the spec 2.1 calls for is expressed by the caller
// grouping ids by entity_type; this helper just caps concurrency.
export async function preflightMany(
  askerUserId: string,
  entityType: string,
  entityIds: string[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  const unique = [...new Set(entityIds)];
  const CONCURRENCY = 8;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => ({ id, ok: await preflightAccess(askerUserId, entityType, id) })),
    );
    for (const r of results) if (r.ok) visible.add(r.id);
  }
  return visible;
}
