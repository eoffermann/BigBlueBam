import type { FastifyInstance } from 'fastify';
import {
  bastionAssertionConfirmSchema,
  bastionAssertionProposeSchema,
  bastionAssertionRejectSchema,
  bastionAssertionReviseSchema,
  bastionControlCreateSchema,
  bastionControlListQuerySchema,
  bastionControlUpdateSchema,
  bastionRequirementApplicabilitySchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import * as controls from '../services/controls.service.js';
import * as assertions from '../services/assertions.service.js';

// Spec 5.1 rows 11-20. Confirm and reject are vouching acts (spec 2.8): a cookie session is
// required (an API key, and therefore any MCP or agent caller, gets 403 SESSION_REQUIRED) and an
// impersonating SuperUser gets 403 IMPERSONATION_NOT_ALLOWED.
export default async function controlRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // Row 11: list with the "Not set up yet" count for the framework view.
  fastify.get('/controls', { preHandler: [requireAuth, can('bastion.control.read')] }, async (request, reply) => {
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionControlListQuerySchema.safeParse({
      framework_id: raw.framework_id || undefined,
      lifecycle: raw.lifecycle || undefined,
      setup: raw.setup || undefined,
      q: raw.q || undefined,
    });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => controls.listControls(viewerOf(request), parsed.data));
  });

  // Row 12: a custom control.
  fastify.post('/controls', { preHandler: [requireAuth, can('bastion.control.write')] }, async (request, reply) => {
    const parsed = bastionControlCreateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await controls.createControl(viewerOf(request), parsed.data);
      reply.status(201);
      return result;
    });
  });

  // Row 13.
  fastify.get('/controls/:id', { preHandler: [requireAuth, can('bastion.control.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => controls.getControl(viewerOf(request), id));
  });

  // Row 14.
  fastify.patch('/controls/:id', { preHandler: [requireAuth, can('bastion.control.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionControlUpdateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => controls.updateControl(viewerOf(request), id, parsed.data));
  });

  // Row 15: one requirement link's applicability decision (audited).
  fastify.patch('/control-requirements/:id', { preHandler: [requireAuth, can('bastion.control.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionRequirementApplicabilitySchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => controls.decideRequirementLink(viewerOf(request), id, parsed.data));
  });

  // Row 16.
  fastify.get('/controls/:id/assertions', { preHandler: [requireAuth, can('bastion.control.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => controls.listControlAssertions(viewerOf(request), id));
  });

  // Row 17: propose a check (humans and agents; it lands as proposed).
  fastify.post('/controls/:id/assertions', { preHandler: [requireAuth, can('bastion.assertion.propose')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionAssertionProposeSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await assertions.proposeAssertion(viewerOf(request), id, parsed.data);
      reply.status(201);
      return result;
    });
  });

  // Row 18: confirm (vouching).
  fastify.post(
    '/assertions/:id/confirm',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.assertion.confirm')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionAssertionConfirmSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => assertions.confirmAssertion(viewerOf(request), id, parsed.data));
    },
  );

  // Row 19: reject (vouching).
  fastify.post(
    '/assertions/:id/reject',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.assertion.confirm')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionAssertionRejectSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => assertions.rejectAssertion(viewerOf(request), id, parsed.data));
    },
  );

  // Row 20: revise (files a superseding proposed check).
  fastify.post('/assertions/:id/revise', { preHandler: [requireAuth, can('bastion.assertion.propose')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionAssertionReviseSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await assertions.reviseAssertion(viewerOf(request), id, parsed.data);
      reply.status(201);
      return result;
    });
  });
}
