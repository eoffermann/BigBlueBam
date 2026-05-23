# Deploy Settings — API + storage contract

Shared spec for the three parallel agents (backend / frontend / deploy script).

## Storage: system_settings table

Four new keys in the existing `system_settings` table (key text PK, value jsonb).
No new tables; the existing CRUD machinery is reused.

| Key | Type | Default if missing | Notes |
|---|---|---|---|
| `deploy_branch` | string | `"stable"` | Git branch to pull from |
| `deploy_repo_url` | string | `git remote get-url origin` | Override for the remote URL; null means "use origin" |
| `deploy_github_token` | string (encrypted) | `null` | AES-256-GCM, prefix `enc:` (see below) |
| `deploy_auto_update_enabled` | boolean | `true` | When false, deploy script skips the pull prompt |

Defaults are NOT seeded — absence in the table means "use the hardcoded default." This way deleting a row reverts to baseline behavior with no DB cleanup.

## Token encryption

Encrypted at rest with AES-256-GCM, key derived via HKDF-SHA256:

```ts
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function deriveKey(): Buffer {
  // HKDF-like single-step: SHA256(SESSION_SECRET + 'deploy-token-key-v1') → 32 bytes
  return createHash('sha256').update(process.env.SESSION_SECRET + 'deploy-token-key-v1').digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptToken(stored: string): string | null {
  if (!stored.startsWith('enc:')) return null;
  const [, ivB64, ctB64, tagB64] = stored.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

Decryption failure (e.g. SESSION_SECRET rotated) returns null and the caller treats the token as missing.

## Catalog: 3 new permissions

Added via the manifest's HAND_AUTHORED block + a delta migration:

```
bam.superuser_deploy_settings.get      is_read=true, requires_superuser=true
bam.superuser_deploy_settings.update    requires_superuser=true
bam.superuser_deploy_settings.verify    requires_superuser=true
```

## Backend endpoints

All under `/superuser/deploy/` in a new file `apps/api/src/routes/deploy-settings.routes.ts`, registered in `apps/api/src/server.ts`. Each route uses `fastify.requireCan('bam.superuser_deploy_settings.<verb>')`.

### `GET /superuser/deploy/settings`

```json
{ "data": {
    "deploy_branch": "stable",
    "deploy_repo_url": "https://github.com/eoffermann/BigBlueBam.git",
    "deploy_github_token_set": true,
    "deploy_auto_update_enabled": true,
    "defaults": {
      "deploy_branch": "stable",
      "deploy_repo_url": null
    }
}}
```

`deploy_github_token_set` is a boolean — never return the token itself. `defaults` shows the hardcoded fallback so the UI can render "(default)" hints.

### `PUT /superuser/deploy/settings`

```json
{
  "deploy_branch": "stable",
  "deploy_repo_url": "https://github.com/eoffermann/BigBlueBam.git",
  "deploy_github_token": "ghp_...",  // optional; pass null to clear, omit to keep
  "deploy_auto_update_enabled": true
}
```

Validation:
- `deploy_branch`: non-empty string, max 100 chars
- `deploy_repo_url`: valid URL OR null (null reverts to origin)
- `deploy_github_token`: 
  - omitted → unchanged
  - `null` → clear stored value
  - string → encrypt and store
- `deploy_auto_update_enabled`: boolean

Returns the new GET-shaped response.

### `POST /superuser/deploy/verify-repo`

```json
{
  "deploy_repo_url": "https://github.com/eoffermann/BigBlueBam.git",
  "deploy_github_token": "ghp_..."  // optional; if omitted, uses stored token
}
```

Verifies by calling GitHub's REST API: `GET https://api.github.com/repos/<owner>/<repo>` with `Authorization: token <token>` if provided.

Response on success:
```json
{ "data": {
    "ok": true,
    "owner": "eoffermann",
    "repo": "BigBlueBam",
    "default_branch": "main",
    "private": false,
    "permissions": { "admin": true, "push": true, "pull": true }  // if token provided
}}
```

Response on failure: HTTP 400 with `{ "error": { "code": "VERIFY_FAILED", "message": "...", "details": [{ "github_status": 404 }] } }`. Common codes: `INVALID_URL`, `REPO_NOT_FOUND`, `AUTH_REQUIRED` (private repo, no token), `INVALID_TOKEN`.

