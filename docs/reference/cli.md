# B3 CLI Reference

The BigBlueBam CLI (often called the "B3 CLI") is a small administrative tool that lives inside the `api` container. It performs the few operations that bootstrap the platform, manage operator-level identities, mint service credentials, and recover access — anything that is awkward, dangerous, or unnecessary to expose over HTTP.

Its source is a single file at [`apps/api/src/cli.ts`](../../apps/api/src/cli.ts). It is built alongside the API (`pnpm --filter @bigbluebam/api build`) and run from inside the container as:

```sh
docker compose exec api node dist/cli.js <command> [flags...]
```

If you're running on a developer host outside Docker, you can also run it directly:

```sh
pnpm --filter @bigbluebam/api exec tsx src/cli.ts <command> [flags...]
```

In both cases the CLI reads `DATABASE_URL` from the environment and connects directly to PostgreSQL. It does **not** go through the HTTP API — that means it can do things normal HTTP users cannot (create the very first SuperUser when no admin exists yet; reset a password without knowing the old one), and it also means it bypasses rate limits, audit logging the API would have written, and the per-route rank checks. Treat it as a privileged tool.

## Convention summary

- **Argument parsing**: long-form flags only, `--foo bar` (no `=`). Boolean flags: `--superuser`, `--hard`, `--force`. Anything else needs a value.
- **Common identifiers**: orgs can usually be referenced by either `--org-slug` or `--org-id`; users always by `--email`.
- **Password length**: a 12-character minimum is enforced on any flag that accepts one.
- **Token output**: anything ending in `_key` or `_token` is printed **once** to stdout. Capture it — there is no API to retrieve it later.

## Commands

### `create-admin`

Bootstrap a new organization and its first owner-user. The owner is automatically given a default org membership and the `owner` role. Pass `--superuser` to additionally grant platform SuperUser. Use this when standing up a fresh stack and the `/auth/bootstrap` HTTP route is unavailable or undesirable.

```
cli create-admin --email <email> --password <pw> --name <display-name> --org <org-name> [--superuser]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--email` | yes | The owner's login email. Must be unique across users. |
| `--password` | yes | The owner's password. Min 12 chars. Stored as an Argon2id hash. |
| `--name` | yes | Display name for the user. |
| `--org` | yes | Human-readable org name. The slug is derived from it. |
| `--superuser` | no | Boolean. Also marks the user as a platform SuperUser. |

Errors:
- `slug "<slug>" is reserved` — the derived slug collides with a reserved SPA route (`login`, `tickets`, `mcp`, etc.). Pick a different org name.

Example:
```sh
docker compose exec api node dist/cli.js create-admin \
  --email admin@acme.com --password 'YourStrongPw!' \
  --name "Acme Admin" --org "Acme Inc" --superuser
```

### `create-user`

Add a user to an **existing** organization with any role. Use this for adding teammates after the bootstrap user has already been created. For more complex flows (inviting via email, adding to specific projects in one step) prefer the `/org/members/invite` HTTP endpoint.

```
cli create-user --email <email> --password <pw> --name <display-name>
                (--org-slug <slug> | --org-id <uuid>) [--role <role>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--email` | yes | The user's login email. |
| `--password` | yes | The user's password. Min 12 chars. |
| `--name` | yes | Display name. |
| `--org-slug` or `--org-id` | one required | Which org to create the user in. |
| `--role` | no | One of `owner`, `admin`, `member`, `viewer`, `guest`. Defaults to `member`. |

### `grant-superuser` / `revoke-superuser`

Toggle the `is_superuser` flag on an existing user by email. SuperUsers bypass org rank checks, can see the `/b3/superuser` admin surface, and can impersonate other users. Be careful.

```
cli grant-superuser --email <email>
cli revoke-superuser --email <email>
```

### `create-api-key`

Mint a user API key. Tokens are prefixed `bbam_` (32-byte base64url body) and stored as Argon2id hashes. Printed **once** to stdout — there is no retrieval. Pin the key to a single org with `--org-slug` or `--org-id` (required by P2-8) and optionally to a single project with `--project-id`.

```
cli create-api-key --email <email> --name <key-label> --scope <scope>
                   (--org-slug <slug> | --org-id <uuid>)
                   [--project-id <uuid>] [--expires-days <n>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--email` | yes | The user the key belongs to. They must already be a member of the chosen org. |
| `--name` | yes | Human-readable label so you can revoke later. |
| `--scope` | yes | `read`, `read_write`, or `admin`. |
| `--org-slug` or `--org-id` | one required | Pins the key to exactly one org. |
| `--project-id` | no | Further restricts the key to a single project. |
| `--expires-days` | no | Numeric expiry, in days from now. Omit for no expiry. |

