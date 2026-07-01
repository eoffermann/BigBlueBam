import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as assetService from '../services/asset.service.js';
import { NotFoundError, ConflictError, StorageError } from '../services/asset.service.js';
import { resolveScanPolicy, setScanOverride } from '../services/scan.service.js';

// A caller is allowed to persistently override / transiently inspect an
// otherwise-unservable file when they are a SuperUser or an org owner/admin.
function callerCanOverride(user: { is_superuser: boolean; role: string } | null): boolean {
  if (!user) return false;
  return user.is_superuser === true || user.role === 'owner' || user.role === 'admin';
}

/**
 * Build the serving-gate opts from the request. The common path (no
 * ?acknowledge_risk) needs no policy read — clean/skipped/overridden assets
 * serve and everything else 409s regardless of the org policy. We only resolve
 * the effective allow-unscanned policy when the caller actually acknowledged
 * the risk, keeping the hot media-serve path free of extra queries.
 */
async function buildServeOpts(
  request: FastifyRequest,
): Promise<assetService.ServeOpts> {
  const acknowledgeRisk = (request.query as { acknowledge_risk?: string }).acknowledge_risk === 'true';
  const canOverride = callerCanOverride(request.user);
  if (!acknowledgeRisk) return { acknowledgeRisk: false, canOverride };
  const policy = await resolveScanPolicy(request.user!.org_id);
  return { acknowledgeRisk: true, canOverride, allowUnscanned: policy.allow_unscanned_access };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createAssetSchema = z.object({
  name: z.string().min(1).max(512),
  content_type: z.string().min(1).max(255),
  folder_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['organization', 'project', 'private']).optional(),
  tags: z.array(z.string()).optional(),
});

