import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarAwardAmend, BursarAwardCreate, BursarAwardTerminate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  bursarAwards,
  bursarBaselineItems,
  bursarBaselineItemNodes,
  bursarRequests,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import {
  awardLinkSpecs,
  bulwarkHandoffDeepLink,
  upsertBursarEntityLinks,
} from '../lib/entity-links.js';
import {
  baselineHash,
  baselineKindCounts,
  composeBaseline,
  amendAwardChain,
  freshAwardChain,
  type BaselineCoverageInput,
  type BaselineItemSpec,
  type BaselineLineInput,
  type BaselineNodeInput,
  type CoverageVerdict,
} from './award-logic.js';
import type { Viewer } from './types.js';

// Awards + baseline freeze (spec 7, M7). Every query carries an explicit organization_id
// predicate. The freeze runs in ONE runInOrgScope transaction: insert the award, COPY the
// awarded offer's per-node coverage into an immutable baseline (included + excluded_at_award +
// absent_at_award), link nodes, stamp the coverage verdict at award, compute baseline_hash, set
// the request `awarded`, write entity_links, then (after commit) publish award.recorded +
// baseline.frozen. There is NO baseline write path: bursar_baseline_items is insert-only and the
// migration 0249 four-path triggers make it undeletable/unupdatable.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// A leveling run holds a LIVE lease when it is `running` and its lease has not lapsed: a fresh
// heartbeat, or (not yet claimed) a recent start. Matches the reaper's 5-minute lease
// (DEFAULT_REAPER_LEASE_MS): a stale abandoned run is reapable, not live, and does NOT block an
// award. Awarding while the absence engine is mid-run would freeze a baseline the engine is
// still writing, so this is a hard 409 (spec 7.1).
async function assertNoLiveLease(tx: DbTx, orgId: string, requestId: string): Promise<void> {
  const live = pgRows<{ id: string }>(
    await tx.execute(sql`
      SELECT id FROM bursar_leveling_runs
       WHERE organization_id = ${orgId} AND request_id = ${requestId}
         AND status = 'running'
         AND (
           (heartbeat_at IS NOT NULL AND heartbeat_at > now() - interval '5 minutes')
           OR (heartbeat_at IS NULL AND started_at > now() - interval '5 minutes')
         )
       LIMIT 1
    `),
  );
  if (live.length > 0) {
    throw new ConflictError(
      'A leveling run holds a live lease on this request; award is blocked until it finishes or its lease expires',
      { run_id: live[0]!.id },
    );
  }
}

interface FreezeParams {
  requestId: string;
  offerId: string;
  vendorId: string | null;
  currency: string;
  termStart: string | null;
  termEnd: string | null;
  autoRenew: boolean;
  renewalNoticeDays: number | null;
  timezone: string;
  contractBinAssetId: string | null;
  predecessor: { id: string; chain_root_id: string } | null;
}

interface FrozenAward {
  award: typeof bursarAwards.$inferSelect;
  counts: ReturnType<typeof baselineKindCounts>;
  itemCount: number;
  handoff: { entity_link: string; deep_link: string };
}

/**
 * The freeze, shared by recordAward and amendAward. Reads the awarded offer's coverage over the
 * request's active scope nodes, composes the immutable baseline, and persists award + baseline +
 * node links + entity_links inside the caller's transaction. Returns the award row and the
 * three-way baseline counts. Publishing is done by the caller AFTER commit.
 */
