import type { FastifyInstance } from 'fastify';
import {
  bursarApplyLibrarySchema,
  bursarConfirmScopeSchema,
  bursarDeriveScopeSchema,
  bursarPromoteRivalSchema,
  bursarScopeNodeCreateSchema,
  bursarScopeNodeUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as scope from '../services/scope.service.js';

// Scope tree routes (spec 11 / 3.2, M3). Per-route permission metadata is authored inline via
// fastify.requireCan (M9 walks it): reads use bursar.scope.read; structural writes use
// bursar.scope.write; confirm and rival-promotion are FLOORED, confirm-required actions
// (bursar.scope.confirm, bursar.scope.promote_rival). Under the fail-closed boot invariant these
// deny for non-SuperUsers from M1 through M8 (dev + Playwright run as Skipper, a SuperUser).
export default async function scopeRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // ── Reads ──────────────────────────────────────────────────────────────────
  fastify.get(
    '/requests/:id/scope',
    { preHandler: [requireAuth, can('bursar.request.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await scope.getScope(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Async-start derivation (202 + run id) ────────────────────────────────────
  fastify.post(
    '/requests/:id/derive-scope',
    { preHandler: [requireAuth, can('bursar.scope.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarDeriveScopeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await scope.deriveScope(viewerOf(request), id, parsed.data);
        reply.status(202);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Node CRUD ────────────────────────────────────────────────────────────────
  fastify.post(
    '/requests/:id/scope/nodes',
    { preHandler: [requireAuth, can('bursar.scope.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarScopeNodeCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await scope.addNode(viewerOf(request), id, parsed.data);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/scope-nodes/:id',
    { preHandler: [requireAuth, can('bursar.scope.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarScopeNodeUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await scope.updateNode(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // DELETE archives (soft), never a hard delete.
  fastify.delete(
    '/scope-nodes/:id',
    { preHandler: [requireAuth, can('bursar.scope.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await scope.archiveNode(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Apply library ────────────────────────────────────────────────────────────
  fastify.post(
    '/requests/:id/scope/apply-library',
    { preHandler: [requireAuth, can('bursar.scope.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarApplyLibrarySchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return await scope.applyLibrary(viewerOf(request), id, parsed.data);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Confirm (floored; 409 while deriving; blocked while injection_suspected) ──
  fastify.post(
    '/requests/:id/scope/confirm',
    { preHandler: [requireAuth, can('bursar.scope.confirm')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarConfirmScopeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await scope.confirmScope(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Promote a rival proposal (floored; confirm-required) ─────────────────────
  fastify.post(
    '/scope-nodes/:id/promote-rival',
    { preHandler: [requireAuth, can('bursar.scope.promote_rival')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarPromoteRivalSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return await scope.promoteRival(viewerOf(request), id, parsed.data);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
