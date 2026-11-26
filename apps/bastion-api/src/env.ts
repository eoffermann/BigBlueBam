import { LLM_CALL_TIMEOUT_DEFAULT_MS, LLM_CALL_TIMEOUT_MAX_MS, LLM_CALL_TIMEOUT_MIN_MS, LLM_HOLD_MARGIN_MS } from '@bigbluebam/shared';
import { z } from 'zod';
import { checkStableSecrets, formatStableSecretRefusal } from './boot/stable-secrets.js';
import { COMPILE_MAX_TOKENS_DEFAULT } from './library/compile-budget.js';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4024),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Request-time dependencies only (never in depends_on).
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),

  // REQUIRED: the /v1/internal/* transport and every outbound permission dual-read carry it.
  INTERNAL_SERVICE_SECRET: z.string().min(32),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Spec 5.2: the number of proxies in front of bastion-api whose X-Forwarded-For entries are
  // trusted. Compose 1 (nginx), Railway 2. Never `true`.
  BASTION_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  // Own bucket (spec 3.3 / 9.1). The S3 credentials are optional: without them bastion-api
  // starts and evidence writes report that storage is not set up.
  BASTION_S3_BUCKET: z.string().min(3).default('bigbluebam-bastion'),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_REGION: z.string().default('us-east-1'),
  // The shared uploads bucket Bin writes to (spec 3.3, M5). Read-only for Bastion: it streams the
  // pinned Bin version's bytes from here into its own bucket at attach. Same credentials.
  S3_BUCKET: z.string().min(3).default('bigbluebam-uploads'),

  // Off-site evidence backup (spec 9.7, M9). All optional; unset disables the mirror.
  BASTION_BACKUP_S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  BASTION_BACKUP_S3_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  BASTION_BACKUP_S3_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  BASTION_BACKUP_S3_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  // Stable secrets (spec 9.4). Presence and shape are checked BEFORE this schema by
  // checkStableSecrets so the refusal is a plain sentence, not a zod dump.
  BASTION_SEAL_SIGNING_KEY: z.string().length(64),
  BASTION_PD_HMAC_KEY: z.string().length(64),
  BASTION_ROOM_IP_SALT: z.string().length(64),
  BASTION_FEED_KEY_PEPPER: z.string().length(64),

  // Public keys of seal signing keys that were replaced (spec 3.4: GET /ledger/seals publishes
  // every signing_key_id, so seals signed before a key change stay verifiable). Comma-separated
  // 64-hex raw Ed25519 public keys; the key id is derived from each. Optional.
  BASTION_SEAL_RETIRED_PUBLIC_KEYS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}(,[0-9a-fA-F]{64})*$/, 'comma-separated 64-hex Ed25519 public keys')
      .optional(),
  ),

  // Time budgets (spec 7.3).
  // One AI call's deadline, sent to the platform proxy as its upstream deadline (#257). Capped at
  // the proxy's LLM_CALL_TIMEOUT_MAX_MS: a larger value would be silently cut there, so it is
  // refused at boot instead. The permit hold window is derived from it (lib/llm-permits.ts).
  BASTION_LLM_TIMEOUT_MS: z.coerce.number().int().min(LLM_CALL_TIMEOUT_MIN_MS).max(LLM_CALL_TIMEOUT_MAX_MS).default(LLM_CALL_TIMEOUT_DEFAULT_MS),
  // The compile call's output budget (#237). Reasoning models spend part of it before answering.
  BASTION_LLM_MAX_TOKENS: z.coerce.number().int().min(256).max(100000).default(COMPILE_MAX_TOKENS_DEFAULT),
  BASTION_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BASTION_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  BASTION_PUT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  BASTION_RUN_LEASE_MS: z.coerce.number().int().positive().default(300000),

  // NOTE: BBB_PERMISSIONS_ENFORCE is deliberately ABSENT. Bastion's per-action enforcement is a
  // hardcoded boot invariant (see boot/assert-permissions-enforce.ts), not an env setting.

  // Platform RLS posture; Bastion binds app.current_org_id per transaction regardless.
  BBB_RLS_ENFORCE: z.string().optional(),
}).superRefine((e, ctx) => {
  // A slice heartbeats between calls, not during one (#257): one call plus a permit wait must
  // fit inside the run lease, or a healthy slice's run is reaped mid-call.
  if (e.BASTION_LLM_TIMEOUT_MS + LLM_HOLD_MARGIN_MS > e.BASTION_RUN_LEASE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BASTION_LLM_TIMEOUT_MS'],
      message: `must be at least ${LLM_HOLD_MARGIN_MS} ms below BASTION_RUN_LEASE_MS (${e.BASTION_RUN_LEASE_MS})`,
    });
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const secretProblems = checkStableSecrets(process.env);
  if (secretProblems.length > 0) {
    console.error(formatStableSecretRefusal(secretProblems));
    process.exit(1);
  }
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    console.error('Invalid environment variables:', JSON.stringify(formatted, null, 2));
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
