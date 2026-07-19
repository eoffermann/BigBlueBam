import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4021),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Per-asker rate limit knobs (spec 5.1: reads/writes that surface or mutate
  // source-scoped records are per-asker preflighted).
  ASKER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  ASKER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Internal service URLs. Bulwark reaches the platform llm-provider (extraction +
  // drafting) and the api's can_access preflight (spec 2.5/2.6), bolt-api (event
  // publish, spec 7.1), and braid-api for synchronous counterparty resolution
  // (spec 7.4 / 9.1 / IN7); absent Braid it degrades to the raw bond.company id.
  BBB_API_INTERNAL_URL: z.string().default('http://api:4000'),
  BOLT_API_INTERNAL_URL: z.string().default('http://bolt-api:4006'),
  BRAID_API_INTERNAL_URL: z.string().default('http://braid-api:4020'),
  // Blast is the transactional-mail transport for legally-required notices/chases (spec D6 /
  // reuse ledger line 710): the send executor POSTs the rendered notice to blast-api's internal
  // transactional-send route, which bypasses blast_unsubscribes.
  BLAST_API_INTERNAL_URL: z.string().default('http://blast-api:4010'),
  // Must be non-empty for the internal event route (/internal/events fails CLOSED
  // when empty, S4/SN2) + the can_access preflight to work.
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Per-action permission enforcement (mirrors basis/braid-api). 'warn' records
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
