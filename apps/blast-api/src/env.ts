import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4010),
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
  BOND_API_INTERNAL_URL: z.string().default('http://bond-api:4009'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  // SMTP configuration for sending emails
  // NOTE: blast-api sends no email itself — the worker (blast-send.job.ts)
  // does, via the shared SMTP resolver. blast-api previously declared a dead
  // SMTP_HOST/PORT/USER/PASS/SMTP_FROM_EMAIL/SMTP_FROM_NAME block that nothing
  // read; removed to kill the from-address sprawl flagged in review.

  // Tracking base URL (public-facing URL for tracking pixels and click redirects)
  TRACKING_BASE_URL: z.string().default('http://localhost'),

  // Webhook authentication secret — if set, inbound webhook requests must
  // include a matching X-Webhook-Secret header. Optional for backward compat.
  BLAST_WEBHOOK_SECRET: z.string().min(16).optional(),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

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
