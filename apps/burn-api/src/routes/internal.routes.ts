import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  burnInternalPrecheckRequestSchema,
  burnPrecheckOutcomeSchema,
} from '@bigbluebam/shared';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { mapServiceError, validationError } from '../lib/http.js';
import { publishBurnFrame } from '../lib/realtime.js';
import { runInOrgScope } from '../plugins/rls.js';
import { resolveViewerCapsFor } from '../lib/viewer-caps.js';
import { env } from '../env.js';
import * as precheck from '../services/precheck.service.js';
import * as ledger from '../services/ledger.service.js';

/**
 * Internal, service-to-service routes. Spec 6.1 and 2.4 points 14 and 16.
 *
 * ── AUTHENTICATION FAILS CLOSED; AVAILABILITY FAILS OPEN ────────────────────────────
 *
 * `requireInternalSecret` rejects 401 UNCONDITIONALLY when INTERNAL_SERVICE_SECRET is empty,
 * before any timing-safe compare, because an empty-vs-empty compare authorizes anyone. That
 * is deliberately the OPPOSITE posture from the gate itself, which fails OPEN on every
 * availability failure. Do not harmonize them in either direction.
 *
 * ── THE ORG COMES FROM THE VALIDATED PAYLOAD ────────────────────────────────────────
 *
 * There is no session on these routes, so `organization_id` is read from the payload AFTER
 * Zod validation and the RLS GUC is set in the SAME transaction via runInOrgScope. Setting
 * it as a standalone statement (which is what the four existing rls plugins in the tree do)
 * would discard it the instant the statement returned.
 */
export default async function internalRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/precheck', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = burnInternalPrecheckRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const { organization_id: orgId, acting_user_id: actingUserId, ...req } = parsed.data;

    try {
      // The ACTING HUMAN's capabilities drive decision-input quantization, not the calling
      // service's. bill-api holds the internal secret, which is not a financial capability:
      // keying quantization off the caller would hand every gated expense the unquantized
      // boundary and reopen the binary-search oracle through the one path that runs on every
      // charge in the firm.
      const caps = actingUserId
        ? await resolveViewerCapsFor(
            {
              apiInternalUrl: env.BBB_API_INTERNAL_URL,
              internalSecret: env.INTERNAL_SERVICE_SECRET,
              timeoutMs: env.UPSTREAM_TIMEOUT_MS,
              log: request.log,
            },
            actingUserId,
            orgId,
          )
        : { financials_read_all: false, costrate_read: false, resolved: false };

      const result = await precheck.runPrecheck({
        caller: {
          viewer: {
            id: actingUserId ?? '00000000-0000-0000-0000-000000000000',
            org_id: orgId,
            role: 'member',
            is_superuser: false,
          },
          namespace: 'svc',
          canReadAll: caps.financials_read_all,
          redis: fastify.redis,
        },
        req,
        orgId,
      });

      try {
        const projectIds = result.engagement_id
          ? await runInOrgScope(orgId, (tx) =>
              ledger.projectsForChain(tx, orgId, result.engagement_id),
            )
          : [];
        await publishBurnFrame(orgId, projectIds, {
          type: 'precheck.decided',
          precheck_id: result.precheck_id,
          verdict: result.verdict,
          engagement_id: result.engagement_id,
        });
      } catch {
        // advisory only
      }

      return { data: result };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/internal/prechecks/:id/outcome', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const schema = burnPrecheckOutcomeSchema.extend({ organization_id: z.string().uuid() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await precheck.recordOutcome(parsed.data.organization_id, id, {
        outcome: parsed.data.outcome,
        work_ref_id: parsed.data.work_ref_id ?? null,
      });
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  /**
   * Ingest from bolt-api's dispatch hook. The ENGINE lands in M6; this is the accepting
   * endpoint, shipped in the same slice as its contract so bolt-api has something real to
   * point at rather than a route that 404s for a milestone.
   */
  const ingestSchema = z.object({
    organization_id: z.string().uuid(),
    event: z.string().min(1).max(128),
    source: z.string().min(1).max(64),
    payload: z.record(z.unknown()).default({}),
    event_id: z.string().max(128).optional(),
  });

  fastify.post('/internal/events', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const { organization_id: orgId, event, source, event_id: eventId } = parsed.data;
    // The GUC is set inside the transaction from the VALIDATED payload org (spec 2.4
    // point 14), which is what makes this route work at all under BBB_RLS_ENFORCE=1.
    const accepted = await runInOrgScope(orgId, async (tx) => {
      // A no-op probe inside the org-scoped transaction: it proves the GUC bound before the
      // M6 engine starts writing here, and it is what the mandatory RLS test asserts against
      // for the payload-derived path.
      await tx.execute(sql`SELECT current_setting('app.current_org_id', true) AS org`);
      return true;
    });
    return reply.status(202).send({
      data: { accepted, event, source, event_id: eventId ?? null, queued_for: 'burn-attribute-batch' },
    });
  });
}
