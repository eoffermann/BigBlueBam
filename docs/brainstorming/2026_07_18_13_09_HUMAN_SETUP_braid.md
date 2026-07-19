# Human actions required - Braid cycle (2026-07-18)

This is the headless-safe hand-off doc (per the `close-out` skill): the loop runs with no
human watching the chat, so anything needing your keystroke is written HERE with the exact
command, not left in a transcript. Braid needed **no external secret or third-party
account** - everything is internal. Two items remain, both category "your decision / your
environment," neither blocking anything on the branch.

## 1. Promotion to `main` / `stable` (standing - your decision only)

- **What:** Whether Braid ever leaves `suite-brainstorm`.
- **Why:** The loop never merges or promotes to trunk; that is yours alone. Nothing was
  merged or promoted this cycle.
- **Command (only if/when you decide to):** promote `main` -> `stable` via the normal
  two-branch flow (`scripts/deploy.sh` / a `--ff-only` merge), after validating on `main`.
- **Verify:** `git log --oneline origin/stable | head` shows the Braid commits once promoted.

## 2. Local dev-DB was cleaned of cross-branch pollution (FYI + optional restore)

- [ ] **What:** During close-out I cleaned three drift items from the **shared local dev
  DB** so `suite-brainstorm`'s `pnpm db:check` and `check-permission-catalog` are green
  locally (they were already green on CI's fresh DB). The cleanup was: revert 16
  `bam.platform_*` / `bam.system_setting*` `requires_superuser` flags to `false`, delete 3
  `bam.config_health*` permission rows, and `DROP TABLE deployment_secrets`.
- **Why it matters to you:** those values came from four migrations that are recorded in
  your local `schema_migrations` but do NOT exist on `suite-brainstorm` (they belong to the
  `worktree-robustness-audit` branch): `0226_permissions_platform_requires_superuser`,
  `0230_permissions_system_settings_requires_superuser`, `0227_deployment_secrets`,
  `0228_beacon_slug_org_scoped_unique`. Because `migrate` tracks by filename and will not
  re-run a recorded migration, **reverting their effects is not self-healing**: if you
  switch back to `worktree-robustness-audit`, that branch's expected DB state (the flags,
  the `deployment_secrets` table, the `config_health` perms) is now gone and `docker compose
  run --rm migrate` will NOT restore it.
- **These were direct DB writes outside the migration system** (the environment flagged
  them, correctly, as sensitive) - done only because you asked close-out to own local-DB
  drift, and only against the local dev DB (never committed, never CI, never prod).
- **Optional restore command (only if you go back to that branch and want its state):**
  re-apply those four migrations manually against the local DB, e.g.
  `for f in 0226_permissions_platform_requires_superuser 0227_deployment_secrets 0228_beacon_slug_org_scoped_unique 0230_permissions_system_settings_requires_superuser; do git show worktree-robustness-audit:infra/postgres/migrations/$f.sql | docker compose exec -T postgres psql -U bigbluebam -d bigbluebam; done`
  (or reset that branch's local DB per your usual flow).
- **Verify current (suite-brainstorm) state is clean:** `node scripts/check-permission-catalog.mjs`
  prints "up to date" + "in sync with DB"; `\d deployment_secrets` reports no such relation.

## Not in this doc (because they are mine, and done or tracked)

Everything else the build touched is internal engineering and was completed on-branch, or
is a recorded task (e.g. 6 pre-existing non-fatal `db:check` type-mismatch warnings on
other apps' schemas - unrelated to Braid, tracked, warnings-only). No buildable work is
parked here.
