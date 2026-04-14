/**
 * Board API error handler - thin shim over the shared factory from
 * `@bigbluebam/logging`. Wave 1.D rollout.
 */
import { createErrorHandler } from '@bigbluebam/logging';

export const errorHandler = createErrorHandler({ serviceName: 'board-api' });
