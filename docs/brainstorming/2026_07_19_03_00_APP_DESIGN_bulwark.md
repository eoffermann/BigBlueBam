# Bulwark - App Design Specification

> An agent that reads the agreements an organization has signed and then spends the whole engagement making sure it does not breach them.
>
> Status: design draft, hardened through adversarial review round 1. New app. Winner of the 2026-07-19 03:00 suite-brainstorm session.
> Chosen internal port: **4021** (next free port after Braid's 4020; 4019 is basis, 4020 is braid).
> Routes: SPA at `/bulwark/`, REST at `/bulwark/api/`, realtime at `/bulwark/ws`.
> Chosen final name: **Bulwark** (single word). App id `bulwark`.

Freshest build precedent cited throughout: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (the Braid spec) and the **just-shipped Braid app** (`apps/braid-api/`, `apps/worker/src/jobs/braid-*.job.ts`, `apps/bolt-api/src/services/braid-dispatch-hook.ts`, `0233_braid_builtin_group_defaults.sql`). Bulwark reuses Braid's HITL-via-`agent_proposals`, Bolt-dispatch-transport, hand-authored-permissions, built-in-group-defaults, and proposal-reconcile patterns.

House style: no em dashes or en dashes in this document; no Co-Authored-By footer.

---

## 1. Overview & positioning

**One-liner.** Bulwark extracts a typed, clause-cited **obligation ledger** from an organization's executed contracts, **binds each obligation to a Bolt event pattern (plus a manual-trigger affordance)**, and fires against reality as it is logged rather than against a static calendar. A delay recorded on a job starts the five-day notice clock that the subcontract actually requires, Bulwark drafts the notice that discharges it, and every outbound act lands in the existing `agent_proposals` queue for a human to approve. Nothing is ever sent unattended.

**The wedge (why it won).** Small contractors waive real claims constantly by missing a 5-day notice clause nobody re-reads after signing. Contract review today is a lawyer at $400/hr, once, at signing, and then never again. Bulwark moves the axis from "one-time review" to **continuous obligation monitoring tied to logged job events, backstopped by a manual trigger** for the obligations whose real-world trigger is not (yet) digitized. Bulwark is explicit that it fires only on events that reach it: an obligation whose trigger is never logged and never manually fired does not arm, so the human-review queue and the manual-trigger tool (Section 4.2 / 5.1 / D8) are the safety net, not a silent gap. The suite already holds every input: the executed document is a **Bin** asset, the counterparty is in **Bond**, the money terms live in **Bill**, the deadlines surface in **Book**, and reality streams through **Bolt**.

**Who it is for.** The owner/PM/contract-admin persona at a 2-50 seat contractor, and structurally identical buyers in any obligation-bearing engagement (SOWs, MSAs, grant awards, commercial leases). Construction is the beachhead; the object model is horizontal.

**How it differs from the three apps it is most often confused with:**
- **Bin** (`apps/bin-api/`, `@bigbluebam/storage`) *stores the document bytes*. Bulwark references a `bin.asset`, reads its bytes once for extraction (after a `can_access` preflight, Section 4.1 / S3), and never becomes a second DAM.
- **Bolt** (`apps/bolt-api/`) *routes events and runs rule automations*. Bulwark is a *consumer* of the Bolt stream whose bindings are data per contract, whose reactions are legally-typed, and which durably persists every event it receives into its own inbox (Section 3.1, THEME D) because bolt-api itself persists only matching-automation executions.
- **Bill** (`apps/bill-api/`) *invoices and tracks money*. Bulwark reads payment/retention terms as obligations and watches Bill events; it never issues an invoice.

**v1 scope.** Objects: `contract` (including `amendment`), `obligation`, `notice_deadline`, `waiver_risk`, `compliance_doc`, `vendor_tier`, `ingest_event` (the durable event inbox), plus `bulwark_org_settings` and `bulwark_extraction_runs`. Surfaces: the obligation ledger per job, the deadline radar, the drafted-notice review queue, and the vendor compliance matrix. Flagship MCP tools: `bulwark_extract_obligations(contract_asset_id)` and `bulwark_check_notice_risk(job_id)`.

**The live event path is load-bearing, not optional (THEME D).** An earlier draft called the dispatch transport a "soft dependency" backed by a source-diff of persisted Bolt events. That backing data does not exist: bolt-api persists only `bolt_executions` (one row per matching automation), so an obligation bound to `bam:task.overdue` produces no persisted row unless the org also runs a Bolt automation on that event. Bulwark therefore makes the transport durable at the receiving end: `POST /v1/internal/events` persists every received event into `bulwark_ingest_events` and the firing job drains that inbox. Dispatch is the only firing path; it is durable once received; a lost enqueue is recovered by re-draining pending inbox rows.

**Out of v1 scope:** authoring/e-signature/redline, OCR of scanned contracts (image-only PDFs extract to zero obligations and are flagged for manual entry, Section 12), a `search_everything` provider (fast-follow), and any autonomous send. Legal-advice disclaimer: extraction is best-effort and always human-reviewable.

---

## 2. AI-native design

Bulwark's AI core is **best-effort clause extraction plus deterministic, timezone-anchored, event-bound firing, with human-in-the-loop review at two boundaries**: every obligation whose firing produces an outbound act is human-reviewed before it can arm a clock, and every outbound act is an `agent_proposals` row a human approves. The LLM understands contract language; it never sends anything, never chooses a recipient or an attachment, and never computes a due date.

### 2.1 The two-plane split (borrowed from Basis / Braid)

1. **LLM extraction (best-effort, always reviewable).** The internal llm-provider reads chunked contract text and proposes typed obligations with a cited span (whose offsets are then **verified against the source bytes**, Section 4.1 / D7) and a self-reported confidence. This output is never live truth.
2. **Deterministic firing (reproducible, auditable, timezone-anchored).** Once an obligation is `confirmed` and bound, firing is pure arithmetic over a typed `deadline_rule` that carries an IANA timezone, an optional jurisdiction/holiday calendar, and a roll-forward flag (Section 3.3, THEME B). The recipient and attachments of any drafted notice are **deterministic** (Section 2.4, THEME E), never model output.

**Invariant.** A `bulwark_notice_deadline` is a pure function of `(obligation.deadline_rule, the legal anchor time, the resolved timezone)`. It is created at-most-once per `(obligation_id, triggering_event_id)`, and the durable inbox (`bulwark_ingest_events`) deduplicates a redelivered Bolt event by `(org, bolt_event_id)` independently of deadline retention, so a purge of an old discharged deadline can never resurrect a clock (Section 3.1, ST4).

### 2.2 Autonomy bands

| Action | Autonomy | Gate |
| --- | --- | --- |
| Extract obligations from a contract asset | Autonomous (worker), best-effort | `bulwark-extract-obligations`; Bin `can_access` preflight first (S3) |
| Confirm / edit / reject an extracted obligation | HITL, permission-gated | `bulwark.obligation.write`; reject is destructive (confirm token) |
| Arm a clock when a bound event fires | Autonomous (deterministic) but only for obligations cleared to arm (see D5 below) | firing job; at-most-once |
| **Manually trigger** an obligation ("this happened, start the clock") | HITL, permission-gated | `bulwark.deadline.write`; the safety net for non-digitized triggers (D8) |
| Flag a waiver risk | Autonomous | radar sweep |
| **Draft** a notice / a compliance chase | Autonomous draft, **HITL to send** | inserted into `agent_proposals`; recipient + attachments deterministic (THEME E) |
| Mark a deadline discharged / waived | HITL, permission-gated | `bulwark.deadline.write`; waive is destructive (confirm token) |
| Delete a tracked contract | HITL, destructive | `bulwark.contract.delete` (Redis confirm token) |
| Edit org settings | Permission-gated | `bulwark.settings.write` |

**Auto-arm is gated on a deterministic signal, not on model confidence (D5).** A high self-reported confidence is uncalibrated and forgeable, so it may only mark an obligation `auto_confirmed` for **display in the ledger**. It may NOT flip `is_armed` for any obligation whose firing produces an outbound proposal (types `notice`, `indemnity`, `payment`, `compliance`). Those types always require an explicit human confirmation before `is_armed` becomes true. For the remaining, non-outbound-producing types, auto-arm is permitted only when a **deterministic** signal holds: the `deadline_rule` parser agreed with the model AND a real `(source, event_type)` mapped AND the cited-span offsets verified. `auto_draft_notices` defaults to **false**.

**The HITL boundary is the `agent_proposals` queue (Braid Section 2.2).** Bulwark never calls Blast/Blank to send directly from the drafting path. It inserts an `agent_proposals` row and the `proposal.decided` subscription executes the send only on `approve`. Direct insert (not the public `POST /v1/proposals`, which mandates `approver_id`, `proposals.routes.ts:40`): `approver_id=NULL` (nullable, `0128_agent_proposals.sql:37`), explicit `expires_at = now() + 7 days` (`:41`), `subject_type='bulwark.notice_draft'` / `'bulwark.compliance_chase'`, `subject_id` = the bulwark row id. After insert Bulwark emits `publishBoltEvent('proposal.created', 'platform', ...)` mirroring the route (`proposals.routes.ts:114-134`). Those subject types are intentionally not `can_access`-resolvable (Braid D3-4); the inbox renders them through the permission-gated Bulwark read routes.

### 2.3 What it retrieves / reasons over

- **Extraction:** the contract text from the Bin asset bytes (org-scoped worker context), chunked, plus the org's obligation taxonomy.
- **Firing:** the armed obligations for a job and the durably-inboxed event, matched by `(source, event_type)` and by the binding's `entity_filter` evaluated over the scoping fields carried in the inbox row (Section 3.1 / S5).
- **Compliance:** the vendor tier's `required_doc_types` (seeded from confirmed `flow_down` obligations, Section 4.4 / D4), the collected docs, and the chase cadence.

### 2.4 The single canonical send path, deterministic and kill-switch-safe

One send executor per outbound type, reached two ways (Braid Section 5.4): the REST "approve and send" route calls it directly; a **`proposal.decided` subscription** branches on `decision` (platform contract `approve|reject|request_revision`, `proposals.routes.ts:52-63`), reverse-looks-up the draft via `proposed_payload.bulwark_draft_id`, **re-SELECTs `agent_proposals.status`** to confirm `approved`, resolves the decider, fail-closes that decider through `POST /v1/agent-policies/<decider_id>/check?tool=<send_tool>` (`register-tool.ts`, non-2xx fails closed) AND asserts the decider holds the send permission.

**Deterministic recipient and attachments (THEME E, BLOCKER).** The drafting LLM produces ONLY `subject` and `body_markdown`. Every control field is deterministic and computed by Bulwark, never by the model:
- `recipient_id` is always `contract.counterparty_id` (or its Braid-resolved golden id, Section 7.4). A recipient named in clause text is ignored.
- `attachments` is a deterministic allowlist: the source contract asset only, or none. The model cannot add an attachment.
- On send, before attaching, Bulwark calls `preflightAccess(decider, 'bin.asset', attachment_id)` (`visibility.service.ts:1151`) so a decider who cannot see the asset does not exfiltrate it. Any attachment failing the preflight is dropped and the send is annotated.

This closes the prompt-injection exfiltration channel: a malicious clause cannot steer the recipient or attach arbitrary Bin bytes.

Exactly-once on the send is a CAS on the draft row: `UPDATE bulwark_notice_deadlines SET notice_status='sent' WHERE id=$1 AND notice_status='approved' RETURNING id` (and the analogous `chase_status` CAS on compliance docs); the REST-vs-subscription echo no-ops harmlessly (Braid ST-r2-8).

### 2.5 Security model

1. **Reads are permission-tiered AND project-scoped (THEME A, BLOCKER).** `cited_span.quote` is verbatim clause text, `deadline_rule` encodes money/notice terms, `counterparty_id` names the sub. Unlike Braid, Bulwark does not re-derive fields per-viewer, so it defends the ledger two ways: (a) `bulwark.contract.read` and `bulwark.obligation.read` are tiered to **owner/admin only** in the built-in defaults (`0237`, Section 3.4 / S1) as the floor; (b) every ledger read route additionally scopes results to contracts whose `project_id` the caller is a member of (reusing the project-membership predicate behind `preflightBinAsset`, `visibility.service.ts:1151`) with an org-admin override. A member granted read through a custom operator group sees only their projects' contracts; the prose and the migration now agree (no "member gets everything" gap).
2. **Registration preflights the Bin asset (S3).** `POST /v1/contracts` and `/extract` call `preflightAccess(asker, 'bin.asset', bin_asset_id)` and reject `not_found` if denied, before enqueuing; the worker re-checks at byte-read time against `created_by` so a later ACL change is honored. A member who cannot open the contract in Bin cannot launder its clause text through the Bulwark ledger.
3. **`/internal/events` fails CLOSED on an empty secret (S4).** The receiving handler rejects 401 when `INTERNAL_SERVICE_SECRET` is empty/undefined BEFORE any timing-safe compare (mirroring `internal-llm.routes.ts:64`'s non-empty gate), because an empty-vs-empty compare authorizes an unauthenticated caller. The compose non-empty assertion is defense in depth, not the only guard.
4. **Extraction input isolation.** The extraction and drafting LLM calls use ONLY the internal llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint. Clause/event text is fenced as untrusted DATA in a delimited block (S8); the model is forbidden to emit control fields, and any it emits are dropped (THEME E). Responses are Zod-validated; malformed rows are dropped.
5. **No autonomous send.** The `agent_proposals` choke point plus the kill-switch re-check on the decider (Section 2.4) means a compromised agent can at worst fill the inbox.
6. **Legally-required mail bypasses marketing suppression (D6).** A COI/W-9/lien-waiver/certified-payroll chase and a contract notice are transactional, not marketing. They do NOT route through the Blast suppression path (`blast-send.job.ts:330-401` filters `blast_unsubscribes`); they send via the platform's direct transactional path with a `transactional=true` flag on the send executor that skips `blast_unsubscribes`. The spec states plainly: compliance and notice sends do not honor marketing unsubscribes.
7. **Events are org-level refs only.** Bulwark's Bolt events (Section 7) carry ids and magnitudes, never clause text or PII. `bulwark.*` outbound-webhook subscriptions require org-admin authorship.
8. **Send permission is admin-tiered and the freeze is permission revocation (S7).** `bulwark.notice.draft` and `bulwark.compliance.chase` are tiered to owner/admin in `0237`. The `agent_policies` kill switch only freezes agent/service deciders (`register-tool.ts:205` bypasses humans, Braid S3-3); the human freeze control is revoking the send permission.
9. **Org scoping (RLS posture, Braid IN-r2-1).** Application-level org-scoping is the enforcing layer (every query carries `organization_id`, the pipeline sets `app.current_org_id` via the basis-style `plugins/rls.ts` Bulwark inherits); RLS policies on every `bulwark_*` table bind when the platform flips `BBB_RLS_ENFORCE=1`. Section 8 test is application-level, with an optional role-bound RLS test.

### 2.6 Guardrails summary

- **agent_policies**: every `bulwark.*` service-account call passes the kill-switch + `matchesAllowlist('bulwark.*')`; not in the always-permitted core, so fails closed until allowlisted. Re-run by the send subscription (Section 2.4).
- **Per-action MCP resolver:** deferred (basis/braid satellite pattern); `bulwark_*` not in `EXPLICIT_TOOL_OVERRIDES`; the `HAND_AUTHORED` loop is the sole creator of the rows.
- **confirm_action** (Redis dynamic-TTL, `confirm-token-store.ts`): `bulwark_delete_contract`, `bulwark_reject_obligation`, `bulwark_waive_deadline`.
- **Rate caps (S6):** auto-drafts are capped per org per sweep and by a per-org daily ceiling on notice-draft LLM calls; beyond the cap the risk is flagged and drafting deferred; work per tick is bounded by the sweep marker; `auto_draft_notices` is off by default.
- **can_access preflight** per requesting user on every read that surfaces a source record, on registration (S3), and on attachment at send (THEME E).

---

## 3. Data model

All Bulwark tables are org-scoped, carry `organization_id`, and have RLS policies gated on `app.current_org_id`, matching `0132_entity_links.sql:52-56` and `0116_rls_foundation.sql`. Each table gets a 1:1 Drizzle module under `apps/bulwark-api/src/db/schema/` (`bulwark-contracts.ts`, `bulwark-obligations.ts`, `bulwark-notice-deadlines.ts`, `bulwark-waiver-risks.ts`, `bulwark-compliance-docs.ts`, `bulwark-vendor-tiers.ts`, `bulwark-ingest-events.ts`, `bulwark-extraction-runs.ts`, `bulwark-org-settings.ts`, `bbb-refs.ts`, `index.ts`), mirroring `apps/bin-api/src/db/schema/`.

**Join boundary (Braid D8).** Bulwark uses `organization_id`; platform tables use `org_id`. No cross-schema FKs to source-app tables (Bin/Bond/Bill): those are dotted `source_type` + uuid, the `entity_links` convention.

### 3.1 Tables

**`bulwark_contracts`** - a contract (or amendment) Bulwark tracks.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `project_id` | uuid | FK `projects(id)` ON DELETE SET NULL; the "job". Required for event-bound obligations to be armable (D8); a null-job contract may hold only manual-trigger or calendar obligations |
| `title` | varchar(512) NOT NULL | |
| `contract_kind` | varchar(32) NOT NULL DEFAULT `'subcontract'` | `subcontract` \| `sow` \| `msa` \| `grant_award` \| `lease` \| `amendment` \| `other` |
| `supersedes_contract_id` | uuid | self-FK (guarded `DO $$`, like `0226_basis_core.sql`); set when `contract_kind='amendment'`; the base it amends |
| `timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA zone for this contract's deadline arithmetic (THEME B); defaulted from `bulwark_org_settings.default_timezone` at create |
| `jurisdiction` | varchar(32) | optional legal jurisdiction, drives holiday calendar selection |
| `bin_asset_id` | uuid NOT NULL | the executed document, a `bin.asset` id (no cross-schema FK) |
| `counterparty_type` | varchar(32) | typically `bond.company` |
| `counterparty_id` | uuid | the counterparty; the deterministic notice recipient (THEME E) |
| `effective_date` | date | |
| `expiry_date` | date | |
| `status` | varchar(16) NOT NULL DEFAULT `'active'` | `draft` \| `extracting` \| `active` \| `amended` \| `expired` \| `terminated` |
| `extraction_status` | varchar(16) NOT NULL DEFAULT `'pending'` | `pending` \| `running` \| `extracted` \| `partial` \| `failed` |
| `extracted_at` | timestamptz | |
| `source_doc_hash` | varchar(64) | sha-256 of extracted bytes; skip re-extraction only when unchanged AND the last run succeeded (ST6) |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | service-bumped, no auto trigger |

Indexes: `(organization_id, status)`, `(organization_id, project_id)`, `(organization_id, bin_asset_id)`, `(organization_id, expiry_date)`, `(supersedes_contract_id)`.

**`bulwark_obligations`** - one typed, clause-cited obligation.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid NOT NULL | FK `bulwark_contracts(id)` ON DELETE CASCADE |
| `clause_ref` | varchar(64) | the stable upsert key component, from `cited_span.section` (e.g. `"12.3"`); the re-extraction / amendment idempotency anchor (THEME C / ST6) |
| `obligation_type` | varchar(32) NOT NULL | `notice` \| `insurance` \| `indemnity` \| `payment` \| `retention` \| `flow_down` \| `renewal` \| `termination` \| `lien` \| `other` |
| `title` | varchar(512) NOT NULL | |
| `trigger_description` | text | |
| `event_binding` | jsonb NOT NULL DEFAULT `'{}'` | `(source, event_type)` + entity_filter (Section 3.3) |
| `deadline_rule` | jsonb NOT NULL DEFAULT `'{}'` | timezone-anchored rule (Section 3.3, THEME B) |
| `mandated_doc_types` | jsonb NOT NULL DEFAULT `'[]'` | for `flow_down`: the compliance doc types this clause requires of lower tiers (D4); empty for other types |
| `cited_span` | jsonb NOT NULL DEFAULT `'{}'` | verified evidence `{ page, section, quote, char_start, char_end, chunk_index, verified }` (Section 3.3, D7) |
| `confidence` | numeric(5,2) | LLM self-reported; drives display auto-confirm only, never auto-arm for outbound types (D5) |
| `review_status` | varchar(16) NOT NULL DEFAULT `'pending_review'` | `pending_review` \| `confirmed` \| `auto_confirmed` \| `rejected` \| `superseded` (terminal, set on re-extraction/amendment, never deleted, THEME C) |
| `is_armed` | boolean NOT NULL DEFAULT false | true only when confirmed/cleared per D5 AND binding complete AND (for event-bound) the contract has a `project_id` |
| `reviewed_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `reviewed_at` | timestamptz | |
| `extraction_run_id` | uuid | FK `bulwark_extraction_runs(id)` ON DELETE SET NULL |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, contract_id, clause_ref) WHERE clause_ref IS NOT NULL` (the stable upsert key), `(organization_id, contract_id)`, `(organization_id, review_status)`, `(organization_id, obligation_type)`, `(organization_id, is_armed) WHERE is_armed`, GIN on `event_binding`.

**`bulwark_ingest_events`** - the durable event inbox (THEME D, BLOCKER). Every event bolt-api dispatches is persisted here before firing, so the transport is durable once received and the firing job is an inbox drain.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `bolt_event_id` | uuid NOT NULL | the source Bolt event id; the redelivery dedup atom |
| `source` | varchar(48) NOT NULL | |
| `event_type` | varchar(96) NOT NULL | |
| `logged_at` | timestamptz NOT NULL | transport/log time (when Bolt saw it) |
| `trigger_at` | timestamptz | the legal trigger time extracted from the payload if present, else null (THEME B) |
| `scope_fields` | jsonb NOT NULL DEFAULT `'{}'` | the entity_filter-referenced non-PII scoping ids extracted at dispatch (e.g. `{ "task.project_id": "..." }`), so firing can evaluate the filter without raw payload (S5) |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `processed` \| `skipped` |
| `received_at` | timestamptz NOT NULL DEFAULT now() | |
| `processed_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, bolt_event_id)` (redelivery dedup independent of deadline retention, ST4), `(organization_id, status, received_at)` (the drain scan), `(source, event_type)`. Retention keeps rows past the drain watermark horizon (Section 4.5).

**`bulwark_notice_deadlines`** - a live deadline instance.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK `bulwark_obligations(id)` **ON DELETE RESTRICT** (THEME C: re-extraction can never drop an obligation with a live clock; it supersedes instead) |
| `contract_id` | uuid NOT NULL | FK `bulwark_contracts(id)` ON DELETE CASCADE (a deliberate whole-contract delete, confirm-token-gated, does remove its deadlines) |
| `ingest_event_id` | uuid | FK `bulwark_ingest_events(id)` ON DELETE SET NULL; the inbox row that armed this |
| `triggering_event_id` | uuid NOT NULL | the dedup key: the `bolt_event_id` for event-armed; for calendar-armed, a deterministic `uuid5(obligation_id || anchor_date)` so recurrence works and the single unique index dedups (ST7) |
| `anchor_source` | varchar(12) NOT NULL | `trigger_at` \| `logged_at` \| `manual` \| `calendar`; which time seeded the clock (THEME B, surfaced for reviewer correction) |
| `triggered_at` | timestamptz NOT NULL | the legal anchor time actually used |
| `logged_at` | timestamptz | the transport time, kept alongside so a reviewer sees the gap between real and logged |
| `resolved_timezone` | varchar(64) NOT NULL | the IANA zone the due date was computed in (from `deadline_rule`/contract) |
| `due_at` | timestamptz NOT NULL | deterministic, computed in `resolved_timezone` with roll-forward (Section 4.2) |
| `status` | varchar(16) NOT NULL DEFAULT `'open'` | `open` \| `discharged` \| `missed` \| `waived` |
| `notice_status` | varchar(16) NOT NULL DEFAULT `'none'` | `none` \| `drafted` \| `approved` \| `sent` \| `discarded` |
| `notice_proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL |
| `notice_draft` | jsonb NOT NULL DEFAULT `'{}'` | ONLY `subject` + `body_markdown` from the LLM; `recipient_id`/`attachments` are deterministic and stamped by Bulwark at send (THEME E) |
| `discharged_at` | timestamptz | |
| `radar_marker` | timestamptz | outbox marker: observed sweep time (never `now()` mid-compute, Braid ST3-1) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, obligation_id, triggering_event_id)` (the single at-most-once arm guard, covering both event and calendar cases; the contradictory second partial index of the prior draft is dropped, ST7), `(organization_id, status, due_at)` (radar scan), `(organization_id, contract_id)`, `(notice_proposal_id)`, `(organization_id, notice_status)`.

**`bulwark_waiver_risks`** - a flagged risk.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK ON DELETE RESTRICT (audit protection, D3) |
| `deadline_id` | uuid | FK `bulwark_notice_deadlines(id)` ON DELETE SET NULL (never cascade-delete a risk when a deadline is archived; the risk is the dispute record, D3) |
| `contract_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `severity` | varchar(8) NOT NULL | `low` \| `medium` \| `high` \| `critical` |
| `reason` | varchar(32) NOT NULL | `clock_running_out` \| `overdue` \| `unbound_obligation` \| `missing_compliance_doc` |
| `detail` | jsonb NOT NULL DEFAULT `'{}'` | hours remaining, exposure ref |
| `status` | varchar(12) NOT NULL DEFAULT `'open'` | `open` \| `resolved` \| `dismissed` |
| `detected_at` / `resolved_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, obligation_id, deadline_id, reason)` (idempotent re-detection), `(organization_id, status, severity)`, `(organization_id, contract_id)`.

