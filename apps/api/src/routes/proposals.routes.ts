import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { agentProposals } from '../db/schema/agent-proposals.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

/**
 * Durable agent-proposals routes (AGENTIC_TODO §9, Wave 2).
 *
 * Surface:
 *   POST /v1/proposals               create a proposal (any authed user)
 *   GET  /v1/proposals               list proposals visible to caller
 *   POST /v1/proposals/:id/decide    approve / reject / request_revision
 *
 * Design notes:
 *   - Every proposal has a mandatory approver and expiry. Callers that just
 *     want to fire an approval event without durable state should continue to
 *     use the legacy /v1/approvals producer, which this endpoint does NOT
 *     replace. Long term, apps should migrate to /v1/proposals/* so a human
 *     gets a single inbox to answer from.
 *   - Default list scope is "proposals where I am either the approver or the
 *     proposer, status=pending". Org admins see the whole org queue.
 *   - Expired pending proposals are lazily flipped to 'expired' on read of
 *     the single-proposal decide path so callers see the truth even if the
 *     background sweep hasn't run yet.
 *   - `proposal.created` and `proposal.decided` events are fired to Bolt
 *     (source `platform`) so rules can route follow-up work (notifications,
 *     escalations, timeout handlers).
 */

const MAX_TTL_SECONDS = 2_592_000; // 30 days
const DEFAULT_TTL_SECONDS = 604_800; // 7 days

const createSchema = z.object({
  proposed_action: z.string().min(1).max(200),
  proposed_payload: z.record(z.unknown()).optional(),
  approver_id: z.string().uuid(),
  subject_type: z.string().min(1).max(200).optional(),
  subject_id: z.string().uuid().optional(),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TTL_SECONDS)
    .optional(),
  decision_reason: z.string().max(4000).optional(),
});

const decideSchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_revision']),
  reason: z.string().max(4000).optional(),
});

const decisionToStatus: Record<
  z.infer<typeof decideSchema>['decision'],
  'approved' | 'rejected' | 'revising'
> = {
  approve: 'approved',
  reject: 'rejected',
  request_revision: 'revising',
};

