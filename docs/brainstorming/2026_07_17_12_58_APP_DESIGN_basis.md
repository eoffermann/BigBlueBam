# Basis - App Design Specification

> Governed metric layer for BigBlueBam. One trusted definition per number, and an AI core that explains why it moved.
>
> Status: design draft, revised after adversarial review round 1. New app.
> Chosen internal port: **4019** (first free port after Blip's 4018; 4015 is shared by blueprint/bureau).
> Routes: SPA at `/basis/`, REST at `/basis/api/`, realtime at `/basis/ws`.

---

## 1. Overview & positioning

**One-liner.** Basis is a governed *semantic layer*: each business metric is defined once (revenue = Bill paid invoices minus refunds; pipeline = Bond open deals by stage), certified by an owner, and read by every app, chart, and agent from the same definition. When a certified metric moves, Basis decomposes the delta across dimensions and, separately, surfaces concrete cross-app activity that may have contributed, returning plain-language root cause with per-user access-filtered drill-downs.

**Customer wedge.** Trust plus speed. Today an SMB gets three different "revenue" numbers from Bench, Bond, and Bill and nobody can say why a KPI moved without an afternoon of pivot-table archaeology. Basis gives one definition of truth and instant root-cause, a capability that only enterprise BI tools (Looker's LookML, dbt Semantic Layer, Cube) ship today and that no team of 2-50 can afford or staff.

**How it sits adjacent to existing apps (not on top of them).**
- Basis does **not** render charts or own dashboards. Bench does (`apps/bench/src/components/widgets/chart-renderer.tsx`, `apps/bench-api/`). Basis produces *definitions and explanations*; Bench *displays* them.
- Basis does **not** own the underlying source data. It defines metrics *over* data that already lives in Bond, Bill, Bam, Blast, etc., and reaches that data through Bench's existing governed query builder (`apps/bench-api/src/services/query.service.ts`, `apps/bench-api/src/lib/data-source-registry.ts`).
- Basis does **not** do external-source ETL or warehousing in v1.

**Relationship to Bench `bench_saved_queries` (adjacency clarified per review).** `apps/bench-api/src/db/schema/bench-saved-queries.ts` is already a named, org-scoped saved query (`data_source`, `entity`, `query_config`) - structurally a metric definition *minus governance*. Basis is deliberately **not** just a certified saved query, for three reasons: (1) governance is first-class (owner, certification state, immutable version lineage, Bolt events on change) rather than a flag; (2) a metric is consumed by many surfaces (widgets, agents, workers) and must have a stable `slug` identity independent of any one saved query; (3) a metric carries presentation governance (unit, favorable direction, target) that a saved query does not. Basis's version `definition` **reuses the Bench `QueryConfig` Zod shape from `packages/shared/src/schemas/bench.ts`** rather than re-describing it, so the two cannot silently drift. A future consolidation (a metric wrapping a `bench_saved_queries.id`) is noted in Open Questions; v1 keeps the definition inline but typed from the shared schema.

**Positioning against Bench widgets.** Bench answers "show me a chart of X." Basis answers "what *is* X, who owns it, is it certified, and why did it change." A Bench widget binds to a Basis metric so the KPI card labeled "MRR" everywhere in the suite resolves to exactly one certified definition and one certified presentation envelope.

**Chosen final name:** **Basis** (single word). Alternatives Baseline and Bedrock were considered and rejected.

**Explicitly out of v1 scope (future consumers, not built here):** **Bellwether** (forecasting) and **Benchmark** (peer comparison) would each consume Basis certified metrics. Named only so the data model leaves room; neither is designed or built in v1.

---

## 2. AI-native design

Basis's AI core is **deterministic contribution analysis with a best-effort LLM-phrased narrative on top**. The math is reproducible and auditable; the language model only turns the ranked decomposition into a sentence, and its failure never blocks the result. This keeps a governance product from ever hallucinating its numbers.

### 2.1 Two independent computations, never fused into one figure

A hard lesson from review: Bench's `executeQuery` returns **grouped aggregates only, never row-level entity IDs**, and concrete entities come only from a time-window activity correlation that can disagree with the delta. So Basis keeps two computations strictly separate and labels them as such:

1. **Deterministic dimensional decomposition (the drivers).** For an additive measure (`sum`/`count`), re-run the metric grouped by a decomposition dimension for both periods; each dimension value's contribution is `value_B(g) - value_A(g)`, and `sum(contributions) == delta_abs` exactly. Drivers are **dimension-value contributions** (e.g. "Enterprise segment contributed -$3.2k"), not entities.
2. **Possibly-related activity (the correlation).** A **separate, explicitly-labeled** list assembled from `v_activity_unified` (`infra/postgres/migrations/0129_activity_unified_view.sql`) and `bolt_recent_events` in the `[A.end, B.end]` window, filtered to the drivers' apps. This is presented as "possibly related activity," never summed into the delta and never asserted as *the* cause.

The flagship output therefore reads: *"MRR fell 8% ($4.1k). Largest contributions to the decline: Enterprise segment -$3.2k, Overdue bucket -$0.9k. Possibly related activity in this window: 3 Bond deals left the Won stage; 2 Bill invoices became overdue."* The `$` figures come only from decomposition; the deals/invoices are correlation, clearly fenced.

If per-driver entity attribution is ever required (post-v1), it needs a governed bounded "top contributing rows" query whose sum is reconciled to the aggregate delta before any attribution is asserted. Not in v1.

### 2.2 Dimension-value labels (raw UUIDs are not human-readable)

Bench dimensions are frequently raw FK UUIDs (`stage_id`, `owner_id`) and `buildQuery` ignores `source.joins`, so a grouped re-query returns UUID buckets, not "Won" or "Enterprise." v1 handles this two ways: the decomposition-dimension allowlist is restricted to **self-labeling columns** (enum/text such as `status`, `level`, `lifecycle_stage`, or MV label columns like `bench_mv_pipeline_snapshot.stage_name`), **or** a dimension has a **registered per-source label resolver** in Basis that maps its UUIDs to names. `lineage.joins` is descriptive metadata only and does **not** participate in query execution. A dimension with neither self-labeling nor a resolver is not offered for decomposition in v1.

### 2.3 Per-user visibility (the leak fix)

Correlated activity is **resolved live per requesting user at read time**, never persisted with a single computer's visibility. Before any cited entity appears, it is mapped to a **canonical dotted `VisibilityEntityType`** (`bond.deal`, `bill.invoice`, `bam.task`; the exact allowlist is `SUPPORTED_ENTITY_TYPES` in `apps/api/src/services/visibility.service.ts:91`) and passed through MCP `can_access(asker_user_id, entity_type, entity_id)` / `POST /v1/visibility/can_access`. Any type not in the allowlist, and any entity the asker cannot see, is dropped fail-closed. The `entity_links.dst_type` string convention (Section 3.3) is kept separate from the visibility type and mapped to it.

Because correlation is per-user, the shared explanation cache (Section 3.1) stores **only the deterministic aggregate decomposition** (delta, dimension contributions). No entity references or correlated-event lists are ever persisted in a shared row. Concrete drivers/drill-downs are recomputed and re-`can_access`-filtered on every read, per the requesting user.

### 2.4 Prompt-injection and PII isolation

Cross-app text (deal names, invoice memos) is attacker-controllable. The narrative step therefore: (a) passes drivers to the LLM as **opaque tokens** (`DRIVER_1`, `DRIVER_2`) plus their numeric contributions, never raw third-party strings; the SPA re-hydrates real names client-side after generation; (b) uses **only the internal platform llm-provider** surface (`apps/api/src/routes/internal-llm.routes.ts` / `apps/api/src/services/llm-provider.service.ts`, reached via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), so no PII egresses to a third-party endpoint Basis chose; (c) renders the returned narrative as **plain text** - no model-emitted HTML or markdown links (links are attached by the SPA from the structured driver list).

### 2.5 What an agent can do autonomously vs. HITL

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Read a certified metric's value | Autonomous | `basis_metric_value` |
| Ask "why did X change" | Autonomous, `can_access`-filtered per caller | `basis_explain_change` |
| Rank drivers of a delta | Autonomous | `basis_rank_drivers` |
| List / search metric catalog | Autonomous | `basis_list_metrics`, `basis_search_metrics` |
| Define a *new draft* metric | Autonomous (draft only) | `basis_define_metric` |
| Add a definition **version** to a **draft** metric | Autonomous, policy-gated, inline `confirm_action` | `basis_add_metric_version` |
| Add a version to a **certified** metric | HITL, Redis-backed confirm token | `basis_add_metric_version` |
| **Certify / decertify** a metric | HITL, Redis-backed confirm token | `basis_certify_metric` / `basis_decertify_metric` |
| **Deprecate** a metric | HITL, destructive, Redis-backed confirm token | `basis_deprecate_metric` |

Per review, the org-wide "truth flip" actions (certify/decertify/deprecate, and versioning an already-certified metric) use the **Redis-backed dynamic-TTL confirm-token store** (`apps/mcp-server/src/lib/confirm-token-store.ts`, key prefix `mcp:confirm_token:`, 60s agent-to-agent TTL), the same class `CLAUDE.md` mandates for destructive MCP actions. Only versioning a still-`draft` metric uses the lighter inline-boolean pattern (`apps/mcp-server/src/tools/blip-tools.ts:155`).

### 2.6 Guardrails summary

- **agent_policies** (`0139_*`, enforced in `apps/mcp-server/src/lib/register-tool.ts:503`): every `basis.*` service-account call passes the §15 kill-switch + glob allowlist. **Operational note:** `basis.*` is **not** in the always-permitted core set (`get_server_info`, `get_me`, `agent_heartbeat`), so Basis tools fail closed until an operator adds `basis.*` (or specific tools) to each agent's allowlist. This is documented for operators and covered by a `register-tool` policy test for the new source.
- **Per-action permissions** (`@bigbluebam/permissions`, plugin pattern `apps/bench-api/src/plugins/permissions.ts`): full verb set in Section 4.4.
- **can_access preflight** on every cited driver, per requesting user, at read time (Section 2.3).
- **Correlation-not-causation guard**: narrative template requires hedged language; the two computations are never fused (Section 2.1).

---

## 3. Data model

All Basis tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id` exactly as `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Policies are advisory until `BBB_RLS_ENFORCE=1`. Each table gets a **1:1 Drizzle schema module** under `apps/basis-api/src/db/schema/` (`basis-metrics.ts`, `basis-metric-versions.ts`, `basis-metric-snapshots.ts`, `basis-explanations.ts`, `index.ts`), mirroring `apps/bench-api/src/db/schema/`, so `pnpm db:check` / `.github/workflows/db-drift.yml` stay green.

### 3.1 Tables

**`basis_metrics`** - one row per governed metric.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `slug` | varchar(80) NOT NULL | stable machine key, unique per org |
| `name` | varchar(160) NOT NULL | display name |
| `description` | text | plain-language definition for humans |
| `unit` | varchar(20) NOT NULL | `currency` \| `count` \| `percent` \| `ratio` \| `duration_ms` |
| `favorable_direction` | varchar(8) NOT NULL DEFAULT `'up'` | `up` \| `down` \| `neutral` |
| `owner_id` | uuid | FK `users(id)` ON DELETE SET NULL |
| `certification` | varchar(12) NOT NULL DEFAULT `'draft'` | `draft` \| `certified` \| `deprecated` |
| `current_version_id` | uuid | FK `basis_metric_versions(id)` |
| `target` | jsonb | optional `{ value, comparison }` for breach detection |
| `resolve_status` | varchar(12) NOT NULL DEFAULT `'ok'` | `ok` \| `resolve_failed`; set by the snapshot sweep when a definition no longer resolves against Bench (drift guard) |
| `resolve_failed_at` | timestamptz | when drift was last detected |
| `last_breach_at` | timestamptz | breach idempotency marker (mirrors `bond_deals.rotting_alerted_at`) |
| `last_breach_direction` | varchar(8) | direction of the last fired breach; cleared when value recovers so a breach fires once per crossing |
| `created_by` | uuid | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, slug)`, `(organization_id, certification)`, `(organization_id, owner_id)`.

**`basis_metric_versions`** - immutable, append-only definition lineage.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | denormalized for RLS |
| `version_number` | integer NOT NULL | monotonic per metric |
| `definition` | jsonb NOT NULL | `{ source_product, source_entity, measure: {field, agg}, filters, default_dimensions, time_column }`, **validated by the shared Bench `QueryConfig` schema** (`packages/shared/src/schemas/bench.ts`) so it cannot drift from what Bench executes |
| `lineage` | jsonb NOT NULL | descriptive `{ apps, base_table, joins }` from `data-source-registry.ts` at create time; **not executed** |
| `change_note` | text | |
| `created_by` | uuid | FK `users(id)` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (metric_id, version_number)`, `(organization_id, created_at DESC)`. Never updated or deleted.

**`basis_metric_snapshots`** - periodic captured values for **movement detection and sparklines only** (explanations do *not* read snapshots; they live-query periods A and B directly - see Section 2.1). **Monthly range-partitioned by `captured_at`** (mirroring `activity_log` and `blip_entries`), provisioned by a worker (Section 6) modeled on `apps/worker/src/jobs/blip-partition-provision.job.ts`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | part of composite PK with `captured_at` (partition key) |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_id` | uuid NOT NULL | FK `basis_metric_versions(id)`; the definition that produced the value |
| `captured_at` | timestamptz NOT NULL | partition key |
| `grain` | varchar(10) NOT NULL | `hour` \| `day` \| `week` \| `month` |
| `value` | numeric NOT NULL | scalar value |
| `dims` | jsonb | per-dimension breakdown, **captured only for additive measures** (nulled for ratio/percentile) |

**Idempotency (blocker fix):** `UNIQUE (metric_id, grain, captured_at, version_id)` and the snapshot job writes with `INSERT ... ON CONFLICT (metric_id, grain, captured_at, version_id) DO UPDATE`, so BullMQ retries and horizontally-scaled workers cannot double-write and corrupt downstream deltas. Indexes: `(metric_id, grain, captured_at DESC)`.

**`basis_explanations`** - cached **deterministic** contribution analyses. Stores no entity references (leak fix); concrete correlation is resolved per-user at read time.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK `basis_metrics(id)` ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_id` | uuid NOT NULL | FK `basis_metric_versions(id)`; part of cache identity |
| `cache_key` | varchar(64) NOT NULL | `hash(metric_id, version_id, period_a, period_b, dimension)` via `hashQueryConfig` (`apps/bench-api/src/services/cache.service.ts`) |
| `period_a` / `period_b` | jsonb NOT NULL | `{ start, end }` |
| `dimension` | varchar(80) | decomposition dimension |
| `delta_abs` / `delta_pct` | numeric | |
| `drivers` | jsonb NOT NULL | ranked `[{ dimension_value, label, contribution_abs, contribution_pct }]` - **dimension-value contributions only, no entities** |
| `narrative` | text | best-effort; nullable when the LLM leg failed |
| `model` | varchar(60) | provider/model used (auditability) |
| `computed_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (cache_key)` (correct cache identity; the prior `(metric_id, dimension)` index would have served a June answer to a July question), `(metric_id, computed_at DESC)`.

### 3.2 Cross-app additive change (Bench binding)

`bench_widgets` gains `basis_metric_id uuid NULL` (additive). When set, Bench resolves the metric via `GET /basis/api/v1/metrics/:id/resolve`, which returns both the query config **and the presentation envelope** (`display_name`, `unit`, `favorable_direction`, `target`); Bench **prefers these over its local `kpi_config`** so there is one certified presentation, not two. The Drizzle module `apps/bench-api/src/db/schema/bench-widgets.ts` is updated in the same change.

### 3.3 Reused platform tables (not created here)

- `entity_links` (`0132_entity_links.sql`): used **only** for optional human-curated "canonical driver" pins on a metric (`src_type='basis_metric'` -> `dst_type` = mapped entity type, `link_kind='references'`), written `ON CONFLICT DO NOTHING`. **Not** auto-written from per-user correlation (that would re-introduce the leak and is ephemeral).
- `v_activity_unified` (`0129_*`), `bolt_recent_events` / `bolt_event_trace`: read at request time for correlation.
- `organizations`, `users`.

### 3.4 Numbered, idempotent migration plan

Migration tip observed on this branch is `0225_bin_scan_override.sql`; the `permissions_seed_actions_delta` series tip is `0224_..._delta_019`. Basis appends from `0226`. All files follow `CLAUDE.md` conventions (filename regex, `-- Why:` / `-- Client impact:` header, `IF NOT EXISTS`, guarded enums via `DO $$ ... EXCEPTION WHEN duplicate_object`, guarded destructive ALTERs).

1. **`0226_basis_core.sql`** - `basis_metrics` (incl. `resolve_status`, `last_breach_*` markers) + `basis_metric_versions`, indexes, RLS policies. Client impact: additive only.
2. **`0227_basis_snapshots_explanations.sql`** - **partitioned** `basis_metric_snapshots` parent (RANGE on `captured_at`) with its `UNIQUE (metric_id, grain, captured_at, version_id)`, an initial month partition, and `basis_explanations` with `UNIQUE (cache_key)` + `version_id`; RLS on both. Client impact: additive only.
3. **`0228_bench_widget_metric_binding.sql`** - `ALTER TABLE bench_widgets ADD COLUMN IF NOT EXISTS basis_metric_id uuid;` + `CREATE INDEX IF NOT EXISTS idx_bench_widgets_basis_metric ...`. Client impact: additive only.
4. **`0229_permissions_seed_actions_delta_020.sql`** - **generated** by regenerating `docs/permissions-action-manifest.json` with the full `basis.*` verb set (Section 4.4); do not hand-write the SQL. Client impact: additive only.

Bolt event registration is a TypeScript edit to `apps/bolt-api/src/services/event-catalog.ts` (Section 7), not a migration.

---

## 4. API surface

Base path `/basis/api/`, Fastify routes under `/v1` (mirroring `apps/bench-api/src/server.ts:111-118`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler`. Cursor pagination, `?filter[field]=value`, `?sort=-field`. **All request/response shapes come from a shared Zod module `packages/shared/src/schemas/basis.ts`** (exported from `schemas/index.ts`, imported by both `basis-api` routes and the SPA), mirroring `packages/shared/src/schemas/bench.ts` per design decision #1.

### 4.1 The underlying-data access decision (promoted from Open Question to prerequisite)

The value/explain path depends on running Bench-governed queries server-to-server. **This is now a required prerequisite, not an open question**, because Bench's org isolation is *entirely* the `orgId` argument to `buildQuery` (there is no RLS on that read path), so a naive secret-guarded route that trusts a caller-supplied org would let any `INTERNAL_SERVICE_SECRET` holder read any org.

**Design (follows `apps/mcp-server/src/routes/tools-call.ts` and the satellite -> api `/internal/permissions/dual-read` pattern):**
- Land a new **internal query route on `bench-api`** guarded by `INTERNAL_SERVICE_SECRET`, that derives the org **from the caller's credential, not from a header**:
  - For **user-initiated** `/value` and `/explain`, Basis **forwards the caller's bearer token** to bench-api; org = `request.user.org_id` resolved from that token. Any `X-Org-Id` is advisory-only and must match, or the request is rejected.
  - For **background workers**, use a **locked `bbam_svc_` per-org service account**; org is derived from that token. A request whose asserted org is not derivable from the credential is rejected.
- `INTERNAL_SERVICE_SECRET` **must be non-empty** in every environment running Basis (platform default is empty, which correctly fails closed). Documented in Section 8 and `.env.example`.
- `bench-api` is added to `basis-api.depends_on` and to `needs` in the deploy catalog (Section 8).

### 4.2 REST endpoints

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/v1/metrics` | List metrics | `filter[certification]`, `filter[owner_id]`, `q`, cursor paginated; `requireAuth`, org from `request.user.org_id` |
| POST | `/v1/metrics` | Create metric (draft) + first version | emits `metric.created` |
| GET | `/v1/metrics/:id` | Get metric + current version | |
| PATCH | `/v1/metrics/:id` | Update metadata (name, owner, unit, direction, target) | non-definition fields only |
| POST | `/v1/metrics/:id/versions` | New definition version, set current | emits `metric.definition_changed` |
| GET | `/v1/metrics/:id/versions` | Version history / lineage audit | |
| POST | `/v1/metrics/:id/certify` | Flip to `certified` | perm `basis.metric.certify`; emits `metric.certified` |
| POST | `/v1/metrics/:id/decertify` | Flip to `draft` | emits `metric.decertified` |
| DELETE | `/v1/metrics/:id` | Deprecate (soft) | emits `metric.deprecated`; destructive-confirm on MCP |
| GET | `/v1/metrics/:id/resolve` | **Binding contract**: query config **plus presentation envelope** | `requireAuth`, org from `request.user.org_id`; Bench forwards its caller's token/service-cred |
| GET | `/v1/metrics/:id/value` | Single current value for a period | forwards caller token to bench-api internal query route |
| POST | `/v1/metrics/:id/explain` | Contribution analysis `{period_a, period_b, dimension?}` | returns cached deterministic row + **live per-user correlation**; large ranges offloaded to `basis-explain` queue returning `{ status:'computing', job_id }` |
| GET | `/v1/metrics/:id/explanations` | List cached deterministic analyses | correlation re-resolved per-user on open |
| GET | `/v1/metrics/:id/snapshots` | Movement history / sparkline data | |
| GET | `/v1/metrics/:id/lineage` | Upstream apps/tables (descriptive) | |
| GET | `/v1/data-sources` | Pass-through of Bench's data-source catalog | `requireAuth`, org-scoped; used by the definition builder |
| GET | `/health` / `/readyz` | Liveness/readiness | `@bigbluebam/service-health`; **`/readyz` checks only Postgres + Redis, never bench-api/LLM/Qdrant** (Section 8.4) |

### 4.3 Realtime (`/basis/ws`)

Lightweight WebSocket, cross-instance via Redis PubSub (`CLAUDE.md` "WebSocket realtime"). Org-scoped rooms. Broadcasts `metric.certified` / `metric.definition_changed` (badge live-update) and `explanation.ready` (queued explain finished; UI renders the deterministic bars even if `narrative` is null). Notification channel only; no Yjs.

### 4.4 Permissions (expanded per review)

Manifest-generated in `docs/permissions-action-manifest.json`, `app.resource.verb` form: `basis.metric.read`, `basis.metric.define`, `basis.metric.version`, `basis.metric.certify`, `basis.metric.decertify`, `basis.metric.deprecate`, `basis.metric.update`, `basis.explain.run`, `basis.datasource.read`. Regenerating the catalog produces `0229_permissions_seed_actions_delta_020.sql`.

### 4.5 MCP tools

New `apps/mcp-server/src/tools/basis-tools.ts` using `registerTool` (`apps/mcp-server/src/lib/register-tool.ts:488`), HTTP client shaped like `apps/mcp-server/src/tools/bench-tools.ts:9`. Env `BASIS_API_URL=http://basis-api:4019/v1`.

| Tool | Backs | Autonomy |
| --- | --- | --- |
| `basis_list_metrics` / `basis_search_metrics` | GET `/metrics` | read |
| `basis_get_metric` | GET `/metrics/:id` | read |
| `basis_metric_value` | GET `/metrics/:id/value` | read |
| `basis_metric_lineage` | GET `/metrics/:id/lineage` | read |
| `basis_explain_change` | POST `/metrics/:id/explain` | read, per-caller `can_access` (flagship) |
| `basis_rank_drivers` | POST `/metrics/:id/explain` (drivers only) | read |
| `basis_define_metric` | POST `/metrics` | write, draft only, policy-gated |
| `basis_add_metric_version` | POST `/metrics/:id/versions` | inline `confirm_action` (draft) / Redis token (certified) |
| `basis_certify_metric` / `basis_decertify_metric` | POST certify/decertify | Redis-backed confirm token |
| `basis_deprecate_metric` | DELETE `/metrics/:id` | destructive, Redis-backed confirm token |

**Endpoints intentionally with no tool** (record in `docs/reference/mcp-endpoint-mapping.md`, keep coverage counts in sync, run the zero-bare-dash grep):
- `GET /metrics/:id/resolve` - _(skip: internal service-to-service binding contract for Bench)_
- `GET /metrics/:id/snapshots|versions|explanations` - _(skip: folded into `basis_get_metric` / `basis_explain_change`)_
- `GET /data-sources` - _(skip: Bench already exposes `bench_list_data_sources`)_
- `PATCH /metrics/:id` - _(skip: metadata edit deferred; definition changes go through `basis_add_metric_version`)_
- `/basis/ws`, `/health`, `/readyz` - _(skip: realtime/probe)_

Also register a Basis provider in `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`) so certified metrics surface in cross-app search with `can_access`-aware scoring.

---

## 5. Frontend

`apps/basis/` React SPA served at `/basis/`, modeled on `apps/bench/` (`app.tsx`, `main.tsx`, `pages/`, `hooks/`, `stores/auth.store.ts`, `lib/api.ts`). **TanStack Query v5** for server state (per-resource hooks like `apps/bench/src/hooks/use-widgets.ts`), **Zustand** for auth (`apps/bench/src/stores/auth.store.ts`), components from **`@bigbluebam/ui`**, request/response types from `packages/shared/src/schemas/basis.ts`.

### Pages

1. **Metric Catalog** (`pages/metric-list.tsx`) - searchable table with certification badges, owner avatars, unit, last-movement sparkline, and a `resolve_status='resolve_failed'` warning badge for drifted definitions.
2. **Metric Detail** (`pages/metric-detail.tsx`) - definition, lineage panel, current value, movement sparkline, version history, permission-gated certify/decertify/deprecate.
3. **Definition Builder** (`pages/definition-builder.tsx`) - **build-time reuse commitment (scope-creep fix):** the query-form (data source -> measure/agg/filters) is **extracted from Bench's widget wizard into a shared component** consumed by both apps, and "Preview value" **POSTs the draft to bench-api for validation** rather than Basis re-implementing preview. Basis adds only governance fields (owner, unit, direction, target) around that shared form.
4. **Why-Did-It-Change Explorer** (`pages/explain.tsx`) - metric + two periods + optional dimension; renders ranked contribution bars, the "possibly related activity" list (separate, per-user filtered), and drill-down links the SPA attaches from structured drivers (never from model-emitted markup). Live-updates via `/basis/ws` `explanation.ready`; shows "summary unavailable" when `narrative` is null.
5. **Settings** (`pages/settings.tsx`) - owners/stewards, default decomposition dimensions, explanation cache TTL, snapshot retention window.

**Chart-scope discipline.** Basis renders only minimal explanatory visuals (ranked horizontal contribution bars, a value sparkline) with `@bigbluebam/ui` primitives - no charting library, no dashboards. Rich visualization stays in Bench.

---

## 6. Background work

New BullMQ workers in `apps/worker`, following the queue-plus-repeatable convention in `apps/worker/src/worker.ts` (`{ pattern: '<cron>' }`). All fan-out jobs use `bbam_svc_` per-org service accounts (Section 4.1), set `app.current_org_id` per org, wrap each `(org, metric)` in **try/catch log-and-continue with per-item error isolation**, are **resumable** (a mid-tick failure never re-writes already-captured items - the snapshot `ON CONFLICT` makes re-runs safe), and emit **progress logging** via `@bigbluebam/logging` (start line with elapsed, per-N progress, a completion line with duration, and a line *before* the LLM call), per the house rule. Job options set `removeOnComplete`/`removeOnFail` and keep payloads to refs (not materialized driver sets) given the shared 256MB noeviction Redis.

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `basis-partition-provision` | daily | Pre-creates next month's `basis_metric_snapshots` partition (mirrors `apps/worker/src/jobs/blip-partition-provision.job.ts`). |
| `basis-metric-snapshot` | hourly (`0 * * * *`) + daily `day`-grain pass | Resolve + execute each certified metric via the Bench internal query route; `INSERT ON CONFLICT` into `basis_metric_snapshots`. On bench 5xx: **skip-and-reschedule** that item; on a definition that no longer resolves: set `basis_metrics.resolve_status='resolve_failed'` and continue (no abort). A per-org concurrency cap bounds the fan-out. |
| `basis-explain` | on-demand queue | Two phases: (1) run the **deterministic** decomposition (Bench queries) and persist the `basis_explanations` row immediately (`ON CONFLICT (cache_key) DO UPDATE`), emit `explanation.ready`; (2) attempt the narrative with a **bounded LLM timeout** - on failure leave `narrative=null` and enqueue a cheap **narrative-only retry** that re-runs no Bench queries. **Job id = the `cache_key` hash** so concurrent identical "why" requests dedupe onto one job. |
| `basis-movement-scan` | daily (`30 4 * * *`) | Compare only snapshots **sharing the same `version_id`** (a `metric.definition_changed` re-baselines, never masquerades as movement). Fire `metric.threshold_breached` **once per crossing** using the `last_breach_*` marker (cleared on recovery). Emitted payload carries **metric + magnitude only, never concrete driver entities** (no asker context here). Per-org call ceiling on any LLM use. |
| `basis-retention-sweep` | daily | Roll `hour`-grain snapshots up to `day` grain, drop snapshot partitions older than the retention window (settings knob), and age out expired `basis_explanations` (mirrors `apps/worker/src/jobs/blip-retention-sweep.job.ts`). |

---

## 7. Events & integration

### 7.1 Bolt events published (source `basis`)

Via `publishBoltEvent(eventType, 'basis', payload, orgId, actorId?, actorType?)` (`packages/shared/src/bolt-events.ts:35`), bare event names. Each is registered with a `payload_schema` in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI. The guard also scans the worker emit site for `metric.threshold_breached`.

| `event_type` | Fired when | Key payload |
| --- | --- | --- |
| `metric.created` | metric defined | `metric.id/slug/name`, `actor.*`, `org.*` |
| `metric.definition_changed` | new version becomes current | `metric.id`, `version.number`, `version.change_note` |
| `metric.certified` | flips to certified | `metric.id/slug`, `actor.*` |
| `metric.decertified` | flips to draft | `metric.id`, `actor.*` |
| `metric.deprecated` | soft-deprecated | `metric.id`, `actor.*` |
| `metric.threshold_breached` | movement scan detects breach | `metric.id`, `delta_abs`, `delta_pct`, `direction` - **magnitude only, no driver entities** |

### 7.2 entity_links

Only optional human-curated metric-to-driver pins (`src_type='basis_metric'`), `ON CONFLICT DO NOTHING`. No automatic per-user correlation links (leak-safe).

### 7.3 Unified activity & cross-app search

Register a Basis provider in `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`); when Qdrant is down, cross-app search degrades to keyword-only. Basis catalog changes flow as Bolt events (consumed by Bolt), not into the fixed `v_activity_unified` UNION in v1; extending that view is optional future work. Correlation *reads* `v_activity_unified`; it never writes to it.

