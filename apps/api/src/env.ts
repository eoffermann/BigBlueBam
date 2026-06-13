import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800), // 7 days

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // BAM-RL-E2E: When set to a truthy value (or when NODE_ENV !== 'production'),
  // the global rate limiter ceiling is multiplied by RATE_LIMIT_E2E_MULTIPLIER
  // (default 100x). This unblocks parallel Playwright workers without disabling
  // brute-force protection in production. The flag must be explicitly set on
  // any container running with NODE_ENV=production for it to take effect, so
  // production deployments stay strict by default.
  BBB_E2E_PERMISSIVE_RATE_LIMIT: z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.coerce.boolean().optional(),
  ),
  RATE_LIMIT_E2E_MULTIPLIER: z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.coerce.number().int().positive().default(100),
  ),

  // HB-57: per-email account lockout after repeated failed logins.
  LOGIN_LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  UPLOAD_MAX_FILE_SIZE: z.coerce.number().int().positive().default(26214400), // 25MB
  UPLOAD_ALLOWED_TYPES: z.string().default('image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt'),

  // S3 / MinIO
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  COOKIE_DOMAIN: z.string().optional(),
  // z.coerce.boolean() runs JS Boolean() which is `true` for ANY non-empty
  // string — including the string 'false'. That bit us when operators set
  // COOKIE_SECURE=false in .env to disable the Secure flag for HTTP-only
  // local-network deploys: the cookie still went out with Secure, the
  // browser silently dropped it, and every page reload bounced through
  // /login. Parse the strings ourselves so 'false' / '0' actually mean
  // false; '' / undefined falls through to the NODE_ENV-based default.
  COOKIE_SECURE: z.preprocess(
    (val) => {
      if (val === '' || val === undefined) return undefined;
      if (typeof val === 'string') {
        const v = val.toLowerCase();
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
      }
      return val;
    },
    z.boolean().optional(),
  ),

  // SMTP / email (P1-30). Optional — if SMTP_HOST is unset, outbound emails
  // are logged by the worker instead of delivered. The API enqueues jobs to
  // the shared `email` BullMQ queue; the worker owns actual delivery.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Canonical SMTP from-address env fallback — same name every service and the
  // shared @bigbluebam/smtp-resolver use. The UI → system_settings.smtp_from
  // overrides it. (Renamed from SMTP_FROM to kill the 4-name sprawl.)
  EMAIL_FROM: z.string().default('noreply@bigbluebam.com'),

  // Public URL used to build invitation acceptance links in emails.
  FRONTEND_URL: z.string().default('http://localhost/b3'),

  // HB-7: Shared secret used by helpdesk-api to authenticate to the
  // /internal/helpdesk/* surface. Must be at least 32 chars. Both apps
  // must receive the same value.
  INTERNAL_HELPDESK_SECRET: z.string().min(32),

  // Internal service-to-service authentication
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  // Bolt workflow automation engine URL (fire-and-forget event publishing)
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),

  // Helpdesk API internal URL for agent queue proxy
  HELPDESK_API_INTERNAL_URL: z.string().default('http://helpdesk-api:4001'),

  // Per-action permissions enforcement mode (Wave A foundation in this PR).
  //   off  — plugin loads but every requireCan() check no-ops to ALLOW.
  //          Day-1 default; behavior is identical to the legacy role gate.
  //   warn — dual-read: legacy gate decides, new resolver runs alongside
  //          and divergences land in permissions.divergence telemetry.
  //          Wave B uses this for at-least-14-day soak.
  //   on   — new resolver is authoritative; route handlers enforce via
  //          requireCan(permission_id). Wave C target.
  // See docs/permissions-overhaul-plan.md for the rollout sequence.
  BBB_PERMISSIONS_ENFORCE: z.enum(['off', 'warn', 'on']).default('off'),
}).transform((data) => ({
  ...data,
  // BAM-010: Default COOKIE_SECURE to true in production when not explicitly set
  COOKIE_SECURE: data.COOKIE_SECURE ?? data.NODE_ENV === 'production',
}));

export type Env = z.output<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    console.error('Invalid environment variables:', JSON.stringify(formatted, null, 2));
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
