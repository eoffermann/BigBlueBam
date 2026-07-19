import { and, eq, sql } from 'drizzle-orm';
import {
  bulwarkDeadlineRuleSchema,
  bulwarkEventBindingSchema,
  type BulwarkDeadlineRule,
} from '@bigbluebam/shared';
import { eventArmKey } from '@bigbluebam/shared/bulwark-arm-key';
import { db } from '../db/index.js';
import {
  bulwarkContracts,
  bulwarkIngestEvents,
  bulwarkObligations,
} from '../db/schema/index.js';
import { computeDueAt } from './deadline-math.service.js';
import { armDeadline } from './arming.service.js';

// Event-binding + firing engine (spec §4.2), an INBOX DRAIN. Loads one durably-inboxed event,
// matches it against armed obligations, evaluates each entity_filter FAIL-CLOSED, computes the
// timezone-anchored due_at, and arms at-most-once via the deterministic event arm key. The
// apps/worker bulwark-fire-on-event job (later milestone) calls drainIngestEvent; the same
// function is what the radar's pending-inbox drain (spec §4.3 step 0) invokes.

type ScopeFields = Record<string, unknown>;

function lastSegment(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1) : path;
}

// The entity_filter primary entity id from scope_fields. Looks up the full payload_path first
// (that is how the dispatcher keys it), then the last segment as a fallback.
function scopeEntityId(scope: ScopeFields, payloadPath: string): string | null {
  const direct = scope[payloadPath];
  if (typeof direct === 'string') return direct;
  const seg = scope[lastSegment(payloadPath)];
  return typeof seg === 'string' ? seg : null;
}

// Read a contract column named by equals_contract_field. Only a small allowlist of id-typed
// columns is comparable (SM1 keeps the binding side id-typed too).
function contractFieldValue(
  contract: typeof bulwarkContracts.$inferSelect,
  field: string,
): string | null {
  switch (field) {
    case 'project_id':
      return contract.project_id;
    case 'counterparty_id':
      return contract.counterparty_id;
    case 'id':
      return contract.id;
    default:
      return null;
  }
}

export interface DrainResult {
  processed: boolean;
  armed_count: number;
  skipped_reason?: string;
}

export async function drainIngestEvent(
  orgId: string,
  ingestEventId: string,
): Promise<DrainResult> {
  const [event] = await db
    .select()
    .from(bulwarkIngestEvents)
    .where(
      and(
        eq(bulwarkIngestEvents.organization_id, orgId),
        eq(bulwarkIngestEvents.id, ingestEventId),
      ),
    )
    .limit(1);
  if (!event) return { processed: false, armed_count: 0, skipped_reason: 'not_found' };
  if (event.status === 'processed')
    return { processed: true, armed_count: 0, skipped_reason: 'already_processed' };

  // Armed obligations whose binding (source, event_type) matches this event.
  const obligations = await db
    .select({ o: bulwarkObligations, c: bulwarkContracts })
    .from(bulwarkObligations)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkObligations.contract_id))
    .where(
      and(
        eq(bulwarkObligations.organization_id, orgId),
        eq(bulwarkObligations.is_armed, true),
        sql`${bulwarkObligations.event_binding}->>'source' = ${event.source}`,
        sql`${bulwarkObligations.event_binding}->>'event_type' = ${event.event_type}`,
      ),
    );

  const scope = (event.scope_fields ?? {}) as ScopeFields;
  // The legal anchor: trigger_at if present, else logged_at (THEME B).
  const anchor = event.trigger_at ? new Date(event.trigger_at) : new Date(event.logged_at);
  const anchorSource = event.trigger_at ? 'trigger_at' : 'logged_at';
  // The state epoch: the source condition's defining timestamp (trigger_at preferred). The
  // M6 bulwark-state-reconcile job MUST derive the same epoch from source state so the keys
  // converge (STK1).
  const stateEpoch = (event.trigger_at
    ? new Date(event.trigger_at)
    : new Date(event.logged_at)
  ).toISOString();

  let armedCount = 0;
  for (const { o, c } of obligations) {
    const binding = bulwarkEventBindingSchema.safeParse(o.event_binding);
    if (!binding.success) continue;
    const filter = binding.data.entity_filter;
    // FAIL CLOSED (S5): an armed event-bound obligation always has a non-empty entity_filter.
    if (!filter?.payload_path || !filter.equals_contract_field) continue;

    const entityId = scopeEntityId(scope, filter.payload_path);
    if (!entityId) continue; // no matching scope field -> arms nothing (never over-fires)
    const expected = contractFieldValue(c, filter.equals_contract_field);
    if (!expected || expected !== entityId) continue;

    const ruleParsed = bulwarkDeadlineRuleSchema.safeParse(o.deadline_rule);
    const rule: BulwarkDeadlineRule = ruleParsed.success
      ? ruleParsed.data
      : {
          offset_days: 0,
          unit: 'calendar_days',
          from: 'trigger_event',
          timezone: c.timezone,
          roll_forward: true,
          grace_hours: 0,
        };
    const { due_at, resolved_timezone } = computeDueAt({ anchor, rule });

    const result = await armDeadline({
      orgId,
      obligationId: o.id,
      contractId: c.id,
      projectId: c.project_id,
      triggeringEventId: eventArmKey(o.id, entityId, stateEpoch),
      anchorSource,
      triggeredAt: anchor,
      loggedAt: new Date(event.logged_at),
      resolvedTimezone: resolved_timezone,
      dueAt: due_at,
      ingestEventId: event.id,
    });
    if (result.armed) armedCount++;
  }

  await db
    .update(bulwarkIngestEvents)
    .set({ status: 'processed', processed_at: new Date() })
    .where(eq(bulwarkIngestEvents.id, event.id));

  return { processed: true, armed_count: armedCount };
}
