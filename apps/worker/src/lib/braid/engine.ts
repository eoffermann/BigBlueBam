// Braid identity-resolution engine (spec 4). Runs in the worker for the
// braid-match-on-ingest queue. Given a changed/new source row it: normalizes match keys,
// acquires the ALL-KEYS advisory lock, create-or-attaches the identity, blocks for
// candidate profiles, scores them, and routes each profile pair to an autonomy band
// (auto-merge / review / no-op) INSIDE the single locked transaction (spec 4.2/4.4). The
// post-commit Bolt events are collected and fired best-effort after commit.
//
// Faithful reimplementation of apps/braid-api/src/services/merge.service.ts merge steps
// (the worker follows the no-cross-api-import convention). The advisory lock + normalize
// + survivorship helpers are byte-faithful copies so worker- and REST-driven merges agree.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Logger } from 'pino';
import { acquireIdentityLocks } from './advisory-lock.js';
import {
  scoreDirect,
  DEFAULT_WEIGHTS,
  SCORE_MODEL,
  type ScoreInputIdentity,
  type DirectScoreResult,
} from './scoring.js';
import { recomputeGolden, type MemberIdentity, type SurvivorshipRule } from './survivorship.js';
import { readSourceRecord } from './source-reader.js';
import {
  BRAID_SYSTEM_USER_ID,
  DEFAULT_AUTO_MERGE_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_REQUIRE_STRONG_SIGNAL,
  NOOP_RESURFACE_COOLDOWN_DAYS,
  PROPOSAL_EXPIRY_DAYS,
} from './constants.js';
import {
  braidProfiles,
  braidIdentities,
  braidMatchCandidates,
  braidMergeDecisions,
  braidSurvivorshipRules,
  braidOrgSettings,
  dedupeDecisions,
  agentProposals,
  entityLinks,
} from './schema.js';

type Db = PostgresJsDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const TRIGRAM_BLOCK_THRESHOLD = 0.3;

// One deferred Bolt event to fire after the transaction commits (refs-only, spec 7.1).
export interface DeferredEvent {
  event: 'profile.merged' | 'profile.split' | 'profile.matched' | 'candidate.created' | 'proposal.created';
  source: 'braid' | 'platform';
  payload: Record<string, unknown>;
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  // Transactional-outbox marker (spec 4.4 ST3-1): after a successful publish, stamp
  // last_event_published_at = the exact updated_at the step OBSERVED (never now()), guarded
  // so a concurrent bump is not masked. Present only for braid profile.* events.
  stampProfileId?: string;
  stampUpdatedAt?: Date;
}

export interface IngestResult {
  status: 'skipped' | 'processed';
  reason?: string;
  identityId?: string;
  homeProfileId?: string;
  merges: number;
  candidates: number;
  attached: boolean;
  noops: number;
  events: DeferredEvent[];
}

interface OrgSettings {
  autoMergeThreshold: number;
  reviewThreshold: number;
  requireStrongSignal: boolean;
  enabledSourceTypes: string[];
}

async function loadOrgSettings(db: Db | Tx, orgId: string): Promise<OrgSettings> {
  const [row] = await db
    .select()
    .from(braidOrgSettings)
    .where(eq(braidOrgSettings.organization_id, orgId))
    .limit(1);
  if (!row) {
    return {
      autoMergeThreshold: DEFAULT_AUTO_MERGE_THRESHOLD,
      reviewThreshold: DEFAULT_REVIEW_THRESHOLD,
      requireStrongSignal: DEFAULT_REQUIRE_STRONG_SIGNAL,
      enabledSourceTypes: [],
    };
  }
  return {
    autoMergeThreshold: Number(row.auto_merge_threshold),
    reviewThreshold: Number(row.review_threshold),
    requireStrongSignal: row.require_strong_signal_for_auto,
    enabledSourceTypes: Array.isArray(row.enabled_source_types)
      ? (row.enabled_source_types as string[])
      : [],
  };
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
    strategy: row.strategy as SurvivorshipRule['strategy'],
    source_priority: Array.isArray(row.source_priority) ? (row.source_priority as string[]) : [],
    pinned_value: row.pinned_value ?? null,
  };
}