---

## 8. Infrastructure

### 8.1 New api compose service

`basis-api` in `docker-compose.yml`, modeled on the `bench-api` block: `PORT: 4019`, stateless, horizontally scalable. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`), and **`bench-api` (`service_healthy`)** since the value/explain path calls its internal query route. Env: `DATABASE_URL`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, **`INTERNAL_SERVICE_SECRET` (must be non-empty)**, `BBB_API_INTERNAL_URL=http://api:4000` (for the internal llm-provider route), `BENCH_API_INTERNAL_URL=http://bench-api:4011`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `CORS_ORIGIN`, rate-limit + query-timeout + LLM-timeout knobs. Healthcheck: `curl -sf http://localhost:4019/health`.

### 8.2 SPA build (blocker fix - the SPA is not its own service)

Every SPA is built inside the single `apps/frontend/Dockerfile` multi-stage build and `COPY`'d into `/usr/share/nginx/html/<app>`. Basis edits `apps/frontend/Dockerfile` in **four places mirroring the blip lines**: (1) deps `COPY` of `apps/basis`, (2) build-stage `COPY`, (3) add `pnpm --filter @bigbluebam/basis build` to the build `RUN`, (4) production `COPY` of `apps/basis/dist` -> `html/basis`. Add `basis` to the static-asset cache regex in `infra/nginx/nginx.conf`. There is **no** separate `basis` compose service.

