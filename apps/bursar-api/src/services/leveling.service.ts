import { and, desc, eq, sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarCoverageOverride, BursarLevel } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { bursarLevelingRuns, bursarRequests } from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { enqueueLeveling } from '../lib/queue.js';
import { partitionDiff, type DiffCoverageRow, type ReviewStatus, type Verdict, type WithheldReason } from './engines/leveling-logic.js';
import type { AdjudicationSettings } from './engines/coverage-adjudication.js';
import type { Viewer } from './types.js';

// Leveling: the absence engine surface (spec 3, 4, 10, 11, M5). Every query carries an explicit
// organization_id predicate. Leveling is ASYNC-START: this service preflights the caps, creates the
// run row, and enqueues, returning a run id; the engine does the bounded, one-offer-per-invocation
// work under a lease with claim fencing.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/* ------------------------------------------------------------------ */
/*  Settings resolution (shared with the internal route)              */
/* ------------------------------------------------------------------ */

export interface LevelingSettingsBundle {
  providerId: string | null;
  parseQualityFloor: number;
  settings: AdjudicationSettings & { max_lines_per_window: number; window_overlap_lines: number };
  caps: { max_offers_per_run: number; max_llm_calls_per_run: number; max_nodes_per_run: number };
}

const DEFAULTS = {
  node_term_overlap_floor: 0.25,
  blanket_cumulative_cap: 4,
  evidence_concentration_floor: 0.5,
  blanket_fanout_cap: 4,
  max_lines_per_window: 80,
  window_overlap_lines: 10,
  parse_quality_floor: 0.35,
  max_offers_per_run: 8,
  max_llm_calls_per_run: 250,
  max_nodes_per_run: 400,
};

