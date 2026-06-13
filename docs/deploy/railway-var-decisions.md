# Railway deploy variable decisions (code-verified)

Every value the deploy sets is decided here **against the actual consuming
code**, not against memory, docker-compose, or assumption. This exists because
on 2026-06-12 an assumed value (`LIVEKIT_WS_URL=/livekit-ws`, inferred from
docker-compose) broke banter calling on prod — the consuming code returns the
value *verbatim* to the LiveKit SDK, which rejects a relative path.

Format per row: **what the consuming code does (file:line)** → **decision**.

---

## LiveKit — browser signaling URL

The single hardest case, because two services consume "the browser ws URL"
differently and a third (voice-agent) uses the same var name server-side.

### `LIVEKIT_WS_URL` (banter-api → browser)
- **Code:** `apps/banter-api/src/services/livekit-url.ts:37-55`. `resolveLivekitWsUrl()`:
  if `LIVEKIT_WS_URL` is set to a non-default value it is returned **verbatim**
  to the browser (line 38-41); otherwise it derives `wss://<host>:7880` from the
  request. The browser hands this straight to the LiveKit JS SDK, which requires
  an **absolute** `ws(s)://host[/path]` URL.
- **Why not relative:** a relative `/livekit-ws` is returned verbatim and the SDK
  cannot parse it → calling fails. This is the 2026-06-12 incident.
- **Why not the `:7880` derivation:** Railway does not expose the LiveKit
  container's `7880` publicly (only the nginx ingress), so `wss://domain:7880`
  is unreachable. The explicit value is mandatory on Railway.
- **DECISION:** absolute **`wss://<public-domain>/livekit-ws`** (nginx proxies
  `/livekit-ws` → `livekit:7880`). `public`-kind so it derives from the deploy's
  public domain and is operator-overridable (external LiveKit endpoint).

### `LIVEKIT_URL` (bureau-api → browser)
- **Code:** `apps/bureau-api/src/services/calling-settings.service.ts:46` returns
  `env.LIVEKIT_URL` as `livekitUrl`, surfaced to the browser as `ws_url`
  (`apps/bureau-api/src/routes/livekit.routes.ts:177,297`). The bureau client
  then calls `resolveWsUrl()` (`packages/bureau-client/src/active-room.ts:210-215`):
  an absolute URL (not starting with `/`) is passed through **verbatim**; a
  relative `/livekit-ws` is resolved against `window.location` origin.
- **Consequence:** bureau accepts **both** absolute and relative. banter accepts
  **only** absolute. The one value correct for both is absolute.
- **DECISION:** absolute **`wss://<public-domain>/livekit-ws`** (same as banter).
  `public`-kind. Verified bureau passes absolute through unchanged.

### `LIVEKIT_HOST` (banter-api / bureau-api → server-side SDK)
- **Code:** `apps/banter-api/src/services/recording.ts:12,22` constructs
  `RoomServiceClient` / `EgressClient` with `env.LIVEKIT_HOST` — a server-to-SFU
  call originating **inside** Railway's private network.
- **DECISION:** internal **`http://livekit.railway.internal:7880`** (`computed`).
  Distinct from the browser URLs above on purpose: server uses internal DNS,
  browser uses the public proxy path.

### `LIVEKIT_URL` on board-api — UNUSED
- **Code:** `grep -rni livekit apps/board-api/src` → **0 matches**. board-api does
  not read `LIVEKIT_URL` (or any LiveKit var) at all.
- **DECISION:** leave the (harmless) catalog entry; the global value change has no
  effect on board-api. Candidate for catalog cleanup later — not changed now to
  avoid scope creep.

### `LIVEKIT_URL` on voice-agent — server-side, NOT deployed on Railway
- **Code:** `apps/voice-agent/src/pipeline.py:175` `room.connect(self._config.livekit_url, token)`
  and `api.py:184` `LiveKitAPI(livekit_url, ...)` — a Python server process that
  needs an absolute **internal** SFU URL, NOT the browser path.
- **DECISION:** voice-agent is excluded from the Railway deploy plan
  (`railway-orchestrator.mjs` filters it), so the global browser-facing
  `LIVEKIT_URL` value never reaches it. **Known limitation:** anyone manually
  deploying voice-agent on Railway must override `LIVEKIT_URL` to
  `ws://livekit.railway.internal:7880`. Documented, not auto-handled.

---

## Internal service URLs — port

- **Code:** `apps/api/src/server.ts:334`, `apps/banter-api/src/server.ts:199`,
  `apps/bureau-api/src/server.ts:183` all `fastify.listen({ port: env.PORT })`.
  Railway injects `PORT=8080` into every container.
- **DECISION:** every internal `*.railway.internal` URL pointing at a Bam app
  service uses **`:8080`** (`computed`, `RAILWAY_DYNAMIC_PORT`), regardless of the
  service's docker-compose nominal port. Third-party images (livekit `7880`,
  minio `9000`, qdrant `6333`) keep their own ports — they ignore `$PORT`.

