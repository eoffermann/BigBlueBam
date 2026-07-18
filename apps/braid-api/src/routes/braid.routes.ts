import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';

// Braid REST surface (spec 5.1). Placeholder registration for M1 scaffold; the full
// /v1 endpoints (profiles, resolve, candidates, merge/split, rules, settings) land in M4.
export default async function braidRoutes(fastify: FastifyInstance) {
  fastify.get('/ping', { preHandler: requireAuth }, async () => {
    return { data: { app: 'braid', ok: true } };
  });
}
