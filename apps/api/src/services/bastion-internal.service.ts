// Bastion's three api-owned internal routes (APP_DESIGN_bastion.md 2.5, 2.8, 8.4). bastion-api
// never writes Bam tables; its outbox delivers here.
//
//   upsertBastionTask     one task per control, keyed by external_id `bastion:control:<id>`.
//                         Created in the project's start phase; a task sitting in a terminal phase
//                         is moved back to the start phase ("Drifted again on {date}"); an open
//                         task gets the comment as an update.
//   commentOnBastionTask  a comment addressed by external_id (never a task id from an earlier
//                         delivery), so it does not depend on that delivery's result.
//   closeBastionProposal  closes an owning_app = 'bastion' proposal for a human member of its org
//                         who decided with a session; records the decider (#128 columns).
//
// Every comment is deduplicated on its idempotency key (recorded in the activity_log row's
// details, under a transaction-scoped advisory lock), so an outbox retry after a lost response
// never posts it twice. Every write is attributed to the Bastion System service user.
//
// The functions take the database as a parameter so test/bastion-internal.db.test.ts can drive
// them against a real Postgres.

import { sql } from 'drizzle-orm';
import type {
  BastionBamTaskComment,
  BastionBamTaskCommentResult,
  BastionBamTaskUpsert,
  BastionBamTaskUpsertResult,
  BastionProposalClose,
  BastionProposalCloseResult,
} from '@bigbluebam/shared';
import { db as defaultDb } from '../db/index.js';

/** Seeded by migration 0274 (kind = 'service'; braid b1 ... bursar b4, Bastion b5). */
export const BASTION_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b5';

export type BastionDb = Pick<typeof defaultDb, 'transaction'>;
type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

export class BastionInternalError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BastionInternalError';
  }
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The single row an INSERT/UPDATE ... RETURNING must produce. */
function only<T>(list: T[], what: string): T {
  const row = list[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

async function bindOrg(tx: Tx, orgId: string) {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
}

async function lockKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bastion_internal:${key}`}, 0))`);
}

interface ProjectRow {
  id: string;
  org_id: string;
}

async function loadProject(tx: Tx, orgId: string, projectId: string): Promise<ProjectRow> {
  const [p] = rows<ProjectRow>(await tx.execute(sql`SELECT id, org_id FROM projects WHERE id = ${projectId} AND org_id = ${orgId} LIMIT 1`));
  if (!p) throw new BastionInternalError(404, 'PROJECT_NOT_FOUND', 'The Compliance project was not found in this organization');
  return p;
}

/** The phase a task opens (or reopens) in: the start phase, else the first non-terminal phase. */
async function startPhase(tx: Tx, projectId: string): Promise<{ id: string; auto_state_on_enter: string | null }> {
  const [ph] = rows<{ id: string; auto_state_on_enter: string | null }>(
    await tx.execute(sql`
      SELECT id, auto_state_on_enter FROM phases
       WHERE project_id = ${projectId} AND (is_start OR NOT is_terminal)
       ORDER BY is_start DESC, position ASC LIMIT 1`),
  );
  if (!ph) throw new BastionInternalError(422, 'CONFIGURATION_ERROR', 'The Compliance project has no open phase to put the task in');
  return ph;
}

interface TaskRow {
  id: string;
  human_id: string;
  project_id: string;
  phase_id: string | null;
  is_terminal: boolean | null;
}

async function findTask(tx: Tx, projectId: string, externalId: string): Promise<TaskRow | null> {
  const [t] = rows<TaskRow>(
    await tx.execute(sql`
      SELECT t.id, t.human_id, t.project_id, t.phase_id, ph.is_terminal
        FROM tasks t LEFT JOIN phases ph ON ph.id = t.phase_id
       WHERE t.project_id = ${projectId} AND t.external_id = ${externalId}
       LIMIT 1`),
  );
  return t ?? null;
}

async function activity(tx: Tx, projectId: string, taskId: string, action: string, details: Record<string, unknown>) {
  await tx.execute(sql`
    INSERT INTO activity_log (project_id, task_id, actor_id, actor_type, action, details)
    VALUES (${projectId}, ${taskId}, ${BASTION_SYSTEM_USER_ID}, 'service', ${action},
            ${JSON.stringify({ caller: 'bastion-api', ...details })}::jsonb)`);
}

