---
name: close-out
description: The final completion audit for an app build produced by app-build-from-spec / autonomous-cycle. It enumerates EVERY requirement from CLAUDE.md, the build/cycle/brainstorm/help skills, the permission-catalog step, and the hard-won lessons, then launches an auditor agent to verify each item against the REAL repo + live stack and pick up anything missed. Its whole purpose is to stop "required work" from being relabeled an "optional follow-up." Run it at the very end of every build, before releasing the concurrency lock and declaring the cycle done.
---

# Close-out (build completion audit)

You reached this skill because a build is "finished." It is not finished until this
audit says so. The job here is simple and adversarial: go through the complete list of
things the process requires, check each one against what is actually on disk and running,
and **do the ones that were missed** - now, in this run, not as a "follow-up."

## The one principle that makes this skill necessary

**Everything on the checklist below is YOUR responsibility. There is no "not my job"
bucket.** Over a long build it is tempting to relabel required work as an "optional
follow-up," "pre-existing hygiene," "out of scope," or "the human's side." That relabeling
is the exact failure this skill exists to catch. Concretely:

- A step that a skill's phase or "Done means" lists is **required**. Not optional. Not
  deferrable. Build it.
- A **pre-existing** error/warning/failure you touched or surfaced is **also yours** -
  record it AND fix it if the fix is small and safe; if it is non-trivial, do it anyway or
  provide the exact remediation and say loudly why it is not done. "Pre-existing" is never
  a reason to leave it (CLAUDE.md: "Pre-existing is not a dismissal").
- An item that needs a **destructive DB op the harness blocks** (DROP/DELETE/`down -v`,
  scheduled-task registration, etc.) is still yours to **drive**: attempt the
  non-destructive path, write the exact one-line command the human must run, apply it
  yourself if the environment permits, and track it - do not just write "yours."
- **Local-DB drift is ESPECIALLY yours** - you are better suited to it than the human, not
  worse. `db:check` / `check-permission-catalog` drift is almost never a genuine hand-off:
  diagnose the root cause (is a table/column/permission in the live DB but declared in no
  Drizzle schema / no committed migration? is it a real gap on THIS branch, or a
  cross-branch artifact polluting the shared local dev DB?), then FIX it the right way - add
  the missing Drizzle declaration, write an additive idempotent migration to align the DB
  to the manifest, or (for genuine cross-branch pollution) provide and apply the exact
  cleanup. Prove CI's fresh DB is clean. Never park drift as "the human's local DB" - that
  is the single most common thing to wrongly disown.
- The **only** three things you actually hand off, and only after driving them as far as
  possible: (1) a **merge/promotion to `main`/`stable`** (human-only, always), (2) an
  **external secret / third-party account** (goes in the `HUMAN_SETUP` doc with exact
  what/why/where/verify), (3) the **single destructive keystroke** the harness refuses -
  handed over as a copy-paste command, never as a vague gesture.

If an item cannot be completed for a real, defensible reason, it gets a **recorded waiver
with the reason and the exact remaining command** - never the words "follow-up,"
"deferred," "later," or "out of scope" for work you are capable of doing.

## What "report it to the human" means (this loop is HEADLESS)

This process normally runs headless, fired by the Task Scheduler with **no human watching
the chat**. So "report it," "surface it," "flag it to the maintainer," or "hand it off"
**never means saying it in a chat message** - that message is written to a transcript no
one reads during the run and is effectively lost. It means **writing it into a persistent,
discoverable document**, or it did not happen.

The document is the cycle's human-actions doc:
`docs/brainstorming/<stamp>_HUMAN_SETUP_<app>.md`. Every item that genuinely needs a human
keystroke goes there as a **checkbox line** with four fields: **what** is needed, **why**
(which feature/gate is blocked or which state is dirty without it), the **exact copy-paste
command or action** (the literal SQL / CLI / admin-screen path - not "run the cleanup"),
and **how to verify** it once done. The three legitimate categories, and only these:

1. **Promotion to `main`/`stable`** - a standing line every cycle: "promotion is the
   maintainer's decision; nothing was merged." (Always present.)
2. **An external secret / third-party account** - the classic HUMAN_SETUP item.
3. **A harness-blocked destructive keystroke** you could not run yourself (a `DROP`/`DELETE`
   on the shared dev DB, a scheduled-task registration, etc.) - after you have driven it as
   far as the environment allows and confirmed it is genuinely blocked.

