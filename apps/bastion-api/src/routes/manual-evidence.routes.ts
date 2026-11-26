import type { FastifyInstance } from 'fastify';
import {
  bastionManualEvidenceCreateSchema,
  bastionManualEvidenceLinkSchema,
  bastionManualEvidenceListQuerySchema,
  bastionManualEvidenceReviewSchema,
  bastionManualEvidenceWithdrawSchema,
  bastionRedactSchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { evidenceDeps } from '../services/evidence-runtime.js';
import * as manual from '../services/manual-evidence.service.js';

// Spec 5.1 rows 32-41 (M5). Vouching routes (create, supersede, link review, redaction) require a
// cookie session and refuse impersonation (spec 2.8, #136): a person attests to what they upload
// and to what they accept. Redaction is owner-only in the service and confirm-gated in the body.
export default async function manualEvidenceRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => evidenceDeps(fastify.log, fastify.redis);
  const restricted = (request: Parameters<typeof fastify.bastionCan>[0]) => fastify.bastionCan(request, 'bastion.evidence.read_restricted');

  // Row 32: a person attests to an upload or a statement.
  fastify.post(
    '/manual-evidence',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.evidence.upload')] },
    async (request, reply) => {
      const parsed = bastionManualEvidenceCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, async () => {
        const out = await manual.createManualEvidence(deps(), viewerOf(request), parsed.data);
        reply.status(201);
        return out;
      });
    },
  );

  // Row 33.
  fastify.get('/manual-evidence', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionManualEvidenceListQuerySchema.safeParse({
      status: raw.status || undefined,
      kind: raw.kind || undefined,
      assertion_id: raw.assertion_id || undefined,
      control_id: raw.control_id || undefined,
      stuck: raw.stuck === 'true' ? true : raw.stuck === 'false' ? false : undefined,
      limit: raw.limit || undefined,
    });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const canRestricted = await restricted(request);
    return handled(request, reply, () => manual.listManualEvidence(deps(), viewerOf(request), parsed.data, canRestricted));
  });

  // Row 34.
  fastify.get('/manual-evidence/:id', { preHandler: [requireAuth, can('bastion.evidence.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const canRestricted = await restricted(request);
    return handled(request, reply, () => manual.getManualEvidence(deps(), viewerOf(request), id, canRestricted));
  });

  // Row 35: the bytes (spec 5.1 byte-response headers).
  fastify.get('/manual-evidence/:id/download', { preHandler: [requireAuth, can('bastion.evidence.read_detail')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const canRestricted = await restricted(request);
    return handled(request, reply, async () => {
      const file = await manual.openManualEvidenceDownload(deps(), viewerOf(request), id, canRestricted);
      for (const [k, v] of Object.entries(file.headers)) reply.header(k, v);
      return reply.send(file.stream);
    });
  });

  // Row 36.
  fastify.post('/manual-evidence/:id/links', { preHandler: [requireAuth, can('bastion.evidence.link')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionManualEvidenceLinkSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => manual.linkManualEvidence(deps(), viewerOf(request), id, parsed.data.assertion_id));
  });

  // Row 37.
  fastify.delete('/manual-evidence/:id/links/:assertion_id', { preHandler: [requireAuth, can('bastion.evidence.link')] }, async (request, reply) => {
    const id = idParam(request);
    const assertionId = idParam(request, 'assertion_id');
    if (!id || !assertionId) return notFound(request, reply);
    return handled(request, reply, () => manual.unlinkManualEvidence(deps(), viewerOf(request), id, assertionId));
  });

  // Row 38: a second person vouches for the evidence.
  fastify.post(
    '/manual-evidence/:id/links/:assertion_id/review',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.evidence.review')] },
    async (request, reply) => {
      const id = idParam(request);
      const assertionId = idParam(request, 'assertion_id');
      if (!id || !assertionId) return notFound(request, reply);
      const parsed = bastionManualEvidenceReviewSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => manual.reviewManualEvidence(deps(), viewerOf(request), id, assertionId, parsed.data));
    },
  );

  // Row 39 (confirm).
  fastify.post('/manual-evidence/:id/withdraw', { preHandler: [requireAuth, can('bastion.evidence.withdraw')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionManualEvidenceWithdrawSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => manual.withdrawManualEvidence(deps(), viewerOf(request), id, parsed.data.reason ?? null));
  });

  // Row 40: a newer copy replaces this one (a person attests again).
  fastify.post(
    '/manual-evidence/:id/supersede',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.evidence.upload')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionManualEvidenceCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, async () => {
        const out = await manual.supersedeManualEvidence(deps(), viewerOf(request), id, parsed.data);
        reply.status(201);
        return out;
      });
    },
  );

  // Review queue "Check again" for an upload stuck waiting on its virus scan (spec 3.3).
  fastify.post('/manual-evidence/:id/check-again', { preHandler: [requireAuth, can('bastion.evidence.upload')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => manual.checkScanAgain(deps(), viewerOf(request), id));
  });

  // Row 41: owner-only (service), confirm-gated, session-only, never impersonated.
  fastify.post(
    '/personal-data/:id/redact',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.evidence.redact')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionRedactSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => manual.redactPersonalData(deps(), viewerOf(request), id, parsed.data.reason));
    },
  );
}
