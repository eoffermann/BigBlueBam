import type { FastifyInstance } from 'fastify';
import {
  bastionAttestSchema,
  bastionPolicyCreateSchema,
  bastionPolicyListQuerySchema,
  bastionPolicyUpdateSchema,
  bastionRequestAttestationsSchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { policyDeps } from '../services/evidence-runtime.js';
import * as policies from '../services/policies.service.js';

// Spec 5.1 rows 64-71 (M7): policies and version-pinned attestation (spec 3.6). Attest is a
// vouching route (spec 2.8, #136): session-only, never impersonated, a human; it has no MCP tool.
// Everything else an agent may do through an API key, under the same permissions.
export default async function policyRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => policyDeps(fastify.log, fastify.redis);
  // #296: a policy manager is told its article's state even when they cannot open the article.
  const manage = async (request: Parameters<typeof fastify.bastionCan>[0]) => ({ policyWrite: await fastify.bastionCan(request, 'bastion.policy.write') });
  const query = (request: { query: unknown }) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  };

  // Row 64.
  fastify.get('/policies', { preHandler: [requireAuth, can('bastion.policy.read')] }, async (request, reply) => {
    const parsed = bastionPolicyListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => policies.listPolicies(deps(), viewerOf(request), parsed.data, await manage(request)));
  });

  // Row 65.
  fastify.post('/policies', { preHandler: [requireAuth, can('bastion.policy.write')] }, async (request, reply) => {
    const parsed = bastionPolicyCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await policies.createPolicy(deps(), viewerOf(request), parsed.data);
      reply.status(201);
      return out;
    });
  });

  // Row 66.
  fastify.patch('/policies/:id', { preHandler: [requireAuth, can('bastion.policy.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionPolicyUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => policies.updatePolicy(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 67: the frozen body for the current version, visibility re-checked per request.
  fastify.get('/policies/:id/body', { preHandler: [requireAuth, can('bastion.attestation.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => policies.getPolicyBody(deps(), viewerOf(request), id));
  });

  // Row 68.
  fastify.get('/policies/:id/attestations', { preHandler: [requireAuth, can('bastion.attestation.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, async () => policies.listPolicyAttestations(deps(), viewerOf(request), id, await manage(request)));
  });

  // Row 69.
  fastify.get('/me/attestations', { preHandler: [requireAuth, can('bastion.attestation.read')] }, async (request, reply) =>
    handled(request, reply, () => policies.myAttestations(deps(), viewerOf(request))),
  );

  // Row 70: "I have read and understood this". Vouching: session, not impersonated, a human.
  fastify.post(
    '/policies/:id/attest',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.attestation.sign')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionAttestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, async () => {
        const out = await policies.attest(deps(), viewerOf(request), id, parsed.data);
        reply.status(out.data.created ? 201 : 200);
        return out;
      });
    },
  );

  // Row 71.
  fastify.post('/policies/:id/request-attestations', { preHandler: [requireAuth, can('bastion.attestation.request')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionRequestAttestationsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => policies.requestAttestations(deps(), viewerOf(request), id, parsed.data, await manage(request)));
  });
}
