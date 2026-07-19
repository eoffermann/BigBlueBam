import { createHash } from 'node:crypto';

// Deterministic arm-key derivation for Bulwark deadlines (Bulwark spec §3.1 STK1/DK1, §4.2).
//
// The `triggering_event_id` of a bulwark_notice_deadline is a DETERMINISTIC RFC-4122 v5
// UUID over source-entity identity plus a state epoch, so the live fire-on-event drain AND
// the bulwark-state-reconcile job (and the radar's calendar arm, and the manual trigger)
// all converge on the SAME id for the same real-world clock. The unique arm index
// (organization_id, obligation_id, triggering_event_id) then collapses the paths to one
// at-most-once atom via ON CONFLICT DO NOTHING.
//
// This module is the SINGLE source of the namespace + the derivation, imported by both
// bulwark-api and the apps/worker jobs so the two can never diverge by a byte. Do NOT
// redefine the namespace anywhere else.

// The fixed v5 namespace UUID. Chosen once for Bulwark; NEVER change it (a change would
// re-key every future deadline and break idempotent convergence with already-armed rows).
export const BULWARK_ARM_NAMESPACE = 'a7c9e0d2-3f4b-4c5d-9e6f-1a2b3c4d5e6f';

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/-/g, ''), 'hex');
}

// RFC-4122 v5 (SHA-1) UUID. Node has no built-in, so implement it deterministically.
export function uuidv5(name: string, namespace: string = BULWARK_ARM_NAMESPACE): string {
  const nsBytes = hexToBytes(namespace);
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version (5) and variant (RFC 4122).
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

// Join key parts with a delimiter that cannot appear inside a uuid/ISO timestamp, so
// (a,b) and (ab,'') never collide.
function armName(parts: Array<string | null | undefined>): string {
  return parts.map((p) => p ?? '').join('|');
}

// Event-armed (state-reflecting) binding: obligation + the entity_filter primary entity id
// from scope_fields + the state epoch (the source condition's defining timestamp, e.g. the
// task's due_at). Identical on the live drain and on bulwark-state-reconcile.
export function eventArmKey(
  obligationId: string,
  scopeEntityId: string,
  stateEpoch: string,
): string {
  return uuidv5(armName([obligationId, scopeEntityId, stateEpoch]));
}

// ── State-reflecting binding epoch convergence (#67) ────────────────────────
//
// A "state-reflecting" binding is one whose trigger corresponds to a queryable persistent
// condition, so bulwark-state-reconcile can re-derive the SAME clock the live fire-on-event
// drain armed. For those, the two paths derive the state epoch from DIFFERENT sources:
//   - the live drain, from the event's full-timestamp trigger_at;
//   - state-reconcile, from tasks.due_date, a DATE (midnight UTC).
// If they fed those raw values to eventArmKey the keys would differ and every such obligation
// would double-arm -> double notice. This module OWNS the canonical granularity so the two
// callers physically cannot diverge: both go through eventArmKeyForBinding, which truncates the
// epoch to a UTC day for state-reflecting bindings. The beachhead is bam:task.overdue, whose
// canonical epoch is the task's due date at day granularity.
//
// NOTE: non-state-reflecting event bindings pass the raw epoch through UNCHANGED so their
// already-armed keys stay byte-stable (changing eventArmKey globally would re-key live rows).
const STATE_REFLECTING_BINDINGS = new Set<string>(['bam:task.overdue']);

export function isStateReflectingBinding(source: string, eventType: string): boolean {
  return STATE_REFLECTING_BINDINGS.has(`${source}:${eventType}`);
}

// Truncate any ISO/timestamp epoch to the canonical UTC day-ISO string
// (YYYY-MM-DDT00:00:00.000Z). Idempotent: a value already at UTC midnight maps to itself, so a
// persisted (already-normalized) arm_state_epoch re-derives the same key on a supersession
// re-point. Defensively passes an unparseable value through unchanged.
export function normalizeStateEpochToDay(epoch: string): string {
  const d = new Date(epoch);
  if (Number.isNaN(d.getTime())) return epoch;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

// The canonical event arm key BOTH the live drain and state-reconcile MUST use. Returns the key
// AND the (possibly normalized) epoch so the caller persists the SAME epoch it keyed on into
// arm_state_epoch (keeping a later supersession re-point via eventArmKey consistent). For a
// state-reflecting binding the epoch is normalized to a UTC day; otherwise it is passed through.
export function eventArmKeyForBinding(
  obligationId: string,
  scopeEntityId: string,
  rawEpoch: string,
  source: string,
  eventType: string,
): { key: string; epoch: string } {
  const epoch = isStateReflectingBinding(source, eventType)
    ? normalizeStateEpochToDay(rawEpoch)
    : rawEpoch;
  return { key: eventArmKey(obligationId, scopeEntityId, epoch), epoch };
}

// Calendar-armed binding: obligation + the anchor date (recomputed to the successor on a
// supersession re-point, STJ4).
export function calendarArmKey(obligationId: string, anchorDate: string): string {
  return uuidv5(armName([obligationId, anchorDate]));
}

// Manual trigger: obligation + the human-supplied occurred_at.
export function manualArmKey(obligationId: string, occurredAt: string): string {
  return uuidv5(armName([obligationId, occurredAt]));
}
