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

// Internal DNS for a Bam app service that may not have landed in the catalog yet.
//
// `internal()` deliberately THROWS on an unknown name; that guard catches typos and must
// stay. But a hint sometimes has to exist BEFORE its service does: an app's env-hints entry
// and its APP_SERVICES block can land in different commits, and a bare `internal()` call for
// the not-yet-added service would throw at module load and break env-hints for EVERY
// consumer, not just that app.
//
// Every Bam app service resolves to the same shape regardless of its catalog port, because
// Railway injects PORT=8080 (see the note above), so the fallback value here is identical to
// what `internal()` will return once the catalog block lands. This is self-healing: no edit
// is needed at that point, and the typo guard still applies to every other call site.
// Services that are being built right now and whose APP_SERVICES block has not landed yet.
// plannedApp() refuses any name that is neither already in the catalog nor listed here, so
// a typo ('brun-api') throws at module load instead of silently resolving to a valid-looking
// URL that nothing ever checks. Entries are removed as each service lands in APP_SERVICES;
// check-env-hints.mjs fails on a stale entry, so this set can only shrink.
export const PLANNED_APP_SERVICES = new Set([
  // Empty. burn-api landed in APP_SERVICES and was removed from here; bursar-api landed in
  // the same commit as its hints, so it never needed an entry. Shrink-only by design: add
  // a name here ONLY while its APP_SERVICES block is genuinely still unwritten, and delete
  // it the moment that block lands.
]);

