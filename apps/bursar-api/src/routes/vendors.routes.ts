import type { FastifyInstance } from 'fastify';
import {
  bursarAliasCreateSchema,
  bursarListQuerySchema,
  bursarVendorCreateSchema,
  bursarVendorUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as vendors from '../services/vendors.service.js';

// Per-route permission metadata is authored inline via fastify.requireCan (spec 13.3), the
// same convention burn uses. The bursar.* actions do not exist in the permissions catalog yet
// (that seed is M9), so under the fail-closed boot invariant these routes DENY for
// non-SuperUsers from M1 through M8. Dev + Playwright run as Skipper (a seeded SuperUser). Do
// NOT weaken the invariant to make them reachable.
export default async function vendorRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/vendors',
    { preHandler: [requireAuth, can('bursar.vendor.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = bursarListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await vendors.listVendors(viewerOf(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
      });
      // The shared financial serializer runs on the WHOLE body (spec 5.6). Vendors carry no
      // floored money fields today, but wiring it here means a future field is covered
      // without anyone remembering to cover it.
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.post(
    '/vendors',
    { preHandler: [requireAuth, can('bursar.vendor.write')] },
    async (request, reply) => {
      const parsed = bursarVendorCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const asker = askerViewer(request);
        const result = await vendors.createVendor(viewerOf(request), parsed.data, asker?.id ?? null);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // Alias-review must be registered BEFORE /vendors/:id so "alias-review" is not captured as
  // an :id param.
  fastify.get(
    '/vendors/alias-review',
    { preHandler: [requireAuth, can('bursar.vendor.read')] },
    async (request) => {
      const result = await vendors.listAliasReview(viewerOf(request));
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.get(
    '/vendors/:id',
    { preHandler: [requireAuth, can('bursar.vendor.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await vendors.getVendor(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/vendors/:id',
    { preHandler: [requireAuth, can('bursar.vendor.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarVendorUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const asker = askerViewer(request);
        const result = await vendors.updateVendor(viewerOf(request), id, parsed.data, asker?.id ?? null);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // DELETE archives (bursar.vendor.delete: floored + destructive + confirm), never a hard
  // delete (spec 11 / 13).
  fastify.delete(
    '/vendors/:id',
    { preHandler: [requireAuth, can('bursar.vendor.delete')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await vendors.archiveVendor(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  /* -------------------------- aliases -------------------------- */

  fastify.get(
    '/vendors/:id/aliases',
    { preHandler: [requireAuth, can('bursar.vendor.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await vendors.listAliases(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/vendors/:id/aliases',
    { preHandler: [requireAuth, can('bursar.vendor.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarAliasCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await vendors.createAlias(viewerOf(request), id, parsed.data.raw_payee);
        reply.status(201);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/vendors/:id/aliases/:alias_id',
    { preHandler: [requireAuth, can('bursar.vendor.write')] },
    async (request, reply) => {
      const { id, alias_id } = request.params as { id: string; alias_id: string };
      try {
        return await vendors.deleteAlias(viewerOf(request), id, alias_id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
