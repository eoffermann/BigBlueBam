/**
 * Internal cross-app routes for Bond.
 *
 * These endpoints are NOT user-facing. They are called by other
 * BigBlueBam services over the internal network (today: book-api, when a
 * public booking is made on a Meet page and the booking page is configured
 * to auto-create a Bond contact). They are authenticated by the shared
 * INTERNAL_SERVICE_SECRET, sent in the `X-Internal-Service-Secret` header.
 * Cookie / API-key auth does NOT apply on this surface — the secret IS the
 * credential.
 *
 * Why this exists:
 *   A public booking is anonymous — there is no logged-in user and no API
 *   key to forward. The previous implementation POSTed to the user-facing
 *   `POST /v1/contacts`, which is gated by requireAuth and only honors a
 *   session cookie or a Bearer token; the lone `x-internal-secret` header it
 *   received was ignored, so the call 401'd and was swallowed by the
 *   best-effort catch. No contact ever got created.
 *
 *   This route carries the org + acting-user attribution explicitly (the
 *   booking-page owner, who owns the calendar the booking lands on) and
 *   reuses the idempotent upsert-by-email service, so re-submitting the same
 *   email does not create duplicate contacts.
 *
 * Mirrors apps/book-api/src/routes/internal.routes.ts so the posture is
 * identical across services: timing-safe compare against
 * env.INTERNAL_SERVICE_SECRET, 401 on mismatch, 503 if the secret is not
 * configured (fail-closed — never accept the request).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { users, organizationMemberships } from '../db/schema/index.js';
import * as contactUpsertService from '../services/contact-upsert.service.js';

// ─────────────────────────────────────────────────────────────────────
// Internal-secret guard.
// ─────────────────────────────────────────────────────────────────────

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Constant-time op against ourselves so length mismatch does not
    // leak via timing differences.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function getInternalSecretHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-internal-service-secret'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const expected = env.INTERNAL_SERVICE_SECRET;
  if (!expected) {
    await reply.status(503).send({
      error: {
        code: 'INTERNAL_AUTH_UNCONFIGURED',
        message: 'Internal service secret is not configured on this Bond API instance',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  const provided = getInternalSecretHeader(request);
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    await reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const lifecycleStages = [
  'subscriber', 'lead', 'marketing_qualified', 'sales_qualified',
  'opportunity', 'customer', 'evangelist', 'other',
] as const;

const upsertContactBody = z.object({
  org_id: z.string().uuid(),
  // The user the contact is attributed to (created_by + owner_id fallback).
  // For a public booking this is the booking-page owner.
  acting_user_id: z.string().uuid(),
  email: z.string().email().max(255),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(150).optional(),
  lifecycle_stage: z.enum(lifecycleStages).optional(),
  lead_source: z.string().max(60).optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────

export default async function internalRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/internal/contacts
   *
   * Idempotent create-or-update of a Bond contact by (org, lower(email)),
   * on behalf of a named acting user. Returns { data, created }.
   */
  fastify.post('/internal/contacts', async (request, reply) => {
    if (!(await requireInternalSecret(request, reply))) return;

    const parsed = upsertContactBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          request_id: request.id,
        },
      });
    }

    const { org_id, acting_user_id, ...contact } = parsed.data;

    // Verify the acting user is a member of the org. created_by is a NOT NULL
    // FK to users.id, so a bogus id would otherwise blow up with a constraint
    // error. Checking membership (not the user's home org_id) keeps this
    // correct under multi-org membership. Fall back to the user's home org_id
    // for users that predate the memberships table.
    const [membership] = await db
      .select({ org_id: organizationMemberships.org_id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, acting_user_id),
          eq(organizationMemberships.org_id, org_id),
        ),
      )
      .limit(1);

    let actingUser = membership ? { id: acting_user_id } : undefined;
    if (!actingUser) {
      const [homeUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, acting_user_id), eq(users.org_id, org_id)))
        .limit(1);
      actingUser = homeUser;
    }

    if (!actingUser) {
      return reply.status(400).send({
        error: {
          code: 'ACTING_USER_NOT_FOUND',
          message: 'acting_user_id does not belong to the requested organization',
          details: [],
          request_id: request.id,
        },
      });
    }

    const result = await contactUpsertService.upsertContactByEmail(
      contact,
      org_id,
      acting_user_id,
    );

    return reply.status(result.created ? 201 : 200).send({
      data: result.data,
      created: result.created,
    });
  });
}
