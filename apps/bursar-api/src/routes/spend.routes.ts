import type { FastifyInstance } from 'fastify';
import { bursarSpendImportSchema, bursarListQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as spend from '../services/spend.service.js';

// Spend routes (spec 11, M8). GET /spend and GET /spend/by-vendor carry bursar.spend.read_all as
// route-file permission metadata (the manifest generator emits the action from the requireCan call),
// following burn's financial-flooring pattern: the money projection is BOTH gated at the route AND
// floored at the serializer for a caller who somehow reaches it without read_all. Import is a
// separate write action (bursar.spend.import).
export default async function spendRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // ── The observed spend stream ───────────────────────────────────────────────
  fastify.get('/spend', { preHandler: [requireAuth, can('bursar.spend.read_all')] }, async (request) => {
    const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
    const parsed = bursarListQuerySchema.safeParse(q);
    const limit = parsed.success ? parsed.data.limit : 25;
    const result = await spend.listSpend(viewerOf(request), {
      cursor: q.cursor,
      limit,
      vendorId: q.filter?.vendor_id,
      normalizedPayee: q.filter?.normalized_payee,
    });
    return redactFinancialFields(result, await request.viewerCaps());
  });

  // ── Per-vendor (and per-shadow-payee) rollup ─────────────────────────────────
  fastify.get('/spend/by-vendor', { preHandler: [requireAuth, can('bursar.spend.read_all')] }, async (request) => {
    const result = await spend.listSpendByVendor(viewerOf(request));
    return redactFinancialFields(result, await request.viewerCaps());
  });

  // ── Resumable, deduped statement import ──────────────────────────────────────
  fastify.post('/spend/import', { preHandler: [requireAuth, can('bursar.spend.import')] }, async (request, reply) => {
    const parsed = bursarSpendImportSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await spend.importSpend(viewerOf(request), parsed.data);
      return { data: result };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  // ── Import batch history ─────────────────────────────────────────────────────
  fastify.get('/spend/imports', { preHandler: [requireAuth, can('bursar.spend.read_all')] }, async (request) => {
    return spend.listSpendImports(viewerOf(request));
  });

  // ── CSV export (formula-neutralized shared helper) ───────────────────────────
  fastify.get('/spend/export', { preHandler: [requireAuth, can('bursar.spend.read_all')] }, async (request, reply) => {
    const csv = await spend.exportSpendCsv(viewerOf(request));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="bursar-spend.csv"');
    return csv;
  });
}
