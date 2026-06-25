import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as dataService from '../services/data.service.js';
import { NotFoundError, ConflictError, UnsupportedFormatError } from '../services/data.service.js';

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof UnsupportedFormatError) {
    return reply.status(422).send({
      error: { code: 'UNSUPPORTED_FORMAT', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof ConflictError) {
    return reply.status(409).send({
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

const patchSchema = z.object({
  patches: z
    .array(z.object({ index: z.number().int().min(0), set: z.record(z.unknown()) }))
    .min(1),
});

const appendSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1),
});

const treePatchSchema = z.object({
  patches: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])).min(1), value: z.unknown() }))
    .min(1),
});

const arrayOpSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).optional(),
  op: z.enum(['append', 'insert', 'delete']),
  value: z.record(z.unknown()).optional(),
  index: z.number().int().min(0).optional(),
});

const commentSchema = z.object({
  shape: z.enum(['record', 'tree']),
  anchor: z.unknown(),
  body: z.string().min(1).max(10_000),
  thread_parent_id: z.string().uuid().nullable().optional(),
});

export default async function dataRoutes(fastify: FastifyInstance) {
  // GET /data/:assetId — read as records/tree (where/columns/limit/offset)
  fastify.get<{ Params: { assetId: string } }>(
    '/data/:assetId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      // filter[col]=value -> where map
      const where: Record<string, string> = {};
      for (const [k, v] of Object.entries(q)) {
        const m = /^filter\[(.+)\]$/.exec(k);
        if (m) where[m[1]!] = v;
      }
      try {
        const result = await dataService.readData(request.params.assetId, request.user!.org_id, {
          where,
          columns: q.columns ? q.columns.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
          limit: q.limit ? Number(q.limit) : undefined,
          offset: q.offset ? Number(q.offset) : undefined,
        });
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /data/:assetId/session — open/resume an editing session
  fastify.post<{ Params: { assetId: string } }>(
    '/data/:assetId/session',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_session.create')] },
    async (request, reply) => {
      try {
        const result = await dataService.openSession(request.params.assetId, request.user!.org_id);
        return reply.status(201).send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /data/:assetId/rows — apply cell patches (commits a new version)
  fastify.patch<{ Params: { assetId: string } }>(
    '/data/:assetId/rows',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_row.update')] },
    async (request, reply) => {
      const body = patchSchema.parse(request.body);
      try {
        const result = await dataService.patchRows(
          request.params.assetId,
          request.user!.org_id,
          request.user!.id,
          body.patches,
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /data/:assetId/rows — append rows (commits a new version)
  fastify.post<{ Params: { assetId: string } }>(
    '/data/:assetId/rows',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_row.create')] },
    async (request, reply) => {
      const body = appendSchema.parse(request.body);
      try {
        const result = await dataService.appendRows(
          request.params.assetId,
          request.user!.org_id,
          request.user!.id,
          body.rows,
        );
        return reply.status(201).send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /data/:assetId/tree — set values at paths in a tree-shaped asset
  // (commits a new version). Backs inline editing of the JSON/YAML tree + its
  // embedded grids.
  fastify.patch<{ Params: { assetId: string } }>(
    '/data/:assetId/tree',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_tree.update')] },
    async (request, reply) => {
      const body = treePatchSchema.parse(request.body);
      try {
        const result = await dataService.patchTree(
          request.params.assetId,
          request.user!.org_id,
          request.user!.id,
          body.patches,
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /data/:assetId/array — add/delete a row in any grid (commits a new
  // version). path=[] targets a record asset's top-level rows; a path like
  // ["passengers"] targets a tree embedded grid.
  fastify.post<{ Params: { assetId: string } }>(
    '/data/:assetId/array',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_array.create')] },
    async (request, reply) => {
      const body = arrayOpSchema.parse(request.body);
      try {
        const result = await dataService.arrayRowOp(
          request.params.assetId,
          request.user!.org_id,
          request.user!.id,
          body,
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // ---- Comments ----------------------------------------------------------

  // GET /data/:assetId/comments
  fastify.get<{ Params: { assetId: string } }>(
    '/data/:assetId/comments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      try {
        const comments = await dataService.listComments(
          request.params.assetId,
          request.user!.org_id,
          q.include_resolved === 'true',
        );
        return reply.send({ data: comments });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /data/:assetId/comments
  fastify.post<{ Params: { assetId: string } }>(
    '/data/:assetId/comments',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_comment.create')] },
    async (request, reply) => {
      const body = commentSchema.parse(request.body);
      try {
        const comment = await dataService.createComment(
          request.params.assetId,
          request.user!.org_id,
          request.user!.id,
          body,
        );
        return reply.status(201).send({ data: comment });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /data/:assetId/comments/:commentId/resolve
  fastify.post<{ Params: { assetId: string; commentId: string }; Body: { resolved?: boolean } }>(
    '/data/:assetId/comments/:commentId/resolve',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.data_comment_resolve.create')] },
    async (request, reply) => {
      const resolved = (request.body as { resolved?: boolean } | undefined)?.resolved ?? true;
      try {
        const comment = await dataService.resolveComment(
          request.params.assetId,
          request.user!.org_id,
          request.params.commentId,
          resolved,
        );
        return reply.send({ data: comment });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