**`bulwark_vendor_tiers`** - a lower-tier vendor in the compliance chain.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid | parent contract; FK ON DELETE SET NULL |
| `parent_tier_id` | uuid | self-FK (guarded `DO $$`) ON DELETE SET NULL; the tier this one flows down from (D4 cascade) |
| `vendor_type` | varchar(32) | typically `bond.company` |
| `vendor_id` | uuid | |
| `tier_level` | smallint NOT NULL DEFAULT 1 | 1 = direct sub, 2+ = sub-sub |
| `required_doc_types` | jsonb NOT NULL DEFAULT `'[]'` | seeded/updated from confirmed `flow_down` obligations of `contract_id` UNION `parent_tier_id.required_doc_types` (D4) |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'idle'` | `idle` \| `chasing` \| `compliant` \| `blocked` (rolled up from docs) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, contract_id)`, `(organization_id, chase_status)`, `(parent_tier_id)`, `UNIQUE (organization_id, contract_id, vendor_type, vendor_id)`.

**`bulwark_compliance_docs`** - one required/collected doc. Validity and collection lifecycle are separated (D9).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `vendor_tier_id` | uuid NOT NULL | FK `bulwark_vendor_tiers(id)` ON DELETE CASCADE |
| `doc_type` | varchar(24) NOT NULL | `coi` \| `w9` \| `lien_waiver` \| `certified_payroll` \| `other` |
| `collection_status` | varchar(16) NOT NULL DEFAULT `'missing'` | collection lifecycle: `missing` \| `requested` \| `collected` (D9) |
| `validity_status` | varchar(12) NOT NULL DEFAULT `'unknown'` | validity: `unknown` \| `valid` \| `expiring` \| `expired` (D9) |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'none'` | send lifecycle: `none` \| `drafted` \| `approved` \| `sent` \| `escalated` |
| `bin_asset_id` | uuid | the collected doc (no cross-schema FK) |
| `effective_date` / `expires_at` | date | drives the expiry sweep |
| `chase_proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL |
| `blank_form_id` | uuid | optional Blank form |
| `last_chased_at` | timestamptz | cadence throttle |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, vendor_tier_id)`, `(organization_id, validity_status)`, `(organization_id, collection_status)`, `(organization_id, expires_at)`, `(organization_id, doc_type)`, `(chase_proposal_id)`.

**`bulwark_extraction_runs`** - audit + chunk checkpoint (ST6).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `contract_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `status` | varchar(16) NOT NULL DEFAULT `'running'` | `running` \| `succeeded` \| `partial` \| `failed` |
| `chunk_count` | integer | |
| `last_processed_chunk` | integer NOT NULL DEFAULT -1 | the checkpoint: a retry resumes at `last_processed_chunk + 1` (ST6) |
| `source_doc_hash` | varchar(64) | the hash this run processed |
| `obligations_extracted` | integer NOT NULL DEFAULT 0 | |
| `low_confidence_count` | integer NOT NULL DEFAULT 0 | |
| `provider_id` | uuid | |
| `error` | text | |
| `started_at` | timestamptz NOT NULL DEFAULT now() | |
| `finished_at` | timestamptz | |