// Recompute one profile's golden record from its members + org rules. Returns the observed
// updated_at (the outbox "version processed") + member count. Mirrors merge.service.recomputeProfile.
async function recomputeProfile(
  tx: Tx,
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

// A candidate identity found by blocking, with the profile it belongs to.
interface BlockedIdentity {
  id: string;
  profile_id: string;
  email_norm: string | null;
  phone_norm: string | null;
  name_norm: string | null;
  domain: string | null;
  platform_user_id: string | null;
}

// Blocking (spec 4.2): exact email/phone/platform_user (GIN on match_keys) UNION trigram
// name (pg_trgm), same org, active profile, excluding identities already in homeProfile.
// Qdrant embedding recall is the soft third path (spec 4.2 / 9.5) and is omitted in M6:
// the engine never blocks on Qdrant, degrading to key + trigram only.
async function blockCandidates(
  tx: Tx,
  orgId: string,
  homeProfileId: string,
  keys: { email_norm?: string; phone_norm?: string; name_norm?: string; platform_user_id?: string | null },
): Promise<BlockedIdentity[]> {
  const conds: ReturnType<typeof sql>[] = [];
  if (keys.email_norm) conds.push(sql`i.match_keys->>'email_norm' = ${keys.email_norm}`);
  if (keys.phone_norm) conds.push(sql`i.match_keys->>'phone_norm' = ${keys.phone_norm}`);
  if (keys.platform_user_id)
    conds.push(sql`i.match_keys->>'platform_user_id' = ${keys.platform_user_id}`);
  if (keys.name_norm)
    conds.push(sql`(i.match_keys->>'name_norm' IS NOT NULL AND similarity(i.match_keys->>'name_norm', ${keys.name_norm}) > ${TRIGRAM_BLOCK_THRESHOLD})`);
  if (conds.length === 0) return [];

  let matchOr = conds[0]!;
  for (let k = 1; k < conds.length; k++) matchOr = sql`${matchOr} OR ${conds[k]!}`;

  const res = await tx.execute(sql`
    SELECT i.id, i.profile_id,
           i.match_keys->>'email_norm' AS email_norm,
           i.match_keys->>'phone_norm' AS phone_norm,
           i.match_keys->>'name_norm' AS name_norm,
           i.match_keys->>'domain' AS domain,
           i.match_keys->>'platform_user_id' AS platform_user_id
      FROM braid_identities i
      JOIN braid_profiles p ON p.id = i.profile_id
     WHERE i.organization_id = ${orgId}
       AND i.profile_id <> ${homeProfileId}
       AND p.status = 'active'
       AND (${matchOr})
     LIMIT 200
  `);
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as BlockedIdentity[];
}

// Is the canonical identity-atom pair suppressed (reject/human-split not_duplicate, or a
// no-op needs_review still inside its resurface cooldown)? Spec 2.3 / 4.2 / D-r2-5.
async function isPairSuppressed(tx: Tx, aId: string, bId: string): Promise<boolean> {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const res = await tx.execute(sql`
    SELECT decision, resurface_after FROM dedupe_decisions
     WHERE entity_type = 'braid.identity' AND id_a = ${lo} AND id_b = ${hi}
     LIMIT 1
  `);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
    decision: string;
    resurface_after: string | Date | null;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  if (row.decision === 'not_duplicate') return true; // human-separated / rejected: never resurface on same evidence
  if (row.decision === 'needs_review') {
    if (!row.resurface_after) return true;
    const until = row.resurface_after instanceof Date ? row.resurface_after : new Date(row.resurface_after);
    return until.getTime() > Date.now(); // still cooling down
  }
  return false;
}

// Direct auto-merge of two profiles via a generated candidate + CAS (spec 4.4). Runs inside
// tx (locks already held). Returns the survivor id + observed updated_at + affected identities.
async function autoMergeProfiles(
  tx: Tx,
  orgId: string,
  pairAId: string,
  pairBId: string,
  bridgeA: string,
  bridgeB: string,
  score: DirectScoreResult,
): Promise<{ survivorId: string; absorbedId: string; affected: Array<{ source_type: string; source_id: string }>; identityCount: number; observedUpdatedAt: Date } | null> {
  const [profA, profB] = pairAId < pairBId ? [pairAId, pairBId] : [pairBId, pairAId];
  const [bA, bB] = pairAId < pairBId ? [bridgeA, bridgeB] : [bridgeB, bridgeA];

  // Lock both profiles by id order (deadlock-safe), re-check not already merged_away.
  const locked = await tx
    .select()
    .from(braidProfiles)
    .where(and(eq(braidProfiles.organization_id, orgId), inArray(braidProfiles.id, [profA, profB])))
    .orderBy(braidProfiles.id)
    .for('update');
  if (locked.length < 2) return null;
  if (locked.some((p) => p.status === 'merged_away')) return null;

  const evidence = buildEvidence(score, bA, bB);
  // Upsert the auto-merge candidate (audit + evidence), then CAS-flip it to merged.
  const [cand] = await tx
    .insert(braidMatchCandidates)
    .values({
      organization_id: orgId,
      profile_a_id: profA,
      profile_b_id: profB,
      bridge_identity_a_id: bA,
      bridge_identity_b_id: bB,
      score: score.score.toFixed(2),
      evidence,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [braidMatchCandidates.organization_id, braidMatchCandidates.profile_a_id, braidMatchCandidates.profile_b_id],
      set: { score: score.score.toFixed(2), evidence, status: 'pending', decided_at: null },
    })
    .returning({ id: braidMatchCandidates.id });
  const candidateId = cand!.id;

  const outcome = await executeMergeInTx(tx, orgId, profA, profB, candidateId, 'auto', BRAID_SYSTEM_USER_ID, 'service', score.score.toFixed(2), 'braid auto-merge (score>=auto_merge_threshold, strong signal)');
  return outcome;
}

// The transactional merge core, shared by auto-merge (candidate CAS) and mirrors
// merge.service.executeMerge. Returns null when the CAS/lock guard aborts (another actor won).
async function executeMergeInTx(
  tx: Tx,
  orgId: string,
  aId: string,
  bId: string,
  candidateId: string,
  decisionKind: 'auto' | 'merge',
  decidedBy: string,
  decidedByKind: 'human' | 'agent' | 'service',
  scoreStr: string | null,
  reason: string,
): Promise<{ survivorId: string; absorbedId: string; affected: Array<{ source_type: string; source_id: string }>; identityCount: number; observedUpdatedAt: Date } | null> {
  const locked = await tx
    .select()
    .from(braidProfiles)
    .where(and(eq(braidProfiles.organization_id, orgId), inArray(braidProfiles.id, [aId, bId])))
    .orderBy(braidProfiles.id)
    .for('update');
  if (locked.length < 2) return null;
  const pa = locked.find((p) => p.id === aId)!;
  const pb = locked.find((p) => p.id === bId)!;

  // CAS the candidate: only the row that flips from pending proceeds (exactly-once, spec 2.2).
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
    .returning({ id: braidMatchCandidates.id });
  if (cas.length === 0) return null;

  // Survivor: oldest profile wins, then more members, then smaller id (deterministic).
  const at = new Date(pa.created_at).getTime();
  const bt = new Date(pb.created_at).getTime();
  let survivorIsA: boolean;
  if (at !== bt) survivorIsA = at < bt;
  else if (pa.identity_count !== pb.identity_count) survivorIsA = pa.identity_count > pb.identity_count;
  else survivorIsA = pa.id < pb.id;
  const survivor = survivorIsA ? pa : pb;
  const absorbed = survivorIsA ? pb : pa;

  const moved = await tx
    .update(braidIdentities)
    .set({ profile_id: survivor.id })
    .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, absorbed.id)))
    .returning({ id: braidIdentities.id, source_type: braidIdentities.source_type, source_id: braidIdentities.source_id });

  await tx
    .update(braidProfiles)
    .set({ status: 'merged_away', merged_into_id: survivor.id, updated_at: new Date() })
    .where(eq(braidProfiles.id, absorbed.id));

  const { observedUpdatedAt, identityCount } = await recomputeProfile(tx, orgId, survivor.id, survivor.kind);

  // Supersede any pending candidate still pointing at the absorbed profile (spec 3.1).
  await tx
    .update(braidMatchCandidates)
    .set({ status: 'superseded', decided_at: new Date() })
    .where(
      and(
        eq(braidMatchCandidates.organization_id, orgId),
        eq(braidMatchCandidates.status, 'pending'),
        or(eq(braidMatchCandidates.profile_a_id, absorbed.id), eq(braidMatchCandidates.profile_b_id, absorbed.id)),
      ),
    );

  await tx.insert(braidMergeDecisions).values({
    organization_id: orgId,
    decision_kind: decisionKind,
    surviving_profile_id: survivor.id,
    absorbed_profile_id: absorbed.id,
    affected_identity_ids: moved.map((m) => m.id),
    candidate_id: candidateId,
    score_at_decision: scoreStr,
    decided_by: decidedBy,
    decided_by_kind: decidedByKind,
    reason,
  });

  return {
    survivorId: survivor.id,
    absorbedId: absorbed.id,
    affected: moved.map((m) => ({ source_type: m.source_type, source_id: m.source_id })),
    identityCount,
    observedUpdatedAt,
  };
}

