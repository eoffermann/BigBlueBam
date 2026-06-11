import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86400), // 1 day (helpdesk customers are higher-risk: unverified email, global pool)

  HELPDESK_URL: z.string().default('http://localhost:8080'),

  CORS_ORIGIN: z.string().default('http://localhost:8080'),

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

  // SMTP (optional — emails disabled when not set)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@bigbluebam.io'),

  // S3 / MinIO
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  COOKIE_DOMAIN: z.string().optional(),
  // z.coerce.boolean() runs JS Boolean() which is `true` for any non-empty
  // string — including 'false'. Parse the env string explicitly so the
  // Secure flag actually flips off when an operator sets COOKIE_SECURE=false
  // for an HTTP-only deployment. See apps/api/src/env.ts for context.
  COOKIE_SECURE: z.preprocess(
    (val) => {
      if (val === '' || val === undefined) return false;
      if (typeof val === 'string') {
        const v = val.toLowerCase();
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
      }
      return val;
    },
    z.boolean().default(false),
  ),

  // HB-7: URL + shared secret for Bam's /internal/helpdesk/* surface. All
  // Bam-side writes (tasks, comments, phase transitions) go through these
  // endpoints instead of direct SQL against the Bam tables.
  BBB_API_INTERNAL_URL: z.string().url().default('http://api:4000'),
  INTERNAL_HELPDESK_SECRET: z.string().min(32),
  // Shared internal secret for forwarding 5xx events to the api's
  // /internal/system-errors/record endpoint. Optional — when unset, the
  // recorder is simply not wired, so the satellite still works in
  // isolation.
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),
});

export type Env = z.infer<typeof envSchema>;

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
