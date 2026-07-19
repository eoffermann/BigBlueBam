import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  BurnPrecheckRequest,
  BurnPrecheckResponse,
  BurnPrecheckVerdict,
  BurnPrecheckVerdictReason,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  burnAttributionRules,
  burnAttributions,
  burnDeliverables,
  burnEngagementProjects,
  burnEngagements,
  burnPrechecks,
  burnVariances,
  burnWorkItems,
} from '../db/schema/index.js';
import { NotFoundError, RateLimitedError } from '../lib/errors.js';
import { canAccessRowProject } from '../lib/project-scope.js';
import { deriveIdempotencyKey } from '../lib/idempotency-key.js';
import {
  PROBE_COUNTER_TTL_SECONDS,
  consumptionBand,
  decisionRemaining,
  orgDailyPrecheckKey,
  probeCapKey,
  quantizeOverage,
} from '../lib/quantize.js';
import { env } from '../env.js';
import { gateIsBlockingFor, loadSettings } from './settings.service.js';
import type { Viewer } from './types.js';

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE PRECHECK GATE. Spec section 5.

   ── INVARIANT 2, AND IT IS NOT NEGOTIABLE ──────────────────────────────────────────
   THE SYNCHRONOUS PATH IS DETERMINISTIC-ONLY. It NEVER calls POST /internal/llm/chat.
   There is no import of the llm client in this file and there must never be one; the test
   suite stubs the LLM client to THROW and asserts zero calls on the SUCCESS path, not only
   on failure paths.

   Why this is a correctness requirement and not a performance preference: on the gate path
   `work_ref_id` is null (the expense does not exist yet -- that is the whole point of a
   PREcheck), so there is no prior attribution and no work item to look up. Requiring a
   confident target would therefore mean a provider round trip inside an 800ms budget. The
   realistic steady state is that every gated expense either burns the budget and FAILS OPEN,
   or falls to `needs_mapping`, which is non-blocking. Either way THE BLOCKING GATE WOULD BE
   DECORATIVE -- an expensive, latent, load-bearing-looking control that never blocks
   anything. Round 2 was decisive about this and it is the single most important line in the
   section.

   If no deterministic target clears `deny_threshold`, the verdict is `needs_mapping`, which
   is already non-blocking. So the deterministic-only rule costs NOTHING in safety.

   ── THE ONLY BLOCKING VERDICT IS `deny` ────────────────────────────────────────────
   `needs_mapping` NEVER blocks in v1. The charge posts with an inline note and a queue item.

   ── THE FOUR DETERMINISTIC STAGES, IN ORDER (spec 5.3) ─────────────────────────────
   1. Stage zero: burn_attribution_rules in priority order.
   2. Structural: project_id -> burn_engagement_projects -> the chain's active deliverables.
   3. Precedent: prior confirmed attributions for the same project / vendor / category.
   4. Lexical: Postgres FTS + trigram over deliverable titles and confirmed exemplars.
   ══════════════════════════════════════════════════════════════════════════════════════ */

export interface PrecheckCaller {
  viewer: Viewer;
  /** `svc:` for the bill-api internal path, `usr:` for the user-facing route. */
  namespace: 'svc' | 'usr';
  /** Financial capability of the ACTING human. Drives decision-input quantization. */
  canReadAll: boolean;
  /** Injected so the internal route and the user route share one implementation. */
  redis: {
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<unknown>;
  };
}

interface DeterministicTarget {
  deliverableId: string;
  engagementId: string;
  chainRootId: string;
  confidence: number;
  method: 'rule' | 'structural' | 'precedent' | 'lexical';
  clauseRef: string | null;
}

