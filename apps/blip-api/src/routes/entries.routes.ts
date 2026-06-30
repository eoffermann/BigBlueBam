/**
 * Entry query / tail / purge / export REST surface (Blip §7, §11.2, §12.4, §14).
 * Query and tail are member-level reads (blip.entry.read, which also gates the
 * cursor tail). Purge is admin-only with an inline two-step confirm. Export
 * freezes a filtered collection into a Bin JSONL asset via the worker queue.
 * Every handler validates the tracked app belongs to the caller's org first.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import { getApp } from '../services/app.service.js';
import { queryEntries, tailEntries, purgeEntries } from '../services/entry.service.js';
import { enqueueExport } from '../lib/queue.js';
import type { Predicate } from '../lib/predicate.js';

// The predicate tree is validated defensively by the compiler/evaluator, so the
// route accepts it loosely rather than re-deriving the recursive shape in zod.
const filterSchema = z.any().optional();
const sortSchema = z
  .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() }))
  .optional();

const querySchema = z.object({
  report_type: z.string().min(1),
  filter: filterSchema,
  sort: sortSchema,
  page_size: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
  format: z.enum(['json', 'jsonl']).optional(),
});

const tailSchema = z.object({
  report_type: z.string().min(1),
  cursor: z.union([z.string(), z.number()]).optional(),
  filter: filterSchema,
  limit: z.number().int().positive().max(500).optional(),
});

const purgeSchema = z.object({
  report_type: z.string().min(1),
  filter: filterSchema,
  confirm_action: z.boolean().optional(),
});

const exportSchema = z.object({
  report_type: z.string().min(1),
  filter: filterSchema,
  asset_name: z.string().min(1).max(512).optional(),
});

export default async function entriesRoutes(fastify: FastifyInstance) {
  // POST /apps/:id/entries/query — filter/sort/paginate (member). format=jsonl
  // streams one redacted payload object per line.
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/entries/query',
    { preHandler: [requireAuth, fastify.requireCan('blip.entry.read')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        await getApp(request.params.id, orgId);
        const body = querySchema.parse(request.body);
        const result = await queryEntries({
          orgId,
          trackedAppId: request.params.id,
          reportType: body.report_type,
          filter: body.filter as Predicate | undefined,
          sort: body.sort,
          pageSize: body.page_size,
          offset: body.offset,
        });
        if (body.format === 'jsonl') {
          const lines = result.rows
            .map((r) => JSON.stringify((r as { payload?: unknown }).payload ?? r))
            .join('\n');
          return reply
            .type('application/x-ndjson')
            .send(lines.length > 0 ? lines + '\n' : '');
        }
        return reply.send({
          data: {
            rows: result.rows,
            total: result.total,
            page_size: result.page_size,
            offset: result.offset,
          },
        });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/entries/tail — incremental pull, seq > cursor (member)
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/entries/tail',
    { preHandler: [requireAuth, fastify.requireCan('blip.entry.read')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        await getApp(request.params.id, orgId);
        const body = tailSchema.parse(request.body);
        const result = await tailEntries({
          orgId,
          trackedAppId: request.params.id,
          reportType: body.report_type,
          cursorSeq: body.cursor,
          filter: body.filter as Predicate | undefined,
          limit: body.limit,
        });
        return reply.send({ data: { entries: result.entries, max_seq: result.max_seq } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/entries/purge — purge a collection (admin; inline confirm)
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/entries/purge',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.entry.purge')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        await getApp(request.params.id, orgId);
        const body = purgeSchema.parse(request.body);
        if (!body.confirm_action) {
          const preview = await queryEntries({
            orgId,
            trackedAppId: request.params.id,
            reportType: body.report_type,
            filter: body.filter as Predicate | undefined,
            pageSize: 1,
          });
          return reply.send({
            data: {
              preview: true,
              report_type: body.report_type,
              would_delete: preview.total,
              message:
                'This permanently deletes the matching entries. Re-send with ' +
                '{ "confirm_action": true } to execute.',
            },
          });
        }
        const result = await purgeEntries({
          orgId,
          trackedAppId: request.params.id,
          reportType: body.report_type,
          filter: body.filter as Predicate | undefined,
        });
        return reply.send({ data: { deleted: result.deleted } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/entries/export — freeze a collection to a Bin JSONL asset (member)
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/entries/export',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('blip.entry.export')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        const app = await getApp(request.params.id, orgId);
        const body = exportSchema.parse(request.body);
        const assetName =
          body.asset_name ??
          `${app.name} — ${body.report_type} — ${new Date().toISOString().slice(0, 10)}.jsonl`;
        await enqueueExport({
          org_id: orgId,
          tracked_app_id: request.params.id,
          report_type: body.report_type,
          filter: body.filter,
          requested_by: request.user!.id,
          asset_name: assetName,
        });
        return reply.send({ data: { status: 'queued' } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
