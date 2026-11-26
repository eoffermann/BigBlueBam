// Shared plumbing for the things humans decide in Bastion (spec 2.4, 2.6, 2.8): the mirrored
// agent_proposals row, the approver choice, the human-decider check, and the
// bastion-proposal-reconcile engine.
//
// Every Bastion proposal is filed with owning_app = 'bastion' and require_human_decider = true,
// so the platform's generic decide route answers 409 DECIDE_IN_APP; Bastion decides in its own
// routes and closes the mirror through the api's internal route (an outbox row).
//
// The reconcile engine re-reads agent_proposals every run (it never relies on inbox rows, which
// are pruned after 30 days): a proposal that expired expires its draft or exception; a proposal
// decided OUTSIDE Bastion while the Bastion row is still waiting is flagged decision_rejected (a
// fix) or rejected (an exception) and reported as a worker error.

import { BASTION_SMALL_TEAM_HUMANS } from '@bigbluebam/shared';
import { ForbiddenError } from '../lib/errors.js';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { accessTypeOf } from '../lib/ref-labels.js';
import type { Viewer } from './types.js';

/** Seeded by migration 0274 (the Bastion System service user). */
export const BASTION_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b5';

/** can_access through the api (fail closed); injected so tests can fake it. */
export type CanAccess = (askerUserId: string, entityType: string, entityId: string) => Promise<boolean>;

export interface DecisionDeps {
  engine: EngineDeps;
  canAccess: CanAccess;
}

/**
 * Whether a cited ref may be shown to this person (spec 2.4: citations pass can_access at write
 * and at read). Every ref goes through can_access, including the probe refs to platform rows
 * (`github_pr_event`, `api_key`, `user`), which map onto bam.* visibility types (#227): owning a
 * control does not widen what its owner may see. A ref with no visibility type is refused.
 */
export async function citationVisible(canAccess: CanAccess, viewer: Viewer, ref: { entity_type: string; entity_id: string }): Promise<boolean> {
  const type = accessTypeOf(ref.entity_type);
  if (!type) return false;
  return canAccess(viewer.id, type, ref.entity_id).catch(() => false);
}

/** The refs this person may see, in order (one can_access per distinct ref). */
export async function visibleRefs<T extends { entity_type: string; entity_id: string }>(canAccess: CanAccess, viewer: Viewer, refs: T[]): Promise<T[]> {
  const verdicts = new Map<string, boolean>();
  const out: T[] = [];
  for (const r of refs) {
    const key = `${r.entity_type}:${r.entity_id}`;
    let ok = verdicts.get(key);
    if (ok === undefined) {
      ok = await citationVisible(canAccess, viewer, r);
      verdicts.set(key, ok);
    }
    if (ok) out.push(r);
  }
  return out;
}

export async function activeHumanCount(tx: Tx, orgId: string): Promise<number> {
  const r = await tx`
    SELECT count(DISTINCT u.id)::int AS n
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ${orgId} AND u.kind = 'human' AND u.is_active`;
  return Number(r[0]?.n ?? 0);
}

export function isSmallTeam(humans: number, threshold = BASTION_SMALL_TEAM_HUMANS): boolean {
  return humans < threshold;
}

/** The caller decides only as an active human (spec 2.8). The route already required a session. */
export async function assertHumanDecider(tx: Tx, viewer: Viewer): Promise<void> {
  const u = (await tx`SELECT kind, is_active FROM users WHERE id = ${viewer.id}`)[0];
  if (!u || u.kind !== 'human' || !u.is_active) {
    throw new ForbiddenError('Only a person can decide this, signed in to Bastion.', 'HUMAN_DECIDER_REQUIRED');
  }
  if (viewer.impersonator_id) throw new ForbiddenError('You cannot decide this while acting as someone else.', 'IMPERSONATION_NOT_ALLOWED');
  if (viewer.auth_method !== 'session') throw new ForbiddenError('Deciding needs a signed-in session, not an API key.', 'SESSION_REQUIRED');
}

