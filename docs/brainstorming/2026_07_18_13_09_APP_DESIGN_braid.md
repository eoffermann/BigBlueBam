# Braid - App Design Specification

> The identity-resolution substrate for BigBlueBam. Braids every app's records into one confidence-scored golden profile per real person or company, with human-in-the-loop merge review.
>
> Status: design draft (round 0, new app). Winner of the 2026-07-18 suite-brainstorm session.
> Chosen internal port: **4020** (first free port after Basis's 4019; 4015 is shared by blueprint/bureau, 4018 is blip, 4019 is basis).
> Routes: SPA at `/braid/`, REST at `/braid/api/`, realtime at `/braid/ws`.
> Chosen final name: **Braid** (single word). App id `braid`.

---

## 1. Overview & positioning

**One-liner.** Braid is an AI customer-data platform. Its agent-driven identity-resolution core clusters the member/record rows scattered across Bond, Helpdesk, Blast, Bill, and Book into one confidence-scored **golden profile** per real-world person or company, attaches an evidence trail to every link, and routes sub-threshold merges to a human reviewer. It exposes one flagship tool, `braid_resolve(entity)`, that returns the golden id for any app record, so every other app's counts, sends, and pipelines resolve to the same person.

**The wedge (why it won).** Braid is the *unification substrate* under the whole suite. Today the same customer exists as a Bond contact, three Helpdesk requesters, a Blast subscriber, and a Bill client, and nothing decides that they are one person. `entity_links` (`infra/postgres/migrations/0132_entity_links.sql`) already *stores* cross-app links and `dedupe_decisions` (`0136_dedupe_decisions.sql`) already *remembers* per-pair verdicts, but nothing in the platform *decides* identity across apps, scores its confidence, or maintains a durable golden record. Braid is the decider. Every count, every campaign send, every invoice-to-deal rollup gets more trustworthy the moment Braid resolves identity, and the value compounds with each app added to the suite. No SMB-priced tool ships evidence-scored, human-reviewed identity resolution across a whole app suite; it beats the manual reconciliation spreadsheet on the trust axis.

**Who it is for.** The org admin / RevOps / support-ops persona at a 2-50 seat team who today reconciles duplicates by hand and cannot trust any single "number of customers" figure.

**How it differs from the three apps it is most often confused with:**
- **Bench** (`apps/bench-api/`) *charts* data. Braid does not render charts or dashboards; it produces the golden entity that a chart's "distinct customers" measure should group by.
- **Basis** (`apps/basis-api/`, `docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md`) *defines a metric once and explains why it moved*. Braid does not define metrics; it resolves the *entities* a metric decomposes over. Basis and Braid are complementary: a Basis metric grouped by customer is only trustworthy if Braid has deduplicated the customers.
- **Bond** (`apps/bond-api/`) is a *CRM that owns contacts, companies, and deals*. Braid does not own source data and never edits a Bond contact. It reads Bond (and Helpdesk, Blast, Bill, Book) records and maintains a *separate* golden layer that points back at them. Bond's own `bond_find_duplicates` (`apps/mcp-server/src/tools/dedupe-tools.ts:72`) dedupes *within* Bond; Braid resolves *across* apps and produces a persistent golden record, not just a candidate list.

**In-scope apps for v1 source identities:** Bond (contacts, companies), Helpdesk (users/requesters), Blast (subscribers), Bill (clients), Book (bookers). Each is an entity type already present in `SUPPORTED_ENTITY_TYPES` or trivially addable (Section 2.4). Downstream consumers: Bond, Blast, Bill, and a future "Bridge" activation app (named only so the model leaves room; not built in v1).

**Out of v1 scope:** external-source ingestion (Salesforce/HubSpot import), household/B2B hierarchy graphs beyond a flat person-to-company link, and probabilistic ML training on customer decisions. All are Open Questions (Section 10).

---

## 2. AI-native design

Braid's AI core is **deterministic-plus-embedding identity resolution with human-in-the-loop merge review**. The scoring math is reproducible and auditable (every link carries an evidence JSON that reconstructs the score). An LLM is used only for a best-effort natural-language *rationale* on a proposed merge; it never decides a merge and never sees a raw amount or PII string that has not passed `can_access`.

### 2.1 The two-plane split (borrowed directly from the Basis pattern)

Braid keeps two computations in different trust planes, exactly as Basis separates certified drivers from per-viewer correlation (`docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md` Section 2.1):

1. **Deterministic match score (the shared, cached decision input).** For a candidate pair of identities, compute a reproducible score from typed features (email exact, phone exact, name trigram, company-domain, embedding cosine; Section 3 of the engine below). This score and its evidence JSON are stored on `braid_match_candidate` and are org-shared: two admins looking at the same candidate see the same score.
2. **Per-viewer evidence rendering (assembled at read time).** When a reviewer opens a candidate or a golden profile's timeline, every cited source record is passed through `can_access(asker_user_id, entity_type, entity_id)` (`apps/api/src/services/visibility.service.ts:1359`) and dropped fail-closed on deny. A support agent who cannot see a Bond deal never sees that deal in the evidence, even though it contributed to the shared score. The shared score is computed by the worker under a first-party service context; the *display* is access-scoped per reviewer.

**Invariant (record and rely on):** the golden record's field values (`braid_profile.attributes`) are produced by **survivorship over source values the merge decision authorized**, and are recomputed from scratch whenever the identity set changes. The golden record is a cache of a pure function of its member identities plus the survivorship rules; a split can always rebuild both halves deterministically.

### 2.2 Autonomy bands (the human-in-the-loop core)

Every candidate pair falls into one of three confidence bands, decided by the resolved score against per-org thresholds in `braid_org_settings` (defaults shown):

| Band | Score | Behavior |
| --- | --- | --- |
| **Auto-merge** | `>= auto_merge_threshold` (default 0.92) | The worker merges autonomously and emits `profile.merged`. Requires at least one *strong deterministic* signal (exact email or exact phone); an embedding-only high score never auto-merges (Section engine 3.4). Every auto-merge writes a `braid_merge_decision` row with `decided_by = <braid service account>` and `decision_kind = 'auto'`, so it is fully auditable and reversible. |
| **Review** | `[review_threshold, auto_merge_threshold)` (default 0.60-0.92) | The worker creates a `braid_match_candidate` row (status `pending`) AND registers an `agent_proposals` row (`proposed_action = 'braid.merge_profiles'`) so the pair lands in the human's single approval inbox (`0128_agent_proposals.sql`). No golden record changes until a human decides. |
| **No-op** | `< review_threshold` | Nothing is written except, optionally, a `dedupe_decisions` `needs_review` suppression so the pair is not rescored every tick. |

A human decision (`confirm` / `split` / `reject`) always wins over an auto-merge and is recorded in `braid_merge_decision`; a rejected pair writes a `dedupe_decisions` `not_duplicate` row (`entity_type = 'braid.identity'`) so the engine never re-surfaces it (reusing the exact suppression contract of `apps/mcp-server/src/tools/dedupe-tools.ts:184`).

### 2.3 Truth-changing actions are HITL-gated

Merging and splitting golden profiles change what the whole suite believes about "who is one customer," so they are gated the way `CLAUDE.md` mandates for destructive MCP actions:

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Resolve an app record to its golden id | Autonomous | `braid_resolve` |
| Read a golden profile / timeline | Autonomous, `can_access`-filtered per `asker_user_id` | `braid_get_profile`, `braid_profile_timeline` |
| List / search profiles and candidates | Autonomous | `braid_list_profiles`, `braid_search_profiles`, `braid_list_candidates` |
| **Propose** a merge for human review | Autonomous (writes a proposal only) | `braid_propose_merge` |
| **Merge** two golden profiles | HITL, Redis-backed confirm token | `braid_merge_profiles` |
| **Split** a golden profile | HITL, destructive, Redis-backed confirm token | `braid_split_profile` |
| Edit a survivorship rule | Permission-gated, no confirm token | `braid_set_survivorship_rule` |

Truth-flip tools use the Redis-backed dynamic-TTL confirm-token store (`apps/mcp-server/src/lib/confirm-token-store.ts`, 60s agent TTL / 5min human TTL), the pattern `CLAUDE.md` requires for delete-task / complete-sprint / remove-member.

### 2.4 Guardrails summary

- **agent_policies** (`0139_agent_policies.sql`, `apps/mcp-server/src/lib/register-tool.ts`): every `braid.*` service-account call passes the kill-switch + glob allowlist. `braid.*` is **not** in the always-permitted core (`get_server_info`/`get_me`/`agent_heartbeat`), so tools fail closed until an operator allowlists `braid.*`. Documented for operators and covered by a `register-tool` policy test.
- **can_access preflight** per requesting user at read time on every cited source record in a timeline, candidate evidence panel, or profile attribute provenance (Section 2.1 plane 2).
- **Prompt-injection / PII isolation:** the merge-rationale LLM call uses **only** the internal platform llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint, and receives **opaque identity tokens** (`IDENTITY_A`, `IDENTITY_B`) plus typed feature scores, never raw email/phone strings. Output is rendered plain text; the SPA re-hydrates labels client-side from structured evidence.
- **New entity types.** Braid registers `braid.profile` and `braid.identity` in `SUPPORTED_ENTITY_TYPES` (`apps/api/src/services/visibility.service.ts:91`) with an org-match gate (a golden profile is readable by any member of its org; there is no per-profile privacy enum in v1). Source-app entity types Braid cites (`bond.contact`, `helpdesk.ticket`, `bill.invoice`, `book.event`, and the new `blast.subscriber`) are already in the allowlist or added alongside; `blast.subscriber` and `bill.client` gaps are called out in Open Questions.

---

## 3. Data model

All Braid tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id`, matching `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Advisory until `BBB_RLS_ENFORCE=1`. Each table gets a 1:1 Drizzle module under `apps/braid-api/src/db/schema/` (`braid-profiles.ts`, `braid-identities.ts`, `braid-match-candidates.ts`, `braid-merge-decisions.ts`, `braid-survivorship-rules.ts`, `braid-org-settings.ts`, `index.ts`), mirroring `apps/bond-api/src/db/schema/` and `apps/basis-api/src/db/schema/`.

### 3.1 Tables

**`braid_profiles`** - the golden record.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | the golden id returned by `braid_resolve` |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `kind` | varchar(8) NOT NULL | `person` \| `company` |
| `display_name` | varchar(320) | survivorship-chosen label (denormalized for lists/search) |
| `primary_email` | varchar(320) | survivorship-chosen; nullable for `company` |
| `primary_phone` | varchar(64) | survivorship-chosen; nullable |
| `company_profile_id` | uuid | self-FK to a `kind='company'` profile (a person's employer); ON DELETE SET NULL |
| `attributes` | jsonb NOT NULL DEFAULT `'{}'` | full survivorship-resolved field map with per-field provenance: `{ "<field>": { value, source_identity_id, source_app, rule } }` |
| `identity_count` | integer NOT NULL DEFAULT 0 | denormalized member count |
| `confidence` | numeric(5,2) | min pairwise link confidence within the cluster (weakest-link) |
| `status` | varchar(10) NOT NULL DEFAULT `'active'` | `active` \| `merged_away` (superseded by another profile) \| `archived` |
| `merged_into_id` | uuid | when `status='merged_away'`, the surviving profile id; self-FK ON DELETE SET NULL |
| `search_vector` | tsvector | generated from `display_name`+emails for keyword search (GIN) |
| `qdrant_point_id` | uuid | mirror id in the Qdrant `braid_profiles` collection for embedding recall |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, id)` (implicit via PK, plus org filter), `(organization_id, kind, status)`, `(organization_id, primary_email)`, `(organization_id, primary_phone)`, GIN on `search_vector`, GIN on `attributes`.

**`braid_identities`** - one row per source-app record that maps into a golden profile. Cannot FK across app schemas, so the source is stored as a dotted type + uuid exactly like `entity_links.dst_type`/`dst_id`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_id` | uuid NOT NULL | FK `braid_profiles(id)` ON DELETE CASCADE |
| `source_type` | text NOT NULL | dotted entity type, e.g. `bond.contact`, `helpdesk.user`, `blast.subscriber`, `bill.client`, `book.booker` |
| `source_id` | uuid NOT NULL | the source-app row id |
| `match_keys` | jsonb NOT NULL DEFAULT `'{}'` | normalized blocking keys captured at ingest: `{ email_norm, phone_norm, name_norm, domain }` |
| `raw_attributes` | jsonb NOT NULL DEFAULT `'{}'` | snapshot of the source fields Braid read (for survivorship + evidence), refreshed on re-ingest |
| `linked_by` | uuid | FK `users(id)`; null for auto-links |
| `link_kind` | varchar(8) NOT NULL DEFAULT `'auto'` | `auto` \| `human` \| `seed` (the first identity that created the profile) |
| `linked_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, source_type, source_id)` (a source record maps to exactly one profile), `(profile_id)`, `(organization_id, source_type)`, GIN on `match_keys` (for blocking lookups by `email_norm`/`phone_norm`).

**`braid_match_candidates`** - the human review queue.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_a_id` / `profile_b_id` | uuid NOT NULL | the two golden profiles proposed to merge; `profile_a_id < profile_b_id` CHECK for a canonical pair |
| `score` | numeric(5,2) NOT NULL | resolved match score in [0,1] |
| `evidence` | jsonb NOT NULL | reproducible feature breakdown: `{ features: [{ kind, a_value_ref, b_value_ref, score, weight }], strong_signal: bool, model }` (values are refs, not raw PII; the SPA re-hydrates via `can_access`) |
| `rationale` | text | best-effort LLM prose over opaque tokens; nullable when the LLM leg failed |
| `status` | varchar(10) NOT NULL DEFAULT `'pending'` | `pending` \| `merged` \| `rejected` \| `superseded` |
| `proposal_id` | uuid | FK `agent_proposals(id)` when a proposal was registered; ON DELETE SET NULL |
| `created_at` / `decided_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, profile_a_id, profile_b_id)`, `(organization_id, status, score DESC)`, `(profile_a_id)`, `(profile_b_id)`.

**`braid_merge_decisions`** - the immutable audit trail for every merge, split, auto-merge, and reject.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `decision_kind` | varchar(8) NOT NULL | `auto` \| `merge` \| `split` \| `reject` |
| `surviving_profile_id` | uuid | for merge/auto: the winner; for split: the profile that was split |
| `absorbed_profile_id` | uuid | for merge/auto: the profile that was merged away |
| `affected_identity_ids` | jsonb NOT NULL DEFAULT `'[]'` | the `braid_identities` ids moved by this decision (lets a split replay exactly which rows to detach) |
| `candidate_id` | uuid | FK `braid_match_candidates(id)` when the decision resolved a candidate; ON DELETE SET NULL |
| `score_at_decision` | numeric(5,2) | |
| `decided_by` | uuid NOT NULL | FK `users(id)`; the Braid service account for `auto` |
| `decided_by_kind` | actor_type NOT NULL | reuses the platform `actor_type` enum (`human`/`agent`/`service`) |
| `reason` | text | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | never updated or deleted |

Indexes: `(organization_id, created_at DESC)`, `(surviving_profile_id, created_at DESC)`, `(candidate_id)`.

**`braid_survivorship_rules`** - per-org, per-field winner selection.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `kind` | varchar(8) NOT NULL | `person` \| `company` (rules are scoped by profile kind) |
| `field` | varchar(64) NOT NULL | golden attribute name, e.g. `display_name`, `primary_email`, `primary_phone`, `title` |
| `strategy` | varchar(20) NOT NULL | `most_recent` \| `source_priority` \| `longest_non_null` \| `most_frequent` \| `manual_pin` |
| `source_priority` | jsonb NOT NULL DEFAULT `'[]'` | ordered `source_type` list for the `source_priority` strategy, e.g. `["bond.contact","bill.client","helpdesk.user"]` |
| `pinned_value` | jsonb | for `manual_pin` |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, kind, field)`.

