import type { FastifyInstance } from 'fastify';

// Bulwark REST surface (spec 5.1). PLACEHOLDER for M1: a single /ping liveness route so the
// scaffold typechecks and boots. The full contract/obligation/deadline/waiver/compliance/
// settings surface (plus the INTERNAL_SERVICE_SECRET-guarded /internal/events ingest route
// and the proposal-decided handler) replaces this in M4.
export default async function bulwarkRoutes(fastify: FastifyInstance) {
  fastify.get('/ping', async () => {
    return { data: { ok: true, service: 'bulwark-api' } };
  });
}
