import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

/**
 * Minimal Sentry-compatible surface. We do not take a hard dependency on
 * @sentry/node in this package so services that don't install it still
 * build; the factory accepts anything that implements `captureException`
 * with the shape we use.
 */
export interface SentryLike {
  captureException(
    error: unknown,
    hint?: { tags?: Record<string, string | number | boolean>; extra?: Record<string, unknown> },
  ): string | undefined;
}

export interface CreateErrorHandlerOptions {
  /**
   * Short service identifier. Currently unused in the response envelope but
   * propagated to Sentry tags so support can filter by origin.
   */
  serviceName: string;
  /**
   * Optional Sentry client. When provided, unknown 5xx errors are captured
   * with the mint internal_error_id as a tag so log lines and Sentry events
   * can be cross-referenced without leaking the cause to the client.
   */
  sentry?: SentryLike;
}

/**
 * Factory that produces a Fastify error handler matching the Bam canonical
 * behavior (Wave 0.1):
 *
 *   - ZodError -> 400 VALIDATION_ERROR with path/message details
 *   - error.validation -> 400 VALIDATION_ERROR with field/message details
 *   - statusCode 429 -> RATE_LIMIT_EXCEEDED
 *   - statusCode 4xx -> passthrough with the error's code or CLIENT_ERROR
 *   - anything else -> 500 INTERNAL_SERVER_ERROR with a minted
 *     internal_error_id stamped both on the response envelope and the log
 *     line. In non-production builds the underlying cause (name, message,
 *     stack, code) is inlined into `details` for developer ergonomics.
 *
 * Returned as a function ready to pass to `fastify.setErrorHandler(...)`.
 */
export function createErrorHandler(opts: CreateErrorHandlerOptions) {
  const { serviceName, sentry } = opts;

  return function errorHandler(
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const requestId = request.id;

    // Zod validation errors.
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

    // Fastify validation errors.
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

    // Rate limit errors.
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

    // Known HTTP errors - any 4xx passes through with the original code
    // when present.
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

    // Unknown / server errors. Mint a stable correlation handle so the
    // end user can paste it verbatim and an operator can grep
    // `internal_error_id=<uuid>` across the log sink to pull the cause
    // without any cause-bearing fields leaking in the HTTP response.
    const isProd = process.env.NODE_ENV === 'production';
    const internalErrorId = randomUUID();

    request.log.error(
      {
        err: error,
        internal_error_id: internalErrorId,
        request_id: requestId,
        service: serviceName,
      },
      'Unhandled error',
    );

    if (sentry) {
      try {
        sentry.captureException(error, {
          tags: {
            internal_error_id: internalErrorId,
            service: serviceName,
            request_id: requestId,
          },
        });
      } catch {
        // Never let error reporting break the response path.
      }
    }

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
  };
}

/**
 * Type alias for the returned handler so consumers can store the result in
 * a typed local if they prefer that over inferring.
 */
export type BamErrorHandler = ReturnType<typeof createErrorHandler>;
