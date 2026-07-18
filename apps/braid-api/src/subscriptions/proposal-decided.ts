import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { braidMatchCandidates, agentProposals } from '../db/schema/index.js';
import { mergeCandidate, rejectCandidate } from '../services/merge.service.js';
import { MergeConflictError } from '../lib/errors.js';
import { env } from '../env.js';
import type { ActorKind } from '../services/types.js';

// The proposal.decided subscription (spec 2.2 / 5.4).
//
// TRANSPORT NOTE (M6): Bolt is an ingest hub, not a fan-out bus. There is no Redis
// PubSub channel carrying Bolt events and no existing service-to-service event push
// (confirmed: neither basis-api nor bin-api consume any Bolt event; the only
// consumers are the worker via BullMQ and agent runners via outbound webhook). So
// the spec's documented fallback is used: this handler is invoked by the internal
// route POST /internal/proposal-decided (guarded by INTERNAL_SERVICE_SECRET), which
// bolt-api will call for matching proposal.decided events once the M6 dispatch is
// wired. The handler is idempotent (mergeCandidate/rejectCandidate are CAS-guarded),
// so at-least-once delivery is safe.

export interface ProposalDecidedEnvelope {
  event_type?: string;
  // The bolt actor is the DECIDER (the user who called proposal_decide). This is the
  // authoritative decider id; approver_id is NULL for braid proposals (spec 2.2).
  actor_id?: string;
  actor_type?: string; // 'user' | 'agent' | 'system'
  org_id?: string;
  payload: {
    proposal: {
      id: string;
      proposed_action: string;
      decision: 'approve' | 'reject' | 'request_revision';
      decision_reason?: string | null;
      approver_id?: string | null;
      actor_id?: string | null;
      decided_at?: string | null;
    };
    org?: { id?: string };
  };
}

export type ProposalDecidedResult =
  | { status: 'ignored'; reason: string }
  | { status: 'noop'; reason: string }
  | { status: 'merged'; candidate_id: string }
  | { status: 'rejected'; candidate_id: string };

function boltActorToKind(actorType: string | undefined): ActorKind {
  if (actorType === 'agent') return 'agent';
  if (actorType === 'system') return 'service';
  return 'human';
}

// Fail-closed check that the decider passes the §15 braid.* kill-switch/allowlist for
// braid_merge_profiles. Human deciders are bypassed server-side (register-tool.ts:205
// returns allowed:true for caller.kind==='human'), so this only bites agent/service
// deciders. Any non-2xx or transport error fails closed (spec S3-4).
async function deciderPassesPolicy(deciderId: string): Promise<boolean> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false;
  const url =
    `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/v1/agent-policies/` +
    `${encodeURIComponent(deciderId)}/check?tool=braid_merge_profiles`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { allowed?: boolean } };
    return json.data?.allowed === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Fail-closed assertion that the decider actually holds braid.profile.merge (spec
// S-r2-1). Uses the same internal resolver the http permissions plugin calls; only an
// explicit 'allow' proceeds (deny/unknown -> noop, leaving the candidate pending for
// the M6 reconcile sweep to retry).
async function deciderHoldsMerge(deciderId: string, orgId: string): Promise<boolean> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false;
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/permissions/dual-read`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        user_id: deciderId,
        permission_id: 'braid.profile.merge',
        agent_policy_decision: 'allow',
        scope: { org_id: orgId, project_id: null },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { decision?: string } };
    return json.data?.decision === 'allow';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleProposalDecided(
  envelope: ProposalDecidedEnvelope,
): Promise<ProposalDecidedResult> {
  const proposal = envelope.payload?.proposal;
  if (!proposal?.id) return { status: 'ignored', reason: 'no proposal in payload' };
  if (proposal.proposed_action !== 'braid.merge_profiles')
    return { status: 'ignored', reason: 'not a braid merge proposal' };

  const orgId = envelope.payload.org?.id ?? envelope.org_id;
  if (!orgId) return { status: 'ignored', reason: 'no org id' };

  // Reverse-lookup the candidate by proposal_id (the payload carries no subject_id).
  const [candidate] = await db
    .select()
    .from(braidMatchCandidates)
    .where(
      and(
        eq(braidMatchCandidates.proposal_id, proposal.id),
        eq(braidMatchCandidates.organization_id, orgId),
      ),
    )
    .limit(1);
  if (!candidate) return { status: 'ignored', reason: 'no candidate for proposal' };
  if (candidate.status !== 'pending')
    return { status: 'noop', reason: `candidate already ${candidate.status}` };

  // Re-SELECT the authoritative proposal status rather than trusting the fire-and-
  // forget frame (S3-2).
  const [prow] = await db
    .select({ status: agentProposals.status, approver_id: agentProposals.approver_id })
    .from(agentProposals)
    .where(eq(agentProposals.id, proposal.id))
    .limit(1);
  if (!prow) return { status: 'ignored', reason: 'proposal row missing' };

  const decision = proposal.decision;
  if (decision === 'request_revision') return { status: 'noop', reason: 'request_revision' };

  // Branch must match the real status.
  if (decision === 'approve' && prow.status !== 'approved')
    return { status: 'noop', reason: `status is ${prow.status}, not approved` };
  if (decision === 'reject' && prow.status !== 'rejected')
    return { status: 'noop', reason: `status is ${prow.status}, not rejected` };

  const decider = envelope.actor_id ?? proposal.actor_id ?? prow.approver_id ?? proposal.approver_id;
  if (!decider) return { status: 'noop', reason: 'no decider actor resolvable' };

  const decidedByKind = boltActorToKind(envelope.actor_type);
  const reason = proposal.decision_reason ?? undefined;

  // Fail-closed decider checks before any truth flip (spec 2.2 / S-r2-1 / S3-4).
  const [policyOk, holdsMerge] = await Promise.all([
    deciderPassesPolicy(decider),
    deciderHoldsMerge(decider, orgId),
  ]);
  if (!policyOk || !holdsMerge) {
    return { status: 'noop', reason: 'decider failed policy/permission check; left pending' };
  }

  try {
    if (decision === 'approve') {
      await mergeCandidate(orgId, candidate.id, decider, decidedByKind, reason);
      return { status: 'merged', candidate_id: candidate.id };
    }
    // reject
    await rejectCandidate(orgId, candidate.id, decider, reason, decidedByKind);
    return { status: 'rejected', candidate_id: candidate.id };
  } catch (err) {
    // A CAS loss is the expected echo of a REST-driven decision (spec 5.4); harmless.
    if (err instanceof MergeConflictError)
      return { status: 'noop', reason: 'CAS lost (already decided)' };
    throw err;
  }
}
