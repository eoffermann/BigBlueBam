// Hints for how each environment variable should be set on Railway.
// Pulled in by scripts/gen-railway-configs.mjs to render railway/env-vars.md.
//
// `kind` field meanings:
//   plugin    — reference to a Railway plugin var (e.g. ${{Postgres.DATABASE_URL}})
//   secret    — secret you generate locally (openssl rand etc.)
//   computed  — derived from the catalog (internal Railway DNS, port, …)
//   reference — reference to another Railway service's variable
//   literal   — fixed value, just type it as-is
//   public    — needs the public URL of the frontend ingress service
//   user      — comes from outside (OAuth provider, SMTP host, …)
//   note      — explanatory only; the value is informational
//
// `value` is what you actually set in Railway. For non-trivial cases the
// `note` field explains why or how.

import { APP_SERVICES, INFRA_SERVICES } from './services.mjs';

// Railway sets PORT=8080 on every container and expects the service to bind
// to it. Every Bam app service (api, helpdesk-api, …, mcp-server, site,
// frontend, worker) reads process.env.PORT and binds to 8080 accordingly,
// REGARDLESS of the nominal docker-compose port in the catalog. So
// internal-DNS URLs going TO a Bam service must use 8080, not the catalog
// port — using the catalog port produces 502s at request time even though
// per-service healthchecks pass (because Railway probes localhost:8080).
//
// Third-party container images (minio, qdrant, livekit) ignore $PORT and
// bind to their own hardcoded defaults (9000, 6333, 7880); for those we
// keep the catalog port. Managed plugins (postgres, redis) never go
// through internal() — they use ${{Postgres.DATABASE_URL}} references.
const RAILWAY_DYNAMIC_PORT = 8080;
const APP_SERVICE_NAMES = new Set(APP_SERVICES.map((s) => s.name));

function internal(name) {
  const svc = [...APP_SERVICES, ...INFRA_SERVICES].find((s) => s.name === name);
  if (!svc) throw new Error(`Unknown service in env-hints: ${name}`);
  if (APP_SERVICE_NAMES.has(name)) {
    return `http://${name}.railway.internal:${RAILWAY_DYNAMIC_PORT}`;
  }
  if (!svc.port) return `http://${name}.railway.internal`;
  return `http://${name}.railway.internal:${svc.port}`;
}