/** An org owner or admin, oldest first (the approver fallback when a control has no owner). */
export async function anOrgAdmin(tx: Tx, orgId: string, exclude: string | null = null): Promise<string | null> {
  const r = await tx`
    SELECT u.id FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
     WHERE u.kind = 'human' AND u.is_active
       AND (${exclude}::uuid IS NULL OR u.id <> ${exclude}::uuid)
       AND EXISTS (SELECT 1 FROM account_group_memberships agm JOIN permission_groups pg ON pg.id = agm.group_id
                    WHERE agm.user_id = u.id AND agm.scope_type = 'org' AND agm.scope_id = ${orgId}
                      AND agm.detached_at IS NULL AND pg.deleted_at IS NULL AND pg.legacy_role IN ('owner', 'admin'))
     ORDER BY m.joined_at NULLS LAST, u.created_at
     LIMIT 1`;
  return r[0] ? String(r[0].id) : null;
}

export interface MirroredProposal {
  action: string;
  subject_type: string;
  subject_id: string;
  approver_id: string | null;
  payload: Record<string, unknown>;
  expires_at: Date;
}

/** File the platform mirror of a Bastion decision (spec 2.4). The actor is the person or agent asking. */
export async function fileMirroredProposal(tx: Tx, viewer: Viewer, p: MirroredProposal): Promise<string> {
  const kind = String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
  const r = await tx`
    INSERT INTO agent_proposals (org_id, actor_id, proposer_kind, proposed_action, proposed_payload, subject_type, subject_id,
                                 approver_id, status, expires_at, owning_app, require_human_decider)
    VALUES (${viewer.org_id}, ${viewer.id}, ${kind}::actor_type, ${p.action}, ${tx.json(p.payload as never)}, ${p.subject_type},
            ${p.subject_id}, ${p.approver_id}, 'pending', ${p.expires_at}, 'bastion', true)
    RETURNING id`;
  const row = r[0];
  if (!row) throw new Error('agent_proposals insert returned no row');
  return String(row.id);
}

// ── bastion-proposal-reconcile (spec 7) ────────────────────────────────────────────────

export interface ReconcileSummary {
  orgs: number;
  fixes_expired: number;
  fixes_decision_rejected: number;
  exceptions_expired: number;
  exceptions_decision_rejected: number;
  inbox_marked_done: number;
}

