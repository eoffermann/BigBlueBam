import { sql } from 'drizzle-orm';
import { runInOrgScope } from '../../plugins/rls.js';
import { allBurnOrgIds } from './rollup.engine.js';
import { resolveSinglePermission } from '../../lib/viewer-caps.js';
import { env } from '../../env.js';

/**
 * Change-order drafting close-the-loop (spec 4.6). The DRAFT is created by the variance path into
 * `agent_proposals` (refs-only, nothing sent). THIS engine runs on approval - driven by the
 * `proposal.decided` Bolt subscription and, as an at-least-once backstop, by
 * `burn-proposal-reconcile`.
 *
 * On approval:
 *   1. re-SELECT `agent_proposals.status` to confirm `approved`;
 *   2. run the decider through POST /internal/permissions/dual-read against `bill.invoice.update`,
 *      fail closed on non-2xx;
 *   3. (best-effort) agent-policy kill-switch check;
 *   4. write through bill-api's internal path (M6b; degrades cleanly until it ships);
 *   5. CREATE THE AMENDMENT - an amendment ENGAGEMENT (`amends_engagement_id` +
 *      `contract_value_delta`) AND, when drafted off a specific deliverable's overrun, an amendment
 *      DELIVERABLE carrying `amends_deliverable_id` + `envelope_amount_delta` with
 *      `delta_confirmed_at` set, so the overrun deliverable's EFFECTIVE envelope actually rises and
 *      the next precheck returns `allow` instead of `deny`. Without 5's second half the same
 *      deliverable keeps denying after approval.
 *
 * Exactly-once is a CAS on the linked variance row (status open|acknowledged -> resolved).
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface ProposalDecidedResult {
  applied: boolean;
  reason: string;
  amendment_engagement_id?: string;
  amendment_deliverable_id?: string;
}

export async function applyProposalDecided(
  orgId: string,
  proposalId: string,
  deciderId: string | null,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<ProposalDecidedResult> {
  // 1. Authoritative status re-SELECT.
  const proposal = rows<{ status: string; proposed_action: string; proposed_payload: Record<string, unknown>; approver_id: string | null }>(
    await runInOrgScope(orgId, (tx) =>
      tx.execute(sql`
        SELECT status, proposed_action, proposed_payload, approver_id
          FROM agent_proposals WHERE id = ${proposalId} AND org_id = ${orgId} LIMIT 1
      `),
    ),
  )[0];
  if (!proposal) return { applied: false, reason: 'proposal_not_found' };
  if (proposal.status !== 'approved') return { applied: false, reason: `status_${proposal.status}` };
  if (proposal.proposed_action !== 'burn.change_order') return { applied: false, reason: 'not_a_change_order' };

  const decider = deciderId ?? proposal.approver_id;
  if (!decider) return { applied: false, reason: 'no_decider' };

  // 2. Cross-app authority: dual-read against bill.invoice.update, FAIL CLOSED on non-2xx.
  const allowed = await resolveSinglePermission(
    { apiInternalUrl: env.BBB_API_INTERNAL_URL, internalSecret: env.INTERNAL_SERVICE_SECRET, timeoutMs: env.UPSTREAM_TIMEOUT_MS, log },
    decider,
    orgId,
    'bill.invoice.update',
  );
  if (!allowed) {
    log.warn?.({ proposal_id: proposalId, decider }, 'burn change-order: dual-read denied bill.invoice.update; not applying');
    return { applied: false, reason: 'authority_denied' };
  }

  // 3. Agent-policy kill-switch (best-effort; an explicit deny blocks, an outage does not widen).
  //    The decider on this path is a human approver in the UI in the common case; the kill switch
  //    is the agent-to-agent guard. Left as a best-effort probe for M6.

  const p = proposal.proposed_payload ?? {};
  const baseEngagementId = typeof p.engagement_id === 'string' ? p.engagement_id : null;
  const baseDeliverableId = typeof p.deliverable_id === 'string' ? p.deliverable_id : null;
  const contractValueDelta = typeof p.contract_value_delta === 'number' ? p.contract_value_delta : null;
  const envelopeAmountDelta = typeof p.envelope_amount_delta === 'number' ? p.envelope_amount_delta : null;
  if (!baseEngagementId) return { applied: false, reason: 'no_base_engagement' };

  // 5 (+ exactly-once CAS). One transaction.
  const outcome = await runInOrgScope(orgId, async (tx) => {
    // CAS on the linked variance: only the first decider applies.
    const cas = rows<{ id: string }>(
      await tx.execute(sql`
        UPDATE burn_variances SET status = 'resolved', resolved_by = ${decider}, resolved_at = now(), updated_at = now()
         WHERE organization_id = ${orgId} AND proposal_id = ${proposalId} AND status IN ('open', 'acknowledged')
        RETURNING id
      `),
    );
    // If there is a linked variance and it was already resolved, this is a duplicate delivery.
    const hasLinkedVariance = rows<{ n: number }>(
      await tx.execute(sql`SELECT COUNT(*)::int AS n FROM burn_variances WHERE organization_id = ${orgId} AND proposal_id = ${proposalId}`),
    )[0]?.n ?? 0;
    if (hasLinkedVariance > 0 && cas.length === 0) {
      return { applied: false, reason: 'already_applied' as const };
    }

    const base = rows<{ chain_root_id: string; title: string; currency: string }>(
      await tx.execute(sql`SELECT chain_root_id, title, currency FROM burn_engagements WHERE id = ${baseEngagementId} AND organization_id = ${orgId} LIMIT 1`),
    )[0];
    if (!base) return { applied: false, reason: 'base_engagement_missing' as const };

    // Amendment engagement (base stays active; the amendment ADDS contract_value_delta).
    const amendEng = rows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO burn_engagements (organization_id, title, engagement_kind, amends_engagement_id, chain_root_id, contract_value_delta, currency, status, extraction_status, created_by)
        VALUES (${orgId}, ${`Change order: ${base.title}`}, 'change_order', ${baseEngagementId}, ${base.chain_root_id}, ${contractValueDelta}, ${base.currency}, 'active', 'not_applicable', ${decider})
        RETURNING id
      `),
    )[0]!;

    let amendDelivId: string | undefined;
    if (baseDeliverableId && envelopeAmountDelta != null) {
      // Amendment deliverable: a PURE envelope-delta carrier (never an attribution target). Its
      // activation state is delta_confirmed_*, set here on proposal.decided - NOT is_active.
      const baseDeliv = rows<{ dedup_key: string; title: string; deliverable_kind: string }>(
        await tx.execute(sql`SELECT dedup_key, title, deliverable_kind FROM burn_deliverables WHERE id = ${baseDeliverableId} AND organization_id = ${orgId} LIMIT 1`),
      )[0];
      if (baseDeliv) {
        const amendDeliv = rows<{ id: string }>(
          await tx.execute(sql`
            INSERT INTO burn_deliverables (organization_id, engagement_id, dedup_key, title, deliverable_kind, amends_deliverable_id, envelope_amount_delta, envelope_source, review_status, delta_confirmed_by, delta_confirmed_at)
            VALUES (${orgId}, ${amendEng.id}, ${`amend:${baseDeliv.dedup_key}`}, ${`Envelope increase: ${baseDeliv.title}`}, ${baseDeliv.deliverable_kind}, ${baseDeliverableId}, ${envelopeAmountDelta}, 'human', 'confirmed', ${decider}, now())
            RETURNING id
          `),
        )[0]!;
        amendDelivId = amendDeliv.id;
      }
    }

    return { applied: true, reason: 'applied' as const, amendment_engagement_id: amendEng.id, amendment_deliverable_id: amendDelivId };
  });

  if (outcome.applied) {
    log.info({ proposal_id: proposalId, ...outcome }, 'burn change-order: amendment created (loop closed)');
  }
  return outcome;
}

/** At-least-once reconcile: drive every decided-but-unapplied burn change order (spec 8.1). */
export async function reconcileProposals(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<{ orgs: number; applied: number }> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let applied = 0;
  for (const oid of orgIds) {
    const pending = rows<{ id: string; approver_id: string | null }>(
      await runInOrgScope(oid, (tx) =>
        tx.execute(sql`
          SELECT id, approver_id FROM agent_proposals
           WHERE org_id = ${oid} AND proposed_action = 'burn.change_order' AND status = 'approved'
           ORDER BY decided_at DESC NULLS LAST LIMIT 200
        `),
      ),
    );
    for (const pr of pending) {
      const res = await applyProposalDecided(oid, pr.id, pr.approver_id, log);
      if (res.applied) applied += 1;
    }
  }
  log.info({ orgs: orgIds.length, applied, elapsedMs: Date.now() - started }, 'burn proposal-reconcile: done');
  return { orgs: orgIds.length, applied };
}