function plannedApp(name) {
  if (APP_SERVICE_NAMES.has(name)) return internal(name);
  if (!PLANNED_APP_SERVICES.has(name)) {
    throw new Error(
      `plannedApp('${name}'): unknown service. Add it to APP_SERVICES, or to ` +
        `PLANNED_APP_SERVICES if it is genuinely still being built. This guard exists ` +
        `because a typo would otherwise produce a plausible .railway.internal URL that ` +
        `no check validates, and the service would be silently unreachable in production.`,
    );
  }
  // Byte-identical to what internal(name) will return once the catalog block lands, so the
  // resolved value does not change at that moment.
  return `http://${name}.railway.internal:${RAILWAY_DYNAMIC_PORT}`;
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
  BLIP_INGEST_PEPPER: {
    kind: 'secret',
    value: '<generate>',
    note: 'openssl rand -hex 32 — blip-api HMAC pepper for hashing public ingest keys. Blip-local (nothing else references it), but must stay STABLE for blip-api: rotating it invalidates every already-issued ingest key. Generate once and keep.',
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
  // Server-to-server base (NO /v1) for satellite services publishing Bolt events via
  // publishBoltEvent. Distinct from BOLT_API_URL, which the mcp-server uses and which DOES
  // carry /v1 because the mcp bolt client requests bare resource paths. The bare shape here
  // matches the `http://bolt-api:4006` default in every consuming app's env.ts.
  //
  // This was MISSING, which was a live deploy bug rather than a cosmetic gap: the var is
  // declared `required` on bulwark-api in services.mjs, and buildServiceVariables THROWS on
  // a required var that resolves to an `unknown` hint. Railway provisioning for bulwark-api
  // aborted outright. On the seven services where it is optional it silently resolved to
  // SKIP, so those services shipped to production with Bolt event publishing simply absent
  // and no signal at all. scripts/check-env-hints.mjs now guards this class of gap.
  BOLT_API_INTERNAL_URL: { kind: 'computed', value: internal('bolt-api') },
  HELPDESK_API_URL: { kind: 'computed', value: internal('helpdesk-api') },
  // beacon-api mounts EVERY route under prefix '/v1' (apps/beacon-api/src/
  // server.ts) and the mcp beacon client requests bare paths like `/beacons`
  // (apps/mcp-server/src/tools/beacon-tools.ts), so the base MUST carry /v1 —
  // unlike banter/helpdesk, whose clients embed the prefix in the request path.
  // (The compose value + this hint had dropped the /v1, so beacon MCP tools
  // 404'd; the env.ts default already carried /v1 and was the correct one.)
  BEACON_API_URL: { kind: 'computed', value: `${internal('beacon-api')}/v1` },
  // brief-api likewise mounts under '/v1' and the mcp brief client uses bare
  // `/documents` paths, so its base carries /v1 too. This was missing from both
  // this map AND the mcp-server catalog optional list, so reconcile never set it
  // on Railway and prod fell back to the localhost:4005 default — Brief MCP
  // tools failed there the same way the unset Banter/Bureau/Blueprint URLs did.
  BRIEF_API_URL: { kind: 'computed', value: `${internal('brief-api')}/v1` },
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
  // the same class of bug as the API_INTERNAL_URL=:4000 mismatch. Banter and
  // Helpdesk omit /v1 because their clients carry the prefix in the request
  // path (/v1/channels, /helpdesk/tickets); every OTHER satellite client
  // (beacon, brief, bond, board, …) uses bare resource paths, so its base
  // carries /v1 — see docker-compose.yml mcp-server env for the reference.
  BANTER_API_URL: { kind: 'computed', value: internal('banter-api') },
  BUREAU_API_URL: { kind: 'computed', value: `${internal('bureau-api')}/v1` },
  BLUEPRINT_API_URL: { kind: 'computed', value: `${internal('blueprint-api')}/v1` },
  // bin-api / bay-api mount every route under '/v1' and their mcp clients use
  // bare resource paths, so the base carries /v1 (matches the env.ts defaults).
  BIN_API_URL: { kind: 'computed', value: `${internal('bin-api')}/v1` },
  BAY_API_URL: { kind: 'computed', value: `${internal('bay-api')}/v1` },
  // Server-to-server base (no /v1) for bay-api -> bin-api internal calls.
  BIN_API_INTERNAL_URL: { kind: 'computed', value: internal('bin-api') },
  // Server-to-server base (no /v1) for burn-api -> bill-api cost-rate resolution. Burn
  // declares this REQUIRED, and a required var with no hint hard-aborts provisioning in
  // buildServiceVariables, so the hint has to exist before burn-api's catalog block lands.
  // It is not referenced by any currently-deployed service, so unlike BOLT_API_INTERNAL_URL
  // this was a LATENT bug rather than a live one.
  BILL_API_INTERNAL_URL: { kind: 'computed', value: internal('bill-api') },
  // Server-to-server base (no /v1) for counterparty golden-id resolution via Braid. Optional
  // on bolt-api, bulwark-api, and worker today, which is exactly why it was invisible: with
  // no hint it silently resolved to SKIP and Braid resolution was simply absent in
  // production on all three.
  BRAID_API_INTERNAL_URL: { kind: 'computed', value: internal('braid-api') },
  // Burn. These used plannedApp() while the burn-api APP_SERVICES block was still unlanded;
  // it has since landed, so they resolve through internal() like every other service.
  //
  // BURN_API_INTERNAL_URL is the spend-gate precheck base, consumed by bill-api, bolt-api,
  // and worker. It is OPTIONAL on bill-api by design (unset means the gate is absent and
  // expenses post normally), which is precisely the dangerous case: with no hint it would
  // never be set on Railway, the preHandler would no-op, and Burn's flagship gate would not
  // exist in production with nothing anywhere reporting its absence.
  BURN_API_INTERNAL_URL: { kind: 'computed', value: internal('burn-api') },
  // Carries /v1 because the mcp-server's burn client requests bare resource paths, matching
  // every other satellite client (beacon, brief, bond, board, ...).
  BURN_API_URL: { kind: 'computed', value: `${internal('burn-api')}/v1` },
  // Bursar. Same two-var shape as Burn, and the SUFFIX ASYMMETRY IS LOAD-BEARING.
  //
  // BURSAR_API_INTERNAL_URL is the bare origin, with no suffix. It is consumed
  // server-to-server by bolt-api and the worker, which address bursar-api's internal routes
  // under their own prefixes.
  BURSAR_API_INTERNAL_URL: { kind: 'computed', value: internal('bursar-api') },
  // BURSAR_API_URL carries /v1 because the mcp-server's bursar client requests bare resource
  // paths, matching every other satellite client (burn, beacon, brief, bond, board, ...).
  // Setting these two to identical values 404s every Bursar MCP tool on Railway, with no
  // local repro because the compose stack sets them explicitly.
  BURSAR_API_URL: { kind: 'computed', value: `${internal('bursar-api')}/v1` },
  // Per-call LLM deadline for the classification and derivation passes.
  BURSAR_LLM_TIMEOUT_MS: { kind: 'literal', value: '60000' },
  // Bounds only the 202-returning START leg of an engine run, never the run itself. The
  // leveling and derivation engines proceed in bounded slices under a heartbeat lease, so a
  // multi-minute run is expected and this value must not be raised to try to cover it.
  BURSAR_ENGINE_TIMEOUT_MS: { kind: 'literal', value: '30000' },
  // The three bill-api-side spend-gate tunables (Burn spec 5.5.1). BURN_PRECHECK_TIMEOUT_MS
  // is the AUTHORITATIVE client deadline and must stay strictly ABOVE burn-api's own
  // precheck_budget_ms (CHECK-clamped to [100, 750]): a timeout budget stored in the
  // service it is meant to bound cannot be read when that service is down. The breaker
  // values are shared across every bill-api replica through Redis, so they describe the
  // FLEET's tolerance, not one process's.
  BURN_PRECHECK_TIMEOUT_MS: { kind: 'literal', value: '800' },
  BURN_PRECHECK_BREAKER_THRESHOLD: { kind: 'literal', value: '5' },
  BURN_PRECHECK_BREAKER_PROBE_MS: { kind: 'literal', value: '30000' },
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
  // Internal LLM concurrency cap (Burn spec 9.7.1). Set on the api service: it
  // fronts POST /internal/llm/chat with a per-calling-service Redis token bucket
  // so a satellite's LLM fan-out cannot starve the shared permission resolver.
  LLM_INTERNAL_MAX_CONCURRENT_PER_SERVICE: { kind: 'literal', value: '4' },
  LLM_INTERNAL_RATE_PER_MINUTE: { kind: 'literal', value: '120' },
  PUBLIC_FORM_RATE_LIMIT: { kind: 'literal', value: '10' },
  PUBLIC_FORM_RATE_WINDOW_MS: { kind: 'literal', value: '3600000' },
  QUERY_TIMEOUT_MS: { kind: 'literal', value: '10000' },
  CACHE_TTL_SECONDS: { kind: 'literal', value: '60' },
  // Platform-wide default, matching `${BBB_PERMISSIONS_ENFORCE:-warn}` in docker-compose.yml
  // (:125 and ~19 other sites). 'warn' records resolver divergence without blocking.
  //
  // A service that needs real enforcement does NOT get it from this hint: burn-api sets
  // `on` explicitly in its own compose entry and asserts the resolved value at boot,
  // refusing to start otherwise. That is a deliberately different mechanism, because a
  // security posture that depends on a shared default being right is one bad merge away
  // from being wrong. Do not raise this literal to 'on' to try to fix a single service.
  BBB_PERMISSIONS_ENFORCE: { kind: 'literal', value: 'warn' },
  // Document-parsing bounds (Burn 4.15). 25 MB and 300 pages; a breach records
  // `rejected_limits` and extracts nothing partial.
  MAX_DOC_BYTES: { kind: 'literal', value: '26214400' },
  MAX_DOC_PAGES: { kind: 'literal', value: '300' },

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