### 8.3 nginx routing

Add to `infra/nginx/nginx.conf`, mirroring the bench block (`nginx.conf:280-296`): `/basis/` alias with SPA fallback, `/basis/api/` -> `http://basis-api:4019/`, `/basis/ws` with upgrade headers. **Blocker fix:** because nginx resolves literal upstreams at load and crashloops on host-not-found (taking the whole ingress down), add **`basis-api` (`condition: service_healthy`) to the `frontend` service `depends_on`** in `docker-compose.yml`. Hand-add the same three routes to `nginx.railway.conf` (static file, not generated).

### 8.4 Deploy catalog, MCP wiring, dependencies, health

- `scripts/deploy/shared/services.mjs`: add a `basis-api` `APP_SERVICES` block (port `4019`, `public_paths: ['/basis/api/','/basis/ws']`, `needs: ['postgres','redis','api','bench-api']`), add `/basis/` to the `frontend` entry's `public_paths` and `basis-api` to its `needs`, and add `basis-api` to `mcp-server.needs` + `depends_on`.
- Add `BASIS_API_URL: http://basis-api:4019/v1` to `mcp-server` env in compose and catalog; register `basis-tools.ts` in the MCP bootstrap.
- **Runtime-dependency posture (stability fix):** `/readyz` checks **only Postgres and Redis** - not bench-api, the LLM, or Qdrant - so a Bench outage never cascades into a Basis "not ready." The Bench query client uses a short timeout and a circuit breaker returning a typed `UPSTREAM_UNAVAILABLE` error; the snapshot sweep skips-and-reschedules on bench 5xx; the narrative is best-effort (drivers render with `narrative=null` on LLM failure); Qdrant-down degrades search to keyword-only. Section 8.1's `depends_on: bench-api` governs *startup ordering*, not liveness.
- Stateful dependencies are Postgres and Redis only; Basis reaches source data and the LLM through other services at request time (those are runtime dependencies, handled by timeouts/circuit-breaking above, not `/readyz`). New Basis queues share the 256MB noeviction Redis, so payloads stay small and jobs set `removeOnComplete`/`removeOnFail`.

