import type { FastifyInstance } from 'fastify';
import { bastionCoverageQuerySchema } from '@bigbluebam/shared';
import { bucketStorageOk } from '../boot/bucket-check.js';
import { requireAuth } from '../plugins/auth.js';
import { handled, validationError, viewerOf } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import { coverageMap, readinessSummary } from '../services/coverage.service.js';
import { offsiteBackupConfigured } from '../services/evidence-runtime.js';

// Spec 5.1 rows 50 and 94 (M5): the Evidence map and the Readiness summary. Both read the one
// loader in engine/numbers.ts (the four numbers plus "Not set up yet" and the denominator).
export default async function coverageRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => engineDeps(fastify.log, fastify.redis);
  const query = (raw: unknown) => {
    const q = (raw ?? {}) as Record<string, string | undefined>;
    return bastionCoverageQuerySchema.safeParse({ framework_id: q.framework_id || undefined });
  };

  // Row 50.
  // Both take `asker_user_id` (#217): the person an agent reads for must hold control.read too.
  const asker = (p: string) => fastify.requireAskerCan(p);

  fastify.get('/coverage', { preHandler: [requireAuth, can('bastion.control.read'), asker('bastion.control.read')] }, async (request, reply) => {
    const parsed = query(request.query);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => coverageMap(deps(), viewerOf(request), parsed.data.framework_id));
  });

  // Row 94.
  fastify.get('/summary', { preHandler: [requireAuth, can('bastion.control.read'), asker('bastion.control.read')] }, async (request, reply) => {
    const parsed = query(request.query);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () =>
      readinessSummary(deps(), viewerOf(request), parsed.data.framework_id, {
        storage_ok: bucketStorageOk(),
        offsite_backup_configured: offsiteBackupConfigured(),
      }),
    );
  });
}
