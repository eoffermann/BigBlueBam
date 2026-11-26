import type { FastifyInstance } from 'fastify';
import {
  bastionAuditLogQuerySchema,
  bastionDeliveryProblemListQuerySchema,
  bastionDeliveryRetrySchema,
  bastionSettingsUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { bucketStorageOk } from '../boot/bucket-check.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import { offsiteBackupConfigured } from '../services/evidence-runtime.js';
import * as settings from '../services/settings.service.js';

// Spec 5.1 rows 96-100 (M9): settings, delivery problems (dead outbox rows and their re-drive),
// and the Bastion audit log. All reachable with an API key under the same permissions
// (decision #196): owners and admins hold settings.write and audit.read by default.
export default async function settingsRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const engine = () => engineDeps(fastify.log, fastify.redis);
  const facts = () => ({ offsite_backup_configured: offsiteBackupConfigured(), storage_ok: bucketStorageOk() });
  const query = (request: { query: unknown }) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  };

  // Row 96.
  fastify.get('/settings', { preHandler: [requireAuth, can('bastion.settings.read')] }, async (request, reply) =>
    handled(request, reply, () => settings.getSettings(engine(), viewerOf(request), facts())),
  );

  // Row 97.
  fastify.patch('/settings', { preHandler: [requireAuth, can('bastion.settings.write')] }, async (request, reply) => {
    const parsed = bastionSettingsUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => settings.updateSettings(engine(), viewerOf(request), parsed.data, facts()));
  });

  // Row 98.
  fastify.get('/delivery-problems', { preHandler: [requireAuth, can('bastion.settings.write')] }, async (request, reply) => {
    const parsed = bastionDeliveryProblemListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => settings.listDeliveryProblems(engine(), viewerOf(request), parsed.data));
  });

  // Row 99.
  fastify.post('/delivery-problems/:id/retry', { preHandler: [requireAuth, can('bastion.settings.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionDeliveryRetrySchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => settings.retryDelivery(engine(), viewerOf(request), id));
  });

  // Row 100.
  fastify.get('/audit', { preHandler: [requireAuth, can('bastion.audit.read')] }, async (request, reply) => {
    const parsed = bastionAuditLogQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => settings.listAudit(engine(), viewerOf(request), parsed.data));
  });
}
