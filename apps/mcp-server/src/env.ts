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
  BEACON_API_URL: z.string().url().default('http://beacon-api:4004'),
  BRIEF_API_URL: z.string().url().default('http://brief-api:4005/v1'),
  BOLT_API_URL: z.string().url().default('http://bolt-api:4006/v1'),
  BEARING_API_URL: z.string().url().default('http://bearing-api:4007/v1'),
  BOARD_API_URL: z.string().url().default('http://board-api:4008/v1'),
  BOND_API_URL: z.string().url().default('http://bond-api:4009/v1'),
  BLAST_API_URL: z.string().url().default('http://blast-api:4010/v1'),
  BOOK_API_URL: z.string().url().default('http://book-api:4012/v1'),
  BENCH_API_URL: z.string().url().default('http://bench-api:4011/v1'),
  BILL_API_URL: z.string().url().default('http://bill-api:4014/v1'),
  BLANK_API_URL: z.string().url().default('http://blank-api:4013/v1'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MCP_AUTH_REQUIRED: z.coerce.boolean().default(true),
  MCP_RATE_LIMIT_RPM: z.coerce.number().int().positive().default(120),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Shared service-to-service secret. When set, the POST /tools/call internal
  // route requires X-Internal-Secret to match this value (timingSafeEqual).
  // When unset, /tools/call refuses every request with 503.
  INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),
  // Bearer token used by /tools/call to authenticate outbound requests to the
  // Bam REST API on behalf of the caller. Issued by the Bam CLI as an
  // org-bound service-account API key (see `cli create-service-account`).
  MCP_INTERNAL_API_TOKEN: z.string().min(1).optional(),
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
