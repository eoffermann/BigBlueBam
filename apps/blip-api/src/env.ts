import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4018),
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
  // Blip freezes filtered collections into Bin JSONL assets and stores compiled
  // timelapse videos as Bin assets; the worker brokers those through Bin's API.
  BIN_API_INTERNAL_URL: z.string().default('http://bin-api:4016'),
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  // Object store (shared bucket). Blip offloads capture images + thumbnails to
  // the same MinIO/S3 the rest of the suite uses, through @bigbluebam/storage.
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  // HMAC pepper for verifying ingest-key secrets on the hot path. Distinct from
  // SESSION_SECRET; ingest keys are low-trust embedded credentials (Blip §10).
  BLIP_INGEST_PEPPER: z.string().min(16).default('blip-dev-ingest-pepper-change-me'),

  // Ingest defaults (Blip §11.1). Overridable per tracked-app / per-key.
  BLIP_MAX_BODY_BYTES: z.coerce.number().int().positive().default(262144),
  BLIP_MAX_CAPTURE_BODY_BYTES: z.coerce.number().int().positive().default(4194304),
  BLIP_MAX_BATCH_COUNT: z.coerce.number().int().positive().default(500),

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