URL parsing: accepts both `https://github.com/owner/repo.git` and `https://github.com/owner/repo` (strip trailing `.git`). Reject non-github.com hosts with `INVALID_URL` — only GitHub auth is supported for v1.

## Deploy script integration

### New helper: `scripts/deploy/shared/db-settings.mjs`

```js
// Fetch deploy settings from the running stack's postgres. Returns null
// for any key not present in system_settings. Returns null entirely if
// the stack is down or postgres unreachable.
export async function loadDeploySettings() { ... }
```

Reads via `docker compose exec -T postgres psql -U $POSTGRES_USER -d bigbluebam -t -A -c "SELECT key, value FROM system_settings WHERE key LIKE 'deploy_%'"`. Timeout 5s. Token is returned as the encrypted `enc:...` string; the deploy script does not need to decrypt it directly — it writes it to a git credential helper.

### `branch-select.mjs` change

Before showing the prompt, call `loadDeploySettings()` and use `deploy_branch` as the default candidate. If the DB-stored branch doesn't exist on origin, fall back to `stable` with a warning. The interactive prompt still appears (so the operator can override per-deploy); just the default changes.

### `docker-compose.mjs` change

After branch selection but before the "Pull updates?" prompt: if `deploy_auto_update_enabled === false`, skip the pull entirely and print `(auto-update disabled via SuperUser settings)`. If `deploy_github_token` is present AND `deploy_repo_url` overrides origin, configure a temporary `git credential.helper store --file=.git-deploy-creds` for the pull, pass the token, then `git credential reject` after the pull completes.

The git-credential write needs to decrypt the token. Since the deploy script runs outside containers, the simplest path is to add a small CLI-only decryption helper: `node -e "..."` invoked from the shell script. The helper imports the same `deriveKey()` function. This means the deploy script needs SESSION_SECRET available — already true since it's in .env.

## Frontend

### New section under the existing Platform tab

In `apps/frontend/src/pages/superuser/index.tsx`, add a `DeploySettingsCard` component to the `PlatformTab` function, alongside the existing `LaunchpadDefaultsCard` and `CallingCredentialsCard`.

### Form fields

| Field | Input type | Behavior |
|---|---|---|
| Branch | text | placeholder `stable` |
| Repo URL | text | placeholder `(default: $origin)` |
| GitHub token | password | with show/hide toggle. Helper text: "Leave blank to keep existing." Status badge: "Token set" / "No token" |
| Auto-update enabled | toggle switch | matches the existing public-signup toggle pattern |

### Buttons

- **Save** — `PUT /superuser/deploy/settings` with only the changed fields. Token field uses the omit-vs-null-vs-string convention from the contract.
- **Verify repo** — `POST /superuser/deploy/verify-repo` using current form values (or last saved if form is pristine). Shows result inline: ✓ repo + branch + access summary, or ✗ error message.
- **Reset to defaults** — `PUT /superuser/deploy/settings` with all four fields cleared/defaulted. Confirms first.

### TanStack Query

Query key `['superuser', 'deploy-settings']`. Invalidate on save / reset. Verify is a mutation that does not invalidate (it's read-only against GitHub).

## Test expectations

Backend:
- `apps/api/test/deploy-settings.test.ts`: SU-only access, GET round-trip, PUT validation, token encryption masking, verify success against a mock GitHub response, verify failure paths.

Frontend: no new component test files required (mirror the existing CallingCredentialsCard pattern which is also test-free).

Deploy script: existing tests under `scripts/deploy/shared/*.test.mjs` follow vitest pattern. Add `db-settings.test.mjs` with a happy-path stub.

## Permissions catalog regen

After adding the 3 new permissions to the HAND_AUTHORED block in `scripts/generate-permission-manifest.mjs`:
1. Regenerate manifest + TS: `node scripts/generate-permission-manifest.mjs && node scripts/build-permission-codegen.mjs`
2. Generate delta migration: `node scripts/build-permission-delta.mjs` → produces `0162_permissions_seed_actions_delta_NNN.sql`
3. Apply: `docker compose run --rm migrate`

## Out of scope (carry as follow-ups)

- Non-GitHub remotes (GitLab, Bitbucket, self-hosted git)
- Scheduled/daemonized auto-update (cron, webhook-triggered)
- Multi-account token storage
- Token refresh / OAuth flow (only PAT supported)
