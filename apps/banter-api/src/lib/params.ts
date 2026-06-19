import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

const uuidSchema = z.string().uuid();

/**
 * Validate that a path param is a well-formed UUID before it is interpolated
 * into a uuid-typed SQL query.
 *
 * Without this guard a malformed or empty `:id` reaches Postgres as a literal
 * (e.g. `WHERE id = 'not-a-uuid'`), which raises `invalid input syntax for
 * type uuid` (SQLSTATE 22P02) and surfaces as a 500 instead of a 400.
 *
 * Returns the validated value on success. On failure it sends the standard
 * VALIDATION_ERROR envelope with HTTP 400 and returns `null`; callers must
 * stop processing (the reply is already sent):
 *
 *   const id = requireUuidParam(request, reply, 'id');
 *   if (id === null) return reply; // 400 already sent
 */
export function requireUuidParam(
  request: FastifyRequest,
  reply: FastifyReply,
  field: string,
): string | null {
  const raw = (request.params as Record<string, string | undefined>)[field];
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: [{ field, issue: 'must be a valid UUID' }],
        request_id: request.id,
      },
    });
    return null;
  }
  return parsed.data;
}