/** Stage zero: explicit org rules, highest priority first. */
async function stageRules(
  tx: DbTx,
  orgId: string,
  req: BurnPrecheckRequest,
): Promise<DeterministicTarget | null> {
  const rules = await tx
    .select()
    .from(burnAttributionRules)
    .where(
      and(
        eq(burnAttributionRules.organization_id, orgId),
        eq(burnAttributionRules.is_enabled, true),
        eq(burnAttributionRules.outcome_kind, 'attribute'),
      ),
    )
    .orderBy(sql`${burnAttributionRules.priority} ASC`);

  for (const rule of rules) {
    const match = (rule.match ?? {}) as {
      source_types?: string[];
      project_ids?: string[];
      title_pattern?: string;
    };
    if (match.source_types && !match.source_types.includes(req.work_ref_type)) continue;
    if (match.project_ids && (!req.project_id || !match.project_ids.includes(req.project_id))) {
      continue;
    }
    if (match.title_pattern) {
      // title_pattern rejects regex metacharacters at write time (shared Zod), so a plain
      // case-insensitive substring test is both correct and immune to catastrophic
      // backtracking. Node has no regex timeout and the spec no longer claims one.
      const haystack = `${req.title ?? ''} ${req.description ?? ''}`.toLowerCase();
      if (!haystack.includes(match.title_pattern.toLowerCase())) continue;
    }
    if (!rule.outcome_deliverable_id) continue;
    const [deliverable] = await tx
      .select({
        id: burnDeliverables.id,
        engagement_id: burnDeliverables.engagement_id,
        clause_ref: burnDeliverables.clause_ref,
      })
      .from(burnDeliverables)
      .where(
        and(
          eq(burnDeliverables.organization_id, orgId),
          eq(burnDeliverables.id, rule.outcome_deliverable_id),
          eq(burnDeliverables.is_active, true),
        ),
      )
      .limit(1);
    if (!deliverable) continue;
    const [engagement] = await tx
      .select({ id: burnEngagements.id, chain_root_id: burnEngagements.chain_root_id })
      .from(burnEngagements)
      .where(eq(burnEngagements.id, deliverable.engagement_id))
      .limit(1);
    if (!engagement) continue;
    return {
      deliverableId: deliverable.id,
      engagementId: engagement.id,
      chainRootId: engagement.chain_root_id ?? engagement.id,
      // A human wrote this rule. It is the most confident signal the system has.
      confidence: 1,
      method: 'rule',
      clauseRef: deliverable.clause_ref,
    };
  }
  return null;
}

/** The chains reachable from a project, through burn_engagement_projects. */
async function chainsForProject(tx: DbTx, orgId: string, projectId: string) {
  return tx
    .select({
      engagement_id: burnEngagements.id,
      chain_root_id: burnEngagements.chain_root_id,
      status: burnEngagements.status,
      start_date: burnEngagements.start_date,
      end_date: burnEngagements.end_date,
    })
    .from(burnEngagementProjects)
    .innerJoin(burnEngagements, eq(burnEngagements.id, burnEngagementProjects.engagement_id))
    .where(
      and(
        eq(burnEngagementProjects.organization_id, orgId),
        eq(burnEngagementProjects.project_id, projectId),
        eq(burnEngagements.status, 'active'),
      ),
    );
}

