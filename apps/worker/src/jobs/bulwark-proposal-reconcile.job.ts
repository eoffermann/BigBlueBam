/**
 * Bulwark proposal reconcile (Bulwark spec §4.5, modeled on braid-proposal-reconcile). Cron
 * every 10 min.
 *
 * At-least-once backstop for the proposal.decided -> send bridge: Bolt is fire-and-forget, so a
 * lost delivery would leave an approved/rejected notice/chase proposal whose send never ran. For
 * each agent_proposals row with proposed_action IN ('bulwark.send_notice','bulwark.chase_compliance_doc')
 * whose status is decided:
 *   - approved / rejected -> drive it through the SAME bulwark-api internal route the Bolt
 *     subscription uses (POST /v1/internal/proposal-decided), which re-SELECTs the authoritative
 *     status, re-derives the decider, fail-closes on the §15 kill-switch + send permission, and
 *     drives the CAS-guarded send executor. Idempotent, so a duplicate delivery no-ops.
 *   - expired -> clear the draft's proposal ref and reset its status to none so the radar
 *     re-drafts. An unmet notice re-surfaces, never orphans.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BulwarkSweepJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { bulwarkInternalUrl } from './bulwark-shared.js';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface PendingRow {
  proposal_id: string;
  org_id: string;
  status: 'approved' | 'rejected' | 'expired';
  approver_id: string | null;
  actor_id: string;
  proposed_action: string;
  draft_id: string | null;
}

async function driveDecision(row: PendingRow, logger: Logger): Promise<boolean> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    logger.warn({ proposal_id: row.proposal_id }, 'bulwark-proposal-reconcile: no INTERNAL_SERVICE_SECRET');
    return false;
  }
  const decision = row.status === 'approved' ? 'approve' : 'reject';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10000));
  try {
    const res = await fetch(`${bulwarkInternalUrl()}/v1/internal/proposal-decided`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({
        event_type: 'proposal.decided',
        actor_id: row.approver_id ?? row.actor_id,
        actor_type: 'system',
        org_id: row.org_id,
        payload: {
          proposal: {
            id: row.proposal_id,
            proposed_action: row.proposed_action,
            decision,
            approver_id: row.approver_id,
            actor_id: row.actor_id,
          },
          org: { id: row.org_id },
        },
      }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err, proposal_id: row.proposal_id }, 'bulwark-proposal-reconcile: route call failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function processBulwarkProposalReconcileJob(
  job: Job<BulwarkSweepJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const started = Date.now();
  const scopeOrg = job.data?.organization_id;

  const pending = rows<PendingRow>(
    await db.execute(sql`
      SELECT p.id AS proposal_id, p.org_id, p.status, p.approver_id, p.actor_id,
             p.proposed_action, p.proposed_payload->>'bulwark_draft_id' AS draft_id
        FROM agent_proposals p
       WHERE p.proposed_action IN ('bulwark.send_notice', 'bulwark.chase_compliance_doc')
         AND p.status IN ('approved', 'rejected', 'expired')
         ${scopeOrg ? sql`AND p.org_id = ${scopeOrg}` : sql``}
       ORDER BY p.updated_at DESC
       LIMIT 500
    `),
  );

  if (pending.length === 0) {
    logger.info({ jobId: job.id }, 'bulwark-proposal-reconcile: nothing to reconcile');
    return;
  }
  logger.info({ jobId: job.id, count: pending.length }, 'bulwark-proposal-reconcile: reconciling');

  let driven = 0;
  let expiredCleared = 0;
  let errors = 0;

  for (const row of pending) {
    try {
      if (row.status === 'expired') {
        if (row.draft_id) {
          // Reset the notice draft (or chase) so the radar re-drafts. Idempotent by column value.
          await db.execute(sql`
            UPDATE bulwark_notice_deadlines
               SET notice_status = 'none', notice_proposal_id = NULL, updated_at = now()
             WHERE id = ${row.draft_id} AND notice_proposal_id = ${row.proposal_id}
          `);
          await db.execute(sql`
            UPDATE bulwark_compliance_docs
               SET chase_status = 'none', chase_proposal_id = NULL, updated_at = now()
             WHERE id = ${row.draft_id} AND chase_proposal_id = ${row.proposal_id}
          `);
        }
        expiredCleared += 1;
        continue;
      }
      const ok = await driveDecision(row, logger);
      if (ok) driven += 1;
      else errors += 1;
    } catch (err) {
      errors += 1;
      logger.error({ err, proposal_id: row.proposal_id }, 'bulwark-proposal-reconcile: row failed');
    }
  }

  logger.info(
    { jobId: job.id, driven, expiredCleared, errors, elapsedMs: Date.now() - started },
    'bulwark-proposal-reconcile: done',
  );
}
