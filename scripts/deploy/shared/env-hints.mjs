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
    note: 'openssl rand -hex 32 — must be IDENTICAL on api and helpdesk-api. Both validate z.string().min(32), so use 32 bytes (64 hex chars); hex-16 sits exactly on the floor and a shorter value crashes both at boot.',
  },
  INTERNAL_SERVICE_SECRET: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 32 — protects internal service-to-service calls (bolt-api event ingestion, MCP /tools/call). Validated min(32); use 64 hex chars.',
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
  // Optional auth — read by beacon-api/brief-api/worker (qdrant.ts:10,
  // beacon-vector-sync.job.ts:50). The bundled Railway Qdrant image has no
  // auth, so this is empty by default; set it only for managed/cloud Qdrant.
  QDRANT_API_KEY: {
    kind: 'user',
    value: '',
    note: 'Only needed if you point QDRANT_URL at a managed Qdrant (e.g. Qdrant Cloud). The bundled self-hosted image requires no key.',
  },

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
  // Server-side SFU address (token minting, room management, webhook
  // validation) — internal DNS is correct because these calls originate
  // inside Railway's private network.
  LIVEKIT_HOST: { kind: 'computed', value: internal('livekit') },
  // Browser-facing signaling URL — must be ABSOLUTE wss://<domain>/livekit-ws.
  // Code-verified (docs/deploy/railway-var-decisions.md): banter returns
  // LIVEKIT_WS_URL verbatim to the LiveKit SDK (apps/banter-api/src/services/
  // livekit-url.ts:38-41) and the SDK rejects a relative path; bureau passes an
  // absolute URL through unchanged (packages/bureau-client/src/active-room.ts:
  // 210-215). A relative `/livekit-ws` works for bureau but breaks banter, so
  // absolute is the only value correct for both. nginx proxies /livekit-ws →
  // livekit:7880. `public` so it derives from the deploy domain and an operator
  // can override it to an external LiveKit endpoint. (An earlier `/livekit-ws`
  // literal here broke banter calling on prod — 2026-06-12.)
  LIVEKIT_URL: { kind: 'public', value: '<frontend-public-url-ws>/livekit-ws' },
  LIVEKIT_WS_URL: { kind: 'public', value: '<frontend-public-url-ws>/livekit-ws' },
  LIVEKIT_WEBHOOK_URL: {
    kind: 'computed',
    value: `${internal('banter-api')}/v1/webhooks/livekit`,
  },
  // ── LiveKit TURN-TLS (public-internet media relay) ────────────────
  // Railway has no public UDP, so browsers off the LAN can only reach the
  // SFU through a TURN-TLS relay. The cert + DNS are irreducibly operator-
  // supplied; the TLS port is auto-filled by the deploy after it creates the
  // livekit TCP proxy (see the post-deploy LiveKit checklist).
  LIVEKIT_TURN_DOMAIN: {
    kind: 'user',
    value: '<turn.your-domain>',
    note: 'Public FQDN for the TURN relay, e.g. turn.example.com. Add a DNS CNAME to the Railway TCP-proxy host. Required for public-internet calls.',
  },
  LIVEKIT_TURN_TLS_PORT: {
    kind: 'user',
    value: '<railway-tcp-proxy-port>',
    note: 'The public port of the livekit TCP proxy (target 5349). The deploy creates the proxy and prints this port; paste it here.',
  },
  LIVEKIT_TURN_CERT_PEM: {
    kind: 'user',
    value: '<lets-encrypt-fullchain-pem>',
    note: 'PEM body of a publicly-trusted cert for LIVEKIT_TURN_DOMAIN (browsers validate it; self-signed fails). Issue via Let\'s Encrypt DNS-01.',
  },
  LIVEKIT_TURN_KEY_PEM: {
    kind: 'user',
    value: '<lets-encrypt-privkey-pem>',
    note: 'PEM body of the private key paired with LIVEKIT_TURN_CERT_PEM.',
  },
  LIVEKIT_TURN_CHECK_TARGET: {
    kind: 'user',
    value: '<turn.your-domain:port>',
    note: 'Set on the worker so the daily turn-cert-expiry watchdog can warn before the TURN cert lapses. Format: turn.example.com:<tls-port>.',
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
  // NOTE: MCP_PORT is deliberately NOT emitted. On Railway the mcp-server must
  // bind the injected PORT=8080; an explicit MCP_PORT=3001 would WIN over PORT
  // (apps/mcp-server/src/env.ts:8-12) and break the ingress healthcheck. It is
  // absent from the mcp-server catalog so it is never applied — kept out of the
  // hints too so it can't be reintroduced by accident.
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
  // The bare public site root. Every backend's deep-link builder appends its
  // own SPA mount (/b3, /beacon, /board, …), so ONE value serves them all —
  // this replaced the old per-app FRONTEND_URL, which baked a different mount
  // into the var for each service and could never be set globally.
  PUBLIC_URL: {
    kind: 'public',
    value: '<frontend-public-url>',
    note: 'Bare site root, e.g. https://your-frontend-service.up.railway.app or your custom domain. Used by every app to build deep-links.',
  },
  TRACKING_BASE_URL: { kind: 'public', value: '<frontend-public-url>' },
  CORS_ORIGIN: { kind: 'public', value: '<frontend-public-url>' },
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
  // Single canonical SMTP from-address. The deploy prompt collects SMTP_FROM
  // and aliases it to EMAIL_FROM (the only name the shared smtp-resolver and
  // every consuming service read); the UI → system_settings.smtp_from is the
  // real source of truth and overrides this. (Was previously sprawled across
  // SMTP_FROM / EMAIL_FROM / SMTP_FROM_EMAIL / SMTP_FROM_NAME.)
  SMTP_FROM: { kind: 'user', value: 'noreply@yourdomain.com' },
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