/** Stage 2 + 4: structural resolution, then lexical narrowing inside the chain. */
async function stageStructuralAndLexical(
  tx: DbTx,
  orgId: string,
  req: BurnPrecheckRequest,
): Promise<{ target: DeterministicTarget | null; chainCount: number; outsideWindow: boolean }> {
  if (!req.project_id) return { target: null, chainCount: 0, outsideWindow: false };
  const chains = await chainsForProject(tx, orgId, req.project_id);
  if (chains.length === 0) return { target: null, chainCount: 0, outsideWindow: false };

  const occurredAt = req.occurred_at ? new Date(req.occurred_at) : new Date();
  const inWindow = chains.filter((c) => {
    const startsOk = !c.start_date || new Date(c.start_date) <= occurredAt;
    const endsOk = !c.end_date || new Date(c.end_date) >= occurredAt;
    return startsOk && endsOk;
  });
  if (inWindow.length === 0) {
    return { target: null, chainCount: chains.length, outsideWindow: true };
  }

  const rootIds = [...new Set(inWindow.map((c) => c.chain_root_id ?? c.engagement_id))];
  const candidates = await tx
    .select({
      id: burnDeliverables.id,
      engagement_id: burnDeliverables.engagement_id,
      clause_ref: burnDeliverables.clause_ref,
      title: burnDeliverables.title,
      chain_root_id: burnEngagements.chain_root_id,
    })
    .from(burnDeliverables)
    .innerJoin(burnEngagements, eq(burnEngagements.id, burnDeliverables.engagement_id))
    .where(
      and(
        eq(burnDeliverables.organization_id, orgId),
        inArray(burnEngagements.chain_root_id, rootIds),
        eq(burnDeliverables.is_active, true),
        eq(burnDeliverables.review_status, 'confirmed'),
        // An amendment deliverable is never a candidate (spec 12.1): post-amendment work
        // attributes to the BASE row and the amendment carries only the delta.
        isNull(burnDeliverables.amends_deliverable_id),
      ),
    );

  if (candidates.length === 0) {
    return { target: null, chainCount: chains.length, outsideWindow: false };
  }

  // Exactly one active deliverable on the chain: structural resolution is unambiguous.
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return {
      target: {
        deliverableId: c.id,
        engagementId: c.engagement_id,
        chainRootId: c.chain_root_id ?? c.engagement_id,
        confidence: 0.95,
        method: 'structural',
        clauseRef: c.clause_ref,
      },
      chainCount: chains.length,
      outsideWindow: false,
    };
  }

  // Stage 4, lexical: a plain token-overlap score over TITLES. Deliberately not `search_tsv`
  // ranking here even though a read_all path could use it, because this same code runs for a
  // member-triggered precheck and the R3-S4 rule is that no member-reachable path ranks on a
  // floored column. Titles are member-visible, so scoring on them discloses nothing new.
  const haystack = `${req.title ?? ''} ${req.description ?? ''}`.toLowerCase();
  const terms = haystack.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  let best: DeterministicTarget | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const titleTerms = c.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    if (titleTerms.length === 0) continue;
    const overlap = titleTerms.filter((t) => terms.includes(t)).length;
    const score = overlap / titleTerms.length;
    if (score > bestScore) {
      bestScore = score;
      best = {
        deliverableId: c.id,
        engagementId: c.engagement_id,
        chainRootId: c.chain_root_id ?? c.engagement_id,
        // Lexical evidence caps well below a rule or an unambiguous structural match. A
        // deny needs deny_threshold (default high), so a lexical guess alone cannot block
        // money -- it can only reach `needs_mapping`, which is the intent.
        confidence: Math.min(0.85, 0.5 + bestScore * 0.35),
        method: 'lexical',
        clauseRef: c.clause_ref,
      };
    }
  }
  return { target: best, chainCount: chains.length, outsideWindow: false };
}

/** Stage 3: precedent. Prior CONFIRMED attributions from the same project. */
async function stagePrecedent(
  tx: DbTx,
  orgId: string,
  req: BurnPrecheckRequest,
): Promise<DeterministicTarget | null> {
  if (!req.project_id) return null;
  const [row] = await tx
    .select({
      deliverable_id: burnAttributions.deliverable_id,
      engagement_id: burnAttributions.engagement_id,
      chain_root_id: burnAttributions.chain_root_id,
      n: sql<number>`count(*)`,
    })
    .from(burnAttributions)
    .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
    .where(
      and(
        eq(burnAttributions.organization_id, orgId),
        eq(burnAttributions.state, 'confirmed'),
        isNull(burnAttributions.superseded_at),
        eq(burnWorkItems.project_id, req.project_id),
        sql`${burnAttributions.deliverable_id} IS NOT NULL`,
      ),
    )
    .groupBy(
      burnAttributions.deliverable_id,
      burnAttributions.engagement_id,
      burnAttributions.chain_root_id,
    )
    .orderBy(sql`count(*) DESC`)
    .limit(1);

  if (!row?.deliverable_id || !row.engagement_id) return null;
  const n = Number(row.n ?? 0);
  return {
    deliverableId: row.deliverable_id,
    engagementId: row.engagement_id,
    chainRootId: row.chain_root_id ?? row.engagement_id,
    // Precedent strengthens with repetition but is capped: it is a correlation, not a rule.
    confidence: Math.min(0.9, 0.6 + Math.min(n, 10) * 0.03),
    method: 'precedent',
    clauseRef: null,
  };
}

/** Consumed billable against one deliverable, from the work-item join. */
async function deliverableConsumption(
  tx: DbTx,
  orgId: string,
  deliverableId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string | null>`coalesce(sum(${burnWorkItems.billable_amount}), 0)` })
    .from(burnAttributions)
    .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
    .where(
      and(
        eq(burnAttributions.organization_id, orgId),
        eq(burnAttributions.deliverable_id, deliverableId),
        isNull(burnAttributions.superseded_at),
        inArray(burnAttributions.state, ['auto_attributed', 'confirmed']),
      ),
    );
  return Number(row?.total ?? 0) || 0;
}

export interface PrecheckOutcomeInternal {
  verdict: BurnPrecheckVerdict;
  reason: BurnPrecheckVerdictReason;
  target: DeterministicTarget | null;
  envelopeAmount: number | null;
  envelopeConsumed: number | null;
  envelopeRemaining: number | null;
  overageAmount: number | null;
}

