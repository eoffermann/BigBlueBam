import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { ZodError } from 'zod';
import {
  braidResolveInputSchema,
  braidProposeMergeSchema,
  braidRejectCandidateSchema,
  braidMergeProfilesSchema,
  braidSplitProfileSchema,
  braidSetSurvivorshipRuleSchema,
  braidUpdateSettingsSchema,
  braidListQuerySchema,
  BraidProfileKind,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { env } from '../env.js';
import * as profileService from '../services/profile.service.js';
import * as candidateService from '../services/candidate.service.js';
import * as mergeService from '../services/merge.service.js';
import * as settingsService from '../services/settings.service.js';
import * as survivorshipService from '../services/survivorship.service.js';
import { resolve as resolveRecord } from '../services/resolve.service.js';
import { enqueueBraidIngest } from '../lib/queue.js';
import { handleProposalDecided } from '../subscriptions/proposal-decided.js';
import type { Viewer } from '../services/types.js';
import {
  AccessDeniedError,
  MergeConflictError,
  NotFoundError,
  RateLimitError,
  SourceTypeNotSupportedError,
} from '../lib/errors.js';

function viewerOf(request: FastifyRequest): Viewer {
  const u = request.user!;
  return { id: u.id, org_id: u.org_id, role: u.role, is_superuser: u.is_superuser };
}

// Effective viewer for the READ plane (security #60). When an agent supplies
// `?asker_user_id=<uuid>` (the human it acts for, per docs/reference/agent-conventions.md),
// the returned data MUST be filtered to what THAT person can see, never the bearer's
// broader admin view. So an asker context forces a NON-admin viewer keyed on the asker id:
// the admin fast-path is skipped and every field/identity is filtered per-asker via
// preflightAccess. The caller must still hold braid.profile.read (admin-tier) to reach the
// route, so passing an asker only ever narrows, never widens. A bogus asker id resolves
// nothing and fails closed (empty result).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readViewer(request: FastifyRequest): Viewer {
  const u = request.user!;
  const raw = (request.query as { asker_user_id?: string } | undefined)?.asker_user_id;
  if (raw && UUID_RE.test(raw) && raw !== u.id) {
    return { id: raw, org_id: u.org_id, role: 'member', is_superuser: false };
  }
  return { id: u.id, org_id: u.org_id, role: u.role, is_superuser: u.is_superuser };
}

function notFound(request: FastifyRequest, reply: FastifyReply, msg = 'Not found') {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: msg, details: [], request_id: request.id },
  });
}

function validationError(request: FastifyRequest, reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      request_id: request.id,
    },
  });
}

function conflict(request: FastifyRequest, reply: FastifyReply, msg: string) {
  return reply.status(409).send({
    error: { code: 'CONFLICT', message: msg, details: [], request_id: request.id },
  });
}

// Internal-route guard (spec 5.1). Fail closed: a missing or mismatched secret is a
// 401. Mirrors the bolt-api X-Internal-Secret / timingSafeEqual convention.
function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = env.INTERNAL_SERVICE_SECRET;
  const provided = request.headers['x-internal-secret'];
  const ok =
    !!configured &&
    typeof provided === 'string' &&
    provided.length === configured.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
  if (!ok) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing X-Internal-Secret header',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

