/**
 * @bigbluebam/logging
 *
 * Shared infrastructure for Bam API services:
 *
 *   - createLogger: pino factory with production redaction + dev pretty
 *     printer and a consistent `service` base field
 *   - requestIdPlugin: Fastify plugin that propagates a safe X-Request-ID
 *     header across hops
 *   - createErrorHandler: canonical Fastify error handler that emits the
 *     Bam error envelope, mints `internal_error_id` on 5xx for support
 *     correlation, and optionally forwards to Sentry
 *   - initErrorReporting: lazy Sentry initializer, no-op when SENTRY_DSN is
 *     unset
 */
export { createLogger } from './logger.js';
export type { CreateLoggerOptions, Logger, LoggerOptions } from './logger.js';
export { requestIdPlugin } from './request-id-plugin.js';
export type { RequestIdPluginOptions } from './request-id-plugin.js';
export { createErrorHandler } from './error-handler.js';
export type {
  CreateErrorHandlerOptions,
  BamErrorHandler,
  SentryLike,
} from './error-handler.js';
export { initErrorReporting } from './error-reporting.js';
export type { ErrorReportingHandle } from './error-reporting.js';
