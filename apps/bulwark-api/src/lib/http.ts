import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { Viewer } from '../services/types.js';
import {
  ConflictError,
  NotFoundError,
  ProjectScopeError,
  ValidationFailure,
} from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function viewerOf(request: FastifyRequest): Viewer {
  const u = request.user!;
  return { id: u.id, org_id: u.org_id, role: u.role, is_superuser: u.is_superuser };
}

// The READ-plane viewer. When an agent supplies ?asker_user_id=<uuid> (the human it acts
// for), reads are filtered to THAT person: a non-admin viewer keyed on the asker id, so an
// asker context only ever narrows. A bogus asker resolves nothing (fail closed).
export function readViewer(request: FastifyRequest): Viewer {
  const u = request.user!;
  const raw = (request.query as { asker_user_id?: string } | undefined)?.asker_user_id;
  if (raw && UUID_RE.test(raw) && raw !== u.id) {
    return { id: raw, org_id: u.org_id, role: 'member', is_superuser: false };
  }
  return { id: u.id, org_id: u.org_id, role: u.role, is_superuser: u.is_superuser };
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
      message: 'Invalid request',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      request_id: request.id,
    },
  });
}

// Map a typed service error onto the canonical envelope. Returns true if it handled the error.
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
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: err.message, details: [], request_id: request.id },
    });
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
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
    return true;
  }
  return false;
}
