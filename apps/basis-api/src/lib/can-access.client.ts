import { preflightMany } from '@bigbluebam/shared/visibility-client';

// Class-B dimension visibility resolution (spec 2.2 / 4.5).
//
// This is a THIN WRAPPER over the shared visibility primitive, not a visibility client.
// The transport, auth, and fail-closed semantics live in ONE place for the whole suite:
// packages/shared/src/visibility-client.ts. Do not re-implement the fetch here.
//
// What stays basis-local is the Class-B decomposition layer: mapping a decomposition
// DIMENSION NAME to a can_access entity_type. That mapping is basis domain knowledge about
// its own analytics dimensions, so it does not belong in the shared package.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cap on how many values a single decomposition may preflight, so a huge result set cannot
// stampede the preflight endpoint. Values beyond the cap stay suppressed (fail closed).
const MAX_PREFLIGHT_VALUES = 200;

// Map a Class-B decomposition dimension name to a can_access entity_type. Only id-valued
// dimensions (the value IS an entity id) are resolvable; a dimension whose values are
// names/labels cannot be preflighted, so it is not listed here and stays fully suppressed.
// Extend this as more id-valued dimensions are exposed. Keys are matched case-insensitively
// against the dimension name.
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

// Re-exported under the basis-local name so existing call sites keep reading naturally.
// This IS the shared primitive, with its fail-closed contract intact.
export { preflightAccess as canAccessEntity } from '@bigbluebam/shared/visibility-client';

/**
 * Given the asker and a Class-B dimension plus its candidate values, return the subset of
 * values the asker is allowed to see. Fails closed (empty set) when: there is no asker, the
 * dimension is not an id-valued mappable dimension, or the internal preflight is
 * unavailable. Non-UUID values are skipped (they cannot be preflighted).
 */
export async function resolveVisibleValues(
  askerUserId: string | undefined,
  dimension: string,
  values: string[],
): Promise<Set<string>> {
  if (!askerUserId) return new Set<string>();
  const entityType = entityTypeForDimension(dimension);
  if (!entityType) return new Set<string>();

  const candidates = values.filter((v) => UUID_RE.test(v)).slice(0, MAX_PREFLIGHT_VALUES);
  return preflightMany(askerUserId, entityType, candidates);
}
