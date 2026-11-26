import type { FastifyInstance } from 'fastify';
import {
  bastionDriftAcknowledgeSchema,
  bastionDriftListQuerySchema,
  bastionExceptionDecideSchema,
  bastionExceptionListQuerySchema,
  bastionExceptionProposeSchema,
  bastionFixDecideSchema,
  bastionFixDraftListQuerySchema,
  bastionFixMarkAppliedSchema,
  bastionGapDismissSchema,
  bastionGapListQuerySchema,
  bastionProposeFixSchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { decisionDeps } from '../services/evidence-runtime.js';
import * as drift from '../services/drift.service.js';
import * as exceptions from '../services/exceptions.service.js';
import * as fixes from '../services/fixes.service.js';

// Spec 5.1 rows 51-63 (M6): gaps, fix drafts, exceptions, drift. Both decide routes are vouching
// routes (spec 2.8, #136): session-only, never impersonated, a human; they carry no MCP tool.
// Everything else an agent may do through an API key, under the same permissions.
export default async function decisionRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => decisionDeps(fastify.log, fastify.redis);
  const query = (request: { query: unknown }) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  };

  // Row 51.
  fastify.get('/gaps', { preHandler: [requireAuth, can('bastion.gap.read')] }, async (request, reply) => {
    const parsed = bastionGapListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => fixes.listGaps(deps(), viewerOf(request), parsed.data));
  });

  // Row 52.
  fastify.post('/gaps/:id/propose-fix', { preHandler: [requireAuth, can('bastion.fix.draft')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionProposeFixSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await fixes.proposeFix(deps(), viewerOf(request), id, parsed.data.note ?? null);
      reply.status(201);
      return out;
    });
  });

  // Row 53.
  fastify.post('/gaps/:id/dismiss', { preHandler: [requireAuth, can('bastion.gap.dismiss')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionGapDismissSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => fixes.dismissGap(deps(), viewerOf(request), id, parsed.data.reason));
  });

  // Row 54.
  fastify.get('/fix-drafts', { preHandler: [requireAuth, can('bastion.fix.read')] }, async (request, reply) => {
    const parsed = bastionFixDraftListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => fixes.listFixDrafts(deps(), viewerOf(request), parsed.data));
  });

  // Row 55.
  fastify.get('/fix-drafts/:id', { preHandler: [requireAuth, can('bastion.fix.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => fixes.getFixDraft(deps(), viewerOf(request), id));
  });

  // Row 56: humans decide in Bastion. fix.decide plus control owner or control.write (service).
  fastify.post(
    '/fix-drafts/:id/decide',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.fix.decide')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionFixDecideSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const canControlWrite = await fastify.bastionCan(request, 'bastion.control.write');
      return handled(request, reply, () => fixes.decideFix(deps(), viewerOf(request), id, parsed.data, canControlWrite));
    },
  );

  // Row 57.
  fastify.post('/fix-drafts/:id/mark-applied', { preHandler: [requireAuth, can('bastion.fix.mark_applied')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionFixMarkAppliedSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => fixes.markFixApplied(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 58.
  fastify.get('/exceptions', { preHandler: [requireAuth, can('bastion.exception.read')] }, async (request, reply) => {
    const parsed = bastionExceptionListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => exceptions.listExceptions(deps().engine, viewerOf(request), parsed.data));
  });

  // Row 59.
  fastify.get('/exceptions/:id', { preHandler: [requireAuth, can('bastion.exception.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => exceptions.getException(deps().engine, viewerOf(request), id));
  });

  // Row 60.
  fastify.post('/exceptions', { preHandler: [requireAuth, can('bastion.exception.propose')] }, async (request, reply) => {
    const parsed = bastionExceptionProposeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await exceptions.proposeException(deps(), viewerOf(request), parsed.data);
      reply.status(201);
      return out;
    });
  });

  // Row 61 (confirm): humans decide in Bastion; approver differs from proposer (small-team rule).
  fastify.post(
    '/exceptions/:id/decide',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.exception.approve')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionExceptionDecideSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => exceptions.decideException(deps(), viewerOf(request), id, parsed.data));
    },
  );

  // Row 62.
  fastify.get('/drift', { preHandler: [requireAuth, can('bastion.drift.read')] }, async (request, reply) => {
    const parsed = bastionDriftListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => drift.listDrift(deps().engine, viewerOf(request), parsed.data));
  });

  // Row 63.
  fastify.post('/drift/:id/acknowledge', { preHandler: [requireAuth, can('bastion.drift.acknowledge')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionDriftAcknowledgeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => drift.acknowledgeDrift(deps().engine, viewerOf(request), id, parsed.data.note ?? null));
  });
}
