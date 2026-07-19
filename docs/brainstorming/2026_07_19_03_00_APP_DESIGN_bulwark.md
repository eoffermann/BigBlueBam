# Bulwark - App Design Specification

> An agent that reads the agreements an organization has signed and then spends the whole engagement making sure it does not breach them.
>
> Status: design draft, hardened through adversarial review rounds 1 and 2. New app. Winner of the 2026-07-19 03:00 suite-brainstorm session.
> Chosen internal port: **4021** (next free port after Braid's 4020; 4019 is basis, 4020 is braid).
> Routes: SPA at `/bulwark/`, REST at `/bulwark/api/`, realtime at `/bulwark/ws`.
> Chosen final name: **Bulwark** (single word). App id `bulwark`.

Freshest build precedent cited throughout: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (the Braid spec) and the **just-shipped Braid app** (`apps/braid-api/`, `apps/worker/src/jobs/braid-*.job.ts`, `apps/bolt-api/src/services/braid-dispatch-hook.ts`, `0233_braid_builtin_group_defaults.sql`). Bulwark reuses Braid's HITL-via-`agent_proposals`, Bolt-dispatch-transport, hand-authored-permissions, built-in-group-defaults, proposal-reconcile, and rescan-durability patterns.

House style: no em dashes or en dashes in this document; no Co-Authored-By footer.

---

## 1. Overview & positioning

**One-liner.** Bulwark extracts a typed, clause-cited **obligation ledger** from an organization's executed contracts, **binds each obligation to a Bolt event pattern (plus a manual-trigger affordance)**, and fires against reality as it is logged rather than against a static calendar. A delay recorded on a job starts the five-day notice clock that the subcontract actually requires, Bulwark drafts the notice that discharges it, and every outbound act lands in the existing `agent_proposals` queue for a human to approve. Nothing is ever sent unattended.

**The wedge (why it won).** Small contractors waive real claims constantly by missing a 5-day notice clause nobody re-reads after signing. Contract review today is a lawyer at $400/hr, once, at signing, and then never again. Bulwark moves the axis from "one-time review" to **continuous obligation monitoring tied to logged job events, backstopped by a manual trigger** for the obligations whose real-world trigger is not (yet) digitized. Bulwark is explicit that it fires only on events that reach it (Section 6 makes delivery durable at three layers), so the human-review queue and the manual-trigger tool (Section 4.2 / 5.1 / D8) are the safety net, not a silent gap. The suite already holds every input: the executed document is a **Bin** asset, the counterparty is in **Bond**, the money terms live in **Bill**, the deadlines surface in **Book**, and reality streams through **Bolt**.

**Who it is for.** The owner/PM/contract-admin persona at a 2-50 seat contractor, and structurally identical buyers in any obligation-bearing engagement (SOWs, MSAs, grant awards, commercial leases). Construction is the beachhead; the object model is horizontal.

**How it differs from the three apps it is most often confused with:**
- **Bin** (`apps/bin-api/`, `@bigbluebam/storage`) *stores the document bytes*. Bulwark references a `bin.asset`, reads its bytes once for extraction (after a `can_access` preflight, Section 4.1 / S3), and never becomes a second DAM.
- **Bolt** (`apps/bolt-api/`) *routes events and runs rule automations*. Bulwark is a *consumer* of the Bolt stream whose bindings are data per contract, whose reactions are legally-typed, and which durably persists every event it receives into its own inbox (Section 3.1, THEME D) because bolt-api itself persists only matching-automation executions.
- **Bill** (`apps/bill-api/`) *invoices and tracks money*. Bulwark reads payment/retention terms as obligations and watches Bill events; it never issues an invoice.

**v1 scope.** Objects: `contract` (including `amendment`), `obligation`, `notice_deadline`, `waiver_risk`, `compliance_doc`, `vendor_tier`, `ingest_event` (the durable event inbox), plus `bulwark_org_settings` and `bulwark_extraction_runs`. Surfaces: the obligation ledger per job, the deadline radar, the drafted-notice review queue, and the vendor compliance matrix. Flagship MCP tools: `bulwark_extract_obligations(contract_asset_id)` and `bulwark_check_notice_risk(job_id)`.

**Firing durability is layered, and the transient-event edge is an honest open question (THEME J / STJ1).** The receiving inbox (`bulwark_ingest_events`) makes an event durable once received; a scheduled pending-inbox drain (Section 4.3) recovers a lost enqueue after the row lands; and a `bulwark-state-reconcile` job (Section 4.5) re-derives clocks from queryable **source state** for the many bindings that reflect persistent state (a task past due and still open, an invoice overdue, a COI near expiry), the braid-rescan analog. The one gap Bulwark cannot close alone is a genuinely **transient** event (no persistent source row) dropped on the bolt-api to bulwark-api hop while bulwark-api is mid-deploy or blipped. That requires a sending-end outbox in bolt-api (Section 6); until it exists, transient-only bindings degrade to the manual-trigger net and are called out as Open Question 1 with the Bolt maintainers as owner. The spec does not claim end-to-end delivery is guaranteed without that outbox.

**Out of v1 scope:** authoring/e-signature/redline, OCR of scanned contracts (image-only PDFs extract to zero obligations and are flagged for manual entry, Section 12), a `search_everything` provider (fast-follow), recurring-calendar obligations beyond a single occurrence (DI6, Section 12), and any autonomous send. Legal-advice disclaimer: extraction is best-effort and always human-reviewable.

---

## 2. AI-native design

Bulwark's AI core is **best-effort clause extraction plus deterministic, timezone-anchored, event-bound firing, with human-in-the-loop review at two boundaries**: every claim-or-money-waiving obligation is human-reviewed before it can arm a clock, and every outbound act is an `agent_proposals` row a human approves. The LLM understands contract language; it never sends anything, never chooses a recipient or an attachment, and never computes a due date.

### 2.1 The two-plane split (borrowed from Basis / Braid)

1. **LLM extraction (best-effort, always reviewable).** The internal llm-provider reads chunked contract text and proposes typed obligations with a cited span (whose offsets are then **verified against the source bytes**, Section 4.1 / D7) and a self-reported confidence. This output is never live truth.
2. **Deterministic firing (reproducible, auditable, timezone-anchored).** Once an obligation is `confirmed` and bound, firing is pure arithmetic over a typed `deadline_rule` that carries an IANA timezone, an optional jurisdiction/holiday calendar, and a roll-forward flag (Section 3.3, THEME B). The recipient and attachments of any drafted notice are **deterministic** (Section 2.4, THEME E), never model output.

**Invariant.** A `bulwark_notice_deadline` is a pure function of `(obligation.deadline_rule, the legal anchor time, the resolved timezone)`. It is created at-most-once per `(obligation_id, triggering_event_id)`, and the durable inbox (`bulwark_ingest_events`) deduplicates a redelivered Bolt event by `(org, source_idempotency_key)` independently of deadline retention, so a purge of an old discharged deadline can never resurrect a clock (Section 3.1, ST4).

### 2.2 Autonomy bands

| Action | Autonomy | Gate |
| --- | --- | --- |
| Extract obligations from a contract asset | Autonomous (worker), best-effort | `bulwark-extract-obligations`; Bin `can_access` preflight first (S3) |
| Confirm / edit / reject an extracted obligation | HITL, permission + project-scoped | `bulwark.obligation.write`; project-membership check + `can_access` (SH1); reject is destructive (confirm token) |
| Arm a clock when a bound event fires | Autonomous (deterministic) but only for obligations cleared to arm (see D5 below) | firing job; at-most-once |
| **Manually trigger** an obligation ("this happened, start the clock") | HITL, permission + project-scoped | `bulwark.deadline.write`; the safety net for unbound / no-project obligations (D8 / DI7) |
| Flag a waiver risk | Autonomous | radar sweep |
| **Draft** a notice / a compliance chase | Autonomous draft, **HITL to send** | inserted into `agent_proposals`; recipient + attachments deterministic (THEME E) |
| Mark a deadline discharged / waived | HITL, permission + project-scoped | `bulwark.deadline.write`; waive is destructive (confirm token) |
| Delete a tracked contract | HITL, destructive, owner/admin | `bulwark.contract.delete` (owner/admin floor, Redis confirm token) |
| Edit org settings | Permission-gated, owner/admin | `bulwark.settings.write` (owner/admin floor) |

**Auto-arm gate, reconciled to the real enum (D5 / DI4).** The obligation-type enum is `notice | insurance | indemnity | payment | retention | flow_down | renewal | termination | lien | other`. There is no `compliance` type (that path derives from `flow_down` obligations plus vendor tiers, Section 4.4, not a type). Two rules govern arming:
- **Human-confirm-before-arm set (claim-or-money-waiving types): `notice`, `lien`, `retention`, `indemnity`, `payment`.** These never auto-arm on model confidence, regardless of `auto_confirm_threshold`; a human must confirm before `is_armed` becomes true. A high self-reported confidence may only mark them `auto_confirmed` for **display in the ledger**, never armed.
- **Auto-arm-eligible types (`insurance`, `flow_down`, `renewal`, `termination`, `other`)** may arm without human confirm only when a **deterministic** signal holds: the `deadline_rule` parser agreed with the model AND (for event-bound) a real `(source, event_type)` mapped AND a **non-empty `entity_filter` is present** (STJ5) AND the cited-span offsets verified. `renewal`/`termination` are typically calendar-derived from human-entered contract dates, so their determinism comes from the contract, not the LLM.

Only the `notice` type has a notice-draft send path; `lien`/`retention`/`indemnity`/`payment` arm a deadline and raise a `waiver_risk` for human action but have no auto-draft outbound. `auto_draft_notices` defaults to **false**.

**The HITL boundary is the `agent_proposals` queue (Braid Section 2.2).** Bulwark never calls Blast/Blank to send directly from the drafting path. It inserts an `agent_proposals` row and the `proposal.decided` subscription executes the send only on `approve`. Direct insert (not the public `POST /v1/proposals`, which mandates `approver_id`, `proposals.routes.ts:40`): `approver_id=NULL` (nullable, `0128_agent_proposals.sql:37`), explicit `expires_at = now() + 7 days` (`:41`), `subject_type='bulwark.notice_draft'` / `'bulwark.compliance_chase'`, `subject_id` = the bulwark row id. **`proposed_payload` is refs-only (SM2):** it carries `{ bulwark_draft_id, deadline_id | compliance_doc_id, contract_id }` and NEVER the clause quote or the notice body, so the platform `proposal_list`/`proposal_decide` tools (gated by platform perms, not `bulwark.notice.draft`) cannot leak drafted text past the owner/admin read floor. The inbox fetches subject/body through the permission-gated `GET /v1/deadlines/:id`. After insert Bulwark emits `publishBoltEvent('proposal.created', 'platform', ...)` mirroring the route (`proposals.routes.ts:114-134`). Those subject types are intentionally not `can_access`-resolvable (Braid D3-4).

### 2.3 What it retrieves / reasons over

- **Extraction:** the contract text from the Bin asset bytes (org-scoped worker context), chunked, plus the org's obligation taxonomy.
- **Firing:** the armed obligations for a job and the durably-inboxed event, matched by `(source, event_type)` and by the binding's `entity_filter` evaluated over the scoping fields carried in the inbox row (Section 3.1 / S5).
- **Compliance:** the vendor tier's `required_doc_types` (recomputed from confirmed `flow_down` obligations, Section 4.4 / D4 / DI5), the collected docs, and the chase cadence.

### 2.4 The single canonical send path, deterministic and kill-switch-safe

One send executor per outbound type, reached two ways (Braid Section 5.4): the REST "approve and send" route calls it directly; a **`proposal.decided` subscription** branches on `decision` (platform contract `approve|reject|request_revision`, `proposals.routes.ts:52-63`), reverse-looks-up the draft via `proposed_payload.bulwark_draft_id`, **re-SELECTs `agent_proposals.status`** to confirm `approved`, resolves the decider, fail-closes that decider through `POST /v1/agent-policies/<decider_id>/check?tool=<send_tool>` (`register-tool.ts`, non-2xx fails closed) AND asserts the decider holds the send permission.

**Deterministic recipient and attachments (THEME E).** The drafting LLM produces ONLY `subject` and `body_markdown`. Every control field is deterministic and computed by Bulwark, never by the model:
- `recipient_id` is always `contract.counterparty_id` (or its Braid-resolved golden id, Section 7.4). A recipient named in clause text is ignored. **`counterparty_id` is nullable (SN1): a null resolved recipient FAILS CLOSED** (the send is blocked and the proposal annotated `recipient_unresolved`), never a clause-named fallback.
- `attachments` is a deterministic allowlist: the source contract asset only, or none. The model cannot add an attachment.
- On send, before attaching, Bulwark calls `preflightAccess(decider, 'bin.asset', attachment_id)` (`visibility.service.ts:1151`) so a decider who cannot see the asset does not exfiltrate it. Any attachment failing the preflight is dropped and the send is annotated.

This closes the prompt-injection exfiltration channel: a malicious clause cannot steer the recipient or attach arbitrary Bin bytes.

Exactly-once on the send is a CAS on the draft row: `UPDATE bulwark_notice_deadlines SET notice_status='sent' WHERE id=$1 AND notice_status='approved' RETURNING id` (and the analogous `chase_status` CAS on compliance docs); the REST-vs-subscription echo no-ops harmlessly (Braid ST-r2-8).

### 2.5 Security model

1. **Reads are permission-tiered AND project-scoped (THEME A + SH3).** `cited_span.quote` is verbatim clause text, `deadline_rule` encodes money/notice terms, `counterparty_id` names the sub. Bulwark defends the ledger two ways: (a) `bulwark.contract.read` and `bulwark.obligation.read` are tiered to **owner/admin only** in the built-in defaults (`0237`, Section 3.4 / S1); (b) every ledger read route (contract list/detail, **obligation list AND detail, deadline list AND detail (the `notice_draft` body), waiver-risk list**, and compliance reads) scopes results to contracts whose `project_id` the caller is a member of, via a single shared list/detail query builder that joins `bulwark_contracts.project_id` and applies the project-membership predicate (`isProjectMember`, `visibility.service.ts:192-207`) with an org-admin override. Section 5.1 annotates every one of these rows "project-scoped" so no implementer ships the review queue unscoped. **Compliance reads (`GET /v1/compliance-docs`, `/vendor-tiers`) are project-scoped through `vendor_tier.contract_id -> contract.project_id`; vendor tiers with a null `contract_id` are owner/admin-only** (SH3).
2. **Writes are ALSO project-scoped (SH1, THEME H).** Every mutating route that takes a bare `obligation_id`/`deadline_id` (`POST /obligations/:id/trigger`, `PATCH /obligations/:id`, `POST /deadlines/:id/discharge`, `/draft-notice`, `/approve-send`) resolves the owning contract and applies the SAME project-membership predicate (org-admin override) BEFORE mutating, because those ids are discoverable org-wide through the ws frames and the Bolt stream. Without this a non-project member could arm, backdate, waive, or retune a clock on a contract they cannot read. The MCP write tools (`bulwark_trigger_obligation`, `bulwark_waive_deadline`, `bulwark_confirm_obligation`, `bulwark_reject_obligation`) carry an explicit `asker_user_id` and fail-closed `can_access`. `POST /trigger` validates `occurred_at` is not in the future and not implausibly backdated (before `contract.effective_date` minus a grace), rejecting or flagging otherwise, so a member cannot backdate straight to `missed`.
3. **Destructive + org-wide-retune routes are owner/admin (SH2).** `bulwark.contract.delete` (cascades and destroys live clocks) and `bulwark.settings.write` (flips `auto_draft_notices`, `notice_llm_daily_cap`, `default_timezone`, shifting every deadline's arithmetic org-wide) are excluded from the member tier in `0237`, matching how the send perms were floored (S7).
4. **Registration preflights the Bin asset (S3).** `POST /v1/contracts` and `/extract` call `preflightAccess(asker, 'bin.asset', bin_asset_id)` and reject `not_found` if denied, before enqueuing; the worker re-checks at byte-read time against `created_by` so a later ACL change is honored.
5. **`/internal/events` fails CLOSED on an empty secret (S4, SN2).** The receiving handler rejects 401 when `INTERNAL_SERVICE_SECRET` is empty/undefined BEFORE any timing-safe compare. This is intentionally **STRONGER than `internal-llm.routes.ts:64`**: because `/internal/events` has a single required secret, an empty-vs-empty compare would authorize an unauthenticated caller, so it rejects unconditionally when the sole secret is empty. An implementer must NOT "align" it to the looser `:64` multi-secret shape.
6. **Extraction input isolation.** The extraction and drafting LLM calls use ONLY the internal llm-provider (`apps/api/src/routes/internal-llm.routes.ts` via `BBB_API_INTERNAL_URL` + `INTERNAL_SERVICE_SECRET`), never a third-party endpoint. Clause/event text is fenced as untrusted DATA in a delimited block (S8); the model is forbidden to emit control fields, and any it emits are dropped (THEME E). Responses are Zod-validated; malformed rows dropped.
7. **`entity_filter.payload_path` is allowlisted to id-typed fields (SM1).** A member holding `bulwark.obligation.write` could otherwise author a binding whose `payload_path` points at a PII field (assignee email, free-text title), which would then persist in `bulwark_ingest_events.scope_fields` past the drain horizon, contradicting refs-only. At bind time and at extraction, `payload_path` is constrained to a curated allowlist of id-typed payload fields, and each captured `scope_fields` value is validated uuid-shaped and dropped if not conforming.
8. **No autonomous send + kill-switch re-check.** The `agent_proposals` choke point plus the decider kill-switch re-check (Section 2.4) means a compromised agent can at worst fill the inbox.
9. **Legally-required mail bypasses marketing suppression (D6).** Compliance chases and contract notices are transactional; they do NOT route through the Blast suppression path (`blast-send.job.ts:330-401` filters `blast_unsubscribes`); they send via the platform's direct transactional path with a `transactional=true` flag that skips `blast_unsubscribes`. Compliance and notice sends do not honor marketing unsubscribes.
10. **Events are org-level refs only.** Bulwark's Bolt events (Section 7) carry ids and magnitudes, never clause text or PII. `bulwark.*` outbound-webhook subscriptions require org-admin authorship. The human freeze control on sends is revoking the send permission (the `agent_policies` kill switch bypasses human deciders, `register-tool.ts:205`, Braid S3-3).
11. **Org scoping (RLS posture, Braid IN-r2-1).** Application-level org-scoping is the enforcing layer; RLS policies on every `bulwark_*` table bind when the platform flips `BBB_RLS_ENFORCE=1`. Section 8 test is application-level, with an optional role-bound RLS test.

### 2.6 Guardrails summary

- **agent_policies**: every `bulwark.*` service-account call passes the kill-switch + `matchesAllowlist('bulwark.*')`; not in the always-permitted core, so fails closed until allowlisted. Re-run by the send subscription (Section 2.4).
- **Per-action MCP resolver:** deferred (basis/braid satellite pattern); `bulwark_*` not in `EXPLICIT_TOOL_OVERRIDES`; the `HAND_AUTHORED` loop is the sole creator of the rows.
- **confirm_action** (Redis dynamic-TTL, `confirm-token-store.ts`): `bulwark_delete_contract`, `bulwark_reject_obligation`, `bulwark_waive_deadline` carry a confirm token at the tool layer.
- **Rate caps (S6):** auto-drafts capped per org per sweep and by a per-org daily ceiling on notice-draft LLM calls; beyond the cap the risk is flagged and drafting deferred; `auto_draft_notices` off by default.
- **can_access preflight** per requesting user on every read AND write that surfaces or mutates a source-scoped record, on registration (S3), and on attachment at send (THEME E).

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
| `project_id` | uuid | FK `projects(id)` ON DELETE SET NULL; the "job". The scoping anchor for read AND write project-membership checks (Section 2.5). A null-job contract holds only manual-trigger or calendar obligations |
| `title` | varchar(512) NOT NULL | |
| `contract_kind` | varchar(32) NOT NULL DEFAULT `'subcontract'` | `subcontract` \| `sow` \| `msa` \| `grant_award` \| `lease` \| `amendment` \| `other` |
| `supersedes_contract_id` | uuid | self-FK (guarded `DO $$`, like `0226_basis_core.sql`); set when `contract_kind='amendment'`; the base it amends |
| `timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA zone for deadline arithmetic (THEME B); defaulted from `bulwark_org_settings.default_timezone` |
| `jurisdiction` | varchar(32) | optional; drives holiday-calendar selection |
| `bin_asset_id` | uuid NOT NULL | the executed document, a `bin.asset` id (no cross-schema FK) |
| `counterparty_type` | varchar(32) | typically `bond.company` |
| `counterparty_id` | uuid | the counterparty; the deterministic notice recipient (THEME E); nullable, and a null fails the send closed (SN1) |
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
| `clause_ref` | varchar(64) | **EVIDENCE, not identity** (DI1/DI2): the human-facing section label from `cited_span.section` (e.g. `"12.3"`), nullable, non-unique |
| `dedup_key` | varchar(64) NOT NULL | **the stable per-obligation upsert/supersession key** (DI1/DI2). Deterministic hash: for numbered clauses, `hash(normalized_clause_ref, obligation_type, normalized_trigger_description)`; for null-section provisions, `hash(verified_quote_content, obligation_type)` tied to `source_doc_hash`. Multiple obligations in one clause get distinct keys because `obligation_type`+trigger differ |
| `supersedes_obligation_id` | uuid | self-FK (guarded `DO $$`) ON DELETE SET NULL; for an amendment obligation, the base obligation it supersedes (DI3), set via `amends_clause_ref` match or reviewer binding at confirm |
| `obligation_type` | varchar(32) NOT NULL | `notice` \| `insurance` \| `indemnity` \| `payment` \| `retention` \| `flow_down` \| `renewal` \| `termination` \| `lien` \| `other` |
| `title` | varchar(512) NOT NULL | |
| `trigger_description` | text | |
| `event_binding` | jsonb NOT NULL DEFAULT `'{}'` | `(source, event_type)` + a **required non-empty `entity_filter` for event-bound arming** (Section 3.3 / STJ5); `payload_path` allowlisted (SM1) |
| `deadline_rule` | jsonb NOT NULL DEFAULT `'{}'` | timezone-anchored rule + optional `recurrence` (Section 3.3, THEME B / DI6) |
| `mandated_doc_types` | jsonb NOT NULL DEFAULT `'[]'` | for `flow_down`: the compliance doc types this clause requires of lower tiers (D4) |
| `cited_span` | jsonb NOT NULL DEFAULT `'{}'` | verified evidence `{ page, section, quote, char_start, char_end, chunk_index, verified }` (Section 3.3, D7) |
| `confidence` | numeric(5,2) | LLM self-reported; drives display auto-confirm only, never auto-arm for the claim-waiving set (D5) |
| `review_status` | varchar(16) NOT NULL DEFAULT `'pending_review'` | `pending_review` \| `confirmed` \| `auto_confirmed` \| `rejected` \| `superseded` (terminal, never deleted, THEME C) |
| `is_armed` | boolean NOT NULL DEFAULT false | true only per the D5 gate AND binding complete AND (for event-bound) a non-empty `entity_filter` AND the contract has a `project_id` |
| `reviewed_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `reviewed_at` | timestamptz | |
| `extraction_run_id` | uuid | FK `bulwark_extraction_runs(id)` ON DELETE SET NULL |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, contract_id, dedup_key)` (the stable per-obligation key, DI1), `(organization_id, contract_id)`, `(organization_id, review_status)`, `(organization_id, obligation_type)`, `(organization_id, is_armed) WHERE is_armed` (also the Redis-gate rebuild source, STJ3), `(supersedes_obligation_id)`, GIN on `event_binding`.

**`bulwark_ingest_events`** - the durable event inbox (THEME D). Every event bolt-api dispatches is persisted here before firing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `source_idempotency_key` | varchar(128) NOT NULL | the redelivery dedup atom: the source-level idempotency key from the payload (`_event_id`, threaded at `event-ingestion.routes.ts:230`) when present, else the bolt event id; a stable upstream key dedups a retried publish, not just a bolt-level redelivery (STJ6) |
| `bolt_event_id` | uuid | the bolt event id, retained for trace |
| `source` | varchar(48) NOT NULL | |
| `event_type` | varchar(96) NOT NULL | |
| `logged_at` | timestamptz NOT NULL | transport/log time |
| `trigger_at` | timestamptz | legal trigger time from the payload if present, else null (THEME B) |
| `scope_fields` | jsonb NOT NULL DEFAULT `'{}'` | the entity_filter-referenced id-typed scoping fields extracted at dispatch, each validated uuid-shaped (SM1); non-conforming values dropped |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `processed` \| `skipped` |
| `received_at` | timestamptz NOT NULL DEFAULT now() | |
| `processed_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, source_idempotency_key)` (redelivery dedup independent of deadline retention, ST4), `(organization_id, status, received_at)` (the scheduled pending-drain scan, STJ2), `(source, event_type)`. Highest-churn table; retention + partitioning posture in the partitioning note.

**`bulwark_notice_deadlines`** - a live deadline instance.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK `bulwark_obligations(id)` **ON DELETE RESTRICT** (THEME C) |
| `contract_id` | uuid NOT NULL | FK `bulwark_contracts(id)` ON DELETE CASCADE |
| `ingest_event_id` | uuid | FK `bulwark_ingest_events(id)` ON DELETE SET NULL |
| `triggering_event_id` | uuid NOT NULL | dedup key: `source_idempotency_key`-derived uuid for event-armed; for calendar-armed, `uuid5(obligation_id || anchor_date)` (recomputed to the successor on re-point, STJ4); for manual, `uuid5(obligation_id || occurred_at)` |
| `anchor_source` | varchar(12) NOT NULL | `trigger_at` \| `logged_at` \| `manual` \| `calendar` (THEME B) |
| `triggered_at` | timestamptz NOT NULL | the legal anchor time used |
| `logged_at` | timestamptz | transport time, kept for reviewer correction |
| `resolved_timezone` | varchar(64) NOT NULL | the IANA zone the due date was computed in |
| `due_at` | timestamptz NOT NULL | deterministic, computed in `resolved_timezone` with roll-forward (Section 4.2) |
| `status` | varchar(16) NOT NULL DEFAULT `'open'` | `open` \| `discharged` \| `missed` \| `waived` \| `voided` (a base clock closed by a termination amendment, DI3) |
| `notice_status` | varchar(16) NOT NULL DEFAULT `'none'` | `none` \| `drafted` \| `approved` \| `sent` \| `discarded` |
| `notice_proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL |
| `notice_draft` | jsonb NOT NULL DEFAULT `'{}'` | ONLY `subject` + `body_markdown`; recipient/attachments deterministic at send (THEME E) |
| `discharged_at` | timestamptz | |
| `radar_marker` | timestamptz | outbox marker: observed sweep time (never `now()` mid-compute, Braid ST3-1) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, obligation_id, triggering_event_id)` (the single at-most-once arm guard), `(organization_id, status, due_at)` (radar scan), `(organization_id, contract_id)`, `(notice_proposal_id)`, `(organization_id, notice_status)`.

**`bulwark_waiver_risks`** - a flagged risk.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `obligation_id` | uuid NOT NULL | FK ON DELETE RESTRICT (audit protection, D3) |
| `deadline_id` | uuid | FK `bulwark_notice_deadlines(id)` ON DELETE SET NULL (never cascade-delete a risk, D3) |
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
| `contract_id` | uuid | parent contract; FK ON DELETE SET NULL; the compliance-read scoping anchor (SH3) |
| `parent_tier_id` | uuid | self-FK (guarded `DO $$`) ON DELETE SET NULL; the tier this one flows down from (D4) |
| `vendor_type` | varchar(32) | typically `bond.company` |
| `vendor_id` | uuid | |
| `tier_level` | smallint NOT NULL DEFAULT 1 | 1 = direct sub, 2+ = sub-sub |
| `required_doc_types` | jsonb NOT NULL DEFAULT `'[]'` | RECOMPUTED from scratch each sweep (DI5) from confirmed `flow_down` obligations of `contract_id` UNION `parent_tier_id.required_doc_types` |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'idle'` | `idle` \| `chasing` \| `compliant` \| `blocked` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, contract_id)`, `(organization_id, chase_status)`, `(parent_tier_id)`, `UNIQUE (organization_id, contract_id, vendor_type, vendor_id)`.

**`bulwark_compliance_docs`** - one required/collected doc. Validity and collection lifecycle are separated (D9).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `vendor_tier_id` | uuid NOT NULL | FK `bulwark_vendor_tiers(id)` ON DELETE CASCADE |
| `doc_type` | varchar(24) NOT NULL | `coi` \| `w9` \| `lien_waiver` \| `certified_payroll` \| `other` |
| `collection_status` | varchar(16) NOT NULL DEFAULT `'missing'` | `missing` \| `requested` \| `collected` (D9) |
| `validity_status` | varchar(12) NOT NULL DEFAULT `'unknown'` | `unknown` \| `valid` \| `expiring` \| `expired` (D9) |
| `chase_status` | varchar(16) NOT NULL DEFAULT `'none'` | `none` \| `drafted` \| `approved` \| `sent` \| `escalated` |
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
| `last_processed_chunk` | integer NOT NULL DEFAULT -1 | checkpoint: a retry resumes at `last_processed_chunk + 1` (ST6) |
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
| `default_timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA (THEME B) |
| `auto_confirm_threshold` | numeric(5,2) NOT NULL DEFAULT 0.95 | display-only auto-confirm floor; never gates auto-arm for the claim-waiving set (D5) |
| `radar_lead_times` | jsonb NOT NULL DEFAULT `'{"critical_hours":24,"high_hours":72,"medium_hours":168}'` | |
| `auto_draft_notices` | boolean NOT NULL DEFAULT **false** | off by default (D5); capped per S6 when on |
| `auto_draft_max_per_sweep` | integer NOT NULL DEFAULT 20 | S6 cap |
| `notice_llm_daily_cap` | integer NOT NULL DEFAULT 100 | S6 per-org daily ceiling |
| `chase_cadence_days` | integer NOT NULL DEFAULT 7 | |
| `coi_expiry_lead_days` | integer NOT NULL DEFAULT 30 | |
| `discharged_deadline_retention_days` | integer NOT NULL DEFAULT 365 | retention floor for discharged deadlines (STJ7) |
| `inbox_retention_days` | integer NOT NULL DEFAULT 400 | **enforced `>= discharged_deadline_retention_days`** so a late redelivery cannot re-arm (STJ7) |
| `llm_provider_id` | uuid | extraction/drafting model; null falls back to org default |
| `last_radar_sweep_at` | timestamptz | advanced only after a fully successful sweep (Braid ST-r2-7) |
| `updated_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**Partitioning posture (ST9 / IN6).** `bulwark_ingest_events` is the **highest-churn** table (a row per forwarded event for every org binding a chatty type like `task.updated`), DELETE-retained. It is the first candidate for **monthly partitioning per `0220_blip_entries_partitioned.sql`**, the named fast-follow trigger when a large org's event volume warrants it. `bulwark_notice_deadlines` and `bulwark_waiver_risks` are lower-churn (discharged-only retention, Section 4.5); unpartitioned in v1 is acceptable at the 2-50 seat SMB target, with the same monthly-partition pattern as their scale fast-follow.

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): `bulwark.contract -> bond.company`, `bulwark.contract -> bin.asset`, `bulwark.vendor_tier -> bond.company` (`ON CONFLICT DO NOTHING`).
- `agent_proposals` (`0128_agent_proposals.sql`): notice/chase drafts, `approver_id=NULL`, `expires_at` set, `proposed_payload` refs-only (SM2).
- `organizations`, `users`, `projects`, `actor_type` enum.
- `bin_assets` (`0205_bin_dam.sql`): read-only, `can_access`-preflighted.
- `llm_providers`: extraction/drafting model, only via `POST /internal/llm/chat`.
- A **bolt-api sending-end dispatch outbox** (STJ1, Section 6): a new small durable table in bolt-api's schema (not a `bulwark_*` table), drained with retry/backoff on the `agent-webhook-dispatch.job.ts` model. Owned by the Bolt maintainers; see Open Question 1.

### 3.3 JSONB shapes (authoritative)

```jsonc
// bulwark_obligations.event_binding (STJ5: entity_filter non-empty required to arm an event-bound obligation; SM1: payload_path allowlisted)
{
  "source": "bam",
  "event_type": "task.overdue",
  "entity_filter": {                      // REQUIRED and non-empty for event-bound arming; firing FAILS CLOSED on absent path (S5)
    "payload_path": "task.project_id",    // allowlisted id-typed field only (SM1)
    "equals_contract_field": "project_id"
  },
  "unbound": false
}

