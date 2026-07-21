---
name: autonomous-cycle
description: The scheduled entry point for the "Startup in a Box" loop. One invocation runs one full cycle - brainstorm a new app, harden its spec, then build/deploy/test it via app-build-from-spec - guarded by a concurrency lock so a new cycle never starts while the previous one is still running. Invoked once daily at 8pm by the Windows Task Scheduler job "BigBlueBam Autonomous Cycle"; can also be run manually. Never merges to main.
---

# Autonomous cycle (scheduled Startup-in-a-Box loop)

One run of this skill performs **one complete cycle**: pick a new app by brainstorm,
harden its design spec, then build, deploy, and test it - all on `suite-brainstorm`,
never merging to `main`. It is what the daily-at-8pm **Windows Task Scheduler** job fires
(the task "BigBlueBam Autonomous Cycle", registered by
`scripts/autonomous/register-autonomous-task.ps1`, which launches `claude` headless via
`scripts/autonomous/run-autonomous-cycle.ps1`). Its one added job over running the phases
by hand is **concurrency control**: only one cycle may be in flight at a time.

## The concurrency lock (do this first, every run)

Use a lock file at `.autonomous-logs/autonomous-cycle.lock.json` (repo-relative, in the
gitignored `.autonomous-logs/` dir - it must never be committed). **Do NOT use the session
scratchpad dir**: each Windows Task Scheduler fire is a fresh `claude` session with a
different scratchpad, so a scratchpad lock would not be shared across runs and every fire
would think the coast is clear. A stable repo-relative path is shared across runs. Shape:
`{ "status": "running", "app": "<name-or-tbd>", "phase": "<phase>", "started_at":
"<iso>", "updated_at": "<iso>" }`. Stamp timestamps from `date -u +%FT%TZ` (Bash).

Note the Task Scheduler wrapper (`scripts/autonomous/run-autonomous-cycle.ps1`) already
holds its own coarser process-level lock (`.autonomous-logs/cycle.lock`) and is registered
with `-MultipleInstances IgnoreNew`, so the OS will not start a second run while one is
active. This skill-level lock is the finer-grained state (phase/app) plus the 3h-staleness
takeover.

On each run:

1. **Read the lock.** If it is absent, or its `updated_at` is older than **3 hours**
   (a crashed/abandoned cycle), the coast is clear - go to step 4.
2. **If a cycle is genuinely in flight** (lock present and `updated_at` within 3h):
   **skip this run** - log "cycle still running (updated <3h ago), skipping this window"
   and exit cleanly. Do NOT try to schedule a delayed re-check: this is a headless one-shot
   run with no persistent session, and the next Windows Task Scheduler fire (~24 hours out,
   the daily 20:00/8pm cadence) is the retry. Never run two cycles at once.
3. Do not delete another live cycle's lock. Only a lock older than 3h may be taken over.
4. **Acquire the lock:** write it with `status: "running"`, `phase: "brainstorm"`,
   fresh timestamps. Refresh `updated_at` (and `phase`/`app`) at each major phase so a
   parallel fire can tell you are alive.

Wrap the whole cycle so the lock is **always released** (set `status: "idle"` or delete
the file) on completion AND on failure - a crash must not wedge the loop for more than the
3-hour staleness window.

## The cycle

With the lock held:

1. **Confirm the branch.** `git switch suite-brainstorm`; if the tree is unexpectedly
   dirty (beyond known pre-existing changes), record it and stop rather than guessing.
2. **Sync from `main` FIRST (before any brainstorm or build).** Pull the latest trunk into
   the branch so a new app is built on top of current `main`, not a stale snapshot:
   `git fetch origin`, then `git merge --no-edit origin/main` into `suite-brainstorm`. This
   is the ALLOWED merge direction (main -> branch); it is NOT a violation of the
   no-merge-to-trunk rule, which only forbids the reverse (branch -> main). Then:
   - **Clean merge:** push the branch (`git push origin suite-brainstorm`) and continue.
   - **Conflicts:** resolve them yourself (never pause). Prefer `main`'s version for shared
     and platform files (`packages/*`, `infra/*`, the Bam `apps/api` core, `CLAUDE.md`,
     numbered migrations) and keep the branch's version for brainstorming artifacts
     (`docs/brainstorming/*`) and satellite-app code that lives only on the branch. Commit
     the resolved merge and push.
   - **Intractable conflict:** `git merge --abort`, note it in the cycle summary, and
     continue the cycle on the un-synced branch. A sync problem must NEVER block, pause, or
     abort the loop - staying in sync is best-effort, shipping the cycle is not.
   After a new migration arrives from `main`, re-run `docker compose run --rm migrate` before
   building so the local DB matches trunk.