**Internal engineering NEVER goes in this doc** - if you are capable of doing it, you do it,
you do not write it up as a human action. The doc is for the three hand-offs above, nothing
else; using it to park buildable work is the same disowning bug in a different disguise.

The `BUILD_REPORT_<app>.md` and the one-paragraph cycle summary each carry a **one-line
pointer** to this doc ("Human actions required: see `<stamp>_HUMAN_SETUP_<app>.md` (N
items)" or "none"). If there are zero human-keystroke items, the report still says so
explicitly - never omit the line, so a maintainer can trust its absence means "nothing,"
not "forgotten." A close-out WAIVER on any checklist line above is only valid if the
remaining action is written into this doc.

## Procedure

1. **Resolve the app + stamp.** Take the app id and the `docs/brainstorming/<stamp>_*`
   stamp from the invocation (or the newest build). Read the WORK_IN_PROGRESS checklist
   and the BUILD_REPORT if they exist.
2. **Launch the close-out auditor** (a `general-purpose` agent, opus) with the full
   checklist below and repo + live-stack access. It verifies EACH item against the actual
   files, the running containers, and the DB, and returns a per-item verdict:
   `PASS` (with the evidence it checked) / `MISSING` / `BROKEN` / `WAIVER(reason)`. It does
   not fix; it reports with evidence so you cannot hand-wave. For a large surface, fan out
   several auditors by section (static gates, MCP parity, infra, docs, security) and merge.
3. **Fix every MISSING/BROKEN item yourself** (directly, or by invoking the right
   sub-skill / agent: `help-doc-authoring`, `help-index-builder`, `suite-help-system`,
   `screenshot-capture`, `post-commit-review`, etc.). Each fix is its own small commit
   (`Fixes #<n>` when an issue exists), pushed to the branch. Never mark an item done
   without the evidence the auditor would need to flip it to PASS.
4. **Re-audit until the whole checklist is PASS or a recorded WAIVER.** A WAIVER must name
   the reason and the exact command/step that remains, and must not be dressable-up
   deferral of buildable work.
5. **Refresh the BUILD_REPORT** with the final checklist state (a real checkbox table),
   then let the caller (`app-build-from-spec` Phase 6 / `autonomous-cycle` step 5) release
   the lock. If this skill is the last step, release the lock and write the one-paragraph
   cycle summary yourself.

## The checklist (verify EVERY line against the real repo + running stack)

Grouped by the phase/skill that owns it. The auditor checks each; you fix each. Commands in
backticks are the objective checks - run them, do not eyeball.

### A. Branch, sync, and hygiene (CLAUDE.md + autonomous-cycle)

- [ ] All work is on `suite-brainstorm` or a feature branch off it; nothing committed to
      `main`/`stable`; branch pushed to origin (`git log origin/suite-brainstorm..HEAD` is
      empty).
- [ ] The branch was synced from `main` at cycle start (main -> branch is allowed; branch
      -> main is never done here).
- [ ] No `Co-Authored-By` footer in any commit of this build
      (`git log <base>..HEAD | grep -i co-authored` prints nothing).
- [ ] No em dashes in any committed doc/markdown this build added
      (grep the added docs for the em-dash and en-dash characters; the ONE sanctioned
      exception is the surface-map table skip-cells).
- [ ] Never ran `docker compose down -v` (data preserved).

### B. Static + drift gates (app-build-from-spec Phase 4)

- [ ] `pnpm typecheck` (or per-package `--filter ... typecheck`) green for every package
      touched (api, <app>-api, <app>, worker, bolt-api, mcp-server, shared, permissions).
- [ ] `pnpm test` green for the touched packages + any new unit suites the spec's Testing
      section named (scorer, executors, visibility branches, register-tool policy,
      org-scoping, etc.).