/* ------------------------------------------------------------------ */
/*  The main entry point                                              */
/* ------------------------------------------------------------------ */

export interface RunPrecheckArgs {
  caller: PrecheckCaller;
  req: BurnPrecheckRequest;
  /** Overrides the caller's org for the internal path, where org comes from the payload. */
  orgId: string;
}

export async function runPrecheck(args: RunPrecheckArgs): Promise<BurnPrecheckResponse> {
  const started = Date.now();
  const { caller, req, orgId } = args;

  return runInOrgScope(orgId, async (tx) => {
    const settings = await loadSettings(tx, orgId);

    // ── Idempotency, and the BANKED-VERDICT ATTACK ──────────────────────────────────
    // A stored `allow` for a 1-cent charge must NEVER be returned for a $60,000 charge.
    // The amount and currency are inside the signed key material, so a mismatched replay
    // cannot collide by construction; the explicit re-validation below is the belt to that
    // suspenders, and it is what makes the failure mode a SUPERSEDE rather than a silent
    // wrong answer.
    const key = deriveIdempotencyKey(env.INTERNAL_SERVICE_SECRET, caller.namespace, req);
    const [existing] = await tx
      .select()
      .from(burnPrechecks)
      .where(
        and(
          eq(burnPrechecks.organization_id, orgId),
          eq(burnPrechecks.idempotency_key, key),
          isNull(burnPrechecks.superseded_at),
        ),
      )
      .limit(1);

    if (existing) {
      const stillValid = existing.valid_until && new Date(existing.valid_until) > new Date();
      const sameMoney =
        Number(existing.proposed_amount) === req.proposed_amount &&
        existing.currency === req.currency &&
        existing.work_ref_type === req.work_ref_type;
      if (stillValid && sameMoney) {
        return toResponse(existing, settings, caller.canReadAll, null);
      }
      // SUPERSEDE-THEN-INSERT (spec 3.1, R2-T7). Never UPDATE in place: the superseded row
      // is the reason-of-record artifact for the verdict that WAS issued, and overwriting it
      // destroys the audit trail the whole feature exists to produce. The superseded row is
      // also exempt from retention purging.
      await tx
        .update(burnPrechecks)
        .set({ superseded_at: new Date() })
        .where(eq(burnPrechecks.id, existing.id));
    }

    // ── Member-tier abuse caps (spec 2.4 point 10) ──────────────────────────────────
    if (caller.namespace === 'usr') {
      const dailyKey = orgDailyPrecheckKey(orgId, caller.viewer.id);
      const n = await caller.redis.incr(dailyKey).catch(() => 0);
      if (n === 1) await caller.redis.expire(dailyKey, PROBE_COUNTER_TTL_SECONDS).catch(() => {});
      const cap = Number(settings.usr_precheck_daily_cap ?? 200);
      if (n > cap) {
        throw new RateLimitedError(
          `Daily precheck cap of ${cap} reached for this user`,
          'PRECHECK_DAILY_CAP',
        );
      }
    }

    // ── The four deterministic stages, in order ─────────────────────────────────────
    let target = await stageRules(tx, orgId, req);
    const structural = target
      ? { target: null, chainCount: 1, outsideWindow: false }
      : await stageStructuralAndLexical(tx, orgId, req);
    if (!target) target = structural.target;
    if (!target) target = await stagePrecedent(tx, orgId, req);

    const denyThreshold = Number(settings.deny_threshold ?? 0.9);
    let verdict: BurnPrecheckVerdict = 'needs_mapping';
    let reason: BurnPrecheckVerdictReason = 'within_envelope';
    let envelopeAmount: number | null = null;
    let envelopeConsumed: number | null = null;
    let envelopeRemaining: number | null = null;
    let overageAmount: number | null = null;

    const blocking = gateIsBlockingFor(settings, req.work_ref_type);

    if (settings.gate_mode === 'off') {
      verdict = 'allow';
      reason = 'gate_off';
    } else if (settings.gate_paused_until && new Date(settings.gate_paused_until) > new Date()) {
      verdict = 'allow';
      reason = 'gate_paused';
    } else if (!target && structural.outsideWindow) {
      verdict = 'allow_with_note';
      reason = 'outside_engagement_window';
    } else if (!target && structural.chainCount === 0) {
      // `no_active_engagement` DEGRADES to needs_mapping unless strict_untracked_projects,
      // which defaults false. A firm that has not yet registered every SOW must not have
      // every unrelated charge blocked on day one.
      verdict = 'needs_mapping';
      reason = 'no_active_engagement';
    } else if (!target) {
      verdict = 'needs_mapping';
      reason = 'low_confidence_target';
    } else {
      const [deliverable] = await tx
        .select()
        .from(burnDeliverables)
        .where(eq(burnDeliverables.id, target.deliverableId))
        .limit(1);

      // A chain with ZERO linked projects can never produce a deny (spec 5.3).
      const [linked] = await tx
        .select({ id: burnEngagementProjects.id })
        .from(burnEngagementProjects)
        .innerJoin(burnEngagements, eq(burnEngagements.id, burnEngagementProjects.engagement_id))
        .where(
          and(
            eq(burnEngagementProjects.organization_id, orgId),
            eq(burnEngagements.chain_root_id, target.chainRootId),
          ),
        )
        .limit(1);

      if (!linked) {
        verdict = 'allow_with_note';
        reason = 'engagement_unlinked';
      } else if (!deliverable) {
        verdict = 'needs_mapping';
        reason = 'low_confidence_target';
      } else if (deliverable.lifecycle_status === 'closed') {
        verdict = target.confidence >= denyThreshold ? 'deny' : 'needs_mapping';
        reason = 'deliverable_closed';
      } else if (deliverable.envelope_amount === null || deliverable.envelope_source === 'unpriced') {
        // An unpriced envelope returns allow_with_note and NEVER a deny (spec 2.2.2). There
        // is no number to enforce against, and inventing one is exactly what the bulk
        // fast-path refuses to do.
        verdict = 'allow_with_note';
        reason = 'envelope_unpriced';
      } else if (deliverable.envelope_source !== 'human' && deliverable.envelope_source !== 'stated') {
        // A deny requires a HUMAN-CONFIRMED envelope. A model-proposed figure is not
        // something the firm agreed to and must not stop money.
        verdict = 'allow_with_note';
        reason = 'envelope_unpriced';
      } else {
        envelopeAmount = Number(deliverable.envelope_amount);
        envelopeConsumed = await deliverableConsumption(tx, orgId, deliverable.id);
        envelopeRemaining = envelopeAmount - envelopeConsumed;

        // ══ THE ORACLE DEFENSE (spec 2.4 point 3, R3-S3) ═══════════════════════════
        // The DECISION INPUT is quantized for a non-read_all caller, not merely the
        // output. Quantizing the output alone leaves the verdict itself as a comparator
        // the caller fully controls through proposed_amount, and binary search recovers
        // envelope_remaining exactly in ~24 probes regardless of bucket size.
        const effectiveRemaining = decisionRemaining(
          envelopeRemaining,
          Number(settings.overage_bucket_amount ?? 10000),
          caller.canReadAll,
        );

        if (effectiveRemaining <= 0) {
          overageAmount = req.proposed_amount;
          verdict = target.confidence >= denyThreshold ? 'deny' : 'needs_mapping';
          reason = 'envelope_exhausted';
        } else if (req.proposed_amount > effectiveRemaining) {
          overageAmount = req.proposed_amount - effectiveRemaining;
          verdict = target.confidence >= denyThreshold ? 'deny' : 'needs_mapping';
          reason = 'envelope_would_exceed';
        } else {
          verdict = 'allow';
          reason = 'within_envelope';
        }

        // The per-(member, deliverable) daily probe cap. A real charge is prechecked once;
        // 24 probes against one deliverable is a binary search, not a workflow. Exceeding
        // it raises a `precheck_probing` variance so the attempt is VISIBLE, not merely
        // rate-limited into silence.
        if (caller.namespace === 'usr' && !caller.canReadAll) {
          const pkey = probeCapKey(caller.viewer.id, deliverable.id);
          const probes = await caller.redis.incr(pkey).catch(() => 0);
          if (probes === 1) {
            await caller.redis.expire(pkey, PROBE_COUNTER_TTL_SECONDS).catch(() => {});
          }
          const probeCap = Number(settings.usr_precheck_per_deliverable_cap ?? 5);
          if (probes > probeCap) {
            await raiseProbingVariance(tx, orgId, target, caller.viewer.id, probes);
            throw new RateLimitedError(
              `Too many prechecks against this deliverable today (${probes} of ${probeCap}). This has been recorded for review.`,
              'PRECHECK_PROBE_CAP',
            );
          }
        }
      }
    }

    // `needs_mapping` NEVER blocks (spec 5.3). `deny` is the only blocking verdict, and only
    // when the gate is actually in blocking mode for this class.
    const enforced = verdict === 'deny' && blocking;

    const validUntil = new Date(
      Date.now() + Number(settings.precheck_replay_ttl_seconds ?? 300) * 1000,
    );

    // A `usr:` row counts toward calibration ONLY if it resolves a real record (spec 2.4
    // point 10). A synthetic `manual` precheck is marked non-calibrating so it cannot
    // manufacture a promotion sample.
    const isCalibrating = caller.namespace === 'svc' && !!req.work_ref_id;

    const [inserted] = await tx
      .insert(burnPrechecks)
      .values({
        organization_id: orgId,
        idempotency_key: key,
        valid_until: validUntil,
        is_calibrating: isCalibrating,
        work_ref_type: req.work_ref_type,
        work_ref_id: req.work_ref_id ?? null,
        project_id: req.project_id ?? null,
        proposed_amount: req.proposed_amount,
        currency: req.currency,
        engagement_id: target?.engagementId ?? null,
        chain_root_id: target?.chainRootId ?? null,
        deliverable_id: target?.deliverableId ?? null,
        verdict,
        verdict_reason: reason,
        mode_at_decision: settings.gate_mode,
        enforced,
        envelope_amount: envelopeAmount,
        envelope_consumed: envelopeConsumed,
        envelope_remaining: envelopeRemaining,
        overage_amount: overageAmount,
        confidence: target ? String(target.confidence) : null,
        clause_ref: target?.clauseRef ?? null,
        outcome: 'pending',
        latency_ms: Date.now() - started,
      })
      .returning();

    return toResponse(inserted!, settings, caller.canReadAll, Date.now() - started);
  });
}

