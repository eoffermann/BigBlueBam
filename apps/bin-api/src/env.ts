import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4016),
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
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  PUBLIC_URL: z.string().default('http://localhost'),

  // MinIO/S3 object storage. Bin is the suite's storage backbone; in this
  // DAM-core slice it uses the bootstrap `local` driver built from these
  // S3_* vars (Bin master §15). Per-org provider bindings are a later slice.
  // Bin objects are namespaced under the `bin/` key prefix (buildStorageKey).
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  // Max object size per upload (default 25MB, matches the suite floor; raised
  // per binding for media-heavy orgs in a later slice). Bin master §9.3.
  UPLOAD_MAX_FILE_SIZE: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  // Envelope-encryption master key for provider secrets (Bin master §15).
  // Required in prod; defaulted in dev so the DAM-core slice boots on a bare
  // stack. Provider-secret encryption lands with the multi-provider slice.
  BIN_SECRETS_KEY: z.string().default('dev-bin-secrets-key-change-me-0000000000'),
  BIN_SECRETS_KEY_ID: z.string().default('local-1'),

  // Presigned URL TTLs (seconds).
  PRESIGN_PUT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Platform default for "may a user work with a file before its AV scan
  // completes?". This is the lowest-precedence layer: an org override
  // (organizations.settings.av.allow_unscanned_access) and the platform
  // system_settings['av.allow_unscanned_access'] both win over it. Default
  // off — serving is gated until the scan clears unless someone opts in.
  BIN_ALLOW_UNSCANNED_ACCESS: z.coerce.boolean().default(false),

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
