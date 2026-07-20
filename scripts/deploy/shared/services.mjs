// Service catalog — the source of truth for all BigBlueBam services.
// Used by:
//   - scripts/deploy/platforms/*.mjs       (deploy orchestration)
//   - scripts/gen-railway-configs.mjs      (generates railway/*.json)
//   - docker-compose.yml                   (should be kept in sync manually)
//   - infra/nginx/nginx-with-site.conf     (upstream names match `name`)
//
// Zero dependencies.

// ─── Application services ────────────────────────────────────────────
//
// Every entry here has its own Dockerfile and is a separately deployable
// container. The `name` is the upstream hostname used by the nginx ingress
// container (both in docker-compose and in Railway's private network, where
// services resolve as `<name>.railway.internal`).
//
// `public_paths` lists every public nginx path that routes to this service
// and is used by the Railway nginx template to generate a Railway-flavored
// config. An empty array means the service is internal-only (worker, voice
// agent, site — although `site` is proxied at `/`, it's listed under
// `public_paths` on the frontend entry).

export const APP_SERVICES = [
  {
    name: 'api',
    description: 'Main Bam API — tasks, sprints, boards, auth',
    dockerfile: 'apps/api/Dockerfile',
    port: 4000,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'minio'],
    public_paths: ['/b3/api/', '/b3/ws', '/files/'],
    env: {
      required: [
        'DATABASE_URL',
        'REDIS_URL',
        'SESSION_SECRET',
        'INTERNAL_HELPDESK_SECRET',
      ],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'PUBLIC_URL',
        'INTERNAL_SERVICE_SECRET',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        'OAUTH_GITHUB_CLIENT_ID', 'OAUTH_GITHUB_CLIENT_SECRET',
        'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET',
        // EMAIL_FROM is the single canonical SMTP from-address fallback (the
        // shared @bigbluebam/smtp-resolver key). The DB system_settings.smtp_from
        // (set in the UI) takes precedence over it.
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM',
      ],
    },
  },
  {
    name: 'helpdesk-api',
    description: 'Helpdesk API — tickets, replies, SLAs, public portal',
    dockerfile: 'apps/helpdesk-api/Dockerfile',
    port: 4001,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'minio', 'api'],
    public_paths: ['/helpdesk/api/', '/helpdesk/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_HELPDESK_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'HELPDESK_URL',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM',
      ],
    },
  },
  {
    name: 'banter-api',
    description: 'Banter API — messaging, channels, DMs, calls',
    dockerfile: 'apps/banter-api/Dockerfile',
    port: 4002,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'minio', 'livekit', 'api'],
    public_paths: ['/banter/api/', '/banter/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        'LIVEKIT_HOST', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_WS_URL',
        'VOICE_AGENT_URL',
      ],
    },
  },
  {
    name: 'beacon-api',
    description: 'Beacon API — knowledge base, vector search, policies',
    dockerfile: 'apps/beacon-api/Dockerfile',
    port: 4004,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'minio', 'qdrant', 'api'],
    public_paths: ['/beacon/api/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'QDRANT_URL', 'BBB_API_INTERNAL_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        // Optional Qdrant auth (apps/beacon-api/src/lib/qdrant.ts:10) — needed
        // only for a managed/cloud Qdrant; the bundled image has no auth.
        'QDRANT_API_KEY',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        'PUBLIC_URL', // deep-link base for Beacon entries (lib/urls.ts)
      ],
    },
  },
  {
    name: 'brief-api',
    description: 'Brief API — collaborative documents, templates, comments',
    dockerfile: 'apps/brief-api/Dockerfile',
    port: 4005,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/brief/api/', '/brief/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
        // brief-api reads QDRANT_URL for semantic search (document.routes.ts:175)
        // + optional QDRANT_API_KEY for managed Qdrant — both were missing.
        'QDRANT_URL', 'QDRANT_API_KEY',
        'PUBLIC_URL', // deep-link base for Brief documents (lib/urls.ts)
      ],
    },
  },
  {
    name: 'bolt-api',
    description: 'Bolt API — automation engine, rules, executions',
    dockerfile: 'apps/bolt-api/Dockerfile',
    port: 4006,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api', 'mcp-server'],
    public_paths: ['/bolt/api/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL', 'MCP_INTERNAL_URL'],
      // BRAID_API_INTERNAL_URL: bolt-api forwards subscribed source events to braid-api's
      // /internal/events (Braid live-ingest transport, spec §6); optional soft-dependency.
      // BURN_API_INTERNAL_URL: bolt-api forwards the 16 subscribed events to burn-api's
      // /v1/internal/events (Burn live-ingest transport, spec §8.3); optional soft-dependency.
      // BURSAR_API_INTERNAL_URL: bolt-api forwards the subscribed source events to
      // bursar-api's /v1/internal/events (Bursar live-ingest transport); optional
      // soft-dependency. Configured here at M0 so the value exists on Railway before the
      // consuming route lands, which is the failure mode section 18.4 of the Bursar spec
      // exists to prevent: an unresolvable optional var is silently SKIPPED, so the
      // transport would simply be absent in production with nothing reporting it.
      optional: ['CORS_ORIGIN', 'LOG_LEVEL', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'INTERNAL_SERVICE_SECRET', 'BRAID_API_INTERNAL_URL', 'BULWARK_API_INTERNAL_URL', 'BURN_API_INTERNAL_URL', 'BURSAR_API_INTERNAL_URL'],
    },
  },
  {
    name: 'bearing-api',
    description: 'Bearing API — goals, key results, progress',
    dockerfile: 'apps/bearing-api/Dockerfile',
    port: 4007,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/bearing/api/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: ['CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'PUBLIC_URL'],
    },
  },
  {
    name: 'board-api',
    description: 'Board API — whiteboards, shapes, real-time collab',
    dockerfile: 'apps/board-api/Dockerfile',
    port: 4008,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'livekit', 'api'],
    public_paths: ['/board/api/', '/board/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL',
        'PUBLIC_URL', // deep-link base for board.* Bolt event payloads (lib/bolt-events.ts)
      ],
    },
  },
  {
    name: 'bond-api',
    description: 'Bond API — CRM contacts, companies, deals, pipeline',
    dockerfile: 'apps/bond-api/Dockerfile',
    port: 4009,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/bond/api/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: ['CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'PUBLIC_URL'],
    },
  },
  {
    name: 'blast-api',
    description: 'Blast API — email campaigns, templates, tracking',
    dockerfile: 'apps/blast-api/Dockerfile',
    port: 4010,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api', 'bond-api'],
    public_paths: ['/blast/api/', '/t/', '/unsub/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL', 'BOND_API_INTERNAL_URL', 'TRACKING_BASE_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        // No SMTP here: blast-api sends no email itself — the worker does
        // (apps/worker/src/jobs/blast-send.job.ts), and the worker catalog
        // carries the SMTP_* + EMAIL_FROM fallback.
      ],
    },
  },
  {
    name: 'bench-api',
    description: 'Bench API — analytics, dashboards, widgets, reports',
    dockerfile: 'apps/bench-api/Dockerfile',
    port: 4011,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/bench/api/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: ['DATABASE_READ_URL', 'CORS_ORIGIN', 'LOG_LEVEL', 'QUERY_TIMEOUT_MS', 'CACHE_TTL_SECONDS'],
    },
  },
  {
    name: 'basis-api',
    description: 'Basis API — governed metric layer + why-did-it-change explanations',
    dockerfile: 'apps/basis-api/Dockerfile',
    port: 4019,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // bench-api is a request-time dependency (Basis runs Bench-governed queries
    // server-to-server); listed in needs for deploy ordering, NOT in compose
    // depends_on (spec 8.1 sibling-dependency pattern).
    needs: ['postgres', 'redis', 'api', 'bench-api'],
    public_paths: ['/basis/api/', '/basis/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'DATABASE_READ_URL',
        'CORS_ORIGIN',
        'LOG_LEVEL',
        'BENCH_API_INTERNAL_URL',
        'BOLT_API_INTERNAL_URL',
        'INTERNAL_SERVICE_SECRET',
        'QUERY_TIMEOUT_MS',
        'LLM_TIMEOUT_MS',
        'EXPLANATION_CACHE_TTL_SECONDS',
      ],
    },
  },
  {
    name: 'braid-api',
    description: 'Braid API — identity resolution + golden-record customer data platform',
    dockerfile: 'apps/braid-api/Dockerfile',
    port: 4020,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // api (can_access preflight) and bolt-api (event publish) are request-time
    // deps only; qdrant is soft. Source reads are shared-DB, not service-to-service.
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/braid/api/', '/braid/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_SERVICE_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: [
        'DATABASE_READ_URL',
        'QDRANT_URL',
        'QDRANT_API_KEY',
        'BOLT_API_INTERNAL_URL',
        'CORS_ORIGIN',
        'LOG_LEVEL',
      ],
    },
  },
  {
    name: 'bulwark-api',
    description: 'Bulwark API — AI contract-obligation monitor (obligation ledger, deadline radar, notice drafts)',
    dockerfile: 'apps/bulwark-api/Dockerfile',
    port: 4021,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // api (can_access preflight), bolt-api (event publish), and braid-api (sync
    // counterparty golden-id resolution, spec 7.4/IN7) are request-time deps only;
    // source byte/DB reads are shared-DB, not service-to-service.
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/bulwark/api/', '/bulwark/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_SERVICE_SECRET', 'BBB_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL'],
      optional: [
        'DATABASE_READ_URL',
        'BRAID_API_INTERNAL_URL',
        'BLAST_API_INTERNAL_URL',
        'CORS_ORIGIN',
        'LOG_LEVEL',
      ],
    },
  },
  {
    name: 'burn-api',
    description: 'Burn API — AI contract-scope & margin monitor + the bill-api spend gate',
    dockerfile: 'apps/burn-api/Dockerfile',
    port: 4022,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // api (can_access preflight + permission resolver), bolt-api (event publish). bill-api is
    // NOT in needs though burn requires BILL_API_INTERNAL_URL at boot: burn and bill are
    // mutually request-time dependent, so listing either in the other's needs risks a cycle
    // (spec 9.6 R2-I8b). The acyclic invariant is held by keeping compose depends_on at
    // migrate/postgres/redis only. BBB_PERMISSIONS_ENFORCE is deliberately absent: Burn's
    // enforcement is a hardcoded boot invariant, not an env-driven setting (issue #83).
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/burn/api/', '/burn/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_SERVICE_SECRET', 'BBB_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL', 'BILL_API_INTERNAL_URL'],
      optional: [
        'DATABASE_READ_URL',
        'BRAID_API_INTERNAL_URL',
        'QDRANT_URL',
        'CORS_ORIGIN',
        'LOG_LEVEL',
        'MAX_DOC_BYTES',
        'MAX_DOC_PAGES',
      ],
    },
  },
  {
    name: 'bursar-api',
    description: 'Bursar API — vendor-side procurement, exclusion diff, spend baseline',
    dockerfile: 'apps/bursar-api/Dockerfile',
    port: 4023,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // BILL_API_INTERNAL_URL deliberately ABSENT: the enforcing spend gate is cut from v1,
    // so there is no bill-api call site. Adding it would be dead configuration that reads
    // as a wired integration.
    // BBB_PERMISSIONS_ENFORCE deliberately ABSENT: enforcement is a hardcoded boot
    // invariant, not an env-driven setting (burn issue #83).
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/bursar/api/', '/bursar/ws'],
    // The env block is NOT optional boilerplate. railway-orchestrator.mjs resolves a missing
    // one to two empty arrays without erroring, so an entry without it deploys with no
    // DATABASE_URL and crash-loops behind a build that looks perfectly healthy.
    env: {
      required: [
        'DATABASE_URL',
        'REDIS_URL',
        'SESSION_SECRET',
        'INTERNAL_SERVICE_SECRET',
        'BBB_API_INTERNAL_URL',
        'BOLT_API_INTERNAL_URL',
      ],
      optional: [
        'DATABASE_READ_URL',
        'BRAID_API_INTERNAL_URL',
        'CORS_ORIGIN',
        'LOG_LEVEL',
        'MAX_DOC_BYTES',
        'MAX_DOC_PAGES',
        'BURSAR_LLM_TIMEOUT_MS',
        'BURSAR_ENGINE_TIMEOUT_MS',
      ],
    },
  },
  {
    name: 'book-api',
    description: 'Book API — calendar events, booking pages, meetings',
    dockerfile: 'apps/book-api/Dockerfile',
    port: 4012,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/book/api/', '/meet/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL', 'PUBLIC_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
        'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
      ],
    },
  },
  {
    name: 'blank-api',
    description: 'Blank API — forms, submissions, public form portal',
    dockerfile: 'apps/blank-api/Dockerfile',
    port: 4013,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/blank/api/', '/forms/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: ['CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'PUBLIC_FORM_RATE_LIMIT', 'PUBLIC_FORM_RATE_WINDOW_MS', 'PUBLIC_URL'],
    },
  },
  {
    name: 'bill-api',
    description: 'Bill API — invoices, payments, expenses',
    dockerfile: 'apps/bill-api/Dockerfile',
    port: 4014,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api'],
    public_paths: ['/bill/api/', '/invoice/'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL', 'PUBLIC_URL'],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET',
        // Burn pre-transaction spend gate (Burn spec 9.2). All four are OPTIONAL: with
        // BURN_API_INTERNAL_URL unset the gate is absent and every expense posts, which is
        // the documented no-op. They still need ENV_HINTS entries -- hintFor() returns
        // { kind: 'unknown' } for anything unlisted and railway-orchestrator.mjs silently
        // OMITS an unknown optional var, which would leave the flagship gate switched off
        // in production with no signal anywhere.
        'BURN_API_INTERNAL_URL', 'BURN_PRECHECK_TIMEOUT_MS',
        'BURN_PRECHECK_BREAKER_THRESHOLD', 'BURN_PRECHECK_BREAKER_PROBE_MS',
      ],
    },
  },
  {
    name: 'blueprint-api',
    description: 'Blueprint API — structured diagrams (nodes, edges, ELK layout, versions, cross-product entity links)',
    dockerfile: 'apps/blueprint-api/Dockerfile',
    port: 4015,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/blueprint/api/', '/blueprint/ws'],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL'],
      optional: ['CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'BOLT_API_INTERNAL_URL', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'PUBLIC_URL'],
    },
  },
  {
    name: 'bureau-api',
    description: 'Bureau API — virtual floors, rooms, presence aggregation, knocks, summons (teleport), LiveKit token minting, and the WS hub',
    dockerfile: 'apps/bureau-api/Dockerfile',
    // Container-internal port. Shares 4015 with blueprint-api; each container
    // runs in its own network namespace and nginx routes by upstream hostname.
    port: 4015,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: ['postgres', 'redis', 'api', 'bolt-api'],
    public_paths: ['/bureau/api/', '/bureau/ws'],
    env: {
      required: [
        'DATABASE_URL',
        'REDIS_URL',
        'SESSION_SECRET',
        'BBB_API_INTERNAL_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'LIVEKIT_HOST',
      ],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        // Browser-facing signaling URL the bureau call widget hands to
        // clients. Without it bureau-api defaults to ws://localhost:7880 and
        // calls cannot connect on Railway. Resolves to the relative
        // /livekit-ws path (same-origin wss via nginx).
        'LIVEKIT_URL',
        'BOLT_API_INTERNAL_URL',
        'BOOK_INTERNAL_URL', 'BOARD_INTERNAL_URL', 'BRIEF_INTERNAL_URL',
        'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
      ],
    },
  },
  {
    name: 'bin-api',
    description: 'Bin API — DAM storage backbone + structured-data editor',
    dockerfile: 'apps/bin-api/Dockerfile',
    port: 4016,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // Bin writes bytes straight to the object store (getMediaDriver), so it
    // needs minio in addition to postgres/redis/api.
    needs: ['postgres', 'redis', 'minio', 'api'],
    public_paths: ['/bin/api/', '/bin/ws'],
    env: {
      required: [
        'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
      ],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'PUBLIC_URL',
        'UPLOAD_MAX_FILE_SIZE', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
        'BOLT_API_INTERNAL_URL', 'BIN_SECRETS_KEY', 'BIN_SECRETS_KEY_ID',
      ],
    },
  },
  {
    name: 'bay-api',
    description: 'Bay API — media review & approval (annotations, decisions, public guest links)',
    dockerfile: 'apps/bay-api/Dockerfile',
    port: 4017,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // Bay streams canonical bytes itself for the public guest-review surface,
    // so it needs minio in addition to postgres/redis/api/bin-api.
    needs: ['postgres', 'redis', 'minio', 'api', 'bin-api'],
    public_paths: ['/bay/api/', '/bay/ws'],
    env: {
      required: [
        'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
      ],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'PUBLIC_URL',
        'BIN_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL',
        'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
      ],
    },
  },
  {
    name: 'blip-api',
    description: 'Blip API — realtime + public ingest satellite',
    dockerfile: 'apps/blip-api/Dockerfile',
    port: 4018,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    // Blip shares Bin's object store and posts events to Bolt, so it needs
    // minio in addition to postgres/redis/api.
    needs: ['postgres', 'redis', 'minio', 'api'],
    public_paths: ['/blip/api/', '/blip/ingest/', '/blip/ws'],
    env: {
      required: [
        'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'BBB_API_INTERNAL_URL',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        'BLIP_INGEST_PEPPER',
      ],
      optional: [
        'CORS_ORIGIN', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET', 'PUBLIC_URL',
        'BIN_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL',
        'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
      ],
    },
  },
  {
    name: 'mcp-server',
    description: 'MCP Protocol Server — tool orchestration for AI agents',
    dockerfile: 'apps/mcp-server/Dockerfile',
    port: 3001,
    healthcheck: '/health',
    start_command: 'node dist/server.js',
    required: true,
    needs: [
      'api', 'helpdesk-api', 'banter-api', 'beacon-api', 'brief-api',
      'bolt-api', 'bearing-api', 'board-api', 'bond-api', 'blast-api',
      'bench-api', 'book-api', 'blank-api', 'bill-api', 'blueprint-api',
      'bin-api', 'bay-api', 'blip-api', 'redis',
    ],
    public_paths: ['/mcp/'],
    env: {
      required: ['MCP_TRANSPORT', 'API_INTERNAL_URL', 'REDIS_URL'],
      optional: [
        'HELPDESK_API_URL', 'BANTER_API_URL', 'BEACON_API_URL', 'BRIEF_API_URL', 'BOLT_API_URL',
        'BEARING_API_URL', 'BOARD_API_URL', 'BOND_API_URL', 'BLAST_API_URL',
        'BOOK_API_URL', 'BENCH_API_URL', 'BILL_API_URL', 'BLANK_API_URL',
        'BLUEPRINT_API_URL', 'BUREAU_API_URL', 'BIN_API_URL', 'BAY_API_URL', 'BLIP_API_URL',
        // BASIS_API_URL + BRAID_API_URL are present in docker-compose.yml but were
        // missing here (pre-existing gap, spec 9.5/IK2); BULWARK_API_URL is the new one.
        'BASIS_API_URL', 'BRAID_API_URL', 'BULWARK_API_URL', 'BURN_API_URL', 'BURSAR_API_URL',
        'MCP_AUTH_REQUIRED', 'LOG_LEVEL', 'INTERNAL_SERVICE_SECRET',
        'MCP_INTERNAL_API_TOKEN',
      ],
    },
  },
  {
    name: 'worker',
    description: 'Background job processor (BullMQ) — email, exports, sprint close',
    dockerfile: 'apps/worker/Dockerfile',
    port: null, // no HTTP listener
    healthcheck: null,
    start_command: 'node dist/worker.js',
    required: true,
    needs: ['postgres', 'redis', 'minio'],
    public_paths: [],
    env: {
      required: ['DATABASE_URL', 'REDIS_URL'],
      optional: [
        'WORKER_CONCURRENCY', 'LOG_LEVEL',
        'INTERNAL_SERVICE_SECRET',
        // The worker's bolt-execute job POSTs to mcp-server's internal
        // /tools/call to run MCP-tool actions (apps/worker/src/jobs/
        // bolt-execute.job.ts:352 reads MCP_INTERNAL_URL, :267 sends the shared
        // INTERNAL_SERVICE_SECRET). Without MCP_INTERNAL_URL it falls back to
        // http://mcp-server:3001 — wrong host AND port on Railway — so Bolt
        // automations with MCP-tool actions silently fail. env-hints computes it.
        'MCP_INTERNAL_URL',
        'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
        // worker reads EMAIL_FROM (apps/worker/src/env.ts:10) — the single
        // canonical SMTP from-address fallback (the shared @bigbluebam/smtp-
        // resolver uses env.EMAIL_FROM; the real source of truth is the UI →
        // system_settings.smtp_from).
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM',
        // worker BUILDS the outbound email tracking links and Slack-import
        // deep-links — without these it emits http://localhost/t/... pixels and
        // /unsub/... links in real campaign mail. Code: blast-send.job.ts:182,
        // 259-260; slack-import.job.ts:746.
        'TRACKING_BASE_URL', 'PUBLIC_URL',
        // worker vector-sync / brief-embed jobs read QDRANT_URL (+ optional
        // QDRANT_API_KEY for managed Qdrant). beacon-vector-sync.job.ts:49-50.
        // The Braid engine jobs also embed via the platform llm-provider
        // (BBB_API_INTERNAL_URL) and re-embed into Qdrant (spec 9.2).
        'QDRANT_URL', 'QDRANT_API_KEY', 'BBB_API_INTERNAL_URL',
        // braid-proposal-reconcile drives approved/rejected proposals through
        // braid-api's single merge executor (spec §4.6); braid-match-on-ingest /
        // braid-rescan need no braid-api URL (they read source schemas directly).
        'BRAID_API_INTERNAL_URL',
        // The 7 bulwark-* jobs invoke the engine over bulwark-api's internal
        // routes (Bulwark spec §4 / §9.2).
        'BULWARK_API_INTERNAL_URL',
        // BURN_API_INTERNAL_URL is set on the worker in docker-compose.yml but was missing
        // from this catalog entry, so on Railway the worker's burn call sites resolved to
        // nothing. Pre-existing gap, recorded and fixed here rather than left.
        // BURSAR_API_INTERNAL_URL is the same transport for Bursar's internal event inbox.
        'BURN_API_INTERNAL_URL', 'BURSAR_API_INTERNAL_URL',
        // Lets the daily turn-cert-expiry watchdog warn before the LiveKit
        // TURN cert lapses; no-op until set (format turn.example.com:port).
        'LIVEKIT_TURN_CHECK_TARGET',
      ],
    },
  },
  {
    name: 'voice-agent',
    description: 'AI voice agent (LiveKit Agents SDK)',
    dockerfile: 'apps/voice-agent/Dockerfile',
    port: 4003,
    healthcheck: '/health',
    start_command: null, // uses Dockerfile CMD
    required: false,
    needs: ['redis', 'livekit'],
    public_paths: [],
    env: {
      required: ['LIVEKIT_URL', 'REDIS_URL'],
      optional: [],
    },
  },
  {
    name: 'site',
    description: 'Marketing site (static)',
    dockerfile: 'infra/site/Dockerfile',
    port: 3000,
    healthcheck: '/',
    start_command: null,
    required: true,
    needs: [],
    public_paths: [], // proxied by `frontend` at `/`
    env: { required: [], optional: [] },
  },
  {
    name: 'frontend',
    description: 'Public nginx ingress — serves all SPAs and proxies APIs',
    dockerfile: 'apps/frontend/Dockerfile',
    port: 8080,
    // NOT '/'. On Railway the `/` location proxies to the `site` upstream, and
    // Railway runs the deploy healthcheck BEFORE the new container has private-
    // network access to sibling services — so a `/` healthcheck fails
    // deterministically ("service unavailable" for the whole window) and the
    // deploy rolls back to the old image. That silently froze the frontend at
    // its Jun-25 build (no /blip/ routes) even though every build SUCCEEDED.
    // `/b3/` is served straight off disk (alias + try_files, no upstream), so it
    // returns 200 the moment nginx is up — a dependency-free ingress health
    // signal. See docs/deploy/railway-auto-deploy.md.
    healthcheck: '/b3/',
    start_command: null,
    required: true,
    is_public_ingress: true, // single externally-exposed service
    // Profile selection happens at container start via the entrypoint script
    // in infra/nginx/entrypoint.sh, NOT at build time. One image works for
    // docker-compose, Railway, and bare docker. See apps/frontend/Dockerfile.
    // Additional watch patterns: changes under infra/nginx/ rebuild the
    // frontend image because both nginx config profiles are COPY'd in.
    extra_watch_patterns: ['infra/nginx/**'],
    needs: [
      'api', 'helpdesk-api', 'banter-api', 'beacon-api', 'brief-api',
      'bolt-api', 'bearing-api', 'board-api', 'bond-api', 'blast-api',
      'bench-api', 'basis-api', 'braid-api', 'bulwark-api', 'burn-api', 'bursar-api', 'book-api', 'blank-api', 'bill-api', 'blueprint-api',
      'bureau-api', 'mcp-server', 'site',
    ],
    public_paths: ['/', '/b3/', '/helpdesk/', '/banter/', '/beacon/', '/brief/', '/bolt/', '/bearing/', '/board/', '/bond/', '/blast/', '/bench/', '/basis/', '/braid/', '/bulwark/', '/burn/', '/bursar/', '/book/', '/blank/', '/bill/', '/blueprint/', '/bureau/', '/blip/', '/bin/', '/bay/'],
    env: { required: [], optional: ['HTTP_PORT', 'HTTPS_PORT'] },
  },
];

