import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { bursarRunDerivationSchema, bursarRunReaperSchema } from '@bigbluebam/shared';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { validationError } from '../lib/http.js';
import { runInOrgScope } from '../plugins/rls.js';
import {
  runDerivationSlice,
  LeaseHeldError,
  DerivationRunNotFoundError,
  type ScopeClassifier,
} from '../services/engines/derivation.engine.js';
import { makeDbDerivationStore, makeLlmClassifier } from '../services/engines/derivation.store.js';
import { LlmThrottledError } from '../lib/llm-errors.js';
import { reapOrg, DEFAULT_REAPER_LEASE_MS } from '../services/engines/reaper.engine.js';
import { reapAllStale, makeDbReaperStore } from '../services/engines/reaper.store.js';
import { runInjectionPrescan } from '../services/scope.service.js';

/**
 * Internal, service-to-service routes (spec 5.5). Session-less: `organization_id` comes from the
 * VALIDATED payload, and the RLS GUC is bound in the same transaction via runInOrgScope inside
 * each store method. `requireInternalSecret` fails CLOSED on an empty secret.
 *
 * ── /internal/run-derivation ────────────────────────────────────────────────
 * Async-start derivation. Each call processes AT MOST ONE chunk of the request document and
 * returns quickly; the worker polls with the same run_id until `done`. A live lease held by a
 * different claimant returns 409; a throttle returns 429 (the worker resumes from the checkpoint);
 * an unknown run returns 404. `BURSAR_ENGINE_TIMEOUT_MS` bounds only the worker's call to this
 * route, never the work itself.
 */
const NULL_CLASSIFIER: ScopeClassifier = {
  async classifyChunk() {
    throw new Error('classifier invoked without a configured provider');
  },
};

export default async function internalRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/run-derivation', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bursarRunDerivationSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const { organization_id: orgId, request_id, run_id, source_text, source_doc_hash, claimant } = parsed.data;

    // Resolve the org's configured provider; null -> the engine fails the run loudly at 'blocked'.
    const providerId = await runInOrgScope(orgId, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT llm_provider_id FROM bursar_org_settings WHERE organization_id = ${orgId} LIMIT 1
      `)) as unknown;
      const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
        llm_provider_id: string | null;
      }>;
      return list[0]?.llm_provider_id ?? null;
    });

    const classifier = providerId ? makeLlmClassifier(providerId) : NULL_CLASSIFIER;
    const store = makeDbDerivationStore();

    // Stage 0 pre-scan runs once, on the first slice (before any chunk is processed), on the exact
    // text the engine sees. Both the inline path and the Bin-byte path reach this point.
    const existing = await store.loadRun(orgId, run_id);
    if (existing && existing.last_processed_chunk < 0) {
      await runInjectionPrescan(orgId, request_id, source_text).catch((err) => {
        request.log.warn({ err, request_id }, 'bursar derivation: injection pre-scan failed (non-fatal)');
      });
    }

    try {
      const result = await runDerivationSlice(
        {
          orgId,
          requestId: request_id,
          runId: run_id,
          claimant,
          sourceText: source_text,
          sourceDocHash: source_doc_hash ?? null,
          providerId,
        },
        store,
        classifier,
        request.log,
      );
      reply.status(result.done ? 200 : 202);
      return { data: result };
    } catch (err) {
      if (err instanceof LeaseHeldError) {
        return reply.status(409).send({
          error: {
            code: 'RUN_CLAIMED',
            message: 'Derivation run is claimed by another worker',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (err instanceof LlmThrottledError) {
        reply.header('retry-after', String(err.retryAfterSeconds));
        return reply.status(429).send({
          error: {
            code: 'LLM_THROTTLED',
            message: 'LLM concurrency cap reached; retry to resume from the checkpoint',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (err instanceof DerivationRunNotFoundError) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Derivation run not found', details: [], request_id: request.id },
        });
      }
      throw err;
    }
  });

  /**
   * ── /internal/run-reaper ──────────────────────────────────────────────────
   * Reverts stale derivation runs (and their owning 'deriving' requests) to a re-derivable state,
   * and unwedges offers stuck 'parsing'. Pass `organization_id` to sweep one org, or omit it to
   * sweep every org with stale work. The M8 worker registration fires this every 5 minutes.
   */
  fastify.post('/internal/run-reaper', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bursarRunReaperSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const leaseMs = parsed.data.lease_ms ?? DEFAULT_REAPER_LEASE_MS;

    if (parsed.data.organization_id) {
      const summary = await reapOrg(makeDbReaperStore(), parsed.data.organization_id, leaseMs);
      return { data: { ...summary, orgs: 1 } };
    }
    const summary = await reapAllStale(leaseMs);
    return { data: summary };
  });
}
