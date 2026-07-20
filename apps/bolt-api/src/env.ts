import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4006),
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
  // Bulwark ingest target (spec §6). bolt-api forwards gate-admitted events here so Bulwark's
  // durable inbox can fire against armed obligations.
  BULWARK_API_INTERNAL_URL: z.string().default('http://bulwark-api:4021'),
  // Burn ingest target (spec §8.3). bolt-api forwards the 16 subscribed events here so Burn's
  // durable inbox (/v1/internal/events) materializes work items and runs attribution.
  BURN_API_INTERNAL_URL: z.string().default('http://burn-api:4022'),
  // Bursar ingest target (spec 16.2). bolt-api forwards the 3 subscribed bill/braid events here so
  // Bursar's durable inbox (/v1/internal/events) ingests spend and re-points braid_profile_id.
  BURSAR_API_INTERNAL_URL: z.string().default('http://bursar-api:4023'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Internal service-to-service secret (shared with other BigBlueBam services)
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

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
