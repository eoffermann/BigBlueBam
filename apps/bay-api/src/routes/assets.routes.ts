import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as assetService from '../services/asset.service.js';
import * as versionService from '../services/version.service.js';
import { NotFoundError, ConflictError } from '../services/errors.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createAssetSchema = z.object({
  name: z.string().min(1).max(512),
  media_kind: z.enum(['image', 'video', 'audio', 'model']),
  project_id: z.string().uuid().nullable().optional(),
});

const createVersionSchema = z.object({
  bin_asset_id: z.string().uuid().nullable().optional(),
  bin_version_id: z.string().uuid().nullable().optional(),
  media_meta: z.record(z.unknown()).optional(),
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
  throw err;
}

export default async function assetRoutes(fastify: FastifyInstance) {
  // GET /assets — list assets (optionally by project)
  fastify.get('/assets', { preHandler: [requireAuth] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const assets = await assetService.listAssets(request.user!.org_id, {
      project_id: q.project_id,
      include_archived: q.include_archived === 'true',
    });
    return reply.send({ data: assets });
  });

  // POST /assets — create an asset (metadata only; versions follow)
  fastify.post(
    '/assets',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.asset.create')] },
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
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.asset.archive')] },
    async (request, reply) => {
      try {
        const asset = await assetService.archiveAsset(request.params.id, request.user!.org_id);
        return reply.send({ data: asset });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // ---- Versions ----------------------------------------------------------

  // GET /assets/:id/versions — list versions for an asset (newest first)
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id/versions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const versions = await versionService.listVersions(request.params.id, request.user!.org_id);
        return reply.send({ data: versions });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /assets/:id/versions — mint a new version referencing Bin bytes
  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/versions',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.asset_version.create')] },
    async (request, reply) => {
      const body = createVersionSchema.parse(request.body ?? {});
      try {
        const result = await versionService.createVersion(
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
        const version = await versionService.getVersion(request.params.id, request.user!.org_id);
        return reply.send({ data: version });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