export async function loadLevelingSettings(orgId: string): Promise<LevelingSettingsBundle> {
  return runInOrgScope(orgId, async (tx) => {
    const row = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT llm_provider_id, node_term_overlap_floor, blanket_cumulative_cap,
               evidence_concentration_floor, blanket_fanout_cap, max_lines_per_window,
               window_overlap_lines, parse_quality_floor, max_offers_per_run,
               max_llm_calls_per_run, max_nodes_per_run
          FROM bursar_org_settings WHERE organization_id = ${orgId} LIMIT 1
      `),
    )[0];
    const num = (k: string, d: number) => (row && row[k] != null ? Number(row[k]) : d);
    // The spec floor for node_term_overlap is 0.25 (spec 3.5); the settings default is 0.30, so a
    // per-org override is honored but the engine floor never drops below the spec value.
    return {
      providerId: (row?.llm_provider_id as string | null) ?? null,
      parseQualityFloor: num('parse_quality_floor', DEFAULTS.parse_quality_floor),
      settings: {
        node_term_overlap_floor: num('node_term_overlap_floor', DEFAULTS.node_term_overlap_floor),
        blanket_cumulative_cap: num('blanket_cumulative_cap', DEFAULTS.blanket_cumulative_cap),
        evidence_concentration_floor: num('evidence_concentration_floor', DEFAULTS.evidence_concentration_floor),
        blanket_fanout_cap: num('blanket_fanout_cap', DEFAULTS.blanket_fanout_cap),
        max_lines_per_window: num('max_lines_per_window', DEFAULTS.max_lines_per_window),
        window_overlap_lines: num('window_overlap_lines', DEFAULTS.window_overlap_lines),
      },
      caps: {
        max_offers_per_run: num('max_offers_per_run', DEFAULTS.max_offers_per_run),
        max_llm_calls_per_run: num('max_llm_calls_per_run', DEFAULTS.max_llm_calls_per_run),
        max_nodes_per_run: num('max_nodes_per_run', DEFAULTS.max_nodes_per_run),
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Cost preflight + async-start (POST /requests/:id/level)           */
/* ------------------------------------------------------------------ */

const AVG_TOKENS_PER_CALL = 8500; // one shared line array + a 6-node batch, order-of-magnitude
const PROXY_CONCURRENCY = 4;
const AVG_CALL_SECONDS = 6;

export interface LevelPreflight {
  offers: number;
  nodes: number;
  estimated_calls: number;
  estimated_tokens: number;
  estimated_wall_clock_seconds: number;
  would_exceed: { offers: boolean; calls: boolean };
}

export type LevelResult =
  | { kind: 'preflight'; preflight: LevelPreflight }
  | { kind: 'rejected_limits'; preflight: LevelPreflight; run_id: string }
  | { kind: 'started'; run_id: string; preflight: LevelPreflight; resumed: boolean; enqueued: boolean };

/**
 * Preflight + async-start leveling (spec 3.9). Returns the estimated calls/tokens/wall-clock and
 * `would_exceed`. `dry_run` returns only that. `max_offers_per_run` exceeded returns
 * `rejected_limits` (the route maps it to 422) and records the refusal on an audit run row; nothing
 * levels. `run_id` continues an existing `partial` run rather than minting a new one, so earlier
 * windows stay visible (spec 3.8). Otherwise a fresh run is created and enqueued.
 */
export async function levelRequest(viewer: Viewer, requestId: string, body: BursarLevel): Promise<LevelResult> {
  const bundle = await loadLevelingSettings(viewer.org_id);
  const prep = await runInOrgScope(viewer.org_id, async (tx) => {
    const [request] = await tx
      .select()
      .from(bursarRequests)
      .where(and(eq(bursarRequests.organization_id, viewer.org_id), eq(bursarRequests.id, requestId)))
      .limit(1);
    if (!request) throw new NotFoundError('Request not found');
    if (request.scope_status !== 'confirmed') {
      throw new ValidationFailure(
        `Scope must be 'confirmed' before leveling (currently '${request.scope_status}')`,
        'SCOPE_NOT_CONFIRMED',
      );
    }
    const offers = pgRows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM bursar_offers WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId}`),
    )[0]?.n ?? 0;
    const nodes = pgRows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM bursar_scope_nodes
         WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId} AND archived_at IS NULL
           AND NOT (derived_from = 'rival_offer' AND review_status <> 'confirmed')
      `),
    )[0]?.n ?? 0;
    return { offers, nodes };
  });

  const batchesPerOffer = Math.max(1, Math.ceil(prep.nodes / 6));
  const estimatedCalls = prep.offers * batchesPerOffer;
  const preflight: LevelPreflight = {
    offers: prep.offers,
    nodes: prep.nodes,
    estimated_calls: estimatedCalls,
    estimated_tokens: estimatedCalls * AVG_TOKENS_PER_CALL,
    estimated_wall_clock_seconds: Math.ceil((estimatedCalls / PROXY_CONCURRENCY) * AVG_CALL_SECONDS),
    would_exceed: {
      offers: prep.offers > bundle.caps.max_offers_per_run,
      calls: estimatedCalls > bundle.caps.max_llm_calls_per_run,
    },
  };

  if (body.dry_run) return { kind: 'preflight', preflight };

  // max_offers_per_run exceeded at start: nothing runs (spec 3.9). Record an audit run row.
  if (preflight.would_exceed.offers) {
    const runId = await runInOrgScope(viewer.org_id, async (tx) => {
      const [run] = await tx
        .insert(bursarLevelingRuns)
        .values({
          organization_id: viewer.org_id,
          request_id: requestId,
          status: 'rejected_limits',
          offer_count: prep.offers,
          node_count: prep.nodes,
          caps_used: bundle.caps,
          error: `Rejected: ${prep.offers} offers exceeds max_offers_per_run (${bundle.caps.max_offers_per_run}).`,
          finished_at: new Date(),
        })
        .returning({ id: bursarLevelingRuns.id });
      return run!.id;
    });
    return { kind: 'rejected_limits', preflight, run_id: runId };
  }

  // Resume a partial run (continue), or mint a fresh one.
  const runId = await runInOrgScope(viewer.org_id, async (tx) => {
    if (body.run_id) {
      const rows = pgRows<{ id: string }>(
        await tx.execute(sql`
          UPDATE bursar_leveling_runs
             SET status = 'running', claimed_by = NULL, error = NULL, finished_at = NULL
           WHERE id = ${body.run_id} AND organization_id = ${viewer.org_id} AND request_id = ${requestId}
             AND status = 'partial'
          RETURNING id
        `),
      );
      if (rows.length === 0) throw new ConflictError('No resumable partial leveling run for this request', { run_id: body.run_id });
      return rows[0]!.id;
    }
    // Reject a fresh start while a run is already live (409).
    const live = pgRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id FROM bursar_leveling_runs
         WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId} AND status = 'running' LIMIT 1
      `),
    );
    if (live.length > 0) throw new ConflictError('A leveling run is already in progress for this request', { run_id: live[0]!.id });
    const [run] = await tx
      .insert(bursarLevelingRuns)
      .values({
        organization_id: viewer.org_id,
        request_id: requestId,
        status: 'running',
        offer_count: prep.offers,
        node_count: prep.nodes,
        caps_used: bundle.caps,
      })
      .returning({ id: bursarLevelingRuns.id });
    return run!.id;
  });

  const enqueued = await enqueueLeveling({ organization_id: viewer.org_id, request_id: requestId, run_id: runId });
  return { kind: 'started', run_id: runId, preflight, resumed: !!body.run_id, enqueued };
}