- [ ] `pnpm db:check` shows NO drift attributable to this app (a new schema dir is
      auto-discovered; every declared table/column exists in the DB and vice-versa). Any
      remaining drift is PRE-EXISTING and unrelated - name it, and if it is a real
      committed-migration gap, fix it; if it is a local-dev-DB artifact of another branch,
      say so with evidence (it is absent from CI's fresh DB) and record the exact cleanup.
- [ ] `pnpm lint:migrations` = 0 violations; every new migration is numbered, idempotent,
      has the `-- Why:` / `-- Client impact:` header, and has NOT been edited after apply.
- [ ] `node scripts/check-bolt-catalog.mjs` = 0 violations; every `publishBoltEvent` this
      app added is registered in `event-catalog.ts` with source + bare event name.
- [ ] Surface-map self-check prints 0:
      `grep -cE '^\| \`[^|]+\` \| - \|' docs/reference/mcp-endpoint-mapping.md` (use the
      real em-dash the file uses). The app has a complete section: every REST row maps to a
      backtick tool name or an annotated sanctioned skip.
- [ ] integration-tests pass if the app added cross-app flows.

### C. CI actually ran and is green (CLAUDE.md "CI is a hard blocker" + the flaky-CI rule)

- [ ] The push actually TRIGGERED CI - the branch is in the workflows' push filters (or a
      PR was opened). `gh run list --branch <branch>` shows runs for the tip commit; do not
      assume "pushed" means "CI ran." If no run fired, wire the branch into the triggers.
- [ ] Every triggered run is green. A red is fixed, not dismissed - including a red you did
      not introduce. Distinguish a genuine failure from a flaky/timeout false-red and fix
      flakiness durably (shard/raise timeouts), never paper over it.

### D. MCP parity - the AI-first hard gate (app-build-from-spec Phase 1c/8)

- [ ] Every REST endpoint the app added has an `<app>_*` MCP tool OR a sanctioned annotated
      skip in the surface map (auth / multipart / public-inbound / SuperUser-admin /
      internal-service / realtime-ws / resolver-done-internally).
- [ ] Every human UI action in the SPA has an equivalent tool (walk the buttons/forms - a
      UI action with no tool is the parity hole a REST-row scan misses).
- [ ] Every tool registers through `registerTool()`; the `<app>.*` `agent_policies`
      allowlist exists (tools fail closed until allowlisted); destructive/truth-flip tools
      use the `confirm_action` two-step token; read tools that surface source records take
      `asker_user_id` and run `can_access` fail-closed.
- [ ] A representative slice was driven end-to-end THROUGH MCP tools (agent service account)
      and produced the same backend rows/events as the UI path.

### E. Permission catalog (the step this process learned the hard way)

- [ ] The `<app>.*` permission rows are hand-authored in
      `scripts/generate-permission-manifest.mjs` `HAND_AUTHORED` (satellite pattern), each
      with explicit `app:'<app>'` and explicit `is_read`; a `<app>.` branch was added to the
      source-label if-chain; the manifest was regenerated and the codegen rebuilt
      (`node scripts/generate-permission-manifest.mjs && node scripts/build-permission-codegen.mjs`).
- [ ] A numbered delta migration (via `scripts/build-permission-delta.mjs`) seeds those rows;
      the generator's proposed removals of UNRELATED rows were stripped.
- [ ] The rows are granted to the built-in permission groups (a migration like the
      `<app>_builtin_group_defaults` one) so a normal Owner/Admin is not `implicit_deny`'d and
      the SPA does not 403. Verify: an org Owner `GET`s a read endpoint and gets 200, not 403.
- [ ] `node scripts/check-permission-catalog.mjs` shows no `<app>.*` drift (manifest =
      codegen = DB). Pre-existing non-app drift is named with evidence.

### F. Frontend shell parity + realtime (app-build-from-spec Phase 1b)

- [ ] The SPA wears the shared `/b3/` chrome: shared sidebar (colored app badge +
      `SidebarPlatformFooter`), shared top bar (`LaunchpadTrigger`, breadcrumb,
      `OrgSwitcher`, `NotificationsBell`, `HelpTrigger`, `UserMenu`), `<Launchpad
      currentApp="<app>" />`, and the blue theme tokens copied verbatim (no bespoke accent).
- [ ] The **Bureau widget is mounted** in `main.tsx` (`mountBureauClient` + history wiring +
      `initSystemErrorReporter`), and `@bigbluebam/bureau-client` is a dependency.
- [ ] `PermissionsProvider` + the auth store + the loading/auth gate + saved-theme apply +
      the `?`-opens-Help shortcut are all wired. Dark-mode selects/dropdowns are readable
      (not white-on-white).
- [ ] Realtime (`/<app>/ws`) works if the spec has it; frames are refs-only where the spec
      requires.

### G. Launchpad + infra wiring (app-build-from-spec Phase 2 + Railway memory)