function buildEvidence(score: DirectScoreResult, bridgeA: string, bridgeB: string): Record<string, unknown> {
  return {
    shape: 'direct',
    features: score.features.map((f) => ({ kind: f.kind, score: f.score, weight: f.weight, strong: f.strong })),
    strong_signal: score.strong_signal,
    bridge_identity_a_id: bridgeA,
    bridge_identity_b_id: bridgeB,
    weights: DEFAULT_WEIGHTS,
    model: SCORE_MODEL,
  };
}

// ── The public ingest entry point ────────────────────────────────────────────

export async function processBraidIngest(
  db: Db,
  params: { orgId: string; sourceType: string; sourceId: string },
  logger: Logger,
): Promise<IngestResult> {
  const source = await readSourceRecord(db, params.sourceType, params.sourceId);
  if (!source) {
    return { status: 'skipped', reason: 'source row not found', merges: 0, candidates: 0, attached: false, noops: 0, events: [] };
  }
  // The job carries the derived org; trust the source-derived org (spec 4.1) but log a mismatch.
  const orgId = source.orgId;
  if (params.orgId && params.orgId !== orgId) {
    logger.warn({ jobOrg: params.orgId, sourceOrg: orgId, sourceType: params.sourceType }, 'braid-ingest: org mismatch; using source-derived org');
  }

  const settings = await loadOrgSettings(db, orgId);
  if (settings.enabledSourceTypes.length > 0 && !settings.enabledSourceTypes.includes(params.sourceType)) {
    return { status: 'skipped', reason: 'source type not enabled for org', merges: 0, candidates: 0, attached: false, noops: 0, events: [] };
  }

  const storedKeys: Record<string, string> = { ...source.matchKeys } as Record<string, string>;
  if (source.platformUserId) storedKeys.platform_user_id = source.platformUserId;

  const events: DeferredEvent[] = [];
  let merges = 0;
  let candidates = 0;
  let noops = 0;
  let attached = false;
  let identityId = '';
  let homeProfileId = '';

  await db.transaction(async (tx) => {
    // 1. Serialize on EVERY present blocking key (spec 4.2 ST-r2-1).
    await acquireIdentityLocks(tx, orgId, source.matchKeys);

    // 2. Upsert-or-attach the identity.
    const [existing] = await tx
      .select()
      .from(braidIdentities)
      .where(
        and(
          eq(braidIdentities.organization_id, orgId),
          eq(braidIdentities.source_type, params.sourceType),
          eq(braidIdentities.source_id, params.sourceId),
        ),
      )
      .limit(1);

    if (existing) {
      // Known identity (resolve-seeded singleton or edited row): refresh snapshot in place.
      await tx
        .update(braidIdentities)
        .set({
          match_keys: storedKeys,
          raw_attributes: source.rawAttributes,
          source_synced_at: source.sourceUpdatedAt ?? new Date(),
          needs_rescan: false,
        })
        .where(eq(braidIdentities.id, existing.id));
      identityId = existing.id;
      homeProfileId = existing.profile_id;
      await recomputeProfile(tx, orgId, homeProfileId, source.kind);
    } else {
      // New source row: create-or-attach. Block for a home profile.
      const blocked = await blockCandidates(tx, orgId, '00000000-0000-0000-0000-000000000000', {
        email_norm: source.matchKeys.email_norm,
        phone_norm: source.matchKeys.phone_norm,
        name_norm: source.matchKeys.name_norm,
        platform_user_id: source.platformUserId,
      });
      const self: ScoreInputIdentity = {
        email_norm: source.matchKeys.email_norm,
        phone_norm: source.matchKeys.phone_norm,
        name_norm: source.matchKeys.name_norm,
        domain: source.matchKeys.domain,
        platform_user_id: source.platformUserId,
      };
      // Best identity per candidate profile.
      const bestByProfile = pickBestByProfile(self, blocked);
      const strongHome = [...bestByProfile.values()]
        .filter((b) => b.score.strong_signal)
        .sort((a, b) => b.score.score - a.score.score)[0];

      if (strongHome) {
        // Attach directly to the best strong-match profile (auto-link below the merge bar).
        const [ins] = await tx
          .insert(braidIdentities)
          .values({
            organization_id: orgId,
            profile_id: strongHome.profileId,
            source_type: params.sourceType,
            source_id: params.sourceId,
            match_keys: storedKeys,
            raw_attributes: source.rawAttributes,
            source_synced_at: source.sourceUpdatedAt ?? new Date(),
            link_confidence: strongHome.score.score.toFixed(2),
            link_evidence: buildEvidence(strongHome.score, '', strongHome.identityId),
            link_kind: 'auto',
          })
          .returning({ id: braidIdentities.id });
        identityId = ins!.id;
        homeProfileId = strongHome.profileId;
        attached = true;
        const rc = await recomputeProfile(tx, orgId, homeProfileId, source.kind);
        await upsertEntityLink(tx, orgId, homeProfileId, params.sourceType, params.sourceId);
        events.push({
          event: 'profile.matched',
          source: 'braid',
          payload: {
            profile: { id: homeProfileId },
            identity: { source_type: params.sourceType, source_id: params.sourceId },
          },
          actorId: BRAID_SYSTEM_USER_ID,
          actorType: 'system',
          stampProfileId: homeProfileId,
          stampUpdatedAt: rc.observedUpdatedAt,
        });
      } else {
        // No strong match: mint a fresh singleton profile.
        const [np] = await tx
          .insert(braidProfiles)
          .values({ organization_id: orgId, kind: source.kind, status: 'active', identity_count: 1, confidence: '1.00' })
          .returning({ id: braidProfiles.id });
        homeProfileId = np!.id;
        const [ins] = await tx
          .insert(braidIdentities)
          .values({
            organization_id: orgId,
            profile_id: homeProfileId,
            source_type: params.sourceType,
            source_id: params.sourceId,
            match_keys: storedKeys,
            raw_attributes: source.rawAttributes,
            source_synced_at: source.sourceUpdatedAt ?? new Date(),
            link_confidence: '1.00',
            link_kind: 'seed',
          })
          .returning({ id: braidIdentities.id });
        identityId = ins!.id;
        await recomputeProfile(tx, orgId, homeProfileId, source.kind);
        await upsertEntityLink(tx, orgId, homeProfileId, params.sourceType, params.sourceId);
      }
    }

    // 3. Re-block from the (now-placed) identity to find OTHER matched profiles and route
    //    each profile pair to a band (auto-merge / review / no-op). N-way bridging cascades.
    let currentHome = homeProfileId;
    const self2: ScoreInputIdentity = {
      email_norm: source.matchKeys.email_norm,
      phone_norm: source.matchKeys.phone_norm,
      name_norm: source.matchKeys.name_norm,
      domain: source.matchKeys.domain,
      platform_user_id: source.platformUserId,
    };
    const blocked2 = await blockCandidates(tx, orgId, currentHome, {
      email_norm: source.matchKeys.email_norm,
      phone_norm: source.matchKeys.phone_norm,
      name_norm: source.matchKeys.name_norm,
      platform_user_id: source.platformUserId,
    });
    const targets = [...pickBestByProfile(self2, blocked2).values()].sort((a, b) => b.score.score - a.score.score);

    for (const target of targets) {
      // Skip if this pair's bridging atoms are suppressed (anti-flap, spec 2.3/4.2).
      if (await isPairSuppressed(tx, identityId, target.identityId)) continue;
      // Re-resolve currentHome to its live survivor (a prior auto-merge may have moved it).
      const live = await followSurvivor(tx, orgId, currentHome);
      if (!live) break;
      currentHome = live;
      if (currentHome === target.profileId) continue; // already merged together

      const score = target.score;
      const autoOk =
        score.score >= settings.autoMergeThreshold &&
        (!settings.requireStrongSignal || score.strong_signal);

      if (autoOk) {
        const outcome = await autoMergeProfiles(tx, orgId, currentHome, target.profileId, identityId, target.identityId, score);
        if (outcome) {
          merges += 1;
          currentHome = outcome.survivorId;
          events.push({
            event: 'profile.merged',
            source: 'braid',
            payload: {
              profile: { id: outcome.survivorId },
              affected_identities: outcome.affected,
              identity_count: outcome.identityCount,
              decision_kind: 'auto',
            },
            actorId: BRAID_SYSTEM_USER_ID,
            actorType: 'system',
            stampProfileId: outcome.survivorId,
            stampUpdatedAt: outcome.observedUpdatedAt,
          });
        }
      } else if (score.score >= settings.reviewThreshold) {
        const created = await createReviewCandidate(tx, orgId, currentHome, target.profileId, identityId, target.identityId, score);
        if (created) {
          candidates += 1;
          events.push(...created.events);
        }
      } else {
        // No-op band: suppress with a resurface cooldown so the pair is not rescored each tick.
        await writeNoopSuppression(tx, orgId, identityId, target.identityId, score.score);
        noops += 1;
      }
    }
  });

  logger.info(
    { orgId, sourceType: params.sourceType, sourceId: params.sourceId, identityId, homeProfileId, merges, candidates, noops, attached },
    'braid-ingest: processed',
  );
  return { status: 'processed', identityId, homeProfileId, merges, candidates, attached, noops, events };
}

