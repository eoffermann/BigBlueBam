import { and, eq, inArray, or } from 'drizzle-orm';
import { publishBoltEvent, type BoltActorType } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import {
  braidProfiles,
  braidIdentities,
  braidMatchCandidates,
  braidMergeDecisions,
  braidSurvivorshipRules,
  dedupeDecisions,
} from '../db/schema/index.js';
import {
  recomputeGolden,
  type MemberIdentity,
  type SurvivorshipRule,
  type SurvivorshipStrategy,
} from './survivorship.service.js';
import { publishBraidFrame } from '../lib/realtime.js';
import { MergeConflictError, NotFoundError } from '../lib/errors.js';
import type { ActorKind } from './types.js';

// The SINGLE truth-changing executors (spec 4.4 / 4.5 / 5.4). Each runs its DB
// steps in ONE drizzle transaction; the post-commit external effects (Bolt event,
// ws frame, outbox marker stamp) are best-effort and outside the transaction.

type BraidTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface IdentityRef {
  source_type: string;
  source_id: string;
}

interface MergeOutcome {
  survivorId: string;
  absorbedId: string;
  kind: string;
  affected: IdentityRef[];
  identityCount: number;
  observedUpdatedAt: Date;
  decisionKind: 'auto' | 'merge';
}

function kindToBolt(kind: ActorKind): BoltActorType {
  return kind === 'human' ? 'user' : kind === 'agent' ? 'agent' : 'system';
}

function toMemberIdentity(row: typeof braidIdentities.$inferSelect): MemberIdentity {
  return {
    id: row.id,
    source_type: row.source_type,
    raw_attributes: (row.raw_attributes as Record<string, unknown>) ?? {},
    source_synced_at: row.source_synced_at,
    linked_at: row.linked_at,
    link_confidence: row.link_confidence,
  };
}

function toRule(row: typeof braidSurvivorshipRules.$inferSelect): SurvivorshipRule {
  return {
    kind: row.kind,
    field: row.field,
    strategy: row.strategy as SurvivorshipStrategy,
    source_priority: Array.isArray(row.source_priority) ? (row.source_priority as string[]) : [],
    pinned_value: row.pinned_value ?? null,
  };
}

// Survivor selection: the oldest profile wins, then the one with more members, then
// the smaller id (deterministic). The N-way bridging initial-attach tie-break of
// spec 4.4 is worker territory; here we only decide which of two merging profiles
// survives.
function pickSurvivor(
  a: typeof braidProfiles.$inferSelect,
  b: typeof braidProfiles.$inferSelect,
): { survivor: typeof braidProfiles.$inferSelect; absorbed: typeof braidProfiles.$inferSelect } {
  const at = new Date(a.created_at).getTime();
  const bt = new Date(b.created_at).getTime();
  let survivorIsA: boolean;
  if (at !== bt) survivorIsA = at < bt;
  else if (a.identity_count !== b.identity_count)
    survivorIsA = a.identity_count > b.identity_count;
  else survivorIsA = a.id < b.id;
  return survivorIsA ? { survivor: a, absorbed: b } : { survivor: b, absorbed: a };
}

// Recompute one profile's golden record from its current members + org rules and
// persist it. Returns the observed updated_at (the outbox "version processed").
async function recomputeProfile(
  tx: BraidTx,
  orgId: string,
  profileId: string,
  kind: string,
): Promise<{ observedUpdatedAt: Date; identityCount: number }> {
  const members = await tx
    .select()
    .from(braidIdentities)
    .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profileId)));
  const rules = await tx
    .select()
    .from(braidSurvivorshipRules)
    .where(and(eq(braidSurvivorshipRules.organization_id, orgId), eq(braidSurvivorshipRules.kind, kind)));
  const g = recomputeGolden(members.map(toMemberIdentity), rules.map(toRule));
  const [updated] = await tx
    .update(braidProfiles)
    .set({
      attributes: g.attributes,
      display_name: g.display_name,
      primary_email: g.primary_email,
      primary_phone: g.primary_phone,
      company_profile_id: g.company_profile_id,
      identity_count: g.identity_count,
      confidence: g.confidence,
      updated_at: new Date(),
    })
    .where(eq(braidProfiles.id, profileId))
    .returning({ updated_at: braidProfiles.updated_at });
  return { observedUpdatedAt: updated!.updated_at, identityCount: g.identity_count };
}