---

## 9. Reuse ledger

| Capability | Reuses (real file/package) | Genuinely new in Basis |
| --- | --- | --- |
| Underlying query / SQL gen / org isolation | `apps/bench-api/src/services/query.service.ts`, `data-source-registry.ts` (+ new internal query route) | Metric-to-query resolution; token-forwarding; no SQL building |
| Saved query prior art | `apps/bench-api/src/db/schema/bench-saved-queries.ts` | Governance/versioning/presentation layer on top |
| Chart/dashboard rendering | `apps/bench/` + new `bench_widgets.basis_metric_id` | One binding column + `/resolve` envelope |
| Shared query/type shape | `packages/shared/src/schemas/bench.ts` (`QueryConfig`) | `packages/shared/src/schemas/basis.ts` |
| Bolt events | `@bigbluebam/shared` `publishBoltEvent`; catalog + `check-bolt-catalog.mjs` | 6 `metric.*` definitions |
| Event correlation | `v_activity_unified` (`0129_*`), `bolt_recent_events`/`bolt_event_trace` | Two-computation decomposition + labeled correlation |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts` (dotted `SUPPORTED_ENTITY_TYPES`), `can_access` | Per-user read-time filtering; type mapping |
| Cross-app linking | `entity_links` (`0132_*`) | Human-pinned metric drivers only |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` | Basis search provider |
| RLS / org scoping | `app.current_org_id` GUC (`0116_*`, `0132_*:52-56`) | Basis table policies |
| Per-action permissions | `@bigbluebam/permissions`, `apps/bench-api/src/plugins/permissions.ts` | 9 `basis.*` actions |
| MCP registration + policy gate + Redis confirm token | `register-tool.ts:488`, `confirm-token-store.ts`, blip inline pattern | 12 `basis_*` handlers |
| Internal service-to-service auth | `apps/mcp-server/src/routes/tools-call.ts` (bearer-derived org) | Bench query-route integration |
| LLM narrative | `apps/api/src/routes/internal-llm.routes.ts`, `llm-provider.service.ts` | Opaque-token prompt + hedging + timeout |
| Fastify skeleton / health / logging | `apps/bench-api/src/server.ts`, `@bigbluebam/service-health`, `@bigbluebam/logging` | Config + routes |
| Snapshot idempotency | `apps/worker/src/jobs/bearing-snapshot.job.ts` | Applying `ON CONFLICT` to metric snapshots |
| Partitioning + retention | `blip-partition-provision.job.ts`, `blip-retention-sweep.job.ts` | Basis provisioning/sweep |
| Background jobs | `apps/worker/src/worker.ts` | 5 `basis-*` jobs |
| SPA scaffold | `apps/bench/src/` + extracted shared query-form | 5 Basis pages |

