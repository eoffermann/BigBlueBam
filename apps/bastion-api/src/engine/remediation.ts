// The control's Bam task (spec 2.5, 2.6). Bastion never writes Bam tables: every task change is a
// bastion_outbox row written in the SAME transaction as the drift (or exception) row that causes
// it, delivered later to the api-owned /internal/bastion routes. All rows for one control share
// the ordering key `control:<id>`, so an upsert is always delivered before a later comment.
//
//   drift            bam_task_upsert: create the task, or reopen it to the start phase with
//                    "Drifted again on {date}: {reason}" (or "Accepted risk expired on {date}")
//   recovery         bam_task_comment "Back to passing on {date}." (the task is never closed)
//   exception        bam_task_comment "Risk accepted until {date}: {reason}"
//
// Comments are addressed by external_id `bastion:control:<id>`, never by a task id from an
// earlier delivery, so they never depend on that delivery's result.

import { bastionControlTaskExternalId } from '@bigbluebam/shared';
import { localClock, type Tx } from './context.js';
import { enqueueOutbox } from './outbox.js';

export const REASON_PHRASE: Record<string, string> = {
  failed: 'the check failed',
  exception_expired: 'the accepted risk ran out',
  no_evidence_source: 'nothing can show this yet',
  source_not_connected: "the source isn't connected",
  manual_evidence_missing: 'evidence is waiting to be uploaded',
  manual_evidence_expired: 'the uploaded evidence expired',
  insufficient_data: "there wasn't enough activity to tell",
  probe_error: "the check couldn't run",
};

export interface RemediationSettings {
  compliance_project_id: string | null;
  remediation_tasks: 'create' | 'propose';
  timezone: string;
}

export async function remediationSettings(tx: Tx, orgId: string): Promise<RemediationSettings> {
  const s = (await tx`SELECT compliance_project_id, remediation_tasks, timezone FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  return {
    compliance_project_id: (s?.compliance_project_id as string | null) ?? null,
    remediation_tasks: s?.remediation_tasks === 'propose' ? 'propose' : 'create',
    timezone: String(s?.timezone ?? 'UTC'),
  };
}

/** The drift row's task_status (spec 2.5): no project, propose mode, or a pending upsert. */
export function driftTaskStatus(s: RemediationSettings): 'pending' | 'no_project' | 'proposed' {
  if (!s.compliance_project_id) return 'no_project';
  return s.remediation_tasks === 'propose' ? 'proposed' : 'pending';
}

export function localDate(now: Date, timeZone: string): string {
  return localClock(now, timeZone).date;
}

/** Enqueue the task upsert for a drift row whose task_status is `pending`. */
export async function enqueueDriftTask(
  tx: Tx,
  orgId: string,
  s: RemediationSettings,
  args: { control_id: string; drift_id: string; now: Date; reopen_comment: string; idempotency_base: string },
): Promise<boolean> {
  if (!s.compliance_project_id || s.remediation_tasks !== 'create') return false;
  const c = (await tx`SELECT title, owner_user_id, plain_summary FROM bastion_controls WHERE organization_id = ${orgId} AND id = ${args.control_id}`)[0];
  if (!c) return false;
  const description =
    `Bastion found that this control is not being met: ${String(c.title)}.\n\n` +
    (c.plain_summary ? `${String(c.plain_summary)}\n\n` : '') +
    `Open it in Bastion: /bastion/controls/${args.control_id}`;
  return enqueueOutbox(tx, {
    orgId,
    kind: 'bam_task_upsert',
    orderingKey: `control:${args.control_id}`,
    idempotencyKey: `${args.idempotency_base}:bam_task_upsert`,
    payload: {
      drift_id: args.drift_id,
      request: {
        org_id: orgId,
        project_id: s.compliance_project_id,
        control_id: args.control_id,
        external_id: bastionControlTaskExternalId(args.control_id),
        title: `Fix: ${String(c.title)}`.slice(0, 500),
        description,
        assignee_id: (c.owner_user_id as string | null) ?? null,
        comment: args.reopen_comment,
        idempotency_key: `${args.idempotency_base}:bam_task_upsert`,
      },
    },
  });
}

/** Enqueue a comment on the control's task (no-op without a Compliance project). */
export async function enqueueTaskComment(
  tx: Tx,
  orgId: string,
  s: RemediationSettings,
  args: { control_id: string; body: string; idempotency_key: string },
): Promise<boolean> {
  if (!s.compliance_project_id) return false;
  return enqueueOutbox(tx, {
    orgId,
    kind: 'bam_task_comment',
    orderingKey: `control:${args.control_id}`,
    idempotencyKey: args.idempotency_key,
    payload: {
      request: {
        org_id: orgId,
        project_id: s.compliance_project_id,
        external_id: bastionControlTaskExternalId(args.control_id),
        body: args.body,
        idempotency_key: args.idempotency_key,
      },
    },
  });
}

/** Enqueue the close of a mirrored proposal (spec 2.8), delivered after the decision commits. */
export async function enqueueProposalClose(
  tx: Tx,
  orgId: string,
  args: { proposal_id: string; decision: 'approved' | 'rejected'; decided_by: string; reason: string | null; ordering_key: string },
): Promise<boolean> {
  return enqueueOutbox(tx, {
    orgId,
    kind: 'proposal_close',
    orderingKey: args.ordering_key,
    idempotencyKey: `proposal_close:${args.proposal_id}`,
    payload: {
      proposal_id: args.proposal_id,
      request: { org_id: orgId, decision: args.decision, decided_by: args.decided_by, decided_auth_method: 'session', reason: args.reason },
    },
  });
}
