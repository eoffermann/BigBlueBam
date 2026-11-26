import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BastionEngineName,
  type BastionRunClaimedError,
  bastionConsumesEvent,
  bastionCompileEngineSchema,
  bastionEvaluateRunEngineSchema,
  bastionInternalEventSchema,
  bastionQuestionnaireEngineSchema,
  bastionSweepEngineSchema,
  bastionExportPacketEngineSchema,
  bastionMirrorEngineSchema,
  bastionVerifyCommitmentsEngineSchema,
} from '@bigbluebam/shared';
import { mirrorObjects, objectSweep } from '../engine/objects.js';
import { verifyCommitments } from '../engine/commitments.js';
import { exportPacketEngine, reapPackets } from '../services/packet.service.js';
import { backupStorage } from '../services/evidence-runtime.js';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { validationError } from '../lib/http.js';
import { canonicalJson, sha256Hex } from '../lib/ledger-canonical.js';
import { publishedSealKeyMap } from '../lib/keys.js';
import { orgTx } from '../engine/context.js';
import { engineDeps } from '../engine/runtime.js';
import { RunLeaseHeldError, RunNotFoundError, runEvaluationSlice } from '../engine/evaluator.js';
import { defaultDeliverer, drainOutbox } from '../engine/outbox.js';
import { redriveRecoveredProjects } from '../engine/remediation.js';
import { evaluateTick, evaluationMissed, ledgerSeal, ledgerVerify, retention, runReaper, weeklyReadiness } from '../engine/sweeps.js';
import { evidenceExpiry, evidenceIngest } from '../services/evidence-engines.js';
import { evidenceDeps } from '../services/evidence-runtime.js';
import { env } from '../env.js';
import { gapRank } from '../engine/gaps.js';
import { proposalReconcile } from '../services/decisions.service.js';
import { compileSlice } from '../services/compile-ai.service.js';
import { compileAiDeps } from '../services/compile-runtime.js';
import { attestationNudge } from '../services/policies.service.js';
import { autofillSlice } from '../services/questionnaire-autofill.service.js';
import { autofillDeps } from '../services/questionnaire-runtime.js';

/**
 * Service-to-service routes (spec 5.1 rows 105-106), behind the shared internal secret and
 * denied at nginx (internal network only). Session-less: organization_id comes from the
 * validated body and every engine binds the RLS GUC itself.
 *
 *   POST /v1/internal/engines/:name  the worker's thin jobs call these (spec 7)
 *   POST /v1/internal/events         bolt-api's bastion dispatch hook forwards subscribed events
 *
 * evaluate-run answers 200 { data: slice } (done or not), 404 for an unknown run, and 409 when
 * another claimant holds a live lease; the 409 body says whether that claim's heartbeat is stale,
 * so the worker waits 30 s and retries instead of ending the attempt (spec 7).
 */
