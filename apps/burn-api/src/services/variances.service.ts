import { and, eq } from 'drizzle-orm';
import type { BurnChangeOrderDraft, BurnVarianceUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import {
  agentProposals,
  burnDeliverables,
  burnEngagements,
  burnVariances,
} from '../db/schema/index.js';
import { NotFoundError, ProjectScopeError } from '../lib/errors.js';
import { canAccessEngagement, engagementScopePredicate } from '../lib/project-scope.js';
import { decodeCursor, keysetOrder, keysetPredicate, pageOf } from '../lib/pagination.js';
import type { Viewer } from './types.js';

export async function listVariances(
  viewer: Viewer,
  params: { cursor?: string; limit: number; status?: string; kind?: string; engagementId?: string },
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cursor = decodeCursor(params.cursor);
    const rows = await tx
      .select()
      .from(burnVariances)
      .where(
        and(
          eq(burnVariances.organization_id, viewer.org_id),
          engagementScopePredicate(viewer, burnVariances.engagement_id),
          params.status ? eq(burnVariances.status, params.status) : undefined,
          params.kind ? eq(burnVariances.variance_kind, params.kind) : undefined,
          params.engagementId ? eq(burnVariances.engagement_id, params.engagementId) : undefined,
          keysetPredicate(burnVariances.created_at, burnVariances.id, cursor),
        ),
      )
      .orderBy(...keysetOrder(burnVariances.created_at, burnVariances.id))
      .limit(params.limit + 1);
    const page = pageOf(rows, params.limit);
    // NOTE: `amount` and every money key nested inside `detail` (which is JSONB) are floored
    // by the shared serializer at the route. The serializer RECURSES precisely because
    // `detail` is free-form: a shallow delete would strip the top-level `amount` and leave
    // the same dollars one level down inside detail.refs.
    return { data: page.rows, next_cursor: page.next_cursor };
  });
}

export async function updateVariance(viewer: Viewer, id: string, patch: BurnVarianceUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnVariances)
      .where(and(eq(burnVariances.organization_id, viewer.org_id), eq(burnVariances.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Variance not found');
    if (row.engagement_id && !(await canAccessEngagement(viewer, row.engagement_id))) {
      throw new ProjectScopeError();
    }
    const [updated] = await tx
      .update(burnVariances)
      .set({
        status: patch.status,
        resolved_by: patch.status === 'resolved' ? viewer.id : row.resolved_by,
        resolved_at: patch.status === 'resolved' ? new Date() : row.resolved_at,
        detail: patch.note
          ? { ...(row.detail as Record<string, unknown>), note: patch.note }
          : row.detail,
        updated_at: new Date(),
      })
      .where(eq(burnVariances.id, id))
      .returning();
    return { data: updated };
  });
}

/* ------------------------------------------------------------------ */
/*  Change orders                                                     */
/* ------------------------------------------------------------------ */

/**
 * Draft a change order. THE DRAFT IS NEVER SENT.
 *
 * The output is an `agent_proposals` row, which is the platform's human-in-the-loop queue.
 * That is why `burn_draft_change_order` needs no confirm token at the MCP layer: the
 * proposal IS the confirmation step, and adding a second one would be ceremony rather than
 * control.
 *
 * On approval (handled by the proposal-decided subscription in M6) this creates the
 * amendment engagement AND the amendment deliverable, which is what makes the base
 * deliverable's effective envelope rise so the next precheck returns `allow` instead of
 * `deny`. That loop closing is the whole point of the feature; a change order that raises
 * paperwork without moving the envelope leaves the operator blocked forever.
 */
export async function draftChangeOrder(viewer: Viewer, body: BurnChangeOrderDraft) {
  await (async () => {
    if (!(await canAccessEngagement(viewer, body.engagement_id))) throw new ProjectScopeError();
  })();

  return runInOrgScope(viewer.org_id, async (tx) => {
    const [engagement] = await tx
      .select()
      .from(burnEngagements)
      .where(
        and(
          eq(burnEngagements.organization_id, viewer.org_id),
          eq(burnEngagements.id, body.engagement_id),
        ),
      )
      .limit(1);
    if (!engagement) throw new NotFoundError('Engagement not found');

    let deliverableTitle: string | null = null;
    if (body.deliverable_id) {
      const [d] = await tx
        .select({ title: burnDeliverables.title })
        .from(burnDeliverables)
        .where(
          and(
            eq(burnDeliverables.organization_id, viewer.org_id),
            eq(burnDeliverables.id, body.deliverable_id),
          ),
        )
        .limit(1);
      deliverableTitle = d?.title ?? null;
    }

    const [proposal] = await tx
      .insert(agentProposals)
      .values({
        org_id: viewer.org_id,
        actor_id: viewer.id,
        proposer_kind: 'human',
        proposed_action: 'burn.changeorder.draft',
        // REFS AND HANDLES ONLY. Spec 12.1 asserts `agent_proposals.proposed_payload` holds
        // no clause text, no client name, and no dollar total: the proposals table is
        // org-level with no per-row visibility, so anything put here is readable by every
        // approver in the org regardless of project membership.
        proposed_payload: {
          engagement_id: body.engagement_id,
          deliverable_id: body.deliverable_id ?? null,
          variance_id: body.variance_id ?? null,
          deliverable_title: deliverableTitle,
          note: body.note ?? null,
        },
        subject_type: 'burn.engagement',
        subject_id: body.engagement_id,
        expires_at: new Date(Date.now() + 30 * 86_400_000),
      })
      .returning();

    if (body.variance_id) {
      await tx
        .update(burnVariances)
        .set({ proposal_id: proposal!.id, status: 'acknowledged', updated_at: new Date() })
        .where(
          and(
            eq(burnVariances.organization_id, viewer.org_id),
            eq(burnVariances.id, body.variance_id),
          ),
        );
    }

    return { data: { proposal_id: proposal!.id, status: proposal!.status, sent: false } };
  });
}

/** Fetch the drafted body. Project-scoped AND serializer-redacted (R2-S3 / R2-S4). */
export async function getChangeOrder(viewer: Viewer, proposalId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [proposal] = await tx
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.org_id, viewer.org_id),
          eq(agentProposals.id, proposalId),
          eq(agentProposals.proposed_action, 'burn.changeorder.draft'),
        ),
      )
      .limit(1);
    if (!proposal) throw new NotFoundError('Change order not found');

    // agent_proposals is ORG-level with no project scoping of its own, so the project
    // predicate has to be applied HERE against the subject engagement. Without this a
    // member could enumerate change-order drafts for chains they cannot otherwise read.
    if (proposal.subject_id && !(await canAccessEngagement(viewer, proposal.subject_id))) {
      throw new NotFoundError('Change order not found');
    }

    const [engagement] = proposal.subject_id
      ? await tx
          .select()
          .from(burnEngagements)
          .where(eq(burnEngagements.id, proposal.subject_id))
          .limit(1)
      : [null];

    return {
      data: {
        proposal_id: proposal.id,
        status: proposal.status,
        payload: proposal.proposed_payload,
        engagement: engagement
          ? { id: engagement.id, title: engagement.title, currency: engagement.currency }
          : null,
        created_at: proposal.created_at,
      },
    };
  });
}