- [ ] `<app>` in `LAUNCHPAD_APP_IDS` + a `LAUNCHPAD_CATALOG` row; the `icon_name` exists in
      the `ICONS` map in `packages/ui/launchpad.tsx` (imported); `api` rebuilt so
      `/launchpad/apps` serves it (curl shows it). Launchpad grid still fits (condense if the
      count overflows).
- [ ] `docker-compose.yml`: `<app>-api` service (right port, migrate/postgres/redis deps),
      and `<app>-api` added to the `frontend` `depends_on` (the real crash-safety guarantee).
- [ ] All THREE nginx configs have the `/<app>/`, `/<app>/api/`, `/<app>/ws` blocks + the
      static-asset regex entry: edit `nginx.conf` and `nginx-with-site.conf` in place
      (respecting their pre-existing divergence), then `node scripts/gen-railway-configs.mjs`
      regenerates `nginx.railway.conf` + `railway/<app>-api.json` (never hand-edit the
      generated railway file or reason about `$rw_upstream` indices).
- [ ] `apps/frontend/Dockerfile`: the four edit sites (deps package.json COPY, build source
      COPY, `pnpm --filter @bigbluebam/<app> build`, production COPY into `html/<app>`).
- [ ] `scripts/deploy/shared/services.mjs`: `<app>-api` catalog entry + frontend
      `public_paths`/`needs` + `mcp-server` `BRAID_API_URL`-style env + `needs` (NOT compose
      `depends_on`) + any new worker env; `BRAID_API_URL`-style var added to
      `apps/mcp-server/src/env.ts` and the `registerXTools` call wired in `server.ts`.
- [ ] `CLAUDE.md`: app inventory lines, the `/<app>/...` route rows, and the MCP tool count
      bumped (and the count updated WHEREVER referenced - docs AND the marketing site).

### H. Internal wiring is not just typecheck-correct - it is LIVE-correct

- [ ] Internal service-to-service routes (`/internal/*`, event dispatch, reconcile sweeps)
      hit the ACTUAL registered path (e.g. a route under the `/v1` prefix is posted to at
      `/v1/internal/...`, not `/internal/...`). Prove it with a live call returning 2xx, not
      a typecheck.
- [ ] The live ingest/event transport was exercised end-to-end against the running stack.

### I. Deploy + backend verification (app-build-from-spec Phase 3 + 4)

- [ ] The affected containers were REBUILT (WSL2/BuildKit may need the change baked into the
      tsup-bundled `dist`; grep the running container's dist for a new string to confirm),
      recreated with `up -d --force-recreate` (NOT `restart`, which serves the old image),
      and `frontend` restarted after any `*-api` change so nginx re-resolves the upstream.
- [ ] The migration actually applied (`\d <table>` shows it; `schema_migrations` has the
      row); the service is healthy.
- [ ] The Playwright user-story suite exists in `apps/e2e/src/apps/<app>/tests/`, covers the
      spec's stories (happy path + at least one negative/permission case), asserts BOTH the
      UI outcome AND the backend (read back via the app's REST API AND directly in Postgres,
      including expected Bolt events + org-scoping), is self-cleaning, and PASSES against the
      live stack. A green Playwright run that left no correct backend state is a failure. A
      story that cannot complete end-to-end is a build defect, not an acceptable gap.

### J. Docs, screenshots, marketing (app-build-from-spec Phase 5 + help-doc-authoring +
     suite-help-system)

- [ ] `docs/apps/<app>/help.md` meets the help-doc-authoring acceptance checklist (every
      section filled, every user-facing feature has how-to steps, every common workflow has a
      User Story incl. an agent flow, real UI labels, feature claims trace to code, no em
      dashes, screenshots referenced exist).
- [ ] `docs/apps/<app>/help-index.json` built (via `help-index-builder`), deterministic
      (`node scripts/help/build-help-index.mjs --apps <app> --check` = current).
- [ ] Help Center wired (suite-help-system): the `(?)` `HelpTrigger app="<app>"` in the top
      bar, the `?`-shortcut, right-click element help, the vite alias - verified live.
- [ ] `docs/apps/<app>/guide.md` written.
- [ ] Screenshots captured via `screenshot-capture` against the **gilligan** project ONLY
      (never generic data), saved where the docs AND the marketing site reference them.