### Test posture (per review)

- `basis-api` unit tests assert the **decomposition invariant** `sum(contributions) == delta_abs` for additive measures, and the **ratio/percentile directional fallback** (labeled non-exact).
- A `packages/shared` test covering `basis.ts` schemas.
- A `register-tool` policy test confirming `basis.*` tools fail closed until allowlisted.
- Confirm the 6 events pass `scripts/check-bolt-catalog.mjs`; confirm `pnpm db:check` is clean against the 4 new Drizzle modules.

---

## 10. Open questions & risks

1. **Ratio / average / percentile decomposition is directional, not exact.** Exact additive decomposition holds only for `sum`/`count`. Rates/averages need mix-vs-rate decomposition; percentiles cannot be summed. v1 ships exact additive decomposition and labels ratio/percentile explanations "directional." Needs sign-off.
2. **Dimension-label coverage.** v1 restricts decomposition to self-labeling columns or dimensions with a registered resolver (Section 2.2). Which resolvers ship in v1 (stage, owner, pipeline?) is a scoping call.
3. **Per-driver entity attribution.** Deferred; requires a governed bounded "top contributing rows" query reconciled to the aggregate delta before any entity-level attribution is asserted.
4. **Bench internal query route.** Now a prerequisite (Section 4.1), but it is an out-of-Basis change to `bench-api` that must land first and be owned by the Bench maintainers.
5. **Metric-vs-saved-query consolidation.** Whether a Basis metric should eventually *wrap* a `bench_saved_queries.id` rather than embed a definition (Section 1). v1 embeds (typed from shared schema); revisit once both stabilize.
6. **`/resolve` precedence rollout.** Bench must be updated to prefer the Basis presentation envelope over local `kpi_config` when `basis_metric_id` is set; until Bench ships that, bound widgets still read local config. Coordinate the two changes.
7. **Certification governance.** Default gate is `basis.metric.certify` (org admin/owner). Whether a permissioned service account may ever certify without a human is a policy question.
8. **Snapshot cost at scale.** O(orgs x certified-metrics x buckets) Bench round-trips; bounded by per-org concurrency caps + retention rollup, but large tenants need a capacity review before enabling hourly grain by default.
9. **Correlation is not causation.** Mitigated by fencing the two computations, hedged language, and per-user filtering; never let an agent treat an explanation as ground truth for an autonomous write.
10. **`v_activity_unified` extension** for Basis catalog changes is deferred (fixed UNION; platform-wide change).

