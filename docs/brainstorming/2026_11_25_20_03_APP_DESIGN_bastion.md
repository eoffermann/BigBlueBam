# Bastion - App Design Specification

> **STATUS: DRAFT, review round 0.** This document is the build input for Bastion. Where it
> disagrees with the session submission, this document wins. Where it disagrees with the
> monorepo, the monorepo wins and section 15 records the discrepancy.

**Session:** 2026_11_25_20_03
**Winner:** Seat B's compliance and GRC submission (29 points; runner-up Bevy at 28), with folded-in
pieces from Seat D (questionnaire autofill, auditor share link), Seat F (GitHub-sourced
change-management controls, trust page), and Seats A and E (token-gated auditor room).
**Final name:** **Bastion** (app id `bastion`). The submission's first-choice name collided with
Bursar's core vocabulary, so the word "baseline" is never used as a Bastion table, column, tool,
route, event, or UI term. Bursar keeps it.
**API:** `bastion-api`, internal `:4024` | **SPA:** `/bastion/`, dev `:3024` | **Realtime:** none in v1 (section 5.3)

> **Counting rule (inherited from Bursar).** Permissions are counted by the section 4.6 probe
> against the section 5.5 table, and the table wins over any prose number. Tables are enumerated
> by the generated RLS loop over the `bastion_` prefix. Seed figures have exactly one source
> (section 10.3).

---

## Table of contents

1. Overview and positioning
2. AI-native design
3. The evidence engine
4. Data model and migrations
5. API surface, MCP tools, permissions
6. Frontend and help
7. Background work
8. Events and integration
9. Infrastructure
10. Seed data (GILLIGAN)
11. Test plan
12. Milestones
13. Reuse ledger
14. Non-goals and v1.1
15. Open questions and risks
16. Changelog

---

## 1. Overview and positioning

### 1.1 One-liner

Every night Bastion checks your SOC 2 or ISO 27001 controls against what actually happened in
the suite, freezes tamper-evident proof of each result, and lists first the controls nothing can
prove, each with the cheapest fix already drafted.

### 1.2 The customer wedge

A 2-50 person firm hits compliance at its first enterprise deal: a 200-row security
questionnaire arrives, or the buyer asks for a SOC 2 report. Vanta and Drata cost $10-40k a year,
need a connector per tool, and still collect much of their evidence as screenshots. Bastion's
evidence source is the system of record the team already works in: who has access, how old the
API keys are, whether merged code was reviewed, whether people read the security policy, whether
backups ran. The proof is native, cited, continuous, and near-zero marginal cost.

The flagship output is not a dashboard of green ticks. It is the **"can't prove yet" list**:
controls that nothing in your stack can currently evidence, ranked by audit risk, each with a
drafted fix (connect a source, change a setting, adopt a policy, ask a named person for a file).

### 1.3 Honest scope: the suite cannot see everything

Seat E's recorded reservation is correct and the design treats it as a first-class requirement:
much SOC 2 evidence lives outside the suite (cloud infrastructure, device management, HR
systems, the identity provider). Bastion answers it three ways (section 3.3):

1. **Uploaded and manual evidence is a first-class path**, held to the same rules as native
   evidence: immutable copy, SHA-256 hash, a named owner, a coverage period, an expiry, a
   citation, and a place in the same tamper-evident ledger.
2. **Machine feeds** let an external system (an HR export script, an MDM report, a sibling suite
   app when one exists) push records through a contract-defined endpoint, frozen the same way.
3. **The coverage graph never blends sources.** The home screen reports four separate numbers:
   proven by the suite, proven by evidence you provided (with how much of it expires soon), not
   met, and can't prove yet. There is no single "automated %" that hides manual dependence.

### 1.4 Category boundary (adjacent, not on top)

| App | Object | Counterparty | Bastion's relationship |
| --- | --- | --- | --- |
| **Bulwark** | Clause owed under an executed contract | Customer or vendor | None. Bastion never reads contracts. A customer's contractual security obligation stays in Bulwark. |
| **Bursar** | Vendor offers and spend | Vendors | Optional read-only probe input: "critical vendors have an award on file" (CC9.2 vendor management). No writes. |
| **Beacon** | Knowledge articles, verification | Staff | Bastion links policy articles and records who attested to which version. Beacon remains the editor. |
| **Bam** | Tasks, GitHub integration | Team | Bastion creates remediation tasks via a new internal route; reads PR review events from a new Bam-owned ledger. |
| **Bin** | Files | Team | Upload path for manual evidence (reuses Bin upload and AV scan); Bastion then copies bytes into its own immutable prefix. |
| **Bay** | Media review guest links | External reviewer | The auditor room borrows the token-gated guest-link pattern, hardened (section 5.2). |

**The enforceable boundary:** Bastion writes zero rows in any other app's tables except
(a) Bam tasks through a dedicated internal route attributed to the Bastion System user and
(b) `entity_links` and `agent_proposals` rows (platform tables). Policy drafts and Bolt rule
drafts are applied to Beacon and Bolt by a human, under that human's own session (section 2.4).

### 1.5 Cadence

Daily background value (nightly evaluation, drift tasks) plus episodic spikes (an incoming
questionnaire, an audit window). The retention mechanism is the drift task in Bam and a weekly
"readiness" Bolt event an org can route to Banter, not a dashboard people must remember to open.

---

## 2. AI-native design

Bastion has four AI mechanisms. Each one has a deterministic core, and the LLM only fills in the
parts where language is the work. **The LLM never writes SQL, never decides a control's status,
and never sends anything outside the org unattended.**

### 2.1 The framework compiler (framework -> typed, testable assertions)

Input is either a built-in framework template (SOC 2 Security criteria, ISO/IEC 27001:2022 Annex
A, a "starter security questionnaire" set) or a custom framework from a document (a Bin asset)
or pasted text.

