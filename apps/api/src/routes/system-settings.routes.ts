import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { requireAuth } from '../plugins/auth.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import { isBootstrapRequired } from '../services/bootstrap-status.service.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { validateExternalUrl } from '../lib/url-validator.js';
import nodemailer from 'nodemailer';
import { inArray } from 'drizzle-orm';
import {
  SMTP_SETTING_KEYS,
  clearSmtpConfigCache,
  resolveSmtpFromSettings,
} from '@bigbluebam/smtp-resolver';
import { env } from '../env.js';
import {
  clearPolicyCache,
  generatePasswordFromPolicy,
  normalizePolicy,
} from '../services/password-generator.service.js';

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
  'bin',
  'bay',
  'blip',
  'helpdesk',
  'bureau',
  'basis',
  'braid',
  'bulwark',
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
  { id: 'bin', name: 'Bin', description: 'Files & Structured Data', icon_name: 'database', color: '#0369a1', path: '/bin/' },
  { id: 'bay', name: 'Bay', description: 'Media Review & Approval', icon_name: 'clapperboard', color: '#db2777', path: '/bay/' },
  { id: 'blip', name: 'Blip', description: 'Telemetry & Logs', icon_name: 'activity', color: '#0891b2', path: '/blip/' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support', icon_name: 'headset', color: '#be123c', path: '/helpdesk/' },
  { id: 'bureau', name: 'Bureau', description: 'Virtual Office', icon_name: 'building', color: '#475569', path: '/bureau/' },
  { id: 'basis', name: 'Basis', description: 'Metric Layer', icon_name: 'ruler', color: '#4f46e5', path: '/basis/' },
  { id: 'braid', name: 'Braid', description: 'Customer Identity', icon_name: 'git-merge', color: '#4338ca', path: '/braid/' },
  { id: 'bulwark', name: 'Bulwark', description: 'Contract Obligations', icon_name: 'shield-check', color: '#1d4ed8', path: '/bulwark/' },
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
// Helper: SSRF-guarded URL validator that surfaces the reason as a Zod issue.
const externalUrlSchema = (max = 2048) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (val) => validateExternalUrl(val).safe === true,
      (val) => {
        const r = validateExternalUrl(val);
        return {
          message: r.safe ? 'OK' : `Unsafe URL: ${r.reason}`,
        };
      },
    );

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
      const n = Number.parseInt(v, 10);
      return n >= 1 && n <= 65535;
    }, 'smtp_port must be an integer between 1 and 65535'),
  ]),
  smtp_user: z.string().min(1).max(255),
  smtp_password: z.string().min(1).max(512),
  smtp_from: z.string().email(),
  smtp_secure: z.boolean(),

  // ── Platform calling (LiveKit + voice agent) ─────────────────────────
  // Values written here override the env-var defaults read by
  // banter-api / board-api / voice-agent. The frontend SuperUser
  // settings page (apps/frontend/src/pages/superuser/
  // platform-calling-settings.tsx) drives them.
  //
  // Secret keys (api_key / api_secret) are MASKED on read — see the
  // GET handler below. The frontend renders the masked value as
  // read-only and forces the SuperUser into an explicit "rotate" mode
  // before sending a new value.
  'calling.livekit_host': externalUrlSchema(2048),
  'calling.livekit_api_key': z.string().min(4).max(256),
  'calling.livekit_api_secret': z.string().min(16).max(512),
  'calling.voice_agent_url': externalUrlSchema(2048),
  'calling.global_enabled': z.boolean(),

  // ── AV / virus scanning (SuperUser only) ─────────────────────────────
  // Read by the worker's bin-av-scan job via apps/worker/src/utils/
  // av-config.ts (system_settings first, env vars as fallback). Changing a
  // value here takes effect within the resolver's ~30s cache TTL without a
  // worker restart. av.allow_unscanned_access is the PLATFORM DEFAULT for
  // "may a user work with a file before its AV scan completes?"; a per-org
  // override (organizations.settings.av.allow_unscanned_access) wins over it.
  'av.scan_mode': z.enum(['off', 'eicar', 'clamav']),
  'av.clamav_host': z.union([z.null(), z.string().min(1).max(255)]),
  'av.clamav_port': z.union([
    z.number().int().min(1).max(65535),
    z.string().regex(/^\d+$/).refine((v) => {
      const n = Number.parseInt(v, 10);
      return n >= 1 && n <= 65535;
    }, 'av.clamav_port must be an integer between 1 and 65535'),
  ]),
  'av.allow_unscanned_access': z.boolean(),

  // ── Password generation policy (SuperUser only) ──────────────────────
  // Controls every server-side password mint: admin-issued password
  // resets, CLI reset-password, future flows. The full default + clamps
  // live in services/password-generator.service.ts. We accept any object
  // shape here and let normalizePolicy() do the clamping at read time —
  // the only thing this validator must reject is non-object junk and
  // illegal modes, so that invariant is never crossed at the storage
  // layer.
  password_policy: z.object({
    mode: z.enum(['alphanumeric', 'passphrase']).optional(),
    alphanumeric: z
      .object({ length: z.number().int().min(12).max(64).optional() })
      .optional(),
    passphrase: z
      .object({
        word_count: z.number().int().min(3).max(8).optional(),
        separator: z.string().max(3).optional(),
        capitalize_words: z.boolean().optional(),
        digit_count: z.number().int().min(0).max(4).optional(),
        append_symbol: z.boolean().optional(),
      })
      .optional(),
  }),
};