interface BestMatch {
  profileId: string;
  identityId: string;
  score: DirectScoreResult;
}

// For each candidate profile, keep the identity with the highest direct score to `self`.
function pickBestByProfile(self: ScoreInputIdentity, blocked: BlockedIdentity[]): Map<string, BestMatch> {
  const best = new Map<string, BestMatch>();
  for (const b of blocked) {
    const score = scoreDirect(self, {
      email_norm: b.email_norm,
      phone_norm: b.phone_norm,
      name_norm: b.name_norm,
      domain: b.domain,
      platform_user_id: b.platform_user_id,
    });
    if (score.score <= 0) continue;
    const cur = best.get(b.profile_id);
    if (!cur || score.score > cur.score.score) {
      best.set(b.profile_id, { profileId: b.profile_id, identityId: b.id, score });
    }
  }
  return best;
}

// Follow the merged_into_id chain to the live active survivor (spec 4.5 ST5).
async function followSurvivor(tx: Tx, orgId: string, startId: string): Promise<string | null> {
  let currentId = startId;
  for (let hops = 0; hops < 32; hops++) {
    const [row] = await tx
      .select({ id: braidProfiles.id, status: braidProfiles.status, merged_into_id: braidProfiles.merged_into_id })
      .from(braidProfiles)
      .where(and(eq(braidProfiles.id, currentId), eq(braidProfiles.organization_id, orgId)))
      .limit(1);
    if (!row) return null;
    if (row.status === 'merged_away' && row.merged_into_id) {
      currentId = row.merged_into_id;
      continue;
    }
    return row.id;
  }
  return null;
}

