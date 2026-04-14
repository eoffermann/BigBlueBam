import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import {
  requireMinOrgRole,
  requireBoardAccess,
  requireBoardEditAccess,
} from '../middleware/authorize.js';
import * as boardService from '../services/board.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { buildBoardEventPayload } from '../lib/enrich-board-event.js';

const BACKGROUNDS = ['dots', 'grid', 'lines', 'plain'] as const;
const VISIBILITIES = ['private', 'project', 'organization'] as const;

const createBoardSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
  background: z.enum(BACKGROUNDS).optional().default('dots'),
  visibility: z.enum(VISIBILITIES).optional().default('project'),
  default_viewport: z.record(z.unknown()).nullable().optional(),
});

const updateBoardSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  background: z.enum(BACKGROUNDS).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  default_viewport: z.record(z.unknown()).nullable().optional(),
  thumbnail_url: z.string().max(2048).nullable().optional(),
});

const listBoardsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  created_by: z.string().uuid().optional(),
  archived: z.enum(['true', 'false']).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
});

export default async function boardRoutes(fastify: FastifyInstance) {
  // GET /boards — List boards
  fastify.get(
    '/boards',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listBoardsQuerySchema.parse(request.query);
      const result = await boardService.listBoards({
        orgId: request.user!.org_id,
        userId: request.user!.id,
        projectId: query.project_id,
        visibility: query.visibility,
        createdBy: query.created_by,
        archived: query.archived !== undefined ? query.archived === 'true' : undefined,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // POST /boards — Create board
  fastify.post(
    '/boards',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createBoardSchema.parse(request.body);
      const board = await boardService.createBoard(
        data as boardService.CreateBoardInput,
        request.user!.id,
        request.user!.org_id,
      );
      try {
        const payload = await buildBoardEventPayload(
          board.id,
          request.user!.org_id,
          request.user!.id,
        );
        publishBoltEvent(
          'board.created',
          'board',
          payload,
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Enrichment failure must never block board creation — drop the event.
      }
      return reply.status(201).send({ data: board });
    },
  );

  // GET /boards/recent — Recently updated boards
  fastify.get(
    '/boards/recent',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await boardService.getRecent(request.user!.id, request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /boards/starred — User's starred boards
  fastify.get(
    '/boards/starred',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await boardService.getStarred(request.user!.id, request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /boards/stats — Org-level board statistics
  fastify.get(
    '/boards/stats',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const stats = await boardService.getStats(
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: stats });
    },
  );

  // GET /boards/search — Search board element content
  fastify.get(
    '/boards/search',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { q } = searchQuerySchema.parse(request.query);
      const result = await boardService.searchBoards(q, request.user!.org_id, request.user!.id);
      return reply.send(result);
    },
  );

  // GET /boards/:id — Get board by ID (excludes yjs_state)
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id',
    { preHandler: [requireAuth, requireBoardAccess()] },
    async (request, reply) => {
      const board = await boardService.getBoard(
        (request as any).board.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );

  // GET /boards/:id/stats — Board statistics
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/stats',
    { preHandler: [requireAuth, requireBoardAccess()] },
    async (request, reply) => {
      const stats = await boardService.getBoardStats(
        (request as any).board.id,
        request.user!.org_id,
      );
      if (!stats) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Board not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: stats });
    },
  );

  // PATCH /boards/:id — Update board metadata
  fastify.patch<{ Params: { id: string } }>(
    '/boards/:id',
    { preHandler: [requireAuth, requireBoardEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateBoardSchema.parse(request.body);
      const board = await boardService.updateBoard(
        (request as any).board.id,
        data as boardService.UpdateBoardInput,
        request.user!.id,
        request.user!.org_id,
      );
      try {
        // `data` is the PATCH body — surface the exact subset of fields the
        // caller changed, with their new values, so Bolt rules can key off
        // specific transitions (e.g. visibility → "organization").
        const changes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) changes[key] = value;
        }
        const payload = await buildBoardEventPayload(
          board.id,
          request.user!.org_id,
          request.user!.id,
          changes,
        );
        publishBoltEvent(
          'board.updated',
          'board',
          payload,
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Enrichment failure must never block the update — drop the event.
      }
      return reply.send({ data: board });
    },
  );

  // DELETE /boards/:id — Archive board
  fastify.delete<{ Params: { id: string } }>(
    '/boards/:id',
    { preHandler: [requireAuth, requireBoardEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const board = await boardService.archiveBoard(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );

  // POST /boards/:id/restore — Restore archived board
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/restore',
    { preHandler: [requireAuth, requireBoardEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const board = await boardService.restoreBoard(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );

  // POST /boards/:id/duplicate — Duplicate board with elements
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/duplicate',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireBoardAccess(), requireScope('read_write')],
    },
    async (request, reply) => {
      const board = await boardService.duplicateBoard(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: board });
    },
  );

  // POST /boards/:id/star — Toggle star on board
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/star',
    { preHandler: [requireAuth, requireBoardAccess()] },
    async (request, reply) => {
      const result = await boardService.toggleStar(
        (request as any).board.id,
        request.user!.id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /boards/:id/lock — Toggle lock on board (admin/owner only)
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/lock',
    { preHandler: [requireAuth, requireBoardEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const board = await boardService.toggleLock(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );
}
