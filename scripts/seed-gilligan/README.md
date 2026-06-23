# Gilligan's Island seed

A themed, cross-app demo dataset: the castaways run their rescue (and the
Howells' social calendar) on BigBlueBam. One org, seven users, and content
across every app — projects, CRM deals, chat, docs, knowledge base, dashboards,
invoices, whiteboards, calendars, diagrams, automations, goals, campaigns,
helpdesk tickets, and SMTP settings.

## Usage

Bring the stack up and apply migrations first, then run the orchestrator from the
repo root:

```bash
docker compose up -d            # stack must be running
docker compose run --rm migrate # schema current
pnpm seed:gilligan              # = node scripts/seed-gilligan/run-all.mjs
```

It is **idempotent** — re-running is safe (every seeder is find-or-create, and the
org/user bootstrap uses upserts). It takes ~90s on a warm stack.

## What `run-all.mjs` does

1. **Bootstraps** the `Gilligan Travel Ltd` org (slug `gilligan-travel-ltd`) and
   the 7 castaway users at the fixed UUIDs the individual seeders hardcode, with
   org + role-group memberships and default priorities (the same rows
   `cli create-admin`/`create-user` create, but at deterministic ids so the 28
   seeders run unchanged).
2. **Mints** a `read_write` API key per castaway (and best-effort admin keys for
   the SMTP step) and assembles the `GKEYS` map the seeders read.
3. **Runs** all 28 seeders in dependency order inside the `api` container
   (`docker compose exec -T -e GKEYS=… api node - < <file>`), which is how they
   reach the internal app hosts and the `DATABASE_URL`/`REDIS_URL`/`S3_*` env.
   Transient `429`s (e.g. banter) are retried with backoff.

## Logins

All castaways share the dev password **`Castaway2026!`**:

| Login | Role |
|---|---|
| `skipper@gilligantravel.example` | owner |
| `howell@gilligantravel.example` | admin |
| `professor@`, `gilligan@`, `maryann@`, `ginger@`, `lovey@` `gilligantravel.example` | member |

Sign in at `/b3/login`; the org is `gilligan-travel-ltd`. Helpdesk customers are
printed at the end of the run.

## Known limitation: form submissions

`blank.mjs` / `blank-submissions.mjs` post to the **public** form-submit endpoint,
which has a fixed anti-spam cap of **10 submissions/hour/form** (blank-api
`public.routes.ts`) that the permissive-rate-limit dev flag does **not** relax.
The forms themselves are always seeded; sample submissions beyond the cap are
expected to be rate-limited, so those two seeders are marked *soft* and do not
fail the run (reported as "⚠ partial (expected)").

## Notes

- Each run mints fresh `gilligan-seed` API keys; if they accumulate, revoke them
  under People → Access (or `cli revoke-api-key`).
- `board-luau.mjs` is a base64 asset generator used by `board.mjs`, not a seeder,
  so the orchestrator does not run it directly.