## mcp-server app-URL fan-out — the `/v1` suffix

The `/v1` belongs in the base URL **iff the client requests bare resource paths
while the target api mounts its routes under a `/v1` prefix.** It is per-service
and must be checked from BOTH sides — the client path AND the api's route prefix.
Do NOT infer it from docker-compose: the compose values had a latent Beacon bug
(below), so cross-checking against them is circular.

- **Clients that carry the prefix in the request path → base omits `/v1`:**
  - `BANTER_API_URL` — `banter-tools.ts` requests `/v1/channels`, `/v1/users/…`.
  - `HELPDESK_API_URL` — `helpdesk-tools.ts` requests `/helpdesk/tickets`,
    `/helpdesk/settings`, `/v1/helpdesk-users/upsert` (each path self-prefixed).
- **Clients that request bare resource paths → base MUST carry `/v1`** (because
  every one of these apis registers routes with `prefix: '/v1'`, verified in each
  `apps/<svc>-api/src/server.ts`):
  - `BEACON_API_URL` — `beacon-tools.ts` requests bare `/beacons`; beacon-api
    mounts `/v1` (`server.ts:104-112`). **Compose + env-hints had dropped the
    `/v1`, so the 30 Beacon MCP tools 404'd on every stack incl. prod.** The
    `env.ts` default (`…:4004/v1`) was the correct one all along; the override lost
    it. **FIXED** 2026-06-13 in `docker-compose.yml`, `env-hints.mjs`, and pinned
    by a `railway-orchestrator.test.mjs` assertion.
  - `BRIEF_API_URL` — `brief-tools.ts` requests bare `/documents`; brief-api
    mounts `/v1`. **Was absent from the mcp-server catalog optional list AND from
    env-hints entirely, so reconcile never set it and prod fell back to the
    `localhost:4005` default → Brief MCP tools failed on Railway.** **FIXED**
    2026-06-13: added to `services.mjs` mcp-server `optional` + `env-hints.mjs`.
  - `BOLT/BEARING/BOARD/BOND/BLAST/BOOK/BENCH/BILL/BLANK/BLUEPRINT/BUREAU` — all
    bare-path clients against `/v1`-mounted apis (verified by sweep); base `/v1`.
- **DECISION:** `BANTER_API_URL`, `HELPDESK_API_URL` →
  `http://<svc>.railway.internal:8080` (no `/v1`). Every other satellite —
  `BEACON`, `BRIEF`, `BOLT`, `BEARING`, `BOARD`, `BOND`, `BLAST`, `BOOK`, `BENCH`,
  `BILL`, `BLANK`, `BLUEPRINT`, `BUREAU` → `http://<svc>.railway.internal:8080/v1`.

## `MCP_INTERNAL_API_TOKEN`
- **Code:** `apps/mcp-server/src/env.ts:52` + `routes/tools-call.ts` — gates the
  internal `POST /tools/call` route; absent/short → 503. It must be a real
  `bbam_svc_` service-account token (minted against the live api), so it cannot be
  randomly generated.
- **DECISION:** `user`-kind with a note to mint it post-deploy; surfaced, not
  auto-generated.

---

## SMTP "from" address — per-service var name

The deploy prompt collects one `SMTP_FROM`, but each service reads a differently
named var. Verified against each service's `env.ts`:

