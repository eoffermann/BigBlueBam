# Bulwark - App Design Specification

> An agent that reads the agreements an organization has signed and then spends the whole engagement making sure it does not breach them.
>
> Status: design draft (round 0), authored against the real monorepo at branch `suite-brainstorm`. New app. Winner of the 2026-07-19 03:00 suite-brainstorm session.
> Chosen internal port: **4021** (next free port after Braid's 4020; 4019 is basis, 4020 is braid).
> Routes: SPA at `/bulwark/`, REST at `/bulwark/api/`, realtime at `/bulwark/ws`.
> Chosen final name: **Bulwark** (single word). App id `bulwark`.

Freshest build precedent cited throughout: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (the Braid spec, hardened through three review rounds and now partly built on this branch). Bulwark reuses Braid's HITL-via-`agent_proposals`, Bolt-dispatch-transport, hand-authored-permissions, and built-in-group-defaults patterns verbatim where they apply.

House style: no em dashes in this document; no Co-Authored-By footer.

---

## 1. Overview & positioning

**One-liner.** Bulwark extracts a typed, clause-cited **obligation ledger** from an organization's executed contracts, **binds each obligation to a Bolt event pattern**, and then fires against live reality instead of against a calendar. A delay event logged on Tuesday starts the five-day notice clock that the subcontract actually requires, Bulwark drafts the notice that discharges it, and every outbound act lands in the existing `agent_proposals` queue for a human to approve. Nothing is ever sent unattended.

**The wedge (why it won).** Small contractors waive real claims constantly by missing a 5-day notice clause nobody re-reads after signing. Contract review today is a lawyer at $400/hr, once, at signing, and then never again. Bulwark moves the axis from "one-time review" to **continuous obligation monitoring tied to real-time job events**, which no static document repository can do. The suite already holds every input Bulwark needs: the executed document is a **Bin** asset, the counterparty is in **Bond**, the money terms live in **Bill**, the deadlines surface in **Book**, and reality streams through **Bolt**. Bulwark is the layer that turns the signed PDF into a live, event-bound ledger and acts to keep you compliant.

**Who it is for.** The owner/PM/contract-admin persona at a 2-50 seat contractor, and structurally identical buyers in any obligation-bearing engagement (SOWs, MSAs, grant awards, commercial leases). Construction is the beachhead because its obligations are the most punishing and the most standardized (notice windows, lien/bond deadlines, COI/W-9/lien-waiver/certified-payroll flow-down), but the object model is horizontal.

**How it differs from the three apps it is most often confused with:**
- **Bin** (`apps/bin-api/`, `@bigbluebam/storage`) *stores the document bytes*. Bulwark does not store files; it references a `bin.asset` (Section 3.1), reads its bytes once for extraction, and never becomes a second DAM. A Bin folder full of executed contracts is inert until Bulwark reads it.
- **Bolt** (`apps/bolt-api/`) *routes events and runs rule automations*. Bulwark does not replace Bolt's rule engine; it is a *consumer* of the Bolt stream whose bindings are data (`bulwark_obligations.event_binding`, per contract) rather than hand-built Bolt rules, and whose reactions are legally-typed (notice clocks, waiver risk, compliance chase) rather than generic actions. A Bolt rule fires an action; a Bulwark obligation discharges a legal duty.
- **Bill** (`apps/bill-api/`) *invoices and tracks money*. Bulwark reads payment/retention terms as obligations and can watch Bill events (a pay-app submitted, retention released), but it never issues an invoice. It watches whether the money terms the contract imposes are being honored.

**v1 scope.** Objects: `contract`, `obligation`, `notice_deadline`, `waiver_risk`, `compliance_doc` (COI / W-9 / lien waiver / certified payroll), `vendor_tier`, plus `bulwark_org_settings` and an `bulwark_extraction_runs` audit table. Surfaces: the obligation ledger per job/engagement, the deadline radar, the drafted-notice review queue, and the vendor compliance matrix. Flagship MCP tools: `bulwark_extract_obligations(contract_asset_id)` and `bulwark_check_notice_risk(job_id)`.

**Out of v1 scope:** authoring new contracts, e-signature, redline/negotiation, and any autonomous send (every send is proposal-gated). Legal advice is explicitly disclaimed: obligation extraction is best-effort and always human-reviewable (Section 3). These are Open Questions (Section 12).

---

## 2. AI-native design

Bulwark's AI core is **best-effort clause extraction plus deterministic event-bound firing, with human-in-the-loop review at two boundaries**: (a) every extracted obligation is reviewable before it can arm a clock, and (b) every outbound act (a drafted notice, a compliance-chase email) is an `agent_proposals` row that a human approves. The LLM understands contract language; it never sends anything and never computes a due date. Due dates are deterministic arithmetic over a typed `deadline_rule` and a real triggering event.

### 2.1 The two-plane split (borrowed from the Basis / Braid pattern)

As Basis separates certified drivers from per-viewer correlation (`docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md` Section 2.1) and Braid separates the deterministic score from per-viewer PII rendering (Braid Section 2.1), Bulwark keeps two computations in different trust planes:

1. **LLM extraction (best-effort, always reviewable).** The internal llm-provider reads chunked contract text and proposes typed obligations with a cited span and a confidence. This output is never live truth: it lands as `bulwark_obligations` rows with `review_status='pending_review'` (or `'auto_confirmed'` only above a high per-org confidence floor, still reversible). It cannot arm a clock until it is `confirmed`.
2. **Deterministic firing (reproducible, auditable).** Once an obligation is `confirmed` and bound to a `(source, event_type)` Bolt pattern, the firing engine is pure arithmetic: `due_at = trigger_event_time + deadline_rule.offset`, recomputed identically every time from the stored rule and the captured event. Two operators looking at the same fired deadline see the same due date and the same clause citation.

**Invariant (record and rely on).** A `bulwark_notice_deadline` is a pure function of `(obligation.deadline_rule, triggering_event)`. It is created at-most-once per `(obligation_id, triggering_event_id)` (unique constraint, Section 3.1) so a redelivered Bolt event or a retried worker never double-arms a clock. The `waiver_risk` and the drafted-notice proposal derive deterministically from the deadline plus the per-org lead-time thresholds.

### 2.2 Autonomy bands (what the agent does alone vs. with a human)

| Action | Autonomy | Mechanism / gate |
| --- | --- | --- |
| Extract obligations from a contract asset | Autonomous (worker), best-effort | `bulwark-extract-obligations` job; low-confidence rows land in the review queue |
| Confirm / edit / reject an extracted obligation | HITL, permission-gated | `bulwark.obligation.write`; reject is destructive (confirm token) |
| Bind an obligation to a `(source, event_type)` pattern | Autonomous suggestion, human-confirmable | proposed by extraction, editable via `bulwark.obligation.write` |
| Arm a notice clock when a bound event fires | Autonomous (deterministic) | firing engine creates a `notice_deadline`; no human needed to start a clock |
| Flag a waiver risk as a clock runs down | Autonomous | deadline-radar sweep; emits `waiver.risk_detected` |
| **Draft a notice** that discharges an obligation | Autonomous draft, **HITL to send** | inserted into `agent_proposals` (`proposed_action='bulwark.send_notice'`); nothing sends until approved |
| **Chase** an expiring COI / W-9 / lien waiver / certified payroll | Autonomous draft, **HITL to send** | inserted into `agent_proposals` (`proposed_action='bulwark.chase_compliance_doc'`); the send is a Blast/Blank action executed only on approve |
| Mark a deadline discharged / waived | HITL, permission-gated | `bulwark.deadline.*` write; waive is destructive (confirm token) |
| Delete a tracked contract | HITL, destructive | `bulwark.contract.delete` (Redis confirm token) |
| Edit org settings / thresholds | Permission-gated | `bulwark.settings.write` |

**The HITL boundary is the `agent_proposals` queue, exactly as Braid used it (Braid Section 2.2).** Bulwark never calls Blast or Blank to send anything directly from the drafting path. It **inserts an `agent_proposals` row** describing the send, and a `proposal.decided` subscription (Section 2.4) executes the send only on `approve`. This is the single choke point that satisfies the winning brief's "nothing is ever sent unattended."

**Proposal registration (mirrors Braid Section 2.2, D-r2-1/D-r2-2).** Bulwark inserts directly into `agent_proposals` rather than through the public `POST /v1/proposals` route, because that route makes `approver_id` mandatory (`apps/api/src/routes/proposals.routes.ts:40`) and a drafted notice belongs in the **org contract-admin queue** (admins see the whole org queue, `proposals.routes.ts:25` default-scope note). The direct insert uses `approver_id=NULL` (the column is nullable, `0128_agent_proposals.sql:37`), an explicit `expires_at = now() + 7 days` (the column is `NOT NULL`, `:41`, and the platform sweep flips `pending -> expired`), `proposer_kind` = the Bulwark service account's `actor_type`, and the subject modeled as the **draft**: `subject_type='bulwark.notice_draft'` (or `'bulwark.compliance_chase'`), `subject_id=<the bulwark row id>`. After the insert Bulwark emits `publishBoltEvent('proposal.created', 'platform', ...)` mirroring the route (`proposals.routes.ts:114-134`) so platform approval-notification fan-out still fires for items that bypassed the route (Braid round-3 D3-5). `bulwark.notice_draft` and `bulwark.compliance_chase` are intentionally NOT registered as `can_access`-resolvable entity types (Braid round-3 D3-4 precedent); the inbox renders them by fetching through the permission-gated Bulwark read routes, and a preflight of those types returns `unsupported_entity_type` with a documented fallback.

### 2.3 What it retrieves / reasons over

- **For extraction:** the contract document text (from the Bin asset bytes, Section 3.5), chunked, plus the org's obligation taxonomy. It never sees another org's data (org-scoped worker context, Section 4).
- **For firing:** the confirmed obligations for a job and the live Bolt event that arrived, matched by `(source, event_type)` and (optionally) by an entity filter in the binding (e.g. only events whose `payload.project_id` equals the contract's job).
- **For compliance:** the vendor tier's required doc types, the collected `compliance_doc` rows and their `expires_at`, and the chase cadence in settings.

### 2.4 The single canonical send path, kill-switch-safe

Bulwark has exactly one send executor per outbound type, reached two ways, identical to Braid's single-`mergeCandidate` discipline (Braid Section 5.4):
- The **REST** endpoints (the UI "approve and send" surface) call the executor directly, gated by `bulwark.notice.draft` / `bulwark.compliance.chase` plus the register-tool policy layer.
- A **Bolt subscription on `proposal.decided`** (fired by `proposal_decide`, `proposals.routes.ts:275/328`, on the `platform` source) branches on `decision` (the platform contract is `approve|reject|request_revision`, `:52-63`). For `approve` it reverse-looks-up the Bulwark draft via `proposed_payload.bulwark_draft_id` (the `proposal.decided` payload carries no subject), **re-SELECTs `agent_proposals.status` to confirm `approved`** rather than trusting the fire-and-forget frame, resolves the **decider** actor from the proposal row, and before sending fail-closes that actor through the reusable primitive `POST /v1/agent-policies/<decider_id>/check?tool=<send_tool>` (`apps/mcp-server/src/lib/register-tool.ts`, which fail-closes on non-2xx) AND asserts the decider holds the send permission. Only then does it execute the Blast send or the Blank form dispatch. `reject` marks the draft discarded; `request_revision` leaves it pending.

Exactly-once on the send is guaranteed by a **compare-and-swap** on the draft row: `UPDATE bulwark_notice_deadlines SET notice_status='sent' WHERE id=$1 AND notice_status='approved' RETURNING id` (and the analogous CAS on `compliance_doc.chase_status`); only the row that flips proceeds, so a REST approve racing the subscription echo no-ops harmlessly. This is the Braid ST-r2-8 "intentional decided echo" pattern.

### 2.5 Security model

A contract obligation ledger is sensitive: it encodes what an org has promised, to whom, and where it is exposed. Bulwark must not become a channel that downgrades any source app's access rules.

1. **Reads are permission-gated and `can_access`-preflighted.** Every read tool that surfaces a source record (the linked Bond counterparty, the Bin asset, the Bill term) takes an explicit `asker_user_id` and drops anything the asker cannot see, via `preflightAccess` (`apps/api/src/services/visibility.service.ts`). The obligation ledger itself is gated by `bulwark.obligation.read` / `bulwark.contract.read`, defaulting to the org contract-admin tier because it is consolidated commitment data.
2. **Extraction input isolation.** The extraction LLM call uses ONLY the internal platform llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint. The document text is sent as-is (it is first-party contract text the org owns), but the call is server-to-server inside the stack and the response is treated as untrusted proposed data (validated against the Zod obligation schema; anything that fails validation is dropped, not stored).
3. **No autonomous send.** The `agent_proposals` choke point (Section 2.2/2.4) means a compromised or hallucinating agent can at worst fill the approval inbox; it cannot email a counterparty or a sub without a human approve, and the approve re-checks the `agent_policies` kill switch for agent/service deciders.
4. **Events are org-level refs only.** Bulwark's Bolt events (Section 7) carry ids and magnitudes, never clause text or counterparty PII. `bulwark.*` outbound-webhook subscriptions require org-admin authorship.
5. **Org scoping (RLS posture, Braid IN-r2-1 framing).** RLS enforcement is a platform-global posture: `ALTER ROLE ... NOBYPASSRLS` is run only by `apps/api/src/boot/rls-boot.ts` gated by `BBB_RLS_ENFORCE`; satellite services get only the per-request GUC hook that sets `app.current_org_id` (`apps/basis-api/src/plugins/rls.ts`, which `bulwark-api` inherits by modeling on basis-api) and never flip the role. So Bulwark's headline org-isolation guarantee is enforced by **application-level org-scoping** (every query carries `organization_id`, and the pipeline sets the `app.current_org_id` GUC). RLS policies are authored on every `bulwark_*` table as defense in depth that binds when the platform flips `BBB_RLS_ENFORCE=1`. The Section 8 test is an application-level org-scoping test, plus an optional RLS-binding test that runs only when the enforced non-superuser role is provisioned.

### 2.6 Guardrails summary

- **agent_policies** (`0139_agent_policies.sql`, `register-tool.ts`): every `bulwark.*` service-account call passes the kill-switch + glob allowlist (`matchesAllowlist('bulwark.*')`). `bulwark.*` is NOT in the always-permitted core, so tools fail closed until an operator allowlists `bulwark.*`. Covered by a `register-tool` policy test. The same check is re-run by the `proposal.decided` send subscription (Section 2.4).
- **Per-action MCP resolver (basis/braid satellite deferral):** Bulwark does NOT add `bulwark_*` to `EXPLICIT_TOOL_OVERRIDES`; the Wave D per-action resolver is deferred exactly as for basis and braid (`scripts/generate-permission-manifest.mjs` basis branch), so the hand-authored `HAND_AUTHORED` loop is the sole creator of all `bulwark.*` rows and its explicit flags land. Enforcing layers are REST `requireCan`, the kill-switch/allowlist, and the confirm token on destructive tools.
- **confirm_action** (Redis-backed dynamic-TTL store, `apps/mcp-server/src/lib/confirm-token-store.ts`, 60s agent / 5min human): the destructive tools `bulwark_delete_contract`, `bulwark_reject_obligation`, and `bulwark_waive_deadline` require a confirm token, the pattern `CLAUDE.md` requires for delete-task / complete-sprint / remove-member.
- **can_access preflight** per requesting user at read time on every cited source record.
- **Extraction prompt discipline:** the model is instructed to return only structured obligations with cited spans and to emit `confidence` per row; anything not matching the schema is dropped. Extraction never triggers a send.

---

## 3. Data model

All Bulwark tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id`, matching `infra/postgres/migrations/0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Those policies bind when the platform flips `BBB_RLS_ENFORCE=1` (Section 2.5 point 5); until then application-level org-scoping is the enforcing layer. Each table gets a 1:1 Drizzle module under `apps/bulwark-api/src/db/schema/` (`bulwark-contracts.ts`, `bulwark-obligations.ts`, `bulwark-notice-deadlines.ts`, `bulwark-waiver-risks.ts`, `bulwark-compliance-docs.ts`, `bulwark-vendor-tiers.ts`, `bulwark-extraction-runs.ts`, `bulwark-org-settings.ts`, `bbb-refs.ts`, `index.ts`), mirroring `apps/bin-api/src/db/schema/` (which uses a `bbb-refs.ts` for cross-schema references) and `apps/basis-api/src/db/schema/`.

**Column-name join boundary (Braid D8).** Bulwark uses `organization_id` on its own tables (matching basis/bin/bond). The platform tables it joins to use `org_id` (`entity_links`, `agent_proposals`). Any query crossing that boundary aliases explicitly. There are **no cross-schema FKs** to source-app tables (Bin assets, Bond companies, Bill terms): those are referenced as a dotted `source_type` + uuid, the `entity_links.dst_type`/`dst_id` convention, so Bulwark never hard-couples to another app's schema.

### 3.1 Tables

**`bulwark_contracts`** - a contract Bulwark tracks. Points at the Bin asset holding the executed document; never stores bytes.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `project_id` | uuid | optional FK `projects(id)` ON DELETE SET NULL; the "job/engagement" this contract governs |
| `title` | varchar(512) NOT NULL | human label |
| `contract_kind` | varchar(32) NOT NULL DEFAULT `'subcontract'` | `subcontract` \| `sow` \| `msa` \| `grant_award` \| `lease` \| `other` |
| `bin_asset_id` | uuid NOT NULL | the executed document, a `bin.asset` row id (no cross-schema FK; resolved via bin-api / entity_links) |
| `counterparty_type` | varchar(32) | dotted source type, typically `bond.company` |
| `counterparty_id` | uuid | source-app row id of the counterparty (GC/sub/vendor); linked via `entity_links` |
| `effective_date` | date | |
| `expiry_date` | date | drives renewal/termination obligations |
| `status` | varchar(16) NOT NULL DEFAULT `'active'` | `draft` \| `extracting` \| `active` \| `expired` \| `terminated` |
| `extraction_status` | varchar(16) NOT NULL DEFAULT `'pending'` | `pending` \| `running` \| `extracted` \| `partial` \| `failed` |
| `extracted_at` | timestamptz | last successful extraction completion |
| `source_doc_hash` | varchar(64) | sha-256 of the extracted document bytes; re-extraction is skipped if unchanged (idempotency) |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | `updated_at` bumped by service layer (no auto trigger, so outbox-style markers do not re-bump; Braid ST3-6 discipline) |

Indexes: `(organization_id, status)`, `(organization_id, project_id)`, `(organization_id, bin_asset_id)`, `(organization_id, expiry_date)`, `(extraction_status)`.

**`bulwark_obligations`** - one typed, clause-cited obligation extracted from a contract.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid NOT NULL | FK `bulwark_contracts(id)` ON DELETE CASCADE |
| `obligation_type` | varchar(32) NOT NULL | `notice` \| `insurance` \| `indemnity` \| `payment` \| `retention` \| `flow_down` \| `renewal` \| `termination` \| `lien` \| `other` |
| `title` | varchar(512) NOT NULL | short label, e.g. "5-day delay notice" |
| `trigger_description` | text | natural-language trigger the clause names, e.g. "any owner-caused delay" |
| `event_binding` | jsonb NOT NULL DEFAULT `'{}'` | the `(source, event_type)` + optional entity filter (Section 3.3) |
| `deadline_rule` | jsonb NOT NULL DEFAULT `'{}'` | typed rule, e.g. `{ offset_days: 5, business_days: false, from: 'trigger_event' }` (Section 3.3) |
| `cited_span` | jsonb NOT NULL DEFAULT `'{}'` | extraction evidence: `{ page, section, quote, char_start, char_end }` (Section 3.3) |
| `confidence` | numeric(5,2) | LLM-reported extraction confidence in [0,1] |
| `review_status` | varchar(16) NOT NULL DEFAULT `'pending_review'` | `pending_review` \| `confirmed` \| `auto_confirmed` \| `rejected` |
| `is_armed` | boolean NOT NULL DEFAULT false | true only when `review_status IN ('confirmed','auto_confirmed')` AND `event_binding` is complete; the firing engine only matches armed obligations |
| `reviewed_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `reviewed_at` | timestamptz | |
| `extraction_run_id` | uuid | FK `bulwark_extraction_runs(id)` ON DELETE SET NULL; provenance |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, contract_id)`, `(organization_id, review_status)`, `(organization_id, obligation_type)`, `(organization_id, is_armed) WHERE is_armed`, GIN on `event_binding`. A partial expression index on the binding source/type accelerates firing lookups (Section 4.3).

**`bulwark_notice_deadlines`** - a live deadline instance created when a bound event fires (or, for calendar obligations like renewal, when the radar sweep computes a date from `expiry_date`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK `bulwark_obligations(id)` ON DELETE CASCADE |
| `contract_id` | uuid NOT NULL | denormalized for the ledger view; FK ON DELETE CASCADE |
| `triggering_event_type` | varchar(96) | `<source>:<event_type>` that armed this clock; null for calendar-derived deadlines |
| `triggering_event_id` | uuid | the Bolt event id that fired this (dedupe key); null for calendar-derived |
| `triggered_at` | timestamptz NOT NULL | the event time (or the computed calendar anchor) |
| `due_at` | timestamptz NOT NULL | deterministic: `triggered_at + deadline_rule.offset` |
| `status` | varchar(16) NOT NULL DEFAULT `'open'` | `open` \| `discharged` \| `missed` \| `waived` |
| `notice_status` | varchar(16) NOT NULL DEFAULT `'none'` | drafted-notice lifecycle: `none` \| `drafted` \| `approved` \| `sent` \| `discarded` |
| `notice_proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL; the HITL pointer |
| `notice_draft` | jsonb NOT NULL DEFAULT `'{}'` | the drafted notice body + recipients (refs), rendered by the drafting worker |
| `discharged_at` | timestamptz | when the notice was sent or the obligation otherwise satisfied |
| `radar_marker` | timestamptz | outbox-style marker: last radar sweep that processed this row (Section 4.4) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, obligation_id, triggering_event_id)` (the at-most-once arm guard; `triggering_event_id` uses a sentinel for calendar-derived rows so those dedupe on `(obligation_id, triggered_at::date)` via a second partial unique index), `(organization_id, status, due_at)` (the radar scan), `(organization_id, contract_id)`, `(notice_proposal_id)`, `(organization_id, notice_status)`.

**`bulwark_waiver_risks`** - a risk flagged when a clock is running out or an obligation is otherwise unmet.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK `bulwark_obligations(id)` ON DELETE CASCADE |
| `deadline_id` | uuid | FK `bulwark_notice_deadlines(id)` ON DELETE CASCADE; null for structural risks (e.g. an unbound high-value obligation) |
| `contract_id` | uuid NOT NULL | denormalized; FK ON DELETE CASCADE |
| `severity` | varchar(8) NOT NULL | `low` \| `medium` \| `high` \| `critical` (from hours-to-due against per-org thresholds) |
| `reason` | varchar(32) NOT NULL | `clock_running_out` \| `overdue` \| `unbound_obligation` \| `missing_compliance_doc` |
| `detail` | jsonb NOT NULL DEFAULT `'{}'` | hours remaining, dollar exposure ref if known |
| `status` | varchar(12) NOT NULL DEFAULT `'open'` | `open` \| `resolved` \| `dismissed` |
| `detected_at` | timestamptz NOT NULL DEFAULT now() | |
| `resolved_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, obligation_id, deadline_id, reason)` (idempotent re-detection: one open risk per cause), `(organization_id, status, severity)`, `(organization_id, contract_id)`.

**`bulwark_vendor_tiers`** - a lower-tier vendor/sub in the compliance chain under a contract.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid | the parent contract whose flow-down clauses impose the requirements; FK ON DELETE SET NULL |
| `vendor_type` | varchar(32) | dotted source type, typically `bond.company` |
| `vendor_id` | uuid | the vendor's Bond company row id; linked via `entity_links` |
| `tier_level` | smallint NOT NULL DEFAULT 1 | 1 = direct sub, 2 = sub-sub, etc. |
| `required_doc_types` | jsonb NOT NULL DEFAULT `'[]'` | e.g. `["coi","w9","lien_waiver","certified_payroll"]` |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'idle'` | `idle` \| `chasing` \| `compliant` \| `blocked` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, contract_id)`, `(organization_id, chase_status)`, `UNIQUE (organization_id, contract_id, vendor_type, vendor_id)`.

**`bulwark_compliance_docs`** - one required/collected compliance document for a vendor tier.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `vendor_tier_id` | uuid NOT NULL | FK `bulwark_vendor_tiers(id)` ON DELETE CASCADE |
| `doc_type` | varchar(24) NOT NULL | `coi` \| `w9` \| `lien_waiver` \| `certified_payroll` \| `other` |
| `status` | varchar(16) NOT NULL DEFAULT `'missing'` | `missing` \| `requested` \| `collected` \| `valid` \| `expiring` \| `expired` |
| `bin_asset_id` | uuid | the collected doc, a `bin.asset` row id (no cross-schema FK); null until collected |
| `effective_date` | date | |
| `expires_at` | date | drives the expiry sweep + chase |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'none'` | `none` \| `drafted` \| `approved` \| `sent` \| `escalated`; mirrors the notice-send CAS lifecycle |
| `chase_proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL; the HITL pointer |
| `blank_form_id` | uuid | optional Blank form used to collect the doc (no cross-schema FK) |
| `last_chased_at` | timestamptz | chase-cadence throttle |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, vendor_tier_id)`, `(organization_id, status)`, `(organization_id, expires_at)` (the expiry sweep), `(organization_id, doc_type)`, `(chase_proposal_id)`.

**`bulwark_extraction_runs`** - an audit row per extraction attempt.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid NOT NULL | FK `bulwark_contracts(id)` ON DELETE CASCADE |
| `status` | varchar(16) NOT NULL DEFAULT `'running'` | `running` \| `succeeded` \| `partial` \| `failed` |
| `chunk_count` | integer | number of document chunks sent to the llm-provider |
| `obligations_extracted` | integer NOT NULL DEFAULT 0 | |
| `low_confidence_count` | integer NOT NULL DEFAULT 0 | rows routed to review |
| `provider_id` | uuid | the llm_providers row used (no cross-schema FK) |
| `error` | text | on failure |
| `started_at` | timestamptz NOT NULL DEFAULT now() | |
| `finished_at` | timestamptz | |

Indexes: `(organization_id, contract_id, started_at DESC)`, `(status)`.

**`bulwark_org_settings`** - per-org tunables (modeled on `basis_org_settings`, `0226_basis_core.sql`). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE; `UNIQUE` |
| `auto_confirm_threshold` | numeric(5,2) NOT NULL DEFAULT 0.95 | extraction rows at/above this land `auto_confirmed` (still reversible); below go to `pending_review` |
| `radar_lead_times` | jsonb NOT NULL DEFAULT `'{"critical_hours":24,"high_hours":72,"medium_hours":168}'` | maps hours-remaining to `waiver_risk.severity` |
| `auto_draft_notices` | boolean NOT NULL DEFAULT true | when true, the radar drafts a notice proposal automatically at the `high` band; when false, it only flags the risk |
| `chase_cadence_days` | integer NOT NULL DEFAULT 7 | minimum days between compliance chase drafts for a doc |
| `coi_expiry_lead_days` | integer NOT NULL DEFAULT 30 | how far ahead of `expires_at` a compliance doc is marked `expiring` and a chase is drafted |
| `llm_provider_id` | uuid | the `llm_providers` row used for extraction; null falls back to the org default |
| `last_radar_sweep_at` | timestamptz | advanced only after a fully successful sweep (Braid ST-r2-7 discipline) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): Bulwark writes durable `bulwark.contract -> bond.company` (counterparty), `bulwark.contract -> bin.asset` (document), and `bulwark.vendor_tier -> bond.company` links (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`). Note `org_id` here vs `organization_id` on Bulwark tables.
- `agent_proposals` (`0128_agent_proposals.sql`): every drafted notice and compliance chase is inserted directly with `approver_id=NULL`, `expires_at` set (Section 2.2).
- `organizations`, `users`, `projects`, and the platform `actor_type` enum.
- `bin_assets` (`apps/bin-api`, `0205_bin_dam.sql`): the executed document and collected compliance docs; read-only, via bin-api's internal read + `@bigbluebam/storage` byte access (Section 3.5).
- `llm_providers` (`apps/api`): the extraction model, reached only through `POST /internal/llm/chat`.

### 3.3 JSONB shapes (authoritative)

```jsonc
// bulwark_obligations.event_binding - the (source, event_type) Bolt pattern + optional entity filter.
// The firing engine matches an incoming Bolt event iff source+event_type match AND every
// entity_filter path in the event payload equals the resolved value.
{
  "source": "bam",                       // the publishing app (bolt-api EventDefinition.source)
  "event_type": "task.overdue",          // bare event name, matches event-catalog.ts
  "entity_filter": {                     // optional; scopes the binding to this contract's job
    "payload_path": "task.project_id",
    "equals_contract_field": "project_id"
  },
  "unbound": false                       // true = extraction could not map a trigger; needs human binding
}

// bulwark_obligations.deadline_rule - deterministic due-date arithmetic.
{
  "offset_days": 5,
  "business_days": false,                // if true, skip weekends (and, later, org holidays)
  "from": "trigger_event",               // trigger_event | contract_effective_date | contract_expiry_date
  "grace_hours": 0
}

// bulwark_obligations.cited_span - extraction evidence with source citation.
{
  "page": 7,
  "section": "12.3",
  "quote": "Subcontractor shall give written notice within five (5) days of any event giving rise to a claim for additional time.",
  "char_start": 18442,
  "char_end": 18571,
  "chunk_index": 3
}

// bulwark_notice_deadlines.notice_draft - the drafted notice (refs + rendered body).
{
  "recipient_type": "bond.company",
  "recipient_id": "…",
  "subject": "Notice of Delay - [contract.title]",
  "body_markdown": "…generated by the drafting worker…",
  "attachments": [{ "bin_asset_id": "…" }],
  "channel": "blast"                     // blast (email campaign of one) | blank (form)
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed migration tip on this branch is `0233_braid_builtin_group_defaults.sql`, and the latest permissions delta is `0232_permissions_seed_actions_delta_021.sql`. **All numbers below are provisional.** Every file carries the header block (`-- Why:` / `-- Client impact:`) and uses idempotent DDL, matching `CLAUDE.md` conventions.

1. **`0234_bulwark_core.sql`** - `bulwark_contracts`, `bulwark_obligations`, `bulwark_notice_deadlines`, `bulwark_waiver_risks`, `bulwark_extraction_runs`, `bulwark_org_settings`, all indexes (incl. the two partial unique indexes on `bulwark_notice_deadlines`), and RLS policies. Self/forward FKs added via guarded `DO $$` blocks after the tables exist (mirrors `0226_basis_core.sql`). Additive only.
2. **`0235_bulwark_compliance.sql`** - `bulwark_vendor_tiers`, `bulwark_compliance_docs`, their indexes, RLS. Additive only. (Split from core so the compliance side can be reviewed/shipped independently.)
3. **`NNNN_permissions_seed_actions_delta_022.sql`** - **generated** (basis/braid hand-authored pattern). The `bulwark.*` rows are hand-authored because `bulwark_` is not in `APP_PREFIXES` (`scripts/generate-permission-manifest.mjs`), exactly as `basis_`/`braid_` are. Strict sequence:
   - (a) land `0234`/`0235` on disk;
   - (b) register the **11** `bulwark.*` rows in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs`, each with an explicit `app:'bulwark'` (rows without `app` default to `'bam'`, false provenance otherwise) AND an **explicit `is_read` value on every row** so no flag depends on verb inference (Braid BP3-2): see Section 10 for the 11 rows and flags;
   - (c) add an `if (c.id.startsWith('bulwark.')) { migrationLabel = '<this delta>'; sourceFile = 'bulwark route/tools'; }` provenance branch mirroring the basis/braid branch;
   - (d) do NOT add `bulwark_*` to `EXPLICIT_TOOL_OVERRIDES` (basis/braid satellite deferral): leaving `bulwark_*` unmapped in `TOOL_TO_PERMISSION` defers the Wave D resolver, so the `HAND_AUTHORED` loop is the sole creator of all 11 rows and its explicit flags land;
   - (e) regenerate the manifest and verify with `check-permission-catalog.mjs`;
   - (f) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number and delta suffix (do not hand-pick). Additive only.
4. **`0237_bulwark_builtin_group_defaults.sql`** - backfills `bulwark.*` into the built-in role default matrix, copied verbatim from `0233_braid_builtin_group_defaults.sql` with `p.app = 'bulwark'`. Without it, every non-SuperUser (including org Owners) hits `implicit_deny` on `/bulwark` routes and the SPA 403s for everyone, the exact gap the Braid build hit. Tiering: owner/admin/member = full (`NOT p.requires_superuser`), viewer = read-only (`p.is_read AND NOT p.requires_superuser`), guest = none. `INSERT ... ON CONFLICT DO NOTHING`. Additive only.

Bolt event registration (Section 7), the `bolt-api` dispatch-hook edit (Section 6), and any `SUPPORTED_ENTITY_TYPES` additions are TypeScript edits, not migrations.

---

## 4. The engines

Both engines run as **BullMQ workers** in `apps/worker`, not in the request path, matching the placement of every satellite app's background work (`bond-stale-deals`, `basis-metric-snapshot`, the braid jobs).

### 4.1 Obligation-extraction engine

**Trigger.** A contract is registered (or its Bin asset changes) via `POST /bulwark/api/v1/contracts` or `POST /contracts/:id/extract`, which enqueues `bulwark-extract-obligations { org_id, contract_id }`. Re-extraction is skipped if `source_doc_hash` is unchanged (idempotency).

**Pipeline (in the worker):**
1. **Fetch bytes.** Read the executed document from Bin. The worker resolves the `bin_asset_id` to bytes via `@bigbluebam/storage` `getStream` (the storage package the worker already links, `packages/storage/`), or via bin-api's internal read route if the byte access needs bin-api's serving gate. Extract text (PDF text layer; OCR is an Open Question for scanned docs, Section 12). Compute `source_doc_hash`.
2. **Chunk.** Split into overlapping ~2-4k-token chunks with page/section anchors preserved so a `cited_span` can carry `{ page, section, char_start, char_end, chunk_index }`. Progress logged per chunk via `@bigbluebam/logging` (the user's flushed-progress rule; a multi-minute extraction must not sit silent).
3. **Extract per chunk.** For each chunk, call the internal llm-provider `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`) with `X-Internal-Secret: INTERNAL_SERVICE_SECRET`, a system prompt that fixes the obligation taxonomy and demands strict JSON, and the chunk text. The response is parsed and **validated against the Zod obligation schema** (`packages/shared/src/schemas/bulwark.ts`); anything malformed is dropped (Section 2.5 point 2). Each obligation carries `{ obligation_type, title, trigger_description, proposed_event_binding, deadline_rule, cited_span, confidence }`.
4. **Deterministic post-processing.** Parse `deadline_rule` from the model's natural-language deadline into the typed shape (e.g. "within five (5) days" -> `{offset_days:5}`) with a deterministic parser; if the parser and the model disagree, mark `unbound`/low-confidence and route to review. Map the proposed trigger to a real `(source, event_type)` from `event-catalog.ts` via a curated alias table (e.g. "delay/schedule slip" -> `bam:task.overdue`, "payment received" -> a `bill` event); an unmapped trigger sets `event_binding.unbound=true`.
5. **Persist.** Upsert `bulwark_obligations` rows. Rows at/above `auto_confirm_threshold` land `auto_confirmed` and `is_armed=true` if the binding is complete; the rest land `pending_review` (`is_armed=false`). Write a `bulwark_extraction_runs` audit row and set `contract.extraction_status`. Emit `obligation.extracted` (per obligation or per run, Section 7) and, on completion, `contract.extracted`.

**Human-review queue.** Anything `pending_review` (low confidence, parser disagreement, or unbound trigger) surfaces in the SPA review queue (Section 5). A human confirms/edits/rejects via `bulwark.obligation.write`. Only `confirmed`/`auto_confirmed` obligations with a complete binding are `is_armed` and thus visible to the firing engine.

**Where it runs.** Queue `bulwark-extract-obligations` in `apps/worker/src/worker.ts`, with BullMQ `attempts` + exponential backoff and a DLQ (the `agent-webhook-dispatch.job.ts` / `-dlq.job.ts` model). LLM calls use a bounded `AbortController` timeout; a provider outage fails the run with a retry, never blocks the API.

### 4.2 Event-binding + firing engine

An armed obligation's `event_binding` + `deadline_rule` turns a live Bolt event into a `bulwark_notice_deadline`.

**Transport in (Section 6 details).** `bolt-api` forwards subscribed events to Bulwark's internal route `POST /bulwark/api/v1/internal/events` (guarded by `INTERNAL_SERVICE_SECRET`), which enqueues a refs-only job `{ org_id, source, event_type, event_id, occurred_at, payload_refs }` into the shared Redis queue `bulwark-fire-on-event`.

**Firing job (`bulwark-fire-on-event`):**
1. Select armed obligations for the org whose `event_binding.source`/`event_type` match the incoming event (indexed lookup, Section 3.1). For each, evaluate the optional `entity_filter` against the event payload (e.g. `payload.task.project_id == contract.project_id`); skip non-matching.
2. Compute `due_at = occurred_at + deadline_rule.offset` (business-day aware if set).
3. Insert a `bulwark_notice_deadline` with `ON CONFLICT (organization_id, obligation_id, triggering_event_id) DO NOTHING` (the at-most-once arm guard, Section 2.1). A redelivered event or retried job no-ops.
4. Emit `deadline.approaching` only when appropriate (the radar owns approaching/risk transitions; the firing job just arms the clock). Emit nothing else on a pure arm.

Idempotency, retry, backoff, and DLQ mirror the extraction job. The "capture the version" outbox discipline (Braid ST3-1, `bond-stale-deals.job.ts:127-138`): the firing job records `triggering_event_id` so re-processing is a no-op, and the radar's `radar_marker` is stamped to the observed sweep time, never `now()` mid-computation, so a crash between compute and side effect is reprocessed next sweep.

### 4.3 The deadline-radar sweep

Queue `bulwark-radar-sweep`, scheduled every 15 minutes (`*/15 * * * *`; a short cadence because notice windows are measured in days and a missed few hours can waive a claim). Per org:
1. **Approaching / risk detection.** Scan `bulwark_notice_deadlines WHERE status='open'` ordered by `due_at`. For each, compute hours-remaining and map to `waiver_risk.severity` via `settings.radar_lead_times`. Upsert a `bulwark_waiver_risk` (`ON CONFLICT (organization_id, obligation_id, deadline_id, reason) DO NOTHING`) so re-detection does not duplicate. Emit `deadline.approaching` and, on a new risk, `waiver.risk_detected`.
2. **Auto-draft.** When `settings.auto_draft_notices` and the risk reaches the `high` band and the obligation type is `notice`, render the notice draft (a second, bounded llm-provider call over the clause + event context, best-effort) into `notice_deadlines.notice_draft`, set `notice_status='drafted'`, insert an `agent_proposals` row (Section 2.2), set `notice_proposal_id`, and emit `notice.drafted`. This never sends; it fills the approval inbox.
3. **Missed.** Deadlines past `due_at` with `status='open'` flip to `missed` and raise a `critical`/`overdue` `waiver_risk`.
4. **Calendar obligations.** For `renewal`/`termination` obligations bound to `contract_effective_date`/`contract_expiry_date` (not a live event), compute the deadline from the contract dates and arm on the second partial-unique index.

`last_radar_sweep_at` advances only after a fully successful per-org tick (resumable from per-row markers). Per-N progress logging via `@bigbluebam/logging`, modeled on `basis-metric-snapshot.job.ts`.

**Durable fallback for the live transport (Braid soft-dependency framing).** Because a dropped `bolt-api` dispatch would otherwise silently fail to arm a clock, the radar sweep ALSO source-diffs the persisted Bolt event log: it selects Bolt events matching any armed obligation's bound `(source, event_type)` since a per-org watermark and runs the firing logic for any not already armed (the `triggering_event_id` unique guard makes this safe to re-run). So a lost dispatch degrades to at-most-15-minutes-late arming, never a permanently missed clock. The exact persisted-event table/name is an Open Question (Section 12); the braid precedent reads `bolt_recent_events`.

### 4.4 The compliance-chase sweep

Queue `bulwark-coi-chase`, scheduled daily (`30 4 * * *`). Per org:
1. Scan `bulwark_compliance_docs` and mark `expiring` where `expires_at <= now() + settings.coi_expiry_lead_days`, `expired` where past. Emit `compliance.expiring` on transition to `expiring`.
2. For `missing`/`expiring`/`expired` docs whose `last_chased_at` is older than `settings.chase_cadence_days`, render a chase draft (email via Blast, or a Blank collection form link), set `chase_status='drafted'`, insert an `agent_proposals` row (`proposed_action='bulwark.chase_compliance_doc'`), set `chase_proposal_id`, bump `last_chased_at`, and emit nothing until approved. The actual Blast send / Blank form dispatch executes only on `proposal.decided` approve (Section 2.4).
3. Roll `vendor_tier.chase_status` up from its docs (`compliant` when all required docs are `valid`, else `chasing`/`blocked`).

### 4.5 Worker jobs summary

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `bulwark-extract-obligations` | event-driven (contract register / re-extract) | Bin bytes -> chunk -> internal llm-provider -> typed obligations + cited spans; low-confidence to review. Idempotent on `source_doc_hash`. Retry/backoff/DLQ. |
| `bulwark-fire-on-event` | event-driven (bolt-api dispatch, Section 6) | Match armed obligations to a live event, compute `due_at`, arm a `notice_deadline` (at-most-once). Idempotent on `triggering_event_id`. |
| `bulwark-radar-sweep` | every 15 min | Risk detection, auto-draft notices into proposals, missed-clock detection, calendar obligations, and the source-diff fallback for lost dispatches. |
| `bulwark-coi-chase` | daily 04:30 | Compliance expiry sweep + chase-draft proposals (Blast/Blank), throttled by cadence. |
| `bulwark-retention` | daily 04:50 | Purge terminal-status deadlines/risks older than N days (`basis-retention-sweep.job.ts` model). Never touches `bulwark_extraction_runs` audit or `bulwark_contracts`. |

All fan-out sets `app.current_org_id` per org and wraps each `(org, row)` in try/catch log-and-continue (the `banter-feed-fanin` pattern).

---

## 5. API surface

Base path `/bulwark/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data: ... }`; errors the canonical `{ error: { code, message, details, request_id } }` from `@bigbluebam/logging` `createErrorHandler` (`apps/basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Shapes live in `packages/shared/src/schemas/bulwark.ts`.

### 5.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/contracts` | List tracked contracts | `bulwark.contract.read`; filterable by `project_id`, `status` |
| POST | `/v1/contracts` | Register a contract from a Bin asset; enqueues extraction | `bulwark.contract.write`; body `{ bin_asset_id, title, contract_kind, project_id?, counterparty_type?, counterparty_id?, effective_date?, expiry_date? }` |
| GET | `/v1/contracts/:id` | Contract detail (with obligation + deadline rollup) | `bulwark.contract.read`; cited source records `can_access`-filtered per asker |
| PATCH | `/v1/contracts/:id` | Update metadata | `bulwark.contract.write` |
| DELETE | `/v1/contracts/:id` | Delete a tracked contract (not the Bin asset) | `bulwark.contract.delete`; confirm token via MCP; cascades obligations/deadlines |
| POST | `/v1/contracts/:id/extract` | Re-run extraction | `bulwark.contract.write`; skipped if `source_doc_hash` unchanged unless `force=true` |
| GET | `/v1/contracts/:id/obligations` | Obligation ledger for a contract | `bulwark.obligation.read` |
| GET | `/v1/obligations` | List obligations (review queue via `filter[review_status]=pending_review`) | `bulwark.obligation.read`; sort `-confidence` |
| GET | `/v1/obligations/:id` | Obligation detail + `cited_span` | `bulwark.obligation.read` |
| PATCH | `/v1/obligations/:id` | Confirm / edit / bind / reject an obligation | `bulwark.obligation.write`; setting `review_status='rejected'` requires the confirm token via MCP |
| GET | `/v1/deadlines` | Deadline radar (filter by `status`, `contract_id`, `due_before`) | `bulwark.deadline.read`; sort `due_at` |
| GET | `/v1/deadlines/:id` | Deadline detail + drafted notice | `bulwark.deadline.read` |
| POST | `/v1/deadlines/:id/draft-notice` | Draft (or re-draft) a notice and register the proposal | `bulwark.notice.draft`; inserts `agent_proposals` (Section 2.2) |
| POST | `/v1/deadlines/:id/approve-send` | Approve+send a drafted notice directly (UI surface) | `bulwark.notice.draft`; the single send executor + CAS (Section 2.4) |
| POST | `/v1/deadlines/:id/discharge` | Mark discharged/waived | `bulwark.deadline.read`+write; waive requires confirm token |
| GET | `/v1/waiver-risks` | List open waiver risks | `bulwark.deadline.read`; sort `-severity` |
| GET | `/v1/vendor-tiers` | List vendor tiers | `bulwark.compliance.read` |
| POST | `/v1/vendor-tiers` | Add a vendor tier | `bulwark.compliance.chase`+write |
| GET | `/v1/compliance-docs` | Vendor compliance matrix (filter by `status`, `doc_type`, `vendor_tier_id`) | `bulwark.compliance.read` |
| POST | `/v1/compliance-docs/:id/chase` | Draft a compliance chase and register the proposal | `bulwark.compliance.chase`; inserts `agent_proposals` |
| POST | `/v1/compliance-docs/:id/approve-send` | Approve+send a chase directly (UI) | `bulwark.compliance.chase`; single send executor + CAS |
| GET | `/v1/settings` | Get org settings | `bulwark.settings.read` |
| PATCH | `/v1/settings` | Update org settings | `bulwark.settings.write` |
| POST | `/v1/internal/events` | Ingest-trigger from bolt-api (Section 6) | `INTERNAL_SERVICE_SECRET`; enqueues `bulwark-fire-on-event`; no public route, no MCP tool |
| GET | `/health` / `/readyz` | Probes | from `@bigbluebam/service-health` `healthCheckPlugin`; `/readyz` checks ONLY Postgres + Redis (`apps/basis-api/src/server.ts:76`) |

**flagship `bulwark_check_notice_risk(job_id)`** is backed by `GET /v1/deadlines?filter[project_id]=<job>&status=open` composed with `GET /v1/waiver-risks?filter[contract...]`; the MCP tool assembles both into one risk report (Section 10). **flagship `bulwark_extract_obligations(contract_asset_id)`** is backed by `POST /v1/contracts` (register-if-new) + `POST /v1/contracts/:id/extract`.

### 5.2 Realtime (`/bulwark/ws`)

Redis-PubSub, org-scoped rooms. Payloads are **refs-only**: `deadline.armed { deadline_id, obligation_id, due_at }`, `waiver.risk_detected { risk_id, severity, contract_id }`, `notice.drafted { deadline_id, proposal_id }`, `compliance.expiring { compliance_doc_id, vendor_tier_id }`. No clause text or PII in the frame; the SPA fetches through the permission-gated read path. Notification channel only. WebSocket plumbing modeled on `apps/basis-api` / `apps/bin-api` ws routes and the Redis PubSub cross-instance broadcast pattern (`CLAUDE.md` "WebSocket realtime").

### 5.3 Permissions (11 rows)

Manifest-generated `app.resource.verb`, resolved by an `apps/basis-api/src/plugins/permissions.ts`-style plugin. Enumerated with flags in Section 10. Read rows default to org-admin-equivalent (consolidated commitment data); `bulwark.contract.delete`, `bulwark.obligation.write` (reject path), and the waive path carry the confirm boundary. The hand-authored registration sequence is Section 3.4 step 3.

---

## 6. Background work and the ingest transport

BullMQ workers in `apps/worker` (Section 4.5). The live firing transport (the Braid IN3 problem, resolved the way the Braid spec resolved it):

**Bolt event to BullMQ enqueue.** `bolt-api` is an ingest hub with no generic service fan-out; the Braid build added a per-event dispatch hook (`apps/bolt-api/src/services/braid-dispatch-hook.ts`, called from `apps/bolt-api/src/routes/event-ingestion.routes.ts:165`). Bulwark adds a **parallel `bulwark-dispatch-hook.ts`** in bolt-api, called alongside `dispatchToBraid` in the same ingestion route, that POSTs matching events to Bulwark's `POST /bulwark/api/v1/internal/events` (guarded by `INTERNAL_SERVICE_SECRET`), fire-and-forget, with the radar source-diff as the durable fallback (Section 4.3).

**Bulwark's subscriptions are dynamic, unlike Braid's fixed source-type map.** Braid hard-codes a small `SUBSCRIPTIONS` table (`braid-dispatch-hook.ts:32`) because its source types are fixed. Bulwark's bound `(source, event_type)` pairs are DATA (one per confirmed obligation binding), so the dispatch hook cannot hard-code them. Resolution: Bulwark maintains a **cached set of distinct active bound pairs per org** and the dispatch hook consults it before forwarding. Two concrete options (decide at build, Open Question):
- (a) **Redis set maintained by Bulwark:** on every obligation arm/disarm Bulwark writes `SADD bulwark:bindings <source>:<event_type>` (org-agnostic union is enough to gate the firehose; the worker re-checks org + entity_filter). The dispatch hook does one `SISMEMBER` before forwarding. Cheapest and matches the fire-and-forget latency budget.
- (b) **A `GET /v1/internal/bindings` endpoint** on bulwark-api the hook caches with a short TTL.

Either way, an event that is not bound is never forwarded, so the hook is not a firehose. `INTERNAL_SERVICE_SECRET` fail-closes (empty secret means no forward, radar catches it). Whether to prefer (a) or (b), and the exact persisted-Bolt-event table the radar source-diffs, are Open Questions (Section 12), both soft dependencies because the radar fallback makes the live path optional for correctness (only for latency).

**Worker env.** The worker needs `BBB_API_INTERNAL_URL` (the internal llm-provider for extraction and notice drafting) added to its compose env and `worker.optional` catalog entry, exactly as the Braid build added it (`docker-compose.yml` worker service, `scripts/deploy/shared/services.mjs`). No source-app internal URLs are added; the worker reads Bin bytes through `@bigbluebam/storage` (already linked) and reads its own schemas directly via `DATABASE_URL`.

---

## 7. Events & integration

### 7.1 Bolt events published (source `bulwark`)

Via `publishBoltEvent(eventType, 'bulwark', payload, orgId, actorId?, actorType?)` (positional signature, `packages/shared/src/bolt-events.ts:35`), bare names, each registered with a `payload_schema` in a new `bulwarkEvents` block in `apps/bolt-api/src/services/event-catalog.ts` (appended to `ALL_EVENTS`), or `scripts/check-bolt-catalog.mjs` fails CI. Payloads are refs + magnitude only.

| `event_type` | When | Payload (refs only) |
| --- | --- | --- |
| `contract.extracted` | an extraction run completes | `contract.id`, `obligations_extracted`, `low_confidence_count`, `org.id` |
| `obligation.extracted` | a new obligation is persisted | `obligation.id`, `contract.id`, `obligation_type`, `confidence`, `review_status`, `org.id` |
| `deadline.approaching` | radar detects a clock nearing due | `deadline.id`, `obligation.id`, `contract.id`, `due_at`, `hours_remaining`, `org.id` |
| `waiver.risk_detected` | a new waiver risk is raised | `risk.id`, `obligation.id`, `contract.id`, `severity`, `reason`, `org.id` |
| `notice.drafted` | a notice draft + proposal is created | `deadline.id`, `proposal.id`, `contract.id`, `org.id` |
| `compliance.expiring` | a compliance doc crosses into expiring/expired | `compliance_doc.id`, `vendor_tier.id`, `doc_type`, `expires_at`, `org.id` |

These are consumable by Bolt rules (e.g. "on `waiver.risk_detected severity=critical`, notify the PM in Banter"), by outbound webhooks, and by other apps. `notice.drafted`/`waiver.risk_detected` are the ones customers will most want to route.

### 7.2 Events Bulwark SUBSCRIBES to (the binding targets)

Bulwark does not own a fixed subscription list; it reacts to whatever `(source, event_type)` its confirmed obligations bind to. Common beachhead bindings, mapped from `event-catalog.ts`:
- `bam:task.overdue`, `bam:task.updated` (schedule slips / delay events on a job's tasks)
- `bill` pay-app / retention / overdue events (payment and retention obligations)
- `book` deadline/event changes (date-driven obligations)
- `bam:sprint.completed`, `epic.*` (milestone-driven notice triggers)

The transport is Section 6. New binding targets require no Bulwark code change (they are data); they require only that the `(source, event_type)` exists in `event-catalog.ts` and, for the live path, that the dispatch-hook gate (Section 6) admits it.

### 7.3 entity_links, unified activity, search

- **entity_links:** on contract register and vendor-tier create, upsert `entity_links` rows (`src_type='bulwark.contract'`/`'bulwark.vendor_tier'`, `dst_type` = the source type, `link_kind='related_to'`, `ON CONFLICT DO NOTHING`). This is how Bulwark appears in cross-app "what is linked to this counterparty" views without a `v_activity_unified` change.
- **unified activity:** Bulwark's catalog changes flow as the Bolt events above, not into the fixed `v_activity_unified` UNION in v1 (which is bam/bond/helpdesk only, `0129_*`), matching the Braid decision.
- **search:** a Bulwark provider in `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`) restricted to permission-gated askers with per-viewer post-filtering is a fast-follow, not v1 (Braid shipped its provider in v1; Bulwark defers to keep v1 tight). Flagged in Section 12.

### 7.4 Braid integration (unify the counterparty)

Where **Braid** (`apps/braid-api`) is available, Bulwark resolves the counterparty/vendor person-or-company to a Braid golden id via `braid_resolve` before writing the `entity_links` row, so the GC in Bond, the client in Bill, and the vendor in a compliance form all resolve to one real-world counterparty. This is a soft dependency: absent Braid, Bulwark links directly to the `bond.company` id. Cited: Braid Section 2.4 (`braid_resolve` is a non-admin-grantable, `preflightAccess`-guarded resolve).

---

## 8. Testing

- **Unit (Vitest, schema-isolated via `@bigbluebam/db-stubs`, basis safety-suite precedent commit `7587872c`):**
  - deterministic `deadline_rule` arithmetic: fixed rule + fixed event -> fixed `due_at`; business-day offsets; grace hours.
  - extraction validation: a malformed / out-of-schema LLM response is dropped, never persisted (Section 2.5 point 2); low-confidence rows land `pending_review` with `is_armed=false`.
  - arm idempotency: the same `(obligation_id, triggering_event_id)` fired twice arms exactly one `notice_deadline` (the unique-constraint guard).
  - firing filter: an event whose `entity_filter` path does not equal the contract's job does NOT arm the clock.
  - radar bands: hours-remaining maps to the correct `waiver_risk.severity`; a missed clock flips to `missed` and raises `critical`; risk re-detection does not duplicate (the `ON CONFLICT` guard).
  - send exactly-once (Section 2.4): a REST approve-send racing the `proposal.decided` echo sends once (the `notice_status` CAS); the loser no-ops.
  - proposal registration: the direct `agent_proposals` insert carries `approver_id=NULL`, an explicit `expires_at`, and `subject_type='bulwark.notice_draft'`; `proposal.created` is emitted after insert.
  - kill-switch on send: a `proposal.decided` approve whose decider fails the `agent_policies` check leaves the draft `approved` and does NOT send (Braid S-r2-1 discipline).
  - source-diff fallback: a lost dispatch is recovered by the radar's Bolt-event source-diff, arming the clock at most one sweep late, with no double-arm.
- **register-tool policy test:** `bulwark.*` fails closed until allowlisted; Bulwark does not populate `TOOL_TO_PERMISSION` (basis/braid Wave D deferral), so the test asserts the allowlist gate, not per-action mapping. A manifest test asserts the three destructive rows land `is_destructive:true, requires_confirmation:true` and every hand-authored row carries an explicit `is_read`.
- **Org-scoping test:** a service-layer query for org A returns zero org-B rows on every `bulwark_*` table (application-level), plus an optional RLS-binding test that runs only when the enforced non-superuser role is provisioned.
- **e2e (Playwright, GILLIGAN dataset per `CLAUDE.md`):** a gilligan "Castaway Rescue Subcontract" is registered from a Bin asset; extraction produces a 5-day notice obligation bound to `bam:task.overdue`; a reviewer confirms it; an overdue task on the job arms the clock; the radar drafts a notice into the approval queue; the Skipper approves and the send executes once; an expiring "Howell COI" triggers a chase draft.

---

## 9. Infrastructure

### 9.1 New api compose service

`bulwark-api` in `docker-compose.yml`, modeled on `braid-api` (`docker-compose.yml:861`) and `basis-api`: `PORT: 4021`, stateless, horizontally scalable. It inherits the basis-style per-request RLS GUC plugin (`apps/basis-api/src/plugins/rls.ts`) by modeling on basis-api; it does NOT flip the DB role (Section 2.5 point 5). `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Source apps, Bin, and the llm-provider are NOT in `depends_on` (request-time deps). Env: `DATABASE_URL`, `DATABASE_READ_URL=${DATABASE_READ_URL:-}` (read offload for the ledger/radar reads, mirroring braid-api `:868`), `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` (non-empty; the `/internal/events` transport + can_access preflight fail closed when empty), `BBB_API_INTERNAL_URL=http://api:4000` (llm-provider + can_access), `BOLT_API_INTERNAL_URL=http://bolt-api:4006` (publish events), `BIN_API_INTERNAL_URL` if byte reads route through bin-api's serving gate, `CORS_ORIGIN`, `NODE_ENV`, `HOST`, `LOG_LEVEL`, rate-limit knobs, `BBB_PERMISSIONS_ENFORCE`. Healthcheck: `curl -sf http://localhost:4021/health`.

### 9.2 Worker service wiring

The engines run in `apps/worker`. Edits (mirroring the Braid worker wiring):
- **Compose (`docker-compose.yml` worker service):** add `BBB_API_INTERNAL_URL: http://api:4000` (extraction + drafting via the internal llm-provider) and `BULWARK_API_INTERNAL_URL: http://bulwark-api:4021` if the worker needs to call back into bulwark-api (it does not for reads; it uses `DATABASE_URL`, but keep the option). `@bigbluebam/storage` is already linked for Bin byte reads.
- **Catalog (`scripts/deploy/shared/services.mjs`):** add `BBB_API_INTERNAL_URL` to `worker.optional` (Braid already added it; if present, no-op).
- **`worker.needs` unchanged:** every new bulwark worker upstream (api for the llm-provider, bolt-api for event publish, Bin for bytes) is a degradable, retried, DLQ'd request-time dependency, consistent with the existing worker posture.
- Register the five queues (`bulwark-extract-obligations`, `bulwark-fire-on-event`, `bulwark-radar-sweep`, `bulwark-coi-chase`, `bulwark-retention`) in `apps/worker/src/worker.ts` (three repeatable/scheduled, two event-driven).

### 9.3 SPA build (four Dockerfile edit sites, no separate compose service)

Every SPA is built in the single `apps/frontend/Dockerfile` and `COPY`'d into `/usr/share/nginx/html/<app>`. Bulwark edits it in four sites, mirroring the exact braid lines (Braid Section 9.3):
1. deps-stage `COPY apps/bulwark/package.json ./apps/bulwark/`.
2. build-stage 4-line source COPY block (`src`, `public`, `index.html`, the three tsconfig/vite files).
3. add `&& pnpm --filter @bigbluebam/bulwark build` to the build `RUN`.
4. production-stage `COPY --from=build /app/apps/bulwark/dist /usr/share/nginx/html/bulwark`.

There is no deps-stage source COPY and no separate `bulwark` compose service.

### 9.4 nginx routing (two source configs, generated railway)

`infra/nginx/nginx.railway.conf` is auto-generated from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs` (`do not edit by hand` header). Edit only the two source configs, then regenerate:
- `infra/nginx/nginx.conf` (after the braid blocks at 327-...): add `/bulwark/` alias + SPA fallback, `/bulwark/api/ -> http://bulwark-api:4021/`, `/bulwark/ws -> http://bulwark-api:4021/ws` with upgrade headers. Add `bulwark` to the static-asset regex.
- `infra/nginx/nginx-with-site.conf`: the same three blocks + static-asset regex.
- Then run `node scripts/gen-railway-configs.mjs`. Because `bulwark-api` is in `APP_SERVICES` (Section 9.6), the generator rewrites the upstream to `bulwark-api.railway.internal:8080`, synthesizes the `$rw_upstream_NN` index and the `rewrite ... break;` lines, and adds the static-asset entry. Do not hand-edit `:8080` or `$rw_upstream` indices.

**Static-asset regex divergence:** the two source alternations already differ (`nginx.conf` includes `bill`; `nginx-with-site.conf` does not). Edit each source in place to add `bulwark`; do not copy one alternation over the other.

**Ingress crash-safety:** add `bulwark-api` (`condition: service_healthy`) to the `frontend` service `depends_on` in `docker-compose.yml` (braid-api is already there). This compose edit, not the services.mjs metadata, is the real load-time guarantee.

### 9.5 Deploy catalog, Railway manifests, MCP wiring, Launchpad, CLAUDE.md

- `scripts/deploy/shared/services.mjs`: add a `bulwark-api` `APP_SERVICES` block (port `4021`, `public_paths: ['/bulwark/api/','/bulwark/ws']`, `required` env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`/`BOLT_API_INTERNAL_URL`, `optional` incl. `DATABASE_READ_URL`/`BIN_API_INTERNAL_URL`/`CORS_ORIGIN`/`LOG_LEVEL`), mirroring `braid-api` (`:270`). Trim `bulwark-api.needs` to `['postgres','redis','api','bolt-api']`; source reads are shared-DB, Bin/llm are soft. Add `/bulwark/` to the `frontend` entry's `public_paths` and `bulwark-api` to its `needs`. Add `bulwark-api` to `mcp-server`'s `needs` metadata and set `BULWARK_API_URL: http://bulwark-api:4021/v1`, but do NOT add it to compose `depends_on` (request-time only, matching bond-api/braid-api). Register `bulwark-tools.ts` in the MCP bootstrap.
- Add the `bulwark-dispatch-hook` wiring to bolt-api (Section 6): `BULWARK_API_INTERNAL_URL=http://bulwark-api:4021` in bolt-api's compose env and catalog, alongside the existing `BRAID_API_INTERNAL_URL`.
- **Run `node scripts/gen-railway-configs.mjs`**: regenerates `nginx.railway.conf` and emits `railway/bulwark-api.json`.
- **Launchpad catalog** in `apps/api/src/routes/system-settings.routes.ts`: add `'bulwark'` to `LAUNCHPAD_APP_IDS` and a `LAUNCHPAD_CATALOG` entry: `{ id: 'bulwark', name: 'Bulwark', description: 'Contract Obligations', icon_name: 'shield-check', color: '#1d4ed8', path: '/bulwark/' }`. Do NOT add `bulwark` to `ROOT_REDIRECT_VALUES` (matches basis/braid precedent; avoids the `REDIRECT_MAP` typecheck break).
- **Launchpad icon:** `shield-check` is absent from the `ICONS` map in `packages/ui/launchpad.tsx:65` (it has `git-merge`/`ruler` but no shield); an unknown `icon_name` falls back to `Box` (`launchpad.tsx:226`). Two edits: `import { ShieldCheck } from 'lucide-react'` and add `'shield-check': ShieldCheck` to the `ICONS` table. No grid redesign.
- **CLAUDE.md (Phase 5 mandate):** append the `bulwark-api` (internal :4021, `/bulwark/api/`) and `bulwark` SPA (`/bulwark/`) inventory lines, add the `/bulwark/`, `/bulwark/api/`, `/bulwark/ws` route rows, and bump the MCP tool count by the new `bulwark-tools.ts` module (14 tools, Section 10).
- **Runtime-dependency posture:** `/readyz` checks only Postgres + Redis. Bin byte reads, the llm-provider, bolt-api publish, and the dispatch transport use bounded timeouts + typed `UPSTREAM_UNAVAILABLE`; the workers retry with backoff and DLQ; the radar source-diff is the durable firing fallback.

---

## 10. MCP surface

New `apps/mcp-server/src/tools/bulwark-tools.ts` via `registerTool` (`apps/mcp-server/src/lib/register-tool.ts`), HTTP client shaped like `apps/mcp-server/src/tools/dedupe-tools.ts:38`. Env `BULWARK_API_URL=http://bulwark-api:4021/v1`. Read tools that surface source records require an explicit `asker_user_id` (per `docs/reference/agent-conventions.md`), fail-closed via `can_access`; destructive tools use the Redis confirm-token store. Following the basis/braid satellite pattern, `bulwark_*` tools are intentionally NOT added to `EXPLICIT_TOOL_OVERRIDES`; per-action resolver mapping is deferred and REST `requireCan` + the kill-switch + the confirm token are the enforcing layers.

| Tool | Backs | Permission | confirm_action |
| --- | --- | --- | --- |
| `bulwark_extract_obligations` (flagship) | POST `/v1/contracts` (register-if-new) + POST `/v1/contracts/:id/extract` | `bulwark.contract.write` | no |
| `bulwark_check_notice_risk` (flagship) | GET `/v1/deadlines` + `/v1/waiver-risks` for a job | `bulwark.deadline.read`, `asker_user_id` | no |
| `bulwark_list_contracts` | GET `/v1/contracts` | `bulwark.contract.read` | no |
| `bulwark_get_contract` | GET `/v1/contracts/:id` (embeds obligations + deadline rollup) | `bulwark.contract.read`, `asker_user_id` | no |
| `bulwark_delete_contract` | DELETE `/v1/contracts/:id` | `bulwark.contract.delete` | **yes** (Redis token) |
| `bulwark_list_obligations` | GET `/v1/obligations` | `bulwark.obligation.read` | no |
| `bulwark_get_obligation` | GET `/v1/obligations/:id` | `bulwark.obligation.read`, `asker_user_id` | no |
| `bulwark_confirm_obligation` | PATCH `/v1/obligations/:id` (confirm/edit/bind) | `bulwark.obligation.write` | no |
| `bulwark_reject_obligation` | PATCH `/v1/obligations/:id` (`review_status='rejected'`) | `bulwark.obligation.write` | **yes** (Redis token) |
| `bulwark_list_deadlines` | GET `/v1/deadlines` | `bulwark.deadline.read` | no |
| `bulwark_draft_notice` | POST `/v1/deadlines/:id/draft-notice` (inserts a proposal) | `bulwark.notice.draft` | no (the proposal is the HITL) |
| `bulwark_waive_deadline` | POST `/v1/deadlines/:id/discharge` (waive) | `bulwark.deadline.read`+write | **yes** (Redis token) |
| `bulwark_list_compliance` | GET `/v1/compliance-docs` | `bulwark.compliance.read` | no |
| `bulwark_chase_compliance` | POST `/v1/compliance-docs/:id/chase` (inserts a proposal) | `bulwark.compliance.chase` | no (the proposal is the HITL) |

14 tools. `bulwark_get_contract` embeds obligations and the deadline rollup, so `/v1/contracts/:id/obligations` is annotated `resolver-done-internally` in the surface map. The genuine no-tool endpoints are `PATCH /settings` and `GET /settings` (surfaced via the SPA; a `bulwark_get_settings`/`bulwark_set_settings` pair MAY be added if agents need to tune thresholds, keeping 11 permission rows either way), `POST /v1/internal/events`, `/bulwark/ws`, `/health`, `/readyz`, and the two `approve-send` routes (intentionally UI-only send surfaces; the MCP send path is the proposal approve, not a direct tool). **agent_policies:** every `bulwark_*` service-account call fails closed until an operator allowlists `bulwark.*`.

**The 11 hand-authored permission rows** (Section 3.4 step 3b), each with explicit `app:'bulwark'` and `is_read`:
- `bulwark.contract.read` (`is_read:true`)
- `bulwark.contract.write` (`is_read:false`)
- `bulwark.contract.delete` (`is_read:false, is_destructive:true, requires_confirmation:true`)
- `bulwark.obligation.read` (`is_read:true`)
- `bulwark.obligation.write` (`is_read:false`; the reject path carries the confirm at the tool layer, not a separate permission, keeping the row count at 11 as Braid kept reject under merge)
- `bulwark.deadline.read` (`is_read:true`)
- `bulwark.notice.draft` (`is_read:false`)
- `bulwark.compliance.read` (`is_read:true`)
- `bulwark.compliance.chase` (`is_read:false`)
- `bulwark.settings.read` (`is_read:true`)
- `bulwark.settings.write` (`is_read:false`)

**Surface-map update:** `docs/reference/mcp-endpoint-mapping.md` MUST be updated in the same change. Every REST row's MCP column is a backtick tool name or the sanctioned em-dash skip-cell form the other apps use; that table is the one place em dashes are correct (the CLAUDE.md self-check grep depends on it), so this spec keeps its prose em-dash-free while the surface-map cells follow the existing convention. Keep the coverage counts and the zero-bare-dash grep green.

---

## 11. Reuse ledger

| Capability | Reuses (real file/package) | New in Bulwark |
| --- | --- | --- |
| App scaffolding (Fastify server, plugins, health, RLS GUC) | `apps/basis-api/src/server.ts` (`@bigbluebam/service-health:8`), `apps/basis-api/src/plugins/rls.ts`, `apps/braid-api/` layout, `apps/bin-api/src/db/schema/bbb-refs.ts` | `bulwark-api` at port 4021 |
| Executed document + collected compliance-doc bytes | `apps/bin-api` `bin_assets` (`0205_bin_dam.sql`), `@bigbluebam/storage` `getStream` | `bulwark.contract -> bin.asset` reference, extraction over the bytes |
| Clause understanding (best-effort, internal only) | internal llm-provider `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`), `llm_providers` | chunk + typed-obligation extraction with cited spans + confidence |
| Event bus + the ingest-dispatch transport | `publishBoltEvent` (`packages/shared/src/bolt-events.ts:35`), `apps/bolt-api/src/services/braid-dispatch-hook.ts` + `event-ingestion.routes.ts:165` | data-driven `event_binding`, a parallel `bulwark-dispatch-hook.ts`, dynamic binding gate (Section 6) |
| HITL approval inbox + fire-and-forget decided event | `agent_proposals` (`0128_agent_proposals.sql`), `apps/api/src/routes/proposals.routes.ts:275,328` | direct null-approver insert for notice/chase drafts + a single kill-switch-safe send executor |
| Confirm-action gating on destructive tools | `apps/mcp-server/src/lib/confirm-token-store.ts` | delete-contract / reject-obligation / waive-deadline tokens |
| Counterparty / vendor identity | `apps/bond-api` companies, `entity_links` (`0132_entity_links.sql`), `braid_resolve` (`apps/braid-api`, Braid Section 2.4) | `bulwark.contract -> bond.company` links, optional Braid golden-id resolution |
| Money terms (payment / retention) | `apps/bill-api` events | payment/retention obligations bound to Bill events |
| Date surface | `apps/book-api` | calendar-derived renewal/termination deadlines |
| Autonomous compliance-chase email | `apps/blast-api` (send executed on approve) | COI/W-9/lien-waiver/certified-payroll chase drafts |
| Vendor document collection forms | `apps/blank-api` | Blank form link in the chase draft |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts`, `can_access` | `asker_user_id` preflight on every read that surfaces a source record |
| Bolt events (positional signature) + drift guard | `publishBoltEvent`, `apps/bolt-api/src/services/event-catalog.ts`, `scripts/check-bolt-catalog.mjs` | 6 `bulwark` event definitions |
| Org scoping + RLS posture | `app.current_org_id` GUC (`0116_*`), `apps/api/src/boot/rls-boot.ts`, `apps/basis-api/src/plugins/rls.ts`, `BBB_RLS_ENFORCE` | Bulwark table policies + app-level org-scoping tests |
| Permissions (hand-authored satellite pattern) | `scripts/generate-permission-manifest.mjs` (basis/braid branches), `check-permission-catalog.mjs`, `build-permission-delta.mjs`, `0233_braid_builtin_group_defaults.sql` | 11 `bulwark.*` rows + built-in-group defaults migration |
| MCP registration + policy gate | `apps/mcp-server/src/lib/register-tool.ts` (incl. `/v1/agent-policies/:id/check`), `dedupe-tools.ts` client | 14 `bulwark_*` handlers |
| Worker fan-out + retry/backoff + DLQ + capture-the-version outbox | `banter-feed-fanin`, `basis-metric-snapshot.job.ts`, `bond-stale-deals.job.ts:127-138`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts`, `basis-retention-sweep.job.ts` | extraction / fire-on-event / radar / chase / retention jobs |
| Launchpad + nginx (2 sources, generated railway) + frontend Dockerfile + services.mjs | braid/basis wiring (cited), `scripts/gen-railway-configs.mjs`, `packages/ui/launchpad.tsx` | one new app id `bulwark`, `shield-check` icon |
| Suite-wide UI shell + Bureau widget + test stubs | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/db-stubs` | Bulwark SPA pages only |

---

## 12. Open questions & risks (human decision needed)

1. **`bolt-api` dispatch gate for dynamic bindings (Section 6).** Bulwark's bound `(source, event_type)` pairs are data, not a fixed map, so the new `bulwark-dispatch-hook.ts` needs a gate: a Redis binding set Bulwark maintains (option a) or a cached `GET /v1/internal/bindings` (option b). Decide at build. Soft dependency: the radar source-diff (Section 4.3) is the durable fallback, so a lost dispatch degrades to at-most-15-minutes-late arming. Owner: Bolt maintainers + Bulwark.
2. **Persisted Bolt-event table for the radar source-diff (Section 4.3).** The fallback reads the persisted Bolt event log filtered to bound `(source, event_type)` since a per-org watermark. Confirm the table name (the Braid precedent references `bolt_recent_events`) and that it carries `occurred_at` + payload at the fidelity the firing filter needs. If it does not persist enough, the live dispatch becomes a hard dependency for those bindings.
3. **Source-app event coverage (Section 7.2).** The beachhead bindings assume Bill pay-app/retention events and Book deadline events exist in `event-catalog.ts` at the needed granularity. Some may not yet be published (the braid-dispatch-hook TODO shows bond.company/bill.client/book.event_attendee upsert events are not all wired). Where a needed trigger event does not exist, that obligation is `unbound` and surfaces in review until the source app publishes it, or is driven off a coarser event. Gates the breadth of what Bulwark can watch autonomously.
4. **Scanned / image-only contracts (Section 4.1).** Extraction assumes a PDF text layer. Scanned executed contracts need OCR, which is out of v1 scope; such contracts extract to zero obligations and must be flagged for manual entry. Decide whether to add an OCR step (a worker dependency) or defer.
5. **Extraction accuracy is best-effort and legally consequential.** A missed or mis-typed obligation could waive a real claim, the exact harm Bulwark exists to prevent. Mitigations: the human-review queue (nothing arms unreviewed below the auto-confirm floor), the cited-span evidence (every obligation shows its clause quote + page/section for verification), and a disclaimer that Bulwark assists but does not replace counsel. The `auto_confirm_threshold` default (0.95) is deliberately conservative. Human decision: the acceptable auto-confirm floor and whether any obligation type must always be human-reviewed.
6. **Notice-draft quality.** The drafted notice is a second best-effort llm-provider call; a bad draft that a human approves without reading could itself create exposure. The HITL approve is the control, but consider requiring an explicit "I have read this" confirmation on high-severity notice sends.
7. **`search_everything` provider (Section 7.3).** Deferred from v1 to keep scope tight; a fast-follow. Braid shipped its provider in v1, so this is a scope choice, not a platform gap.
8. **No human-provided secret required.** All dependencies are internal and already in the stack (Bin, Bolt, the internal llm-provider, agent_proposals, Blast, Blank, Bond, optionally Braid). No third-party API key, no external endpoint. The only new env are internal service URLs and the reused `INTERNAL_SERVICE_SECRET`.

---

## Changelog

_Round 0 (initial draft). No adversarial findings folded yet. Subsequent rounds will record each finding's disposition (accept / accept-with-modification / reject-with-reason) here, per the revision protocol._