/** Post a comment once per idempotency key. The caller holds the advisory lock on the key. */
async function postCommentOnce(tx: Tx, task: { id: string; project_id: string }, body: string, idempotencyKey: string) {
  const [dup] = rows<{ comment_id: string | null }>(
    await tx.execute(sql`
      SELECT details->>'comment_id' AS comment_id FROM activity_log
       WHERE task_id = ${task.id} AND action = 'comment.created_from_bastion'
         AND details->>'idempotency_key' = ${idempotencyKey}
       LIMIT 1`),
  );
  if (dup) return { comment_id: dup.comment_id, posted: false };
  const c = only(
    rows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO comments (task_id, author_id, body, body_plain, is_system)
        VALUES (${task.id}, ${BASTION_SYSTEM_USER_ID}, ${body}, ${body}, true)
        RETURNING id`),
    ),
    'comment insert',
  );
  await tx.execute(sql`UPDATE tasks SET comment_count = comment_count + 1, updated_at = now() WHERE id = ${task.id}`);
  await activity(tx, task.project_id, task.id, 'comment.created_from_bastion', { comment_id: c.id, idempotency_key: idempotencyKey });
  return { comment_id: c.id, posted: true };
}

async function memberOrNull(tx: Tx, orgId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [m] = rows<{ user_id: string }>(
    await tx.execute(sql`SELECT user_id FROM organization_memberships WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1`),
  );
  return m ? m.user_id : null;
}

export async function upsertBastionTask(input: BastionBamTaskUpsert, database: BastionDb = defaultDb): Promise<BastionBamTaskUpsertResult> {
  return database.transaction(async (tx) => {
    await bindOrg(tx, input.org_id);
    await lockKey(tx, input.external_id);
    const project = await loadProject(tx, input.org_id, input.project_id);
    const existing = await findTask(tx, project.id, input.external_id);

    if (!existing) {
      const phase = await startPhase(tx, project.id);
      const seq = only(
        rows<{ task_id_prefix: string; task_id_sequence: number }>(
          await tx.execute(sql`
            UPDATE projects SET task_id_sequence = task_id_sequence + 1 WHERE id = ${project.id}
            RETURNING task_id_prefix, task_id_sequence`),
        ),
        'task id sequence',
      );
      const humanId = `${seq.task_id_prefix}-${seq.task_id_sequence}`;
      const assignee = await memberOrNull(tx, input.org_id, input.assignee_id);
      const t = only(rows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO tasks (project_id, org_id, human_id, external_id, title, description, description_plain,
                             phase_id, state_id, assignee_id, reporter_id, priority, custom_fields, position)
          VALUES (${project.id}, ${input.org_id}, ${humanId}, ${input.external_id}, ${input.title},
                  ${input.description ?? null}, ${input.description ?? null}, ${phase.id}, ${phase.auto_state_on_enter},
                  ${assignee}, ${BASTION_SYSTEM_USER_ID}, 'high',
                  ${JSON.stringify({ bastion_control_id: input.control_id })}::jsonb,
                  (SELECT coalesce(max(position), 0) + 1024 FROM tasks WHERE phase_id = ${phase.id}))
          RETURNING id`),
      ), 'task insert');
      await activity(tx, project.id, t.id, 'task.created_from_bastion', { control_id: input.control_id, idempotency_key: input.idempotency_key });
      // spec 8.3: bastion.control -> bam.task, in the transaction that creates the task.
      await tx.execute(sql`
        INSERT INTO entity_links (org_id, src_type, src_id, dst_type, dst_id, link_kind, created_by)
        VALUES (${input.org_id}, 'bastion.control', ${input.control_id}, 'bam.task', ${t.id}, 'related_to', ${BASTION_SYSTEM_USER_ID})
        ON CONFLICT DO NOTHING`);
      return { task_id: t.id, human_id: humanId, outcome: 'created', comment_posted: false };
    }

    let outcome: BastionBamTaskUpsertResult['outcome'] = 'updated';
    if (existing.is_terminal) {
      const phase = await startPhase(tx, project.id);
      await tx.execute(sql`
        UPDATE tasks SET phase_id = ${phase.id}, state_id = ${phase.auto_state_on_enter}, completed_at = NULL, updated_at = now()
         WHERE id = ${existing.id}`);
      await activity(tx, project.id, existing.id, 'task.reopened_from_bastion', {
        from_phase_id: existing.phase_id,
        to_phase_id: phase.id,
        idempotency_key: input.idempotency_key,
      });
      outcome = 'reopened';
    }
    let posted = false;
    if (input.comment) {
      await lockKey(tx, `comment:${input.idempotency_key}`);
      posted = (await postCommentOnce(tx, existing, input.comment, input.idempotency_key)).posted;
    }
    return { task_id: existing.id, human_id: existing.human_id, outcome, comment_posted: posted };
  });
}