export default async function proposalRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // POST /v1/proposals
  // ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/v1/proposals',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.proposal.create')] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid proposal payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const data = parsed.data;
      const ttl = data.ttl_seconds ?? DEFAULT_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + ttl * 1000);

      const [row] = await db
        .insert(agentProposals)
        .values({
          org_id: user.active_org_id,
          actor_id: user.id,
          proposer_kind: user.kind,
          proposed_action: data.proposed_action,
          proposed_payload: data.proposed_payload ?? {},
          subject_type: data.subject_type ?? null,
          subject_id: data.subject_id ?? null,
          approver_id: data.approver_id,
          status: 'pending',
          expires_at: expiresAt,
          decision_reason: data.decision_reason ?? null,
        })
        .returning();

      // Fire proposal.created. Bare event name + source 'platform' per
      // Wave 0.4 naming convention. Fire-and-forget: publishBoltEvent never
      // throws, so a Bolt outage cannot break proposal creation.
      await publishBoltEvent(
        'proposal.created',
        'platform',
        {
          proposal: {
            id: row!.id,
            proposed_action: row!.proposed_action,
            approver_id: row!.approver_id,
            actor_id: row!.actor_id,
            proposer_kind: row!.proposer_kind,
            expires_at: row!.expires_at.toISOString(),
            subject_type: row!.subject_type,
            subject_id: row!.subject_id,
            url: `/b3/approvals/${row!.id}`,
          },
          org: { id: user.active_org_id },
        },
        user.active_org_id,
        user.id,
        user.kind === 'human' ? 'user' : 'agent',
      );

      return reply.status(201).send({ data: row });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/proposals
  // ────────────────────────────────────────────────────────────────────
  //
  // Filter pattern matches existing routes: `filter[<field>]=<value>`.
  // Default scope: caller sees proposals where approver_id = caller.id OR
  // actor_id = caller.id. Org admins/owners see the whole org queue.
  // Default status filter is 'pending' when unspecified so the inbox is
  // usefully narrowed by default; pass `filter[status]=all` (or any other
  // value) to override.
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      'filter[approver_id]'?: string;
      'filter[actor_id]'?: string;
      'filter[status]'?: string;
    };
  }>(
    '/v1/proposals',
    { preHandler: [requireAuth, shadowOnly('bam.proposal.list')] },
    async (request, reply) => {
      const user = request.user!;
      const isOrgAdmin = user.role === 'owner' || user.role === 'admin' || user.is_superuser;
      const limit = Math.min(
        request.query.limit ? parseInt(request.query.limit, 10) : 50,
        200,
      );

      const conditions = [eq(agentProposals.org_id, user.active_org_id)];

      // Visibility: non-admins see only rows where they are the approver or
      // the actor. This is in addition to any caller-specified filters.
      if (!isOrgAdmin) {
        conditions.push(
          or(
            eq(agentProposals.approver_id, user.id),
            eq(agentProposals.actor_id, user.id),
          )!,
        );
      }

      if (request.query['filter[approver_id]']) {
        conditions.push(eq(agentProposals.approver_id, request.query['filter[approver_id]']));
      }
      if (request.query['filter[actor_id]']) {
        conditions.push(eq(agentProposals.actor_id, request.query['filter[actor_id]']));
      }
      const statusFilter = request.query['filter[status]'] ?? 'pending';
      if (statusFilter !== 'all') {
        // Cast the incoming string to the pg enum at the SQL level; Drizzle
        // doesn't know the union of enum values at runtime here.
        conditions.push(sql`${agentProposals.status} = ${statusFilter}::proposal_status`);
      }

      if (request.query.cursor) {
        const cursorDate = new Date(request.query.cursor);
        if (!Number.isNaN(cursorDate.getTime())) {
          conditions.push(lt(agentProposals.created_at, cursorDate));
        }
      }

      const rows = await db
        .select()
        .from(agentProposals)
        .where(and(...conditions))
        .orderBy(desc(agentProposals.created_at), desc(agentProposals.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && data.length > 0
          ? data[data.length - 1]!.created_at.toISOString()
          : null;

      return reply.send({
        data,
        meta: {
          next_cursor: nextCursor,
          has_more: hasMore,
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/proposals/:id/decide
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string };
  }>(
    '/v1/proposals/:id/decide',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.proposal_decide.create')] },
    async (request, reply) => {
      const user = request.user!;
      const isOrgAdmin = user.role === 'owner' || user.role === 'admin' || user.is_superuser;

      const parsed = decideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid decision payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const [existing] = await db
        .select()
        .from(agentProposals)
        .where(
          and(
            eq(agentProposals.id, request.params.id),
            eq(agentProposals.org_id, user.active_org_id),
          ),
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Proposal not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!isOrgAdmin && existing.approver_id !== user.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the designated approver (or an org admin) can decide this proposal',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Lazy expiry: if the proposal is past its expires_at, transition it to
      // 'expired' and surface 410 so the caller knows it's unactionable. This
      // saves the client from racing the background sweep.
      const now = new Date();
      if (existing.expires_at < now && (existing.status === 'pending' || existing.status === 'revising')) {
        await db
          .update(agentProposals)
          .set({ status: 'expired', updated_at: now })
          .where(eq(agentProposals.id, existing.id));
        return reply.status(410).send({
          error: {
            code: 'PROPOSAL_EXPIRED',
            message: 'Proposal has expired and can no longer be decided',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.status !== 'pending' && existing.status !== 'revising') {
        return reply.status(409).send({
          error: {
            code: 'PROPOSAL_ALREADY_DECIDED',
            message: `Proposal is in status '${existing.status}' and cannot be transitioned`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const newStatus = decisionToStatus[parsed.data.decision];
      const [updated] = await db
        .update(agentProposals)
        .set({
          status: newStatus,
          decided_at: now,
          decision_reason: parsed.data.reason ?? null,
          updated_at: now,
        })
        .where(eq(agentProposals.id, existing.id))
        .returning();

      await publishBoltEvent(
        'proposal.decided',
        'platform',
        {
          proposal: {
            id: updated!.id,
            proposed_action: updated!.proposed_action,
            decision: parsed.data.decision,
            decision_reason: updated!.decision_reason,
            approver_id: updated!.approver_id,
            actor_id: updated!.actor_id,
            decided_at: updated!.decided_at?.toISOString() ?? null,
          },
          org: { id: user.active_org_id },
        },
        user.active_org_id,
        user.id,
        user.kind === 'human' ? 'user' : 'agent',
      );

      return reply.send({ data: updated });
    },
  );
}
