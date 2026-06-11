/**
 * Shared logging utilities for BigBlueBam services.
 *
 * Exports:
 *   - `createLogger(options)` pino factory with pino-pretty in dev.
 *   - `requestIdPlugin` Fastify plugin that attaches a request-id and child
 *     logger to every incoming request.
 *   - `createErrorHandler(options)` unified Fastify error handler.
 *   - `initErrorReporting(serviceName)` Sentry init hook (no-op if
 *     SENTRY_DSN is unset; Sentry SDK is an optional peer dep).
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';

export { type Logger } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions['level'];
  isDev?: boolean;
  sentryDsn?: string;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? (process.env.LOG_LEVEL as LoggerOptions['level']) ?? 'info';
  const isDev = options.isDev ?? process.env.NODE_ENV !== 'production';
  const base: LoggerOptions = {
    level,
    base: { service: options.service },
  };
  if (isDev) {
    base.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
  }
  return pino(base);
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export const requestIdPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.decorateRequest('requestId', '');
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const header = request.headers['x-request-id'];
    const id =
      (Array.isArray(header) ? header[0] : header) && String(header).length > 0
        ? String(Array.isArray(header) ? header[0] : header)
        : randomUUID();
    request.requestId = id;
    request.log = request.log.child({ request_id: id });
  });
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.requestId);
  });
});

export interface ErrorRecorderContext {
  request_id: string;
  internal_error_id: string;
  service: string;
  method?: string;
  route?: string;
  status_code: number;
  user_id?: string | null;
  org_id?: string | null;
}

export interface CreateErrorHandlerOptions {
  serviceName: string;
  /** Optional Sentry capture function; receives (err, { request_id, internal_error_id }). */
  sentryCapture?: (
    err: Error,
    context: { request_id: string; internal_error_id: string; service: string },
  ) => void;
  /**
   * Optional sink for 5xx errors — typically inserts a row into the
   * system_errors table so the SuperUser Console's Log Analysis tab can
   * display them. Errors thrown by the recorder are swallowed (logging
   * must never crash a request).
   */
  recordError?: (err: Error, context: ErrorRecorderContext) => void | Promise<void>;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Array<{ field?: string; issue?: string; [k: string]: unknown }>;
    request_id: string;
    internal_error_id?: string;
  };
}

function isZodLikeError(err: unknown): err is { issues: Array<{ path: unknown[]; message: string }> } {
  return !!err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues);
}

export function createErrorHandler(options: CreateErrorHandlerOptions) {
  return async function errorHandler(
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const requestId = (request as unknown as { requestId?: string }).requestId ?? request.id;

    // Defensive: if a prior step already flushed the reply (e.g. a
    // content-type-parser error that Fastify partially handled), do NOT
    // touch it again — a second send re-runs the onSend pipeline and
    // throws ERR_HTTP_HEADERS_SENT, which is uncaught and kills the
    // process. Returning the reply also signals Fastify NOT to auto-send
    // this async handler's resolved value (the historical double-send that
    // crashed every service on an empty-JSON-body POST).
    if (reply.sent) return reply;

    if (isZodLikeError(error)) {
      const details = (error as unknown as { issues: Array<{ path: unknown[]; message: string }> }).issues.map((i) => ({
        field: Array.isArray(i.path) ? i.path.join('.') : undefined,
        issue: i.message,
      }));
      const envelope: ErrorEnvelope = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
          request_id: String(requestId),
        },
      };
      return reply.status(400).send(envelope);
    }

    if (error.validation) {
      const envelope: ErrorEnvelope = {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message ?? 'Validation failed',
          details: error.validation.map((v) => ({ field: v.instancePath ?? v.schemaPath, issue: v.message })),
          request_id: String(requestId),
        },
      };
      return reply.status(400).send(envelope);
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const envelope: ErrorEnvelope = {
        error: {
          code: (error as unknown as { code?: string }).code ?? 'REQUEST_ERROR',
          message: error.message ?? 'Request error',
          details: [],
          request_id: String(requestId),
        },
      };
      return reply.status(statusCode).send(envelope);
    }

    const internalErrorId = randomUUID();
    request.log.error(
      {
        err: { message: error.message, stack: error.stack, name: error.name },
        internal_error_id: internalErrorId,
        request_id: requestId,
      },
      '5xx error',
    );
    if (options.sentryCapture) {
      try {
        options.sentryCapture(error, {
          request_id: String(requestId),
          internal_error_id: internalErrorId,
          service: options.serviceName,
        });
      } catch {
        // swallow, logging must never throw
      }
    }
    if (options.recordError) {
      // Best-effort sink for the SuperUser Log Analysis tab. Pull the
      // best caller context we can without forcing the host to wire it
      // up explicitly — `request.user` is the api's convention, but
      // satellite services that don't set it just skip.
      const callerUser = (request as unknown as { user?: { id?: string | null; active_org_id?: string | null; org_id?: string | null } | null }).user;
      const route =
        (request as unknown as { routeOptions?: { url?: string } }).routeOptions?.url ??
        request.url.split('?')[0] ??
        request.url;
      try {
        void Promise.resolve(
          options.recordError(error, {
            request_id: String(requestId),
            internal_error_id: internalErrorId,
            service: options.serviceName,
            method: request.method,
            route,
            status_code: statusCode,
            user_id: callerUser?.id ?? null,
            org_id: callerUser?.active_org_id ?? callerUser?.org_id ?? null,
          }),
        ).catch(() => {
          // swallow — logging must never crash a request
        });
      } catch {
        // swallow synchronous throws too
      }
    }
    const envelope: ErrorEnvelope = {
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : error.message ?? 'Internal server error',
        details: [],
        request_id: String(requestId),
        internal_error_id: internalErrorId,
      },
    };
    return reply.status(500).send(envelope);
  };
}

/**
 * Sentry init hook. If `SENTRY_DSN` env is set, dynamically import
 * `@sentry/node` and call `init`. If the package is not installed or
 * DSN is unset, this is a no-op. We use dynamic import so services
 * without Sentry do not take on the dependency.
 */
export async function initErrorReporting(serviceName: string): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const moduleName = '@sentry/node';
    const sentry = (await import(moduleName)) as unknown as {
      init: (opts: Record<string, unknown>) => void;
    };
    sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      serverName: serviceName,
      tracesSampleRate: 0,
    });
  } catch {
    // @sentry/node not installed, silent.
  }
}
