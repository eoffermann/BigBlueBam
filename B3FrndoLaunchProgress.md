# B3 Frndo Launch — Progress Log

Running log of decisions and progress. Latest entries at the top.

## Status

| # | Item | Status | Commit |
|---|------|--------|--------|
| 1 | Git branch `b3-frndo-launch` | ✅ | — |
| 2 | CLI documentation (`docs/reference/cli.md`) | ⏳ pending | — |
| 3 | CLI `reset-password` command | ⏳ pending | — |
| 4 | Invitation email actually sends | ⏳ pending | — |
| 5 | Send-password-reset email link | ⏳ pending | — |
| 6 | Admin reset displays new password | ⏳ pending | — |
| 7 | Create user with projects | ⏳ pending | — |
| 8 | Subtasks bidirectional UI + done-gate (many-to-many) | ⏳ pending | — |
| 9 | Final pass: tests, smoke, docker rebuild | ⏳ pending | — |

## Decisions

### 2026-06-08 — Discovery pass

Ran five parallel research agents covering: email/invitation flow, CLI structure, password-reset flow, user-creation/projects, and subtask data model. Findings logged in `B3FrndoLaunchPlan.md`.

Most important takeaways:
- The admin "reset password doesn't show the new password" bug is one line of code in `apps/api/src/routes/org.routes.ts`: the service returns the password but the route handler drops it.
- The "invitation email doesn't fire" bug is the absence of any send call in `org.service.ts::inviteMember()` — not a misconfiguration.
- The shared `InviteMemberSchema` already has `project_ids` — the wiring just needs to flow through the service.
- Subtasks need a new join table to support the "many parents" requirement. Existing `parent_task_id` self-FK stays as a back-compat hint.
- Forgot/send-password-reset email flow is greenfield (no token table, no route, no template).

### 2026-06-08 — Implementation ordering

Will work through requirements roughly in the order they appear in `B3FrndoLaunch.md`. Commits per feature, push after each successful local test.

The two cheap wins (admin password display, member invitation email) come first — they're high-value and low-risk and unblock the rest of the testing flow.

Subtasks last because they're the biggest single change.
