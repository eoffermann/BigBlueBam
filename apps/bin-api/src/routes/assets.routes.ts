import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as assetService from '../services/asset.service.js';
import { NotFoundError, ConflictError, StorageError } from '../services/asset.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createAssetSchema = z.object({
  name: z.string().min(1).max(512),
  content_type: z.string().min(1).max(255),
  folder_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['organization', 'project', 'private']).optional(),
});

const presignVersionSchema = z.object({
  filename: z.string().min(1).max(512).optional(),
  content_type: z.string().min(1).max(255).optional(),
});

// ---------------------------------------------------------------------------
// Error envelope mapping
// ---------------------------------------------------------------------------

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof ConflictError) {
    return reply.status(409).send({
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof StorageError) {
    return reply.status(502).send({
      error: { code: 'STORAGE_ERROR', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

export default async function assetRoutes(fastify: FastifyInstance) {
  // GET /assets — list assets (optionally by folder/project)
  fastify.get('/assets', { preHandler: [requireAuth] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const assets = await assetService.listAssets(request.user!.org_id, {
      folder_id: q.folder_id === 'root' ? null : q.folder_id,
      project_id: q.project_id,
      include_archived: q.include_archived === 'true',
    });
    return reply.send({ data: assets });
  });

  // POST /assets — create an asset (metadata only; upload follows)
  fastify.post(
    '/assets',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset.create')] },
    async (request, reply) => {
      const body = createAssetSchema.parse(request.body);
      try {
        const asset = await assetService.createAsset(body, request.user!.org_id, request.user!.id);
        return reply.status(201).send({ data: asset });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /assets/:id — get a single asset
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const asset = await assetService.getAsset(request.params.id, request.user!.org_id);
        return reply.send({ data: asset });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /assets/:id/archive — soft-delete an asset
  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/archive',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset.archive')] },
    async (request, reply) => {
      try {
        const asset = await assetService.archiveAsset(request.params.id, request.user!.org_id);
        return reply.send({ data: asset });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /assets/:id/download — presigned GET for the current version
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id/download',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const result = await assetService.presignAssetDownload(request.params.id, request.user!.org_id);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // ---- Versions ----------------------------------------------------------

  // GET /assets/:id/versions — list versions for an asset
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id/versions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const versions = await assetService.listVersions(request.params.id, request.user!.org_id);
        return reply.send({ data: versions });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /assets/:id/versions — reserve a version + return a presigned PUT
  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/versions',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset_version.create')] },
    async (request, reply) => {
      const body = presignVersionSchema.parse(request.body ?? {});
      try {
        const result = await assetService.presignVersionUpload(
          request.params.id,
          request.user!.org_id,
          request.user!.id,
          body,
        );
        return reply.status(201).send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /versions/:id — get a single version
  fastify.get<{ Params: { id: string } }>(
    '/versions/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const version = await assetService.getVersion(request.params.id, request.user!.org_id);
        return reply.send({ data: version });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /versions/:id/complete — finalize an uploaded version
  fastify.post<{ Params: { id: string } }>(
    '/versions/:id/complete',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.version_complete.create')] },
    async (request, reply) => {
      try {
        const result = await assetService.completeVersion(request.params.id, request.user!.org_id);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