const updateAssetSchema = z.object({
  name: z.string().min(1).max(512).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
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
  // Proxied upload uses multipart. Scoped to this route plugin (mirrors the
  // as-built apps/api uploadRoutes registration).
  await fastify.register(multipart, { limits: { fileSize: env.UPLOAD_MAX_FILE_SIZE } });

  // GET /assets — list assets (optionally by folder/project)
  fastify.get('/assets', { preHandler: [requireAuth] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const assets = await assetService.listAssets(request.user!.org_id, {
      folder_id: q.folder_id === 'root' ? null : q.folder_id,
      project_id: q.project_id,
      include_archived: q.include_archived === 'true',
      tag: q.tag,
    });
    return reply.send({ data: assets });
  });

  // GET /tags — distinct tags across the org's non-archived assets
  fastify.get('/tags', { preHandler: [requireAuth] }, async (request, reply) => {
    const tags = await assetService.listTags(request.user!.org_id);
    return reply.send({ data: tags });
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

  // PATCH /assets/:id — update an asset's name/folder/tags
  fastify.patch<{ Params: { id: string } }>(
    '/assets/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset.update')] },
    async (request, reply) => {
      const body = updateAssetSchema.parse(request.body ?? {});
      try {
        const asset = await assetService.updateAsset(request.params.id, request.user!.org_id, body);
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

  // GET /assets/:id/download — presigned GET for the current version.
  // ?acknowledge_risk=true lets a caller with the org policy (or an
  // admin/SuperUser) fetch a still-unscanned/errored file; an overridden file
  // is always downloadable.
  fastify.get<{ Params: { id: string } }>(
    '/assets/:id/download',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const opts = await buildServeOpts(request);
        const result = await assetService.presignAssetDownload(
          request.params.id,
          request.user!.org_id,
          opts,
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // DELETE /assets/:id — hard-delete an asset (row + bytes, decoupled).
  fastify.delete<{ Params: { id: string } }>(
    '/assets/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset.delete')] },
    async (request, reply) => {
      try {
        const result = await assetService.deleteAsset(request.params.id, request.user!.org_id);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /assets/bulk-delete — hard-delete many assets; returns per-id results.
  const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
  fastify.post(
    '/assets/bulk-delete',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset.delete')] },
    async (request, reply) => {
      const body = bulkDeleteSchema.parse(request.body);
      const results = await assetService.deleteAssets(body.ids, request.user!.org_id);
      return reply.send({ data: results });
    },
  );

  // POST /assets/:id/scan-override — persistent per-file scan override
  // (false-positive clear). Admin/SuperUser only. allow:false clears it.
  const scanOverrideSchema = z.object({
    allow: z.boolean(),
    reason: z.string().max(2000).optional(),
  });
  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/scan-override',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      if (!callerCanOverride(request.user)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only an org owner/admin or SuperUser may override a scan block',
            details: [],
            request_id: request.id,
          },
        });
      }
      const body = scanOverrideSchema.parse(request.body ?? {});
      try {
        const result = await setScanOverride(
          request.params.id,
          request.user!.org_id,
          request.user!.id,
          body.allow,
          body.reason ?? null,
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /assets/:id/upload — proxied upload (bytes through the service). The
  // default upload path used by the SPA; works without a browser-reachable
  // provider endpoint (D-7). Reserves a version, streams to the driver, and
  // finalizes in one call.
  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/upload',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.asset_version.create')] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'No file provided', details: [], request_id: request.id },
        });
      }
      const buffer = await file.toBuffer();
      if (buffer.length > env.UPLOAD_MAX_FILE_SIZE) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${env.UPLOAD_MAX_FILE_SIZE} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }
      try {
        const result = await assetService.uploadVersionBytes(
          request.params.id,
          request.user!.org_id,
          request.user!.id,
          buffer,
          { filename: file.filename, content_type: file.mimetype },
        );
        return reply.status(201).send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /assets/:id/raw — proxied serve (bytes through the service). The default
  // serve path used by the SPA; gated on scan_status like /download (§9.3).
  fastify.get<{ Params: { id: string }; Querystring: { variant?: string } }>(
    '/assets/:id/raw',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        // ?variant=proxy|poster serves the worker-derived web-friendly
        // representation; anything else (incl. absent) serves the original.
        const rawVariant = (request.query as { variant?: string }).variant;
        const variant: assetService.ServeVariant =
          rawVariant === 'proxy' || rawVariant === 'poster' ? rawVariant : 'original';
        const serveOpts = await buildServeOpts(request);
        // Honor HTTP Range so browsers can seek/scrub video & audio. We need
        // the total size first; do a tiny range probe (bytes 0-0) to learn it
        // without buffering the whole object, then serve the requested window.
        const rangeHeader = (request.headers.range as string | undefined) ?? '';
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (m && assetService.hasRangeSupport()) {
          const info = await assetService.statServable(
            request.params.id,
            request.user!.org_id,
            variant,
            serveOpts,
          );
          const total = info.total;
          let start = m[1] ? Number(m[1]) : 0;
          let end = m[2] ? Number(m[2]) : total - 1;
          if (Number.isNaN(start) || start < 0) start = 0;
          if (Number.isNaN(end) || end > total - 1) end = total - 1;
          if (start > end) {
            reply.header('Content-Range', `bytes */${total}`);
            return reply.status(416).send();
          }
          const { stream, contentType, size, filename } = await assetService.streamAssetRange(
            request.params.id,
            request.user!.org_id,
            start,
            end,
            variant,
            serveOpts,
          );
          reply.header('Content-Type', contentType);
          reply.header('Content-Length', size);
          reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
          reply.header('Accept-Ranges', 'bytes');
          reply.header('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
          reply.header('Cache-Control', 'private, max-age=300');
          return reply.status(206).send(stream);
        }

        const { stream, contentType, size, filename } = await assetService.streamAssetDownload(
          request.params.id,
          request.user!.org_id,
          variant,
          serveOpts,
        );
        reply.header('Content-Type', contentType);
        reply.header('Content-Length', size);
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
        reply.header('Cache-Control', 'private, max-age=300');
        return reply.send(stream);
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
