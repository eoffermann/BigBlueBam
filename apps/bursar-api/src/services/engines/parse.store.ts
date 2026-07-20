import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { runInOrgScope } from '../../plugins/rls.js';
import { DEFAULT_DOC_LIMITS } from './parse-logic.js';
import type { ParseOutcome } from './parse.engine.js';
import type { ParseSettings } from './parse.engine.js';
import type { ScopeNodeRef } from './match-logic.js';

/**
 * The production DB layer for the deterministic offer parse (spec 4.1, M4). Split from the pure
 * engine (parse.engine.ts) so the core stays free of db/env imports and the unit suite exercises
 * the whole pipeline against Buffer fixtures. Every statement carries an explicit organization_id
 * predicate and runs under runInOrgScope so the RLS GUC binds.
 *
 * NO transaction spans the parse compute: load -> parse (pure, in the route) -> persist, each in
 * its own short org-scoped transaction, exactly like the derivation store.
 */

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 64);
}

export interface OfferForParse {
  id: string;
  request_id: string;
  organization_id: string;
  normalization_status: string | null;
  source_format: string | null;
  currency: string;
}

/** Load the offer under org scope; null when it does not exist for this org. */
export async function loadOfferForParse(orgId: string, offerId: string): Promise<OfferForParse | null> {
  return runInOrgScope(orgId, async (tx) => {
    const r = pgRows<OfferForParse>(
      await tx.execute(sql`
        SELECT id, request_id, organization_id, normalization_status, source_format, currency
          FROM bursar_offers
         WHERE id = ${offerId} AND organization_id = ${orgId}
         LIMIT 1
      `),
    )[0];
    return r ?? null;
  });
}

/** The non-archived scope nodes of a request, for structural matching. */
export async function loadRequestNodes(orgId: string, requestId: string): Promise<ScopeNodeRef[]> {
  return runInOrgScope(orgId, async (tx) => {
    return pgRows<ScopeNodeRef>(
      await tx.execute(sql`
        SELECT id, title, normative_strength
          FROM bursar_scope_nodes
         WHERE organization_id = ${orgId} AND request_id = ${requestId} AND archived_at IS NULL
      `),
    );
  });
}

/** Resolve the org's parse settings (thresholds + lexicons) with spec defaults as a fallback. */
export async function loadParseSettings(orgId: string): Promise<ParseSettings> {
  return runInOrgScope(orgId, async (tx) => {
    const row = pgRows<{
      parse_quality_floor: string;
      blanket_cumulative_cap: number;
      evidence_concentration_floor: string;
      blanket_fanout_cap: number;
      blanket_lexicon: unknown;
      exclusion_lexicon: unknown;
    }>(
      await tx.execute(sql`
        SELECT parse_quality_floor, blanket_cumulative_cap, evidence_concentration_floor,
               blanket_fanout_cap, blanket_lexicon, exclusion_lexicon
          FROM bursar_org_settings
         WHERE organization_id = ${orgId}
         LIMIT 1
      `),
    )[0];
    return {
      parse_quality_floor: row ? Number(row.parse_quality_floor) : 0.35,
      blanket_cumulative_cap: row ? Number(row.blanket_cumulative_cap) : 4,
      evidence_concentration_floor: row ? Number(row.evidence_concentration_floor) : 0.5,
      blanket_fanout_cap: row ? Number(row.blanket_fanout_cap) : 4,
      blanket_lexicon: Array.isArray(row?.blanket_lexicon) ? (row!.blanket_lexicon as string[]) : [],
      exclusion_lexicon: Array.isArray(row?.exclusion_lexicon) ? (row!.exclusion_lexicon as string[]) : [],
      limits: DEFAULT_DOC_LIMITS,
    };
  });
}

/** Transition the offer to `parsing` (the claim). The reaper reverts a stuck `parsing` offer. */
export async function claimOfferForParse(orgId: string, offerId: string): Promise<void> {
  await runInOrgScope(orgId, async (tx) => {
    await tx.execute(sql`
      UPDATE bursar_offers
         SET normalization_status = 'parsing', normalization_error = NULL, updated_at = now()
       WHERE id = ${offerId} AND organization_id = ${orgId}
    `);
  });
}

/**
 * Persist a parse outcome atomically: replace the offer's lines + matches, update the per-offer
 * counters and flags, set the terminal normalization_status, and open/refresh the
 * offer_manipulation_suspected finding when the parse quarantined the offer (spec 5.3). Reparse is
 * idempotent: existing lines/matches for the offer are deleted first, so ordinals never collide.
 */
