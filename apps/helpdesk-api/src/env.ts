import { z } from 'zod';
import { envBool } from '@bigbluebam/shared';

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

  // BBB_E2E_PERMISSIVE_RATE_LIMIT / RATE_LIMIT_E2E_MULTIPLIER are read (and refused at boot
  // when malformed) by registerGlobalRateLimit in @bigbluebam/service-health (#411).

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
  // No default credentials (issue #176): without them storage is "not configured"
  // and storage-backed routes answer 503 STORAGE_NOT_CONFIGURED.
  S3_ACCESS_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  S3_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  COOKIE_DOMAIN: z.string().optional(),
  // The shared envBool (#251) so COOKIE_SECURE=false actually turns the Secure flag off for an
  // HTTP-only deployment. See apps/api/src/env.ts for the incident.
  COOKIE_SECURE: envBool(false),

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
