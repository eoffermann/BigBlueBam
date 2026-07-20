import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4023),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Internal service URLs (spec 18.3).
  //
  // BILL_API_INTERNAL_URL is deliberately ABSENT: the enforcing spend gate is cut from v1
  // (spec section 9), so there is no bill-api call site and adding the variable would be
  // dead configuration that reads as a wired integration.
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  BRAID_API_INTERNAL_URL: z.string().default('http://braid-api:4020'),

  // REQUIRED, not optional. Both the /v1/internal/* transport and every outbound call to
  // apps/api's /internal/permissions/dual-read carry it; an empty secret makes the internal
  // routes fail closed and makes every permission decision unresolvable.
  INTERNAL_SERVICE_SECRET: z.string().min(32),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Bounded, inert document parsing (spec 5.4). Default 20MB, deliberately BELOW nginx's
  // server-level client_max_body_size (25m / 26_214_400) so an over-limit file yields Bursar's
  // "this file is larger than 20MB" 413 rather than a bare nginx 413. The global nginx limit is
  // NOT raised for one app's worst case.
  MAX_DOC_BYTES: z.coerce.number().int().positive().default(20_971_520),
  MAX_DOC_PAGES: z.coerce.number().int().positive().default(300),

  // Per-call LLM deadline, and the deadline for the START call of an async engine run.
  // BURSAR_ENGINE_TIMEOUT_MS bounds only the 202-returning start leg (spec 18.6a): the
  // leveling and derivation engines proceed in bounded slices under a lease, so this is
  // never the deadline for the work itself.
  BURSAR_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  BURSAR_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // Deadline for the request-path internal round trips: the permission dual-read (viewer
  // caps / financial flooring), the Braid resolve, and the Bin asset access preflight. These
  // are short synchronous calls in front of a route handler, NOT the LLM/engine work, so the
  // budget is small and independent of BURSAR_LLM_TIMEOUT_MS.
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // NOTE: BBB_PERMISSIONS_ENFORCE is deliberately ABSENT from this schema. Bursar's
  // per-action enforcement is a hardcoded boot invariant, not an env-driven setting
  // (spec 13.3, and burn issue #83: ENV_HINTS is a flat global map with no per-service
  // override, so a satellite cannot be given a different value than the other services).

  // Platform RLS posture. Bursar binds the app.current_org_id GUC per request regardless
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
