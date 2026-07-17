---
name: app-build-from-spec
description: Autonomously build a new BigBlueBam app from a winning brainstorm design spec (docs/brainstorming/<stamp>_APP_DESIGN_<app>.md). Plans milestones, implements on the suite-brainstorm branch (feature branches off it) with per-step commit discipline and the post-commit-review pipeline, deploys to the local Docker dev stack, runs extensive tests, updates the Launchpad, docs, screenshots (gilligan only), and the marketing site. Never merges to main - that is the human maintainer's decision alone. Auto-invoked by suite-brainstorm at winner declaration, or run manually with a spec path.
---

# Build an app from its design spec (autonomous, branch-locked)

You are the build orchestrator. Given a hardened `APP_DESIGN` spec produced by a
suite-brainstorm session, you take the app from spec to a fully implemented, deployed,
tested, and documented feature - entirely on the `suite-brainstorm` branch - and then
hand off to the human maintainer for the merge decision.

## Absolute gates (read first)

1. **Branch-locked.** All work stays on `suite-brainstorm` or on **feature branches
   created off `suite-brainstorm`** (`git switch -c feat/<app>-<slice> suite-brainstorm`).
   Never work on, commit to, push to, or merge into `main` or `stable`.
2. **Human-only merge.** You NEVER merge brainstorming-build work into `main`/`stable`,
   open a PR targeting them, or promote anything. When the build is done you STOP and
   report; the maintainer decides if and when it lands. Merging feature branches back
   into `suite-brainstorm` is fine (that keeps the work on-branch).
3. **Push the branch, never the trunk.** Push `suite-brainstorm` and feature branches to
   origin so CI runs and the post-commit-review pipeline can watch it. Never
   `git push origin main`/`stable`.
4. **Never `docker compose down -v`.** It wipes the seeded dev data. Rebuild/recreate
   individual services instead.
5. **Screenshots use the GILLIGAN project only** (hard CLAUDE.md rule). Never ship generic
   placeholder data in any doc or marketing image.
6. **CI is a hard blocker.** Green CI (and a clean local verification) is required before
   you call a milestone done - including pre-existing reds you touch (record them, don't
   dismiss them).
7. House rules: no `Co-Authored-By` footer; no em dashes in committed docs; small commits
   with meaningful messages; migrations numbered/idempotent and never edited after apply.

## Phase 0 - Load the spec and plan

1. Resolve the spec: use the path given, else pick the newest
   `docs/brainstorming/<stamp>_APP_DESIGN_<app>.md`. Read it end to end - especially the
   data model + migration plan, API/MCP surface, workers, events, infra section, and the
   **Reuse ledger** (it names the exact packages/siblings to build on).
2. Confirm you are on `suite-brainstorm` (`git switch suite-brainstorm`); if the tree is
   dirty, stop and report rather than guessing.
3. Turn the spec into an ordered milestone plan with `TaskCreate`, roughly:
   M1 scaffold (`apps/<app>-api` + `apps/<app>` from the sibling the spec models on) ·
   M2 data model (Drizzle schema modules + numbered idempotent migrations; run
   `docker compose run --rm migrate`) · M3 shared Zod (`packages/shared/src/schemas/<app>.ts`) ·
   M4 API routes + realtime · M5 MCP tools + agent_policies/allowlist + surface-map ·
   M6 workers + Bolt events (register in `event-catalog.ts`) · M7 frontend SPA ·
   M8 **Launchpad + infra wiring** (see Phase 2) · M9 docs · M10 screenshots ·
   M11 marketing site. Sequence per the spec's own dependency order.

## Phase 1 - Implement with commit discipline

For each milestone, work in small functional steps. After each meaningful step:

1. Build/verify locally (typecheck the touched package at least).
2. Commit one small working change with a descriptive message (no co-author footer). If
   you discover a pre-existing bug that blocks progress, open a GitHub issue first, then
   fix it in its own commit with `Fixes #<n>` (issue-driven fixes).
3. **Push the branch** and run the **post-commit-review** skill (it fans out ci-watchdog,
   security-analyst, stability-reviewer, best-practices-reviewer). A PostToolUse hook
   reminds you after every commit.
4. **Address open `automated-review` issues first** before the next milestone task - fix
   each in its own `Fixes #<n>` commit, or close with a reason. Never carry an unaddressed
   review finding into the next milestone.

Prefer feature branches off `suite-brainstorm` for larger slices, then merge them back
into `suite-brainstorm` (keeping everything on-branch).

## Phase 2 - Launchpad + infra wiring (do not skip)

A new app is not "added" until it appears in the **Launchpad** and the stack can serve it.

**Launchpad (required for every new app):**
- Add the app id to `LAUNCHPAD_APP_IDS` and a metadata row to `LAUNCHPAD_CATALOG` in
  `apps/api/src/routes/system-settings.routes.ts` (`{ id, name, description, icon_name
  (kebab-case), color, path }`). This is the runtime source of truth - every SPA's
  Launchpad reads it from `/b3/api/launchpad/apps` on the next load with **no SPA rebuild**
  needed, *unless* the app needs a brand-new icon.
