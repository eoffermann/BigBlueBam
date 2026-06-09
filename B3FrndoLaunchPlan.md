# B3 Frndo Launch — Implementation Plan

This document is the working plan for everything listed in `B3FrndoLaunch.md`. It is updated as strategy shifts.

## Branch

`b3-frndo-launch` (off `main`). All work commits here. Push after each completed feature.

## Discovery summary

Five parallel research passes ran across the relevant subsystems. Key findings inform the plan below.

### Email / Invitation

- SMTP transport: configured via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) AND an in-DB `system_settings` override (precedence: DB > env > default). Cached 30s in the worker.
- Worker email path: `apps/worker/src/jobs/email.job.ts` consumes the `email` BullMQ queue and calls `transport.sendMail()`. Already handles `guest-invitation`, `email-verification`, `email-change-notice` job types generically — adding a new type is just registering it.
- Templates: inline HTML in `apps/api/src/lib/email-queue.ts`. Guest invitations are the closest existing analog (`sendGuestInvitationEmail()`).
- **Root cause of invitation-email bug:** `apps/api/src/services/org.service.ts::inviteMember()` (lines 162–252) creates the user and `organization_memberships` row but never enqueues an email. The guest-invite path by contrast does enqueue and returns `email_sent`.

### CLI

- Entry point `apps/api/src/cli.ts`, 10 commands today (`create-admin`, `create-user`, `grant-superuser`, `revoke-superuser`, `create-api-key`, `create-service-account`, `create-helpdesk-agent-key`, `revoke-api-key`, `revoke-helpdesk-agent-key`, `list-orgs`). Invoked as `docker compose exec api node dist/cli.js <cmd> ...`.
- Password hashing: `argon2.hash(password)` with default options. Same pattern in `org.service.ts::resetMemberPassword()`.
- Session invalidation pattern (from `org.service.ts:509`): `await tx.delete(sessions).where(eq(sessions.user_id, targetUserId))` inside a transaction.
- No tests exist for the CLI. No comprehensive CLI reference doc; only README + `printUsage()` snippets.

### Admin password reset

- Endpoint exists: `POST /org/members/:userId/reset-password` (`apps/api/src/routes/org.routes.ts:947-1006`), backed by `orgService.resetMemberPassword()`.
- Service generates a 16-char password from a confusable-safe alphabet (`generateStrongPassword`) and returns `{ user, password }`.
- **BUG:** Route handler logs the password but does NOT return it in the response. Frontend (`apps/frontend/src/pages/people/detail.tsx`, line 184) expects `res.data.password`. This is the "doesn't display the new password" symptom. Trivial server-side fix.

### Forgot password / email link

- Does NOT exist. No `password_reset_tokens` table, no route, no worker job, no frontend page. Must build greenfield.

### User-create + projects

- Shared `InviteMemberSchema` in `packages/shared/src/schemas/organization.ts` already declares `project_ids?: string[]`. So the wire shape is ready.
- `org.service.ts::inviteMember()` currently ignores `project_ids`.
- `apps/frontend/src/pages/people/index.tsx` invite dialog doesn't expose a project picker.
- `addMemberToProjects` route + UI already exist on the user-detail page — but the *create* flow doesn't reuse them.

### Subtasks

- Existing data model: `tasks.parent_task_id` self-FK (nullable). Denormalized `subtask_count` / `subtask_done_count` columns. Indexed on `parent_task_id`.
- Frontend already shows a "Subtasks" section on the task-detail drawer (`apps/frontend/src/components/tasks/task-detail-drawer.tsx:731-795`) and a tiny progress bar on the card.
- **Missing:**
  - "Parent Tasks" section on the detail drawer.
  - Many-to-many: a subtask can have multiple parents — the current 1:N FK can't represent that.
  - Done-gate: API does not enforce "all subtasks done before parent can move to terminal phase". `task.service.ts::moveTask()` only sets `completed_at` and moves on.
- "Done" semantics: a phase row with `is_terminal=true`. That's the gate to check.

## Implementation plan

Order roughly follows the order in `B3FrndoLaunch.md`. Each item ends in commit + push after passing local checks.

### 1. CLI documentation

Create `docs/reference/cli.md`. Contents: one section per existing command (subject, required/optional flags, examples, error modes), plus the new `reset-password` command added in step 2. Link from `README.md` and from `docs/guides/getting-started.md`. Mirror `printUsage()` output so they don't drift.

### 2. CLI `reset-password`

Add subcommand to `apps/api/src/cli.ts`:

```
reset-password --email <user-email> [--password <new-pw>] [--show-only]
```

- If `--password` omitted, use `generateStrongPassword(16)` (export from `org.service.ts` or duplicate the helper — likely export it to avoid duplicating randomness logic).
- Hash with `argon2.hash()`.
- Update `users.password_hash` and `users.updated_at` in a transaction.
- Inside same transaction, `DELETE FROM sessions WHERE user_id = ...` (matches `resetMemberPassword` semantics).
- Print the chosen/generated password to stdout (the whole point of a CLI password reset). Print user id + email for confirmation.
- Add to `printUsage()` help block.
- Unit test: spin up an in-memory or test DB? — repo doesn't show CLI tests at all, so a smoke test is sufficient: run the CLI against the live dev DB, then attempt to log in via the API and confirm success.

