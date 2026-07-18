import { z } from 'zod';

// Railway (and most managed PaaS providers) inject `PORT` and require the
// service to bind to it for healthchecks and the public proxy to work. Prefer
// PORT when set, fall back to the historical MCP_PORT (used by docker-compose),
// fall back to 3001 for local dev.
const envSchema = z.object({
  MCP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(() => Number(process.env.PORT) || 3001),
  MCP_TRANSPORT: z.enum(['streamable-http', 'stdio', 'sse']).default('streamable-http'),
  API_INTERNAL_URL: z.string().url().default('http://localhost:3000'),
  HELPDESK_API_URL: z.string().url().default('http://localhost:4001'),
  BANTER_API_URL: z.string().url().default('http://localhost:4002'),
  BEACON_API_URL: z.string().url().default('http://beacon-api:4004/v1'),
  BRIEF_API_URL: z.string().url().default('http://brief-api:4005/v1'),
  BOLT_API_URL: z.string().url().default('http://bolt-api:4006/v1'),
  BEARING_API_URL: z.string().url().default('http://bearing-api:4007/v1'),
  BOARD_API_URL: z.string().url().default('http://board-api:4008/v1'),
  BOND_API_URL: z.string().url().default('http://bond-api:4009/v1'),
  BLAST_API_URL: z.string().url().default('http://blast-api:4010/v1'),
  BOOK_API_URL: z.string().url().default('http://book-api:4012/v1'),
  BENCH_API_URL: z.string().url().default('http://bench-api:4011/v1'),
  BASIS_API_URL: z.string().url().default('http://basis-api:4019/v1'),
  BRAID_API_URL: z.string().url().default('http://braid-api:4020/v1'),
  BILL_API_URL: z.string().url().default('http://bill-api:4014/v1'),
  BLANK_API_URL: z.string().url().default('http://blank-api:4013/v1'),
  BLUEPRINT_API_URL: z.string().url().default('http://blueprint-api:4015/v1'),
  BIN_API_URL: z.string().url().default('http://bin-api:4016/v1'),
  BAY_API_URL: z.string().url().default('http://bay-api:4017/v1'),
  BLIP_API_URL: z.string().url().default('http://blip-api:4018/v1'),
  BUREAU_API_URL: z.string().url().default('http://bureau-api:4015/v1'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MCP_AUTH_REQUIRED: z.coerce.boolean().default(true),
  MCP_RATE_LIMIT_RPM: z.coerce.number().int().positive().default(120),
  // Wave D Phase 2: per-action permissions enforcement. Mirrors the api's
  // BBB_PERMISSIONS_ENFORCE setting. 'off' = no resolver call from MCP;
  // 'warn' = call resolver, record divergence, never block; 'on' = call
  // resolver, deny tool invocation on resolver-deny. The ALWAYS_PERMITTED
  // core tools (get_server_info, get_me, agent_heartbeat) bypass this in
  // all three modes — same shape as the §15 agent_policies gate.
  BBB_PERMISSIONS_ENFORCE: z.enum(['off', 'warn', 'on']).default('warn'),
  // Wave 0.2: shared secret for the internal POST /tools/call HTTP route.
  // Must match INTERNAL_SERVICE_SECRET on the calling services (bolt-api,
  // worker, api). Absent, empty, or short means /tools/call returns 503.
  // Empty string is normalized to undefined because docker-compose
  // interpolation turns unset references into empty strings by default.
  INTERNAL_SERVICE_SECRET: z
    .preprocess((v) => (typeof v === 'string' && v.length === 0 ? undefined : v), z.string().min(32).optional()),
  // Bearer token minted via `cli create-service-account` that the internal
  // /tools/call route hands to the per-request ApiClient. The service
  // account is org-bound, so this token provides the org scoping for any
  // tool invocation that flows through /tools/call. Empty string is
  // normalized to undefined for the same docker-compose reason as above.
  MCP_INTERNAL_API_TOKEN: z
    .preprocess((v) => (typeof v === 'string' && v.length === 0 ? undefined : v), z.string().min(1).optional()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }
  return result.data;
}