async function raiseProbingVariance(
  tx: DbTx,
  orgId: string,
  target: DeterministicTarget,
  userId: string,
  probes: number,
) {
  const dedupKey = `precheck_probing:${userId}:${target.deliverableId}:${new Date()
    .toISOString()
    .slice(0, 10)}`;
  await tx
    .insert(burnVariances)
    .values({
      organization_id: orgId,
      engagement_id: target.engagementId,
      chain_root_id: target.chainRootId,
      deliverable_id: target.deliverableId,
      variance_kind: 'precheck_probing',
      severity: 'medium',
      dedup_key: dedupKey,
      // No amount. A variance about someone trying to learn the envelope must not carry
      // the envelope.
      amount: null,
      detail: {
        refs: [{ entity_type: 'user', entity_id: userId }],
        note: `${probes} prechecks against one deliverable in a single day, above the configured per-deliverable cap.`,
      },
      status: 'open',
    })
    .onConflictDoNothing();
}

/**
 * Project the stored row onto the wire shape (spec 5.7).
 *
 * The read_all-only keys are OMITTED, not nulled, for everyone else. The shared serializer
 * would delete them anyway (they are all in BURN_READ_ALL_FLOORED_KEYS), but building the
 * object correctly here means a route that forgets to call the serializer still cannot leak
 * from this path. Defense in depth on the one response the whole feature is named for.
 */
