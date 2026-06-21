# Deploy Settings — Frontend (Wave G, Agent 2)

Implements the SuperUser deploy-settings UI per
`docs/plans/deploy-settings-contract.md`. Backend (Agent 1) and deploy-script
(Agent 3) work proceeds in parallel; this card renders a graceful error state
when the backend route is not yet deployed (404 / 403), mirroring the Wave F
pattern.

## Files created

- `apps/frontend/src/lib/api/superuser-deploy.ts`
  - `superuserDeployApi.getDeploySettings()` → GET `/superuser/deploy/settings`
  - `superuserDeployApi.updateDeploySettings(body)` → PUT `/superuser/deploy/settings`
  - `superuserDeployApi.verifyRepo(body)` → POST `/superuser/deploy/verify-repo`
  - Exported types: `DeploySettingsData`, `DeploySettingsResponse`,
    `UpdateDeploySettingsInput`, `VerifyRepoInput`, `VerifyRepoSuccess`,
    `VerifyRepoResponse`.
- `apps/frontend/src/components/superuser/deploy-settings-card.tsx`
  - `<DeploySettingsCard />` — Card with `GitBranch` icon, four form fields,
    Verify / Save / Reset buttons, and a confirmation dialog for Reset.

## Files modified

- `apps/frontend/src/pages/superuser/index.tsx`
  - Added import for `DeploySettingsCard`.
  - Placed `<DeploySettingsCard />` in `PlatformTab` immediately after
    `<LaunchpadDefaultsCard />` and `<CallingCredentialsCard />`.

## UI / interaction details worth knowing

- **Token field convention** matches the contract: omit when unchanged,
  send `null` to clear, send a string to set. Implemented via two pieces of
  form state: `tokenInput` (the typed value) and `clearToken` (a boolean
  toggled by the "Clear token" button). Typing in the field auto-cancels a
  pending clear. The badge above the input flips between "Token set" (green)
  and "No token" / "Will be cleared on save" (zinc).
- **Show/hide token** uses `lucide-react`'s `Eye` / `EyeOff` icons inside the
  input. The input is `type="password"` by default and `font-mono` for
  readability when revealed.
- **Repo URL placeholder** is `(default: <defaults.deploy_repo_url>)` when
  the server reports a resolved origin, falling back to `(default: $origin)`
  if not. A second dim helper line shows the actual default value when the
  field is blank.
- **Verify** uses whatever's in the form right now (token included if the
  user has typed one and hasn't asked to clear). Result is rendered inline
  below the URL row: green check with `owner/repo on default branch X —
  public/private (+permissions)`, or red X with the error message and HTTP
  status (when present on the `ApiError`).
- **Reset** sends `{deploy_branch: null, deploy_repo_url: null,
  deploy_github_token: null, deploy_auto_update_enabled: true}` after a
  confirmation dialog.
- **Save button** is disabled until the form diff against the last-saved
  snapshot is non-empty. `buildUpdatePayload(form, saved)` produces a
  minimal PUT body (only changed fields).
- **TanStack Query** key: `['superuser', 'deploy-settings']`. Stale time
  1 minute. Save / reset mutations invalidate the key; verify does not
  (it's read-only against GitHub). Query retry is suppressed for 404/403
  responses so the error card doesn't thrash.

## Verification

| Step | Result |
|---|---|
| `pnpm --filter @bigbluebam/frontend typecheck` | clean (exit 0) |
| `docker compose build frontend` | success (image `bigbluebam-frontend`) |
| `docker compose up -d --force-recreate frontend` + `restart frontend` | healthy |
| Bundle contains `Deploy Settings`, `deploy_branch`, `deploy_github_token_set`, `superuser_deploy_settings`, `verify-repo` | confirmed (grep on `/b3/assets/index-*.js`) |
| `GET /b3/api/superuser/deploy/settings` | 404 (backend agent not landed yet — error state renders) |

The 404 from the backend route is expected at this point in the rollout.
The component's error gate renders an amber "Deploy settings unavailable"
panel with a helpful message ("The /superuser/deploy/settings endpoint is
not available yet. The backend may still be rolling out.") instead of
crashing or showing broken inputs.

## Anomalies / sharp edges

- The contract's GET response shape for the `permissions` field on verify
  success is `{ admin, push, pull }`. We render the highest-tier one
  (admin > push > pull) as a single label in the success row rather than
  three checkboxes — adjust if Agent 1 ends up surfacing all three.
- The contract describes verify failures as HTTP 400 with `code:
  'VERIFY_FAILED'`. The component surfaces `err.message` directly; if the
  backend wants to surface the `details.github_status` separately we'll
  need a follow-up to dig it out of `ApiError.details`.
- The "Auto-update" toggle visually mirrors the public-signup toggle (same
  switch styling, `bg-primary-600` when active). It does not have an
  individual save-only button — changes are batched into the global Save.

## Out of scope (per task boundaries)

- No backend route changes (Agent 1).
- No `scripts/deploy/*` changes (Agent 3).
- No edits to existing Platform-tab cards beyond placement.