// Write identity-level suppression for the STRONG-signal cross pairs between two
// separated identity sets (spec 4.5 ST3-4). Strong = shared email_norm or phone_norm;
// those are the only pairs that could cross the auto-merge bar and silently re-merge.
// platform_user (needs a source join) and the weak pairs (name/embedding/domain) are
// the worker's async capped backfill.
// TODO(M6): add platform_user strong pairs + the capped weak-pair backfill in the worker.
async function suppressStrongPairs(
  tx: BraidTx,
  orgId: string,
  setA: (typeof braidIdentities.$inferSelect)[],
  setB: (typeof braidIdentities.$inferSelect)[],
  decidedBy: string,
): Promise<void> {
  const rows: {
    org_id: string;
    entity_type: string;
    id_a: string;
    id_b: string;
    decision: string;
    decided_by: string;
    reason: string;
  }[] = [];
  const keyOf = (m: typeof braidIdentities.$inferSelect, k: 'email_norm' | 'phone_norm') => {
    const mk = (m.match_keys as Record<string, unknown>) ?? {};
    const v = mk[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  for (const a of setA) {
    for (const b of setB) {
      const strong =
        (keyOf(a, 'email_norm') && keyOf(a, 'email_norm') === keyOf(b, 'email_norm')) ||
        (keyOf(a, 'phone_norm') && keyOf(a, 'phone_norm') === keyOf(b, 'phone_norm'));
      if (!strong) continue;
      const [id_a, id_b] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      rows.push({
        org_id: orgId,
        entity_type: 'braid.identity',
        id_a,
        id_b,
        decision: 'not_duplicate',
        decided_by: decidedBy,
        reason: 'human-separated (split); strong pair cannot auto-remerge',
      });
    }
  }
  if (rows.length === 0) return;
  await tx
    .insert(dedupeDecisions)
    .values(rows)
    .onConflictDoNothing({
      target: [dedupeDecisions.entity_type, dedupeDecisions.id_a, dedupeDecisions.id_b],
    });
}

// The core merge steps, shared by the candidate and direct paths. Runs inside `tx`.
async function executeMerge(
  tx: BraidTx,
  params: {
    orgId: string;
    aId: string;
    bId: string;
    candidateId: string | null;
    decidedBy: string;
    decidedByKind: ActorKind;
    reason?: string;
    isAuto: boolean;
  },
): Promise<MergeOutcome> {
  const { orgId, aId, bId, candidateId, decidedBy, decidedByKind, reason, isAuto } = params;

  // Global lock order: FOR UPDATE on the profile rows, ordered by id (deadlock-safe).
  const locked = await tx
    .select()
    .from(braidProfiles)
    .where(and(eq(braidProfiles.organization_id, orgId), inArray(braidProfiles.id, [aId, bId])))
    .orderBy(braidProfiles.id)
    .for('update');
  if (locked.length < 2) throw new NotFoundError('One or both profiles not found');
  const pa = locked.find((p) => p.id === aId)!;
  const pb = locked.find((p) => p.id === bId)!;

  let score: string | null = null;
  if (candidateId) {
    // CAS: only the row that flips from pending proceeds (exactly-once, spec 2.2).
    const cas = await tx
      .update(braidMatchCandidates)
      .set({ status: 'merged', decided_at: new Date() })
      .where(
        and(
          eq(braidMatchCandidates.id, candidateId),
          eq(braidMatchCandidates.organization_id, orgId),
          eq(braidMatchCandidates.status, 'pending'),
        ),
      )
      .returning({ score: braidMatchCandidates.score });
    if (cas.length === 0) throw new MergeConflictError();
    score = cas[0]!.score;
  } else {
    // Direct path has no candidate; the FOR UPDATE + merged_away re-check is the guard.
    if (pa.status === 'merged_away' || pb.status === 'merged_away') throw new MergeConflictError();
  }

  const { survivor, absorbed } = pickSurvivor(pa, pb);

  // Move all absorbed identities onto the survivor.
  const moved = await tx
    .update(braidIdentities)
    .set({ profile_id: survivor.id })
    .where(
      and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, absorbed.id)),
    )
    .returning({
      id: braidIdentities.id,
      source_type: braidIdentities.source_type,
      source_id: braidIdentities.source_id,
    });

  // Mark the absorbed profile merged_away, pointing at the survivor.
  await tx
    .update(braidProfiles)
    .set({ status: 'merged_away', merged_into_id: survivor.id, updated_at: new Date() })
    .where(eq(braidProfiles.id, absorbed.id));

  // Recompute the survivor's golden record from the union of members.
  const { observedUpdatedAt, identityCount } = await recomputeProfile(
    tx,
    orgId,
    survivor.id,
    survivor.kind,
  );

  // Supersede any pending candidate still pointing at the absorbed profile so no
  // candidate ever references a merged_away id (spec 3.1 status rule).
  await tx
    .update(braidMatchCandidates)
    .set({ status: 'superseded', decided_at: new Date() })
    .where(
      and(
        eq(braidMatchCandidates.organization_id, orgId),
        eq(braidMatchCandidates.status, 'pending'),
        or(
          eq(braidMatchCandidates.profile_a_id, absorbed.id),
          eq(braidMatchCandidates.profile_b_id, absorbed.id),
        ),
      ),
    );

  await tx.insert(braidMergeDecisions).values({
    organization_id: orgId,
    decision_kind: isAuto ? 'auto' : 'merge',
    surviving_profile_id: survivor.id,
    absorbed_profile_id: absorbed.id,
    affected_identity_ids: moved.map((m) => m.id),
    reverses_decision_id: null,
    candidate_id: candidateId,
    score_at_decision: score,
    decided_by: decidedBy,
    decided_by_kind: decidedByKind,
    reason: reason ?? null,
  });

  return {
    survivorId: survivor.id,
    absorbedId: absorbed.id,
    kind: survivor.kind,
    affected: moved.map((m) => ({ source_type: m.source_type, source_id: m.source_id })),
    identityCount,
    observedUpdatedAt,
    decisionKind: isAuto ? 'auto' : 'merge',
  };
}

