import { sql } from 'drizzle-orm';
import { runInOrgScope } from '../../plugins/rls.js';
import { computeTotals, valueGap, type GapForTotal } from './totals-logic.js';
import { makeLlmCoverageClassifier } from './leveling-classifier.js';
import type {
  EngineLine,
  LevelingStore,
  LevelingRunRow,
  OfferForLeveling,
  WindowAnswer,
} from './leveling.engine.js';
import type { AdjudicationNode } from './coverage-adjudication.js';
import type { Verdict } from './leveling-logic.js';

/**
 * The production DB store + LLM classifier for the leveling engine (spec 3.4-3.9, 4, 10, M5). Split
 * from the engine core (leveling.engine.ts) so that core stays free of db/env imports and the unit
 * suite exercises the slice loop against an in-memory store without booting the service env.
 *
 * Every mutating method opens its own short `runInOrgScope` transaction so the RLS GUC binds and the
 * CLAIM-FENCED writes are atomic. NO transaction spans an LLM round trip: the classifier call
 * happens in the engine BETWEEN store calls, never inside one. Every statement carries an explicit
 * organization_id predicate.
 */

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function mapRunRow(r: Record<string, unknown>): LevelingRunRow {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    request_id: r.request_id as string,
    status: r.status as string,
    last_processed_offer_index: Number(r.last_processed_offer_index ?? -1),
    offer_count: r.offer_count === null || r.offer_count === undefined ? null : Number(r.offer_count),
    node_count: r.node_count === null || r.node_count === undefined ? null : Number(r.node_count),
    llm_calls_used: Number(r.llm_calls_used ?? 0),
    coverage_written: Number(r.coverage_written ?? 0),
    claimed_by: (r.claimed_by as string | null) ?? null,
    heartbeat_at: r.heartbeat_at ? new Date(r.heartbeat_at as string) : null,
    max_llm_calls_per_run: Number(r.max_llm_calls_per_run ?? 250),
  };
}

const RUN_COLS = sql`id, organization_id, request_id, status, last_processed_offer_index, offer_count,
  node_count, llm_calls_used, coverage_written, claimed_by, heartbeat_at,
  COALESCE((caps_used->>'max_llm_calls_per_run')::int, 250) AS max_llm_calls_per_run`;