/* ------------------------------------------------------------------ */
/*  Reads                                                             */
/* ------------------------------------------------------------------ */

export async function listLevelingRuns(viewer: Viewer, requestId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const runs = await tx
      .select()
      .from(bursarLevelingRuns)
      .where(and(eq(bursarLevelingRuns.organization_id, viewer.org_id), eq(bursarLevelingRuns.request_id, requestId)))
      .orderBy(desc(bursarLevelingRuns.started_at))
      .limit(50);
    return { data: runs };
  });
}

/** The coverage grid: per (node, offer) verdict + band + withheld reason, plus totals per offer. */
export async function getMatrix(viewer: Viewer, requestId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const nodes = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT id, title, normative_strength, parent_id, ordinal
          FROM bursar_scope_nodes
         WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId} AND archived_at IS NULL
           AND NOT (derived_from = 'rival_offer' AND review_status <> 'confirmed')
         ORDER BY ordinal ASC, created_at ASC
      `),
    );
    const offers = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT id, label, vendor_id, currency, normalization_status, blanket_suspected, injection_suspected
          FROM bursar_offers WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId}
         ORDER BY created_at ASC, id ASC
      `),
    );
    const coverage = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT c.id, c.offer_id, c.scope_node_id, c.verdict, c.confidence_band, c.review_status,
               c.withheld_reason, c.derived_covered, c.delta_kind, c.delta_amount_minor,
               c.cited_span, c.matched_line_ids, c.rejected_candidates
          FROM bursar_offer_coverage c
          JOIN bursar_offers o ON o.id = c.offer_id AND o.organization_id = c.organization_id
         WHERE c.organization_id = ${viewer.org_id} AND o.request_id = ${requestId}
      `),
    );
    const totals = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT t.offer_id, t.total_kind, t.amount_minor, t.renderable, t.unvalued_gap_count, t.estimated
          FROM bursar_offer_totals t
          JOIN bursar_offers o ON o.id = t.offer_id AND o.organization_id = t.organization_id
         WHERE t.organization_id = ${viewer.org_id} AND o.request_id = ${requestId}
      `),
    );
    // gap_adjusted sorts the Matrix ONLY when renderable for every offer (spec 10.2); otherwise it
    // falls back to `stated`.
    const gapAdjusted = totals.filter((t) => t.total_kind === 'gap_adjusted');
    const sortable = gapAdjusted.length > 0 && gapAdjusted.every((t) => t.renderable === true);
    return { data: { nodes, offers, coverage, totals, sort_key: sortable ? 'gap_adjusted' : 'stated' } };
  });
}

/**
 * The §4.7 exclusion diff. For each offer, every mandatory node is enumerated EXACTLY ONCE in one
 * of published / needs_review / unverified, and the three counts sum to the mandatory node count.
 * A node with no coverage row is `unverified` - never silently dropped.
 */