**`braid_org_settings`** - per-org tunables (modeled on `basis_org_settings`, `0226_basis_core.sql:73`). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE; `UNIQUE` |
| `auto_merge_threshold` | numeric(5,2) NOT NULL DEFAULT 0.92 | |
| `review_threshold` | numeric(5,2) NOT NULL DEFAULT 0.60 | |
| `require_strong_signal_for_auto` | boolean NOT NULL DEFAULT true | if true, embedding-only high scores route to review, never auto-merge |
| `enabled_source_types` | jsonb NOT NULL DEFAULT `'[]'` | which app source types are ingested (opt-in per org) |
| `rescan_max_age_days` | integer | null = never expire a candidate; else stale `pending` candidates are re-scored |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): Braid writes durable `braid.profile -> <source_type>` links with `link_kind='related_to'` when a profile absorbs an identity, so `resolve_references` / `account_view` can traverse "everything linked to this golden profile" without knowing Braid's schema. `ON CONFLICT DO NOTHING`.
- `dedupe_decisions` (`0136_dedupe_decisions.sql`): reject verdicts written with `entity_type='braid.identity'` so rejected pairs are never re-surfaced (canonical ordered-pair contract).
- `agent_proposals` (`0128_agent_proposals.sql`): review-band candidates register a proposal so humans get one inbox.
- `organizations`, `users`, and the platform `actor_type` enum.