// Review band: upsert the candidate, register an approver-null agent_proposals row, link it,
// and emit candidate.created + proposal.created (spec 2.2). Returns the deferred events.
async function createReviewCandidate(
  tx: Tx,
  orgId: string,
  homeProfileId: string,
  targetProfileId: string,
  bridgeHome: string,
  bridgeTarget: string,
  score: DirectScoreResult,
): Promise<{ events: DeferredEvent[] } | null> {
  const [profA, profB] = homeProfileId < targetProfileId ? [homeProfileId, targetProfileId] : [targetProfileId, homeProfileId];
  const [bA, bB] = homeProfileId < targetProfileId ? [bridgeHome, bridgeTarget] : [bridgeTarget, bridgeHome];
  const evidence = buildEvidence(score, bA, bB);

  const [cand] = await tx
    .insert(braidMatchCandidates)
    .values({
      organization_id: orgId,
      profile_a_id: profA,
      profile_b_id: profB,
      bridge_identity_a_id: bA,
      bridge_identity_b_id: bB,
      score: score.score.toFixed(2),
      evidence,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [braidMatchCandidates.organization_id, braidMatchCandidates.profile_a_id, braidMatchCandidates.profile_b_id],
      set: { score: score.score.toFixed(2), evidence, bridge_identity_a_id: bA, bridge_identity_b_id: bB },
    })
    .returning({ id: braidMatchCandidates.id, status: braidMatchCandidates.status, proposal_id: braidMatchCandidates.proposal_id });
  const candidate = cand!;
  // If the pair already has a live pending proposal, don't double-register.
  if (candidate.status !== 'pending') return { events: [] };

  const events: DeferredEvent[] = [];
  let proposalId = candidate.proposal_id;
  if (!proposalId) {
    const expiresAt = new Date(Date.now() + PROPOSAL_EXPIRY_DAYS * 86400_000);
    const [prop] = await tx
      .insert(agentProposals)
      .values({
        org_id: orgId,
        actor_id: BRAID_SYSTEM_USER_ID,
        proposer_kind: 'service',
        proposed_action: 'braid.merge_profiles',
        proposed_payload: { candidate_id: candidate.id, profile_a_id: profA, profile_b_id: profB },
        subject_type: 'braid.candidate',
        subject_id: candidate.id,
        approver_id: null,
        status: 'pending',
        expires_at: expiresAt,
      })
      .returning({ id: agentProposals.id, actor_id: agentProposals.actor_id, expires_at: agentProposals.expires_at });
    proposalId = prop!.id;
    await tx
      .update(braidMatchCandidates)
      .set({ proposal_id: proposalId })
      .where(eq(braidMatchCandidates.id, candidate.id));

    // Mirror proposals.routes.ts:114 so platform approval-notification fan-out fires (D3-5).
    events.push({
      event: 'proposal.created',
      source: 'platform',
      payload: {
        proposal: {
          id: proposalId,
          proposed_action: 'braid.merge_profiles',
          approver_id: null,
          actor_id: BRAID_SYSTEM_USER_ID,
          proposer_kind: 'service',
          expires_at: prop!.expires_at.toISOString(),
          subject_type: 'braid.candidate',
          subject_id: candidate.id,
        },
        org: { id: orgId },
      },
      actorId: BRAID_SYSTEM_USER_ID,
      actorType: 'system',
    });
  }

  events.push({
    event: 'candidate.created',
    source: 'braid',
    payload: { candidate: { id: candidate.id }, score: score.score, org: { id: orgId } },
    actorId: BRAID_SYSTEM_USER_ID,
    actorType: 'system',
  });
  return { events };
}

