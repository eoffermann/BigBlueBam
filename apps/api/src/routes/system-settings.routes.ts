import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { requireAuth } from '../plugins/auth.js';
import { requireSuperuser } from '../middleware/require-superuser.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import { isBootstrapRequired } from '../services/bootstrap-status.service.js';
import { dualReadGate } from '../middleware/dual-read.js';

// Canonical Launchpad app catalog. Mirrors the APPS array in
// packages/ui/launchpad.tsx — keep them in sync. The launchpad_default_apps
// system_setting and the per-org organizations.settings.launchpad_apps are
// arrays of these ids; null/missing means "all apps enabled".
export const LAUNCHPAD_APP_IDS = [
  'b3',
  'banter',
  'beacon',
  'bond',
  'blast',
  'bill',
  'blank',
  'book',
  'bench',
  'brief',
  'bolt',
  'bearing',
  'board',
  'helpdesk',
] as const;

export type LaunchpadAppId = (typeof LAUNCHPAD_APP_IDS)[number];

// Valid values for the root_redirect setting
const ROOT_REDIRECT_VALUES = [
  'site',
  'b3',
  'banter',
  'beacon',
  'brief',
  'bolt',
  'bearing',
  'board',
  'bond',
  'helpdesk',
] as const;

type RootRedirectValue = (typeof ROOT_REDIRECT_VALUES)[number];

// Map setting value to URL path
const REDIRECT_MAP: Record<RootRedirectValue, string | null> = {
  site: null, // null means no redirect — serve marketing site
  b3: '/b3/',
  banter: '/banter/',
  beacon: '/beacon/',
  brief: '/brief/',
  bolt: '/bolt/',
  bearing: '/bearing/',
  board: '/board/',
  bond: '/bond/',
  helpdesk: '/helpdesk/',
};

// Per-key value validators
//
// New keys can be added here freely — the PUT route applies the matching
// validator if one exists, otherwise accepts the raw value. Keys without a
// validator are still SuperUser-gated at the route level.
//
// NOTE on SMTP: the password is stored plaintext in the system_settings
// value column. For self-hosted BigBlueBam where the operator controls both
// the DB and the app, this is a defensible trade-off (same person has
// access to both). If you're running in a multi-tenant context where the
// DB might be visible to parties who should not see SMTP creds, set the
// values via env vars instead — the resolver (apps/worker/src/utils/
// smtp-config.mjs) reads the DB first and falls back to env vars, so
// env-only deploys still work.
const KEY_VALIDATORS: Record<string, z.ZodType> = {
  root_redirect: z.enum(ROOT_REDIRECT_VALUES),

  // Platform-wide Launchpad default. Null/empty means "all apps enabled".
  // SuperUsers set this to constrain the default for every org that hasn't
  // overridden launchpad_apps in their organizations.settings JSONB.
  launchpad_default_apps: z.union([
    z.null(),
    z.array(z.enum(LAUNCHPAD_APP_IDS)).max(LAUNCHPAD_APP_IDS.length),
  ]),

  // SMTP (see apps/worker/src/utils/smtp-config.mjs for the resolver)
  smtp_host: z.string().min(1).max(255),
  smtp_port: z.union([
    z.number().int().min(1).max(65535),
    z.string().regex(/^\d+$/).refine((v) => {
      const n = parseInt(v, 10);
      return n >= 1 && n <= 65535;
    }, 'smtp_port must be an integer between 1 and 65535'),
  ]),
  smtp_user: z.string().min(1).max(255),
  smtp_password: z.string().min(1).max(512),
  smtp_from: z.string().email(),
  smtp_secure: z.boolean(),
};

export default async function systemSettingsRoutes(fastify: FastifyInstance) {
  // ─── GET /system-settings — list all settings (SuperUser only) ────────
  fastify.get(
    '/system-settings',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireSuperuser, permission: 'bam.system_setting.list' })] },
    async () => {
      const rows = await db.select().from(systemSettings);
      return { data: rows };
    },
  );

  // ─── GET /system-settings/:key — read a single setting (authenticated) ─
  fastify.get<{ Params: { key: string } }>(
    '/system-settings/:key',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { key } = request.params;
      const [row] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Setting '${key}' not found`,
            details: [],
            request_id: request.id,
          },
        });
      }

      return { data: row };
    },
  );

  // ─── PUT /system-settings/:key — update a setting (SuperUser only) ─────
  fastify.put<{ Params: { key: string } }>(
    '/system-settings/:key',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireSuperuser, permission: 'bam.system_setting.update' })] },
    async (request, reply) => {
      const { key } = request.params;

      // Validate the body has a `value` field
      const bodySchema = z.object({ value: z.unknown() });
      const bodyParsed = bodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request body must include a "value" field',
            details: bodyParsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      // If there is a key-specific validator, apply it
      const keyValidator = KEY_VALIDATORS[key];
      if (keyValidator) {
        const result = keyValidator.safeParse(bodyParsed.data.value);
        if (!result.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid value for setting '${key}'`,
              details: result.error.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
              })),
              request_id: request.id,
            },
          });
        }
      }

      const userId = request.user!.id;
      const now = new Date();

      // Upsert the setting
      await db
        .insert(systemSettings)
        .values({
          key,
          value: JSON.stringify(bodyParsed.data.value),
          updated_by: userId,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: JSON.stringify(bodyParsed.data.value),
            updated_by: userId,
            updated_at: now,
          },
        });

      await logSuperuserAction({
        superuserId: userId,
        action: 'update_system_setting',
        details: { key, value: bodyParsed.data.value },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });

      // Return the updated row
      const [updated] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      return { data: updated };
    },
  );

  // ─── GET /root-redirect — unauthenticated, for nginx/site redirect ────
  // Returns { redirect: "/helpdesk/" } or { redirect: null } (serve site).
  // When the install has not been bootstrapped yet, overrides any configured
  // redirect and sends the visitor to the SuperUser sign-up page so the
  // first person to hit the site can create the root account.
  fastify.get('/root-redirect', async () => {
    if (await isBootstrapRequired()) {
      return { redirect: '/b3/bootstrap' };
    }

    const [row] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'root_redirect'));

    if (!row) {
      // Default: no redirect (serve marketing site)
      return { redirect: null };
    }

    // The value is stored as a JSON string, e.g. "site" or "helpdesk"
    const val = (typeof row.value === 'string' ? row.value : String(row.value)) as RootRedirectValue;
    const redirect = REDIRECT_MAP[val] ?? null;
    return { redirect };
  });
}
