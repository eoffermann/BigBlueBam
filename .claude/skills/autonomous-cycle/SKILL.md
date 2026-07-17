---
name: autonomous-cycle
description: The scheduled entry point for the "Startup in a Box" loop. One invocation runs one full cycle - brainstorm a new app, harden its spec, then build/deploy/test it via app-build-from-spec - guarded by a concurrency lock so a new cycle never starts while the previous one is still running. Invoked by the every-6-hours cron; can also be run manually. Never merges to main.
---

# Autonomous cycle (scheduled Startup-in-a-Box loop)

One run of this skill performs **one complete cycle**: pick a new app by brainstorm,
harden its design spec, then build, deploy, and test it - all on `suite-brainstorm`,
never merging to `main`. It is what the every-6-hours cron fires. Its one added job over
running the phases by hand is **concurrency control**: only one cycle may be in flight at
a time.

## The concurrency lock (do this first, every run)

Use a lock file at `<scratchpad>/autonomous-cycle.lock.json` (the session scratchpad dir,
not the repo - it must never be committed). Shape:
`{ "status": "running", "app": "<name-or-tbd>", "phase": "<phase>", "started_at":
"<iso>", "updated_at": "<iso>" }`. Stamp timestamps from `date -u +%FT%TZ` (Bash).

On each run:

1. **Read the lock.** If it is absent, or its `updated_at` is older than **3 hours**
   (a crashed/abandoned cycle), the coast is clear - go to step 4.
2. **If a cycle is genuinely in flight** (lock present and `updated_at` within 3h):
   per the schedule contract, **wait up to 3 hours in hourly steps**, then give up for
   this window. Implement the wait by scheduling a one-shot re-check ~1 hour out
   (`CronCreate` with `recurring: false`, a pinned minute/hour ~60 min ahead) whose prompt
   re-invokes this skill and carries a `retry` counter. On the 1st and 2nd busy re-check,
   reschedule again. On the **3rd** (about 3 hours in) still-busy check, **stop**: log
   "cycle still running after 3h, skipping this window" and exit. The next 6-hour cron
   fire will start fresh. Never run two cycles at once.
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
2. **Brainstorm + harden the spec.** Invoke the `suite-brainstorm` skill. It runs the five
   ideators, debate, vote, and the adversarial spec-hardening loop, and on convergence it
   auto-hands off to the build. If you are running the phases directly, that handoff is
   step 3.
3. **Build, deploy, test.** The winning `docs/brainstorming/<stamp>_APP_DESIGN_<app>.md`
   goes to `app-build-from-spec`: implement, wire the Launchpad + infra, deploy to the
   local Docker dev stack, and run the **extensive tests including the Playwright
   user-story + backend-verification pass**. If the app needs configuration only a human
   can provide, write `docs/brainstorming/<stamp>_HUMAN_SETUP_<app>.md` and keep going.
4. **Release the lock** and write a one-paragraph cycle summary (app shipped, tests status,
   any human-setup doc, any automated-review issues still open) so the next fire and the
   maintainer can see what happened.

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

The cron that fires this is **session-only** (it lives only while this Claude session is
running and auto-expires after 7 days). For a truly unattended multi-day loop the session
must stay alive, or an external scheduler must re-invoke it. Say so when reporting status.
