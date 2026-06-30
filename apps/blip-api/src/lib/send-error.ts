/**
 * Maps service error classes onto the standard BigBlueBam error envelope. Unknown
 * errors are re-thrown so the global createErrorHandler records them as 5xx.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { NotFoundError, ConflictError, GoneError, ForbiddenError, ValidationError } from '../services/errors.js';

export function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown): FastifyReply {
  const base = (code: string, message: string, status: number, details: unknown[] = []) =>
    reply.status(status).send({ error: { code, message, details, request_id: request.id } });

  if (err instanceof ZodError) {
    return base(
      'VALIDATION_ERROR',
      'Request validation failed',
      400,
      err.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
    );
  }
  if (err instanceof NotFoundError) return base('NOT_FOUND', err.message, 404);
  if (err instanceof ConflictError) return base('CONFLICT', err.message, 409);
  if (err instanceof GoneError) return base('GONE', err.message, 410);
  if (err instanceof ForbiddenError) return base('FORBIDDEN', err.message, 403);
  if (err instanceof ValidationError) return base('VALIDATION_ERROR', err.message, 400);
  throw err;
}