### 3.3 JSONB shapes (authoritative)

```jsonc
// braid_profiles.attributes
{
  "display_name": { "value": "Thurston Howell III", "source_identity_id": "…", "source_app": "bond.contact", "rule": "source_priority" },
  "primary_email": { "value": "howell@…", "source_identity_id": "…", "source_app": "bill.client", "rule": "most_recent" }
}

// braid_match_candidates.evidence
{
  "features": [
    { "kind": "email_exact",      "score": 1.0, "weight": 0.45, "a_value_ref": "id_a#email", "b_value_ref": "id_b#email" },
    { "kind": "name_trigram",     "score": 0.86, "weight": 0.20 },
    { "kind": "embedding_cosine", "score": 0.91, "weight": 0.20 },
    { "kind": "phone_exact",      "score": 0.0,  "weight": 0.15 }
  ],
  "strong_signal": true,
  "model": "braid-score-v1"
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed migration tip on this branch is `0229_permissions_seed_actions_delta_020.sql`. **All numbers below are provisional** and must be re-verified at implement time because any other branch landing a migration first invalidates the numbering. Every file carries the header block (`-- Why:` / `-- Client impact:`) and uses idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guarded `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for enums/FKs, guarded destructive ALTERs), matching `CLAUDE.md` migration conventions.