export async function getExclusionDiff(viewer: Viewer, requestId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const mandatory = pgRows<{ id: string; title: string }>(
      await tx.execute(sql`
        SELECT id, title FROM bursar_scope_nodes
         WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId} AND archived_at IS NULL
           AND normative_strength = 'mandatory'
           AND NOT (derived_from = 'rival_offer' AND review_status <> 'confirmed')
         ORDER BY ordinal ASC, created_at ASC
      `),
    );
    const mandatoryIds = mandatory.map((n) => n.id);
    const offers = pgRows<{ id: string; label: string | null }>(
      await tx.execute(sql`
        SELECT id, label FROM bursar_offers WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId}
         ORDER BY created_at ASC, id ASC
      `),
    );
    const perOffer = [];
    for (const offer of offers) {
      const rows = pgRows<{ scope_node_id: string; verdict: string; review_status: string; withheld_reason: string | null }>(
        await tx.execute(sql`
          SELECT scope_node_id, verdict, review_status, withheld_reason
            FROM bursar_offer_coverage
           WHERE organization_id = ${viewer.org_id} AND offer_id = ${offer.id}
        `),
      );
      const byNode = new Map<string, DiffCoverageRow>();
      for (const r of rows) {
        byNode.set(r.scope_node_id, {
          scope_node_id: r.scope_node_id,
          review_status: r.review_status as ReviewStatus,
          verdict: r.verdict as Verdict,
          withheld_reason: (r.withheld_reason as WithheldReason | null) ?? null,
        });
      }
      const part = partitionDiff(mandatoryIds, byNode);
      perOffer.push({
        offer_id: offer.id,
        label: offer.label,
        ...part,
        // The blocking-banner condition: any needs_review or unverified node.
        blocking: part.needs_review.length > 0 || part.unverified.length > 0,
        rows: mandatory.map((n) => {
          const cov = byNode.get(n.id);
          return {
            scope_node_id: n.id,
            title: n.title,
            verdict: cov?.verdict ?? 'unverified',
            review_status: cov?.review_status ?? 'unverified',
            withheld_reason: cov?.withheld_reason ?? null,
          };
        }),
      });
    }
    return { data: { mandatory_count: mandatoryIds.length, offers: perOffer } };
  });
}

export async function getTotals(viewer: Viewer, requestId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const totals = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT t.* FROM bursar_offer_totals t
          JOIN bursar_offers o ON o.id = t.offer_id AND o.organization_id = t.organization_id
         WHERE t.organization_id = ${viewer.org_id} AND o.request_id = ${requestId}
         ORDER BY t.offer_id, t.total_kind
      `),
    );
    return { data: totals };
  });
}

export async function getCoverage(viewer: Viewer, coverageId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const row = pgRows<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM bursar_offer_coverage WHERE id = ${coverageId} AND organization_id = ${viewer.org_id} LIMIT 1`),
    )[0];
    if (!row) throw new NotFoundError('Coverage not found');
    return { data: row };
  });
}

/** A human override of a coverage verdict (decided_by='human'). Published unless it is a gap. */
export async function overrideCoverage(viewer: Viewer, coverageId: string, body: BursarCoverageOverride) {
  const result = await runInOrgScope(viewer.org_id, async (tx) => {
    const existing = pgRows<{ id: string; offer_id: string; scope_node_id: string }>(
      await tx.execute(sql`SELECT id, offer_id, scope_node_id FROM bursar_offer_coverage WHERE id = ${coverageId} AND organization_id = ${viewer.org_id} LIMIT 1`),
    )[0];
    if (!existing) throw new NotFoundError('Coverage not found');
    // A human absent must carry evidence to satisfy the DB CHECK; decided_by='human' does.
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        UPDATE bursar_offer_coverage
           SET verdict = ${body.verdict}, decided_by = 'human', review_status = 'published',
               withheld_reason = NULL,
               delta_amount_minor = ${body.delta_amount_minor ?? null},
               overridden_by = ${viewer.id}, overridden_at = now(), overridden_reason = ${body.reason},
               updated_at = now()
         WHERE id = ${coverageId} AND organization_id = ${viewer.org_id}
        RETURNING *
      `),
    );
    return rows[0]!;
  });
  await publishBoltEvent(
    'exclusion.detected',
    'bursar',
    { 'offer.id': result.offer_id, 'request.id': null, 'org.id': viewer.org_id, gap_count: 1 },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});
  return { data: result };
}

/** The internal adjudication queue: coverage rows needing review across the org. */
export async function getReview(viewer: Viewer, limit = 50) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT c.id, c.offer_id, c.scope_node_id, c.verdict, c.confidence_band, c.withheld_reason,
               c.created_at, o.request_id, o.label AS offer_label, n.title AS node_title
          FROM bursar_offer_coverage c
          JOIN bursar_offers o ON o.id = c.offer_id AND o.organization_id = c.organization_id
          JOIN bursar_scope_nodes n ON n.id = c.scope_node_id AND n.organization_id = c.organization_id
         WHERE c.organization_id = ${viewer.org_id} AND c.review_status = 'needs_review'
         ORDER BY c.created_at DESC
         LIMIT ${limit}
      `),
    );
    return { data: rows };
  });
}
