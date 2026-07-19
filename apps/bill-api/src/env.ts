import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4014),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Internal service URLs
  MCP_INTERNAL_URL: z.string().default('http://mcp-server:3001'),
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  // ── Burn pre-transaction spend gate (Burn spec 5.5.1, 9.2) ──────────────
  // OPTIONAL BY DESIGN. Unset means the gate is absent and every expense posts
  // normally; the client still increments burn:gate_calls so the absence reads
  // as 0 percent coverage rather than a clean 0/0 console (5.5.2).
  BURN_API_INTERNAL_URL: z.string().optional(),
  // The AUTHORITATIVE client deadline. Deliberately a bill-api-side constant and
  // NOT burn_org_settings.precheck_budget_ms: a timeout budget stored in the
  // service it is meant to bound cannot be read when that service is down.
  // burn-api's precheck_budget_ms is a server-side compute budget only, and is
  // CHECK-clamped to [100, 750], strictly below this default.
  BURN_PRECHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(800),
  // Consecutive timeouts or 5xx before the breaker opens.
  BURN_PRECHECK_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  // Half-open probe interval, and the minimum spacing between probes of a
  // recovering burn-api across ALL bill-api replicas (NX election, 5.5.1).
  BURN_PRECHECK_BREAKER_PROBE_MS: z.coerce.number().int().positive().default(30000),

  PUBLIC_URL: z.string().default('http://localhost'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // MinIO
  MINIO_ENDPOINT: z.string().default('minio:9000'),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),

  // Wave D Phase 3: per-action permission enforcement. Mirrors the api's
  // BBB_PERMISSIONS_ENFORCE. 'warn' calls the resolver and records
  // divergence; 'on' additionally blocks on resolver-deny.
  BBB_PERMISSIONS_ENFORCE: z.enum(['off', 'warn', 'on']).default('warn'),
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
