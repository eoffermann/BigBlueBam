import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { Viewer } from '../services/types.js';
import { isAdminViewer } from '../services/types.js';
import {
  ConflictError,
  NotFoundError,
  ProjectScopeError,
  RateLimitedError,
  ValidationFailure,
} from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function viewerOf(request: FastifyRequest): Viewer {
  const u = request.user!;
  return {
    id: u.id,
    org_id: u.active_org_id ?? u.org_id,
    role: u.role,
    is_superuser: u.is_superuser,
  };
}

/**
 * The asker viewer, or null when no distinct asker is supplied.
 *
 * An agent passing ?asker_user_id=<uuid> is NARROWING, never widening (spec 2.2.1). The
 * returned viewer is deliberately built with role 'member' and is_superuser false, so the
 * admin fast path in project-scope.ts is skipped and every scope check runs against the
 * human. The financial-flooring half of the same rule lives in lib/viewer-caps.ts
 * (bearer INTERSECT asker); this is the row-visibility half.
 */
export function askerViewer(request: FastifyRequest): Viewer | null {
  const u = request.user!;
  const raw = (request.query as { asker_user_id?: string } | undefined)?.asker_user_id;
  if (raw && UUID_RE.test(raw) && raw !== u.id) {
    return { id: raw, org_id: u.active_org_id ?? u.org_id, role: 'member', is_superuser: false };
  }
  return null;
}

/** The READ-plane viewer: the asker when one is supplied, otherwise the bearer. */
export function readViewer(request: FastifyRequest): Viewer {
  return askerViewer(request) ?? viewerOf(request);
}

export function notFound(request: FastifyRequest, reply: FastifyReply, msg = 'Not found') {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: msg, details: [], request_id: request.id },
  });
}

export function forbidden(request: FastifyRequest, reply: FastifyReply, msg = 'Forbidden') {
  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: msg, details: [], request_id: request.id },
  });
}

export function validationError(request: FastifyRequest, reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: err.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
      request_id: request.id,
    },
  });
}

/**
 * The SECOND, INDEPENDENT in-route role guard (spec 2.4 point 1).
 *
 * `requireCan` resolves through apps/api. That resolver returns 'unknown' on any non-2xx,
 * and while burn-api runs the plugin with onUnknown: 'deny', this guard exists so that an
 * apps/api outage, a plugin regression, or a future refactor of the shared package cannot
 * by itself open the surfaces that carry per-person compensation and firm-wide
 * profitability. It reads the org role DIRECTLY off request.user and consults nothing else.
 *
 * Applied to: /v1/cost-rates (all verbs), /v1/financials/accounts, /v1/financials/export,
 * POST /v1/prechecks/:id/label (for the mark_wrong values), PATCH /v1/settings.
 */
export async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [], request_id: request.id },
    });
  }
  if (!isAdminViewer(viewerOf(request))) {
    return forbidden(request, reply, 'This surface requires an organization owner or admin role');
  }
}

/** Map a typed service error onto the canonical envelope. True if it handled the error. */
export function mapServiceError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): boolean {
  if (err instanceof NotFoundError) {
    notFound(request, reply, err.message);
    return true;
  }
  if (err instanceof ProjectScopeError) {
    forbidden(request, reply, err.message);
    return true;
  }
  if (err instanceof ValidationFailure) {
    reply.status(400).send({
      error: { code: err.code, message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  if (err instanceof ConflictError) {
    reply.status(409).send({
      code: 'CONFLICT',
      // The CURRENT state travels with the 409 so a concurrent triage can re-render without
      // a second round trip (spec 6.1, /v1/attributions/:id).
      current: err.current ?? null,
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  if (err instanceof RateLimitedError) {
    reply.status(429).send({
      error: { code: err.code, message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  return false;
}
