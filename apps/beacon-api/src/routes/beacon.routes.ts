import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireMinOrgRole, requireBeaconEditAccess, requireBeaconReadAccess } from '../middleware/authorize.js';
import * as beaconService from '../services/beacon.service.js';
import * as verificationService from '../services/verification.service.js';
import { transitionBeacon } from '../services/lifecycle.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { buildBeaconEventPayload } from '../lib/enrich-beacon-event.js';

const createBeaconSchema = z.object({
  title: z.string().min(1).max(512),
  summary: z.string().max(500).nullable().optional(),
  body_markdown: z.string().min(1).max(500_000),
  body_html: z.string().nullable().optional(),
  visibility: z.enum(['Public', 'Organization', 'Project', 'Private']).optional(),
  project_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBeaconSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  summary: z.string().max(500).nullable().optional(),
  body_markdown: z.string().min(1).max(500_000).optional(),
  body_html: z.string().nullable().optional(),
  visibility: z.enum(['Public', 'Organization', 'Project', 'Private']).optional(),
  metadata: z.record(z.unknown()).optional(),
  change_note: z.string().max(500).optional(),
});

const listBeaconsQuerySchema = z.object({
  project_ids: z.string().optional(),       // comma-separated UUIDs
  project_id: z.string().uuid().optional(), // single project (frontend convenience)
  status: z.string().optional(),
  tag: z.string().optional(),               // single tag (frontend convenience)
  tags: z.string().optional(),              // comma-separated
  visibility_max: z.string().optional(),
  expires_after: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export default async function beaconRoutes(fastify: FastifyInstance) {
  // POST /beacons — Create a new beacon (Draft)
  fastify.post(
    '/beacons',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createBeaconSchema.parse(request.body);
      const beacon = await beaconService.createBeacon(
        data,
        request.user!.id,
        request.user!.org_id,
      );
      // Fire-and-forget Bolt event emission. Enrichment requires a DB
      // round-trip for actor/owner/org joins — kick it off but do not
      // await so we never block the HTTP response.
      buildBeaconEventPayload(beacon, request.user!.id)
        .then((payload) =>
          publishBoltEvent(
            'beacon.created',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.status(201).send({ data: beacon });
    },
  );

  // GET /beacons/stats — Org-wide beacon statistics
  fastify.get(
    '/beacons/stats',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const stats = await beaconService.getStats(request.user!.org_id);
      return reply.send({ data: stats });
    },
  );

  // GET /beacons — List beacons with filters
  fastify.get(
    '/beacons',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listBeaconsQuerySchema.parse(request.query);
      const filters: beaconService.ListBeaconsFilters = {
        orgId: request.user!.org_id,
        userId: request.user!.id,
        projectIds: query.project_ids
          ? query.project_ids.split(',').filter(Boolean)
          : query.project_id
            ? [query.project_id]
            : undefined,
        status: query.status,
        tags: query.tags
          ? query.tags.split(',').filter(Boolean)
          : query.tag
            ? [query.tag]
            : undefined,
        expiresAfter: query.expires_after,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      };

      const result = await beaconService.listBeacons(filters);
      return reply.send(result);
    },
  );

  // GET /beacons/by-slug/:slug — Resolve a slug to a beacon (mirror of GET
  // /beacons/:id but scoped exclusively to slug lookups so MCP resolvers
  // never have to guess). Declared before the parametric /beacons/:id route
  // so Fastify matches the literal `/by-slug/` segment first.
  fastify.get<{ Params: { slug: string } }>(
    '/beacons/by-slug/:slug',
    {
      // Pass the slug through as the `:id` param that the existing
      // middleware expects. `requireBeaconReadAccess` already accepts a
      // UUID *or* a slug and loads the row onto `request.beacon`, so
      // reusing it keeps the auth rules in sync.
      preHandler: [
        requireAuth,
        async (request, _reply) => {
          (request.params as { id?: string }).id = (request.params as { slug: string }).slug;
        },
        requireBeaconReadAccess(),
      ],
    },
    async (request, reply) => {
      return reply.send({ data: (request as any).beacon });
    },
  );

  // GET /beacons/:id — Get a single beacon by UUID or slug
  fastify.get<{ Params: { id: string } }>(
    '/beacons/:id',
    { preHandler: [requireAuth, requireBeaconReadAccess()] },
    async (request, reply) => {
      // beacon already loaded and attached by middleware
      return reply.send({ data: (request as any).beacon });
    },
  );

  // PUT /beacons/:id — Update beacon (creates new version)
  fastify.put<{ Params: { id: string } }>(
    '/beacons/:id',
    { preHandler: [requireAuth, requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateBeaconSchema.parse(request.body);
      const beacon = await beaconService.updateBeacon(
        request.params.id,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      // Build a coarse `changes` object from the request body so rule
      // authors can discriminate "title renamed" from "summary edited".
      // TODO: upgrade to a proper old/new-value diff once updateBeacon
      // returns the pre-update snapshot alongside the new row.
      const changes: Record<string, { new: unknown }> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && key !== 'change_note') {
          changes[key] = { new: value };
        }
      }
      buildBeaconEventPayload(beacon, request.user!.id, {
        changes,
        change_note: data.change_note ?? null,
      })
        .then((payload) =>
          publishBoltEvent(
            'beacon.updated',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.send({ data: beacon });
    },
  );

  // DELETE /beacons/:id — Retire a beacon (soft delete)
  fastify.delete<{ Params: { id: string } }>(
    '/beacons/:id',
    { preHandler: [requireAuth, requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const beacon = await beaconService.retireBeacon(
        request.params.id,
        request.user!.id,
        request.user!.org_id,
      );
      // NOTE: the DELETE endpoint currently emits `beacon.expired` to keep
      // parity with the legacy producer. Strictly speaking this is a
      // *retirement*, not an expiry — see TODO below.
      // TODO: split into a dedicated `beacon.retired` event once the
      // catalog grows one; until then Bolt rule authors should match
      // `beacon.expired` with `beacon.status === 'Retired'`.
      buildBeaconEventPayload(beacon, request.user!.id, {
        retired_by: request.user!.id,
      })
        .then((payload) =>
          publishBoltEvent(
            'beacon.expired',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.send({ data: beacon });
    },
  );

  // POST /beacons/:id/publish — Draft → Active
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/publish',
    { preHandler: [requireAuth, requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const beacon = await beaconService.publishBeacon(
        request.params.id,
        request.user!.id,
        request.user!.org_id,
      );
      buildBeaconEventPayload(beacon, request.user!.id, {
        published_by: request.user!.id,
      })
        .then((payload) =>
          publishBoltEvent(
            'beacon.published',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.send({ data: beacon });
    },
  );

  // POST /beacons/:id/restore — Archived → Active
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/restore',
    { preHandler: [requireAuth, requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const beacon = await beaconService.restoreBeacon(
        request.params.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: beacon });
    },
  );

  // POST /beacons/:id/verify — Record a verification event
  const verifySchema = z.object({
    verification_type: z.enum(['Manual', 'AgentAutomatic', 'AgentAssisted', 'ScheduledReview']),
    outcome: z.enum(['Confirmed', 'Updated', 'Challenged', 'Retired']),
    confidence_score: z.number().min(0).max(1).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/verify',
    { preHandler: [requireAuth, requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const data = verifySchema.parse(request.body);
      const result = await verificationService.verifyBeacon(
        request.params.id,
        request.user!.id,
        {
          type: data.verification_type,
          outcome: data.outcome,
          confidence: data.confidence_score ?? null,
          notes: data.notes ?? null,
        },
        request.user!.org_id,
      );
      // Emit `beacon.verified` on any successful verification submission,
      // regardless of outcome, so rule authors can react to every review
      // decision (Confirmed / Updated / Challenged / Retired). Rules that
      // only care about the happy path can filter on
      // `verification.outcome === 'Confirmed'`.
      buildBeaconEventPayload(result.beacon, request.user!.id, {
        verification: {
          id: result.verification.id,
          type: data.verification_type,
          outcome: data.outcome,
          confidence_score: data.confidence_score ?? null,
          notes: data.notes ?? null,
        },
      })
        .then((payload) =>
          publishBoltEvent(
            'beacon.verified',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.send({ data: result });
    },
  );

  // POST /beacons/:id/challenge — Flag beacon for review (Active → PendingReview)
  const challengeSchema = z.object({
    reason: z.string().max(2000).optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/challenge',
    { preHandler: [requireAuth, requireBeaconReadAccess(), requireMinOrgRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      const data = challengeSchema.parse(request.body ?? {});
      const beacon = await transitionBeacon(
        request.params.id,
        'PendingReview',
        request.user!.id,
        { reason: data.reason },
        request.user!.org_id,
      );
      buildBeaconEventPayload(beacon, request.user!.id, {
        challenge: {
          reason: data.reason ?? null,
          challenged_by: request.user!.id,
        },
      })
        .then((payload) =>
          publishBoltEvent(
            'beacon.challenged',
            'beacon',
            payload,
            request.user!.org_id,
            request.user!.id,
          ),
        )
        .catch(() => {});
      return reply.send({ data: beacon });
    },
  );
}
