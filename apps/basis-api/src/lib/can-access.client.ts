import { env } from '../env.js';

// Per-viewer visibility resolution for Class-B decomposition (spec 2.2 / 4.5).
// A Class-B dimension's values are entity references; to serve a per-value label
// to an asker we must confirm the asker can see that entity. We call the Bam API's
// internal can_access preflight (service-secret auth) - the SAME rules the
// agent-facing can_access tool uses (apps/api/src/services/visibility.service.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map a Class-B decomposition dimension name to a can_access entity_type. Only
// id-valued dimensions (the value IS an entity id) are resolvable; a dimension
// whose values are names/labels cannot be preflighted, so it is not listed here
// and stays fully suppressed. Extend this as more id-valued dimensions are
// exposed. Keys are matched case-insensitively against the dimension name.
const DIMENSION_ENTITY_TYPE: Record<string, string> = {
  company_id: 'bond.company',
  company: 'bond.company',
  contact_id: 'bond.contact',
  contact: 'bond.contact',
  deal_id: 'bond.deal',
  deal: 'bond.deal',
  project_id: 'bam.project',
  project: 'bam.project',
  task_id: 'bam.task',
  ticket_id: 'helpdesk.ticket',
  invoice_id: 'bill.invoice',
  goal_id: 'bearing.goal',
  document_id: 'brief.document',
  entry_id: 'beacon.entry',
};

export function entityTypeForDimension(dimension: string): string | null {
  return DIMENSION_ENTITY_TYPE[dimension.toLowerCase()] ?? null;
}

export async function canAccessEntity(
  askerUserId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/visibility/can-access`;
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false; // no secret -> cannot verify -> fail closed
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ asker_user_id: askerUserId, entity_type: entityType, entity_id: entityId }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { allowed?: boolean };
    return json.allowed === true;
  } catch {
    return false; // unreachable -> fail closed
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Given the asker and a Class-B dimension plus its candidate values, return the
 * subset of values the asker is allowed to see. Fails closed (empty set) when:
 * there is no asker, the dimension is not an id-valued mappable dimension, or the
 * internal preflight is unavailable. Non-UUID values are skipped (cannot be
 * preflighted). Bounded fan-out so a huge decomposition cannot stampede the
 * preflight endpoint.
 */
export async function resolveVisibleValues(
  askerUserId: string | undefined,
  dimension: string,
  values: string[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (!askerUserId) return visible;
  const entityType = entityTypeForDimension(dimension);
  if (!entityType) return visible;

  const candidates = values.filter((v) => UUID_RE.test(v)).slice(0, 200);
  const CONCURRENCY = 8;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (v) => ({ v, ok: await canAccessEntity(askerUserId, entityType, v) })),
    );
    for (const r of results) if (r.ok) visible.add(r.v);
  }
  return visible;
}
