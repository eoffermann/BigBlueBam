import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  LINK_KINDS,
  createLink,
  listLinks,
  removeLink,
} from '../services/entity-links.service.js';

/**
 * Entity-links routes (AGENTIC_TODO §16, Wave 4).
 *
 *   GET    /v1/entity-links
 *   POST   /v1/entity-links
 *   DELETE /v1/entity-links/:id
 *
 * Thin HTTP shell around services/entity-links.service.ts. All the
 * preflight + cycle-detection logic lives there so the MCP tool and the
 * REST route share a single decision path.
 */

const listQuerySchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().uuid(),
  direction: z.enum(['src', 'dst', 'both']).optional().default('both'),
  kind: z.enum(LINK_KINDS as unknown as [string, ...string[]]).optional(),
  limit: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().positive().max(500))
    .optional(),
});

const createBodySchema = z.object({
  src_type: z.string().min(1).max(64),
  src_id: z.string().uuid(),
  dst_type: z.string().min(1).max(64),
  dst_id: z.string().uuid(),
  link_kind: z.enum(LINK_KINDS as unknown as [string, ...string[]]),
});

export default async function entityLinksRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // GET /v1/entity-links
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/v1/entity-links',
    { preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.entity_link.list')] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid entity-links list query',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const { type, id, direction, kind, limit } = parsed.data;
      const result = await listLinks({
        callerUserId: user.id,
        orgId: user.active_org_id,
        type,
        id,
        direction,
        kind: kind as (typeof LINK_KINDS)[number] | undefined,
        limit: limit ?? 100,
      });

      return reply.send({
        data: result.data.map((r) => ({
          id: r.id,
          org_id: r.org_id,
          src_type: r.src_type,
          src_id: r.src_id,
          dst_type: r.dst_type,
          dst_id: r.dst_id,
          link_kind: r.link_kind,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
          direction: r.direction,
        })),
        filtered_count: result.filtered_count,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/entity-links
  // ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/v1/entity-links',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.entity_link.create')] },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid entity-link create payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const body = parsed.data;
      const result = await createLink({
        callerUserId: user.id,
        orgId: user.active_org_id,
        srcType: body.src_type,
        srcId: body.src_id,
        dstType: body.dst_type,
        dstId: body.dst_id,
        linkKind: body.link_kind as (typeof LINK_KINDS)[number],
      });

      if (!result.ok) {
        return reply.status(result.status).send({
          error: {
            code: result.code,
            message: result.message,
            details: result.details ?? [],
            request_id: request.id,
            ...(result.preflight ? { preflight: result.preflight } : {}),
          },
        });
      }

      const row = result.data;
      return reply.status(result.created ? 201 : 200).send({
        data: {
          id: row.id,
          org_id: row.org_id,
          src_type: row.src_type,
          src_id: row.src_id,
          dst_type: row.dst_type,
          dst_id: row.dst_id,
          link_kind: row.link_kind,
          created_by: row.created_by,
          created_at: row.created_at.toISOString(),
        },
        created: result.created,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // DELETE /v1/entity-links/:id
  // ────────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/entity-links/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bam.entity_link.delete')] },
    async (request, reply) => {
      const user = request.user!;
      const result = await removeLink({
        callerUserId: user.id,
        orgId: user.active_org_id,
        linkId: request.params.id,
      });
      if (!result.ok) {
        return reply.status(result.status).send({
          error: {
            code: result.code,
            message: result.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      // Return 200 with body so the MCP tool (which parses JSON unconditionally)
      // does not see an empty-body 204. The plan's spec for entity_link_remove
      // is { ok: true } anyway.
      return reply.status(200).send({ ok: true });
    },
  );
}
