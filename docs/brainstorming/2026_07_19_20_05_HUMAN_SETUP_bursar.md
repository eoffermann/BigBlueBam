# Human setup - Bursar (cycle 2026_07_19_20_05)

Actions that require a human keystroke. Everything not listed here was built and wired
autonomously on the `suite-brainstorm` branch.

This doc holds only three categories: an external secret or third-party account, a
harness-blocked keystroke that could not be run from the build environment, and the
standing note that promotion to trunk is the maintainer's call. Internal engineering is
never parked here.

**Open items: 1** (plus the standing promotion note).

---

## 1. Raise `max_connections` on the Railway-managed Postgres

- [ ] **What:** raise `max_connections` from the stock 100 to 200 on the Railway Postgres
      service, and if the plan allows it, raise `shared_buffers` to 512MB.

- **Why it matters.** Every API service in the suite opens a connection pool (`max: 20`,
  plus a second read pool where `DATABASE_READ_URL` is set). With 24 API services plus the
  worker and the mcp-server, the theoretical ceiling is far above 100; it only works today
  because pools fill lazily. Bursar adds long-held advisory locks and a set of scheduled
  jobs, which is the workload shape that converts latent oversubscription into real
  `FATAL: sorry, too many clients already` errors. The failures would surface in *other*
  apps first, so this typically presents as a Bond or Bill outage rather than anything that
  points at Bursar.

- **Why the build could not do it.** Railway Postgres is a managed plan. Neither this
  repository nor the deploy adapters in `scripts/deploy/` can set server parameters on it;
  there is no compose `command:` to override. The local dev stack was raised to 200 and
  verified, so this gap exists only in production.

- **Where:** the Railway dashboard for the Postgres service on the BigBlueBam project, under
  the service's variables or plan configuration. On plans that expose it, this is the
  `POSTGRES_MAX_CONNECTIONS` service variable; on others it requires a plan change.

- **Verify afterwards:**

  ```sh
  psql "$RAILWAY_DATABASE_URL" -c "SHOW max_connections;"
  ```

  Expect `200`. The local equivalent already returns 200:

  ```sh
  docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SHOW max_connections;"
  ```

- **If you skip it:** production keeps the stock 100 and stays at the pre-existing risk
  level. Bursar itself will still work; the risk is suite-wide connection exhaustion under
  load, which predates Bursar and which Bursar makes somewhat more likely. The deploy
  catalog records this as a `tuning` block with `applied_on_railway: false` so it is not
  silently forgotten.

---

## 2. Promotion to `main` / `stable` (standing note, no action required)

The autonomous loop never merges to trunk. All Bursar work lives on `suite-brainstorm` and
on feature branches off it. Promoting any of it to `main` and then `stable` is the
maintainer's decision, taken separately from this cycle. The loop does not wait on it.