// Best-effort post-commit side effects for a merge (spec 4.4). The Bolt event and ws
// frame are refs-only; last_event_published_at is stamped to the OBSERVED updated_at
// (NOT now()) and guarded so a concurrent merge's own bump is not masked.
async function afterMerge(
  outcome: MergeOutcome,
  orgId: string,
  decidedBy: string,
  decidedByKind: ActorKind,
): Promise<void> {
  void publishBoltEvent(
    'profile.merged',
    'braid',
    {
      profile: { id: outcome.survivorId },
      affected_identities: outcome.affected,
      identity_count: outcome.identityCount,
      decision_kind: outcome.decisionKind,
    },
    orgId,
    decidedBy,
    kindToBolt(decidedByKind),
  );
  void publishBraidFrame(orgId, {
    type: 'profile.merged',
    data: { surviving_profile_id: outcome.survivorId, affected_identities: outcome.affected },
  });
  await db
    .update(braidProfiles)
    .set({ last_event_published_at: outcome.observedUpdatedAt })
    .where(
      and(
        eq(braidProfiles.id, outcome.survivorId),
        eq(braidProfiles.updated_at, outcome.observedUpdatedAt),
      ),
    )
    .catch(() => {});
  // TODO(M6): re-embed the survivor into Qdrant; for now qdrant_synced_at is left
  // stale so the rescan/worker re-embeds (the outbox marker discipline).
}

// ── Public executors ────────────────────────────────────────────────────────

export async function mergeCandidate(
  orgId: string,
  candidateId: string,
  decidedBy: string,
  decidedByKind: ActorKind,
  reason?: string,
): Promise<MergeOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [cand] = await tx
      .select()
      .from(braidMatchCandidates)
      .where(
        and(eq(braidMatchCandidates.id, candidateId), eq(braidMatchCandidates.organization_id, orgId)),
      )
      .limit(1);
    if (!cand) throw new NotFoundError('Candidate not found');
    if (cand.status !== 'pending') throw new MergeConflictError();
    return executeMerge(tx, {
      orgId,
      aId: cand.profile_a_id,
      bId: cand.profile_b_id,
      candidateId,
      decidedBy,
      decidedByKind,
      reason,
      isAuto: decidedByKind === 'service',
    });
  });
  await afterMerge(outcome, orgId, decidedBy, decidedByKind);
  // TODO(M6): resolve the linked agent_proposals row to 'approved' (the intentional
  // proposal.decided echo drives the subscription back into a harmless CAS no-op,
  // spec 5.4). Left out of the REST path for M4 to avoid the echo loop.
  return outcome;
}

export async function mergeProfilesDirect(
  orgId: string,
  profileAId: string,
  profileBId: string,
  decidedBy: string,
  reason?: string,
  decidedByKind: ActorKind = 'human',
): Promise<MergeOutcome> {
  const outcome = await db.transaction((tx) =>
    executeMerge(tx, {
      orgId,
      aId: profileAId,
      bId: profileBId,
      candidateId: null,
      decidedBy,
      decidedByKind,
      reason,
      isAuto: false,
    }),
  );
  await afterMerge(outcome, orgId, decidedBy, decidedByKind);
  return outcome;
}

