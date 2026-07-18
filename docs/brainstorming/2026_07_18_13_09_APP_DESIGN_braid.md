# Braid - App Design Specification

> The identity-resolution substrate for BigBlueBam. Braids every app's records into one confidence-scored golden profile per real person or company, with human-in-the-loop merge review.
>
> Status: design draft, hardened through adversarial review rounds 1 and 2 (final hardening round). New app. Winner of the 2026-07-18 suite-brainstorm session.
> Chosen internal port: **4020** (first free port after Basis's 4019; 4015 is shared by blueprint/bureau, 4018 is blip, 4019 is basis).
> Routes: SPA at `/braid/`, REST at `/braid/api/`, realtime at `/braid/ws`.
> Chosen final name: **Braid** (single word). App id `braid`.

---

## 1. Overview & positioning

**One-liner.** Braid is an AI customer-data platform. Its agent-driven identity-resolution core clusters the person-and-company rows scattered across Bond, Bill, Helpdesk, and Book into one confidence-scored **golden profile** per real-world person or company, attaches an evidence trail to every link, and routes sub-threshold merges to a human reviewer. It exposes one flagship tool, `braid_resolve(entity)`, that returns a stable golden id for any app record, so every other app's counts, sends, and pipelines resolve to the same person.

**The wedge (why it won).** Braid is the *unification substrate* under the whole suite. Today the same customer exists as a Bond contact, a Bill client, three Helpdesk requesters, and a dozen Book event attendees, and nothing decides that they are one person. `entity_links` (`infra/postgres/migrations/0132_entity_links.sql`) already *stores* cross-app links and `dedupe_decisions` (`0136_dedupe_decisions.sql`) already *remembers* per-pair verdicts, but nothing in the platform *decides* identity across apps, scores its confidence, or maintains a durable golden record. Braid is the decider. Every count, every campaign audience, every invoice-to-deal rollup gets more trustworthy the moment Braid resolves identity, and the value compounds with each app added to the suite. No SMB-priced tool ships evidence-scored, human-reviewed identity resolution across a whole app suite; it beats the manual reconciliation spreadsheet on the trust axis.

**Who it is for.** The org admin / RevOps / support-ops persona at a 2-50 seat team who today reconciles duplicates by hand and cannot trust any single "number of customers" figure. This persona choice is load-bearing for the security model (Section 2.5): the full golden-profile READ defaults to an org-admin-equivalent permission tier because a golden profile is consolidated cross-app PII. The narrow `resolve` operation (input record to golden id) is a separate, non-admin-grantable permission so the flagship wedge can serve service accounts and per-app callers safely (Section 2.5 point 1).

**How it differs from the three apps it is most often confused with:**
- **Bench** (`apps/bench-api/`) *charts* data. Braid does not render charts or dashboards; it produces the golden entity that a chart's "distinct customers" measure should group by.
- **Basis** (`apps/basis-api/`, `docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md`) *defines a metric once and explains why it moved*. Braid does not define metrics; it resolves the *entities* a metric decomposes over. A Basis metric grouped by customer is only trustworthy if Braid has deduplicated the customers.
- **Bond** (`apps/bond-api/`) is a *CRM that owns contacts, companies, and deals*. Braid does not own source data and never edits a Bond contact. It reads Bond (and Bill, Helpdesk, Book) records and maintains a *separate* golden layer that points back at them. Bond's own `bond_find_duplicates` (`apps/mcp-server/src/tools/dedupe-tools.ts:72`) dedupes *within* Bond; Braid resolves *across* apps and produces a persistent golden record, not just a candidate list.

**v1 source identities (real schema).** The real, backing-row source list is:

| Source type | Real backing table | Person/company | Notes |
| --- | --- | --- | --- |
| `bond.contact` | `apps/bond-api/src/db/schema/bond-contacts.ts` (`first_name`,`last_name`,`email`,`phone`) | person | has `owner_id`; per-owner visibility (Section 2.5) |
| `bond.company` | `bond-companies.ts` | company | org-readable (no owner) |
| `bill.client` | `apps/bill-api/src/db/schema/bill-clients.ts` (`name`,`email`,`phone`,`bond_company_id`) | person or company | org-readable; may already carry a `bond_company_id` hint |
| `helpdesk.user` | helpdesk requester/user table | person | mirrors helpdesk's real REQUESTER-read predicate, not the triage-permissive ticket branch (Section 2.5, S-r2-4) |
| `book.event_attendee` | `apps/book-api/src/db/schema/book-event-attendees.ts` (`email` NOT NULL, `name`, `event_id`; no `organization_id`) | person | **email-keyed, one row per booking**; org derived via `book_events.organization_id` (Section 4.1); the highest-volume, lowest-precision source |

**Blast is NOT a source identity type.** Blast has no per-person subscriber row: recipients are computed at send time from `blast_segments` over `bond_contacts` (`apps/worker/src/jobs/blast-send.job.ts`) plus `blast_unsubscribes` (`apps/blast-api/src/db/schema/blast-unsubscribes.ts`). Braid therefore does not ingest a Blast identity. Instead the golden profile carries an **email-suppression overlay** derived from `blast_unsubscribes` (a boolean `email_suppressed` keyed on the profile's `primary_email`). Because there is no Blast visibility branch, `email_suppressed` is admin-only on read (Section 2.5, S-r2-3).

**Enabled-source gating (security-driven, Section 2.5 / 5.5).** A source type is *not* an ingest option for an org until (a) it has a verified visibility branch in `apps/api/src/services/visibility.service.ts` mirroring that app's authoritative read predicate, and (b) it is listed in `braid_org_settings.enabled_source_types`. If a person-level source cannot get a faithful visibility predicate this cycle, it is dropped from v1 rather than shipped as an org-match-only leak.

Downstream consumers: Bond, Bill, and a future "Bridge" activation app (named only so the model leaves room; not built in v1).

**Out of v1 scope:** external-source ingestion (Salesforce/HubSpot), household/B2B hierarchy graphs beyond a flat person-to-company link, and probabilistic ML training on decisions. All are Open Questions (Section 12).

---

## 2. AI-native design

Braid's AI core is **deterministic-plus-embedding identity resolution with human-in-the-loop merge review**. The scoring math is reproducible and auditable (every link carries an evidence JSON that reconstructs the score). An LLM produces only a best-effort natural-language *rationale* on a proposed merge; it never decides a merge and never sees a raw amount or PII string that has not passed `can_access`.

### 2.1 The two-plane split (borrowed from the Basis pattern)

Braid keeps two computations in different trust planes, exactly as Basis separates certified drivers from per-viewer correlation (`docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md` Section 2.1):

1. **Deterministic match score (the shared decision input).** For a candidate pair, compute a reproducible score from typed features (Section 4.3). The score, and the **full weight set snapshot** (not just the model name), are stored on `braid_match_candidates.evidence` so an old candidate re-renders deterministically even after thresholds/weights change (ST8). Two admins looking at the same candidate see the same score.
2. **Per-viewer PII rendering (assembled at read time).** The golden record's denormalized PII columns are an **internal worker cache**, never served raw to a non-admin caller. The cached columns are `display_name`, `primary_email`, `primary_phone`, the `attributes` map, `email_suppressed`, `confidence`, and `identity_count`. When any caller opens a profile, timeline, candidate, or search result, every one of these is re-derived per viewer from only the member identities that pass `preflightAccess` (`apps/api/src/services/visibility.service.ts:1359`): fields whose winning source the caller cannot see are dropped; `identity_count` and the member list are recomputed from only visible members; **`confidence` is recomputed as `min()` over only `can_access`-passing members** (so a hidden weak member does not leak through the scalar, S-r2-3); `email_suppressed` is withheld from non-admins (no Blast visibility gate exists, S-r2-3). The shared score is computed by the worker under a first-party service context; the *display* is access-scoped per viewer. The fan-out is batched (one preflight query per `source_type`, not per identity), capped with cursor pagination, and the per-`(viewer, profile)` verdict is cached for a short TTL so read latency does not track hidden-member count (S-r2-6).

**Invariant (record and rely on).** A golden record's field values (`braid_profiles.attributes`) are a pure function of its member identities plus the survivorship rules, recomputed from scratch whenever the identity set changes. This invariant holds **only because** the recompute runs serialized under the per-blocking-key advisory lock and inside the single merge transaction (Section 4.4, ST1/ST2). A split can always rebuild both halves deterministically because every merge records exactly which identities it moved (`braid_merge_decisions.affected_identity_ids`).

### 2.2 Autonomy bands (the human-in-the-loop core)

Every candidate pair falls into one of three confidence bands, decided by the resolved score against per-org thresholds in `braid_org_settings` (defaults shown):

| Band | Score | Behavior |
| --- | --- | --- |
| **Auto-merge** | `>= auto_merge_threshold` (default 0.92) AND at least one strong deterministic signal (exact email or exact phone; an embedding-only high score never auto-merges, Section 4.3-4.4) | The worker merges autonomously (Section 4.4) and emits `profile.merged`. Every auto-merge writes a `braid_merge_decisions` row with `decision_kind='auto'`, `decided_by=<braid service account>`, so it is fully auditable and reversible. |
| **Review** | `[review_threshold, auto_merge_threshold)` (default 0.60-0.92), OR a high score with no strong signal | The worker creates a `braid_match_candidates` row (status `pending`) AND registers an `agent_proposals` row so the pair also lands in the human's approval inbox (registration detail below). No golden record changes until a human decides. |
| **No-op** | `< review_threshold` | Writes an identity-level `dedupe_decisions` `needs_review` suppression with a `resurface_after` cooldown so the pair is not rescored every tick (Section 4.2 honors it, D-r2-5). |

**Proposal registration (round-2 D-r2-1/D-r2-2).** `POST /v1/proposals` (`apps/api/src/routes/proposals.routes.ts:42`) makes `approver_id` mandatory, but a review-band merge has no single designated approver: it belongs in the org-admin queue (admins see the whole org queue, `:163`). So Braid **inserts directly into `agent_proposals`** (not through the public route, whose `POST` forbids a null approver) with `approver_id=NULL` (the column is nullable, `agent-proposals.ts:42`), `proposed_action='braid.merge_profiles'`, an explicit **`expires_at = now() + 7 days`** (the column is NOT NULL and a platform sweep flips `pending -> expired`, `agent-proposals.ts:46`, round-3 D3-3), and the subject modeled as the **candidate**: `subject_type='braid.candidate'`, `subject_id=<candidate.id>`. A single `subject_id` uuid cannot name a two-profile pair, so the candidate is the subject and the pair is recovered from the candidate row. After the insert Braid emits `publishBoltEvent('proposal.created', 'platform', ...)` mirroring the route (`proposals.routes.ts:114-134`) so platform approval-notification fan-out still fires for review items that bypassed the route (round-3 D3-5). **`braid.candidate` is intentionally NOT a `can_access`-resolvable entity type (round-3 D3-4):** it is not registered in `SUPPORTED_ENTITY_TYPES`; the inbox renders a `braid.candidate` subject by fetching the candidate through the `braid.candidate.read`-gated `GET /v1/candidates/:id` (which applies the per-viewer evidence filtering), not through `can_access('braid.candidate', id)`. A consumer that preflights the subject type gets `unsupported_entity_type` and falls back to the candidate read route.

**Single canonical decision path, kill-switch-safe (round-2 S-r2-1 / D3, hardened round-3).** `proposal_decide` (`proposals.routes.ts:275`) only flips `agent_proposals.status` (gated solely on `isOrgAdmin || approver_id === user.id`, no confirm token, no `braid.*` check) and emits `proposal.decided` on the `platform` source (`:328`). Braid has exactly one merge executor, `mergeCandidate(candidate_id, decided_by)`, and one reject executor, `rejectCandidate`, reached two ways:
- The **REST** endpoints `POST /v1/candidates/:id/merge` and `/reject` (the UI surface) call them directly, gated by `braid.profile.merge` and the register-tool policy layer.
- A **Bolt subscription** on `proposal.decided` **branches on `decision`** (the platform contract is `approve|reject|request_revision`, `proposals.routes.ts:52-63`, round-3 D3-1). For any branch it first reverse-looks-up the candidate via `braid_match_candidates.proposal_id = event.proposal.id` (the payload carries no `subject_id`, `:328-346`) and **re-SELECTs `agent_proposals.status` for `event.proposal.id`** rather than trusting the fire-and-forget frame (S3-2), requiring the real status to match the branch. It then resolves the **decider** actor from the proposal row (`approver_id`, or the org admin who decided) and, before any merge, fail-closes that actor through the reusable primitive `POST /v1/agent-policies/<decider_id>/check?tool=braid_merge_profiles` (`apps/mcp-server/src/lib/register-tool.ts:232`, which fail-closes on non-2xx, S3-4) AND asserts the decider holds `braid.profile.merge`. The branches:
  - `approve` with status `approved` -> `mergeCandidate` (CAS-guarded).
  - `reject` with status `rejected` -> `rejectCandidate`, which writes the `entity_type='braid.identity'` bridge-atom suppression of Section 2.3 so the pair does not re-surface next tick (D3-1).
  - `request_revision` -> leave the candidate `pending` and notify; no truth change.

  If the decider check fails, the subscription **no-ops and leaves the candidate `pending`**. A platform-source approval is never treated as equivalent to the `braid.profile.merge` confirm-token path. **Scope of the kill-switch (round-3 S3-3):** the `agent_policies` gate fail-closes only agent/service deciders (`register-tool.ts:205` returns `allowed:true` for `caller.kind==='human'`), so the human freeze control is **revoking `braid.profile.merge`** (point 2 of Section 2.5 re-asserts the tier), not the kill switch. An approved-but-frozen proposal will auto-execute via `braid-proposal-reconcile` once the freeze lifts unless the operator also rejects the candidate.

Both entrypoints are made exactly-once by a **compare-and-swap** inside the merge transaction: `UPDATE braid_match_candidates SET status='merged' WHERE id=$1 AND status='pending' RETURNING id`; only the row that flips proceeds (ST3). This kills the retry-double-merge and the human-vs-worker race; the loser no-ops.

A human decision (`merge` / `split` / `reject`) always wins over an auto-merge and is recorded in `braid_merge_decisions`; a rejected pair writes identity-level `dedupe_decisions` rows (Section 2.3) so the engine never re-surfaces it.

### 2.3 Reject-suppression keyed on stable atoms (D4)

`dedupe_decisions` (`0136_dedupe_decisions.sql`) is keyed on an immutable canonical pair `(entity_type, id_a < id_b)`. A Braid candidate is a pair of golden **profiles** whose ids die on merge, so keying suppression on profile ids would let a rejected pair re-surface after either profile re-clusters, and `entity_type='braid.profile'` would be a type-lie. Instead, Braid suppresses on the **stable identity atoms** that bridged the two profiles:
- `braid_identities.id` is immutable and survives merge/split (identity rows move between profiles but keep their id).
- On reject, Braid writes `dedupe_decisions` rows with `entity_type='braid.identity'` for the bridging identity pair (`bridge_identity_a_id`/`bridge_identity_b_id`), `decision='not_duplicate'`.
- Re-blocking (Section 4.2) checks identity-level suppression **before** proposing any profile-pair merge: if the bridging identity pair is suppressed, the candidate is not regenerated.

This keeps `entity_type` honest (the atoms really are `braid_identities`) and reuses the canonical ordered-pair contract of `dedupe-tools.ts:184` verbatim. Note (round-2 D-r2-8): because suppression is on the bridge *atoms* and not the profile pair, genuinely new member-level evidence (a different identity bridging the same two people on different keys) can legitimately re-open the pair for review. That is the intended consequence of atom-level keying, not a bug.

### 2.4 Truth-changing actions are HITL-gated

| Action | Autonomy | Mechanism |
| --- | --- | --- |
| Resolve an app record to its golden id | Autonomous, `braid.profile.resolve` (non-admin-grantable), `preflightAccess` on the input record, rate-limited | `braid_resolve` |
| Read a golden profile / timeline | Autonomous, `can_access`-filtered per `asker_user_id`, admin-tier for the full view | `braid_get_profile`, `braid_profile_timeline` |
| List / search profiles and candidates | Autonomous, admin-tier or per-viewer-assembled | `braid_list_profiles`, `braid_search_profiles`, `braid_list_candidates` |
| **Propose** a merge for human review | Autonomous, but `preflightAccess` on both profiles' members for the proposing asker, rate-limited | `braid_propose_merge` |
| **Reject** a candidate | Permission-gated (reuses `braid.profile.merge`; the confirm boundary is the merge, not the suppression, BP-r2-5) | `braid_reject_candidate` |
| **Merge** two golden profiles | HITL, Redis-backed confirm token | `braid_merge_profiles` |
| **Split** a golden profile | HITL, destructive, Redis-backed confirm token | `braid_split_profile` |
| Edit a survivorship rule | Permission-gated | `braid_set_survivorship_rule` |

Truth-flip tools use the Redis-backed dynamic-TTL confirm-token store (`apps/mcp-server/src/lib/confirm-token-store.ts`, 60s agent TTL / 5min human TTL), the pattern `CLAUDE.md` requires for delete-task / complete-sprint / remove-member.

### 2.5 Security model for consolidated PII

A golden profile is the single richest PII object in the suite (it merges every app's copy of a person). Braid must not become a channel that downgrades any source app's access rules.

1. **`resolve` is a distinct, non-admin-grantable permission (round-2 Theme 1).** `braid.profile.resolve` (`is_read:true`, non-admin-grantable, no confirm) gates only the narrow input-record-to-golden-id operation, so service accounts and per-app callers can drive the flagship wedge. It is made safe by three constraints, not by an admin gate: the input record is passed through `preflightAccess` first (deny returns `not_found`, never a golden id, S2); `identity_count` is suppressed for non-admins (a raw member count is linkage disclosure); and the write path is rate-limited per asker (Section 5.1). The **full profile READ** (`braid.profile.read`) and the candidate queue (`braid.candidate.read`) remain org-admin-tier by default, and even for a granted non-admin the returned view is re-assembled per viewer (point 2). There is no implication that `resolve` is admin-only.
2. **Per-viewer attribute re-assembly (S1b, defense in depth).** As in Section 2.1 plane 2, every viewer-visible scalar and attribute is re-derived from only member identities that pass `preflightAccess`. Bond's per-owner rule (`preflightBondContact`/`preflightBondDeal`, `visibility.service.ts:387-461` deny member/viewer non-owned contacts) is preserved through Braid, not bypassed.
3. **`braid_resolve` is not a deanonymization oracle (S2).** Covered by point 1: input preflight, count suppression, rate limit.
4. **No stub leakage (S3).** `/profiles/:id/identities` for a non-admin caller drops denied identities **entirely** (no masked stub, no `source_type` hint), and recomputes `identity_count` and the member list from only `can_access`-passing rows.
5. **Search is not a PII oracle (S4).** The `search_everything` Braid provider and `braid_search_profiles` restrict to admin askers and run per-viewer attribute assembly in the post-filter, fail-closed. The `search_vector` (from `display_name` + emails) is only ever queried under an admin asker.

**New visibility branches are in-scope v1 security work (S5/D7, refined round-2 S-r2-4).** Braid registers `braid.profile` and `braid.identity` in `SUPPORTED_ENTITY_TYPES` (`visibility.service.ts:91`), and intentionally NOT `braid.candidate` (which is resolved through the `braid.candidate.read`-gated candidate route instead of `can_access`, round-3 D3-4), and adds branches for the person-level source types it cites, each **mirroring that app's real authoritative read predicate**, with a unit test per branch:
- `bond.contact` / `bond.company`: already registered (`:426` / `:463`).
- `bill.client`: mirrors bill's real read predicate (bill list routes scope on org only, so org-match, same posture as the already-registered `bill.invoice` at `:1016`).
- `helpdesk.user`: **must mirror the real REQUESTER-read predicate in helpdesk-api, NOT the deliberately-permissive triage ticket branch** (`preflightHelpdeskTicket`, `:344`, returns `allowed:true` for any org user when `project_id IS NULL`, an intentional triage carve-out that defers isolation to helpdesk-api filters). Copying that would make every requester's name/email org-readable and then re-assemble it into golden profiles for non-owners. The branch test is written against the requester-read rule; if requesters are support-team-restricted, the Braid branch reflects that; if a faithful predicate cannot be written this cycle, `helpdesk.user` is dropped from v1 enabled sources per the 5.5 gate.
- `book.event_attendee`: gates through its parent `book.event` (org-match, mirroring `preflightBookEvent` at `:988`).

A source type is **not** enabled until its branch exists and its unit test passes (Section 5.5).

6. **Events are org-level linkage disclosure (S6).** `profile.merged` / `profile.split` / `candidate.created` broadcast to every org Bolt rule and subscribed agent runner with no per-user scoping, so they are kept **refs-only** and documented as org-level linkage side channels: `braid.*` outbound-webhook subscriptions require org-admin authorship and must never gain a PII field. `profile.merged` carries the **survivor** id plus the affected source-identity list (which the consumer already owns; needed for cache invalidation, ST5) but not the absorbed cluster's other members. Full pairwise linkage lives only on the immutable `braid_merge_decisions` audit table.
7. **`braid_propose_merge` guardrail (S7).** The proposing asker must pass `preflightAccess` on both profiles' member identities (or be admin); denied proposals are rejected, and proposal creation is rate-limited per agent.
8. **Org-scoping defense and the RLS posture (round-2 IN-r2-1).** RLS enforcement is a **platform-global** posture: `ALTER ROLE ... NOBYPASSRLS` is run only by `apps/api/src/boot/rls-boot.ts` and gated by `BBB_RLS_ENFORCE`; satellite services (like basis) get only the per-request GUC hook that sets `app.current_org_id` (`apps/basis-api/src/plugins/rls.ts`) and never flip the role. `braid-api` cannot unilaterally require enforcement, and the compose `DATABASE_URL` connects as the `POSTGRES_USER` superuser (which bypasses RLS regardless of the role attribute). So Braid's headline org-isolation guarantee is enforced by **application-level org-scoping** (every query carries `organization_id`, and the request pipeline sets the `app.current_org_id` GUC via a basis-style `plugins/rls.ts` that Braid inherits by modeling on `basis-api`, Section 9.1). RLS policies are authored on every `braid_*` table as defense in depth that binds when the platform flips `BBB_RLS_ENFORCE=1` and braid-api connects as the non-superuser `bam_app` role; that flip is a coordinated platform decision, not a braid-local knob. The Section 8 test is an **application-level org-scoping test** (a query for org A returns zero org-B rows through the service layer), plus an optional RLS-binding test that runs only when the enforced non-superuser role is provisioned.

### 2.6 Guardrails summary

- **agent_policies** (`0139_agent_policies.sql`, `apps/mcp-server/src/lib/register-tool.ts`): every `braid.*` service-account call passes the kill-switch + glob allowlist (`matchesAllowlist('braid.*')`). `braid.*` is **not** in the always-permitted core, so tools fail closed until an operator allowlists `braid.*`. Covered by a `register-tool` policy test. The same kill-switch check is re-run by the `proposal.decided` subscription before any merge (Section 2.2).
- **Per-action MCP resolver (basis satellite deferral, round-3 BP3-1):** Braid does NOT add `braid_*` to `EXPLICIT_TOOL_OVERRIDES`; the Wave D per-action resolver is deferred exactly as for the basis satellite (`generate-permission-manifest.mjs:757-776`). Adding tool overrides would collide with the hand-authored flags: tool rows are recorded first and `record()` derives `is_destructive`/`is_read`/`requires_confirmation` purely from the verb (`:672-674`), and `merge`/`split`/`reject`/`resolve` are in neither `DESTRUCTIVE_VERBS` nor `READ_VERBS`, so the truth-flip permissions would land non-destructive/non-confirm and the `if(!byId.has(...))` hand-authored loop at `:778` (no else-branch) would then skip the correct flags. The enforcing layers for Braid are REST `requireCan`, the §15 `braid.*` kill-switch/allowlist, and the merge/split confirm-token.
- **can_access preflight** per requesting user at read time on every cited source record (input to resolve, timeline row, candidate evidence, profile attribute provenance).
- **Prompt-injection / PII isolation:** the merge-rationale LLM call uses **only** the internal platform llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint, and receives **opaque identity tokens** (`IDENTITY_A`, `IDENTITY_B`) plus typed feature scores, never raw email/phone strings. Output is rendered plain text; the SPA re-hydrates labels client-side from structured evidence.

---

## 3. Data model

All Braid tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id`, matching `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Those policies bind when the platform flips `BBB_RLS_ENFORCE=1` (Section 2.5 point 8); until then, application-level org-scoping is the enforcing layer. Each table gets a 1:1 Drizzle module under `apps/braid-api/src/db/schema/` (`braid-profiles.ts`, `braid-identities.ts`, `braid-match-candidates.ts`, `braid-merge-decisions.ts`, `braid-survivorship-rules.ts`, `braid-org-settings.ts`, `index.ts`), mirroring `apps/bond-api/src/db/schema/` and `apps/basis-api/src/db/schema/`.

**Column-name join boundary (D8).** Braid uses `organization_id` on its own tables (matching basis/bond). The platform tables it joins to use `org_id` (`entity_links`, `dedupe_decisions`, `agent_proposals`). Any query crossing that boundary must alias explicitly.

### 3.1 Tables

**`braid_profiles`** - the golden record.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | the golden id; stable across merge via `merged_into_id` chain (Section 4.5) |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `kind` | varchar(8) NOT NULL | `person` \| `company` |
| `display_name` | varchar(320) | internal cache, per-viewer re-assembled on read |
| `primary_email` | varchar(320) | internal cache; nullable for `company` |
| `primary_phone` | varchar(64) | internal cache; nullable |
| `email_suppressed` | boolean NOT NULL DEFAULT false | Blast unsubscribe overlay keyed on `primary_email`; **admin-only on read** (no Blast visibility branch, S-r2-3) |
| `company_profile_id` | uuid | self-FK to a `kind='company'` profile; ON DELETE SET NULL; survivorship-resolved (Section 4.4) |
| `attributes` | jsonb NOT NULL DEFAULT `'{}'` | survivorship-resolved field map with per-field provenance; internal cache |
| `identity_count` | integer NOT NULL DEFAULT 0 | true member count; suppressed / recomputed per viewer (S2/S3) |
| `confidence` | numeric(5,2) | cached `min()` over member `link_confidence`; **recomputed per viewer over only `can_access`-passing members** on read (S-r2-3) |
| `status` | varchar(12) NOT NULL DEFAULT `'active'` | `active` \| `merged_away` \| `archived` |
| `merged_into_id` | uuid | when `merged_away`, the surviving profile id; self-FK ON DELETE SET NULL |
| `search_vector` | tsvector | from `display_name`+emails (GIN); queried only under an admin asker (S4) |
| `qdrant_point_id` | uuid | mirror id in the Qdrant `braid_profiles` collection |
| `qdrant_synced_at` | timestamptz | transactional-outbox marker: last successful re-embed (ST-r2-4) |
| `last_event_published_at` | timestamptz | last successful `profile.*` publish for this profile (ST-r2-4) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | `updated_at` bumped by every identity-set mutation; **no auto-update trigger** so the outbox marker stamp does not re-bump it (round-3 ST3-6) |

Indexes: `(organization_id, kind, status)`, `(organization_id, primary_email)`, `(organization_id, primary_phone)`, `(merged_into_id)`, `(qdrant_synced_at)` and `(last_event_published_at)` (outbox reconciliation, ST-r2-4), GIN on `search_vector`, GIN on `attributes`.

**`braid_identities`** - one row per source-app record mapped into a golden profile. No cross-schema FK; the source is a dotted type + uuid like `entity_links.dst_type`/`dst_id`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | immutable stable atom (survives merge/split); the `dedupe_decisions` suppression key (Section 2.3) |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_id` | uuid NOT NULL | FK `braid_profiles(id)` ON DELETE CASCADE |
| `source_type` | text NOT NULL | `bond.contact` \| `bond.company` \| `bill.client` \| `helpdesk.user` \| `book.event_attendee` |
| `source_id` | uuid NOT NULL | source-app row id |
| `match_keys` | jsonb NOT NULL DEFAULT `'{}'` | normalized blocking keys `{ email_norm, phone_norm, name_norm, domain }` |
| `raw_attributes` | jsonb NOT NULL DEFAULT `'{}'` | snapshot of source fields Braid read |
| `source_synced_at` | timestamptz | last time `raw_attributes` was refreshed from source |
| `needs_rescan` | boolean NOT NULL DEFAULT false | explicit DLQ give-up stamp (ST-r2-7); the rescan clears it after a successful re-process |
| `link_confidence` | numeric(5,2) | confidence of the link that attached this identity (D5); `seed` links are 1.0, later re-scored by the worker |
| `link_evidence` | jsonb NOT NULL DEFAULT `'{}'` | the feature breakdown that justified the attach (drives the timeline "why this member joined") |
| `link_kind` | varchar(8) NOT NULL DEFAULT `'auto'` | `auto` \| `human` \| `seed` |
| `linked_by` | uuid | FK `users(id)`; null for auto/seed |
| `linked_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, source_type, source_id)`, `(profile_id)`, `(organization_id, source_type)`, `(source_synced_at)`, `(organization_id, needs_rescan) WHERE needs_rescan` (DLQ resweep), GIN on `match_keys`.

**`braid_match_candidates`** - the human review queue.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `profile_a_id` / `profile_b_id` | uuid NOT NULL | canonical `profile_a_id < profile_b_id` CHECK |
| `bridge_identity_a_id` / `bridge_identity_b_id` | uuid NOT NULL | the two `braid_identities` that bridged; the suppression atoms and the source of a bridged candidate's score (Section 2.3 / 4.4) |
| `score` | numeric(5,2) NOT NULL | resolved match score in [0,1] |
| `evidence` | jsonb NOT NULL | direct or bridged shape (Section 3.3); full weight set snapshotted (ST8); values are refs, re-hydrated per viewer |
| `rationale` | text | best-effort LLM prose over opaque tokens; nullable |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `merged` \| `rejected` \| `superseded` |
| `proposal_id` | uuid | FK `agent_proposals(id)`; the subscription reverse-lookup key (D-r2-2); ON DELETE SET NULL |
| `created_at` / `decided_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, profile_a_id, profile_b_id)`, `(organization_id, status, score DESC)`, `(profile_a_id)`, `(profile_b_id)`, `(proposal_id)` (subscription reverse-lookup), `(organization_id, status, created_at)` (retention sweep + approved-but-pending reconciliation, ST-r2-5).

Status transitions (D8): `pending -> merged` (CAS), `pending -> rejected` (reject), and `pending -> superseded` whenever a merge/split changes either referenced profile's cluster. Every merge runs `UPDATE braid_match_candidates SET status='superseded' WHERE status='pending' AND (profile_a_id = :absorbed OR profile_b_id = :absorbed)` in the same transaction, so no candidate ever points at a `merged_away` id.

**`braid_merge_decisions`** - immutable audit for every merge, split, auto-merge, and reject.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `decision_kind` | varchar(8) NOT NULL | `auto` \| `merge` \| `split` \| `reject` |
| `surviving_profile_id` | uuid | merge/auto: the winner; split: the profile that was split |
| `absorbed_profile_id` | uuid | merge/auto: the profile merged away (reactivated on unmerge, Section 4.5) |
| `affected_identity_ids` | jsonb NOT NULL DEFAULT `'[]'` | the `braid_identities` ids moved by this decision (replay for split/unmerge) |
| `reverses_decision_id` | uuid | for split/unmerge, the decision being reversed; self-FK |
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
| `field` | varchar(64) NOT NULL | incl. `display_name`, `primary_email`, `primary_phone`, `title`, and `company_profile_id` (which employer wins on merge, D8) |
| `strategy` | varchar(20) NOT NULL | `most_recent` \| `source_priority` \| `longest_non_null` \| `most_frequent` \| `manual_pin` |
| `source_priority` | jsonb NOT NULL DEFAULT `'[]'` | ordered `source_type` list for `source_priority` |
| `pinned_value` | jsonb | for `manual_pin` |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, kind, field)`. The `company_profile_id` rule for a `person` profile resolves which linked employer-company profile survives when two people merge (default `most_recent` by `source_synced_at`).

**`braid_org_settings`** - per-org tunables (modeled on `basis_org_settings`, `0226_basis_core.sql:73`). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE; `UNIQUE` |
| `auto_merge_threshold` | numeric(5,2) NOT NULL DEFAULT 0.92 | prospective-only; changes re-evaluated by rescan (ST8) |
| `review_threshold` | numeric(5,2) NOT NULL DEFAULT 0.60 | |
| `require_strong_signal_for_auto` | boolean NOT NULL DEFAULT true | embedding-only high scores route to review, never auto-merge |
| `enabled_source_types` | jsonb NOT NULL DEFAULT `'[]'` | opt-in per org; a type is offered only if its visibility branch is verified (Section 2.5) |
| `rescan_max_age_days` | integer | null = never expire a candidate |
| `last_rescan_at` | timestamptz | advanced only after a fully successful tick (ST-r2-7) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): Braid writes durable `braid.profile -> <source_type>` links (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`). Note `org_id` here vs `organization_id` on Braid tables.
- `dedupe_decisions` (`0136_dedupe_decisions.sql`): reject/split verdicts and no-op `needs_review` cooldowns as `entity_type='braid.identity'` on the immutable identity-pair atoms (Section 2.3 / 4.2 / 4.5); the `resurface_after` column carries the no-op cooldown (D-r2-5).
- `agent_proposals` (`0128_agent_proposals.sql`): review-band candidates are inserted directly with `approver_id=NULL` (Section 2.2).
- `organizations`, `users`, and the platform `actor_type` enum.

### 3.3 JSONB shapes (authoritative)

```jsonc
// braid_profiles.attributes (internal cache; per-viewer re-assembled on read)
{
  "display_name":  { "value": "Thurston Howell III", "source_identity_id": "…", "source_app": "bond.contact", "rule": "source_priority" },
  "primary_email": { "value": "howell@…",            "source_identity_id": "…", "source_app": "bill.client",  "rule": "most_recent" }
}

// braid_match_candidates.evidence - DIRECT pairwise (A and B scored on 4.3 features)
{
  "shape": "direct",
  "features": [
    { "kind": "email_exact", "score": 1.0, "weight": 0.45, "a_value_ref": "id_a#email", "b_value_ref": "id_b#email" },
    { "kind": "name_trigram", "score": 0.86, "weight": 0.20 }
  ],
  "strong_signal": true,
  "weights": { "email_exact": 0.45, "phone_exact": 0.15, "name_trigram": 0.20, "embedding_cosine": 0.15, "domain_match": 0.05, "platform_user": 0.45 },
  "model": "braid-score-v1"
}

// braid_match_candidates.evidence - BRIDGED (D-r2-4): score/strong_signal derive from the
// bridging identity's TWO strong links to A and B, NOT a direct A-vs-B comparison. A and B may
// share no attribute yet still be the same person (email->A, phone->B).
{
  "shape": "bridged",
  "bridge_identity_id": "…",                         // the new identity that matched both
  "links": [
    { "profile": "A", "bridge_identity_a_id": "…", "kind": "email_exact", "score": 1.0, "strong": true },
    { "profile": "B", "bridge_identity_b_id": "…", "kind": "phone_exact", "score": 1.0, "strong": true }
  ],
  "score": 0.95,                                      // derived from the bridge links, reproducible
  "strong_signal": true,                              // true iff BOTH bridge links are strong
  "weights": { "email_exact": 0.45, "phone_exact": 0.15, "name_trigram": 0.20, "embedding_cosine": 0.15, "domain_match": 0.05, "platform_user": 0.45 },
  "model": "braid-score-v1"
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed migration tip on this branch is `0229_permissions_seed_actions_delta_020.sql`. **All numbers below are provisional.** Every file carries the header block (`-- Why:` / `-- Client impact:`) and uses idempotent DDL, matching `CLAUDE.md` conventions.

1. **`0230_braid_core.sql`** - `braid_profiles` (incl. `qdrant_synced_at`, `last_event_published_at`), `braid_identities` (incl. `link_confidence`/`link_evidence`/`source_synced_at`/`needs_rescan`), `braid_survivorship_rules`, `braid_org_settings`, all indexes, RLS policies. Self-FKs (`company_profile_id`, `merged_into_id`) added via guarded `DO $$` blocks after the table exists (mirrors `0226_basis_core.sql:62-68`). Additive only.
2. **`0231_braid_candidates_decisions.sql`** - `braid_match_candidates` (with `profile_a_id < profile_b_id` CHECK, `bridge_identity_*`, `proposal_id` FK), `braid_merge_decisions` (with `reverses_decision_id`), indexes, RLS. Additive only.
3. **`NNNN_permissions_seed_actions_delta_0MM.sql`** - **generated** (BP1/BP7). The `braid.*` rows are hand-authored because `braid_` is not in `APP_PREFIXES` (`scripts/generate-permission-manifest.mjs:74`), exactly as `basis_` is (`:719-776`). Strict sequence:
   - (a) land `0230`/`0231` on disk;
   - (b) register the **9** `braid.*` rows in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs`, each with an explicit `app:'braid'` (rows without `app` default to `'bam'` at `:783`, false provenance otherwise, BP-r2-3) AND an **explicit `is_read` value on every row** so no flag depends on verb inference (round-3 BP3-2): `braid.profile.read` (`is_read:true`), `braid.profile.resolve` (**`is_read:false`** because `POST /v1/resolve` can lazily mint a singleton, so it must not be reachable under a read-only API-key scope ceiling; a resolve caller needs at least `read_write` scope, and the mint is a benign idempotent singleton but is still a write), `braid.profile.merge` (`is_read:false, is_destructive:true, requires_confirmation:true`), `braid.profile.split` (`is_read:false, is_destructive:true, requires_confirmation:true`), `braid.candidate.read` (`is_read:true`), `braid.rule.read` (`is_read:true`), `braid.rule.write` (`is_read:false`), `braid.settings.read` (`is_read:true`), `braid.settings.write` (`is_read:false`);
   - (c) add an `if (c.id.startsWith('braid.')) { migrationLabel = '<this delta>'; sourceFile = 'braid metrics-style route'; }` branch at `generate-permission-manifest.mjs:800`, mirroring the basis branch at `:797-800`, so the manifest records the real braid delta migration + `braid-tools.ts` provenance;
   - (d) do NOT add `braid_*` to `EXPLICIT_TOOL_OVERRIDES` (round-3 BP3-1, basis satellite deferral): tool overrides are recorded first and derive flags from the verb, which would overwrite the hand-authored truth-flip flags; leaving `braid_*` unmapped in `TOOL_TO_PERMISSION` defers the Wave D resolver exactly as basis does, so the `HAND_AUTHORED` loop at `:778` is the sole creator of all 9 rows and its explicit flags land;
   - (e) regenerate the manifest and verify with `check-permission-catalog.mjs`;
   - (f) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number and delta suffix (do not hand-pick). Additive only.

Bolt event registration (Section 7) and the `SUPPORTED_ENTITY_TYPES` additions (Section 2.5) are TypeScript edits, not migrations. The Qdrant `braid_profiles` collection is created **lazily on first use** (Section 9.5), not by SQL.

---

## 4. Identity-resolution engine

The engine runs as **BullMQ workers** in `apps/worker` (queue `braid-match-on-ingest`), not in the request path. It is triggered live by source-app events (Section 6) and by a nightly source-diffing re-scan. It is emphatically not a quarterly batch.

### 4.1 Ingest and normalization

The worker reads the changed source row **directly via Postgres** (the worker already runs `bond-stale-deals` and `blast-send` against these schemas with its `DATABASE_URL`; no server-to-server HTTP for source reads). **Org derivation for org-less sources (round-2 D-r2-6):** `book_event_attendees` has no `organization_id`; its org is joined via `book_events.organization_id` (the same parent the visibility branch gates through, `visibility.service.ts:988`) before the `(organization_id, source_type, source_id)` upsert. The helpdesk requester org column is unverified and must be confirmed at implement time (Section 12). It upserts a `braid_identity` (`ON CONFLICT (org, source_type, source_id) DO UPDATE`, refreshing `raw_attributes` and `source_synced_at`) with normalized `match_keys`:
- `email_norm`: lowercased, trimmed, plus-address stripped for free-mail domains.
- `phone_norm`: E.164 where parseable, else digits-only.
- `name_norm`: lowercased, punctuation-stripped, unicode-folded.
- `domain`: email domain, dropping free-mail domains.

### 4.2 Blocking / candidate generation (reuse-first, serialized on ALL keys)

Candidates come from three cheap unioned paths:
1. **Exact-key blocking (SQL).** GIN lookups on `braid_identities.match_keys` for identities sharing `email_norm` or `phone_norm`.
2. **Fuzzy-name blocking (SQL, pg_trgm).** Trigram similarity on `name_norm`, the same mechanism `bond_find_duplicates` uses (`dedupe-tools.ts:75`).
3. **Embedding recall (Qdrant).** Embed `name + email-local-part + company` and query the Qdrant `braid_profiles` collection. Cross-app manual UI search uses `search_everything`.

**Suppression check.** Before generating any profile-pair candidate, the engine checks `dedupe_decisions` for the bridging identity pair: a `not_duplicate` verdict is skipped (anti-flap, ST4), and a `needs_review` verdict is skipped **until its `resurface_after` cooldown has elapsed** (the no-op efficiency claim, D-r2-5). The no-op band write sets `resurface_after` accordingly.

**Serialization on EVERY blocking key (round-2 ST-r2-1, hardened round-3 ST3-2).** A single-strongest-key lock is insufficient: two records sharing only `phone` but differing on `email` would take different locks and each mint a seed keyed on the shared phone (the N-way bridging case). Create-or-attach uses a **single shared lock helper** (imported by both the worker and the resolve path so they cannot diverge) that:
- (a) derives **one two-int advisory token per key**, namespaced by class and org: `pg_advisory_xact_lock(<class int4 = hash('email' | 'phone')>, <hash(org_id || ':' || key_value) int4>)`. The org namespace stops `john@gmail.com` in two different orgs from contending globally, and the class int4 stops an `email_norm` colliding with a `phone_norm` in a single-bigint space.
- (b) acquires the tokens for all of the new identity's present blocking keys **sorted by the FINAL numeric `(class, key_hash)` token tuple** (identically in the worker and in resolve, since both call the same helper), so acquisition order is deterministic and deadlock-free. It is NOT sorted by the raw normalized string (which would order differently from the hashed bigints and could deadlock a worker against a resolve).
- (c) enforces one global lock-class order on **every** path including direct merge: **all advisory key-locks first, then `SELECT ... FOR UPDATE` on profile rows ordered by `id`**.

A new profile may be minted **only while holding the locks for all of the new identity's blocking keys**, so any racing job that shares any key blocks, then re-reads and attaches. The bridge-merge in 4.4 runs inside this same locked transaction. The `FOR UPDATE` row-lock step mirrors `apps/api/src/services/org.service.ts:429-489` / `:871-940` (which use row locks, NOT advisory locks; there is no in-repo advisory-lock precedent, so the helper above is the authoritative spec). Qdrant-down degrades to paths 1 and 2 only; the engine never blocks on Qdrant. A regression test asserts two records sharing only phone but differing on email resolve to one profile.

### 4.3 Scoring features (direct pairwise)

For a direct candidate pair, compute a weighted score (weights snapshotted into `evidence.weights`, ST8):

| Feature | Signal | Default weight | Strong? |
| --- | --- | --- | --- |
| `email_exact` | `email_norm` equal | 0.45 | yes |
| `phone_exact` | `phone_norm` equal | 0.15 | yes |
| `name_trigram` | pg_trgm similarity on `name_norm` | 0.20 | no |
| `embedding_cosine` | Qdrant cosine on the identity embedding | 0.15 | no |
| `domain_match` | same company `domain` | 0.05 | no |
| `platform_user` | same non-null `book_event_attendees.user_id` (a real nullable FK to `users`, `book-event-attendees.ts:19`), i.e. two identities anchored to the same platform user | 0.45 | yes |

Score = sum(feature_score * weight), clamped to [0,1]. `strong_signal = email_exact OR phone_exact OR platform_user` (a shared platform user id is a high-precision anchor, round-3 D3-6).

### 4.4 Decision bands, N-way bridging, and survivorship

The resolved score routes into the three bands of Section 2.2. `require_strong_signal_for_auto` means a 0.95 built entirely from name+embedding routes to **review**.

**N-way bridging merge (round-2 D-r2-4, scoring corrected).** A new identity can strongly match two *different* existing profiles (exact email to A, exact phone to B). A and B may share no attribute, so a **direct** A-vs-B score would be below the auto bar even though the bridge is strong. Therefore a **bridged** candidate's `score` and `strong_signal` derive from the **bridging identity's two strong links** (recorded via `bridge_identity_a_id`/`bridge_identity_b_id`, evidence `shape:"bridged"` in Section 3.3), not a direct A-vs-B attribute comparison. The auto/review decision is reproducible from that stored bridge evidence: auto-merge iff **both** bridge links are strong-signal, else review. The engine then:
1. Generates the profile-pair merge candidate between A and B with the bridged evidence, running the band logic and CAS inside the locked transaction of 4.2.
2. Attaches the new identity to the **survivor** of that merge. Initial-attach tie-break when the merge is only review-band (not yet executed): attach to the **oldest** profile, then the one with the most `human`/`seed` identities.

**Merge execution (ST2/ST3, transactional).** `mergeCandidate` / direct merge runs its DB steps in **one Drizzle transaction**:
0. `SELECT ... FOR UPDATE` both profiles (deadlock-safe lock order by id); CAS the candidate (`... WHERE status='pending' RETURNING id`) and, for direct merges, assert neither profile is already `merged_away`. If the CAS returns no row, abort (another actor won).
1. Move all `braid_identities` of the absorbed profile to the survivor.
2. Set absorbed `status='merged_away'`, `merged_into_id=survivor`; recompute `identity_count` and cached `confidence` (weakest-link).
3. **Recompute survivorship** for every golden field, including `company_profile_id`, from `braid_survivorship_rules` over the union of member `raw_attributes`, rewriting `attributes` with fresh provenance. Supersede stale candidates (Section 3.1 status rule). Insert the `braid_merge_decisions` row. Leave `qdrant_synced_at` / `last_event_published_at` unchanged (they lag the new `updated_at`, which is how the outbox reconciliation finds this profile).

After commit, **best-effort and outside the transaction**: re-embed the survivor into Qdrant, and `publishBoltEvent('profile.merged', ...)`. **Each marker is stamped to the exact `updated_at` value the step OBSERVED, not `now()` (round-3 ST3-1):** `SET qdrant_synced_at = <observed updated_at>` and `SET last_event_published_at = <observed updated_at>`. Stamping `now()` would mask a concurrent merge whose own `updated_at` bump (and whose own crashed publish) landed between the read and the stamp; stamping the observed value leaves `marker < the new updated_at`, so the concurrent change is reprocessed next tick. This is the "capture the version you processed" discipline of `bond-stale-deals.job.ts:127-138`. A crash between commit and these side effects leaves a correct golden record with a stale marker; the rescan finds it (`WHERE qdrant_synced_at IS NULL OR qdrant_synced_at < updated_at`, likewise for the event marker) and replays. **Identity-set invariant (round-3 ST3-6):** every mutation to a profile's identity set (merge, sub-merge-bar attach/seed, and the resolve lazy-mint of Section 5.1) bumps `updated_at` and defers the marker stamp, and `braid_profiles` carries **no `updated_at` auto-update trigger** (the marker-stamp UPDATE must not re-bump `updated_at`, or the profile would re-embed every night forever). This mirrors the post-commit external-call shape of `apps/worker/src/jobs/basis-metric-snapshot.job.ts`.

### 4.5 Unmerge / split (D2, with audit and anti-flap)

- **Unmerge (reverse a specific merge).** `braid_split_profile` given a `merge_decision_id` **reactivates the original absorbed profile**: it flips its `status` back to `active`, clears `merged_into_id`, and reattaches exactly the `affected_identity_ids` the merge recorded, **restoring the original profile id** so cached consumers are not orphaned. A `braid_merge_decisions` row (`decision_kind='split'`, `reverses_decision_id=<the merge>`) completes the chain.
- **Fresh-id split (the "actually two people" case).** Given an explicit `identity_ids` set with no prior merge, mint a new profile, move the named identities, recompute survivorship on both.

**Anti-flap (ST4, bounded round-2 ST-r2-6, invariant sharpened round-3 ST3-4).** A split records a **per-split separation-set marker** rather than the full NxM cross-product (splitting 30 identities from 20 would be 600 pairwise rows). **The invariant that closes the auto-remerge window:** the split writes **synchronously, in the HITL path, every STRONG-signal pair** (`email_exact` / `phone_exact` / `platform_user`) among the separated identities, because those are the only pairs that could cross the auto-merge bar. The **async, capped backfill** covers only weak pairs (`name_trigram` / `embedding_cosine` / `domain_match`), which are review-band and cannot auto-remerge, so a delay in the backfill can at worst re-surface a weak pair for human review, never silently re-merge. All are flagged human-separated. Blocking excludes suppressed pairs before scoring. Honest scope: a human-separated pair **cannot re-merge on the same evidence**; genuinely new member-level evidence can re-open it for review (Section 2.3, D-r2-8).

**Stable-id contract for consumers (ST5).** `braid_resolve` MUST follow the `merged_into_id` chain to the live `active` survivor. `profile_id` is therefore not a durable key across merges; both `profile.merged` and `profile.split` carry the affected source-identity list (`source_type` + `source_id`) so a consumer holding "bond.contact X -> P" learns X now resolves to the survivor and re-resolves. Consumers re-resolve on any `profile.*` event.

### 4.6 Where it runs

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `braid-match-on-ingest` | event-driven (Section 6) | Normalize the changed source row into a `braid_identity`, block (suppression check + all-keys advisory lock), score, route to a band, run N-way bridging. Idempotent. Bounded retry + backoff + DLQ (ST7); on give-up sets `braid_identities.needs_rescan=true` (ST-r2-7). |
| `braid-rescan` | daily (`20 3 * * *`, non-zero minute) | **Source-diffing (round-2 ST-r2-3).** For each enabled `source_type` it (a) selects source rows `WHERE source.updated_at > braid_identities.source_synced_at` (changed-since-ingest; this catches an in-place edit **only if the source mutation path bumps `updated_at`**, a precondition tracked in Section 12, round-3 ST3-3; where a source cannot guarantee that, its change-detection is driven off `bolt_recent_events` upsert events instead of the `updated_at` diff), (b) left-anti-joins the source table against `braid_identities` to find source rows with **no identity yet** (the outage backfill; the anti-join alone does NOT cover in-place edits), and (c) selects `braid_identities WHERE needs_rescan` (DLQ give-ups). It also reconciles the transactional outbox: re-embed `WHERE qdrant_synced_at IS NULL OR qdrant_synced_at < updated_at` and re-publish where `last_event_published_at` lags, stamping each marker to the `updated_at` it observed (never `now()`, round-3 ST3-1). LIMIT'd cursor batches with a per-tick cap; `last_rescan_at` is advanced **only after a fully successful tick** (a mid-tick crash is resumable from the per-identity `source_synced_at`/`needs_rescan` high-water, ST-r2-7); per-N (`%25`) progress logging via `@bigbluebam/logging`, modeled on `basis-metric-snapshot.job.ts`. |
| `braid-proposal-reconcile` | **dedicated 10-minute sweep** (preferred over the daily fold for delivery-loss latency, round-3 ST3-5) | **At-least-once for the proposal bridge (ST-r2-5, extended round-3 D3-1/D3-3/S3-2/ST3-5).** `proposal.decided` is fire-and-forget Bolt (`bond-stale-deals.job.ts:23` shape). For each `agent_proposals` row with `proposed_action='braid.merge_profiles'` whose linked `braid_match_candidates.proposal_id` candidate is still `pending`: (a) `status='approved'` -> re-derive the **original decider** from the proposal (`approver_id`/decided-by, not the worker service account), re-check that actor via `POST /v1/agent-policies/<decider_id>/check?tool=braid_merge_profiles`, then `mergeCandidate`; (b) `status='rejected'` -> `rejectCandidate` (writes the bridge-atom suppression so the pair does not re-surface, D3-1); (c) `status='expired'` -> clear the stale `braid_match_candidates.proposal_id` and re-register a fresh proposal, or surface "inbox entry expired; decide in the Braid candidate queue" (D3-3). Safe because `mergeCandidate`/`rejectCandidate` are CAS-idempotent; a duplicate delivery no-ops. |
| `braid-candidate-retention` | daily (`50 3 * * *`, non-zero minute) | Purge terminal-status candidates older than N days (`basis-retention-sweep.job.ts` model, ST8). Never touches `braid_merge_decisions`. |

Retry/backoff on source-app failure (ST7) reuses the BullMQ `attempts` + exponential-backoff schedule of `agent-webhook-dispatch.job.ts` (0s/30s/2m/...) with a give-up DLQ modeled on `agent-webhook-dlq.job.ts`; source reads use a bounded `AbortController` timeout. All fan-out sets `app.current_org_id` per org (the `INTERNAL_SERVICE_SECRET` + explicit `org_id` pattern of `banter-feed-fanin`) and wraps each `(org, identity)` in try/catch log-and-continue.

---

## 5. API surface

Base path `/braid/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler` (`apps/basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Shapes live in `packages/shared/src/schemas/braid.ts`.

### 5.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/profiles` | List golden profiles | `braid.profile.read` (admin-tier); per-viewer assembly for granted non-admins |
| GET | `/v1/profiles/:id` | Get a golden profile + provenance | attributes and scalars re-assembled per viewer (S1b, S-r2-3) |
| GET | `/v1/profiles/:id/identities` | List member source identities | non-admin: denied rows dropped entirely, count recomputed (S3); cursor-paginated (S-r2-6) |
| GET | `/v1/profiles/:id/timeline` | Cross-app timeline | fail-closed mapping: a row is included only if it maps to a member identity whose source entity the caller passed `preflightAccess` on; any event not tied to a `can_access`-passing member is dropped (S-r2-7) |
| GET | `/v1/profiles/:id/decisions` | Merge/split audit history | `braid.profile.read` (admin-tier); each decision's `affected_identity_ids` and `absorbed_profile_id` are filtered through the same batched `preflightAccess` as the member list, dropping unmappable ids fail-closed so the array length cannot defeat `identity_count` suppression (round-3 S3-1) |
| POST | `/v1/resolve` | Resolve `{source_type, source_id}` to a stable golden id | `braid.profile.resolve` (non-admin-grantable); `preflightAccess` on the input record first, `not_found` if denied; `identity_count` suppressed for non-admins; follows `merged_into_id` chain; **rate-limited per asker** (it writes); lazy minting is locked and identity-first (below) |
| GET | `/v1/candidates` | List review-queue candidates | `braid.candidate.read`; sort `-score` |
| GET | `/v1/candidates/:id` | Candidate detail + evidence | evidence value-refs re-hydrated per caller |
| POST | `/v1/candidates/:id/merge` | Confirm a merge | `braid.profile.merge`; the single `mergeCandidate` executor (CAS-guarded); resolves the linked `agent_proposals` row |
| POST | `/v1/candidates/:id/reject` | Reject a candidate | `braid.profile.merge` (confirm not enforced here; the HITL boundary is the merge, BP-r2-5); writes identity-level suppression |
| POST | `/v1/profiles/merge` | Merge two profiles directly | `braid.profile.merge`; `{ profile_a_id, profile_b_id, reason }`; `FOR UPDATE` + `merged_away` re-check |
| POST | `/v1/profiles/:id/split` | Unmerge or split | `braid.profile.split`; `{ merge_decision_id? | identity_ids?, reason }` (Section 4.5) |
| GET | `/v1/survivorship-rules` | List rules | `braid.rule.read` |
| PUT | `/v1/survivorship-rules/:kind/:field` | Upsert a rule | `braid.rule.write` |
| GET | `/v1/settings` | Get org settings | `braid.settings.read` |
| PATCH | `/v1/settings` | Update org settings | `braid.settings.write`; source-type enablement gate (Section 5.5) |
| POST | `/internal/events` | Ingest-trigger from bolt-api (Section 6) | `INTERNAL_SERVICE_SECRET`; enqueues into `braid-match-on-ingest`; no public route |
| GET | `/health` / `/readyz` | Probes | from `@bigbluebam/service-health` `healthCheckPlugin` (BP5), `/readyz` checks **only Postgres + Redis** (`apps/basis-api/src/server.ts:76`) |

**Lazy resolve minting is locked and worker-deferred (round-2 Theme 3, D-r2-3 / ST-r2-2).** `resolve` runs in braid-api, not the worker, so two concurrent resolves (or a resolve racing an ingest) could each see no identity and each `INSERT braid_profiles`, leaking an orphan empty profile even though `UNIQUE(org, source_type, source_id)` on `braid_identities` blocks a duplicate identity (the profile insert happens first). So `resolve` acquires the **same all-keys advisory lock as the worker (Section 4.2)** before any write, and is structured identity-first inside the locked transaction: `INSERT braid_identities ... ON CONFLICT (org, source_type, source_id) DO NOTHING RETURNING profile_id`; a profile is minted **only when the identity row is genuinely new**, as a bare singleton (no matching in the request path). `resolve` then enqueues `braid-match-on-ingest` for the freshly-seeded identity so it clusters normally in the worker. The seed's `link_confidence` is 1.0 as a singleton and is re-scored when the worker attaches or bridges it. The mint bumps `updated_at` and defers the outbox marker stamp per the identity-set invariant (Section 4.4, round-3 ST3-6).

### 5.2 Realtime (`/braid/ws`)

Redis-PubSub, org-scoped rooms. Payloads are **refs-only**: `candidate.created { candidate_id, score }`, `profile.merged { surviving_profile_id, affected_identities: [...] }`, `profile.split { surviving_profile_id, new_profile_id?, affected_identities: [...] }`. No PII or evidence in the frame; the SPA fetches through the per-caller filtered read path. Notification channel only.

### 5.3 Permissions (9 rows)

Manifest-generated `app.resource.verb`, resolved by an `apps/basis-api/src/plugins/permissions.ts`-style plugin: `braid.profile.read`, **`braid.profile.resolve`**, `braid.profile.merge` (destructive, confirm), `braid.profile.split` (destructive, confirm), `braid.candidate.read`, `braid.rule.read`, `braid.rule.write`, `braid.settings.read`, `braid.settings.write` (**9 rows**). `braid.profile.read` and `braid.candidate.read` default to org-admin-equivalent; `braid.profile.resolve` is non-admin-grantable (Section 2.5 point 1). The hand-authored registration + `EXPLICIT_TOOL_OVERRIDES` sequence is Section 3.4 step 3.

### 5.4 The single canonical decision path

`/candidates/:id/merge`, `/candidates/:id/reject`, `/profiles/merge`, and `/profiles/:id/split` are the **only** endpoints that mutate golden truth. The `agent_proposals` inbox is a notification-and-approval pointer whose subject is the **candidate** (`subject_type='braid.candidate'`, `subject_id=candidate.id`); approving a `braid.merge_profiles` proposal fires `proposal.decided`, and Braid's subscription reverse-looks-up the candidate via `braid_match_candidates.proposal_id = event.proposal.id` (the payload carries no subject, D-r2-2), re-checks the `braid.*` kill-switch and asserts `braid.profile.merge` (S-r2-1), then calls the same `mergeCandidate`.

**Exactly-once, stated precisely (round-2 ST-r2-8).** Exactly-once is guaranteed by the **candidate-status CAS** for candidate-backed merges (the review path), and by **`SELECT ... FOR UPDATE` + a `merged_away` re-check** for the candidate-less direct-merge path (`POST /v1/profiles/merge`, which has no candidate row). The REST-merge then resolving its `agent_proposals` row via `proposal_decide` produces an intentional `proposal.decided` echo, which the subscription drives back into `mergeCandidate` where the CAS harmlessly no-ops. That echo is expected and must not be mistaken for a double-execute during incident triage.

### 5.5 Source-type enablement gate

`PATCH /v1/settings` may add a `source_type` to `enabled_source_types` only if that type has a verified `visibility.service.ts` branch (Section 2.5). The endpoint rejects enabling a type whose branch is absent with a typed `SOURCE_TYPE_NOT_SUPPORTED` error.

---

## 6. Background work and the ingest transport

BullMQ workers in `apps/worker` (Section 4.6). The live trigger transport (IN3):

**Bolt event to BullMQ enqueue.** The source apps publish upsert/create events through `bolt-api` ingest. Braid registers the `(source, event_type)` pairs it cares about with `bolt-api`, which POSTs each matching event to Braid's internal route `POST /braid/api/internal/events` (guarded by `INTERNAL_SERVICE_SECRET`); that route enqueues a refs-only job `{ org_id, source_type, source_id }` into the shared Redis `braid-match-on-ingest` queue. Subscribed events: `bond` `contact.upserted` / `company.upserted`; `bill` client create/update; `helpdesk` `user.upserted`; `book` attendee create.

Whether `bolt-api` already exposes this internal per-event dispatch, or needs a small route added, is an Open Question dependency (Section 12). **The live path is a soft dependency because the nightly `braid-rescan` source-diffs each enabled source table directly** (changed-since-ingest via source `updated_at`, plus a left-anti-join for un-ingested rows, Section 4.6, ST-r2-3), so a dropped dispatch degrades to genuine next-day resolution rather than to a stale-watermark blind spot.

The worker service needs new env: `QDRANT_URL` (embedding recall + re-embed) and `BBB_API_INTERNAL_URL` (llm-provider embeddings). **Neither is currently in the worker compose env** (`docker-compose.yml:229-253` has only `INTERNAL_SERVICE_SECRET`, `BOLT_API_INTERNAL_URL`, `BOOK_API_INTERNAL_URL`), so both must be **added** there (round-2 IN-r2-2/IN-r2-3). It does not need source-app internal URLs because it reads those schemas directly via `DATABASE_URL`. Wiring detail is in Section 9.2.

---

## 7. Events & integration

### 7.1 Bolt events published (source `braid`)

Via `publishBoltEvent(eventType, 'braid', payload, orgId, actorId?, actorType?)` (positional signature, `packages/shared/src/bolt-events.ts:35`), bare names, each registered with a `payload_schema` in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI. Payloads are refs + magnitude only; org-level linkage disclosure (S6).

| `event_type` | When | Payload |
| --- | --- | --- |
| `profile.merged` | two profiles merged (auto or human) | `profile.id` (survivor), `affected_identities` (`source_type`+`source_id` list), `identity_count`, `decision_kind`, `actor.*`, `org.*` |
| `profile.split` | a profile unmerged or split | `profile.id` (survivor), `new_profile_id?`, `affected_identities`, `actor.*`, `org.*` |
| `profile.matched` | a new identity auto-linked below the merge bar | `profile.id`, `identity.source_type`, `identity.source_id`, `org.*` |
| `candidate.created` | a review-band candidate was queued | `candidate.id`, `score`, `org.*` |

### 7.2 entity_links

On every profile-to-identity link, Braid upserts an `entity_links` row (`src_type='braid.profile'`, `dst_type=<source_type>`, `link_kind='related_to'`, `ON CONFLICT DO NOTHING`).

### 7.3 Unified activity & search

Register a **Braid provider in `search_everything`** (`apps/mcp-server/src/tools/search-tools.ts`), restricted to admin askers with per-viewer post-filtering, fail-closed (S4). Braid catalog changes flow as the Bolt events above, not into the fixed `v_activity_unified` UNION in v1 (bam/bond/helpdesk only). The timeline reads `v_activity_unified` + `bolt_recent_events` for member identities, with the fail-closed mapping of Section 5.1 (S-r2-7).

---

## 8. Testing

- **Unit (Vitest, schema-isolated via `@bigbluebam/db-stubs`, basis safety-suite precedent commit `7587872c`):**
  - deterministic scorer: fixed feature inputs produce a fixed direct score and `strong_signal`; **bridged** scorer derives score/strong_signal from the two bridge links, not a direct A-vs-B comparison (D-r2-4).
  - band routing: threshold boundaries, `require_strong_signal_for_auto`, N-way bridging tie-break.
  - survivorship recompute: each strategy, `company_profile_id` resolution, provenance.
  - split-replay: `affected_identity_ids` reattach restores the original absorbed profile id (unmerge) and the fresh-id split path.
  - suppression: identity-level keying survives merge/split; `needs_review` `resurface_after` cooldown is honored by blocking; a human-separated pair cannot re-merge on the same evidence.
  - CAS exactly-once: two concurrent `mergeCandidate` calls, only one flips; direct-merge exactly-once via `FOR UPDATE` + `merged_away` re-check.
  - **all-keys lock (ST-r2-1):** two records sharing only phone but differing on email resolve to one profile.
  - **resolve minting (Theme 3):** concurrent resolves for a new record mint exactly one profile, no orphan.
  - **outbox reconciliation (ST-r2-4):** a merge whose post-commit re-embed/publish is skipped is found and replayed by rescan via the `qdrant_synced_at`/`last_event_published_at` markers.
  - **proposal reconcile (ST-r2-5):** an approved `braid.merge_profiles` proposal whose candidate is still pending is driven to merge by the sweep; a kill-switch-engaged decision no-ops and leaves it pending (S-r2-1).
  - **per-viewer scalars (S-r2-3):** `confidence` recomputes over visible members; `email_suppressed` withheld from non-admins.
- **visibility.service.ts branch tests:** one per new branch (`bill.client`, `helpdesk.user` against the real requester-read predicate not the triage carve-out (S-r2-4), `book.event_attendee`, `braid.profile`, `braid.identity`); a source is not enabled until its test passes (Section 5.5).
- **register-tool policy test:** `braid.*` fails closed until allowlisted (the §15 kill-switch/allowlist); Braid does not populate `TOOL_TO_PERMISSION` (basis-style Wave D deferral, round-3 BP3-1), so the test asserts the allowlist gate, not per-action mapping. A manifest test asserts the two truth-flip rows land `is_destructive:true, requires_confirmation:true` and `braid.profile.resolve` lands `is_read:false` (BP3-1/BP3-2).
- **Org-scoping test (round-2 IN-r2-1):** a service-layer query for org A returns zero org-B rows on every `braid_*` table (application-level), plus an optional RLS-binding test that runs only when the enforced non-superuser role is provisioned.
- **e2e:** gilligan-seeded stories - the Skipper appears as a Bond contact, a Bill client, and three Book attendees; Braid clusters them into one golden profile; the reviewer confirms a review-band merge; a wrong merge is split and does not re-merge on the same evidence.

---

## 9. Infrastructure

### 9.1 New api compose service

`braid-api` in `docker-compose.yml`, modeled on `basis-api` (`docker-compose.yml:798`): `PORT: 4020`, stateless, horizontally scalable. **It inherits the basis-style per-request RLS GUC plugin (`apps/basis-api/src/plugins/rls.ts`) by modeling on basis-api**, which sets `app.current_org_id` per request; it does NOT flip the DB role (that is `apps/api/src/boot/rls-boot.ts`, a platform-global action, Section 2.5 point 8). `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Source apps and Qdrant are NOT in `depends_on`. Env: `DATABASE_URL`, **`DATABASE_READ_URL=${DATABASE_READ_URL:-}`** (read-replica offload for the read-heavy per-viewer re-assembly, search fan-out, and blocking scans, falling back to `DATABASE_URL` when empty, mirroring `basis-api` at `docker-compose.yml:805`, round-3 IN3-1), `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, **`INTERNAL_SERVICE_SECRET` (non-empty)**, `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `QDRANT_URL` (+ optional `QDRANT_API_KEY`), `CORS_ORIGIN`, rate-limit knobs. Healthcheck: `curl -sf http://localhost:4020/health`.

### 9.2 Worker service wiring (round-2 IN-r2-2/IN-r2-3)

The engine runs in `apps/worker`. Two edits:
- **Compose (`docker-compose.yml:229-253`):** add **both** `QDRANT_URL: http://qdrant:6333` and `BBB_API_INTERNAL_URL: http://api:4000` to the `worker` service env (neither is present; the worker embeds via the platform llm-provider and re-embeds into Qdrant), matching the in-tree address convention (round-3 IN3-2).
- **Catalog (`scripts/deploy/shared/services.mjs`):** `QDRANT_URL` is **already** in the worker catalog `optional` (`services.mjs:503`); add only `BBB_API_INTERNAL_URL` to `worker.optional`.
- **`worker.needs` intentionally unchanged (round-3 IN3-3):** every new braid worker upstream (`api` for embeddings, `qdrant` for vectors) is a degradable, retried, DLQ'd request-time dependency (ingest falls back to key+trigram blocking on a Qdrant/api outage), consistent with the existing worker posture, so neither is promoted to `worker.needs`.

No source-app internal URLs are added; the worker reads source schemas directly via `DATABASE_URL` (one shared DB).

### 9.3 SPA build (the SPA is not its own service; four sites)

Every SPA is built in the single `apps/frontend/Dockerfile` and `COPY`'d into `/usr/share/nginx/html/<app>`. Braid edits it in **four** sites, mirroring the exact basis lines:
1. deps-stage `COPY apps/braid/package.json ./apps/braid/` (like `Dockerfile:22`).
2. build-stage 4-line source COPY block (like `:117-120`): `COPY apps/braid/src ./apps/braid/src`, `COPY apps/braid/public ./apps/braid/public`, `COPY apps/braid/index.html ./apps/braid/`, `COPY apps/braid/tsconfig.json apps/braid/tsconfig.node.json apps/braid/vite.config.ts ./apps/braid/`.
3. add `&& pnpm --filter @bigbluebam/braid build` to the build `RUN` (like `:181`).
4. production-stage `COPY --from=build /app/apps/braid/dist /usr/share/nginx/html/braid` (like `:205`).

There is no deps-stage source COPY and no separate `braid` compose service.

### 9.4 nginx routing

`infra/nginx/nginx.railway.conf` is **auto-generated** from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs` (`do not edit by hand` header). Edit only the two source configs, then regenerate:
- `infra/nginx/nginx.conf` (basis at 298-316): add `/braid/` alias + SPA fallback, `/braid/api/ -> http://braid-api:4020/`, `/braid/ws -> http://braid-api:4020/ws` with upgrade headers. Add `braid` to the static-asset regex at `nginx.conf:670`.
- `infra/nginx/nginx-with-site.conf` (basis at 396-414): the same three blocks. Add `braid` to the static-asset regex at `nginx-with-site.conf:748`.
- Then run `node scripts/gen-railway-configs.mjs`. Because `braid-api` is in `APP_SERVICES` (Section 9.6), the generator rewrites the upstream to `braid-api.railway.internal:8080`, synthesizes the `$rw_upstream_NN` index (via its `varSeq` counter) and the `rewrite ... break;` lines, and adds the static-asset entry. Do not reason about specific `$rw_upstream` indices or `:8080` by hand.

**Static-asset regex divergence:** the alternations already differ (`nginx.conf:670` includes `bill`; `nginx-with-site.conf:748` and the generated `railway:876` do not). Edit each source file in place to add `braid`; do not copy one alternation over another or you regress `bill`/`basis` caching.

**Ingress crash-safety:** add **`braid-api` (`condition: service_healthy`) to the `frontend` service `depends_on`** in `docker-compose.yml` (basis-api is already there). This compose edit, not the services.mjs metadata, is the real load-time guarantee.

### 9.5 Qdrant posture

Braid takes the soft path: `/readyz` checks only Postgres + Redis, and the `braid_profiles` Qdrant collection is created **lazily on first use** with retry + circuit-break, **never fatal at boot**. `QDRANT_URL` (+ optional `QDRANT_API_KEY`) is added to the `braid-api` catalog `optional` env, matching `brief-api` (`services.mjs:133`). Qdrant-down degrades blocking to key + trigram only.

### 9.6 Deploy catalog, Railway manifests, MCP wiring, Launchpad, CLAUDE.md

- `scripts/deploy/shared/services.mjs`: add a `braid-api` `APP_SERVICES` block (port `4020`, `public_paths: ['/braid/api/','/braid/ws']`, `required` env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`, `optional` incl. `DATABASE_READ_URL`/`QDRANT_URL`/`QDRANT_API_KEY`/`BOLT_API_INTERNAL_URL`/`CORS_ORIGIN`/`LOG_LEVEL`, mirroring `basis-api`). **Trim `braid-api.needs` to `['postgres','redis','api','bolt-api']`** (round-2 IN-r2-5); source reads are shared-DB, not service-to-service, and qdrant is soft. Add `/braid/` to the `frontend` entry's `public_paths` and `braid-api` to its `needs`. **Add `braid-api` to `mcp-server`'s `needs` metadata and set `BRAID_API_URL`, but do NOT add it to compose `depends_on`** (round-2 IN-r2-4); mcp-server reaches braid-api only at request time, matching bond-api/beacon-api. Add `BRAID_API_URL: http://braid-api:4020/v1` to `mcp-server` env in compose and catalog; register `braid-tools.ts` in the MCP bootstrap. Add `BBB_API_INTERNAL_URL` to the `worker` catalog `optional` (Section 9.2).
- **Run `node scripts/gen-railway-configs.mjs`**: it regenerates `nginx.railway.conf` and emits a new `railway/braid-api.json`. `railway/frontend.json` is not the artifact that changes; the regenerated `nginx.railway.conf` plus the new `railway/braid-api.json` are.
- **Launchpad catalog** in `apps/api/src/routes/system-settings.routes.ts`: add `'braid'` to `LAUNCHPAD_APP_IDS` (`:61`) and a `LAUNCHPAD_CATALOG` entry (`:97`): `{ id: 'braid', name: 'Braid', description: 'Customer Identity', icon_name: 'git-merge', color: '#4338ca', path: '/braid/' }`. **Do NOT add `braid` to `ROOT_REDIRECT_VALUES`** (round-2 IN-r2-6): the paired `REDIRECT_MAP` (`system-settings.routes.ts:117`) would need a matching key or typecheck fails, and the established pattern is that new apps (basis/bin/bay/blip/bureau) are absent from root redirect.
- **Launchpad icon:** `git-merge` is absent from the `ICONS` map in `packages/ui/launchpad.tsx` (it has `ruler` not `git-merge`); an unknown `icon_name` falls back to `Box` (`launchpad.tsx:224`). Two edits: `import { GitMerge } from 'lucide-react'` and add `'git-merge': GitMerge` to the `ICONS` table. No grid redesign; the grid already scrolls (`max-h-[65vh] overflow-y-auto`, `launchpad.tsx:222`).
- **CLAUDE.md (Phase 5 mandate):** append the `braid-api` (internal :4020, `/braid/api/`) and `braid` SPA (`/braid/`) inventory lines, add the `/braid/`, `/braid/api/`, `/braid/ws` route rows, and bump the MCP tool count: the new `braid-tools.ts` module adds 13 tools, taking the catalog to 51 modules (add a `+13 Braid` line and update the total wherever referenced in docs/marketing).
- **Runtime-dependency posture:** `/readyz` checks only Postgres + Redis. Source-app Postgres reads, Qdrant, and llm-provider embeddings use a bounded timeout + circuit breaker returning typed `UPSTREAM_UNAVAILABLE`; the ingest worker retries with backoff and DLQs on give-up (setting `needs_rescan`); the merge-rationale LLM call is best-effort.

---

## 10. MCP surface

New `apps/mcp-server/src/tools/braid-tools.ts` via `registerTool` (`apps/mcp-server/src/lib/register-tool.ts`), HTTP client shaped like `apps/mcp-server/src/tools/dedupe-tools.ts:38`. Env `BRAID_API_URL=http://braid-api:4020/v1`. Read tools that surface source records require an explicit `asker_user_id` (per `docs/reference/agent-conventions.md`), fail-closed via `can_access`; truth-flip tools use the Redis confirm-token store. Following the basis satellite pattern (round-3 BP3-1), `braid_*` tools are intentionally NOT added to `EXPLICIT_TOOL_OVERRIDES`; per-action resolver mapping is deferred and REST `requireCan` + the §15 kill-switch + the confirm-token are the enforcing layers.

| Tool | Backs | Permission | confirm_action |
| --- | --- | --- | --- |
| `braid_resolve` | POST `/v1/resolve` | `braid.profile.resolve` (non-admin-grantable) | no |
| `braid_get_profile` | GET `/v1/profiles/:id` | `braid.profile.read` | no |
| `braid_list_profiles` / `braid_search_profiles` | GET `/v1/profiles` | `braid.profile.read`, admin asker (S4) | no |
| `braid_profile_timeline` | GET `/v1/profiles/:id/timeline` | `braid.profile.read`, `asker_user_id`, fail-closed | no |
| `braid_list_candidates` | GET `/v1/candidates` | `braid.candidate.read` | no |
| `braid_propose_merge` | UPSERTS a canonical `braid_match_candidates` row (computed evidence, `bridge_identity_*`) then inserts an `agent_proposals` row (approver null, `expires_at`) and sets the candidate's `proposal_id` to it, so approval flows through the identical CAS-guarded `mergeCandidate` (round-3 D3-2) | `braid.candidate.read` + preflight both members, rate-limited (S7) | no (proposal is the HITL) |
| `braid_reject_candidate` | POST `/v1/candidates/:id/reject` | `braid.profile.merge` (confirm not enforced, BP-r2-5) | no |
| `braid_merge_profiles` | POST `/v1/profiles/merge` or `/candidates/:id/merge` | `braid.profile.merge` | **yes** (Redis token) |
| `braid_split_profile` | POST `/v1/profiles/:id/split` | `braid.profile.split` | **yes** (Redis token) |
| `braid_set_survivorship_rule` | PUT `/v1/survivorship-rules/:kind/:field` | `braid.rule.write` | no |
| `braid_list_survivorship_rules` | GET `/v1/survivorship-rules` | `braid.rule.read` | no |
| `braid_get_settings` | GET `/v1/settings` | `braid.settings.read` | no |

13 tools. `braid_get_profile` returns member identities and recent decisions embedded, so `/profiles/:id/identities` and `/profiles/:id/decisions` are annotated `resolver-done-internally` in the surface map. The embedded decisions are filtered through the same per-viewer `affected_identity_ids`/`absorbed_profile_id` machinery as the standalone `/decisions` route (round-3 S3-1). The genuine no-tool endpoints (round-2 BP-r2-2) are `PATCH /settings`, `POST /internal/events`, `/braid/ws`, `/health`, `/readyz` (plus the two resolver-done-internally sub-resource GETs). **`PUT /survivorship-rules` HAS a tool (`braid_set_survivorship_rule`) and is not a no-tool endpoint.** **agent_policies:** every `braid_*` service-account call fails closed until an operator allowlists `braid.*`.

**Surface-map update (BP2/BP6):** `docs/reference/mcp-endpoint-mapping.md` MUST be updated in the same change. Every REST row's MCP column is a backtick tool name or the sanctioned em-dash skip-cell form the other apps use (`docs/reference/mcp-endpoint-mapping.md:1920`); that table is the one place em dashes are correct (the CLAUDE.md self-check grep depends on it), so this spec keeps its own prose em-dash-free while the surface-map cells follow the existing convention. Keep the coverage counts and the zero-bare-dash grep green.

---

## 11. Reuse ledger

| Capability | Reuses (real file/package) | New in Braid |
| --- | --- | --- |
| App scaffolding (Fastify server, plugins, health plugin, RLS GUC plugin) | `apps/basis-api/src/server.ts` (`@bigbluebam/service-health:8`), `apps/basis-api/src/plugins/rls.ts`, `apps/bond-api/` layout | `braid-api` at port 4020 |
| Cross-app entity linking | `entity_links` (`0132_entity_links.sql`) | `braid.profile -> source` links |
| Per-pair dedupe memory / cooldown / never-resurface | `dedupe_decisions` (`0136_*`, incl. `resurface_after`), `dedupe-tools.ts:184` | identity-atom keyed suppression + no-op cooldown |
| Within-app duplicate signals (pg_trgm, exact email/phone) | `bond_find_duplicates` (`dedupe-tools.ts:72`) | cross-app blocking + weighted + bridged score |
| Embedding similarity | Qdrant (in-stack), platform llm-provider embeddings | lazy `braid_profiles` collection + identity embeddings |
| HITL approval inbox + fire-and-forget decided event | `agent_proposals` (`0128_*`), `proposals.routes.ts:275,328` | direct null-approver insert + kill-switch-safe subscription + reconcile sweep |
| Confirm-action gating on truth-flips | `apps/mcp-server/src/lib/confirm-token-store.ts` | merge/split tokens |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts:1359`, `can_access` | new `braid.*` + person-source branches, per-viewer re-assembly of all scalars |
| Bolt events (positional signature) | `publishBoltEvent` (`packages/shared/src/bolt-events.ts:35`), catalog + `check-bolt-catalog.mjs` | 4 `profile.*`/`candidate.*` definitions |
| Cross-app timeline data (fail-closed mapping) | `v_activity_unified` (`0129_*`), `bolt_recent_events` | union over a profile's members |
| Cross-app search | `apps/mcp-server/src/tools/search-tools.ts` | admin-asker Braid provider |
| Org scoping + RLS posture | `app.current_org_id` GUC (`0116_*`), `apps/api/src/boot/rls-boot.ts`, `apps/basis-api/src/plugins/rls.ts`, `BBB_RLS_ENFORCE` | Braid table policies + app-level org-scoping tests |
| Permissions (hand-authored, basis satellite pattern) | `generate-permission-manifest.mjs:757-776` (basis satellite deferral), `check-permission-catalog.mjs`, `build-permission-delta.mjs` | **9** `braid.*` rows, explicit `is_read` flags, no tool overrides (round-3 BP3-1) |
| MCP registration + policy gate | `register-tool.ts` (incl. the `/v1/agent-policies/:id/check` primitive at `:232`), `dedupe-tools.ts` client | 13 `braid_*` handlers |
| Worker fan-out + retry/backoff + DLQ + capture-the-version outbox | `banter-feed-fanin`, `basis-metric-snapshot.job.ts`, `bond-stale-deals.job.ts:23,127-138`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts` | ingest/rescan/reconcile/retention jobs + observed-`updated_at` outbox markers |
| Row-lock serialization precedent | `org.service.ts:429-489/:871-940` (`SELECT ... FOR UPDATE` row locks; no in-repo advisory precedent) | a single shared class/org-namespaced `pg_advisory_xact_lock` helper (round-3 ST3-2), shared by worker and resolve |
| Retention sweep pattern | `apps/worker/src/jobs/basis-retention-sweep.job.ts` | terminal-candidate purge |
| Org-settings table (nullable = unbounded) | `basis_org_settings` (`0226_*:73`) | thresholds + enabled sources + watermark |
| Launchpad + nginx (2 source configs, generated railway) + frontend Dockerfile + services.mjs | basis/bill wiring (cited above), `gen-railway-configs.mjs` | one new app id `braid`, `git-merge` icon |
| Suite-wide UI shell + Bureau widget + test stubs | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/db-stubs` | Braid SPA pages only |

---

## 12. Open questions & risks (human decision needed)

1. **`bolt-api` internal per-event dispatch (IN3).** The live match-on-ingest path assumes `bolt-api` can POST subscribed events to Braid's `/internal/events`. If that dispatch does not exist, it is a small `bolt-api` addition; the nightly source-diffing rescan (Section 4.6, ST-r2-3) makes it a soft dependency with a real next-day fallback. Owner: Bolt maintainers.
2. **Person-level visibility branches (D7/S5/S-r2-4).** `bill.client`, `helpdesk.user`, and `book.event_attendee` need real `visibility.service.ts` branches mirroring each app's authoritative read predicate, each with a passing unit test. `helpdesk.user` must reflect the requester-read rule, NOT the triage-permissive ticket carve-out (`:344`); if a faithful predicate cannot be written this cycle, drop that source from v1. Largest cross-team dependency; gates the wedge breadth.
3. **Helpdesk requester org column (D-r2-6).** The org derivation for `helpdesk.user` is unverified; confirm the requester table's org column (or its parent join) at implement time, mirroring the `book_events.organization_id` derivation.
4. **Source `updated_at` bump on in-place edits (round-3 ST3-3).** The changed-since rescan branch (`WHERE source.updated_at > braid_identities.source_synced_at`) only re-ingests an edit if the source's mutation path bumps `updated_at`. These columns are `defaultNow().notNull()` with **no `moddatetime` trigger** (`book-event-attendees.ts:25`, `bill-clients.ts:37`, `bond-contacts.ts:54`), a service-layer convention, not enforced. Each enabled source must be verified to bump `updated_at` on edit; where it cannot be guaranteed, that source's change-detection is driven off `bolt_recent_events` upsert events instead. The left-anti-join alone catches only NEW rows, not in-place edits.
5. **`v_activity_unified` is bam/bond/helpdesk only** (`0129_*`). Bill/Book timeline activity comes from `bolt_recent_events`, so completeness depends on those apps' typed-event coverage.
6. **Book attendee volume.** `book.event_attendee` is one row per booking, email-keyed; a frequent booker produces many identities that cluster into one profile. Consider a per-org toggle to treat Book attendees as evidence-only (strengthen an existing profile via exact email but never seed).
7. **Enforced-RLS role provisioning (IN-r2-1).** The role-bound cross-org RLS test only passes when braid-api connects as the non-superuser `bam_app` role under `BBB_RLS_ENFORCE=1`, a coordinated platform posture. Until then, application-level org-scoping is the enforcing layer and the test.
8. **Golden-record write-back / company hierarchy / threshold auto-tuning.** All deferred (read-only golden record; flat person-to-company link; operator-tuned bands).
9. **No human-provided secret required.** All dependencies are internal and already in the stack.

---

## Changelog - Round 1

Dispositions for every finding (accept / adapt / reject) with the section changed. No findings were rejected.

**Design**
- [design] D1 ACCEPT: re-derived v1 sources from real schema; Blast reduced to an email-suppression overlay. Sections 1, 2.5, 3, 4, 6.
- [design] D2 ACCEPT: `braid_resolve` lazily creates a singleton seed and follows the `merged_into_id` chain; unmerge reactivates the original absorbed profile id. Sections 4.5, 5.1.
- [design] D3 ACCEPT: single `mergeCandidate` executor reached by REST + `proposal.decided`, CAS-guarded. Sections 2.2, 5.4.
- [design] D4 ACCEPT: reject/split suppression keyed on immutable `braid_identities.id` atoms. Sections 2.3, 4.2, 4.5.
- [design] D5 ACCEPT: `link_confidence` + `link_evidence` on `braid_identities`; `confidence` is `min()` over member links. Sections 3.1, 4.4.
- [design] D6 ACCEPT: N-way bridging generates profile-pair merge candidates. Section 4.4.
- [design] D7 ACCEPT: real visibility branches per person-source; a source is not enabled until verified. Sections 2.5, 5.5, 12.
- [design] D8 ACCEPT: `company_profile_id` survivorship rule; `superseded` transition; table-name normalized; `org_id` vs `organization_id` note. Sections 3, 4.4.

**Security**
- [security] S1 ACCEPT (both options): admin-tier read default AND per-viewer attribute re-assembly. Section 2.5.
- [security] S2 ACCEPT: `braid_resolve` takes `asker_user_id`, preflights the input, suppresses `identity_count`. Sections 2.5, 5.1.
- [security] S3 ACCEPT: non-admin `/identities` drops denied rows entirely, recomputes count. Section 2.5.
- [security] S4 ACCEPT: search restricted to admin askers with per-viewer post-filter. Sections 2.5, 7.3, 10.
- [security] S5 ACCEPT: visibility branches gated with a unit test per branch. Sections 2.5, 5.5, 8.
- [security] S6 ACCEPT (adapted): events refs-only; `profile.merged` carries survivor + affected identities only. Sections 2.5, 7.1.
- [security] S7 ACCEPT: `braid_propose_merge` preflights both members, rate-limited. Sections 2.4, 10.
- [security] S8 ACCEPT (superseded by round-2 IN-r2-1 reframing): RLS posture. Sections 2.5, 3, 8, 9.1.

**Stability**
- [stability] ST1 ACCEPT (superseded by round-2 ST-r2-1 all-keys fix): advisory-lock serialization. Section 4.2.
- [stability] ST2 ACCEPT: merge in one Drizzle transaction; side effects post-commit. Section 4.4.
- [stability] ST3 ACCEPT: candidate-status CAS inside the merge txn. Sections 2.2, 4.4.
- [stability] ST4 ACCEPT: split writes identity-level suppression, human-separated. Section 4.5.
- [stability] ST5 ACCEPT: `profile.*` events carry affected source identities; `braid_resolve` follows the survivor chain. Sections 4.5, 5.2, 7.1.
- [stability] ST6 ACCEPT (extended by round-2 ST-r2-3): watermarked rescan. Sections 3.1, 4.6.
- [stability] ST7 ACCEPT: BullMQ attempts + backoff + DLQ; bounded `AbortController`. Section 4.6.
- [stability] ST8 ACCEPT: full weight set snapshotted; prospective thresholds; retention sweep. Sections 3.1, 3.3, 4.6.

**Best-practices**
- [best-practices] BP1 ACCEPT: hand-authored `braid.*` rows then regenerate + verify + delta. Section 3.4.
- [best-practices] BP2 ACCEPT: added reject + two read tools; resolver-done-internally annotations. Section 10.
- [best-practices] BP3 ACCEPT: CLAUDE.md inventory + route + MCP count. Section 9.6.
- [best-practices] BP4 ACCEPT: Section 8 Testing.
- [best-practices] BP5 ACCEPT: health plugin from `@bigbluebam/service-health`. Sections 5.1, 9.1.
- [best-practices] BP6 ACCEPT: surface-map em-dash skip cells; prose stays em-dash-free. Section 10.
- [best-practices] BP7 ACCEPT: delta migration depends on the generator update. Section 3.4.

**Infrastructure**
- [infrastructure] IN1 ACCEPT: railway auto-generation; edit sources then regenerate. Sections 9.4, 9.6.
- [infrastructure] IN2 ACCEPT (extended by round-2 IN-r2-2/3): worker env wiring. Sections 6, 9.2.
- [infrastructure] IN3 ACCEPT: named the ingest transport + rescan fallback. Sections 5.1, 6, 12.
- [infrastructure] IN4 ACCEPT: four Dockerfile edit sites. Section 9.3.
- [infrastructure] IN5 ACCEPT: lazy Qdrant collection. Section 9.5.
- [infrastructure] IN6 ACCEPT: static-asset alternation in two sources, bill divergence noted. Section 9.4.
- [infrastructure] IN7 ACCEPT: GitMerge import + ICONS edit. Section 9.6.
- [infrastructure] IN8 ACCEPT: compose `frontend.depends_on` as the crash-safety guarantee. Section 9.4.

---

## Changelog - Round 2

Final hardening round. Every finding accepted or accepted-with-adaptation; none rejected. Goal: zero remaining blocker/major coherence gap.

**Theme 1 - the `resolve` permission tier (design D-r2-7, security S-r2-2, best-practices BP-r2-1)**
- [design] Theme 1 ACCEPT: made `braid.profile.resolve` a distinct 9th, non-admin-grantable permission (input preflight + count suppression + rate limit keep it safe); only the full profile READ stays admin-tier. Updated every "8 rows" to 9 (Sections 2.5, 3.4, 5.3, 10, 11) and gated `POST /v1/resolve` + `braid_resolve` on it (Sections 5.1, 10). Deleted the implication that resolve is admin-only. (from review round 2)

**Theme 2 - the `proposal.decided` bridge (security S-r2-1 BLOCKER, design D-r2-1/D-r2-2, stability ST-r2-5)**
- [security] S-r2-1 ACCEPT (BLOCKER): the `proposal.decided` subscription now re-checks the `braid.*` kill-switch/allowlist and asserts the decider holds `braid.profile.merge` before executing; kill-switch-engaged decisions no-op and leave the candidate pending, closing the fail-open. Sections 2.2, 5.4, 2.6. (from review round 2)
- [design] D-r2-1 ACCEPT: review-band proposals are inserted directly into `agent_proposals` with `approver_id=NULL` (admin queue), not through the mandatory-approver public route. Section 2.2. (from review round 2)
- [design] D-r2-2 ACCEPT: proposal subject modeled as the candidate (`subject_type='braid.candidate'`); the subscription reverse-looks-up via `braid_match_candidates.proposal_id` since `proposal.decided` carries no subject. Sections 2.2, 3.1, 5.4. (from review round 2)
- [stability] ST-r2-5 ACCEPT: added the `braid-proposal-reconcile` sweep driving approved-but-pending proposals through the CAS-idempotent `mergeCandidate` (at-least-once). Section 4.6. (from review round 2)

**Theme 3 - lazy-resolve minting under the lock (design D-r2-3, stability ST-r2-2)**
- [stability] Theme 3 ACCEPT: `resolve` now takes the same all-keys advisory lock, is identity-first (`INSERT braid_identities ... ON CONFLICT DO NOTHING RETURNING profile_id`, mint only when genuinely new), mints a bare singleton and defers clustering to the worker, and is rate-limited per asker (it writes). Section 5.1. (from review round 2)

**Theme 4 - advisory-lock scope (stability ST-r2-1 BLOCKER)**
- [stability] ST-r2-1 ACCEPT (BLOCKER): the create-or-attach lock now covers EVERY present blocking key (`email_norm` AND `phone_norm`), sorted ascending to avoid deadlock (stackable), so two records sharing only phone attach to one profile; bridge-merge runs in the same locked txn or re-checks under `FOR UPDATE`; added a regression test. Sections 4.2, 8. (from review round 2)

**N-way bridging scoring (design D-r2-4)**
- [design] D-r2-4 ACCEPT: a bridged candidate's score/`strong_signal` derive from the bridging identity's two strong links (evidence `shape:"bridged"`), not a direct A-vs-B comparison; recorded the bridged evidence shape. Sections 3.3, 4.4, 8. (from review round 2)

**Security read-plane residue**
- [security] S-r2-3 ACCEPT: `email_suppressed` (admin-only) and `confidence` (recomputed over `can_access`-passing members) routed through the per-viewer machinery and listed in the internal-cache set. Sections 2.1, 3.1. (from review round 2)
- [security] S-r2-4 ACCEPT: `helpdesk.user` branch must mirror the real requester-read predicate, not the triage-permissive ticket carve-out (`:344`); drop from v1 if not faithful. Sections 2.5, 8, 12. (from review round 2)
- [security] S-r2-6 ACCEPT: per-viewer assembly batches preflight (one query per `source_type`), caps members with cursor pagination, caches the per-`(viewer,profile)` verdict for a short TTL. Sections 2.1, 5.1. (from review round 2)
- [security] S-r2-7 ACCEPT: timeline uses fail-closed mapping (a row is included only if tied to a `can_access`-passing member; unmapped Bolt events are dropped). Sections 5.1, 7.3. (from review round 2)

**Stability reconciliation markers**
- [stability] ST-r2-3 ACCEPT: rescan source-diffs each enabled source table (changed-since-ingest via source `updated_at` + left-anti-join for un-ingested rows + `needs_rescan`), making the next-day fallback real. Sections 4.6, 6. (from review round 2)
- [stability] ST-r2-4 ACCEPT: added `qdrant_synced_at` + `last_event_published_at` transactional-outbox markers stamped post-commit; rescan reconciles by them. Sections 3.1, 4.4, 4.6. (from review round 2)
- [stability] ST-r2-6 ACCEPT: split suppression is bounded/batched (separation-set marker, not full NxM synchronous); softened the claim to "cannot re-merge on the same evidence." Section 4.5. (from review round 2)
- [stability] ST-r2-7 ACCEPT: `last_rescan_at` advances only after a fully successful tick (per-identity high-water resumable); added an explicit `needs_rescan` column for the DLQ give-up. Sections 3.1, 4.6. (from review round 2)
- [stability] ST-r2-8 ACCEPT: restated 5.4 exactly-once precisely (candidate CAS for candidate-backed, `FOR UPDATE` + `merged_away` re-check for direct) and documented the intentional no-op echo. Section 5.4. (from review round 2)

**Infrastructure**
- [infrastructure] IN-r2-1 ACCEPT: dropped the "braid unilaterally requires enforce" framing; RLS-enforce is a platform-global posture (`rls-boot.ts`), braid inherits the basis-style `plugins/rls.ts` GUC hook, and the S8 test is reframed as an application-level org-scoping test (role-bound RLS test optional, needs the non-superuser role). Sections 2.5, 3, 8, 9.1, 12. (from review round 2)
- [infrastructure] IN-r2-2 ACCEPT: Section 6 corrected to say `BBB_API_INTERNAL_URL` must be ADDED to the worker compose env (not already-present). Sections 6, 9.2. (from review round 2)
- [infrastructure] IN-r2-3 ACCEPT: scoped the catalog edit to adding only `BBB_API_INTERNAL_URL` to `worker.optional` (QDRANT_URL already there, `:503`); compose gains both. Section 9.2. (from review round 2)
- [infrastructure] IN-r2-4 ACCEPT: `braid-api` added to `mcp-server` needs + `BRAID_API_URL` only, NOT compose `depends_on`. Section 9.6. (from review round 2)
- [infrastructure] IN-r2-5 ACCEPT: trimmed `braid-api.needs` to `['postgres','redis','api','bolt-api']`; source reads are shared-DB. Section 9.6. (from review round 2)
- [infrastructure] IN-r2-6 ACCEPT: dropped the `ROOT_REDIRECT_VALUES` addition (matches basis/blip precedent; avoids the `REDIRECT_MAP` typecheck break at `:117`). Section 9.6. (from review round 2)

**Best-practices**
- [best-practices] BP-r2-2 ACCEPT: removed `PUT /survivorship-rules` from the no-tool list (it is backed by `braid_set_survivorship_rule`); corrected the genuine no-tool set. Section 10. (from review round 2)
- [best-practices] BP-r2-3 ACCEPT: set `app:'braid'` on each hand-authored row and added a `braid.`-prefix provenance branch at `generate-permission-manifest.mjs:800`. Section 3.4. (from review round 2)
- [best-practices] BP-r2-4 ACCEPT: added `EXPLICIT_TOOL_OVERRIDES` entries for all 13 `braid_*` tools (blip block model) so `TOOL_TO_PERMISSION` is populated and the Wave D resolver enforces per-action. Sections 2.6, 3.4, 10. (from review round 2)
- [best-practices] BP-r2-5 ACCEPT (explicit-note route): `braid_reject_candidate` reuses `braid.profile.merge` and the confirm token is intentionally not enforced on the reject route (the HITL boundary is the merge, not the suppression); kept 9 rows. Sections 2.4, 5.1, 10. (from review round 2)

**Design minors/nits**
- [design] D-r2-5 ACCEPT: no-op band writes `needs_review` with a `resurface_after` cooldown and blocking honors it, so no-op pairs are not rescored every tick. Sections 2.2, 4.2, 3.2. (from review round 2)
- [design] D-r2-6 ACCEPT: added the org-derivation line to 4.1 (`book_events.organization_id`; helpdesk requester org flagged unverified). Sections 4.1, 12. (from review round 2)
- [design] D-r2-8 ACCEPT: added the sentence to 2.3 noting reject suppresses the bridge atoms, so new member-level evidence can legitimately re-open the pair. Section 2.3. (from review round 2)

---

## Changelog - Round 3

Final cap round. Zero blockers found; 8 majors plus minors/nits, all narrow refinements to existing machinery. Every finding accepted or accepted-with-adaptation; none rejected. After this fold the spec is FINAL and hands off to the build.

**Design - the proposal-inbox contract (D3-1/2/3 majors + D3-4/5 minors + D3-6 nit)**
- [design] D3-1 ACCEPT: the `proposal.decided` subscription branches on `decision` (approve->mergeCandidate, reject->rejectCandidate writing bridge-atom suppression, request_revision->leave pending); the reconcile sweep also drives `status='rejected'` proposals into `rejectCandidate`. Sections 2.2, 4.6. (from review round 3)
- [design] D3-2 ACCEPT: `braid_propose_merge` upserts a canonical `braid_match_candidates` row (computed evidence, `bridge_identity_*`) and back-links its `proposal_id`, so an agent-proposed merge flows through the identical CAS-guarded `mergeCandidate` and a human approval is never a silent no-op. Sections 2.4, 10. (from review round 3)
- [design] D3-3 ACCEPT: the direct `agent_proposals` insert supplies an explicit `expires_at = now()+7d`; the reconcile sweep detects `status='expired'` candidates-still-pending and re-registers or surfaces "decide in the Braid queue," clearing the stale `proposal_id`. Sections 2.2, 4.6. (from review round 3)
- [design] D3-4 ACCEPT: documented `braid.candidate` as intentionally NOT `can_access`-resolvable; the inbox renders it via the `braid.candidate.read`-gated candidate route, and a preflight returns `unsupported_entity_type` with a documented fallback. Sections 2.2, 2.5. (from review round 3)
- [design] D3-5 ACCEPT: after the direct insert Braid emits `proposal.created` on `platform` mirroring the route, so approval-notification fan-out fires. Section 2.2. (from review round 3)
- [design] D3-6 ACCEPT: added a `platform_user` strong-signal feature (weight 0.45) keyed on the real `book_event_attendees.user_id` FK, threaded into the score, `strong_signal`, and both `evidence.weights` blocks. Sections 3.3, 4.3. (from review round 3)

**Security (S3-1 major + S3-2/3/4 minors)**
- [security] S3-1 ACCEPT: `GET /v1/profiles/:id/decisions` (and the `braid_get_profile` embed) gated on admin-tier `braid.profile.read` and filtered through the same batched `preflightAccess` as the member list (drop unmappable `affected_identity_ids`/`absorbed_profile_id` fail-closed), so array length cannot defeat `identity_count` suppression; named the permission in the 5.1 auth cell. Sections 5.1, 10. (from review round 3)
- [security] S3-2 ACCEPT: the subscription re-SELECTs `agent_proposals.status` and requires it to match the branch before acting, rather than trusting the fire-and-forget frame. Section 2.2. (from review round 3)
- [security] S3-3 ACCEPT: stated plainly that the kill-switch freezes only agent/service deciders (`register-tool.ts:205` bypasses humans); the human freeze control is revoking `braid.profile.merge`; noted approved-but-frozen proposals auto-execute via the reconcile sweep once the freeze lifts unless the candidate is also rejected. Section 2.2. (from review round 3)
- [security] S3-4 ACCEPT: replaced the "reuse createPolicyGate" framing with the reusable primitive `POST /v1/agent-policies/:id/check?tool=` (`register-tool.ts:232`) called directly with the event's decider actor_id (fail-closes on non-2xx). Sections 2.2, 4.6. (from review round 3)

**Stability (ST3-1/2/3 majors + ST3-4/5 minors + ST3-6 nit)**
- [stability] ST3-1 ACCEPT: outbox markers stamp the OBSERVED `updated_at`, not `now()`, on both markers in the merge post-commit and the rescan reconcile, so a concurrent bump leaves `marker < new updated_at` and is reprocessed (capture-the-version discipline, `bond-stale-deals.job.ts:127-138`). Sections 4.4, 4.6. (from review round 3)
- [stability] ST3-2 ACCEPT: specified a single shared advisory-lock helper with class+org-namespaced two-int tokens, sorted by the FINAL numeric token identically in worker and resolve, and one global class order (all advisory keys, then `FOR UPDATE` by id) on every path; dropped the false advisory-lock citation of `org.service.ts` (kept it as the `FOR UPDATE` row-lock reference). Sections 4.2, 11. (from review round 3)
- [stability] ST3-3 ACCEPT: added a Section 12 precondition that each enabled source's mutation path is verified to bump `updated_at` (columns have no `moddatetime` trigger); where not guaranteed, change-detection is driven off `bolt_recent_events`; noted the anti-join alone does not cover in-place edits. Sections 4.6, 12. (from review round 3)
- [stability] ST3-4 ACCEPT: sharpened the split anti-flap invariant - every STRONG-signal pair (email/phone/platform_user) is written synchronously in the HITL path; the async cap covers only weak (review-band) pairs that cannot auto-remerge. Section 4.5. (from review round 3)
- [stability] ST3-5 ACCEPT: the reconcile sweep re-derives the ORIGINAL decider from the proposal row and re-checks THAT actor via the check endpoint (not the worker service context); preferred a dedicated 10-minute sweep over the daily fold. Sections 2.2, 4.6. (from review round 3)
- [stability] ST3-6 ACCEPT: extended the "bump `updated_at`, defer marker" invariant to attach/seed and the resolve lazy-mint, and pinned that `braid_profiles` carries no `updated_at` auto-update trigger so the marker stamp does not perpetually re-embed. Sections 3.1, 4.4, 5.1. (from review round 3)

**Best-practices (BP3-1 major + BP3-2 minor)**
- [best-practices] BP3-1 ACCEPT (Option 1, basis deferral): removed the round-2 `EXPLICIT_TOOL_OVERRIDES` instruction; `braid_*` is intentionally unmapped in `TOOL_TO_PERMISSION` (Wave D deferred exactly as basis), so the `HAND_AUTHORED` loop is the sole creator of all 9 rows and its flags land; updated 2.6, 3.4, 8, 10, 11. (from review round 3)
- [best-practices] BP3-2 ACCEPT: every hand-authored row now carries an explicit `is_read` value; `braid.profile.resolve` is `is_read:false` (it can lazily mint, so a read-only key must not reach it; a resolve caller needs `read_write` scope). Section 3.4. (from review round 3)

**Infrastructure (all clean; IN3-1 minor + IN3-2/3 nits)**
- [infrastructure] IN3-1 ACCEPT: added `DATABASE_READ_URL=${DATABASE_READ_URL:-}` to the braid-api compose env and `braid-api.optional`, mirroring basis-api (`docker-compose.yml:805`) for the read-heavy workload. Sections 9.1, 9.6. (from review round 3)
- [infrastructure] IN3-2 ACCEPT: gave the worker env values (`QDRANT_URL: http://qdrant:6333`, `BBB_API_INTERNAL_URL: http://api:4000`). Section 9.2. (from review round 3)
- [infrastructure] IN3-3 ACCEPT: noted `worker.needs` is intentionally unchanged because every new braid worker upstream is a degradable, retried, DLQ'd request-time dependency. Section 9.2. (from review round 3)
