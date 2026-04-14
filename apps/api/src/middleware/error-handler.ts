/**
 * Bam API error handler.
 *
 * Wave 1.D consolidated the canonical Fastify error handler into
 * `@bigbluebam/logging` and every API service now registers the same
 * handler. This file is a thin re-export so existing imports
 * (`import { errorHandler } from './middleware/error-handler.js'`) keep
 * working without touching the server bootstrap.
 */
import { createErrorHandler } from '@bigbluebam/logging';

export const errorHandler = createErrorHandler({ serviceName: 'api' });
