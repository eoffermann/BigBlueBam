# ui-debug reference — BigBlueBam stack map + smoke cookbook

Everything here is BigBlueBam-specific. The methodology lives in `SKILL.md`;
this file is the lookup you use while walking Layer 2 and running Layer 3.

## Request-path topology

A click in any SPA travels:

```
React control (onClick)
  → handler  (component)
    → hook / mutation  (src/hooks/*, uses the `api` client)
      → api client      (src/lib/api.ts — prepends baseURL, adds X-Org-Id)
        → nginx          (infra/nginx/nginx.conf: location /<app>/api/ → proxy_pass http://<app>-api:PORT/ )
          → Fastify route (apps/<app>-api/src/routes/*.ts — fastify.<method>('<path>', {preHandler}, handler))
            → Drizzle      (db.select/insert/update/delete on schema in apps/<app>-api/src/db/schema)
              → Postgres
```

Each arrow is a contract. The bugs hide where two sides disagree: method, path,
body shape, response field names, or a permission preHandler.

The Bam (`/b3/`) frontend is special: cross-app calls in shared components hit
absolute paths (`/b3/api/...`, `/banter/api/v1/...`) that the **shared** nginx
proxies regardless of which SPA is loaded, and cookies are shared across the
same host. So a component rendered inside `/bond/` can legitimately call
`/b3/api/me/notifications`.

## Per-app api-client baseURL (verify by reading `apps/<app>/src/lib/api.ts`)

The `/v1` segment is **inconsistent** — this is the most common source of
wrong-URL 404s. Treat this table as a starting point and confirm against the
file, because it drifts.

| App (SPA) | api-client baseURL | Backend route prefix |
|---|---|---|
| frontend (Bam, `/b3/`) | `/b3/api` | *(none)* — routes are `/me/...`, `/auth/...` |
| banter | `/banter/api/v1` | `/v1/...` |
| beacon | `/beacon/api/v1` | `/v1/...` |
| bearing | `/bearing/api/v1` | `/v1/...` |
| blueprint | `/blueprint/api/v1` | `/v1/...` |
| board | `/board/api/v1` | `/v1/...` |
| bolt | `/bolt/api/v1` | `/v1/...` |
| bond | `/bond/api/v1` | `/v1/...` |
| brief | `/brief/api/v1` | `/v1/...` |
| bureau | `/bureau/api/v1` | `/v1/...` |
| bench | `/bench/api` | *(none)* |
| bill | `/bill/api` | *(none)* |
| blank | `/blank/api` | *(none)* |
| blast | `/blast/api` | *(none)* |
| book | `/book/api` | *(none)* |
| helpdesk | `/helpdesk/api` | *(none)* |

## Resolving a client call → backend route

nginx `location /<app>/api/ { proxy_pass http://<app>-api:PORT/; }` (note the
trailing slash) **strips `/<app>/api`** and forwards the rest. So:

```
wire path        = baseURL + clientPath               (what the browser requests)
forwarded path   = wire path  minus  "/<app>/api"     (what the service sees)
backend route    must literally equal forwarded path
```

Worked example (banter edit, the real bug from 2026-06-14):
- hook called `api.patch('/channels/${channelId}/messages/${messageId}', …)`
- baseURL = `/banter/api/v1` → wire = `/banter/api/v1/channels/<c>/messages/<m>`
- forwarded = `/v1/channels/<c>/messages/<m>`
- backend routes that exist: `PATCH /v1/messages/:id` (and `POST /v1/channels/:id/messages`).
  **No** `/v1/channels/:id/messages/:id` → 404, swallowed → "Save does nothing."
- Fix: client path `/messages/${messageId}` → forwarded `/v1/messages/:id` ✓.

Shortcut to find the real route:
```sh
grep -rn "fastify.\(get\|post\|patch\|put\|delete\)(" apps/<app>-api/src/routes \
  | grep -iE "messages|bookmarks|<the noun>"
```
Then open the file and read the exact path string + the handler.

## Smoke cookbook (local dev)

### Stack up / rebuild a changed service
```sh
docker compose up -d                                            # bring the stack up
docker compose build <svc> && docker compose up -d --force-recreate <svc>
docker compose restart frontend     # REQUIRED after recreating any *-api: nginx
                                     # caches the upstream container IP; restart re-resolves it
```
Frontend SPA changes (incl. anything in `packages/ui` or `apps/<spa>/src`) compile
into the single `frontend` image: `docker compose build frontend && docker compose up -d --force-recreate frontend`.
**Never `docker compose down -v`** — it wipes the seeded test DB.

### Hitting endpoints (the host redirects HTTP→HTTPS, cert is self-signed)
```sh
curl -sk https://localhost/<app>/api/...           # -k: accept self-signed; or -skL to follow the 301
```

### psql (read-back / assert side effects)
```sh
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SELECT ..."
```

### Service logs (catch swallowed errors — 404s, 42703 column errors, 401/403)
```sh
docker compose logs --tail=80 <app>-api 2>&1 | grep -iE "error|4[0-9][0-9]|42703|PostgresError"
```

