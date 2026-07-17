# Basis - Human Setup Requirements

Companion to `2026_07_17_12_58_APP_DESIGN_basis.md` and the build on the
`suite-brainstorm` branch. These are the items the autonomous build **cannot**
complete on its own - they need a human decision, a cross-team change, or a secret.
Everything not listed here is being built and tested autonomously; the paths that
depend on these items are marked "pending human setup" until each is provided.

Status legend: **BLOCKER** (a core runtime path does not work until done) ·
**DECISION** (a governance/scoping call the build should not make alone) ·
**CONFIG** (a secret/env value only a human should set).

---

## 1. Bench internal query route (2-mode auth) - BLOCKER

- **What:** a new internal query route on **`bench-api`** that Basis calls
  server-to-server to run governed queries, with the two auth modes in spec 4.1:
  (a) user requests forward the caller's bearer, validated live via `requireAuth`
  with org derived from the verified principal, `INTERNAL_SERVICE_SECRET` as an
  additional gate; (b) workers present `INTERNAL_SERVICE_SECRET` + an explicit
  `org_id`.
- **Why:** the entire `/value` and `/explain` path and every snapshot/movement job
  depend on it. Without it, Basis can define, certify, and version metrics, but
  cannot compute a value or an explanation. This route is owned by the Bench
  maintainers (Open Question 3), so the autonomous build treats it as a
  prerequisite rather than silently editing Bench's auth surface.
- **Where:** `apps/bench-api/src/routes/` (new internal route) + the query builder in
  `apps/bench-api/src/services/query.service.ts`. Follow the existing
  `INTERNAL_SERVICE_SECRET`-guarded internal-route precedent.
- **Verify:** with the route live and `INTERNAL_SERVICE_SECRET` set, a Basis
  `/v1/metrics/:id/value` call returns a number and `/explain` returns a driver
  decomposition; org isolation holds (a token for org A cannot read org B).
- **Interim build behavior:** Basis ships the value/explain endpoints with the Bench
  client behind a circuit breaker returning a typed `UPSTREAM_UNAVAILABLE` when the
  route is absent, so the app deploys and every non-query path works.

## 2. `INTERNAL_SERVICE_SECRET` must be non-empty wherever Basis runs - CONFIG

- **What:** set `INTERNAL_SERVICE_SECRET` to a real value for `basis-api`, the
  `worker`, and `bench-api` (it must match).
- **Why:** the platform default is empty, which correctly **fails closed** - both
  bench-auth modes reject the call, so value/explain and all jobs no-op.
- **Where:** `.env` (and the Railway/deploy env for each of those services). Already
  a required env var per the root `CLAUDE.md` Environment section.
- **Verify:** `docker compose exec basis-api printenv INTERNAL_SERVICE_SECRET`
  returns a non-empty value equal to the one on `bench-api` and `worker`.

## 3. Ratio / average / percentile decomposition sign-off - DECISION

- **What:** confirm that for non-additive measures (`avg`, ratios, percentiles) the
  contribution decomposition is labeled **"directional, not exact"** in v1 (exact
  `sum(contributions) == delta_abs` holds only for `sum`/`count`).
- **Why:** the "one trusted number" promise is exact only for additive measures;
  ratio explanations are directional and must be presented as such so no one treats
  them as reconciling arithmetic (Open Question 1).
- **Where:** product decision; reflected in the Explain Explorer copy and the
  explanation payload's `exact: boolean` flag.

## 4. Certification governance - DECISION

- **What:** decide who may flip a metric to **certified**. Default gate is
  `basis.metric.certify` (org admin/owner). Open question: whether a permissioned
  **service account / agent may ever certify without a human** (Open Question 7).
- **Why:** certification is the act that makes a definition the org-wide source of
  truth; the truth-flip MCP tools already require a Redis-backed confirm token, but
  the human-vs-agent policy for certification is a governance call.
- **Where:** the `basis.metric.certify` permission grant + `agent_policies` for any
  service account that should (or should not) hold it.

## 5. Class-B resolver coverage + `related_apps` seeding - DECISION

- **What:** decide which entity-FK decomposition dimensions ship registered
  resolvers in v1 (owner, company, project?) and which neighbor apps an admin may
  add to a metric's `related_apps` correlation neighborhood (Open Questions 4, 5).
- **Why:** unregistered dimensions are simply not offered for decomposition, and
  correlation quality depends on the `related_apps` set; both are scoping calls, not
  code the build should guess.
- **Where:** the resolver registry in `basis-api` and the metric's `related_apps`
  field / Settings page.

## 6. `/resolve` presentation-envelope precedence in Bench - DECISION + cross-team

- **What:** a coordinated **Bench** change so a widget bound to a Basis metric
  prefers the Basis presentation envelope (`unit`, `favorable_direction`, `target`,
  `display_name`) from `GET /basis/api/v1/metrics/:id/resolve` over its local
  `kpi_config` (Open Question 6).
- **Why:** without it, a KPI card bound to "MRR" can still render with a stale local
  target/direction - two sources of truth for presentation, the thing Basis exists
  to unify.
- **Where:** `apps/bench-api` widget resolution + `apps/bench/` KPI renderer.
- **Interim build behavior:** Basis exposes `/resolve` with the full envelope now;
  the Bench-side preference is a follow-up and is marked pending here.

---

## Not blocked (built and tested autonomously)

Metric catalog + CRUD, versioning + immutable lineage, certify/decertify/deprecate
with Redis confirm tokens, the definition builder with Bench-preview round-trip
validation, snapshots + movement detection + retention (all local), the Launchpad
tile, docs, gilligan screenshots, and the marketing entry do **not** depend on the
items above and are completed in the normal cycle. Only the live value/explain
numbers (items 1-2) and the two cross-team preferences (items 4-6 decisions,
item 6 Bench change) wait on a human.