function toResponse(
  row: typeof burnPrechecks.$inferSelect,
  settings: { overage_bucket_amount: string | number | null },
  canReadAll: boolean,
  latencyMs: number | null,
): BurnPrecheckResponse {
  const bucket = Number(settings.overage_bucket_amount ?? 10000);
  const base: BurnPrecheckResponse = {
    precheck_id: row.id,
    verdict: row.verdict as BurnPrecheckVerdict,
    verdict_reason: row.verdict_reason as BurnPrecheckVerdictReason,
    enforced: row.enforced,
    mode_at_decision: row.mode_at_decision as BurnPrecheckResponse['mode_at_decision'],
    engagement_id: row.engagement_id,
    deliverable_id: row.deliverable_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    consumption_band:
      row.envelope_amount === null
        ? 'unpriced'
        : consumptionBand(Number(row.envelope_consumed ?? 0), Number(row.envelope_amount)),
    overage_amount_quantized:
      row.overage_amount === null ? null : quantizeOverage(Number(row.overage_amount), bucket),
    overage_bucket_amount: bucket,
    valid_until: (row.valid_until instanceof Date
      ? row.valid_until
      : new Date(row.valid_until)
    ).toISOString(),
    latency_ms: latencyMs ?? row.latency_ms,
  };
  if (!canReadAll) return base;
  return {
    ...base,
    envelope_amount: row.envelope_amount === null ? null : Number(row.envelope_amount),
    envelope_consumed: row.envelope_consumed === null ? null : Number(row.envelope_consumed),
    envelope_remaining: row.envelope_remaining === null ? null : Number(row.envelope_remaining),
    overage_amount: row.overage_amount === null ? null : Number(row.overage_amount),
    clause_ref: row.clause_ref,
  };
}

