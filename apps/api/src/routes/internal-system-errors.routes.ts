/**
 * Internal endpoints for the platform-wide system_errors sink.
 *
 * Every satellite service runs the shared @bigbluebam/logging error
 * handler. The handler captures 5xxs and calls an optional recorder.
 * Satellites use the `httpSystemErrorRecorder` from @bigbluebam/logging
 * to POST here, so the SuperUser Console's Log Analysis tab can show
 * errors from anywhere in the platform, not just the main api.
 *
 * Two routes live here:
 *
 *   POST /internal/system-errors/record
 *     Server-to-server. INTERNAL_SERVICE_SECRET-gated. The satellites
 *     post here from inside the cluster — they have the shared secret.
 *
 *   POST /internal/system-errors/record-browser
 *     Browser-callable. Session-cookie auth (requireAuth). Used by the
 *     frontend SystemErrorReporter so any error a user actually SEES
 *     on the screen — including Bureau call.errorMessage, unhandled
 *     rejections, network failures — lands in the same table the
 *     SuperUser already monitors. Without this, the only signal is "the
 *     user reported a red label, please investigate", which is exactly
 *     the loop we want to close.
 *
 * Both routes clip fields to safe sizes before insertion so a noisy
 * error path can't blow up the table. The browser route additionally
 * force-prefixes `service` with `frontend/` so server-side `service`
 * names (api/worker/etc.) can't be spoofed from the browser.
 *
 * Mount prefix: /internal (routes register at the root because there's
 * no per-feature prefix here).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { systemErrors } from '../db/schema/system-errors.js';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';

// Mirrors the auth pattern in internal-can-read.routes.ts /
// internal-permissions.routes.ts: x-internal-secret header against
// INTERNAL_SERVICE_SECRET. (The older requireServiceAuth in middleware/
// is helpdesk-specific — checks x-internal-token against
// INTERNAL_HELPDESK_SECRET — and isn't the right gate for general
// satellite calls.)
function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const configured = env.INTERNAL_SERVICE_SECRET;
  if (!configured) {
    // Fail CLOSED. This previously returned (admitting the request) to "match other
    // internal routes", but that shared behavior was itself the defect: an unset
    // secret turned every internal route into an unauthenticated surface. The secret
    // is a documented-required env var, so refusing is correct in every environment.
    request.log.error(
      'INTERNAL_SERVICE_SECRET is not configured - refusing internal system-error requests.',
    );
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Internal service authentication is not configured',
        details: [],
        request_id: request.id,
      },
    });
  }
  const header =
    request.headers['x-internal-service-secret'] ??
    request.headers['x-internal-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !timingSafeStringEqual(provided, configured)) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
  }
}

const MAX_MESSAGE_LEN = 4000;
const MAX_STACK_LEN = 16000;
const MAX_ROUTE_LEN = 255;

function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

const recordSchema = z.object({
  service: z.string().min(1).max(40),
  request_id: z.string().max(80).nullable().optional(),
  user_id: z.string().uuid().nullable().optional(),
  org_id: z.string().uuid().nullable().optional(),
  method: z.string().max(10).nullable().optional(),
  route: z.string().max(MAX_ROUTE_LEN).nullable().optional(),
  status_code: z.number().int().min(100).max(599).nullable().optional(),
  error_code: z.string().max(80).nullable().optional(),
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  stack: z.string().max(MAX_STACK_LEN).nullable().optional(),
  payload: z.record(z.unknown()).default({}),
});

export default async function internalSystemErrorsRoutes(fastify: FastifyInstance) {
  // ── POST /internal/system-errors/record ─────────────────────────
  // Insert one row into system_errors on behalf of a satellite that
  // hit a 5xx. Fire-and-forget at the caller — we always return 204
  // so the caller's error path doesn't get blocked on our response.
  fastify.post(
    '/system-errors/record',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const parsed = recordSchema.safeParse(request.body);
      if (!parsed.success) {
        // We accept this is best-effort logging; a bad payload should
        // not break the satellite's already-in-progress error response.
        // Log the validation issue locally and return 204 anyway.
        request.log.warn(
          { details: parsed.error.errors, body: request.body },
          'system-errors/record: invalid payload',
        );
        return reply.status(204).send();
      }
      const d = parsed.data;
      try {
        await db.insert(systemErrors).values({
          service: clip(d.service, 40) ?? d.service,
          request_id: clip(d.request_id ?? null, 80),
          user_id: d.user_id ?? null,
          org_id: d.org_id ?? null,
          method: clip(d.method ?? null, 10),
          route: clip(d.route ?? null, MAX_ROUTE_LEN),
          status_code: d.status_code ?? null,
          error_code: clip(d.error_code ?? null, 80),
          message: clip(d.message, MAX_MESSAGE_LEN) ?? d.message,
          stack: clip(d.stack ?? null, MAX_STACK_LEN),
          payload: d.payload,
        });
      } catch (err) {
        // Logging must never throw back to the caller — fall through.
        request.log.warn({ err }, 'system-errors/record: insert failed');
      }
      return reply.status(204).send();
    },
  );

  // ── POST /internal/system-errors/record-browser ─────────────────
  // Browser-facing variant. The frontend SystemErrorReporter posts
  // here whenever anything user-visible goes wrong. Same shape as the
  // satellite route minus the fields a browser shouldn't pick (the
  // session is the source of truth for user_id / org_id, not the
  // payload — we ignore those if sent).
  fastify.post(
    '/system-errors/record-browser',
    {
      preHandler: [requireAuth],
      // Per-IP rate limit so a runaway browser tab can't flood the
      // table. 60 / minute is comfortably above any honest pattern
      // (panic-loop reporters typically include their own throttle).
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
        },
      },
    },
    async (request, reply) => {
      const parsed = browserRecordSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn(
          { details: parsed.error.errors },
          'system-errors/record-browser: invalid payload',
        );
        return reply.status(204).send();
      }
      const d = parsed.data;
      const user = request.user;
      // Force-prefix the service tag so a browser can't claim to be
      // (e.g.) `api` and pollute the SuperUser console's service
      // filter. Sources like `b3`, `banter`, `bureau-client` become
      // `frontend/b3`, `frontend/banter`, etc.
      const safeService = `frontend/${d.service}`.slice(0, 40);
      try {
        await db.insert(systemErrors).values({
          service: safeService,
          request_id: clip(d.request_id ?? null, 80),
          // Trust the session, not the payload, for these two.
          user_id: user?.id ?? null,
          org_id: user?.active_org_id ?? null,
          method: clip(d.method ?? null, 10),
          route: clip(d.route ?? null, MAX_ROUTE_LEN),
          status_code: d.status_code ?? null,
          error_code: clip(d.error_code ?? null, 80),
          message: clip(d.message, MAX_MESSAGE_LEN) ?? d.message,
          stack: clip(d.stack ?? null, MAX_STACK_LEN),
          payload: d.payload,
        });
      } catch (err) {
        request.log.warn({ err }, 'system-errors/record-browser: insert failed');
      }
      return reply.status(204).send();
    },
  );
}

const browserRecordSchema = z.object({
  // Forced through a `frontend/` prefix at insert time, so this is just
  // the app name (b3, banter, bureau, bureau-client, helpdesk, …).
  service: z.string().min(1).max(30),
  request_id: z.string().max(80).nullable().optional(),
  // user_id / org_id intentionally omitted — populated from the session.
  method: z.string().max(10).nullable().optional(),
  route: z.string().max(MAX_ROUTE_LEN).nullable().optional(),
  status_code: z.number().int().min(100).max(599).nullable().optional(),
  error_code: z.string().max(80).nullable().optional(),
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  stack: z.string().max(MAX_STACK_LEN).nullable().optional(),
  payload: z.record(z.unknown()).default({}),
});