export const ENV_HINTS = {
  // ── Database / cache (managed Railway plugins) ────────────────────
  DATABASE_URL: {
    kind: 'plugin',
    value: '${{Postgres.DATABASE_URL}}',
    note: 'Reference the Railway Postgres plugin',
  },
  DATABASE_READ_URL: {
    kind: 'plugin',
    value: '${{Postgres.DATABASE_URL}}',
    note: 'Same as DATABASE_URL unless you set up a read replica',
  },
  REDIS_URL: {
    kind: 'plugin',
    value: '${{Redis.REDIS_URL}}',
    note: 'Reference the Railway Redis plugin',
  },

  // ── Secrets you generate yourself ─────────────────────────────────
  SESSION_SECRET: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 32 — must be IDENTICAL on every API service so they share sessions',
  },
  INTERNAL_HELPDESK_SECRET: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 16 — must be IDENTICAL on api and helpdesk-api',
  },
  INTERNAL_SERVICE_SECRET: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 16 — protects internal service-to-service calls (bolt-api event ingestion etc.)',
  },

  // ── MinIO (object storage) ────────────────────────────────────────
  MINIO_ROOT_USER: {
    kind: 'secret',
    value: '<generate>',
    note: 'Set on the minio service. Reference from app services as ${{minio.MINIO_ROOT_USER}}',
  },
  MINIO_ROOT_PASSWORD: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 24. Set on the minio service. Reference from app services as ${{minio.MINIO_ROOT_PASSWORD}}',
  },
  S3_ENDPOINT: { kind: 'computed', value: internal('minio') },
  S3_ACCESS_KEY: { kind: 'reference', value: '${{minio.MINIO_ROOT_USER}}' },
  S3_SECRET_KEY: { kind: 'reference', value: '${{minio.MINIO_ROOT_PASSWORD}}' },
  S3_BUCKET: { kind: 'literal', value: 'bigbluebam-uploads' },
  S3_REGION: { kind: 'literal', value: 'us-east-1' },

  // ── Qdrant (vector search) ────────────────────────────────────────
  QDRANT_URL: { kind: 'computed', value: internal('qdrant') },

  // ── LiveKit (voice / video SFU) ───────────────────────────────────
  LIVEKIT_API_KEY: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 16 — must MATCH on livekit, banter-api, board-api, voice-agent',
  },
  LIVEKIT_API_SECRET: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 32 — must MATCH on livekit, banter-api, board-api, voice-agent',
  },
  LIVEKIT_HOST: { kind: 'computed', value: internal('livekit') },
  LIVEKIT_URL: { kind: 'computed', value: internal('livekit').replace('http://', 'ws://') },
  LIVEKIT_WS_URL: {
    kind: 'public',
    value: 'wss://<your-public-domain>',
    note: 'Public WebSocket URL clients use. If exposing LiveKit publicly, point to its Railway domain or your custom subdomain. Otherwise leave blank to disable voice/video.',
  },
  LIVEKIT_WEBHOOK_URL: {
    kind: 'computed',
    value: `${internal('banter-api')}/v1/webhooks/livekit`,
  },

  // ── Inter-service URLs (internal Railway DNS) ────────────────────
  BBB_API_INTERNAL_URL: { kind: 'computed', value: internal('api') },
  API_INTERNAL_URL: { kind: 'computed', value: internal('api') },
  MCP_INTERNAL_URL: { kind: 'computed', value: internal('mcp-server') },
  BOND_API_INTERNAL_URL: { kind: 'computed', value: internal('bond-api') },
  HELPDESK_API_URL: { kind: 'computed', value: internal('helpdesk-api') },
  BEACON_API_URL: { kind: 'computed', value: internal('beacon-api') },
  BOLT_API_URL: { kind: 'computed', value: `${internal('bolt-api')}/v1` },
  BEARING_API_URL: { kind: 'computed', value: `${internal('bearing-api')}/v1` },
  BOARD_API_URL: { kind: 'computed', value: `${internal('board-api')}/v1` },
  BOND_API_URL: { kind: 'computed', value: `${internal('bond-api')}/v1` },
  BLAST_API_URL: { kind: 'computed', value: `${internal('blast-api')}/v1` },
  BOOK_API_URL: { kind: 'computed', value: `${internal('book-api')}/v1` },
  BENCH_API_URL: { kind: 'computed', value: `${internal('bench-api')}/v1` },
  BILL_API_URL: { kind: 'computed', value: `${internal('bill-api')}/v1` },
  BLANK_API_URL: { kind: 'computed', value: `${internal('blank-api')}/v1` },
  // The mcp-server fans out to every app API. These three were missing, so on
  // Railway the mcp-server fell back to its `localhost:<port>` defaults and the
  // Banter (50+), Bureau, and Blueprint MCP tool families silently failed —
  // the same class of bug as the API_INTERNAL_URL=:4000 mismatch. The /v1
  // suffix matches what the mcp-server clients expect (Banter/Helpdesk/Beacon
  // embed /v1 in their request paths so their base omits it; the rest carry
  // /v1 in the base — see docker-compose.yml mcp-server env for the reference).
  BANTER_API_URL: { kind: 'computed', value: internal('banter-api') },
  BUREAU_API_URL: { kind: 'computed', value: `${internal('bureau-api')}/v1` },
  BLUEPRINT_API_URL: { kind: 'computed', value: `${internal('blueprint-api')}/v1` },
  VOICE_AGENT_URL: { kind: 'computed', value: internal('voice-agent') },

  // ── MCP server ────────────────────────────────────────────────────
  MCP_TRANSPORT: { kind: 'literal', value: 'streamable-http' },
  MCP_AUTH_REQUIRED: {
    kind: 'literal',
    value: 'true',
    note: 'Recommended for production deployments',
  },
  MCP_PORT: { kind: 'literal', value: '3001' },
  // Bearer token for the internal POST /tools/call route (server-to-server
  // tool invocation, e.g. bolt-api → mcp-server). It must be a real
  // `bbam_svc_`-prefixed service-account token minted against the deployed
  // api, so it cannot be auto-generated like a random secret — the deploy
  // mints it once the api is live (see post-deploy step) and writes it here.
  // Until set, /tools/call returns 503 and agent-to-agent tool calls are off.
  MCP_INTERNAL_API_TOKEN: {
    kind: 'user',
    value: '<mint-after-api-is-up>',
    note: 'docker compose / railway run: api node dist/cli.js create-service-account --name mcp-internal --org-slug <org>; paste the bbam_svc_ token here',
  },

  // ── Public URLs (point at your frontend service's Railway domain) ─
  PUBLIC_URL: {
    kind: 'public',
    value: '<frontend-public-url>',
    note: 'e.g. https://your-frontend-service.up.railway.app or your custom domain',
  },
  TRACKING_BASE_URL: { kind: 'public', value: '<frontend-public-url>' },
  CORS_ORIGIN: { kind: 'public', value: '<frontend-public-url>' },
  FRONTEND_URL: { kind: 'public', value: '<frontend-public-url>/b3' },
  HELPDESK_URL: { kind: 'public', value: '<frontend-public-url>/helpdesk' },

  // ── Logs / rate limits / tunables ─────────────────────────────────
  LOG_LEVEL: { kind: 'literal', value: 'info' },
  NODE_ENV: { kind: 'literal', value: 'production' },
  RATE_LIMIT_MAX: { kind: 'literal', value: '100' },
  RATE_LIMIT_WINDOW_MS: { kind: 'literal', value: '60000' },
  WORKER_CONCURRENCY: { kind: 'literal', value: '5' },
  PUBLIC_FORM_RATE_LIMIT: { kind: 'literal', value: '10' },
  PUBLIC_FORM_RATE_WINDOW_MS: { kind: 'literal', value: '3600000' },
  QUERY_TIMEOUT_MS: { kind: 'literal', value: '10000' },
  CACHE_TTL_SECONDS: { kind: 'literal', value: '60' },

  // ── OAuth (you provide) ───────────────────────────────────────────
  OAUTH_GITHUB_CLIENT_ID: {
    kind: 'user',
    value: '<from-github>',
    note: 'Create an OAuth app at https://github.com/settings/developers',
  },
  OAUTH_GITHUB_CLIENT_SECRET: { kind: 'user', value: '<from-github>' },
  OAUTH_GOOGLE_CLIENT_ID: {
    kind: 'user',
    value: '<from-google-cloud>',
    note: 'Create an OAuth client at https://console.cloud.google.com',
  },
  OAUTH_GOOGLE_CLIENT_SECRET: { kind: 'user', value: '<from-google-cloud>' },
  GOOGLE_CLIENT_ID: { kind: 'user', value: '<from-google-cloud>' },
  GOOGLE_CLIENT_SECRET: { kind: 'user', value: '<from-google-cloud>' },
  MICROSOFT_CLIENT_ID: { kind: 'user', value: '<from-azure-portal>' },
  MICROSOFT_CLIENT_SECRET: { kind: 'user', value: '<from-azure-portal>' },

  // ── SMTP (email — you provide) ────────────────────────────────────
  SMTP_HOST: {
    kind: 'user',
    value: '<smtp-host>',
    note: 'e.g. smtp.sendgrid.net, smtp.postmark.com, smtp.resend.com',
  },
  SMTP_PORT: { kind: 'literal', value: '587' },
  SMTP_USER: { kind: 'user', value: '<smtp-user>' },
  SMTP_PASS: { kind: 'user', value: '<smtp-password>' },
  SMTP_FROM: { kind: 'user', value: 'noreply@yourdomain.com' },
  SMTP_FROM_EMAIL: { kind: 'user', value: 'noreply@yourdomain.com' },
  SMTP_FROM_NAME: { kind: 'user', value: 'BigBlueBam' },
  EMAIL_FROM: { kind: 'user', value: 'noreply@yourdomain.com' },

  // ── Frontend ingress ─────────────────────────────────────────────
  HTTP_PORT: {
    kind: 'note',
    value: '80',
    note: 'Frontend listens on port 80 internally; Railway assigns an external port automatically',
  },
  HTTPS_PORT: {
    kind: 'note',
    value: '443',
    note: 'Same as HTTP_PORT — Railway terminates TLS at its edge',
  },

  // ── Migrations ────────────────────────────────────────────────────
  MIGRATIONS_DIR: { kind: 'literal', value: '/app/migrations' },
};