Indexes: `(organization_id, contract_id, started_at DESC)`, `(status)`. Never purged (audit).

**`bulwark_org_settings`** - per-org tunables (modeled on `basis_org_settings`, `0226_basis_core.sql`). One row per org.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE; `UNIQUE` |
| `default_timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA; contracts default their `timezone` from this (THEME B) |
| `auto_confirm_threshold` | numeric(5,2) NOT NULL DEFAULT 0.95 | display-only auto-confirm floor; never gates auto-arm for outbound types (D5) |
| `radar_lead_times` | jsonb NOT NULL DEFAULT `'{"critical_hours":24,"high_hours":72,"medium_hours":168}'` | |
| `auto_draft_notices` | boolean NOT NULL DEFAULT **false** | off by default (D5); when on, still capped per S6 |
| `auto_draft_max_per_sweep` | integer NOT NULL DEFAULT 20 | S6 cap per org per sweep |
| `notice_llm_daily_cap` | integer NOT NULL DEFAULT 100 | S6 per-org daily ceiling on drafting LLM calls |
| `chase_cadence_days` | integer NOT NULL DEFAULT 7 | |
| `coi_expiry_lead_days` | integer NOT NULL DEFAULT 30 | |
| `llm_provider_id` | uuid | extraction/drafting model; null falls back to org default |
| `last_radar_sweep_at` | timestamptz | advanced only after a fully successful sweep (Braid ST-r2-7) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**Partitioning posture (ST9).** `bulwark_notice_deadlines` and `bulwark_waiver_risks` are unpartitioned in v1. At the 2-50 seat SMB target their churn is low and retention is discharged-only (Section 4.5 / D3), so DELETE retention does not create meaningful bloat. Monthly partitioning (the `basis_metric_snapshots` / blip pattern) is a documented scale fast-follow, revisited if a large org's deadline volume warrants it.

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): `bulwark.contract -> bond.company`, `bulwark.contract -> bin.asset`, `bulwark.vendor_tier -> bond.company` (`ON CONFLICT DO NOTHING`).
- `agent_proposals` (`0128_agent_proposals.sql`): notice/chase drafts, `approver_id=NULL`, `expires_at` set.
- `organizations`, `users`, `projects`, `actor_type` enum.
- `bin_assets` (`0205_bin_dam.sql`): read-only, `can_access`-preflighted.
- `llm_providers`: extraction/drafting model, only via `POST /internal/llm/chat`.

### 3.3 JSONB shapes (authoritative)

```jsonc
// bulwark_obligations.event_binding
{
  "source": "bam",
  "event_type": "task.overdue",
  "entity_filter": {                      // when present, firing FAILS CLOSED if the field is absent (S5)
    "payload_path": "task.project_id",
    "equals_contract_field": "project_id"
  },
  "unbound": false
}

// bulwark_obligations.deadline_rule (THEME B: timezone-anchored, roll-forward aware)
{
  "offset_days": 5,
  "unit": "calendar_days",                // calendar_days | business_days
  "from": "trigger_event",                // trigger_event | contract_effective_date | contract_expiry_date
  "timezone": "America/Los_Angeles",      // IANA; default from contract.timezone / org default
  "jurisdiction": "US-CA",                // optional
  "holiday_calendar": "us-federal",       // optional; used when unit=business_days or roll_forward
  "roll_forward": true,                   // due lands on a weekend/holiday -> next business day
  "grace_hours": 0
}

// bulwark_obligations.cited_span (D7: offsets VERIFIED against source bytes; verified=false forces review)
{
  "page": 7,
  "section": "12.3",                      // becomes clause_ref, the stable upsert key
  "quote": "Subcontractor shall give written notice within five (5) days ...",
  "char_start": 18442,
  "char_end": 18571,
  "chunk_index": 3,
  "verified": true                        // source_text.slice(start,end) fuzzy-matched quote (tied to source_doc_hash)
}

