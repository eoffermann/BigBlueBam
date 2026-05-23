import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess, requireDocumentEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as versionService from '../services/version.service.js';

const createVersionSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  change_summary: z.string().max(1000).nullable().optional(),
});

export default async function versionRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/versions — List version history
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/versions',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_version.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const versions = await versionService.listVersions(doc.id);
      return reply.send({ data: versions });
    },
  );

  // POST /documents/:id/versions — Create a named snapshot
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/versions',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_version.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createVersionSchema.parse(request.body ?? {});
      const doc = (request as any).document;
      const version = await versionService.createVersion(
        doc.id,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: version });
    },
  );

  // GET /documents/:id/versions/:versionId — Get a specific version
  fastify.get<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_version.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const version = await versionService.getVersion(doc.id, request.params.versionId);

      if (!version) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Version not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: version });
    },
  );

  // POST /documents/:id/versions/:versionId/restore — Restore a version
  fastify.post<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId/restore',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_version.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const restored = await versionService.restoreVersion(
        doc.id,
        request.params.versionId,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: restored });
    },
  );

  // GET /documents/:id/versions/:v1/diff/:v2 — Compare two versions
  fastify.get<{ Params: { id: string; v1: string; v2: string } }>(
    '/documents/:id/versions/:v1/diff/:v2',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_version_diff.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const { v1, v2 } = request.params;

      const [version1, version2] = await Promise.all([
        versionService.getVersion(doc.id, v1),
        versionService.getVersion(doc.id, v2),
      ]);

      if (!version1) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Version ${v1} not found`,
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!version2) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Version ${v2} not found`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const lines1 = (version1.plain_text ?? '').split('\n');
      const lines2 = (version2.plain_text ?? '').split('\n');

      // Simple line-by-line diff using LCS approach
      const diff = computeLineDiff(lines1, lines2);

      return reply.send({
        data: {
          v1: { id: version1.id, version_number: version1.version_number },
          v2: { id: version2.id, version_number: version2.version_number },
          changes: diff,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Simple line-by-line diff (LCS-based)
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  line: string;
  line_number_old?: number;
  line_number_new?: number;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: 'unchanged',
        line: oldLines[i - 1]!,
        line_number_old: i,
        line_number_new: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({
        type: 'added',
        line: newLines[j - 1]!,
        line_number_new: j,
      });
      j--;
    } else {
      result.push({
        type: 'removed',
        line: oldLines[i - 1]!,
        line_number_old: i,
      });
      i--;
    }
  }

  return result.reverse();
}
