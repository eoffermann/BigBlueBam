# Wave D audit — apps/api per-action permission coverage

_Generated: 2026-05-18T05:05:34.298Z from `docs/permissions-action-manifest.json` and `apps/api/src/routes/`_

Audit script: `scripts/wave-d-audit.mjs` (read-only).

## 1. Summary counts

| Category | Count |
|---|---|
| **Total in-scope permissions** | 246 |
| OK (resolver gate present with matching permission_id) | 120 |
| MISMATCH (gate present but with different permission_id) | 0 |
| NO_GATE (route exists, no dualReadGate / requireCan / shadowOnly) | 125 |
| MISSING_ROUTE (manifest entry has no matching route handler) | 0 |
| INLINE_CHECK (preHandler missing but handler body has `is_superuser` gating) | 1 |

OK ratio: **48.8%** (120 / 246).

Out-of-scope entries skipped (basename collision with sub-app route files, e.g. `comment.routes.ts` in apps/brief-api): **52**.

### Scope definition

In-scope means: `source.source === 'rest'` AND `path.basename(source.file)` is present in `apps/api/src/routes/` AND (the permission `app` is one of `bam` / `platform` / `shared`, OR a matching route handler is actually found in apps/api). The "OR" clause covers a handful of cross-app permissions whose REST surface really does live in the Bam main API (none observed after the collision filter ran — all 52 dropped entries belonged to banter/beacon/board/bolt/book/brief route files of the same basename).

### Gate vocabulary

