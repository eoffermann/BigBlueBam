/**
 * Bureau summon routes (Agent C, workstream 6).
 *
 * REST mirror of the §8 summon-family WS messages. Same flow, same audit
 * row, same Bolt event — the routes exist so non-WS clients (MCP tools,
 * automation, integration tests) can drive the summon system without
 * holding a socket open.
 *
 *   POST /v1/summon                       — plan + record + fan-out
 *   GET  /v1/summons/:id                  — audit-row lookup
 *   POST /v1/summons/:id/grant-access     — §4.4 grant-and-summon follow-up
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauSummons } from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../middleware/room-access.js';
import {
  fanOutSummon,
  grantAccessAndSummon,
  planSummon,
  recordSummon,
  reportDenials,
} from '../services/summon.service.js';

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const createBody = z.object({
  target_url: z.string().url().or(z.string().min(1).max(2048)),
  target_app: z.string().min(1).max(24),
  target_label: z.string().max(200).optional(),
  lk_room_hint: z.string().max(96).optional(),
});

const grantBody = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

export default async function summonsRoutes(fastify: FastifyInstance) {
  // ───── POST /v1/summon ──────────────────────────────────────────
  fastify.post(
    '/summon',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const { target_url, target_app, target_label, lk_room_hint } =
        parsed.data;

      // 1. Plan — resolves summoner's room, runs cross-app access checks.
      const plan = await planSummon(fastify.redis, {
        orgId: user.org_id,
        summonerId: user.id,
        targetUrl: target_url,
        targetApp: target_app,
        targetLabel: target_label,
        lkRoomHint: lk_room_hint,
      });
      if (!plan) {
        return badRequest(
          request,
          reply,
          'You are not currently in a Bureau room (summon disabled)',
        );
      }

      // 2. Record the audit row.
      const summonId = await recordSummon({
        orgId: user.org_id,
        summonerId: user.id,
        fromRoomId: plan.fromRoomId,
        targetUrl: target_url,
        targetApp: target_app,
        targetLabel: target_label,
        lkRoomHint: lk_room_hint,
        eligible: plan.eligibleRecipients,
        denied: plan.deniedRecipients,
      });

      // 3. Fan out summon_incoming to eligible recipients (inline or via worker).
      await fanOutSummon({
        redis: fastify.redis,
        summonId,
        orgId: user.org_id,
        summonerId: user.id,
        summonerName: user.display_name,
        targetUrl: target_url,
        targetApp: target_app,
        targetLabel: target_label,
        lkRoomHint: lk_room_hint,
        recipients: plan.eligibleRecipients,
        logger: fastify.log,
      });

      // 4. If anyone was denied, send the summoner a §4.4 access report so
      //    the client can offer the "Grant access" dialog.
      if (plan.deniedRecipients.length > 0) {
        await reportDenials({
          redis: fastify.redis,
          summonId,
          summonerId: user.id,
          denied: plan.deniedRecipients,
          canShare: plan.canShare,
        });
      }

      return reply.status(201).send({
        data: {
          summon_id: summonId,
          from_room_id: plan.fromRoomId,
          eligible_count: plan.eligibleRecipients.length,
          denied_count: plan.deniedRecipients.length,
          can_share: plan.canShare,
        },
      });
    },
  );

  // ───── GET /v1/summons/:id ──────────────────────────────────────
  fastify.get(
    '/summons/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [row] = await db
        .select()
        .from(bureauSummons)
        .where(
          and(eq(bureauSummons.id, id), eq(bureauSummons.org_id, user.org_id)),
        )
        .limit(1);

      if (!row) return notFound(request, reply, 'Summon not found');

      // Only the summoner (or org admins/owners) can read the audit row.
      // Recipients see their own outcome via the WS push; they do not need
      // the cross-recipient view this endpoint returns.
      const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';
      if (
        !user.is_superuser &&
        !isAdminOrOwner &&
        row.summoner_id !== user.id
      ) {
        return forbidden(
          request,
          reply,
          'Only the summoner can read this summon',
        );
      }

      return reply.status(200).send({ data: row });
    },
  );

  // ───── POST /v1/summons/:id/grant-access ────────────────────────
  fastify.post(
    '/summons/:id/grant-access',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const parsed = grantBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }

      // The service performs the summoner-id check internally, but we
      // pre-load the row so we can return a friendly 404 vs 403.
      const [row] = await db
        .select({
          id: bureauSummons.id,
          summoner_id: bureauSummons.summoner_id,
        })
        .from(bureauSummons)
        .where(
          and(eq(bureauSummons.id, id), eq(bureauSummons.org_id, user.org_id)),
        )
        .limit(1);
      if (!row) return notFound(request, reply, 'Summon not found');
      if (row.summoner_id !== user.id && !user.is_superuser) {
        return forbidden(
          request,
          reply,
          'Only the summoner can grant access on this summon',
        );
      }

      const result = await grantAccessAndSummon({
        redis: fastify.redis,
        summonId: id,
        summonerId: user.id,
        summonerName: user.display_name,
        userIds: parsed.data.user_ids,
        logger: fastify.log,
      });

      return reply
        .status(200)
        .send({ data: { granted: result.granted, missing: result.missing } });
    },
  );
}