export async function rejectCandidate(
  orgId: string,
  candidateId: string,
  decidedBy: string,
  reason?: string,
  decidedByKind: ActorKind = 'human',
): Promise<{ candidateId: string }> {
  await db.transaction(async (tx) => {
    const cas = await tx
      .update(braidMatchCandidates)
      .set({ status: 'rejected', decided_at: new Date() })
      .where(
        and(
          eq(braidMatchCandidates.id, candidateId),
          eq(braidMatchCandidates.organization_id, orgId),
          eq(braidMatchCandidates.status, 'pending'),
        ),
      )
      .returning();
    if (cas.length === 0) throw new MergeConflictError();
    const cand = cas[0]!;

    // Suppress on the immutable bridge-identity atoms (spec 2.3), canonical id_a<id_b.
    const [id_a, id_b] =
      cand.bridge_identity_a_id < cand.bridge_identity_b_id
        ? [cand.bridge_identity_a_id, cand.bridge_identity_b_id]
        : [cand.bridge_identity_b_id, cand.bridge_identity_a_id];
    await tx
      .insert(dedupeDecisions)
      .values({
        org_id: orgId,
        entity_type: 'braid.identity',
        id_a,
        id_b,
        decision: 'not_duplicate',
        decided_by: decidedBy,
        reason: reason ?? null,
        confidence_at_decision: cand.score,
      })
      .onConflictDoNothing({
        target: [dedupeDecisions.entity_type, dedupeDecisions.id_a, dedupeDecisions.id_b],
      });

    await tx.insert(braidMergeDecisions).values({
      organization_id: orgId,
      decision_kind: 'reject',
      surviving_profile_id: cand.profile_a_id,
      absorbed_profile_id: cand.profile_b_id,
      affected_identity_ids: [],
      candidate_id: candidateId,
      score_at_decision: cand.score,
      decided_by: decidedBy,
      decided_by_kind: decidedByKind,
      reason: reason ?? null,
    });
  });
  return { candidateId };
}

export interface SplitOptions {
  merge_decision_id?: string;
  identity_ids?: string[];
}

export interface SplitOutcome {
  survivingProfileId: string;
  newProfileId: string;
  affected: IdentityRef[];
}