export async function commentOnBastionTask(input: BastionBamTaskComment, database: BastionDb = defaultDb): Promise<BastionBamTaskCommentResult> {
  return database.transaction(async (tx) => {
    await bindOrg(tx, input.org_id);
    const project = await loadProject(tx, input.org_id, input.project_id);
    await lockKey(tx, `comment:${input.idempotency_key}`);
    const task = await findTask(tx, project.id, input.external_id);
    if (!task) return { task_id: null, comment_id: null, outcome: 'no_task' };
    const r = await postCommentOnce(tx, task, input.body, input.idempotency_key);
    return { task_id: task.id, comment_id: r.comment_id, outcome: r.posted ? 'posted' : 'duplicate' };
  });
}

interface ProposalRow {
  id: string;
  org_id: string;
  owning_app: string | null;
  status: string;
  proposed_action: string;
  approver_id: string | null;
  actor_id: string;
  decided_by: string | null;
  decision_reason: string | null;
}

export interface ClosedProposal {
  result: BastionProposalCloseResult;
  /** The proposal.decided payload to publish after commit; null when it was already closed. */
  event: Record<string, unknown> | null;
}

export async function closeBastionProposal(proposalId: string, input: BastionProposalClose, database: BastionDb = defaultDb): Promise<ClosedProposal> {
  return database.transaction(async (tx) => {
    await bindOrg(tx, input.org_id);
    const [p] = rows<ProposalRow>(
      await tx.execute(sql`
        SELECT id, org_id, owning_app, status, proposed_action, approver_id, actor_id, decided_by, decision_reason
          FROM agent_proposals WHERE id = ${proposalId} FOR UPDATE`),
    );
    if (!p || p.org_id !== input.org_id) throw new BastionInternalError(404, 'NOT_FOUND', 'Proposal not found');
    if (p.owning_app !== 'bastion') {
      throw new BastionInternalError(409, 'NOT_A_BASTION_PROPOSAL', 'Only proposals owned by Bastion can be closed through this route');
    }
    const [decider] = rows<{ kind: string; is_active: boolean }>(
      await tx.execute(sql`
        SELECT u.kind, u.is_active FROM users u
          JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${input.org_id}
         WHERE u.id = ${input.decided_by} LIMIT 1`),
    );
    if (!decider) throw new BastionInternalError(403, 'DECIDER_NOT_MEMBER', 'The decider is not a member of this organization');
    if (decider.kind !== 'human' || !decider.is_active) {
      throw new BastionInternalError(403, 'HUMAN_DECIDER_REQUIRED', 'Only an active human member may decide a Bastion proposal');
    }
    if (p.status !== 'pending' && p.status !== 'revising') {
      if (p.status === input.decision && p.decided_by === input.decided_by) {
        return { result: { proposal_id: p.id, status: p.status, already_closed: true }, event: null };
      }
      throw new BastionInternalError(409, 'PROPOSAL_ALREADY_DECIDED', `Proposal is in status '${p.status}' and cannot be closed again`);
    }
    const [u] = rows<{ decided_at: string }>(
      await tx.execute(sql`
        UPDATE agent_proposals
           SET status = ${input.decision}::proposal_status, decided_at = now(), decision_reason = ${input.reason ?? null},
               decided_by = ${input.decided_by}, decided_by_kind = 'human', decided_impersonator_id = NULL,
               decided_auth_method = ${input.decided_auth_method}, updated_at = now()
         WHERE id = ${p.id} AND status IN ('pending', 'revising')
        RETURNING decided_at`),
    );
    if (!u) throw new BastionInternalError(409, 'PROPOSAL_ALREADY_DECIDED', 'Proposal was decided by someone else first');
    return {
      result: { proposal_id: p.id, status: input.decision, already_closed: false },
      event: {
        proposal: {
          id: p.id,
          proposed_action: p.proposed_action,
          decision: input.decision === 'approved' ? 'approve' : 'reject',
          decision_reason: input.reason ?? null,
          approver_id: p.approver_id,
          actor_id: p.actor_id,
          decided_at: new Date(u.decided_at).toISOString(),
          decided_by: input.decided_by,
          decided_by_kind: 'human',
          decided_impersonator_id: null,
          decided_auth_method: input.decided_auth_method,
          owning_app: 'bastion',
        },
        org: { id: input.org_id },
      },
    };
  });
}