3. **Brainstorm + harden the spec.** Invoke the `suite-brainstorm` skill. It runs the five
   ideators, debate, vote, and the adversarial spec-hardening loop, and on convergence it
   auto-hands off to the build. If you are running the phases directly, that handoff is
   step 4.
4. **Build, deploy, test.** The winning `docs/brainstorming/<stamp>_APP_DESIGN_<app>.md`
   goes to `app-build-from-spec`: implement, wire the Launchpad + infra, deploy to the
   local Docker dev stack, and run the **extensive tests including the Playwright
   user-story + backend-verification pass**. If the app needs configuration only a human
   can provide, write `docs/brainstorming/<stamp>_HUMAN_SETUP_<app>.md` and keep going.
4a. **Launchpad-completeness is a hard gate; a failing gate RESUMES engineering, it does
   not ship.** An app is registered in `LAUNCHPAD_CATALOG` only once it is complete to the
   suite-common standard (MCP tools, help doc + index, marketing section, User-Story
   screenshots). `pnpm check:app-completeness` enforces this and fails CI otherwise. If a
   cycle dies mid-build (a previous fire crashed, or the build was interrupted) an app can
   be left in the Launchpad half-finished - this is a defect, never an acceptable resting
   state. When you detect a Launchpad app that fails `check:app-completeness` (this one or a
   leftover from an earlier fire), you MUST: (a) run an **agentic readiness review** of that
   app's plan (its `*_APP_DESIGN_<app>.md` spec) and current functionality - is the plan
   sound and worth completing, or should the app be pulled; then (b) if worth completing,
   **resume automated engineering** and finish every missing milestone (schema/migrations,
   MCP tool parity, SPA, permissions, help docs + Help Center, gilligan screenshots,
   marketing section, tests) exactly as `app-build-from-spec` would for a fresh build, until
   the gate is green; or (c) if the review says pull it, remove its `LAUNCHPAD_CATALOG` entry
   (and its scaffold/nginx/compose wiring) so nothing incomplete remains consumer-facing.
   Do not weaken the gate, and do not release the lock with any Launchpad app red.
5. **Run the `close-out` skill BEFORE releasing the lock.** Invoke `close-out` (via the
   Skill tool) with the app id + stamp. It is the completion audit: it re-checks every
   requirement of this whole process against the real repo + running stack and picks up
   anything that was skipped or quietly relabeled an "optional follow-up." Do not release
   the lock or declare the cycle done until close-out passes. This exists because required
   work (Playwright e2e, help-index/Help Center, the permission delta + built-in-group
   grants, surface-map completeness, pre-existing + local-DB drift) has been dropped by
   calling it a "follow-up" - close-out is the backstop that refuses that.
6. **Release the lock** and write a one-paragraph cycle summary (app shipped, tests status,
   whether the main->branch sync was clean/conflicted/skipped, any human-setup doc, any
   automated-review issues still open) so the next fire and the maintainer can see what
   happened.

## Hard rules (inherited, restated)

- **NEVER pause for human input, approval, or sign-off. Ever.** This loop is fully
  autonomous and usually runs with no human present. Do not ask questions or wait for a
  decision - make the reasonable call, record it, and continue. Anything needing a
  human-provided secret/account goes in the HUMAN_SETUP doc while the build proceeds on
  everything else; it is never a stopping point.
- **Everything stays on `suite-brainstorm`** (feature branches off it). Never merge or
  promote into `main`/`stable` - but that is not a pause: promotion is out of scope, so
  the loop just keeps producing on the branch. A human may promote separately; the loop
  does not wait for it.
- Push branches to origin (so CI + the post-commit-review pipeline run); never push the
  trunk.
- Never `docker compose down -v`. Screenshots use the **gilligan** project only. No
  `Co-Authored-By` footer; no em dashes in committed docs.
- CI reds and review findings are fixed autonomously (in-loop), never escalated to a
  human to resolve.

## Note on durability

This loop is fired by a **Windows Task Scheduler** job ("BigBlueBam Autonomous Cycle")
that runs independently of any Claude session, needs no session to stay alive, and does
not expire. It is registered once by `scripts/autonomous/register-autonomous-task.ps1`
(S4U logon, so it runs whether or not the user is logged in) and launches a headless
`claude` per fire via `scripts/autonomous/run-autonomous-cycle.ps1`, once daily at 8pm. This
replaced the earlier session-only in-session cron (which only lived while a Claude session
was open and auto-expired after 7 days, so it silently stopped). If the loop ever needs
to change cadence or be paused, re-run the register script (or disable/enable the task in
Task Scheduler) - do not rely on any in-session scheduling primitive for durability.