// ─── One-shot jobs ───────────────────────────────────────────────────

export const JOB_SERVICES = [
  {
    name: 'migrate',
    description: 'SQL migration runner — reuses api image, runs once and exits',
    dockerfile: 'apps/api/Dockerfile',
    start_command: 'node dist/migrate.js',
    required: true,
    needs: ['postgres'],
    env: {
      required: ['DATABASE_URL'],
      optional: ['MIGRATIONS_DIR'],
    },
  },
];

// ─── Infrastructure services ─────────────────────────────────────────
//
// `managed_on_railway: true` → use Railway's managed plugin (first-class, no
// volume needed). For everything else we deploy the upstream image as a
// regular Railway service backed by a persistent volume.

export const INFRA_SERVICES = [
  {
    name: 'postgres',
    description: 'PostgreSQL 16 database',
    image: 'postgres:16-alpine',
    port: 5432,
    managed_on_railway: true,
    required: true,
    volume: null, // managed
    // Connection ceiling. docker-compose.yml runs this image with
    //   postgres -c max_connections=200 -c shared_buffers=512MB
    // because the stock 100 is oversubscribed across 20+ API services, each holding a
    // write pool plus an optional read pool. Exhaustion does NOT present as a fault in
    // whichever service crossed the line; it presents as `too many clients already` in an
    // unrelated app, historically Bond or Bill.
    //
    // ⚠ NOT YET APPLIED ON RAILWAY. Railway Postgres is a MANAGED plan
    // (managed_on_railway: true above), so this file cannot set it and the deploy adapters
    // do not touch managed-plan parameters. Until an operator raises the connection limit
    // on the managed plan to match, the local fix is cosmetic and production keeps the
    // stock ceiling. Recorded here so it is visible in the catalog rather than living only
    // in a build report.
    tuning: {
      max_connections: 200,
      shared_buffers: '512MB',
      applied_locally: true,
      applied_on_railway: false,
    },
  },
  {
    name: 'redis',
    description: 'Redis 7 (sessions, cache, pubsub, queues)',
    image: 'redis:7-alpine',
    port: 6379,
    managed_on_railway: true,
    required: true,
    volume: null,
  },
  {
    name: 'minio',
    description: 'MinIO S3-compatible object storage',
    image: 'minio/minio:latest',
    dockerfile: 'infra/railway/minio/Dockerfile', // passthrough wrapper
    port: 9000,
    console_port: 9001,
    managed_on_railway: false,
    required: true,
    volume: { mount_path: '/data', size_gb: 10 },
    env: {
      required: ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'],
      optional: [],
    },
  },
  {
    name: 'qdrant',
    description: 'Qdrant vector database (Beacon/Brief/Bond semantic search)',
    image: 'qdrant/qdrant:latest',
    dockerfile: 'infra/railway/qdrant/Dockerfile',
    port: 6333,
    managed_on_railway: false,
    required: true,
    volume: { mount_path: '/qdrant/storage', size_gb: 5 },
    env: { required: [], optional: [] },
  },
  {
    name: 'livekit',
    description: 'LiveKit SFU (voice/video in Banter and Board)',
    image: 'livekit/livekit-server:latest',
    dockerfile: 'infra/railway/livekit/Dockerfile',
    port: 7880,
    rtc_port: 7881,
    managed_on_railway: false,
    required: false,
    volume: null, // stateless — config is baked into the image
    env: {
      required: ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
      // TURN-TLS makes public-internet calls work; all operator-supplied
      // (cert/DNS/domain), surfaced by the post-deploy LiveKit checklist.
      // INTERNAL_SERVICE_SECRET lets the container post its boot topology
      // report (LIVEKIT_RAILWAY_BOOT / _NO_TURN) to the platform log.
      optional: [
        'LIVEKIT_TURN_DOMAIN', 'LIVEKIT_TURN_TLS_PORT',
        'LIVEKIT_TURN_CERT_PEM', 'LIVEKIT_TURN_KEY_PEM',
        'INTERNAL_SERVICE_SECRET',
      ],
    },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────

export function getRequiredAppServices() {
  return APP_SERVICES.filter((s) => s.required);
}

export function getOptionalAppServices() {
  return APP_SERVICES.filter((s) => !s.required);
}

export function getAllAppServices() {
  return APP_SERVICES;
}

export function getManagedInfra() {
  return INFRA_SERVICES.filter((i) => i.managed_on_railway);
}

export function getSelfHostedInfra() {
  return INFRA_SERVICES.filter((i) => !i.managed_on_railway);
}

export function findService(name) {
  return (
    APP_SERVICES.find((s) => s.name === name) ??
    INFRA_SERVICES.find((s) => s.name === name) ??
    JOB_SERVICES.find((s) => s.name === name) ??
    null
  );
}

// ─── Back-compat: legacy exports used by older callers ──────────────
// Several scripts still import `SERVICES` and `INFRASTRUCTURE` from the
// previous version of this file. Keep them as thin shims so nothing breaks.

export const SERVICES = APP_SERVICES.map((s) => ({
  name: s.name,
  port: s.port,
  dockerfile: s.dockerfile,
  required: s.required,
  description: s.description,
}));

export const INFRASTRUCTURE = INFRA_SERVICES.map((i) => ({
  name: i.name,
  image: i.image,
  port: i.port,
  required: i.required,
  managed: i.managed_on_railway,
  description: i.description,
}));

export const APP_URLS = {
  'b3': { label: 'Bam (Project Management)', path: '/b3/' },
  'helpdesk': { label: 'Helpdesk', path: '/helpdesk/' },
  'banter': { label: 'Banter (Messaging)', path: '/banter/' },
  'beacon': { label: 'Beacon (Knowledge Base)', path: '/beacon/' },
  'brief': { label: 'Brief (Documents)', path: '/brief/' },
  'bolt': { label: 'Bolt (Automations)', path: '/bolt/' },
  'bearing': { label: 'Bearing (Goals & OKRs)', path: '/bearing/' },
  'board': { label: 'Board (Whiteboards)', path: '/board/' },
  'bond': { label: 'Bond (CRM)', path: '/bond/' },
  'blast': { label: 'Blast (Email Campaigns)', path: '/blast/' },
  'bench': { label: 'Bench (Analytics)', path: '/bench/' },
  'book': { label: 'Book (Calendar)', path: '/book/' },
  'blank': { label: 'Blank (Forms)', path: '/blank/' },
  'bill': { label: 'Bill (Invoicing)', path: '/bill/' },
  'blueprint': { label: 'Blueprint (Diagrams)', path: '/blueprint/' },
  'bureau': { label: 'Bureau (Virtual Office)', path: '/bureau/' },
  'mcp': { label: 'MCP Server', path: '/mcp/' },
};

export function getRequiredServices() {
  return SERVICES.filter((s) => s.required);
}

export function getOptionalServices() {
  return SERVICES.filter((s) => !s.required);
}

export function getRequiredInfra() {
  return INFRASTRUCTURE.filter((i) => i.required);
}

export function getOptionalInfra() {
  return INFRASTRUCTURE.filter((i) => !i.required);
}
