import type { FastifyInstance } from 'fastify';
import { burnSettingsUpdateSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, requireOrgAdmin, validationError, viewerOf } from '../lib/http.js';
import { publishBurnFrame } from '../lib/realtime.js';
import * as settings from '../services/settings.service.js';

export default async function settingsRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/settings', { preHandler: [requireAuth, can('burn.settings.read')] }, async (request) =>
    settings.getSettings(viewerOf(request)),
  );

  fastify.get(
    '/calibration',
    { preHandler: [requireAuth, can('burn.settings.read')] },
    async (request) => {
      // Standing against ALL SEVEN preconditions with the shortfall NAMED. Advisory is a
      // complete product and the console says so; an org with no promotion path still gets
      // the queue, the variance inbox, change-order drafts, and the financial figures.
      const result = await settings.getCalibration(viewerOf(request), fastify.redis);
      return {
        ...result,
        coverage_window_days: settings.CALIBRATION_COVERAGE_WINDOW_DAYS,
      };
    },
  );

  fastify.patch(
    '/settings',
    // Two independent gates. `burn.settings.write` owns gate_mode, and weakening the spend
    // control is the consequential direction -- so the in-route role guard is here too.
    { preHandler: [requireAuth, can('burn.settings.write'), requireOrgAdmin] },
    async (request, reply) => {
      const raw = (request.body ?? {}) as Record<string, unknown>;
      // `acknowledge_blocking` is a REQUEST flag, not a stored setting (precondition 7), so
      // it is peeled off before the strict schema rejects it as an unknown key.
      const { acknowledge_blocking: acknowledgeBlocking, ...rest } = raw;
      const parsed = burnSettingsUpdateSchema.safeParse(rest);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await settings.updateSettings(
          viewerOf(request),
          parsed.data,
          { acknowledge_blocking: acknowledgeBlocking === true },
          fastify.redis,
        );
        if (parsed.data.gate_mode && parsed.data.gate_mode !== result.previous_gate_mode) {
          const orgId = request.user!.active_org_id ?? request.user!.org_id;
          // Org-wide frame: a gate mode change affects everyone who posts a charge. No
          // dollars, no chain refs -- just the mode and a short reason.
          await publishBurnFrame(orgId, [], {
            type: 'gate.mode_changed',
            mode: parsed.data.gate_mode,
            reason: `changed by an organization administrator from ${result.previous_gate_mode}`,
          }).catch(() => {});
        }
        return { data: result.data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