async function freezeAward(tx: DbTx, viewer: Viewer, p: FreezeParams): Promise<FrozenAward> {
  const orgId = viewer.org_id;

  // Nodes considered for the baseline: the same active, confirmed-or-request node set the matrix
  // and diff use, so `included + excluded_at_award + absent_at_award == node count` holds.
  const nodes = pgRows<{
    id: string;
    ordinal: number;
    title: string;
    description: string | null;
    unit: string | null;
    quantity: string | null;
  }>(
    await tx.execute(sql`
      SELECT id, ordinal, title, description, unit, quantity
        FROM bursar_scope_nodes
       WHERE organization_id = ${orgId} AND request_id = ${p.requestId} AND archived_at IS NULL
         AND NOT (derived_from = 'rival_offer' AND review_status <> 'confirmed')
       ORDER BY ordinal ASC, created_at ASC
    `),
  );

  const coverage = pgRows<{
    scope_node_id: string;
    verdict: string;
    matched_line_ids: string[] | null;
    cited_span: unknown;
    delta_kind: string | null;
    delta_amount_minor: number | null;
  }>(
    await tx.execute(sql`
      SELECT scope_node_id, verdict, matched_line_ids, cited_span, delta_kind, delta_amount_minor
        FROM bursar_offer_coverage
       WHERE organization_id = ${orgId} AND offer_id = ${p.offerId}
    `),
  );

  const lines = pgRows<{
    id: string;
    unit: string | null;
    quantity: string | null;
    unit_price_minor: number | null;
    extended_minor: number | null;
    currency: string | null;
  }>(
    await tx.execute(sql`
      SELECT id, unit, quantity, unit_price_minor, extended_minor, currency
        FROM bursar_offer_lines
       WHERE organization_id = ${orgId} AND offer_id = ${p.offerId}
    `),
  );

  const nodeInputs: BaselineNodeInput[] = nodes.map((n) => ({
    id: n.id,
    ordinal: n.ordinal,
    title: n.title,
    description: n.description,
    unit: n.unit,
    quantity: n.quantity,
  }));
  const coverageInputs: BaselineCoverageInput[] = coverage.map((c) => ({
    scope_node_id: c.scope_node_id,
    verdict: c.verdict as CoverageVerdict,
    matched_line_ids: c.matched_line_ids,
    cited_span: c.cited_span,
    delta_kind: c.delta_kind,
    delta_amount_minor: c.delta_amount_minor,
  }));
  const lineInputs: BaselineLineInput[] = lines.map((l) => ({
    id: l.id,
    unit: l.unit,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    extended_minor: l.extended_minor,
    currency: l.currency,
  }));

  const items = composeBaseline({
    nodes: nodeInputs,
    coverage: coverageInputs,
    lines: lineInputs,
    currency: p.currency,
  });
  const counts = baselineKindCounts(items);

  const awardId = randomUUID();
  const chain = p.predecessor ? amendAwardChain(awardId, p.predecessor) : freshAwardChain(awardId);
  const hash = baselineHash(items, {
    request_id: p.requestId,
    offer_id: p.offerId,
    currency: p.currency,
    term_start: p.termStart,
    term_end: p.termEnd,
  });

  const [award] = await tx
    .insert(bursarAwards)
    .values({
      id: awardId,
      organization_id: orgId,
      request_id: p.requestId,
      offer_id: p.offerId,
      vendor_id: p.vendorId,
      supersedes_award_id: chain.supersedes_award_id,
      chain_root_id: chain.chain_root_id,
      baseline_hash: hash,
      currency: p.currency,
      term_start: p.termStart,
      term_end: p.termEnd,
      auto_renew: p.autoRenew,
      renewal_notice_days: p.renewalNoticeDays,
      timezone: p.timezone,
      contract_bin_asset_id: p.contractBinAssetId,
      status: 'active',
      awarded_by: viewer.id,
    })
    .returning();

  // COPY every accepted line (including excluded_at_award and absent_at_award) into the FROZEN
  // ledger. Client-side ids so the node links can be built without a second round trip per item.
  const withIds = items.map((it) => ({ id: randomUUID(), spec: it as BaselineItemSpec }));
  if (withIds.length > 0) {
    await tx.insert(bursarBaselineItems).values(
      withIds.map(({ id, spec }) => ({
        id,
        organization_id: orgId,
        award_id: awardId,
        ordinal: spec.ordinal,
        kind: spec.kind,
        title: spec.title,
        description: spec.description,
        unit: spec.unit,
        quantity: spec.quantity,
        unit_price_minor: spec.unit_price_minor,
        extended_minor: spec.extended_minor,
        currency: spec.currency,
        delta_kind: spec.delta_kind,
        delta_amount_minor: spec.delta_amount_minor,
        coverage_verdict_at_award: spec.coverage_verdict_at_award,
        source_offer_line_id: spec.source_offer_line_id,
        cited_span: spec.cited_span as Record<string, unknown>,
      })),
    );
    const nodeLinks = withIds.flatMap(({ id, spec }) =>
      spec.node_ids.map((nid) => ({
        organization_id: orgId,
        baseline_item_id: id,
        scope_node_id: nid,
      })),
    );
    if (nodeLinks.length > 0) {
      await tx.insert(bursarBaselineItemNodes).values(nodeLinks).onConflictDoNothing();
    }
  }

  // The request enters `awarded` (spec 7.1).
  await tx
    .update(bursarRequests)
    .set({ scope_status: 'awarded', updated_at: new Date() })
    .where(and(eq(bursarRequests.organization_id, orgId), eq(bursarRequests.id, p.requestId)));

  // Amendment: flip the predecessor to `superseded` in the SAME transaction (spec 7.2).
  if (p.predecessor) {
    await tx
      .update(bursarAwards)
      .set({ status: 'superseded', superseded_at: new Date(), updated_at: new Date() })
      .where(and(eq(bursarAwards.organization_id, orgId), eq(bursarAwards.id, p.predecessor.id)));
  }

  // entity_links in the same transaction (spec 16.3). Includes the Bulwark handoff edge.
  await upsertBursarEntityLinks(
    tx,
    orgId,
    viewer.id,
    awardLinkSpecs({
      awardId,
      requestId: p.requestId,
      offerId: p.offerId,
      vendorId: p.vendorId,
      contractBinAssetId: p.contractBinAssetId,
    }),
  );

  return {
    award: award!,
    counts,
    itemCount: items.length,
    handoff: {
      entity_link: 'bursar.award -> bin.asset',
      deep_link: bulwarkHandoffDeepLink({ awardId, contractBinAssetId: p.contractBinAssetId }),
    },
  };
}