// No-op band: identity-level needs_review suppression with a resurface cooldown (spec 4.2 / D-r2-5).
async function writeNoopSuppression(tx: Tx, orgId: string, aId: string, bId: string, score: number): Promise<void> {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const resurfaceAfter = new Date(Date.now() + NOOP_RESURFACE_COOLDOWN_DAYS * 86400_000);
  await tx
    .insert(dedupeDecisions)
    .values({
      org_id: orgId,
      entity_type: 'braid.identity',
      id_a: lo,
      id_b: hi,
      decision: 'needs_review',
      decided_by: BRAID_SYSTEM_USER_ID,
      reason: 'braid no-op band (score < review_threshold); resurface cooldown',
      confidence_at_decision: score.toFixed(2),
      resurface_after: resurfaceAfter,
    })
    .onConflictDoUpdate({
      target: [dedupeDecisions.entity_type, dedupeDecisions.id_a, dedupeDecisions.id_b],
      set: { resurface_after: resurfaceAfter, confidence_at_decision: score.toFixed(2) },
    });
}

async function upsertEntityLink(tx: Tx, orgId: string, profileId: string, sourceType: string, sourceId: string): Promise<void> {
  await tx
    .insert(entityLinks)
    .values({ org_id: orgId, src_type: 'braid.profile', src_id: profileId, dst_type: sourceType, dst_id: sourceId, link_kind: 'related_to' })
    .onConflictDoNothing();
}
