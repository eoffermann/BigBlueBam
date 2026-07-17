# Basis - App Design Specification

> Governed metric layer for BigBlueBam. One trusted definition per number, and an AI core that explains why it moved.
>
> Status: design draft (suite-brainstorm winner, Seat B / data-intelligence lens). New app.
> Chosen internal port: **4019** (first free port after Blip's 4018; 4015 is shared by blueprint/bureau).
> Routes: SPA at `/basis/`, REST at `/basis/api/`, realtime at `/basis/ws`.

---

## 1. Overview & positioning

**One-liner.** Basis is a governed *semantic layer*: each business metric is defined once (revenue = Bill paid invoices minus refunds; pipeline = Bond open deals by stage), certified by an owner, and read by every app, chart, and agent from the same definition. When a certified metric moves, Basis decomposes the delta across dimensions and correlates it to concrete cross-app events, returning plain-language root cause with linked drill-downs.

**Customer wedge.** Trust plus speed. Today an SMB gets three different "revenue" numbers from Bench, Bond, and Bill and nobody can say why a KPI moved without an afternoon of pivot-table archaeology. Basis gives one definition of truth and instant root-cause, a capability that only enterprise BI tools (Looker's LookML, dbt Semantic Layer, Cube) ship today and that no team of 2-50 can afford or staff.

**How it sits adjacent to existing apps (not on top of them).**
- Basis does **not** render charts or own dashboards. Bench does (`apps/bench/src/components/widgets/chart-renderer.tsx`, `apps/bench-api/`). Basis produces *definitions and explanations*; Bench *displays* them.
- Basis does **not** own the underlying source data. It defines metrics *over* data that already lives in Bond, Bill, Bam, Blast, etc., and reaches that data through Bench's existing governed query layer (`apps/bench-api/src/services/query.service.ts`, `apps/bench-api/src/lib/data-source-registry.ts`).
- Basis does **not** do external-source ETL or warehousing in v1.

**Positioning against Bench specifically.** Bench answers "show me a chart of X." Basis answers "what *is* X, who owns it, is it certified, and why did it change." A Bench widget binds to a Basis metric so that the KPI card labeled "MRR" everywhere in the suite resolves to exactly one certified definition.

**Chosen final name:** **Basis** (single word). Alternatives Baseline and Bedrock were considered and rejected.

**Explicitly out of v1 scope (future consumers, not built here):**
- **Bellwether** (forecasting) would consume Basis certified metrics as its input series.
- **Benchmark** (peer comparison) would consume Basis certified metrics for cross-org comparison.
Both are named only so the data model leaves room for them; neither is designed or built in v1.

---

## 2. AI-native design

Basis's AI core is **deterministic contribution analysis with an LLM-phrased narrative on top**. The math is reproducible and auditable; the language model only turns the ranked decomposition into a sentence. This keeps the "why" trustworthy (a governance product cannot hallucinate its numbers).

### 2.1 The mechanism: contribution analysis

Given a metric `M`, a baseline period `A`, and a comparison period `B`:

1. **Resolve** the metric's current certified definition to a canonical Bench query (`{source_product, source_entity, measure, filters, time_column}`). See `basis_metric_versions.definition` in Section 3.
2. **Total delta.** Execute the metric for `A` and `B` through Bench's query layer; compute `delta_abs = value_B - value_A` and `delta_pct`.
3. **Dimensional decomposition.** For each candidate dimension `d` (from the metric's `default_dimensions`, or a caller-supplied one), re-run the metric grouped by `d` for both periods and compute each dimension value's contribution to the delta. For an additive measure (`sum`/`count`) this is exact: `contribution(g) = value_B(g) - value_A(g)` and `sum(contributions) == delta_abs`. Drivers are ranked by absolute contribution.
4. **Event correlation.** For the top drivers, query cross-app activity in the `[A.end, B.end]` window (`v_activity_unified`, migration `infra/postgres/migrations/0129_activity_unified_view.sql`) and recent Bolt events (`bolt_recent_events` / `bolt_event_trace`) filtered to the driver's app and entity, to attach concrete causes: "3 enterprise Bond deals slipped from Won", "2 Bill invoices went overdue."
5. **Visibility preflight.** Every cited entity is passed through the MCP `can_access(asker_user_id, entity_type, entity_id)` tool / `POST /v1/visibility/can_access` (`apps/api/src/services/visibility.service.ts`) and dropped if the asker cannot see it. This is mandatory per the platform agent convention in `docs/reference/agent-conventions.md`.
6. **Narrative.** The ranked, access-filtered drivers plus correlated events are handed to the platform LLM provider (the same `llm-provider` surface the Bam api exposes; see the `llm-provider` per-route rate limit note in `CLAUDE.md`) with a strict template that forbids inventing numbers and requires hedged causal language ("correlates with", not "caused by"). Output: "MRR fell 8% ($4.1k) because 3 enterprise Bond deals slipped from Won ($3.2k) and 2 Bill invoices went overdue ($0.9k)", each clause carrying a drill-down link to the entity.

### 2.2 What an agent can do autonomously vs. HITL

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Read a certified metric's value | Autonomous | `basis_metric_value` MCP tool |
| Ask "why did X change" | Autonomous (read-only, `can_access`-filtered) | `basis_explain_change` |
| Rank drivers of a delta | Autonomous | `basis_rank_drivers` |
| List / search metric catalog | Autonomous | `basis_list_metrics`, `basis_search_metrics` |
| Define a *new draft* metric | Autonomous (draft only, never certified) | `basis_define_metric` |
| Add a new definition **version** to an existing metric | HITL | policy-gated; `confirm_action` two-step when the metric is already certified (org-wide truth change) |
| **Certify / decertify** a metric | HITL | `basis_certify_metric` requires `confirm_action:true`; permission `basis.metric.certify` |
| **Deprecate / delete** a metric | HITL, destructive | `basis_deprecate_metric` requires `confirm_action:true` |

The two-step `confirm_action` pattern mirrors Blip's terminal-action tools (`apps/mcp-server/src/tools/blip-tools.ts:155` and `:241`): call with `confirm_action` omitted to get a preview of impact, call again with `confirm_action:true` to proceed. Redis-backed confirm tokens are not needed for these because the inline-boolean idempotent pattern is sufficient (definition changes are versioned, not destructive), matching Blip's precedent.

### 2.3 Guardrails

- **agent_policies** (`infra/postgres/migrations/0139_*`, enforced in `apps/mcp-server/src/lib/register-tool.ts:503`): every `basis.*` tool invocation by a service account passes through the §15 kill-switch + glob allowlist (`basis.*`). No new mechanism; Basis just registers its tools through the standard `registerTool` wrapper.
- **Per-action permissions** (`@bigbluebam/permissions`): `basis.metric.read`, `basis.metric.define`, `basis.metric.certify`, `basis.metric.deprecate`, `basis.explain.run`. Enforced by the same permissions plugin Bench uses (`apps/bench-api/src/plugins/permissions.ts`).
- **can_access preflight** on every cited driver entity before it appears in an explanation (Section 2.1 step 5).
- **Correlation-not-causation guard**: the narrative template hard-requires hedged language and always links the raw contribution numbers so a human can audit the claim.
- **No autonomous certification**: an agent can draft a definition but only a human (or an explicitly permissioned service account clearing `confirm_action`) can flip `certification` to `certified`.

---

## 3. Data model

All Basis tables are org-scoped and carry `organization_id`, with RLS policies gated on the `app.current_org_id` GUC exactly as `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql` establish. Policies are advisory until `BBB_RLS_ENFORCE=1` flips the app role to NOBYPASSRLS.

### 3.1 Tables

**`basis_metrics`** - one row per governed metric.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `slug` | varchar(80) NOT NULL | stable machine key, unique per org (e.g. `mrr`, `pipeline_open`) |
| `name` | varchar(160) NOT NULL | display name |
| `description` | text | plain-language definition for humans |
| `unit` | varchar(20) NOT NULL | enum-like: `currency` \| `count` \| `percent` \| `ratio` \| `duration_ms` |
| `favorable_direction` | varchar(8) NOT NULL DEFAULT `'up'` | `up` \| `down` \| `neutral` (drives "good/bad" coloring in consumers) |
| `owner_id` | uuid | FK `users(id)` ON DELETE SET NULL; the accountable steward |
| `certification` | varchar(12) NOT NULL DEFAULT `'draft'` | `draft` \| `certified` \| `deprecated` |
| `current_version_id` | uuid | FK `basis_metric_versions(id)`; the active definition |
| `target` | jsonb | optional `{ value, comparison }` for threshold breach detection; nullable |
| `created_by` | uuid | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, slug)`, `(organization_id, certification)`, `(organization_id, owner_id)`.

**`basis_metric_versions`** - immutable, append-only lineage/audit trail of definitions.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | denormalized for RLS |
| `version_number` | integer NOT NULL | monotonically increasing per metric |
| `definition` | jsonb NOT NULL | canonical spec bound to a Bench data source: `{ source_product, source_entity, measure: { field, agg }, filters: [...], default_dimensions: [...], time_column }` (shapes mirror `apps/bench-api/src/services/query.service.ts` `QueryConfig`) |
| `lineage` | jsonb NOT NULL | derived from the Bench data source: upstream `{ apps: [...], base_table, joins }` copied from `data-source-registry.ts` at version-create time |
| `change_note` | text | why this version exists |
| `created_by` | uuid | FK `users(id)` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (metric_id, version_number)`, `(organization_id, created_at DESC)`. Rows are never updated or deleted (audit integrity); deprecating a metric flips `basis_metrics.certification`, it does not delete versions.

**`basis_metric_snapshots`** - periodic captured values that power movement detection and give "why did X change" a baseline without a live re-query.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_id` | uuid NOT NULL | FK `basis_metric_versions(id)`; which definition produced this value |
| `captured_at` | timestamptz NOT NULL | |
| `grain` | varchar(10) NOT NULL | `hour` \| `day` \| `week` \| `month` |
| `value` | numeric NOT NULL | the scalar metric value for the bucket |
| `dims` | jsonb | optional per-dimension breakdown snapshot for cheap decomposition |

Indexes: `(metric_id, grain, captured_at DESC)`, `(organization_id, captured_at DESC)`.

**`basis_explanations`** - cached contribution analyses (expensive to compute, safe to reuse within a TTL).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `period_a` / `period_b` | jsonb NOT NULL | `{ start, end }` each |
| `dimension` | varchar(80) | the decomposition dimension used |
| `delta_abs` | numeric | |
| `delta_pct` | numeric | |
| `drivers` | jsonb NOT NULL | ranked `[{ dimension_value, contribution_abs, contribution_pct, entity_refs: [...] }]` |
| `correlated_events` | jsonb | `[{ source, event_type, entity_type, entity_id, at }]`, already `can_access`-filtered |
| `narrative` | text | LLM-phrased sentence |
| `model` | varchar(60) | provider/model used for the narrative (auditability) |
| `computed_by` | uuid | actor (user or agent) |
| `computed_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(metric_id, computed_at DESC)`, a partial/covering index on `(metric_id, dimension)` for cache lookup.

### 3.2 Cross-app additive change (Bench binding)

**`bench_widgets` gains `basis_metric_id uuid NULL`** (additive), so a Bench widget can bind to a certified metric instead of an ad-hoc `query_config`. When set, Bench resolves the metric via `GET /basis/api/v1/metrics/:id/resolve` and executes it through its own existing query layer. No FK across the app boundary is declared in Drizzle (both apps share one DB, but Bench's schema module stays authoritative for the table); the column is a soft reference validated at bind time. The Drizzle schema `apps/bench-api/src/db/schema/bench-widgets.ts` is updated in the same change to keep `pnpm db:check` green.

### 3.3 Reused platform tables (not created here)

- `entity_links` (`0132_entity_links.sql`): explanation-to-driver links (`src_type='basis_explanation'`, `dst_type` = the driver entity type, `link_kind='references'`).
- `v_activity_unified` (`0129_activity_unified_view.sql`): read source for event correlation.
- `organizations`, `users` (via `apps/*/src/db/schema/bbb-refs.ts` style refs).

### 3.4 Numbered, idempotent migration plan

Migration tip observed on this branch is `0225_bin_scan_override.sql`, so Basis appends from `0226`. Every file follows the conventions in `CLAUDE.md` (filename `^[0-9]{4}_[a-z...]`, header block with `-- Why:` / `-- Client impact:`, `IF NOT EXISTS`, guarded destructive ALTERs, guarded enum creation via `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL`).

1. **`0226_basis_core.sql`** - `basis_metrics` + `basis_metric_versions`, their indexes, RLS enable + `basis_*_org_isolation` policies on `app.current_org_id`. Client impact: additive only.
2. **`0227_basis_snapshots_explanations.sql`** - `basis_metric_snapshots` + `basis_explanations`, indexes, RLS policies. Client impact: additive only.
3. **`0228_bench_widget_metric_binding.sql`** - `ALTER TABLE bench_widgets ADD COLUMN IF NOT EXISTS basis_metric_id uuid;` + `CREATE INDEX IF NOT EXISTS idx_bench_widgets_basis_metric ON bench_widgets(basis_metric_id);`. Client impact: additive only (nullable column).
4. **`0229_permissions_seed_actions_delta_020.sql`** - seed the `basis.*` action catalog rows following the existing `..._permissions_seed_actions_delta_NNN.sql` pattern (`0224` is the current tip of that series). Client impact: additive only. Regenerate `docs/permissions-action-manifest.json` in the same change.

Bolt event registration is **not** a migration; it is a TypeScript edit to `apps/bolt-api/src/services/event-catalog.ts` (Section 7), guarded by `scripts/check-bolt-catalog.mjs`.

---

## 4. API surface

Base path `/basis/api/`, Fastify routes registered under `/v1` (mirroring `apps/bench-api/src/server.ts:111-118`). All responses use the shared envelope conventions: success `{ data: ... }`, errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler`. List endpoints use cursor pagination, `?filter[field]=value`, and `?sort=-field` per `CLAUDE.md` "Key Design Decisions."

### 4.1 REST endpoints

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/v1/metrics` | List metrics | `filter[certification]`, `filter[owner_id]`, `q` search, cursor paginated |
| POST | `/v1/metrics` | Create metric (draft) + first version | emits `metric.created` |
| GET | `/v1/metrics/:id` | Get metric + current version | |
| PATCH | `/v1/metrics/:id` | Update metadata (name, owner, unit, direction, target) | non-definition fields only |
| POST | `/v1/metrics/:id/versions` | Add a new definition version, set as current | emits `metric.definition_changed` |
| GET | `/v1/metrics/:id/versions` | Version history / lineage audit | |
| POST | `/v1/metrics/:id/certify` | Flip to `certified` | perm `basis.metric.certify`; emits `metric.certified` |
| POST | `/v1/metrics/:id/decertify` | Flip back to `draft` | emits `metric.decertified` |
| DELETE | `/v1/metrics/:id` | Deprecate (soft; sets `deprecated`) | emits `metric.deprecated`; destructive-confirm on MCP |
| GET | `/v1/metrics/:id/resolve` | **Binding contract**: canonical Bench `{product, entity, query_config}` for the current certified version | consumed by Bench service-to-service |
| GET | `/v1/metrics/:id/value` | Single current value for a period | resolves definition, executes via Bench query layer |
| POST | `/v1/metrics/:id/explain` | Contribution analysis for `{period_a, period_b, dimension?}` | returns cached `basis_explanations` row or computes; large ranges offloaded to the `basis-explain` queue and returned `{ status: 'computing', job_id }` |
| GET | `/v1/metrics/:id/explanations` | List cached explanations | |
| GET | `/v1/metrics/:id/snapshots` | Movement history from `basis_metric_snapshots` | |
| GET | `/v1/metrics/:id/lineage` | Upstream apps/tables for the current version | reads `basis_metric_versions.lineage` |
| GET | `/v1/data-sources` | Pass-through of Bench's data-source catalog for the definition builder | proxies `bench-api` `listDataSources()` |
| GET | `/health` / `/readyz` | Liveness/readiness | via `@bigbluebam/service-health` |

**Underlying-data access decision.** Basis does not re-implement SQL generation. It reaches source data through Bench's governed builder in `apps/bench-api/src/services/query.service.ts` (`buildQuery`/`executeQuery`), which already enforces per-source org isolation, identifier allowlisting, and statement timeouts. The concrete integration path (internal service-to-service route on bench-api guarded by `INTERNAL_SERVICE_SECRET`, vs. forwarding the caller's bearer token, vs. extracting the builder into a shared package) is an open question in Section 10; the spec assumes an internal, secret-guarded query route added to bench-api.

### 4.2 Realtime (`/basis/ws`)

A lightweight WebSocket, cross-instance via Redis PubSub (same pattern as the Bam/Bench realtime described in `CLAUDE.md` "WebSocket realtime"). Rooms scoped to org. Broadcasts:
- `metric.certified` / `metric.definition_changed` so an open catalog view live-updates a badge.
- `explanation.ready` when a queued `basis-explain` job finishes, so the "why" explorer swaps its spinner for the result.

No collaborative editing / Yjs; this is a notification channel only.

### 4.3 MCP tools

Registered in a new `apps/mcp-server/src/tools/basis-tools.ts` using `registerTool` (`apps/mcp-server/src/lib/register-tool.ts:488`), calling `basis-api` over HTTP with the same client shape as `apps/mcp-server/src/tools/bench-tools.ts:9` (`createBenchClient`). Env `BASIS_API_URL=http://basis-api:4019/v1`.

| Tool | Backs | Autonomy |
| --- | --- | --- |
| `basis_list_metrics` | GET `/metrics` | read |
| `basis_search_metrics` | GET `/metrics?q=` | read |
| `basis_get_metric` | GET `/metrics/:id` | read |
| `basis_metric_value` | GET `/metrics/:id/value` | read |
| `basis_metric_lineage` | GET `/metrics/:id/lineage` | read |
| `basis_explain_change` | POST `/metrics/:id/explain` | read, `can_access`-filtered (the flagship tool) |
| `basis_rank_drivers` | POST `/metrics/:id/explain` (drivers only) | read |
| `basis_define_metric` | POST `/metrics` | write, draft only, policy-gated |
| `basis_add_metric_version` | POST `/metrics/:id/versions` | write, `confirm_action` when metric is certified |
| `basis_certify_metric` | POST `/metrics/:id/certify` | write, `confirm_action:true` required |
| `basis_decertify_metric` | POST `/metrics/:id/decertify` | write, `confirm_action:true` required |
| `basis_deprecate_metric` | DELETE `/metrics/:id` | destructive, `confirm_action:true` required |

**Endpoints intentionally with no MCP tool** (record in `docs/reference/mcp-endpoint-mapping.md`):
- `GET /metrics/:id/resolve` - _(skip: internal service-to-service binding contract for Bench, not agent-facing)_
- `GET /metrics/:id/snapshots`, `GET /metrics/:id/versions`, `GET /metrics/:id/explanations` - _(skip: folded into `basis_get_metric` / `basis_explain_change` responses; separate tools would be redundant)_
- `GET /data-sources` - _(skip: Bench already exposes `bench_list_data_sources`; Basis reuses it)_
- `PATCH /metrics/:id` - _(skip: metadata edit deferred; definition changes go through `basis_add_metric_version`)_
- `/basis/ws`, `/health`, `/readyz` - _(skip: realtime/probe)_

Also register a Basis provider in `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`) so a metric surfaces in cross-app search as "Revenue (certified metric)".

---

## 5. Frontend

`apps/basis/` React SPA, served by nginx at `/basis/`, modeled on `apps/bench/` structure (`app.tsx`, `main.tsx`, `pages/`, `hooks/`, `stores/auth.store.ts`, `lib/api.ts`). State: **TanStack Query v5** for server state (per-resource hooks like `apps/bench/src/hooks/use-widgets.ts`), **Zustand** for auth/session (`apps/bench/src/stores/auth.store.ts`). Components from **`@bigbluebam/ui`**; layout/sidebar modeled on `apps/bench/src/components/layout/`.

### Pages

1. **Metric Catalog** (`pages/metric-list.tsx`) - searchable/filterable table of metrics with certification badges (draft/certified/deprecated), owner avatars, unit, and last-movement sparkline. Reuses the list/filter patterns from `apps/bench/src/pages/dashboard-list.tsx`.
2. **Metric Detail** (`pages/metric-detail.tsx`) - definition summary, lineage panel (upstream apps/tables), current value, snapshot movement sparkline, version history, and certify/decertify/deprecate actions (permission-gated buttons).
3. **Definition Builder** (`pages/definition-builder.tsx`) - pick a Bench data source (from `GET /v1/data-sources`), choose measure + aggregation + filters + default dimensions; a "Preview value" button runs `GET /metrics/:id/value` (or a dry-run) to validate. Reuses the Bench widget-wizard mental model (`apps/bench/src/pages/widget-wizard.tsx`) without importing its chart code.
4. **Why-Did-It-Change Explorer** (`pages/explain.tsx`) - pick a metric, two periods, and an optional dimension; renders the ranked driver list with contribution bars, the plain-language narrative, and per-driver drill-down links that deep-link into the source app (Bond deal, Bill invoice). Live-updates via `/basis/ws` `explanation.ready`.
5. **Settings** (`pages/settings.tsx`) - metric owners/stewards, default decomposition dimensions, explanation cache TTL.

**Chart-scope discipline.** Per the out-of-scope rule, Basis renders only minimal *explanatory* visuals (ranked horizontal contribution bars, a value sparkline), not a general charting engine or dashboards. Rich visualization and dashboards remain Bench's job. The exact line (does a contribution waterfall count as "chart rendering"?) is flagged in Section 10; the conservative default is a bar-list, not a charting library.

---

## 6. Background work

New BullMQ workers in `apps/worker`, following the queue-plus-repeatable convention in `apps/worker/src/worker.ts` (`{ pattern: '<cron>' }` for scheduled jobs, e.g. the Bond stale-deals job at `worker.ts` ~line 823).

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `basis-metric-snapshot` | repeatable, hourly (`0 * * * *`) for `hour` grain; a daily `0 4 * * *` pass rolls up `day` grain | For each org's certified metrics, resolve the definition and execute via the Bench query layer, writing `basis_metric_snapshots`. Gives explanations a cheap baseline and powers movement detection. |
| `basis-explain` | on-demand queue (no schedule) | Offloads heavy `POST /explain` requests (large ranges / many dimensions) from the API; writes `basis_explanations` and broadcasts `explanation.ready` on `/basis/ws`. |
| `basis-movement-scan` | repeatable, daily (`30 4 * * *`, offset from snapshot) | Detects certified metrics whose latest snapshot breached `basis_metrics.target` or moved beyond a threshold vs. the prior period; precomputes an explanation and emits `metric.threshold_breached`. |

All three respect `SEED_ORG_SLUG`-agnostic multi-org iteration and set `app.current_org_id` per org before querying, consistent with the RLS posture.

---

## 7. Events & integration

### 7.1 Bolt events published (source `basis`)

Published via `publishBoltEvent(eventType, 'basis', payload, orgId, actorId?, actorType?)` from `@bigbluebam/shared` (`packages/shared/src/bolt-events.ts:35`), using bare event names per the naming convention. Each must be registered in `apps/bolt-api/src/services/event-catalog.ts` (with a `payload_schema`) or `scripts/check-bolt-catalog.mjs` fails CI.

| `event_type` | Fired when | Key payload |
| --- | --- | --- |
| `metric.created` | a new metric is defined | `metric.id`, `metric.slug`, `metric.name`, `actor.*`, `org.*` |
| `metric.definition_changed` | a new definition version becomes current | `metric.id`, `version.number`, `version.change_note`, `definition` summary |
| `metric.certified` | certification flips to certified | `metric.id`, `metric.slug`, `actor.*` |
| `metric.decertified` | certification flips back to draft | `metric.id`, `actor.*` |
| `metric.deprecated` | metric soft-deprecated | `metric.id`, `actor.*` |
| `metric.threshold_breached` | movement scan detects a target/threshold breach | `metric.id`, `delta_abs`, `delta_pct`, `explanation.id` |

These make Basis a first-class Bolt publisher, so a workflow can, for example, trigger a Banter post when `metric.threshold_breached` fires. `metric.definition_changed` is the governance signal the winning description calls out: downstream consumers (Bench widgets, future Bellwether/Benchmark) learn that a definition moved.

### 7.2 entity_links

Each explanation creates `entity_links` rows (`0132_entity_links.sql`) from `src_type='basis_explanation'`, `src_id=<explanation.id>` to each cited driver entity (`dst_type` = e.g. `bond_deal`, `bill_invoice`; `link_kind='references'`). This lets any consumer answer "what explanations cite this deal?" without Basis-specific knowledge.

### 7.3 Unified activity & cross-app search

- **search_everything**: register a Basis provider so certified metrics are findable in cross-app search (`apps/mcp-server/src/tools/search-tools.ts`), with `can_access`-aware scoring.
- **v_activity_unified**: Basis's own catalog changes flow as Bolt events (consumed by Bolt) rather than being UNIONed into the fixed `v_activity_unified` view in v1; extending that view to include a `basis_metric_versions` arm is noted as optional future work (Section 10). The correlation *reads* from `v_activity_unified`; it does not require writing to it.

---

## 8. Infrastructure

### 8.1 New compose service

`basis-api` added to `docker-compose.yml`, modeled on the `bench-api` service block:
- Internal port **4019** (`PORT: 4019`), stateless, horizontally scalable.
- `depends_on`: `migrate` (`service_completed_successfully`), `postgres`, `redis`.
- Env: `DATABASE_URL`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL=http://api:4000`, `BENCH_API_INTERNAL_URL=http://bench-api:4011`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `CORS_ORIGIN`, rate-limit and query-timeout knobs matching bench-api's `env.ts`.
- Healthcheck: `curl -sf http://localhost:4019/health` via `@bigbluebam/service-health`.

`basis` frontend service builds the SPA into the nginx html tree, same as other `apps/*` SPAs.

### 8.2 nginx routing (`infra/nginx/nginx.conf`)

Add, mirroring the bench block (`nginx.conf:280-296`):
```
location /basis/ { alias /usr/share/nginx/html/basis/; try_files $uri $uri/ /basis/index.html; }
location /basis/api/ { proxy_pass http://basis-api:4019/; ... }
location /basis/ws  { proxy_pass http://basis-api:4019/; ...upgrade headers... }
```
Railway needs the parallel entries in `nginx.railway.conf` plus a `scripts/deploy/.../services.mjs` catalog entry (per the "Railway new-app checklist" memory; provisioning is automated on push to `stable`).

### 8.3 MCP wiring

Add `BASIS_API_URL: http://basis-api:4019/v1` to the `mcp-server` service env (alongside the existing `BENCH_API_URL` etc. in `docker-compose.yml`), and register `basis-tools.ts` in the MCP server tool bootstrap.

### 8.4 Scaling & health

Stateless api container scales horizontally; realtime fan-out is cross-instance via Redis PubSub. Snapshot/explain workers run in the existing `apps/worker` process (no new container). Postgres/Redis are the only stateful dependencies and are the managed-swappable services already in the stack.

---

## 9. Reuse ledger

| Capability | Reuses (real file/package) | Genuinely new in Basis |
| --- | --- | --- |
| Underlying data query / SQL generation / org isolation | `apps/bench-api/src/services/query.service.ts` (`buildQuery`/`executeQuery`), `apps/bench-api/src/lib/data-source-registry.ts` | Metric-to-query resolution layer; nothing about SQL building |
| Data-source catalog for the definition builder | `apps/bench-api/src/routes/data-sources.routes.ts`, `listDataSources()` | Pass-through only |
| Chart/dashboard rendering | `apps/bench/` (widgets, chart-renderer) + new `bench_widgets.basis_metric_id` binding | One nullable binding column + a `/resolve` contract |
| Bolt event publishing | `@bigbluebam/shared` `publishBoltEvent` (`packages/shared/src/bolt-events.ts:35`); catalog `apps/bolt-api/src/services/event-catalog.ts`; guard `scripts/check-bolt-catalog.mjs` | 6 new `metric.*` event definitions |
| Cross-app event correlation | `v_activity_unified` (`0129_*`), `bolt_recent_events`/`bolt_event_trace` MCP tools | Decomposition + correlation logic |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts`, MCP `can_access` / `POST /v1/visibility/can_access` | Applying it to cited drivers |
| Cross-app linking | `entity_links` (`0132_entity_links.sql`) | Writing explanation-to-driver links |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` `search_everything` | A Basis search provider |
| RLS / org scoping | `app.current_org_id` GUC pattern (`0116_*`, `0132_*:52-56`) | Basis table policies (mechanical) |
| Per-action permissions | `@bigbluebam/permissions`, `apps/bench-api/src/plugins/permissions.ts` | 5 `basis.*` action rows |
| MCP tool registration + policy gate + confirm_action | `apps/mcp-server/src/lib/register-tool.ts:488`; confirm pattern `apps/mcp-server/src/tools/blip-tools.ts:155` | 12 `basis_*` tool handlers |
| Fastify service skeleton (cors/cookie/rate-limit/redis/auth) | `apps/bench-api/src/server.ts` | Basis routes/services |
| Health/readiness | `@bigbluebam/service-health` | Config only |
| Structured logging + 5xx recording | `@bigbluebam/logging` (`createErrorHandler`, `httpSystemErrorRecorder`) | Config only |
| Background jobs | `apps/worker` BullMQ conventions (`worker.ts`) | 3 `basis-*` job handlers |
| SPA scaffold (TanStack Query + Zustand + `@bigbluebam/ui`) | `apps/bench/src/` structure | 5 Basis pages |
| LLM narrative | platform `llm-provider` surface (Bam api) | Prompt template + hedging guard |

The ledger is the proof of the thesis: Basis is mostly wiring. The genuinely new surface is the metric catalog data model, the contribution-analysis math, and the narrative prompt.

---

## 10. Open questions & risks

1. **Bench query access path (integration decision, needs a human call).** Basis must run Bench-governed queries server-to-server. Options: (a) add an internal query route to `bench-api` guarded by `INTERNAL_SERVICE_SECRET`; (b) forward the caller's bearer token from Basis to bench-api; (c) extract `query.service.ts`'s builder into a shared package both apps import. Recommendation: (a), because it keeps one governed builder and one org-isolation implementation. This is the single biggest cross-app coupling in the spec and should be decided before implementation.

2. **Ratio / average / percentile metrics are not cleanly decomposable.** Exact additive decomposition (`sum(contributions) == delta_abs`) only holds for `sum` and `count` measures. Rates and averages need mix-vs-rate decomposition; percentiles (Blip's `p95` rollups) cannot be summed at all. v1 should ship exact decomposition for additive metrics and clearly label ratio/percentile explanations as "directional, not exact." Needs sign-off on that limitation.

3. **"No chart rendering" boundary.** The why-explorer wants a contribution waterfall, which is arguably a chart and thus arguably Bench's territory. Conservative v1: a ranked bar-list rendered with `@bigbluebam/ui` primitives, no charting library. Confirm whether a waterfall is acceptable within Basis or must be delegated to a Bench widget.

4. **Correlation is not causation.** The narrative asserts "why" from correlation in a time window. Mitigations (hedged language, linked raw numbers, `can_access` filtering) reduce but do not eliminate the risk of a confidently-wrong story. Accept as a labeled limitation; never let an agent treat an explanation as ground truth for an autonomous write.

5. **Certification governance.** Who may certify? v1 gates on `basis.metric.certify` (org admin/owner by default). Whether service accounts can ever certify autonomously (vs. always requiring a human `confirm_action`) is a policy question.

6. **`v_activity_unified` extension.** Whether Basis catalog changes should be UNIONed into the unified activity view (vs. living only as Bolt events) is deferred; the view is a fixed UNION and touching it is a platform-wide change.

7. **Snapshot cost at scale.** Hourly snapshots of every certified metric for every org is O(metrics x orgs) Bench queries per hour. For large tenants this needs batching/caching (reuse `apps/bench-api/src/services/cache.service.ts`) and possibly a lower default grain. Capacity plan needed before enabling by default.

8. **Definition drift vs. Bench data-source drift.** A metric's `definition` references a Bench data source (`product:entity`, fields). If Bench renames a field or an MV loses org isolation (see the cautionary comments in `data-source-registry.ts` about `bench_mv_daily_task_throughput`), a certified metric can silently break. Basis needs a validation pass (part of `basis-metric-snapshot`) that flags metrics whose resolve fails, rather than serving a broken number.

---

## Changelog

- Initial draft (round 0): full spec authored against Bench sibling, shared packages, MCP tool-registration pattern, and migration conventions. Chose internal port 4019 and routes `/basis/`, `/basis/api/`, `/basis/ws`.
