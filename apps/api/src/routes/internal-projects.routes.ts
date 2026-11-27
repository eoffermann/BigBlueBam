/**
 * Server-to-server project creation (#364).
 *
 *   POST /internal/projects/ensure
 *     INTERNAL_SERVICE_SECRET-gated (the shared guard in lib/internal-secret.ts). Creates a
 *     project in body.org_id on behalf of body.created_by through projectService.createProject,
 *     the same code POST /projects runs, so the creator gets the admin project membership and
 *     the template's phases and task states. Idempotent on (org_id, ensure_key), the caller's
 *     own operation id: a replay answers the project that operation created (200, created
 *     false). A slug held by any other project is never answered (#373); the new project takes
 *     the first free suffixed slug (slug-2, slug-3, ...) and the response carries the real slug.
 *
 * Caller: the worker's Slack import (apps/worker/src/jobs/slack-import.job.ts), project mode
 * create_new. It used to INSERT INTO projects (org_id, name, key, owner_id) directly; key and
 * owner_id are not columns of projects, so every such import failed, and a raw insert would have
 * skipped the membership and the phases anyway.
 *
 * No signed-in user, so under BBB_RLS_ENFORCE=1 the org comes from body.org_id
 * (config.rlsOrgScope). created_by must be a member of that org.
 *
 * Mount prefix: /internal
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { internalEnsureProjectSchema } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { orgIdIn } from '../lib/rls-org-scope.js';
import { cacheInvalidate, CACHE_KEYS } from '../lib/cache.js';
import * as projectService from '../services/project.service.js';

export default async function internalProjectsRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/projects/ensure',
    { preHandler: [requireInternalSecret], config: { rlsOrgScope: orgIdIn('body', 'org_id') } },
    async (request, reply) => {
      const parsed = internalEnsureProjectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid project ensure payload',
            details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
            request_id: request.id,
          },
        });
      }
      const { org_id, created_by, ...data } = parsed.data;

      const [member] = await db
        .select({ user_id: organizationMemberships.user_id })
        .from(organizationMemberships)
        .where(and(eq(organizationMemberships.org_id, org_id), eq(organizationMemberships.user_id, created_by)))
        .limit(1);
      if (!member) {
        return reply.status(422).send({
          error: {
            code: 'CREATOR_NOT_IN_ORG',
            message: 'created_by is not a member of org_id',
            details: [{ field: 'created_by', issue: 'not a member of the org' }],
            request_id: request.id,
          },
        });
      }

      const { project, created } = await projectService.ensureProject(org_id, data, created_by);
      if (created && fastify.hasDecorator('redis')) {
        // The creator's cached project list just gained a row (same key POST /projects drops).
        await cacheInvalidate(fastify.redis, `${CACHE_KEYS.userProjects(created_by)}:org:${org_id}`);
      }
      return reply.status(created ? 201 : 200).send({ data: project, created });
    },
  );
}
