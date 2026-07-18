---
name: app-build-from-spec
description: Autonomously build a new BigBlueBam app from a winning brainstorm design spec (docs/brainstorming/<stamp>_APP_DESIGN_<app>.md). Plans milestones, implements on the suite-brainstorm branch (feature branches off it) with per-step commit discipline and the post-commit-review pipeline, deploys to the local Docker dev stack, runs extensive tests, updates the Launchpad, docs, screenshots (gilligan only), and the marketing site. Never merges to main - that is the human maintainer's decision alone. Auto-invoked by suite-brainstorm at winner declaration, or run manually with a spec path.
---

# Build an app from its design spec (autonomous, branch-locked)

You are the build orchestrator. Given a hardened `APP_DESIGN` spec produced by a
suite-brainstorm session, you take the app from spec to a fully implemented, deployed,
tested, and documented feature - entirely on the `suite-brainstorm` branch - fully
autonomously, start to finish.

## Absolute gates (read first)

0. **NEVER pause for human input. Ever.** This is a fully-autonomous loop; most of the
   time no human is watching. You do not ask questions, request approval, wait for
   sign-off, or "hand off and stop." When you would otherwise ask a human to decide,
   make the most reasonable decision yourself, record it, and keep going. The five
   ideator seats already brainstormed, negotiated, and voted the app and its feature
   set - you do NOT re-litigate scope or wait for a human to pick features. Build the
   whole spec, end to end.
0a. **Build every internal dependency yourself; do not defer buildable work.** Your job
   is to fully implement the app end to end. If a feature needs another app to expose
   something (a new Bench internal query route, a new shared package export, a new event,
   a schema column, an MCP provider registration, a worker job, an LLM call through the
   existing internal `llm-provider` service), you BUILD that too, on-branch, and wire it.
   "Stub it", "deferred", "forthcoming", "a follow-up", or "out of scope" are NOT
   acceptable dispositions for work you are capable of doing - they are how an app ships
   half-done. The only things that legitimately block a code path are genuinely external:
   a third-party API key/secret, an OAuth app registration on someone else's service, a
   paid provider account, DNS, or a manual credential you cannot self-issue. Those - and
   ONLY those - go in the HUMAN_SETUP doc (gate 0b). An internal route, resolver, or
   invariant the spec designed is a thing you implement, never a thing you note and skip.
0b. **HUMAN_SETUP is for external secrets/accounts only.** Write
   `docs/brainstorming/<stamp>_HUMAN_SETUP_<app>.md` ONLY for items that require a
   human-held external credential or third-party account. Never put internal engineering
   work (cross-app routes, resolvers, migrations, providers, tests) there to avoid doing
   it. Build and test everything that does not depend on a genuinely external secret, mark
   only the truly-external-dependent path as pending, and continue. The only thing you
   never do is merge to `main` (gate 2), and that is not a pause: promotion is simply out
   of scope, so you keep producing on the branch.
1. **Branch-locked.** All work stays on `suite-brainstorm` or on **feature branches
   created off `suite-brainstorm`** (`git switch -c feat/<app>-<slice> suite-brainstorm`).
   Never work on, commit to, push to, or merge into `main` or `stable`.
2. **No merge to trunk (not a pause).** You never merge brainstorming-build work into
   `main`/`stable`, open a PR targeting them, or promote anything - promotion is a
   separate human action outside this loop, and you do NOT wait for it. When a build
   finishes you simply record the outcome and the loop moves on to the next cycle.
   Merging feature branches back into `suite-brainstorm` is fine (keeps work on-branch).
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
8. **MCP parity is a hard gate, not a nice-to-have (this is an AI-first WorkOS).** The
   defining premise of the suite is the human + agent dual interface: every capability is
   reachable by both humans (UI + REST) and AI agents (MCP tools), on the same data, under
   the same permissions and audit trail. Therefore, for the app you build: **every REST
   API endpoint AND every action a human user can take in the interface has an equivalent
   MCP tool.** An endpoint or a UI button that no agent can drive is a parity hole and the
   app is not done. The ONLY acceptable absences are explicitly-annotated skips in the
   surface map (see Phase 1c) for the narrow, sanctioned categories - auth, multipart/binary
   upload/download, public-inbound webhooks, SuperUser/permission-matrix administration,
   internal service-to-service, realtime/Yjs transport, and "resolver-done-internally".
   A skip is a decision you write down with a reason, never a bare gap you leave behind.
   Do not treat MCP tools as an afterthought bolted on at the end: design the tool surface
   alongside the routes, and never ship an endpoint or a UI action in one milestone and
   "add the tool later" in another - they land together.