1. **`0230_braid_core.sql`** - `braid_profiles`, `braid_identities`, `braid_survivorship_rules`, `braid_org_settings`, all indexes, RLS policies on `app.current_org_id`. The `braid_profiles.company_profile_id` / `merged_into_id` self-FKs are added via guarded `DO $$` blocks after the table exists (avoids circular create order, mirrors `0226_basis_core.sql:62-68`). Additive only.
2. **`0231_braid_candidates_decisions.sql`** - `braid_match_candidates` (with the `profile_a_id < profile_b_id` CHECK and the `proposal_id` FK to `agent_proposals`), `braid_merge_decisions`, indexes, RLS. Additive only.
3. **`NNNN_permissions_seed_actions_delta_0MM.sql`** - **generated** by re-running `scripts/build-permission-delta.mjs` after regenerating `docs/permissions-action-manifest.json` with the `braid.*` verb set (Section 4.4). Do not hand-pick the number or delta suffix; the generator assigns `max(4-digit files)+1`. Must run only after the two hand-authored files are on disk. Additive only.

Bolt event registration (Section 7) and the `SUPPORTED_ENTITY_TYPES` additions (Section 2.4) are TypeScript edits, not migrations. The Qdrant `braid_profiles` collection is created idempotently at `braid-api` boot (like Beacon/Bond's collections), not by SQL.

---

## 4. Identity-resolution engine

The engine runs as a **BullMQ worker** in `apps/worker` (queue `braid-match-on-ingest`), not in the request path, so a burst of source-app writes never blocks a user. It is triggered two ways: live match-on-ingest (Bolt event subscription) and a nightly re-scan. It is emphatically **not** a quarterly batch.

### 4.1 Ingest and normalization

When a source record changes, Braid captures a `braid_identity` (upsert on `(org, source_type, source_id)`) with normalized `match_keys`:
- `email_norm`: lowercased, trimmed, plus-address stripped for gmail-class domains.
- `phone_norm`: E.164 where parseable, else digits-only.
- `name_norm`: lowercased, punctuation-stripped, unicode-folded.
- `domain`: email domain, dropping free-mail domains (gmail/outlook/etc) so a shared free-mail domain is not a company signal.

### 4.2 Blocking / candidate generation (reuse-first)

Rather than compare every pair (O(n^2)), Braid generates candidates three cheap ways and unions them:
1. **Exact-key blocking (SQL).** GIN lookups on `braid_identities.match_keys` for identities sharing `email_norm` or `phone_norm`. This is the high-precision path and is pure Postgres.
2. **Fuzzy-name blocking (SQL, pg_trgm).** Trigram similarity on `name_norm`, the same `pg_trgm` mechanism `bond_find_duplicates` already uses (`apps/mcp-server/src/tools/dedupe-tools.ts:75` describes the `pg_trgm` full-name similarity path). Braid does not reinvent trigram scoring; it applies the same function class over its `braid_identities` rows.
3. **Embedding recall (Qdrant).** For each new identity, embed `name + email-local-part + company` and query the Qdrant `braid_profiles` collection for nearest neighbors. Qdrant is already in-stack for Beacon/Brief/Bond semantic retrieval (`CLAUDE.md` Data section), so this reuses the existing vector service and the platform llm-provider embedding endpoint. Cross-app candidate discovery also uses `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`) when a reviewer manually searches for a person to merge in the UI.

Qdrant-down degrades to keyword+key blocking only (paths 1 and 2), matching the Basis "Qdrant-down -> keyword-only" posture. The engine never blocks on Qdrant.

### 4.3 Scoring features

For each candidate pair, compute a weighted score from typed features (weights are per-org-overridable in a later version; v1 ships the defaults in `evidence.model = 'braid-score-v1'`):

| Feature | Signal | Default weight | Strong? |
| --- | --- | --- | --- |
| `email_exact` | `email_norm` equal | 0.45 | yes |
| `phone_exact` | `phone_norm` equal | 0.15 | yes |
| `name_trigram` | pg_trgm similarity on `name_norm` | 0.20 | no |
| `embedding_cosine` | Qdrant cosine on the identity embedding | 0.15 | no |
| `domain_match` | same company `domain` | 0.05 | no |

Score = sum(feature_score * weight), clamped to [0,1]. `strong_signal = email_exact OR phone_exact`.

### 4.4 Decision bands and survivorship

The resolved score routes into the three bands of Section 2.2, read from `braid_org_settings`. The `require_strong_signal_for_auto` gate means a 0.95 built entirely from name+embedding routes to **review**, not auto-merge (an embedding "looks like the same name" is never sufficient to silently merge two customers). On a merge (auto or human-confirmed):
1. Pick a surviving profile (the older, or the one with more `human`/`seed` identities).
2. Move all `braid_identities` of the absorbed profile to the survivor; set the absorbed profile `status='merged_away'`, `merged_into_id=survivor`.
3. **Recompute survivorship** for every golden field from `braid_survivorship_rules` over the union of member identities' `raw_attributes`, rewriting `braid_profiles.attributes` with fresh provenance (Section 2.1 invariant).
4. Write a `braid_merge_decisions` row (kind `auto` or `merge`), write/refresh `entity_links`, re-embed the survivor into Qdrant, emit `profile.merged`.