/* ------------------------------------------------------------------ */
/*  The gate log, override, and label                                 */
/* ------------------------------------------------------------------ */

export async function listPrechecks(
  viewer: Viewer,
  params: { cursor?: string; limit: number; verdict?: string; engagementId?: string },
  memberProjects: string[],
  canReadAll: boolean,
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(burnPrechecks)
      .where(
        and(
          eq(burnPrechecks.organization_id, viewer.org_id),
          params.verdict ? eq(burnPrechecks.verdict, params.verdict) : undefined,
          params.engagementId ? eq(burnPrechecks.engagement_id, params.engagementId) : undefined,
          memberProjects.length > 0 || viewer.is_superuser
            ? undefined
            : sql`false`,
        ),
      )
      .orderBy(sql`${burnPrechecks.created_at} DESC`)
      .limit(params.limit + 1);

    // Project-scoped by the row's OWN project_id. Admins see everything in the org.
    const scoped =
      viewer.is_superuser || viewer.role === 'owner' || viewer.role === 'admin'
        ? rows
        : rows.filter((r) => r.project_id && memberProjects.includes(r.project_id));

    // Strip envelope_* and clause_ref without read_all (spec 6.1). The shared serializer
    // does this too; doing it here as well keeps the gate log correct even if a future
    // refactor moves the route off the serializer.
    const projected = scoped.map((r) => {
      if (canReadAll) return r;
      const {
        envelope_amount: _a,
        envelope_consumed: _b,
        envelope_remaining: _c,
        overage_amount: _d,
        clause_ref: _e,
        ...rest
      } = r;
      return rest as typeof r;
    });

    const page = projected.slice(0, params.limit);
    return {
      data: page,
      next_cursor: projected.length > params.limit ? String(page[page.length - 1]?.id ?? '') : null,
    };
  });
}

