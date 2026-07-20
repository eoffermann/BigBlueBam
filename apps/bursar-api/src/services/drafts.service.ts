import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarDraftCreate, BursarDraftDecision, BursarDraftKind } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import { buildDraftGrounding, type DraftGroundingSource } from '../lib/draft-grounding.js';
import type { Viewer } from './types.js';

// Drafts (spec 5.7, M8): the ONE artifact that leaves the building, and the most confidential
// surface. draft.read is NOT a viewer permission (route-gated); reads are additionally owner-scoped
// here (created_by / owner_user_id) because org-level RLS cannot express per-user confidentiality.
// The agent_proposals summary is a CONTENT-FREE template. Grounding comes from buildDraftGrounding,
// which can only select lines of the given offer and nodes of the given request.

// The seeded "Bursar System" service user (migration 0247); agent_proposals.actor_id is NOT NULL.
const BURSAR_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b4';
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The DB grounding source. Each query is scoped to (organization_id, offer_id|request_id) exactly. */
function makeDbGroundingSource(tx: DbTx): DraftGroundingSource {
  return {
    async offerLines(orgId, offerId) {
      return pgRows(
        await tx.execute(sql`
          SELECT id, ordinal, raw_text, line_role, unit, quantity::text AS quantity
            FROM bursar_offer_lines
           WHERE organization_id = ${orgId} AND offer_id = ${offerId}
           ORDER BY ordinal ASC
        `),
      );
    },
    async requestNodes(orgId, requestId) {
      return pgRows(
        await tx.execute(sql`
          SELECT id, ordinal, title, normative_strength
            FROM bursar_scope_nodes
           WHERE organization_id = ${orgId} AND request_id = ${requestId} AND archived_at IS NULL
           ORDER BY ordinal ASC
        `),
      );
    },
  };
}

/** Owner-scoped list (spec 5.7): a caller sees only drafts they created or own; superusers see all. */
export async function listDrafts(viewer: Viewer, status?: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const conds = [sql`organization_id = ${viewer.org_id}`];
    if (!viewer.is_superuser) conds.push(sql`(created_by = ${viewer.id} OR owner_user_id = ${viewer.id})`);
    if (status) conds.push(sql`status = ${status}`);
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT id, kind, status, request_id, vendor_id, award_id, mismatch_id, proposal_id,
               owner_user_id, title, body, created_by, approved_by, approved_at, rejected_by,
               rejected_at, created_at, updated_at
          FROM bursar_drafts
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY created_at DESC
         LIMIT 200
      `),
    );
    return { data: rows };
  });
}

export async function getDraft(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const conds = [sql`organization_id = ${viewer.org_id}`, sql`id = ${id}`];
    if (!viewer.is_superuser) conds.push(sql`(created_by = ${viewer.id} OR owner_user_id = ${viewer.id})`);
    const row = pgRows<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM bursar_drafts WHERE ${sql.join(conds, sql` AND `)} LIMIT 1`),
    )[0];
    if (!row) throw new NotFoundError('Draft not found');
    return { data: row };
  });
}

/** Build the draft body FROM the confined grounding. No content beyond this request+offer leaks. */
function renderDraftBody(kind: BursarDraftKind, prompt: string | null, grounding: { nodes: Array<{ title: string }>; lines: Array<{ raw_text: string }> }): string {
  const lead =
    kind === 'clarification'
      ? 'Clarification request drafted from the confirmed scope tree and the vendor offer:'
      : 'Negotiation brief drafted from the confirmed scope tree and the vendor offer:';
  const nodeList = grounding.nodes.map((n) => `- ${n.title}`).join('\n');
  const lineList = grounding.lines.map((l) => `- ${l.raw_text}`).join('\n');
  return [
    lead,
    prompt ? `\nIntent: ${prompt}` : '',
    `\nScope requirements:\n${nodeList || '(none)'}`,
    grounding.lines.length ? `\nOffer lines:\n${lineList}` : '',
  ].join('\n');
}

