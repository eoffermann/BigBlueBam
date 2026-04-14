import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const requestId = request.id;

  // Zod validation errors
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
        request_id: requestId,
      },
    });
  }

  // Fastify validation errors
  if (error.validation) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.validation.map((v) => ({
          path: v.instancePath,
          message: v.message ?? 'Invalid value',
        })),
        request_id: requestId,
      },
    });
  }

  // Rate limit errors
  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later',
        details: [],
        request_id: requestId,
      },
    });
  }

  // Known HTTP errors
  if (error.statusCode && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      error: {
        code: error.code ?? 'CLIENT_ERROR',
        message: error.message,
        details: [],
        request_id: requestId,
      },
    });
  }

  // Unknown / server errors.
  //
  // Closes Platform_Plan.md (2026-04-13-revised) gap 2.3.2. Production used
  // to return a generic envelope with no correlation handle beyond
  // request_id, so an end user reporting a failure could only paste a
  // request id that an operator then had to grep for in raw stdout. We now
  // mint a stable internal_error_id per failure, log the full cause against
  // it on the structured logger, and return the id to the client. The
  // operator can grep `internal_error_id=<uuid>` to find the cause without
  // any cause-bearing fields leaking into the HTTP response.
  const isProd = process.env.NODE_ENV === 'production';
  const internalErrorId = randomUUID();

  request.log.error(
    {
      err: error,
      internal_error_id: internalErrorId,
      request_id: requestId,
    },
    'Unhandled error',
  );

  if (isProd) {
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        details: [],
        request_id: requestId,
        internal_error_id: internalErrorId,
      },
    });
  }

  const cause = {
    name: error.name ?? 'Error',
    message: error.message ?? String(error),
    code: (error as FastifyError & { code?: string }).code,
    stack: error.stack,
  };

  return reply.status(500).send({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      details: [cause],
      request_id: requestId,
      internal_error_id: internalErrorId,
    },
  });
}