- If the app needs an icon not already in the `ICONS` map in `packages/ui/launchpad.tsx`,
  add the lucide import + a kebab-case `ICONS` entry there, then rebuild the SPAs once.
- Rebuild the `api` container so `/launchpad/apps` serves the new entry; verify with
  `curl -s .../b3/api/launchpad/apps` (the app appears in `catalog_detail`).
- **Scaling the Launchpad as the suite grows.** The overlay in `packages/ui/launchpad.tsx`
  is a fixed `max-w-2xl`, `grid grid-cols-4 gap-3`, `p-6` grid with **no scroll**. Each new
  app makes it taller; past roughly the current count it will overflow the viewport. When
  the addition pushes it near/over that limit, condense it in the same change: tighten
  spacing (`gap-2`, smaller tile padding) and/or add columns (`grid-cols-5`/`6` at wider
  breakpoints) and/or cap height with a scroll region (`max-h-[70vh] overflow-y-auto` on
  the grid) and/or adjust the modal aspect ratio (`max-w-3xl`). Keep the alphabetical sort
  and the "you are here" current-app highlight. If you decide the current layout still
  fits, say so explicitly and file a `best-practices` issue noting the growing count so the
  condense/scroll work is tracked rather than silently deferred.

**Stack wiring** (follow the spec's infra section and mirror the newest sibling app):
- `docker-compose.yml`: new `<app>-api` service (internal port from the spec, `migrate`
  as `service_completed_successfully`, postgres/redis `service_healthy`); add `<app>-api`
  to the `frontend` service `depends_on` so nginx does not crashloop on an unknown upstream.
- All **three** nginx configs (`infra/nginx/nginx.conf`, `nginx-with-site.conf`,
  `nginx.railway.conf` - the Railway form uses the `rw_upstream`/`:8080`/rewrite-break
  pattern) get the `/<app>/`, `/<app>/api/`, `/<app>/ws` blocks and the static-asset cache
  regex entry.
- `apps/frontend/Dockerfile`: the deps-COPY, build-COPY, `pnpm --filter @bigbluebam/<app>
  build`, and production-COPY-into-`html/<app>` lines (the SPA ships inside the single
  frontend image, not a separate service).
- `scripts/deploy/shared/services.mjs` catalog entry, then `node
  scripts/gen-railway-configs.mjs` and commit the generated `railway/<app>-api.json`.
- Update the app inventory + route table in `CLAUDE.md`.

## Phase 3 - Deploy to the local Docker dev stack

```
docker compose run --rm migrate                              # apply new migrations
docker compose build <app>-api <app-if-it-had-a-new-icon> api
docker compose up -d --force-recreate <app>-api api
docker compose restart frontend                              # after any *-api change
```
Never `-v`. Confirm the migration applied (`docker compose exec -T postgres psql ... "\d <table>"`)
and the service is healthy before testing.

## Phase 4 - Extensive tests

Run and make green: `pnpm typecheck`; `pnpm test` (targeted package first, then the suite);
`pnpm db:check` and `pnpm lint:migrations`; `node scripts/check-bolt-catalog.mjs`; the
surface-map self-check grep; integration-tests and e2e where the app warrants them; and a
**live smoke** on the local stack (curl the new routes, a `psql` read, exercise the SPA
path). Distinguish flaky from real reds and fix flakiness durably (shard/raise timeouts) -
do not paper over it. CI on the pushed branch must be green.

## Phase 5 - Docs, screenshots, marketing (all on-branch)

- **Docs:** author `docs/apps/<app>/help.md` via the `help-doc-authoring` skill, build its
  `help-index.json` (`help-index-builder`), and wire the Help Center (`suite-help-system`).
  Update `docs/reference/mcp-endpoint-mapping.md` and the `CLAUDE.md` app list.
- **Screenshots:** capture via the `screenshot-capture` skill against the **gilligan**
  project only; seed gilligan data for the new app first if needed. Never generic data.
- **Marketing site:** add the app to the `site/` marketing content (card/section, and the
  manual/book artifacts if the pipeline covers it). Note that `site` bakes `site/public/`
  and its content at image build time, so rebuild the `site` service to see it locally.

## Phase 6 - Hand off (STOP)

Produce a clear report and STOP:
- What shipped, on which branch (and any feature branches merged back into
  `suite-brainstorm`), with the key commits.
- Test + CI status (green, with any residual issues named).
- The list of `automated-review` issues filed and their disposition.
- A "How to see it in action" block: the exact local URLs/commands to view the new app,
  its Launchpad tile, its docs, and its marketing section.
- An explicit line: **merging `suite-brainstorm` into `main`/`stable` is yours to decide;
  nothing has been merged or promoted.**

## Done means

The new app is implemented, wired into the Launchpad and the stack, deployed to the local
dev environment, passing extensive tests with green branch CI, documented, screenshotted
(gilligan), and represented on the marketing site - all on `suite-brainstorm` - with every
automated-review finding addressed, and the merge decision left entirely to the human.