// Braid REST surface (spec 5.1). Success { data }; errors the canonical envelope.
export default async function braidRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  /* ── Profiles ─────────────────────────────────────────────────────────── */

  fastify.get(
    '/profiles',
    { preHandler: [requireAuth, can('braid.profile.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = braidListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await profileService.listProfiles(request.user!.org_id, readViewer(request), {
        cursor: q.cursor,
        limit,
        kind: q.filter?.kind,
        status: q.filter?.status,
      });
      return { data: result.data, next_cursor: result.next_cursor };
    },
  );

  fastify.get(
    '/profiles/:id',
    { preHandler: [requireAuth, can('braid.profile.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const profile = await profileService.getProfileForViewer(
        request.user!.org_id,
        id,
        readViewer(request),
      );
      if (!profile) return notFound(request, reply, 'Profile not found');
      return { data: profile };
    },
  );

  fastify.get(
    '/profiles/:id/identities',
    { preHandler: [requireAuth, can('braid.profile.read')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const q = request.query as { limit?: string };
      const limit = Math.min(Number(q.limit) || 100, 200);
      const rows = await profileService.listIdentitiesForViewer(
        request.user!.org_id,
        id,
        readViewer(request),
        limit,
      );
      return { data: rows };
    },
  );

  fastify.get(
    '/profiles/:id/timeline',
    { preHandler: [requireAuth, can('braid.profile.read')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await profileService.timelineForViewer(
        request.user!.org_id,
        id,
        readViewer(request),
      );
      return { data: rows };
    },
  );

  fastify.get(
    '/profiles/:id/decisions',
    { preHandler: [requireAuth, can('braid.profile.read')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await profileService.decisionsForViewer(
        request.user!.org_id,
        id,
        readViewer(request),
      );
      return { data: rows };
    },
  );

  /* ── Resolve (flagship) ───────────────────────────────────────────────── */

  fastify.post(
    '/resolve',
    { preHandler: [requireAuth, can('braid.profile.resolve')] },
    async (request, reply) => {
      const parsed = braidResolveInputSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await resolveRecord(
          fastify.redis,
          request.user!.org_id,
          parsed.data,
          viewerOf(request),
        );
        return { data: result };
      } catch (err) {
        // A denied input record returns not_found, never a golden id (spec 5.1 / S2).
        if (err instanceof AccessDeniedError) return notFound(request, reply, 'Source record not found');
        if (err instanceof RateLimitError) {
          return reply.status(429).send({
            error: {
              code: 'RATE_LIMITED',
              message: 'Resolve rate limit exceeded; slow down',
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  /* ── Candidates (review queue) ────────────────────────────────────────── */

  fastify.get(
    '/candidates',
    { preHandler: [requireAuth, can('braid.candidate.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const limit = Math.min(Number(q.limit) || 25, 100);
      const result = await candidateService.listCandidates(request.user!.org_id, {
        status: q.filter?.status,
        limit,
        cursor: q.cursor,
      });
      return { data: result.data, next_cursor: result.next_cursor };
    },
  );

  fastify.get(
    '/candidates/:id',
    { preHandler: [requireAuth, can('braid.candidate.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const candidate = await candidateService.getCandidate(request.user!.org_id, id);
      if (!candidate) return notFound(request, reply, 'Candidate not found');
      return { data: candidate };
    },
  );

  // Agent/human-initiated propose (spec 2.4 / 10). Upserts a candidate + inbox proposal;
  // the proposal is the HITL, so no confirm token here.
  fastify.post(
    '/candidates',
    { preHandler: [requireAuth, can('braid.candidate.read')] },
    async (request, reply) => {
      const parsed = braidProposeMergeSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const candidate = await candidateService.proposeMerge(
          request.user!.org_id,
          request.user!.id,
          parsed.data,
        );
        return reply.status(201).send({ data: candidate });
      } catch (err) {
        if (err instanceof NotFoundError) return notFound(request, reply, err.message);
        throw err;
      }
    },
  );

  fastify.post(
    '/candidates/:id/merge',
    { preHandler: [requireAuth, can('braid.profile.merge')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { reason?: string };
      try {
        const outcome = await mergeService.mergeCandidate(
          request.user!.org_id,
          id,
          request.user!.id,
          'human',
          body.reason,
        );
        return { data: outcome };
      } catch (err) {
        if (err instanceof NotFoundError) return notFound(request, reply, 'Candidate not found');
        if (err instanceof MergeConflictError)
          return conflict(request, reply, 'Candidate already decided');
        throw err;
      }
    },
  );

  fastify.post(
    '/candidates/:id/reject',
    { preHandler: [requireAuth, can('braid.profile.merge')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = braidRejectCandidateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const outcome = await mergeService.rejectCandidate(
          request.user!.org_id,
          id,
          request.user!.id,
          parsed.data.reason,
          'human',
        );
        return { data: outcome };
      } catch (err) {
        if (err instanceof MergeConflictError)
          return conflict(request, reply, 'Candidate already decided');
        throw err;
      }
    },
  );

  /* ── Direct merge / split ─────────────────────────────────────────────── */

  fastify.post(
    '/profiles/merge',
    { preHandler: [requireAuth, can('braid.profile.merge')] },
    async (request, reply) => {
      const parsed = braidMergeProfilesSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const outcome = await mergeService.mergeProfilesDirect(
          request.user!.org_id,
          parsed.data.profile_a_id,
          parsed.data.profile_b_id,
          request.user!.id,
          parsed.data.reason,
          'human',
        );
        return { data: outcome };
      } catch (err) {
        if (err instanceof NotFoundError) return notFound(request, reply, 'Profile not found');
        if (err instanceof MergeConflictError)
          return conflict(request, reply, 'A profile was already merged away');
        throw err;
      }
    },
  );

  fastify.post(
    '/profiles/:id/split',
    { preHandler: [requireAuth, can('braid.profile.split')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = braidSplitProfileSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const outcome = await mergeService.splitProfile(
          request.user!.org_id,
          id,
          {
            merge_decision_id: parsed.data.merge_decision_id,
            identity_ids: parsed.data.identity_ids,
          },
          request.user!.id,
          parsed.data.reason,
          'human',
        );
        return { data: outcome };
      } catch (err) {
        if (err instanceof NotFoundError) return notFound(request, reply, 'Profile or decision not found');
        throw err;
      }
    },
  );

  /* ── Survivorship rules ───────────────────────────────────────────────── */

  fastify.get(
    '/survivorship-rules',
    { preHandler: [requireAuth, can('braid.rule.read')] },
    async (request) => {
      const rows = await survivorshipService.listRules(request.user!.org_id);
      return { data: rows };
    },
  );

  fastify.put(
    '/survivorship-rules/:kind/:field',
    { preHandler: [requireAuth, can('braid.rule.write')] },
    async (request, reply) => {
      const { kind, field } = request.params as { kind: string; field: string };
      const kindParsed = BraidProfileKind.safeParse(kind);
      if (!kindParsed.success)
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: "kind must be 'person' or 'company'",
            details: [],
            request_id: request.id,
          },
        });
      const parsed = braidSetSurvivorshipRuleSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const rule = await survivorshipService.upsertRule(
        request.user!.org_id,
        request.user!.id,
        kindParsed.data,
        field,
        parsed.data,
      );
      return { data: rule };
    },
  );

  /* ── Settings ─────────────────────────────────────────────────────────── */

  fastify.get(
    '/settings',
    { preHandler: [requireAuth, can('braid.settings.read')] },
    async (request) => {
      const settings = await settingsService.getSettings(request.user!.org_id);
      return { data: settings };
    },
  );

  fastify.patch(
    '/settings',
    { preHandler: [requireAuth, can('braid.settings.write')] },
    async (request, reply) => {
      const parsed = braidUpdateSettingsSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const settings = await settingsService.updateSettings(
          request.user!.org_id,
          request.user!.id,
          parsed.data,
        );
        return { data: settings };
      } catch (err) {
        if (err instanceof SourceTypeNotSupportedError) {
          return reply.status(400).send({
            error: {
              code: 'SOURCE_TYPE_NOT_SUPPORTED',
              message: err.message,
              details: [{ source_type: err.sourceType }],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  /* ── Internal routes (service-to-service; INTERNAL_SERVICE_SECRET) ─────── */

  // Ingest-trigger from bolt-api (spec 5.1 / 6). Enqueues a refs-only job into the
  // shared braid-match-on-ingest queue. For M4 this is an accepted-and-logged stub;
  // the BullMQ queue is wired in M6.
  fastify.post('/internal/events', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const body = (request.body ?? {}) as {
      org_id?: string;
      source_type?: string;
      source_id?: string;
    };
    if (!body.org_id || !body.source_type || !body.source_id) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'org_id, source_type, source_id are required',
          details: [],
          request_id: request.id,
        },
      });
    }
    // Enqueue a refs-only job into the shared braid-match-on-ingest queue (spec §6). The
    // worker reads the source row directly and clusters it. Best-effort: an enqueue failure
    // degrades to the nightly rescan source-diff (the documented soft-dependency fallback).
    const enqueued = await enqueueBraidIngest({
      orgId: body.org_id,
      sourceType: body.source_type,
      sourceId: body.source_id,
    });
    request.log.info(
      { org_id: body.org_id, source_type: body.source_type, enqueued },
      'braid /internal/events enqueued match-on-ingest',
    );
    return reply.status(202).send({ data: { accepted: true, enqueued } });
  });

  // proposal.decided delivery (spec 2.2 / 5.4). See subscriptions/proposal-decided.ts
  // for the transport rationale (Bolt has no service fan-out; bolt-api will POST here
  // in M6). Idempotent: mergeCandidate/rejectCandidate are CAS-guarded.
  fastify.post('/internal/proposal-decided', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    try {
      const result = await handleProposalDecided(request.body as never);
      return { data: result };
    } catch (err) {
      request.log.error({ err }, 'braid proposal-decided handler failed');
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