export async function splitProfile(
  orgId: string,
  profileId: string,
  opts: SplitOptions,
  decidedBy: string,
  reason?: string,
  decidedByKind: ActorKind = 'human',
): Promise<SplitOutcome> {
  const outcome = await db.transaction<SplitOutcome>(async (tx) => {
    if (opts.merge_decision_id) {
      // Unmerge: reactivate the original absorbed profile and reattach its identities.
      const [decision] = await tx
        .select()
        .from(braidMergeDecisions)
        .where(
          and(
            eq(braidMergeDecisions.id, opts.merge_decision_id),
            eq(braidMergeDecisions.organization_id, orgId),
          ),
        )
        .limit(1);
      if (!decision || !decision.absorbed_profile_id || !decision.surviving_profile_id)
        throw new NotFoundError('Merge decision not found or not reversible');
      const survivorId = decision.surviving_profile_id;
      const absorbedId = decision.absorbed_profile_id;
      const affectedIds = Array.isArray(decision.affected_identity_ids)
        ? (decision.affected_identity_ids as string[])
        : [];

      // Lock both profiles, id order.
      await tx
        .select({ id: braidProfiles.id })
        .from(braidProfiles)
        .where(and(eq(braidProfiles.organization_id, orgId), inArray(braidProfiles.id, [survivorId, absorbedId])))
        .orderBy(braidProfiles.id)
        .for('update');

      // Reactivate the absorbed profile in place (restores the original id, ST5).
      await tx
        .update(braidProfiles)
        .set({ status: 'active', merged_into_id: null, updated_at: new Date() })
        .where(eq(braidProfiles.id, absorbedId));

      // Reattach exactly the identities this merge moved.
      const reattached =
        affectedIds.length > 0
          ? await tx
              .update(braidIdentities)
              .set({ profile_id: absorbedId })
              .where(and(eq(braidIdentities.organization_id, orgId), inArray(braidIdentities.id, affectedIds)))
              .returning({
                id: braidIdentities.id,
                source_type: braidIdentities.source_type,
                source_id: braidIdentities.source_id,
                match_keys: braidIdentities.match_keys,
              })
          : [];

      const [survivorRow] = await tx
        .select({ kind: braidProfiles.kind })
        .from(braidProfiles)
        .where(eq(braidProfiles.id, survivorId))
        .limit(1);
      const [absorbedRow] = await tx
        .select({ kind: braidProfiles.kind })
        .from(braidProfiles)
        .where(eq(braidProfiles.id, absorbedId))
        .limit(1);

      await recomputeProfile(tx, orgId, survivorId, survivorRow?.kind ?? 'person');
      await recomputeProfile(tx, orgId, absorbedId, absorbedRow?.kind ?? 'person');

      const survivorMembers = await tx
        .select()
        .from(braidIdentities)
        .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, survivorId)));
      const absorbedMembers = await tx
        .select()
        .from(braidIdentities)
        .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, absorbedId)));
      await suppressStrongPairs(tx, orgId, survivorMembers, absorbedMembers, decidedBy);

      await tx.insert(braidMergeDecisions).values({
        organization_id: orgId,
        decision_kind: 'split',
        surviving_profile_id: survivorId,
        absorbed_profile_id: absorbedId,
        affected_identity_ids: affectedIds,
        reverses_decision_id: opts.merge_decision_id,
        candidate_id: null,
        decided_by: decidedBy,
        decided_by_kind: decidedByKind,
        reason: reason ?? null,
      });

      return {
        survivingProfileId: survivorId,
        newProfileId: absorbedId,
        affected: reattached.map((r) => ({ source_type: r.source_type, source_id: r.source_id })),
      };
    }

    // Fresh-id split: the "actually two people" case. Mint a new profile and move the
    // named identities to it.
    const identityIds = opts.identity_ids ?? [];
    if (identityIds.length === 0) throw new NotFoundError('No identities to split');

    const [src] = await tx
      .select()
      .from(braidProfiles)
      .where(and(eq(braidProfiles.id, profileId), eq(braidProfiles.organization_id, orgId)))
      .for('update')
      .limit(1);
    if (!src) throw new NotFoundError('Profile not found');

    const [np] = await tx
      .insert(braidProfiles)
      .values({ organization_id: orgId, kind: src.kind, status: 'active', identity_count: 0 })
      .returning({ id: braidProfiles.id });
    const newProfileId = np!.id;

    const moved = await tx
      .update(braidIdentities)
      .set({ profile_id: newProfileId })
      .where(
        and(
          eq(braidIdentities.organization_id, orgId),
          eq(braidIdentities.profile_id, profileId),
          inArray(braidIdentities.id, identityIds),
        ),
      )
      .returning({
        id: braidIdentities.id,
        source_type: braidIdentities.source_type,
        source_id: braidIdentities.source_id,
      });
    if (moved.length === 0) throw new NotFoundError('None of the identities belong to this profile');

    await recomputeProfile(tx, orgId, profileId, src.kind);
    await recomputeProfile(tx, orgId, newProfileId, src.kind);

    const srcMembers = await tx
      .select()
      .from(braidIdentities)
      .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profileId)));
    const newMembers = await tx
      .select()
      .from(braidIdentities)
      .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, newProfileId)));
    await suppressStrongPairs(tx, orgId, srcMembers, newMembers, decidedBy);

    await tx.insert(braidMergeDecisions).values({
      organization_id: orgId,
      decision_kind: 'split',
      surviving_profile_id: profileId,
      absorbed_profile_id: newProfileId,
      affected_identity_ids: moved.map((m) => m.id),
      reverses_decision_id: null,
      candidate_id: null,
      decided_by: decidedBy,
      decided_by_kind: decidedByKind,
      reason: reason ?? null,
    });

    return {
      survivingProfileId: profileId,
      newProfileId,
      affected: moved.map((m) => ({ source_type: m.source_type, source_id: m.source_id })),
    };
  });

  // Post-commit: refs-only split frame + Bolt event (spec 5.2 / 7.1).
  void publishBoltEvent(
    'profile.split',
    'braid',
    {
      profile: { id: outcome.survivingProfileId },
      new_profile_id: outcome.newProfileId,
      affected_identities: outcome.affected,
    },
    orgId,
    decidedBy,
    kindToBolt(decidedByKind),
  );
  void publishBraidFrame(orgId, {
    type: 'profile.split',
    data: {
      surviving_profile_id: outcome.survivingProfileId,
      new_profile_id: outcome.newProfileId,
      affected_identities: outcome.affected,
    },
  });
  return outcome;
}