| Service | Var the code reads | Evidence | Catalog status |
|---|---|---|---|
| api | `SMTP_FROM` | `apps/api/src/env.ts:78`; `lib/email-queue.ts:74` maps it to its internal EMAIL_FROM | listed ✓ |
| helpdesk-api | `EMAIL_FROM` | `apps/helpdesk-api/src/env.ts:47` | listed ✓ |
| blast-api | `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | `apps/blast-api/src/env.ts:32-33` | listed ✓ |
| worker | `EMAIL_FROM` | `apps/worker/src/env.ts:10`; used in `jobs/blast-send.job.ts:252`, `jobs/helpdesk-email-notify.job.ts:143` | **listed `SMTP_FROM` only — GAP** |

- **DECISION (consolidated to ONE name):** the from-address is `system_settings.smtp_from`
  (UI) with a **single** env fallback, `EMAIL_FROM` — the only name the shared
  `@bigbluebam/smtp-resolver` reads (`packages/smtp-resolver/src/index.ts:38,153`).
  Concretely:
  - **api** now reads `EMAIL_FROM` (was `SMTP_FROM`, which it remapped anyway) —
    `apps/api/src/env.ts`, `lib/email-queue.ts:74`, `routes/system-settings.routes.ts:528`.
  - **blast-api**'s entire SMTP block was **dead** (it sends nothing; the worker
    does) — removed from `apps/blast-api/src/env.ts` and the catalog.
  - **worker** gets `EMAIL_FROM` in its catalog (it reads it; was missing).
  - The deploy prompt still collects one `SMTP_FROM` and aliases it to
    `EMAIL_FROM` (`extractUserIntegrationsFromEnvConfig`).
  Net: four names (`SMTP_FROM` / `EMAIL_FROM` / `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME`)
  collapsed to one (`EMAIL_FROM`), with the DB/UI as the real source of truth.

---

## Exhaustive verification pass — remaining variables

Every other deploy-set variable was verified against its consumer. Summary
(full evidence gathered 2026-06-13):

**Public-URL family — all values correct as-is.** `<frontend-public-url>` resolves
to a bare origin with no trailing slash (`scripts/deploy/shared/public-url.mjs:47-54`).
- `CORS_ORIGIN` = bare origin — every API does `env.CORS_ORIGIN.split(',')` into
  `@fastify/cors` and the WS gate does an exact `Set.has(origin)` match
  (`apps/api/src/plugins/websocket.ts:179`); a path/trailing-slash would never
  match the browser `Origin`. ✓
- `FRONTEND_URL` = `<root>/b3` — `apps/api/src/lib/urls.ts:28-35` + the raw
  `slack-notify.service.ts:91` consumer require the `/b3` mount. ✓ (api only)
- `PUBLIC_URL` / `TRACKING_BASE_URL` = bare origin — consumers strip a trailing
  slash then append their own mount (`/book`, `/bill`, `/t/`, `/unsub/`). A path
  here would double the mount or break the open-pixel/unsub links. ✓

**Gaps found & fixed (service reads it, catalog didn't set it):**
- **worker** was missing `TRACKING_BASE_URL` + `FRONTEND_URL` — it builds the
  outbound email tracking pixel / click / unsubscribe links
  (`apps/worker/src/jobs/blast-send.job.ts:182,259-260`); without them real
  campaign mail shipped `http://localhost/t/...` links. **Added.**
- **worker** + **brief-api** were missing `QDRANT_URL`; **beacon-api / brief-api /
  worker** were missing the optional `QDRANT_API_KEY` (read in
  `beacon-vector-sync.job.ts:49-50`, `document.routes.ts:175,191`). **Added**
  (`QDRANT_API_KEY` is `user`-kind, empty by default — the bundled Qdrant has no
  auth; only managed Qdrant needs it).

**Footgun removed:** `MCP_PORT=3001` was emitted by env-hints but would WIN over
Railway's injected `PORT=8080` (`apps/mcp-server/src/env.ts:8-12`) and break the
ingress healthcheck if ever applied. It was never in the mcp-server catalog (so
never applied), but it's now removed from the hints so it can't be reintroduced.

**Doc fix:** the generated-secret notes said `openssl rand -hex 16` (= exactly the
32-char `z.string().min(32)` floor — fragile). The actual generator already uses
`randomHex(32)` = 64 chars (`secrets.mjs:21-23`); notes corrected to `hex 32`.

**Verified correct, no change:** `DATABASE_URL`/`DATABASE_READ_URL`/`REDIS_URL`
(plugin refs), `S3_*` (port 9000, `bigbluebam-uploads`, `us-east-1`), `QDRANT_URL`
(6333), `MINIO_ROOT_USER/PASSWORD`, `LIVEKIT_API_KEY/SECRET` (must match across
livekit+banter+board+bureau+voice-agent), `LIVEKIT_WEBHOOK_URL`
(`/v1/webhooks/livekit` on banter-api `webhook.routes.ts:153`), `MCP_TRANSPORT`/
`MCP_AUTH_REQUIRED`, `NODE_ENV`, and all rate-limit / timeout literals.

## Deep-link base — `FRONTEND_URL` removed, standardized on `PUBLIC_URL`

`FRONTEND_URL` was retired. It carried a different meaning per service (api
expected `<root>/b3`, beacon expected `<root>/beacon` baked in, board/bearing/brief
expected the bare `<root>` and appended their own mount), so one global value
could never serve them all and the deploy only set it on api — leaving
beacon/board/bearing/brief emitting `http://localhost/...` deep-links on Railway.

The fix standardizes on the **bare site root** in `PUBLIC_URL` (the convention
book/bill/bond/blank already used), with every backend appending its own SPA
mount:
- api `lib/urls.ts` → `PUBLIC_URL` + `/b3` (still tolerant of a stray `/b3`);
  `slack-notify` now delegates to that one builder.
- beacon `lib/urls.ts` → appends `/beacon` (was the lone outlier that baked the
  mount into the var).
- board/bearing/brief → already appended their mount; just read `PUBLIC_URL`.
- bureau's `FRONTEND_URL` was dead (no consumer) — removed.
- env-hints drops `FRONTEND_URL`; `PUBLIC_URL` (bare `<frontend-public-url>`) is
  set on every deep-link service in the catalog. secrets.mjs/docker-compose updated.

One value now serves every app, no per-service override machinery. Code-verified
against each consumer; api + 5 satellite apps typecheck clean, all tests green.