export function makeDbLevelingStore(): LevelingStore {
  return {
    async loadRun(orgId, runId) {
      return runInOrgScope(orgId, async (tx) => {
        const r = pgRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT ${RUN_COLS} FROM bursar_leveling_runs
             WHERE id = ${runId} AND organization_id = ${orgId} LIMIT 1
          `),
        )[0];
        return r ? mapRunRow(r) : null;
      });
    },

    async claim(orgId, runId, claimant, leaseMs) {
      const leaseSql = `${Math.round(leaseMs)} milliseconds`;
      return runInOrgScope(orgId, async (tx) => {
        const r = pgRows<Record<string, unknown>>(
          await tx.execute(sql`
            UPDATE bursar_leveling_runs
               SET claimed_by = ${claimant}, heartbeat_at = now()
             WHERE id = ${runId} AND organization_id = ${orgId} AND status = 'running'
               AND (claimed_by IS NULL OR claimed_by = ${claimant}
                    OR heartbeat_at IS NULL OR heartbeat_at < now() - ${leaseSql}::interval)
            RETURNING ${RUN_COLS}
          `),
        )[0];
        return r ? mapRunRow(r) : null;
      });
    },

    async loadOffers(orgId, requestId) {
      return runInOrgScope(orgId, async (tx) => {
        return pgRows<OfferForLeveling>(
          await tx.execute(sql`
            SELECT id AS offer_id, parse_quality, blanket_suspected, injection_suspected,
                   normalization_status, currency
              FROM bursar_offers
             WHERE organization_id = ${orgId} AND request_id = ${requestId}
             ORDER BY created_at ASC, id ASC
          `),
        ).map((o) => ({
          ...o,
          parse_quality: o.parse_quality === null || o.parse_quality === undefined ? null : Number(o.parse_quality),
        }));
      });
    },

    async loadNodes(orgId, requestId) {
      return runInOrgScope(orgId, async (tx) => {
        return pgRows<AdjudicationNode & { quantity: number | null; unit: string | null }>(
          await tx.execute(sql`
            SELECT id AS scope_node_id, parent_id, title, description, normative_strength,
                   quantity, unit
              FROM bursar_scope_nodes
             WHERE organization_id = ${orgId} AND request_id = ${requestId} AND archived_at IS NULL
               -- Rival-derived proposals stay OUT of the tree until promoted (spec 4.5): they never
               -- produce an absent and never appear in the diff while pending.
               AND NOT (derived_from = 'rival_offer' AND review_status <> 'confirmed')
             ORDER BY ordinal ASC, created_at ASC
          `),
        ).map((n) => ({ ...n, quantity: n.quantity === null || n.quantity === undefined ? null : Number(n.quantity) }));
      });
    },

    async loadLines(orgId, offerId) {
      return runInOrgScope(orgId, async (tx) => {
        return pgRows<EngineLine>(
          await tx.execute(sql`
            SELECT id AS offer_line_id, ordinal, raw_text, line_role, blanket_claim, exclusion_hit,
                   extended_minor
              FROM bursar_offer_lines
             WHERE organization_id = ${orgId} AND offer_id = ${offerId}
             ORDER BY ordinal ASC
          `),
        ).map((l) => ({
          ...l,
          ordinal: Number(l.ordinal),
          extended_minor: l.extended_minor === null || l.extended_minor === undefined ? null : Number(l.extended_minor),
        }));
      });
    },

    async loadWindowResults(orgId, runId, offerId) {
      return runInOrgScope(orgId, async (tx) => {
        const rows = pgRows<{ scope_node_id: string; verdict: string; cited_span: Record<string, unknown> }>(
          await tx.execute(sql`
            SELECT scope_node_id, verdict, cited_span
              FROM bursar_leveling_window_results
             WHERE organization_id = ${orgId} AND leveling_run_id = ${runId} AND offer_id = ${offerId}
          `),
        );
        const out = new Map<string, WindowAnswer[]>();
        for (const r of rows) {
          const span = r.cited_span ?? {};
          const answer: WindowAnswer = {
            verdict: r.verdict as Verdict,
            cited_offer_line_id: (span.cited_offer_line_id as string | null) ?? null,
            quote: (span.quote as string | null) ?? null,
            classifier_confidence: typeof span.classifier_confidence === 'number' ? span.classifier_confidence : 0.7,
            rejected_candidates: Array.isArray(span.rejected_candidates)
              ? (span.rejected_candidates as Array<{ offer_line_id: string; reason?: string }>)
              : [],
          };
          if (!out.has(r.scope_node_id)) out.set(r.scope_node_id, []);
          out.get(r.scope_node_id)!.push(answer);
        }
        return out;
      });
    },

    async writeWindowResult(orgId, runId, claimant, r) {
      return runInOrgScope(orgId, async (tx) => {
        // Fence on the claim: no live claim -> abort the slice (return false).
        const fenced = pgRows<{ id: string }>(
          await tx.execute(sql`
            SELECT id FROM bursar_leveling_runs
             WHERE id = ${runId} AND organization_id = ${orgId} AND claimed_by = ${claimant} AND status = 'running'
             FOR UPDATE
          `),
        );
        if (fenced.length === 0) return false;
        await tx.execute(sql`
          INSERT INTO bursar_leveling_window_results (
            organization_id, leveling_run_id, offer_id, scope_node_id, window_index, verdict, cited_span
          ) VALUES (
            ${orgId}, ${runId}, ${r.offer_id}, ${r.scope_node_id}, ${r.window_index}, ${r.verdict},
            ${JSON.stringify(r.cited_span)}::jsonb
          )
          ON CONFLICT (leveling_run_id, offer_id, scope_node_id, window_index, verdict) DO NOTHING
        `);
        return true;
      });
    },

    async writeCoverage(orgId, runId, claimant, offerId, result) {
      return runInOrgScope(orgId, async (tx) => {
        const fenced = pgRows<{ id: string }>(
          await tx.execute(sql`
            SELECT id FROM bursar_leveling_runs
             WHERE id = ${runId} AND organization_id = ${orgId} AND claimed_by = ${claimant} AND status = 'running'
             FOR UPDATE
          `),
        );
        if (fenced.length === 0) return false;
        await tx.execute(sql`UPDATE bursar_leveling_runs SET heartbeat_at = now() WHERE id = ${runId} AND organization_id = ${orgId}`);

        for (const d of result.decisions) {
          const verdict = d.decision.verdict;
          // The absent DB CHECK requires rejected candidates or a human decision. A demoted-absent
          // (verdict became ambiguous) is fine; a real absent carries the classifier's rejects.
          const rejected = JSON.stringify(d.rejected_candidates ?? []);
          const citedSpan = JSON.stringify({ cited_offer_line_id: d.cited_offer_line_id, quote: d.quote });
          const matchedIds = d.matched_line_ids.length > 0 ? d.matched_line_ids : null;
          await tx.execute(sql`
            INSERT INTO bursar_offer_coverage (
              organization_id, offer_id, scope_node_id, leveling_run_id, verdict, decided_by,
              matched_line_ids, cited_span, rejected_candidates, node_term_overlap,
              classifier_confidence, composite_confidence, confidence_band, review_status,
              withheld_reason, derived_covered, blanket_suspected
            ) VALUES (
              ${orgId}, ${offerId}, ${d.scope_node_id}, ${runId}, ${verdict}, 'llm',
              ${matchedIds === null ? sql`'{}'::uuid[]` : sql`${matchedIds}::uuid[]`},
              ${citedSpan}::jsonb, ${rejected}::jsonb,
              ${d.node_term_overlap === null ? null : String(d.node_term_overlap)}::numeric,
              ${String(d.classifier_confidence)}::numeric, ${String(d.composite_confidence)}::numeric,
              ${d.decision.band}, ${d.decision.reviewStatus}, ${d.decision.withheldReason},
              ${d.derived_covered}, ${false}
            )
            ON CONFLICT (organization_id, offer_id, scope_node_id) DO UPDATE SET
              leveling_run_id = EXCLUDED.leveling_run_id, verdict = EXCLUDED.verdict,
              decided_by = CASE WHEN bursar_offer_coverage.decided_by = 'human' THEN 'human' ELSE EXCLUDED.decided_by END,
              matched_line_ids = EXCLUDED.matched_line_ids, cited_span = EXCLUDED.cited_span,
              rejected_candidates = EXCLUDED.rejected_candidates, node_term_overlap = EXCLUDED.node_term_overlap,
              classifier_confidence = EXCLUDED.classifier_confidence, composite_confidence = EXCLUDED.composite_confidence,
              confidence_band = EXCLUDED.confidence_band,
              review_status = CASE WHEN bursar_offer_coverage.decided_by = 'human' THEN bursar_offer_coverage.review_status ELSE EXCLUDED.review_status END,
              withheld_reason = EXCLUDED.withheld_reason, derived_covered = EXCLUDED.derived_covered,
              updated_at = now()
          `);
        }
        // Record the leveling caps snapshot progress + count.
        await tx.execute(sql`
          UPDATE bursar_leveling_runs SET coverage_written = coverage_written + ${result.decisions.length}
           WHERE id = ${runId} AND organization_id = ${orgId} AND claimed_by = ${claimant}
        `);
        return true;
      });
    },

    async writeOfferCounters(orgId, offerId, unsubpriced, concentration) {
      await runInOrgScope(orgId, async (tx) => {
        await tx.execute(sql`
          UPDATE bursar_offers
             SET unsubpriced_mandatory_count = ${unsubpriced},
                 evidence_concentration = ${concentration === null ? null : String(concentration)}::numeric,
                 updated_at = now()
           WHERE id = ${offerId} AND organization_id = ${orgId}
        `);
      });
    },

    async writeTotals(orgId, offerId) {
      await runInOrgScope(orgId, async (tx) => {
        const offer = pgRows<{ currency: string; request_id: string }>(
          await tx.execute(sql`SELECT currency, request_id FROM bursar_offers WHERE id = ${offerId} AND organization_id = ${orgId} LIMIT 1`),
        )[0];
        if (!offer) return;
        const currency = offer.currency ?? 'USD';

        const baseRow = pgRows<{ base_only: number | null }>(
          await tx.execute(sql`
            SELECT COALESCE(SUM(extended_minor), 0) AS base_only
              FROM bursar_offer_lines
             WHERE organization_id = ${orgId} AND offer_id = ${offerId} AND line_role = 'base'
          `),
        )[0];
        const baseOnly = Number(baseRow?.base_only ?? 0);

        // Mandatory + should_have gaps for this offer, with node quantity for the rung-3 library
        // fallback. rival_median (rung 2) is cross-offer and is layered in at the request level;
        // per-offer valuation uses rung 1 (this offer's own option/allowance) and rung 3 only.
        const gapRows = pgRows<{
          scope_node_id: string;
          verdict: string;
          strength: string;
          delta_amount_minor: number | null;
          quantity: number | null;
        }>(
          await tx.execute(sql`
            SELECT c.scope_node_id, c.verdict, n.normative_strength AS strength,
                   c.delta_amount_minor, n.quantity
              FROM bursar_offer_coverage c
              JOIN bursar_scope_nodes n ON n.id = c.scope_node_id AND n.organization_id = c.organization_id
             WHERE c.organization_id = ${orgId} AND c.offer_id = ${offerId}
               AND c.verdict IN ('absent', 'excluded_explicit', 'partial')
               AND c.review_status = 'published'
          `),
        );

        const gaps: GapForTotal[] = gapRows.map((g) => ({
          scope_node_id: g.scope_node_id,
          strength: g.strength as GapForTotal['strength'],
          verdict: g.verdict,
          delta_amount_minor: g.delta_amount_minor === null || g.delta_amount_minor === undefined ? null : Number(g.delta_amount_minor),
          // Per-offer valuation has no admissible observation source at this layer (rung 1 needs a
          // priced option line attributed to the node; rung 2 is cross-offer; rung 3 needs a
          // library unit price). Absent those, the gap is `unvalued` and gap_adjusted is
          // renderable=false - the honest default (spec 10.2), never a fabricated number. The
          // request-level totals view layers in the rival_median observations.
          valuation: valueGap({ currency }),
        }));

        const totals = computeTotals({ currency, base_only_minor: baseOnly, stated_minor: null, gaps });
        for (const t of totals) {
          await tx.execute(sql`
            INSERT INTO bursar_offer_totals (
              organization_id, offer_id, total_kind, currency, amount_minor, estimated,
              unvalued_gap_count, renderable, provenance
            ) VALUES (
              ${orgId}, ${offerId}, ${t.total_kind}, ${t.currency},
              ${t.amount_minor === null ? null : t.amount_minor}, ${t.estimated},
              ${t.unvalued_gap_count}, ${t.renderable}, ${JSON.stringify(t.provenance)}::jsonb
            )
            ON CONFLICT (organization_id, offer_id, total_kind) DO UPDATE SET
              amount_minor = EXCLUDED.amount_minor, estimated = EXCLUDED.estimated,
              unvalued_gap_count = EXCLUDED.unvalued_gap_count, renderable = EXCLUDED.renderable,
              provenance = EXCLUDED.provenance, computed_at = now()
          `);
        }
      });
    },

    async checkpoint(orgId, runId, claimant, cp) {
      return runInOrgScope(orgId, async (tx) => {
        const r = pgRows<{ id: string }>(
          await tx.execute(sql`
            UPDATE bursar_leveling_runs
               SET last_processed_offer_index = ${cp.last_processed_offer_index},
                   llm_calls_used = ${cp.llm_calls_used},
                   coverage_written = ${cp.coverage_written},
                   heartbeat_at = now()
             WHERE id = ${runId} AND organization_id = ${orgId}
               AND claimed_by = ${claimant} AND status = 'running'
            RETURNING id
          `),
        );
        return r.length > 0;
      });
    },

    async finalize(orgId, runId, claimant, status, error) {
      return runInOrgScope(orgId, async (tx) => {
        const r = pgRows<{ id: string }>(
          await tx.execute(sql`
            UPDATE bursar_leveling_runs
               SET status = ${status}, error = ${error}, claimed_by = NULL, finished_at = now()
             WHERE id = ${runId} AND organization_id = ${orgId}
               AND claimed_by = ${claimant} AND status = 'running'
            RETURNING id
          `),
        );
        return r.length > 0;
      });
    },

    async release(orgId, runId, claimant) {
      await runInOrgScope(orgId, async (tx) => {
        await tx.execute(sql`
          UPDATE bursar_leveling_runs SET claimed_by = NULL
           WHERE id = ${runId} AND organization_id = ${orgId} AND claimed_by = ${claimant}
        `);
      });
    },
  };
}

export { makeLlmCoverageClassifier };