// bulwark_obligations.deadline_rule (THEME B + DI6 recurrence)
{
  "offset_days": 5,
  "unit": "calendar_days",                // calendar_days | business_days
  "from": "trigger_event",                // trigger_event | contract_effective_date | contract_expiry_date
  "timezone": "America/Los_Angeles",      // IANA
  "jurisdiction": "US-CA",                // optional
  "holiday_calendar": "us-federal",       // optional
  "roll_forward": true,
  "grace_hours": 0,
  "recurrence": { "interval": "annual", "until": null }   // optional (DI6); null/absent = single occurrence
}

// bulwark_obligations.cited_span (D7)
{
  "page": 7, "section": "12.3",
  "quote": "Subcontractor shall give written notice within five (5) days ...",
  "char_start": 18442, "char_end": 18571, "chunk_index": 3,
  "verified": true                        // source_text.slice(start,end) fuzzy-matched quote, tied to source_doc_hash
}

// bulwark_notice_deadlines.notice_draft (THEME E)
{
  "subject": "Notice of Delay - [contract.title]",
  "body_markdown": "…untrusted text only…"
  // recipient_id and attachments are NOT here; deterministic, stamped by Bulwark at send
}
```

### 3.4 Numbered, idempotent migration plan (numbers PROVISIONAL)

Observed tip is `0233_braid_builtin_group_defaults.sql`; latest permissions delta is `0232_permissions_seed_actions_delta_021.sql`. Numbers provisional. Every file carries the header block and idempotent DDL.

1. **`0234_bulwark_core.sql`** - `bulwark_contracts` (self-FK, `timezone`, `jurisdiction`), `bulwark_obligations` (incl. `dedup_key` NOT NULL + its unique index, `supersedes_obligation_id` self-FK, `mandated_doc_types`, `superseded` status), `bulwark_ingest_events` (folded here per the round-1 numbering, incl. `source_idempotency_key` unique), `bulwark_notice_deadlines` (obligation FK **ON DELETE RESTRICT**, contract FK CASCADE, single unique arm index, `voided` status), `bulwark_waiver_risks`, `bulwark_extraction_runs` (incl. `last_processed_chunk`), `bulwark_org_settings` (incl. retention floors), all indexes, RLS. Additive only.
2. **`0235_bulwark_compliance.sql`** - `bulwark_vendor_tiers` (incl. `parent_tier_id` self-FK), `bulwark_compliance_docs` (split statuses), indexes, RLS. Additive only.
3. **`0236_permissions_seed_actions_delta_022.sql`** - **generated**. The `bulwark.*` rows are hand-authored (`bulwark_` not in `APP_PREFIXES`). Strict sequence (THEME F: the codegen step is the exact Braid gap and is explicit):
   - (a) land `0234`/`0235` on disk;
   - (b) register the **12** `bulwark.*` rows (Section 10) in the `HAND_AUTHORED` array of `generate-permission-manifest.mjs`, each with explicit `app:'bulwark'` and an explicit `is_read`;
   - (c) add an `if (c.id.startsWith('bulwark.')) { migrationLabel = '<this delta>'; sourceFile = 'bulwark route/tools'; }` provenance branch;
   - (d) do NOT add `bulwark_*` to `EXPLICIT_TOOL_OVERRIDES`;
   - (e) run `node scripts/generate-permission-manifest.mjs` (writes `docs/permissions-action-manifest.json`) **then `node scripts/build-permission-codegen.mjs`** (the only writer of `packages/permissions/src/generated/permissions.ts`, consumed by the resolver + `useCan`) and **COMMIT the regenerated `permissions.ts`**;
   - (f) run `check-permission-catalog.mjs` (re-runs codegen in a temp dir, diffs the committed `permissions.ts`; passes only because (e) committed it);
   - (g) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number/suffix. The emitted delta MUST contain only additive `bulwark.*` rows; strip any proposed removal/deactivation of unrelated rows before landing (BP4). Additive only.
4. **`0237_bulwark_builtin_group_defaults.sql`** (the file **immediately after the generated delta**, `NNNN+1`; if an unrelated migration lands first the delta shifts and this follows it, BP9; the `0237` cited in Sections 2.5/5.3/10 is illustrative). Backfills `bulwark.*` into the built-in role matrix, modeled on `0233_braid_builtin_group_defaults.sql` with a **custom tiering** (THEME A / S7 / SH2): owner/admin get all `bulwark.*` (`NOT requires_superuser`); **member gets all EXCEPT `bulwark.contract.read`, `bulwark.obligation.read`, `bulwark.notice.draft`, `bulwark.compliance.chase`, `bulwark.contract.delete`, `bulwark.settings.write`**; viewer gets `is_read AND NOT requires_superuser` EXCEPT `bulwark.contract.read`/`bulwark.obligation.read`; guest none. `INSERT ... ON CONFLICT DO NOTHING`. Additive only.

Bolt event registration (Section 7), the bolt-api dispatch-hook + sending-outbox edits (Section 6), and any `SUPPORTED_ENTITY_TYPES` additions are TypeScript/bolt-api edits.

---

## 4. The engines

Both engines run as BullMQ workers in `apps/worker`, matching `braid-*.job.ts` / `basis-metric-snapshot.job.ts`.

### 4.1 Obligation-extraction engine

**Trigger.** `POST /v1/contracts` or `POST /contracts/:id/extract` enqueues `bulwark-extract-obligations { org_id, contract_id }`, AFTER the route `can_access`-preflighted the Bin asset for the caller (S3).

**Pipeline:**
1. **Preflight + fetch.** The worker re-checks `preflightAccess(created_by, 'bin.asset', bin_asset_id)` (S3), then reads bytes via `@bigbluebam/storage` `getStream` (Section 9.2 commits the byte path). Extract text (PDF text layer; scanned docs yield zero obligations and are flagged, Section 12). Compute `source_doc_hash`.
2. **Hash-skip is conditional (ST6).** Skip only when `source_doc_hash` is unchanged AND the last `bulwark_extraction_runs.status='succeeded'`. A `partial`/`failed` prior run never skips; it resumes.
3. **Chunk + checkpoint.** Overlapping page/section-anchored chunks. A run persists `last_processed_chunk`; a retry resumes at the next chunk (ST6). Per-chunk progress logged via `@bigbluebam/logging` (flushed).
4. **Extract per chunk.** Call `POST /internal/llm/chat` with the untrusted chunk fenced in a delimited DATA block (S8), demanding strict JSON. Parse and Zod-validate; drop malformed rows.
5. **Deterministic post-processing.**
   - **Verify the citation (D7):** check `source_text.slice(char_start, char_end)` fuzzy-matches `quote`; snap or mark `verified=false` and force `pending_review`. Verified offsets tied to `source_doc_hash`.
   - **Normalize the clause label + compute `dedup_key` (DI1/DI2):** deterministically normalize `clause_ref` (strip prefixes/punctuation such as "S"/"Section"/"12.03", canonicalize numbering) as EVIDENCE, then compute `dedup_key` = `hash(normalized_clause_ref, obligation_type, normalized_trigger_description)` for numbered clauses, or `hash(verified_quote_content, obligation_type)` tied to `source_doc_hash` for null-section provisions. Distinct obligations in one clause get distinct keys because type+trigger differ.
   - **Parse the deadline (THEME B):** parse into the typed `deadline_rule`, stamping `timezone` from the contract. Parser-vs-model disagreement does not clear the deterministic-arm gate (D5).
   - **Map the trigger + require a filter (STJ5):** map to a real `(source, event_type)` via a curated alias table; an unmapped trigger sets `unbound=true`; a mapped trigger with no derivable non-empty `entity_filter` is confirmable but cannot arm as event-bound (it stays manual/calendar).
6. **Persist by `dedup_key` (DI1/DI2 / THEME C / ST6).** Upsert `bulwark_obligations` on `(organization_id, contract_id, dedup_key)`. **Numbered-clause** obligations present in a prior run but absent now transition to `superseded` (never deleted). **Null-section (content-hash) obligations are NEVER auto-superseded by mere absence** (a reworded quote drifts the hash); they retire only by explicit human action. Rows clearing the D5 gate may `auto_confirmed`+`is_armed` per the type rules; the claim-waiving set stays `pending_review`. Write the run audit; set `contract.extraction_status`. Emit `obligation.extracted` and, on completion, `contract.extracted`.

**Amendment / supersession (THEME C + DI3).** An amendment is a NEW Bin asset registered with `contract_kind='amendment'` and `supersedes_contract_id` set. Supersession does NOT assume the amendment reuses base clause numbers (it carries its own numbering). Two mechanisms set each amendment obligation's `supersedes_obligation_id`:
- **`amends_clause_ref` extraction (best-effort):** the extraction prompt captures the base-section reference named in the amendment prose ("Section 12.3 is hereby amended/deleted"), matched to the base obligation whose normalized `clause_ref` equals it.
- **Reviewer binding at confirm (HITL, authoritative):** the review UI lets a human bind each amendment obligation to the base obligation it supersedes, and choose an outcome: **restate** (base -> `superseded`, open deadlines **re-pointed** to the successor in one transaction) or **terminate** (base -> `superseded`, open deadlines set `status='voided'` with a reason, preserving audit, DI3). A deletion clause that produces no amendment obligation is surfaced as a review item so the base is not left firing a dead clause.

**Calendar re-point key fix (STJ4).** When open deadlines are re-pointed to a successor obligation, **calendar-armed** deadlines have their `triggering_event_id` recomputed to `uuid5(successor_obligation_id || anchor_date)` inside the re-point transaction, guarded `ON CONFLICT (organization_id, obligation_id, triggering_event_id) DO NOTHING` against an already-armed successor calendar deadline (drop the loser). This prevents the next radar tick minting a duplicate `uuid5(successor || date)` renewal deadline. Event-armed deadlines keep their `source_idempotency_key`-derived id (obligation-independent, re-point safe).

**Where it runs.** Queue `bulwark-extract-obligations`, BullMQ `attempts` + exponential backoff + DLQ. Bounded `AbortController` on LLM calls.

### 4.2 Event-binding + firing engine (inbox drain)

**Transport in (Section 6).** bolt-api forwards subscribed events to `POST ${BULWARK_API_INTERNAL_URL}/v1/internal/events` (THEME G: container-internal target, matching `braid-dispatch-hook.ts:73-75`). The route (a) fails closed if `INTERNAL_SERVICE_SECRET` is empty (S4/SN2), (b) durably INSERTs a `bulwark_ingest_events` row `ON CONFLICT (organization_id, source_idempotency_key) DO NOTHING` (THEME D / STJ6), extracting `trigger_at`, and `scope_fields` (uuid-validated, SM1), then (c) enqueues `bulwark-fire-on-event { org_id, ingest_event_id }`.

**Firing job (`bulwark-fire-on-event`), an inbox drain:**
1. Load the `bulwark_ingest_events` row (or the scheduled pending-drain feeds it, Section 4.3). Skip if `processed`.
2. Select armed obligations for the org whose binding `(source, event_type)` matches.
3. **Evaluate `entity_filter`, FAIL CLOSED (S5).** An armed event-bound obligation always has a non-empty `entity_filter` (STJ5), so an event with no matching `scope_fields` path arms zero deadlines; a filter never over-fires org-wide.
4. **Choose the legal anchor (THEME B).** `anchor = trigger_at` if present, else `logged_at`, recording `anchor_source`.
5. **Compute `due_at` in the resolved timezone (THEME B).** Interpret the anchor in `deadline_rule.timezone`, add the offset in calendar or business days, apply `roll_forward`, convert to timestamptz.
6. Insert a `bulwark_notice_deadline` `ON CONFLICT (organization_id, obligation_id, triggering_event_id) DO NOTHING` (at-most-once). Mark the inbox row `processed`. **Publish the `deadline.armed` ws frame on ANY conflict-free deadline insert regardless of arm path (BP10)** (event drain, radar calendar, manual trigger), refs-only (Section 5.2 / 7.1).

**Manual trigger, interaction defined (D8 / DI7).** `POST /v1/obligations/:id/trigger { occurred_at }` is **restricted to obligations that are `unbound` OR whose contract has no `project_id`** (the genuine safety-net cases), so it cannot double-arm an event-armable obligation under the disjoint-id-space unique index. It arms a deadline with `anchor_source='manual'`, `triggering_event_id = uuid5(obligation_id || occurred_at)`. The route is project-scoped and validates `occurred_at` plausibility (SH1).

Idempotency/retry/backoff/DLQ mirror extraction. Capture-the-version discipline: `triggering_event_id` makes re-processing a no-op; `radar_marker` stamps the observed sweep time, never `now()`.

### 4.3 The deadline-radar sweep (also the pending-inbox drain, STJ2)

Queue `bulwark-radar-sweep`, every 15 minutes. Per org, under a **per-org advisory lock** (ST5):
0. **Pending-inbox drain (STJ2).** Scan `bulwark_ingest_events WHERE status='pending' AND received_at < now() - interval` and re-enqueue / directly run the firing logic, so an inbox row whose BullMQ enqueue was lost (a Redis hiccup) is still processed. The radar is the named owner of the scheduled pending-drain.
1. **Approaching / risk.** Scan `open` deadlines by `due_at`; map hours-remaining to `severity` via `radar_lead_times`; upsert `waiver_risk` `ON CONFLICT DO NOTHING`. Emit `deadline.approaching` / `waiver.risk_detected`.
2. **Auto-draft, CAS-guarded and capped (ST5 / S6 / D5).** Only when `auto_draft_notices` (off by default), the obligation type is `notice`, the risk reached `high`, and the caps are not exhausted. CAS `UPDATE bulwark_notice_deadlines SET notice_status='drafted' WHERE id=$1 AND notice_status='none' RETURNING id`; only the winner drafts. Render ONLY `subject`+`body_markdown`, insert an `agent_proposals` row with a refs-only `proposed_payload` (SM2), set `notice_proposal_id`, emit `notice.drafted`. Beyond the caps, flag and defer.
3. **Missed.** `open` deadlines past `due_at` flip to `missed` and raise a `critical`/`overdue` `waiver_risk`. Retained indefinitely (D3).
4. **Calendar obligations (ST7 + DI6).** For `renewal`/`termination` obligations, compute the anchor date from the contract dates and arm with `triggering_event_id = uuid5(obligation_id || anchor_date)`. When `deadline_rule.recurrence` is set (DI6), roll the anchor forward per `interval` (bounded by `until`/`expiry`) so year N and year N+1 both arm through the single unique index; a non-recurring calendar obligation arms exactly once. Publish `deadline.armed` on the conflict-free insert (BP10).

`last_radar_sweep_at` advances only after a fully successful tick.

### 4.4 The compliance-chase sweep + flow-down linkage

Queue `bulwark-coi-chase`, daily 04:30. Per org:
1. **Flow-down recompute (D4 / DI5).** The sweep **recomputes `required_doc_types` from scratch each run**, processing tiers in `tier_level` ASCENDING order so parents settle before children: a tier's set = `union(mandated_doc_types of the contract's confirmed flow_down obligations, parent_tier.required_doc_types)`. Recompute-from-scratch means a rejected/superseded `flow_down` obligation automatically drops its doc types (removal is not a special case); intra-day staleness is acceptable.
2. **Validity sweep (D9).** Mark `validity_status='expiring'` where `expires_at <= now() + coi_expiry_lead_days`, `expired` where past. Emit `compliance.expiring` on transition.
3. **Chase draft.** For docs `missing`/`expiring`/`expired` whose `last_chased_at` is older than `chase_cadence_days`, CAS `chase_status none->drafted`, render a chase draft, insert an `agent_proposals` row (`proposed_action='bulwark.chase_compliance_doc'`, refs-only payload), bump `last_chased_at`. The Blast/Blank send executes only on approve and is **transactional (bypasses `blast_unsubscribes`)** (D6).
4. Roll `vendor_tier.chase_status` up (`compliant` when all required docs `valid`).

### 4.5 State-reconcile, proposal-reconcile, gate-reconcile, retention, and jobs summary

**`bulwark-state-reconcile` (STJ1, the braid-rescan analog).** Scheduled (every 30 min). Per org, for each armed obligation whose binding is a **state-reflecting** type (a curated set where the trigger corresponds to a queryable persistent condition: `bam:task.overdue` reflects a task past `due_at` still `open`; a Bill invoice overdue; a compliance doc near expiry), re-query the source table (directly via `DATABASE_URL`) for rows currently satisfying the condition AND matching the obligation's `entity_filter` scope, and arm any deadline not already armed (the at-most-once unique guard makes it safe). This recovers a dispatch dropped on the bolt-api hop for the majority of beachhead bindings, because they reflect state rather than a one-shot event. Genuinely transient bindings (no persistent source row) are NOT covered here and depend on the bolt-api sending-end outbox (Open Question 1). Uses a per-obligation source watermark; per-N progress logging.

**`bulwark-proposal-reconcile` (ST5, modeled on `braid-proposal-reconcile.job.ts`).** Every 10 minutes. For each `agent_proposals` row `proposed_action IN ('bulwark.send_notice','bulwark.chase_compliance_doc')` whose linked draft is still `drafted`/`none`: on `approved` re-derive the original decider, re-check the kill-switch, drive the send CAS; on `rejected` mark the draft `discarded`; on `expired` clear the proposal ref and reset the status to `none` so the radar re-drafts. An unmet notice re-surfaces, never orphans.

**Redis gate-reconcile (STJ3).** The per-org `bulwark:bindings:<org_id>` set is a **cache over the durable `bulwark_obligations(is_armed, event_binding)` table, never the record**. It is rebuilt at bulwark-api boot AND on the state-reconcile cadence from `SELECT DISTINCT source, event_type FROM bulwark_obligations WHERE is_armed` per org (index `(organization_id, is_armed) WHERE is_armed`), so a Redis flush cannot permanently drop triggers. An arm operation **fails if `SADD` does not confirm** (the arm is not committed as armed until the gate reflects it), so a failed `SADD` never silently drops future triggers.

**Retention (D3 / ST4 / STJ7).** `bulwark-retention` (daily 04:50) purges ONLY `status='discharged'` deadlines older than `discharged_deadline_retention_days`, and prunes `bulwark_ingest_events` older than `inbox_retention_days`. The settings enforce `inbox_retention_days >= discharged_deadline_retention_days`, and the job **computes the deadline purge cutoff from the inbox floor in the same run** so the two can never invert and let a late redelivery re-arm a purged clock. `missed`/`waived`/`voided` deadlines and ALL `waiver_risks` are kept indefinitely (the dispute record). `bulwark_extraction_runs`, `bulwark_contracts`, `bulwark_obligations` are never purged.

| Queue / job | Schedule | Purpose |
| --- | --- | --- |
| `bulwark-extract-obligations` | event-driven | Bin bytes -> chunk (checkpointed) -> llm-provider -> verified-cited obligations by `dedup_key`; supersession-aware. |
| `bulwark-fire-on-event` | event-driven (inbox drain) | entity_filter fail-closed, timezone-anchored `due_at`, at-most-once arm. |
| `bulwark-radar-sweep` | every 15 min | Pending-inbox drain (STJ2), risk detection, CAS-guarded capped auto-draft, missed detection, calendar/recurring obligations; per-org advisory lock. |
| `bulwark-state-reconcile` | every 30 min | Re-derive clocks from queryable source state for state-reflecting bindings (STJ1); rebuild the Redis gate (STJ3). |
| `bulwark-coi-chase` | daily 04:30 | Flow-down recompute (ascending tiers), validity sweep, transactional chase drafts. |
| `bulwark-proposal-reconcile` | every 10 min | At-least-once send bridge + expired-proposal re-draft. |
| `bulwark-retention` | daily 04:50 | Purge only discharged deadlines + inbox past the coupled floor; keep missed/waived/voided/risks forever. |

Seven jobs (round 1 had six; `bulwark-state-reconcile` is added and the pending-inbox drain is folded into the radar sweep). All fan-out sets `app.current_org_id` per org and wraps each `(org, row)` in try/catch log-and-continue.

---

## 5. API surface

Base path `/bulwark/api/`, routes under `/v1` (mirroring `apps/basis-api/src/server.ts:88`). Success `{ data }`; errors the canonical envelope from `@bigbluebam/logging` `createErrorHandler` (`basis-api/src/server.ts:28`). Cursor pagination, `?filter[field]=value`, `?sort=-field`. Shapes in `packages/shared/src/schemas/bulwark.ts`.

### 5.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/contracts` | List tracked contracts | `bulwark.contract.read` (owner/admin floor); project-scoped |
| POST | `/v1/contracts` | Register from a Bin asset; enqueues extraction | `bulwark.contract.write`; **`can_access('bin.asset')` preflight (S3)** |
| GET | `/v1/contracts/:id` | Contract detail + rollup | `bulwark.contract.read`; **project-scoped**; cited source records `can_access`-filtered |
| PATCH | `/v1/contracts/:id` | Update metadata (incl. `timezone`) | `bulwark.contract.write`; **project-scoped** |
| DELETE | `/v1/contracts/:id` | Delete a tracked contract (not the Bin asset) | `bulwark.contract.delete` (owner/admin floor, SH2); confirm token via MCP; cascades deadlines |
| POST | `/v1/contracts/:id/extract` | Re-run extraction | `bulwark.contract.write`; **project-scoped**; hash-skip conditional (ST6); Bin preflight (S3) |
| GET | `/v1/contracts/:id/obligations` | Ledger for a contract | `bulwark.obligation.read`; **project-scoped** |
| GET | `/v1/obligations` | List (review queue via `filter[review_status]=pending_review`) | `bulwark.obligation.read`; **project-scoped (SH3)**; surfaces `cited_span.quote`+`deadline_rule`; sort `-confidence` |
| GET | `/v1/obligations/:id` | Detail + verified `cited_span` | `bulwark.obligation.read`, `asker_user_id`; **project-scoped (SH3)** |
| PATCH | `/v1/obligations/:id` | Confirm / edit / bind / reject / bind-to-base | `bulwark.obligation.write`; **project-scoped (SH1)**; `rejected` needs confirm token; confirming a `flow_down` seeds vendor `required_doc_types`; binds `supersedes_obligation_id` for amendments (DI3) |
| POST | `/v1/obligations/:id/trigger` | **Manual trigger** (unbound / no-project only, DI7) | `bulwark.deadline.write`; **project-scoped (SH1)**; `occurred_at` plausibility validated |
| GET | `/v1/deadlines` | Deadline radar | `bulwark.deadline.read`; **project-scoped**; filters `status`, `contract_id`, `due_before`, `project_id` |
| GET | `/v1/deadlines/:id` | Detail + drafted notice body | `bulwark.deadline.read`; **project-scoped (SH3)** |
| POST | `/v1/deadlines/:id/draft-notice` | Draft/re-draft + register proposal | `bulwark.notice.draft` (owner/admin floor); **project-scoped (SH1)** |
| POST | `/v1/deadlines/:id/approve-send` | Approve+send directly (UI) | `bulwark.notice.draft`; **project-scoped (SH1)**; single send executor + CAS + deterministic recipient/attachment preflight (THEME E) |
| POST | `/v1/deadlines/:id/discharge` | Mark discharged/waived | `bulwark.deadline.write`; **project-scoped (SH1)**; waive requires confirm token |
| GET | `/v1/waiver-risks` | Open waiver risks | `bulwark.deadline.read`; **project-scoped**; sort `-severity` |
| GET | `/v1/vendor-tiers` | List vendor tiers | `bulwark.compliance.read`; **project-scoped via `contract_id` (SH3)**; null-contract tiers owner/admin-only |
| POST | `/v1/vendor-tiers` | Add a tier (seeds `required_doc_types`) | `bulwark.compliance.chase`; **project-scoped (SH1)** |
| GET | `/v1/compliance-docs` | Vendor compliance matrix | `bulwark.compliance.read`; **project-scoped via `vendor_tier.contract_id` (SH3)** |
| POST | `/v1/compliance-docs/:id/chase` | Draft a chase + register proposal | `bulwark.compliance.chase` (owner/admin floor); **project-scoped (SH1)** |
| POST | `/v1/compliance-docs/:id/approve-send` | Approve+send directly (UI) | `bulwark.compliance.chase`; **project-scoped**; transactional send (D6) + CAS |
| GET | `/v1/settings` | Get org settings | `bulwark.settings.read` |
| PATCH | `/v1/settings` | Update org settings | `bulwark.settings.write` (owner/admin floor, SH2) |
| POST | `/v1/internal/events` | Ingest-trigger from bolt-api | `INTERNAL_SERVICE_SECRET`, **reject unconditionally when the sole secret is empty (S4/SN2)**; persists to `bulwark_ingest_events`, enqueues drain; no public route, no MCP tool |
| GET | `/health` / `/readyz` | Probes | `@bigbluebam/service-health`; `/readyz` checks ONLY Postgres + Redis |

The shared list/detail query builder enforces the `bulwark_contracts.project_id` join + `isProjectMember` predicate (org-admin override) for every route annotated "project-scoped," and the shared mutating-route guard applies the same before any write (SH1/SH3).

### 5.2 Realtime (`/bulwark/ws`)

Redis-PubSub, org-scoped rooms, refs-only. Frames: `deadline.armed { deadline_id, obligation_id, due_at }` (published on ANY conflict-free deadline insert regardless of arm path, BP10), `waiver.risk_detected { risk_id, severity, contract_id }`, `notice.drafted { deadline_id, proposal_id }`, `compliance.expiring { compliance_doc_id, vendor_tier_id }`. No clause text or PII. Modeled on `apps/basis-api` / `apps/bin-api` ws routes + Redis PubSub cross-instance broadcast.

### 5.3 Permissions (12 rows)

Manifest-generated `app.resource.verb`, resolved by a `basis-api/src/plugins/permissions.ts`-style plugin. Enumerated in Section 10. Owner/admin floors in `0237`: `bulwark.contract.read`, `bulwark.obligation.read`, `bulwark.notice.draft`, `bulwark.compliance.chase`, `bulwark.contract.delete`, `bulwark.settings.write` (S1/S7/SH2). Registration sequence is Section 3.4 step 3 (incl. the codegen step, THEME F).

---

## 6. Background work and the ingest transport

BullMQ workers in `apps/worker` (Section 4.5). Firing durability is layered (THEME J):

**bolt-api dispatch hook + sending-end outbox (STJ1).** Bulwark adds a `bulwark-dispatch-hook.ts` in bolt-api, called alongside `dispatchToBraid` in `apps/bolt-api/src/routes/event-ingestion.routes.ts`, that forwards matching events to `${BULWARK_API_INTERNAL_URL}/v1/internal/events` (THEME G: container-internal target `http://bulwark-api:4021`, matching `braid-dispatch-hook.ts:73-75`). The bare `void dispatch(...).catch()` at `event-ingestion.routes.ts:165` is fire-and-forget and can silently drop a transient event if bulwark-api is mid-deploy/blipped. To make delivery durable at the SENDING end, bolt-api persists a small durable **dispatch-outbox row** for every Bulwark-gated event in the same transaction as ingest, and a bolt-api drain job retries it with backoff + DLQ on the `agent-webhook-dispatch.job.ts` / `agent-webhook-dlq.job.ts` model already in the repo. This is a **bolt-api change owned by the Bolt maintainers** (Open Question 1); until it ships, transient-only bindings degrade to the manual-trigger net, and state-reflecting bindings are already covered by `bulwark-state-reconcile` (Section 4.5). The spec does not claim guaranteed end-to-end delivery without the outbox.

**Per-org, per-binding dispatch gate, durably rebuildable (ST8 / STJ3).** The gate is keyed per org: on every obligation arm/disarm Bulwark writes/removes `bulwark:bindings:<org_id> <source>:<event_type>`, and the arm fails if `SADD` does not confirm. The dispatch hook does a `SISMEMBER bulwark:bindings:<event.org_id>` for the event's OWN org before forwarding. The set is a **cache over the durable `bulwark_obligations` table**, rebuilt at boot and on the state-reconcile cadence, so a Redis flush cannot permanently drop triggers.

**Receiving durability + scheduled drain (THEME D / STJ2).** `/v1/internal/events` persists every accepted event into `bulwark_ingest_events` before firing (dedup on `source_idempotency_key`, STJ6), and both the event-driven firing job and the radar's scheduled pending-drain (Section 4.3 step 0) process pending rows, so a lost BullMQ enqueue after a successful INSERT is recovered. A live-2xx smoke test asserts the dispatch target resolves and returns 2xx (THEME G).

**Worker env.** Add `BBB_API_INTERNAL_URL: http://api:4000` (extraction + drafting llm-provider) to the worker compose env and `worker.optional`. Byte reads via `@bigbluebam/storage` (Section 9.2 / IN3). No source-app internal URLs beyond that.

---

## 7. Events & integration

### 7.1 Bolt events published (source `bulwark`)

Via `publishBoltEvent(eventType, 'bulwark', payload, orgId, actorId?, actorType?)` (positional, `packages/shared/src/bolt-events.ts:35`), bare names, each registered in a new `bulwarkEvents` block in `apps/bolt-api/src/services/event-catalog.ts` or `scripts/check-bolt-catalog.mjs` fails CI. Refs + magnitude only.

| `event_type` | When | Payload (refs only) |
| --- | --- | --- |
| `contract.extracted` | an extraction run completes | `contract.id`, `obligations_extracted`, `low_confidence_count`, `org.id` |
| `obligation.extracted` | a new obligation is persisted | `obligation.id`, `contract.id`, `obligation_type`, `confidence`, `review_status`, `org.id` |
| `deadline.approaching` | radar detects a clock nearing due | `deadline.id`, `obligation.id`, `contract.id`, `due_at`, `hours_remaining`, `org.id` |
| `waiver.risk_detected` | a new waiver risk is raised | `risk.id`, `obligation.id`, `contract.id`, `severity`, `reason`, `org.id` |
| `notice.drafted` | a notice draft + proposal is created | `deadline.id`, `proposal.id`, `contract.id`, `org.id` |
| `compliance.expiring` | a doc crosses into expiring/expired | `compliance_doc.id`, `vendor_tier.id`, `doc_type`, `expires_at`, `org.id` |

`deadline.armed` is a ws-only frame (Section 5.2 / BP6 / BP10), not a Bolt event, published on any conflict-free deadline insert.

### 7.2 Events Bulwark SUBSCRIBES to (the binding targets)

Bulwark reacts to whatever `(source, event_type)` its confirmed obligations bind to (data, not a fixed list). Beachhead bindings from `event-catalog.ts`: `bam:task.overdue`, `bam:task.updated`, Bill pay-app/retention/overdue events, Book deadline events, `bam:sprint.completed`. Most beachhead bindings reflect queryable persistent state, so `bulwark-state-reconcile` (Section 4.5) makes them durable end-to-end; genuinely transient bindings depend on Open Question 1. New binding targets require the `(source, event_type)` to exist in `event-catalog.ts` and the per-org gate to admit it (Section 6).

### 7.3 entity_links, unified activity, search

- **entity_links:** on contract register and vendor-tier create, upsert `bulwark.contract`/`bulwark.vendor_tier -> source` rows (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`).
- **unified activity:** Bulwark flows as the Bolt events above, not into the fixed `v_activity_unified` UNION (bam/bond/helpdesk only), matching Braid.
- **search:** a Bulwark `search_everything` provider is a fast-follow, not v1 (Section 12).

### 7.4 Braid integration (unify the counterparty)

Where Braid is available, Bulwark resolves the counterparty/vendor to a golden id via `braid_resolve` before writing the `entity_links` row, so the deterministic notice recipient (THEME E) is the canonical counterparty. **This resolution runs synchronously in bulwark-api at contract-register / vendor-tier-create, so bulwark-api carries `BRAID_API_INTERNAL_URL` (Section 9.1 / IN7); absent Braid (or an empty URL) it degrades to the raw `bond.company` id.** Soft dependency.

---

## 8. Testing

- **Unit (Vitest, `@bigbluebam/db-stubs`, basis safety-suite precedent commit `7587872c`):**
  - **timezone / roll-forward (THEME B):** Pacific near-midnight anchor computes the correct calendar day; `business_days` skips weekends; `roll_forward` moves a weekend due date forward; DST boundaries hold.
  - **anchor selection (THEME B):** `trigger_at` preferred over `logged_at`; a Friday event logged Tuesday clocks from Friday; `anchor_source` recorded.
  - **stable key (DI1/DI2):** three distinct obligations in section "12.3" (notice + documentation + preserve) get three distinct `dedup_key`s and all persist; a null-section provision gets a content-hash key and re-extraction of the same doc is idempotent; a null-section obligation is NOT superseded by mere absence; "12.3" vs "S12.3" vs "Section 12.03" normalize to one `clause_ref`.
  - **amendment supersession (THEME C/DI3):** an amendment obligation binds to the base via `amends_clause_ref`/reviewer binding; restate re-points open deadlines to the successor in one transaction; terminate voids them with a reason; the deadline-to-obligation `ON DELETE RESTRICT` blocks an accidental delete with a live clock.
  - **calendar re-point key (STJ4):** re-pointing a calendar deadline recomputes `triggering_event_id=uuid5(successor||date)` and a later radar tick does NOT mint a duplicate renewal deadline.
  - **arm gate (D5/DI4):** a `notice`/`lien`/`retention`/`indemnity`/`payment` obligation with confidence 0.99 stays `pending_review`/`is_armed=false` until human confirm; an auto-arm-eligible type arms only on the deterministic signal; a `compliance` type does not exist.
  - **event-bound requires filter (STJ5):** an event binding with no `entity_filter` cannot set `is_armed=true`; confirming one is flagged; a filtered `task.overdue` on Project X does not arm a Project-Y contract's clock (S5).
  - **inbox durability (THEME D/STJ2/STJ6):** a pending inbox row with a lost enqueue is processed by the radar pending-drain; a retried upstream publish with the same `source_idempotency_key` dedups; a redelivery dedups even after the discharged deadline was purged (ST4).
  - **state-reconcile (STJ1):** a dropped dispatch for a `task.overdue` binding is recovered by `bulwark-state-reconcile` re-querying the source task table; a transient-only binding is documented as NOT recovered (Open Question 1).
  - **gate durability (STJ3):** after a Redis flush the boot/periodic reconcile rebuilds `bulwark:bindings:<org>` from `is_armed` obligations; an arm whose `SADD` fails is not committed as armed.
  - **retention coupling (STJ7):** `inbox_retention_days < discharged_deadline_retention_days` is rejected; the purge cutoff is computed from the inbox floor so they cannot invert.
  - **deterministic recipient/attachment (THEME E/SN1):** a clause naming a foreign recipient/file does not change `recipient_id` or add an attachment; a null `counterparty_id` fails the send closed and annotates the proposal; an attachment failing the decider `can_access` is dropped.
  - **proposed_payload refs-only (SM2):** no clause/notice text lands in `agent_proposals.proposed_payload`.
  - **scope_fields allowlist (SM1):** a binding whose `payload_path` targets a non-allowlisted / non-uuid field is rejected at bind time; a non-uuid `scope_fields` value is dropped.
  - **write project-scoping (SH1):** a non-project member is 403 on `POST /trigger`, `/discharge`, `/draft-notice`, `PATCH /obligations/:id` for a contract they cannot read; `occurred_at` in the future or before `effective_date - grace` is rejected.
  - **/internal/events fail-closed (S4/SN2):** an empty `INTERNAL_SERVICE_SECRET` returns 401 unconditionally before any compare (stronger than `:64`).
  - **send CAS / reconcile (ST5):** two overlapping radar sweeps draft once; an expired proposal is re-drafted; a REST approve racing the subscription echo sends once.
  - **flow-down recompute (D4/DI5):** rejecting a `flow_down` obligation drops its doc types on the next recompute; tiers process parent-before-child.
  - **transactional send (D6):** a chase/notice send is NOT filtered by `blast_unsubscribes`.
  - **calendar recurrence (ST7/DI6):** an `annual` recurrence arms year N and N+1; a non-recurring calendar obligation arms once.
- **register-tool policy test:** `bulwark.*` fails closed until allowlisted.
- **permission-manifest test (BP7):** the ONE destructive permission row (`bulwark.contract.delete`) lands `is_destructive:true, requires_confirmation:true`; every row carries an explicit `is_read`; `bulwark.obligation.write` and `bulwark.deadline.write` are `is_read:false` with the confirm enforced at the MCP tool layer (`confirm-token-store`) per Section 10, NOT flagged on the manifest row.
- **permission tiering (BP5/SH2):** after `0237`, a non-SuperUser org **Owner** GETs 200 on `GET /v1/contracts`; a **Member** is 403 on `bulwark.contract.read`/`obligation.read`, `bulwark.notice.draft`, `DELETE /contracts/:id`, and `PATCH /settings`; a **Viewer** is read-only on non-tiered reads and 403 on the tiered reads + all writes.
- **Org-scoping test:** a service-layer query for org A returns zero org-B rows on every `bulwark_*` table; optional role-bound RLS test.
- **e2e (Playwright, GILLIGAN dataset per `CLAUDE.md`):** a "Castaway Rescue Subcontract" is registered from a Bin asset (Bin ACL honored); extraction yields a 5-day notice obligation bound to `bam:task.overdue` with a project filter; a reviewer confirms it; an overdue task arms the clock in the contract's Pacific timezone; the radar drafts a notice into the approval queue; the Skipper approves and it sends once to the deterministic counterparty; an expiring "Howell COI" triggers a transactional chase; a non-project member cannot see or arm the subcontract's clocks.

---

## 9. Infrastructure

### 9.1 New api compose service

`bulwark-api` in `docker-compose.yml`, modeled on `braid-api` (`docker-compose.yml:861`): `PORT: 4021`, stateless, horizontally scalable. Inherits the basis-style per-request RLS GUC plugin; does NOT flip the DB role. `depends_on`: `migrate` (`service_completed_successfully`), `postgres` + `redis` (`service_healthy`) only. Env: `DATABASE_URL`, `DATABASE_READ_URL=${DATABASE_READ_URL:-}`, `REDIS_URL`/`REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` (non-empty; `/internal/events` fails closed when empty, S4), `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, **`BRAID_API_INTERNAL_URL=${BRAID_API_INTERNAL_URL:-http://braid-api:4020}` (IN7: sync counterparty resolution at register/vendor-tier-create; absent-Braid degrades per 7.4)**, `CORS_ORIGIN`, `NODE_ENV`, `HOST`, `LOG_LEVEL`, rate-limit knobs, `BBB_PERMISSIONS_ENFORCE`. Healthcheck: `curl -sf http://localhost:4021/health`.

### 9.2 Worker service wiring (IN3 resolved)

Extraction runs in the worker, which reads Bin bytes via `@bigbluebam/storage` resolving the object key from the shared DB (`bin_assets` via `DATABASE_URL`), exactly as `bin-transcode`/`bin-av-scan` do. `BIN_API_INTERNAL_URL` is NOT added anywhere; `@bigbluebam/storage` is the sole byte path. Edits:
- **Compose (`docker-compose.yml` worker service):** add `BBB_API_INTERNAL_URL: http://api:4000`.
- **Catalog (`scripts/deploy/shared/services.mjs`):** add `BBB_API_INTERNAL_URL` to `worker.optional` (no-op if Braid already added it).
- **`worker.needs` unchanged:** every new upstream is a degradable, retried, DLQ'd request-time dependency.
- Register the seven queues in `apps/worker/src/worker.ts` (`bulwark-extract-obligations`, `bulwark-fire-on-event`, `bulwark-radar-sweep`, `bulwark-state-reconcile`, `bulwark-coi-chase`, `bulwark-proposal-reconcile`, `bulwark-retention`), the repeatable ones modeled on the basis scheduler at `worker.ts:673-679`.

### 9.3 SPA build (four Dockerfile edit sites, no separate compose service)

Edit `apps/frontend/Dockerfile` in four sites, mirroring the braid lines: (1) deps-stage `COPY apps/bulwark/package.json ./apps/bulwark/`; (2) build-stage 4-line source COPY block; (3) `&& pnpm --filter @bigbluebam/bulwark build` in the build `RUN`; (4) production `COPY --from=build /app/apps/bulwark/dist /usr/share/nginx/html/bulwark`.

### 9.4 nginx routing (two source configs, generated railway)

`infra/nginx/nginx.railway.conf` is auto-generated from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs`. Edit only the two source configs:
- `infra/nginx/nginx.conf` (after the braid blocks): `/bulwark/` alias + SPA fallback, `/bulwark/api/ -> http://bulwark-api:4021/`, `/bulwark/ws -> http://bulwark-api:4021/ws` with upgrade headers.
- `infra/nginx/nginx-with-site.conf`: the same three blocks.
- **Static-asset regex (IN5):** insert ONLY the `bulwark` token into each source file's existing alternation; touch nothing else; do not reconcile the pre-existing bay/blip/bill divergence in this pass.
- Then `node scripts/gen-railway-configs.mjs`. Do not hand-edit `:8080` or the `$rw_upstream_NN` index.
- **Ingress crash-safety:** add `bulwark-api` (`condition: service_healthy`) to the `frontend` service `depends_on`.

### 9.5 Deploy catalog, Railway, MCP wiring, Launchpad, marketing site, CLAUDE.md

- `scripts/deploy/shared/services.mjs`: add a `bulwark-api` `APP_SERVICES` block (port `4021`, `public_paths: ['/bulwark/api/','/bulwark/ws']`, `required` env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`/`BOLT_API_INTERNAL_URL`, `optional` incl. `DATABASE_READ_URL`/`BRAID_API_INTERNAL_URL`/`CORS_ORIGIN`/`LOG_LEVEL`), mirroring `braid-api` (`:270`). `bulwark-api.needs = ['postgres','redis','api','bolt-api']`. Add `/bulwark/` to the `frontend` entry's `public_paths` and `bulwark-api` to its `needs`.
- **MCP wiring (IN1):** add `BULWARK_API_URL` to `mcp-server.env.optional` in `services.mjs` AND to the docker-compose `mcp-server` block (mirroring the `BRAID_API_URL: http://braid-api:4020/v1` line at `docker-compose.yml:188`), value `http://bulwark-api:4021/v1`, plus an env-hint. **Backfill the pre-existing bug:** `BASIS_API_URL` and `BRAID_API_URL` are in `docker-compose.yml` but MISSING from `mcp-server.env.optional`; add all three. **`mcp-server.needs` (IN4):** do NOT add `bulwark-api`, matching braid/basis. Register `bulwark-tools.ts` in the MCP bootstrap.
- **bolt-api wiring (Section 6):** add `BULWARK_API_INTERNAL_URL=http://bulwark-api:4021` to bolt-api compose env + catalog, alongside `BRAID_API_INTERNAL_URL`. The sending-end outbox (STJ1) is a bolt-api schema + drain-job change owned by the Bolt maintainers (Open Question 1).
- **Run `node scripts/gen-railway-configs.mjs`:** regenerates `nginx.railway.conf` and emits `railway/bulwark-api.json`.
- **Launchpad catalog** in `apps/api/src/routes/system-settings.routes.ts`: add `'bulwark'` to `LAUNCHPAD_APP_IDS` and a `LAUNCHPAD_CATALOG` entry `{ id: 'bulwark', name: 'Bulwark', description: 'Contract Obligations', icon_name: 'shield-check', color: '#1d4ed8', path: '/bulwark/' }`. Do NOT add to `ROOT_REDIRECT_VALUES`.
- **Launchpad icon:** `shield-check` is absent from `ICONS` in `packages/ui/launchpad.tsx:65` (unknown -> `Box`, `:226`). Two edits: `import { ShieldCheck } from 'lucide-react'` and `'shield-check': ShieldCheck`.
- **Marketing site (BP3):** add a Bulwark section to the `site/` Vite app registered on a page, GILLIGAN-only screenshots, rebuild the site image; update the MCP tool count AND the "N apps" narrative in BOTH `CLAUDE.md` AND `site/`.
- **CLAUDE.md (Phase 5 mandate):** append the `bulwark-api` (internal :4021, `/bulwark/api/`) and `bulwark` SPA inventory lines, the route rows, and the MCP tool count for `bulwark-tools.ts` (15 tools, Section 10).
- **Runtime-dependency posture:** `/readyz` checks only Postgres + Redis. Bin byte reads, the llm-provider, bolt-api publish, and Braid resolution use bounded timeouts + typed `UPSTREAM_UNAVAILABLE`; workers retry/backoff/DLQ; the durable inbox + state-reconcile are the firing guarantees (transient-event edge per Open Question 1).

---

## 10. MCP surface

New `apps/mcp-server/src/tools/bulwark-tools.ts` via `registerTool`, HTTP client shaped like `dedupe-tools.ts:38`. Env `BULWARK_API_URL=http://bulwark-api:4021/v1`. Reads AND writes that surface or mutate source-scoped records require `asker_user_id` (`docs/reference/agent-conventions.md`), fail-closed via `can_access` (SH1); destructive tools use the Redis confirm-token store. `bulwark_*` not in `EXPLICIT_TOOL_OVERRIDES` (basis/braid deferral).

| Tool | Backs | Permission | confirm / asker |
| --- | --- | --- | --- |
| `bulwark_extract_obligations` (flagship) | POST `/v1/contracts` + POST `/contracts/:id/extract` | `bulwark.contract.write` | no |
| `bulwark_check_notice_risk` (flagship) | GET `/v1/deadlines` + `/waiver-risks` for a job | `bulwark.deadline.read` | `asker_user_id` |
| `bulwark_list_contracts` | GET `/v1/contracts` | `bulwark.contract.read` | no |
| `bulwark_get_contract` | GET `/v1/contracts/:id` (embeds obligations + rollup) | `bulwark.contract.read` | `asker_user_id` |
| `bulwark_delete_contract` | DELETE `/v1/contracts/:id` | `bulwark.contract.delete` | **confirm** |
| `bulwark_list_obligations` | GET `/v1/obligations` | `bulwark.obligation.read` | no |
| `bulwark_get_obligation` | GET `/v1/obligations/:id` | `bulwark.obligation.read` | `asker_user_id` |
| `bulwark_confirm_obligation` | PATCH `/v1/obligations/:id` (confirm/edit/bind) | `bulwark.obligation.write` | `asker_user_id` (SH1) |
| `bulwark_reject_obligation` | PATCH `/v1/obligations/:id` (`rejected`) | `bulwark.obligation.write` | **confirm** + `asker_user_id` |
| `bulwark_trigger_obligation` | POST `/v1/obligations/:id/trigger` (manual, DI7) | `bulwark.deadline.write` | `asker_user_id` (SH1) |
| `bulwark_list_deadlines` | GET `/v1/deadlines` | `bulwark.deadline.read` | no |
| `bulwark_draft_notice` | POST `/v1/deadlines/:id/draft-notice` | `bulwark.notice.draft` | no (proposal is the HITL) |
| `bulwark_waive_deadline` | POST `/v1/deadlines/:id/discharge` (waive) | `bulwark.deadline.write` | **confirm** + `asker_user_id` |
| `bulwark_list_compliance` | GET `/v1/compliance-docs` | `bulwark.compliance.read` | no |
| `bulwark_chase_compliance` | POST `/v1/compliance-docs/:id/chase` | `bulwark.compliance.chase` | no (proposal is the HITL) |

15 tools. `bulwark_get_contract` embeds obligations + rollup, so `/v1/contracts/:id/obligations` is `resolver-done-internally`. **No-tool endpoint enumeration, complete (BP8):**
- `PATCH /v1/contracts/:id` -> skip: metadata edit, SPA-surfaced.
- `GET /v1/deadlines/:id` -> skip: resolver-done-internally (`bulwark_check_notice_risk` + `bulwark_list_deadlines` surface deadline data; the `notice_draft` body is a UI-only read gated by the owner/admin floor).
- `GET /v1/vendor-tiers` and `POST /v1/vendor-tiers` -> skip: compliance-matrix management, SPA-only.
- `POST /v1/compliance-docs/:id/approve-send` and `POST /v1/deadlines/:id/approve-send` -> skip: UI-only send surfaces (the MCP send path is the proposal approve).
- `PATCH`/`GET /v1/settings` -> skip: settings SPA-surfaced.
- `POST /v1/internal/events`, `/bulwark/ws`, `/health`, `/readyz` -> skip: internal / realtime / probe.

**agent_policies:** every `bulwark_*` service-account call fails closed until `bulwark.*` is allowlisted.

**The 12 hand-authored permission rows**, each with explicit `app:'bulwark'` and `is_read`:
- `bulwark.contract.read` (`is_read:true`; owner/admin floor)
- `bulwark.contract.write` (`is_read:false`)
- `bulwark.contract.delete` (`is_read:false, is_destructive:true, requires_confirmation:true`; owner/admin floor)
- `bulwark.obligation.read` (`is_read:true`; owner/admin floor)
- `bulwark.obligation.write` (`is_read:false`; reject confirm at the tool layer)
- `bulwark.deadline.read` (`is_read:true`)
- `bulwark.deadline.write` (`is_read:false`; discharge/manual-trigger; waive confirm at the tool layer)
- `bulwark.notice.draft` (`is_read:false`; owner/admin floor)
- `bulwark.compliance.read` (`is_read:true`)
- `bulwark.compliance.chase` (`is_read:false`; owner/admin floor)
- `bulwark.settings.read` (`is_read:true`)
- `bulwark.settings.write` (`is_read:false`; owner/admin floor)

Only `bulwark.contract.delete` is manifest-destructive (BP7); the reject/waive confirm boundaries live at the MCP tool layer, consistent with Section 8's test.

**Surface-map update:** `docs/reference/mcp-endpoint-mapping.md` MUST be updated in the same change; every REST row's MCP column is a backtick tool name or the sanctioned em-dash skip-cell. Keep the coverage counts and the zero-bare-dash grep green.

---

## 11. Reuse ledger

| Capability | Reuses (real file/package) | New in Bulwark |
| --- | --- | --- |
| App scaffolding (Fastify, plugins, health, RLS GUC) | `apps/basis-api/src/server.ts` (`@bigbluebam/service-health:8`), `apps/basis-api/src/plugins/rls.ts`, `apps/braid-api/` layout, `apps/bin-api/src/db/schema/bbb-refs.ts` | `bulwark-api` at 4021 |
| Document + collected-doc bytes | `apps/bin-api` `bin_assets` (`0205_bin_dam.sql`), `@bigbluebam/storage` `getStream` (shared-DB object-key resolution) | contract/compliance `bin.asset` references, `can_access`-preflighted |
| Clause + notice-draft understanding (internal only) | internal llm-provider `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`), `llm_providers` | fenced-DATA extraction with verified cited spans + deterministic `dedup_key`; drafting emits only subject/body |
| Event bus + durable dispatch transport | `publishBoltEvent` (`bolt-events.ts:35`), `braid-dispatch-hook.ts` + `event-ingestion.routes.ts`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts` (the sending-outbox model) | data-driven `event_binding`, a `bulwark-dispatch-hook.ts`, a durably-rebuildable per-org gate, the `bulwark_ingest_events` inbox, and `bulwark-state-reconcile` |
| HITL inbox + reconcile | `agent_proposals` (`0128_agent_proposals.sql`), `proposals.routes.ts:275,328`, `braid-proposal-reconcile.job.ts` | refs-only null-approver drafts, single kill-switch-safe send executor, `bulwark-proposal-reconcile` |
| Confirm-action on destructive tools | `apps/mcp-server/src/lib/confirm-token-store.ts` | delete-contract / reject-obligation / waive-deadline tokens |
| Counterparty identity | `apps/bond-api`, `entity_links` (`0132_entity_links.sql`), `braid_resolve` (`apps/braid-api`) | deterministic notice recipient resolution (sync in bulwark-api, IN7) |
| Money / dates / chase / forms | `apps/bill-api`, `apps/book-api`, `apps/blast-api` (transactional flag), `apps/blank-api` | payment/retention obligations, calendar deadlines, transactional chases, collection forms |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts:1151` (`preflightBinAsset`), `:192-207` (`isProjectMember`), `can_access` | Bin preflight on register; project-scoped read AND write routes; attachment preflight at send |
| Bolt events + drift guard | `event-catalog.ts`, `scripts/check-bolt-catalog.mjs` | 6 `bulwark` event definitions |
| Org scoping + RLS posture | `app.current_org_id` GUC (`0116_*`), `rls-boot.ts`, `basis-api/src/plugins/rls.ts`, `BBB_RLS_ENFORCE` | Bulwark table policies + app-level org-scoping tests |
| Permissions (hand-authored satellite pattern) | `scripts/generate-permission-manifest.mjs`, `scripts/build-permission-codegen.mjs` (writes `packages/permissions/src/generated/permissions.ts`), `check-permission-catalog.mjs`, `build-permission-delta.mjs`, `0233_braid_builtin_group_defaults.sql` | 12 `bulwark.*` rows + custom-tiered built-in defaults |
| MCP registration + policy gate | `register-tool.ts` (incl. `/v1/agent-policies/:id/check`), `dedupe-tools.ts` client | 15 `bulwark_*` handlers |
| Worker retry/backoff/DLQ + capture-the-version + advisory lock + rescan + retention | `braid-*.job.ts`, `basis-metric-snapshot.job.ts` (scheduler `worker.ts:673-679`), `bond-stale-deals.job.ts:127-138`, `agent-webhook-dispatch.job.ts`/`-dlq.job.ts`, `basis-retention-sweep.job.ts` | extraction (checkpointed) / inbox-drain firing / radar (locked, capped, pending-drain) / state-reconcile / chase / proposal-reconcile / retention |
| High-churn partitioning pattern | `0220_blip_entries_partitioned.sql` | `bulwark_ingest_events` monthly-partition fast-follow |
| Launchpad + nginx + frontend Dockerfile + services.mjs + marketing site | braid/basis wiring, `gen-railway-configs.mjs`, `packages/ui/launchpad.tsx`, `site/` | one new app id `bulwark`, `shield-check` icon, a marketing section |
| Suite UI shell + Bureau widget + test stubs | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/db-stubs` | Bulwark SPA pages only |

---

## 12. Open questions & risks (human decision needed)

1. **Transient-event delivery durability (STJ1, owner: Bolt maintainers).** State-reflecting bindings (most beachhead ones) are made durable end-to-end by `bulwark-state-reconcile` (Section 4.5). A genuinely transient event (no persistent source row) dropped on the bolt-api to bulwark-api hop while bulwark-api is mid-deploy/blipped is NOT recoverable without a **sending-end dispatch outbox in bolt-api** (Section 6), a bolt-api schema + drain-job change on the existing `agent-webhook-dispatch.job.ts` model. Until it ships, transient-only bindings degrade to the manual-trigger net. Decision: whether to build the bolt-api outbox now or accept the degraded transient path for v1 (with the manual trigger + human review as the documented net).
2. **Per-org dispatch gate consistency (Section 6 / STJ3).** The `bulwark:bindings:<org>` set is a cache over `bulwark_obligations`, rebuilt at boot and on the state-reconcile cadence, with the arm failing on an unconfirmed `SADD`. Confirm the rebuild cadence is tight enough for the eventual-consistency window on a fresh arm (the pending-drain + state-reconcile backstop covers a brief miss).
3. **`trigger_at` payload extraction (THEME B).** Which payload field names the real legal event time is not standardized across the catalog; where absent, the clock anchors on `logged_at` with `anchor_source` surfaced. Confirm per beachhead binding.
4. **Holiday-calendar source (THEME B).** v1 ships weekend-only roll-forward plus an optional named calendar (`us-federal`); jurisdiction calendars are a fast-follow.
5. **Recurring calendar obligations (DI6).** `deadline_rule.recurrence` is modeled and the radar rolls the anchor per interval, but multi-occurrence recurrence beyond a simple annual roll (leap handling, mid-term amendments to the interval) is a fast-follow; v1 targets single-occurrence and annual renewal.
6. **Source-app event coverage (Section 7.2).** Some beachhead triggers may not be published at the needed granularity yet; unbound obligations are manual-trigger-only until the source app publishes.
7. **Scanned / image-only contracts (Section 4.1).** No OCR in v1; such contracts extract to zero obligations and are flagged for manual entry.
8. **Extraction + draft accuracy is best-effort and legally consequential.** Mitigations: the human-review queue (the claim-waiving set never auto-arms, D5), verified cited spans (D7), the deterministic recipient/attachment (THEME E), the transactional-send path (D6), the amendment reviewer-binding (DI3), and a disclaimer that Bulwark assists but does not replace counsel.
9. **`search_everything` provider (Section 7.3).** Deferred to a fast-follow.
10. **Partitioning trigger (ST9 / IN6).** `bulwark_ingest_events` (highest churn) is the first monthly-partition candidate per `0220_blip_entries_partitioned.sql`; deadlines/risks follow if volume warrants.
11. **No human-provided secret required.** All dependencies are internal. The only new env are internal service URLs (incl. `BRAID_API_INTERNAL_URL`, IN7) and the reused `INTERNAL_SERVICE_SECRET`.

---

## Changelog - Round 1

All 6 blockers (Themes A-G) plus majors D3-D9, S3-S8, ST4-ST9, BP3-BP6, IN1-IN5 were accepted or accepted-with-adaptation; none rejected. Highlights: per-viewer/permission-tiered ledger reads (A), timezone/anchor split (B), amendment supersession + `ON DELETE RESTRICT` (C), the `bulwark_ingest_events` durable inbox (D), deterministic notice recipient/attachment (E), the explicit `build-permission-codegen.mjs` sequence (F), the `/v1/internal/events` dispatch target (G), retention audit protection (D3), flow-down-to-compliance linkage (D4), confidence-vs-arm split (D5), transactional send (D6), cited-span verification (D7), the manual-trigger affordance (D8), compliance state-machine split + `deadline.write` (D9), Bin preflight (S3), fail-closed `/internal/events` (S4), entity_filter fail-closed (S5), auto-draft caps (S6), inbox dedup atom (ST4), CAS + advisory lock + reconcile (ST5), chunk checkpointing (ST6), calendar uuid5 dedup (ST7), per-org firehose fix (ST8), partitioning posture (ST9), and the infra wiring (IN1-IN5).

## Changelog - Round 2

Second hardening round. Every finding accepted or accepted-with-adaptation; none rejected. Round-1 verified fixes were not re-touched. Dispositions:

**THEME H (write/destructive scoping)**
- [security] SH1 ACCEPT (MAJOR): all mutating routes (`/trigger`, PATCH `/obligations/:id`, `/discharge`, `/draft-notice`, `/approve-send`) apply the project-membership predicate + org-admin override before mutating; the four MCP write tools carry `asker_user_id` + `can_access`; `occurred_at` plausibility validated. Sections 2.5(2), 5.1, 10, 8. (from review round 2)
- [security] SH2 ACCEPT (MAJOR): `0237` excludes member from `bulwark.contract.delete` + `bulwark.settings.write` (owner/admin floor); member-403 tests added. Sections 2.5(3), 3.4, 5.1, 8. (from review round 2)
- [security] SH3 ACCEPT (MAJOR): obligation list/detail + deadline detail annotated "project-scoped" and enforced in the shared query builder; compliance reads project-scoped via `vendor_tier.contract_id` with null-contract tiers owner/admin-only. Sections 2.5(1), 5.1. (from review round 2)

**THEME I (obligation stable key)**
- [design] DI1 ACCEPT (MAJOR): the upsert key is a per-obligation `dedup_key` = hash(normalized_clause_ref, obligation_type, normalized_trigger); `clause_ref` is evidence only; supersession keys on the same. Sections 3.1, 4.1. (from review round 2)
- [design] DI2 ACCEPT (MAJOR): `clause_ref` normalized deterministically; null-section provisions get a content-hash key tied to `source_doc_hash`; a null-section obligation is never auto-superseded by absence. Sections 3.1, 4.1. (from review round 2)
- [design] DI3 ACCEPT (MAJOR): amendment supersession sets `supersedes_obligation_id` via extracted `amends_clause_ref` or reviewer binding at confirm, with explicit restate vs terminate (`voided`) outcomes; deletion clauses surface as review items. Sections 3.1, 4.1. (from review round 2)
- [design] DI4 ACCEPT (MAJOR): the arm gate reconciled to the real enum; human-confirm-before-arm set = {notice, lien, retention, indemnity, payment}; phantom `compliance` type dropped; compliance-chase derives from flow_down + tiers; only `notice` auto-drafts. Sections 2.2, 4.1. (from review round 2)

**THEME J (durability)**
- [stability] STJ1 ACCEPT (BLOCKER): added `bulwark-state-reconcile` (braid-rescan analog) for state-reflecting bindings; specified a bolt-api sending-end dispatch outbox for transient events as Open Question 1 (owner: Bolt maintainers); removed the "durable once received" overclaim. Sections 1, 4.5, 6, 12. (from review round 2)
- [stability] STJ2 ACCEPT (MAJOR): the radar sweep is the named owner of the scheduled pending-inbox drain (`status='pending'` scan). Sections 4.3, 6. (from review round 2)
- [stability] STJ3 ACCEPT (MAJOR): the Redis binding gate is a cache rebuilt at boot + on the reconcile cadence from `is_armed` obligations; an arm fails on an unconfirmed `SADD`. Sections 4.5, 6. (from review round 2)
- [stability] STJ4 ACCEPT (MAJOR): re-point recomputes calendar `triggering_event_id=uuid5(successor||anchor_date)` with `ON CONFLICT DO NOTHING`, preventing duplicate recurring notices. Sections 3.1, 4.1. (from review round 2)
- [stability] STJ5 ACCEPT (MAJOR): event-bound obligations require a non-empty `entity_filter` before `is_armed`; a filterless binding cannot arm. Sections 2.2, 3.1, 4.2. (from review round 2)
- [stability] STJ6 ACCEPT (MINOR): inbox dedup keys on `source_idempotency_key` (payload `_event_id` when present) so a retried publish dedups. Section 3.1. (from review round 2)
- [stability] STJ7 ACCEPT (MINOR): `inbox_retention_days >= discharged_deadline_retention_days` enforced; the purge cutoff is computed from the inbox floor in the same run. Sections 3.1, 4.5. (from review round 2)

**Design minors**
- [design] DI5 ACCEPT: flow-down `required_doc_types` recomputed from scratch each sweep, tiers ascending; removal is automatic. Section 4.4. (from review round 2)
- [design] DI6 ACCEPT: added `deadline_rule.recurrence`; radar rolls the anchor per interval; multi-occurrence beyond annual is a fast-follow. Sections 3.3, 4.3, 12. (from review round 2)
- [design] DI7 ACCEPT: manual trigger restricted to unbound / no-project obligations to prevent double-arm. Sections 2.2, 4.2, 5.1. (from review round 2)
- [design] DI8 ACCEPT (already resolved round 1): compliance status split + `discharge` on `bulwark.deadline.write` were folded in round 1; re-confirmed. Sections 3.1, 5.1. (from review round 2)

**Security minors/nits**
- [security] SM1 ACCEPT: `entity_filter.payload_path` allowlisted to id-typed fields; `scope_fields` values uuid-validated and dropped otherwise. Sections 2.5(7), 3.1, 3.3. (from review round 2)
- [security] SM2 ACCEPT: `agent_proposals.proposed_payload` refs-only; body fetched through the gated route; test added. Sections 2.2, 3.2, 8. (from review round 2)
- [security] SN1 ACCEPT: null resolved recipient fails the send closed and annotates the proposal. Sections 2.4, 3.1, 8. (from review round 2)
- [security] SN2 ACCEPT: S4 reworded "STRONGER than internal-llm.routes.ts:64: reject unconditionally when the sole secret is empty"; test asserts it. Sections 2.5(5), 5.1, 8. (from review round 2)

**Best-practices**
- [best-practices] BP7 ACCEPT (MAJOR): Section 8 asserts the ONE destructive row (`bulwark.contract.delete`) carries the manifest flags; reject/waive confirm at the tool layer; Sections 8 and 10 agree. Sections 8, 10. (from review round 2)
- [best-practices] BP8 ACCEPT (MAJOR): the no-tool enumeration extended to cover PATCH `/contracts/:id`, GET `/deadlines/:id`, GET/POST `/vendor-tiers` (all skips); tools stay 15. Section 10. (from review round 2)
- [best-practices] BP9 ACCEPT (MINOR): `0237` marked as the file immediately after the generated delta (`NNNN+1`); the cited `0237` is illustrative. Section 3.4. (from review round 2)
- [best-practices] BP10 ACCEPT (MINOR): `deadline.armed` published on ANY conflict-free deadline insert (event drain, radar calendar, manual trigger). Sections 4.2, 4.3, 5.2, 7.1. (from review round 2)

**Infrastructure**
- [infrastructure] IN6 ACCEPT (MINOR): ST9 extended to cover `bulwark_ingest_events` (highest churn) as the first monthly-partition candidate per `0220_blip_entries_partitioned.sql`. Sections 3.1, 12. (from review round 2)
- [infrastructure] IN7 ACCEPT (MINOR): `BRAID_API_INTERNAL_URL` added to bulwark-api compose env + services.mjs optional; counterparty resolution runs sync in bulwark-api, absent-Braid degrades. Sections 7.4, 9.1, 9.5. (from review round 2)
