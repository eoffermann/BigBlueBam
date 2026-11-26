import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { Viewer } from '../services/types.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationFailure } from './errors.js';
import { authMethodOf } from './guards.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The caller. Routes run requireAuth first, so a missing user here is a wiring bug. */
export function viewerOf(request: FastifyRequest): Viewer {
  const u = request.user;
  if (!u) throw new Error('viewerOf called before requireAuth');
  return {
    id: u.id,
    org_id: u.active_org_id ?? u.org_id,
    role: u.role,
    is_superuser: u.is_superuser,
    impersonator_id: request.isImpersonating ? (request.impersonator?.id ?? null) : null,
    auth_method: authMethodOf(request) ?? 'api_key',
  };
}

export function notFound(request: FastifyRequest, reply: FastifyReply, msg = 'Not found') {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: msg, details: [], request_id: request.id },
  });
}

export function validationError(request: FastifyRequest, reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: err.errors[0]?.message ?? 'Invalid request',
      details: err.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
      request_id: request.id,
    },
  });
}

/** Map a typed service error onto the canonical envelope. True if it handled the error. */
export function mapServiceError(request: FastifyRequest, reply: FastifyReply, err: unknown): boolean {
  if (err instanceof NotFoundError) {
    notFound(request, reply, err.message);
    return true;
  }
  if (err instanceof ValidationFailure) {
    reply.status(400).send({
      error: { code: err.code, message: err.message, details: err.details, request_id: request.id },
    });
    return true;
  }
  if (err instanceof ForbiddenError) {
    reply.status(403).send({
      error: { code: err.code, message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  if (err instanceof ConflictError) {
    reply.status(409).send({
      error: { code: err.code, message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  return false;
}

/**
 * Wrap a route body: typed service errors become the canonical envelope, anything else goes to
 * the global error handler.
 */
export async function handled<T>(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (mapServiceError(request, reply, err)) return reply;
    throw err;
  }
}

/** Reject a non-uuid :id with 404 before it reaches SQL (a uuid cast error would be a 500). */
export function idParam(request: FastifyRequest, name = 'id'): string | null {
  const v = (request.params as Record<string, string | undefined>)[name];
  return isUuid(v) ? v : null;
}
