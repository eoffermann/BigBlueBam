/**
 * Braid proposal reconcile (Braid design spec §4.6, ST-r2-5 / D3-1/D3-3). Cron every 10 min.
 *
 * At-least-once backstop for the proposal.decided bridge: Bolt is fire-and-forget, so a lost
 * delivery would leave an approved/rejected proposal whose Braid candidate never executed.
 * For each agent_proposals row with proposed_action='braid.merge_profiles' whose linked
 * candidate is still pending:
 *   - approved -> drive it through the SAME braid-api internal route the Bolt subscription
 *     uses (POST /internal/proposal-decided), which re-derives the decider, re-checks the
 *     §15 braid.* kill-switch + braid.profile.merge, and CAS-merges. This keeps ALL merge
 *     logic in braid-api (one place), as the milestone brief prefers.
 *   - rejected -> same route, which writes the bridge-atom suppression.
 *   - expired -> clear the stale braid_match_candidates.proposal_id (the candidate stays
 *     pending in the Braid queue for a human to decide via REST).
 * mergeCandidate/rejectCandidate are CAS-idempotent, so a duplicate delivery no-ops.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BraidProposalReconcileJobData {
  organization_id?: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface PendingRow {
  proposal_id: string;
  candidate_id: string;
  org_id: string;
  status: 'approved' | 'rejected' | 'expired';
  approver_id: string | null;
  actor_id: string;
}

function braidInternalUrl(): string {
  return (process.env.BRAID_API_INTERNAL_URL ?? 'http://braid-api:4020').replace(/\/+$/, '');
}

async function driveDecision(row: PendingRow, logger: Logger): Promise<'merged' | 'rejected' | 'noop' | 'error'> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    logger.warn({ candidate_id: row.candidate_id }, 'braid-proposal-reconcile: no INTERNAL_SERVICE_SECRET; cannot drive decision');
    return 'error';
  }
  const decision = row.status === 'approved' ? 'approve' : 'reject';
  // Synthesize the proposal.decided envelope braid-api's handler expects. The route
  // re-SELECTs the authoritative proposal status and re-derives the decider (approver_id or
  // the proposer), then fail-closes on the policy + permission checks before any truth flip.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10000));
  try {
    // braid-api registers its routes under /v1, so the internal decision route
    // is /v1/internal/proposal-decided.
    const res = await fetch(`${braidInternalUrl()}/v1/internal/proposal-decided`, {
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
            proposed_action: 'braid.merge_profiles',
            decision,
            approver_id: row.approver_id,
            actor_id: row.actor_id,
          },
          org: { id: row.org_id },
        },
      }),
    });
    if (!res.ok) return 'error';
    const json = (await res.json()) as { data?: { status?: string } };
    const st = json.data?.status;
    if (st === 'merged') return 'merged';
    if (st === 'rejected') return 'rejected';
    return 'noop';
  } catch (err) {
    logger.warn({ err, candidate_id: row.candidate_id }, 'braid-proposal-reconcile: route call failed');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

export async function processBraidProposalReconcileJob(
  job: Job<BraidProposalReconcileJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const started = Date.now();
  const scopeOrg = job.data?.organization_id;

  const pending = rows<PendingRow>(
    await db.execute(sql`
      SELECT p.id AS proposal_id, c.id AS candidate_id, p.org_id, p.status,
             p.approver_id, p.actor_id
        FROM agent_proposals p
        JOIN braid_match_candidates c ON c.proposal_id = p.id
       WHERE p.proposed_action = 'braid.merge_profiles'
         AND c.status = 'pending'
         AND p.status IN ('approved', 'rejected', 'expired')
         ${scopeOrg ? sql`AND p.org_id = ${scopeOrg}` : sql``}
       LIMIT 500
    `),
  );

  if (pending.length === 0) {
    logger.info({ jobId: job.id }, 'braid-proposal-reconcile: nothing to reconcile');
    return;
  }
  logger.info({ jobId: job.id, count: pending.length }, 'braid-proposal-reconcile: reconciling');

  let merged = 0;
  let rejected = 0;
  let expiredCleared = 0;
  let errors = 0;

  for (const row of pending) {
    try {
      if (row.status === 'expired') {
        // Clear the stale pointer; the candidate stays pending for a human to decide.
        await db.execute(sql`
          UPDATE braid_match_candidates SET proposal_id = NULL
           WHERE id = ${row.candidate_id} AND status = 'pending'
        `);
        expiredCleared += 1;
        continue;
      }
      const outcome = await driveDecision(row, logger);
      if (outcome === 'merged') merged += 1;
      else if (outcome === 'rejected') rejected += 1;
      else if (outcome === 'error') errors += 1;
    } catch (err) {
      errors += 1;
      logger.error({ err, candidate_id: row.candidate_id }, 'braid-proposal-reconcile: row failed');
    }
  }

  logger.info(
    { jobId: job.id, merged, rejected, expiredCleared, errors, elapsedMs: Date.now() - started },
    'braid-proposal-reconcile: done',
  );
}