---

## Changelog

Round 1 (adversarial review). Findings addressed:

**Blockers - all accepted:**
- [security+design, converged] Cached-explanation cross-user leak: **accepted.** `basis_explanations` now stores only deterministic aggregate decomposition (no entity refs); concrete correlation is resolved and `can_access`-filtered per requesting user at read time (§2.1, §2.3, §3.1).
- [security] Bench query org-bypass: **accepted.** Org is now derived from the caller's credential, not a header - user requests forward the bearer token, workers use per-org `bbam_svc_` accounts, `X-Org-Id` advisory-only, following `tools-call.ts` (§4.1).
- [security] Worker precompute leaks concrete drivers: **accepted.** Workers precompute aggregate-only; all entity-level correlation is deferred to per-user read time; `threshold_breached` carries magnitude only (§2.3, §6, §7.1).
- [stability] Snapshot idempotency: **accepted.** `UNIQUE (metric_id, grain, captured_at, version_id)` + `INSERT ON CONFLICT DO UPDATE` (§3.1).
- [infrastructure] SPA not a separate service: **accepted.** Four `apps/frontend/Dockerfile` edits + nginx static-asset regex; removed the phantom `basis` compose service (§8.2).
- [infrastructure] nginx upstream crashloop: **accepted.** `basis-api` added to `frontend.depends_on` (service_healthy) + `services.mjs` (§8.3, §8.4).
- [infrastructure] Bench route non-existent / secret fails closed: **accepted.** Promoted to a required prerequisite; internal bench route guarded by non-empty `INTERNAL_SERVICE_SECRET`; `bench-api` added to `basis-api.depends_on` and `needs` (§4.1, §8).

