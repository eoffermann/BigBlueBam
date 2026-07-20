import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { Viewer } from '../services/types.js';
import { isAdminViewer } from '../services/types.js';
import { AssetAccessError, ConflictError, NotFoundError, ValidationFailure } from './errors.js';

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
 * The asker viewer, or null when no distinct asker is supplied. An agent passing
 * ?asker_user_id=<uuid> is NARROWING, never widening (spec 13.3). The returned viewer is
 * built with role 'member' and is_superuser false so no admin fast path is taken. The
 * financial-flooring half (bearer INTERSECT asker) lives in lib/viewer-caps.ts.
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
 * The SECOND, INDEPENDENT in-route role guard (spec 13.3). requireCan resolves through
 * apps/api and returns 'unknown' on any non-2xx; while bursar-api runs onUnknown: 'deny',
 * this guard exists so an apps/api outage or a shared-package regression cannot by itself
 * open the owner/admin surfaces (settings write, and the finding-suppression knobs). It reads
 * the org role DIRECTLY off request.user.
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
  if (err instanceof NotFoundError || err instanceof AssetAccessError) {
    // AssetAccessError is 404 by design (spec 5.8): a Bin asset the caller may not read must
    // be indistinguishable from one that does not exist.
    notFound(request, reply, err.message);
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
      current: err.current ?? null,
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  return false;
}
