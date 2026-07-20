import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  bursarRunDerivationSchema,
  bursarRunReaperSchema,
  bursarParseOfferSchema,
  bursarRunLevelingSchema,
  publishBoltEvent,
  type BursarSourceFormat,
} from '@bigbluebam/shared';
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
import { parseOfferDocument, withParseBudget, type ParseOutcome } from '../services/engines/parse.engine.js';
import {
  claimOfferForParse,
  loadOfferForParse,
  loadParseSettings,
  loadRequestNodes,
  persistParseOutcome,
} from '../services/engines/parse.store.js';
import {
  runLevelingSlice,
  LevelingLeaseHeldError,
  LevelingRunNotFoundError,
} from '../services/engines/leveling.engine.js';
import { makeDbLevelingStore, makeLlmCoverageClassifier } from '../services/engines/leveling.store.js';
import { loadLevelingSettings } from '../services/leveling.service.js';
import type { CoverageClassifier } from '../services/engines/leveling-classifier.js';

/** Map a MIME content-type to a Bursar source format for content-type pinning (spec 5.4). */
function formatFromContentType(ct: string | null | undefined): BursarSourceFormat | null {
  if (!ct) return null;
  const c = ct.toLowerCase();
  if (c.includes('pdf')) return 'pdf';
  if (c.includes('tab-separated') || c.includes('tsv')) return 'tsv';
  if (c.includes('csv')) return 'csv';
  if (c.includes('ndjson') || c.includes('jsonl')) return 'jsonl';
  if (c.includes('yaml')) return 'yaml';
  if (c.includes('json')) return 'json';
  if (c.includes('spreadsheet') || c.includes('excel') || c.includes('officedocument.spreadsheet')) return 'xlsx';
  if (c.includes('rfc822') || c.includes('message/')) return 'email';
  return 'text';
}

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

