/**
 * @bigbluebam/service-health
 *
 * Fastify plugin that exposes canonical health and prometheus metrics
 * endpoints for every Bam service. Registered per-service during Wave 2 of
 * the 2026-04-13 push; the package itself ships as part of Wave 1.D.
 */
export { serviceHealthPlugin } from './plugin.js';
export type {
  ServiceHealthOptions,
  ServiceHealthChecks,
} from './plugin.js';