### 4.5 Unmerge / split (with audit)

A split reverses a specific merge decision. `braid_split_profile` takes a `profile_id` and a set of `identity_ids` to detach (or a `merge_decision_id` to replay). The engine:
1. Creates a fresh profile, moves the named identities to it, recomputes survivorship on **both** profiles.
2. Writes a `braid_merge_decisions` row (kind `split`) referencing the reversed decision, so the audit chain is complete and a subsequent re-merge is itself audited.
3. Emits `profile.split`. Because `braid_merge_decisions.affected_identity_ids` recorded exactly which rows a merge moved, a split can target precisely the earlier merge's rows rather than guessing.

### 4.6 Where it runs

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `braid-match-on-ingest` | event-driven (BullMQ, fed by the Bolt event subscription in Section 6) | Normalize the changed source record into a `braid_identity`, block, score, and route to a band. Idempotent: re-processing the same source version re-derives the same identity row (`ON CONFLICT`) and the same candidates. |
| `braid-rescan` | daily (`20 3 * * *`, non-zero minute to avoid collisions) | Re-score stale `pending` candidates past `rescan_max_age_days`, re-embed drifted profiles, and re-block identities whose source record changed while Braid was down. Try/catch log-and-continue per `(org, identity)` with `@bigbluebam/logging` progress lines (start with elapsed, per-N progress, completion with duration) per the user-wide logging rule. |

Both jobs fan out cross-org using the **secret + explicit `org_id`** worker pattern (present `INTERNAL_SERVICE_SECRET`, set `app.current_org_id` per org), exactly as `banter-feed-fanin` does and as Basis's workers do.

---

## 5. API surface