## Phase 0 - Load the spec and plan

1. Resolve the spec: use the path given, else pick the newest
   `docs/brainstorming/<stamp>_APP_DESIGN_<app>.md`. Read it end to end - especially the
   data model + migration plan, API/MCP surface, workers, events, infra section, and the
   **Reuse ledger** (it names the exact packages/siblings to build on).
2. Confirm you are on `suite-brainstorm` (`git switch suite-brainstorm`); if the tree is
   dirty, stop and report rather than guessing. Then **sync from `main` first**:
   `git fetch origin && git merge --no-edit origin/main` so you build on current trunk
   (this is the allowed merge direction; only branch->main is forbidden). Resolve any
   conflicts favoring `main` for shared/platform files and the branch for
   `docs/brainstorming/*` + satellite-app code; if intractable, `git merge --abort`, note
   it, and continue - a sync problem never blocks the build. Re-run
   `docker compose run --rm migrate` if the merge brought new migrations. (When invoked by
   `autonomous-cycle`, that skill already did this sync; doing it again is a harmless no-op.)
3. Turn the spec into an ordered milestone plan, roughly:
   M1 scaffold (`apps/<app>-api` + `apps/<app>` from the sibling the spec models on) ·
   M2 data model (Drizzle schema modules + numbered idempotent migrations; run
   `docker compose run --rm migrate`) · M3 shared Zod (`packages/shared/src/schemas/<app>.ts`) ·
   M4 API routes + realtime · M5 **MCP tool surface at full parity** (one `<app>_*` tool
   per REST endpoint and per human UI action, registered through `registerTool()`;
   `<app>.*` `agent_policies` allowlist; `confirm_action` on every destructive tool;
   `docs/reference/mcp-endpoint-mapping.md` rows for every endpoint - tool name or annotated
   skip, never a bare gap - see Phase 1c) · M6 workers + Bolt events (register in
   `event-catalog.ts`) · M7 frontend SPA
   (**must match `/b3/` shell + include the Bureau widget - see Phase 1b**) ·
   M8 **Launchpad + infra wiring** (see Phase 2) · M9 documentation, including Help docs
   (**must match `/b3/` help doc format including index, user story examples, etc.,
   M10 screenshots, M11 marketing site. Sequence per the spec's own dependency order and
   write a checklist of milestones for asynchronous human inspection and review in
   `docs/brainstorming/<stamp>_WORK_IN_PROGRESS_<app>.md`. For each step include a checkbox,
   the milestone name, a detailed description of what that milestone will include, including
   individual checkboxes for steps inside the milestone itself.
4. Launch an adversarial agent to check over this milestone plan, comparing it to the app
   design, and fleshing out the details of the milestone plan based on information contained
   in that app design.
5. Turn the spec into an ordered milestone plan with `TaskCreate`.

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

## Phase 1b - Frontend shell parity (mandatory - always match `/b3/`)

**Every app in the suite wears the same chrome. A new SPA is not done until it looks and
behaves like `/b3/`.** Do NOT invent your own top bar, your own Launchpad, or your own color
palette - that is the single most common way a new app ends up looking foreign. Before
writing any SPA layout, open the Bam reference (`apps/frontend/src/components/layout/
app-layout.tsx` + `sidebar.tsx`) AND the newest satellite app that already conforms
(currently `apps/blip/` - `src/components/layout/blip-layout.tsx`, `blip-sidebar.tsx`,
`src/main.tsx`, `src/styles/globals.css`). Copy that structure; change only the app name,
icon, nav items, and routes.

Required, non-negotiable, for every app's SPA:

- **Shared sidebar** (`w-[260px] bg-sidebar`): a colored `bg-primary-600` badge + the app
  name at the top, the app's own nav items, and the shared `SidebarPlatformFooter`
  (`@bigbluebam/ui/sidebar-footer`) at the bottom - it provides Account Settings, People,
  All Users, and the SuperUser console. Never re-implement that footer.
- **Shared top bar** (`h-14`), left to right: `LaunchpadTrigger`; a page/breadcrumb
  indicator that reflects where you are (like `/b3/` showing `Dashboard`, then
  `Projects > <name>`); the `OrgSwitcher` (current org + selector); where applicable a
  search field; a Banter quick-link; the `NotificationsBell` (Alerts); the `HelpTrigger`
  for the current app; and the `UserMenu` (username/email, Account Settings, People, People
  Manager, SuperUser Console, Sign out). ALL of these come from `@bigbluebam/ui/*` -
  `launchpad`, `org-switcher`, `notifications-bell`, `help-center`, `user-menu`. Wire the
  vite aliases for each (mirror the sibling's `vite.config.ts`).
- **Shared Launchpad**: use `<Launchpad currentApp="<app>" />` from `@bigbluebam/ui/launchpad`.
  It is a shared interface and must be launched from the same LaunchpadTrigger in the top bar
  and look identical on every app. If it looks different, you built your own - delete it.
- **Shared theme tokens**: copy the sibling's `src/styles/globals.css` verbatim (the blue
  `--color-primary-*` ramp and the `--color-sidebar*` tokens). Do NOT introduce a different
  accent (no indigo/violet/etc.); style buttons/links with `bg-primary-600`/`text-primary-600`.
- **Bureau widget (mandatory, every app)**: mount the suite-wide Bureau docked call/presence
  box in `src/main.tsx` exactly like the sibling - `mountBureauClient({ describeLocation,
  initialRoute, navigate })` plus the pushState/replaceState/popstate wiring, and
  `initSystemErrorReporter({ service: '<app>' })` - and add `@bigbluebam/bureau-client` to the
  app's `package.json`. Every other app has it; a new app without it is incomplete.
- **Shared providers + auth**: wrap the app in `PermissionsProvider` (fetcher hitting
  `/b3/api/auth/me`), add the `src/stores/auth.store.ts` `fetchMe` store, the loading/auth
  gate, the saved-theme apply, and the `?`-opens-Help shortcut - all copied from the sibling.

Acceptance: side-by-side with `/b3/`, the sidebar, top bar, Launchpad, colors, and Bureau
box are visually the same family; only the app's content differs. If any of the above is
missing or bespoke, the SPA milestone (M7) is not complete.

## Phase 1c - MCP tool surface at full parity (mandatory - the AI-first contract)

**BigBlueBam is an AI-first WorkOS. Its defining guarantee is the human + agent
dual interface: every capability is reachable by both a person (UI + REST) and an AI agent
(an MCP tool), on the same boards, under the same roles, RLS, and append-only audit trail -
not a separate, weaker API bolted on the side.** For the app you are building this means a
non-negotiable, verifiable rule:

> **Every REST API endpoint you add, and every action a human user can take in the app's
> interface, has an equivalent MCP tool.** No endpoint and no user-facing action ships
> agent-blind. The agent can do everything the human can do.

This is not an end-of-build cleanup step. Design the `<app>_*` tool surface alongside the
routes in M4/M5 and build them in the same slices - an endpoint or a UI action and its tool
land in the same commit, never "tool added later". If you catch yourself shipping a route
or a button with no tool, stop and build the tool before moving on.

**How to build each tool (mirror the newest sibling, e.g. `apps/mcp-server/src/tools/`):**

- Add a handler module `apps/mcp-server/src/tools/<app>-tools.ts` (split into a few modules
  if the surface is large, as Bam does). Type every tool's input/output off the shared Zod
  schemas from M3 (`@bigbluebam/shared`) so the tool and the endpoint validate identically.
- Register **every** tool through `registerTool()` in `apps/mcp-server/src/lib/register-tool.ts`.
  That wrapper is what enforces the platform's agent governance: the per-session `PolicyGate`
  fail-closes each service-account call against `agent_policies` (human callers bypass;
  unknown callers fail closed). Do not hand-register or bypass the wrapper.
- Add the app's glob to the `agent_policies` allowlist model (`<app>.*`), so an operator can
  scope or kill-switch the app's tools per agent. Name tools `<app>_<verb>_<noun>` so the
  glob actually gates them.
- **Every destructive or high-impact tool** (delete, complete, end, archive, bulk-mutate,
  anything not safely idempotent) routes through the `confirm_action` two-step token flow -
  first call stages and returns a token, second call replays it. Do not invent your own
  confirmation.
- Any tool that surfaces cross-app results into a shared surface must run the `can_access`
  visibility preflight for every cited entity (per `docs/reference/agent-conventions.md`),
  using the human's `asker_user_id`, and drop anything the audience may not see.
- Read tools count too: list/get/search endpoints and any UI view that fetches data get a
  read tool (`<app>_list_*`, `<app>_get_*`, `<app>_search_*`), so an agent can observe the
  same state a human sees, not just mutate.

**Prove parity with the surface map (`docs/reference/mcp-endpoint-mapping.md`):**

- In the SAME change that adds each endpoint/tool/UI call site, add its row to the map. The
  MCP column is **either a real backtick-wrapped tool name or an explicit
  ` - _(skip: <reason>)_`, never a bare ` - `.** A bare gap is a build defect.
- The only sanctioned skip reasons are the narrow categories from gate 8: auth,
  multipart/binary upload/download, public-inbound webhook, SuperUser/permission-matrix
  admin, internal service-to-service, realtime/Yjs transport, resolver-done-internally.
  If your reason is not one of these, the answer is "build the tool", not "skip it".
- Run the self-check and make it print `0` before calling M5 done:
  `grep -cE '^\| \`[^|]+\` \| - \|' docs/reference/mcp-endpoint-mapping.md`.
- Also cross-walk the UI: for every button, menu action, and form-submit in the SPA (M7),
  confirm there is a tool that performs the same action. A UI action with no tool is the
  most common parity hole because it is not caught by a REST-row scan - check it explicitly.

Acceptance: the app's every REST endpoint and every human UI action either maps to a named
`<app>_*` MCP tool or carries an annotated, sanctioned skip; all tools register through
`registerTool()`; destructive tools are `confirm_action`-gated; the `<app>.*` allowlist
exists; and the surface-map self-check prints `0`. If any of these is untrue, M5 is not
complete - regardless of how finished the REST and UI layers look.

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

**When - and ONLY when - a code path needs a genuinely EXTERNAL credential** (a
third-party API key or secret, an OAuth app registration on someone else's service, a
paid provider account, DNS, or a manual credential you cannot self-issue), do NOT silently
stub or skip it. Write a setup doc alongside the session and design docs:
`docs/brainstorming/<stamp>_HUMAN_SETUP_<app>.md`. It must state, for each item: exactly
**what** is needed, **why** (which feature is degraded/blocked without it), **where** to
put it (the precise env var / file / admin screen), and how to verify it once provided.
Build and test everything that does not depend on that external secret, mark only the
externally-blocked path as "pending human setup" in the doc and the Phase 6 report, and
keep going - the cycle never blocks waiting on a human.

**Internal work is NOT a HUMAN_SETUP item and is NOT deferrable** (gate 0a). If a feature
needs another app to expose a route, a shared export, an event, a schema column, an MCP
provider, a worker job, or an LLM call through the existing internal `llm-provider`
service, you BUILD it, on-branch, in this cycle - you do not write it up as "pending",
"forthcoming", or "a follow-up". The HUMAN_SETUP doc is for external credentials only;
using it to park engineering you are capable of doing is a bug in your process. If you
catch yourself about to defer an internal capability the spec designed, stop and implement
it instead.

## Phase 4 - Extensive tests

**Static + unit gates.** Run and make green: `pnpm typecheck`; `pnpm test` (targeted
package first, then the suite); `pnpm db:check` and `pnpm lint:migrations`;
`node scripts/check-bolt-catalog.mjs`; the surface-map self-check grep; integration-tests.
Distinguish flaky from real reds and fix flakiness durably (shard/raise timeouts) - do not
paper over it. CI on the pushed branch must be green.

**MCP parity gate (hard).** The surface-map self-check
(`grep -cE '^\| \`[^|]+\` \| - \|' docs/reference/mcp-endpoint-mapping.md` prints `0`) must
pass, AND you must actively verify parity rather than trust it: walk the app's route table
and confirm each endpoint has a named tool or a sanctioned annotated skip, then walk the
SPA's user-facing actions and confirm each has an equivalent `<app>_*` tool. Spot-check by
driving a representative slice of the app end-to-end **through MCP tools alone** (agent
service account against the local stack) and confirm the same backend rows/events appear as
when a human drives the UI. A UI action or endpoint with no agent path is a build defect -
file it and fix it, do not accept it as a gap.

**End-to-end user-story testing (required for every deployed app).** Once the app is live
on the local Docker dev stack, exercise it the way a user would:

1. **Author user stories** from the spec's scope - a handful of concrete flows a real user
   would perform (e.g. for a metric layer: "define a metric -> certify it -> ask why it
   changed -> see the driver breakdown -> bind it to a Bench widget"). Cover the primary
   happy path plus at least one permission/negative case.
2. **Drive each story with Playwright** against the local stack (extend `apps/e2e/`,
   reusing its fixtures and the login helpers). Log in as a seeded **gilligan** user, walk
   the UI through the story, and assert the visible outcomes. Capture a trace on failure.
3. **Verify the backend actually changed.** After each story, confirm the right data was
   created/updated: read it back via the app's own API (`curl` the route as the same user)
   AND directly in Postgres (`docker compose exec -T postgres psql ... "select ... where
   organization_id = ..."`). A green Playwright run that left no correct backend state is a
   failure - the UI must have produced the real rows/events the spec promises (including
   the expected Bolt events and org-scoping).
4. Keep the E2E specs in the branch so the story suite grows with the suite; make them
   self-cleaning (tear down what they create) so re-runs stay deterministic.

Treat any story that can't be completed end-to-end as a build defect (file it / fix it),
not as an acceptable gap.

## Phase 5 - Docs, screenshots, marketing (all on-branch)

- **Docs:** author `docs/apps/<app>/help.md` via the `help-doc-authoring` skill, build its
  `help-index.json` (`help-index-builder`), and wire the Help Center (`suite-help-system`).
  Update `docs/reference/mcp-endpoint-mapping.md` and the `CLAUDE.md` app list.
- **MCP Tooling:** The Docs for the new app (and the Marketing site described below) should
  include the tool count for MCP tools on this app. The total MCP tool count should be
  updated wherever this is referenced.
- **Screenshots:** capture via the `screenshot-capture` skill against the **gilligan**
  project only; seed gilligan data for the new app first if needed. Never generic data.
- **Marketing site:** add the app to the `site/` marketing content (card/section, and the
  manual/book artifacts if the pipeline covers it). MCP Tool Counts should be updated
  in the Marketing site anywhere that it mentions them. Note that `site` bakes `site/public/`
  and its content at image build time, so rebuild the `site` service to see it locally.

## Phase 6 - Record the cycle (do NOT stop or wait)

Write a cycle record to `docs/brainstorming/<stamp>_BUILD_REPORT_<app>.md` (and release
the autonomous-cycle lock so the next cycle can run). Do not pause for review, approval,
or a merge decision - just record and let the loop continue:
- What shipped, on which branch, with the key commits.
- Test + CI status (green, with any residual issues named + the follow-up tasks you filed).
- The `automated-review` issues filed and their disposition.
- Anything written to the HUMAN_SETUP doc (degraded paths awaiting a human-provided
  secret/account) - noted as a record, NOT as a blocker; everything else is done and the
  app is deployed and tested on the branch.
- A "how to see it in action" section (local URLs/commands, Launchpad tile, docs).

Then the cycle is complete. Control returns to the scheduler for the next cycle; a human
may separately choose to promote work to `main`, but the loop never waits for that.

## Done means

The new app is implemented, wired into the Launchpad and the stack, deployed to the local
dev environment, passing extensive tests with green branch CI, documented, screenshotted
(gilligan), and represented on the marketing site - all on `suite-brainstorm`, produced
fully autonomously with no human pause - and every automated-review finding addressed.
**Its MCP surface is at full parity: every REST endpoint and every human UI action has an
equivalent `<app>_*` MCP tool (or a sanctioned, annotated skip), all registered through
`registerTool()` with the `<app>.*` allowlist and `confirm_action` on destructive tools, and
the surface-map self-check prints `0`** - the app is as operable by an agent as by a person.
Whether any of it ever reaches `main` is a separate human choice the loop does not wait on.