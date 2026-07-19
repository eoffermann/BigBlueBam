import { db } from '../db/index.js';
import { bulwarkNoticeDeadlines } from '../db/schema/index.js';
import { publishBulwarkFrame } from '../lib/realtime.js';
import type { BulwarkAnchorSource } from '@bigbluebam/shared';

// The single at-most-once deadline arm (spec §4.2 step 6 / BP10). Every arm path - the live
// fire-on-event drain, the radar calendar arm, and the manual trigger - funnels through here
// so they all get identical ON CONFLICT semantics and all publish the deadline.armed frame on
// ANY conflict-free insert regardless of arm path (BP10).
//
// The unique index (organization_id, obligation_id, triggering_event_id) makes a redelivered
// or reconciled event a no-op: ON CONFLICT DO NOTHING returns zero rows and we publish
// nothing. The deterministic triggering_event_id (computed by the shared @bigbluebam/shared
// arm-key helpers) is what guarantees the drain and bulwark-state-reconcile converge.

export interface ArmDeadlineParams {
  orgId: string;
  obligationId: string;
  contractId: string;
  // The owning contract's project_id (null for a no-project contract), for project-scoped
  // ws fan-out (SK1).
  projectId: string | null;
  triggeringEventId: string;
  // The two components of the deterministic EVENT arm key, persisted so amendment supersession
  // can recompute the successor key in place (STJ4). Null for calendar/manual arms.
  armScopeEntityId?: string | null;
  armStateEpoch?: string | null;
  anchorSource: BulwarkAnchorSource;
  triggeredAt: Date;
  loggedAt?: Date | null;
  resolvedTimezone: string;
  dueAt: Date;
  ingestEventId?: string | null;
}

export interface ArmResult {
  armed: boolean;
  deadlineId: string | null;
}

export async function armDeadline(params: ArmDeadlineParams): Promise<ArmResult> {
  const [row] = await db
    .insert(bulwarkNoticeDeadlines)
    .values({
      organization_id: params.orgId,
      obligation_id: params.obligationId,
      contract_id: params.contractId,
      ingest_event_id: params.ingestEventId ?? null,
      triggering_event_id: params.triggeringEventId,
      arm_scope_entity_id: params.armScopeEntityId ?? null,
      arm_state_epoch: params.armStateEpoch ?? null,
      anchor_source: params.anchorSource,
      triggered_at: params.triggeredAt,
      logged_at: params.loggedAt ?? null,
      resolved_timezone: params.resolvedTimezone,
      due_at: params.dueAt,
      status: 'open',
      notice_status: 'none',
    })
    .onConflictDoNothing({
      target: [
        bulwarkNoticeDeadlines.organization_id,
        bulwarkNoticeDeadlines.obligation_id,
        bulwarkNoticeDeadlines.triggering_event_id,
      ],
    })
    .returning({ id: bulwarkNoticeDeadlines.id });

  if (!row) return { armed: false, deadlineId: null };

  // Publish deadline.armed on the conflict-free insert (BP10). Project-scoped fan-out is
  // enforced by the ws handler (SK1); the frame carries only refs.
  await publishBulwarkFrame(params.orgId, params.projectId, {
    type: 'deadline.armed',
    data: { deadline_id: row.id, obligation_id: params.obligationId, due_at: params.dueAt.toISOString() },
  });
  return { armed: true, deadlineId: row.id };
}