/** Load an offer scoped to the request, returning its default vendor/currency. */
async function loadAwardableOffer(tx: DbTx, orgId: string, requestId: string, offerId: string) {
  const row = pgRows<{ id: string; vendor_id: string | null; currency: string | null }>(
    await tx.execute(sql`
      SELECT id, vendor_id, currency FROM bursar_offers
       WHERE organization_id = ${orgId} AND id = ${offerId} AND request_id = ${requestId}
       LIMIT 1
    `),
  )[0];
  if (!row) throw new NotFoundError('Offer not found for this request');
  return row;
}

async function publishFreeze(viewer: Viewer, requestId: string, frozen: FrozenAward): Promise<void> {
  await publishBoltEvent(
    'award.recorded',
    'bursar',
    {
      'award.id': frozen.award.id,
      'request.id': requestId,
      'vendor.id': frozen.award.vendor_id,
      'org.id': viewer.org_id,
    },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});
  await publishBoltEvent(
    'baseline.frozen',
    'bursar',
    {
      'award.id': frozen.award.id,
      'request.id': requestId,
      'org.id': viewer.org_id,
      item_count: frozen.itemCount,
      included: frozen.counts.included,
      excluded_at_award: frozen.counts.excluded_at_award,
      absent_at_award: frozen.counts.absent_at_award,
    },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  POST /awards                                                      */
/* ------------------------------------------------------------------ */

export async function recordAward(viewer: Viewer, body: BursarAwardCreate) {
  const frozen = await runInOrgScope(viewer.org_id, async (tx) => {
    const [request] = await tx
      .select()
      .from(bursarRequests)
      .where(and(eq(bursarRequests.organization_id, viewer.org_id), eq(bursarRequests.id, body.request_id)))
      .limit(1);
    if (!request) throw new NotFoundError('Request not found');
    if (request.scope_status !== 'confirmed') {
      throw new ValidationFailure(
        `Scope must be 'confirmed' before an award can be recorded (currently '${request.scope_status}'). Use amend to supersede an existing award.`,
        'SCOPE_NOT_CONFIRMED',
      );
    }
    await assertNoLiveLease(tx, viewer.org_id, body.request_id);
    const offer = await loadAwardableOffer(tx, viewer.org_id, body.request_id, body.offer_id);
    return freezeAward(tx, viewer, {
      requestId: body.request_id,
      offerId: body.offer_id,
      vendorId: body.vendor_id ?? offer.vendor_id ?? null,
      currency: body.currency ?? offer.currency ?? request.currency,
      termStart: body.term_start ?? null,
      termEnd: body.term_end ?? null,
      autoRenew: body.auto_renew,
      renewalNoticeDays: body.renewal_notice_days ?? null,
      timezone: body.timezone,
      contractBinAssetId: body.contract_bin_asset_id ?? null,
      predecessor: null,
    });
  });
  await publishFreeze(viewer, body.request_id, frozen);
  return { data: frozen.award, baseline_counts: frozen.counts, bulwark_handoff: frozen.handoff };
}

/* ------------------------------------------------------------------ */
/*  POST /awards/:id/amend                                            */
/* ------------------------------------------------------------------ */

export async function amendAward(viewer: Viewer, awardId: string, body: BursarAwardAmend) {
  const result = await runInOrgScope(viewer.org_id, async (tx) => {
    const [predecessor] = await tx
      .select()
      .from(bursarAwards)
      .where(and(eq(bursarAwards.organization_id, viewer.org_id), eq(bursarAwards.id, awardId)))
      .limit(1);
    if (!predecessor) throw new NotFoundError('Award not found');
    if (predecessor.status !== 'active') {
      throw new ValidationFailure(
        `Only an active award can be amended (this one is '${predecessor.status}').`,
        'AWARD_NOT_ACTIVE',
      );
    }
    await assertNoLiveLease(tx, viewer.org_id, predecessor.request_id);
    const offerId = body.offer_id ?? predecessor.offer_id;
    if (!offerId) throw new ValidationFailure('An amendment needs an offer to freeze', 'NO_OFFER');
    const offer = await loadAwardableOffer(tx, viewer.org_id, predecessor.request_id, offerId);
    return freezeAward(tx, viewer, {
      requestId: predecessor.request_id,
      offerId,
      vendorId: body.vendor_id !== undefined ? body.vendor_id : predecessor.vendor_id ?? offer.vendor_id ?? null,
      currency: body.currency ?? predecessor.currency,
      termStart: body.term_start !== undefined ? body.term_start : predecessor.term_start,
      termEnd: body.term_end !== undefined ? body.term_end : predecessor.term_end,
      autoRenew: body.auto_renew ?? predecessor.auto_renew,
      renewalNoticeDays:
        body.renewal_notice_days !== undefined ? body.renewal_notice_days : predecessor.renewal_notice_days,
      timezone: body.timezone ?? predecessor.timezone,
      contractBinAssetId:
        body.contract_bin_asset_id !== undefined ? body.contract_bin_asset_id : predecessor.contract_bin_asset_id,
      predecessor: { id: predecessor.id, chain_root_id: predecessor.chain_root_id },
    });
  });
  await publishFreeze(viewer, result.award.request_id, result);
  return { data: result.award, baseline_counts: result.counts, bulwark_handoff: result.handoff };
}

/* ------------------------------------------------------------------ */
/*  POST /awards/:id/terminate                                        */
/* ------------------------------------------------------------------ */

export async function terminateAward(viewer: Viewer, awardId: string, body: BursarAwardTerminate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [award] = await tx
      .select()
      .from(bursarAwards)
      .where(and(eq(bursarAwards.organization_id, viewer.org_id), eq(bursarAwards.id, awardId)))
      .limit(1);
    if (!award) throw new NotFoundError('Award not found');
    if (award.status !== 'active') {
      throw new ValidationFailure(
        `Only an active award can be terminated (this one is '${award.status}').`,
        'AWARD_NOT_ACTIVE',
      );
    }
    const [updated] = await tx
      .update(bursarAwards)
      .set({
        status: 'terminated',
        terminated_at: new Date(),
        terminated_by: viewer.id,
        terminated_reason: body.reason,
        updated_at: new Date(),
      })
      .where(and(eq(bursarAwards.organization_id, viewer.org_id), eq(bursarAwards.id, awardId)))
      .returning();
    return { data: updated! };
  });
}

