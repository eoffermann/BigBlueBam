import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import {
  requireBoardAccess,
  requireBoardEditAccess,
} from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as boardService from '../services/board.service.js';
import { publishBoltEvent, buildBoardEventPayload } from '../lib/bolt-events.js';

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
    { preHandler: [requireAuth, shadowOnly('board.board.list')] },
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
      preHandler: [requireAuth, fastify.requireCan('board.board.create'), requireScope('read_write')],
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
    { preHandler: [requireAuth, shadowOnly('board.board_recent.list')] },
    async (request, reply) => {
      const result = await boardService.getRecent(request.user!.id, request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /boards/starred — User's starred boards
  fastify.get(
    '/boards/starred',
    { preHandler: [requireAuth, shadowOnly('board.board_starred.list')] },
    async (request, reply) => {
      const result = await boardService.getStarred(request.user!.id, request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /boards/stats — Org-level board statistics
  fastify.get(
    '/boards/stats',
    { preHandler: [requireAuth, shadowOnly('board.board_stat.list')] },
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
      preHandler: [requireAuth, shadowOnly('board.board_search.list')],
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
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board.get')] },
    async (request, reply) => {
      const board = await boardService.getBoard(
        (request as any).board.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );

  // GET /boards/:id/integrity — Per-board integrity check
  // Returns the structured issue list that powers the alert UX. The list
  // response carries an integrity_issue_count for the card-level indicator;
  // this endpoint backs the canvas-level banner and the Detach / Reassign
  // remediation dialog.
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/integrity',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_integrity.get')] },
    async (request, reply) => {
      const issues = await boardService.checkBoardIntegrity(
        (request as any).board.id,
        request.user!.org_id,
      );
      return reply.send({ data: { issues, ok: issues.length === 0 } });
    },
  );

  // POST /boards/:id/remediate — Apply a fix for an integrity issue
  // Two operations: detach (project_id := NULL) or reassign (project_id :=
  // <new id from caller's org>). Both write a board_integrity_audit row so
  // the operator can see what got fixed by whom. The trigger from migration
  // 0143 means a malformed reassign target is caught at the DB level too.
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/remediate',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_remediate.create'), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.discriminatedUnion('action', [
        z.object({ action: z.literal('detach') }),
        z.object({ action: z.literal('reassign'), project_id: z.string().uuid() }),
      ]);
      const body = schema.parse(request.body);
      const board = await boardService.remediateBoardIntegrity({
        boardId: (request as any).board.id,
        orgId: request.user!.org_id,
        userId: request.user!.id,
        action: body,
      });
      return reply.send({ data: board });
    },
  );

  // GET /boards/:id/stats — Board statistics
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/stats',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_stat.get')] },
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
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board.update'), requireScope('read_write')] },
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
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const board = await boardService.archiveBoard(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: board });
    },
  );

  // DELETE /boards/:id/permanent — Hard-delete a board (and via FK CASCADE,
  // all its elements, collaborators, stars, versions, etc.). Distinct from
  // the plain DELETE which archives. The /permanent suffix keeps the two
  // affordances visible in the route list and route logs; using a query
  // param like ?permanent=true would conflate the two in audit grep.
  fastify.delete<{ Params: { id: string } }>(
    '/boards/:id/permanent',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_permanent.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const result = await boardService.permanentlyDeleteBoard(
        (request as any).board.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /boards/:id/restore — Restore archived board
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/restore',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board.restore'), requireScope('read_write')] },
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
      preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board.duplicate'), requireScope('read_write')],
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
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_star.create')] },
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
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board.lock'), requireScope('read_write')] },
    async (request, reply) => {
      const { board, previousLocked } = await boardService.toggleLock(
        (request as any).board.id,
        request.user!.id,
        request.user!.org_id,
      );
      try {
        const payload = await buildBoardEventPayload(
          board.id,
          request.user!.org_id,
          request.user!.id,
          {
            previous_locked: previousLocked,
            locked: board.locked,
          },
        );
        payload['board.locked'] = board.locked;
        payload['board.locked_by'] = request.user!.id;
        payload['board.locked_at'] = board.updated_at;
        publishBoltEvent(
          'board.locked',
          'board',
          payload,
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Enrichment failure must never block the lock toggle — drop the event.
      }
      return reply.send({ data: board });
    },
  );
}