1. **Templates are code, not rows.** `apps/bastion-api/src/library/{soc2,iso27001,starter}.ts`
   ship each control as `{ ref_code, title, plain_summary, category, risk_weight,
   suggested_assertions[], suggested_manual_evidence[] }`. Plain summaries are written in-house
   in plain language (section 15.1 covers why the official criteria text is not reproduced).
   Adopting a template copies its controls into org rows, so no global-row RLS variant is needed
   (Bursar's `bursar_scope_library` needed one, `0251_bursar_rls.sql:33-44`).
2. **Company profile interview.** Ten plain questions ("Do you write software?", "Do people
   work from company laptops?", "Do you keep customer data in your own cloud account?"). Answers
   live in `bastion_org_settings.company_profile`.
3. **Tailoring (LLM).** For each control the compiler sends the control summary, the profile,
   the list of connected sources (GitHub integration present? Blip tracked apps? Bursar vendors?),
   and **the probe catalog** (section 3.1) as a closed menu. The model returns JSON: chosen probe
   keys, parameters, thresholds, or a manual-evidence spec, or "not applicable" with a reason.
4. **Validation (deterministic).** Every returned probe key must exist in the catalog; every
   parameter set must pass that probe's Zod schema; every threshold must sit inside the probe's
   allowed range. Anything else is dropped with a recorded reason. A custom-framework control
   extracted from a document must carry a cited span that passes `verifyCite`
   (`apps/burn-api/src/services/engines/extraction-logic.ts:39`), or it is dropped.
5. **Everything lands as `proposed`.** A human confirms each assertion (or bulk-confirms a
   control after reading the plain statement). Only `confirmed` assertions are evaluated. A
   control with no confirmed assertion is `unprovable` with reason `not_yet_confirmed`.
6. **Deterministic fallback.** If the org has no LLM provider configured, or the proxy is down,
   built-in templates still compile: their `suggested_assertions` are proposed verbatim. Only
   custom-document frameworks require the LLM. Compile never blocks on the model for built-ins.

Confirmed assertions are **content-immutable**: an edit creates a new `proposed` row that
supersedes the old one on confirmation, so every historical snapshot cites the exact assertion
version that produced it.

### 2.2 The nightly evaluator (assertions -> frozen evidence -> status)

Fully deterministic. For each confirmed assertion it runs the bound probe (or checks the linked
manual evidence or feed), produces an outcome (`pass`, `fail`, `unprovable` with a reason code),
writes a canonical JSON evidence document to object storage, hashes it, and appends it to the
org's evidence ledger (section 3.4). A control's status is the worst of its assertions
(`fail` > `unprovable` > `pass`). Status changes become drift events, Bolt events, and Bam tasks
(section 2.5). Details in section 3.

### 2.3 The evidence coverage graph and gap ranking

The graph is `control -> assertion -> evidence source`, where a source is one of `native`
(probe), `feed`, `manual_file`, `self_attested`, or `none`. Each control gets a
`coverage_kind`: `native`, `feed`, `manual`, `attested`, `mixed`, or `none`.

**Gap ranking is deterministic.** For each open gap:

```
risk = control.risk_weight (1..5)
     x severity(gap_kind)           # failing 1.00, unprovable_no_source 0.90,
                                    # manual_expired 0.85, unprovable_not_connected 0.80,
                                    # manual_expiring 0.50 x (1 - days_left / warn_window)
     x audit_proximity              # 1 + max(0, 90 - days_to_audit_target) / 90
```

Each `(gap_kind, probe or manual spec)` maps to fix templates with a fixed effort cost:
`config_change` 1, `connect_source` 2, `bolt_rule` 2, `evidence_request` 2, `policy_draft` 3,
`process_change` 5. The list sorts by risk descending, cost ascending; a "Quick wins" toggle sorts
by `risk / cost`. **The LLM never sets risk or picks the template.** It only drafts the content of
the chosen template (section 2.4).

### 2.4 Fix drafting (the cheapest fix, into `agent_proposals`)

For a selected gap, Bastion drafts the fix and files it as a platform proposal
(`agent_proposals`, `apps/api/src/db/schema/agent-proposals.ts:27-48`) with
`proposed_action = 'bastion.fix.<template>'`, `subject_type = 'bastion.gap'`, approver = the
control owner (fallback: an org admin), `expires_at` = now + 14 days, `actor_id` = the Bastion
System user (or the calling agent). The draft body also lives in `bastion_fix_drafts`.

| Template | What the LLM drafts | What happens on approval |
| --- | --- | --- |
| `evidence_request` | A plain request to the named owner, with an example of acceptable evidence ("an export of the Google Workspace 2-Step Verification report, covering everyone") | Bastion creates a Bam task assigned to the owner (internal route, section 8.4) linking to the upload screen |
| `policy_draft` | Markdown policy text grounded in the control summary and the org profile | The approver clicks **Create in Beacon as a draft**; the SPA calls beacon-api with the approver's own session. Bastion records the resulting entry via `mark-applied` |
| `bolt_rule` | A Bolt automation definition (e.g. "when a member is removed, open a task to revoke their API keys") | **Create in Bolt (turned off)** under the approver's session; a human turns it on |
| `connect_source` | Step-by-step plain instructions (e.g. "Turn on Pull request reviews in your GitHub webhook") | Human does it; the next evaluation proves it |
| `config_change` | The exact setting and value (e.g. Blip retention for "Coconut Count Tracker" from 30 to 90 days) | Human does it; the next evaluation proves it |
| `process_change` | A short procedure plus the manual evidence it will produce | Human adopts it; becomes a manual assertion |

Every citation in a draft passes `can_access` for the asker before it is persisted and again
when it is rendered (section 2.7).

### 2.5 Drift handling

When a control's status worsens (`pass -> fail`, `pass -> unprovable`), Bastion writes a
`bastion_drift_events` row, publishes `control.drifted` (source `bastion`), and, when the org has
a compliance project configured, upserts **one open Bam task per control**
(`external_id = 'bastion:control:<control_id>'`, so repeated drift updates the same task rather
than spamming). `remediation_tasks` in settings is `create` (default) or `propose`; in `propose`
mode the task becomes an `agent_proposals` row instead. On recovery Bastion publishes
`control.recovered` and comments on the task; it never closes the task itself (a human confirms
the fix).

### 2.6 Security-questionnaire autofill

1. A questionnaire file (xlsx or csv) arrives as a Bin asset, optionally linked to a Bond deal
   and company (Seat F's "which deal is waiting on this").
2. **Parse (deterministic).** `@bigbluebam/structured-data` codecs (csv today; xlsx is a new codec,
   section 15.4) produce rows; a column-mapping step (auto-detected, human-adjustable) identifies
   the question, the answer column, and an optional yes/no column.
3. **Pre-scan.** Every question passes the injection pre-scan ported from
   `apps/bursar-api/src/lib/injection-prescan.ts`. A suspect questionnaire is flagged and every
   affected row forced to `low` confidence.
4. **Retrieve (lexical, inside Bastion).** Postgres full-text search over the org's answer
   library, control plain summaries, confirmed assertion statements, and linked policy titles.
   No vector store (no Qdrant collection is created; the Bursar lesson about dead embedding paths
   applies, section 15.9).
5. **Draft (LLM).** The model gets the question plus the top-k candidates with ids and must
   answer citing candidate ids only. Output is JSON `{ answer, yes_no, cited_ids[] }`.
6. **Verify and band (deterministic).** Cited ids must be in the retrieved set and pass
   `can_access` for the questionnaire owner. Confidence is a composite of retrieval score,
   citation validity, and **the live status of every cited control**: any answer that cites a
   control currently `fail` or `unprovable` is forced to `low` and the draft says so plainly
   ("We cannot currently prove this. The check for 'laptops are encrypted' has no evidence.").
   Bastion never drafts a confident "Yes" it cannot prove.
7. **Review.** `low` and `medium` rows go to the review queue, routed to the control owner or to
   the person `expertise_for_topic` suggests. The whole questionnaire requires a floored
   **Approve** before export. Export writes the answers back into the original layout with
   formula-neutralized cells (`packages/shared/src/csv-safe.ts:26-66`).
8. **Learn.** Approved answers enter `bastion_answer_library`. A library answer is marked stale
   automatically when any control it cites changes status, so it cannot be reused unexamined.

A single-question variant (`POST /answers/draft`, MCP `bastion_draft_answer`) lets an agent in
Banter answer "do we encrypt backups?" with citations, as a draft.

### 2.7 What agents may do

| Action | Autonomous | Needs a human |
| --- | --- | --- |
| Read controls, status, coverage, gaps, drift, evidence summaries | yes | |
| Read evidence row-level detail | only when the asker holds `bastion.evidence.read_detail` (intersection rule) | |
| Verify an evidence hash and ledger position | yes | |
| Run a compile (produces `proposed` assertions only) | yes | confirming any assertion |
| Propose an assertion | yes (lands `proposed`) | confirmation |
| Run an evaluation (rate-limited: 1 full run per org per hour) | yes | |
| Draft questionnaire answers, draft a single answer | yes (drafts only) | approving and exporting |
| Propose a fix (`agent_proposals`) | yes | deciding the proposal |
| Upload or withdraw manual evidence | no tool | a human attests to provenance |
| Sign a policy attestation | **never** (server rejects `users.kind <> 'human'`) | the person themselves |
| Create or revoke an auditor room, publish the trust page, change settings | no tool | floored humans with confirm |

### 2.8 Guardrails

- **Agent policies.** Every `bastion_*` tool goes through `registerTool`
  (`apps/mcp-server/src/lib/register-tool.ts`), so the `agent_policies` kill switch and glob
  allowlist apply; tools fail closed until an operator allowlists `bastion.*`. Bastion is not in
  `EXPLICIT_TOOL_OVERRIDES` (the satellite pattern documented at
  `apps/mcp-server/src/tools/bursar-tools.ts:30-38`).
- **`asker_user_id` narrows, never widens.** bastion-api intersects the bearer's and the asker's
  capabilities, because mcp-server's own permission mode defaults to `warn` and cannot backstop
  it (same reasoning as `bursar-tools.ts:19-28`).
- **Visibility preflight.** Every cited entity in a fix draft, a questionnaire answer, or a
  single-answer draft passes `can_access` (`packages/shared/src/visibility-client.ts`) for the
  asker at write time; dropped citations are counted on the row (`dropped_citation_count`). Reads
  re-filter per viewer, because visibility can change after the draft was written (Bursar's
  attach-and-read rule, `apps/bursar-api/src/lib/bin-asset-access.ts:1-26`).
- **Closed probe menu.** The model selects from a catalog of code-reviewed probes; it cannot
  author a query.
- **Read-only probe execution.** Probes run in `SET TRANSACTION READ ONLY` with
  `statement_timeout = 15s` inside `runInOrgScope`, on `DATABASE_READ_URL` when configured.
- **Injection pre-scan** on questionnaires and custom framework documents; uploaded text is
  always data inside a delimited block, never instructions.
- **No outbound transport.** Bastion sends no email and posts to no external system. Questionnaire
  exports are downloads; the auditor room is pull-only.

---

## 3. The evidence engine

### 3.1 The probe catalog (native evidence)

Probes live in `apps/bastion-api/src/probes/<key>.ts`. Each exports `{ key, version,
paramsSchema (Zod), preconditions(), run(tx, params, window), redact(), explain(result) }`. `run`
uses parameterized `sql` tagged templates over the shared DB (no Drizzle declarations of foreign
tables, so `scripts/db-check.mjs` is unaffected). `query_fingerprint` is the SHA-256 of the
probe's SQL template text, recorded on every snapshot so an auditor can see exactly which query
produced a result and that it did not change between two snapshots.

Every org predicate is explicit (`org_id` / `organization_id` / membership join) because the
connecting role still bypasses RLS (`apps/bursar-api/src/plugins/rls.ts:29-36`).

| Key | Source (verified in repo) | Precondition (else `unprovable`) | Default predicate | Cited refs |
| --- | --- | --- | --- | --- |
| `keys.max_age` | `api_keys` (`org_id`, `created_at`, `rotated_at`, `rotation_grace_expires_at`; `apps/api/src/db/schema/api-keys.ts:11-41`) | none | no key older than 90 days since `coalesce(rotated_at, created_at)` | key name + prefix, owner name |
| `keys.unused_active` | `api_keys.last_used_at` | none | no key unused for 60+ days | key name + prefix |
| `access.departed_still_holding` | `users.is_active`, `users.disabled_at`, `organization_memberships`, `api_keys`, `sessions.active_org_id` | none | zero people who left (inactive, disabled, or no longer a member) still hold a key or live session for this org | person name |
| `access.dormant_accounts` | `organization_memberships`, `login_history` (success rows; **no org column**, joined via `user_id`), `sessions.last_used_at` | none | zero human members with no sign-in for 90 days | person name |
| `access.privileged_roster` | `organization_memberships.role`, `users.is_superuser` | none | at most 3 owners/admins | person name, role |
| `auth.failed_login_spikes` | `login_history` (`success = false`) for member emails | none | at most 0 hours with 10+ failures for one account | person name, hour (no IP addresses) |
| `agents.policy_coverage` | `users.kind in ('agent','service')`, `agent_policies` (`apps/api/src/db/schema/agent-policies.ts:28-49`) | at least 1 agent or service user in the org | every agent has a policy row (so its kill switch exists) and no bare `*` allowlist | agent name |
| `agents.human_approval` | `agent_proposals` (status, `decided_at`, `expires_at`) | at least 1 proposal in window | at most 5 proposals expired without a decision in the window | proposal title |
| `change.merge_reviewed` | **new** `github_pr_events` (section 8.4) joined to `github_integrations` | an enabled integration AND at least one review event received in 30 days | 100% of merges to the default branch had an approval from someone other than the author before merge | repo, PR number + title |
| `change.merge_traceable` | `github_pr_events.task_refs` | an enabled integration | at least 90% of merges reference a Bam task | repo, PR number |
| `ops.backup_fresh` (inherited) | `platform_backups` (`status`, `completed_at`; platform-scoped, `apps/api/src/db/schema/platform-backups.ts:7-24`) | at least 1 scheduled backup exists | a completed backup within 26 hours | none (platform fact, counts only) |
| `ops.restore_tested` (inherited) | `platform_restores` | none | a completed restore within 365 days | none |
| `logging.retention_floor` | `blip_retention_policies` + `blip_tracked_apps` (`apps/blip-api/src/db/schema/blip-retention-policies.ts:10-25`) | at least 1 tracked app | every tracked app keeps logs at least 90 days (null age = unlimited, passes) | tracked app name |
| `logging.audit_trail_alive` | `v_activity_unified` (`organization_id`, `created_at`) | none | activity recorded in the last 7 days | counts only |
| `automation.failure_rate` | `bolt_executions` joined to `bolt_automations` | at least 1 enabled automation | at most 5% failed in 30 days | automation name |
| `policy.attested` | `bastion_policy_attestations` vs required people | a linked policy | 100% of required people attested to the current version within the cadence | person name (missing) |
| `policy.current` | `beacon_entries` (`status = 'Active'`, `expires_at`, `last_verified_at`) | a linked policy | Active, not expired, verified within 365 days | article title |
| `platform.superuser_access` | `superuser_audit_log.target_org_id` | none | informational; at most N platform-operator actions in 30 days, all cited | action name, date |
| `vendors.critical_have_award` | `bursar_vendors.criticality`, `bursar_awards` | at least 1 Bursar vendor | every critical vendor has an active award on file | vendor name |
| `feed.fresh` | `bastion_feed_records` | the feed exists | a record within the feed's cadence, and the optional count predicate holds | feed record subject labels |

**Inherited controls.** The two `ops.*` probes read platform-scoped facts. On a self-hosted
single-org deploy that is the org's own control. On a multi-tenant hosted deploy it is the
platform operator's control, and the UI labels it **"Provided by your hosting platform"** so an
auditor can treat it as a carve-out (section 15.3).

**What has no native probe, and says so.** MFA coverage (the platform has no MFA or TOTP: no
matching schema or migration exists), device encryption, cloud infrastructure configuration,
background checks, and physical security. These controls are proposed with manual evidence specs
from day one, and the coverage graph shows them as `manual` or `none`, never as gaps the product
pretends it will close natively.

**Redaction.** Probes never put secrets, key hashes, IP addresses, session ids, or user-agent
strings into evidence. Cited refs carry `{ entity_type, entity_id, label }`, capped at 200 per
snapshot with an `overflow_count`.

### 3.2 Outcomes and reason codes

Three statuses only: `pass`, `fail`, `unprovable`. The UI words are **Proven**, **Not met**,
**Can't prove yet**. `unprovable` always carries one reason:

| Reason | Plain UI text |
| --- | --- |
| `not_yet_confirmed` | "Nobody has confirmed how to check this yet." |
| `no_evidence_source` | "Nothing in the suite can show this. Upload evidence or connect a source." |
| `source_not_connected` | "This could be checked automatically, but {source} isn't connected." |
| `manual_evidence_missing` | "Waiting for {owner} to upload {what}." |
| `manual_evidence_expired` | "The evidence {owner} uploaded expired on {date}." |
| `insufficient_data` | "There wasn't enough activity in the period to tell." |
| `probe_error` | "The check couldn't run last night. We'll try again tonight." |

`not_applicable` is a control applicability state (with a required written reason), not a
status; such controls are excluded from every count and listed separately for the auditor.

### 3.3 Uploaded and manual evidence (the answer to Seat E)

Manual evidence obeys **the same rules as native evidence**: immutable bytes, a SHA-256 hash, a
named owner, a period covered, an expiry, a citation on every snapshot that uses it, and an entry
in the same evidence ledger.

**Kinds.**

| Kind | Example | Trust level shown |
| --- | --- | --- |
| `file` | Google Workspace 2-Step Verification report (CSV), AWS IAM credential report, Jamf encryption export, a pen-test PDF | "Uploaded evidence" |
| `attestation_statement` | "All six laptops have FileVault on. Checked by the Professor on 2026-11-02." (a typed statement, no file) | "Self-attested" (weaker; ranked as a gap of lower severity relief) |
| `feed_record` | Records pushed by a machine feed (section 3.5) | "Automated feed" |

**Upload path (reuses Bin).** The SPA uploads the file to Bin through bin-api's existing upload
route with the user's session (so Bin's AV scan, `bin-av-scan`, runs), into a per-org "Compliance
evidence" folder Bastion creates on first use. The SPA then calls
`POST /bastion/api/v1/manual-evidence` with the asset id and metadata. bastion-api:

1. checks the asset with the four-check `assertBinAssetReadable` pattern
   (`apps/bursar-api/src/lib/bin-asset-access.ts`: `can_access`, same org, `scan_status =
   'clean'`, exists), returning 404 on any failure;
2. pins `current_version_id`;
3. once the scan is clean (a pending scan leaves the row `pending_scan`; the
   `bastion-evidence-ingest` job retries), re-asserts the four checks immediately before reading,
   streams the pinned version's bytes, computes SHA-256, and writes them to Bastion's own
   immutable, content-addressed key `<org>/bastion/objects/<sha256>` via
   `@bigbluebam/storage` (`createBootstrapDriver`, as `apps/blip-api/src/lib/storage.ts:11-27`).
   A server-side `copyTo` is used when the driver supports it;
4. appends a ledger entry and flips the row to `active`.

Because Bastion keeps its own copy, a later Bin edit, archive, or delete cannot alter evidence an
auditor already saw. The Bin asset remains the user's working copy.

**Required metadata (form fields, plain labels).** What is this? Which system did it come from?
Who is responsible for it (owner, defaults to the control owner)? When was it produced? What
period does it cover? Is it restricted (HR, legal, pen-test)? Plus a required uploader
statement: "I confirm this is an unaltered export or an accurate statement." `valid_until`
defaults from the assertion's `manual_evidence_spec.cadence_days` (for example 90 days for an MFA
report) and may be shortened, never extended past the spec.

**Evaluation of a manual assertion.** `pass` if at least one `active` linked evidence item has
`valid_until >= now` and its period covers the assertion's required window, and a reviewer with
`bastion.evidence.review` has marked it `accepted`. A reviewer verdict of `shows_exception`
yields `fail`. No accepted current item yields `unprovable` (`manual_evidence_missing` or
`manual_evidence_expired`). **Manual evidence never yields `pass` on upload alone**; a second
person (or the owner, if the org has fewer than 3 humans, recorded as such) accepts it. Bastion
does not read the file's contents with an LLM in v1 (section 14).

**Freshness.** `bastion-evidence-expiry` warns at `manual_expiry_warn_days` (default 30) with
`evidence.expiring`, and flips status at expiry with `evidence.expired`. Expiring evidence
appears in the gap ranking before it lapses.

**Withdrawal, never deletion.** A floored, confirm-gated withdraw sets `status = 'withdrawn'`
with a reason and writes a `withdrawal` ledger entry. Bytes and the row remain; auditors can see
the withdrawal.

### 3.4 Immutability and the evidence ledger

Every evidence-bearing record (probe snapshot, manual evidence, feed record, policy attestation,
withdrawal) appends one row to `bastion_ledger_entries`:

```
entry_hash = sha256( prev_entry_hash || entry_kind || entry_id || content_sha256 || recorded_at_iso )
```

- Appends are serialized per org with `pg_advisory_xact_lock(hashtext('bastion_ledger:' || org))`
  inside a short transaction that contains **no outbound HTTP**
  (`apps/burn-api/src/lib/advisory-lock.ts` states the rule). Object writes happen before the
  transaction; objects are content-addressed, so an orphaned object from a rolled-back
  transaction is harmless and swept.
- **Four-path immutability** (the Bursar pattern for `bursar_baseline_items`): a `BEFORE UPDATE`
  trigger with a `WHEN` clause on content columns, a `BEFORE DELETE` trigger, `ON DELETE
  RESTRICT` foreign keys, and a `BEFORE TRUNCATE` statement trigger, on
  `bastion_evidence_snapshots`, `bastion_evidence_objects`, `bastion_manual_evidence` (content
  columns), `bastion_feed_records`, `bastion_policy_attestations`, `bastion_ledger_entries`, and
  `bastion_auditor_access_log`.
- **Snapshot dedup.** If tonight's canonical document is byte-identical to the last one, the
  object is reused (same `content_sha256`), but a new snapshot row and ledger entry are still
  written, because "it was still true on this date" is itself evidence.
- **Verification.** `GET /evidence/:id/verify` re-reads the object, recomputes SHA-256, and walks
  the ledger from the entry to the current head. The weekly `bastion-ledger-verify` job re-hashes
  a bounded sample (plus everything an open auditor room references) and publishes
  `evidence.integrity_failed` on any mismatch.
- **External witness.** A daily `ledger.sealed` Bolt event carries the head hash and sequence
  number. Orgs that route it to an outbound webhook or a Banter channel get an off-database record
  of the head, which makes silent rewriting of history detectable.
- **Honest limit.** Every service connects as a Postgres superuser today, so a determined DBA
  could disable triggers. The hash chain plus the external witness makes that detectable, not
  impossible. True WORM storage (S3 Object Lock) is v1.1 (section 15.5).

### 3.5 Machine feeds (external systems and sibling apps)

The optional, contract-defined feed path.

- **Contract.** `packages/shared/src/schemas/bastion-feeds.ts` defines
  `bastionFeedRecordSchema`: `{ feed_kind: 'training_completion' | 'incident_record' |
  'access_review' | 'device_inventory' | 'hr_roster' | 'generic', idempotency_key, occurred_at,
  subject_label, subject_user_email?, attributes (bounded record, 16 KB) , source_label }`.
- **API push.** `POST /bastion/api/v1/feeds/:feed_key/records` (batch up to 500) authenticated by a
  normal `bbam_` API key whose user holds `bastion.feed.write`. This is how an HR export script, a
  scheduled MDM report, or a cloud-config dump enters. Records are hashed, frozen, and ledgered
  like everything else; duplicates by `(feed, idempotency_key)` are no-ops.
- **Sibling apps (when present).** bolt-api gets `bastion-subscriptions.ts` and
  `bastion-dispatch-hook.ts`, modeled on `apps/bolt-api/src/services/bursar-dispatch-hook.ts`,
  forwarding subscribed events to `/v1/internal/events` (note the `/v1` prefix; the Bulwark and
  Braid cycles both shipped a live 404 by dropping it). v1 ships the registry with
  `proposal.decided` (platform) only. The training, incident, and access-review apps discussed in
  the session do not exist yet; when one ships it adds a registry entry mapping its event to a
  `feed_kind`, as part of its own milestone. Bastion needs no change to accept it.
- **Freshness** is the `feed.fresh` probe; a feed that goes quiet becomes `unprovable`
  (`source_not_connected`), not `pass`.

### 3.6 Policy attestation (Beacon)

Beacon has verification (`beacon_verifications`) but no acknowledgement record, so Bastion owns
attestation. An admin links a Beacon article as a policy, chooses who must read it (everyone, or
specific permission groups) and how often (default yearly). Members see **Policies to read** at
`/bastion/attest`: the SPA fetches the article body from beacon-api under their own session, and
**I have read and understood this** posts to bastion-api, which records the attestation against
the current `beacon_entries.version` and the SHA-256 of that version's `beacon_versions.body_markdown`
read **server-side** (never client-supplied). A new Beacon version resets the requirement for that
policy. Agents cannot attest.

---

## 4. Data model and migrations

All tables prefixed `bastion_`, org-scoped by `organization_id`, Drizzle schema in
`apps/bastion-api/src/db/schema/`, plus a `bbb-refs.ts` peer stub for `users` and
`organizations` as every satellite has. Cross-app refs are typed uuid columns with **no
cross-schema FK**. `entity_links` and `agent_proposals` use `org_id` (column-name boundary noted
at `apps/bursar-api/src/lib/entity-links.ts:13-15`).

### 4.1 Tables

**Frameworks and controls**

- **`bastion_frameworks`**: `id`, `organization_id`, `template_key` (nullable; `soc2`,
  `iso27001`, `starter`), `template_version`, `name`, `kind` CHECK (`template`,`custom`),
  `source_bin_asset_id`, `source_bin_asset_version_id`, `source_doc_sha256`, `status` CHECK
  (`draft`,`compiling`,`active`,`archived`), `audit_target_date`, `period_start`, `period_end`,
  `adopted_by`, timestamps. Index `(organization_id, status)`.
- **`bastion_controls`**: `id`, `organization_id`, `framework_id` (RESTRICT), `ref_code`,
  `title`, `plain_summary`, `category`, `risk_weight smallint` CHECK 1-5, `owner_user_id` (SET
  NULL), `applicability` CHECK (`applicable`,`not_applicable`), `not_applicable_reason`,
  `cited_span jsonb` (custom only), `status` CHECK (`pass`,`fail`,`unprovable`),
  `status_reason`, `coverage_kind` CHECK (`native`,`feed`,`manual`,`attested`,`mixed`,`none`),
  `last_evaluated_at`, `status_changed_at`, timestamps. Unique `(organization_id, framework_id,
  ref_code)`. Index `(organization_id, status)`, `(organization_id, owner_user_id)`. A
  `tsvector` generated column over `title || plain_summary` with GIN index (questionnaire
  retrieval).
- **`bastion_assertions`**: `id`, `organization_id`, `control_id` (RESTRICT), `kind` CHECK
  (`probe`,`manual`,`feed`), `probe_key`, `probe_version`, `params jsonb`, `predicate jsonb`,
  `manual_evidence_spec jsonb` (`what`, `example`, `cadence_days`, `required_window_days`),
  `feed_id`, `plain_statement` (bounded 500), `proposed_by` CHECK
  (`template`,`compiler`,`human`,`agent`), `compile_run_id`, `review_status` CHECK
  (`proposed`,`confirmed`,`rejected`,`superseded`), `supersedes_id`, `confirmed_by`,
  `confirmed_at`, `created_by`, timestamps. Content columns immutable once `confirmed`
  (trigger). Index `(organization_id, control_id, review_status)`.
- **`bastion_compile_runs`**: `id`, `organization_id`, `framework_id`, `status` CHECK
  (`running`,`succeeded`,`partial`,`failed`), `controls_total`, `controls_done`,
  `assertions_proposed`, `assertions_dropped`, `drop_reasons jsonb`, `llm_calls_used`,
  `used_fallback boolean`, `claimed_by`, `heartbeat_at`, `error`, timestamps.

**Evaluation and evidence**

- **`bastion_evaluation_runs`**: `id`, `organization_id`, `trigger` CHECK
  (`nightly`,`manual`,`agent`), `scope` CHECK (`all`,`control`), `control_id`, `status` (as
  compile runs), `controls_total`, `controls_done`, `pass_count`, `fail_count`,
  `unprovable_count`, `claimed_by`, `heartbeat_at`, `as_of`, `started_by`, timestamps.
  Partial unique `(organization_id) WHERE status = 'running' AND scope = 'all'`.
- **`bastion_evidence_objects`**: `organization_id`, `content_sha256`, `object_key`,
  `size_bytes`, `content_type`, `created_at`. PK `(organization_id, content_sha256)`. Immutable.
- **`bastion_evidence_snapshots`**: `id`, `organization_id`, `evaluation_run_id`,
  `assertion_id` (RESTRICT), `control_id`, `outcome` CHECK (`pass`,`fail`,`unprovable`),
  `unprovable_reason`, `probe_key`, `probe_version`, `params jsonb`, `query_fingerprint`,
  `window_start`, `window_end`, `summary jsonb` (bounded counts), `cited_refs jsonb`,
  `overflow_count`, `manual_evidence_ids uuid[]`, `feed_record_count`, `content_sha256` (FK to
  objects), `ledger_seq`, `created_at`. Immutable. Index `(organization_id, control_id,
  created_at DESC)`.
- **`bastion_manual_evidence`**: `id`, `organization_id`, `kind` CHECK
  (`file`,`attestation_statement`), `title`, `description`, `source_system`, `bin_asset_id`,
  `bin_asset_version_id`, `content_sha256`, `size_bytes`, `content_type`, `statement_text`
  (attestation kind), `owner_user_id`, `uploaded_by`, `produced_on`, `period_start`,
  `period_end`, `valid_until`, `sensitivity` CHECK (`standard`,`restricted`),
  `uploader_statement`, `uploader_statement_at`, `status` CHECK
  (`pending_scan`,`active`,`superseded`,`withdrawn`,`blocked`), `superseded_by_id`,
  `withdrawn_reason`, `withdrawn_by`, `withdrawn_at`, `ledger_seq`, timestamps. Content columns
  immutable after `active`; only status columns may change (trigger WHEN clause). Index
  `(organization_id, status, valid_until)`.
- **`bastion_manual_evidence_links`**: `id`, `organization_id`, `manual_evidence_id`,
  `assertion_id`, `review_verdict` CHECK (`pending`,`accepted`,`shows_exception`),
  `reviewed_by`, `reviewed_at`, `review_note`, `linked_by`, `linked_at`, `unlinked_at`.
  Unique `(organization_id, manual_evidence_id, assertion_id)`.
- **`bastion_evidence_feeds`**: `id`, `organization_id`, `feed_key` (slug), `label`,
  `feed_kind`, `source_kind` CHECK (`api_push`,`bolt_event`), `bolt_source`, `bolt_event_type`,
  `cadence_days`, `status` CHECK (`active`,`paused`), `last_record_at`, timestamps. Unique
  `(organization_id, feed_key)`.
- **`bastion_feed_records`**: `id`, `organization_id`, `feed_id`, `idempotency_key`,
  `occurred_at`, `subject_label`, `subject_user_id`, `attributes jsonb` (16 KB CHECK on
  `pg_column_size`), `payload_sha256`, `ledger_seq`, `received_at`. Unique `(organization_id,
  feed_id, idempotency_key)`. Immutable.
- **`bastion_ingest_events`**: durable inbox for `/internal/events` (shape of Bursar's
  `bursar_ingest_events`): `source`, `event_type`, `source_idempotency_key`, `payload jsonb`,
  `status`, `claimed_by`, `heartbeat_at`, `attempts`, timestamps. Unique `(organization_id,
  source_idempotency_key)`.
- **`bastion_ledger_entries`**: `organization_id`, `seq bigint`, `entry_kind` CHECK
  (`snapshot`,`manual_evidence`,`feed_record`,`attestation`,`withdrawal`), `entry_id`,
  `content_sha256`, `prev_entry_hash`, `entry_hash`, `recorded_at`. PK `(organization_id,
  seq)`. Immutable.

**Gaps, drift, fixes**

- **`bastion_drift_events`**: `id`, `organization_id`, `control_id`, `from_status`,
  `to_status`, `reason`, `snapshot_id`, `bam_task_id`, `proposal_id`, `acknowledged_by`,
  `acknowledged_at`, `detected_at`. Index `(organization_id, detected_at DESC)`.
- **`bastion_gaps`**: `id`, `organization_id`, `control_id`, `assertion_id`, `gap_kind` CHECK
  (`failing`,`unprovable_no_source`,`unprovable_not_connected`,`manual_missing`,
  `manual_expiring`,`manual_expired`,`not_yet_confirmed`), `risk_score numeric(8,4)`,
  `fix_template`, `fix_cost smallint`, `status` CHECK (`open`,`proposed`,`resolved`,
  `dismissed`), `dismissed_reason`, `dismissed_by`, `computed_at`. Unique `(organization_id,
  control_id, assertion_id, gap_kind)`.
- **`bastion_fix_drafts`**: `id`, `organization_id`, `gap_id`, `template` CHECK (six values),
  `title`, `body_markdown`, `payload jsonb`, `cited_refs jsonb`, `dropped_citation_count`,
  `proposal_id`, `status` CHECK (`proposed`,`approved`,`rejected`,`expired`,`applied`),
  `applied_entity_type`, `applied_entity_id`, `created_by`, `created_by_kind`, timestamps.

**Policies**

- **`bastion_policies`**: `id`, `organization_id`, `beacon_entry_id`, `title_cache`,
  `audience jsonb` (`{all_members: true}` or group ids), `cadence_days`, `owner_user_id`,
  `status` CHECK (`active`,`retired`), timestamps. Unique `(organization_id, beacon_entry_id)`.
- **`bastion_policy_attestations`**: `id`, `organization_id`, `policy_id`, `beacon_entry_id`,
  `beacon_version int`, `body_sha256`, `user_id`, `attested_at`, `ledger_seq`. Unique
  `(organization_id, policy_id, beacon_version, user_id)`. Immutable.

**Questionnaires**

- **`bastion_questionnaires`**: `id`, `organization_id`, `title`, `requester_label`,
  `bond_deal_id`, `bond_company_id`, `source_bin_asset_id`, `source_bin_asset_version_id`,
  `source_sha256`, `format` CHECK (`xlsx`,`csv`), `column_map jsonb`, `status` CHECK
  (`uploaded`,`mapping`,`answering`,`in_review`,`approved`,`exported`,`failed`),
  `injection_suspected`, `row_count`, `rows_done`, `low_count`, `medium_count`, `high_count`,
  `due_date`, `owner_user_id`, `claimed_by`, `heartbeat_at`, `approved_by`, `approved_at`,
  timestamps.
- **`bastion_questionnaire_items`**: `id`, `organization_id`, `questionnaire_id`, `row_index`,
  `sheet_name`, `section`, `question_text` (bounded 4000), `answer_kind` CHECK
  (`yes_no`,`text`,`yes_no_text`), `draft_answer`, `draft_yes_no`, `final_answer`,
  `final_yes_no`, `cited_refs jsonb`, `dropped_citation_count`, `confidence numeric(4,3)`,
  `confidence_band` CHECK (`high`,`medium`,`low`), `band_reasons jsonb`, `review_status` CHECK
  (`pending`,`accepted`,`edited`,`needs_owner`), `assigned_to`, `reviewed_by`, `reviewed_at`.
  Unique `(organization_id, questionnaire_id, sheet_name, row_index)`.
- **`bastion_answer_library`**: `id`, `organization_id`, `question_text`, `answer_text`,
  `yes_no`, `cited_refs jsonb`, `source_item_id`, `approved_by`, `approved_at`, `stale boolean`,
  `stale_reason`, `retired_at`, `tsv tsvector` (generated, GIN). Index `(organization_id,
  stale, retired_at)`.

**Sharing**

- **`bastion_auditor_rooms`**: `id`, `organization_id`, `framework_id`, `label` (auditor firm),
  `token_sha256` (unique), `token_hint` (last 4 chars), `passcode_hash` (argon2, nullable),
  `period_start`, `period_end`, `control_ids uuid[]` (null = all applicable),
  `include_restricted boolean default false`, `expires_at NOT NULL`, `revoked_at`,
  `created_by`, `last_accessed_at`, `access_count`, timestamps. CHECK `expires_at <= created_at
  + interval '180 days'` (settings may set a lower ceiling).
- **`bastion_auditor_access_log`**: `id`, `organization_id`, `room_id`, `accessed_at`,
  `view_kind` CHECK (`overview`,`control`,`evidence`,`download`,`request`), `object_ref`,
  `ip_hash` (salted SHA-256), `user_agent_trunc` (120). Immutable.
- **`bastion_auditor_requests`**: `id`, `organization_id`, `room_id`, `control_id`,
  `requester_name`, `body` (bounded 5000), `status` CHECK (`open`,`answered`,`closed`),
  `answered_by`, `answer_note`, timestamps.
- **`bastion_trust_pages`**: `id`, `organization_id`, `slug` (unique), `status` CHECK
  (`draft`,`published`,`unpublished`), `draft_content jsonb`, `published_content jsonb`,
  `published_sha256`, `published_by`, `published_at`, timestamps.
- **`bastion_export_packets`**: `id`, `organization_id`, `framework_id`, `period_start`,
  `period_end`, `include_restricted`, `status`, `object_key`, `content_sha256`, `size_bytes`,
  `requested_by`, `claimed_by`, `heartbeat_at`, `error`, timestamps.

**Settings and audit**

- **`bastion_org_settings`**: `organization_id` PK, `llm_provider_id`, `compliance_project_id`
  (Bam project for remediation tasks), `remediation_tasks` CHECK (`create`,`propose`),
  `timezone`, `evaluation_hour_local` (default 3), `manual_expiry_warn_days` (30),
  `questionnaire_high_floor` (0.80), `questionnaire_medium_floor` (0.55),
  `max_llm_calls_per_compile` (400), `max_llm_calls_per_questionnaire` (1200),
  `max_rows_per_questionnaire` (1000), `auditor_room_max_days` (90), `company_profile jsonb`,
  `updated_by`, `updated_at`.
- **`bastion_audit_log`**: `id`, `organization_id`, `actor_id`, `actor_kind`, `action`,
  `subject_type`, `subject_id`, `details jsonb`, `created_at`. Every assertion confirmation,
  evidence review, withdrawal, room create/revoke, trust-page publish, settings change, and
  questionnaire approval lands here. Append-only.

**Count:** 28 `bastion_` tables, plus 1 Bam-owned table (`github_pr_events`, section 8.4).

### 4.2 Reused platform tables (read-only unless noted)

`users`, `organizations`, `organization_memberships`, `sessions`, `login_history`, `api_keys`,
`agent_policies`, `agent_proposals` (insert + read), `entity_links` (insert), `superuser_audit_log`,
`platform_backups`, `platform_restores`, `v_activity_unified`, `github_integrations`,
`beacon_entries`, `beacon_versions`, `blip_tracked_apps`, `blip_retention_policies`,
`bolt_automations`, `bolt_executions`, `bin_assets`, `bin_asset_versions`, `bursar_vendors`,
`bursar_awards`, `bond_deals`, `bond_companies`, `llm_providers` (via the internal proxy only).

### 4.3 RLS posture

Policies are **generated** by a `DO $$` loop over `information_schema.tables` for the
`bastion\_%` prefix, exactly as `infra/postgres/migrations/0251_bursar_rls.sql:20-50` (ENABLE,
`DROP POLICY IF EXISTS`, `CREATE POLICY ... USING (organization_id =
current_setting('app.current_org_id', true)::uuid)`). No variant policy is needed because there
are no global rows (templates are code, section 2.1). Two exceptions are handled in code, not by
weakening policies:

- **Public routes** (auditor room, trust page) resolve the org from the token or slug with a
  single lookup in a dedicated function, then do all further work inside
  `runInOrgScope(resolvedOrgId, ...)`.
- **Org-iterating jobs** take the per-org advisory lock and call `runInOrgScope` once per org.

bastion-api adopts Bursar's transaction-scoped binding (`apps/bursar-api/src/plugins/rls.ts:58-68`)
and reports the effective posture at boot with `boot/assert-rls-bound.ts`. The honest caveat
stands: the connecting role bypasses RLS today, so every query carries an explicit
`organization_id` predicate. `test/rls-coverage.test.ts` asserts every `bastion_%` table has a
policy.

### 4.4 Migration plan

Anchor: **current tip + 1, observed at authoring time**. Tip today is
`0259_bursar_builtin_group_defaults.sql`. Re-run `ls infra/postgres/migrations/*.sql | tail -3`
after any rebase; other apps land on this branch.

| # | File | Contents |
| --- | --- | --- |
| 0260 | `0260_bastion_core.sql` | frameworks, controls (+ tsvector), assertions (+ confirmed-content trigger), compile runs, org settings, audit log; the **Bastion System** sentinel user `00000000-0000-0000-0000-0000000000b5` in the shared sentinel org, `kind = 'service'`, `password_hash = '!'`, both `ON CONFLICT (id)` and `ON CONFLICT (email)` inserts as `0234_bulwark_core.sql:297-327` (b1-b4 are taken) |
| 0261 | `0261_bastion_evidence.sql` | evaluation runs, evidence objects, snapshots, manual evidence, links, feeds, feed records, ingest events, ledger entries; all immutability triggers (UPDATE with WHEN, DELETE, TRUNCATE) |
| 0262 | `0262_bastion_gaps_policies.sql` | drift events, gaps, fix drafts, policies, policy attestations (+ immutability) |
| 0263 | `0263_bastion_questionnaires.sql` | questionnaires, items, answer library (+ tsvector) |
| 0264 | `0264_bastion_sharing.sql` | auditor rooms, access log (+ immutability), auditor requests, trust pages, export packets |
| 0265 | `0265_github_pr_events.sql` | **Bam-owned** append-only `github_pr_events` (section 8.4); header states it is an apps/api table created for Bastion's change-management probes |
| 0266 | `0266_bastion_rls.sql` | the generated RLS loop |
| M9 | `<observed>_permissions_seed_actions_delta_025.sql` | emitted by `scripts/build-permission-delta.mjs`; **number observed, never chosen** |
| M9 | `<observed + 1>_bastion_builtin_group_defaults.sql` | authored **only after** the delta is applied |

Every file starts with the header block (filename marker, `-- Why:`, `-- Client impact:
additive only`), uses `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`DROP TRIGGER IF EXISTS ...; CREATE TRIGGER ...`, and `DROP POLICY IF EXISTS ...; CREATE POLICY
...`. There are no destructive ALTERs in v1. Decision recorded in the 0261 header: **no
partitioning in v1** (snapshot volume is roughly assertions x nights, about 55,000 rows per org per
year at 150 assertions, which is well within a btree on `(organization_id, control_id,
created_at)`).

### 4.5 The permission procedure (M9, never M1)

Unchanged from Bursar section 17.2 because the trap is identical: the manifest generator walks
routes and tools, and the delta generator numbers itself `max(prefix) + 1`. Bastion's rows are
added to the `HAND_AUTHORED` array in `scripts/generate-permission-manifest.mjs` (line 719;
satellite apps are not in `APP_TO_PREFIX`, per the comment at lines 861-880).

```sh
node scripts/generate-permission-manifest.mjs       # emits bastion.* from HAND_AUTHORED
node scripts/build-permission-codegen.mjs
node scripts/build-permission-delta.mjs             # OBSERVE the number it assigns
node scripts/check-permission-catalog.mjs
docker compose run --rm migrate
# ONLY NOW author <observed + 1>_bastion_builtin_group_defaults.sql
docker compose run --rm migrate
```

Authoring the group-defaults file first makes it run first, match zero rows, succeed, get
checksummed, and never re-run, leaving every non-SuperUser at `implicit_deny` on every `/bastion`
route. That has happened twice (`0259` header).

**Interim posture M1-M8:** `bastion.*` actions do not exist, so with the fail-closed boot
invariant every `/bastion` route denies non-SuperUsers. Development and Playwright run as Skipper
(seeded SuperUser) until M9. Nobody "fixes" this by weakening the invariant.

### 4.6 The probe is the gate

```sql
SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
FROM permission_group_defaults d
JOIN permissions p ON p.id = d.permission_id
JOIN permission_groups pg ON pg.id = d.group_id
WHERE p.app = 'bastion' GROUP BY 1;
```

The CI assertion parses the section 5.5 table and recomputes. Sanity target only:
`owner = admin = 47`, `member = 23`, `viewer = 9`, `guest = 0`. **If this line disagrees with the
table, the table wins.**

---

## 5. API surface, MCP tools, permissions

Base path `/bastion/api/v1/...`; Fastify mounts routes under `/v1` (as
`apps/bursar-api/src/server.ts:146-172`) and nginx strips `/bastion/api`. Cursor pagination
(`?cursor=&limit=`, response `{ data, meta: { next_cursor, has_more } }`), `?filter[field]=`,
`?sort=-field`, and the platform error envelope `{ error: { code, message, details[],
request_id } }` everywhere. Writes return `{ data }`. Stale updates use `updated_at` and 409.

### 5.1 REST endpoints

| # | Method and path | Permission | MCP tool |
| --- | --- | --- | --- |
| 1 | `GET /library/templates` | `framework.read` | skip: static catalog, surfaced inside `bastion_list_frameworks` |
| 2 | `GET /frameworks` | `framework.read` | `bastion_list_frameworks` |
| 3 | `POST /frameworks` (adopt template or create custom) | `framework.write` | skip: setup is a human act |
| 4 | `GET /frameworks/:id` | `framework.read` | `bastion_list_frameworks` (by id) |
| 5 | `PATCH /frameworks/:id` | `framework.write` | skip: human admin |
| 6 | `POST /frameworks/:id/archive` (confirm) | `framework.write` | skip: destructive human act |
| 7 | `POST /frameworks/:id/compile` (202 + run id) | `framework.compile` | `bastion_compile_framework` |
| 8 | `GET /frameworks/:id/compile-runs` | `framework.read` | `bastion_compile_framework` (status mode) |
| 9 | `GET /controls` | `control.read` | `bastion_list_controls` |
| 10 | `GET /controls/:id` | `control.read` | `bastion_control_status` |
| 11 | `PATCH /controls/:id` (owner, applicability, summary) | `control.write` | skip: human admin |
| 12 | `GET /controls/:id/assertions` | `control.read` | `bastion_control_status` (includes assertions) |
| 13 | `POST /controls/:id/assertions` (lands `proposed`) | `assertion.propose` | `bastion_propose_assertion` |
| 14 | `POST /assertions/:id/confirm` | `assertion.confirm` | skip: the human confirmation gate |
| 15 | `POST /assertions/:id/reject` | `assertion.confirm` | skip: human gate |
| 16 | `POST /assertions/:id/revise` (new superseding proposal) | `assertion.propose` | `bastion_propose_assertion` (revise mode) |
| 17 | `GET /probes` (catalog, params, plain text, precondition met?) | `control.read` | `bastion_list_probes` |
| 18 | `POST /evaluations` (202; scope all or control) | `evaluation.run` | `bastion_run_evaluation` |
| 19 | `GET /evaluations` | `control.read` | `bastion_list_evaluations` |
| 20 | `GET /evaluations/:id` | `control.read` | `bastion_list_evaluations` (by id) |
| 21 | `GET /controls/:id/evidence` (snapshot timeline) | `evidence.read` | `bastion_evidence_for` |
| 22 | `GET /evidence/:id` (refs need `evidence.read_detail` or control ownership) | `evidence.read` | `bastion_get_evidence` |
| 23 | `GET /evidence/:id/verify` | `evidence.read` | `bastion_verify_evidence` |
| 24 | `GET /evidence/:id/download` (canonical JSON) | `evidence.read_detail` | skip: binary download |
| 25 | `POST /manual-evidence` (attach Bin asset or statement) | `evidence.upload` | skip: a human attests to provenance |
| 26 | `GET /manual-evidence` | `evidence.read` | `bastion_list_manual_evidence` |
| 27 | `GET /manual-evidence/:id` | `evidence.read` (+ `read_restricted` for restricted) | `bastion_list_manual_evidence` (by id) |
| 28 | `GET /manual-evidence/:id/download` | `evidence.read_detail` (+ restricted) | skip: binary download |
| 29 | `POST /manual-evidence/:id/links` | `evidence.link` | skip: human curation |
| 30 | `DELETE /manual-evidence/:id/links/:assertion_id` (sets `unlinked_at`) | `evidence.link` | skip: human curation |
| 31 | `POST /manual-evidence/:id/links/:assertion_id/review` | `evidence.review` | skip: human adjudication |
| 32 | `POST /manual-evidence/:id/withdraw` (confirm) | `evidence.withdraw` | skip: destructive human act |
| 33 | `POST /manual-evidence/:id/supersede` | `evidence.upload` | skip: human attests |
| 34 | `GET /feeds` | `feed.read` | skip: admin configuration surface |
| 35 | `POST /feeds` | `feed.manage` | skip: admin configuration |
| 36 | `PATCH /feeds/:id` | `feed.manage` | skip: admin configuration |
| 37 | `POST /feeds/:feed_key/records` (API-key machine push) | `feed.write` | skip: machine ingest path, not an agent action |
| 38 | `GET /feeds/:id/records` | `feed.read` | skip: admin inspection |
| 39 | `GET /coverage` (graph nodes, edges, four-number summary) | `control.read` | `bastion_coverage_summary` |
| 40 | `GET /gaps` (ranked; `?sort=quick_wins`) | `gap.read` | `bastion_coverage_gaps` |
| 41 | `POST /gaps/:id/propose-fix` | `fix.draft` | `bastion_propose_fix` |
| 42 | `POST /gaps/:id/dismiss` (reason) | `gap.dismiss` | skip: human adjudication |
| 43 | `GET /fix-drafts` | `fix.read` | skip: drafts are read via `proposal_list` |
| 44 | `GET /fix-drafts/:id` | `fix.read` | skip: read via `proposal_list` |
| 45 | `POST /fix-drafts/:id/mark-applied` | `fix.mark_applied` | skip: records a human's action in another app |
| 46 | `GET /drift` | `drift.read` | `bastion_list_drift` |
| 47 | `POST /drift/:id/acknowledge` | `drift.acknowledge` | skip: human acknowledgement |
| 48 | `GET /policies` | `policy.read` | skip: covered by `bastion_attestation_status` |
| 49 | `POST /policies` (link a Beacon article) | `policy.write` | skip: human admin |
| 50 | `PATCH /policies/:id` | `policy.write` | skip: human admin |
| 51 | `GET /policies/:id/attestations` | `attestation.read` | `bastion_attestation_status` |
| 52 | `GET /me/attestations` | `attestation.sign` | skip: personal UI list |
| 53 | `POST /policies/:id/attest` | `attestation.sign` | skip: humans only; agents may never attest |
| 54 | `POST /policies/:id/request-attestations` | `attestation.request` | skip: human admin nudge |
| 55 | `GET /questionnaires` | `questionnaire.read` | `bastion_list_questionnaires` |
| 56 | `POST /questionnaires` (from Bin asset) | `questionnaire.write` | skip: file intake is a human act |
| 57 | `GET /questionnaires/:id` | `questionnaire.read` | `bastion_get_questionnaire` |
| 58 | `PATCH /questionnaires/:id` (column map, deal link, owner) | `questionnaire.write` | skip: human mapping |
| 59 | `POST /questionnaires/:id/autofill` (202) | `questionnaire.write` | `bastion_questionnaire_autofill` |
| 60 | `GET /questionnaires/:id/items` | `questionnaire.read` | `bastion_get_questionnaire` (includes items) |
| 61 | `PATCH /questionnaire-items/:id` | `questionnaire.write` | skip: human review |
| 62 | `POST /questionnaires/:id/approve` (confirm) | `questionnaire.approve` | skip: the human release gate |
| 63 | `GET /questionnaires/:id/export` | `questionnaire.export` | skip: binary download after approval |
| 64 | `POST /answers/draft` | `questionnaire.write` | `bastion_draft_answer` |
| 65 | `GET /answer-library` | `answer_library.read` | `bastion_search_answer_library` |
| 66 | `PATCH /answer-library/:id` (edit or retire) | `answer_library.write` | skip: human curation |
| 67 | `GET /auditor-rooms` | `auditor_room.read` | skip: floored sharing admin |
| 68 | `POST /auditor-rooms` (token returned once; confirm) | `auditor_room.create` | skip: disclosure is a human act |
| 69 | `POST /auditor-rooms/:id/revoke` (confirm) | `auditor_room.revoke` | skip: human act |
| 70 | `GET /auditor-rooms/:id/access-log` | `auditor_room.read` | skip: floored |
| 71 | `GET /auditor-requests` | `auditor_room.read` | skip: floored |
| 72 | `PATCH /auditor-requests/:id` | `auditor_room.read` | skip: floored |
| 73 | `POST /exports` (202) | `export.create` | skip: produces a binary packet |
| 74 | `GET /exports` | `export.read` | skip: floored |
| 75 | `GET /exports/:id/download` | `export.read` | skip: binary download |
| 76 | `GET /trust-page` | `trust_page.read` | skip: publishing admin |
| 77 | `PUT /trust-page` (draft content) | `trust_page.write` | skip: publishing admin |
| 78 | `POST /trust-page/publish` (confirm) | `trust_page.publish` | skip: public disclosure is a human act |
| 79 | `POST /trust-page/unpublish` | `trust_page.publish` | skip: human act |
| 80 | `GET /summary` (home numbers) | `control.read` | `bastion_coverage_summary` (same data) |
| 81 | `GET /search?q=` (controls + policies, for `search_everything`) | `control.read` | skip: consumed by `search_everything`, not a standalone tool |
| 82 | `GET /settings` | `settings.read` | skip: admin |
| 83 | `PATCH /settings` | `settings.write` | skip: admin |
| 84 | `GET /audit` | `audit.read` | skip: floored |
| 85 | `GET /public/room` (header `X-Bastion-Room-Token`, optional passcode) | token | skip: public token-gated, no session |
| 86 | `GET /public/room/controls/:id` | token | skip: public |
| 87 | `GET /public/room/evidence/:id` (+ `?download=1`) | token | skip: public |
| 88 | `POST /public/room/requests` | token | skip: public |
| 89 | `GET /public/trust/:slug` | none | skip: public |
| 90 | `POST /internal/events` | internal secret | skip: service-to-service |
| 91 | `POST /internal/engines/:name` (202) | internal secret | skip: service-to-service |
| 92 | `GET /health`, `GET /health/ready`, `GET /metrics` | none | skip: health |

**Count:** 91 REST endpoints in rows 1-91, plus the three health routes registered by
`@bigbluebam/service-health`. Of the 91, 30 rows map to an MCP tool and 61 are intentional skips.

Internal routes register outside any session gate (Bursar's `internal.routes.ts` pattern) and use
`requireInternalSecret` (`apps/bursar-api/src/lib/internal-secret.ts`, fail-closed on an empty
secret). Long operations (compile, evaluation, autofill, export) return **202 + run id** and are
polled; the start call never waits on the work (Bursar section 18.6(a)).

### 5.2 Public surfaces (auditor room and trust page)

**Auditor room.** Hardened version of Bay's guest link (`apps/bay-api/src/routes/public-review.routes.ts:8-11`,
`apps/bay-api/src/services/review-link.service.ts:34`):

| Bay today | Bastion | Why |
| --- | --- | --- |
| token in URL path (`/bay/r/:token`) | token in URL **fragment** (`/bastion/room#<token>`), sent as header `X-Bastion-Room-Token` | fragments never reach nginx access logs or `Referer` headers |
| token stored in plaintext | `token_sha256` stored; shown once at creation | a DB read does not yield working links |
| optional expiry | **mandatory** expiry, default 30 days, ceiling `auditor_room_max_days` (max 180) | evidence disclosure must lapse |
| none | optional 6-digit passcode, argon2-hashed, shared out of band | second factor for the disclosure |
| 120 req/min per route | 120 req/min per IP, plus a Redis per-IP failed-token counter (10 misses per 10 min locks that IP out for 15 min) | token-guessing defense |
| 404 for missing or revoked | 404 for missing, revoked, or expired | existence is not confirmable |

Every room view writes `bastion_auditor_access_log`. Restricted manual evidence appears only if
the room was created with `include_restricted` (a separate confirm in the create dialog, listing
the restricted items by title). Files stream through bastion-api (no presigned URLs, so every
download is logged). The room creation dialog shows a preview of exactly what the auditor will
see. The room is read-only apart from the evidence request form (bounded, 20 per hour per room).

**Trust page.** Opt-in, admin-authored, frozen at publish. Content is a curated list of
categories and plain statements ("Code changes are reviewed before release"), each optionally
showing "checked nightly, last checked {date}". **No evidence, no counts of failures, no names.**
Publishing snapshots `draft_content` into `published_content` with a hash; the public route
serves only `published_content`. A statement whose linked control is currently `fail` or
`unprovable` cannot be published (the publish call returns 422 listing them), so the page never
claims something Bastion cannot prove. A fixed footer reads "Bastion is not an auditor. This page
is not a certification."

### 5.3 Realtime: none in v1, by decision

No `/bastion/ws`. Every long operation is a run row the SPA polls every 3 seconds with TanStack
Query `refetchInterval` while `status = 'running'`. Reasons: the nightly evaluator runs with nobody
watching; compile and autofill progress is coarse; and Bursar's experience shows polling ends up
being the authoritative path anyway. Its SPA opens `/bursar/ws`
(`apps/bursar/src/hooks/use-bursar-realtime.ts:26`), but bursar-api registers no WebSocket
handler, so it already runs on its polling fallback (recorded as pre-existing, section 15.10).
Omitting realtime also removes one nginx block and one failure mode from M0.

### 5.4 MCP tools

`apps/mcp-server/src/tools/bastion-tools.ts`, client shaped like `createBursarClient`
(`bursar-tools.ts:55-80`, forwarding the caller's bearer token), registered in
`apps/mcp-server/src/server.ts`, env `BASTION_API_URL` (ends in `/v1`) in
`apps/mcp-server/src/env.ts`.

| # | Tool | Backing endpoint | Notes |
| --- | --- | --- | --- |
| 1 | `bastion_list_frameworks` | rows 2, 4 | includes template catalog |
| 2 | `bastion_list_controls` | row 9 | filters: status, coverage kind, owner, framework |
| 3 | `bastion_control_status` | rows 10, 12 | plain explanation, assertions, latest outcome |
| 4 | `bastion_evidence_for` | row 21 | snapshot timeline for a control |
| 5 | `bastion_get_evidence` | row 22 | refs only if the asker may see detail |
| 6 | `bastion_verify_evidence` | row 23 | hash + ledger walk |
| 7 | `bastion_coverage_summary` | rows 39, 80 | the four honest numbers + graph |
| 8 | `bastion_coverage_gaps` | row 40 | ranked gaps, `quick_wins` option |
| 9 | `bastion_propose_fix` | row 41 | files an `agent_proposals` row |
| 10 | `bastion_compile_framework` | rows 7, 8 | proposals only |
| 11 | `bastion_propose_assertion` | rows 13, 16 | lands `proposed` |
| 12 | `bastion_run_evaluation` | row 18 | rate-limited |
| 13 | `bastion_list_evaluations` | rows 19, 20 | |
| 14 | `bastion_list_drift` | row 46 | |
| 15 | `bastion_list_probes` | row 17 | the closed menu an agent proposes from |
| 16 | `bastion_attestation_status` | row 51 | |
| 17 | `bastion_list_questionnaires` | row 55 | |
| 18 | `bastion_get_questionnaire` | rows 57, 60 | |
| 19 | `bastion_questionnaire_autofill` | row 59 | drafts only |
| 20 | `bastion_draft_answer` | row 64 | single question, cited, draft |
| 21 | `bastion_list_manual_evidence` | rows 26, 27 | restricted items need `read_restricted` on the asker |
| 22 | `bastion_search_answer_library` | row 65 | |

**22 tools.** Every tool that surfaces evidence detail, restricted evidence, or questionnaire
content takes `asker_user_id` and applies the intersection rule. None of the tools needs
`confirm_action`, because every destructive or disclosing action has no tool by design. The
module header carries the same "do not complete the surface" warning as `bursar-tools.ts:40-48`.

### 5.5 Permissions (the single source of truth)

`requires_superuser` is false for every row. "Floored" means owner and admin only.

| Action | is_read | floored | viewer | destructive | confirm |
| --- | --- | --- | --- | --- | --- |
| `bastion.framework.read` | yes | | yes | | |
| `bastion.framework.write` | | yes | | | |
| `bastion.framework.compile` | | yes | | | |
| `bastion.control.read` | yes | | yes | | |
| `bastion.control.write` | | yes | | | |
| `bastion.assertion.propose` | | | | | |
| `bastion.assertion.confirm` | | yes | | | |
| `bastion.evaluation.run` | | | | | |
| `bastion.evidence.read` | yes | | yes | | |
| `bastion.evidence.read_detail` | yes | yes | | | |
| `bastion.evidence.read_restricted` | yes | yes | | | |
| `bastion.evidence.upload` | | | | | |
| `bastion.evidence.link` | | | | | |
| `bastion.evidence.review` | | yes | | | |
| `bastion.evidence.withdraw` | | yes | | yes | yes |
| `bastion.feed.read` | yes | | | | |
| `bastion.feed.manage` | | yes | | | |
| `bastion.feed.write` | | yes | | | |
| `bastion.gap.read` | yes | | yes | | |
| `bastion.gap.dismiss` | | yes | | | |
| `bastion.fix.read` | yes | | | | |
| `bastion.fix.draft` | | | | | |
| `bastion.fix.mark_applied` | | | | | |
| `bastion.drift.read` | yes | | yes | | |
| `bastion.drift.acknowledge` | | | | | |
| `bastion.policy.read` | yes | | yes | | |
| `bastion.policy.write` | | yes | | | |
| `bastion.attestation.read` | yes | | yes | | |
| `bastion.attestation.sign` | | | yes | | |
| `bastion.attestation.request` | | yes | | | |
| `bastion.questionnaire.read` | yes | | | | |
| `bastion.questionnaire.write` | | | | | |
| `bastion.questionnaire.approve` | | yes | | | yes |
| `bastion.questionnaire.export` | yes | | | | |
| `bastion.answer_library.read` | yes | | | | |
| `bastion.answer_library.write` | | yes | | | |
| `bastion.auditor_room.read` | yes | yes | | | |
| `bastion.auditor_room.create` | | yes | | | yes |
| `bastion.auditor_room.revoke` | | yes | | yes | yes |
| `bastion.export.create` | | yes | | | |
| `bastion.export.read` | yes | yes | | | |
| `bastion.trust_page.read` | yes | | | | |
| `bastion.trust_page.write` | | yes | | | |
| `bastion.trust_page.publish` | | yes | | | yes |
| `bastion.settings.read` | yes | | yes | | |
| `bastion.settings.write` | | yes | | | |
| `bastion.audit.read` | yes | yes | | | |

**Group grants:** `owner` and `admin` get every row. `member` gets every row not floored.
`viewer` gets the rows marked `viewer` (eight reads plus `attestation.sign`, because everyone who
works at the firm must be able to attest to a policy). `guest` gets none. Questionnaire, fix,
feed, answer-library, and trust-page reads are deliberately not granted to `viewer` (customer and
draft content).

**Control owner exception (service rule, not a permission):** a member who owns a control may
read evidence detail for that control and review evidence linked to it, so the person asked for
an upload can see why.

**Enforcement posture:** bastion-api copies the hardcoded fail-closed boot invariant
(`apps/bursar-api/src/boot/assert-permissions-enforce.ts:34-47`, asserted at
`apps/bursar-api/src/server.ts:47-52` before anything binds a port): `BASTION_PERMISSIONS_MODE =
'on'`, `BASTION_PERMISSIONS_ON_UNKNOWN = 'deny'`, **not env-configurable** (burn issue #83: the
deploy env-hint map is flat and global). `BBB_PERMISSIONS_ENFORCE` appears in neither bastion-api's
env schema nor its catalog entry.

---

## 6. Frontend and help

`apps/bastion/`: React 19, TanStack Query v5, Zustand (auth store and UI preferences only), Tailwind
v4, Radix, Motion. Structure copied from `apps/bursar/src/` (`app.tsx` path router with
`BASE_PATH = '/bastion'`, `components/layout/bastion-layout.tsx` and `bastion-sidebar.tsx`,
`lib/api.ts`, `hooks/use-bastion.ts`, `stores/auth.store.ts`).

**`apps/bastion/vite.config.ts` sets `base: '/bastion/'`** and copies **every** `@bigbluebam/ui/*`
alias from `apps/bursar/vite.config.ts:18-43` (the unresolved-alias failure breaks the whole
frontend image because the Dockerfile chains builds with `&&`). Dev `server.port: 3024`, proxying
`/bastion/api` to `localhost:4024`.

### 6.1 Pages

| Route | Page | What it shows |
| --- | --- | --- |
| `/bastion/` | **Readiness** | Four separate numbers: "Proven by the suite", "Proven by evidence you provided" (with "N expire in the next 30 days"), "Not met", "Can't prove yet". Days to audit. Top five gaps with **Draft the fix**. Last night's check time. |
| `/bastion/setup` | **Setup wizard** | Pick a framework (plain descriptions, not codes), the ten-question company profile, Compile, then **Review proposed checks** grouped by plain category with bulk confirm per control. |
| `/bastion/controls` | **Controls** | Grouped by plain category ("People and access", "Code changes", "Backups and recovery", "Policies and training", "Vendors", "Monitoring"). Status chips use words, not colors alone. The framework code (CC6.2, A.5.18) is a small secondary chip. |
| `/bastion/controls/:id` | **Control detail** | Plain explanation; "How we check this" (each assertion's plain statement); evidence timeline; "What would fix this"; linked manual evidence with expiry; the Bam task; **Check now**. |
| `/bastion/coverage` | **Evidence map** | The coverage graph: controls as rows, sources as columns (Suite, Feeds, Uploads, Self-attested, Nothing). A legend states plainly that uploads and self-attested evidence are not automatic. |
| `/bastion/gaps` | **What to fix first** | The ranked list with risk and effort in words ("High risk, about an hour"), "Quick wins" toggle, proposal status. |
| `/bastion/evidence` | **Evidence locker** | Uploads and feeds, owners, coverage periods, expiry, review state; **Add evidence** (Bin upload) and **Write a statement**. |
| `/bastion/policies` | **Policies** | Linked Beacon articles, who has and hasn't read the current version. |
| `/bastion/attest` | **Policies to read** | Every member's personal list; reads the article in place; **I have read and understood this**. |
| `/bastion/questionnaires` and `/:id` | **Questionnaires** | Upload, column mapping, progress, the answer grid with confidence words ("Sure", "Check this", "Needs an expert"), citations as named chips, **Approve** and **Download answers**. |
| `/bastion/review` | **Review queue** | Proposed checks, evidence waiting for review, fix proposals, low-confidence answers, auditor requests. |
| `/bastion/sharing` | **Sharing** | Auditor rooms (create, preview, revoke, access log), audit packets, trust page editor. |
| `/bastion/settings` | **Settings** | Compliance project, remediation mode, check time and timezone, AI provider, expiry warnings, limits. |
| `/bastion/room` | **Auditor room** (public) | Rendered before the auth gate, like `apps/bay/src/app.tsx:31,98`. |
| `/bastion/trust/:slug` | **Trust page** (public) | Same early render. |

### 6.2 Plain-language rules (non-technical operators)

- No raw UUIDs, hashes, probe keys, or SQL on any default view. Evidence detail shows a
  **"Technical details"** disclosure containing the probe name, query fingerprint, and hash for
  those who want them (auditors usually do).
- Every status has a one-sentence reason from the section 3.2 table.
- Every probe has an `explain()` sentence: "3 API keys are older than 90 days: 'Coconut Radio
  Bridge' (210 days), ...".
- Dates render in the viewer's timezone with relative text ("expires in 12 days").
- Empty states teach: "Nothing can prove this yet. You can upload a report from the system that
  knows, or write a statement."

### 6.3 State and shared components

- TanStack Query keys per resource (`['bastion','controls',filters]`), optimistic updates for
  review actions with rollback, `refetchInterval` polling on run rows only while running.
- Zustand: `auth.store.ts` (copied) and a small `ui.store.ts` (gap sort mode, collapsed groups).
- `@bigbluebam/ui`: `launchpad`, `org-switcher`, `notifications-bell`, `help-center`
  (`<HelpTrigger app="bastion" />` as `apps/bursar/src/components/layout/bursar-layout.tsx:126`),
  `user-menu`, `sidebar-footer`, `impersonation-banner`, `permissions-context` and `use-can`
  (hide floored actions instead of showing a disabled button with no explanation).
- Launchpad icon: add `castle` (lucide `Castle`) to `packages/ui/launchpad.tsx` `ICONS` (beside
  `'shield-check'` at line 90); `site/src/pages/docs.tsx` `APP_ICON`/`APP_COLOR` get an entry.

### 6.4 Help

`docs/apps/bastion/help.md`, `guide.md`, generated `help-index.json` (checked with
`node scripts/help/build-help-index.mjs --check`), `meta.json` and
`docs/apps/bastion/screenshots/` from the docs-capture recipe
`packages/docs-capture/recipes/bastion/bastion.yaml` (GILLIGAN workspace only). The guide explains,
in plain language: what each status means; why uploads are not automatic; how to answer a
questionnaire; what an auditor sees; that Bastion is not an auditor.

---

## 7. Background work

Locks and engine logic live inside bastion-api. Worker jobs are thin HTTP callers into
`/v1/internal/engines/:name`, registered in `apps/worker/src/worker.ts` with a
`registerBastionSweep` helper copied from `registerBursarSweep` (`worker.ts:2605-2625`) and a
`bastion-shared.ts` (`postBastion`) copied from `apps/worker/src/jobs/bursar-shared.ts`. Queue
names and job data types live in `packages/shared/src/queues.ts`. Every queue sets
`removeOnComplete: 100`, `removeOnFail: 500` (Redis runs `noeviction`).

| Job | Schedule | Does |
| --- | --- | --- |
| `bastion-evaluate-tick` | `*/15 * * * *` | finds orgs whose local `evaluation_hour_local` has passed with no nightly run today; claims a run row; evaluates in bounded slices (25 assertions per slice) with claim fencing, re-enqueueing until done |
| `bastion-compile` | event (from `POST /frameworks/:id/compile`) | 10 controls per slice; deterministic fallback when the LLM is unavailable |
| `bastion-questionnaire-autofill` | event | 20 rows per slice; LLM throttling (429) defers the slice without failing rows |
| `bastion-evidence-ingest` | event + `*/10 * * * *` retry | waits for Bin scan, re-asserts access, copies bytes, hashes, ledgers |
| `bastion-export-packet` | event | builds the audit packet (section 7.2) |
| `bastion-gap-rank` | after each evaluation + `30 6 * * *` | recomputes `bastion_gaps` |
| `bastion-evidence-expiry` | `10 6 * * *` | `evidence.expiring` / `evidence.expired`; re-evaluates affected manual assertions |
| `bastion-attestation-nudge` | `0 14 * * *` | due attestations -> platform notifications + `attestation.overdue` |
| `bastion-proposal-reconcile` | `*/15 * * * *` | reflects `agent_proposals` decisions onto fix drafts and drift tasks (backstop for the `proposal.decided` event) |
| `bastion-ledger-seal` | `55 23 * * *` UTC | publishes `ledger.sealed` with each org's head hash |
| `bastion-ledger-verify` | `40 4 * * 0` | re-hashes a bounded sample plus everything open rooms reference |
| `bastion-run-reaper` | `*/5 * * * *` | reverts runs whose heartbeat exceeded the 5-minute lease to `partial`, and transactionally unwedges the owning framework (`compiling -> draft`) or questionnaire (`answering -> mapping`) |
| `bastion-weekly-readiness` | `0 13 * * 1` | publishes `readiness.weekly` with the four numbers per org |
| `bastion-retention` | `20 5 * * *` | prunes processed ingest events older than 30 days and auditor access logs older than `max(2 years, latest room expiry)`; **never** touches evidence tables (they reject DELETE) |

### 7.1 Progress logging (required)

Every long job logs a start line **before** its first slow step and progress at each slice, with
elapsed time, in the structured pino logger (`@bigbluebam/logging`):

- evaluator: `bastion-evaluate: org 3/41 'Gilligan Travel Ltd' assertions 75/150 (pass 61, fail 6,
  unprovable 8) elapsed_ms=8420`;
- compile: `bastion-compile: framework 'SOC 2' controls 30/64 proposed 51 dropped 2 llm_calls 30
  fallback=false elapsed_ms=...`;
- autofill: `bastion-autofill: questionnaire 'Howell Industries Vendor Security Review' rows 40/96
  (high 22, medium 11, low 7) elapsed_ms=...`, with an explicit line when it defers on LLM
  throttling ("throttled by the AI provider, resuming in 30 s");
- export: one line per packet stage (`collecting controls`, `writing evidence 120/412`,
  `rendering summary PDF`, `zipping`).

The same counters are written to the run row so the SPA's progress bar and the logs agree.

### 7.2 The audit packet

A zip containing: `manifest.json` (every file with its SHA-256, the ledger head at export time,
the framework, the period), `controls.csv` and `controls.jsonl`, `evidence/<snapshot>.json`, the
manual evidence files selected (restricted only if chosen), `attestations.csv`, `drift.csv`, and
`summary.pdf` (one page per control with plain explanation, status history, and citations). Built
with `pdf-lib` and `jszip`, the same libraries `apps/worker/src/jobs/bill-pdf-generate.job.ts:27`
and the worker already depend on. The packet itself is hashed and stored under
`<org>/bastion/exports/<id>.zip`.

---

## 8. Events and integration

### 8.1 Published (source `bastion`)

All via `publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)` from
`@bigbluebam/shared` (positional; `packages/shared/src/bolt-events.ts`), bare event names, source
`'bastion'`, every pair registered as a `bastionEvents` array in
`apps/bolt-api/src/services/event-catalog.ts` (shape at lines 23-28), and checked by
`scripts/check-bolt-catalog.mjs`. Payloads carry **refs and scalars only**, never evidence content
or questionnaire text.

| Event | Fired when | Key payload fields |
| --- | --- | --- |
| `framework.adopted` | a framework is adopted or created | `framework.id`, `framework.name`, `controls.count` |
| `assertions.compiled` | a compile run finishes | `framework.id`, `proposed.count`, `dropped.count`, `used_fallback` |
| `evaluation.completed` | an evaluation run finishes | `run.id`, `pass.count`, `fail.count`, `unprovable.count` |
| `control.drifted` | a control worsens | `control.id`, `control.title`, `from_status`, `to_status`, `reason`, `owner.id` |
| `control.recovered` | a control returns to pass | `control.id`, `from_status` |
| `evidence.uploaded` | manual evidence becomes active | `evidence.id`, `control.ids`, `valid_until`, `owner.id` |
| `evidence.expiring` | within the warning window | `evidence.id`, `days_left`, `owner.id` |
| `evidence.expired` | at expiry | `evidence.id`, `control.ids` |
| `evidence.integrity_failed` | a re-hash mismatches | `entry.seq`, `entry.kind` |
| `ledger.sealed` | daily | `head.seq`, `head.hash` |
| `gap.fix_proposed` | a fix proposal is filed | `gap.id`, `template`, `proposal.id` |
| `attestation.overdue` | someone has not attested within cadence | `policy.id`, `user.id` |
| `questionnaire.drafted` | autofill finishes | `questionnaire.id`, `high.count`, `medium.count`, `low.count`, `deal.id` |
| `questionnaire.approved` | approved for export | `questionnaire.id`, `deal.id` |
| `auditor_room.created` | a room is created | `room.id`, `label`, `expires_at` |
| `auditor_room.revoked` | a room is revoked | `room.id` |
| `trust_page.published` | trust page published | `slug` |
| `readiness.weekly` | Monday digest | `proven_native`, `proven_provided`, `not_met`, `cannot_prove`, `expiring_soon` |

### 8.2 Consumed

`proposal.decided` (source `platform`) through the bolt-api dispatch hook into
`/v1/internal/events`, mapping decisions onto `bastion_fix_drafts` and drift proposals. Machine
feeds are the other inbound path (section 3.5). Bastion does not consume Bin events (bin-api emits
none).

### 8.3 entity_links

Written in the same org-scoped transaction as the row they describe, `ON CONFLICT DO NOTHING`, via
an `entity-links.ts` copied from `apps/bursar-api/src/lib/entity-links.ts`:

- `bastion.control` -> `bam.task` (`related_to`) when a remediation task is created;
- `bastion.manual_evidence` -> `bin.asset` (`derived_from`);
- `bastion.policy` -> `beacon.entry` (`references`);
- `bastion.questionnaire` -> `bond.deal` (`related_to`) when linked;
- `bastion.fix_draft` -> the applied `beacon.entry` or Bolt automation (`derived_from`) on
  `mark-applied`.

### 8.4 Required additive changes outside apps/bastion*

| File | Change |
| --- | --- |
| `apps/api/src/routes/github-webhook.routes.ts` | Today only `push` and `pull_request` are handled (line 88) and a PR is stored **only when it references a task** (lines 192-230); no review data exists anywhere. Add: handle `pull_request_review`, and append every `pull_request` closed/merged and `pull_request_review` submitted event to `github_pr_events` regardless of task references. Existing task-linking behavior is unchanged. |
| `apps/api/src/db/schema/github-pr-events.ts` + `0265_github_pr_events.sql` | `id`, `integration_id`, `project_id`, `org_id`, `repo_owner`, `repo_name`, `pr_number`, `event_kind` CHECK (`merged`,`closed`,`review`), `base_ref`, `is_default_branch`, `head_sha`, `author_login`, `merged_by_login`, `reviewer_login`, `review_state`, `review_commit_sha`, `task_refs text[]`, `occurred_at`, `delivery_id` (unique, GitHub `X-GitHub-Delivery` for dedup), `received_at`. Append-only. |
| `apps/api/src/routes/internal-bastion.routes.ts` (new) | `POST /internal/bastion/tasks/upsert` and `POST /internal/bastion/tasks/:id/comment`, `requireServiceAuth`, attributed to `BASTION_SYSTEM_USER_ID` in `activity_log`, modeled on `apps/api/src/routes/internal-helpdesk.routes.ts:51+`, keyed on the `(project_id, external_id)` partial unique index from migration 0130. Because Bam's `logActivity` runs, remediation tasks appear in `v_activity_unified`. |
| `apps/api/src/lib/constants.ts` | `BASTION_SYSTEM_USER_ID` |
| `apps/api/src/services/visibility.service.ts` | add `bastion.control`, `bastion.evidence_snapshot`, `bastion.manual_evidence`, `bastion.policy`, `bastion.questionnaire`, `bastion.fix_draft` to `VisibilityEntityType` (lines 79-126) and `SUPPORTED_ENTITY_TYPES` (lines 128-175) with resolvers: same org plus the matching read permission; `bastion.manual_evidence` with `sensitivity = 'restricted'` additionally requires `read_restricted` or ownership |
| `apps/mcp-server/src/tools/search-tools.ts` | add a Bastion fetcher (controls and policies via row 81) with entity type mapped to `bastion.control` for `can_access` filtering |
| `apps/bolt-api/src/services/` | `bastion-subscriptions.ts`, `bastion-dispatch-hook.ts`; `BASTION_API_INTERNAL_URL` in `apps/bolt-api/src/env.ts` |
| `packages/structured-data/src/codecs/xlsx.ts` | new read/write xlsx codec (section 15.4) |
| `packages/shared/src/schemas/bastion*.ts`, `queues.ts` | Zod schemas, feed contract, queue contracts |

### 8.5 Unified activity and search

- **Search:** `search_everything` includes Bastion controls and policies (section 8.4), filtered by
  `can_access` in asker mode.
- **Activity:** remediation tasks and their comments land in Bam's `activity_log`, which
  `v_activity_unified` already unions. Bastion's own administrative actions go to
  `bastion_audit_log` (row 84). Extending `v_activity_unified` with a Bastion branch is **not** done
  in v1: no satellite has extended the view since `0129_activity_unified_view.sql`, and doing so
  means restating the whole view body in a new migration (section 15.8).

---

## 9. Infrastructure

### 9.1 Compose service (`docker-compose.yml`)

Modeled on the `bursar-api` block (lines 1041-1093): `<<: *common`, build
`apps/bastion-api/Dockerfile`, env `DATABASE_URL`, `DATABASE_READ_URL`, `REDIS_URL`,
`SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL=http://api:4000`,
`BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_BUCKET`, `S3_REGION` (as bin-api), `PORT=4024`, `HOST=0.0.0.0`, `LOG_LEVEL`, `CORS_ORIGIN`,
`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `BASTION_LLM_TIMEOUT_MS=60000` (matches the proxy's 60 s
upstream deadline), `BASTION_ENGINE_TIMEOUT_MS=30000`, `BASTION_PROBE_TIMEOUT_MS=15000`,
`BASTION_ROOM_IP_SALT` (defaults to a derivation of `SESSION_SECRET`). `depends_on`: migrate
(`service_completed_successfully`), postgres and redis (`service_healthy`), minio
(`service_started`). Bolt-api and api are request-time dependencies only, kept out of
`depends_on` so the boot graph stays acyclic. Healthcheck
`curl -sf http://localhost:4024/health`. Networks `backend` and `frontend`.

Also: `BASTION_API_URL=http://bastion-api:4024/v1` on mcp-server (beside line 200);
`BASTION_API_INTERNAL_URL=http://bastion-api:4024` on worker and bolt-api. Postgres already runs
`max_connections=200` (lines 11-24); bastion-api's pool is capped at `max: 10`. **Redis is
verify-only** (512mb, `noeviction`); do not edit its block.

### 9.2 nginx (three files, two locations each, strict ordering)

`infra/nginx/nginx-with-site.conf` (what compose mounts), `infra/nginx/nginx.conf`,
`infra/nginx/nginx.railway.conf` each get `location /bastion/` (alias + `try_files ...
/bastion/index.html`, which also serves `/bastion/room` and `/bastion/trust/:slug`) and
`location /bastion/api/` (`proxy_pass http://bastion-api:4024/;`, Railway via `set
$rw_upstream_N "bastion-api.railway.internal"` + rewrite), **and `bastion` added to the shared
static-asset regex** (`nginx-with-site.conf:907`). No `/bastion/ws`.

> **Ordering is mandatory.** The compose-mounted conf has no `resolver` directive, so nginx
> resolves upstreams at load and exits on an unknown host, taking every app down. Build and start
> `bastion-api`, confirm it is running, **then** add the nginx blocks and
> `docker compose up -d --force-recreate frontend`. Gate: `docker compose exec frontend nginx -t`.
> Rollback if the frontend goes down: `git checkout infra/nginx/` and recreate frontend first.

`client_max_body_size` is unchanged; questionnaires and evidence files come through Bin's existing
upload route, and bastion-api's JSON bodies are small.

### 9.3 Frontend image

`apps/frontend/Dockerfile`: `COPY apps/bastion/package.json ./apps/bastion/` (beside line 26),
`COPY apps/bastion/ ./apps/bastion/` (beside line 74), `&& pnpm --filter @bigbluebam/bastion build \`
(beside line 101), `COPY --from=build /app/apps/bastion/dist /usr/share/nginx/html/bastion`
(beside line 129). The SPA dist is not bind-mounted, so serving `/bastion/` needs `docker compose
build frontend`, which rebuilds every SPA (the slow step of M0).

### 9.4 Deploy catalog and env hints

`scripts/deploy/shared/services.mjs`, modeled on the bursar entry (lines 355-385), **with the env
block** (a missing one resolves to empty arrays and deploys with no `DATABASE_URL`):

```js
{
  name: 'bastion-api',
  description: 'Bastion API - continuous compliance controls, evidence, questionnaires',
  dockerfile: 'apps/bastion-api/Dockerfile',
  port: 4024,
  healthcheck: '/health',
  start_command: 'node dist/server.js',
  required: true,
  // BBB_PERMISSIONS_ENFORCE deliberately ABSENT: hardcoded boot invariant (burn issue #83).
  needs: ['postgres', 'redis', 'minio', 'api', 'bolt-api'],
  public_paths: ['/bastion/api/'],
  env: {
    required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_SERVICE_SECRET',
               'BBB_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL',
               'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'],
    optional: ['DATABASE_READ_URL', 'S3_REGION', 'CORS_ORIGIN', 'LOG_LEVEL',
               'BASTION_LLM_TIMEOUT_MS', 'BASTION_ENGINE_TIMEOUT_MS',
               'BASTION_PROBE_TIMEOUT_MS', 'BASTION_ROOM_IP_SALT'],
  },
}
```

Also: `bastion-api` in the frontend entry's `needs` and `/bastion/` in its `public_paths`
(line 717-720); `BASTION_API_INTERNAL_URL` on bolt-api and worker entries; `BASTION_API_URL` on
mcp-server's `env.optional`. `scripts/deploy/shared/env-hints.mjs` (beside lines 296-303):

```js
BASTION_API_INTERNAL_URL: { kind: 'computed', value: internal('bastion-api') },        // bare origin
BASTION_API_URL:          { kind: 'computed', value: `${internal('bastion-api')}/v1` }, // mcp client
```

The `/v1` asymmetry is load-bearing. On Railway, internal URLs use port 8080, not 4024.

### 9.5 Health and scaling

`@bigbluebam/service-health` registers exactly `/health`, `/health/ready`, `/metrics`. Readiness
checks Postgres and Redis only: not MinIO, not the LLM proxy, not bolt-api, so an upstream outage
never takes Bastion out of rotation (`apps/bursar-api/src/server.ts:126-140`). bastion-api is
stateless and scales horizontally: run claims (`claimed_by`, `heartbeat_at`, conditional writes
`WHERE id = $run AND claimed_by = $me AND status = 'running'`, a zero-row update aborts the
slice) make concurrent instances and BullMQ retries safe; the ledger append lock is a per-org
advisory transaction lock; the auditor-room failed-token counter is in Redis.

### 9.6 Registration checklist

| File | Change |
| --- | --- |
| `apps/api/src/routes/system-settings.routes.ts` | `LAUNCHPAD_APP_IDS` += `'bastion'` (line 65 area); `LAUNCHPAD_CATALOG` += `{ id: 'bastion', name: 'Bastion', description: 'Compliance & Controls', icon_name: 'castle', color: '#7c2d12', path: '/bastion/' }`; `ROOT_REDIRECT_VALUES` += `'bastion'` **and** `REDIRECT_MAP` += `bastion: '/bastion/'` (both halves, lines 108-139) |
| `scripts/docs/lib/tool-source.mjs` | `APP_TOOL_MODULES` += `bastion: ['bastion-tools']`; run `pnpm docs:catalog` and commit the regenerated JSON |
| `docs/reference/mcp-endpoint-mapping.md` | a Bastion section mirroring section 5.1, every skip row in the doc's skip-marker form, the `## Surface summary` row updated; the CLAUDE.md self-check grep prints `0` |
| `apps/bolt-api/src/services/event-catalog.ts` | `bastionEvents` per section 8.1 |
| `.env.example` | the `BASTION_*` vars with comments |
| `CLAUDE.md` | app table rows for `bastion-api` and `bastion`, the route list (`/bastion/`, `/bastion/api/`), the migrate dependents list |
| `scripts/seed-gilligan/run-all.mjs` | new final phase (section 10) |

---

## 10. Seed data (GILLIGAN)

`scripts/seed-gilligan/bastion.mjs` plus `bastion.expectations.mjs`, registered in
`scripts/seed-gilligan/run-all.mjs` as a new last phase `{ name: 'Compliance', files:
['bastion.mjs'] }` after "Support & email" (it needs Bam, Bond, Beacon, Bin, Blip, Bolt, and
Bursar data from earlier phases). Plus the docs-capture recipe. Never seeded:
`e2e-admin@bigbluebam.test`, "E2E Test Organization", "screenshots-demo".

### 10.1 The story

Gilligan Travel Ltd is preparing for its first SOC 2 review because Thurston Howell III's holding
company will only book the charter fleet through a vendor that passes its security review.
Skipper owns the program; the Professor owns technical controls; Mary Ann owns people controls.
The auditor is "Lagoon & Reef CPAs".

### 10.2 What the seed creates (all real rows, evaluated by a real run)

- **Framework:** SOC 2 (Security) adopted, audit target date 75 days out, company profile
  answered ("we write software: yes", "company laptops: yes", "own cloud account: yes").
- **Confirmed assertions** for the seeded controls (the seeder confirms them as Skipper, so the
  audit log shows a human confirmation).
- **Source data the probes will find:**
  - API key "Coconut Radio Bridge" owned by the Professor, 210 days since rotation -> `keys.max_age`
    **Not met**.
  - A departed guest account, **Wrongway Feldman**, disabled but still holding an API key ->
    `access.departed_still_holding` **Not met**.
  - GitHub integration on the "Rescue Radio Firmware" repo with `github_pr_events`: 11 merges,
    10 approved by someone else, PR #42 "Boost antenna gain" merged by Gilligan with no review ->
    `change.merge_reviewed` **Not met**, citing PR #42.
  - Blip tracked app "Daily Coconut Count" with 30-day retention -> `logging.retention_floor`
    **Not met**, with a `config_change` fix drafted ("raise to 90 days").
  - Platform backups completed last night -> `ops.backup_fresh` **Proven** ("Provided by your
    hosting platform").
  - Beacon article "Island Information Security Policy", linked as a policy; 5 of 7 castaways
    attested to the current version; Gilligan and Lovey have not -> `policy.attested` **Not met**,
    with an `attestation.overdue` nudge.
  - Bursar vendor "Island Weather Feed" marked critical with an award on file ->
    `vendors.critical_have_award` **Proven**.
- **Manual evidence:**
  - "Google Workspace 2-Step Verification report" uploaded by the Professor (CSV in Bin), accepted
    by Skipper, valid until 12 days from now -> MFA control **Proven by evidence you provided**,
    with an "expires in 12 days" warning and an `evidence.expiring` event.
  - Laptop disk encryption: **nothing** -> **Can't prove yet**, ranked first among gaps, with an
    `evidence_request` fix proposal to the Professor ("Export the FileVault status report from
    your device manager, or write a statement after checking each laptop").
  - "Background checks for new crew" self-attested by Mary Ann -> shown as **Self-attested**.
- **Questionnaire:** "Howell Industries Vendor Security Review" (xlsx, 24 rows) linked to the Bond
  deal "Howell Holdings Charter Fleet", autofilled: high, medium, and low counts per the
  expectations constant; the disk-encryption row is low with the plain "we cannot currently prove
  this" note.
- **Auditor room** "Lagoon & Reef CPAs, Type I readiness", expiring in 30 days, two access-log
  rows.
- **Trust page** draft (unpublished) with three statements, one blocked from publishing because it
  links the failing code-review control.

### 10.3 One source for the numbers

`scripts/seed-gilligan/bastion.expectations.mjs` exports `BASTION_SEED_EXPECTATIONS` (control
counts per status, coverage-kind counts, the top-ranked gap title, the questionnaire band counts,
the attestation ratio, the ledger length after the seeded run). The Playwright suite imports it
rather than restating literals, as `apps/e2e/src/apps/bursar/bursar-expectations.d.ts` does for
Bursar.

---

## 11. Test plan

### 11.1 Unit (Vitest, `@bigbluebam/db-stubs` where no SQL is needed)

`permissions-enforce` (boot invariant refuses any mode other than `on`/`deny`); every probe's
`paramsSchema` bounds and `explain()` text; compiler output validation (unknown probe key dropped,
out-of-range threshold dropped, invalid cited span dropped, fallback path proposes template
assertions); status aggregation (worst-of); manual assertion evaluation decision table (no
evidence, expired, pending review, accepted, shows_exception, period not covered); gap risk
formula and cost tiebreak; canonical JSON serialization stability (key order, number formatting);
ledger hash chaining and verification (tampered middle entry detected); snapshot dedup reuses the
object but writes a new row; auditor token hashing, fragment parsing, passcode verify, lockout
counter; trust-page publish refuses failing or unprovable statements; questionnaire confidence
banding (any cited non-pass control forces `low`); citation verification (ids outside the retrieved
set rejected); injection pre-scan; csv neutralization on export; `bin-asset-access` five refusal
cases (cross-org, private, unscanned, flipped after attach, version advanced); claim fencing
(zero-row conditional update aborts the slice); reaper unwedges frameworks and questionnaires;
attestation rejects `users.kind <> 'human'`; `rls-coverage` (every `bastion_%` table has a policy).

### 11.2 Integration (real Postgres, CI service container)

- **Probe goldens:** each probe runs against a fixture schema seeded with known rows and must
  return the exact expected outcome and cited refs, including the precondition-unmet path.
- **Immutability:** UPDATE of a content column, DELETE, cascade attempt, and TRUNCATE on each
  immutable table all raise.
- **Cross-app flows** in `apps/integration-tests`: GitHub `pull_request_review` webhook ->
  `github_pr_events` -> evaluation -> `control.drifted` -> internal task upsert -> Bam task exists
  with `external_id = 'bastion:control:<id>'`; a second drift updates the same task. Proposal
  decided -> `proposal.decided` -> fix draft `approved` -> evidence request task. Feed push with a
  repeated idempotency key is a no-op.

### 11.3 LLM corpus gates (deterministic via recorded responses)

| Gate | Threshold |
| --- | --- |
| Compiler validity | 0 invalid probe keys or params reach `proposed` |
| Compiler coverage on SOC 2 template | every template control receives at least one proposed assertion or a manual spec |
| Custom framework extraction | 0 controls without a verifying cited span |
| Questionnaire false confidence | 0 `high` answers that cite a `fail` or `unprovable` control |
| Questionnaire injection | 0 `high` answers on the injection fixture rows |
| Citation integrity | 0 persisted citations outside the retrieved set or failing `can_access` |

Fixtures: a 40-question synthetic questionnaire with labelled answerable and unanswerable rows,
8 injection-shaped rows, a custom framework document of 12 controls. Recorded caveat: stubs never
exercise the real proxy timeout or concurrency behavior.

### 11.4 Playwright user stories (GILLIGAN only, assertions import `BASTION_SEED_EXPECTATIONS`)

As **Skipper** (owner):

1. Open `/bastion/`; the four numbers match the expectations constant; the text "Proven by
   evidence you provided" is present and separate from "Proven by the suite".
2. The top gap is laptop disk encryption; click **Draft the fix**; a proposal appears in the
   review queue addressed to the Professor.
3. Open the "Code changes are reviewed" control; the evidence timeline cites "PR #42 Boost antenna
   gain"; **Technical details** reveals a query fingerprint; **Verify** shows "This evidence is
   intact".
4. Open the evidence locker; the 2-Step Verification report shows "expires in 12 days".
5. Open the Howell questionnaire; the low-confidence disk-encryption row reads "We cannot
   currently prove this"; **Approve** is disabled until every low row is reviewed.
6. Create an auditor room; the token is shown once; the preview lists exactly the selected
   controls.
7. Try to publish the trust page; the failing statement blocks publishing with its plain reason.
8. **Negative:** no element on the home page, controls list, or control detail renders a raw UUID
   (regex check on visible text).

As **Gilligan** (member):

9. `/bastion/attest` lists "Island Information Security Policy"; attest; the policy's coverage
   rises by one for Skipper on reload.
10. **Negative:** `/bastion/sharing` actions are absent (floored), and a direct call to `POST
    /auditor-rooms` returns 403.

As an **anonymous auditor**:

11. Open the room link in a fresh context; the overview loads without login; open a control and
    an evidence item; the access log for that room gains entries (checked back as Skipper).
12. **Negative:** after Skipper revokes the room, the same link shows "This link is no longer
    available" and the API returns 404.
13. **Help:** the HelpTrigger opens and the Bastion guide loads.

### 11.5 Convention gates

`pnpm db:check` (0 drift), `pnpm lint:migrations`, `pnpm check:bolt-catalog`,
`node scripts/check-permission-catalog.mjs`, the section 4.6 probe-vs-table assertion, the
surface-map self-check grep printing `0` plus an updated `## Surface summary`,
`pnpm docs:catalog:check`, `node scripts/help/build-help-index.mjs --check`,
`grep -c bastion infra/nginx/*.conf` non-zero in all three files,
`docker compose exec frontend nginx -t`, `tsc --noEmit`, Biome.

---

## 12. Milestones

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | Scaffold `apps/bastion-api` (copy of bursar-api skeleton: env, boot invariants, auth, rls, permissions, redis plugins, service-health) and `apps/bastion` (layout, router, vite base, every alias, port 3024); Dockerfile; compose service; **nginx in the section 9.2 order**; frontend Dockerfile four edits; `services.mjs` with the env block; env hints with the `/v1` asymmetry; launchpad + `REDIRECT_MAP` + icon | `/bastion/` serves; `/bastion/api/health` 200; `nginx -t` passes; `grep -c bastion infra/nginx/*.conf` x3; Redis `config get` unchanged |
| **M1** | Migrations 0260-0266 + Drizzle + the generated RLS loop; no permission chain | `db:check` 0 drift; `rls-coverage` and immutability integration tests green |
| **M2** | Template library (SOC 2, ISO 27001, starter) in code with plain summaries; frameworks, controls, assertions CRUD; setup wizard; deterministic compile fallback | adopting SOC 2 proposes assertions with no LLM configured |
| **M3** | Probe catalog (all section 3.1 probes) + the Bam GitHub ledger change (0265, webhook) + evaluator with slices, claims, ledger, objects, snapshots, verify | probe goldens pass; a full run on the seeded org completes with progress logs; tampering is detected |
| **M4** | Manual evidence (Bin attach, scan wait, copy, hash, review, expiry, withdraw), feeds (API push), coverage graph, the four-number home | Playwright 1, 4 |
| **M5** | Gaps, risk ranking, fix drafting into `agent_proposals`, drift events, internal Bam task route, proposal reconcile, `proposal.decided` dispatch | Playwright 2, 3; cross-app integration flows green |
| **M6** | LLM compiler tailoring and custom-framework extraction; policies and attestation | compiler corpus gates; Playwright 9 |
| **M7** | Questionnaires: xlsx codec, mapping, autofill slices, banding, review, approval, export, answer library | questionnaire corpus gates; Playwright 5 |
| **M8** | Auditor room, access log, requests, export packet, trust page; help.md/guide.md | Playwright 6, 7, 11, 12 |
| **M9** | Full permission chain (section 4.5) + group defaults; MCP tools + mcp-server env; Bolt catalog; visibility types; `search_everything` fetcher; surface map + summary; docs catalog; help gate against a rebuilt image; GILLIGAN seeder + expectations; e2e; CLAUDE.md | all section 11.5 gates green; section 4.6 probe matches section 5.5 |

---

## 13. Reuse ledger

| Capability | Reused from | Genuinely new |
| --- | --- | --- |
| Fastify skeleton, error handler, 404 envelope, shutdown | `apps/bursar-api/src/server.ts:54-196` | nothing |
| Permission enforcement invariant | `apps/bursar-api/src/boot/assert-permissions-enforce.ts` | the section 5.5 table |
| RLS binding and posture report | `apps/bursar-api/src/plugins/rls.ts:58-68`, `boot/assert-rls-bound.ts` | generated loop for `bastion_` |
| Auth (session, API key, impersonation) | `apps/bursar-api/src/plugins/auth.ts` (itself a verbatim burn port) | nothing |
| Health, readiness, metrics | `@bigbluebam/service-health` | nothing |
| Logging and system-error recording | `@bigbluebam/logging` (`createErrorHandler`, `httpSystemErrorRecorder`) | progress lines |
| Object storage | `@bigbluebam/storage` `createBootstrapDriver`, `put`, `getStream`, `stat`, `copyTo` (`packages/storage/src/driver.ts:32-60`) | content-addressed key layout |
| File upload and AV scan | Bin upload route + `bin-av-scan` | none; Bastion attaches |
| Bin access checks at attach and read | `apps/bursar-api/src/lib/bin-asset-access.ts` + `.db.ts` | nothing |
| LLM access | `apps/bursar-api/src/lib/llm-client.ts` -> `POST /internal/llm/chat` with `X-Internal-Service: bastion` | prompts |
| Citation verification | `verifyCite` (`apps/burn-api/src/services/engines/extraction-logic.ts:39`) | nothing |
| Injection pre-scan | `apps/bursar-api/src/lib/injection-prescan.ts` | questionnaire row signals |
| Advisory locks, no HTTP inside | `apps/burn-api/src/lib/advisory-lock.ts` | ledger append lock |
| Run claims, heartbeats, reaper, fencing | Bursar reaper engine (`apps/bursar-api/src/services/engines/reaper.engine.ts`) | unwedge rules for frameworks and questionnaires |
| Immutability triggers | `bursar_baseline_items` four-path pattern (`0249_bursar_awards_baseline.sql`) | the hash-chained ledger |
| HITL queue | `agent_proposals` + `proposal_*` MCP tools | `bastion_fix_drafts` |
| Visibility preflight | `packages/shared/src/visibility-client.ts`, `visibility.service.ts` | six entity types |
| Cross-app links | `apps/bursar-api/src/lib/entity-links.ts` | five link specs |
| Bolt publish and catalog | `publishBoltEvent` (`packages/shared/src/bolt-events.ts`), `event-catalog.ts`, `check-bolt-catalog.mjs` | `bastionEvents` |
| Event intake | `apps/bolt-api/src/services/bursar-dispatch-hook.ts` + durable inbox | feed registry |
| Bam task creation from a satellite | `apps/api/src/routes/internal-helpdesk.routes.ts`, upsert index from migration 0130 | `internal-bastion.routes.ts` |
| Guest links | Bay public review (`apps/bay-api/src/routes/public-review.routes.ts`) | hashed tokens, fragment transport, passcode, lockout |
| Structured file parsing | `@bigbluebam/structured-data` codecs | **xlsx codec** |
| CSV export safety | `packages/shared/src/csv-safe.ts` | nothing |
| PDF and zip | `pdf-lib`, `jszip` (worker deps) | packet layout |
| Worker registration | `registerBursarSweep` (`apps/worker/src/worker.ts:2605-2625`), `bursar-shared.ts` | 14 jobs |
| MCP module and PolicyGate | `apps/mcp-server/src/tools/bursar-tools.ts:55-80`, `register-tool.ts` | 22 tools |
| SPA shell, help, launchpad | `apps/bursar/src/`, `@bigbluebam/ui`, `build-help-index.mjs` | Bastion pages |
| Seeding | `scripts/seed-gilligan/run-all.mjs`, expectations-constant pattern | `bastion.mjs` |
| Search | `search_everything` (`apps/mcp-server/src/tools/search-tools.ts`) | one fetcher |

**Genuinely new:** the probe catalog and its closed-menu compiler, the hash-chained evidence
ledger with an external witness, the manual-evidence lifecycle (review, freshness, withdrawal),
the honest four-number coverage graph and deterministic gap ranking, policy attestation records,
questionnaire banding tied to live control status, the hardened auditor room, the xlsx codec, and
the Bam GitHub review ledger.

---

## 14. Non-goals and v1.1

**Non-goals (v1):**

1. Not an auditor, not a certification body, no legal opinions; every public and exported surface
   says so.
2. No customer or vendor contract obligations (Bulwark). No outbound vendor-risk questionnaires
   (Bursar territory).
3. No pentest, vulnerability scanning, CSPM, or endpoint agents; those arrive as uploads or feeds.
4. No direct cloud, MDM, IdP, or HRIS connectors in v1; the feed API is the integration point.
5. No LLM reading of uploaded evidence files.
6. No running access reviews or training; their records are consumed when the apps exist.
7. No outbound email or external posting.
8. No editing of Beacon articles or Bolt rules by Bastion; a human applies drafts.
9. No vector retrieval.
10. No `/bastion/ws` realtime.

**v1.1 candidates:**

| Item | Precondition |
| --- | --- |
| S3 Object Lock (WORM) for the `bastion/objects/` prefix | a bucket created with object lock and a per-org storage binding (the storage package documents the binding as designed, not implemented) |
| LLM check that an uploaded file matches its evidence request | measured reviewer load from v1 |
| Native MFA control | the platform ships MFA (section 15.2) |
| GitHub branch-protection evidence | a GitHub App or token-based read path; webhooks do not carry it |
| Extending `v_activity_unified` with a satellite branch | a platform decision covering all satellites |
| Sibling-app feeds (training, incidents, access reviews) | those apps ship and register their events |
| Evidence retention and legal hold policy | customer demand; v1 never deletes evidence |

---

## 15. Open questions and risks

1. **Framework text licensing (human decision, before M2).** The SOC 2 Trust Services Criteria
   text is AICPA copyright and ISO/IEC 27001 Annex A text is ISO copyright. v1 ships reference
   codes plus in-house plain-language summaries and never the official wording. Someone with
   legal authority should confirm that this is acceptable, and whether orgs may paste licensed
   text into a custom framework (assumed yes, since it stays inside their own org).
2. **The platform has no MFA.** No schema, migration, or route implements TOTP or enforced SSO, so
   the most-asked SOC 2 question can never be proven natively. v1 handles it honestly with manual
   evidence (an IdP report). A platform MFA feature would close the most visible gap; that belongs
   on the platform roadmap, not in Bastion.
3. **Inherited (platform) controls.** `platform_backups` and `platform_restores` are
   platform-scoped. On self-hosted single-org installs that is the org's own control. On a
   multi-tenant hosted deploy the hosting operator's own SOC 2 report would be the proper evidence
   (a carve-out). Assumed: label these "Provided by your hosting platform" and let the org attach
   the operator's report as manual evidence if the auditor wants it.
4. **xlsx is new.** No package in the monorepo reads or writes xlsx today. Real questionnaires
   arrive as xlsx. Assumed: add `exceljs` (or equivalent) to `@bigbluebam/structured-data` as a new
   codec at M7, behind its own unit tests. A dependency choice needs approval; CSV works from day
   one regardless.
5. **Immutability is application-level today.** DB triggers plus a hash chain plus a daily
   external witness detect tampering; they cannot prevent a superuser from disabling triggers.
   Auditors may ask; the answer is in the guide. WORM is v1.1.
6. **The GitHub change is in Bam.** Adding `pull_request_review` handling and an unconditional
   PR ledger touches a hot webhook route in apps/api. It is additive, but existing installs must
   also tick "Pull request reviews" in their GitHub webhook settings, which Bastion detects and
   turns into a `connect_source` fix.
7. **Remediation task default.** Assumed `create` (one task per control, updated on repeat
   drift), because drift that produces no task is the problem the product exists to solve. An org
   that dislikes system-created tasks switches to `propose`. A human may prefer `propose` as the
   default.
8. **`v_activity_unified` is not extended.** Bastion's own actions are visible in its audit log
   and through Bam tasks, but not in the unified activity view. A platform decision on letting
   satellites extend the view would resolve this for every app at once.
9. **No vector retrieval.** Lexical search over a small, curated corpus is assumed sufficient for
   questionnaire retrieval; the corpus gate measures it. If recall is poor on paraphrased
   questions, the answer is a platform embedding path, not a private Qdrant collection.
10. **Pre-existing defects found while grounding this spec** (to be filed as tasks, not worked
    around):
    - `apps/bursar/src/hooks/use-bursar-realtime.ts:26` opens `/bursar/ws` and nginx proxies it
      (`nginx-with-site.conf:518`), but bursar-api registers no WebSocket handler, so every
      connection fails and the SPA silently runs on polling. The CLAUDE.md app table describes a
      working realtime path.
    - `apps/api/src/routes/github-webhook.routes.ts` stores pull requests only when the title or
      body references a task, so the platform has no record of unlinked merges at all.
    - Bay stores guest-review tokens in plaintext (`bay_review_links.token`) and carries them in
      the URL path, where they reach nginx access logs.
    - `login_history` has no org column, so per-org sign-in reporting must join through
      memberships, and a multi-org user's failures count in every org they belong to.
11. **Self-review exception.** Requiring a second person to accept manual evidence is impossible in
    a two-person firm. Assumed: under three humans, the owner may accept their own evidence, and
    the auditor sees "accepted by the uploader (small team)".
12. **Questionnaire PII.** Customer questionnaires can contain names and contact details; they are
    member-readable but not viewer-readable. Whether they should be restricted further is a human
    decision.

---

## 16. Changelog

- Round 0 (initial draft, 2026-11-25). Drafted from Seat B's submission with folded-in pieces from
  Seats A, D, E, F, and an explicit answer to Seat E's reservation (sections 1.3, 3.3, 3.5). No
  review findings yet.
