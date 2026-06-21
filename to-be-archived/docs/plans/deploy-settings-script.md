# Deploy script — SuperUser deploy-settings integration

Companion to `deploy-settings-contract.md`. Tracks the deploy-script side
of the three-agent split (backend / frontend / deploy script).

## Scope delivered

Wires the deploy orchestrator to consult the running stack's
`system_settings` table for SuperUser-managed deploy overrides, and to
honor them at branch-selection and pull time. All overrides are
optional and graceful: missing rows / stack-down / postgres-unreachable
falls back to the existing hardcoded behavior with no operator
intervention required.

## Files created

| Path | Purpose |
|---|---|
| `scripts/deploy/shared/db-settings.mjs` | `loadDeploySettings()` — runs `docker compose exec postgres psql` with a 5s timeout, parses pipe-separated JSONB rows into `{deploy_branch, deploy_repo_url, deploy_github_token_encrypted, deploy_auto_update_enabled}`. Returns `null` on any failure. Also exposes `loadPostgresEnv()` and `parsePsqlOutput()` for testing. Standalone CLI smoke entry prints the loaded shape (with token redacted) as JSON. |
| `scripts/deploy/shared/decrypt-token.mjs` | `decryptDeployToken(encrypted, sessionSecret)` — byte-for-byte mirror of the contract's `decryptToken`. Strips `enc:` prefix, parses iv\|ct\|tag (base64), derives key via `SHA256(sessionSecret + 'deploy-token-key-v1')`, AES-256-GCM decipher. Returns `null` on any failure (wrong prefix, malformed segments, auth-tag mismatch, key rotated, etc.). |
| `scripts/deploy/shared/db-settings.test.mjs` | Vitest unit tests with mocked psql runner (`vi.fn()`). Covers default shape, full row set, JSON null vs. absent, unprefixed token rejection, unknown keys, malformed JSON skip, CRLF line endings, runner-throws-returns-null, `.env`-missing-returns-null. |
| `scripts/deploy/shared/decrypt-token.test.mjs` | Round-trip tests. Encrypts a known plaintext in-test using the contract's exact recipe (inlined, not imported, so future drift fails loudly), then asserts the helper decrypts it. Covers PAT, empty string, multi-byte UTF-8, wrong-secret returns null, prefix missing, segment count, tampered ciphertext + tampered auth tag. |

## Files modified

| Path | Change |
|---|---|
| `scripts/deploy/shared/branch-select.mjs` | Calls `loadDeploySettings()` before the prompt. If `deploy_branch` is set AND exists on origin, that branch is placed first in the menu as the SuperUser-configured default, with a `(using SuperUser-configured default: <branch>)` notice printed above the prompt. If the configured branch doesn't exist on origin, prints a yellow warning and falls back to hardcoded `stable`. If the settings call fails entirely (stack down / postgres unreachable), behavior is unchanged. |
| `scripts/deploy/platforms/docker-compose.mjs` | Pre-pull settings check: `deploy_auto_update_enabled === false` skips the entire fetch+pull block with a `(auto-update disabled via SuperUser settings — skipping pull)` notice. `deploy_repo_url` override (when it differs from `git remote get-url origin` after normalization) prints `(SuperUser override active: <url>)` and is used as the pull target for this one pull only — the configured origin URL is never touched. `deploy_github_token_encrypted` is read, decrypted using `SESSION_SECRET` from `.env`, and injected into the pull URL via `https://oauth2:<urlencoded-token>@github.com/...` basic auth. Only `https://github.com/...` URLs are eligible — other hosts/schemes silently drop the token rather than leak a PAT to an arbitrary endpoint. The plaintext token and authed URL are dereferenced in a `finally` immediately after the pull completes. Both the pull command and the override-URL handling use `execFileSync` array-form args so user-supplied values never go through a shell. |

## Test results

```
cd scripts/deploy/shared && npx vitest run
 Test Files  8 passed (8)
      Tests  154 passed (154)
   Duration  ~1.5s
```

Of the 154 tests, 28 are new (10 in `decrypt-token.test.mjs`, 18 in
`db-settings.test.mjs`). The other 126 are the pre-existing tests
covering `port-probe`, `letsencrypt`, `public-url`, `tls`,
`railway-api`, and `railway-orchestrator` — all still green.

Note: the shared/ directory has no `package.json` (matches the
pre-existing convention — every other `*.test.mjs` file here was run
the same way before this PR). `npx vitest` self-installs the package
on first run; the existing `vitest.config.mjs` picks up both new test
files automatically via its `*.test.mjs` glob.