- [ ] **Screencaps are EMBEDDED in the docs, not merely present as files.** The suite
      convention (see `docs/apps/basis/help.md` + `guide.md`) is inline
      `![caption](screenshots/light/<file>.png)` in BOTH help.md and guide.md - a screencap
      per major surface/feature. Verify with `grep -c '!\[' docs/apps/<app>/help.md` (must be
      > 0) and that every referenced path exists. Files-on-disk-but-unreferenced is the exact
      gap that reads as "done" but ships docs with no images.
- [ ] **The BUILT marketing site actually SERVES the screencaps, not an SPA HTML fallback.**
      `site/public/` is baked at image-build time, so a stale image serves `index.html` (200,
      `text/html`) for a missing PNG - which looks fine to a naive 200 check. After
      `docker compose build site && up -d --force-recreate site`, verify the real bytes:
      `curl -s -o /dev/null -w '%{content_type}' http://localhost:3000/screenshots/<app>/light/<file>.png`
      must print `image/png`, and every `FloatingFrame src=` in the app's marketing section
      must resolve to a file that exists (no dark-dup-of-hero padding a 4-slot layout).
- [ ] Marketing site section added under `site/`, registered on a page, MCP counts updated;
      the app-count narrative reconciled if it drifted (do not leave "N apps" copy stale just
      because it predates this app - that is exactly the kind of pre-existing item that is
      still yours to fix or, if genuinely large, to record with the specific edit needed).
- [ ] **The `/docs` MCP tool catalog includes the app.** `/docs` is AUTO-GENERATED from the
      per-app tool sources (`pnpm docs:catalog` -> committed `site/src/content/docs-catalog.generated.json`,
      consumed by `site/src/pages/docs.tsx`) - it is NOT hand-maintained. Verify the app's
      tool module is in `APP_TOOL_MODULES` (scripts/docs/lib/tool-source.mjs) and its
      LAUNCHPAD_CATALOG row exists, re-run `node scripts/docs/build-docs-catalog.mjs` (must be
      deterministic - no git diff), and confirm the app + its tools appear in the generated
      JSON. The manual (`manual.generated.json`) and the DOCX/PDF (`scripts/docs-book/build-book.mjs`)
      likewise pick the app up from the same sources - regenerate them if this app is new.

### K. Review pipeline fully closed (Phase 1 + post-commit-review)

- [ ] `post-commit-review` ran over the substantive code push; every `automated-review`
      issue it filed is CLOSED - fixed in its own `Fixes #<n>` commit, or closed with a
      reason. Nothing is left open and unaddressed.
- [ ] If the repo is public, automated-review issues do not leave exploit-grade detail open
      on an unfixed vuln - fix fast and close, and flag the disclosure posture to the human.

### L. Pre-existing issues surfaced during the build (CLAUDE.md "not a dismissal")

- [ ] Every pre-existing error/warning/failure encountered is recorded as a task with file +
      message, and either fixed (small/safe) or driven as far as possible with the exact
      remaining remediation stated. None were waved away as "pre-existing," "not a
      regression," or "the human's side" without the remediation attached.

### M. Cycle bookkeeping (autonomous-cycle)

- [ ] The `WORK_IN_PROGRESS_<app>.md` checkboxes reflect reality.
- [ ] The `BUILD_REPORT_<app>.md` records: what shipped + key commits, the FULL test + CI
      status, the automated-review issues + disposition, any `HUMAN_SETUP` items (external
      secrets only), the main->branch sync outcome, and a concrete "How to see it in action"
      block.
- [ ] A `HUMAN_SETUP_<app>.md` exists IFF a genuinely external secret/account is needed - and
      it contains only that, never internal engineering parked to avoid doing it.
- [ ] The concurrency lock is released (`status: idle`) after this audit passes.

## What "done" means for this skill

Every line above is `PASS` or a `WAIVER` that names a real reason and the exact remaining
command - with the waiver reserved for the three genuine hand-offs (merge to trunk, external
secret, harness-blocked destructive keystroke). If any line is `MISSING`/`BROKEN`, this skill
is not done: fix it and re-audit. Only then release the lock and declare the cycle complete.

## Hard rules (inherited, restated)

- Never pause for human input; make the call, do the work, record it.
- Everything stays on `suite-brainstorm`; never merge/promote to `main`/`stable`.
- Push the branch, never the trunk. Never `docker compose down -v`. Screenshots gilligan
  only. No `Co-Authored-By`; no em dashes in committed docs. CI reds fixed in-loop.
- No item is ever downgraded to an "optional follow-up." That downgrade is the bug this
  skill was written to kill.