/* ------------------------------------------------------------------ */
/*  Reads                                                             */
/* ------------------------------------------------------------------ */

export interface AwardListParams {
  cursor?: string;
  limit: number;
  status?: string;
  requestId?: string;
  vendorId?: string;
}

export async function listAwards(viewer: Viewer, params: AwardListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cur = decodeCursor(params.cursor);
    const conds = [eq(bursarAwards.organization_id, viewer.org_id)];
    if (params.status) conds.push(eq(bursarAwards.status, params.status));
    if (params.requestId) conds.push(eq(bursarAwards.request_id, params.requestId));
    if (params.vendorId) conds.push(eq(bursarAwards.vendor_id, params.vendorId));
    if (cur) {
      conds.push(
        or(
          lt(bursarAwards.created_at, new Date(cur.createdAt)),
          and(eq(bursarAwards.created_at, new Date(cur.createdAt)), lt(bursarAwards.id, cur.id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(bursarAwards)
      .where(and(...conds))
      .orderBy(desc(bursarAwards.created_at), desc(bursarAwards.id))
      .limit(params.limit + 1);
    const { items, next_cursor } = paginate(rows, params.limit);
    return { data: items, next_cursor };
  });
}

export async function getAward(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(bursarAwards)
      .where(and(eq(bursarAwards.organization_id, viewer.org_id), eq(bursarAwards.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Award not found');
    return { data: row };
  });
}

/** GET /awards/:id/baseline. The FROZEN ledger, read-only, with the node links for each item. */
export async function getAwardBaseline(viewer: Viewer, awardId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [award] = await tx
      .select()
      .from(bursarAwards)
      .where(and(eq(bursarAwards.organization_id, viewer.org_id), eq(bursarAwards.id, awardId)))
      .limit(1);
    if (!award) throw new NotFoundError('Award not found');
    const items = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT i.*, COALESCE(
                 (SELECT array_agg(n.scope_node_id)
                    FROM bursar_baseline_item_nodes n
                   WHERE n.organization_id = i.organization_id AND n.baseline_item_id = i.id),
                 '{}'
               ) AS scope_node_ids
          FROM bursar_baseline_items i
         WHERE i.organization_id = ${viewer.org_id} AND i.award_id = ${awardId}
         ORDER BY i.ordinal ASC, i.created_at ASC
      `),
    );
    return {
      data: {
        award,
        baseline_hash: award.baseline_hash,
        items,
        counts: {
          included: items.filter((i) => i.kind === 'included').length,
          excluded_at_award: items.filter((i) => i.kind === 'excluded_at_award').length,
          absent_at_award: items.filter((i) => i.kind === 'absent_at_award').length,
          total: items.length,
        },
      },
    };
  });
}
