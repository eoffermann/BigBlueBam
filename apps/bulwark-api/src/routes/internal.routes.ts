import type { FastifyInstance } from 'fastify';
import { bulwarkIngestEventSchema } from '@bigbluebam/shared';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { writeIngestEvent } from '../services/ingest.service.js';
import { handleProposalDecided } from '../subscriptions/proposal-decided.js';
import { drainIngestEvent } from '../services/firing.service.js';
import { runExtraction } from '../services/extraction.service.js';
import {
  orgsWithBulwarkData,
  radarSweep,
  stateReconcile,
  retentionSweep,
} from '../services/sweeps.service.js';
import { rebuildGate, rebuildAllGates } from '../services/gate.service.js';

// Run a per-org engine over one org (when body.organization_id is set) or every org with
// Bulwark data, aggregating a summary. Each (org) is wrapped log-and-continue so one bad org
// never aborts the sweep (spec §4.5).
async function sweepAllOrgs<T>(
  fastify: FastifyInstance,
  label: string,
  scopeOrg: string | undefined,
  run: (orgId: string) => Promise<T>,
): Promise<{ orgs: number; results: Array<{ org_id: string; result: T | null }> }> {
  const orgIds = scopeOrg ? [scopeOrg] : await orgsWithBulwarkData();
  const results: Array<{ org_id: string; result: T | null }> = [];
  for (const orgId of orgIds) {
    try {
      results.push({ org_id: orgId, result: await run(orgId) });
    } catch (err) {
      fastify.log.error({ err, orgId, label }, `bulwark ${label}: org failed`);
      results.push({ org_id: orgId, result: null });
    }
  }
  return { orgs: orgIds.length, results };
}

// Internal service-to-service routes (spec 5.1 / 6). Registered under { prefix: '/v1' } so the
// live paths are /v1/internal/events and /v1/internal/proposal-decided. The bolt-api dispatch
// hook (M6) POSTs to /v1/internal/events with the /v1 prefix present (Braid shipped a live 404
// by targeting /internal/events without it - do NOT drop the /v1).
export default async function internalRoutes(fastify: FastifyInstance) {
  // Ingest-trigger from bolt-api. Fails CLOSED when INTERNAL_SERVICE_SECRET is empty (S4/SN2),
  // then durably persists to bulwark_ingest_events and enqueues the firing drain.
  fastify.post('/internal/events', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bulwarkIngestEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid ingest event',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
          request_id: request.id,
        },
      });
    }
    const result = await writeIngestEvent(parsed.data);
    request.log.info(
      {
        org_id: parsed.data.org_id,
        source: parsed.data.source,
        event_type: parsed.data.event_type,
        deduped: result.deduped,
        enqueued: result.enqueued,
      },
      'bulwark /internal/events persisted to inbox',
    );
    return reply.status(202).send({ data: { accepted: true, ...result } });
  });

  // ── Engine-invocation routes (spec §9.2 / the M6 brief). Worker jobs are thin HTTP callers
  // that hit these so all engine logic lives in bulwark-api. All fail closed on empty secret. ──

  // Run the checkpointed extraction engine for a contract. The worker reads the Bin bytes via
  // @bigbluebam/storage and POSTs the extracted text + hash here (spec §4.1).
  fastify.post('/internal/run-extraction', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const body = (request.body ?? {}) as {
      org_id?: string;
      contract_id?: string;
      source_text?: string;
      source_doc_hash?: string;
      provider_id?: string | null;
    };
    if (!body.org_id || !body.contract_id || typeof body.source_text !== 'string' || !body.source_doc_hash) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'org_id, contract_id, source_text, source_doc_hash are required',
          details: [],
          request_id: request.id,
        },
      });
    }
    const result = await runExtraction({
      orgId: body.org_id,
      contractId: body.contract_id,
      sourceText: body.source_text,
      sourceDocHash: body.source_doc_hash,
      providerIdOverride: body.provider_id ?? undefined,
    });
    return reply.send({ data: result });
  });

  // Drain one durably-inboxed event against armed obligations (spec §4.2). Idempotent via the
  // deterministic arm key.
  fastify.post('/internal/drain-event', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const body = (request.body ?? {}) as { org_id?: string; ingest_event_id?: string };
    if (!body.org_id || !body.ingest_event_id) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'org_id and ingest_event_id are required',
          details: [],
          request_id: request.id,
        },
      });
    }
    const result = await drainIngestEvent(body.org_id, body.ingest_event_id);
    return reply.send({ data: result });
  });

  // Scheduled radar sweep across orgs (spec §4.3): pending-inbox drain, risk detection,
  // CAS-guarded capped auto-draft, missed detection, calendar/recurring arming.
  fastify.post('/internal/radar-sweep', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const scope = (request.body as { organization_id?: string } | undefined)?.organization_id;
    const summary = await sweepAllOrgs(fastify, 'radar-sweep', scope, radarSweep);
    return reply.send({ data: summary });
  });

  // Scheduled state-reconcile across orgs (spec §4.5 / STJ1): re-derive clocks from source
  // state for state-reflecting bindings + rebuild the Redis gate.
  fastify.post('/internal/state-reconcile', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const scope = (request.body as { organization_id?: string } | undefined)?.organization_id;
    const summary = await sweepAllOrgs(fastify, 'state-reconcile', scope, stateReconcile);
    return reply.send({ data: summary });
  });

  // Scheduled gate-reconcile (spec §6 / STJ3): rebuild the per-org dispatch gate cache.
  fastify.post('/internal/gate-reconcile', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const scope = (request.body as { organization_id?: string } | undefined)?.organization_id;
    if (scope) {
      const members = await rebuildGate(scope);
      return reply.send({ data: { orgs: 1, members } });
    }
    const summary = await rebuildAllGates();
    return reply.send({ data: summary });
  });

  // Scheduled retention (spec §4.5 / STJ7): purge discharged deadlines + inbox past the coupled
  // floor. missed/waived/voided + all risks kept forever.
  fastify.post('/internal/retention', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const scope = (request.body as { organization_id?: string } | undefined)?.organization_id;
    const summary = await sweepAllOrgs(fastify, 'retention', scope, retentionSweep);
    return reply.send({ data: summary });
  });

  // proposal.decided delivery (spec 2.2 / 5.4). Idempotent: the send executors are CAS-guarded.
  fastify.post('/internal/proposal-decided', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    try {
      const result = await handleProposalDecided(request.body as never);
      return { data: result };
    } catch (err) {
      request.log.error({ err }, 'bulwark proposal-decided handler failed');
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'proposal-decided processing failed',
          details: [],
          request_id: request.id,
        },
      });
    }
  });
}
