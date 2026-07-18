# Braid - App Design Specification

> The identity-resolution substrate for BigBlueBam. Braids every app's records into one confidence-scored golden profile per real person or company, with human-in-the-loop merge review.
>
> Status: design draft, revised after adversarial review round 1. New app. Winner of the 2026-07-18 suite-brainstorm session.
> Chosen internal port: **4020** (first free port after Basis's 4019; 4015 is shared by blueprint/bureau, 4018 is blip, 4019 is basis).
> Routes: SPA at `/braid/`, REST at `/braid/api/`, realtime at `/braid/ws`.
> Chosen final name: **Braid** (single word). App id `braid`.

---

## 1. Overview & positioning

**One-liner.** Braid is an AI customer-data platform. Its agent-driven identity-resolution core clusters the person-and-company rows scattered across Bond, Bill, Helpdesk, and Book into one confidence-scored **golden profile** per real-world person or company, attaches an evidence trail to every link, and routes sub-threshold merges to a human reviewer. It exposes one flagship tool, `braid_resolve(entity)`, that returns a stable golden id for any app record, so every other app's counts, sends, and pipelines resolve to the same person.

**The wedge (why it won).** Braid is the *unification substrate* under the whole suite. Today the same customer exists as a Bond contact, a Bill client, three Helpdesk requesters, and a dozen Book event attendees, and nothing decides that they are one person. `entity_links` (`infra/postgres/migrations/0132_entity_links.sql`) already *stores* cross-app links and `dedupe_decisions` (`0136_dedupe_decisions.sql`) already *remembers* per-pair verdicts, but nothing in the platform *decides* identity across apps, scores its confidence, or maintains a durable golden record. Braid is the decider. Every count, every campaign audience, every invoice-to-deal rollup gets more trustworthy the moment Braid resolves identity, and the value compounds with each app added to the suite. No SMB-priced tool ships evidence-scored, human-reviewed identity resolution across a whole app suite; it beats the manual reconciliation spreadsheet on the trust axis.

**Who it is for.** The org admin / RevOps / support-ops persona at a 2-50 seat team who today reconciles duplicates by hand and cannot trust any single "number of customers" figure. This persona choice is load-bearing for the security model (Section 2.5): golden-profile reads default to an org-admin-equivalent permission tier because a golden profile is consolidated cross-app PII.

**How it differs from the three apps it is most often confused with:**
- **Bench** (`apps/bench-api/`) *charts* data. Braid does not render charts or dashboards; it produces the golden entity that a chart's "distinct customers" measure should group by.
- **Basis** (`apps/basis-api/`, `docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md`) *defines a metric once and explains why it moved*. Braid does not define metrics; it resolves the *entities* a metric decomposes over. A Basis metric grouped by customer is only trustworthy if Braid has deduplicated the customers.
- **Bond** (`apps/bond-api/`) is a *CRM that owns contacts, companies, and deals*. Braid does not own source data and never edits a Bond contact. It reads Bond (and Bill, Helpdesk, Book) records and maintains a *separate* golden layer that points back at them. Bond's own `bond_find_duplicates` (`apps/mcp-server/src/tools/dedupe-tools.ts:72`) dedupes *within* Bond; Braid resolves *across* apps and produces a persistent golden record, not just a candidate list.

**v1 source identities (re-derived from REAL schema in round 1).** Round 0 named fictional `blast.subscriber` and `book.booker` types. The real, backing-row source list is:

| Source type | Real backing table | Person/company | Notes |
| --- | --- | --- | --- |
| `bond.contact` | `apps/bond-api/src/db/schema/bond-contacts.ts` (`first_name`,`last_name`,`email`,`phone`) | person | has `owner_id`; per-owner visibility (Section 2.5) |
| `bond.company` | `bond-companies.ts` | company | org-readable (no owner) |
| `bill.client` | `apps/bill-api/src/db/schema/bill-clients.ts` (`name`,`email`,`phone`,`bond_company_id`) | person or company | org-readable; may already carry a `bond_company_id` hint |
| `helpdesk.user` | helpdesk requester/user table | person | mirrors helpdesk's real read predicate |
| `book.event_attendee` | `apps/book-api/src/db/schema/book-event-attendees.ts` (`email` NOT NULL, `name`, `event_id`) | person | **email-keyed, one row per booking** - many attendee rows for the same email cluster into one profile; the highest-volume, lowest-precision source |

**Blast is NOT a source identity type.** Blast has no per-person subscriber row: recipients are computed at send time from `blast_segments` over `bond_contacts` (`apps/worker/src/jobs/blast-send.job.ts`) plus `blast_unsubscribes` (`apps/blast-api/src/db/schema/blast-unsubscribes.ts`). Braid therefore does not ingest a Blast identity. Instead the golden profile carries an **email-suppression overlay** derived from `blast_unsubscribes` (a boolean `attributes.email_suppressed` keyed on the profile's `primary_email`), so a downstream "is this person unsubscribed" question resolves against the golden record without inventing a subscriber entity.

**Enabled-source gating (security-driven, Section 2.5 / 5.5).** A source type is *not* an ingest option for an org until (a) it has a verified visibility branch in `apps/api/src/services/visibility.service.ts` mirroring that app's authoritative read predicate, and (b) it is listed in `braid_org_settings.enabled_source_types`. If a person-level source cannot get a faithful visibility predicate this cycle, it is dropped from v1 rather than shipped as an org-match-only leak.

Downstream consumers: Bond, Bill, and a future "Bridge" activation app (named only so the model leaves room; not built in v1).

**Out of v1 scope:** external-source ingestion (Salesforce/HubSpot), household/B2B hierarchy graphs beyond a flat person-to-company link, and probabilistic ML training on decisions. All are Open Questions (Section 12).

---

## 2. AI-native design

Braid's AI core is **deterministic-plus-embedding identity resolution with human-in-the-loop merge review**. The scoring math is reproducible and auditable (every link carries an evidence JSON that reconstructs the score). An LLM produces only a best-effort natural-language *rationale* on a proposed merge; it never decides a merge and never sees a raw amount or PII string that has not passed `can_access`.

### 2.1 The two-plane split (borrowed from the Basis pattern)

Braid keeps two computations in different trust planes, exactly as Basis separates certified drivers from per-viewer correlation (`docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md` Section 2.1):

1. **Deterministic match score (the shared decision input).** For a candidate pair, compute a reproducible score from typed features (Section 4.3). The score, and the **full weight set snapshot** (not just the model name), are stored on `braid_match_candidates.evidence` so an old candidate re-renders deterministically even after thresholds/weights change (ST8). Two admins looking at the same candidate see the same score.
2. **Per-viewer PII rendering (assembled at read time).** The golden record's denormalized PII columns are an **internal worker cache**, never served raw to a non-admin caller. When any caller opens a profile, timeline, candidate, or search result, the returned attribute map and evidence are re-assembled per viewer from only the member identities that pass `preflightAccess` (`apps/api/src/services/visibility.service.ts:1359`); fields whose winning source the caller cannot see are dropped, and `identity_count` / member list are recomputed from only visible members (Section 2.5, S1/S3). The shared score is computed by the worker under a first-party service context; the *display* is access-scoped per viewer.

**Invariant (record and rely on).** A golden record's field values (`braid_profiles.attributes`) are a pure function of its member identities plus the survivorship rules, recomputed from scratch whenever the identity set changes. This invariant holds **only because** the recompute runs serialized under the per-blocking-key advisory lock and inside the single merge transaction (Section 4.4, ST1/ST2). A split can always rebuild both halves deterministically because every merge records exactly which identities it moved (`braid_merge_decisions.affected_identity_ids`).

### 2.2 Autonomy bands (the human-in-the-loop core)

Every candidate pair falls into one of three confidence bands, decided by the resolved score against per-org thresholds in `braid_org_settings` (defaults shown):

| Band | Score | Behavior |
| --- | --- | --- |
| **Auto-merge** | `>= auto_merge_threshold` (default 0.92) AND at least one strong deterministic signal (exact email or exact phone; an embedding-only high score never auto-merges, Section 4.3-4.4) | The worker merges autonomously (Section 4.4) and emits `profile.merged`. Every auto-merge writes a `braid_merge_decisions` row with `decision_kind='auto'`, `decided_by=<braid service account>`, so it is fully auditable and reversible. |
| **Review** | `[review_threshold, auto_merge_threshold)` (default 0.60-0.92), OR a high score with no strong signal | The worker creates a `braid_match_candidates` row (status `pending`) AND registers an `agent_proposals` row (`proposed_action='braid.merge_profiles'`, `subject_type='braid.profile'`) so the pair also lands in the human's approval inbox. No golden record changes until a human decides. |
| **No-op** | `< review_threshold` | Nothing is written except an identity-level `dedupe_decisions` `needs_review` suppression so the pair is not rescored every tick. |

**Single canonical decision path (round-1 D3 fix).** `proposal_decide` in `apps/api/src/routes/proposals.routes.ts` only flips `agent_proposals.status` (it maps `approve -> approved` and stops); it does **not** run a merge. To avoid the dual-inbox double-execute hazard, Braid has exactly one merge executor, `mergeCandidate(candidate_id, decided_by)`, reached two ways that converge on the same guarded code:
- The **REST** endpoints `POST /v1/candidates/:id/merge` and `/reject` (the UI surface) call it directly.
- A **Bolt subscription** on `proposal.decided`: when `proposed_action='braid.merge_profiles'` and the decision is `approve`, Braid calls the same `mergeCandidate`; on `reject`/`request_revision` it calls `rejectCandidate`.

Both entrypoints are made exactly-once by a **compare-and-swap** inside the merge transaction: `UPDATE braid_match_candidates SET status='merged' WHERE id=$1 AND status='pending' RETURNING id`; only the row that flips proceeds (ST3). This kills both the retry-double-merge and the human-vs-worker race, and reconciles the two inboxes: whichever surface fires first wins, the other no-ops, and the loser resolves its counterpart (the REST path resolves the linked `agent_proposals` row via `proposal_decide`; the subscription path stamps `braid_match_candidates.decided_at`).

A human decision (`merge` / `split` / `reject`) always wins over an auto-merge and is recorded in `braid_merge_decisions`; a rejected pair writes identity-level `dedupe_decisions` rows (Section 2.3) so the engine never re-surfaces it.

### 2.3 Reject-suppression keyed on stable atoms (round-1 D4 fix)

`dedupe_decisions` (`0136_dedupe_decisions.sql`) is keyed on an immutable canonical pair `(entity_type, id_a < id_b)`. A Braid candidate is a pair of golden **profiles** whose ids die on merge, so keying suppression on profile ids would let a rejected pair re-surface after either profile re-clusters, and `entity_type='braid.profile'` would be a type-lie. Instead, Braid suppresses on the **stable identity atoms** that bridged the two profiles:
- `braid_identities.id` is immutable and survives merge/split (identity rows move between profiles but keep their id).
- On reject, Braid writes `dedupe_decisions` rows with `entity_type='braid.identity'` for the identity pair(s) whose match generated the candidate (canonical `id_a < id_b`), `decision='not_duplicate'`.
- Re-blocking (Section 4.2) checks identity-level suppression **before** proposing any profile-pair merge: if the bridging identity pair is suppressed, the candidate is not regenerated.

This keeps `entity_type` honest (the atoms really are `braid_identities`), reuses the canonical ordered-pair contract of `dedupe-tools.ts:184` verbatim, and survives re-clustering.

### 2.4 Truth-changing actions are HITL-gated

Merging and splitting golden profiles change what the whole suite believes about "who is one customer," so they are gated the way `CLAUDE.md` mandates for destructive MCP actions:

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Resolve an app record to its golden id | Autonomous, requires `asker_user_id`, `preflightAccess` on the input record | `braid_resolve` |
| Read a golden profile / timeline | Autonomous, `can_access`-filtered per `asker_user_id`, admin-tier for the full view | `braid_get_profile`, `braid_profile_timeline` |
| List / search profiles and candidates | Autonomous, admin-tier or per-viewer-assembled | `braid_list_profiles`, `braid_search_profiles`, `braid_list_candidates` |
| **Propose** a merge for human review | Autonomous, but `preflightAccess` on both profiles' members for the proposing asker, rate-limited | `braid_propose_merge` |
| **Reject** a candidate | Permission-gated, writes identity-level suppression | `braid_reject_candidate` |
| **Merge** two golden profiles | HITL, Redis-backed confirm token | `braid_merge_profiles` |
| **Split** a golden profile | HITL, destructive, Redis-backed confirm token | `braid_split_profile` |
| Edit a survivorship rule | Permission-gated | `braid_set_survivorship_rule` |

Truth-flip tools use the Redis-backed dynamic-TTL confirm-token store (`apps/mcp-server/src/lib/confirm-token-store.ts`, 60s agent TTL / 5min human TTL), the pattern `CLAUDE.md` requires for delete-task / complete-sprint / remove-member.

### 2.5 Security model for consolidated PII (round-1 S1-S8)

A golden profile is the single richest PII object in the suite (it merges every app's copy of a person). Braid must not become a channel that downgrades any source app's access rules. Five read-path mechanisms plus three systemic ones enforce this:

1. **Admin-tier read default (S1a).** `braid.profile.read`, `braid.profile.resolve` (via `braid_resolve`), and `braid.candidate.read` default to an org-admin-equivalent permission, matching the stated RevOps/admin persona. Non-admins are not granted profile reads by default.
2. **Per-viewer attribute re-assembly (S1b, defense in depth).** Even for a granted non-admin caller, the returned `attributes` map is re-assembled at read time from only member identities that pass `preflightAccess`; a field whose winning source the caller cannot see is dropped. Bond's per-owner rule (`preflightBondContact`/`preflightBondDeal`, `visibility.service.ts:387-461` deny member/viewer non-owned contacts) is thereby preserved through Braid, not bypassed.
3. **`braid_resolve` is not a deanonymization oracle (S2).** `POST /v1/resolve` and the tool take `asker_user_id` and run `preflightAccess` on the **input** record first; a denied input returns `not_found` (never a golden id). `identity_count` is suppressed for non-admins (a raw member count is itself linkage disclosure). The fail-closed asker contract mirrors `docs/reference/agent-conventions.md`.
4. **No stub leakage (S3).** `/profiles/:id/identities` for a non-admin caller drops denied identities **entirely** (no masked stub, no `source_type` hint), and recomputes `identity_count` and the member list from only `can_access`-passing rows. The true cluster count is admin-only.
5. **Search is not a PII oracle (S4).** The `search_everything` Braid provider and `braid_search_profiles` restrict to admin askers and run per-viewer attribute assembly in the post-filter, fail-closed, matching `apps/mcp-server/src/tools/search-tools.ts` asker semantics. The `search_vector` (built from `display_name` + emails) is only ever queried under an admin asker.

**New visibility branches are in-scope v1 security work (S5/D7).** Braid registers `braid.profile` and `braid.identity` in `SUPPORTED_ENTITY_TYPES` (`visibility.service.ts:91`) and adds branches for the person-level source types it cites, each **mirroring that app's real authoritative read predicate**, with a unit test per branch:
- `bond.contact` / `bond.company`: already registered (`:426` / `:463`).
- `bill.client`: mirrors bill's real read predicate (bill list routes scope on org only, so org-match, same posture as the already-registered `bill.invoice` at `:1016`). Faithful to Bill's own authorization, not a careless stub.
- `helpdesk.user`: mirrors helpdesk's authoritative requester-read predicate (support-team org scope).
- `book.event_attendee`: gates through its parent `book.event` (org-match, mirroring `preflightBookEvent` at `:988`).

A source type is **not** enabled until its branch exists and its unit test passes (Section 5.5). If any of these cannot get a faithful predicate this cycle, it is dropped from v1 enabled sources rather than shipped as an org-match-only leak.

6. **Events are org-level linkage disclosure (S6).** `profile.merged` / `profile.split` / `candidate.created` broadcast to every org Bolt rule and subscribed agent runner with no per-user scoping, so they are kept **refs-only** and documented as org-level linkage side channels: `braid.*` outbound-webhook subscriptions require org-admin authorship and must never gain a PII field. To limit pairwise-linkage disclosure, `profile.merged` carries the **survivor** id plus the affected source-identity list (which the consumer already owns; needed for cache invalidation, ST5) but not the absorbed cluster's other members. Full pairwise linkage lives only on the immutable `braid_merge_decisions` audit table.
7. **`braid_propose_merge` guardrail (S7).** The proposing asker must pass `preflightAccess` on both profiles' member identities (or be admin); denied proposals are rejected, and proposal creation is rate-limited per agent to stop inbox spam and existence-probing.
8. **RLS enforced, not advisory (S8).** Braid is the first app to REQUIRE `BBB_RLS_ENFORCE=1` in its own deploy checklist (Section 9.1), because its entire table set is consolidated cross-app PII. A test asserts a cross-org `SELECT` on each `braid_*` table returns zero rows under the enforced role.

### 2.6 Guardrails summary

- **agent_policies** (`0139_agent_policies.sql`, `apps/mcp-server/src/lib/register-tool.ts`): every `braid.*` service-account call passes the kill-switch + glob allowlist. `braid.*` is **not** in the always-permitted core, so tools fail closed until an operator allowlists `braid.*`. Covered by a `register-tool` policy test.
- **can_access preflight** per requesting user at read time on every cited source record (input to resolve, timeline row, candidate evidence, profile attribute provenance).
- **Prompt-injection / PII isolation:** the merge-rationale LLM call uses **only** the internal platform llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint, and receives **opaque identity tokens** (`IDENTITY_A`, `IDENTITY_B`) plus typed feature scores, never raw email/phone strings. Output is rendered plain text; the SPA re-hydrates labels client-side from structured evidence.

---

## 3. Data model

All Braid tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id`, matching `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. **Round 1 posture: enforced, not advisory** (Section 2.5 point 8). Each table gets a 1:1 Drizzle module under `apps/braid-api/src/db/schema/` (`braid-profiles.ts`, `braid-identities.ts`, `braid-match-candidates.ts`, `braid-merge-decisions.ts`, `braid-survivorship-rules.ts`, `braid-org-settings.ts`, `index.ts`), mirroring `apps/bond-api/src/db/schema/` and `apps/basis-api/src/db/schema/`.

**Column-name join boundary (round-1 D8).** Braid uses `organization_id` on its own tables (matching basis/bond). The platform tables it joins to use `org_id` (`entity_links`, `dedupe_decisions`, `agent_proposals`). Any query crossing that boundary must alias explicitly; the mismatch is documented here so a builder does not assume a single name.

### 3.1 Tables

**`braid_profiles`** - the golden record.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | the golden id returned by `braid_resolve`; stable across merge via `merged_into_id` chain (Section 4.5) |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `kind` | varchar(8) NOT NULL | `person` \| `company` |
| `display_name` | varchar(320) | survivorship-chosen label; **internal cache, per-viewer re-assembled on read** |
| `primary_email` | varchar(320) | survivorship-chosen; internal cache; nullable for `company` |
| `primary_phone` | varchar(64) | survivorship-chosen; internal cache; nullable |
| `email_suppressed` | boolean NOT NULL DEFAULT false | Blast unsubscribe overlay keyed on `primary_email` (Section 1) |
| `company_profile_id` | uuid | self-FK to a `kind='company'` profile (a person's employer); ON DELETE SET NULL; resolved by a survivorship rule (Section 4.4) |
| `attributes` | jsonb NOT NULL DEFAULT `'{}'` | survivorship-resolved field map with per-field provenance `{ "<field>": { value, source_identity_id, source_app, rule } }`; internal cache |
| `identity_count` | integer NOT NULL DEFAULT 0 | denormalized true member count; suppressed / recomputed per viewer on read (S2/S3) |
| `confidence` | numeric(5,2) | `min()` over member identities' `link_confidence` (weakest-link; computable now that links carry a score, D5) |
| `status` | varchar(12) NOT NULL DEFAULT `'active'` | `active` \| `merged_away` \| `archived` |
| `merged_into_id` | uuid | when `status='merged_away'`, the surviving profile id; self-FK ON DELETE SET NULL |
| `search_vector` | tsvector | from `display_name`+emails (GIN); queried only under an admin asker (S4) |
| `qdrant_point_id` | uuid | mirror id in the Qdrant `braid_profiles` collection |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, kind, status)`, `(organization_id, primary_email)`, `(organization_id, primary_phone)`, `(merged_into_id)` (fast survivor-chain follow), GIN on `search_vector`, GIN on `attributes`.

**`braid_identities`** - one row per source-app record mapped into a golden profile. No cross-schema FK; the source is stored as a dotted type + uuid like `entity_links.dst_type`/`dst_id`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | immutable stable atom (survives merge/split); used for `dedupe_decisions` suppression (Section 2.3) |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_id` | uuid NOT NULL | FK `braid_profiles(id)` ON DELETE CASCADE |
| `source_type` | text NOT NULL | `bond.contact` \| `bond.company` \| `bill.client` \| `helpdesk.user` \| `book.event_attendee` |
| `source_id` | uuid NOT NULL | source-app row id |
| `match_keys` | jsonb NOT NULL DEFAULT `'{}'` | normalized blocking keys `{ email_norm, phone_norm, name_norm, domain }` |
| `raw_attributes` | jsonb NOT NULL DEFAULT `'{}'` | snapshot of source fields Braid read (survivorship + evidence), refreshed on re-ingest |
| `source_synced_at` | timestamptz | last time `raw_attributes` was refreshed from source; the rescan watermark (ST6) |
| `link_confidence` | numeric(5,2) | confidence of the link that attached this identity to its profile (D5); `seed` links are 1.0 |
| `link_evidence` | jsonb NOT NULL DEFAULT `'{}'` | the feature breakdown that justified the attach (drives the timeline "why this member joined") |
| `link_kind` | varchar(8) NOT NULL DEFAULT `'auto'` | `auto` \| `human` \| `seed` |
| `linked_by` | uuid | FK `users(id)`; null for auto/seed |
| `linked_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, source_type, source_id)` (a source record maps to exactly one profile), `(profile_id)`, `(organization_id, source_type)`, `(source_synced_at)` (watermark scan), GIN on `match_keys`.

**`braid_match_candidates`** - the human review queue. (Table name normalized to the plural everywhere, round-1 D8.)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_a_id` / `profile_b_id` | uuid NOT NULL | canonical `profile_a_id < profile_b_id` CHECK |
| `bridge_identity_a_id` / `bridge_identity_b_id` | uuid NOT NULL | the two `braid_identities` that matched and generated this candidate (the stable suppression atoms, Section 2.3) |
| `score` | numeric(5,2) NOT NULL | resolved match score in [0,1] |
| `evidence` | jsonb NOT NULL | `{ features: [...], strong_signal: bool, weights: {...}, model }` - the **full weight set** is snapshotted so old candidates re-render deterministically (ST8); values are refs, re-hydrated per viewer |
| `rationale` | text | best-effort LLM prose over opaque tokens; nullable |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `merged` \| `rejected` \| `superseded` |
| `proposal_id` | uuid | FK `agent_proposals(id)`; ON DELETE SET NULL |
| `created_at` / `decided_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, profile_a_id, profile_b_id)`, `(organization_id, status, score DESC)`, `(profile_a_id)`, `(profile_b_id)`, `(organization_id, status, created_at)` (retention sweep, ST8).

Status transitions (round-1 D8): `pending -> merged` (CAS on merge), `pending -> rejected` (reject), and `pending -> superseded` whenever a merge/split changes either referenced profile's cluster so the candidate no longer points at live `active` profiles. Every merge runs `UPDATE braid_match_candidates SET status='superseded' WHERE status='pending' AND (profile_a_id = :absorbed OR profile_b_id = :absorbed)` in the same transaction, so no candidate ever points at a `merged_away` id.

**`braid_merge_decisions`** - immutable audit for every merge, split, auto-merge, and reject.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `decision_kind` | varchar(8) NOT NULL | `auto` \| `merge` \| `split` \| `reject` |
| `surviving_profile_id` | uuid | merge/auto: the winner; split: the profile that was split |
| `absorbed_profile_id` | uuid | merge/auto: the profile merged away (reactivated on unmerge, Section 4.5) |
| `affected_identity_ids` | jsonb NOT NULL DEFAULT `'[]'` | the `braid_identities` ids moved by this decision (lets a split/unmerge replay exactly) |
| `reverses_decision_id` | uuid | for split/unmerge, the `braid_merge_decisions.id` being reversed; self-FK |
| `candidate_id` | uuid | FK `braid_match_candidates(id)`; ON DELETE SET NULL |
| `score_at_decision` | numeric(5,2) | |
| `decided_by` | uuid NOT NULL | FK `users(id)`; the Braid service account for `auto` |
| `decided_by_kind` | actor_type NOT NULL | reuses the platform `actor_type` enum (`human`/`agent`/`service`) |
| `reason` | text | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | never updated or deleted |

Indexes: `(organization_id, created_at DESC)`, `(surviving_profile_id, created_at DESC)`, `(candidate_id)`, `(reverses_decision_id)`.

**`braid_survivorship_rules`** - per-org, per-field winner selection.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `kind` | varchar(8) NOT NULL | `person` \| `company` |
| `field` | varchar(64) NOT NULL | golden attribute name, incl. `display_name`, `primary_email`, `primary_phone`, `title`, and **`company_profile_id`** (which employer wins on merge, round-1 D8) |
| `strategy` | varchar(20) NOT NULL | `most_recent` \| `source_priority` \| `longest_non_null` \| `most_frequent` \| `manual_pin` |
| `source_priority` | jsonb NOT NULL DEFAULT `'[]'` | ordered `source_type` list for `source_priority`, e.g. `["bond.contact","bill.client","helpdesk.user","book.event_attendee"]` |
| `pinned_value` | jsonb | for `manual_pin` |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, kind, field)`. The `company_profile_id` rule for a `person` profile resolves which linked employer-company profile survives when two people merge (default `most_recent` by `source_synced_at`).

**`braid_org_settings`** - per-org tunables (modeled on `basis_org_settings`, `0226_basis_core.sql:73`). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE; `UNIQUE` |
| `auto_merge_threshold` | numeric(5,2) NOT NULL DEFAULT 0.92 | prospective-only; changes re-evaluated by rescan, not retroactively applied (ST8) |
| `review_threshold` | numeric(5,2) NOT NULL DEFAULT 0.60 | |
| `require_strong_signal_for_auto` | boolean NOT NULL DEFAULT true | embedding-only high scores route to review, never auto-merge |
| `enabled_source_types` | jsonb NOT NULL DEFAULT `'[]'` | opt-in per org; a type is offered only if its visibility branch is verified (Section 2.5) |
| `rescan_max_age_days` | integer | null = never expire a candidate; else stale `pending` candidates re-scored |
| `last_rescan_at` | timestamptz | rescan watermark (ST6) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): Braid writes durable `braid.profile -> <source_type>` links (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`) so `resolve_references` / `account_view` / `search_everything` can traverse a golden profile's members. Note `org_id` here vs `organization_id` on Braid tables.
- `dedupe_decisions` (`0136_dedupe_decisions.sql`): reject and split verdicts as `entity_type='braid.identity'` on the immutable identity-pair atoms (Section 2.3 / 4.5).
- `agent_proposals` (`0128_agent_proposals.sql`): review-band candidates register a proposal.
- `organizations`, `users`, and the platform `actor_type` enum.

### 3.3 JSONB shapes (authoritative)

```jsonc
// braid_profiles.attributes (internal cache; per-viewer re-assembled on read)
{
  "display_name":  { "value": "Thurston Howell III", "source_identity_id": "…", "source_app": "bond.contact", "rule": "source_priority" },
  "primary_email": { "value": "howell@…",            "source_identity_id": "…", "source_app": "bill.client",  "rule": "most_recent" }
}

// braid_match_candidates.evidence (full weight set snapshotted, ST8)
{
  "features": [
    { "kind": "email_exact",      "score": 1.0,  "weight": 0.45, "a_value_ref": "id_a#email", "b_value_ref": "id_b#email" },
    { "kind": "name_trigram",     "score": 0.86, "weight": 0.20 },
    { "kind": "embedding_cosine", "score": 0.91, "weight": 0.20 },
    { "kind": "phone_exact",      "score": 0.0,  "weight": 0.15 }
  ],
  "strong_signal": true,
  "weights": { "email_exact": 0.45, "phone_exact": 0.15, "name_trigram": 0.20, "embedding_cosine": 0.15, "domain_match": 0.05 },
  "model": "braid-score-v1"
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed migration tip on this branch is `0229_permissions_seed_actions_delta_020.sql`. **All numbers below are provisional** and must be re-verified at implement time. Every file carries the header block (`-- Why:` / `-- Client impact:`) and uses idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guarded `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for enums/FKs), matching `CLAUDE.md` conventions.

1. **`0230_braid_core.sql`** - `braid_profiles`, `braid_identities` (incl. `link_confidence`/`link_evidence`/`source_synced_at`), `braid_survivorship_rules`, `braid_org_settings`, all indexes, RLS policies on `app.current_org_id`. Self-FKs (`company_profile_id`, `merged_into_id`) added via guarded `DO $$` blocks after the table exists (mirrors `0226_basis_core.sql:62-68`). Additive only.
2. **`0231_braid_candidates_decisions.sql`** - `braid_match_candidates` (with `profile_a_id < profile_b_id` CHECK, `bridge_identity_*`, `proposal_id` FK to `agent_proposals`), `braid_merge_decisions` (with `reverses_decision_id`), indexes, RLS. Additive only.
3. **`NNNN_permissions_seed_actions_delta_0MM.sql`** - **generated** (round-1 BP1/BP7). The `braid.*` rows will NOT be produced by the route scanner because `braid_` is not in `APP_PREFIXES` (`scripts/generate-permission-manifest.mjs:74`), exactly as `basis_` is hand-authored (`:719-776`). Strict sequence: (a) land `0230`/`0231` on disk; (b) register the 8 `braid.*` rows in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs`, mirroring the basis rows at `:768-776`, with `braid.profile.merge` and `braid.profile.split` flagged `is_destructive:true, requires_confirmation:true`; (c) regenerate the manifest and verify with `check-permission-catalog.mjs`; (d) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number and delta suffix (do not hand-pick). Additive only.

Bolt event registration (Section 7) and the `SUPPORTED_ENTITY_TYPES` additions (Section 2.5) are TypeScript edits, not migrations. The Qdrant `braid_profiles` collection is created **lazily on first use** (Section 9.5), not by SQL.

---

## 4. Identity-resolution engine

The engine runs as **BullMQ workers** in `apps/worker` (queue `braid-match-on-ingest`), not in the request path. It is triggered live by source-app events (Section 6) and by a nightly watermarked re-scan. It is emphatically not a quarterly batch.

### 4.1 Ingest and normalization

The worker reads the changed source row **directly via Postgres** (the worker already runs `bond-stale-deals` and `blast-send` against these schemas with its `DATABASE_URL`; no server-to-server HTTP is needed for source reads, round-1 IN2). It upserts a `braid_identity` (`ON CONFLICT (org, source_type, source_id) DO UPDATE`, refreshing `raw_attributes` and `source_synced_at`) with normalized `match_keys`:
- `email_norm`: lowercased, trimmed, plus-address stripped for free-mail domains.
- `phone_norm`: E.164 where parseable, else digits-only.
- `name_norm`: lowercased, punctuation-stripped, unicode-folded.
- `domain`: email domain, dropping free-mail domains so a shared free-mail domain is not a company signal.

### 4.2 Blocking / candidate generation (reuse-first, serialized)

Candidates come from three cheap unioned paths:
1. **Exact-key blocking (SQL).** GIN lookups on `braid_identities.match_keys` for identities sharing `email_norm` or `phone_norm`. High precision, pure Postgres.
2. **Fuzzy-name blocking (SQL, pg_trgm).** Trigram similarity on `name_norm`, the same `pg_trgm` mechanism `bond_find_duplicates` already uses (`dedupe-tools.ts:75`).
3. **Embedding recall (Qdrant).** Embed `name + email-local-part + company` and query the Qdrant `braid_profiles` collection for nearest neighbors, reusing the in-stack vector service and the platform llm-provider embedding endpoint. Cross-app manual search in the UI uses `search_everything`.

**Identity-level suppression check.** Before generating any profile-pair candidate, the engine checks `dedupe_decisions` for a `not_duplicate` verdict on the bridging identity pair (Section 2.3); suppressed pairs are skipped, which is also what stops merge/split flapping (ST4).

**Serialization to prevent duplicate golden profiles (round-1 ST1).** Concurrent ingest of two records for the same person must not each mint a seed profile. The create-or-attach step takes a Postgres transaction-scoped advisory lock on the strongest blocking key, `pg_advisory_xact_lock(hashtext(org_id || ':' || strongest_key))` (where `strongest_key` is `email_norm`, else `phone_norm`, else a per-identity fallback). A new profile may be minted **only while holding that lock**, so a racing job blocks, then re-reads and attaches to the just-created profile instead of minting a second. Qdrant-down degrades to paths 1 and 2 only; the engine never blocks on Qdrant.

### 4.3 Scoring features

For each candidate pair, compute a weighted score (weights snapshotted into `evidence.weights`, ST8):

| Feature | Signal | Default weight | Strong? |
| --- | --- | --- | --- |
| `email_exact` | `email_norm` equal | 0.45 | yes |
| `phone_exact` | `phone_norm` equal | 0.15 | yes |
| `name_trigram` | pg_trgm similarity on `name_norm` | 0.20 | no |
| `embedding_cosine` | Qdrant cosine on the identity embedding | 0.15 | no |
| `domain_match` | same company `domain` | 0.05 | no |

Score = sum(feature_score * weight), clamped to [0,1]. `strong_signal = email_exact OR phone_exact`.

### 4.4 Decision bands, N-way bridging, and survivorship

The resolved score routes into the three bands of Section 2.2, read from `braid_org_settings`. `require_strong_signal_for_auto` means a 0.95 built entirely from name+embedding routes to **review**, never auto-merge.

**N-way bridging merge (round-1 D6).** A new identity can strongly match two *different* existing profiles (exact email to A, exact phone to B). That implies A and B are the same person and must themselves merge. So when a new identity strongly matches more than one existing profile, the engine:
1. Generates the **profile-pair merge candidate(s)** between the matched existing profiles (auto-merge if both matches are strong-signal, else route to review), running the normal band logic and CAS.
2. Attaches the new identity to the **survivor** of that merge. Initial-attach tie-break when no merge fires yet (review-band): attach to the **oldest** profile, then the one with the most `human`/`seed` identities. This makes 3-record convergence happen through ingest, which round 0 could not express.

**Merge execution (round-1 ST2/ST3, transactional).** `mergeCandidate` / direct merge runs its DB steps in **one Drizzle transaction**:
0. `SELECT ... FOR UPDATE` both profiles (deadlock-safe lock order by id); CAS the candidate (`... WHERE status='pending' RETURNING id`) and, for direct merges, assert neither profile is already `merged_away`. If the CAS returns no row, abort (another actor won).
1. Move all `braid_identities` of the absorbed profile to the survivor.
2. Set absorbed `status='merged_away'`, `merged_into_id=survivor`; recompute `identity_count` and `confidence` (weakest-link).
3. **Recompute survivorship** for every golden field, including `company_profile_id`, from `braid_survivorship_rules` over the union of member `raw_attributes`, rewriting `braid_profiles.attributes` with fresh provenance. Supersede stale candidates (Section 3.1 status rule). Insert the `braid_merge_decisions` row.

After commit, **best-effort and outside the transaction** (a DB txn cannot hold a Qdrant call or an HTTP publish): re-embed the survivor into Qdrant and `publishBoltEvent('profile.merged', ...)`. A crash between commit and these side effects leaves a correct golden record (steps 1-3 are atomic) with a stale Qdrant point and a missing event; the nightly rescan reconciles both. This mirrors the post-commit external-call shape of `apps/worker/src/jobs/basis-metric-snapshot.job.ts` and the fire-and-forget publish of `bond-stale-deals.job.ts`.

### 4.5 Unmerge / split (round-1 D2, with audit and anti-flap)

Two cases, both audited:
- **Unmerge (reverse a specific merge).** `braid_split_profile` given a `merge_decision_id` **reactivates the original absorbed profile**: it flips that profile's `status` back to `active`, clears `merged_into_id`, and reattaches exactly the `affected_identity_ids` the merge recorded. This **restores the original profile id**, so cached consumers keyed on the absorbed id are not orphaned. A `braid_merge_decisions` row (`decision_kind='split'`, `reverses_decision_id=<the merge>`) completes the audit chain.
- **Fresh-id split (the "actually two people" case).** Given an explicit `identity_ids` set with no prior merge to reverse, the engine mints a new profile, moves the named identities, and recomputes survivorship on both. A fresh id is correct here because these identities were never a distinct profile before.

**Anti-flap (round-1 ST4).** Every split writes `dedupe_decisions` `not_duplicate` rows (canonical `id_a < id_b`, `entity_type='braid.identity'`) for the separated identity pairs, and flags them human-separated so a future high score routes to **review, not auto-merge**. Blocking excludes suppressed pairs before scoring, so the next ingest/rescan cannot silently re-merge what a human tore apart.

**Stable-id contract for consumers (round-1 ST5).** `braid_resolve` MUST follow the `merged_into_id` chain to the live `active` survivor and return that id. `profile_id` is therefore not a durable key across merges; both `profile.merged` and `profile.split` carry the affected source-identity list (`source_type` + `source_id`) so a consumer holding "bond.contact X -> P" learns X now resolves to the survivor and re-resolves. Consumers re-resolve on any `profile.*` event.

### 4.6 Where it runs

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `braid-match-on-ingest` | event-driven (Section 6) | Normalize the changed source row into a `braid_identity`, block (with suppression check + advisory lock), score, route to a band, and run N-way bridging. Idempotent: re-processing the same source version re-derives the same identity row (`ON CONFLICT`) and the same candidates. Bounded retry + backoff + DLQ (ST7). |
| `braid-rescan` | daily (`20 3 * * *`, non-zero minute) | **Watermarked** (ST6): using `braid_org_settings.last_rescan_at` and per-identity `source_synced_at`, re-score only identities whose `raw_attributes` changed since the last success, re-embed drifted profiles, reconcile post-commit side effects a merge crash skipped, and re-score stale `pending` candidates past `rescan_max_age_days`. LIMIT'd cursor batches with a per-tick cap; per-N (`%25`) progress logging via `@bigbluebam/logging`, modeled on `basis-metric-snapshot.job.ts` and `basis-partition-provision`. |
| `braid-candidate-retention` | daily (`50 3 * * *`, non-zero minute) | Purge terminal-status (`merged`/`rejected`/`superseded`) candidates older than N days, modeled on `apps/worker/src/jobs/basis-retention-sweep.job.ts` (ST8). Never touches `braid_merge_decisions` (immutable audit). |

Retry/backoff on source-app failure (ST7) reuses the BullMQ `attempts` + exponential-backoff schedule of `apps/worker/src/jobs/agent-webhook-dispatch.job.ts` (0s/30s/2m/...) with a give-up DLQ modeled on `agent-webhook-dlq.job.ts`; on give-up the identity is stamped stale for the watermarked rescan, and source reads use a bounded `AbortController` timeout. All fan-out sets `app.current_org_id` per org (the `INTERNAL_SERVICE_SECRET` + explicit `org_id` pattern of `banter-feed-fanin` and the Basis workers) and wraps each `(org, identity)` in try/catch log-and-continue.

---

## 5. API surface

Base path `/braid/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler` (`apps/basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Request/response shapes live in `packages/shared/src/schemas/braid.ts`, imported by both `braid-api` and the SPA.

### 5.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/profiles` | List golden profiles | `braid.profile.read` (admin-tier); per-viewer attribute assembly for granted non-admins |
| GET | `/v1/profiles/:id` | Get a golden profile + provenance | attributes re-assembled per viewer (S1b) |
| GET | `/v1/profiles/:id/identities` | List member source identities | non-admin: denied rows dropped entirely, count recomputed from visible members (S3) |
| GET | `/v1/profiles/:id/timeline` | Cross-app timeline | UNIONs member identities' activity via `v_activity_unified` + `bolt_recent_events`, each row `can_access`-filtered per caller |
| GET | `/v1/profiles/:id/decisions` | Merge/split audit history | reads `braid_merge_decisions` |
| POST | `/v1/resolve` | Resolve `{source_type, source_id}` to a stable golden id | takes `asker_user_id`; `preflightAccess` on the input record first, `not_found` if denied; follows `merged_into_id` chain; `identity_count` suppressed for non-admins (S2); **lazily creates a singleton seed profile on first resolve so it never 404s a real record** (D2) |
| GET | `/v1/candidates` | List review-queue candidates | `braid.candidate.read`; sort `-score` |
| GET | `/v1/candidates/:id` | Candidate detail + evidence | evidence value-refs re-hydrated per caller |
| POST | `/v1/candidates/:id/merge` | Confirm a merge | `braid.profile.merge`; the single `mergeCandidate` executor (CAS-guarded); resolves the linked `agent_proposals` row |
| POST | `/v1/candidates/:id/reject` | Reject a candidate | `braid.profile.merge`; writes identity-level `dedupe_decisions` suppression (Section 2.3) |
| POST | `/v1/profiles/merge` | Merge two profiles directly | `braid.profile.merge`; body `{ profile_a_id, profile_b_id, reason }`; asserts neither already `merged_away` |
| POST | `/v1/profiles/:id/split` | Unmerge or split | `braid.profile.split`; body `{ merge_decision_id? | identity_ids?, reason }` (Section 4.5) |
| GET | `/v1/survivorship-rules` | List rules | `braid.rule.read` |
| PUT | `/v1/survivorship-rules/:kind/:field` | Upsert a rule | `braid.rule.write` |
| GET | `/v1/settings` | Get org settings | `braid.settings.read` |
| PATCH | `/v1/settings` | Update org settings | `braid.settings.write`; source-type enablement gate (Section 5.5) |
| POST | `/internal/events` | Ingest-trigger from bolt-api (Section 6) | `INTERNAL_SERVICE_SECRET`; enqueues into `braid-match-on-ingest`; no public route |
| GET | `/health` / `/readyz` | Probes | from `@bigbluebam/service-health` `healthCheckPlugin` (BP5), `/readyz` checks **only Postgres + Redis** (`apps/basis-api/src/server.ts:76`) |

### 5.2 Realtime (`/braid/ws`)

Redis-PubSub, org-scoped rooms (the cross-instance PubSub pattern `CLAUDE.md` describes). Payloads are **refs-only**: `candidate.created { candidate_id, score }`, `profile.merged { surviving_profile_id, affected_identities: [...] }`, `profile.split { surviving_profile_id, new_profile_id?, affected_identities: [...] }`. No PII or evidence in the frame; the SPA fetches through the per-caller filtered read path. Notification channel only.

### 5.3 Permissions

Manifest-generated `app.resource.verb`, resolved by an `apps/basis-api/src/plugins/permissions.ts`-style plugin: `braid.profile.read`, `braid.profile.merge` (destructive, confirm), `braid.profile.split` (destructive, confirm), `braid.candidate.read`, `braid.rule.read`, `braid.rule.write`, `braid.settings.read`, `braid.settings.write` (8 rows). `braid.profile.read` and `braid.candidate.read` default to an org-admin-equivalent tier (Section 2.5). The hand-authored registration + regeneration sequence is Section 3.4 step 3.

### 5.4 The single canonical decision path

Restating Section 2.2 D3 for the API layer: `/candidates/:id/merge`, `/candidates/:id/reject`, `/profiles/merge`, and `/profiles/:id/split` are the **only** endpoints that mutate golden truth. The `agent_proposals` inbox is a notification-and-approval pointer; approving a `braid.merge_profiles` proposal fires `proposal.decided`, which Braid's subscription turns into a call to the same `mergeCandidate` executor. Exactly-once is guaranteed by the candidate-status CAS, so the two surfaces cannot double-execute.

### 5.5 Source-type enablement gate

`PATCH /v1/settings` may add a `source_type` to `enabled_source_types` only if that type has a verified `visibility.service.ts` branch (Section 2.5). The endpoint rejects enabling a type whose branch is absent with a typed `SOURCE_TYPE_NOT_SUPPORTED` error, so an org can never turn on an org-match-only PII leak.

---

## 6. Background work and the ingest transport

BullMQ workers in `apps/worker` (Section 4.6). The live trigger transport (round-1 IN3, previously unspecified):

**Bolt event to BullMQ enqueue.** The source apps already publish upsert/create events through `bolt-api` ingest. Braid registers the `(source, event_type)` pairs it cares about with `bolt-api`, which POSTs each matching event to Braid's internal route `POST /braid/api/internal/events` (guarded by `INTERNAL_SERVICE_SECRET`); that route enqueues a refs-only job `{ org_id, source_type, source_id }` into the shared Redis `braid-match-on-ingest` queue. This is a first-party internal dispatch, distinct from the HMAC agent-runner outbound-webhook mechanism. Subscribed events:
- `bond` `contact.upserted` / `company.upserted`
- `bill` client create/update
- `helpdesk` `user.upserted` (the `helpdesk_upsert_user` write-plane tool, `CLAUDE.md` Wave 4)
- `book` attendee create (per booking)

Whether `bolt-api` already exposes this internal per-event dispatch, or needs a small route added, is an Open Question dependency (Section 12). If the live path is unavailable, the nightly watermarked `braid-rescan` still catches every changed identity, so the system degrades to next-day resolution, not to a quarterly batch. The worker re-reads the source row from Postgres (not from the event payload) so it never trusts a stale payload for golden attributes. Every job is idempotent (identity `ON CONFLICT`, candidate upsert, CAS).

The worker service needs new env (round-1 IN2): `QDRANT_URL` (embedding recall + re-embed), plus the already-present `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET` for llm-provider embeddings. It does **not** need source-app internal URLs because it reads those schemas directly via `DATABASE_URL`. Wiring is in Section 9.2.

---

## 7. Events & integration

### 7.1 Bolt events published (source `braid`)

Via `publishBoltEvent(eventType, 'braid', payload, orgId, actorId?, actorType?)` (positional signature, `packages/shared/src/bolt-events.ts:35`), bare names, each registered with a `payload_schema` in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI. Payloads are refs + magnitude only; they are org-level linkage disclosure (S6), so `braid.*` webhook subscriptions require org-admin authorship and must never gain a PII field.

| `event_type` | When | Payload |
| --- | --- | --- |
| `profile.merged` | two profiles merged (auto or human) | `profile.id` (survivor), `affected_identities` (`source_type`+`source_id` list, for consumer re-resolve), `identity_count`, `decision_kind`, `actor.*`, `org.*` (no absorbed cluster members, S6) |
| `profile.split` | a profile unmerged or split | `profile.id` (survivor), `new_profile_id?`, `affected_identities`, `actor.*`, `org.*` |
| `profile.matched` | a new identity auto-linked into an existing profile below the merge bar | `profile.id`, `identity.source_type`, `identity.source_id`, `org.*` |
| `candidate.created` | a review-band candidate was queued | `candidate.id`, `score`, `org.*` (no profile ids in the frame beyond the candidate ref) |

### 7.2 entity_links

On every profile-to-identity link, Braid upserts an `entity_links` row (`src_type='braid.profile'`, `dst_type=<source_type>`, `link_kind='related_to'`, `ON CONFLICT DO NOTHING`).

### 7.3 Unified activity & search

Register a **Braid provider in `search_everything`** (`apps/mcp-server/src/tools/search-tools.ts`), restricted to admin askers with per-viewer post-filtering, fail-closed (S4). Braid catalog changes flow as the Bolt events above, not into the fixed `v_activity_unified` UNION in v1 (bam/bond/helpdesk only). The profile timeline *reads* `v_activity_unified` and `bolt_recent_events` for its member identities.

---

## 8. Testing (round-1 BP4)

- **Unit (Vitest, schema-isolated via `@bigbluebam/db-stubs`, following the basis safety-suite precedent in commit `7587872c`):**
  - deterministic scorer: fixed feature inputs produce a fixed score and `strong_signal`.
  - band routing: threshold boundaries, the `require_strong_signal_for_auto` gate, N-way bridging tie-break.
  - survivorship recompute: each strategy, `company_profile_id` resolution, provenance correctness.
  - split-replay: `affected_identity_ids` reattach restores the original absorbed profile id (unmerge) and the fresh-id split path.
  - suppression: identity-level `dedupe_decisions` keying survives merge/split; a suppressed pair is not re-proposed.
  - CAS exactly-once: two concurrent `mergeCandidate` calls, only one flips.
- **visibility.service.ts branch tests:** one unit test per new branch (`bill.client`, `helpdesk.user`, `book.event_attendee`, `braid.profile`, `braid.identity`) asserting it mirrors the source app's real read predicate; a source type is not enabled until its test passes (Section 5.5).
- **register-tool policy test:** `braid.*` fails closed until allowlisted.
- **RLS enforcement test (S8):** cross-org `SELECT` on each `braid_*` table returns zero rows under the `BBB_RLS_ENFORCE=1` role.
- **e2e:** gilligan-seeded stories (`docs-capture` / gilligan cast) - the Skipper appears as a Bond contact, a Bill client, and three Book attendees; Braid clusters them into one golden profile; the reviewer confirms a review-band merge; a wrong merge is split and does not re-merge.

---

## 9. Infrastructure

### 9.1 New api compose service

`braid-api` in `docker-compose.yml`, modeled on `basis-api` (`docker-compose.yml:798`): `PORT: 4020`, stateless, horizontally scalable. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Source apps and Qdrant are NOT in `depends_on` (request-time, circuit-broken; Qdrant is soft, Section 9.5). Env: `DATABASE_URL`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, **`INTERNAL_SERVICE_SECRET` (non-empty)**, `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `QDRANT_URL` (+ optional `QDRANT_API_KEY`), `CORS_ORIGIN`, rate-limit knobs. Healthcheck: `curl -sf http://localhost:4020/health`. **Deploy checklist requires `BBB_RLS_ENFORCE=1`** for braid-api (S8).

### 9.2 Worker service wiring (round-1 IN2)

The engine runs in `apps/worker`, whose compose env (`docker-compose.yml:229-253`) currently lacks the URLs Braid needs. Add to the `worker` service env: `QDRANT_URL` (embedding recall + re-embed), and rely on the already-present `BBB_API_INTERNAL_URL`/`INTERNAL_SERVICE_SECRET` for llm-provider embeddings (add `BBB_API_INTERNAL_URL` if absent). No source-app internal URLs are added because the worker reads source schemas directly via `DATABASE_URL`. Mirror the same additions in the `worker` catalog entry's `optional` list in `scripts/deploy/shared/services.mjs`.

### 9.3 SPA build (the SPA is not its own service; round-1 IN4)

Every SPA is built in the single `apps/frontend/Dockerfile` and `COPY`'d into `/usr/share/nginx/html/<app>`. Braid edits it in **four** sites, mirroring the exact basis lines:
1. deps-stage `COPY apps/braid/package.json ./apps/braid/` (like `Dockerfile:22`).
2. build-stage 4-line source COPY block (like `:117-120`): `COPY apps/braid/src ./apps/braid/src`, `COPY apps/braid/public ./apps/braid/public`, `COPY apps/braid/index.html ./apps/braid/`, `COPY apps/braid/tsconfig.json apps/braid/tsconfig.node.json apps/braid/vite.config.ts ./apps/braid/`.
3. add `&& pnpm --filter @bigbluebam/braid build` to the build `RUN` (like `:181`).
4. production-stage `COPY --from=build /app/apps/braid/dist /usr/share/nginx/html/braid` (like `:205`).

There is no deps-stage source COPY (round 0 wrongly said "five places, deps-stage source copy"). There is no separate `braid` compose service.

### 9.4 nginx routing (round-1 IN1/IN6)

`infra/nginx/nginx.railway.conf` is **auto-generated** from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs` (`do not edit by hand` header) and must not be hand-edited. Edit only the two source configs, then regenerate:
- `infra/nginx/nginx.conf` (basis at 298-316): add `/braid/` alias + SPA fallback, `/braid/api/ -> http://braid-api:4020/`, `/braid/ws -> http://braid-api:4020/ws` with upgrade headers. Add `braid` to the static-asset regex alternation at `nginx.conf:670`.
- `infra/nginx/nginx-with-site.conf` (basis at 396-414): the same three blocks. Add `braid` to the static-asset regex at `nginx-with-site.conf:748`.
- Then run `node scripts/gen-railway-configs.mjs`. Because `braid-api` is in `APP_SERVICES` (Section 9.6), the generator rewrites the upstream to `braid-api.railway.internal:8080`, synthesizes the `$rw_upstream_NN` index (via its `varSeq` counter) and the `rewrite ... break;` lines, and adds the static-asset entry. Do not reason about specific `$rw_upstream` indices or `:8080` by hand.

**Static-asset regex divergence (IN6):** the alternations already differ (`nginx.conf:670` includes `bill`; `nginx-with-site.conf:748` and the generated `railway:876` do not). Edit each source file in place to add `braid`; do not copy one alternation over another or you regress `bill`/`basis` caching.

**Ingress crash-safety (IN8):** nginx (compose form) resolves literal upstreams at load and crashloops on host-not-found, so add **`braid-api` (`condition: service_healthy`) to the `frontend` service `depends_on`** in `docker-compose.yml` (basis-api is already there, so this addition is correct). This compose edit, not the services.mjs metadata, is the real load-time guarantee.

### 9.5 Qdrant posture (round-1 IN5)

Basis (the primary model) uses no Qdrant; Beacon hard-depends on it. Braid takes the soft path: `/readyz` checks only Postgres + Redis, and the `braid_profiles` Qdrant collection is created **lazily on first use** with retry + circuit-break, **never fatal at boot** (round 0 wrongly said "at boot like Beacon/Bond"). `QDRANT_URL` (+ optional `QDRANT_API_KEY`) is added to the `braid-api` catalog `optional` env, matching `brief-api` (`services.mjs:133`). Qdrant-down degrades blocking to key + trigram only.

### 9.6 Deploy catalog, Railway manifests, MCP wiring, Launchpad, CLAUDE.md

- `scripts/deploy/shared/services.mjs`: add a `braid-api` `APP_SERVICES` block (port `4020`, `public_paths: ['/braid/api/','/braid/ws']`, `required` env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`, `optional` incl. `QDRANT_URL`/`QDRANT_API_KEY`/`BOLT_API_INTERNAL_URL`/`CORS_ORIGIN`/`LOG_LEVEL`, `needs: ['postgres','redis','api','bolt-api','bond-api','bill-api','helpdesk-api','book-api']`, qdrant optional). Add `/braid/` to the `frontend` entry's `public_paths` and `braid-api` to its `needs`; add `braid-api` to `mcp-server`'s `needs`/`depends_on`. Add `BRAID_API_URL: http://braid-api:4020/v1` to `mcp-server` env in compose and catalog; register `braid-tools.ts` in the MCP bootstrap. Add `QDRANT_URL` + `BBB_API_INTERNAL_URL` to the `worker` catalog `optional` (Section 9.2). (The existing `services.mjs` cross-ref lists are already imperfect; the compose `frontend.depends_on` edit in 9.4 is the real crash-safety guarantee.)
- **Run `node scripts/gen-railway-configs.mjs`**: it regenerates `nginx.railway.conf` and emits a new `railway/braid-api.json`. Round 0 wrongly claimed `railway/frontend.json` is updated; what changes is the regenerated `nginx.railway.conf` plus the new `railway/braid-api.json`.
- **Launchpad catalog** in `apps/api/src/routes/system-settings.routes.ts`: add `'braid'` to `LAUNCHPAD_APP_IDS` (`:61`) and a `LAUNCHPAD_CATALOG` entry (`:97`): `{ id: 'braid', name: 'Braid', description: 'Customer Identity', icon_name: 'git-merge', color: '#4338ca', path: '/braid/' }`. Add `'braid'` to `ROOT_REDIRECT_VALUES` if it should be a valid root target.
- **Launchpad icon (round-1 IN7):** `git-merge` is absent from the `ICONS` map in `packages/ui/launchpad.tsx` (which has `ruler` but not `git-merge`), and an unknown `icon_name` falls back to the generic `Box` (`launchpad.tsx:224`). Two explicit edits: `import { GitMerge } from 'lucide-react'` and add `'git-merge': GitMerge` to the `ICONS` table. No grid redesign is needed; the grid already scrolls past 20+ apps (`max-h-[65vh] overflow-y-auto`, `launchpad.tsx:222`).
- **CLAUDE.md (round-1 BP3, Phase 5 mandate):** append the `braid-api` (internal :4020, `/braid/api/`) and `braid` SPA (`/braid/`) inventory lines to the `apps/` block, add the `/braid/`, `/braid/api/`, `/braid/ws` route rows to the nginx route list, and bump the MCP tool count: the new `braid-tools.ts` module adds 13 tools, taking the catalog to 51 modules (add a `+13 Braid` line to the breakdown and update the total wherever it is referenced in docs/marketing).
- **Runtime-dependency posture:** `/readyz` checks only Postgres + Redis. Source-app Postgres reads, Qdrant, and llm-provider embeddings use a bounded timeout + circuit breaker returning typed `UPSTREAM_UNAVAILABLE`; the ingest worker retries with backoff and DLQs on give-up; the merge-rationale LLM call is best-effort.

---

## 10. MCP surface (round-1 BP2)

New `apps/mcp-server/src/tools/braid-tools.ts` via `registerTool` (`apps/mcp-server/src/lib/register-tool.ts`), HTTP client shaped like `apps/mcp-server/src/tools/dedupe-tools.ts:38`. Env `BRAID_API_URL=http://braid-api:4020/v1`. Read tools that surface source records require an explicit `asker_user_id` (per `docs/reference/agent-conventions.md`), fail-closed via `can_access`; truth-flip tools use the Redis confirm-token store.

| Tool | Backs | Autonomy | confirm_action |
| --- | --- | --- | --- |
| `braid_resolve` | POST `/v1/resolve` | read (flagship); `asker_user_id` + input preflight | no |
| `braid_get_profile` | GET `/v1/profiles/:id` | read (embeds identities + decisions) | no |
| `braid_list_profiles` / `braid_search_profiles` | GET `/v1/profiles` | read, admin asker (S4) | no |
| `braid_profile_timeline` | GET `/v1/profiles/:id/timeline` | read, `asker_user_id`, `can_access`-filtered | no |
| `braid_list_candidates` | GET `/v1/candidates` | read | no |
| `braid_propose_merge` | registers an `agent_proposals` row | write (proposal only); preflight both members, rate-limited (S7) | no (proposal is the HITL) |
| `braid_reject_candidate` | POST `/v1/candidates/:id/reject` | write (writes identity suppression) | no |
| `braid_merge_profiles` | POST `/v1/profiles/merge` or `/candidates/:id/merge` | truth-flip | **yes** (Redis token) |
| `braid_split_profile` | POST `/v1/profiles/:id/split` | truth-flip, destructive | **yes** (Redis token) |
| `braid_set_survivorship_rule` | PUT `/v1/survivorship-rules/:kind/:field` | write, permission-gated | no |
| `braid_list_survivorship_rules` | GET `/v1/survivorship-rules` | read | no |
| `braid_get_settings` | GET `/v1/settings` | read | no |

13 tools. `braid_get_profile` returns member identities and recent decisions embedded, so `/profiles/:id/identities` and `/profiles/:id/decisions` are annotated `resolver-done-internally` in the surface map (not a bare skip). `/settings` PATCH, `/survivorship-rules` PUT, `/internal/events`, `/braid/ws`, `/health`, `/readyz` are the intentional no-tool endpoints. **agent_policies:** `braid.*` is not in the always-permitted core; every `braid_*` service-account call fails closed until an operator allowlists `braid.*`.

**Surface-map update (round-1 BP2/BP6):** `docs/reference/mcp-endpoint-mapping.md` MUST be updated in the same change. Every REST row's MCP column is a backtick tool name or the sanctioned em-dash skip-cell form the other apps use (`docs/reference/mcp-endpoint-mapping.md:1920`); that table is the one place em dashes are correct (the CLAUDE.md self-check grep depends on it), so this spec keeps its own prose em-dash-free while the surface-map cells follow the existing convention. Keep the coverage counts and the zero-bare-dash grep green.

---

## 11. Reuse ledger

| Capability | Reuses (real file/package) | New in Braid |
| --- | --- | --- |
| App scaffolding (Fastify server, plugins, health plugin) | `apps/basis-api/src/server.ts` (`@bigbluebam/service-health:8`), `apps/bond-api/` layout | `braid-api` at port 4020 |
| Cross-app entity linking | `entity_links` (`0132_entity_links.sql`) | `braid.profile -> source` links |
| Per-pair dedupe memory / never-resurface | `dedupe_decisions` (`0136_*`), `dedupe-tools.ts:184` | identity-atom keyed suppression (Section 2.3) |
| Within-app duplicate signals (pg_trgm, exact email/phone) | `bond_find_duplicates` (`dedupe-tools.ts:72`) | cross-app blocking + weighted score |
| Embedding similarity | Qdrant (in-stack), platform llm-provider embeddings | lazy `braid_profiles` collection + identity embeddings |
| HITL approval inbox | `agent_proposals` (`0128_*`), `proposals.routes.ts` | single-executor reconciliation (D3) |
| Confirm-action gating on truth-flips | `apps/mcp-server/src/lib/confirm-token-store.ts` | merge/split tokens |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts:1359`, `can_access` | new `braid.*` + person-source branches, per-viewer re-assembly |
| Bolt events (positional signature) | `publishBoltEvent` (`packages/shared/src/bolt-events.ts:35`), catalog + `check-bolt-catalog.mjs` | 4 `profile.*`/`candidate.*` definitions |
| Cross-app timeline data | `v_activity_unified` (`0129_*`), `bolt_recent_events` | union over a profile's members |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` | admin-asker Braid provider |
| RLS / org scoping (enforced) | `app.current_org_id` GUC (`0116_*`, `0132_*:52-56`), `BBB_RLS_ENFORCE` | Braid table policies + enforced-posture checklist |
| Permissions (hand-authored, like basis) | `@bigbluebam/permissions`, `generate-permission-manifest.mjs:768`, `check-permission-catalog.mjs`, `build-permission-delta.mjs` | 8 `braid.*` rows |
| MCP registration + policy gate | `register-tool.ts`, `dedupe-tools.ts` client | 13 `braid_*` handlers |
| Worker fan-out + retry/backoff + DLQ + post-commit publish | `banter-feed-fanin`, `basis-metric-snapshot.job.ts`, `bond-stale-deals.job.ts`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts` | Braid ingest/rescan/retention jobs |
| Advisory-lock serialization | Postgres `pg_advisory_xact_lock` | per-blocking-key create-or-attach lock (ST1) |
| Retention sweep pattern | `apps/worker/src/jobs/basis-retention-sweep.job.ts` | terminal-candidate purge |
| Org-settings table (nullable = unbounded) | `basis_org_settings` (`0226_*:73`) | thresholds + enabled sources + watermark |
| Launchpad + nginx (2 source configs, generated railway) + frontend Dockerfile + services.mjs | basis/bill wiring (cited above), `gen-railway-configs.mjs` | one new app id `braid`, `git-merge` icon |
| Suite-wide UI shell + Bureau widget + test stubs | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/db-stubs` | Braid SPA pages only |

---

## 12. Open questions & risks (human decision needed)

1. **`bolt-api` internal per-event dispatch (IN3).** The live match-on-ingest path assumes `bolt-api` can POST subscribed events to Braid's `/internal/events`. If that dispatch does not exist, it is a small `bolt-api` addition or the system runs on nightly rescan only (next-day, not batch). Owner: Bolt maintainers.
2. **Person-level visibility branches (D7/S5).** `bill.client`, `helpdesk.user`, and `book.event_attendee` need real `visibility.service.ts` branches mirroring each app's authoritative read predicate, each with a passing unit test, before that source is enabled. If a faithful predicate cannot be written this cycle, drop that source from v1 rather than ship an org-match-only leak. This is the single largest cross-team dependency and it gates the "whole app suite" wedge breadth.
3. **`v_activity_unified` is bam/bond/helpdesk only** (`0129_*`). Bill/Book activity in a timeline comes from `bolt_recent_events`, so completeness depends on those apps' typed-event coverage. Extending the view is a platform follow-up.
4. **Book attendee volume.** `book.event_attendee` is one row per booking, email-keyed, so a frequent booker produces many identities that all cluster into one profile. This is the highest-volume, lowest-precision source; consider a per-org toggle to treat Book attendees as evidence-only (they strengthen an existing profile via exact email but never seed a new one).
5. **Golden-record write-back.** v1 keeps the golden record read-only relative to source apps. Whether a future version pushes the golden email back into source records (master-data write-back) is deferred; large blast radius.
6. **Company hierarchy depth.** v1 models only a flat person-to-company link (`company_profile_id`). Household/subsidiary graphs are out of scope.
7. **Threshold auto-tuning.** The 0.92/0.60 bands are operator-tuned starting points; a learning loop over `braid_merge_decisions` is deferred.
8. **No human-provided secret required.** All dependencies are internal (`INTERNAL_SERVICE_SECRET`, `QDRANT_URL`, `DATABASE_URL`, `REDIS_URL`, `BBB_API_INTERNAL_URL`) and already in the stack. No external account or third-party credential for v1.

---

## Changelog - Round 1

Dispositions for every finding (accept / adapt / reject) with the section changed. No findings were rejected.

**Design**
- [design] D1 ACCEPT: re-derived v1 sources from real schema (`bond.contact`, `bond.company`, `bill.client`, `helpdesk.user`, `book.event_attendee`); Blast reduced to an email-suppression overlay (no subscriber entity); rippled through Sections 1, 2.5, 3, 4, 6. (from review round 1)
- [design] D2 ACCEPT: `braid_resolve` lazily creates a singleton seed profile (never 404s) and follows the `merged_into_id` chain; unmerge reactivates the original absorbed profile id; fresh-id split reserved for the "two people" case. Sections 4.5, 5.1. (from review round 1)
- [design] D3 ACCEPT: single `mergeCandidate` executor reached by both the REST endpoint and a `proposal.decided` subscription, CAS-guarded for exactly-once. Sections 2.2, 5.4. (from review round 1)
- [design] D4 ACCEPT: reject/split suppression keyed on immutable `braid_identities.id` atoms with honest `entity_type='braid.identity'`; re-blocking checks identity-level suppression first. Sections 2.3, 4.2, 4.5. (from review round 1)
- [design] D5 ACCEPT: added `link_confidence` + `link_evidence` to `braid_identities`; `braid_profiles.confidence` is `min()` over stored link confidences. Sections 3.1, 4.4. (from review round 1)
- [design] D6 ACCEPT: N-way bridging generates profile-pair merge candidates when a new identity strongly matches more than one profile, with a stated initial-attach tie-break. Section 4.4. (from review round 1)
- [design] D7 ACCEPT (security-scoped, overlaps S5): real visibility branches per person-source are in-scope v1 work; a source is not enabled until its branch is verified, else dropped from v1. Sections 2.5, 5.5, 12. (from review round 1)
- [design] D8 ACCEPT: added `company_profile_id` survivorship rule; defined the `superseded` candidate transition on every merge; normalized the table name to `braid_match_candidates`; documented `org_id` vs `organization_id` join boundary. Sections 3, 4.4. (from review round 1)

**Security**
- [security] S1 ACCEPT (both options): admin-tier read default AND per-viewer attribute re-assembly from `can_access`-passing members. Section 2.5. (from review round 1)
- [security] S2 ACCEPT: `braid_resolve`/`POST /resolve` take `asker_user_id`, preflight the input record, suppress `identity_count` for non-admins. Sections 2.5, 5.1. (from review round 1)
- [security] S3 ACCEPT: non-admin `/identities` drops denied rows entirely (no stub, no `source_type`), recomputes count from visible members. Section 2.5. (from review round 1)
- [security] S4 ACCEPT: search provider + `braid_search_profiles` restricted to admin askers with per-viewer post-filter. Sections 2.5, 7.3, 10. (from review round 1)
- [security] S5 ACCEPT: visibility branches are a security gate with a unit test per branch; enablement blocked until verified. Sections 2.5, 5.5, 8. (from review round 1)
- [security] S6 ACCEPT (adapted): events kept refs-only and documented as org-level linkage; `profile.merged` carries survivor + affected source identities (needed for ST5 invalidation) but not the absorbed cluster's other members; webhook subscriptions require org-admin authorship. Sections 2.5, 7.1. (from review round 1)
- [security] S7 ACCEPT: `braid_propose_merge` preflights both profiles' members for the proposing asker and is rate-limited. Sections 2.4, 10. (from review round 1)
- [security] S8 ACCEPT: Braid requires `BBB_RLS_ENFORCE=1` in its deploy checklist with a cross-org zero-row test. Sections 2.5, 3, 8, 9.1. (from review round 1)

**Stability**
- [stability] ST1 ACCEPT: `pg_advisory_xact_lock(hashtext(org_id||':'||strongest_key))` serializes create-or-attach; new profiles minted only under the lock. Section 4.2. (from review round 1)
- [stability] ST2 ACCEPT: merge DB steps 1-3 + decision insert in one Drizzle transaction with `SELECT..FOR UPDATE`; Qdrant re-embed + publish are post-commit best-effort, reconciled by rescan. Section 4.4. (from review round 1)
- [stability] ST3 ACCEPT: candidate-status CAS inside the merge txn; direct merges assert not-already-`merged_away`. Sections 2.2, 4.4. (from review round 1)
- [stability] ST4 ACCEPT: split writes identity-level `not_duplicate` suppression flagged human-separated so future high scores route to review, not auto-merge. Section 4.5. (from review round 1)
- [stability] ST5 ACCEPT: both `profile.*` events carry the affected source-identity list; `braid_resolve` follows the survivor chain; `profile_id` documented as non-durable, consumers re-resolve. Sections 4.5, 5.2, 7.1. (from review round 1)
- [stability] ST6 ACCEPT: rescan watermarked via `last_rescan_at` + `source_synced_at`, LIMIT'd cursor batches, per-tick cap, `%25` progress logging. Sections 3.1, 4.6. (from review round 1)
- [stability] ST7 ACCEPT: BullMQ attempts + exponential backoff + DLQ; give-up stamps identity stale; bounded `AbortController` on source reads. Section 4.6. (from review round 1)
- [stability] ST8 ACCEPT: full weight set snapshotted into `evidence`; threshold changes prospective-only / rescan-evaluated; `braid-candidate-retention` sweep for terminal candidates. Sections 3.1, 3.3, 4.6. (from review round 1)

**Best-practices**
- [best-practices] BP1 ACCEPT: register 8 `braid.*` rows in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs` (merge/split destructive+confirm), then regenerate + `check-permission-catalog.mjs` + `build-permission-delta.mjs`. Section 3.4. (from review round 1)
- [best-practices] BP2 ACCEPT: added `braid_reject_candidate`, `braid_list_survivorship_rules`, `braid_get_settings` (13 tools total); re-annotated identities/decisions as resolver-done-internally. Section 10. (from review round 1)
- [best-practices] BP3 ACCEPT: added the CLAUDE.md inventory + route-row + MCP-count (51 modules, +13 Braid) update step. Section 9.6. (from review round 1)
- [best-practices] BP4 ACCEPT: added Section 8 Testing (unit scorer/bands/survivorship/split-replay, visibility branch tests, register-tool policy test, RLS test, gilligan e2e). (from review round 1)
- [best-practices] BP5 ACCEPT: `/health`+`/readyz` from `@bigbluebam/service-health` `healthCheckPlugin`, PG+Redis readiness. Sections 5.1, 9.1. (from review round 1)
- [best-practices] BP6 ACCEPT: surface-map skip cells use the sanctioned em-dash form (the one correct em-dash location); spec prose stays em-dash-free. Section 10. (from review round 1)
- [best-practices] BP7 ACCEPT: Section 3.4 notes the delta migration depends on the generator update landing after `0230`/`0231`. (from review round 1)

**Infrastructure**
- [infrastructure] IN1 ACCEPT: removed the railway hand-edit; edit `nginx.conf` + `nginx-with-site.conf` then regenerate via `gen-railway-configs.mjs`; corrected the false `railway/frontend.json` claim (only `nginx.railway.conf` regenerates + a new `railway/braid-api.json`). Sections 9.4, 9.6. (from review round 1)
- [infrastructure] IN2 ACCEPT: wired the worker service env (`QDRANT_URL`, `BBB_API_INTERNAL_URL`) in compose + services.mjs; engine reads source rows directly via Postgres, no server-to-server HTTP. Sections 6, 9.2. (from review round 1)
- [infrastructure] IN3 ACCEPT: named the ingest transport (bolt-api posts subscribed events to `/braid/api/internal/events`, which enqueues into BullMQ), with idempotency and the rescan fallback; recorded the bolt-api dependency as an Open Question. Sections 5.1, 6, 12. (from review round 1)
- [infrastructure] IN4 ACCEPT: corrected to four Dockerfile edit sites (no deps-stage source COPY), mirroring exact basis lines. Section 9.3. (from review round 1)
- [infrastructure] IN5 ACCEPT: Qdrant collection created lazily on first use with retry/circuit-break, never fatal at boot; `QDRANT_URL`/`QDRANT_API_KEY` added to braid-api optional env like brief-api. Section 9.5. (from review round 1)
- [infrastructure] IN6 ACCEPT: add `braid` to the static-asset alternation in `nginx.conf` and `nginx-with-site.conf` only (regenerate railway), noting the existing `bill` divergence so no alternation is copy-pasted over another. Section 9.4. (from review round 1)
- [infrastructure] IN7 ACCEPT: explicit `GitMerge` import + `'git-merge': GitMerge` ICONS edit; noted the grid already scrolls (`max-h-[65vh] overflow-y-auto`). Section 9.6. (from review round 1)
- [infrastructure] IN8 ACCEPT: prioritized the compose `frontend.depends_on` (braid-api, `service_healthy`) as the real crash-safety guarantee; services.mjs treated as deploy metadata. Section 9.4. (from review round 1)
