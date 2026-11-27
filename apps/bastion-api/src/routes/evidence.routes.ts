import type { FastifyInstance } from 'fastify';
import {
  bastionEvaluationListQuerySchema,
  bastionEvidenceListQuerySchema,
  bastionRestoreAcknowledgeSchema,
  bastionRestoreListQuerySchema,
  bastionRunEvaluationSchema,
  bastionSealListQuerySchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import * as evidence from '../services/evidence.service.js';
import { canAccess } from '../services/evidence-runtime.js';

// Spec 5.1 rows 22-27 and 29-31 (M4). Restore acknowledgement is an integrity act: a cookie
// session is required, impersonation is refused, the permission is ledger.acknowledge_restore,
// and the service additionally requires the owner role (spec 5.5).
export default async function evidenceRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => engineDeps(fastify.log, fastify.redis);

  // Row 22: start an evaluation now (202 + the queued run).
  fastify.post('/evaluations', { preHandler: [requireAuth, can('bastion.evaluation.run')] }, async (request, reply) => {
    const parsed = bastionRunEvaluationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await evidence.startEvaluation(deps(), viewerOf(request), parsed.data);
      reply.status(202);
      return result;
    });
  });

  // Row 23.
  fastify.get('/evaluations', { preHandler: [requireAuth, can('bastion.control.read')] }, async (request, reply) => {
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionEvaluationListQuerySchema.safeParse({
      status: raw.status || undefined,
      cursor: raw.cursor || undefined,
      limit: raw.limit || undefined,
    });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => evidence.listEvaluations(deps(), viewerOf(request), parsed.data));
  });

  // Row 24: run status (the UI polls this; no realtime in v1).
  fastify.get('/evaluations/:id', { preHandler: [requireAuth, can('bastion.control.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => evidence.getEvaluation(deps(), viewerOf(request), id));
  });

  // Row 25.
  fastify.get('/controls/:id/evidence', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionEvidenceListQuerySchema.safeParse({
      assertion_id: raw.assertion_id || undefined,
      latest: raw.latest || undefined,
      cursor: raw.cursor || undefined,
      limit: raw.limit || undefined,
    });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => evidence.listControlEvidence(deps(), viewerOf(request), id, parsed.data, canAccess));
  });

  // Row 26.
  fastify.get('/evidence/:id', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => evidence.getEvidence(deps(), viewerOf(request), id, canAccess));
  });

  // Row 27.
  fastify.get('/evidence/:id/verify', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => evidence.verifyEvidence(deps(), viewerOf(request), id));
  });

  // Row 29: every seal with every signing key (current and retired).
  fastify.get('/ledger/seals', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionSealListQuerySchema.safeParse({ cursor: raw.cursor || undefined, limit: raw.limit || undefined });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => evidence.listSeals(deps(), viewerOf(request), parsed.data));
  });

  // Row 30.
  fastify.get('/ledger/restores', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionRestoreListQuerySchema.safeParse({ cursor: raw.cursor || undefined, limit: raw.limit || undefined });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => evidence.listRestores(deps(), viewerOf(request), parsed.data));
  });

  // Row 31: owner-only, confirm-gated, session-only, never impersonated.
  fastify.post(
    '/ledger/restores/:id/acknowledge',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.ledger.acknowledge_restore')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionRestoreAcknowledgeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => evidence.acknowledgeRestore(deps(), viewerOf(request), id, parsed.data));
    },
  );
}