### 3. Fix admin-reset endpoint to return new password

`apps/api/src/routes/org.routes.ts:947-1006`: include `password` (and `generated` flag) in the response body. Service already returns it; route just drops it.

Tighten the response surface: include `password` only when the route generated it OR when the request omitted `password` (i.e. don't echo back an admin-supplied password — there's no purpose to that and it's a small information-leak win). Frontend (`detail.tsx`) already expects `res.data.password` and surfaces it in a reveal-once dialog, so no UI work needed — but verify the dialog actually copies and clears state on close. If it doesn't, fix that too.

Add a unit test in `apps/api/test/` for the route exercising both branches (generated vs admin-provided password).

### 4. Add member-invitation email

- Add `sendMemberInvitationEmail({ email, displayName, orgName, inviterName, tempPassword? })` to `apps/api/src/lib/email-queue.ts`, modeled on `sendGuestInvitationEmail()`. Job type: `'member-invitation'`. Returns `boolean` (true if enqueued).
- New worker handling: extend `apps/worker/src/jobs/email.job.ts` to render the member-invitation template (subject + HTML + text). Plain HTML matching the guest template aesthetic. Include the org name, inviter name, login URL (`PUBLIC_BASE_URL + '/b3/'`), and — if a temp password was generated for them — that temp password plus a note to change it on first login.
- Wire it into `org.service.ts::inviteMember()`: after creating the org membership, enqueue the email and propagate `email_sent` to the route response. The route at `/org/members/invite` should mirror the guest-invite return shape (`email_sent: boolean`, with a warning toast in the UI if false).
- Frontend (`apps/frontend/src/pages/people/index.tsx`): surface `email_sent` in the success toast so the admin knows whether the email actually went out (e.g. "Invited Alice. (SMTP not configured — share credentials manually.)").
- Add unit test exercising `inviteMember()` with and without SMTP configured.

### 5. Send-password-reset email (forgot password / admin-triggered reset link)

Greenfield. Pieces:

- **DB migration**: `password_reset_tokens(id uuid pk, user_id uuid fk, token_hash text, expires_at timestamptz, used_at timestamptz, created_at timestamptz default now())`. SHA-256 the token; store hash. Add index `(user_id)` and `(expires_at)`.
- **Token issuance** (admin-initiated for now — the immediate user-management need): new endpoint `POST /org/members/:userId/send-password-reset` that mints a token, stores hash, enqueues email job type `'password-reset'` with the raw token in the link.
- **Token consumption**: new public endpoint `POST /auth/password-reset/consume` that takes `{ token, new_password }`, looks up by SHA-256 of token, checks `expires_at > now()`, checks `used_at IS NULL`, sets `used_at = now()`, updates the user's `password_hash`, deletes all sessions for that user. Rate-limit hard (5/min/IP).
- **Frontend page** at `/b3/password-reset?token=...` — minimal: shows the form, calls the consume endpoint, redirects to login on success.
- **Admin button**: add "Send password reset link" to the Access tab on `apps/frontend/src/pages/people/detail.tsx`, alongside the existing "Reset password" button. Calls the new send endpoint and toasts "Email sent" or "SMTP not configured".
- Email template: subject "Reset your BigBlueBam password", body with link + 1h expiry note.
- Default expiry: 60 minutes (configurable via env `PASSWORD_RESET_TOKEN_TTL_MINUTES`, default 60).
- Unit tests for: token mint, token consume happy path, expired, already-used, wrong-token.

### 6. Combined create-user + add-to-projects

- Frontend (`apps/frontend/src/pages/people/index.tsx`): in the invite dialog, after the role field, add a "Projects" multi-select. Defer the role within each project to a sensible default (`member`) for now to keep the UX simple — admins can edit individual project roles after creation via the existing Projects tab.
- API: `org.service.ts::inviteMember()` already receives `project_ids` from the schema but ignores them. Threading: after the org-membership row is created, iterate `project_ids` and insert into `project_memberships` (default role `'member'`), idempotent on `(project_id, user_id)`.
- Permission: project IDs must belong to the same org as the inviter (existing pattern from `addMemberToProjects` in org.service.ts).
- Bulk invite flow (`/org/members/invite/bulk`) gets the same enhancement — apply `project_ids` to every invited row.
- Unit test for inviting with `project_ids` and asserting `project_memberships` rows exist.

### 7. Subtasks (many-to-many + done-gate)

This is the largest single item. Decision: **introduce a join table** so a single task can have multiple parents.

- **Migration**: new table `task_parent_links(task_id uuid not null, parent_task_id uuid not null, created_at timestamptz default now(), created_by uuid, primary key (task_id, parent_task_id))`. Backfill from existing `tasks.parent_task_id`. Keep the `parent_task_id` column as the "primary parent" pointer for legacy code (board carry-forward, subtask_count denormalization). Add index `(parent_task_id)`.
- **Drizzle schema**: add `task_parent_links` table file.
- **Service layer** (`apps/api/src/services/task.service.ts`):
  - `addParent(taskId, parentTaskId)`: idempotent insert. Reject self-loop. Reject cycle (DFS up to depth ~16).
  - `removeParent(taskId, parentTaskId)`: delete row.
  - `listParents(taskId)`: read from join table.
  - `listSubtasks(parentTaskId)`: read from join table.
  - Update `moveTask()`: when target phase is terminal, query the join table for incomplete children (`tasks.completed_at IS NULL`) and reject with a structured error if any exist.
  - When marking a task complete via state change (not just phase), same gate.
  - Counter maintenance: when adding/removing a link, recompute `subtask_count` and `subtask_done_count` on the parent. Existing maintenance triggered on subtask completion should iterate parents instead of single parent.
- **Routes** (`apps/api/src/routes/task.routes.ts`):
  - `POST /tasks/:id/parents` (body: `{ parent_task_id }`)
  - `DELETE /tasks/:id/parents/:parentId`
  - `GET /tasks/:id/parents` → list
  - `GET /tasks/:id/subtasks` → list (already implicit in `task.subtasks_count` but no list endpoint exists)
  - Keep existing `parent_task_id` on create/update for back-compat; when set, also insert into join table.
- **Frontend**:
  - `apps/frontend/src/components/tasks/task-detail-drawer.tsx`: add "Parent tasks" section above or below the existing "Subtasks" section. Same chip-list aesthetic. "+ Add parent" button → task picker dialog scoped to the project.
  - Add "↳ subtask of N tasks" header indicator when `parentCount > 0`.
  - On the "mark done" / move-to-terminal-phase actions, display a blocking dialog if subtasks incomplete: "Cannot mark Done — N subtasks still open." Error comes from the new API guard.
- **MCP** (out-of-scope for this turn unless trivial — the design doc mentions subtask tools as desirable; if time allows, add `bam_add_subtask` / `bam_list_subtasks` thin wrappers).
- Tests:
  - Unit: cycle detection, idempotent insert, done-gate happy/sad path.
  - Integration: end-to-end create-parent-with-two-subtasks, try to mark parent done before children done → expect 409; mark children done; mark parent done → expect 200.

### 8. Final verification

- Run `pnpm test` across affected packages.
- Run `pnpm --filter @bigbluebam/api test`, `pnpm --filter @bigbluebam/frontend test`, `pnpm --filter @bigbluebam/shared test`.
- Run `pnpm db:check` to confirm no drift.
- Run `pnpm lint:migrations`.
- Run `node scripts/check-bolt-catalog.mjs` (no new Bolt events expected, but check).
- Rebuild docker images for the changed apps and re-up them.
- Smoke tests (manual, scripted via API calls):
  - `reset-password` CLI: change password, verify login works.
  - Invite user: confirm email-job enqueued in Redis, then check worker log for send attempt (or actual delivery if SMTP configured).
  - Admin reset password: confirm response includes password.
  - Send password reset link: confirm email enqueued, copy the link from logs, set new password via the consumption endpoint, log in.
  - Create user with project_ids: verify project_memberships rows exist.
  - Subtasks: try to mark a parent done with open subtasks → expect rejection; mark children → mark parent → success.
- Iterate through `B3FrndoLaunch.md` second time and verify each line item.
- Update `B3FrndoLaunch.md` with a status block at the bottom.

## Risks and mitigations

- **DB checksum immutability**: any new migration is append-only with the required header (Why, Client impact) and idempotent guards. Easy.
- **Worker email job type drift**: extending `email.job.ts` requires a worker rebuild. Compose flow accounts for this.
- **Many-to-many backfill correctness**: the migration backfill must produce exactly one join row per non-null `parent_task_id`. Use `INSERT INTO task_parent_links (task_id, parent_task_id) SELECT id, parent_task_id FROM tasks WHERE parent_task_id IS NOT NULL ON CONFLICT DO NOTHING`.
- **Cycle detection cost**: bounded DFS at insert time (depth 16). Sufficient for realistic project sizes.
- **Reveal-once UX for admin password**: easy to lose the password if not copied. Frontend already has the dialog skeleton; verify clipboard copy and warn before close.
- **Token security for reset link**: use 256-bit random tokens (`randomBytes(32).toString('base64url')`), store only SHA-256 hash, rate-limit, single-use.

## Operational notes

- Never run `docker compose down -v`. Per CLAUDE.md, the dev DB has seed data we want to preserve.
- After adding a migration file, run `docker compose run --rm migrate` (the bind mount makes the file visible to the runner immediately, no rebuild needed).
- For app-code changes: `docker compose build <app> && docker compose up -d --force-recreate <app>`.
- Push the branch after each major item lands and tests pass.
