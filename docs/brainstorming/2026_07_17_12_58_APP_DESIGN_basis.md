# Basis - App Design Specification

> Governed metric layer for BigBlueBam. One trusted definition per number, and an AI core that explains why it moved.
>
> Status: design draft, revised after adversarial review rounds 1, 2, and 3. New app.
> Chosen internal port: **4019** (first free port after Blip's 4018; 4015 is shared by blueprint/bureau).
> Routes: SPA at `/basis/`, REST at `/basis/api/`, realtime at `/basis/ws`.

---

## 1. Overview & positioning

**One-liner.** Basis is a governed *semantic layer*: each business metric is defined once (revenue = Bill paid invoices minus refunds; pipeline = Bond open deals by stage), certified by an owner, and read by every app, chart, and agent from the same definition. When a certified metric moves, Basis decomposes the delta across dimensions (the certified, shared answer) and, as a separate per-viewer aid, surfaces concrete cross-app activity that may have contributed.

**Customer wedge.** Trust plus speed. Today an SMB gets three different "revenue" numbers from Bench, Bond, and Bill and nobody can say why a KPI moved without an afternoon of pivot-table archaeology. Basis gives one definition of truth and instant root-cause, a capability that only enterprise BI tools (Looker's LookML, dbt Semantic Layer, Cube) ship today and that no team of 2-50 can afford or staff. The "one trusted number" promise applies to the **certified top-line value and its total delta**, which stay exact and org-shared. Its **per-entity breakdown** is access-scoped: for entity-keyed (Class-B) decompositions a viewer missing access to some entities gets a deliberately non-invertible breakdown (k-anonymous suppression, Section 2.2) that may not fully reconcile to the exact total - the number is shared, the breakdown is per-viewer. The possibly-related-activity aid is likewise per-viewer and access-scoped (Section 2.1), ranked below the certified drivers so the two are never confused.

**How it sits adjacent to existing apps (not on top of them).**
- Basis does **not** render charts or own dashboards. Bench does (`apps/bench/src/components/widgets/chart-renderer.tsx`, `apps/bench-api/`). Basis produces *definitions and explanations*; Bench *displays* them.
- Basis does **not** own the underlying source data. It defines metrics *over* data that already lives in Bond, Bill, Bam, Blast, etc., and reaches that data through Bench's existing governed query builder (`apps/bench-api/src/services/query.service.ts`, `apps/bench-api/src/lib/data-source-registry.ts`).
- Basis does **not** do external-source ETL or warehousing in v1.

**Relationship to Bench `bench_saved_queries` (adjacency).** `apps/bench-api/src/db/schema/bench-saved-queries.ts` is already a named, org-scoped saved query - structurally a metric definition *minus governance*. Basis is deliberately **not** just a certified saved query: governance is first-class (owner, certification state, immutable version lineage, Bolt events on change); a metric has a stable `slug` identity independent of any one saved query; and a metric carries presentation governance (unit, direction, target) a saved query does not.

**Metric definition shape and the drift guard (corrected in round 2).** The Bench *shared* schema is `benchQueryConfigSchema` / type `BenchQueryConfig` (`packages/shared/src/schemas/bench.ts`: `source`, `fields[]`, `filters[]`, `group_by[]`, `order_by[]`, `limit`). That widget schema **cannot express the additive decomposition** Basis needs (it has no per-measure aggregation), and it is a *different* shape from what Bench's executor actually consumes (`buildQuery` in `query.service.ts` takes `measures: QueryMeasure[]` with a per-measure `agg`, plus `dimensions`). Therefore, for v1: **`packages/shared/src/schemas/basis.ts` owns the Basis definition shape** (`{ source_product, source_entity, measure: { field, agg }, filters, default_dimensions, time_column }`), which is convertible to the executor's `QueryConfig`. The authoritative anti-drift mechanism is **round-trip validation**: the Definition Builder and `/versions` POST send the draft to bench-api's preview/validate route, and a definition that no longer resolves is flagged (Section 3.1, `resolve_status`). Earlier drafts wrongly claimed the shared `QueryConfig` validates this; that identifier does not exist and is removed throughout. The durable follow-up (Open Question) is to promote Bench's *executor* contract (`QueryMeasure`/`dimensions`) into `packages/shared` so both apps import one type; only then does "cannot drift" become literally true.

**Positioning against Bench widgets.** Bench answers "show me a chart of X." Basis answers "what *is* X, who owns it, is it certified, and why did it change." A Bench widget binds to a Basis metric so the KPI labeled "MRR" everywhere resolves to one certified definition and one certified presentation envelope.

**Chosen final name:** **Basis** (single word). Baseline and Bedrock considered and rejected.

**Out of v1 scope (future consumers):** **Bellwether** (forecasting) and **Benchmark** (peer comparison) would consume Basis certified metrics. Named only so the model leaves room; neither is built in v1.

---

## 2. AI-native design

Basis's AI core is **deterministic contribution analysis with a best-effort LLM-phrased narrative of the drivers**. The math is reproducible and auditable; the LLM only phrases the *driver* decomposition and never touches per-viewer correlation.

### 2.1 Two independent computations, structurally separated (never one fused sentence)

Bench's `executeQuery` returns **grouped aggregates only, never row-level entity IDs**, and concrete entities come only from a per-viewer time-window activity correlation that can disagree with the delta. So Basis keeps two computations in different trust and caching planes:

1. **Deterministic dimensional decomposition (the certified, shared answer).** For an additive measure (`sum`/`count`), re-run the metric grouped by the resolved decomposition dimension for both periods; each dimension value's contribution is `value_B(g) - value_A(g)`, and `sum(contributions) == delta_abs` exactly. Drivers are **dimension-value contributions**, not entities. This result is org-shared and cached (Section 3.1), and its narrative is generated by the LLM from **opaque driver tokens** (Section 2.4).
2. **Possibly-related activity (a per-viewer aid, ranked below the drivers).** A separate list assembled **at read time, per requesting user**, from `v_activity_unified` and `bolt_recent_events`, mapped to typed entities and `can_access`-filtered (Section 2.3). It is never cached in a shared row, never fed to the LLM, and never merged into the deterministic delta or its narrative.

**Consequence for the flagship (reconciled in round 2).** The output is rendered as **two visibly separate pieces**, not one sentence:
- *Certified driver narrative (shared, cached):* "MRR fell 8% ($4.1k). Largest contributions to the decline: Enterprise segment -$3.2k, Overdue bucket -$0.9k."
- *Possibly related activity (per viewer, access-scoped, assembled at read time):* "3 Bond deals left the Won stage; 2 Bill invoices became overdue" - shown only for entities this viewer can access.

An implementer must never put per-viewer correlation counts into the shared `narrative` column; doing so re-opens the leak the round-1 fix closed.

**Correlation coverage caveat (round 3).** `bill.invoice` **is** in `SUPPORTED_ENTITY_TYPES` (`apps/api/src/services/visibility.service.ts:81`), so the Bill example is a legitimate, `can_access`-checkable correlation candidate and is kept. The only residual is that **Bill is not in `v_activity_unified`** (which UNIONs bam/bond/helpdesk only), so Bill-sourced correlation must come from `bolt_recent_events` - i.e. it depends on Bill emitting typed `invoice.*` Bolt events. The same holds for any app absent from `v_activity_unified` (Open Question 10).

**Invariant (record and rely on):** `/explain` **never reads `basis_metric_snapshots`**; it live-queries periods A and B directly. Snapshots exist only for movement detection and sparklines. This invariant is what lets retention safely delete snapshot rows without corrupting an in-flight explain (Section 6).

### 2.2 Decomposition-dimension classification (round-2 leak fix + label + cache-key rules)

A decomposition dimension is one of two classes, decided at **resolver-registration time**:

- **Class A - a CURATED allowlist of bounded org-global ENUM columns** (`status`, `stage`, `lifecycle_stage`, `level`, plus explicitly-enumerated MV *enum* columns). Class A is **not** inferred from "the value isn't a UUID" - it is a hand-maintained allowlist. Values are not per-user-restricted, so driver rows may be **shared-cached with concrete labels and amounts**.
- **Class B - entity-derived dimension** (`owner_id`, `company_id`, `project_id`, `stage_id`, and **any column that is the display/label form of a `SUPPORTED_ENTITY_TYPES` entity**, e.g. a materialized `company_name`/`owner_name`). Class B is keyed on the underlying *entity*, not on whether the stored value is a UUID: **a label column joined from a restricted entity is Class B**, stored as the opaque entity FK and re-resolved per user. (This closes the round-3 hole where an MV `company_name` column would have sailed into Class A carrying a per-entity-restricted name.)

**Invariant:** any column that is the display form of a Class-B entity MUST register Class B. A **registration-time test** asserts that a label column joined from a restricted entity cannot register Class A.

**Class-B amount leak fix (round-3 blocker).** For Class B, the sensitive payload is the **per-entity contribution amount**, not just the label. So the **shared** cache for a Class-B decomposition carries **neither a per-driver narrative nor per-entity amounts**. Concretely:
- The shared `basis_explanations` row for a Class-B dimension stores drivers as `{ dimension_value (opaque uuid), contribution_abs, contribution_pct }` **only as an intermediate that is never served raw**, and its `narrative` is **null** (no Class-B prose is ever LLM-generated over org-wide entity amounts).
- At **read time, per requesting user**, denied entities are removed entirely - label **and** `contribution_abs`/`contribution_pct` - and folded into an aggregated **"Other (N hidden)"** bucket. But drop-the-whole-row alone is **not sufficient**, because the shared row also serves the exact certified `delta_abs`, and by the certified invariant `sum(contributions) == delta_abs` a viewer can back out a hidden cell by subtraction: `residual = delta_abs - sum(allowed rows)`. When exactly **one** entity is suppressed (the common case), that residual *is* its exact magnitude - regardless of whether "Other" prints a number. This is a **complementary-disclosure / small-cell** problem, and it is a category error to "mirror the correlation path" here (correlation has no exact-sum-to-a-public-total invariant, so drop-the-row is safe *there* but not *here*).
- **k-anonymous secondary suppression (the actual fix).** The hidden aggregate must cover **at least k >= 2 entities**. When exactly one entity would be suppressed for a viewer, fold an **additional** allowed driver (the smallest-magnitude allowed row) into "Other" so `N_hidden >= 2` and no individual is arithmetically back-outable. Equivalently, **do not serve an exact per-decomposition "Other" amount alongside the exact `delta_abs` whenever any cell is suppressed for that viewer** - the *combination* is what leaks. Any Class-B prose the UI shows is generated per-user over only the fully-allowed drivers.

**Honest tension (one trusted number vs per-viewer breakdown).** k-anonymous suppression means a restricted viewer's Class-B breakdown may **not visibly reconcile to the exact certified `delta_abs`** - some of the delta sits in "Other" precisely so it cannot be solved for. This is the correct tradeoff and the boundary the wedge (Section 1) draws: the certified **number** stays exact and org-shared, but its per-entity **breakdown** is access-scoped and deliberately non-invertible. A viewer who can access every driver sees a fully-reconciling breakdown; a viewer missing access sees an intentionally lossy one.

`lineage.joins` is descriptive metadata only and does **not** participate in query execution. A dimension that is neither Class A nor a registered Class B resolver is not offered for decomposition; requesting it returns a typed `DIMENSION_NOT_ALLOWED` error rather than silently degrading.

**Effective-dimension resolution and cache identity.** `/explain` makes `dimension` optional. The **effective** dimension is resolved server-side *before* hashing, with a single precedence: **request `dimension` > metric `default_dimensions[0]` > org Settings default**. The cache key hashes the **resolved** dimension (never null/raw request), so a default change does not serve stale rows and two resolved dimensions cannot collide on a null-keyed row. An out-of-allowlist dimension is rejected with `DIMENSION_NOT_ALLOWED`.

### 2.3 Per-user visibility, and the correlation-to-entity mapping (round-2)

Correlated activity and Class-B driver labels are resolved live per requesting user. Every candidate must reduce to a **checkable `(VisibilityEntityType, entity_id)` pair or be dropped** - there is no free-text fallback (a raw `bolt_recent_events` string is attacker-controllable and must never render past `can_access`). The explicit mapping:

| Correlation source | Raw shape | Maps to `VisibilityEntityType` | If unmappable |
| --- | --- | --- | --- |
| `v_activity_unified` (bam arm) | typed `bam` task/project/sprint row | `bam.task` / `bam.project` / `bam.sprint` | drop |
| `v_activity_unified` (bond arm) | typed `bond` deal/contact/company row | `bond.deal` / `bond.contact` / `bond.company` | drop |
| `v_activity_unified` (helpdesk arm) | typed ticket row | (helpdesk type per `SUPPORTED_ENTITY_TYPES`) | drop |
| `bolt_recent_events` payload | `{ source, event_type, payload.*.id }` | per-source resolver -> dotted type (e.g. `bill.invoice`) only when a typed id is present | **drop** (no id, or type not in allowlist) |
| Class-B driver UUID | dimension value | the dimension's registered entity type | drop |

The `entity_links.dst_type` convention (Section 3.3) is kept separate and mapped to the visibility type at this boundary. After mapping, each candidate is passed through MCP `can_access(asker_user_id, entity_type, entity_id)` / `POST /v1/visibility/can_access` (`apps/api/src/services/visibility.service.ts:91` for the allowlist) and dropped fail-closed on deny or on any unsupported type.

### 2.4 Prompt-injection and PII isolation

The shared narrative covers **Class-A drivers only**. Class-B decompositions get **no shared narrative** (`narrative=null`); any Class-B prose is generated per-user at read time over only `can_access`-allowed drivers (Section 2.2), so per-entity amounts never enter a shared string. For Class A the LLM receives **opaque tokens** (`DRIVER_1`, `DRIVER_2`) plus numeric contributions, never raw third-party strings; the SPA re-hydrates Class-A labels client-side. It uses **only the internal platform llm-provider** (`apps/api/src/routes/internal-llm.routes.ts` / `apps/api/src/services/llm-provider.service.ts`, via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), so no PII egresses to a third-party endpoint. Output is rendered **plain text**; links are attached by the SPA from structured drivers, never from model-emitted markup.

### 2.5 What an agent can do autonomously vs. HITL

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Read a certified metric's value | Autonomous | `basis_metric_value` |
| Ask "why did X change" | Autonomous; requires explicit `asker_user_id` (Section 4.5) | `basis_explain_change` |
| Rank drivers of a delta | Autonomous; requires explicit `asker_user_id` | `basis_rank_drivers` |
| List / search catalog | Autonomous | `basis_list_metrics`, `basis_search_metrics` |
| Define a *new draft* metric | Autonomous (draft only) | `basis_define_metric` |
| Version a **draft** metric | Autonomous, policy-gated, inline `confirm_action` | `basis_add_metric_version` |
| Version a **certified** metric | HITL, Redis-backed confirm token | `basis_add_metric_version` |
| **Certify / decertify** | HITL, Redis-backed confirm token | `basis_certify_metric` / `basis_decertify_metric` |
| **Deprecate** | HITL, destructive, Redis-backed confirm token | `basis_deprecate_metric` |

Truth-flip actions use the **Redis-backed dynamic-TTL confirm-token store** (`apps/mcp-server/src/lib/confirm-token-store.ts`, 60s agent TTL), the class `CLAUDE.md` mandates for destructive MCP actions. Only versioning a still-`draft` metric uses the inline-boolean pattern (`apps/mcp-server/src/tools/blip-tools.ts:155`).

### 2.6 Guardrails summary

- **agent_policies** (`0139_*`, `apps/mcp-server/src/lib/register-tool.ts:503`): every `basis.*` service-account call passes the §15 kill-switch + glob allowlist. `basis.*` is **not** in the always-permitted core, so tools fail closed until an operator allowlists them; documented for operators and covered by a `register-tool` policy test.
- **Per-action permissions** (`@bigbluebam/permissions`, pattern `apps/bench-api/src/plugins/permissions.ts`): Section 4.4.
- **can_access preflight** per requesting user at read time on every Class-B driver and every correlation candidate.
- **Correlation-not-causation guard**: the two computations are never fused (Section 2.1); narrative is hedged and driver-only.

---

## 3. Data model

All Basis tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id` as `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Advisory until `BBB_RLS_ENFORCE=1`. Each table gets a **1:1 Drizzle module** under `apps/basis-api/src/db/schema/` (`basis-metrics.ts`, `basis-metric-versions.ts`, `basis-metric-snapshots.ts`, `basis-explanations.ts`, `index.ts`), mirroring `apps/bench-api/src/db/schema/`. The partitioned snapshots table declares the **parent only** in Drizzle (children are DB-managed) so `pnpm db:check` stays green.

### 3.1 Tables

**`basis_metrics`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `slug` | varchar(80) NOT NULL | unique per org |
| `name` | varchar(160) NOT NULL | |
| `description` | text | |
| `unit` | varchar(20) NOT NULL | `currency`\|`count`\|`percent`\|`ratio`\|`duration_ms` |
| `favorable_direction` | varchar(8) NOT NULL DEFAULT `'up'` | `up`\|`down`\|`neutral` |
| `owner_id` | uuid | FK `users(id)` ON DELETE SET NULL |
| `certification` | varchar(12) NOT NULL DEFAULT `'draft'` | `draft`\|`certified`\|`deprecated` |
| `current_version_id` | uuid | FK `basis_metric_versions(id)` |
| `related_apps` | jsonb NOT NULL DEFAULT `'[]'` | metric-scoped correlation neighborhood (round-2): the app set correlation may draw from; defaults to `lineage.apps`, admin-extendable with neighbor apps |
| `target` | jsonb | optional `{ value, comparison }` for breach detection |
| `resolve_status` | varchar(12) NOT NULL DEFAULT `'ok'` | `ok`\|`resolve_failed`; written for **drafts and certified** metrics (Section 6) |
| `resolve_failed_at` | timestamptz | |
| `last_breach_at` / `last_breach_direction` | timestamptz / varchar(8) | once-per-crossing breach marker (mirrors `bond_deals.rotting_alerted_at`); direction cleared on recovery |
| `created_by` | uuid | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, slug)`, `(organization_id, certification)`, `(organization_id, owner_id)`.

**`basis_metric_versions`** - immutable lineage.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_number` | integer NOT NULL | monotonic per metric |
| `definition` | jsonb NOT NULL | Basis definition shape (Section 1), owned by `packages/shared/src/schemas/basis.ts`; validated against Bench by round-trip preview, not by a shared `QueryConfig` |
| `lineage` | jsonb NOT NULL | descriptive `{ apps, base_table, joins }`; **not executed** |
| `change_note` | text | |
| `created_by` | uuid | FK `users(id)` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (metric_id, version_number)`, `(organization_id, created_at DESC)`. Never updated or deleted.

**`basis_metric_snapshots`** - captured values for movement detection and sparklines only. **Range-partitioned monthly by `captured_at`.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | composite PK with `captured_at` |
| `metric_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_id` | uuid NOT NULL | FK `basis_metric_versions(id)` |
| `captured_at` | timestamptz NOT NULL | partition key; **truncated to the grain boundary in UTC** (Section 6) |
| `grain` | varchar(10) NOT NULL | `hour`\|`day`\|`week`\|`month` |
| `value` | numeric NOT NULL | scalar |

`dims` was dropped for v1 (no reader; movement-scan and sparklines use scalar `value` only). **Idempotency:** `UNIQUE (metric_id, grain, captured_at, version_id)` (the partition key `captured_at` is part of the key, so it is enforceable on the partitioned parent) + `INSERT ON CONFLICT DO UPDATE`. This guarantee holds **only because `captured_at` is bucket-aligned** (Section 6): a retry of the same scheduled tick re-derives the identical boundary and no-ops. Indexes: `(metric_id, grain, captured_at DESC)`.

**`basis_explanations`** - cached **deterministic** driver decomposition only.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `metric_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `organization_id` | uuid NOT NULL | |
| `version_id` | uuid NOT NULL | FK; part of cache identity |
| `cache_key` | varchar(64) NOT NULL | `sha256` of canonical JSON of the identity tuple `metric_id \| version_id \| period_a \| period_b \| resolved_dimension`, computed by a small **Basis-owned** helper (in `packages/shared` or a `basis-api` lib). It does **not** import bench-api's `CacheService.hashQueryConfig` (that is a private instance method of a separate service - the same false cross-app-reuse pattern round 2 purged). |
| `period_a` / `period_b` | jsonb NOT NULL | |
| `dimension` | varchar(80) | the **resolved** dimension (Section 2.2) |
| `dimension_class` | varchar(1) | `A` (labels stored) or `B` (opaque uuids, labels resolved per-user) |
| `delta_abs` / `delta_pct` | numeric | |
| `drivers` | jsonb NOT NULL | Class A: `[{ dimension_value, label, contribution_abs, contribution_pct }]` (served as-is). Class B: `[{ dimension_value (uuid, opaque), contribution_abs, contribution_pct }]` **never served raw** - at read time denied rows are dropped whole (label + amount) and folded into an "Other (N hidden)" bucket per user (Section 2.2) |
| `narrative` | text | **Class A**: drivers-only, nullable when the LLM leg failed. **Class B**: always `null` (no shared per-entity prose); per-user prose generated at read time |
| `model` | varchar(60) | |
| `computed_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (cache_key)`, `(metric_id, computed_at DESC)`.

**`basis_org_settings`** - per-org configuration the round-2 retention + cache-precedence fixes depend on (round-3: this had no home). Modeled on `apps/blip-api/src/db/schema/blip-retention-policies.ts` (nullable `max_age_days` = unbounded). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE; `UNIQUE` |
| `snapshot_max_age_days` | integer | **null = unbounded** (feeds the retention sweep's "skip coarse tier if any org unbounded"); shorter windows enforced by ranged DELETE only (Section 6) |
| `explanation_cache_ttl_seconds` | integer | ages out `basis_explanations` |
| `default_dimension` | varchar(80) | the org-Settings tier of the effective-dimension precedence (Section 2.2) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Org-scoped with RLS on `app.current_org_id`. Section 6's sweep reads `snapshot_max_age_days` across all orgs; Section 2.2's precedence reads `default_dimension`; the §5 Settings page persists here.

### 3.2 Cross-app additive change (Bench binding)

`bench_widgets` gains `basis_metric_id uuid NULL` (additive). When set, Bench resolves via `GET /basis/api/v1/metrics/:id/resolve`, which returns the query config **and the presentation envelope** (`display_name`, `unit`, `favorable_direction`, `target`); Bench **prefers these over local `kpi_config`**. `apps/bench-api/src/db/schema/bench-widgets.ts` is updated in the same change.

### 3.3 Reused platform tables

- `entity_links` (`0132_*`): only human-curated metric-to-driver pins (`src_type='basis_metric'`), `ON CONFLICT DO NOTHING`. Never auto-written from per-user correlation.
- `v_activity_unified` (`0129_*`, covers **bam/bond/helpdesk only** - Bill and others are not in it), `bolt_recent_events` / `bolt_event_trace`: read at request time.
- `organizations`, `users`.

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed tip on this branch is `0225_bin_scan_override.sql`; the `permissions_seed_actions_delta` series tip is `0224_..._delta_019`. **All numbers below are provisional.** `scripts/build-permission-delta.mjs` assigns the migration number as `max(4-digit files)+1` and the delta suffix as `(existing delta count)+1`; it **MUST run only after the three hand-authored files are on disk**, its outputs are **generator-derived (do not hand-pick `0229`/`020`)**, and the whole set must be re-verified and re-run at implement/merge time because any other branch landing a migration first invalidates the numbering.

1. **`0226_basis_core.sql`** - `basis_metrics` (incl. `related_apps`, `resolve_status`, `last_breach_*`) + `basis_metric_versions` + **`basis_org_settings`**, indexes, RLS. Additive only.
2. **`0227_basis_snapshots_explanations.sql`** - partitioned `basis_metric_snapshots` parent (RANGE on `captured_at`) with `UNIQUE (metric_id, grain, captured_at, version_id)`; **pre-create current..+12 monthly partitions PLUS a `DEFAULT` catch-all partition** (mirrors blip's wide runway). **DEFAULT recovery caveat (round-3):** a bare `CREATE TABLE ... PARTITION OF ... FOR VALUES` for a month whose rows already landed in `DEFAULT` aborts with "default partition would be violated by some row" - so DEFAULT is a *degradation net, not a self-healing guarantee* (see Section 6 for the runbook). `basis_explanations` with `UNIQUE (cache_key)` + `version_id` + `dimension_class`; RLS on both. Additive only.
3. **`0228_bench_widget_metric_binding.sql`** - `ADD COLUMN IF NOT EXISTS bench_widgets.basis_metric_id uuid` + index. Additive only.
4. **`NNNN_permissions_seed_actions_delta_0MM.sql`** - **generated** by re-running the permission-delta generator after regenerating `docs/permissions-action-manifest.json` with the `basis.*` verb set (Section 4.4). Additive only.

Bolt event registration is a TS edit to `apps/bolt-api/src/services/event-catalog.ts` (Section 7), not a migration.

---

## 4. API surface

Base path `/basis/api/`, routes under `/v1` (mirroring `apps/bench-api/src/server.ts:111-118`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` (`@bigbluebam/logging` `createErrorHandler`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Request/response shapes come from `packages/shared/src/schemas/basis.ts`, imported by both `basis-api` and the SPA.

### 4.1 Bench query access (two auth modes; converged round-2 fix - no per-org service accounts)

The value/explain path runs Bench-governed queries server-to-server via a **new internal query route on `bench-api`**. Bench's org isolation is entirely the `orgId` argument to `buildQuery` (no RLS on that read path), so the route enforces org two ways, matching existing platform precedent:

- **Mode (a) - user-initiated `/value` and `/explain`:** Basis **forwards the caller's bearer token**. The bench route validates that token as a **live credential through the same `requireAuth` session/API-key verification path as a normal request** (it does not decode a claimed org), and derives org from the **verified principal**. `INTERNAL_SERVICE_SECRET` is an **additional** gate; the request is rejected if the token fails live validation **even when the secret is correct**. This closes the "forge a token asserting any org" hole.
- **Mode (b) - background workers:** the worker presents `INTERNAL_SERVICE_SECRET` and an **explicit `org_id`**, trusted because it is first-party and network-internal. This is exactly how existing cross-org workers fan out (e.g. `banter-feed-fanin` reads `data.org_id` and sets `app.current_org_id`). **There are no per-org `bbam_svc_` service accounts** - the round-1 fleet is dropped: it required N pre-minted, once-shown, hand-rotated tokens with no org-creation hook (new orgs would silently get no snapshots) and aggregated every tenant's financials behind one secret store.

`INTERNAL_SERVICE_SECRET` **must be non-empty** wherever Basis runs (platform default is empty, which correctly fails closed). The bench internal route is an out-of-Basis prerequisite owned by Bench maintainers (Open Questions).

### 4.2 REST endpoints

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/v1/metrics` | List | filters, cursor; `requireAuth`, org from `request.user.org_id` |
| POST | `/v1/metrics` | Create draft + first version | validates definition via Bench preview; emits `metric.created` |
| GET | `/v1/metrics/:id` | Get metric + current version | |
| PATCH | `/v1/metrics/:id` | Update metadata + `related_apps` | non-definition only |
| POST | `/v1/metrics/:id/versions` | New version | **runs Bench preview to set `resolve_status`**; emits `metric.definition_changed` |
| GET | `/v1/metrics/:id/versions` | Version history | |
| POST | `/v1/metrics/:id/certify` | Flip certified | re-validates via Bench preview; perm `basis.metric.certify`; emits `metric.certified` |
| POST | `/v1/metrics/:id/decertify` | Flip draft | emits `metric.decertified` |
| DELETE | `/v1/metrics/:id` | Deprecate (soft) | emits `metric.deprecated` |
| GET | `/v1/metrics/:id/resolve` | Binding contract: query config + presentation envelope | `requireAuth`, org-scoped; Bench forwards its caller's cred |
| GET | `/v1/metrics/:id/value` | Value for a period | Mode (a) token-forward |
| POST | `/v1/metrics/:id/explain` | Decomposition + per-user correlation | resolves effective dimension server-side then hashes; cached deterministic row + read-time correlation; large ranges -> `basis-explain` queue, `{status:'computing', job_id}` |
| GET | `/v1/metrics/:id/explanations` | List cached deterministic rows | **each read routed through the same per-user Class-B label + correlation `can_access` filter as `/explain`** |
| GET | `/v1/metrics/:id/snapshots` | Movement history / sparkline | |
| GET | `/v1/metrics/:id/lineage` | Upstream apps/tables (descriptive) | |
| GET | `/v1/data-sources` | Pass-through of Bench data-source catalog | `requireAuth`, org-scoped |
| GET | `/health` / `/readyz` | Probes | `/readyz` checks **only Postgres + Redis** (Section 8.4) |

### 4.3 Realtime (`/basis/ws`)

Redis-PubSub, org-scoped rooms. `explanation.ready` payload is **refs-only**: `{ metric_id, cache_key, narrative_ready: boolean }` - no driver payload (clients fetch through the per-user-filtered read path). Also broadcasts `metric.certified` / `metric.definition_changed`. Notification channel only.

### 4.4 Permissions

Manifest-generated in `docs/permissions-action-manifest.json`, `app.resource.verb`: `basis.metric.read`, `basis.metric.define`, `basis.metric.version`, `basis.metric.certify`, `basis.metric.decertify`, `basis.metric.deprecate`, `basis.metric.update`, `basis.explain.run`, `basis.datasource.read`. Regenerating the catalog produces the delta migration (Section 3.4).

### 4.5 MCP tools

New `apps/mcp-server/src/tools/basis-tools.ts` via `registerTool` (`register-tool.ts:488`), HTTP client shaped like `apps/mcp-server/src/tools/bench-tools.ts:9`. Env `BASIS_API_URL=http://basis-api:4019/v1`.

`basis_explain_change` and `basis_rank_drivers` **require an explicit `asker_user_id`** (per `docs/reference/agent-conventions.md`). This is a deliberate departure from `search_everything`'s fail-open default (`apps/mcp-server/src/tools/search-tools.ts:750` returns allowlisted hits unfiltered when `as_user_id` is absent). When `asker_user_id` is absent, Basis returns the **deterministic decomposition with an empty correlation list**, and for **Class-B dimensions the whole decomposition collapses to a single "Other (all N hidden)" aggregate** carrying the `delta_abs`/`delta_pct` total but **no per-entity rows and no per-entity amounts** (treat every entity as denied - so there is nothing to subtract against and the N=1 back-out is structurally impossible). Per-entity Class-B amounts are exposed **only** when an `asker_user_id` is supplied and passes `can_access`, subject to the k >= 2 secondary-suppression rule (Section 2.2). Class-A drivers are returned normally. Fail-closed; never the service account's own visibility.

| Tool | Backs | Autonomy |
| --- | --- | --- |
| `basis_list_metrics` / `basis_search_metrics` | GET `/metrics` | read |
| `basis_get_metric` | GET `/metrics/:id` | read |
| `basis_metric_value` | GET `/metrics/:id/value` | read |
| `basis_metric_lineage` | GET `/metrics/:id/lineage` | read |
| `basis_explain_change` | POST `/explain` | read, requires `asker_user_id` |
| `basis_rank_drivers` | POST `/explain` (drivers only) | read, requires `asker_user_id` |
| `basis_define_metric` | POST `/metrics` | write, draft only, policy-gated |
| `basis_add_metric_version` | POST `/versions` | inline `confirm_action` (draft) / Redis token (certified) |
| `basis_certify_metric` / `basis_decertify_metric` | certify/decertify | Redis confirm token |
| `basis_deprecate_metric` | DELETE `/metrics/:id` | destructive, Redis confirm token |

**No-tool endpoints** (record in `docs/reference/mcp-endpoint-mapping.md`; keep coverage counts synced; run the zero-bare-dash grep): `/resolve` _(skip: internal Bench binding)_; `/snapshots`,`/versions`,`/explanations` _(skip: folded into `basis_get_metric`/`basis_explain_change`)_; `/data-sources` _(skip: Bench has `bench_list_data_sources`)_; `PATCH /metrics/:id` _(skip: deferred)_; `/basis/ws`,`/health`,`/readyz` _(skip: realtime/probe)_. Register a Basis provider in `search_everything`.

---

## 5. Frontend

`apps/basis/` React SPA at `/basis/`, modeled on `apps/bench/` (`app.tsx`, `main.tsx`, `pages/`, `hooks/`, `stores/auth.store.ts`, `lib/api.ts`). TanStack Query v5, Zustand auth (`apps/bench/src/stores/auth.store.ts`), `@bigbluebam/ui`, types from `packages/shared/src/schemas/basis.ts`.

1. **Metric Catalog** - table with certification badges, owners, unit, sparkline, and a `resolve_failed` warning badge.
2. **Metric Detail** - definition, lineage, current value, sparkline, version history, permission-gated certify/decertify/deprecate.
3. **Definition Builder** - the query-form (data source -> measure/agg/filters) is **extracted from Bench's widget wizard into a shared component** used by both apps; "Preview value" **POSTs the draft to bench-api** (the authoritative drift/validation guard). Basis adds only governance fields around it.
4. **Why-Did-It-Change Explorer** - ranks the **certified deterministic drivers first**, then a visibly-separate, lower-ranked "possibly related activity" panel (per-viewer, access-scoped). Drill-down links attached by the SPA from structured drivers, never model markup. Live-updates via `explanation.ready`; shows "summary unavailable" when `narrative` is null.
5. **Settings** - owners/stewards, default decomposition dimension, explanation cache TTL, and the per-org snapshot retention window, all persisted to **`basis_org_settings`** (Section 3.1). Copy states the retention window enforces via bounded deletes and can never shorten another tenant's data (Section 6).

Basis renders only minimal explanatory visuals (contribution bars, sparkline) with `@bigbluebam/ui` primitives - no charting library, no dashboards.

---

## 6. Background work

BullMQ workers in `apps/worker` (`{ pattern: '<cron>' }` convention in `apps/worker/src/worker.ts`). All fan-out uses **Mode (b)** (Section 4.1: `INTERNAL_SERVICE_SECRET` + explicit `org_id`, `app.current_org_id` set per org, like `banter-feed-fanin`). Every `(org, metric)` is wrapped in **try/catch log-and-continue**, resumable (the snapshot `ON CONFLICT` + bucket-aligned `captured_at` make re-runs no-ops), with **progress logging** via `@bigbluebam/logging` (start line with elapsed, per-N progress, completion with duration, a line before any LLM call). Jobs set `removeOnComplete`/`removeOnFail` and keep payloads to refs (shared 256MB noeviction Redis). Per-org windows come from **`basis_org_settings`** (Section 3.1).

**Cron collision-avoidance (round-3 fix).** The hourly snapshot fires at **minute :00 of every hour**, so that minute is owned by the snapshot tick. Every daily job must therefore avoid minute :00, or the retention sweep's `ACCESS EXCLUSIVE` partition DROP could still overlap an hourly snapshot write. All daily jobs are pinned to distinct **non-zero** minutes: `basis-partition-provision` `45 2 * * *`, `basis-retention-sweep` `15 3 * * *`, `basis-movement-scan` `30 4 * * *`.

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `basis-partition-provision` | daily (`45 2 * * *`) | Ensure the snapshot runway stays current..+12 months (the `DEFAULT` partition is the degradation net). **Alarms** (not just logs) on failure. **DEFAULT recovery runbook (round-3):** if a month's rows already landed in `DEFAULT` (the missed-provision case), a bare `CREATE ... PARTITION OF` for that month aborts ("default partition would be violated by some row"). v1 treats this as a **manual-runbook condition, not self-healing**: an operator detaches `DEFAULT`, creates the month partition, redistributes the rows through the parent, and re-attaches `DEFAULT`. Until then, DEFAULT-resident rows are reclaimed **only** by the per-org ranged DELETE once aged past the window - the coarse tier can never drop `DEFAULT`. So `DEFAULT` prevents insert failure but is **not** a graceful-degradation guarantee for the coarse retention tier. |
| `basis-metric-snapshot` | hourly (`0 * * * *`) + a **daily `day`-grain pass** | For each certified metric, `captured_at = date_trunc('<grain>', scheduled_tick_time)` in UTC (re-derived from the tick, never `now()`), live-query and `INSERT ON CONFLICT DO UPDATE`. The daily pass is the **sole `day`-grain producer**. On bench 5xx: skip-and-reschedule that item; on unresolvable definition: set `resolve_status='resolve_failed'` and continue. Per-org concurrency cap. |
| `basis-explain` | on-demand | (1) run the **deterministic** decomposition, resolve the effective dimension, persist `basis_explanations` (`ON CONFLICT (cache_key) DO UPDATE`), emit `explanation.ready{narrative_ready:false}`; (2) attempt the drivers-only narrative with a bounded LLM timeout; on failure leave `narrative=null` and enqueue a **narrative-only retry** (no Bench queries) that, on success, **re-emits `explanation.ready{narrative_ready:true}`** on the same `cache_key`-keyed room so clients leave "summary unavailable." **Job id = `cache_key`** so identical requests dedupe. Correlation is **not** computed here (it is per-user, at read time). |
| `basis-movement-scan` | daily (`30 4 * * *`, non-zero minute) | Compare only snapshots sharing the **same `version_id`** (a `definition_changed` re-baselines). Fire `metric.threshold_breached` **once per crossing** via `last_breach_*` (cleared on recovery). Payload is **magnitude only** (Section 7). |
| `basis-retention-sweep` | daily (`15 3 * * *`, non-zero minute) | **Two-tier, verbatim from `apps/worker/src/jobs/blip-retention-sweep.job.ts:130-135`**, reading `basis_org_settings.snapshot_max_age_days`: (1) coarse floor - drop a whole month partition only when its upper bound is past the **platform-wide MAX retention across all orgs**, and **skip entirely if any org is unbounded** (`snapshot_max_age_days IS NULL`); the `DEFAULT` partition is never droppable (no upper bound). (2) per-org shorter windows are enforced by **bounded ranged DELETEs within live partitions, never a partition drop**, so one org's short window cannot delete another org's rows in a shared month. Also ages out expired `basis_explanations`. **No hour-to-day rollup** (round-2): re-aggregating 24 hourly rows of a stock metric would ~24x it and would collide with the daily `day`-grain pass on the UNIQUE key; retention only deletes expired `hour`-grain rows. |

A lightweight **draft resolve-check** also runs on `/versions` POST and `/certify` (via the same Bench preview the Definition Builder uses) so draft/decertified definitions get drift feedback, not only certified ones.

---

## 7. Events & integration

### 7.1 Bolt events published (source `basis`)

Via `publishBoltEvent(eventType, 'basis', payload, orgId, actorId?, actorType?)` (`packages/shared/src/bolt-events.ts:35`), bare names, each registered with a `payload_schema` in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI (the guard also scans the worker emit site for `metric.threshold_breached`).

| `event_type` | When | Payload |
| --- | --- | --- |
| `metric.created` | defined | `metric.id/slug/name`, `actor.*`, `org.*` |
| `metric.definition_changed` | new current version | `metric.id`, `version.number`, `version.change_note` |
| `metric.certified` / `metric.decertified` / `metric.deprecated` | state flips | `metric.id`, `actor.*` |
| `metric.threshold_breached` | movement-scan breach | `metric.id`, `delta_abs`, `delta_pct`, `direction` - **magnitude only, no entity refs** |

### 7.2 entity_links

Only human-curated metric-to-driver pins (`src_type='basis_metric'`), `ON CONFLICT DO NOTHING`. No auto per-user correlation links.

### 7.3 Unified activity & search

Register a Basis provider in `search_everything`; Qdrant-down degrades cross-app search to keyword-only. Basis catalog changes flow as Bolt events, not into the fixed `v_activity_unified` UNION in v1. Correlation *reads* `v_activity_unified` (bam/bond/helpdesk arms) and `bolt_recent_events` (everything else, incl. Bill), scoped to the metric's `related_apps`.

---

## 8. Infrastructure

### 8.1 New api compose service

`basis-api` in `docker-compose.yml`, modeled on `bench-api`: `PORT: 4019`, stateless, horizontally scalable. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) **only**. Per the sibling-dependency pattern (blast-api calls bond-api but its compose `depends_on` is just migrate/redis/postgres), **`bench-api` is NOT in `basis-api.depends_on`** - it is a request-time, circuit-broken dependency and lives only in the deploy catalog `needs` (Section 8.4). Gating startup on Bench health would let a Bench crashloop block Basis. Env: `DATABASE_URL`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, **`INTERNAL_SERVICE_SECRET` (non-empty)**, `BBB_API_INTERNAL_URL=http://api:4000`, `BENCH_API_INTERNAL_URL=http://bench-api:4011`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `CORS_ORIGIN`, rate-limit + query-timeout + LLM-timeout knobs. Healthcheck: `curl -sf http://localhost:4019/health`.

### 8.2 SPA build (the SPA is not its own service)

Every SPA is built in the single `apps/frontend/Dockerfile` multi-stage build and `COPY`'d into `/usr/share/nginx/html/<app>`. Basis edits it in **five places mirroring the blip lines**: (1) deps-stage `COPY apps/basis/package.json`, (2) deps-stage source `COPY apps/basis`, (3) build-stage `COPY`, (4) add `pnpm --filter @bigbluebam/basis build` to the build `RUN`, (5) production `COPY apps/basis/dist` -> `html/basis`. Cross-check every place that hardcodes the app list. There is **no** separate `basis` compose service.

### 8.3 nginx routing (ALL THREE configs)

Add `/basis/`, `/basis/api/`, `/basis/ws` blocks **and** the static-asset cache-regex entry to **all three** mainline configs, matching how bench/blip appear in each:
- `infra/nginx/nginx.conf` - alias + SPA fallback; `/basis/api/` -> `http://basis-api:4019/`; `/basis/ws` with upgrade headers.
- `infra/nginx/nginx-with-site.conf` - the site-profile entrypoint (`docker-compose.yml:327` bind-mounts it as `site.conf.template`); omitting it 404s `/basis/` in any site-profile stack.
- `infra/nginx/nginx.railway.conf` - **different form**: `set $rw_upstream_NN "basis-api.railway.internal";` with the file-level resolver, `rewrite ^/basis/api/(.*)$ /$1 break;`, `proxy_pass http://$rw_upstream_NN:8080;` (**port 8080, not 4019**), a **fresh `$rw_upstream_NN` index** (next free), and `/basis/ws` uses `rewrite ^/basis/ws(.*)$ /ws$1 break;`. Mirror the blip block exactly.

**Ingress crash-safety:** because nginx (compose form) resolves literal upstreams at load and crashloops on host-not-found, add **`basis-api` (`condition: service_healthy`) to the `frontend` service `depends_on`** in `docker-compose.yml`.

### 8.4 Deploy catalog, Railway manifests, MCP wiring, health

- `scripts/deploy/shared/services.mjs`: add a `basis-api` `APP_SERVICES` block (port `4019`, `public_paths: ['/basis/api/','/basis/ws']`, `needs: ['postgres','redis','api','bench-api']`); add `/basis/` to the `frontend` entry's `public_paths` and `basis-api` to its `needs`; add `basis-api` to `mcp-server`'s existing curated `needs`/`depends_on` subset. Add `BASIS_API_URL: http://basis-api:4019/v1` to `mcp-server` env in compose and catalog; register `basis-tools.ts` in the MCP bootstrap.
- **Run `node scripts/gen-railway-configs.mjs` and commit the new `railway/basis-api.json` + updated `railway/frontend.json`** (these per-service manifests are generated from `APP_SERVICES` and checked in; without this step there is no `railway/basis-api.json` to deploy).
- **Runtime-dependency posture:** `/readyz` checks **only Postgres + Redis** - never bench-api/LLM/Qdrant - so a Bench outage never cascades into Basis "not ready." The Bench query client uses a short timeout + circuit breaker returning typed `UPSTREAM_UNAVAILABLE`; the snapshot sweep skips-and-reschedules on bench 5xx; narrative is best-effort; Qdrant-down -> keyword-only search. Stateful deps are Postgres + Redis only.

---

## 9. Reuse ledger

| Capability | Reuses (real file/package) | New in Basis |
| --- | --- | --- |
| Underlying query / SQL gen / org isolation | `apps/bench-api/src/services/query.service.ts`, `data-source-registry.ts` (+ new internal query route, 2-mode auth) | Metric-to-query resolution; token-forward + secret+org_id modes |
| Saved-query prior art | `apps/bench-api/src/db/schema/bench-saved-queries.ts` | Governance/versioning/presentation layer |
| Chart/dashboard rendering | `apps/bench/` + new `bench_widgets.basis_metric_id` | One binding column + `/resolve` envelope |
| Definition shape / drift guard | `packages/shared/src/schemas/basis.ts` (Basis-owned) + Bench preview round-trip | The Basis definition schema |
| Bolt events | `@bigbluebam/shared` `publishBoltEvent`; catalog + `check-bolt-catalog.mjs` | 6 `metric.*` definitions |
| Event correlation | `v_activity_unified` (bam/bond/helpdesk), `bolt_recent_events`/`bolt_event_trace` | Two-plane decomposition + per-user mapping table |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts` (dotted `SUPPORTED_ENTITY_TYPES`), `can_access` | Class-A/B classification; correlation mapping; read-time filtering |
| Cross-app linking | `entity_links` (`0132_*`) | Human-pinned drivers only |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` | Basis provider (fail-closed asker rule) |
| RLS / org scoping | `app.current_org_id` GUC (`0116_*`, `0132_*:52-56`) | Basis table policies |
| Per-action permissions | `@bigbluebam/permissions`, `apps/bench-api/src/plugins/permissions.ts` | 9 `basis.*` actions |
| MCP registration + policy gate + Redis confirm token | `register-tool.ts:488`, `confirm-token-store.ts`, blip inline pattern | 12 `basis_*` handlers |
| Cross-org worker fan-out (secret + explicit org_id) | `banter-feed-fanin` pattern; `app.current_org_id` | Basis snapshot/scan fan-out |
| LLM narrative | `internal-llm.routes.ts`, `llm-provider.service.ts` | Opaque-token drivers-only prompt |
| Fastify skeleton / health / logging | `apps/bench-api/src/server.ts`, `@bigbluebam/service-health`, `@bigbluebam/logging` | Config + routes |
| Snapshot idempotency | `apps/worker/src/jobs/bearing-snapshot.job.ts` | Bucket-aligned `captured_at` + `ON CONFLICT` |
| Partition runway + DEFAULT + two-tier retention | `blip-partition-provision.job.ts`, `blip-retention-sweep.job.ts:130-135` | Basis provisioning/sweep (no rollup; DEFAULT runbook) |
| Per-org policy table | `apps/blip-api/src/db/schema/blip-retention-policies.ts` (nullable `max_age_days`) | `basis_org_settings` |
| Railway config generation | `scripts/gen-railway-configs.mjs` | `railway/basis-api.json` |
| Background jobs | `apps/worker/src/worker.ts` | 5 `basis-*` jobs |
| SPA scaffold | `apps/bench/src/` + extracted shared query-form | 5 Basis pages |

### Test posture

- Assert the decomposition invariant `sum(contributions) == delta_abs` for additive measures, and the ratio/percentile directional fallback (labeled non-exact).
- Assert a re-run of the same scheduled snapshot tick is a **no-op** (bucket-aligned `captured_at`).
- Assert the `metric.threshold_breached` payload is **exactly** `{metric.id, delta_abs, delta_pct, direction}` with **no entity refs** (leak-safety as a test, not convention).
- Assert `basis_explain_change`/`basis_rank_drivers` without `asker_user_id` return empty correlation and, for Class-B dimensions, **drop per-entity amounts** (only the total + "Other (N hidden)") - fail-closed.
- Assert a **Class-B decomposition never persists a shared narrative** and that a denied entity's `contribution_abs` is unrecoverable at read time (dropped whole, folded into "Other").
- **N=1 complementary-disclosure test:** with exactly one denied entity, assert the response neither exposes nor lets the viewer *arithmetically derive* its magnitude - i.e. `delta_abs - sum(served rows)` must **not** equal any single hidden entity's contribution (k >= 2 secondary suppression forces `N_hidden >= 2`). Also assert the absent-asker `basis_rank_drivers` fallback returns a single "Other (all N hidden)" aggregate with no per-entity amounts.
- **Registration-time test:** a label column joined from a restricted entity **cannot register Class A** (must be Class B).
- A `packages/shared` `basis.ts` schema test; a `register-tool` policy test that `basis.*` fails closed until allowlisted; confirm the 6 events pass `check-bolt-catalog.mjs`; `pnpm db:check` clean against the 4 Drizzle modules (parent-only for the partitioned table).

---

## 10. Open questions & risks

1. **Ratio/average/percentile decomposition is directional, not exact.** Exact only for `sum`/`count`. v1 labels ratio/percentile explanations "directional." Sign-off needed.
2. **Promote Bench's executor contract to shared?** v1 has `basis.ts` own the definition shape with Bench-preview as the drift guard; the durable fix is promoting Bench's `QueryMeasure`/`dimensions` executor contract into `packages/shared` so both apps import one type (then "cannot drift" is literally true). Recommended follow-up.
3. **Bench internal query route (2-mode auth)** is an out-of-Basis prerequisite owned by Bench maintainers; must land before value/explain works.
4. **Class-B resolver coverage.** Which entity-FK dimensions ship registered resolvers in v1 (owner, company, project?) is a scoping call; unregistered dimensions are simply not offered.
5. **`related_apps` defaults.** Seeding `related_apps` from `lineage.apps` plus which neighbor apps an admin may add is a governance decision; correlation quality depends on it.
6. **`/resolve` precedence rollout** requires a coordinated Bench change to prefer the Basis presentation envelope over local `kpi_config`.
7. **Certification governance.** Default gate `basis.metric.certify` (org admin/owner); whether a permissioned service account may ever certify without a human is open.
8. **Snapshot cost at scale.** O(orgs x certified-metrics x buckets) Bench round-trips; bounded by per-org concurrency caps + retention, but large tenants need a capacity review before enabling hourly grain by default.
9. **Correlation is not causation**; never let an agent treat an explanation as ground truth for an autonomous write.
10. **`v_activity_unified` extension** for Basis catalog changes and for apps it omits (e.g. Bill) is deferred; v1 uses `bolt_recent_events` for uncovered apps, contingent on those apps emitting typed-id events.

---

## Changelog

**Round 3 - convergence verification (final residual blocker):**

- [security, BLOCKER] Class-B "drop-the-row + Other (N hidden)" did not close the amount leak because of **complementary disclosure against the certified total**: since the shared row serves an exact `delta_abs` and `sum(contributions) == delta_abs`, a viewer subtracts the served rows to recover a single denied entity's exact magnitude (the N=1 case). **Accepted.** Added **k-anonymous secondary suppression**: the hidden aggregate must cover k >= 2 entities; when exactly one would be suppressed, fold the smallest-magnitude allowed row into "Other" so N_hidden >= 2, and never serve an exact per-decomposition "Other" amount alongside the exact `delta_abs` when any cell is suppressed. The §4.5 absent-asker fallback collapses Class-B to a single "Other (all N hidden)" aggregate with no per-entity amounts. Stated the honest tension (a restricted viewer's breakdown may not reconcile to the exact certified total - the number is shared and exact, the breakdown is access-scoped and non-invertible) in §1 and §2.2. Extended the §9 test to the N=1 arithmetic-derivation case. Sections touched: §1, §2.2, §4.5, §9.

**Round 3 (capped round):**

- [security, BLOCKER] Class-B per-entity contribution amounts leaked via the shared cache: **accepted.** For Class-B dimensions the shared cache carries no per-driver narrative (`narrative=null`) and its per-entity amounts are never served raw; at read time a denied entity's whole row (label **and** amount) is dropped and folded into an "Other (N hidden)" bucket. Same drop-the-amount rule applied to the `basis_rank_drivers` absent-asker fallback (§2.2, §2.4, §3.1, §4.5, §9).
- [security, major] Class-A admitted entity-derived label columns: **accepted.** Class A is now a curated allowlist of bounded org-global enum columns only; any column that is the display form of a Class-B entity MUST be Class B; added a registration-time test invariant (§2.2, §9).
- [design, major] Per-org settings had no storage: **accepted.** Added `basis_org_settings` (modeled on `blip-retention-policies.ts`, nullable `snapshot_max_age_days`, `default_dimension`, `explanation_cache_ttl_seconds`) to §3.1 + the core migration; retention sweep and cache-precedence now point at it (§3.1, §3.4, §5, §6).
- [stability, major] DEFAULT partition + provisioner recovery inconsistency: **accepted-with-modification.** Rather than build the detach/redistribute/re-attach flow in v1, documented the DEFAULT-provision-failure as a **manual-runbook condition (not self-healing)** and stated DEFAULT-resident rows are reclaimed only by the per-org ranged DELETE, never the coarse tier - so DEFAULT is a degradation net, not a graceful-degradation guarantee. The automated redistribute flow is noted as the operator runbook (§3.4, §6).
- [best-practices, minor] `cache_key` cited bench-api's private `hashQueryConfig`: **accepted.** Replaced with a Basis-owned `sha256`-of-canonical-JSON helper; dropped the cross-service citation (§3.1).
- [stability, minor] Cron collision incompletely specified (minute :00 owned by the hourly snapshot): **accepted.** Pinned `basis-partition-provision` `45 2`, `basis-retention-sweep` `15 3`, `basis-movement-scan` `30 4`, and stated the invariant that all daily jobs avoid minute :00 (§6).
- [correction] The claim that `bill.invoice` is not in `SUPPORTED_ENTITY_TYPES` was verified **false** (it is at `visibility.service.ts:81`): **not applied.** Kept the Bill flagship example; added the true caveat that Bill (and any app absent from `v_activity_unified`) correlation depends on `bolt_recent_events` coverage (§2.1, OQ10).
- **Rejected this round:** none (the one invalid finding was flagged by the coordinator and correctly not applied).

**Round 2 (re-review of the round-1 revision):**

- [security+infrastructure, CONVERGED - per-org service accounts] **Accepted.** Dropped the invented per-org `bbam_svc_` fleet. Bench internal route now has two auth modes: (a) user request forwards the caller's bearer, validated live via `requireAuth` with org from the verified principal and `INTERNAL_SERVICE_SECRET` as an extra gate; (b) worker request uses `INTERNAL_SERVICE_SECRET` + explicit `org_id` (first-party trust, like `banter-feed-fanin`) (§4.1, §6, §8.1).
- [security] Shared-`drivers` cache leak via entity-FK dimension: **accepted.** Class-A (self-labeling enum) vs Class-B (entity-FK) classification; Class-B drivers stored opaque (uuid only) and label-resolved + `can_access`-filtered per user at read (§2.2, §3.1).
- [stability] Per-org retention driving a global partition DROP: **accepted.** Two-tier verbatim from blip: partition DROP only on platform-wide MAX retention (skip if any org unbounded); per-org shorter windows via bounded DELETEs within live partitions (§6, §5).
- [design] Correlation "drivers' apps" contradiction + `v_activity_unified` coverage: **accepted.** Added `related_apps` governance field; correlation draws from `v_activity_unified` (bam/bond/helpdesk) + `bolt_recent_events` (rest, incl. Bill); flagship reconciled (§2.1, §2.3, §3.1, §7.3).
- [design] Fused-sentence narrative impossible: **accepted.** Narrative is drivers-only and shared; correlation is per-user at read time; flagship rewritten as two separate pieces (§2.1, §2.4, §6).
- [design+security, CONVERGED] Cache identity + default-dimension precedence: **accepted.** Effective dimension resolved server-side before hashing; precedence request > `default_dimensions[0]` > Settings; out-of-allowlist -> typed `DIMENSION_NOT_ALLOWED` (§2.2, §3.1, §4.2).
- [security] MCP asker fail-open: **accepted.** `basis_explain_change`/`basis_rank_drivers` require explicit `asker_user_id`; absent -> empty correlation + opaque drivers (§4.5).
- [security] Bench route must authenticate the forwarded bearer as a live credential: **accepted.** Validate via `requireAuth`, derive org from verified principal, secret as additional gate (§4.1).
- [security] Correlation entity extraction + mapping undefined: **accepted.** Added the explicit source->`VisibilityEntityType` mapping table; unmappable/untyped candidates dropped, never rendered as text (§2.3).
- [stability] Hour->day retention rollup collision + stock mis-aggregation: **accepted.** Rollup dropped; daily `day`-grain pass is the sole producer; retention only deletes expired hour rows (§6, §3.1).
- [stability] Snapshot idempotency needs bucket-aligned `captured_at`: **accepted.** `date_trunc` to grain boundary in UTC, re-derived from the scheduled tick; no-op re-run test (§3.1, §6, §9).
- [stability] Partition provisioning SPOF: **accepted.** Migration pre-creates current..+12 months + a `DEFAULT` catch-all; DEFAULT never droppable; provision-failure alarms (§3.4, §6).
- [best-practices] Wrong shared-schema claim/identifier: **accepted.** Corrected to `benchQueryConfigSchema`/`BenchQueryConfig`; `basis.ts` owns the definition shape; Bench-preview round-trip is the drift guard; promoting the executor contract noted as the durable follow-up (§1, §3.1, §9, OQ2).
- [best-practices] Migration numbering: **accepted.** Numbers marked provisional; generator runs after the hand-authored files exist; re-verify at merge (§3.4).
- [infrastructure] Third nginx config omitted: **accepted.** Blocks + cache regex added to all three (`nginx.conf`, `nginx-with-site.conf`, `nginx.railway.conf`) (§8.3).
- [infrastructure] Railway routing form: **accepted.** Specified `rw_upstream`/`:8080`/`rewrite ... break` form with next free index and the `/basis/ws` rewrite (§8.3).
- [infrastructure] `basis-api.depends_on: bench-api` anti-pattern: **accepted.** Removed from compose `depends_on`; Bench stays in `services.mjs` needs only, matching blast->bond; mcp-server `depends_on` scoped to its curated subset (§8.1, §8.4).
- [infrastructure] `gen-railway-configs.mjs` step omitted: **accepted.** Added the explicit generate-and-commit step (§8.4).
- [minors] All accepted: dropped `dims` from v1 (§3.1); draft resolve-check on `/versions`+`/certify` (§6, §4.2); UI ranks correlation below certified drivers + wedge wording (§1, §2.1, §5); `explanation.ready` payload refs-only + `/explanations` per-user filter (§4.2, §4.3); distinct off-peak retention cron + recorded "explain never reads snapshots" invariant (§2.1, §6); narrative-only retry re-emits WS event (§6); `threshold_breached` leak-safety unit test (§9); Dockerfile deps-stage `COPY apps/basis/package.json` (§8.2).

**Rejected this round:** none.

**Round 1 (prior):** all blockers/majors/minors accepted; leak fix (per-user correlation), org-bypass fix, SPA-build/nginx/ingress fixes, snapshot idempotency, partitioning/retention, cache identity, LLM injection/PII, Redis confirm tokens, shared Zod + Drizzle modules, expanded permissions, runtime-dependency posture. Two accept-with-mod: entity-type mapping at the boundary; `entity_links` narrowed to human-pinned links. (Several round-1 items were themselves re-opened and hardened in round 2, above.)