// Keys whose stored value is a secret and must be masked on every read.
// The frontend uses the masked value as a display-only placeholder until
// the operator explicitly enters "rotate" mode.
const SECRET_KEYS = new Set<string>([
  'smtp_password',
  'calling.livekit_api_key',
  'calling.livekit_api_secret',
]);

/**
 * Translate the most common nodemailer/openssl errors into actionable
 * one-line hints. Operators don't read OpenSSL traceback lines; they
 * read the line at the top of the error card. So the test endpoint
 * gives one back tailored to the symptom + the resolved config.
 */
function smtpErrorHint(
  err: Error & { code?: string },
  cfg: { host: string; port: number; secure: boolean },
): string | null {
  const msg = err.message ?? '';
  const code = err.code ?? '';

  // OpenSSL "wrong version number" — the canonical TLS / STARTTLS mismatch.
  if (/wrong version number/i.test(msg)) {
    if (cfg.secure) {
      return (
        `Set "Use TLS (secure)" OFF for port ${cfg.port}. SSL was attempted ` +
        `against a STARTTLS port; the server replied in plaintext so the ` +
        `handshake failed. Port 465 is the only port that wants TLS on; ` +
        `587 and 25 want it off (nodemailer auto-issues STARTTLS).`
      );
    }
    return (
      `Set "Use TLS (secure)" ON for port ${cfg.port}. Plain SMTP was ` +
      `attempted against an SSL-only port (port 465 expects TLS from the ` +
      `first byte). Either turn TLS on, or change the port to 587.`
    );
  }

  // Common DNS/connectivity failures.
  if (/EBADNAME|ENOTFOUND/i.test(msg) || code === 'EDNS') {
    return (
      `Host "${cfg.host}" doesn't resolve. Check for typos or stray quote ` +
      `characters in the SMTP Host field, and confirm the worker container ` +
      `has DNS access to the provider.`
    );
  }
  if (code === 'ECONNREFUSED') {
    return (
      `Nothing is listening on ${cfg.host}:${cfg.port}. Verify the port ` +
      `(465 for SSL, 587 for STARTTLS) and that any provider-side IP ` +
      `restrictions allow this deployment's outbound IP.`
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ETIME') {
    return (
      `Connection to ${cfg.host}:${cfg.port} timed out. The provider may be ` +
      `blocking outbound SMTP from this network, or a firewall is in the ` +
      `way. Try port 587 instead of 25 if your network blocks legacy SMTP.`
    );
  }

  // Auth.
  if (code === 'EAUTH' || /authentication|535|invalid login|535-/i.test(msg)) {
    return (
      `Authentication rejected. Re-check the SMTP username (often the full ` +
      `email address) and password. Many providers require an "app password" ` +
      `or "API key" rather than the normal account password.`
    );
  }

  return null;
}

// Show only the trailing characters of a stored secret. `last` controls
// how many chars of the raw value leak through (4 for the LiveKit api
// secret per the task spec; 0 for everything else, which prints a pure
// placeholder).
function maskSecret(raw: unknown, last: number): string {
  if (raw == null) return '';
  const str = typeof raw === 'string' ? raw : String(raw);
  if (str.length === 0) return '';
  if (last <= 0 || str.length <= last) return '••••••••';
  return '••••••••' + str.slice(-last);
}

function maskedValueFor(key: string, raw: unknown): unknown {
  if (!SECRET_KEYS.has(key)) return raw;
  // LiveKit secret: show last 4 per the task spec. Everything else: full mask.
  const last = key === 'calling.livekit_api_secret' ? 4 : 0;
  return maskSecret(raw, last);
}

export default async function systemSettingsRoutes(fastify: FastifyInstance) {
  // ─── GET /system-settings — list all settings (SuperUser only) ────────
  fastify.get(
    '/system-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.system_setting.list')] },
    async () => {
      const rows = await db.select().from(systemSettings);
      // Mask secret values before returning. Even SuperUsers should not
      // get raw secrets back over the wire on a list request — they can
      // re-enter the value via the rotate flow if they need to change it.
      const safe = rows.map((row) => ({
        ...row,
        value: maskedValueFor(row.key, row.value),
        is_secret: SECRET_KEYS.has(row.key),
      }));
      return { data: safe };
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

      const safe = SECRET_KEYS.has(row.key)
        ? { ...row, value: maskedValueFor(row.key, row.value), is_secret: true }
        : { ...row, is_secret: false };
      return { data: safe };
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

      // The password generator caches the policy in-process for 15s. When
      // a SuperUser flips the setting, invalidate so the next mint sees
      // the new value immediately rather than at the next cache expiry.
      if (key === 'password_policy') clearPolicyCache();
      // Same idea for SMTP: the resolver caches for 30s. After a write
      // here, the next `isSmtpConfigured()` call should see the change
      // immediately so the people-invite UI stops reporting "not
      // configured" the moment the operator hits Save.
      if (key.startsWith('smtp_')) clearSmtpConfigCache();

      // Upsert the setting. Pass the value directly — drizzle / postgres-js
      // already encodes JS primitives and objects for the JSONB column.
      // The previous `JSON.stringify` pre-encode was the cause of the 2026-
      // 06-11 hostname-with-embedded-quotes incident: every row got stored
      // as a JSON string containing the JSON-encoded text (strings gained
      // embedded quotes, numbers/booleans became strings-of-themselves,
      // objects became strings-of-JSON). Migration 0182 unwraps the
      // pre-existing rows so the storage shape is consistent now.
      await db
        .insert(systemSettings)
        .values({
          key,
          value: bodyParsed.data.value,
          updated_by: userId,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: bodyParsed.data.value,
            updated_by: userId,
            updated_at: now,
          },
        });

      // Never write raw secrets into the audit log — store a masked
      // form so the audit trail proves a rotation happened without
      // leaking the new value back in plaintext.
      const auditValue = SECRET_KEYS.has(key)
        ? maskedValueFor(key, bodyParsed.data.value)
        : bodyParsed.data.value;
      await logSuperuserAction({
        superuserId: userId,
        action: 'update_system_setting',
        details: { key, value: auditValue },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });

      // Return the updated row. Mask secrets on the way back out so the
      // PUT response doesn't echo the raw value we just stored.
      const [updated] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      if (!updated) {
        // Unreachable in practice (we just inserted), but keeps the type
        // checker happy without an unsafe assertion.
        return { data: null };
      }

      const safe = SECRET_KEYS.has(updated.key)
        ? { ...updated, value: maskedValueFor(updated.key, updated.value), is_secret: true }
        : { ...updated, is_secret: false };
      return { data: safe };
    },
  );

  // ─── POST /system-settings/smtp/test ──────────────────────────────────
  // Verifies SMTP settings actually work. Two modes:
  //   - No `to` field   → just verifies the transport can authenticate
  //                       and complete a TLS handshake. Returns ok/error.
  //   - `to` provided   → also sends a short test message to that address
  //                       so the operator can confirm end-to-end delivery
  //                       (inbox arrival, spam filter, From-address
  //                       header rejection, etc.).
  //
  // Reads the current effective config exactly the way the worker would,
  // so a green result here is a real promise that the next invitation
  // will land. If the operator just edited the SuperUser form, the cache
  // has already been cleared by the PUT handler above.
  fastify.post(
    '/system-settings/smtp/test',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.system_setting.update'),
      ],
    },
    async (request, reply) => {
      const bodySchema = z.object({
        to: z.string().email().max(320).optional(),
      });
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Body validation failed',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const { to } = parsed.data;

      // Load smtp_* rows the same way the runtime resolver does so the
      // test exercises the exact precedence the worker will see.
      const rows = await db
        .select({ key: systemSettings.key, value: systemSettings.value })
        .from(systemSettings)
        .where(inArray(systemSettings.key, [...SMTP_SETTING_KEYS]));
      const settings: Record<string, unknown> = {};
      for (const r of rows) settings[r.key] = r.value;
      const cfg = resolveSmtpFromSettings(settings, {
        SMTP_HOST: env.SMTP_HOST,
        SMTP_PORT: env.SMTP_PORT,
        SMTP_USER: env.SMTP_USER,
        SMTP_PASS: env.SMTP_PASS,
        EMAIL_FROM: env.EMAIL_FROM,
      });

      if (!cfg) {
        return reply.status(400).send({
          data: {
            ok: false,
            stage: 'config',
            error:
              'No SMTP host configured (neither system_settings nor env vars). Set SMTP Host in the form above and save before testing.',
          },
        });
      }

      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
        // Force a tight timeout so a wrong host doesn't hang the request.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });

      // Phase 1: verify connection + auth.
      try {
        await transport.verify();
      } catch (err) {
        const e = err as Error & { code?: string };
        const hint = smtpErrorHint(e, cfg);
        request.log.warn({ err: e, stage: 'verify', cfg_source: cfg.source }, 'SMTP test failed (verify)');
        return reply.send({
          data: {
            ok: false,
            stage: 'verify',
            error_code: e.code ?? null,
            error: e.message,
            hint,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, source: cfg.source },
          },
        });
      }

      // Phase 2: optional send.
      if (!to) {
        return reply.send({
          data: {
            ok: true,
            stage: 'verify',
            message: `Connected to ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS' : 'STARTTLS'}) successfully.`,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, source: cfg.source },
          },
        });
      }
      try {
        const info = await transport.sendMail({
          from: cfg.from,
          to,
          subject: 'BigBlueBam SMTP test',
          text:
            'This is a test message sent by the BigBlueBam SuperUser → Platform → SMTP test button. ' +
            'If you received it, your SMTP relay is configured correctly.\n',
        });
        return reply.send({
          data: {
            ok: true,
            stage: 'send',
            message: `Test email accepted by ${cfg.host} for delivery to ${to}. Message id: ${info.messageId}`,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, source: cfg.source },
          },
        });
      } catch (err) {
        const e = err as Error & { code?: string; response?: string };
        const hint = smtpErrorHint(e, cfg);
        request.log.warn({ err: e, stage: 'send', cfg_source: cfg.source }, 'SMTP test failed (send)');
        return reply.send({
          data: {
            ok: false,
            stage: 'send',
            error_code: e.code ?? null,
            error: e.message,
            server_response: e.response ?? null,
            hint,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, source: cfg.source },
          },
        });
      } finally {
        // nodemailer transports are pool-less by default, but explicitly
        // closing keeps the FD count tidy under repeated test clicks.
        transport.close();
      }
    },
  );

  // ─── POST /system-settings/password_policy/preview ─────────────────────
  // Generates N sample passwords against a DRAFT policy without
  // persisting it. The frontend uses this so a SuperUser can see what
  // their settings will produce before saving. Reuses normalizePolicy()
  // so the preview clamps the same way the live generator will, no
  // matter what the form sends.
  fastify.post(
    '/system-settings/password_policy/preview',
    { preHandler: [requireAuth, fastify.requireCan('bam.system_setting.update')] },
    async (request, reply) => {
      const bodySchema = z.object({
        policy: z.unknown(),
        count: z.number().int().min(1).max(10).optional(),
      });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Body must contain { policy, count? }',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const policy = normalizePolicy(parsed.data.policy);
      const count = parsed.data.count ?? 5;
      const samples: string[] = [];
      for (let i = 0; i < count; i++) samples.push(generatePasswordFromPolicy(policy));
      return { data: { policy, samples } };
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