export default async function internalRoutes(fastify: FastifyInstance) {
  const deps = () => engineDeps(fastify.log, fastify.redis);
  const send = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    reply.status(status).send({ error: { code, message, details: [], request_id: request.id, ...extra } });

  fastify.post('/internal/engines/:name', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const nameParsed = BastionEngineName.safeParse((request.params as { name?: string }).name);
    if (!nameParsed.success) return send(request, reply, 404, 'NOT_FOUND', 'Unknown engine');
    const name = nameParsed.data;

    if (name === 'evaluate-run') {
      const parsed = bastionEvaluateRunEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return { data: await runEvaluationSlice(deps(), parsed.data) };
      } catch (err) {
        if (err instanceof RunNotFoundError) return send(request, reply, 404, 'NOT_FOUND', err.message);
        if (err instanceof RunLeaseHeldError) {
          // Built to the shared contract the worker parses (issue #205).
          const body: BastionRunClaimedError = {
            error: {
              code: 'RUN_CLAIMED',
              message: err.message,
              details: [],
              request_id: request.id,
              claimed_by: err.claimedBy,
              heartbeat_stale: err.heartbeatStale,
            },
          };
          return reply.status(409).send(body);
        }
        throw err;
      }
    }

    if (name === 'compile') {
      // M7: async-start LLM slice of one compile run (spec 7.3). Same 404 / 409 contract as evaluate-run.
      const parsed = bastionCompileEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return { data: await compileSlice(compileAiDeps(fastify.log, fastify.redis), parsed.data) };
      } catch (err) {
        if (err instanceof RunNotFoundError) return send(request, reply, 404, 'NOT_FOUND', 'We could not find that compile run.');
        if (err instanceof RunLeaseHeldError) {
          const body: BastionRunClaimedError = {
            error: {
              code: 'RUN_CLAIMED',
              message: 'This compile run is being driven by another worker.',
              details: [],
              request_id: request.id,
              claimed_by: err.claimedBy,
              heartbeat_stale: err.heartbeatStale,
            },
          };
          return reply.status(409).send(body);
        }
        throw err;
      }
    }

    if (name === 'questionnaire-autofill') {
      // M8: async-start LLM slice of one questionnaire (spec 7.3). Same 404 / 409 contract as compile.
      const parsed = bastionQuestionnaireEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return { data: await autofillSlice(autofillDeps(fastify.log, fastify.redis), parsed.data) };
      } catch (err) {
        if (err instanceof RunNotFoundError) return send(request, reply, 404, 'NOT_FOUND', 'We could not find that questionnaire.');
        if (err instanceof RunLeaseHeldError) {
          const body: BastionRunClaimedError = {
            error: {
              code: 'RUN_CLAIMED',
              message: 'This questionnaire is being drafted by another worker.',
              details: [],
              request_id: request.id,
              claimed_by: err.claimedBy,
              heartbeat_stale: err.heartbeatStale,
            },
          };
          return reply.status(409).send(body);
        }
        throw err;
      }
    }

    // M9 (spec 7.2, 9.7): the off-site mirror after each database backup, the packet job's
    // personal-data commitment checks (the HMAC key stays here) and its claim/progress/finish calls.
    if (name === 'mirror-objects') {
      const parsed = bastionMirrorEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return { data: await mirrorObjects(deps(), backupStorage(), parsed.data) };
    }
    if (name === 'verify-commitments') {
      const parsed = bastionVerifyCommitmentsEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return { data: await verifyCommitments(deps(), parsed.data.organization_id, parsed.data.holders) };
    }
    if (name === 'export-packet') {
      const parsed = bastionExportPacketEngineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return { data: await exportPacketEngine(deps(), parsed.data) };
    }

    const parsed = bastionSweepEngineSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const opts = parsed.data;
    const d = deps();
    switch (name) {
      case 'object-sweep':
        return { data: await objectSweep(d, opts) };
      case 'evaluate-tick':
        return { data: await evaluateTick(d, opts) };
      case 'outbox-drain':
        // #229: deliveries that died on a broken Compliance project go back to pending first,
        // once it can take tasks again.
        await redriveRecoveredProjects(d, opts);
        return {
          data: await drainOutbox(
            d,
            defaultDeliverer({
              sql: d.sql,
              storage: d.storage,
              putTimeoutMs: d.putTimeoutMs,
              bam: { apiUrl: env.BBB_API_INTERNAL_URL, secret: env.INTERNAL_SERVICE_SECRET },
            }),
            { orgId: opts.organization_id, claimant: `bastion-api:${process.pid}` },
          ),
        };
      case 'gap-rank':
        return { data: await gapRank(d, opts) };
      case 'proposal-reconcile':
        return { data: await proposalReconcile(d, opts) };
      case 'attestation-nudge':
        return { data: await attestationNudge(d, opts) };
      case 'ledger-seal':
        return { data: await ledgerSeal(d, opts) };
      case 'ledger-verify':
        return { data: await ledgerVerify(d, publishedSealKeyMap(), opts) };
      case 'run-reaper': {
        const reaped = await runReaper(d, opts);
        // M9: stalled audit packets are failed with "build it again".
        const packets = await reapPackets(d, opts);
        return { data: { ...reaped, packets_failed: packets.failed } };
      }
      case 'evaluation-missed':
        return { data: await evaluationMissed(d, opts) };
      case 'weekly-readiness':
        return { data: await weeklyReadiness(d, opts) };
      case 'retention':
        return { data: await retention(d, opts) };
      case 'evidence-ingest':
        return { data: await evidenceIngest(evidenceDeps(fastify.log, fastify.redis), opts) };
      case 'evidence-expiry':
        return { data: await evidenceExpiry(evidenceDeps(fastify.log, fastify.redis), opts) };
      default:
        return send(request, reply, 404, 'NOT_FOUND', 'Unknown engine');
    }
  });

  // Row 105: the durable inbox for events Bastion consumes (spec 8.2). Deduplicated on
  // (org, source_idempotency_key); processing (proposal reconcile, bolt-event feeds) is M5/M6.
  fastify.post('/internal/events', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bastionInternalEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const e = parsed.data;
    const key = `${e.source}:${e.event}:${e.event_id ?? sha256Hex(canonicalJson(e.payload))}`.slice(0, 256);
    const org = await deps().sql`SELECT 1 FROM organizations WHERE id = ${e.organization_id}`;
    if (org.length === 0) return send(request, reply, 404, 'NOT_FOUND', 'Unknown organization');
    // Store only what Bastion will consume (issue #206): its own proposals' decisions, and only
    // for orgs that have set Bastion up. Anything else is acknowledged and dropped, so the
    // sender does not retry it and the inbox does not grow with rows nothing reads.
    if (!bastionConsumesEvent(e.source, e.event, e.payload)) {
      reply.status(202);
      return { data: { accepted: false, ignored: 'not_consumed' } };
    }
    const setUp = await orgTx(deps().sql, e.organization_id, (tx) =>
      tx`SELECT 1 FROM bastion_org_settings WHERE organization_id = ${e.organization_id}`);
    if (setUp.length === 0) {
      reply.status(202);
      return { data: { accepted: false, ignored: 'not_set_up' } };
    }
    const inserted = await orgTx(deps().sql, e.organization_id, (tx) => tx`
      INSERT INTO bastion_ingest_events (organization_id, source, event_type, source_idempotency_key, payload)
      VALUES (${e.organization_id}, ${e.source}, ${e.event}, ${key}, ${tx.json(e.payload as never)})
      ON CONFLICT (organization_id, source_idempotency_key) DO NOTHING
      RETURNING id`);
    reply.status(202);
    return { data: { accepted: true, duplicate: inserted.length === 0 } };
  });
}
