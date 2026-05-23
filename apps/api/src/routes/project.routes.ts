import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { createProjectSchema, updateProjectSchema, addProjectMemberSchema } from '@bigbluebam/shared';
import * as projectService from '../services/project.service.js';
import * as orgService from '../services/org.service.js';
import { checkOrgPermission, isOrgPrivileged } from '../services/org-permissions.js';
import { requireAuth, requireScope, requireMinRole } from '../plugins/auth.js';
import { requireProjectRole } from '../middleware/authorize.js';
import { cacheGetOrSet, cacheInvalidate, CACHE_KEYS } from '../lib/cache.js';

const USER_PROJECTS_TTL_SECONDS = 30;

/**
 * Drop every `bbb:user:<userId>:projects` key for a given project's members.
 * Called after any write that could change a user's visible project list
 * (create, update, archive, add-member). Best-effort — never throws.
 */
async function invalidateProjectListsForProject(redis: Redis, projectId: string): Promise<void> {
  const info = await projectService.getProjectOrgAndMemberIds(projectId);
  if (!info) return;
  await Promise.all(
    info.user_ids.map((uid) =>
      cacheInvalidate(redis, `${CACHE_KEYS.userProjects(uid)}:org:${info.org_id}`),
    ),
  );
}

function userProjectsKey(userId: string, orgId: string): string {
  return `${CACHE_KEYS.userProjects(userId)}:org:${orgId}`;
}

export default async function projectRoutes(fastify: FastifyInstance) {
  fastify.get('/projects', { preHandler: [requireAuth] }, async (request, reply) => {
    // SuperUsers see every project in the org; skip caching for them so
    // they don't share a key space with regular members whose views may
    // legitimately differ.
    if (request.user!.is_superuser) {
      const projects = await projectService.listProjects(
        request.user!.org_id,
        request.user!.id,
        true,
      );
      return reply.send({ data: projects });
    }

    const projects = await cacheGetOrSet(
      fastify.redis,
      userProjectsKey(request.user!.id, request.user!.org_id),
      USER_PROJECTS_TTL_SECONDS,
      () => projectService.listProjects(request.user!.org_id, request.user!.id, false),
    );

    return reply.send({ data: projects });
  });

  fastify.post('/projects', { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] }, async (request, reply) => {
    // Enforce org-level permission: members_can_create_projects
    if (!request.user!.is_superuser && !isOrgPrivileged(request.user!.role)) {
      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!checkOrgPermission(org?.settings as Record<string, unknown> | null, 'members_can_create_projects')) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Your organization does not allow members to create projects',
            details: [],
            request_id: request.id,
          },
        });
      }
    }

    const data = createProjectSchema.parse(request.body);
    const project = await projectService.createProject(
      request.user!.org_id,
      data,
      request.user!.id,
    );
    // Creator's project list just gained a row — drop their cached copy.
    await cacheInvalidate(
      fastify.redis,
      userProjectsKey(request.user!.id, request.user!.org_id),
    );

    return reply.status(201).send({ data: project });
  });

  fastify.get<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const project = await projectService.getProject(request.params.id);
      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          request.params.id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Project not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      return reply.send({ data: project });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      // Check admin role
      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          request.params.id,
          request.user!.id,
        );
        if (!membership || membership.role !== 'admin') {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Project admin role required',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const data = updateProjectSchema.parse(request.body);
      const project = await projectService.updateProject(request.params.id, data);
      await invalidateProjectListsForProject(fastify.redis, request.params.id);

      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: project });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          request.params.id,
          request.user!.id,
        );
        if (!membership || membership.role !== 'admin') {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Project admin role required',
              details: [],
              request_id: request.id,
            },
          });
        }

        // Enforce org-level permission: members_can_delete_own_projects.
        // If the user is not an org admin/owner, they may only delete projects
        // they created, and only if the org permission allows it.
        if (!isOrgPrivileged(request.user!.role)) {
          const existingProject = await projectService.getProject(request.params.id);
          const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
          const permitted = checkOrgPermission(
            org?.settings as Record<string, unknown> | null,
            'members_can_delete_own_projects',
          );
          const isCreator =
            existingProject !== null &&
            (existingProject as { created_by?: string | null }).created_by === request.user!.id;
          if (!permitted || !isCreator) {
            return reply.status(403).send({
              error: {
                code: 'FORBIDDEN',
                message: 'Your organization does not allow members to delete this project',
                details: [],
                request_id: request.id,
              },
            });
          }
        }
      }

      const project = await projectService.archiveProject(request.params.id);
      await invalidateProjectListsForProject(fastify.redis, request.params.id);
      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: project });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/members',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          request.params.id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Project not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const members = await projectService.getProjectMembers(request.params.id);
      return reply.send({ data: members });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/members',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectRole('admin')] },
    async (request, reply) => {
      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          request.params.id,
          request.user!.id,
        );
        if (!membership || membership.role !== 'admin') {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Project admin role required',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const data = addProjectMemberSchema.parse(request.body);
      const newMembership = await projectService.addProjectMember(
        request.params.id,
        data.user_id,
        data.role,
        request.user!.id,
      );
      await invalidateProjectListsForProject(fastify.redis, request.params.id);

      return reply.status(201).send({ data: newMembership });
    },
  );
}