**Majors:**
- [design+security, converged] Entity_type namespace: **accepted.** Use dotted `VisibilityEntityType` (`bond.deal`, etc.); map + fail-closed; keep `entity_links.dst_type` separate (§2.3).
- [design] Fused causal figure: **accepted.** Drivers = dimension-value contributions only; correlation is a separate "possibly related activity" list; flagship example reworded (§2.1).
- [design] `bench_saved_queries` adjacency: **accepted.** Added to positioning + reuse ledger; definition typed from shared `bench.ts` `QueryConfig` (§1, §3.1, §9).
- [design] `/resolve` presentation envelope: **accepted.** Returns unit/direction/target/display name; Bench precedence specified (§3.2, §4.2).
- [design] Narrative labels from UUIDs: **accepted.** Self-labeling-or-resolver dimension allowlist; `lineage.joins` marked non-executing (§2.2).
- [design+stability, converged] Cache identity + async idempotency: **accepted.** `cache_key = hash(metric_id, version_id, period_a, period_b, dimension)`, `version_id` added, `UNIQUE (cache_key)`, BullMQ job id = cache_key, upsert, links `ON CONFLICT DO NOTHING` (§3.1, §6).
- [security] LLM injection/PII: **accepted.** Opaque `DRIVER_n` tokens, internal-only llm-provider, plain-text output (§2.4).
- [security] Confirm-token class: **accepted.** Redis-backed dynamic-TTL tokens for certify/decertify/deprecate + versioning a certified metric; inline-boolean only for draft versioning (§2.5).
- [stability+infrastructure, converged] Snapshot/explanation retention: **accepted.** Monthly partitioning + `basis-partition-provision` + `basis-retention-sweep`; retention knob (§3.1, §6).
- [stability] LLM degradation: **accepted.** Deterministic phase persisted first, bounded narrative timeout, `narrative=null` + `explanation.ready` on failure, cheap narrative-only retry (§6).
- [stability] Movement-scan version-mixing + breach storm: **accepted.** Compare same `version_id` only; `last_breach_*` once-per-crossing marker (§3.1, §6).
- [stability] Sweep error isolation: **accepted.** Per-item try/catch, `resolve_failed` marker, resumable (§6).
- [stability] Runtime-dependency posture: **accepted.** `/readyz` = Postgres+Redis only; Bench circuit-breaker `UPSTREAM_UNAVAILABLE`; skip-and-reschedule; Qdrant-down keyword-only (§8.4). Corrected the earlier "only deps are Postgres/Redis" wording.
- [best-practices] Shared Zod module: **accepted.** `packages/shared/src/schemas/basis.ts` (§4, §5).
- [best-practices] Drizzle modules: **accepted.** 4 modules + index, 1:1 with migrations (§3).
- [best-practices] Test posture: **accepted.** Decomposition-invariant, fallback, schema, policy, and catalog tests (§9).
- [best-practices] Permissions expansion: **accepted.** 9 `basis.*` actions, manifest-generated `0229_..._delta_020` (§4.4, §3.4).
- [infrastructure] LLM path/timeout/degradation/ceiling: **accepted.** Internal llm-provider via `BBB_API_INTERNAL_URL`+`INTERNAL_SERVICE_SECRET`, bounded timeout, best-effort, per-org ceiling + concurrency cap (§2.4, §6, §8.1).
- [infrastructure] Railway/catalog wiring: **accepted.** Enumerated `services.mjs`, `mcp-server` needs/depends_on/env, `nginx.railway.conf`, `BASIS_API_URL` (§8.4).

**Minors - all accepted:** snapshot-vs-explain purpose reworded and dims gated to additive (§3.1); Definition Builder extracts Bench's shared query-form + POSTs to bench-api for preview (§5); `/resolve` and `/data-sources` behind `requireAuth`, org from `request.user.org_id` (§4.2); `basis.*` not in always-permitted core documented + policy test (§2.6, §9); progress logging in fan-out jobs (§6); surface-map counts/CLI/zero-bare-dash self-check (§4.5); 6 events registered with payload_schema + guard scans worker emit site (§7.1); shared-Redis payload discipline + removeOnComplete/removeOnFail (§6, §8.4).

**Rejected:** none. Every finding was accepted or accepted-with-modification. Accept-with-modification of note: the entity-type finding suggested mapping `bond_deal`->`bond.deal`; I kept `entity_links.dst_type` on its own convention and map it to the visibility type at the boundary rather than changing either subsystem's native vocabulary. The cache-idempotency finding's suggestion to write `entity_links` from correlation was narrowed to human-pinned links only, because auto-writing per-user correlation links would reintroduce the leak the first blocker fixes.