export async function overridePrecheck(
  viewer: Viewer,
  id: string,
  body: { override_reason_code: string; override_reason_text: string },
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await loadSettings(tx, viewer.org_id);
    const minChars = Number(settings.override_reason_min_chars ?? 20);
    if (body.override_reason_text.trim().length < minChars) {
      throw new RateLimitedError(
        `An override reason must be at least ${minChars} characters`,
        'OVERRIDE_REASON_TOO_SHORT',
      );
    }
    const [row] = await tx
      .select()
      .from(burnPrechecks)
      .where(and(eq(burnPrechecks.organization_id, viewer.org_id), eq(burnPrechecks.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Precheck not found');
    if (!(await canAccessRowProject(viewer, row.project_id))) {
      throw new NotFoundError('Precheck not found');
    }

    // `gate_wrong` is NOT reachable here. It requires burn.precheck.mark_wrong and lives on
    // the label route (spec 2.4 point 9). The shared Zod schema for this route omits it, so
    // this is belt-and-braces against a future schema edit.
    if (body.override_reason_code === 'gate_wrong') {
      throw new RateLimitedError(
        'gate_wrong is set through POST /v1/prechecks/:id/label and requires burn.precheck.mark_wrong',
        'FORBIDDEN_OVERRIDE_CODE',
      );
    }

    const outcome =
      body.override_reason_code === 'mapped_manually'
        ? 'mapped'
        : body.override_reason_code === 'change_order_pending'
          ? 'change_order_raised'
          : 'absorbed';

    const [updated] = await tx
      .update(burnPrechecks)
      .set({
        override_reason_code: body.override_reason_code,
        override_reason_text: body.override_reason_text,
        overridden_by: viewer.id,
        overridden_at: new Date(),
        outcome,
      })
      .where(eq(burnPrechecks.id, id))
      .returning();
    return { data: updated };
  });
}

export interface LabelInput {
  advisory_feedback?: 'right_call' | 'would_have_mapped' | 'wrong_call';
  override_reason_code?: 'gate_wrong';
  flag_for_review?: true;
}

/**
 * ONE ROUTE, TWO AUTHORITIES (spec 2.4 point 9).
 *
 * `right_call` and `would_have_mapped` are member-writable on the caller's OWN non-enforced
 * row and FEED NOTHING -- they are UX signal and queue routing only. `wrong_call` and
 * `gate_wrong` require burn.precheck.mark_wrong and are the ONLY values in the demotion
 * numerator and the precision sample.
 *
 * Why the split exists at all: the round-2 draft rendered the feedback control INLINE on the
 * note the member expense creator sees, while gating its write route on an owner/admin
 * permission. Every member who clicked got a 403 -- and the natural fix for that UX bug is to
 * open the route to member tier, which silently evaporates the whole demotion-integrity
 * control through a change nobody reviews as security. Splitting by VALUE means the inline
 * control is genuinely usable by a member and the demotion signal still cannot be moved by
 * one.
 *
 * `canMarkWrong` is resolved by the ROUTE (permission plus the second in-route role guard)
 * and passed in, so this function cannot be called with an unchecked authority.
 */
export async function labelPrecheck(
  viewer: Viewer,
  id: string,
  body: LabelInput,
  canMarkWrong: boolean,
) {
  const wantsScoringValue =
    body.advisory_feedback === 'wrong_call' || body.override_reason_code === 'gate_wrong';
  if (wantsScoringValue && !canMarkWrong) {
    throw new RateLimitedError(
      'Setting wrong_call or gate_wrong requires burn.precheck.mark_wrong (organization owner or admin)',
      'FORBIDDEN_LABEL',
    );
  }

  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnPrechecks)
      .where(and(eq(burnPrechecks.organization_id, viewer.org_id), eq(burnPrechecks.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Precheck not found');
    if (!(await canAccessRowProject(viewer, row.project_id))) {
      throw new NotFoundError('Precheck not found');
    }

    // The member-writable values are permitted only on a NON-ENFORCED row (an advisory
    // verdict). Once a verdict actually blocked money, its label is a compliance artifact.
    if (!wantsScoringValue && row.enforced && !canMarkWrong) {
      throw new RateLimitedError(
        'This verdict was enforced. Labeling an enforced verdict requires burn.precheck.mark_wrong.',
        'FORBIDDEN_LABEL',
      );
    }

    if (body.flag_for_review) {
      // Enqueue WITHOUT labeling: the third option on the inline member control, so a member
      // never needs a 403 to express "this looks wrong".
      await tx
        .insert(burnVariances)
        .values({
          organization_id: viewer.org_id,
          engagement_id: row.engagement_id,
          chain_root_id: row.chain_root_id,
          deliverable_id: row.deliverable_id,
          variance_kind: 'unscoped_work',
          severity: 'low',
          dedup_key: `precheck_flag:${row.id}`,
          detail: { refs: [{ entity_type: 'burn.precheck', entity_id: row.id }], note: 'Flagged for review by the charge creator.' },
          status: 'open',
        })
        .onConflictDoNothing();
      return { data: { precheck_id: row.id, flagged: true } };
    }

    const values: Record<string, unknown> = {};
    if (body.advisory_feedback) values.advisory_feedback = body.advisory_feedback;
    if (body.override_reason_code) values.override_reason_code = body.override_reason_code;

    const [updated] = await tx
      .update(burnPrechecks)
      .set(values)
      .where(eq(burnPrechecks.id, id))
      .returning();
    return { data: updated };
  });
}

/** bill-api's post-commit callback (spec 6.1, POST /v1/internal/prechecks/:id/outcome). */
export async function recordOutcome(
  orgId: string,
  id: string,
  body: { outcome: string; work_ref_id?: string | null },
) {
  return runInOrgScope(orgId, async (tx) => {
    const [updated] = await tx
      .update(burnPrechecks)
      .set({
        outcome: body.outcome,
        work_ref_id: body.work_ref_id ?? undefined,
      })
      .where(and(eq(burnPrechecks.organization_id, orgId), eq(burnPrechecks.id, id)))
      .returning();
    if (!updated) throw new NotFoundError('Precheck not found');
    return { data: updated };
  });
}

// Re-exported so the service remains the single import site for gate callers.
export { deriveIdempotencyKey };