## Smoke results

CLI smoke against the live local stack:

```
$ node scripts/deploy/shared/db-settings.mjs
{
  "deploy_branch": null,
  "deploy_repo_url": null,
  "deploy_github_token_encrypted": null,
  "deploy_auto_update_enabled": true
}
```

Confirmed `loadDeploySettings()` returns the defaults shape (no rows
yet — backend agent's endpoints haven't shipped) and that the CLI
helper runs cleanly with no postgres error.

End-to-end verification with manually-inserted rows:

```
$ docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
    "INSERT INTO system_settings (key, value) VALUES \
     ('deploy_branch', '\"permissions\"'::jsonb), \
     ('deploy_repo_url', '\"https://github.com/eoffermann/BigBlueBam.git\"'::jsonb), \
     ('deploy_github_token', '\"enc:aGVsbG8=:d29ybGQ=:dGFnZ290YWdnb3RhZ2dvdA==\"'::jsonb), \
     ('deploy_auto_update_enabled', 'true'::jsonb)"
INSERT 0 4

$ node scripts/deploy/shared/db-settings.mjs
{
  "deploy_branch": "permissions",
  "deploy_repo_url": "https://github.com/eoffermann/BigBlueBam.git",
  "deploy_github_token_encrypted": "[REDACTED enc:...]",
  "deploy_auto_update_enabled": true
}
```

All four fields round-trip correctly: branch name with no special
chars, URL with `:` `/` `.`, token with `enc:` prefix (masked in CLI
output to avoid scrollback leaks), boolean. Rows then deleted to leave
the table clean for the backend agent.

Module-import smoke for the wired call sites:

```
$ node -e "import('./scripts/deploy/shared/branch-select.mjs').then(...)"
OK: branch-select exports: [ 'chooseDeployBranch' ]

$ node -e "import('./scripts/deploy/platforms/docker-compose.mjs').then(...)"
OK: docker-compose exports: [ 'default', 'renderLivekitConfig' ]
  default keys: [ name, description, checkPrerequisites, writeEnvFile,
                  deploy, runCommand, verifyLogin, stop ]
```

Both modules import without ESM errors; the public API is unchanged.

## Anomalies / sharp edges

- **No `package.json` for `scripts/deploy/shared/`.** The task brief
  mentioned `pnpm install --no-frozen-lockfile && pnpm test`, but no
  package.json exists here — the existing six test files have always
  run via `npx vitest` (which self-installs vitest at the global cache
  on first run). I matched the pre-existing convention rather than
  inventing a new package boundary. If a future PR wants a proper
  `package.json` here, the shared tests will all keep working.

- **The `select` prompt doesn't auto-accept on Enter.** It requires a
  numeric pick. So "default selection" in `branch-select.mjs` is really
  "shown first in the menu" — same semantics that the original
  hardcoded `stable` had. No behavior regression; just calling out that
  there's no [Enter]-to-accept shortcut.

- **`runPullWithSettings` cannot zero plaintext token memory.** Node
  V8 doesn't expose a "wipe heap buffer" API. The helper drops local
  references in a `finally` block, which minimizes the window for
  accidental capture, but a process-dump attack against an active
  deploy script could still in principle recover the PAT until the next
  GC pass. This is no worse than every other use of process.env tokens
  in this repo (Railway, OAuth, SMTP, OpenAI, Anthropic, etc.) — flagging
  for completeness, not as a blocker.

- **SSH-form remote URL comparison.** `normalizeRepoUrl` treats
  `git@github.com:owner/repo` and `https://github.com/owner/repo` as the
  same URL for the override-vs-origin comparison. If the operator's
  origin is SSH and the SU configured an https override, we DO inject
  the token successfully (good — that's the point), but the
  `(override active)` notice still fires because the schemes differ.
  This is mildly noisy but not incorrect.

- **Token injection only supports `github.com`.** Per the contract:
  GitLab, Bitbucket, and self-hosted git are explicitly out of scope
  for v1. Non-github hosts get a `(SuperUser PAT only supports
  https://github.com/... URLs — pulling without it)` notice and the
  pull falls through to unauthenticated. This is the contract-defined
  behavior.

## Not done (outside scope)

- The four DB rows themselves aren't created or seeded — that's the
  backend agent's `PUT /superuser/deploy/settings` work.
- The frontend `DeploySettingsCard` to drive the PUT is the frontend
  agent's work.
- No new database migration: per the contract, the existing
  `system_settings` table is reused as-is.