export async function createDraft(viewer: Viewer, kind: BursarDraftKind, body: BursarDraftCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const request = pgRows<{ id: string }>(
      await tx.execute(sql`SELECT id FROM bursar_requests WHERE organization_id = ${viewer.org_id} AND id = ${body.request_id} LIMIT 1`),
    )[0];
    if (!request) throw new NotFoundError('Request not found');

    // If an offer is named, it MUST belong to this request (confinement precondition for grounding).
    if (body.offer_id) {
      const offer = pgRows<{ id: string }>(
        await tx.execute(sql`SELECT id FROM bursar_offers WHERE organization_id = ${viewer.org_id} AND id = ${body.offer_id} AND request_id = ${body.request_id} LIMIT 1`),
      )[0];
      if (!offer) throw new ValidationFailure('offer_id does not belong to request_id', 'OFFER_REQUEST_MISMATCH');
    }

    // Resolve vendor display_name for the content-free proposal summary.
    const vendorName = body.vendor_id
      ? pgRows<{ display_name: string }>(
          await tx.execute(sql`SELECT display_name FROM bursar_vendors WHERE organization_id = ${viewer.org_id} AND id = ${body.vendor_id} LIMIT 1`),
        )[0]?.display_name ?? 'the vendor'
      : 'the vendor';

    // Confined grounding, then a body rendered strictly from it.
    const grounding = await buildDraftGrounding(makeDbGroundingSource(tx), viewer.org_id, {
      offerId: body.offer_id ?? null,
      requestId: body.request_id,
    });
    const draftBody = renderDraftBody(kind, body.prompt ?? null, grounding);
    const title = body.title ?? (kind === 'clarification' ? 'Clarification request' : 'Negotiation brief');

    const draft = pgRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO bursar_drafts (organization_id, kind, status, request_id, vendor_id, award_id,
               mismatch_id, owner_user_id, title, body, created_by)
        VALUES (${viewer.org_id}, ${kind}, 'pending', ${body.request_id}, ${body.vendor_id ?? null},
               ${body.award_id ?? null}, ${body.mismatch_id ?? null}, ${viewer.id}, ${title}, ${draftBody}, ${viewer.id})
        RETURNING id
      `),
    )[0]!;

    // The HITL proposal. summary is a CONTENT-FREE template (spec 5.7): no offer/request content.
    const summary = `Bursar draft awaiting review: ${kind} for ${vendorName}`;
    const proposal = pgRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO agent_proposals (org_id, actor_id, proposer_kind, proposed_action, proposed_payload,
               subject_type, subject_id, approver_id, status, expires_at)
        VALUES (${viewer.org_id}, ${BURSAR_SYSTEM_USER_ID}, 'agent', 'bursar.draft.review',
               ${JSON.stringify({ bursar_draft_id: draft.id, summary })}::jsonb,
               'bursar.draft', ${draft.id}, NULL, 'pending', ${new Date(Date.now() + PROPOSAL_TTL_MS).toISOString()})
        RETURNING id
      `),
    )[0]!;

    await tx.execute(sql`UPDATE bursar_drafts SET proposal_id = ${proposal.id}, updated_at = now() WHERE organization_id = ${viewer.org_id} AND id = ${draft.id}`);

    void publishBoltEvent(
      'draft.created',
      'bursar',
      { 'draft.id': draft.id, kind, 'vendor.id': body.vendor_id ?? null, 'org.id': viewer.org_id },
      viewer.org_id,
    ).catch(() => {});

    return { data: { id: draft.id, kind, status: 'pending', proposal_id: proposal.id } };
  });
}

async function decideDraft(viewer: Viewer, id: string, decision: 'approved' | 'rejected', reason: string | undefined) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const draft = pgRows<{ id: string; proposal_id: string | null; status: string }>(
      await tx.execute(sql`SELECT id, proposal_id, status FROM bursar_drafts WHERE organization_id = ${viewer.org_id} AND id = ${id} LIMIT 1`),
    )[0];
    if (!draft) throw new NotFoundError('Draft not found');

    const stamp = decision === 'approved' ? sql`approved_by = ${viewer.id}, approved_at = now()` : sql`rejected_by = ${viewer.id}, rejected_at = now()`;
    await tx.execute(sql`UPDATE bursar_drafts SET status = ${decision}, ${stamp}, updated_at = now() WHERE organization_id = ${viewer.org_id} AND id = ${id}`);

    // Reflect onto the linked proposal so the HITL queue closes.
    if (draft.proposal_id) {
      const pStatus = decision === 'approved' ? 'approved' : 'rejected';
      await tx.execute(sql`
        UPDATE agent_proposals SET status = ${pStatus}, approver_id = ${viewer.id}, decided_at = now(),
               decision_reason = ${reason ?? null}, updated_at = now()
         WHERE org_id = ${viewer.org_id} AND id = ${draft.proposal_id} AND status = 'pending'
      `);
    }

    void publishBoltEvent('draft.decided', 'bursar', { 'draft.id': id, decision, 'org.id': viewer.org_id }, viewer.org_id).catch(() => {});
    return { data: { id, status: decision } };
  });
}

export function approveDraft(viewer: Viewer, id: string, body: BursarDraftDecision) {
  return decideDraft(viewer, id, 'approved', body.reason);
}
export function rejectDraft(viewer: Viewer, id: string, body: BursarDraftDecision) {
  return decideDraft(viewer, id, 'rejected', body.reason);
}