// bulwark_notice_deadlines.notice_draft (THEME E: ONLY subject + body from the LLM)
{
  "subject": "Notice of Delay - [contract.title]",
  "body_markdown": "…generated by the drafting worker, untrusted text only…"
  // recipient_id and attachments are NOT here; they are deterministic and stamped by Bulwark at send
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed tip is `0233_braid_builtin_group_defaults.sql`; latest permissions delta is `0232_permissions_seed_actions_delta_021.sql`. Numbers provisional. Every file carries the header block and idempotent DDL.

1. **`0234_bulwark_core.sql`** - `bulwark_contracts` (incl. `supersedes_contract_id` self-FK via guarded `DO $$`, `timezone`, `jurisdiction`), `bulwark_obligations` (incl. `clause_ref` unique, `mandated_doc_types`, `superseded` status), `bulwark_ingest_events`, `bulwark_notice_deadlines` (obligation FK **ON DELETE RESTRICT**, contract FK CASCADE, single unique arm index), `bulwark_waiver_risks`, `bulwark_extraction_runs` (incl. `last_processed_chunk`), `bulwark_org_settings`, all indexes, RLS. Additive only.
2. **`0235_bulwark_compliance.sql`** - `bulwark_vendor_tiers` (incl. `parent_tier_id` self-FK), `bulwark_compliance_docs` (split `collection_status`/`validity_status`/`chase_status`), indexes, RLS. Additive only.
3. **`NNNN_permissions_seed_actions_delta_022.sql`** - **generated**. The `bulwark.*` rows are hand-authored (`bulwark_` not in `APP_PREFIXES`, like `basis_`/`braid_`). Strict sequence (THEME F, BLOCKER: the codegen step is the exact Braid gap and is now explicit):
   - (a) land `0234`/`0235` on disk;
   - (b) register the **12** `bulwark.*` rows (Section 10) in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs`, each with explicit `app:'bulwark'` and an explicit `is_read`;
   - (c) add an `if (c.id.startsWith('bulwark.')) { migrationLabel = '<this delta>'; sourceFile = 'bulwark route/tools'; }` provenance branch;
   - (d) do NOT add `bulwark_*` to `EXPLICIT_TOOL_OVERRIDES`;
   - (e) run `node scripts/generate-permission-manifest.mjs` (writes `docs/permissions-action-manifest.json`) **then `node scripts/build-permission-codegen.mjs`** (the only writer of `packages/permissions/src/generated/permissions.ts`, which the resolver + `useCan` consume) and **COMMIT the regenerated `permissions.ts`**;
   - (f) run `check-permission-catalog.mjs`, which re-runs codegen in a temp dir and diffs against the committed `permissions.ts`; it passes only because (e) committed it;
   - (g) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number/suffix. The emitted delta MUST contain only additive `bulwark.*` rows; strip any proposed removal/deactivation of unrelated rows before landing (BP4). Additive only.
4. **`0237_bulwark_builtin_group_defaults.sql`** - backfills `bulwark.*` into the built-in role matrix, modeled on `0233_braid_builtin_group_defaults.sql` but with a **custom tiering** (THEME A / S7): owner/admin get all `bulwark.*` (`NOT requires_superuser`); **member gets all EXCEPT `bulwark.contract.read`, `bulwark.obligation.read`, `bulwark.notice.draft`, `bulwark.compliance.chase`** (the sensitive reads and the send perms); viewer gets `is_read AND NOT requires_superuser` EXCEPT `bulwark.contract.read`/`bulwark.obligation.read`; guest none. `INSERT ... ON CONFLICT DO NOTHING`. Without it every non-SuperUser (including Owners) hits `implicit_deny` and the SPA 403s (the Braid gap). Additive only.

Bolt event registration (Section 7), the bolt-api dispatch-hook edit (Section 6), and any `SUPPORTED_ENTITY_TYPES` additions are TypeScript edits.

---

## 4. The engines

Both engines run as BullMQ workers in `apps/worker`, matching `braid-*.job.ts` / `basis-metric-snapshot.job.ts`.

### 4.1 Obligation-extraction engine

**Trigger.** `POST /v1/contracts` or `POST /contracts/:id/extract` enqueues `bulwark-extract-obligations { org_id, contract_id }`, AFTER the route has `can_access`-preflighted the Bin asset for the caller (S3).

**Pipeline:**
1. **Preflight + fetch.** The worker re-checks `preflightAccess(created_by, 'bin.asset', bin_asset_id)` (S3), then reads bytes via `@bigbluebam/storage` `getStream` (Section 9.2 commits the byte path). Extract text (PDF text layer; scanned docs yield zero obligations and are flagged, Section 12). Compute `source_doc_hash`.
2. **Hash-skip is conditional (ST6).** Skip only when `source_doc_hash` is unchanged AND the last `bulwark_extraction_runs.status='succeeded'`. A `partial`/`failed` prior run never skips; it resumes.
3. **Chunk + checkpoint.** Split into overlapping page/section-anchored chunks. A run persists `last_processed_chunk`; a retry resumes at the next chunk (ST6), so a chunk-3-of-10 failure does not permanently under-extract nor re-insert chunks 1-2. Per-chunk progress logged via `@bigbluebam/logging` (flushed; a multi-minute extraction must not sit silent).
4. **Extract per chunk.** Call `POST /internal/llm/chat` with the untrusted chunk fenced in a delimited DATA block (S8) and a system prompt fixing the taxonomy and demanding strict JSON. Parse and Zod-validate; drop malformed rows. Each obligation: `{ obligation_type, title, trigger_description, proposed_event_binding, deadline_rule, mandated_doc_types?, cited_span }`.
5. **Deterministic post-processing.**
   - **Verify the citation (D7):** check `source_text.slice(char_start, char_end)` fuzzy-matches `quote`. On mismatch, snap the offsets to the real location if findable and set `verified=true`; else mark `verified=false`, force `pending_review`. Verified offsets are stored and tied to `source_doc_hash` so the SPA highlights real bytes.
   - **Parse the deadline (THEME B):** parse the natural-language deadline into the typed `deadline_rule`, stamping `timezone` from the contract. If the parser and the model disagree, do not clear the deterministic-arm gate (D5).
   - **Map the trigger:** map to a real `(source, event_type)` from `event-catalog.ts` via a curated alias table; an unmapped trigger sets `event_binding.unbound=true`.
6. **Persist by stable key (THEME C / ST6).** Upsert `bulwark_obligations` on `(contract_id, clause_ref)`. Obligations present in a prior run but absent from this one transition to `review_status='superseded'` (never deleted). Rows clearing the D5 deterministic-arm gate for non-outbound types may `auto_confirmed`+`is_armed`; outbound types (`notice`/`indemnity`/`payment`/`compliance`) stay `pending_review` until a human confirms. Write the run audit; set `contract.extraction_status`. Emit `obligation.extracted` and, on completion, `contract.extracted`.

**Amendment / supersession (THEME C).** An amendment is a NEW Bin asset registered with `contract_kind='amendment'` and `supersedes_contract_id` set to the base. On its extraction, in ONE transaction: the base contract flips to `status='amended'`; base obligations whose `clause_ref` reappears in the amendment transition to `superseded` and their **open deadlines are re-pointed** to the superseding obligation (same `clause_ref`); base obligations with no successor keep their obligations and open deadlines intact. No open deadline is ever dropped, which is why the deadline-to-obligation FK is `ON DELETE RESTRICT`.

**Where it runs.** Queue `bulwark-extract-obligations`, BullMQ `attempts` + exponential backoff + DLQ (`agent-webhook-dispatch.job.ts` / `-dlq.job.ts` model). Bounded `AbortController` on LLM calls.

### 4.2 Event-binding + firing engine (inbox drain)

**Transport in (Section 6).** bolt-api forwards subscribed events to `POST ${BULWARK_API_INTERNAL_URL}/v1/internal/events` (THEME G: the internal container target, not the public `/bulwark/api/` prefix; matches `braid-dispatch-hook.ts:73-75`). The route (a) fails closed if `INTERNAL_SERVICE_SECRET` is empty (S4), (b) durably INSERTs a `bulwark_ingest_events` row `ON CONFLICT (organization_id, bolt_event_id) DO NOTHING` (THEME D), extracting `trigger_at` (a payload field naming when the real event occurred, else null) and `scope_fields` (the entity_filter-referenced ids, S5), then (c) enqueues `bulwark-fire-on-event { org_id, ingest_event_id }`.

**Firing job (`bulwark-fire-on-event`), an inbox drain:**
1. Load the `bulwark_ingest_events` row (or scan `status='pending'` on a periodic drain, so a lost enqueue is still processed). Skip if already `processed`.
2. Select armed obligations for the org whose binding `(source, event_type)` matches.
3. **Evaluate `entity_filter`, FAIL CLOSED (S5).** If a binding declares `entity_filter`, resolve the required path from `scope_fields`; if the field is absent or does not equal the contract field, do NOT arm (never over-fire to the wrong counterparty). An event with no matching scope arms zero deadlines.
4. **Choose the legal anchor (THEME B).** `anchor = trigger_at` if present, else `logged_at`, recording `anchor_source`; keep both times on the deadline so a reviewer can correct a late-logged event.
5. **Compute `due_at` in the resolved timezone (THEME B).** Interpret the anchor in `deadline_rule.timezone`, add the offset in calendar or business days, apply `roll_forward` against the holiday calendar, convert to timestamptz. Store `resolved_timezone`.
6. Insert a `bulwark_notice_deadline` `ON CONFLICT (organization_id, obligation_id, triggering_event_id) DO NOTHING` (at-most-once). Mark the inbox row `processed`. Publish the refs-only `deadline.armed` ws frame (Section 5.2 / BP6) on a conflict-free insert.

**Manual trigger (D8).** `POST /v1/obligations/:id/trigger { occurred_at }` arms a deadline exactly as an event would, with `anchor_source='manual'` and `triggering_event_id = uuid5(obligation_id || occurred_at)`. This is the safety net for obligations whose real-world trigger is never digitized. An event-bound obligation whose contract has a null `project_id` (so `entity_filter` cannot scope to a job) is not armable by events and is manual-only; the SPA marks it and `is_armed` stays false for the event path.

Idempotency/retry/backoff/DLQ mirror extraction. Capture-the-version discipline: `triggering_event_id` makes re-processing a no-op; `radar_marker` stamps the observed sweep time, never `now()` mid-compute.

### 4.3 The deadline-radar sweep

Queue `bulwark-radar-sweep`, every 15 minutes. Per org, under a **per-org advisory lock** so two overlapping sweeps cannot double-draft (ST5):
1. **Approaching / risk.** Scan `open` deadlines by `due_at`; map hours-remaining to `severity` via `radar_lead_times`; upsert `waiver_risk` `ON CONFLICT (...) DO NOTHING`. Emit `deadline.approaching` / `waiver.risk_detected`.
2. **Auto-draft, CAS-guarded and capped (ST5 / S6 / D5).** Only when `auto_draft_notices` (off by default), the obligation type is `notice`, the risk reached `high`, and the per-sweep / daily caps (`auto_draft_max_per_sweep`, `notice_llm_daily_cap`) are not exhausted. Guard the transition with a CAS: `UPDATE bulwark_notice_deadlines SET notice_status='drafted' WHERE id=$1 AND notice_status='none' RETURNING id`; only the winner drafts. Render ONLY `subject`+`body_markdown` (a bounded, best-effort drafting LLM call), insert an `agent_proposals` row (Section 2.2), set `notice_proposal_id`, emit `notice.drafted`. Recipient + attachments are stamped deterministically at send (THEME E). Beyond the caps, flag the risk and defer.
3. **Missed.** `open` deadlines past `due_at` flip to `missed` and raise a `critical`/`overdue` `waiver_risk`. These rows are retained indefinitely (D3).
4. **Calendar obligations (ST7).** For `renewal`/`termination` obligations bound to `contract_effective_date`/`contract_expiry_date`, compute the anchor date and arm with `triggering_event_id = uuid5(obligation_id || anchor_date)`, so year N and year N+1 both arm through the single unique index.

`last_radar_sweep_at` advances only after a fully successful tick.

### 4.4 The compliance-chase sweep + flow-down linkage

Queue `bulwark-coi-chase`, daily 04:30. Per org:
1. **Flow-down seeding (D4).** When a `flow_down` obligation is confirmed, or a `vendor_tier` is added under its contract, the tier's `required_doc_types` is set to `union(mandated_doc_types of the contract's confirmed flow_down obligations, parent_tier.required_doc_types)`. Tier-level 2+ inherits its `parent_tier_id`'s set, so flow-down cascades down the chain. This is the single link that joins the ledger half and the compliance half into one product.
2. **Validity sweep (D9).** Mark `validity_status='expiring'` where `expires_at <= now() + coi_expiry_lead_days`, `expired` where past. Emit `compliance.expiring` on transition.
3. **Chase draft.** For docs `missing`/`expiring`/`expired` whose `last_chased_at` is older than `chase_cadence_days`, CAS `chase_status none->drafted`, render a chase draft, insert an `agent_proposals` row (`proposed_action='bulwark.chase_compliance_doc'`), bump `last_chased_at`. The Blast/Blank send executes only on approve and is **transactional (bypasses `blast_unsubscribes`)** (D6).
4. Roll `vendor_tier.chase_status` up (`compliant` when all required docs `valid`).

### 4.5 Proposal-reconcile, retention, and jobs summary

**`bulwark-proposal-reconcile` (ST5, modeled on `apps/worker/src/jobs/braid-proposal-reconcile.job.ts`).** A dedicated 10-minute sweep for the at-least-once proposal bridge. For each `agent_proposals` row `proposed_action IN ('bulwark.send_notice','bulwark.chase_compliance_doc')` whose linked draft is still `drafted`/`none`: on `approved` re-derive the original decider, re-check the kill-switch, and drive the send CAS; on `rejected` mark the draft `discarded`; on **`expired`** clear `notice_proposal_id`/`chase_proposal_id` and reset `notice_status`/`chase_status` to `none` so the radar re-drafts on the still-open clock. An unmet notice re-surfaces; it never silently orphans.

**Retention (D3 / ST4).** `bulwark-retention` (daily 04:50) purges ONLY `status='discharged'` deadlines, and only those older than `max(N days, the inbox drain watermark horizon)` so a late redelivery cannot resurrect a clock (the inbox `UNIQUE(org, bolt_event_id)` is the durable dedup atom regardless). `missed`/`waived` deadlines and ALL `waiver_risks` are kept indefinitely (or archived, never deleted): they are the dispute record. `bulwark_ingest_events` is pruned only past the drain horizon. `bulwark_extraction_runs`, `bulwark_contracts`, and `bulwark_obligations` are never purged.

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `bulwark-extract-obligations` | event-driven | Bin bytes -> chunk (checkpointed) -> llm-provider -> verified-cited obligations by stable key; supersession-aware. |
| `bulwark-fire-on-event` | event-driven (inbox drain) | Drain `bulwark_ingest_events`, entity_filter fail-closed, timezone-anchored `due_at`, at-most-once arm. |
| `bulwark-radar-sweep` | every 15 min | Risk detection, CAS-guarded capped auto-draft, missed detection, calendar obligations; per-org advisory lock. |
| `bulwark-coi-chase` | daily 04:30 | Flow-down seeding, validity sweep, transactional chase drafts. |
| `bulwark-proposal-reconcile` | every 10 min | At-least-once send bridge + expired-proposal re-draft. |
| `bulwark-retention` | daily 04:50 | Purge only discharged deadlines past the watermark horizon; keep missed/waived/risks forever. |

All fan-out sets `app.current_org_id` per org and wraps each `(org, row)` in try/catch log-and-continue.

---

## 5. API surface

Base path `/bulwark/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data }`; errors the canonical envelope from `@bigbluebam/logging` `createErrorHandler` (`basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Shapes in `packages/shared/src/schemas/bulwark.ts`.

### 5.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/contracts` | List tracked contracts | `bulwark.contract.read` (owner/admin floor); project-scoped for granted non-admins (S1) |
| POST | `/v1/contracts` | Register from a Bin asset; enqueues extraction | `bulwark.contract.write`; **`can_access('bin.asset')` preflight, reject `not_found` if denied (S3)** |
| GET | `/v1/contracts/:id` | Contract detail + rollup | `bulwark.contract.read`; project-scoped; cited source records `can_access`-filtered |
| PATCH | `/v1/contracts/:id` | Update metadata (incl. `timezone`) | `bulwark.contract.write` |
| DELETE | `/v1/contracts/:id` | Delete a tracked contract (not the Bin asset) | `bulwark.contract.delete`; confirm token via MCP; cascades deadlines via `contract_id` FK |
| POST | `/v1/contracts/:id/extract` | Re-run extraction | `bulwark.contract.write`; hash-skip conditional on last-run success (ST6); Bin preflight (S3) |
| GET | `/v1/contracts/:id/obligations` | Ledger for a contract | `bulwark.obligation.read`; project-scoped |
| GET | `/v1/obligations` | List (review queue via `filter[review_status]=pending_review`) | `bulwark.obligation.read`; sort `-confidence` |
| GET | `/v1/obligations/:id` | Detail + verified `cited_span` | `bulwark.obligation.read`, `asker_user_id` |
| PATCH | `/v1/obligations/:id` | Confirm / edit / bind / reject | `bulwark.obligation.write`; `rejected` requires confirm token via MCP; confirming a `flow_down` seeds vendor `required_doc_types` (D4) |
| POST | `/v1/obligations/:id/trigger` | **Manual trigger** ("this happened") | `bulwark.deadline.write`; arms a deadline `anchor_source='manual'` (D8) |
| GET | `/v1/deadlines` | Deadline radar | `bulwark.deadline.read`; project-scoped; filters `status`, `contract_id`, `due_before`, `project_id` |
| GET | `/v1/deadlines/:id` | Detail + drafted notice | `bulwark.deadline.read` |
| POST | `/v1/deadlines/:id/draft-notice` | Draft/re-draft + register proposal | `bulwark.notice.draft` (owner/admin floor, S7) |
| POST | `/v1/deadlines/:id/approve-send` | Approve+send directly (UI) | `bulwark.notice.draft`; single send executor + CAS + deterministic recipient/attachment preflight (THEME E) |
| POST | `/v1/deadlines/:id/discharge` | Mark discharged/waived | `bulwark.deadline.write` (D9: an action perm, not read+write); waive requires confirm token |
| GET | `/v1/waiver-risks` | Open waiver risks | `bulwark.deadline.read`; project-scoped; sort `-severity` |
| GET | `/v1/vendor-tiers` | List vendor tiers | `bulwark.compliance.read` |
| POST | `/v1/vendor-tiers` | Add a tier (seeds `required_doc_types`, D4) | `bulwark.compliance.chase` |
| GET | `/v1/compliance-docs` | Vendor compliance matrix | `bulwark.compliance.read`; filters `validity_status`, `collection_status`, `doc_type` |
| POST | `/v1/compliance-docs/:id/chase` | Draft a chase + register proposal | `bulwark.compliance.chase` (owner/admin floor, S7) |
| POST | `/v1/compliance-docs/:id/approve-send` | Approve+send directly (UI) | `bulwark.compliance.chase`; transactional send (D6) + CAS |
| GET | `/v1/settings` | Get org settings | `bulwark.settings.read` |
| PATCH | `/v1/settings` | Update org settings | `bulwark.settings.write` |
| POST | `/v1/internal/events` | Ingest-trigger from bolt-api | `INTERNAL_SERVICE_SECRET`, **fail-closed on empty secret (S4)**; persists to `bulwark_ingest_events`, enqueues drain; no public route, no MCP tool |
| GET | `/health` / `/readyz` | Probes | `@bigbluebam/service-health`; `/readyz` checks ONLY Postgres + Redis |

**flagship `bulwark_check_notice_risk(job_id)`** composes `GET /v1/deadlines?filter[project_id]=<job>&status=open` + `GET /v1/waiver-risks` into one risk report (Section 10). **flagship `bulwark_extract_obligations(contract_asset_id)`** is `POST /v1/contracts` (register-if-new, with the Bin preflight) + `POST /contracts/:id/extract`.

### 5.2 Realtime (`/bulwark/ws`)

Redis-PubSub, org-scoped rooms, refs-only. Frames: `deadline.armed { deadline_id, obligation_id, due_at }` (published by the firing job on a conflict-free insert, BP6, separate from the Bolt event set), `waiver.risk_detected { risk_id, severity, contract_id }`, `notice.drafted { deadline_id, proposal_id }`, `compliance.expiring { compliance_doc_id, vendor_tier_id }`. No clause text or PII. Modeled on `apps/basis-api` / `apps/bin-api` ws routes + Redis PubSub cross-instance broadcast.

### 5.3 Permissions (12 rows)

Manifest-generated `app.resource.verb`, resolved by a `basis-api/src/plugins/permissions.ts`-style plugin. Enumerated in Section 10. Read rows `bulwark.contract.read`/`bulwark.obligation.read` and send rows `bulwark.notice.draft`/`bulwark.compliance.chase` are owner/admin floor in `0237` (S1/S7). Registration sequence is Section 3.4 step 3 (including the codegen step, THEME F).

---

## 6. Background work and the ingest transport

BullMQ workers in `apps/worker` (Section 4.5). The live firing transport (the Braid IN3 problem, resolved durably):

**bolt-api dispatch hook.** Bulwark adds a `bulwark-dispatch-hook.ts` in bolt-api, called alongside `dispatchToBraid` in `apps/bolt-api/src/routes/event-ingestion.routes.ts`, that POSTs matching events to `${BULWARK_API_INTERNAL_URL}/v1/internal/events` (THEME G: the container-internal target `http://bulwark-api:4021`, NOT the public `/bulwark/api/` nginx prefix, matching `braid-dispatch-hook.ts:73-75` "verified live"). Fire-and-forget.

**Per-org, per-binding dispatch gate (ST8).** Braid hard-codes a fixed source-type map; Bulwark's bound `(source, event_type)` pairs are data. To avoid a cross-tenant firehose, the gate is keyed **per org**: on every obligation arm/disarm Bulwark writes `SADD bulwark:bindings:<org_id> <source>:<event_type>` (and `SREM` on the last disarm of that pair for the org). The dispatch hook does a `SISMEMBER bulwark:bindings:<event.org_id>` for the event's OWN org before forwarding, so an event is forwarded only when THAT org has a matching binding; an event no org bound is never forwarded. Project/entity scoping is pushed toward the gate where the payload carries it; the worker's `entity_filter` evaluation is defense in depth.

**Durability (THEME D).** The receiving `/v1/internal/events` persists every accepted event into `bulwark_ingest_events` before firing, and the firing job drains that inbox, so a dropped enqueue is recovered by re-draining `status='pending'` rows. The transport is load-bearing (the earlier "soft dependency backed by a bolt-event source-diff" is removed: bolt-api persists only `bolt_executions`, one per matching automation, so no such backing data exists). A live-2xx smoke test asserts the dispatch target resolves and returns 2xx (THEME G).

**Worker env.** Add `BBB_API_INTERNAL_URL: http://api:4000` (extraction + drafting llm-provider) to the worker compose env and `worker.optional` (as the Braid build did). Byte reads: Section 9.2 / IN3 commits the path. No source-app internal URLs beyond that.

---

## 7. Events & integration

### 7.1 Bolt events published (source `bulwark`)

Via `publishBoltEvent(eventType, 'bulwark', payload, orgId, actorId?, actorType?)` (positional, `packages/shared/src/bolt-events.ts:35`), bare names, each registered in a new `bulwarkEvents` block in `apps/bolt-api/src/services/event-catalog.ts` (appended to `ALL_EVENTS`) or `scripts/check-bolt-catalog.mjs` fails CI. Refs + magnitude only.

| `event_type` | When | Payload (refs only) |
| --- | --- | --- |
| `contract.extracted` | an extraction run completes | `contract.id`, `obligations_extracted`, `low_confidence_count`, `org.id` |
| `obligation.extracted` | a new obligation is persisted | `obligation.id`, `contract.id`, `obligation_type`, `confidence`, `review_status`, `org.id` |
| `deadline.approaching` | radar detects a clock nearing due | `deadline.id`, `obligation.id`, `contract.id`, `due_at`, `hours_remaining`, `org.id` |
| `waiver.risk_detected` | a new waiver risk is raised | `risk.id`, `obligation.id`, `contract.id`, `severity`, `reason`, `org.id` |
| `notice.drafted` | a notice draft + proposal is created | `deadline.id`, `proposal.id`, `contract.id`, `org.id` |
| `compliance.expiring` | a doc crosses into expiring/expired | `compliance_doc.id`, `vendor_tier.id`, `doc_type`, `expires_at`, `org.id` |

`deadline.armed` is a ws-only frame (Section 5.2 / BP6), not a Bolt event, so a pure arm does not spam the Bolt catalog.

### 7.2 Events Bulwark SUBSCRIBES to (the binding targets)

Bulwark reacts to whatever `(source, event_type)` its confirmed obligations bind to (data, not a fixed list). Beachhead bindings from `event-catalog.ts`: `bam:task.overdue`, `bam:task.updated`, Bill pay-app/retention/overdue events, Book deadline events, `bam:sprint.completed`. New binding targets require no code change; they require the `(source, event_type)` to exist in `event-catalog.ts` and the per-org gate to admit it (Section 6). Where a needed trigger event does not exist, that obligation is `unbound` and manual-trigger-only until the source app publishes it (Section 12 / D8).

### 7.3 entity_links, unified activity, search

- **entity_links:** on contract register and vendor-tier create, upsert `bulwark.contract`/`bulwark.vendor_tier -> source` rows (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`).
- **unified activity:** Bulwark flows as the Bolt events above, not into the fixed `v_activity_unified` UNION (bam/bond/helpdesk only), matching Braid.
- **search:** a Bulwark `search_everything` provider (permission-gated, per-viewer post-filtered) is a fast-follow, not v1 (Section 12).

### 7.4 Braid integration (unify the counterparty)

Where Braid is available, Bulwark resolves the counterparty/vendor to a golden id via `braid_resolve` before writing the `entity_links` row, so the deterministic notice recipient (THEME E) is the canonical counterparty. Soft dependency: absent Braid, Bulwark uses the `bond.company` id directly.

---

## 8. Testing

- **Unit (Vitest, `@bigbluebam/db-stubs`, basis safety-suite precedent commit `7587872c`):**
  - **timezone / roll-forward (THEME B):** a Pacific contract's anchor near midnight computes the correct calendar day; `business_days` skips weekends; `roll_forward` moves a weekend due date to the next business day; DST boundary crossings hold.
  - **anchor selection (THEME B):** `trigger_at` present is preferred over `logged_at`; a Friday event logged Tuesday computes the due date from Friday, not Tuesday, and records `anchor_source`.
  - **supersession (THEME C):** re-extraction transitions absent obligations to `superseded` (not deleted) and re-points their open deadlines to the successor in one transaction; the deadline-to-obligation `ON DELETE RESTRICT` blocks an accidental obligation delete with a live clock.
  - **inbox drain (THEME D):** a persisted `bulwark_ingest_events` row with a lost enqueue is still fired by the pending-drain; a redelivered `bolt_event_id` dedups at the inbox even after the discharged deadline was purged (ST4).
  - **deterministic recipient/attachment (THEME E):** a clause naming `legal@attacker.example` and a foreign file does not change `recipient_id` (stays `counterparty_id`) or add an attachment; an attachment failing the decider's `can_access` preflight is dropped at send.
  - **/internal/events fail-closed (S4):** an empty `INTERNAL_SERVICE_SECRET` returns 401 before any compare.
  - **entity_filter fail-closed (S5):** a filtered binding with a missing/mismatched `scope_fields` path arms zero deadlines; `task.overdue` on Project X does not arm a Project-Y contract's clock.
  - **auto-arm gate (D5):** an outbound-type obligation with confidence 0.99 stays `pending_review`/`is_armed=false` until human confirm; a non-outbound type arms only on the deterministic signal.
  - **calendar recurrence (ST7):** year N and year N+1 both arm through the single unique index; no second index.
  - **extraction resume (ST6):** a chunk-3 failure resumes at chunk 3 on retry with no duplicate chunk-1/2 rows; an unchanged-hash re-run after a `partial` run does NOT skip.
  - **citation verification (D7):** a fabricated quote whose offsets do not match the source bytes is marked `verified=false` and forced to review.
  - **flow-down seeding (D4):** confirming a `flow_down` obligation seeds the vendor tier's `required_doc_types`; a tier-2 inherits its parent's set.
  - **send CAS / reconcile (ST5):** two overlapping radar sweeps draft once (the `none->drafted` CAS); an expired proposal is re-drafted by `bulwark-proposal-reconcile`; a REST approve racing the subscription echo sends once.
  - **transactional send (D6):** a chase/notice send is NOT filtered by `blast_unsubscribes`.
  - **per-org gate (ST8):** an event whose org has no matching binding is not forwarded / not enqueued.
- **register-tool policy test:** `bulwark.*` fails closed until allowlisted; a manifest test asserts the three destructive rows land `is_destructive:true, requires_confirmation:true` and every row carries an explicit `is_read`.
- **permission tiering (BP5):** after `0237`, a non-SuperUser org **Owner** GETs 200 on `GET /v1/contracts` (guards the Braid Owner-403 gap); a **Viewer** is read-only on non-tiered reads and 403 on writes and on `bulwark.contract.read`/`obligation.read`; a **Member** is 403 on `bulwark.notice.draft`.
- **Org-scoping test:** a service-layer query for org A returns zero org-B rows on every `bulwark_*` table; optional role-bound RLS test when the enforced role is provisioned.
- **e2e (Playwright, GILLIGAN dataset per `CLAUDE.md`):** a "Castaway Rescue Subcontract" is registered from a Bin asset (Bin ACL honored); extraction yields a 5-day notice obligation bound to `bam:task.overdue`; a reviewer confirms it; an overdue task arms the clock in the contract's Pacific timezone; the radar drafts a notice into the approval queue; the Skipper approves and it sends once to the deterministic counterparty; an expiring "Howell COI" triggers a transactional chase.

---

## 9. Infrastructure

### 9.1 New api compose service

`bulwark-api` in `docker-compose.yml`, modeled on `braid-api` (`docker-compose.yml:861`): `PORT: 4021`, stateless, horizontally scalable. Inherits the basis-style per-request RLS GUC plugin; does NOT flip the DB role. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Env: `DATABASE_URL`, `DATABASE_READ_URL=${DATABASE_READ_URL:-}` (mirrors braid-api `:868`), `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` (non-empty; `/internal/events` fails closed when empty, S4), `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `CORS_ORIGIN`, `NODE_ENV`, `HOST`, `LOG_LEVEL`, rate-limit knobs, `BBB_PERMISSIONS_ENFORCE`. Healthcheck: `curl -sf http://localhost:4021/health`.

### 9.2 Worker service wiring (IN3 resolved)

The engines run in `apps/worker`. **Byte-read path committed (IN3):** extraction runs in the worker, so the worker reads Bin bytes via `@bigbluebam/storage` resolving the object key from the shared DB (`bin_assets` via `DATABASE_URL`), exactly as `bin-transcode`/`bin-av-scan` workers already do. Therefore `BIN_API_INTERNAL_URL` is NOT added to bulwark-api (dropped from the prior draft) and NOT needed in the worker; `@bigbluebam/storage` (already linked) is the sole byte path. Edits:
- **Compose (`docker-compose.yml` worker service):** add `BBB_API_INTERNAL_URL: http://api:4000` (llm-provider for extraction + drafting).
- **Catalog (`scripts/deploy/shared/services.mjs`):** add `BBB_API_INTERNAL_URL` to `worker.optional` (Braid may already have added it; no-op if present).
- **`worker.needs` unchanged:** every new bulwark worker upstream (api for llm, bolt-api for publish) is a degradable, retried, DLQ'd request-time dependency.
- Register the six queues in `apps/worker/src/worker.ts` (`bulwark-extract-obligations`, `bulwark-fire-on-event`, `bulwark-radar-sweep`, `bulwark-coi-chase`, `bulwark-proposal-reconcile`, `bulwark-retention`).

### 9.3 SPA build (four Dockerfile edit sites, no separate compose service)

Edit `apps/frontend/Dockerfile` in four sites, mirroring the braid lines: (1) deps-stage `COPY apps/bulwark/package.json ./apps/bulwark/`; (2) build-stage 4-line source COPY block; (3) `&& pnpm --filter @bigbluebam/bulwark build` in the build `RUN`; (4) production `COPY --from=build /app/apps/bulwark/dist /usr/share/nginx/html/bulwark`.

### 9.4 nginx routing (two source configs, generated railway)

`infra/nginx/nginx.railway.conf` is auto-generated from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs`. Edit only the two source configs:
- `infra/nginx/nginx.conf` (after the braid blocks): `/bulwark/` alias + SPA fallback, `/bulwark/api/ -> http://bulwark-api:4021/`, `/bulwark/ws -> http://bulwark-api:4021/ws` with upgrade headers.
- `infra/nginx/nginx-with-site.conf`: the same three blocks.
- **Static-asset regex (IN5):** the two source alternations already diverge in more than one token (`nginx.conf` includes `bill`; the two files are also missing `bay`/`blip` in the generated form). Insert ONLY the `bulwark` token into each source file's existing alternation; touch nothing else; do not copy one alternation over the other or reconcile the pre-existing bay/blip/bill divergence in this pass.
- Then `node scripts/gen-railway-configs.mjs`; the generator rewrites the upstream to `bulwark-api.railway.internal:8080`, synthesizes the `$rw_upstream_NN` index and `rewrite ... break;` lines. Do not hand-edit `:8080` or the index.
- **Ingress crash-safety:** add `bulwark-api` (`condition: service_healthy`) to the `frontend` service `depends_on` in `docker-compose.yml`.

### 9.5 Deploy catalog, Railway, MCP wiring, Launchpad, marketing site, CLAUDE.md

- `scripts/deploy/shared/services.mjs`: add a `bulwark-api` `APP_SERVICES` block (port `4021`, `public_paths: ['/bulwark/api/','/bulwark/ws']`, `required` env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`/`BOLT_API_INTERNAL_URL`, `optional` incl. `DATABASE_READ_URL`/`CORS_ORIGIN`/`LOG_LEVEL`), mirroring `braid-api` (`:270`). `bulwark-api.needs = ['postgres','redis','api','bolt-api']`. Add `/bulwark/` to the `frontend` entry's `public_paths` and `bulwark-api` to its `needs`.
- **MCP wiring (IN1):** add `BULWARK_API_URL` to `mcp-server.env.optional` in `services.mjs` AND to the docker-compose `mcp-server` environment block (mirroring the `BRAID_API_URL: http://braid-api:4020/v1` line at `docker-compose.yml:188`), value `http://bulwark-api:4021/v1`, plus an env-hints hint. **Backfill the pre-existing bug in the same pass:** `BASIS_API_URL` and `BRAID_API_URL` are present in `docker-compose.yml` but MISSING from `mcp-server.env.optional` in `services.mjs` (so `gen-railway-configs` omits them from `env-vars.md`); add all three. **`mcp-server.needs` decision (IN4):** do NOT add `bulwark-api` to `mcp-server.needs`, matching the deliberate braid/basis omission (mcp-server reaches app APIs only at request time; `needs` only affects deploy ordering). Register `bulwark-tools.ts` in the MCP bootstrap.
- **bolt-api wiring (Section 6):** add `BULWARK_API_INTERNAL_URL=http://bulwark-api:4021` to bolt-api compose env + catalog, alongside `BRAID_API_INTERNAL_URL`.
- **Run `node scripts/gen-railway-configs.mjs`:** regenerates `nginx.railway.conf` and emits `railway/bulwark-api.json`.
- **Launchpad catalog** in `apps/api/src/routes/system-settings.routes.ts`: add `'bulwark'` to `LAUNCHPAD_APP_IDS` and a `LAUNCHPAD_CATALOG` entry `{ id: 'bulwark', name: 'Bulwark', description: 'Contract Obligations', icon_name: 'shield-check', color: '#1d4ed8', path: '/bulwark/' }`. Do NOT add to `ROOT_REDIRECT_VALUES` (matches basis/braid; avoids the `REDIRECT_MAP` typecheck break).
- **Launchpad icon:** `shield-check` is absent from `ICONS` in `packages/ui/launchpad.tsx:65` (unknown icons fall back to `Box`, `:226`). Two edits: `import { ShieldCheck } from 'lucide-react'` and add `'shield-check': ShieldCheck`.
- **Marketing site (BP3):** add a Bulwark section to the `site/` Vite app registered on a page, with GILLIGAN-only screenshots where the site references them (per the hard screenshots rule in `CLAUDE.md`), then rebuild the site image (`docker compose build site && docker compose up -d --force-recreate site`; on Railway it ships on push to `stable`). Update the MCP tool count AND the "N apps" narrative wherever referenced in BOTH `CLAUDE.md` AND `site/`, not just `CLAUDE.md`.
- **CLAUDE.md (Phase 5 mandate):** append the `bulwark-api` (internal :4021, `/bulwark/api/`) and `bulwark` SPA (`/bulwark/`) inventory lines, the `/bulwark/`, `/bulwark/api/`, `/bulwark/ws` route rows, and bump the MCP tool count by the new `bulwark-tools.ts` module (15 tools, Section 10).
- **Runtime-dependency posture:** `/readyz` checks only Postgres + Redis. Bin byte reads, the llm-provider, and bolt-api publish use bounded timeouts + typed `UPSTREAM_UNAVAILABLE`; workers retry/backoff/DLQ; the durable inbox is the firing guarantee.

---

## 10. MCP surface

New `apps/mcp-server/src/tools/bulwark-tools.ts` via `registerTool`, HTTP client shaped like `dedupe-tools.ts:38`. Env `BULWARK_API_URL=http://bulwark-api:4021/v1`. Reads that surface source records require `asker_user_id` (`docs/reference/agent-conventions.md`), fail-closed via `can_access`; destructive tools use the Redis confirm-token store. `bulwark_*` not in `EXPLICIT_TOOL_OVERRIDES` (basis/braid deferral).

| Tool | Backs | Permission | confirm_action |
| --- | --- | --- | --- |
| `bulwark_extract_obligations` (flagship) | POST `/v1/contracts` + POST `/contracts/:id/extract` | `bulwark.contract.write` | no |
| `bulwark_check_notice_risk` (flagship) | GET `/v1/deadlines` + `/waiver-risks` for a job | `bulwark.deadline.read`, `asker_user_id` | no |
| `bulwark_list_contracts` | GET `/v1/contracts` | `bulwark.contract.read` | no |
| `bulwark_get_contract` | GET `/v1/contracts/:id` (embeds obligations + rollup) | `bulwark.contract.read`, `asker_user_id` | no |
| `bulwark_delete_contract` | DELETE `/v1/contracts/:id` | `bulwark.contract.delete` | **yes** |
| `bulwark_list_obligations` | GET `/v1/obligations` | `bulwark.obligation.read` | no |
| `bulwark_get_obligation` | GET `/v1/obligations/:id` | `bulwark.obligation.read`, `asker_user_id` | no |
| `bulwark_confirm_obligation` | PATCH `/v1/obligations/:id` (confirm/edit/bind) | `bulwark.obligation.write` | no |
| `bulwark_reject_obligation` | PATCH `/v1/obligations/:id` (`rejected`) | `bulwark.obligation.write` | **yes** |
| `bulwark_trigger_obligation` | POST `/v1/obligations/:id/trigger` (manual trigger, D8) | `bulwark.deadline.write` | no |
| `bulwark_list_deadlines` | GET `/v1/deadlines` | `bulwark.deadline.read` | no |
| `bulwark_draft_notice` | POST `/v1/deadlines/:id/draft-notice` (inserts a proposal) | `bulwark.notice.draft` | no (proposal is the HITL) |
| `bulwark_waive_deadline` | POST `/v1/deadlines/:id/discharge` (waive) | `bulwark.deadline.write` | **yes** |
| `bulwark_list_compliance` | GET `/v1/compliance-docs` | `bulwark.compliance.read` | no |
| `bulwark_chase_compliance` | POST `/v1/compliance-docs/:id/chase` (inserts a proposal) | `bulwark.compliance.chase` | no (proposal is the HITL) |

15 tools. `bulwark_get_contract` embeds obligations + rollup, so `/v1/contracts/:id/obligations` is `resolver-done-internally` in the surface map. No-tool endpoints: `GET`/`PATCH /settings` (SPA-surfaced), `POST /v1/internal/events`, `/bulwark/ws`, `/health`, `/readyz`, and the two `approve-send` routes (UI-only send surfaces; the MCP send path is the proposal approve). **agent_policies:** every `bulwark_*` service-account call fails closed until `bulwark.*` is allowlisted.

**The 12 hand-authored permission rows** (Section 3.4 step 3b), each with explicit `app:'bulwark'` and `is_read`:
- `bulwark.contract.read` (`is_read:true`; owner/admin floor)
- `bulwark.contract.write` (`is_read:false`)
- `bulwark.contract.delete` (`is_read:false, is_destructive:true, requires_confirmation:true`)
- `bulwark.obligation.read` (`is_read:true`; owner/admin floor)
- `bulwark.obligation.write` (`is_read:false`; the reject path carries confirm at the tool layer)
- `bulwark.deadline.read` (`is_read:true`)
- `bulwark.deadline.write` (`is_read:false`; discharge/manual-trigger; waive confirm at the tool layer, D9)
- `bulwark.notice.draft` (`is_read:false`; owner/admin floor, S7)
- `bulwark.compliance.read` (`is_read:true`)
- `bulwark.compliance.chase` (`is_read:false`; owner/admin floor, S7)
- `bulwark.settings.read` (`is_read:true`)
- `bulwark.settings.write` (`is_read:false`)

**Surface-map update:** `docs/reference/mcp-endpoint-mapping.md` MUST be updated in the same change; every REST row's MCP column is a backtick tool name or the sanctioned em-dash skip-cell (that table is the one place em dashes are correct). Keep the coverage counts and the zero-bare-dash grep green.

---

## 11. Reuse ledger

| Capability | Reuses (real file/package) | New in Bulwark |
| --- | --- | --- |
| App scaffolding (Fastify, plugins, health, RLS GUC) | `apps/basis-api/src/server.ts` (`@bigbluebam/service-health:8`), `apps/basis-api/src/plugins/rls.ts`, `apps/braid-api/` layout, `apps/bin-api/src/db/schema/bbb-refs.ts` | `bulwark-api` at 4021 |
| Document + collected-doc bytes | `apps/bin-api` `bin_assets` (`0205_bin_dam.sql`), `@bigbluebam/storage` `getStream` (shared-DB object-key resolution) | contract/compliance `bin.asset` references, `can_access`-preflighted |
| Clause + notice-draft understanding (internal only) | internal llm-provider `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`), `llm_providers` | fenced-DATA extraction with verified cited spans; drafting emits only subject/body |
| Event bus + durable dispatch transport | `publishBoltEvent` (`bolt-events.ts:35`), `apps/bolt-api/src/services/braid-dispatch-hook.ts` + `event-ingestion.routes.ts` | data-driven `event_binding`, a `bulwark-dispatch-hook.ts`, a per-org gate, and the `bulwark_ingest_events` durable inbox |
| HITL inbox + reconcile | `agent_proposals` (`0128_agent_proposals.sql`), `proposals.routes.ts:275,328`, `apps/worker/src/jobs/braid-proposal-reconcile.job.ts` | null-approver drafts, single kill-switch-safe send executor, `bulwark-proposal-reconcile` |
| Confirm-action on destructive tools | `apps/mcp-server/src/lib/confirm-token-store.ts` | delete-contract / reject-obligation / waive-deadline tokens |
| Counterparty identity | `apps/bond-api`, `entity_links` (`0132_entity_links.sql`), `braid_resolve` (`apps/braid-api`) | deterministic notice recipient resolution |
| Money / dates / chase / forms | `apps/bill-api`, `apps/book-api`, `apps/blast-api` (transactional flag), `apps/blank-api` | payment/retention obligations, calendar deadlines, transactional chases, collection forms |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts:1151` (`preflightBinAsset`), `can_access` | Bin preflight on register + attachment preflight at send + project-scoped ledger reads |
| Bolt events + drift guard | `event-catalog.ts`, `scripts/check-bolt-catalog.mjs` | 6 `bulwark` event definitions |
| Org scoping + RLS posture | `app.current_org_id` GUC (`0116_*`), `rls-boot.ts`, `basis-api/src/plugins/rls.ts`, `BBB_RLS_ENFORCE` | Bulwark table policies + app-level org-scoping tests |
| Permissions (hand-authored satellite pattern) | `scripts/generate-permission-manifest.mjs`, **`scripts/build-permission-codegen.mjs`** (writes `packages/permissions/src/generated/permissions.ts`), `check-permission-catalog.mjs`, `build-permission-delta.mjs`, `0233_braid_builtin_group_defaults.sql` | 12 `bulwark.*` rows + custom-tiered built-in defaults |
| MCP registration + policy gate | `register-tool.ts` (incl. `/v1/agent-policies/:id/check`), `dedupe-tools.ts` client | 15 `bulwark_*` handlers |
| Worker retry/backoff/DLQ + capture-the-version + advisory lock + retention | `braid-*.job.ts`, `basis-metric-snapshot.job.ts`, `bond-stale-deals.job.ts:127-138`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts`, `basis-retention-sweep.job.ts` | extraction (checkpointed) / inbox-drain firing / radar (locked, capped) / chase / reconcile / retention |
| Launchpad + nginx + frontend Dockerfile + services.mjs + marketing site | braid/basis wiring, `gen-railway-configs.mjs`, `packages/ui/launchpad.tsx`, `site/` | one new app id `bulwark`, `shield-check` icon, a marketing section |
| Suite UI shell + Bureau widget + test stubs | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/db-stubs` | Bulwark SPA pages only |

---

## 12. Open questions & risks (human decision needed)

1. **Per-org dispatch gate mechanism (Section 6).** The `SADD bulwark:bindings:<org_id>` Redis set + `SISMEMBER` gate keyed on the event's own org is the chosen shape (ST8). Confirm the arm/disarm write points keep the set consistent (the last disarm of a `(source,event_type)` for an org must `SREM`), and decide the eventual-consistency window on a fresh arm (the inbox drain + radar backstop covers a brief miss). Owner: Bolt maintainers + Bulwark.
2. **`trigger_at` payload extraction (THEME B).** Which payload field names the real legal event time per source event is not standardized across the catalog. Where a source event carries no such field, `trigger_at` is null and the clock anchors on `logged_at` with `anchor_source='logged_at'` surfaced for reviewer correction. Confirm per beachhead binding which field to prefer.
3. **Holiday-calendar source (THEME B).** `business_days` / `roll_forward` need a jurisdiction holiday calendar. v1 ships weekend-only roll-forward plus an optional named calendar (`us-federal`); state-specific and international calendars are a fast-follow. A wrong holiday still yields a due date within a day of correct and is human-reviewable.
4. **Source-app event coverage (Section 7.2).** Some beachhead triggers (Bill pay-app/retention, Book deadline changes) may not be published at the needed granularity yet (the braid-dispatch-hook TODO shows several upsert events are not wired). Unbound obligations are manual-trigger-only (D8) until the source app publishes. Gates autonomous breadth.
5. **Scanned / image-only contracts (Section 4.1).** No OCR in v1; such contracts extract to zero obligations and are flagged for manual entry. Decide whether to add an OCR worker step or defer.
6. **Extraction + draft accuracy is best-effort and legally consequential.** Mitigations: the human-review queue (outbound types never auto-arm, D5), verified cited spans (D7), the deterministic recipient/attachment (THEME E), the transactional-send path (D6), and a disclaimer that Bulwark assists but does not replace counsel. Human decision: the acceptable auto-confirm floor for display and whether any type must always be reviewed (default: all outbound types are).
7. **`search_everything` provider (Section 7.3).** Deferred from v1 to keep scope tight; a fast-follow.
8. **Partitioning trigger (ST9).** DELETE retention on unpartitioned deadline/risk tables is acceptable at the SMB target; revisit monthly partitioning if a large org's volume warrants it.
9. **No human-provided secret required.** All dependencies are internal (Bin, Bolt, the internal llm-provider, agent_proposals, Blast transactional path, Blank, Bond, optionally Braid). No third-party API key. The only new env are internal service URLs and the reused `INTERNAL_SERVICE_SECRET`.

---

## Changelog - Round 1

Final hardening round 1. Every finding accepted or accepted-with-adaptation; none rejected. Dispositions:

**Convergent themes (blockers)**
- [security] THEME A ACCEPT (BLOCKER, option b): ledger reads tiered to owner/admin floor in `0237` AND project-scoped per-route with org-admin override; prose-vs-migration contradiction resolved (custom `0237` tiering, no member-gets-everything). Sections 2.5, 3.1, 3.4, 5.1, 5.3, 10.
- [design] THEME B ACCEPT (BLOCKER): `deadline_rule` gains IANA `timezone` + `jurisdiction`/`holiday_calendar` + `roll_forward`; `contract.timezone` stored; firing separates legal `trigger_at` from transport `logged_at` (prefers `trigger_at`, records `anchor_source`); DST/roll-forward tests. Sections 2.1, 3.1, 3.3, 4.1, 4.2, 8.
- [stability] THEME C ACCEPT (BLOCKER): `contract_kind='amendment'` + `supersedes_contract_id`; base status `'amended'`; obligation stable key `(contract_id, clause_ref)`; superseded terminal status (never delete); open deadlines re-pointed in one transaction; deadline-to-obligation FK `ON DELETE RESTRICT`. Sections 3.1, 3.4, 4.1, 8.
- [stability] THEME D ACCEPT (BLOCKER): added the `bulwark_ingest_events` durable inbox; firing is an inbox drain; the false "bolt-event source-diff fallback" removed; live path documented as load-bearing. Sections 1, 3.1, 4.2, 6, 8.
- [security] THEME E ACCEPT (BLOCKER): notice recipient is always `contract.counterparty_id`, attachments a deterministic allowlist, drafting LLM emits only subject/body; `can_access` preflight on the attachment for the decider at send. Sections 2.1, 2.4, 3.3, 8.
- [best-practices] THEME F ACCEPT (BLOCKER): inserted the explicit `build-permission-codegen.mjs` step (regenerate + commit `packages/permissions/src/generated/permissions.ts`) before `check-permission-catalog`, then `build-permission-delta`; added to the reuse ledger. Sections 3.4, 11.
- [best-practices/infra] THEME G ACCEPT (MAJOR x3): the internal dispatch target is `${BULWARK_API_INTERNAL_URL}/v1/internal/events` in Sections 4.2 and 6, matching 5.1 and the braid hook; added a live-2xx smoke test. Sections 4.2, 6, 8.

**Design**
- [design] D3 ACCEPT: retention scoped to `discharged` only; missed/waived deadlines + all waiver_risks kept indefinitely (FK `RESTRICT`/`SET NULL`, never cascade-delete a risk). Sections 3.1, 4.5.
- [design] D4 ACCEPT: `flow_down` obligations carry `mandated_doc_types`; confirming one (or adding a tier) seeds `vendor_tier.required_doc_types`; `parent_tier_id` cascades tier 2+. Sections 3.1, 4.4, 5.1, 8.
- [design] D5 ACCEPT: split display-auto-confirm from auto-arm; outbound types (notice/indemnity/payment/compliance) always require human confirm before `is_armed`; non-outbound auto-arm gated on a deterministic signal; `auto_draft_notices` default false. Sections 2.2, 3.1, 4.1, 4.3.
- [design] D6 ACCEPT: compliance/notice sends are transactional and bypass `blast_unsubscribes` via a `transactional=true` send flag; stated plainly they do not honor marketing unsubscribes. Sections 2.5, 4.4.
- [design] D7 ACCEPT: deterministic post-processing verifies `quote` against `source_text.slice(start,end)`, snaps or forces review on mismatch, stores verified offsets tied to `source_doc_hash`. Sections 3.3, 4.1, 8.
- [design] D8 ACCEPT: added `POST /v1/obligations/:id/trigger` + `bulwark_trigger_obligation`; wedge softened to "event-bound plus manual trigger"; event-bound obligations require a resolvable job scope (null-project contracts are manual-only). Sections 1, 2.2, 4.2, 5.1, 10.
- [design] D9 ACCEPT: `compliance_docs` split into `collection_status` + `validity_status` (+ `chase_status`); discharge/waive moved to `bulwark.deadline.write` (an action perm, not read+write). Sections 3.1, 5.1, 10.

**Security**
- [security] S3 ACCEPT: `can_access('bin.asset')` preflight at register/extract and a worker re-check against `created_by`. Sections 2.5, 4.1, 5.1.
- [security] S4 ACCEPT: `/internal/events` returns 401 when `INTERNAL_SERVICE_SECRET` is empty, before any compare. Sections 2.5, 4.2, 5.1, 8.
- [security] S5 ACCEPT: the inbox carries the entity_filter-referenced `scope_fields`; firing FAILS CLOSED when a declared filter path is absent. Sections 3.1, 4.2, 8.
- [security] S6 ACCEPT: per-org per-sweep auto-draft cap + per-org daily notice-draft LLM ceiling; beyond cap flag and defer. Sections 2.6, 3.1, 4.3.
- [security] S7 ACCEPT: `bulwark.notice.draft` + `bulwark.compliance.chase` tiered owner/admin in `0237`; human freeze is permission revocation (kill-switch bypasses humans). Sections 2.5, 3.4.
- [security] S8 ACCEPT: extraction/drafting prompts fence clause + event text as untrusted DATA and forbid control-field emission. Sections 2.5, 4.1.

**Stability**
- [stability] ST4 ACCEPT: the dedup atom lives in `bulwark_ingest_events` (`UNIQUE(org, bolt_event_id)`), independent of deadline retention; retention never precedes the drain horizon. Sections 2.1, 3.1, 4.5.
- [stability] ST5 ACCEPT: draft guarded by a `none->drafted` CAS + per-org advisory lock; added `bulwark-proposal-reconcile` (expired proposals reset to re-draft). Sections 4.3, 4.5, 8.
- [stability] ST6 ACCEPT: hash-skip conditional on prior-run success; `last_processed_chunk` checkpoint resume; stable-key upsert (no dupes). Sections 3.1, 4.1, 8.
- [stability] ST7 ACCEPT: calendar dedup uses `triggering_event_id = uuid5(obligation_id || anchor_date)`; the contradictory second unique index dropped; year N / N+1 test. Sections 3.1, 4.3, 8.
- [stability] ST8 ACCEPT: per-org dispatch gate keyed on the event's own org; worker filter is defense in depth. Sections 4.2, 6, 8.
- [stability] ST9 ACCEPT (documented): unpartitioned in v1 acceptable at SMB volume with discharged-only retention; monthly partitioning is a documented fast-follow. Sections 3.1, 12.

**Best-practices**
- [best-practices] BP3 ACCEPT: added a marketing `site/` section subtask (GILLIGAN screenshots, image rebuild) and the MCP-count + app-count narrative update in BOTH CLAUDE.md and site/. Section 9.5.
- [best-practices] BP4 ACCEPT: the emitted delta must be additive-only; strip any unrelated row removals before landing. Section 3.4.
- [best-practices] BP5 ACCEPT: added the Owner-200 / Viewer-read-only / Member-403 tiering tests. Section 8.
- [best-practices] BP6 ACCEPT: `deadline.armed` is a ws-only frame published by the firing job on a conflict-free insert, distinct from the Bolt event set. Sections 4.2, 5.2, 7.1.

**Infrastructure**
- [infrastructure] IN1 ACCEPT: `BULWARK_API_URL` added to `mcp-server.env.optional` in services.mjs + compose + env-hint; backfilled the pre-existing missing `BASIS_API_URL`/`BRAID_API_URL`. Section 9.5.
- [infrastructure] IN3 ACCEPT: committed the byte path to `@bigbluebam/storage` shared-DB object-key resolution in the worker; dropped `BIN_API_INTERNAL_URL` from bulwark-api. Section 9.2.
- [infrastructure] IN4 ACCEPT: `bulwark-api` deliberately omitted from `mcp-server.needs`, matching braid/basis. Section 9.5.
- [infrastructure] IN5 ACCEPT: insert only the `bulwark` token into each source alternation; the pre-existing bay/blip/bill divergence is left untouched this pass. Section 9.4.
