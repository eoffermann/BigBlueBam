import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBeaconEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as tagService from '../services/tag.service.js';

const addTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(128)).min(1).max(20),
});

export default async function tagRoutes(fastify: FastifyInstance) {
  // GET /tags — List all tags in scope with counts
  fastify.get(
    '/tags',
    { preHandler: [requireAuth, shadowOnly('beacon.tag.list')] },
    async (request, reply) => {
      const projectId = (request.query as { project_id?: string }).project_id;
      const tags = await tagService.listTags(request.user!.org_id, projectId);
      return reply.send({ data: tags });
    },
  );

  // POST /beacons/:id/tags — Add tags to a beacon
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/tags',
    { preHandler: [requireAuth, requireBeaconEditAccess(), shadowOnly('beacon.beacon_tag.create'), requireScope('read_write')] },
    async (request, reply) => {
      const { tags } = addTagsSchema.parse(request.body);
      const added = await tagService.addTags(
        request.params.id,
        tags,
        request.user!.id,
      );
      return reply.status(201).send({ data: added });
    },
  );

  // DELETE /beacons/:id/tags/:tag — Remove a tag
  fastify.delete<{ Params: { id: string; tag: string } }>(
    '/beacons/:id/tags/:tag',
    { preHandler: [requireAuth, requireBeaconEditAccess(), shadowOnly('beacon.beacon_tag.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const deleted = await tagService.removeTag(
        request.params.id,
        request.params.tag,
      );
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Tag not found on this beacon',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: deleted });
    },
  );
}
