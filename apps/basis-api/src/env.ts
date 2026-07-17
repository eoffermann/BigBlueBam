import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4019),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Internal service URLs. Basis reaches Bench's governed query builder
  // server-to-server (spec 4.1) and the platform llm-provider for narratives.
  MCP_INTERNAL_URL: z.string().default('http://mcp-server:3001'),
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BENCH_API_INTERNAL_URL: z.string().default('http://bench-api:4011'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  // Must be non-empty for the Bench internal query route + narrative path to
  // work; empty correctly fails closed (spec 4.1, 8.1).
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Query + explanation execution settings.
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  EXPLANATION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // Per-action permission enforcement (mirrors bench-api). 'warn' records
  // divergence; 'on' blocks on resolver-deny.
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
