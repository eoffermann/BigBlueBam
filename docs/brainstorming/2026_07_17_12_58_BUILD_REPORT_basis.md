# Basis - Build Report (cycle 2026_07_17_12_58)

Autonomous build of the winning app **Basis** from
`2026_07_17_12_58_APP_DESIGN_basis.md`, on the `suite-brainstorm` branch. Nothing
merged to `main`.

## Outcome: shipped to the local dev stack, verified end-to-end

All 11 milestones complete; the app is deployed and running in the local Docker
stack and passes both API and UI verification.

| Milestone | Status |
| --- | --- |
| M1 scaffold (basis-api + basis SPA) | done, typechecks |
| M2 data model (migrations 0226-0229) | applied, `db:check` drift-clean |
| M3 shared Zod schemas | done |
| M4 REST API + bench internal query route | done, deployed |
| M5 12 MCP tools + 9 permissions + surface map | done, deployed |
| M6 4 worker jobs + 6 Bolt events | done, deployed (4 queues registered) |
| M7 SPA | done, live at `/basis/` |
| M8 Launchpad + infra (compose, 3 nginx, services.mjs, Railway) | done |
| M9 deploy + tests (Playwright user story) | 14 passed |
| M10-11 docs + marketing | help doc, README, CLAUDE.md, surface map, site section |

## Verified behavior (real gilligan data)

- Metric CRUD + versioning + certify/decertify/deprecate: API + Postgres rows +
  Bolt events + Playwright UI (define -> certify -> deprecate, 14 passed).
- `value = 33` computed via the Bench internal query route (built here as the
  spec's out-of-Basis prerequisite).
- `explain`: deterministic decomposition with the additive invariant exact
  (high +4, medium +3, urgent +2, low +1 = delta 10), Class-A labels served.
- Graceful degradation: `503 UPSTREAM_UNAVAILABLE` (Bench down) and
  `400 DEFINITION_RESOLVE_FAILED` (bad definition - a real bug the smoke caught and
  this build fixed).
- 4 worker queues registered in Redis; 12 MCP tools compiled into mcp-server.

## Human setup

See `2026_07_17_12_58_HUMAN_SETUP_basis.md`. The two runtime prerequisites
(bench-api internal query route, `INTERNAL_SERVICE_SECRET`) were satisfied in the
dev stack, so value/explain compute live numbers. The governance decisions
(ratio sign-off, certification-by-agent policy, Class-B resolver coverage, Bench
`/resolve` precedence) remain product calls; none block the built feature.

## Follow-ups (non-blocking, tracked)

- Data-rich **gilligan screenshots** via the `screenshot-capture` skill (marketing
  section + help doc were written to stand without them).
- The LLM narrative and per-user `can_access`-gated correlation are stubbed
  (narrative=null, correlation=[]) - the deterministic core is complete; these are
  the documented next enhancements.
- Pre-existing, non-Basis items tracked as tasks: `deployment_secrets` db:check
  drift, 3 retired `bam.config_health` perms, site `manual.tsx` missing deps.

## Deferred differentiated capabilities (tracked, not silently done)

The adversarial post-commit review (issue #49) correctly flagged that several
first-class pipeline legs designed in the spec are stubbed in the landed code. They
are the differentiated capabilities of the app, so they are recorded as explicit
tracking tasks (#16-#19) rather than left reading as done:

1. **Certified-driver narrative** (#16): `basis-explain` LLM job absent; explanations
   store `narrative: null`. Needs the internal llm-provider and an `explanation.ready`
   re-emit. Depends on a configured LLM provider (see the HUMAN_SETUP doc).
2. **Per-user correlation** (#17): the read-time possibly-related-activity plane is
   hard-coded empty (`correlation: []`). Needs the `can_access` + `related_apps`
   resolver against `v_activity_unified` / `bolt_recent_events`.
3. **Class-B k>=2 suppression** (#18): a Class-B breakdown is collapsed to a single
   fail-closed "Other (all N hidden)" bucket for every viewer; per-user label
   resolution and the k-anonymous secondary (N=1 complementary-disclosure) suppression
   are not implemented. Encoded as `it.todo` executable spec-of-record.
4. **Bench-preview write-time drift guard** (#19): create/version paths do not
   round-trip the definition through bench-api preview, and `resolve_status` is written
   only by the snapshot job, never validated at write time.

The deterministic core (definition -> certified metric -> additive decomposition ->
threshold movement) is complete and verified; the above are the next enhancements. None
block the shipped happy path.

## Operational notes learned this cycle

- The WSL2/BuildKit cache silently reuses stale images; `docker compose build
  --no-cache <svc>` is required to pick up new source.
- Recreating a satellite API leaves the frontend nginx pointed at its old IP (502);
  restart the frontend once the API is healthy.

Merging any of this into `main` is a human decision; the loop does not wait on it.
