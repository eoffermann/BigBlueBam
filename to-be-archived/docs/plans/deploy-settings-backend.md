# Deploy Settings Backend (Agent 1) — completion report

Backend for the SuperUser Deploy Settings card. Companion to the Wave F
permissions editor. Per `docs/plans/deploy-settings-contract.md`.

## Files changed / added

### New
- `apps/api/src/services/deploy-settings.service.ts` — `loadDeploySettings`,
  `saveDeploySettings`, `getDecryptedToken`, `encryptToken`, `decryptToken`,
  `getOriginUrl` (cached); reads/writes the four `deploy_*` keys in
  `system_settings`; defaults applied at read time (no DB seed required).
- `apps/api/src/routes/deploy-settings.routes.ts` —
  `GET/PUT /superuser/deploy/settings` and
  `POST /superuser/deploy/verify-repo`, each gated by
  `bam.superuser_deploy_settings.{get,update,verify}` (all
  `requires_superuser=true`). Includes the `parseGitHubRepoUrl` parser
  (accepts `.git` suffix, rejects non-github.com hosts and SSH form).
- `apps/api/test/deploy-settings.test.ts` — 20 vitest tests:
  encryption round-trip, URL parser cases (incl. gitlab + SSH rejects),
  SU-only access (avery → 403 on all 3 routes), GET defaults, PUT
  round-trip, PUT-with-token shows `enc:` prefix in storage, PUT null
  clears, PUT omit keeps existing, verify success/REPO_NOT_FOUND/
  AUTH_REQUIRED hint/INVALID_URL.
- `infra/postgres/migrations/0162_permissions_seed_actions_delta_005.sql`
  — auto-generated; adds the 3 catalog rows.

### Edited
- `scripts/generate-permission-manifest.mjs` — added 3 entries to the
  `HAND_AUTHORED` block (`bam.superuser_deploy_settings.{get,update,verify}`,
  all `requires_superuser=true`), and added `deploy-settings.routes.ts`
  to `EXCLUDED_FILE_BASENAMES` so the auto-deriver doesn't try to fight
  the hand-authored ids.
- `apps/api/src/server.ts` — imported and registered `deploySettingsRoutes`.
- `docs/permissions-action-manifest.json` — regenerated; 1063 total
  permissions (was 1060).
- `packages/permissions/src/generated/permissions.ts` — regenerated.

## Verification

| Step | Result |
|---|---|
| `pnpm --filter @bigbluebam/api typecheck` | clean (initial run flagged 5 TS errors under `noUncheckedIndexedAccess`; fixed by narrowing `url.pathname.split('/')` indices and `stored.split(':')` parts. No pre-existing errors elsewhere.) |
| `pnpm --filter @bigbluebam/api test -- deploy-settings` | 20/20 passed (262 ms) |
| `node scripts/check-permission-catalog.mjs` | clean (catalog ↔ manifest ↔ DB all in sync; 1063 rows) |
| `docker compose run --rm migrate` | `[migrate] applying 0162_permissions_seed_actions_delta_005.sql` → `1 applied, 122 already up-to-date` |
| `docker compose build api && up -d --force-recreate api` | succeeded |
| `curl https://localhost/b3/api/health` | 200 |

## Smoke (eddie@bigblueceiling.com, SU)

| Call | Result |
|---|---|
| `GET /superuser/deploy/settings` | 200 → `{deploy_branch:"stable", deploy_repo_url:"", deploy_github_token_set:false, deploy_auto_update_enabled:true, defaults:{deploy_branch:"stable", deploy_repo_url:null}}` |
| `PUT {deploy_branch:"main", deploy_auto_update_enabled:false}` | 200 → values reflected immediately |
| Follow-up `GET` | 200 → `deploy_branch:"main"`, `deploy_auto_update_enabled:false` |
| `PUT {deploy_github_token:"ghp_smoketest_value"}` | 200 → `deploy_github_token_set:true` |
| DB inspection of stored token | `"enc:KvdFZkfTSS+P69ks:D4RgxNmAmWy5X1QuGkMZDWSlyw==:Wj3gez4rcKdibzmkkDzSbg==" ` — `enc:` prefix confirmed |
| `POST /superuser/deploy/verify-repo {url: github.com/eoffermann/BigBlueBam.git}` | 200 → `{ok:true, owner:"eoffermann", repo:"BigBlueBam", default_branch:"main", private:false}` |

DB rows cleaned up after smoke (`DELETE FROM system_settings WHERE key LIKE 'deploy_%'`).

## Smoke (avery.singh@mage.io, non-SU)

| Call | Status |
|---|---|
| `GET /superuser/deploy/settings` | 403 |
| `PUT /superuser/deploy/settings` | 403 |
| `POST /superuser/deploy/verify-repo` | 403 |

(Password `TestMember-Wave-D-Verify` per the contract; corresponding user
id `969d36a7-a10d-4a64-99dc-f2a95fe2b038`.)

## Anomalies / notes for the frontend agent

1. `deploy_repo_url` defaults to the empty string when both the stored
   override and `git remote get-url origin` are missing (the API
   container doesn't ship a git binary, so origin discovery returns
   null inside containers). `defaults.deploy_repo_url` correctly
   reports `null` in that case. The frontend should render the
   "(default: $origin)" hint based on `defaults.deploy_repo_url`, not
   on whether `deploy_repo_url` happens to be empty.

2. `parseGitHubRepoUrl` is exported from the route module for test
   reuse. If a future agent wants to share it with the deploy script,
   move it into the service file.

3. Token storage uses `JSON.stringify(encryptedString)` so the jsonb
   column receives a quoted JSON string (`"enc:..."`). On read drizzle
   returns the plain JS string. This matches the
   `system-settings.routes.ts` convention exactly; no special-casing
   is needed for the existing GET / PUT machinery.

4. PUT auditing masks the token: the `superuser_audit_log.details`
   payload records `deploy_github_token: "set"` or `"cleared"`, never
   the plaintext or ciphertext.

5. CSRF: state-changing routes require a valid `X-CSRF-Token` header
   matching the `csrf_token` cookie, same as every other authenticated
   state-changing route. No CSRF exemption was added; the existing
   `csrf.ts` plugin handles it.

6. Out-of-scope discovery: none. No adjacent bugs surfaced during the
   work.