Counted as a permission gate (the script looks for these in the route's `preHandler` text):
- `dualReadGate({ ..., permission: '<id>' })` (Wave B canonical shape)
- `requireCan('<id>')` / `fastify.requireCan('<id>')` (Wave C target shape)
- `shadowOnly('<id>')` (for routes that had no legacy gate)

Explicitly NOT counted (per audit brief):
- `requireAuth` (authentication only)
- `requireScope(...)` (API-key scope ceiling)
- `requireProjectAccess` / `requireProjectAccessForEntity` (entity visibility)
- Legacy role gates (`requireMinRole`, `requireOrgRole`, `requireRole`, `requireProjectRole`, `requireSuperuser`) — when present *without* a dualReadGate wrapper, the row is classified NO_GATE even though authz still happens via the legacy path.

## 2. Per-file coverage

| File | Expected | OK | MISMATCH | NO_GATE | INLINE_CHECK | MISSING_ROUTE | OK % |
|---|---:|---:|---:|---:|---:|---:|---:|
| `superuser.routes.ts` | 23 | 23 | 0 | 0 | 0 | 0 | 100% |
| `org.routes.ts` | 22 | 18 | 0 | 4 | 0 | 0 | 82% |
| `platform.routes.ts` | 11 | 0 | 0 | 11 | 0 | 0 | 0% |
| `task.routes.ts` | 11 | 7 | 0 | 4 | 0 | 0 | 64% |
| `auth.routes.ts` | 9 | 0 | 0 | 9 | 0 | 0 | 0% |
| `guest.routes.ts` | 8 | 7 | 0 | 1 | 0 | 0 | 88% |
| `report.routes.ts` | 8 | 0 | 0 | 8 | 0 | 0 | 0% |
| `sprint.routes.ts` | 8 | 5 | 0 | 3 | 0 | 0 | 63% |
| `llm-provider.routes.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 100% |
| `project.routes.ts` | 7 | 4 | 0 | 3 | 0 | 0 | 57% |
| `user.routes.ts` | 6 | 0 | 0 | 6 | 0 | 0 | 0% |
| `internal-helpdesk.routes.ts` | 5 | 0 | 0 | 5 | 0 | 0 | 0% |
| `label.routes.ts` | 5 | 3 | 0 | 2 | 0 | 0 | 60% |
| `phase.routes.ts` | 5 | 2 | 0 | 3 | 0 | 0 | 40% |
| `agent.routes.ts` | 4 | 0 | 0 | 4 | 0 | 0 | 0% |
| `agent-policies.routes.ts` | 4 | 0 | 0 | 4 | 0 | 0 | 0% |
| `agent-webhooks.routes.ts` | 4 | 0 | 0 | 4 | 0 | 0 | 0% |
| `api-key.routes.ts` | 4 | 3 | 0 | 0 | 1 | 0 | 75% |
| `oauth.routes.ts` | 4 | 0 | 0 | 4 | 0 | 0 | 0% |
| `comment.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `custom-field.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `epic.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `notification.routes.ts` | 4 | 0 | 0 | 4 | 0 | 0 | 0% |
| `github-integration.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `import.routes.ts` | 4 | 4 | 0 | 0 | 0 | 0 | 100% |
| `slack-integration.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `template.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `view.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `webhook.routes.ts` | 4 | 3 | 0 | 1 | 0 | 0 | 75% |
| `system-settings.routes.ts` | 4 | 2 | 0 | 2 | 0 | 0 | 50% |
| `attachment-meta.routes.ts` | 3 | 0 | 0 | 3 | 0 | 0 | 0% |
| `attachment.routes.ts` | 3 | 2 | 0 | 1 | 0 | 0 | 67% |
| `service-account.routes.ts` | 3 | 2 | 0 | 1 | 0 | 0 | 67% |
| `entity-links.routes.ts` | 3 | 0 | 0 | 3 | 0 | 0 | 0% |
| `launchpad.routes.ts` | 3 | 2 | 0 | 1 | 0 | 0 | 67% |
| `time-entry.routes.ts` | 3 | 1 | 0 | 2 | 0 | 0 | 33% |
| `proposals.routes.ts` | 3 | 0 | 0 | 3 | 0 | 0 | 0% |
| `activity-unified.routes.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0% |
| `reaction.routes.ts` | 2 | 1 | 0 | 1 | 0 | 0 | 50% |
| `dedupe-decisions.routes.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0% |
| `upload.routes.ts` | 2 | 1 | 0 | 1 | 0 | 0 | 50% |
| `ical.routes.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0% |
| `activity.routes.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0% |
| `public-config.routes.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0% |
| `permissions-divergences.routes.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 100% |
| `approval.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `email-verify.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `internal-llm.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `expertise.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `task-state.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `export.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `task-analytics.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `visibility.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `github-webhook.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |
| `slack-webhook.routes.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0% |

## 3. Detail tables

### 3.1 OK (120) — gates present with matching permission_id

Compact listing (full data is in `audit-output.json`):

| permission_id | method+path | file:line | gate_pattern_found | flags |
|---|---|---|---|---|
| `bam.attachment.delete` | `DELETE /attachments/:id` | `attachment.routes.ts:65` | `dualReadGate(bam.attachment.delete)` | DESTRUCTIVE, WRITE |
| `bam.audit_log.list` | `GET /audit-log` | `superuser.routes.ts:1203` | `dualReadGate(bam.audit_log.list)` | - |
| `bam.auth_api_key.create` | `POST /auth/api-keys` | `api-key.routes.ts:53` | `dualReadGate(bam.auth_api_key.create)` | WRITE |
| `bam.auth_api_key.delete` | `DELETE /auth/api-keys/:id` | `api-key.routes.ts:262` | `dualReadGate(bam.auth_api_key.delete)` | DESTRUCTIVE, WRITE |
| `bam.auth_api_key.rotate` | `POST /auth/api-keys/:id/rotate` | `api-key.routes.ts:171` | `dualReadGate(bam.auth_api_key.rotate)` | WRITE |
| `bam.auth_service_account.create` | `POST /auth/service-accounts` | `service-account.routes.ts:167` | `dualReadGate(bam.auth_service_account.create)` | WRITE |
| `bam.auth_service_account.delete` | `DELETE /auth/service-accounts/:id` | `service-account.routes.ts:333` | `dualReadGate(bam.auth_service_account.delete)` | DESTRUCTIVE, WRITE |
| `bam.beta_signup.list` | `GET /beta-signups` | `superuser.routes.ts:1394` | `dualReadGate(bam.beta_signup.list)` | - |
| `bam.comment_reaction.create` | `POST /comments/:id/reactions` | `reaction.routes.ts:14` | `dualReadGate(bam.comment_reaction.create)` | WRITE |
| `bam.comment.delete` | `DELETE /comments/:id` | `comment.routes.ts:266` | `dualReadGate(bam.comment.delete)` | DESTRUCTIVE, WRITE |
| `bam.comment.update` | `PATCH /comments/:id` | `comment.routes.ts:218` | `dualReadGate(bam.comment.update)` | WRITE |
| `bam.context_clear.create` | `POST /context/clear` | `superuser.routes.ts:489` | `dualReadGate(bam.context_clear.create)` | WRITE |
| `bam.context.switch` | `POST /context/switch` | `superuser.routes.ts:423` | `dualReadGate(bam.context.switch)` | SU, WRITE |
| `bam.custom_field.delete` | `DELETE /custom-fields/:id` | `custom-field.routes.ts:99` | `dualReadGate(bam.custom_field.delete)` | DESTRUCTIVE, WRITE |
| `bam.custom_field.update` | `PATCH /custom-fields/:id` | `custom-field.routes.ts:56` | `dualReadGate(bam.custom_field.update)` | WRITE |
| `bam.epic.delete` | `DELETE /epics/:id` | `epic.routes.ts:114` | `dualReadGate(bam.epic.delete)` | DESTRUCTIVE, WRITE |
| `bam.epic.update` | `PATCH /epics/:id` | `epic.routes.ts:71` | `dualReadGate(bam.epic.update)` | WRITE |
| `bam.guest_invitation_resend.create` | `POST /v1/guests/invitations/:id/resend` | `guest.routes.ts:230` | `dualReadGate(bam.guest_invitation_resend.create)` | WRITE |
| `bam.guest_invitation.delete` | `DELETE /v1/guests/invitations/:id` | `guest.routes.ts:191` | `dualReadGate(bam.guest_invitation.delete)` | DESTRUCTIVE, WRITE |
| `bam.guest_invitation.list` | `GET /v1/guests/invitations` | `guest.routes.ts:163` | `dualReadGate(bam.guest_invitation.list)` | - |
| `bam.guest_scope.update` | `PATCH /v1/guests/:id/scope` | `guest.routes.ts:503` | `dualReadGate(bam.guest_scope.update)` | WRITE |
| `bam.guest.delete` | `DELETE /v1/guests/:id` | `guest.routes.ts:610` | `dualReadGate(bam.guest.delete)` | DESTRUCTIVE, WRITE |
| `bam.guest.invite` | `POST /v1/guests/invite` | `guest.routes.ts:20` | `dualReadGate(bam.guest.invite)` | WRITE |
| `bam.guest.list` | `GET /v1/guests` | `guest.routes.ts:473` | `dualReadGate(bam.guest.list)` | - |
| `bam.label.delete` | `DELETE /labels/:id` | `label.routes.ts:142` | `dualReadGate(bam.label.delete)` | DESTRUCTIVE, WRITE |
| `bam.label.update` | `PATCH /labels/:id` | `label.routes.ts:103` | `dualReadGate(bam.label.update)` | WRITE |
| `bam.llm_provider_resolve.list` | `GET /llm-providers/resolve` | `llm-provider.routes.ts:159` | `dualReadGate(bam.llm_provider_resolve.list)` | - |
| `bam.llm_provider_test.create` | `POST /llm-providers/:id/test` | `llm-provider.routes.ts:295` | `dualReadGate(bam.llm_provider_test.create)` | WRITE |
| `bam.llm_provider.create` | `POST /llm-providers` | `llm-provider.routes.ts:60` | `dualReadGate(bam.llm_provider.create)` | WRITE |
| `bam.llm_provider.delete` | `DELETE /llm-providers/:id` | `llm-provider.routes.ts:267` | `dualReadGate(bam.llm_provider.delete)` | DESTRUCTIVE, WRITE |
| `bam.llm_provider.get` | `GET /llm-providers/:id` | `llm-provider.routes.ts:183` | `dualReadGate(bam.llm_provider.get)` | - |
| `bam.llm_provider.list` | `GET /llm-providers` | `llm-provider.routes.ts:43` | `dualReadGate(bam.llm_provider.list)` | - |
| `bam.llm_provider.update` | `PATCH /llm-providers/:id` | `llm-provider.routes.ts:211` | `dualReadGate(bam.llm_provider.update)` | WRITE |
| `bam.org_launchpad_app.list` | `GET /org/launchpad-apps` | `launchpad.routes.ts:92` | `dualReadGate(bam.org_launchpad_app.list)` | - |
| `bam.org_launchpad_app.update` | `PUT /org/launchpad-apps` | `launchpad.routes.ts:119` | `dualReadGate(bam.org_launchpad_app.update)` | WRITE |
| `bam.org_member_active.update` | `PATCH /org/members/:userId/active` | `org.routes.ts:245` | `dualReadGate(bam.org_member_active.update)` | WRITE |
| `bam.org_member_activity.get` | `GET /org/members/:userId/activity` | `org.routes.ts:707` | `dualReadGate(bam.org_member_activity.get)` | - |
| `bam.org_member_api_key.create` | `POST /org/members/:userId/api-keys` | `org.routes.ts:596` | `dualReadGate(bam.org_member_api_key.create)` | WRITE |
| `bam.org_member_api_key.delete` | `DELETE /org/members/:userId/api-keys/:keyId` | `org.routes.ts:665` | `dualReadGate(bam.org_member_api_key.delete)` | DESTRUCTIVE, WRITE |
| `bam.org_member_api_key.get` | `GET /org/members/:userId/api-keys` | `org.routes.ts:565` | `dualReadGate(bam.org_member_api_key.get)` | - |
| `bam.org_member_force_password_change.create` | `POST /org/members/:userId/force-password-change` | `org.routes.ts:484` | `dualReadGate(bam.org_member_force_password_change.create)` | WRITE |
| `bam.org_member_profile.update` | `PATCH /org/members/:userId/profile` | `org.routes.ts:207` | `dualReadGate(bam.org_member_profile.update)` | WRITE |
| `bam.org_member_project.create` | `POST /org/members/:userId/projects` | `org.routes.ts:369` | `dualReadGate(bam.org_member_project.create)` | WRITE |
| `bam.org_member_project.delete` | `DELETE /org/members/:userId/projects/:projectId` | `org.routes.ts:452` | `dualReadGate(bam.org_member_project.delete)` | DESTRUCTIVE, WRITE |
| `bam.org_member_project.get` | `GET /org/members/:userId/projects` | `org.routes.ts:347` | `dualReadGate(bam.org_member_project.get)` | - |
| `bam.org_member_project.update` | `PATCH /org/members/:userId/projects/:projectId` | `org.routes.ts:416` | `dualReadGate(bam.org_member_project.update)` | WRITE |
| `bam.org_member_reset_password.create` | `POST /org/members/:userId/reset-password` | `org.routes.ts:937` | `dualReadGate(bam.org_member_reset_password.create)` | WRITE |
| `bam.org_member_sign_out_everywhere.create` | `POST /org/members/:userId/sign-out-everywhere` | `org.routes.ts:524` | `dualReadGate(bam.org_member_sign_out_everywhere.create)` | WRITE |
| `bam.org_member_transfer_ownership.create` | `POST /org/members/:userId/transfer-ownership` | `org.routes.ts:296` | `dualReadGate(bam.org_member_transfer_ownership.create)` | WRITE |
| `bam.org_member.delete` | `DELETE /org/members/:userId` | `org.routes.ts:1042` | `dualReadGate(bam.org_member.delete)` | DESTRUCTIVE, WRITE |
| `bam.org_member.get` | `GET /org/members/:userId` | `org.routes.ts:185` | `dualReadGate(bam.org_member.get)` | - |
| `bam.org_member.update` | `PATCH /org/members/:userId` | `org.routes.ts:998` | `dualReadGate(bam.org_member.update)` | WRITE |
| `bam.org.update` | `PATCH /org` | `org.routes.ts:41` | `dualReadGate(bam.org.update)` | WRITE |
| `bam.organization.get` | `GET /organizations/:id` | `superuser.routes.ts:216` | `dualReadGate(bam.organization.get)` | - |
| `bam.organization.list` | `GET /organizations` | `superuser.routes.ts:89` | `dualReadGate(bam.organization.list)` | - |
| `bam.overview.list` | `GET /overview` | `superuser.routes.ts:338` | `dualReadGate(bam.overview.list)` | - |
| `bam.platform_setting.list` | `GET /platform-settings` | `superuser.routes.ts:1341` | `dualReadGate(bam.platform_setting.list)` | - |
| `bam.platform_setting.update` | `PATCH /platform-settings` | `superuser.routes.ts:1357` | `dualReadGate(bam.platform_setting.update)` | WRITE |
| `bam.project_custom_field.create` | `POST /projects/:id/custom-fields` | `custom-field.routes.ts:25` | `dualReadGate(bam.project_custom_field.create)` | WRITE |
| `bam.project_epic.create` | `POST /projects/:id/epics` | `epic.routes.ts:40` | `dualReadGate(bam.project_epic.create)` | WRITE |
| `bam.project_github_integration.delete` | `DELETE /projects/:id/github-integration` | `github-integration.routes.ts:173` | `dualReadGate(bam.project_github_integration.delete)` | DESTRUCTIVE, WRITE |
| `bam.project_github_integration.get` | `GET /projects/:id/github-integration` | `github-integration.routes.ts:32` | `dualReadGate(bam.project_github_integration.get)` | - |
| `bam.project_github_integration.update` | `PUT /projects/:id/github-integration` | `github-integration.routes.ts:57` | `dualReadGate(bam.project_github_integration.update)` | WRITE |
| `bam.project_import_csv.create` | `POST /projects/:id/import/csv` | `import.routes.ts:163` | `dualReadGate(bam.project_import_csv.create)` | WRITE |
| `bam.project_import_github.create` | `POST /projects/:id/import/github` | `import.routes.ts:488` | `dualReadGate(bam.project_import_github.create)` | WRITE |
| `bam.project_import_jira.create` | `POST /projects/:id/import/jira` | `import.routes.ts:392` | `dualReadGate(bam.project_import_jira.create)` | WRITE |
| `bam.project_import_trello.create` | `POST /projects/:id/import/trello` | `import.routes.ts:271` | `dualReadGate(bam.project_import_trello.create)` | WRITE |
| `bam.project_label.create` | `POST /projects/:id/labels` | `label.routes.ts:76` | `dualReadGate(bam.project_label.create)` | WRITE |
| `bam.project_member.create` | `POST /projects/:id/members` | `project.routes.ts:276` | `dualReadGate(bam.project_member.create)` | WRITE |
| `bam.project_phas_reorder.create` | `POST /projects/:id/phases/reorder` | `phase.routes.ts:131` | `dualReadGate(bam.project_phas_reorder.create)` | WRITE |
| `bam.project_phas.create` | `POST /projects/:id/phases` | `phase.routes.ts:26` | `dualReadGate(bam.project_phas.create)` | WRITE |
| `bam.project_slack_integration_test.create` | `POST /projects/:id/slack-integration/test` | `slack-integration.routes.ts:116` | `dualReadGate(bam.project_slack_integration_test.create)` | WRITE |
| `bam.project_slack_integration.delete` | `DELETE /projects/:id/slack-integration` | `slack-integration.routes.ts:179` | `dualReadGate(bam.project_slack_integration.delete)` | DESTRUCTIVE, WRITE |
| `bam.project_slack_integration.update` | `PUT /projects/:id/slack-integration` | `slack-integration.routes.ts:45` | `dualReadGate(bam.project_slack_integration.update)` | WRITE |
| `bam.project_sprint.create` | `POST /projects/:id/sprints` | `sprint.routes.ts:32` | `dualReadGate(bam.project_sprint.create)` | WRITE |
| `bam.project_task_template_apply.create` | `POST /projects/:id/task-templates/:templateId/apply` | `template.routes.ts:93` | `dualReadGate(bam.project_task_template_apply.create)` | WRITE |
| `bam.project_task_template.create` | `POST /projects/:id/task-templates` | `template.routes.ts:55` | `dualReadGate(bam.project_task_template.create)` | WRITE |
| `bam.project_task.create` | `POST /projects/:id/tasks` | `task.routes.ts:90` | `dualReadGate(bam.project_task.create)` | WRITE |
| `bam.project_view.create` | `POST /projects/:id/views` | `view.routes.ts:39` | `dualReadGate(bam.project_view.create)` | WRITE |
| `bam.project_webhook.create` | `POST /projects/:id/webhooks` | `webhook.routes.ts:39` | `dualReadGate(bam.project_webhook.create)` | WRITE |
| `bam.project.create` | `POST /projects` | `project.routes.ts:57` | `dualReadGate(bam.project.create)+requireCan(bam.project.create)` | WRITE |
| `bam.project.delete` | `DELETE /projects/:id` | `project.routes.ts:180` | `dualReadGate(bam.project.delete)` | DESTRUCTIVE, WRITE |
| `bam.project.update` | `PATCH /projects/:id` | `project.routes.ts:139` | `dualReadGate(bam.project.update)` | WRITE |
| `bam.sprint_complete.create` | `POST /sprints/:id/complete` | `sprint.routes.ts:243` | `dualReadGate(bam.sprint_complete.create)` | WRITE |
| `bam.sprint_start.create` | `POST /sprints/:id/start` | `sprint.routes.ts:112` | `dualReadGate(bam.sprint_start.create)` | WRITE |
| `bam.sprint.cancel` | `POST /sprints/:id/cancel` | `sprint.routes.ts:463` | `dualReadGate(bam.sprint.cancel)` | DESTRUCTIVE, WRITE |
| `bam.sprint.update` | `PATCH /sprints/:id` | `sprint.routes.ts:79` | `dualReadGate(bam.sprint.update)` | WRITE |
| `bam.superuser_calling_credential.list` | `GET /superuser/calling-credentials` | `superuser.routes.ts:1426` | `dualReadGate(bam.superuser_calling_credential.list)` | SU |
| `bam.superuser_permission_divergence_summary.list` | `GET /superuser/permissions/divergences/summary` | `permissions-divergences.routes.ts:22` | `dualReadGate(bam.superuser_permission_divergence_summary.list)` | SU |
| `bam.superuser_permission_divergence.list` | `GET /superuser/permissions/divergences` | `permissions-divergences.routes.ts:52` | `dualReadGate(bam.superuser_permission_divergence.list)` | SU |
| `bam.system_setting.list` | `GET /system-settings` | `system-settings.routes.ts:107` | `dualReadGate(bam.system_setting.list)` | - |
| `bam.system_setting.update` | `PUT /system-settings/:key` | `system-settings.routes.ts:143` | `dualReadGate(bam.system_setting.update)` | WRITE |
| `bam.task_attachment.create` | `POST /tasks/:id/attachments` | `attachment.routes.ts:12` | `dualReadGate(bam.task_attachment.create)` | WRITE |
| `bam.task_bulk.create` | `POST /tasks/bulk` | `task.routes.ts:387` | `dualReadGate(bam.task_bulk.create)` | WRITE |
| `bam.task_comment.create` | `POST /tasks/:id/comments` | `comment.routes.ts:114` | `dualReadGate(bam.task_comment.create)` | WRITE |
| `bam.task_template.delete` | `DELETE /task-templates/:id` | `template.routes.ts:226` | `dualReadGate(bam.task_template.delete)` | DESTRUCTIVE, WRITE |
| `bam.task_time_entry.create` | `POST /tasks/:id/time-entries` | `time-entry.routes.ts:12` | `dualReadGate(bam.task_time_entry.create)` | WRITE |
| `bam.task_upsert_by_external_id.create` | `POST /v1/tasks/upsert-by-external-id` | `task.routes.ts:145` | `dualReadGate(bam.task_upsert_by_external_id.create)` | WRITE |
| `bam.task.delete` | `DELETE /tasks/:id` | `task.routes.ts:359` | `dualReadGate(bam.task.delete)` | DESTRUCTIVE, WRITE |
| `bam.task.duplicate` | `POST /tasks/:id/duplicate` | `task.routes.ts:433` | `dualReadGate(bam.task.duplicate)` | WRITE |
| `bam.task.move` | `POST /tasks/:id/move` | `task.routes.ts:337` | `dualReadGate(bam.task.move)` | WRITE |
| `bam.task.update` | `PATCH /tasks/:id` | `task.routes.ts:315` | `dualReadGate(bam.task.update)` | WRITE |
| `bam.upload.create` | `POST /upload` | `upload.routes.ts:40` | `dualReadGate(bam.upload.create)` | WRITE |
| `bam.user_active.update` | `PATCH /users/:id/active` | `superuser.routes.ts:922` | `dualReadGate(bam.user_active.update)` | WRITE |
| `bam.user_email.update` | `PATCH /users/:id/email` | `superuser.routes.ts:1065` | `dualReadGate(bam.user_email.update)` | WRITE |
| `bam.user_login_history.get` | `GET /users/:id/login-history` | `superuser.routes.ts:1248` | `dualReadGate(bam.user_login_history.get)` | - |
| `bam.user_membership.create` | `POST /users/:id/memberships` | `superuser.routes.ts:603` | `dualReadGate(bam.user_membership.create)` | WRITE |
| `bam.user_membership.delete` | `DELETE /users/:id/memberships/:orgId` | `superuser.routes.ts:687` | `dualReadGate(bam.user_membership.delete)` | DESTRUCTIVE, WRITE |
| `bam.user_membership.update` | `PATCH /users/:id/memberships/:orgId` | `superuser.routes.ts:734` | `dualReadGate(bam.user_membership.update)` | WRITE |
| `bam.user_project.get` | `GET /users/:id/projects` | `superuser.routes.ts:1163` | `dualReadGate(bam.user_project.get)` | - |
| `bam.user_session_revoke_all.create` | `POST /users/:id/sessions/revoke-all` | `superuser.routes.ts:1032` | `dualReadGate(bam.user_session_revoke_all.create)` | WRITE |
| `bam.user_session.delete` | `DELETE /users/:id/sessions/:sessionId` | `superuser.routes.ts:887` | `dualReadGate(bam.user_session.delete)` | DESTRUCTIVE, WRITE |
| `bam.user_session.get` | `GET /users/:id/sessions` | `superuser.routes.ts:854` | `dualReadGate(bam.user_session.get)` | - |
| `bam.user_set_default_org.create` | `POST /users/:id/set-default-org` | `superuser.routes.ts:799` | `dualReadGate(bam.user_set_default_org.create)` | WRITE |
| `bam.user.get` | `GET /users/:id` | `superuser.routes.ts:561` | `dualReadGate(bam.user.get)` | - |
| `bam.user.list` | `GET /users` | `superuser.routes.ts:507` | `dualReadGate(bam.user.list)` | - |
| `bam.view.delete` | `DELETE /views/:id` | `view.routes.ts:139` | `dualReadGate(bam.view.delete)` | DESTRUCTIVE, WRITE |
| `bam.view.update` | `PATCH /views/:id` | `view.routes.ts:73` | `dualReadGate(bam.view.update)` | WRITE |
| `bam.webhook.delete` | `DELETE /webhooks/:id` | `webhook.routes.ts:124` | `dualReadGate(bam.webhook.delete)` | DESTRUCTIVE, WRITE |
| `bam.webhook.update` | `PATCH /webhooks/:id` | `webhook.routes.ts:77` | `dualReadGate(bam.webhook.update)` | WRITE |

### 3.2 MISMATCH (0) — wrong permission_id

_None._

### 3.3 NO_GATE (125) — route exists, no permission check in preHandler

Grouped by file. `legacy_gates` column reports any `requireMinRole` / `requireOrgRole` / `requireRole` / `requireProjectRole` / `requireSuperuser` calls found in the same preHandler (these are the legacy role gates the codemod was supposed to wrap with `dualReadGate`).

| permission_id | method+path | file:line | legacy_gates_in_preHandler | flags |
|---|---|---|---|---|
| `bam.activity_unified.list` | `GET /v1/activity/unified` | `activity-unified.routes.ts:49` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.activity_unified_by_actor.list` | `GET /v1/activity/unified/by-actor` | `activity-unified.routes.ts:89` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_activity.get` | `GET /projects/:id/activity` | `activity.routes.ts:7` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_activity.get` | `GET /tasks/:id/activity` | `activity.routes.ts:23` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.agent_policy.get` | `GET /v1/agent-policies/:agent_user_id` | `agent-policies.routes.ts:53` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.agent_policy.create` | `POST /v1/agent-policies/:agent_user_id` | `agent-policies.routes.ts:99` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_policy.list` | `GET /v1/agent-policies` | `agent-policies.routes.ts:169` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.agent_policy_check.create` | `POST /v1/agent-policies/:agent_user_id/check` | `agent-policies.routes.ts:206` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_runner_webhook.create` | `POST /v1/agent-runners/:runner_user_id/webhook` | `agent-webhooks.routes.ts:46` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_runner_webhook.rotate` | `POST /v1/agent-runners/:runner_user_id/webhook/rotate` | `agent-webhooks.routes.ts:106` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_webhook_delivery.list` | `GET /v1/agent-webhook-deliveries` | `agent-webhooks.routes.ts:146` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.agent_webhook_delivery.redeliver` | `POST /v1/agent-webhook-deliveries/:delivery_id/redeliver` | `agent-webhooks.routes.ts:176` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent.heartbeat` | `POST /v1/agents/heartbeat` | `agent.routes.ts:67` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_self_report.create` | `POST /v1/agents/self-report` | `agent.routes.ts:146` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.agent_audit.get` | `GET /v1/agents/:agent_user_id/audit` | `agent.routes.ts:200` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.agent.list` | `GET /v1/agents` | `agent.routes.ts:281` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.approval.create` | `POST /v1/approvals` | `approval.routes.ts:48` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.attachment.get` | `GET /v1/attachments/:id` | `attachment-meta.routes.ts:35` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.attachment.list` | `GET /v1/attachments` | `attachment-meta.routes.ts:87` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.attachment__meta.list` | `GET /v1/attachments/_meta` | `attachment-meta.routes.ts:177` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_attachment.get` | `GET /tasks/:id/attachments` | `attachment.routes.ts:51` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_bootstrap.create` | `POST /auth/bootstrap` | `auth.routes.ts:63` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_register.create` | `POST /auth/register` | `auth.routes.ts:139` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_login.create` | `POST /auth/login` | `auth.routes.ts:189` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_logout.create` | `POST /auth/logout` | `auth.routes.ts:298` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_me.list` | `GET /auth/me` | `auth.routes.ts:309` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_org.list` | `GET /auth/orgs` | `auth.routes.ts:356` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_switch_org.create` | `POST /auth/switch-org` | `auth.routes.ts:389` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_change_password.create` | `POST /auth/change-password` | `auth.routes.ts:480` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_me.update` | `PATCH /auth/me` | `auth.routes.ts:539` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.task_comment.get` | `GET /tasks/:id/comments` | `comment.routes.ts:17` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_custom_field.get` | `GET /projects/:id/custom-fields` | `custom-field.routes.ts:11` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.dedupe_decision.create` | `POST /v1/dedupe-decisions` | `dedupe-decisions.routes.ts:45` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.dedupe_decision_pending.list` | `GET /v1/dedupe-decisions/pending` | `dedupe-decisions.routes.ts:98` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_verify_email.create` | `POST /auth/verify-email/:token` | `email-verify.routes.ts:16` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.entity_link.list` | `GET /v1/entity-links` | `entity-links.routes.ts:45` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.entity_link.create` | `POST /v1/entity-links` | `entity-links.routes.ts:97` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.entity_link.delete` | `DELETE /v1/entity-links/:id` | `entity-links.routes.ts:161` | _(none — pure requireAuth/scope/project)_ | DESTRUCTIVE, WRITE |
| `bam.project_epic.get` | `GET /projects/:id/epics` | `epic.routes.ts:12` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.expertise_for_topic.create` | `POST /v1/expertise/for-topic` | `expertise.routes.ts:46` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project.export` | `POST /projects/:id/export` | `export.routes.ts:10` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_github_ref.get` | `GET /tasks/:id/github-refs` | `github-integration.routes.ts:205` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.webhook_github.create` | `POST /webhooks/github` | `github-webhook.routes.ts:68` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.guest_accept.create` | `POST /v1/guests/accept/:token` | `guest.routes.ts:336` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project_calendar.get` | `GET /projects/:id/calendar.ics` | `ical.routes.ts:76` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.me_calendar.list` | `GET /me/calendar.ics` | `ical.routes.ts:132` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task.create` | `POST /tasks` | `internal-helpdesk.routes.ts:56` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.comment.create` | `POST /comments` | `internal-helpdesk.routes.ts:224` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.task_move_to_terminal_phase.create` | `POST /tasks/:id/move-to-terminal-phase` | `internal-helpdesk.routes.ts:295` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.task.reopen` | `POST /tasks/:id/reopen` | `internal-helpdesk.routes.ts:364` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.queue.list` | `GET /queue` | `internal-helpdesk.routes.ts:449` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.chat.create` | `POST /chat` | `internal-llm.routes.ts:110` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project_label.get` | `GET /projects/:id/labels` | `label.routes.ts:13` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.label.list` | `GET /labels` | `label.routes.ts:32` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.launchpad_app.list` | `GET /launchpad/apps` | `launchpad.routes.ts:63` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.me_notification.list` | `GET /me/notifications` | `notification.routes.ts:9` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.me_notification_mark_read.create` | `POST /me/notifications/mark-read` | `notification.routes.ts:99` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.me_notification_mark_all_read.create` | `POST /me/notifications/mark-all-read` | `notification.routes.ts:137` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.me_notification_read.create` | `POST /me/notifications/:id/read` | `notification.routes.ts:156` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_oauth_provider.list` | `GET /auth/oauth/providers` | `oauth.routes.ts:116` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_oauth_authorize.get` | `GET /auth/oauth/:provider/authorize` | `oauth.routes.ts:130` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_oauth_callback.create` | `POST /auth/oauth/:provider/callback` | `oauth.routes.ts:180` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.auth_oauth_link.create` | `POST /auth/oauth/:provider/link` | `oauth.routes.ts:363` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.org.list` | `GET /org` | `org.routes.ts:14` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.org_member.list` | `GET /org/members` | `org.routes.ts:70` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.org_member.invite` | `POST /org/members/invite` | `org.routes.ts:748` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.org_member_invite_bulk.create` | `POST /org/members/invite/bulk` | `org.routes.ts:826` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project_phas.get` | `GET /projects/:id/phases` | `phase.routes.ts:12` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.phas.update` | `PATCH /phases/:id` | `phase.routes.ts:57` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.phas.delete` | `DELETE /phases/:id` | `phase.routes.ts:94` | _(none — pure requireAuth/scope/project)_ | DESTRUCTIVE, WRITE |
| `bam.platform_org.list` | `GET /v1/platform/orgs` | `platform.routes.ts:65` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.platform_org.create` | `POST /v1/platform/orgs` | `platform.routes.ts:96` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.platform_org.get` | `GET /v1/platform/orgs/:id` | `platform.routes.ts:123` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.platform_org.update` | `PATCH /v1/platform/orgs/:id` | `platform.routes.ts:153` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.platform_org.delete` | `DELETE /v1/platform/orgs/:id` | `platform.routes.ts:188` | _(none — pure requireAuth/scope/project)_ | DESTRUCTIVE, WRITE |
| `bam.platform_org_member.get` | `GET /v1/platform/orgs/:id/members` | `platform.routes.ts:228` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.platform_user_superuser.update` | `PATCH /v1/platform/users/:id/superuser` | `platform.routes.ts:254` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.platform_impersonate.create` | `POST /v1/platform/impersonate` | `platform.routes.ts:287` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.platform_stop_impersonation.create` | `POST /v1/platform/stop-impersonation` | `platform.routes.ts:367` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.platform_impersonation_session.list` | `GET /v1/platform/impersonation-sessions` | `platform.routes.ts:406` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.platform_audit_log.list` | `GET /v1/platform/audit-log` | `platform.routes.ts:442` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project.list` | `GET /projects` | `project.routes.ts:34` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project.get` | `GET /projects/:id` | `project.routes.ts:102` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_member.get` | `GET /projects/:id/members` | `project.routes.ts:250` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.proposal.create` | `POST /v1/proposals` | `proposals.routes.ts:69` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.proposal.list` | `GET /v1/proposals` | `proposals.routes.ts:149` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.proposal_decide.create` | `POST /v1/proposals/:id/decide` | `proposals.routes.ts:228` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.public_config.list` | `GET /public/config` | `public-config.routes.ts:48` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.public_beta_signup.create` | `POST /public/beta-signup` | `public-config.routes.ts:59` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.comment_reaction.get` | `GET /comments/:id/reactions` | `reaction.routes.ts:86` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_velocity.get` | `GET /projects/:id/reports/velocity` | `report.routes.ts:19` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_burndown.get` | `GET /projects/:id/reports/burndown` | `report.routes.ts:34` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_cfd.get` | `GET /projects/:id/reports/cfd` | `report.routes.ts:88` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_cycle_time.get` | `GET /projects/:id/reports/cycle-time` | `report.routes.ts:118` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_overdue.get` | `GET /projects/:id/reports/overdue` | `report.routes.ts:193` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_workload.get` | `GET /projects/:id/reports/workload` | `report.routes.ts:243` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_time_tracking.get` | `GET /projects/:id/reports/time-tracking` | `report.routes.ts:296` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_report_status_distribution.get` | `GET /projects/:id/reports/status-distribution` | `report.routes.ts:369` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.auth_service_account.list` | `GET /auth/service-accounts` | `service-account.routes.ts:58` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_slack_integration.get` | `GET /projects/:id/slack-integration` | `slack-integration.routes.ts:32` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.webhook_slack_command.create` | `POST /webhooks/slack/command` | `slack-webhook.routes.ts:61` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project_sprint.get` | `GET /projects/:id/sprints` | `sprint.routes.ts:18` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.sprint.get` | `GET /sprints/:id` | `sprint.routes.ts:54` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.sprint_report.get` | `GET /sprints/:id/report` | `sprint.routes.ts:526` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.system_setting.get` | `GET /system-settings/:key` | `system-settings.routes.ts:117` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.root_redirect.list` | `GET /root-redirect` | `system-settings.routes.ts:229` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_analytic_count_by_phrase.list` | `GET /v1/tasks/analytics/count-by-phrase` | `task-analytics.routes.ts:56` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_state.get` | `GET /projects/:id/states` | `task-state.routes.ts:9` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_task.get` | `GET /projects/:id/tasks` | `task.routes.ts:16` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_board.get` | `GET /projects/:id/board` | `task.routes.ts:50` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_by_ref.get` | `GET /tasks/by-ref/:ref` | `task.routes.ts:208` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task.get` | `GET /tasks/:id` | `task.routes.ts:278` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_task_template.get` | `GET /projects/:id/task-templates` | `template.routes.ts:40` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.task_time_entry.get` | `GET /tasks/:id/time-entries` | `time-entry.routes.ts:47` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.me_time_entry.list` | `GET /me/time-entries` | `time-entry.routes.ts:61` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.file_*.list` | `GET /files/*` | `upload.routes.ts:121` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.user.list` | `GET /users` | `user.routes.ts:68` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.user.get` | `GET /users/:id` | `user.routes.ts:105` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.user_by_email.list` | `GET /users/by-email` | `user.routes.ts:142` | _(none — pure requireAuth/scope/project)_ | - |
| `banter.user_by_email.list` | `GET /v1/users/by-email` | `user.routes.ts:142` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.user_search.list` | `GET /users/search` | `user.routes.ts:186` | _(none — pure requireAuth/scope/project)_ | - |
| `banter.user_search.list` | `GET /v1/users/search` | `user.routes.ts:186` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.project_view.get` | `GET /projects/:id/views` | `view.routes.ts:12` | _(none — pure requireAuth/scope/project)_ | - |
| `bam.visibility_can_access.create` | `POST /v1/visibility/can_access` | `visibility.routes.ts:36` | _(none — pure requireAuth/scope/project)_ | WRITE |
| `bam.project_webhook.get` | `GET /projects/:id/webhooks` | `webhook.routes.ts:17` | _(none — pure requireAuth/scope/project)_ | - |

### 3.4 MISSING_ROUTE (0) — manifest entry has no matching handler

_None._ (52 manifest rows whose `file` basename also exists in apps/api but whose paths only match handlers in other apps' route files have been filtered out as out-of-scope. See `outOfScope` in `audit-output.json`.)

### 3.5 INLINE_CHECK (1) — preHandler lacks gate, handler body has `is_superuser` gating

| permission_id | method+path | file:line | notes |
|---|---|---|---|
| `bam.auth_api_key.list` | `GET /auth/api-keys` | `api-key.routes.ts:24` | preHandler has no permission check \| handler body has inline is_superuser gate |

Note: the heuristic matches `if (... is_superuser ...) ... reply.(status|code)(403|401) | FORBIDDEN | UNAUTHORIZED` within the first 80 lines of the handler body. False negatives are possible for inline checks that throw via a helper or set `reply.send` without a status code. False positives are possible if a route emits a 403 inside a deeply nested branch whose superuser check is unrelated to authorization — re-confirm by reading the file.

## 4. Top 10 highest-value gaps to fix first

Ranked by priority weight (requires_superuser × 4 + is_destructive × 3 + non-read × 2 + 1).

| # | permission_id | method+path | file:line | flags | priority |
|---|---|---|---|---|---|
| 1 | `bam.entity_link.delete` | `DELETE /v1/entity-links/:id` | `entity-links.routes.ts:161` | DESTRUCTIVE, WRITE | 6 |
| 2 | `bam.phas.delete` | `DELETE /phases/:id` | `phase.routes.ts:94` | DESTRUCTIVE, WRITE | 6 |
| 3 | `bam.platform_org.delete` | `DELETE /v1/platform/orgs/:id` | `platform.routes.ts:188` | DESTRUCTIVE, WRITE | 6 |
| 4 | `bam.agent_policy_check.create` | `POST /v1/agent-policies/:agent_user_id/check` | `agent-policies.routes.ts:206` | WRITE | 3 |
| 5 | `bam.agent_policy.create` | `POST /v1/agent-policies/:agent_user_id` | `agent-policies.routes.ts:99` | WRITE | 3 |
| 6 | `bam.agent_runner_webhook.create` | `POST /v1/agent-runners/:runner_user_id/webhook` | `agent-webhooks.routes.ts:46` | WRITE | 3 |
| 7 | `bam.agent_runner_webhook.rotate` | `POST /v1/agent-runners/:runner_user_id/webhook/rotate` | `agent-webhooks.routes.ts:106` | WRITE | 3 |
| 8 | `bam.agent_self_report.create` | `POST /v1/agents/self-report` | `agent.routes.ts:146` | WRITE | 3 |
| 9 | `bam.agent_webhook_delivery.redeliver` | `POST /v1/agent-webhook-deliveries/:delivery_id/redeliver` | `agent-webhooks.routes.ts:176` | WRITE | 3 |
| 10 | `bam.agent.heartbeat` | `POST /v1/agents/heartbeat` | `agent.routes.ts:67` | WRITE | 3 |

_Recommendation_: wrap each of the above with `shadowOnly('<id>')` first (since most have no legacy role gate to dual-read against), confirm divergence telemetry stays quiet for one full enforcement window, then promote to `requireCan('<id>')` before flipping `BBB_PERMISSIONS_ENFORCE=on`.

## 5. Anomalies & open questions

### 5.1 Routes claimed by more than one manifest entry

2 routes are referenced by more than one manifest permission. This is usually fine (one handler implements multiple verbs by query/body), but it does mean a single `dualReadGate` cannot satisfy both; the resolver only checks one `permission_id` per request. Investigate whether one of the manifest entries is stale.

| file:line | permissions claiming it |
|---|---|
| `user.routes.ts:142` | `bam.user_by_email.list` (NO_GATE), `banter.user_by_email.list` (NO_GATE) |
| `user.routes.ts:186` | `bam.user_search.list` (NO_GATE), `banter.user_search.list` (NO_GATE) |

### 5.2 NO_GATE rows with no legacy gate either (pure `requireAuth` / `requireScope` / `requireProjectAccess`)

**125 of 125 NO_GATE rows have no legacy authorization gate at all.** These are the riskiest gaps before flipping `=on`: today they 200 for any authenticated user (subject to scope and project visibility); after `=on` they will still 200, but the resolver will record `null` decisions because `requireCan` was never called. Either:

1. They are intentionally public-ish endpoints (`/auth/me`, `/auth/login`, `/launchpad`, `/agents/heartbeat`) — in which case the manifest entry exists but no permission gate is needed; consider marking these `is_core: true` in the manifest so the audit can ignore them, or add `shadowOnly('<id>')` to capture telemetry.
2. They are oversights from Wave A/B/C where the codemod could not match the route — these need explicit `shadowOnly` or `requireCan` wraps before `=on`.

Quick triage: of the 125 no-legacy-gate rows, 3 are flagged `requires_superuser` or `is_destructive` and must NOT remain ungated under `=on`.

### 5.3 NO_GATE rows that still have legacy role gates

_None observed._ Every legacy role gate in apps/api routes appears to be wrapped by `dualReadGate` (this confirms Wave C's codemod ran successfully against the legacy-gated subset).

### 5.4 Manifest entries silently routed to other apps (basename collision)

52 manifest entries have a `file` whose basename exists in `apps/api/src/routes/` AND in some sub-app's `apps/<app>-api/src/routes/`. The script dropped them as out-of-scope because the path/method does not match any handler in apps/api. The manifest-builder probably stamped the basename ambiguously — consider including the full repo-relative file path in `source.file` going forward so future audits don't have to disambiguate by route-match. Breakdown:

- `brief`: 18 entries
- `helpdesk`: 16 entries
- `board`: 8 entries
- `banter`: 4 entries
- `beacon`: 2 entries
- `bolt`: 2 entries
- `book`: 2 entries

### 5.5 `shadowOnly` adoption

`shadowOnly` (the convenience for routes that have no legacy gate, just to record resolver telemetry) currently covers **0** of the in-scope routes. With 125 legacy-less NO_GATE rows still present, there is significant headroom to expand `shadowOnly` adoption before `=on`.

### 5.6 `requires_superuser` permissions still ungated

_None._

### 5.7 Open questions for the wave lead

1. **Are public auth endpoints in-scope?** `bam.auth_login.create`, `bam.auth_register.create`, `bam.auth_bootstrap.create`, `bam.auth_logout.create`, `bam.auth_me.list`, and `/public/config` legitimately have no permission gate because they predate authentication or are the authentication flow themselves. They should likely be marked `is_core` (analogous to MCP's "always permitted" set: `get_server_info`, `get_me`, `agent_heartbeat`) or otherwise excluded from coverage targets.
2. **Internal/service routes** under `/internal/helpdesk` and `/internal/llm` are gated by `INTERNAL_SERVICE_SECRET` at the network layer and don't fit the human-permission model. Should they be removed from the manifest, or kept with a sentinel permission like `platform.internal.invoke` and the gate enforced via a different middleware?
3. **Webhook receivers** (`POST /webhooks/slack`, `POST /webhooks/github`, `POST /webhooks/livekit`) authenticate via HMAC signature, not session. Same question as (2): these should probably be marked `is_core` or excluded.
4. **Routes with multiple manifest claims** (section 5.1) need a single canonical `permission_id` chosen before `=on` — the resolver only fires one check per request.

## 6. Verdict on flipping `BBB_PERMISSIONS_ENFORCE=on`

**Not safe today.** With 125 ungated routes (125 of which have no legacy authorization gate of any kind, including 0 flagged `requires_superuser` and 3 flagged `is_destructive`), turning `=on` would either:

- if the resolver's default-deny posture is per-action: cause every ungated route to 403 for every caller including SuperUsers (a large operational regression);
- if the resolver's default-deny is bypassed when no `requireCan` is on the route: silently allow them, which defeats the purpose of `=on` and leaves 0 SuperUser-only actions accessible to any authenticated user under the new model.

**Suggested pre-flip checklist:**

1. Resolve every row in section 3.3 (NO_GATE) by either (a) adding `requireCan('<id>')` to the preHandler, (b) adding `shadowOnly('<id>')` if the route is genuinely public, or (c) marking the manifest entry `is_core`/`public` and excluding it from coverage requirements.
2. Resolve the routes-with-multiple-claims (section 5.1) so each handler has exactly one canonical `permission_id`.
3. Re-run `scripts/wave-d-audit.mjs` and verify `OK + INLINE_CHECK + (core/public-excluded)` covers 100% of in-scope rows.
4. Run divergence telemetry under `=warn` for at least one full enforcement window after the gate-additions land; spot-check that the divergence dashboard is quiet (no resolver-denies-but-legacy-allows on Bam routes).
5. Then flip `BBB_PERMISSIONS_ENFORCE=on` and watch `permissions_divergence_log` for the first 24 hours.
