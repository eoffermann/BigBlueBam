import type { FastifyInstance } from 'fastify';
import {
  burnListQuerySchema,
  burnPrecheckLabelSchema,
  burnPrecheckOverrideSchema,
  burnPrecheckRequestSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import { publishBurnFrame } from '../lib/realtime.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { resolveSinglePermission } from '../lib/viewer-caps.js';
import { env } from '../env.js';
import { runInOrgScope } from '../plugins/rls.js';
import { isAdminViewer } from '../services/types.js';
import * as precheck from '../services/precheck.service.js';
import * as ledger from '../services/ledger.service.js';

export default async function precheckRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  /**
   * THE GATE, user-facing. `usr:` namespace.
   *
   * Rows are marked `is_calibrating = false` unless `work_ref_id` resolves, and are subject
   * to a per-user daily cap plus the per-(member, deliverable) probe cap. Both exist because
   * `POST /v1/precheck` would otherwise be a way to MANUFACTURE A CALIBRATION SAMPLE
   * (spec 2.4 point 10): a member scripts 200 `work_ref_type: 'manual'` rows in seconds and
   * satisfies the promotion volume gate on evidence they invented.
   */
  fastify.post(
    '/precheck',
    { preHandler: [requireAuth, can('burn.precheck.run')] },
    async (request, reply) => {
      const parsed = burnPrecheckRequestSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const viewer = viewerOf(request);
        const caps = await request.viewerCaps();

        // Project-scoped: a non-project member gets a scoped rejection, not envelope
        // figures. This is the S1 "the gate is not an oracle" assertion -- without it,
        // POST /v1/precheck against an arbitrary project id is a read of that project's
        // envelope state by anyone in the org.
        if (parsed.data.project_id && !isAdminViewer(viewer)) {
          const mine = await memberProjectIds(viewer.id);
          if (!mine.includes(parsed.data.project_id)) {
            return reply.status(403).send({
              error: {
                code: 'FORBIDDEN',
                message: 'You are not a member of the project this charge is scoped to',
                details: [],
                request_id: request.id,
              },
            });
          }
        }

        const result = await precheck.runPrecheck({
          caller: {
            viewer,
            namespace: 'usr',
            canReadAll: caps.financials_read_all,
            redis: fastify.redis,
          },
          req: parsed.data,
          orgId: viewer.org_id,
        });

        await emitDecided(viewer.org_id, result.precheck_id, result.verdict, result.engagement_id);
        return redactFinancialFields({ data: result }, caps);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/prechecks',
    { preHandler: [requireAuth, can('burn.precheck.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const viewer = readViewer(request);
      const caps = await request.viewerCaps();
      const mine = isAdminViewer(viewer) ? [] : await memberProjectIds(viewer.id);
      const result = await precheck.listPrechecks(
        viewer,
        {
          cursor: q.cursor,
          limit,
          verdict: q.filter?.verdict,
          engagementId: q.filter?.engagement_id,
        },
        mine,
        caps.financials_read_all,
      );
      return redactFinancialFields(result, caps);
    },
  );

  /**
   * Override with a reason. MEMBER TIER, deliberately.
   *
   * Raising `burn.precheck.override` above member is rejected in the spec and here: a member
   * who hits a block must be able to proceed. Requiring an admin for every override
   * recreates exactly the friction that gets the whole feature switched off, which is the
   * failure mode three voting seats independently named. Only the demotion-driving LABEL
   * moves up a tier, not the escape hatch.
   */
  fastify.post(
    '/prechecks/:id/override',
    { preHandler: [requireAuth, can('burn.precheck.override')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnPrecheckOverrideSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await precheck.overridePrecheck(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  /**
   * ONE ROUTE, TWO AUTHORITIES (spec 2.4 point 9).
   *
   * `right_call` / `would_have_mapped` / `flag_for_review` need only `burn.precheck.run` on
   * the caller's own non-enforced row. `wrong_call` and `gate_wrong` need
   * `burn.precheck.mark_wrong` PLUS the second in-route org-role guard.
   *
   * The route gate is the WEAKER permission and the stronger authority is resolved inside,
   * because a single route with a single hard gate is what produced the round-2 defect: the
   * inline member control rendered for everyone, gated on the owner/admin permission, so
   * every member who clicked got a 403 -- and the natural fix for THAT is to lower the whole
   * route to member tier, silently evaporating the demotion-integrity control.
   */
  fastify.post(
    '/prechecks/:id/label',
    { preHandler: [requireAuth, can('burn.precheck.run')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnPrecheckLabelSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const viewer = viewerOf(request);
        // Two independent conditions, both required: the named permission AND the org role
        // read directly off request.user, so a permission-resolver outage cannot open it.
        let canMarkWrong = false;
        if (isAdminViewer(viewer)) {
          canMarkWrong = await resolveSinglePermission(
            {
              apiInternalUrl: env.BBB_API_INTERNAL_URL,
              internalSecret: env.INTERNAL_SERVICE_SECRET,
              timeoutMs: env.UPSTREAM_TIMEOUT_MS,
              log: request.log,
            },
            viewer.id,
            viewer.org_id,
            'burn.precheck.mark_wrong',
          );
        }
        const result = await precheck.labelPrecheck(viewer, id, parsed.data, canMarkWrong);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  async function emitDecided(
    orgId: string,
    precheckId: string,
    verdict: string,
    engagementId: string | null,
  ) {
    try {
      const projectIds = engagementId
        ? await runInOrgScope(orgId, (tx) => ledger.projectsForChain(tx, orgId, engagementId))
        : [];
      await publishBurnFrame(orgId, projectIds, {
        type: 'precheck.decided',
        precheck_id: precheckId,
        verdict: verdict as never,
        engagement_id: engagementId,
      });
    } catch {
      // advisory only
    }
  }
}
