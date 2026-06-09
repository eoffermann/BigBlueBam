import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { requireAuth } from '../plugins/auth.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import { isBootstrapRequired } from '../services/bootstrap-status.service.js';
import { shadowOnly } from '../middleware/dual-read.js';

// Canonical Launchpad app catalog. THIS is the single source of truth for
// every app the suite exposes — `LAUNCHPAD_CATALOG` carries the rendering
// metadata (name, description, icon, color, path) and the API ships it to
// every SPA at runtime so adding a new app no longer requires rebuilding
// every frontend container.
//
// Adding a new app:
//   1. Append its id to LAUNCHPAD_APP_IDS below (kept as a literal-tuple so
//      zod's z.enum can derive the union type for stored override columns).
//   2. Append the matching metadata row to LAUNCHPAD_CATALOG.
//   3. If a brand-new icon name is needed, add it to the icon map in
//      packages/ui/launchpad.tsx::ICONS so client renderers can resolve it.
//
// Once those three edits land in apps/api and packages/ui rebuilds, every
// other SPA picks up the new app at runtime without a container rebuild.

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
  'blueprint',
  'helpdesk',
] as const;

export type LaunchpadAppId = (typeof LAUNCHPAD_APP_IDS)[number];

export interface LaunchpadAppEntry {
  id: LaunchpadAppId;
  name: string;
  description: string;
  /** Lucide icon name in kebab-case (e.g. `layout-dashboard`). The client
   *  maps this to a React component via the `ICONS` table in launchpad.tsx. */
  icon_name: string;
  color: string;
  path: string;
}

export const LAUNCHPAD_CATALOG: readonly LaunchpadAppEntry[] = [
  { id: 'b3', name: 'Bam', description: 'Project Management', icon_name: 'layout-dashboard', color: '#2563eb', path: '/b3/' },
  { id: 'banter', name: 'Banter', description: 'Team Messaging', icon_name: 'message-circle', color: '#7c3aed', path: '/banter/' },
  { id: 'beacon', name: 'Beacon', description: 'Knowledge Base', icon_name: 'book-open', color: '#059669', path: '/beacon/' },
  { id: 'bond', name: 'Bond', description: 'CRM', icon_name: 'handshake', color: '#0891b2', path: '/bond/' },
  { id: 'blast', name: 'Blast', description: 'Email Campaigns', icon_name: 'mail', color: '#dc2626', path: '/blast/' },
  { id: 'bill', name: 'Bill', description: 'Invoicing & Billing', icon_name: 'dollar-sign', color: '#16a34a', path: '/bill/' },
  { id: 'blank', name: 'Blank', description: 'Forms & Surveys', icon_name: 'clipboard-list', color: '#7c3aed', path: '/blank/' },
  { id: 'book', name: 'Book', description: 'Scheduling & Calendar', icon_name: 'calendar', color: '#2563eb', path: '/book/' },
  { id: 'bench', name: 'Bench', description: 'Analytics', icon_name: 'bar-chart-3', color: '#2563eb', path: '/bench/' },
  { id: 'brief', name: 'Brief', description: 'Documents', icon_name: 'file-text', color: '#d97706', path: '/brief/' },
  { id: 'bolt', name: 'Bolt', description: 'Automations', icon_name: 'zap', color: '#dc2626', path: '/bolt/' },
  { id: 'bearing', name: 'Bearing', description: 'Goals & OKRs', icon_name: 'target', color: '#0d9488', path: '/bearing/' },
  { id: 'board', name: 'Board', description: 'Whiteboards', icon_name: 'pen-tool', color: '#6366f1', path: '/board/' },
  { id: 'blueprint', name: 'Blueprint', description: 'Diagrams & Flows', icon_name: 'sparkles', color: '#0ea5e9', path: '/blueprint/' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support', icon_name: 'headset', color: '#be123c', path: '/helpdesk/' },
];

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
    { preHandler: [requireAuth, fastify.requireCan('bam.system_setting.list')] },
    async () => {
      const rows = await db.select().from(systemSettings);
      return { data: rows };
    },
  );

  // ─── GET /system-settings/:key — read a single setting (authenticated) ─
  fastify.get<{ Params: { key: string } }>(
    '/system-settings/:key',
    { preHandler: [requireAuth, shadowOnly('bam.system_setting.get')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.system_setting.update')] },
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