Base path `/braid/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler` (`apps/basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Request/response shapes live in `packages/shared/src/schemas/braid.ts`, imported by both `braid-api` and the SPA.

### 5.1 REST endpoints

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/v1/profiles` | List golden profiles | filters (`kind`, `status`), cursor; `requireAuth`, org from `request.user.org_id`; perm `braid.profile.read` |
| GET | `/v1/profiles/:id` | Get a golden profile + attributes + provenance | |
| GET | `/v1/profiles/:id/identities` | List the member source identities | each identity's source record is `can_access`-checked for the caller; denied rows return a masked stub |
| GET | `/v1/profiles/:id/timeline` | Cross-app timeline of the golden person | UNIONs the member identities' activity via `v_activity_unified` + `bolt_recent_events`, each row `can_access`-filtered per caller (Section 2.1 plane 2) |
| GET | `/v1/profiles/:id/decisions` | Merge/split audit history | reads `braid_merge_decisions` |
| POST | `/v1/resolve` | Resolve a source record to its golden id | body `{ source_type, source_id }`; returns `{ profile_id, confidence, identity_count }` or 404; perm `braid.profile.read`; the REST twin of the flagship MCP tool |
| GET | `/v1/candidates` | List review-queue candidates | filter `status`, sort `-score`; perm `braid.candidate.read` |
| GET | `/v1/candidates/:id` | Candidate detail + evidence | evidence value-refs re-hydrated per caller via `can_access` |
| POST | `/v1/candidates/:id/merge` | Confirm a merge | perm `braid.profile.merge`; writes decision, runs the engine merge (Section 4.4); emits `profile.merged`; resolves the linked `agent_proposals` row |
| POST | `/v1/candidates/:id/reject` | Reject a candidate | perm `braid.profile.merge`; writes a `dedupe_decisions` `not_duplicate` row so it never re-surfaces |
| POST | `/v1/profiles/merge` | Merge two profiles directly (no candidate) | body `{ profile_a_id, profile_b_id, reason }`; perm `braid.profile.merge` |
| POST | `/v1/profiles/:id/split` | Split a profile | body `{ identity_ids?, merge_decision_id?, reason }`; perm `braid.profile.split`; emits `profile.split` |
| GET | `/v1/survivorship-rules` | List rules | perm `braid.rule.read` |
| PUT | `/v1/survivorship-rules/:kind/:field` | Upsert a rule | perm `braid.rule.write` |
| GET | `/v1/settings` | Get org settings (thresholds, enabled sources) | perm `braid.settings.read` |
| PATCH | `/v1/settings` | Update org settings | perm `braid.settings.write` |
| GET | `/health` / `/readyz` | Probes | `/readyz` checks **only Postgres + Redis** so a Qdrant or source-app outage never cascades into Braid "not ready" (mirrors `apps/basis-api/src/server.ts:76`) |

### 5.2 Realtime (`/braid/ws`)

Redis-PubSub, org-scoped rooms (reusing the cross-instance PubSub pattern `CLAUDE.md` describes for WebSocket realtime). Payloads are **refs-only**: `candidate.created { candidate_id, score }`, `profile.merged { surviving_profile_id, absorbed_profile_id }`, `profile.split { profile_id }`. No PII or evidence in the socket frame; the SPA fetches through the per-caller `can_access`-filtered read path. Notification channel only.

### 5.3 Permissions

Manifest-generated in `docs/permissions-action-manifest.json`, `app.resource.verb` (the `@bigbluebam/permissions` catalog, resolved by `apps/basis-api/src/plugins/permissions.ts`-style plugin): `braid.profile.read`, `braid.profile.merge`, `braid.profile.split`, `braid.candidate.read`, `braid.rule.read`, `braid.rule.write`, `braid.settings.read`, `braid.settings.write`. Regenerating the catalog produces the delta migration (Section 3.4).

---

## 6. Background work

BullMQ workers in `apps/worker` (`apps/worker/src/worker.ts` convention). The two Braid jobs (`braid-match-on-ingest`, `braid-rescan`) are described in Section 4.6. In addition:

**Bolt event subscription (match-on-ingest trigger).** Braid subscribes to the upsert/create events its source apps already publish and enqueues a `braid-match-on-ingest` job per event:
- `bond` `contact.upserted` / `company.upserted`
- `helpdesk` `user.upserted` (the `helpdesk_upsert_user` write-plane tool, `CLAUDE.md` Wave 4)
- `bill` client create/update
- `blast` subscriber create/update
- `book` booker create

The subscription reuses the platform outbound-event mechanism; Braid registers as an internal consumer rather than an HMAC webhook runner. Every job payload is refs-only (`{ org_id, source_type, source_id }`); the worker re-reads the source record server-to-server so it never trusts stale event payload for the golden attributes. `removeOnComplete`/`removeOnFail` are set; the shared 256MB noeviction Redis holds only refs.

All fan-out sets `app.current_org_id` per org and wraps each `(org, record)` in try/catch log-and-continue, resumable because identity upsert (`ON CONFLICT`) and candidate upsert are no-ops on replay.

---

## 7. Events & integration

### 7.1 Bolt events published (source `braid`)

Via `publishBoltEvent(eventType, 'braid', payload, orgId, actorId?, actorType?)` (`packages/shared/src/bolt-events.ts:35`), bare names, each registered with a `payload_schema` in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI (the guard scans every `publishBoltEvent` call site under `apps/`, including the worker emit sites).

| `event_type` | When | Payload (refs + magnitude only) |
| --- | --- | --- |
| `profile.merged` | two profiles merged (auto or human) | `profile.id` (survivor), `absorbed_profile_id`, `identity_count`, `decision_kind` (`auto`/`merge`), `actor.*`, `org.*` |
| `profile.split` | a profile split | `profile.id`, `new_profile_id`, `moved_identity_count`, `actor.*`, `org.*` |
| `profile.matched` | a new identity auto-linked into an existing profile below the merge bar | `profile.id`, `identity.source_type`, `identity.source_id`, `org.*` |
| `candidate.created` | a review-band candidate was queued | `candidate.id`, `profile_a_id`, `profile_b_id`, `score`, `org.*` |

These events let Bolt automations react (for example, a Bolt rule could re-run a Blast segment when `profile.merged` fires) and are the way Braid appears in downstream flows. Payloads carry refs and scores, never raw PII strings.

### 7.2 entity_links

On every profile-to-identity link, Braid upserts an `entity_links` row (`src_type='braid.profile'`, `dst_type=<source_type>`, `link_kind='related_to'`, `ON CONFLICT DO NOTHING`) so `resolve_references`, `account_view`, and `search_everything` can traverse a golden profile's members without knowing Braid's schema.

### 7.3 Unified activity & search

Register a **Braid provider in `search_everything`** (`apps/mcp-server/src/tools/search-tools.ts`) so agents and the command palette can find golden profiles by name/email, fail-closed on the asker rule. Braid catalog changes flow as the Bolt events above, not into the fixed `v_activity_unified` UNION in v1 (that view is bam/bond/helpdesk only; extending it is an Open Question). The profile **timeline** endpoint *reads* `v_activity_unified` and `bolt_recent_events` for its member identities.

---

## 8. Infrastructure

### 8.1 New api compose service

`braid-api` in `docker-compose.yml`, modeled on `basis-api` (`docker-compose.yml:798`): `PORT: 4020`, stateless, horizontally scalable. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Per the sibling-dependency pattern, the source apps (bond-api, helpdesk-api, bill-api, blast-api, book-api) and Qdrant are **NOT** in `braid-api.depends_on`; they are request-time, circuit-broken dependencies and live only in the deploy-catalog `needs`. Env: `DATABASE_URL`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, **`INTERNAL_SERVICE_SECRET` (non-empty)**, `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `QDRANT_URL`, `CORS_ORIGIN`, rate-limit knobs. Healthcheck: `curl -sf http://localhost:4020/health`.

### 8.2 SPA build (the SPA is not its own service)

Every SPA is built in the single `apps/frontend/Dockerfile` multi-stage build and `COPY`'d into `/usr/share/nginx/html/<app>`. Braid edits it in **five places mirroring the basis lines**: (1) deps-stage `COPY apps/braid/package.json`, (2) deps-stage source `COPY apps/braid`, (3) build-stage `COPY`, (4) add `pnpm --filter @bigbluebam/braid build` to the build `RUN`, (5) production `COPY apps/braid/dist` -> `html/braid`. Cross-check every place that hardcodes the app list. There is **no** separate `braid` compose service.

### 8.3 nginx routing (ALL THREE configs)

Add `/braid/`, `/braid/api/`, `/braid/ws` blocks **and** the static-asset cache-regex entry to all three mainline configs, matching how basis appears in each:
- `infra/nginx/nginx.conf` (basis at lines 298-316): alias + SPA fallback; `/braid/api/` -> `http://braid-api:4020/`; `/braid/ws` -> `http://braid-api:4020/ws` with upgrade headers. Add `braid` to the static-asset regex alternation (`nginx.conf:670`).
- `infra/nginx/nginx-with-site.conf` (basis at 396-414): same blocks; the site-profile entrypoint (`docker-compose.yml` bind-mounts it as `site.conf.template`). Omitting it 404s `/braid/` in any site-profile stack. Add `braid` to the static-asset regex (`nginx-with-site.conf:748`).
- `infra/nginx/nginx.railway.conf` (basis at 474-495): **different form** - `set $rw_upstream_47 "braid-api.railway.internal";` for `/braid/ws` and `set $rw_upstream_48 "braid-api.railway.internal";` for `/braid/api/` (basis used indices 21/22; the highest current index is 46, so **47/48 are the next free pair**), `rewrite ^/braid/api/(.*)$ /$1 break;`, `rewrite ^/braid/ws(.*)$ /ws$1 break;`, `proxy_pass http://$rw_upstream_NN:8080;` (**port 8080, not 4020**). Add `braid` to the static-asset regex (`nginx.railway.conf:876`). Mirror the basis block exactly.

**Ingress crash-safety:** because nginx (compose form) resolves literal upstreams at load and crashloops on host-not-found, add **`braid-api` (`condition: service_healthy`) to the `frontend` service `depends_on`** in `docker-compose.yml`, exactly as basis-api was added.

### 8.4 Deploy catalog, Railway manifests, MCP wiring, Launchpad

- `scripts/deploy/shared/services.mjs`: add a `braid-api` `APP_SERVICES` block (port `4020`, `public_paths: ['/braid/api/','/braid/ws']`, `needs: ['postgres','redis','api','bond-api','helpdesk-api','bill-api','blast-api','book-api','qdrant']`); add `/braid/` to the `frontend` entry's `public_paths` and `braid-api` to its `needs`; add `braid-api` to `mcp-server`'s `needs`/`depends_on`. Add `BRAID_API_URL: http://braid-api:4020/v1` to `mcp-server` env in compose and catalog; register `braid-tools.ts` in the MCP bootstrap.
- **Run `node scripts/gen-railway-configs.mjs`** and commit the new `railway/braid-api.json` + updated `railway/frontend.json`.
- **Launchpad catalog row** in `apps/api/src/routes/system-settings.routes.ts`: add `'braid'` to `LAUNCHPAD_APP_IDS` (`:61`) and a `LAUNCHPAD_CATALOG` entry (`:97`): `{ id: 'braid', name: 'Braid', description: 'Customer Identity', icon_name: 'git-merge', color: '#4338ca', path: '/braid/' }`. The `git-merge` Lucide icon reads as "braid two strands into one"; add it to the `ICONS` table in `launchpad.tsx` if not already present. Add `'braid'` to `ROOT_REDIRECT_VALUES` if the app should be a valid root target.
- **Runtime-dependency posture:** `/readyz` checks **only Postgres + Redis**. Source-app reads and Qdrant use a short timeout + circuit breaker returning typed `UPSTREAM_UNAVAILABLE`; the ingest worker skips-and-reschedules on a source 5xx; the merge-rationale LLM call is best-effort; Qdrant-down degrades to key+trigram blocking. Stateful deps are Postgres + Redis + Qdrant (Qdrant is soft).

### 8.5 SPA structure and blue theme

`apps/braid/` React SPA at `/braid/`, on the shared Bam UI shell, modeled on `apps/basis/` (`app.tsx`, `main.tsx`, `pages/`, `stores/`, `lib/`). TanStack Query v5 for server state, Zustand for the auth store (`apps/basis/src/stores`), `@bigbluebam/ui` primitives, the suite-wide Bureau docked-box widget (`@bigbluebam/bureau-client`), and the blue theme (`color: #4338ca`, indigo, adjacent to Basis's `#4f46e5`). Types from `packages/shared/src/schemas/braid.ts`.

Pages:
1. **Profile Catalog** - table of golden profiles with kind badge, member count, confidence, primary email/phone, and a "review pending" indicator. Keyword + embedding search box (backed by `search_everything`).
2. **Golden Profile Detail** - resolved attributes with per-field provenance ("email from Bill client, chosen by most_recent"), the member-identity list (each with a `can_access`-gated deep link to the source app), the **cross-app timeline**, and the merge/split audit history. Split action is permission-gated and confirm-token-gated.
3. **Merge Review Queue** - the `braid_match_candidates` list sorted by score, each card showing the side-by-side evidence panel (feature scores, re-hydrated per viewer), the LLM rationale, and Confirm / Reject buttons wired to the `agent_proposals` inbox.
4. **Survivorship Rules Editor** - per-kind, per-field strategy picker with a source-priority drag list.
5. **Settings** - thresholds (`auto_merge_threshold`, `review_threshold`), `require_strong_signal_for_auto` toggle, enabled source types, rescan window; persisted to `braid_org_settings`.

---

## 9. MCP surface

New `apps/mcp-server/src/tools/braid-tools.ts` via `registerTool` (`apps/mcp-server/src/lib/register-tool.ts`), HTTP client shaped like `apps/mcp-server/src/tools/dedupe-tools.ts:38` and `bond-tools`. Env `BRAID_API_URL=http://braid-api:4020/v1`. Read tools that surface source records require an explicit `asker_user_id` (per `docs/reference/agent-conventions.md`) and fail-closed via `can_access`; truth-flip tools use the Redis confirm-token store.

| Tool | Backs | Autonomy | confirm_action |
| --- | --- | --- | --- |
| `braid_resolve` | POST `/v1/resolve` | read (flagship; returns golden id for any `{source_type, source_id}`) | no |
| `braid_get_profile` | GET `/v1/profiles/:id` | read | no |
| `braid_list_profiles` / `braid_search_profiles` | GET `/v1/profiles` | read | no |
| `braid_profile_timeline` | GET `/v1/profiles/:id/timeline` | read, requires `asker_user_id`, `can_access`-filtered | no |
| `braid_list_candidates` | GET `/v1/candidates` | read | no |
| `braid_propose_merge` | registers an `agent_proposals` row | write (proposal only) | no (proposal IS the HITL) |
| `braid_merge_profiles` | POST `/v1/profiles/merge` (or `/candidates/:id/merge`) | truth-flip | **yes** (Redis token) |
| `braid_split_profile` | POST `/v1/profiles/:id/split` | truth-flip, destructive | **yes** (Redis token) |
| `braid_set_survivorship_rule` | PUT `/v1/survivorship-rules/:kind/:field` | write, permission-gated | no |

**agent_policies:** `braid.*` is added to the glob-allowlist space and is **not** in the always-permitted core, so every `braid_*` service-account call fails closed until an operator allowlists `braid.*` (`apps/mcp-server/src/lib/register-tool.ts`). Covered by a `register-tool` policy test.

**No-tool endpoints** (record in `docs/reference/mcp-endpoint-mapping.md`; keep coverage counts synced; run the zero-bare-dash grep): `/profiles/:id/identities`, `/profiles/:id/decisions` _(skip: folded into `braid_get_profile`)_; `/candidates/:id/reject` _(skip: reject is a human-only UI action; agents route via proposal decline)_; `/survivorship-rules` GET _(skip: folded into settings read)_; `/settings` GET/PATCH _(skip: org-admin config UI)_; `/braid/ws`, `/health`, `/readyz` _(skip: realtime/probe)_. Register a Braid provider in `search_everything`. The surface-map doc (`docs/reference/mcp-endpoint-mapping.md`) MUST be updated in the same change that adds these routes/tools.

---

## 10. Reuse ledger

| Capability | Reuses (real file/package) | New in Braid |
| --- | --- | --- |
| App scaffolding (Fastify server, plugins, health) | `apps/basis-api/src/server.ts`, `apps/bond-api/` layout | `braid-api` at port 4020 |
| Cross-app entity linking | `entity_links` (`0132_entity_links.sql`) | `braid.profile -> source` links written on every auto-link |
| Per-pair dedupe memory / never-resurface | `dedupe_decisions` (`0136_dedupe_decisions.sql`), `apps/mcp-server/src/tools/dedupe-tools.ts:184` | reject verdicts as `braid.identity` pairs |
| Within-app duplicate signals (pg_trgm, exact email/phone) | `bond_find_duplicates` (`dedupe-tools.ts:72`) | generalized to a cross-app blocking + weighted score |
| Embedding similarity | Qdrant (in-stack for Beacon/Brief/Bond), platform llm-provider embeddings | `braid_profiles` Qdrant collection + identity embeddings |
| HITL approval inbox | `agent_proposals` (`0128_agent_proposals.sql`) | review-band candidates register proposals |
| Confirm-action gating on truth-flips | `apps/mcp-server/src/lib/confirm-token-store.ts` | merge/split tokens |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts:1359`, `can_access` | new `braid.profile`/`braid.identity` types; read-time evidence filtering |
| Bolt events | `publishBoltEvent` (`packages/shared/src/bolt-events.ts:35`), catalog + `check-bolt-catalog.mjs` | 4 `profile.*`/`candidate.*` definitions |
| Cross-app timeline data | `v_activity_unified` (`0129_*`), `bolt_recent_events` | union over a golden profile's member identities |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` | Braid provider (fail-closed asker rule) |
| RLS / org scoping | `app.current_org_id` GUC (`0116_*`, `0132_*:52-56`) | Braid table policies |
| Per-action permissions | `@bigbluebam/permissions`, `apps/basis-api/src/plugins/permissions.ts` | 8 `braid.*` actions |
| MCP registration + policy gate | `apps/mcp-server/src/lib/register-tool.ts`, `dedupe-tools.ts` client pattern | 9 `braid_*` handlers |
| Cross-org worker fan-out (secret + explicit org_id) | `banter-feed-fanin` pattern; Basis workers | `braid-match-on-ingest`, `braid-rescan` |
| Org-settings table pattern (nullable = unbounded) | `basis_org_settings` (`0226_basis_core.sql:73`) | thresholds + enabled sources |
| Launchpad + nginx (3 configs) + frontend Dockerfile + services.mjs | basis wiring (all cited above) | one new app id `braid` |
| Suite-wide UI shell + Bureau widget | `@bigbluebam/ui`, `@bigbluebam/bureau-client` | Braid SPA pages only |

---

## 11. Open questions & risks (human decision needed)

1. **`blast.subscriber` and `bill.client` are not yet in `SUPPORTED_ENTITY_TYPES`** (`apps/api/src/services/visibility.service.ts:91` lists `bill.invoice` but not `bill.client`; Blast has no entity registered at all). Braid's timeline and evidence `can_access` checks on those source records will fail-closed (drop) until visibility branches are added. Decision: extend `visibility.service.ts` with `blast.subscriber`, `bill.client`, `helpdesk.user`, `book.booker` branches, or scope v1 sources to only the already-registered types (`bond.contact`, `bond.company`, `helpdesk.ticket`, `bill.invoice`, `book.event`). This is the single largest cross-team dependency.
2. **The source apps must emit the create/update Bolt events Braid subscribes to.** Bond/Helpdesk upsert events exist (`contact.upserted`, `helpdesk_upsert_user`); confirm Bill/Blast/Book emit typed create/update events with a stable record id, or Braid falls back to nightly `braid-rescan` polling only (no live match-on-ingest for those apps). This gates the "live, not quarterly batch" wedge claim for those apps.
3. **`v_activity_unified` is bam/bond/helpdesk only** (`0129_*`). A golden profile's timeline for Bill/Blast/Book activity must come from `bolt_recent_events`, so timeline completeness depends on those apps' event coverage. Extending the view is a platform-owned follow-up.
4. **Golden-record write-back.** v1 keeps the golden record read-only relative to source apps (Braid never edits a Bond contact). Whether a future version should push the golden email back into the source records (the "master data management" write-back) is a product decision with real blast-radius; deferred.
5. **Company hierarchy depth.** v1 models only a flat person-to-company link (`braid_profiles.company_profile_id`). Household/subsidiary graphs are out of scope.
6. **Threshold defaults per org.** The 0.92/0.60 bands are starting points. Whether to auto-tune from human accept/reject rates (a learning loop over `braid_merge_decisions`) is deferred; v1 is deterministic and operator-tuned.
7. **No human-provided secret is required.** All dependencies are internal (`INTERNAL_SERVICE_SECRET`, `QDRANT_URL`, `DATABASE_URL`, `REDIS_URL`) and already present in the stack. There is no external account, API key, or third-party credential to provision for v1.

---

## Changelog

- Initial draft (round 0). New app spec created from the 2026-07-18 suite-brainstorm winning description.