export async function proposalReconcile(deps: EngineDeps, opts: { organization_id?: string } = {}): Promise<ReconcileSummary> {
  const now = deps.now();
  const orgs = (
    await deps.sql`
      SELECT DISTINCT organization_id FROM (
        SELECT organization_id FROM bastion_fix_drafts WHERE status = 'proposed' AND proposal_id IS NOT NULL
        UNION SELECT organization_id FROM bastion_exceptions WHERE status = 'proposed' AND proposal_id IS NOT NULL
        UNION SELECT organization_id FROM bastion_ingest_events WHERE status = 'pending' AND source = 'platform' AND event_type = 'proposal.decided'
      ) o ${opts.organization_id ? deps.sql`WHERE organization_id = ${opts.organization_id}` : deps.sql``}`
  ).map((r) => String(r.organization_id));
  deps.log.info({ orgs: orgs.length }, `bastion-proposal-reconcile: checking ${orgs.length} org(s) with waiting decisions`);
  const s: ReconcileSummary = { orgs: orgs.length, fixes_expired: 0, fixes_decision_rejected: 0, exceptions_expired: 0, exceptions_decision_rejected: 0, inbox_marked_done: 0 };

  for (const orgId of orgs) {
    const r = await orgTx(deps.sql, orgId, async (tx) => {
      const out = { fe: 0, fr: 0, ee: 0, er: 0, inbox: 0 };
      const fixes = await tx`
        SELECT d.id, d.gap_id, p.status AS p_status, p.expires_at AS p_expires, p.decided_by
          FROM bastion_fix_drafts d JOIN agent_proposals p ON p.id = d.proposal_id
         WHERE d.organization_id = ${orgId} AND d.status = 'proposed'
         FOR UPDATE OF d`;
      for (const f of fixes) {
        const expired = f.p_status === 'expired' || ((f.p_status === 'pending' || f.p_status === 'revising') && new Date(f.p_expires as string) <= now);
        if (expired) {
          await tx`UPDATE bastion_fix_drafts SET status = 'expired' WHERE id = ${f.id as string} AND status = 'proposed'`;
          if (f.gap_id) await tx`UPDATE bastion_gaps SET status = 'open' WHERE id = ${f.gap_id as string} AND status = 'proposed'`;
          await tx`UPDATE agent_proposals SET status = 'expired', updated_at = now() WHERE id = (SELECT proposal_id FROM bastion_fix_drafts WHERE id = ${f.id as string}) AND status IN ('pending', 'revising')`;
          out.fe += 1;
        } else if (f.p_status !== 'pending' && f.p_status !== 'revising') {
          await tx`UPDATE bastion_fix_drafts SET status = 'decision_rejected' WHERE id = ${f.id as string} AND status = 'proposed'`;
          if (f.gap_id) await tx`UPDATE bastion_gaps SET status = 'open' WHERE id = ${f.gap_id as string} AND status = 'proposed'`;
          await tx`INSERT INTO bastion_audit_log (organization_id, actor_id, actor_kind, action, subject_type, subject_id, details)
                   VALUES (${orgId}, ${BASTION_SYSTEM_USER_ID}, 'service', 'fix.decision_rejected', 'fix_draft', ${f.id as string},
                           ${tx.json({ proposal_status: f.p_status, decided_by: f.decided_by ?? null } as never)})`;
          out.fr += 1;
        }
      }
      const exceptions = await tx`
        SELECT e.id, p.status AS p_status, p.expires_at AS p_expires, p.decided_by
          FROM bastion_exceptions e JOIN agent_proposals p ON p.id = e.proposal_id
         WHERE e.organization_id = ${orgId} AND e.status = 'proposed'
         FOR UPDATE OF e`;
      for (const e of exceptions) {
        const expired = e.p_status === 'expired' || ((e.p_status === 'pending' || e.p_status === 'revising') && new Date(e.p_expires as string) <= now);
        if (expired) {
          await tx`UPDATE bastion_exceptions SET status = 'expired' WHERE id = ${e.id as string} AND status = 'proposed'`;
          await tx`UPDATE agent_proposals SET status = 'expired', updated_at = now() WHERE id = (SELECT proposal_id FROM bastion_exceptions WHERE id = ${e.id as string}) AND status IN ('pending', 'revising')`;
          out.ee += 1;
        } else if (e.p_status !== 'pending' && e.p_status !== 'revising') {
          await tx`UPDATE bastion_exceptions SET status = 'rejected' WHERE id = ${e.id as string} AND status = 'proposed'`;
          await tx`INSERT INTO bastion_audit_log (organization_id, actor_id, actor_kind, action, subject_type, subject_id, details)
                   VALUES (${orgId}, ${BASTION_SYSTEM_USER_ID}, 'service', 'exception.decision_rejected', 'exception', ${e.id as string},
                           ${tx.json({ proposal_status: e.p_status, decided_by: e.decided_by ?? null } as never)})`;
          out.er += 1;
        }
      }
      // The proposal rows are the source of truth; the inbox copies have been read by now.
      const done = await tx`
        UPDATE bastion_ingest_events SET status = 'done', updated_at = now()
         WHERE organization_id = ${orgId} AND status = 'pending' AND source = 'platform' AND event_type = 'proposal.decided'
        RETURNING id`;
      out.inbox = done.length;
      return out;
    });
    s.fixes_expired += r.fe;
    s.fixes_decision_rejected += r.fr;
    s.exceptions_expired += r.ee;
    s.exceptions_decision_rejected += r.er;
    s.inbox_marked_done += r.inbox;
    if (r.fr + r.er > 0) {
      deps.log.error(
        { organization_id: orgId, fixes: r.fr, exceptions: r.er },
        'bastion-proposal-reconcile: a Bastion proposal was decided outside Bastion; Bastion ignored that decision (decision_rejected)',
      );
    }
  }
  deps.log.info(s, 'bastion-proposal-reconcile: complete');
  return s;
}
