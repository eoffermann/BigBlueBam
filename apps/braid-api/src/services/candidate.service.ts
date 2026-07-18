import { and, desc, eq, lt } from 'drizzle-orm';
import type { BraidCandidate } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import {
  braidMatchCandidates,
  braidIdentities,
  braidProfiles,
  agentProposals,
} from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import { publishBoltEvent } from '@bigbluebam/shared';

// Review-queue reads (spec 5.1). braid.candidate.read is admin-tier by default, so the
// evidence value-refs (which are refs like "id_a#email", not raw PII) are returned as
// stored. TODO(M6): per-caller re-hydration of evidence refs for granted non-admins.

type CandidateRow = typeof braidMatchCandidates.$inferSelect;

function toCandidate(row: CandidateRow): BraidCandidate {
  return {
    id: row.id,
    profile_a_id: row.profile_a_id,
    profile_b_id: row.profile_b_id,
    score: Number(row.score),
    evidence: row.evidence as BraidCandidate['evidence'],
    rationale: row.rationale,
    status: row.status as BraidCandidate['status'],
    proposal_id: row.proposal_id,
    created_at: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
  };
}

export interface ListCandidatesQuery {
  status?: string;
  limit: number;
  cursor?: string;
}

export async function listCandidates(
  orgId: string,
  query: ListCandidatesQuery,
): Promise<{ data: BraidCandidate[]; next_cursor: string | null }> {
  const conds = [eq(braidMatchCandidates.organization_id, orgId)];
  conds.push(eq(braidMatchCandidates.status, query.status ?? 'pending'));
  if (query.cursor) conds.push(lt(braidMatchCandidates.created_at, new Date(query.cursor)));

  const rows = await db
    .select()
    .from(braidMatchCandidates)
    .where(and(...conds))
    .orderBy(desc(braidMatchCandidates.score), desc(braidMatchCandidates.created_at))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit
      ? (page[page.length - 1]!.created_at instanceof Date
          ? (page[page.length - 1]!.created_at as Date)
          : new Date(page[page.length - 1]!.created_at)
        ).toISOString()
      : null;

  return { data: page.map(toCandidate), next_cursor: nextCursor };
}

export async function getCandidate(orgId: string, id: string): Promise<BraidCandidate | null> {
  const [row] = await db
    .select()
    .from(braidMatchCandidates)
    .where(and(eq(braidMatchCandidates.id, id), eq(braidMatchCandidates.organization_id, orgId)))
    .limit(1);
  return row ? toCandidate(row) : null;
}

// Agent/human-initiated propose (spec 2.4 / 10, D3-2). Upserts a canonical
// (profile_a_id < profile_b_id) candidate for two existing profiles, inserts an
// agent_proposals row (approver_id NULL so it lands in the org-admin queue, expires_at
// 7d, subject = the candidate), and links the candidate's proposal_id back to it, so an
// approval flows through the identical CAS-guarded mergeCandidate as a worker-registered
// review candidate. The proposal IS the HITL; no confirm token here.
export async function proposeMerge(
  orgId: string,
  proposerId: string,
  input: { profile_a_id: string; profile_b_id: string; reason?: string },
): Promise<BraidCandidate> {
  // Canonicalize the pair (the table CHECK requires profile_a_id < profile_b_id).
  const [a, b] =
    input.profile_a_id < input.profile_b_id
      ? [input.profile_a_id, input.profile_b_id]
      : [input.profile_b_id, input.profile_a_id];

  // Both profiles must exist, be active, and be in this org.
  const profiles = await db
    .select({ id: braidProfiles.id, status: braidProfiles.status })
    .from(braidProfiles)
    .where(and(eq(braidProfiles.organization_id, orgId)));
  const byId = new Map(profiles.map((p) => [p.id, p.status]));
  if (byId.get(a) !== 'active' || byId.get(b) !== 'active') {
    throw new NotFoundError('One or both profiles not found or not active');
  }

  // Representative bridge atoms: the first identity of each profile. These are the stable
  // suppression atoms a later reject keys on (spec 2.3).
  const bridgeA = (
    await db
      .select({ id: braidIdentities.id })
      .from(braidIdentities)
      .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, a)))
      .limit(1)
  )[0];
  const bridgeB = (
    await db
      .select({ id: braidIdentities.id })
      .from(braidIdentities)
      .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, b)))
      .limit(1)
  )[0];
  if (!bridgeA || !bridgeB) {
    throw new NotFoundError('One or both profiles have no member identity to bridge');
  }

  const evidence = {
    shape: 'direct' as const,
    features: [],
    strong_signal: false,
    weights: {},
    model: 'braid-manual-propose',
  };

  const result = await db.transaction(async (tx) => {
    // Upsert the candidate (idempotent on the canonical pair).
    const [cand] = await tx
      .insert(braidMatchCandidates)
      .values({
        organization_id: orgId,
        profile_a_id: a,
        profile_b_id: b,
        bridge_identity_a_id: bridgeA.id,
        bridge_identity_b_id: bridgeB.id,
        score: '0.50',
        evidence,
        rationale: input.reason ?? null,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: [
          braidMatchCandidates.organization_id,
          braidMatchCandidates.profile_a_id,
          braidMatchCandidates.profile_b_id,
        ],
        set: { status: 'pending', rationale: input.reason ?? null },
      })
      .returning();
    const candidate = cand!;

    // Insert the approval-inbox proposal (approver_id NULL -> org-admin queue).
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [proposal] = await tx
      .insert(agentProposals)
      .values({
        org_id: orgId,
        actor_id: proposerId,
        proposer_kind: 'human',
        proposed_action: 'braid.merge_profiles',
        proposed_payload: { candidate_id: candidate.id, profile_a_id: a, profile_b_id: b },
        subject_type: 'braid.candidate',
        subject_id: candidate.id,
        approver_id: null,
        status: 'pending',
        expires_at: expiresAt,
      })
      .returning();

    await tx
      .update(braidMatchCandidates)
      .set({ proposal_id: proposal!.id })
      .where(eq(braidMatchCandidates.id, candidate.id));

    return { ...candidate, proposal_id: proposal!.id };
  });

  // Refs-only notifications (spec 5.2 / 7.1). Best-effort, post-commit.
  publishBoltEvent('candidate.created', 'braid', {
    candidate: { id: result.id },
    score: 0.5,
    org: { id: orgId },
  }, orgId).catch(() => {});
  publishBoltEvent('proposal.created', 'platform', {
    proposal: { id: result.proposal_id },
    proposed_action: 'braid.merge_profiles',
    org: { id: orgId },
  }, orgId).catch(() => {});

  return toCandidate(result as CandidateRow);
}
