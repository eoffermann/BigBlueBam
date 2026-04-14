/**
 * Banter API error handler.
 *
 * Wave 1.D consolidated the canonical Fastify error handler into
 * `@bigbluebam/logging`. This thin shim keeps the module path stable so
 * future middleware files (per-service custom logic) have an obvious
 * home, while delegating the actual implementation to the shared factory.
 */
import { createErrorHandler } from '@bigbluebam/logging';

export const errorHandler = createErrorHandler({ serviceName: 'banter-api' });
