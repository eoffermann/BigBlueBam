import type { FastifyInstance } from 'fastify';
import {
  bastionAdoptFrameworkSchema,
  bastionArchiveFrameworkSchema,
  bastionBulkApplicabilitySchema,
  bastionCompileFrameworkSchema,
  bastionCompileRunListQuerySchema,
  bastionFrameworkUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { publicProbeCatalog } from '../library/index.js';
import * as frameworks from '../services/frameworks.service.js';
import * as compile from '../services/compile.service.js';

// Spec 5.1 rows 1-10 and 21, plus the bulk applicability route the Setup wizard uses. Every
// route runs requireCan with a spec 5.5 identifier (enforcement is the hardcoded fail-closed
// invariant in boot/assert-permissions-enforce.ts).
export default async function frameworkRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // Row 1: the built-in templates and whether each is adopted.
  fastify.get('/library/templates', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) =>
    handled(request, reply, () => frameworks.listTemplates(viewerOf(request))),
  );

  // Row 21: the closed probe menu (plain names; keys are for tools and the Technical details view).
  fastify.get('/probes', { preHandler: [requireAuth, can('bastion.control.read')] }, async () => ({
    data: publicProbeCatalog(),
  }));

  // Row 2.
  fastify.get('/frameworks', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) => {
    const q = request.query as { include_archived?: string };
    return handled(request, reply, () =>
      frameworks.listFrameworks(viewerOf(request), { include_archived: q.include_archived === 'true' }),
    );
  });

  // Row 3: adopt a framework (MCP: bastion_adopt_framework, issue #196).
  fastify.post('/frameworks', { preHandler: [requireAuth, can('bastion.framework.write')] }, async (request, reply) => {
    const parsed = bastionAdoptFrameworkSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await frameworks.adoptFramework(viewerOf(request), parsed.data);
      reply.status(201);
      return result;
    });
  });

  // Row 4.
  fastify.get('/frameworks/:id', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => frameworks.getFramework(viewerOf(request), id));
  });

  // Row 5.
  fastify.patch('/frameworks/:id', { preHandler: [requireAuth, can('bastion.framework.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionFrameworkUpdateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => frameworks.updateFramework(viewerOf(request), id, parsed.data));
  });

  // Row 6: archive (confirm). Retires controls whose only links were to this framework.
  fastify.post('/frameworks/:id/archive', { preHandler: [requireAuth, can('bastion.framework.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionArchiveFrameworkSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => frameworks.archiveFramework(viewerOf(request), id));
  });

  // Row 7: requirements with their applicability decisions.
  fastify.get('/frameworks/:id/requirements', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => frameworks.listRequirements(viewerOf(request), id));
  });

  // Bulk applicability (the Setup wizard's ISO step). Same permission as row 15.
  fastify.post('/frameworks/:id/applicability', { preHandler: [requireAuth, can('bastion.control.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionBulkApplicabilitySchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => frameworks.decideApplicability(viewerOf(request), id, parsed.data));
  });

  // Row 8: statement_of_applicability.csv (byte response headers per spec 5.1).
  fastify.get(
    '/frameworks/:id/statement-of-applicability',
    { preHandler: [requireAuth, can('bastion.framework.read')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      return handled(request, reply, async () => {
        const { csv, filename } = await frameworks.statementOfApplicabilityCsv(viewerOf(request), id);
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('Content-Security-Policy', "sandbox; default-src 'none'")
          .header('X-Content-Type-Options', 'nosniff');
        return reply.send(csv);
      });
    },
  );

  // Row 9: deterministic compile (202 + the run).
  fastify.post('/frameworks/:id/compile', { preHandler: [requireAuth, can('bastion.framework.compile')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionCompileFrameworkSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const result = await compile.compileFramework(viewerOf(request), id, request.log);
      reply.status(202);
      return result;
    });
  });

  // Row 10: newest first, cursor-paginated (`next_cursor`, `has_more`).
  fastify.get('/frameworks/:id/compile-runs', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionCompileRunListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => compile.listCompileRuns(viewerOf(request), id, parsed.data));
  });
}