### Auth for the smoke test
Most flows need a real session. Options, cheapest first:

1. **bigbluebam MCP server** (already authenticated as a user). Great for
   creating + tearing down test data and as an oracle. Tools are namespaced
   `mcp__bigbluebam__*` (local) / `mcp__bigbluebam-prod__*` (prod — do NOT use for
   local smoke). `get_me` / `get_server_info` confirm who/where you are.
2. **Login → cookie jar**, then replay the UI's exact request:
   ```sh
   curl -skc /tmp/c.txt -X POST https://localhost/b3/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"<seeded user>","password":"<pw>"}'
   # reuse the cookie on the real request:
   curl -sk -b /tmp/c.txt -X PATCH https://localhost/banter/api/v1/messages/<id> \
     -H 'Content-Type: application/json' -H "X-Org-Id: <org-uuid>" \
     -d '{"content":"edited by ui-debug smoke"}'
   ```
   If you don't have credentials for a seeded account, ask the user for a test
   login (or an API key) — don't guess.
3. **API key** (`bbam_` user key): send `Authorization: Bearer <key>` instead of
   the cookie.

**Local-dev auth recipe (verified 2026-06-14).** Seed passwords are inconsistent:
`seed-platform.mjs` users use `dev-password-change-me`, but the Mage/acme demo
users (e.g. `*@mage.io`) ship with **unusable** password hashes (the scenario
never logs them in). When a login 401s with `INVALID_CREDENTIALS`, don't keep
guessing — reset a known user via the CLI, then log in:
```sh
# pick a human user + their org
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -tc \
  "SELECT u.email, o.slug, o.id FROM users u JOIN organizations o ON o.id=u.org_id \
   WHERE u.kind='human' LIMIT 6;"
# reset (password MUST be >= 12 chars)
docker compose exec -T api node dist/cli.js reset-password --email <email> --password 'UiDebugSmoke123!'
# login -> cookie jar
curl -skc /tmp/cj.txt -X POST https://localhost/b3/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"<email>","password":"UiDebugSmoke123!"}'
```
Tables are `organizations` / `organization_memberships` / `users` (users carry
`org_id` directly). Resetting a demo user's password is benign on the seeded dev
DB, but it's residue — **disclose it** in the report (you can't restore an
originally-unusable hash).

**Two curl gotchas that waste a cycle each:**
- **Bodies must be ASCII** — a multibyte char (em-dash `—`, smart quotes) makes
  curl's byte length disagree with `Content-Length` → `FST_ERR_CTP_INVALID_CONTENT_LENGTH`.
  Keep smoke payloads plain ASCII.
- **DELETE with no body**: do NOT send `-H Content-Type:application/json` on a
  bodyless DELETE — Fastify rejects it with `FST_ERR_CTP_EMPTY_JSON_BODY`. Drop
  the header for bodyless requests.
- `python` can be flaky/absent in the Git-Bash shell — extract ids with `sed`
  (`sed -n 's/.*"data":{"id":"\([0-9a-f-]\{36\}\)".*/\1/p'`) rather than relying
  on a JSON one-liner.

`X-Org-Id`: banter and several apps pin the active org via this header (the
client injects `useAuthStore.user.active_org_id`). If a request 404s/empties for
no obvious reason, you're probably missing it. Get the org id from `get_me` or
`SELECT id, slug FROM orgs;`.

### Data setup / teardown — record every id, delete in reverse
Prefer MCP tools or the app's own create endpoints so you exercise real paths.
Example (banter edit/bookmark smoke):
```
# setup
ch  = banter_create_channel(name: "ui-debug-tmp")            -> channel id
msg = banter_post_message(channel_id: ch, content: "before") -> message id
# exercise the EXACT UI request (replay via curl with the session cookie), then
# assert:
banter_get_message(message_id: msg)   # content == "after", is_edited == true
# teardown (reverse order)
banter_delete_message(message_id: msg)
banter_delete_channel(channel_id: ch)
```
If a delete tool doesn't exist for what you created, fall back to `psql` DELETE
scoped by the ids you recorded — and double-check you're only deleting your own
rows. Confirm teardown left nothing behind (`SELECT count(*) ... WHERE id = ...`).

## Checklist crib (per pass)

- [ ] User story written, full effect chain + post-reload state listed
- [ ] Control has a live handler (not a placeholder) — `file:line`
- [ ] handler → hook → api call: method + baseURL + path + body resolved
- [ ] forwarded path matches a real route segment-for-segment — `file:line`
- [ ] route handler performs the real side effect (right table/column)
- [ ] preHandlers won't silently 4xx the actual user
- [ ] response field names == what the component reads
- [ ] stack rebuilt from current code; smoke replays the real request
- [ ] effect asserted via read-back/psql; persistence + 2nd-order surface checked
- [ ] negative/edge path checked where relevant
- [ ] all test data cleaned up; stack left as found
- [ ] verdict: done only if UI→logic proven AND logic verified; else which layer broke