export async function persistParseOutcome(
  orgId: string,
  offer: OfferForParse,
  outcome: ParseOutcome,
  sourceFormat: string,
  uncompressedBytes: number,
): Promise<void> {
  await runInOrgScope(orgId, async (tx) => {
    // 1. Clear prior lines (matches CASCADE from lines) for a clean reparse.
    await tx.execute(sql`
      DELETE FROM bursar_offer_lines WHERE organization_id = ${orgId} AND offer_id = ${offer.id}
    `);

    // 2. Insert the parsed lines, capturing ordinal -> id so matches can reference them.
    const ordinalToId = new Map<number, string>();
    for (const line of outcome.lines) {
      const inserted = pgRows<{ id: string; ordinal: number }>(
        await tx.execute(sql`
          INSERT INTO bursar_offer_lines (
            organization_id, offer_id, ordinal, raw_text, char_start, char_end, page,
            quantity, unit, unit_price_minor, extended_minor, currency, line_role,
            blanket_claim, exclusion_hit, parsed_by
          ) VALUES (
            ${orgId}, ${offer.id}, ${line.ordinal}, ${line.raw_text}, ${line.char_start}, ${line.char_end},
            ${line.page},
            ${line.quantity === null ? null : String(line.quantity)}::numeric, ${line.unit},
            ${line.unit_price_minor}, ${line.extended_minor}, ${line.currency}, ${line.line_role},
            ${line.blanket_claim}, ${line.exclusion_hit}, 'deterministic'
          )
          RETURNING id, ordinal
        `),
      )[0];
      if (inserted) ordinalToId.set(inserted.ordinal, inserted.id);
    }

    // 3. Insert the structural line-node matches (coverage_id null until M5 adjudicates).
    for (const m of outcome.matches) {
      const lineId = ordinalToId.get(m.offer_line_ordinal);
      if (!lineId) continue;
      await tx.execute(sql`
        INSERT INTO bursar_line_node_matches (
          organization_id, offer_line_id, scope_node_id, allocation_weight, allocation_method, match_method
        ) VALUES (
          ${orgId}, ${lineId}, ${m.scope_node_id}, ${'1.00000'}::numeric, ${'equal_split'}, ${m.match_method}
        )
        ON CONFLICT (organization_id, offer_line_id, scope_node_id) DO NOTHING
      `);
    }

    // 4. Update the offer row: counters, flags, terminal status, and audit metadata.
    await tx.execute(sql`
      UPDATE bursar_offers
         SET normalization_status = ${outcome.status},
             normalization_error = ${outcome.error},
             parse_quality = ${outcome.parse_quality === null ? null : String(outcome.parse_quality)}::numeric,
             page_count = ${outcome.page_count},
             unsubpriced_mandatory_count = ${outcome.counters.unsubpriced_mandatory_count},
             evidence_concentration = ${
               outcome.counters.evidence_concentration === null
                 ? null
                 : String(outcome.counters.evidence_concentration)
             }::numeric,
             blanket_suspected = ${outcome.blanket_suspected},
             injection_suspected = ${outcome.injection_suspected},
             injection_signals = ${JSON.stringify(outcome.injection_signals)}::jsonb,
             source_format = ${sourceFormat},
             uncompressed_bytes = ${uncompressedBytes},
             status = ${outcome.status === 'parsed' ? 'parsed' : 'received'},
             parsed_at = now(),
             updated_at = now()
       WHERE id = ${offer.id} AND organization_id = ${orgId}
    `);

    // 5. The product finding (spec 5.3). A blanket-lexicon hit, a §4.3 cap trip, or an injection
    // signal opens an offer_manipulation_suspected row, severity high, citing the span.
    if (outcome.manipulation.suspected) {
      const dedupKey = sha(`offer_manipulation_suspected|${offer.id}`);
      const details = {
        reasons: outcome.manipulation.reasons,
        cap_reasons: outcome.cap_reasons,
        unsubpriced_mandatory_count: outcome.counters.unsubpriced_mandatory_count,
        evidence_concentration: outcome.counters.evidence_concentration,
        blanket_lines: outcome.blanket_lines,
      };
      const evidenceHash = sha(JSON.stringify(details));
      await tx.execute(sql`
        INSERT INTO bursar_mismatches (
          organization_id, detector, severity, status, dedup_key, evidence_hash, request_id, offer_id,
          cited_span, details
        )
        VALUES (
          ${orgId}, 'offer_manipulation_suspected', 'high', 'open', ${dedupKey}, ${evidenceHash},
          ${offer.request_id}, ${offer.id},
          ${JSON.stringify({ spans: outcome.manipulation.spans })}::jsonb, ${JSON.stringify(details)}::jsonb
        )
        ON CONFLICT (organization_id, dedup_key) DO UPDATE SET
          status = CASE WHEN bursar_mismatches.status = 'dismissed' THEN bursar_mismatches.status ELSE 'open' END,
          evidence_hash = EXCLUDED.evidence_hash, details = EXCLUDED.details, cited_span = EXCLUDED.cited_span,
          last_seen_at = now(), updated_at = now()
      `);
    }
  });

  // Events (refs + scalars only). offer.normalized on a clean parse; offer.manipulation_suspected
  // when quarantined. Best-effort: a Bolt outage never fails the parse.
  await publishBoltEvent(
    'offer.normalized',
    'bursar',
    {
      'offer.id': offer.id,
      'request.id': offer.request_id,
      'org.id': orgId,
      status: outcome.status,
      parse_quality: outcome.parse_quality,
    },
    orgId,
  ).catch(() => {});
  if (outcome.manipulation.suspected) {
    await publishBoltEvent(
      'offer.manipulation_suspected',
      'bursar',
      {
        'offer.id': offer.id,
        'request.id': offer.request_id,
        'org.id': orgId,
        reasons: outcome.manipulation.reasons.join(','),
      },
      orgId,
    ).catch(() => {});
  }
}
