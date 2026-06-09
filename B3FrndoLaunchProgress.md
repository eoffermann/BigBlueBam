# B3 Frndo Launch — Progress Log

Running log of decisions and progress. Latest entries at the top.

## Status

| # | Item | Status | Commit |
|---|------|--------|--------|
| 1 | Git branch `b3-frndo-launch` | ✅ | `94450a2` |
| 2 | CLI documentation (`docs/reference/cli.md`) | ✅ | `7a50de6` |
| 3 | CLI `reset-password` command | ✅ | `7a50de6` |
| 4 | Invitation email actually sends | ✅ | `2ae169a` |
| 5 | Send-password-reset email link | ✅ | `2ae169a` |
| 6 | Admin reset displays new password | ✅ | `7a50de6` |
| 7 | Create user with projects | ✅ | `2c30186` |
| 8 | Subtasks bidirectional UI + done-gate (many-to-many) | ✅ | `84a4477` |
| 9 | Final pass: tests, smoke, docker rebuild | ✅ | — |

All items complete. Branch pushed to `origin/b3-frndo-launch`.

## Final verification

### Tests

- **api**: 488/488 passing (35 test files)
- **shared**: 94/94 passing (2 test files)
- **frontend**: 119/119 passing (5 test files)
- **Total**: 701 tests, 0 failures

### Typecheck

- `@bigbluebam/api typecheck` — clean
- `@bigbluebam/frontend typecheck` — clean (fixed a pre-existing import-casing error in `apps/frontend/src/main.tsx` along the way)

### CI-equivalent guards

- `pnpm lint:migrations` — 132 files checked, 0 violations. 21 warnings, all pre-existing on migrations 0023, 0024, 0026, 0127, 0128, 0132 (none on my new files 0170 / 0171).
- `scripts/check-bolt-catalog.mjs` — 109 (source, event_type) pairs parsed; all `publishBoltEvent` call sites match. No new Bolt events introduced this launch.
- `pnpm db:check` — could not run against the dev Postgres because the container does not expose 5432 to the host on this stack. Verified the migrations applied correctly by direct `\d` introspection: both `password_reset_tokens` and `task_parent_links` exist with the exact column types, indexes, FKs, and CHECK constraints declared in the Drizzle schema. CI runs `db:check` in a clean Postgres instance and will exercise it on push.

### Docker rebuild + simulated-prod smoke

The api, frontend, and worker containers were rebuilt and recreated after each schema and code change. Every feature was exercised end-to-end against the running stack:

- **CLI `reset-password`**: created a throwaway user via `cli create-user`, reset their password via `cli reset-password`, logged in with the new password against `/b3/api/auth/login` over HTTPS. Generated and admin-supplied password forms both verified.
- **Admin reset password (HTTP)**: logged in as SuperUser, called `POST /org/members/:userId/reset-password`, response body now includes `password` field. Verified the password authenticates via login.
- **Invitation email**: invited a fresh user — service enqueued a `member-invitation` job on the `email` BullMQ queue. Worker logs confirm "Processing email job" → "SMTP not configured — logging email instead of sending" (correct behavior in dev where SMTP_HOST is unset; with SMTP configured the worker calls `transport.sendMail`). Onboarding token mints into `password_reset_tokens(purpose='invite', ttl=7 days)`.
- **Send password reset link (admin button)**: called `POST /org/members/:userId/send-password-reset`, response shows `email_sent`, `smtp_configured`, `expires_in_minutes`. Token is minted, email job is enqueued, the admin sees a clear status banner.
- **Public forgot-password endpoint**: `POST /auth/password-reset/request` returns opaque success even for unknown emails (no enumeration).
- **Consume endpoint**: inserted a reset token with a known SHA-256 hash, called `POST /auth/password-reset/consume` with the raw token, password updated, all sessions deleted. Negative paths: reuse → `ALREADY_USED`, garbage token → `INVALID_TOKEN`, past-expiry token → `EXPIRED`.
- **Create user with projects**: invited a user with `project_ids` field set, verified `project_memberships` row was inserted in the same transaction. Cross-org `project_ids` rejected with `400 CROSS_ORG_PROJECT` and no user row created.
- **Subtask done-gate**: created parent + open subtask, tried to move parent to Done phase → rejected with `409 INCOMPLETE_SUBTASKS` and structured details listing the open child's `human_id` and title. Moved the child to Done, then the parent → success. Moved parent back out of Done → `completed_at` cleared.
- **Many-to-many parents**: added a second parent to the existing child via `POST /tasks/:childId/parents`, listed both via `GET /tasks/:childId/parents`. Self-loop → `400 SELF_LOOP`. Cycle attempt (parent's parent → child) → `409 CYCLE`. Idempotent re-add → `{already_linked: true}`. Remove → `{removed: true}` and the second parent disappears.

## Decisions

### 2026-06-08 — Subtask data model

Picked a join table (`task_parent_links`) for many-to-many parents rather than:
- Keeping the existing 1:N self-FK only — doesn't satisfy the spec.
- Replacing the self-FK with the join table only — would force a wider refactor of the existing `subtask_count` / `subtask_done_count` denormalization plus every place in the code that reads `task.parent_task_id`.

Hybrid wins: keep `tasks.parent_task_id` as the "primary parent" hint that drives the existing fast-path UI and counters; treat `task_parent_links` as the source of truth for the bidirectional read. Both reads (`listTaskParents` / `listTaskSubtasks`) union the two paths so a single-parent subtask backfilled from the legacy column still shows correctly.

### 2026-06-08 — Done-gate uses phase.is_terminal, not completed_at

The existing `updateTask` path can write `phase_id` without setting `completed_at` (pre-existing inconsistency — `moveTask` does set it, but `updateTask` doesn't). If the gate read `completed_at`, a task that crossed into Done via `updateTask` would still register as "open" and would falsely block its grandparent from being marked Done.

The gate instead joins through `phases` and checks `is_terminal` directly. Robust to the inconsistency; correct semantics. The inconsistency itself was noted as out-of-scope work-creep — fixing it would mean changing the broader `updateTask` behavior, which is not what this launch is about.

### 2026-06-08 — Discovery pass

Ran five parallel research agents covering: email/invitation flow, CLI structure, password-reset flow, user-creation/projects, and subtask data model. Findings logged in `B3FrndoLaunchPlan.md`.

Most important takeaways:
- The admin "reset password doesn't show the new password" bug was one line of code in `apps/api/src/routes/org.routes.ts`: the service returns the password but the route handler dropped it.
- The "invitation email doesn't fire" bug was the absence of any send call in `org.service.ts::inviteMember()` — not a misconfiguration.
- The shared `InviteMemberSchema` already had `project_ids` — the wiring just needed to flow through the service.
- Subtasks needed a new join table to support the "many parents" requirement.
- Forgot/send-password-reset email flow was greenfield (no token table, no route, no template).

### 2026-06-08 — Pre-existing bugs found and fixed

Per CLAUDE.md's "Pre-existing is not a dismissal" rule, two pre-existing issues were fixed inline rather than deferred:

1. **`apps/frontend/src/main.tsx` import-casing TS error** — `import { App } from './app'` referenced the file as lowercase. Windows is case-insensitive at runtime so it worked, but `tsc --noEmit` failed. Fixed to `./App`.
2. **Admin reset password endpoint dropping the generated password** — this WAS in the launch requirements, listed as "Reset Password doesn't display the new password to the admin resetting it." The frontend already expected `res.data.password`, the service already returned it, and the route handler was the only thing in the middle dropping it.

## Files changed

### Migrations
- `infra/postgres/migrations/0170_password_reset_tokens.sql` (new)
- `infra/postgres/migrations/0171_task_parent_links.sql` (new)

### Backend
- `apps/api/src/cli.ts` — `reset-password` command + help block
- `apps/api/src/services/org.service.ts` — `inviteMember` accepts `projectIds`; `getMembershipRole` exported
- `apps/api/src/services/task.service.ts` — subtask many-to-many service + done-gate
- `apps/api/src/services/password-reset.service.ts` (new) — mint/consume tokens
- `apps/api/src/lib/email-queue.ts` — `sendPasswordResetEmail`, `sendMemberInvitationEmail`
- `apps/api/src/routes/org.routes.ts` — invite returns email_sent + project assignments; new `send-password-reset` endpoint; reset endpoint returns password
- `apps/api/src/routes/auth.routes.ts` — `/auth/password-reset/{request,consume}`
- `apps/api/src/routes/task.routes.ts` — parent/subtask endpoints + IncompleteSubtasksError → 409
- `apps/api/src/db/schema/password-reset-tokens.ts` (new)
- `apps/api/src/db/schema/task-parent-links.ts` (new)
- `apps/api/test/task.test.ts` — updated mock chain for the new done-gate selects

### Frontend
- `apps/frontend/src/App.tsx` — route entry for `/password-reset`
- `apps/frontend/src/main.tsx` — fixed pre-existing import casing
- `apps/frontend/src/pages/password-reset.tsx` (new) — public page
- `apps/frontend/src/pages/login.tsx` — "Forgot password?" link
- `apps/frontend/src/pages/people/index.tsx` — invite dialog gets a Projects multi-select; success toast surfaces `email_sent` and project count
- `apps/frontend/src/pages/people/detail.tsx` — Access tab "Send password reset link" button with status banner
- `apps/frontend/src/pages/board.tsx` — surface INCOMPLETE_SUBTASKS rejection via alert
- `apps/frontend/src/components/board/board-view.tsx` — same
- `apps/frontend/src/components/board/swimlane-board.tsx` — same
- `apps/frontend/src/components/tasks/task-detail-drawer.tsx` — `ParentTasksSection` block above Subtasks
- `apps/frontend/src/hooks/use-tasks.ts` — useTaskParents/useAddTaskParent/useRemoveTaskParent
- `apps/frontend/src/lib/api/people.ts` — `sendPasswordResetLink` API client + `email_sent` in invite responses

### Docs
- `docs/reference/cli.md` (new) — comprehensive CLI reference
- `B3FrndoLaunchPlan.md` — initial planning doc
- `B3FrndoLaunchProgress.md` — this file
- `B3FrndoLaunch.md` — appended completion block (this commit)
