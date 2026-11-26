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

import { BAM_OPEN_PHASE_SQL, bastionControlTaskExternalId } from '@bigbluebam/shared';
import { type EngineDeps, localClock, orgTx, type Tx } from './context.js';
import { enqueueOutbox, PROJECT_UNAVAILABLE_CODES } from './outbox.js';

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

// ── The Compliance project's health (#229) ─────────────────────────────────────────────────
//
// The project id in bastion_org_settings has no foreign key into Bam, so the project can be
// deleted (or left with no open phase) under Bastion. The api then refuses every task upsert with
// PROJECT_NOT_FOUND or CONFIGURATION_ERROR (apps/api bastion-internal.service.ts loadProject and
// startPhase). This is the one place Bastion asks the same two questions the api asks: Setup
// (setup.service.ts setComplianceProject), the Readiness banner and the re-drive gate all call it.
// "Open phase" is BAM_OPEN_PHASE_SQL from @bigbluebam/shared, the predicate the api's startPhase
// reads too (#253), so the two cannot drift.

export type ComplianceProjectHealth = 'not_set' | 'ok' | 'missing' | 'no_open_phase';

export async function complianceProjectHealth(tx: Tx, orgId: string, projectId: string | null): Promise<ComplianceProjectHealth> {
  if (!projectId) return 'not_set';
  const r = (await tx`
    SELECT EXISTS (SELECT 1 FROM projects WHERE id = ${projectId} AND org_id = ${orgId}) AS present,
           EXISTS (SELECT 1 FROM phases WHERE project_id = ${projectId} AND ${tx.unsafe(BAM_OPEN_PHASE_SQL)}) AS open_phase`)[0];
  if (!r?.present) return 'missing';
  if (!r.open_phase) return 'no_open_phase';
  return 'ok';
}

/** Plain words for the Readiness banner (spec 6.1), or null when tasks can be filed. */
export function complianceProjectProblem(health: ComplianceProjectHealth): string | null {
  if (health === 'missing') {
    return "Bastion can't file tasks: the Compliance project was deleted. Pick a Compliance project in Setup, and the waiting tasks will be filed.";
  }
  if (health === 'no_open_phase') {
    return "Bastion can't file tasks: the Compliance project has no open phase to put them in. Add one in Bam, and the waiting tasks will be filed.";
  }
  return null;
}

/**
 * Re-drive the Bam deliveries that died because the Compliance project could not take them, once
 * it can (#229): the dead task upserts and comments go back to pending, addressed to the current
 * project, and their drift rows go back from project_unavailable to pending. A no-op unless the
 * project is healthy. Returns the number of outbox rows re-driven.
 */
export async function redriveProjectDeliveries(tx: Tx, orgId: string): Promise<number> {
  const s = await remediationSettings(tx, orgId);
  if ((await complianceProjectHealth(tx, orgId, s.compliance_project_id)) !== 'ok') return 0;
  const rows = await tx`
    UPDATE bastion_outbox
       SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL,
           claimed_by = NULL, heartbeat_at = NULL, redrive_count = redrive_count + 1,
           payload = jsonb_set(payload, '{request,project_id}', to_jsonb(${s.compliance_project_id}::text))
     WHERE organization_id = ${orgId} AND status = 'dead'
       AND kind IN ('bam_task_upsert', 'bam_task_comment')
       AND last_error LIKE ANY (${PROJECT_UNAVAILABLE_CODES.map((c) => `%${c}%`)}::text[])
    RETURNING id`;
  await tx`UPDATE bastion_drift_events SET task_status = 'pending'
            WHERE organization_id = ${orgId} AND task_status = 'project_unavailable'`;
  return rows.length;
}

/**
 * Every org with deliveries waiting on a broken Compliance project, re-driven if it is fixed now.
 * Runs before each outbox drain, so fixing the project in Bam (adding an open phase) is enough;
 * picking a new project in Setup re-drives at once (setup.routes.ts).
 */
export async function redriveRecoveredProjects(deps: EngineDeps, opts: { organization_id?: string } = {}): Promise<number> {
  const patterns = PROJECT_UNAVAILABLE_CODES.map((c) => `%${c}%`);
  const orgs = await deps.sql`
    SELECT organization_id FROM bastion_drift_events
     WHERE task_status = 'project_unavailable' ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
    UNION
    SELECT organization_id FROM bastion_outbox
     WHERE status = 'dead' AND kind IN ('bam_task_upsert', 'bam_task_comment') AND last_error LIKE ANY (${patterns}::text[])
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}`;
  let total = 0;
  for (const o of orgs) {
    const orgId = String(o.organization_id);
    const n = await orgTx(deps.sql, orgId, (tx) => redriveProjectDeliveries(tx, orgId));
    if (n > 0) deps.log.info({ organization_id: orgId, redriven: n }, 'bastion-outbox: the Compliance project can take tasks again; re-driving its waiting deliveries');
    total += n;
  }
  return total;
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
  const summary = c.plain_summary ? `${String(c.plain_summary)}\n\n` : '';
  const description = `Bastion found that this control is not being met: ${String(c.title)}.\n\n${summary}Open it in Bastion: /bastion/controls/${args.control_id}`;
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