const NULL_COVERAGE_CLASSIFIER: CoverageClassifier = {
  async classifyBatch() {
    throw new Error('coverage classifier invoked without a configured provider');
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

  /**
   * ── /internal/parse-offer ─────────────────────────────────────────────────
   * Deterministic Stage-1 offer parse (spec 4.1, M4). Session-less: `organization_id` comes from
   * the VALIDATED payload. The worker forwards the pinned Bin bytes (base64) after its own §5.8
   * re-assertion, or inline text; this route runs the WHOLE pipeline (ceilings, content-type
   * pinning, extraction, segmentation, parse_quality, lexicons, structural matching, the two §4.3
   * counters) under a wall-clock budget and persists. NO LLM. Unlike derivation this is a single
   * bounded invocation, so it does not poll: it returns the terminal parse result directly.
   */
  fastify.post('/internal/parse-offer', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bursarParseOfferSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const data = parsed.data;
    const started = Date.now();

    const offer = await loadOfferForParse(data.organization_id, data.offer_id);
    if (!offer) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Offer not found', details: [], request_id: request.id },
      });
    }

    // Resolve the document bytes: base64 (canonical, PDFs + structured) or inline text.
    const buf =
      data.source_bytes_b64 !== undefined
        ? Buffer.from(data.source_bytes_b64, 'base64')
        : Buffer.from(data.source_text ?? '', 'utf8');
    const byteLen = data.byte_len ?? buf.length;
    const declaredFormat: BursarSourceFormat =
      data.declared_format ??
      (offer.source_format as BursarSourceFormat | null) ??
      formatFromContentType(data.content_type) ??
      'text';

    request.log.info(
      { org_id: data.organization_id, offer_id: data.offer_id, bytes: byteLen, format: declaredFormat },
      'bursar parse-offer: claiming + reading bytes',
    );
    await claimOfferForParse(data.organization_id, data.offer_id);

    const [nodes, settings] = await Promise.all([
      loadRequestNodes(data.organization_id, offer.request_id),
      loadParseSettings(data.organization_id),
    ]);

    request.log.info(
      { org_id: data.organization_id, offer_id: data.offer_id, nodes: nodes.length, elapsedMs: Date.now() - started },
      'bursar parse-offer: parsing',
    );
    let outcome: ParseOutcome;
    try {
      outcome = await withParseBudget(
        () =>
          parseOfferDocument({
            buf,
            declaredFormat,
            nodes,
            settings,
            byteLen,
            uncompressedBytes: null,
            entryCount: null,
          }),
        settings.limits.parseWallClockMs,
      );
    } catch (err) {
      // A wall-clock overrun (spec 5.4): mark the offer failed so the reaper does not have to, and
      // surface the reason. Never silently succeed.
      await claimOfferForParse(data.organization_id, data.offer_id).catch(() => {});
      request.log.warn({ err: (err as Error).message, offer_id: data.offer_id }, 'bursar parse-offer: budget exceeded');
      return reply.status(200).send({ data: { offer_id: data.offer_id, status: 'failed', error: (err as Error).message } });
    }

    request.log.info(
      { org_id: data.organization_id, offer_id: data.offer_id, status: outcome.status, elapsedMs: Date.now() - started },
      'bursar parse-offer: persisting',
    );
    await persistParseOutcome(data.organization_id, offer, outcome, declaredFormat, byteLen);

    request.log.info(
      { org_id: data.organization_id, offer_id: data.offer_id, status: outcome.status, elapsedMs: Date.now() - started },
      'bursar parse-offer: done',
    );
    return {
      data: {
        offer_id: data.offer_id,
        status: outcome.status,
        parse_quality: outcome.parse_quality,
        unsubpriced_mandatory_count: outcome.counters.unsubpriced_mandatory_count,
        evidence_concentration: outcome.counters.evidence_concentration,
        blanket_suspected: outcome.blanket_suspected,
        manipulation_suspected: outcome.manipulation.suspected,
      },
    };
  });

  /**
   * ── /internal/run-leveling ─────────────────────────────────────────────────
   * Async-start leveling (spec 3.4-3.9, M5). Each call processes AT MOST ONE offer of the request
   * and returns quickly; the worker polls with the same run_id until `done`. A live lease held by a
   * different claimant returns 409; a throttle returns 429 (the worker resumes from the checkpoint);
   * an unknown run returns 404. No provider configured -> the engine fails the run at 'blocked'.
   */
  fastify.post('/internal/run-leveling', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bursarRunLevelingSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const { organization_id: orgId, request_id, run_id, claimant } = parsed.data;

    const { providerId, settings, parseQualityFloor } = await loadLevelingSettings(orgId);
    const classifier: CoverageClassifier = providerId ? makeLlmCoverageClassifier(providerId) : NULL_COVERAGE_CLASSIFIER;
    const store = makeDbLevelingStore();

    try {
      const result = await runLevelingSlice(
        { orgId, requestId: request_id, runId: run_id, claimant, providerId, settings, parseQualityFloor },
        store,
        classifier,
        request.log,
      );
      // Events (refs + scalars only, best-effort): a published mandatory gap for the offer just
      // processed fires exclusion.detected; the terminal run fires quote.leveled.
      if (result.publishedGaps > 0 && result.processedOfferId) {
        await publishBoltEvent(
          'exclusion.detected',
          'bursar',
          { 'offer.id': result.processedOfferId, 'request.id': request_id, 'org.id': orgId, gap_count: result.publishedGaps },
          orgId,
        ).catch(() => {});
      }
      if (result.done && (result.status === 'succeeded' || result.status === 'partial')) {
        await publishBoltEvent(
          'quote.leveled',
          'bursar',
          { 'request.id': request_id, 'run.id': run_id, 'org.id': orgId, status: result.status, offer_count: result.offerCount },
          orgId,
        ).catch(() => {});
      }
      reply.status(result.done ? 200 : 202);
      return { data: result };
    } catch (err) {
      if (err instanceof LevelingLeaseHeldError) {
        return reply.status(409).send({
          error: { code: 'RUN_CLAIMED', message: 'Leveling run is claimed by another worker', details: [], request_id: request.id },
        });
      }
      if (err instanceof LlmThrottledError) {
        reply.header('retry-after', String(err.retryAfterSeconds));
        return reply.status(429).send({
          error: { code: 'LLM_THROTTLED', message: 'LLM concurrency cap reached; retry to resume from the checkpoint', details: [], request_id: request.id },
        });
      }
      if (err instanceof LevelingRunNotFoundError) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Leveling run not found', details: [], request_id: request.id },
        });
      }
      throw err;
    }
  });
}
