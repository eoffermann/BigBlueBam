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
import { runExtraction } from '../services/engines/extraction.engine.js';
import { attributeAllPending } from '../services/engines/attribution.engine.js';
import { runVarianceSweep } from '../services/engines/variance.engine.js';
import { runRevalue } from '../services/engines/revaluation.engine.js';
import { refreshRollups } from '../services/engines/rollup.engine.js';
import { runRetention } from '../services/engines/retention.engine.js';
import {
  runSilentDeliverableSweep,
  runClaimReaper,
  runCalibrationRecompute,
} from '../services/engines/sweeps.engine.js';
import { applyProposalDecided, reconcileProposals } from '../services/engines/change-order.engine.js';

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
    const { organization_id: orgId, event, source, event_id: eventId, payload } = parsed.data;
    // Durable inbox write (spec 3.1 / 8.3). The GUC is set inside the transaction from the
    // VALIDATED payload org (spec 2.4 point 14), which is what makes this route work under
    // BBB_RLS_ENFORCE=1. Idempotent on (org, source_idempotency_key), so a redelivered event or
    // a reconcile-pass replay collapses onto one pending row rather than double-attributing.
    const idem = eventId ?? (typeof payload._event_id === 'string' ? (payload._event_id as string) : `${source}:${event}:${Date.now()}`);
    const scopeFields = extractScopeFields(payload);
    const accepted = await runInOrgScope(orgId, async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO burn_ingest_events (organization_id, source_idempotency_key, source, event_type, scope_fields, status, received_at)
        VALUES (${orgId}, ${idem}, ${source}, ${event}, ${JSON.stringify(scopeFields)}::jsonb, 'pending', now())
        ON CONFLICT (organization_id, source_idempotency_key) DO NOTHING
        RETURNING id
      `);
      const rows = (Array.isArray(inserted) ? inserted : ((inserted as { rows?: unknown[] }).rows ?? [])) as unknown[];
      return rows.length > 0;
    });
    return reply.status(202).send({
      data: { accepted, event, source, event_id: eventId ?? null, queued_for: 'burn-attribute-batch' },
    });
  });

  // ── Engine invocation routes (spec 4 / 8.1). The 11 worker jobs are thin HTTP callers that
  //    POST here so all engine logic lives in one container (spec 4.0). Each fails via
  //    mapServiceError; a thrown error surfaces a 5xx so BullMQ retries with backoff. ─────────
  const orgOptSchema = z.object({ organization_id: z.string().uuid().optional() });

  async function engineRoute(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    run: (orgId: string | null) => Promise<unknown>,
  ) {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = orgOptSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const summary = await run(parsed.data.organization_id ?? null);
      return { data: summary };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  }

  const extractionSchema = z.object({
    organization_id: z.string().uuid(),
    engagement_id: z.string().uuid(),
    source_text: z.string(),
    source_doc_hash: z.string().min(1).max(64),
    doc_bytes: z.number().int().nonnegative().optional(),
    doc_pages: z.number().int().nonnegative().optional(),
  });

  fastify.post('/internal/run-extraction', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = extractionSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await runExtraction(parsed.data, request.log);
      return { data: result };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  const attributeSchema = z.object({
    organization_id: z.string().uuid().optional(),
    claimed_by: z.string().min(1).max(64).default('worker'),
  });
  fastify.post('/internal/engines/attribute-batch', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = attributeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await attributeAllPending(parsed.data.organization_id ?? null, parsed.data.claimed_by, request.log);
      return { data: result };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/internal/engines/variance-sweep', (request, reply) =>
    engineRoute(request, reply, (orgId) => runVarianceSweep(orgId, request.log)));
  fastify.post('/internal/engines/revalue', (request, reply) =>
    engineRoute(request, reply, (orgId) => runRevalue(orgId, request.log)));
  fastify.post('/internal/engines/silent-sweep', (request, reply) =>
    engineRoute(request, reply, (orgId) => runSilentDeliverableSweep(orgId, request.log)));
  fastify.post('/internal/engines/rollup-refresh', (request, reply) =>
    engineRoute(request, reply, (orgId) => refreshRollups(orgId, request.log)));
  fastify.post('/internal/engines/retention', (request, reply) =>
    engineRoute(request, reply, (orgId) => runRetention(orgId, request.log)));
  fastify.post('/internal/engines/claim-reap', (request, reply) =>
    engineRoute(request, reply, (orgId) => runClaimReaper(orgId, request.log)));
  fastify.post('/internal/engines/proposal-reconcile', (request, reply) =>
    engineRoute(request, reply, (orgId) => reconcileProposals(orgId, request.log)));
  fastify.post('/internal/engines/calibration-recompute', (request, reply) =>
    engineRoute(request, reply, (orgId) => runCalibrationRecompute(orgId, fastify.redis, request.log)));

  // Registered but scheduled OFF (behind embedding_enabled). A no-op that exists so the queue and
  // its route form a stable contract.
  fastify.post('/internal/engines/embed-sync', (request, reply) =>
    engineRoute(request, reply, async () => ({ status: 'disabled', reason: 'embedding_enabled=false' })));

  const proposalDecidedSchema = z.object({
    organization_id: z.string().uuid(),
    proposal_id: z.string().uuid(),
    decider_id: z.string().uuid().nullable().optional(),
  });
  fastify.post('/internal/engines/proposal-decided', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = proposalDecidedSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await applyProposalDecided(
        parsed.data.organization_id,
        parsed.data.proposal_id,
        parsed.data.decider_id ?? null,
        request.log,
      );
      return { data: result };
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}

// The id-typed scoping fields lifted from an event payload into the inbox row's scope_fields.
// uuid-validated on write; non-conforming values are dropped (spec ingest-events schema).
const SCOPE_PATHS = [
  'task.project_id', 'task.id', 'project.id', 'project_id', 'expense.id', 'invoice.id',
  'invoice.project_id', 'company.id', 'deal.id', 'actor.id', 'rate.id', 'id',
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nestedValue(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function extractScopeFields(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of SCOPE_PATHS) {
    const v = nestedValue(payload, path);
    if (typeof v === 'string' && UUID_RE.test(v)) {
      out[path] = v;
      const seg = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
      if (!(seg in out)) out[seg] = v;
    }
  }
  // Preserve the payload _event_id so the reconcile passes can correlate.
  if (typeof payload._event_id === 'string') out._event_id = payload._event_id;
  return out;
}