/**
 * Look up a hint, returning a stub for unknown variables.
 */
export function hintFor(varName) {
  return ENV_HINTS[varName] ?? { kind: 'unknown', value: '<see app docs>', note: '' };
}

// ── Variable ownership ───────────────────────────────────────────────
//
// "Authoritative" (deploy-owned) variables have a value that is a pure
// function of the service catalog — internal DNS URLs, fixed literals,
// Railway plugin/service references. An operator should never hand-edit
// these, and if the live value ever drifts from the computed one it is
// always wrong (that is exactly how prod ended up with API_INTERNAL_URL
// pointing at :4000). The reconcile flow may therefore OVERWRITE them.
//
// Everything else is "context-owned": secrets (which the operator may have
// rotated), public URLs (which may point at a custom domain), and user
// integrations (OAuth/SMTP). Reconcile must MERGE-PRESERVE these — never
// clobber a value the operator deliberately set.
const AUTHORITATIVE_KINDS = new Set(['computed', 'literal', 'plugin', 'reference']);

/** True if a hint `kind` is deploy-owned and safe to overwrite on reconcile. */
export function isAuthoritativeKind(kind) {
  return AUTHORITATIVE_KINDS.has(kind);
}

/**
 * Ownership of a variable by name: 'deploy' (authoritative, overwrite on
 * reconcile) or 'context' (operator may own it, merge-preserve).
 */
export function ownershipOf(varName) {
  return isAuthoritativeKind(hintFor(varName).kind) ? 'deploy' : 'context';
}
