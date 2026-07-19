import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4022),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Per-asker rate limit knobs (spec 2.4 point 10: usr: prechecks are capped
  // per user and per org so a member cannot manufacture a calibration sample).
  ASKER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  ASKER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Internal service URLs (spec 9.1). BILL_API_INTERNAL_URL is REQUIRED: Burn has no
  // cost/bill rate resolver of its own for the billable side and delegates to bill-api's
  // POST /internal/rates/resolve (spec 2.3.1.2). The remainder are optional-with-defaults.
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  BILL_API_INTERNAL_URL: z.string().min(1),
  BRAID_API_INTERNAL_URL: z.string().default('http://braid-api:4020'),
  QDRANT_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  QDRANT_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // REQUIRED, not optional (issue #89). Two things depend on it and both fail unsafely
  // when it is absent:
  //   1. /v1/internal/* fails CLOSED on an empty secret (spec 2.4 point 16), rejecting
  //      401 before any timing-safe compare.
  //   2. Every outbound POST to apps/api's /internal/permissions/dual-read carries it.
  //      Since cede5e2e apps/api rejects an empty secret with a non-2xx, which the
  //      permissions plugin reads as an unresolvable decision. Burn runs that plugin
  //      with onUnknown: 'deny', so a missing secret would 403 every gated route.
  // Burn cannot function correctly without it either way, so it refuses to boot rather
  // than start in a degraded posture, exactly like BILL_API_INTERNAL_URL above.
  INTERNAL_SERVICE_SECRET: z.string().min(32),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Bounded, inert document parsing (spec 2.4 point 15).
  MAX_DOC_BYTES: z.coerce.number().int().positive().default(26_214_400),
  MAX_DOC_PAGES: z.coerce.number().int().positive().default(300),

  // NOTE: BBB_PERMISSIONS_ENFORCE is deliberately ABSENT from this schema. Burn's
  // per-action enforcement is an invariant, not a setting: it is hardcoded to 'on' at the
  // plugin registration site in server.ts. See ./boot/assert-permissions-enforce.ts.

  // Platform RLS posture. Burn binds the app.current_org_id GUC per request regardless
  // (see plugins/rls.ts); this flag only controls whether a binding failure is fatal.
  BBB_RLS_ENFORCE: z.string().optional(),
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