### `create-service-account`

Create a locked, login-less user plus a `bbam_svc_`-prefixed API key for internal service-to-service calls. The intended use is anything that needs to call the internal MCP `/tools/call` route (apps/mcp-server) or anywhere a real human credential is wrong. Default scope is `admin`.

```
cli create-service-account --name <account-name> (--org-slug <slug> | --org-id <uuid>) [--scope <scope>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name` | yes | Both the service account's display name and the underlying user. |
| `--org-slug` or `--org-id` | one required | Which org the service account lives in. |
| `--scope` | no | Defaults to `admin`. |

### `create-helpdesk-agent-key`

Per-agent API key for Helpdesk (HB-28 + HB-49). Prefixed `hdag_`, stored hashed. Printed once.

```
cli create-helpdesk-agent-key --email <agent-email> --name <key-label> [--expires-days <n>]
```

### `revoke-api-key`

Hard-deletes a Bam API key by prefix (the first 8 characters that you see in the audit log). Use `--id` if you have the full key id instead.

```
cli revoke-api-key --prefix <bbam_xxx>
cli revoke-api-key --id <uuid>
```

### `revoke-helpdesk-agent-key`

Soft-revokes by default (the row is kept with `revoked_at` set so audit trails stay intact). Pass `--hard` or `--force` for a destructive delete.

```
cli revoke-helpdesk-agent-key --prefix <hdag_xxx> [--hard]
```

### `list-orgs`

Diagnostic helper — prints every org's slug, id, and name. Useful when you need an `--org-slug` for another command but don't remember it.

```
cli list-orgs
```

### `reset-password`

Reset a user's password by email. Generates a 16-character strong password from a confusable-safe alphabet (or uses `--password` if provided), writes the Argon2id hash, and deletes **every** session for that user inside the same transaction so any stolen cookie becomes useless. The new password is printed once.

This is the operator-side counterpart to the `POST /org/members/:userId/reset-password` HTTP endpoint. Unlike that endpoint it performs no rank check — an operator running the CLI is assumed to have already verified the request out-of-band — and it never sends email. Pair it with the "send password reset link" UI button if you want the user to set the password themselves.

```
cli reset-password --email <email> [--password <new-pw>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--email` | yes | The user whose password is being reset. |
| `--password` | no | The new password. Min 12 chars. If omitted, a 16-char password is generated. |

Output:
```
Password reset successfully:
  User ID:           20daae27-cd86-41c5-a64c-1113ba6bd750
  Email:             user@example.com
  Name:              Sample User
  New password:      Ky8qPxZ4RvHdW2Lj
  Generated:         yes
  Sessions revoked:  3

Share this password with the user out-of-band. It will not be shown again.
```

Common uses:
- The user is locked out and you need to hand them a temporary password immediately.
- You need to recover access to a stack where SMTP is not (yet) configured and so the email-reset link flow can't help.
- You are scripting a re-credentialing flow as part of incident response.

Errors:
- `no user found with email <email>` — the email does not exist in the `users` table. Run `list-orgs` and then verify the user exists in your target org.
- `--password must be at least 12 characters` — bump the password length or omit the flag.

### `--help` / no command

Prints a usage summary identical to the one above. When in doubt, run it.

## Common patterns

### First-run bootstrap

```sh
# Once postgres + migrate have run:
docker compose exec api node dist/cli.js create-admin \
  --email me@example.com --password 'BootstrapPw1!' \
  --name "Eddie" --org "Acme" --superuser
```

### Operator-side password rescue

```sh
# Reset the password and hand the generated string to the user.
docker compose exec api node dist/cli.js reset-password \
  --email locked-out@example.com
```

### Mint a CI / scripting key

```sh
docker compose exec api node dist/cli.js create-api-key \
  --email ci-bot@example.com --name "ci-pipeline" --scope read_write \
  --org-slug acme --expires-days 90
```

### Stand up an MCP service account

```sh
docker compose exec api node dist/cli.js create-service-account \
  --name "mcp-internal" --org-slug acme
```

## See also

- [`docs/reference/api-reference.md`](api-reference.md) for HTTP endpoints, including the corresponding `POST /org/members/:userId/reset-password` and `POST /org/members/:userId/send-password-reset` flows.
- [`docs/reference/permissions.md`](permissions.md) for how org roles relate to action permissions.
- [`docs/reference/architecture.md`](architecture.md) for where the API container sits in the stack.
