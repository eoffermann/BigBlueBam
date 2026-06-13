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

- **Code:** the mcp-server tool clients embed `/v1` in their request **paths**, so
  their base URL must NOT include it: `apps/mcp-server/src/tools/banter-tools.ts`
  (`/v1/channels`…), `beacon-tools.ts`, `helpdesk-tools.ts:467` (`/v1/helpdesk-users/upsert`).
  Cross-checked against the proven docker-compose values (`docker-compose.yml`
  mcp-server env): BANTER/BEACON/HELPDESK have **no** `/v1`; the rest carry `/v1`.
- **DECISION:** `BANTER_API_URL`, `BEACON_API_URL`, `HELPDESK_API_URL` →
  `http://<svc>.railway.internal:8080` (no `/v1`). `BUREAU_API_URL`,
  `BLUEPRINT_API_URL`, and the BOLT/BEARING/BOARD/BOND/BLAST/BOOK/BENCH/BILL/BLANK
  family → `…:8080/v1`.

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

- **DECISION:** (1) backfill `EMAIL_FROM` / `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME`
  from the entered `SMTP_FROM` (done in `extractUserIntegrationsFromEnvConfig`);
  (2) **add `EMAIL_FROM` to the worker catalog** so the orchestrator actually
  sets it (a catalog var is only set if it's listed).
