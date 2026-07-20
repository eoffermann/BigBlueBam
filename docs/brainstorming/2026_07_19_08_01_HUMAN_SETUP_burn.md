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

## 2. Local Docker disk / frontend image (LOCAL ENV - already worked around)

During Phase 4 the Docker WSL2 VM ran **out of disk** (196GB images + 126GB build cache),
which made Docker serve stale cached images (the frontend image lacked the burn SPA, and
api/mcp-server lagged burn's permissions/tools). This is a host-environment issue, not a
code defect - the Dockerfile is correct and the SPA builds cleanly on the host and in CI.

- [x] Reclaimed ~140GB of dangling images + build cache (no volumes touched); rebuilt
      api + mcp-server; rebuilt the frontend image now that disk is free.
- [ ] Ongoing: keep the Docker Desktop disk from filling (`docker system prune` periodically).
      If `/burn/` ever 404s after a fresh `docker compose up`, the frontend image is stale -
      free disk and `docker compose build frontend && docker compose up -d --force-recreate frontend`.

## 3. Promotion to trunk (STANDING DECISION - not a blocker)

- [ ] Burn is built, reviewed, and tested entirely on `suite-brainstorm`. Nothing was merged
      or promoted to `main`/`stable` - that is the maintainer's decision alone.

## Nothing else

No third-party API key, OAuth app, paid provider, or DNS is required to RUN Burn - all its
dependencies are internal (Postgres, Redis, Bin/Bam/Bill via the shared DB, Bond via Braid,
the internal llm-provider, Bolt). The engines, the flagship gate + circuit breaker, workers,
permission catalog, SPA, and infra were all built and wired in-loop.
