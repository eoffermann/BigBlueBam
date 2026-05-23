import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { organizations } from '../db/schema/organizations.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { requireAuth } from '../plugins/auth.js';
import * as orgService from '../services/org.service.js';
import { LAUNCHPAD_APP_IDS, type LaunchpadAppId } from './system-settings.routes.js';
import { shadowOnly } from '../middleware/dual-read.js';

/**
 * Launchpad app visibility. Two-tier:
 *   - Platform default in `system_settings.launchpad_default_apps` (SuperUser).
 *   - Per-org override in `organizations.settings.launchpad_apps` (admin/owner).
 *
 * Resolution: org override → platform default → null (means "all apps enabled").
 * The catalog itself (icons/colors/paths) lives in packages/ui/launchpad.tsx;
 * only the *visibility list* of ids is stored here.
 */

const appIdSchema = z.enum(LAUNCHPAD_APP_IDS);
const appsArraySchema = z.array(appIdSchema).max(LAUNCHPAD_APP_IDS.length);

async function readPlatformDefault(): Promise<LaunchpadAppId[] | null> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'launchpad_default_apps'));
  if (!row) return null;
  // Stored as JSON; the PUT handler stringifies the value, so it can come
  // back as either an array or a JSON string depending on the JSONB driver
  // path. Both paths are tolerated.
  const parsed = (() => {
    if (Array.isArray(row.value)) return row.value;
    if (typeof row.value === 'string') {
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return null;
      }
    }
    return row.value;
  })();
  const result = appsArraySchema.nullable().safeParse(parsed);
  return result.success ? result.data : null;
}

function readOrgOverride(settings: unknown): LaunchpadAppId[] | null {
  if (!settings || typeof settings !== 'object') return null;
  const raw = (settings as Record<string, unknown>).launchpad_apps;
  if (raw === undefined || raw === null) return null;
  const result = appsArraySchema.safeParse(raw);
  return result.success ? result.data : null;
}

export default async function launchpadRoutes(fastify: FastifyInstance) {
  // ─── GET /launchpad/apps ─────────────────────────────────────────────────
  // Any authenticated user. Returns the resolved list for the caller's active
  // org plus metadata about which layer won, so the UI can show
  // "inherits from platform" hints.
  fastify.get('/launchpad/apps', { preHandler: [requireAuth, shadowOnly('bam.launchpad_app.list')] }, async (request) => {
    const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
    const orgOverride = org ? readOrgOverride(org.settings) : null;
    const platformDefault = await readPlatformDefault();

    const source: 'org' | 'platform' | 'default' = orgOverride
      ? 'org'
      : platformDefault
        ? 'platform'
        : 'default';

    const enabled =
      orgOverride ?? platformDefault ?? ([...LAUNCHPAD_APP_IDS] as LaunchpadAppId[]);

    return {
      data: {
        catalog: LAUNCHPAD_APP_IDS,
        enabled,
        source,
        org_override: orgOverride,
        platform_default: platformDefault,
      },
    };
  });

  // ─── GET /org/launchpad-apps ─────────────────────────────────────────────
  // Org admin/owner. Returns the org's current override (or null if it inherits)
  // alongside the platform default and full catalog so the UI can render the
  // checkbox list without a second round-trip.
  fastify.get(
    '/org/launchpad-apps',
    { preHandler: [requireAuth, fastify.requireCan('bam.org_launchpad_app.list')] },
    async (request, reply) => {
      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }
      const orgOverride = readOrgOverride(org.settings);
      const platformDefault = await readPlatformDefault();
      return {
        data: {
          catalog: LAUNCHPAD_APP_IDS,
          org_override: orgOverride,
          platform_default: platformDefault,
        },
      };
    },
  );

  // ─── PUT /org/launchpad-apps ─────────────────────────────────────────────
  // Org admin/owner. Pass `{ apps: [...] }` to override, or `{ apps: null }`
  // to clear the override and fall back to the platform default. The body
  // is a shallow merge into `organizations.settings` — only the
  // `launchpad_apps` key is touched.
  fastify.put(
    '/org/launchpad-apps',
    { preHandler: [requireAuth, fastify.requireCan('bam.org_launchpad_app.update')] },
    async (request, reply) => {
      const schema = z.object({ apps: appsArraySchema.nullable() });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid apps array',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }

      const currentSettings =
        org.settings && typeof org.settings === 'object'
          ? { ...(org.settings as Record<string, unknown>) }
          : {};

      if (parsed.data.apps === null) {
        delete currentSettings.launchpad_apps;
      } else {
        currentSettings.launchpad_apps = parsed.data.apps;
      }

      // Bypass the typed updateOrganization helper because its `settings`
      // argument replaces the whole object; we want a shallow merge of just
      // the launchpad_apps key.
      await db
        .update(organizations)
        .set({ settings: currentSettings, updated_at: new Date() })
        .where(eq(organizations.id, request.user!.org_id));

      orgService.invalidateOrgCache(request.user!.org_id, fastify.redis);

      request.log.info(
        {
          event: 'org.launchpad_apps_updated',
          caller_id: request.user!.id,
          org_id: request.user!.org_id,
          apps: parsed.data.apps,
        },
        'Org admin updated launchpad apps',
      );

      const platformDefault = await readPlatformDefault();
      return reply.send({
        data: {
          catalog: LAUNCHPAD_APP_IDS,
          org_override: parsed.data.apps,
          platform_default: platformDefault,
        },
      });
    },
  );
}
