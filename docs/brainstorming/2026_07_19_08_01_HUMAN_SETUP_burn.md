# Burn - human actions required

The Burn build ran headless, then was resumed interactively after the M5 build died at the
M5/M6 boundary. Everything buildable was built and wired. This doc holds ONLY items that
need a human keystroke. Internal engineering was done in-loop and is not listed here.

## 1. Enable the gate in each environment (operator config - NOT a secret)

Burn's flagship gate is **optional by design**: bill-api reads `BURN_API_INTERNAL_URL` and
if it is unset the gate is simply absent (every billable expense posts, fail-open). So the
gate does nothing until an operator opts in.

- [ ] To turn the gate on in an environment, set `BURN_API_INTERNAL_URL=http://burn-api:4022`
      (compose) or the platform-internal burn-api URL (Railway) on the **bill-api** and
      **worker** services, then recreate them. It is already enabled in the local dev `.env`
      for this stack. Verify: `docker compose exec -T bill-api sh -c 'echo $BURN_API_INTERNAL_URL'`
      is non-empty, and an over-envelope billable expense in a `blocking`-mode org returns
      HTTP 409 `BURN_ENVELOPE_EXCEEDED`. Leaving it unset is a safe default (gate absent).

## 2. Local Docker environment (LOCAL ENV - two distinct issues, both worked around)

Two separate Docker Desktop / WSL2 problems surfaced during deploy. Neither is a code defect
- the Dockerfiles are correct, the SPA builds cleanly on the host, and CI/Railway (clean
Docker, no WSL2) build correctly.

**2a. Disk exhaustion (FIXED).** The Docker WSL2 VM ran out of disk (196GB images + 126GB
build cache); postgres could not extend files and Docker served stale api/mcp-server images
(so burn's 22 permissions + MCP tools looked missing). Reclaimed ~140GB of dangling images +
build cache (no volumes touched) and rebuilt api + mcp-server. Resolved.
- [ ] Ongoing: keep the Docker Desktop disk from filling (`docker system prune` periodically).

**2b. The `frontend` image will not pick up the burn SPA (needs a Docker Desktop restart).**
Even `docker compose build --no-cache frontend` (after disk was freed) produces a byte-identical
stale image with NO `/usr/share/nginx/html/burn` - while the `site` image (small `site/` build
context) rebuilds fresh. Root cause: the frontend builds from the **repo-root** context, and
Docker Desktop's WSL2 file share is dropping the newly-added `apps/burn` from that large context
(the large-context truncation noted in CLAUDE.md). Worked around for the live stack: built the
burn SPA on the host (`pnpm --filter @bigbluebam/burn build`) and `docker cp`'d the dist into the
running frontend container, so `http://localhost/burn/` serves 200. That cp is EPHEMERAL - lost
on a frontend recreate.
- [ ] **To bake burn into the frontend image: restart Docker Desktop** (resyncs the WSL2 file
      share), then `docker compose build frontend && docker compose up -d --force-recreate frontend`
      and confirm `docker run --rm --entrypoint sh bigbluebam-frontend -c 'ls /usr/share/nginx/html/burn'`
      lists `index.html` + `assets`. Until then, if `/burn/` 404s after a recreate, re-run:
      `pnpm --filter @bigbluebam/burn build && docker cp apps/burn/dist/. bigbluebam-frontend-1:/usr/share/nginx/html/burn/`.

## 3. Promotion to trunk (STANDING DECISION - not a blocker)

- [ ] Burn is built, reviewed, and tested entirely on `suite-brainstorm`. Nothing was merged
      or promoted to `main`/`stable` - that is the maintainer's decision alone.

## Nothing else

No third-party API key, OAuth app, paid provider, or DNS is required to RUN Burn - all its
dependencies are internal (Postgres, Redis, Bin/Bam/Bill via the shared DB, Bond via Braid,
the internal llm-provider, Bolt). The engines, the flagship gate + circuit breaker, workers,
permission catalog, SPA, and infra were all built and wired in-loop.
