import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4017),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
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
  // Bay federates on top of Bin for canonical bytes (Bay master). Asset
  // versions reference Bin assets/versions; the actual byte fetch/presign is
  // brokered through Bin's API rather than re-implementing storage here.
  BIN_API_INTERNAL_URL: z.string().default('http://bin-api:4016'),
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  // Object store (shared bucket). Bay streams the canonical bytes itself for
  // the public guest-review surface (the authenticated player still goes
  // through Bin's /raw proxy). Mirrors the bin-api S3_* defaults so both read
  // the same MinIO/S3 with the same keys.
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  PUBLIC_URL: z.string().default('http://localhost'),

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
