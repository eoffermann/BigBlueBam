import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess } from '../middleware/authorize.js';
import * as projectService from '../services/project.service.js';
import {
  getEffectiveCallingSettings,
  getProjectCallingSettings,
  upsertProjectCallingSettings,
} from '../services/project-calling-settings.service.js';

const upsertSchema = z
  .object({
    calling_enabled: z.boolean().nullable().optional(),
    allow_recording: z.boolean().nullable().optional(),
    allow_transcription: z.boolean().nullable().optional(),
    default_office_privacy: z
      .string()
      .min(1)
      .max(16)
      .nullable()
      .optional(),
  })
  .strict();

export default async function projectCallingSettingsRoutes(fastify: FastifyInstance) {
  // GET /projects/:id/calling-settings — raw row only (NULL = inherit).
  // Any project member can read; if no row exists yet, returns null data.
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/calling-settings',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const row = await getProjectCallingSettings(request.params.id);
      return reply.send({ data: row });
    },
  );

  // GET /projects/:id/calling-settings/effective — resolved values after
  // walking project -> org -> platform. Includes provenance so the UI can
  // render "(inherited from org)" tags.
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/calling-settings/effective',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const effective = await getEffectiveCallingSettings(request.params.id);
      if (!effective) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: effective });
    },
  );

  // PUT /projects/:id/calling-settings — admin/owner only.
  // Mirrors the project admin-role gate used by PATCH /projects/:id.
  fastify.put<{ Params: { id: string } }>(
    '/projects/:id/calling-settings',
    {
      preHandler: [
        requireAuth,
        requireScope('read_write'),
        requireProjectAccess(),
      ],
    },
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

      const data = upsertSchema.parse(request.body);
      const row = await upsertProjectCallingSettings(request.params.id, data);
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: row });
    },
  );
}
