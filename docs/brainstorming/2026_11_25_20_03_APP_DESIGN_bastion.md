# Bastion - App Design Specification

> **STATUS: DRAFT, review round 1 folded in.** This document is the build input for Bastion.
> Where it disagrees with the session submission, this document wins. Where it disagrees with
> the monorepo, the monorepo wins and section 15 records the discrepancy. Every round 1 finding
> has a disposition line in section 16.

**Session:** 2026_11_25_20_03
**Winner:** Seat B's compliance and GRC submission (29 points; runner-up Bevy at 28), with
folded-in pieces from Seat D (questionnaire autofill, auditor share link), Seat F (GitHub-sourced
change-management controls), and Seats A and E (token-gated auditor room). Seat F's public trust
page is deferred to v1.1 (section 14).
**Final name:** **Bastion** (app id `bastion`). The submission's first-choice name collided with
Bursar's core vocabulary, so the word "baseline" is never used as a Bastion table, column, tool,
route, event, or UI term.
**API:** `bastion-api`, internal `:4024` | **SPA:** `/bastion/`, dev `:3024` | **Realtime:** none in v1 (section 5.3)

> **Counting rule.** Permissions are counted by the section 4.6 probe against the section 5.5
> table, and the table wins over any prose number. Tables are enumerated by the generated RLS loop
> over the `bastion_` prefix. Seed figures have exactly one source (section 10.3).

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
9. Infrastructure, backup and DR
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

The flagship output is the **"can't prove yet" list**: controls nothing in your stack can
currently evidence, ranked by audit risk, each with a drafted fix (connect a source, change a
setting, adopt a policy, ask a named person for a file). Setup work ("nobody has confirmed how to
check this yet") is shown separately as a setup progress bar, never mixed into that list
(section 2.3).

**Test once, comply many.** Controls are org-level. SOC 2 and ISO 27001 requirements map onto the
same internal controls through a static crosswalk, so one MFA report, one Bam task, and one
evidence trail serve both frameworks (section 2.1).

### 1.3 Honest scope: the suite cannot see everything

Seat E's recorded reservation is correct and the design treats it as a first-class requirement:
much SOC 2 evidence lives outside the suite (cloud infrastructure, device management, HR
systems, the identity provider). Bastion answers it three ways (section 3.3):

1. **Uploaded and manual evidence is a first-class path**, held to the same rules as native
   evidence: immutable copy, SHA-256 hash, a named owner, a coverage period, an expiry, a
   citation, a second-person review, and a place in the same tamper-evident ledger.
2. **Machine feeds** let an external system (an HR export script, an MDM report, a sibling suite
   app when one exists) push records with a per-feed credential, frozen the same way.
3. **The coverage graph never blends sources.** The home screen reports four separate numbers:
   proven by the suite, proven by evidence you provided (with how much of it expires soon), not
   met, and can't prove yet. A control that mixes native and provided evidence counts as
   "provided", so the suite number never overstates.

### 1.4 Category boundary (adjacent, not on top)

| App | Object | Counterparty | Bastion's relationship |
| --- | --- | --- | --- |
| **Bulwark** | Clause owed under an executed contract | Customer or vendor | None. Bastion never reads contracts. |
| **Bursar** | Vendor offers and spend | Vendors | Optional read-only probe input: "critical vendors have an award on file" (CC9.2). No writes. |
| **Beacon** | Knowledge articles, verification | Staff | Bastion links policy articles and records who attested to which version. Beacon remains the editor. |
| **Bam** | Tasks, GitHub integration | Team | Remediation tasks via a new internal route; PR review events from a new Bam-owned ledger. |
| **Bin** | Files | Team | Upload path for manual evidence (reuses Bin upload and AV scan); Bastion then copies bytes into its own bucket. |
| **Bay** | Media review guest links | External reviewer | The auditor room borrows the token-gated guest-link pattern, hardened (section 5.2). |

**The enforceable boundary:** Bastion writes zero rows in any other app's tables except
(a) Bam tasks and comments through a dedicated internal route attributed to the Bastion System
user and (b) `entity_links` and `agent_proposals` rows (platform tables). Policy drafts and Bolt
rule drafts are applied to Beacon and Bolt by a human, under that human's own session.

### 1.5 Cadence

Daily background value (nightly evaluation, drift tasks) plus episodic spikes (an incoming
questionnaire, an audit window). The retention mechanism is the drift task in Bam and the weekly
`readiness.weekly` Bolt event an org can route to Banter. That event is only deliverable once the
platform Bolt source list includes `bastion` (milestone M0, issue #124).

---

## 2. AI-native design

Bastion has four AI mechanisms. Each has a deterministic core; the LLM only fills in the parts
where language is the work. **The LLM never writes SQL, never decides a control's status, never
chooses a Bolt action, and never sends anything outside the org unattended.**

### 2.1 Controls, frameworks, and the compiler

**Org-level controls with a requirement mapping (option b, chosen).** The library in
`apps/bastion-api/src/library/` defines:

- `controls.ts`: Bastion's internal control catalog, each with a stable `control_key` (for
  example `access.offboarding`, `change.peer_review`, `auth.mfa`), a plain title and summary, a
  category, a `risk_weight` (1-5), `suggested_assertions[]`, and `suggested_manual_evidence[]`.
- `soc2.ts`, `iso27001.ts`, `starter.ts`: each framework's requirement list as
  `{ ref_code, title, plain_summary, control_keys[] }`. This **is** the static SOC 2 to ISO 27001
  crosswalk: two requirements that name the same `control_key` share one internal control.

Adopting a framework creates `bastion_controls` rows only for `control_key`s the org does not
already have, and always creates `bastion_control_requirements` rows linking the control to that
framework's `ref_code`s. Adopting ISO 27001 after SOC 2 therefore adds requirement links plus the
few ISO-only controls; assertions, evidence, gaps, exceptions, and Bam tasks stay single. The four
home numbers and every list take `?framework_id=` to show one framework's view.

Why option (b) fits rather than a one-framework limit: the library already carries a per-control
key and per-requirement `ref_code`, the second framework is the stated customer journey
(section 1.2), and the cost is one mapping table. The concrete risk is that a crosswalk is a
judgement; it ships as reviewed code with a unit test asserting every requirement maps to at
least one control, and an admin may add or remove a requirement link (audited).

Org-authored **custom controls** are allowed (`POST /controls`, `control_key = 'custom:<slug>'`)
and may be linked to any adopted framework requirement. **Custom frameworks extracted from a
document by the LLM are v1.1** (section 14).

**The compile flow (built-in frameworks only in v1):**

1. **Company profile interview.** Ten plain questions ("Do you write software?", "Do people work
   from company laptops?", "Do you keep customer data in your own cloud account?").
2. **Tailoring (LLM, optional).** For each new control the compiler sends the control summary,
   the profile, the list of connected sources, and **the probe catalog** (section 3.1) as a closed
   menu. The model returns JSON: probe keys, parameters (including a proposed `expected_population`
   for population-based probes), thresholds, a manual-evidence spec, or "not applicable" with a
   reason.
3. **Validation (deterministic).** Every probe key must exist in the catalog; every parameter set
   must pass that probe's Zod schema; every threshold must sit inside the probe's allowed range.
   Anything else is dropped with a recorded reason.
4. **Everything lands as `proposed`.** A human confirms each assertion (or bulk-confirms a control
   after reading the plain statement and the proposed population). Only `confirmed` assertions are
   evaluated.
5. **Deterministic fallback.** With no LLM provider configured, or the proxy down, the library's
   `suggested_assertions` are proposed verbatim and the population is proposed from what the
   compiler finds connected. Compile never blocks on the model.

Confirmed assertions are **content-immutable**: an edit creates a new `proposed` row that
supersedes the old one on confirmation, so every historical snapshot cites the exact assertion
version that produced it.

### 2.2 The nightly evaluator

Fully deterministic. For each control, it evaluates every confirmed assertion (probe, manual
evidence, or feed), writes a canonical evidence document to Bastion's bucket, hashes it, and
appends it to the org's evidence ledger. **Status is aggregated per control only after every
confirmed assertion of that control has a snapshot in the run**, and written with a conditional
update (section 7.3). A control's status is the worst of its assertions (`fail` > `unprovable` >
`pass`), then adjusted by accepted exceptions (section 2.6). Infrastructure failures never count
as compliance failures (section 3.2).

### 2.3 The coverage graph and gap ranking

The graph is `control -> assertion -> evidence source`, where a source is `native` (probe),
`feed`, `manual_file`, `self_attested`, or `none`. Each control gets a `coverage_kind`: `native`,
`feed`, `manual`, `attested`, `mixed`, or `none`.

**The four home numbers (authoritative rule).** Over applicable controls with at least one
confirmed assertion:

| Number | A control counts here when |
| --- | --- |
| Proven by the suite | status `pass` and every passing assertion is `native` or `feed` |
| Proven by evidence you provided | status `pass` and any passing assertion is manual or self-attested (this includes `mixed`) |
| Not met | status `fail` |
| Can't prove yet | status `unprovable` |

Controls with **no confirmed assertion** are excluded from all four numbers and from the gap
list. They appear only in **Setup: N of M controls have a confirmed check**, a progress bar on
Readiness and in the setup wizard. `not_applicable` controls are excluded and listed separately.

**The gap mapping (the one authoritative table).** Every `(status, reason)` maps to one gap kind,
severity, and default fix template. Implementations must not invent another mapping;
`BASTION_SEED_EXPECTATIONS` asserts it.

| Status | Reason | `gap_kind` | Severity | Default fix template |
| --- | --- | --- | --- | --- |
| `fail` | (any) | `failing` | 1.00 | by probe (`config_change`, `bolt_rule`, `process_change`) or `evidence_request` for manual `shows_exception` |
| `unprovable` | `no_evidence_source` | `no_source` | 0.90 | `evidence_request` |
| `unprovable` | `manual_evidence_expired` | `manual_expired` | 0.85 | `evidence_request` |
| `unprovable` | `source_not_connected` | `not_connected` | 0.80 | `connect_source` |
| `unprovable` | `manual_evidence_missing` | `manual_missing` | 0.80 | `evidence_request` |
| `unprovable` | `evaluation_stale` | `stale` | 0.70 | `process_change` ("the nightly check isn't running"; also raises a worker error) |
| `unprovable` | `insufficient_data` | `insufficient_data` | 0.40 | none (informational; explains the period was too quiet) |
| `unprovable` | `probe_error` (second consecutive night) | `check_broken` | 0.60 | none (operator issue; recorded via `recordWorkerError`) |
| `unprovable` | `not_yet_confirmed` | (no gap) | n/a | setup progress bar only |
| `pass` | manual evidence within the warning window | `manual_expiring` | 0.50 x (1 - days_left / warn_window) | `evidence_request` |
| `pass` | only self-attested evidence | `attested_only` | 0.90 x 0.6 = 0.54 | `evidence_request` (upgrade to a file) |

```
risk = control.risk_weight (1..5) x severity x audit_proximity
audit_proximity = 1 + max(0, 90 - days_to_nearest_audit_target) / 90
```

Fix template costs are fixed: `config_change` 1, `connect_source` 2, `bolt_rule` 2,
`evidence_request` 2, `policy_draft` 3, `process_change` 5. The list sorts by risk descending,
cost ascending; a "Quick wins" toggle sorts by `risk / cost`. **The LLM never sets risk or picks
the template.**

### 2.4 Fix drafting (into `agent_proposals`)

For a selected gap, Bastion files a platform proposal (`agent_proposals`,
`apps/api/src/db/schema/agent-proposals.ts:27-48`) with `proposed_action =
'bastion.fix.<template>'`, `subject_type = 'bastion.gap'`, approver = the control owner (fallback:
an org admin), `expires_at` = now + 14 days, `actor_id` = the Bastion System user (or the calling
agent). The draft body also lives in `bastion_fix_drafts`, whose `proposal_id` is the only link
Bastion trusts (section 2.8).

| Template | What is drafted | What happens on approval |
| --- | --- | --- |
| `evidence_request` | LLM: a plain request to the named owner, with an example of acceptable evidence | Bastion creates a Bam task assigned to the owner (via the outbox) linking to the upload screen |
| `policy_draft` | LLM: Markdown policy text grounded in the control summary and the org profile | The approver clicks **Create in Beacon as a draft** (SPA, approver's own session); `mark-applied` records the entry |
| `bolt_rule` | **Deterministic**: a rule shape from a closed set in `apps/bastion-api/src/library/bolt-rule-shapes.ts`, keyed by `(gap_kind, probe_key)`. Actions come only from an allowlist (`create_task` in the compliance project, `banter_post` to an internal channel). The LLM writes only the name and description. Any draft containing another action, including `send_webhook` or `send_email*`, is rejected before persisting. | **Create in Bolt (turned off)** under the approver's session; a human turns it on |
| `connect_source` | Template text with plain steps | Human does it; the next evaluation proves it |
| `config_change` | Template text with the exact setting and value | Human does it; the next evaluation proves it |
| `process_change` | LLM: a short procedure plus the manual evidence it will produce | Becomes a manual assertion |

Every cited label passes the injection pre-scan
(`apps/bursar-api/src/lib/injection-prescan.ts`) and is placed inside a delimited data block
before it enters any prompt; PR titles, tracked-app names, key names, and vendor names are
outsider-controlled text. Every citation in a draft passes `can_access` for the asker before it is
persisted and again when it is rendered.

### 2.5 Drift handling

A control's status worsening (`pass -> fail`, `pass -> unprovable` for a non-infrastructure
reason) writes a `bastion_drift_events` row and, in the same transaction, outbox rows for the
`control.drifted` event and the Bam task upsert. `remediation_tasks` in settings is `create`
(default) or `propose`.

**One task per control, with reopen semantics.** The internal route upserts
`external_id = 'bastion:control:<control_id>'`. If the existing task sits in a terminal phase
(`phases.is_terminal`, `apps/api/src/db/schema/phases.ts:17`), the route moves it to the project's
start phase (`is_start`) and adds the comment "Drifted again on {date}: {reason}". The section
11.2 flow tests "drift, close, drift again: the task is open". On recovery Bastion publishes
`control.recovered` and comments; it never closes the task.

**A compliance project is a required setup step.** The setup wizard offers **Create a
"Compliance" project for me** (the SPA calls Bam's project API with the user's session, then saves
it in settings) or **Use an existing project**. While it is unset, Readiness shows a banner
("Bastion can't open tasks for problems until you choose a project") and drift rows record
`task_status = 'no_project'`.

### 2.6 Exceptions (accepted risk)

A justified violation needs a legitimate resolution that is not "loosen the threshold". A
`bastion_exceptions` row names one control, optionally one assertion and one cited entity (for
example PR #42, or the long-lived "Radio Relay" service key), a reason, a compensating-control
note, and a mandatory `expires_at` (at most 365 days). It is filed as an `agent_proposals` row
(agents may propose); it takes effect only when approved by a human holding
`bastion.exception.approve` (section 2.8). Approved exceptions are immutable and ledgered (entry
kind `exception`).

Effects: snapshots keep the raw outcome. If every failing cited ref (or the whole failing
assertion) is covered by an active exception, the control's status becomes `pass` with a visible
"1 accepted exception" marker, and it counts under "Proven by evidence you provided". Exceptions
appear in the auditor room and in the packet's `exceptions.csv`. Expiry publishes
`exception.expired` and the next evaluation reverts to the raw outcome.

### 2.7 Security-questionnaire autofill

1. A questionnaire file (xlsx or csv) arrives as a Bin asset, optionally linked to a Bond deal and
   company.
2. **Parse (deterministic).** `@bigbluebam/structured-data` codecs (csv today; xlsx is a new codec,
   section 15.4) produce rows; a column-mapping step identifies question, answer, and yes/no
   columns.
3. **Pre-scan.** Every question passes the injection pre-scan; a suspect row is forced to `low`.
4. **Retrieve (lexical, inside Bastion).** Postgres full-text search over the answer library,
   control summaries, confirmed assertion statements, and linked policy titles. No vector store.
5. **Draft (LLM).** The model gets the question plus top-k candidates with ids and must answer
   citing candidate ids only.
6. **Verify and band (deterministic).** Cited ids must be in the retrieved set and pass
   `can_access` for the questionnaire owner. Any answer citing a control whose **effective**
   status (including staleness, section 3.2) is `fail` or `unprovable` is forced to `low`, and the
   draft says so plainly. Bastion never drafts a confident "Yes" it cannot prove.
7. **Review.** `low` and `medium` rows go to the review queue (control owner, or the person
   `expertise_for_topic` suggests). A floored, non-impersonated **Approve** is required before
   export. Export writes answers back into the original layout with formula-neutralized cells
   (`packages/shared/src/csv-safe.ts:26-66`).
8. **Learn.** Approved answers enter `bastion_answer_library`, automatically marked stale when any
   cited control changes status.

A single-question variant (`POST /answers/draft`, MCP `bastion_draft_answer`) answers one
question as a cited draft.

### 2.8 What agents may do, and guardrails

| Action | Autonomous | Needs a human |
| --- | --- | --- |
| Read controls, status, coverage, gaps, drift, exceptions, evidence summaries | yes (counts-only explanations unless the asker may see detail) | |
| Read evidence row-level detail | only when the asker holds `bastion.evidence.read_detail` or owns the control (intersection rule) | |
| Verify an evidence hash and ledger segment | yes | |
| Run a compile (produces `proposed` assertions only) | yes | confirming |
| Propose an assertion | yes (lands `proposed`) | confirmation |
| Run an evaluation (1 full run per org per hour, 1 control-scope run per control at a time) | yes | |
| Draft questionnaire answers or a single answer | yes (drafts only) | approving and exporting |
| Propose a fix or an exception (`agent_proposals`) | yes | a human with the matching Bastion permission decides |
| Upload, withdraw, redact evidence | no tool | a human attests |
| Sign a policy attestation | **never** | the person themselves, not impersonated |
| Create or revoke an auditor room, change settings | no tool | floored humans with confirm |

**Guardrails.**

- **Agent policies.** Every `bastion_*` tool goes through `registerTool`
  (`apps/mcp-server/src/lib/register-tool.ts`), so the `agent_policies` kill switch and allowlist
  apply; tools fail closed until an operator allowlists `bastion.*` (satellite pattern,
  `apps/mcp-server/src/tools/bursar-tools.ts:30-38`).
- **`asker_user_id` narrows, never widens** (same reasoning as `bursar-tools.ts:19-28`).
- **Proposal decisions are re-verified, not trusted.** `proposals.routes.ts` lets any owner or
  admin role (including an admin-role service account) decide any proposal, and
  `proposal_create` lets any agent mint a `bastion.fix.*` action. So `proposal.decided` is only a
  wake-up signal. Bastion re-reads `agent_proposals` by id and acts only when (1) the id equals a
  `proposal_id` Bastion itself wrote on a fix draft, exception, or drift row; (2) `approver_id`
  resolves to `users.kind = 'human'`; (3) that human holds the matching Bastion permission
  (`fix.draft` approval is the control owner or `control.write`; exceptions need
  `exception.approve`) per the permission resolver; (4) the decision was not made while
  impersonating (the audit row of the decision carries no impersonator). Anything else is
  recorded as `decision_rejected` and the draft stays `proposed`.
- **Impersonation cannot vouch.** A `rejectWhenImpersonating` preHandler returns 403
  `IMPERSONATION_NOT_ALLOWED` on every route where the act means "this specific person vouches":
  attest, manual-evidence create and supersede, link review, assertion confirm and reject,
  exception approval reconcile, questionnaire approve, auditor-room create and revoke, redaction.
  Every other write records `impersonator_id` on `bastion_audit_log`. (The copied auth plugin
  swaps `request.user` on `X-Impersonate-User`, `apps/bursar-api/src/plugins/auth.ts:308-353`.)
- **Visibility preflight.** Every cited entity passes `can_access`
  (`packages/shared/src/visibility-client.ts`) at write and at read; dropped citations are
  counted on the row.
- **Closed probe menu.** The model selects from code-reviewed probes; probe SQL lives in
  `SECURITY DEFINER` functions (section 3.1).
- **Internal routes are not reachable from outside.** All three nginx confs get
  `location ~ ^/bastion/api/v1/internal/ { return 404; }`; bolt-api and the worker call
  bastion-api directly on the internal network.
- **No outbound transport.** Bastion sends no email and posts to no external system.

---

## 3. The evidence engine

### 3.1 The probe catalog (native evidence)

**Where the SQL lives.** Under `BBB_RLS_ENFORCE=1` the shared role loses BYPASSRLS, and
`0116_rls_foundation.sql:97-104` hides `sessions` rows of users with no membership in the current
org, so a probe inside `runInOrgScope` would see zero departed sessions and **pass the very
control it exists to catch**. Probes therefore run as `SECURITY DEFINER` SQL functions created by
migration `0267_bastion_probe_functions.sql`: `bastion_probe_<key>_v<version>(org uuid, as_of
timestamptz, params jsonb) RETURNS jsonb`, `STABLE`, `SET search_path = public`, owned by the
migrating superuser, each with an explicit org predicate. A new probe version is a new function
in a new migration (old versions stay, so historical snapshots remain reproducible).
`query_fingerprint` is the SHA-256 of `pg_get_functiondef(oid)` read at boot.

The TypeScript side (`apps/bastion-api/src/probes/<key>.ts`) exports `{ key, version,
paramsSchema (Zod), preconditions(), visibilityFloor(), explain(result, detailAllowed) }` and
calls the function in a `READ ONLY` transaction with `SET LOCAL statement_timeout =
BASTION_PROBE_TIMEOUT_MS` on `DATABASE_READ_URL` when set. Every probe has a **visibility floor**:
it must see at least as many org members as `organization_memberships` reports through the same
definer path, otherwise the outcome is `unprovable/probe_error`. Every probe reads `run.as_of`,
never `now()`.

**Population rule.** Population-based probes take a human-confirmed `expected_population`
parameter. Any expected member not connected yields `unprovable/source_not_connected` naming it,
and every `explain()` and snapshot summary states the population checked ("1 repository checked:
Rescue Radio Firmware").

**Precondition rule.** No precondition may be satisfiable only by the control actually operating
(a team that never does the thing must get `fail`, not "not connected").

| Key | Source (verified in repo) | Precondition (else `unprovable`) | Default predicate | Cited refs |
| --- | --- | --- | --- | --- |
| `keys.max_age` | `api_keys` (`org_id`, `created_at`, `rotated_at`; `apps/api/src/db/schema/api-keys.ts:11-41`) | none | no key older than 90 days since `coalesce(rotated_at, created_at)` | key ref |
| `keys.unused_active` | `api_keys.last_used_at` | none | no key unused for 60+ days | key ref |
| `access.departed_still_holding` | `users.is_active`, `users.disabled_at`, `organization_memberships`, `api_keys`, `sessions.active_org_id` (read via the definer, so RLS cannot hide rows) | none | zero people who left still hold a key or live session for this org | person ref |
| `access.dormant_accounts` | `organization_memberships`, `login_history` (no org column; joined via `user_id`), `sessions.last_used_at` | none | zero human members with no sign-in for 90 days | person ref |
| `access.privileged_roster` | `organization_memberships.role`, `users.is_superuser` | none | at most 3 owners/admins | person ref |
| `auth.failed_login_spikes` | `login_history` (`success = false`) | none | 0 hours with 10+ failures for one account | person ref, hour (no IP) |
| `agents.policy_coverage` | `users.kind in ('agent','service')`, `agent_policies` | none (zero agents passes trivially and says so) | every agent has a policy row and no bare `*` allowlist | agent ref |
| `agents.human_approval` | `agent_proposals` | none (an empty window is `insufficient_data`) | at most 5 proposals expired undecided in 30 days | proposal ref |
| `change.merge_reviewed` | **new** `github_pr_events` + `github_integrations.subscribed_events` (section 8.4) | every repo in `expected_population` has an enabled integration **subscribed to `pull_request_review`** (from the stored `ping` `hook.events`, or any review delivery ever received) | 100% of merges to the default branch had an approval from someone other than the author before merge | PR ref |
| `change.merge_traceable` | `github_pr_events.task_refs` | every expected repo integrated | at least 90% of merges reference a Bam task | PR ref |
| `ops.backup_fresh` (inherited) | `platform_backups` (platform-scoped) | **none** (zero completed backups is `fail`, not "not connected") | a completed backup within 26 hours | counts only |
| `ops.restore_tested` (inherited) | `platform_restores` | none | a completed restore within 365 days | counts only |
| `logging.retention_floor` | `blip_retention_policies` + `blip_tracked_apps` | every app in `expected_population` is a Blip tracked app | each keeps logs at least 90 days (null age = unlimited, passes) | tracked app ref |
| `logging.audit_trail_alive` | `v_activity_unified` | none | activity recorded in the last 7 days | counts only |
| `automation.failure_rate` | `bolt_executions` + `bolt_automations` | none (no enabled automation is `insufficient_data`) | at most 5% failed in 30 days | automation ref |
| `policy.attested` | `bastion_policy_attestations` vs required people | a linked policy | 100% of required people attested to the current version within cadence | person ref |
| `policy.current` | `beacon_entries` (`status = 'Active'`, `visibility`, `expires_at`, `last_verified_at`) | a linked policy | Active, visible org-wide, not expiring within 30 days (cites Beacon's own `expires_at`), verified within 365 days | article ref |
| `platform.superuser_access` | `superuser_audit_log.target_org_id` | none | informational; at most N actions in 30 days, all cited | action, date |
| `vendors.critical_have_award` | `bursar_vendors.criticality`, `bursar_awards` | none (no critical vendors passes and says so) | every critical vendor has an active award | vendor ref |
| `feed.fresh` | `bastion_feed_records` | the feed exists | a record within cadence, optional count predicate | feed record ref |

**Inherited controls.** The two `ops.*` probes read platform-scoped facts, labelled **"Provided
by your hosting platform"** (section 15.3).

**What has no native probe, and says so.** MFA coverage (the platform has no MFA or TOTP),
device encryption, cloud configuration, background checks, physical security, and GitHub branch
protection (webhooks do not carry it). These are proposed with manual evidence specs from day
one.

**Redaction and personal data.** Probes never emit secrets, key hashes, IP addresses, session
ids, or user agents. Cited refs in the hashed evidence document are `{ entity_type, entity_id }`
only; human-readable labels live in the mutable `bastion_personal_data` table (section 3.4).
`explain()` returns counts only ("3 API keys are older than 90 days") unless the viewer holds
`read_detail` or owns the control, in which case labels are joined in.

### 3.2 Outcomes, reason codes, staleness

Three statuses: `pass`, `fail`, `unprovable` (UI: **Proven**, **Not met**, **Can't prove yet**).
`unprovable` always carries one reason:

| Reason | Plain UI text |
| --- | --- |
| `not_yet_confirmed` | "Nobody has confirmed how to check this yet." (setup bar only) |
| `no_evidence_source` | "Nothing in the suite can show this. Upload evidence or connect a source." |
| `source_not_connected` | "This could be checked automatically, but {source} isn't connected." |
| `manual_evidence_missing` | "Waiting for {owner} to upload {what}." |
| `manual_evidence_expired` | "The evidence {owner} uploaded expired on {date}." |
| `insufficient_data` | "There wasn't enough activity in the period to tell." |
| `probe_error` | "The check couldn't run. We'll try again tonight." |
| `evaluation_stale` | "This hasn't been checked since {date}, so we can't vouch for it." |

**Staleness.** A control whose `last_evaluated_at` is older than `stale_after_hours` (default 36)
is **computed and displayed as `unprovable/evaluation_stale` everywhere status is consumed**:
Readiness, gaps, questionnaire banding, the auditor room, MCP reads. One shared function,
`effectiveStatus(control, now)`, is the only way any reader obtains a status.

**Infrastructure failures do not drift.** `probe_error`, a storage write failure, or a read-only
transaction failure keeps the previous stored status, sets `stale_reason`, and increments
`consecutive_error_nights`. Only a second consecutive `probe_error` night is treated as a status
change (to `unprovable/probe_error`, gap kind `check_broken`). If the bucket is unavailable, the
slice ends without writing a snapshot or ledger row and the run finishes `partial` with reason
`storage_unavailable`. The `bastion-evaluation-missed` job records a worker error via
`recordWorkerError` and publishes `evaluation.missed` when no nightly run completed for an org in
26 hours.

`not_applicable` is an applicability state (with a written reason), not a status.

### 3.3 Uploaded and manual evidence (the answer to Seat E)

Manual evidence obeys the same rules as native evidence: immutable bytes, SHA-256, a named owner,
a covered period, an expiry, citation on every snapshot that uses it, a ledger entry, and
second-person review.

| Kind | Example | Trust level shown |
| --- | --- | --- |
| `file` | Google Workspace 2-Step Verification report (CSV), AWS IAM credential report, Jamf export, a pen-test PDF | "Uploaded evidence" |
| `attestation_statement` | "All six laptops have FileVault on. Checked by the Professor on 2026-11-02." | "Self-attested" (gap kind `attested_only`, section 2.3) |
| `feed_record` | Records pushed by a machine feed (section 3.5) | "Automated feed" |

**Upload path (reuses Bin).** The SPA uploads the file to Bin through bin-api's existing route
with the user's session (so `bin-av-scan` runs) into a per-org "Compliance evidence" folder, then
calls `POST /bastion/api/v1/manual-evidence` with the asset id and metadata. bastion-api applies
the four checks of `assertBinAssetReadable` (`apps/bursar-api/src/lib/bin-asset-access.ts`:
`can_access`, same org, scan state, exists), pins `current_version_id`, then **streams the pinned
version's bytes, hashing as it goes, into Bastion's own bucket** (a cross-bucket stream, not
`copyTo`) under a random key `objects/<uuid>`. The hash is a column, never part of the key, and
the key is never shown.

**Scan states, mapped explicitly** (`apps/worker/src/jobs/bin-av-scan.job.ts:13-23`):

| Bin `scan_status` | Bastion outcome |
| --- | --- |
| `clean` | copy immediately at attach |
| `skipped` (scanning off) | copy immediately; labelled "Not virus-scanned (scanning is off on this installation)" |
| `pending` | row `pending_scan`; retried by `bastion-evidence-ingest` with `attempts` and `next_attempt_at` backoff; after 24 h it surfaces in the review queue and retries stop |
| `infected` | `blocked`, reason `infected` |
| `error` | `blocked`, reason `scan_failed`, plain message "The virus scanner couldn't check this file. Ask your administrator." |

Because bytes are copied once at attach when the pinned version is already clean or skipped, later
Bin version churn cannot block evidence. If the asset moved to a newer version before the pinned
version was copied, the row is `blocked` with reason `changed_before_scan` and the user re-attaches.

**Required metadata.** What is this? Which system did it come from? Who is responsible (owner)?
When was it produced? What period does it cover? Is it restricted (HR, legal, pen-test)? Plus a
required uploader statement. `valid_until` is an **end-of-day instant in the org's timezone**,
computed by one shared helper (`packages/shared/src/schemas/bastion.ts`, `endOfDayInTz`) used by
the evaluator, the expiry job, and the SPA. It defaults from `manual_evidence_spec.cadence_days`
and may be shortened, never extended.

**Evaluation of a manual assertion.** `pass` if at least one `active` linked item has `valid_until
>= run.as_of`, covers the required window, and is `accepted` by a reviewer with
`bastion.evidence.review` who is not the uploader (under three humans in the org the owner may
accept their own, recorded as "accepted by the uploader (small team)"). `shows_exception` yields
`fail`. Otherwise `unprovable` (`manual_evidence_missing` or `manual_evidence_expired`).

**Withdrawal and redaction.** Withdraw sets `status = 'withdrawn'` and writes a ledger entry.
Redaction (section 3.4) deletes bytes and personal data while keeping the hash commitment.

### 3.4 Immutability, the evidence ledger, personal data

**Ledger entries.** Every evidence-bearing record (snapshot, manual evidence, feed record,
attestation, exception, withdrawal, redaction, restore) appends one row to
`bastion_ledger_entries`.

**Canonical form (one canonicalizer, shared by writer and verifier,
`apps/bastion-api/src/lib/ledger-canonical.ts`):**

```
entry_hash = hex_lower( sha256( canonical_json({
  org, seq, kind, id, content_sha256, personal_data_hmac, prev, recorded_at
}) ) )
```

`canonical_json` sorts keys, uses no whitespace, renders numbers as JSON integers, and renders
`recorded_at` as a UTC ISO string truncated to milliseconds with a `Z` suffix. `recorded_at` is
set in the application (never a DB default) and stored already truncated. `prev` is lowercase hex
(the genesis `prev` is 64 zeros). A golden test round-trips rows through Postgres and recomputes.

- Appends are serialized per org with `pg_advisory_xact_lock(hashtext('bastion_ledger:' || org))`
  in a short transaction with **no outbound HTTP** (`apps/burn-api/src/lib/advisory-lock.ts`).
  Object writes precede the transaction.
- **Four-path immutability** (the `bursar_baseline_items` pattern, `0249_bursar_awards_baseline.sql`):
  `BEFORE UPDATE` with `WHEN` on content columns, `BEFORE DELETE`, `ON DELETE RESTRICT`, and
  `BEFORE TRUNCATE`, on `bastion_evidence_snapshots`, `bastion_evidence_objects`,
  `bastion_manual_evidence` (content columns; redaction columns are the only mutable ones),
  `bastion_feed_records`, `bastion_policy_attestations`, `bastion_exceptions` (content columns),
  `bastion_ledger_entries`, `bastion_ledger_seals` (content columns).
- **Snapshot dedup.** A byte-identical canonical document reuses the object; a new snapshot row
  and ledger entry are still written.

**Seals and the external witness.** `bastion-ledger-seal` writes one `bastion_ledger_seals` row
per org per UTC day (`head_seq`, `head_hash`, Ed25519 `signature` with `BASTION_SEAL_SIGNING_KEY`,
a secret held in env, never in the DB), in the same transaction as an outbox row for
`ledger.sealed`. The outbox drainer retries until `published_at` is set, so a bolt-api outage
cannot lose a seal. The public key is served by `GET /ledger/seals`, and the signed seal history is
printed into the packet's `manifest.json` and shown in the auditor room, so an auditor can compare
heads they already received. A rewritten chain cannot reproduce old signatures.

**Verification is bounded.** `GET /evidence/:id/verify` re-reads the object, recomputes SHA-256,
and walks only from the entry to the next seal (at most one day of entries). It reports
`intact`, `hash_mismatch`, `object_missing`, or `redacted` separately. `bastion-ledger-verify`
works through a per-run object budget with a resume cursor and progress logging.

**Restores.** After a database restore, the head may fall behind already-published seals. On boot
and in each seal run, bastion-api compares the ledger head with the latest seal; if the head is
behind, it appends a `restore` entry citing the prior sealed head and publishes `ledger.restored`,
so a rewind is explained, not flagged as tampering (section 9.7).

**Personal data is outside what the ledger proves.** Names, emails, labels, and feed attributes
live in `bastion_personal_data` (mutable, org-scoped, keyed by holder). Immutable rows and evidence
documents carry only `personal_data_hmac = HMAC(BASTION_PD_HMAC_KEY, canonical_json(data))`. One
audited, owner-only, confirm-gated, non-impersonated route (`POST /personal-data/:id/redact`)
blanks the data, deletes any manual-evidence bytes it belongs to, sets `redacted_at`, and appends
a `redaction` ledger entry. The chain stays verifiable; the entry shows "redacted".

**Honest limit.** Services connect as a Postgres superuser today; triggers plus the chain plus
off-database signed seals make tampering detectable, not impossible. WORM storage is v1.1.

### 3.5 Machine feeds (external systems and sibling apps)

- **Contract.** `packages/shared/src/schemas/bastion.ts` defines `bastionFeedRecordSchema`:
  `{ feed_kind: 'training_completion' | 'incident_record' | 'access_review' | 'device_inventory' |
  'hr_roster' | 'generic', idempotency_key, occurred_at, subject_label?, subject_user_email?,
  attributes (bounded, 16 KB), source_label }`. Subject and attributes go to
  `bastion_personal_data`.
- **Per-feed credentials** (Blip's ingest-key pattern, `apps/blip-api/src/db/schema/blip-ingest-keys.ts`):
  `bastion_feed_keys` holds a public `key_id`, `secret_hmac` (HMAC with a server pepper), a
  fingerprint, `last4`, status, and a 7-day rotation grace. A token is shown once from the feed's
  settings page (**Create a key for this feed**), can only append to that one feed, and is recorded
  on every record as `feed_key_id`. No `bbam_` key can push feed records.
- **Limits.** Batches up to 500 records and 2 MB; per-key rate limit 60 requests per minute; a
  per-feed daily record quota (`daily_record_quota`, default 5,000) returning 429 when exceeded;
  per-org feed storage accounting shown in settings. Duplicates by `(feed, idempotency_key)` are
  no-ops.
- **Sibling apps (when present).** bolt-api gets `bastion-subscriptions.ts` and
  `bastion-dispatch-hook.ts`, modeled on `apps/bolt-api/src/services/bursar-dispatch-hook.ts`,
  forwarding subscribed events to `/v1/internal/events`. v1 registers `proposal.decided` only.
- **Freshness** is the `feed.fresh` probe.

### 3.6 Policy attestation (Beacon)

Beacon has verification but no acknowledgement record, so Bastion owns attestation. Linking a
Beacon article as a policy requires its `visibility` to be `Organization` or `Public`; otherwise
the link returns 422 with "Share this article with everyone first". `policy.current` re-checks
visibility and Beacon's own `expires_at` nightly, so a narrowed or expiring article becomes a gap
before `beacon-expiry-sweep` retires it.

**What is shown is what is hashed.** `/bastion/attest` reads the policy body from
`GET /policies/:id/body`, which serves the exact `beacon_versions.body_markdown` of the current
version that bastion-api also hashes. **I have read and understood this** records the attestation
against that version number and body hash. A new Beacon version resets the requirement. Agents and
impersonated sessions cannot attest.

---

## 4. Data model and migrations

All tables prefixed `bastion_`, org-scoped by `organization_id`, Drizzle schema in
`apps/bastion-api/src/db/schema/`, plus a `bbb-refs.ts` peer stub for `users` and
`organizations`. Cross-app refs are typed uuid columns with no cross-schema FK. `entity_links`
and `agent_proposals` use `org_id`.

### 4.1 Tables

**Frameworks and controls**

- **`bastion_frameworks`**: `id`, `organization_id`, `template_key` (`soc2`,`iso27001`,`starter`),
  `template_version`, `name`, `status` CHECK (`compiling`,`active`,`archived`),
  `audit_target_date`, `period_start`, `period_end`, `adopted_by`, timestamps. Unique
  `(organization_id, template_key) WHERE status <> 'archived'`.
- **`bastion_controls`**: `id`, `organization_id`, `control_key`, `title`, `plain_summary`,
  `category`, `risk_weight smallint` CHECK 1-5, `owner_user_id` (SET NULL), `applicability` CHECK
  (`applicable`,`not_applicable`), `not_applicable_reason`, `status` CHECK
  (`pass`,`fail`,`unprovable`), `status_reason`, `stale_reason`, `consecutive_error_nights`,
  `coverage_kind` CHECK (`native`,`feed`,`manual`,`attested`,`mixed`,`none`),
  `active_exception_count`, `last_evaluated_at`, `status_changed_at`, `tsv` (generated, GIN),
  timestamps. Unique `(organization_id, control_key)`.
- **`bastion_control_requirements`**: `id`, `organization_id`, `control_id` (RESTRICT),
  `framework_id` (RESTRICT), `ref_code`, `requirement_title`, `source` CHECK
  (`crosswalk`,`admin`), `created_by`, `created_at`, `removed_at`. Unique `(organization_id,
  framework_id, ref_code, control_id)`.
- **`bastion_assertions`**: `id`, `organization_id`, `control_id`, `kind` CHECK
  (`probe`,`manual`,`feed`), `probe_key`, `probe_version`, `params jsonb` (includes
  `expected_population`), `predicate jsonb`, `manual_evidence_spec jsonb`, `feed_id`,
  `plain_statement`, `proposed_by` CHECK (`library`,`compiler`,`human`,`agent`), `compile_run_id`,
  `review_status` CHECK (`proposed`,`confirmed`,`rejected`,`superseded`), `supersedes_id`,
  `confirmed_by`, `confirmed_at`, `created_by`, timestamps. Content immutable once confirmed.
- **`bastion_compile_runs`**: `id`, `organization_id`, `framework_id`, `status` CHECK
  (`running`,`succeeded`,`partial`,`failed`), `controls_total`, `controls_done`,
  `assertions_proposed`, `assertions_dropped`, `drop_reasons jsonb`, `llm_calls_used`,
  `used_fallback`, `claimed_by`, `heartbeat_at`, `error`, timestamps.
- **`bastion_org_settings`**: `organization_id` PK, `llm_provider_id`, `compliance_project_id`,
  `remediation_tasks` CHECK (`create`,`propose`), `timezone`, `evaluation_hour_local` (default 3),
  `evaluation_minute_offset` (derived from a hash of the org id, 0-59), `stale_after_hours` (36),
  `manual_expiry_warn_days` (30), `questionnaire_high_floor` (0.80), `questionnaire_medium_floor`
  (0.55), `max_llm_calls_per_compile` (400), `max_llm_calls_per_questionnaire` (1200),
  `max_rows_per_questionnaire` (1000), `auditor_room_max_days` (90), `max_packet_bytes`
  (2 GiB), `company_profile jsonb`, `updated_by`, `updated_at`.
- **`bastion_audit_log`**: `id`, `organization_id`, `actor_id`, `actor_kind`, `impersonator_id`,
  `action`, `subject_type`, `subject_id`, `details jsonb`, `created_at`. Append-only.

**Evaluation and evidence**

- **`bastion_evaluation_runs`**: `id`, `organization_id`, `trigger` CHECK
  (`nightly`,`manual`,`agent`), `scope` CHECK (`all`,`control`), `control_id`,
  `nightly_for_date date`, `as_of`, `status` CHECK (`queued`,`running`,`succeeded`,`partial`,
  `failed`), `partial_reason`, `controls_total`, `controls_done`, `pass_count`, `fail_count`,
  `unprovable_count`, `claimed_by`, `heartbeat_at`, `started_by`, timestamps. Partial uniques:
  `(organization_id) WHERE status IN ('queued','running') AND scope = 'all'`;
  `(organization_id, control_id) WHERE status IN ('queued','running') AND scope = 'control'`;
  `(organization_id, nightly_for_date) WHERE trigger = 'nightly'`.
- **`bastion_evidence_objects`**: `organization_id`, `content_sha256`, `object_key` (random),
  `size_bytes`, `content_type`, `created_at`, `bytes_redacted_at`. PK `(organization_id,
  content_sha256)`. Immutable except `bytes_redacted_at`.
- **`bastion_evidence_snapshots`**: `id`, `organization_id`, `evaluation_run_id`, `assertion_id`
  (RESTRICT), `control_id`, `outcome`, `unprovable_reason`, `probe_key`, `probe_version`,
  `params jsonb`, `query_fingerprint`, `population_checked jsonb`, `window_start`, `window_end`,
  `summary jsonb` (counts), `cited_refs jsonb` (`{entity_type, entity_id}` only, capped 200),
  `overflow_count`, `manual_evidence_ids uuid[]`, `exception_ids uuid[]`, `feed_record_count`,
  `content_sha256`, `personal_data_hmac`, `ledger_seq`, `created_at`. Immutable. Index
  `(organization_id, control_id, created_at DESC)`.
- **`bastion_manual_evidence`**: `id`, `organization_id`, `kind` CHECK
  (`file`,`attestation_statement`), `title`, `description`, `source_system`, `bin_asset_id`,
  `bin_asset_version_id`, `content_sha256`, `size_bytes`, `content_type`, `scan_label` CHECK
  (`clean`,`not_scanned`), `owner_user_id`, `uploaded_by`, `produced_on`, `period_start`,
  `period_end`, `valid_until timestamptz`, `sensitivity` CHECK (`standard`,`restricted`),
  `uploader_statement_at`, `status` CHECK (`pending_scan`,`active`,`superseded`,`withdrawn`,
  `blocked`), `blocked_reason`, `attempts`, `next_attempt_at`, `superseded_by_id`,
  `withdrawn_reason`, `withdrawn_by`, `withdrawn_at`, `redacted_at`, `personal_data_hmac`,
  `ledger_seq`, timestamps.
- **`bastion_manual_evidence_links`**: `id`, `organization_id`, `manual_evidence_id`,
  `assertion_id`, `review_verdict` CHECK (`pending`,`accepted`,`shows_exception`),
  `reviewed_by`, `reviewed_at`, `review_note`, `linked_by`, `linked_at`, `unlinked_at`. Unique
  `(organization_id, manual_evidence_id, assertion_id)`.
- **`bastion_evidence_feeds`**: `id`, `organization_id`, `feed_key` (slug), `label`, `feed_kind`,
  `source_kind` CHECK (`api_push`,`bolt_event`), `bolt_source`, `bolt_event_type`, `cadence_days`,
  `daily_record_quota`, `records_today`, `bytes_total`, `status`, `last_record_at`, timestamps.
  Unique `(organization_id, feed_key)`.
- **`bastion_feed_keys`**: `id`, `organization_id`, `feed_id`, `key_id` (public), `secret_hmac`,
  `fingerprint`, `last4`, `label`, `status` CHECK (`active`,`grace`,`revoked`),
  `grace_expires_at`, `predecessor_id`, `created_by`, `created_at`, `last_used_at`,
  `revoked_at`. Unique `key_id`.
- **`bastion_feed_records`**: `id`, `organization_id`, `feed_id`, `feed_key_id`,
  `idempotency_key`, `occurred_at`, `payload_sha256`, `personal_data_hmac`, `ledger_seq`,
  `received_at`. Unique `(organization_id, feed_id, idempotency_key)`. Immutable.
- **`bastion_personal_data`**: `id`, `organization_id`, `holder_kind` CHECK
  (`snapshot`,`manual_evidence`,`feed_record`,`attestation`,`exception`), `holder_id`, `data
  jsonb` (labels, emails, attributes; 16 KB CHECK), `data_hmac`, `redacted_at`, `redacted_by`,
  `redaction_reason`. Unique `(organization_id, holder_kind, holder_id)`. Mutable by design.
- **`bastion_ingest_events`**: durable inbox for `/internal/events` (`source`, `event_type`,
  `source_idempotency_key`, `payload`, `status`, `claimed_by`, `heartbeat_at`, `attempts`,
  `next_attempt_at`, timestamps). Unique `(organization_id, source_idempotency_key)`.
- **`bastion_outbox`**: `id`, `organization_id`, `kind` CHECK (`bolt_event`,`bam_task_upsert`,
  `bam_task_comment`), `idempotency_key`, `payload jsonb`, `status` CHECK
  (`pending`,`delivered`,`dead`), `attempts`, `next_attempt_at`, `last_error`, `claimed_by`,
  `heartbeat_at`, `delivered_at`, `created_at`. Unique `(organization_id, idempotency_key)`.
- **`bastion_ledger_entries`**: `organization_id`, `seq bigint`, `entry_kind` CHECK
  (`snapshot`,`manual_evidence`,`feed_record`,`attestation`,`exception`,`withdrawal`,
  `redaction`,`restore`), `entry_id`, `content_sha256`, `personal_data_hmac`, `prev_entry_hash`,
  `entry_hash`, `recorded_at`. PK `(organization_id, seq)`. Immutable.
- **`bastion_ledger_seals`**: `organization_id`, `seal_date date`, `head_seq`, `head_hash`,
  `signature`, `signing_key_id`, `published_at`, `created_at`. PK `(organization_id, seal_date)`.
  Content immutable; `published_at` mutable.

**Gaps, drift, fixes, exceptions**

- **`bastion_drift_events`**: `id`, `organization_id`, `control_id`, `evaluation_run_id`,
  `from_status`, `to_status`, `reason`, `snapshot_id`, `bam_task_id`, `task_status` CHECK
  (`pending`,`created`,`reopened`,`updated`,`no_project`,`proposed`), `proposal_id`,
  `acknowledged_by`, `acknowledged_at`, `detected_at`. Unique `(organization_id,
  evaluation_run_id, control_id)`.
- **`bastion_gaps`**: `id`, `organization_id`, `control_id`, `assertion_id`, `gap_kind` CHECK (the
  ten section 2.3 kinds), `risk_score numeric(8,4)`, `fix_template`, `fix_cost`, `status` CHECK
  (`open`,`proposed`,`resolved`,`dismissed`), `dismissed_reason`, `dismissed_by`, `computed_at`.
  Unique `(organization_id, control_id, assertion_id, gap_kind)`.
- **`bastion_fix_drafts`**: `id`, `organization_id`, `gap_id`, `template`, `title`,
  `body_markdown`, `payload jsonb` (Bolt rule shape id + params for `bolt_rule`),
  `cited_refs jsonb`, `dropped_citation_count`, `proposal_id`, `status` CHECK
  (`proposed`,`approved`,`rejected`,`expired`,`applied`,`decision_rejected`),
  `applied_entity_type`, `applied_entity_id`, `created_by`, `created_by_kind`, timestamps.
- **`bastion_exceptions`**: `id`, `organization_id`, `control_id`, `assertion_id`,
  `cited_entity_type`, `cited_entity_id`, `reason`, `compensating_note`, `proposal_id`, `status`
  CHECK (`proposed`,`active`,`expired`,`rejected`), `approved_by`, `approved_at`, `expires_at NOT
  NULL` (CHECK at most 365 days after creation), `personal_data_hmac`, `ledger_seq`, timestamps.
  Content immutable once `active`.

**Policies**

- **`bastion_policies`**: `id`, `organization_id`, `beacon_entry_id`, `title_cache`, `audience
  jsonb`, `cadence_days`, `owner_user_id`, `status` CHECK (`active`,`retired`), timestamps.
  Unique `(organization_id, beacon_entry_id)`.
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
- **`bastion_questionnaire_items`**: `id`, `organization_id`, `questionnaire_id`, `sheet_name`,
  `row_index`, `section`, `question_text` (4000), `answer_kind`, `draft_answer`, `draft_yes_no`,
  `final_answer`, `final_yes_no`, `cited_refs jsonb`, `dropped_citation_count`, `confidence`,
  `confidence_band`, `band_reasons jsonb`, `review_status` CHECK
  (`pending`,`accepted`,`edited`,`needs_owner`), `assigned_to`, `reviewed_by`, `reviewed_at`.
  Unique `(organization_id, questionnaire_id, sheet_name, row_index)`.
- **`bastion_answer_library`**: `id`, `organization_id`, `question_text`, `answer_text`, `yes_no`,
  `cited_refs jsonb`, `source_item_id`, `approved_by`, `approved_at`, `stale`, `stale_reason`,
  `retired_at`, `tsv` (generated, GIN).

**Sharing**

- **`bastion_auditor_rooms`**: `id`, `organization_id`, `framework_id`, `label`, `token_sha256`
  (unique), `token_hint`, `passcode_hash` (argon2, nullable), `passcode_failures`,
  `locked_at`, `period_start`, `period_end`, `control_ids uuid[]`, `restricted_evidence_ids
  uuid[]` (frozen allowlist; empty = none), `expires_at NOT NULL`, `revoked_at`, `created_by`,
  `last_accessed_at`, `access_count`, timestamps. CHECK `expires_at <= created_at + interval '180
  days'`.
- **`bastion_auditor_access_log`**: `id`, `organization_id`, `room_id`, `accessed_at`,
  `view_kind`, `object_ref`, `ip_hash`, `user_agent_trunc`. Append-only: UPDATE and TRUNCATE
  rejected; DELETE rejected **unless** the transaction-local GUC `bastion.purge_access_log = 'on'`
  is set and `accessed_at < now() - interval '2 years'`. Only the `SECURITY DEFINER` function
  `bastion_purge_access_log(org uuid)` sets that GUC; the retention engine calls it. This choice
  is stated in the `0266` header before the file runs anywhere.
- **`bastion_auditor_requests`**: `id`, `organization_id`, `room_id`, `control_id`,
  `requester_name`, `body` (5000), `status` CHECK (`open`,`answered`,`closed`), `answered_by`,
  `answer_note`, timestamps.
- **`bastion_export_packets`**: `id`, `organization_id`, `framework_id`, `period_start`,
  `period_end`, `include_restricted`, `status`, `stage`, `stage_progress`, `object_key`,
  `content_sha256`, `size_bytes`, `requested_by`, `claimed_by`, `heartbeat_at`, `error`,
  timestamps.

**Count:** 33 `bastion_` tables, plus Bam-owned `github_pr_events` and one added column on
`github_integrations` (section 8.4).

**Volume.** The high-volume tables are `bastion_evidence_snapshots` (assertions x nights, about
55,000 rows per org per year at 150 assertions), `bastion_ledger_entries` (snapshots plus feed
records), and `bastion_feed_records` (bounded by the per-feed quota). v1 does not partition;
the `0263` header records that monthly `created_at` partitioning becomes mandatory when any of the
three passes 50 million rows platform-wide (the `activity_log` precedent).

### 4.2 Reused platform tables (read-only unless noted)

`users`, `organizations`, `organization_memberships`, `sessions`, `login_history`, `api_keys`,
`agent_policies`, `agent_proposals` (insert + read), `entity_links` (insert), `superuser_audit_log`,
`platform_backups`, `platform_restores`, `v_activity_unified`, `github_integrations`, `phases`,
`beacon_entries`, `beacon_versions`, `blip_tracked_apps`, `blip_retention_policies`,
`bolt_automations`, `bolt_executions`, `bin_assets`, `bin_asset_versions`, `bursar_vendors`,
`bursar_awards`, `bond_deals`, `bond_companies`, `llm_providers` (via the internal proxy).

### 4.3 RLS posture

Policies are generated by a `DO $$` loop over `information_schema.tables` for `bastion\_%`, as
`infra/postgres/migrations/0251_bursar_rls.sql:20-50`. No variant policy is needed (no global
rows). Public routes resolve the org from the room token in one lookup, then work inside
`runInOrgScope(resolvedOrgId, ...)`. Probes run through `SECURITY DEFINER` functions (section
3.1) precisely because they read other apps' tables whose RLS would otherwise hide the rows they
must count. bastion-api adopts Bursar's transaction-scoped binding
(`apps/bursar-api/src/plugins/rls.ts:58-68`) and reports posture at boot. Every query carries an
explicit `organization_id` predicate. `test/rls-coverage.test.ts` asserts every `bastion_%` table
has a policy.

### 4.4 Migration plan

Anchor: **current tip + 1, observed at authoring time** (tip today:
`0259_bursar_builtin_group_defaults.sql`). Re-run `ls infra/postgres/migrations/*.sql | tail -3`
after any rebase.

| # | File | Contents |
| --- | --- | --- |
| 0260 | `0260_bolt_trigger_source_values.sql` | **Platform fix for issue #124.** `ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS ...` for every value in the new shared `BOLT_SOURCES` list missing from the enum at authoring (at least `'bursar'` and `'bastion'`; the `0121` pattern) |
| 0261 | `0261_github_pr_events.sql` | **Bam-owned.** Append-only `github_pr_events` and `ALTER TABLE github_integrations ADD COLUMN IF NOT EXISTS subscribed_events text[]` |
| 0262 | `0262_bastion_core.sql` | frameworks, controls (+ tsvector), control requirements, assertions (+ confirmed-content trigger), compile runs, org settings, audit log; the **Bastion System** sentinel user `00000000-0000-0000-0000-0000000000b5` (`kind = 'service'`, `password_hash = '!'`, both `ON CONFLICT` inserts as `0234_bulwark_core.sql:297-327`) |
| 0263 | `0263_bastion_evidence.sql` | evaluation runs (+ three partial uniques), objects, snapshots, manual evidence, links, feeds, feed keys, feed records, personal data, ingest events, outbox, ledger entries, ledger seals; immutability triggers; partitioning threshold note |
| 0264 | `0264_bastion_gaps_policies.sql` | drift events, gaps, fix drafts, exceptions, policies, attestations; immutability triggers |
| 0265 | `0265_bastion_questionnaires.sql` | questionnaires, items, answer library |
| 0266 | `0266_bastion_sharing.sql` | auditor rooms, access log (+ guarded DELETE trigger and `bastion_purge_access_log`), auditor requests, export packets |
| 0267 | `0267_bastion_probe_functions.sql` | the `SECURITY DEFINER` probe functions, version 1 |
| 0268 | `0268_bastion_rls.sql` | the generated RLS loop |
| M10 | `<observed>_permissions_seed_actions_delta_025.sql` | emitted by `scripts/build-permission-delta.mjs`; number observed, never chosen |
| M10 | `<observed + 1>_bastion_builtin_group_defaults.sql` | authored only after the delta is applied |

Eleven migration files. Every file carries the header block (filename marker, `-- Why:`,
`-- Client impact: additive only`), `IF NOT EXISTS` forms, `DROP TRIGGER IF EXISTS` before each
trigger, `DROP POLICY IF EXISTS` before each policy, `CREATE OR REPLACE FUNCTION` for functions.
No destructive ALTERs.

### 4.5 The permission procedure (M10, never earlier)

Bastion's rows go in the `HAND_AUTHORED` array in `scripts/generate-permission-manifest.mjs`
(line 719; satellites are not in `APP_TO_PREFIX`, per lines 861-880).

```sh
node scripts/generate-permission-manifest.mjs
node scripts/build-permission-codegen.mjs
node scripts/build-permission-delta.mjs             # OBSERVE the number it assigns
node scripts/check-permission-catalog.mjs
docker compose run --rm migrate
# ONLY NOW author <observed + 1>_bastion_builtin_group_defaults.sql
docker compose run --rm migrate
```

Authoring the group-defaults file first makes it run first, match zero rows, succeed, get
checksummed, and never re-run (`0259` header records two occurrences).

**Interim posture M1-M9:** `bastion.*` actions do not exist, so with the fail-closed boot
invariant every `/bastion` route denies non-SuperUsers. Development and Playwright run **only as
Skipper** (seeded SuperUser) before M10; member and viewer stories are M10 gates.

### 4.6 The probe is the gate

```sql
SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
FROM permission_group_defaults d
JOIN permissions p ON p.id = d.permission_id
JOIN permission_groups pg ON pg.id = d.group_id
WHERE p.app = 'bastion' GROUP BY 1;
```

The CI assertion parses section 5.5 and recomputes. Sanity target only: `owner = admin = 48`,
`member = 24`, `viewer = 10`, `guest = 0`. **If this line disagrees with the table, the table
wins.**

---

## 5. API surface, MCP tools, permissions

Base path `/bastion/api/v1/...`, mounted under `/v1` (`apps/bursar-api/src/server.ts:146-172`).
Cursor pagination (`{ data, meta: { next_cursor, has_more } }`), `?filter[field]=`, `?sort=`,
the platform error envelope, `updated_at` stale checks with 409. Long operations return **202 +
run id** and are polled. Lists of controls, gaps, and the summary accept `?framework_id=`.

### 5.1 REST endpoints

| # | Method and path | Permission | MCP tool |
| --- | --- | --- | --- |
| 1 | `GET /library/templates` | `framework.read` | skip: static catalog, included in `bastion_list_frameworks` |
| 2 | `GET /frameworks` | `framework.read` | `bastion_list_frameworks` |
| 3 | `POST /frameworks` (adopt; crosswalk merges into existing controls) | `framework.write` | skip: setup is a human act |
| 4 | `GET /frameworks/:id` | `framework.read` | `bastion_list_frameworks` |
| 5 | `PATCH /frameworks/:id` | `framework.write` | skip: human admin |
| 6 | `POST /frameworks/:id/archive` (confirm) | `framework.write` | skip: destructive human act |
| 7 | `GET /frameworks/:id/requirements` | `framework.read` | `bastion_list_frameworks` |
| 8 | `POST /frameworks/:id/compile` (202) | `framework.compile` | `bastion_compile_framework` |
| 9 | `GET /frameworks/:id/compile-runs` | `framework.read` | `bastion_compile_framework` |
| 10 | `GET /controls` | `control.read` | `bastion_list_controls` |
| 11 | `POST /controls` (custom control) | `control.write` | skip: human admin |
| 12 | `GET /controls/:id` | `control.read` | `bastion_control_status` |
| 13 | `PATCH /controls/:id` (owner, applicability, summary, requirement links) | `control.write` | skip: human admin |
| 14 | `GET /controls/:id/assertions` | `control.read` | `bastion_control_status` |
| 15 | `POST /controls/:id/assertions` (lands `proposed`) | `assertion.propose` | `bastion_propose_assertion` |
| 16 | `POST /assertions/:id/confirm` | `assertion.confirm` | skip: the human confirmation gate |
| 17 | `POST /assertions/:id/reject` | `assertion.confirm` | skip: human gate |
| 18 | `POST /assertions/:id/revise` | `assertion.propose` | `bastion_propose_assertion` |
| 19 | `GET /probes` | `control.read` | `bastion_list_probes` |
| 20 | `POST /evaluations` (202) | `evaluation.run` | `bastion_run_evaluation` |
| 21 | `GET /evaluations` | `control.read` | `bastion_list_evaluations` |
| 22 | `GET /evaluations/:id` | `control.read` | `bastion_list_evaluations` |
| 23 | `GET /controls/:id/evidence` | `evidence.read` | `bastion_evidence_for` |
| 24 | `GET /evidence/:id` | `evidence.read` (labels need `read_detail` or ownership) | `bastion_get_evidence` |
| 25 | `GET /evidence/:id/verify` | `evidence.read` | `bastion_verify_evidence` |
| 26 | `GET /evidence/:id/download` | `evidence.read_detail` | skip: binary download |
| 27 | `GET /ledger/seals` (signed heads + public key) | `evidence.read` | skip: verification material for auditors and the packet |
| 28 | `POST /manual-evidence` | `evidence.upload` | skip: a human attests to provenance |
| 29 | `GET /manual-evidence` (restricted titles hidden without `read_restricted`) | `evidence.read` | `bastion_list_manual_evidence` |
| 30 | `GET /manual-evidence/:id` | `evidence.read` (+ `read_restricted`) | `bastion_list_manual_evidence` |
| 31 | `GET /manual-evidence/:id/download` | `evidence.read_detail` (+ `read_restricted`) | skip: binary download |
| 32 | `POST /manual-evidence/:id/links` | `evidence.link` | skip: human curation |
| 33 | `DELETE /manual-evidence/:id/links/:assertion_id` (sets `unlinked_at`) | `evidence.link` | skip: human curation |
| 34 | `POST /manual-evidence/:id/links/:assertion_id/review` | `evidence.review` | skip: human adjudication |
| 35 | `POST /manual-evidence/:id/withdraw` (confirm) | `evidence.withdraw` | skip: destructive human act |
| 36 | `POST /manual-evidence/:id/supersede` | `evidence.upload` | skip: human attests |
| 37 | `POST /personal-data/:id/redact` (confirm, owner only) | `evidence.redact` | skip: destructive human act |
| 38 | `GET /feeds` | `feed.read` | skip: admin configuration surface |
| 39 | `POST /feeds` | `feed.manage` | skip: admin configuration |
| 40 | `PATCH /feeds/:id` | `feed.manage` | skip: admin configuration |
| 41 | `GET /feeds/:id/keys` | `feed.manage` | skip: credential admin |
| 42 | `POST /feeds/:id/keys` (token shown once) | `feed.manage` | skip: credential admin |
| 43 | `POST /feed-keys/:id/revoke` | `feed.manage` | skip: credential admin |
| 44 | `POST /feeds/:feed_key/records` | per-feed key | skip: machine ingest path with its own credential |
| 45 | `GET /feeds/:id/records` | `feed.read` | skip: admin inspection |
| 46 | `GET /coverage` | `control.read` | `bastion_coverage_summary` |
| 47 | `GET /gaps` | `gap.read` | `bastion_coverage_gaps` |
| 48 | `POST /gaps/:id/propose-fix` | `fix.draft` | `bastion_propose_fix` |
| 49 | `POST /gaps/:id/dismiss` | `gap.dismiss` | skip: human adjudication |
| 50 | `GET /fix-drafts` | `fix.read` | skip: read via `proposal_list` |
| 51 | `GET /fix-drafts/:id` | `fix.read` | skip: read via `proposal_list` |
| 52 | `POST /fix-drafts/:id/mark-applied` | `fix.mark_applied` | skip: records a human's action in another app |
| 53 | `GET /exceptions` | `exception.read` | `bastion_list_exceptions` |
| 54 | `GET /exceptions/:id` | `exception.read` | `bastion_list_exceptions` |
| 55 | `POST /exceptions` (files a proposal) | `exception.propose` | `bastion_propose_exception` |
| 56 | `GET /drift` | `drift.read` | `bastion_list_drift` |
| 57 | `POST /drift/:id/acknowledge` | `drift.acknowledge` | skip: human acknowledgement |
| 58 | `GET /policies` | `policy.read` | skip: covered by `bastion_attestation_status` |
| 59 | `POST /policies` (link a Beacon article; 422 unless org-visible) | `policy.write` | skip: human admin |
| 60 | `PATCH /policies/:id` | `policy.write` | skip: human admin |
| 61 | `GET /policies/:id/body` (the hashed version body) | `attestation.read` | skip: UI reading surface |
| 62 | `GET /policies/:id/attestations` | `attestation.read` | `bastion_attestation_status` |
| 63 | `GET /me/attestations` (caller-scoped in the service layer) | `attestation.read` | skip: personal UI list |
| 64 | `POST /policies/:id/attest` | `attestation.sign` | skip: humans only, never agents |
| 65 | `POST /policies/:id/request-attestations` | `attestation.request` | skip: human admin nudge |
| 66 | `GET /questionnaires` | `questionnaire.read` | `bastion_list_questionnaires` |
| 67 | `POST /questionnaires` (from Bin asset) | `questionnaire.write` | skip: file intake is a human act |
| 68 | `GET /questionnaires/:id` | `questionnaire.read` | `bastion_get_questionnaire` |
| 69 | `PATCH /questionnaires/:id` | `questionnaire.write` | skip: human mapping |
| 70 | `POST /questionnaires/:id/autofill` (202) | `questionnaire.write` | `bastion_questionnaire_autofill` |
| 71 | `GET /questionnaires/:id/items` | `questionnaire.read` | `bastion_get_questionnaire` |
| 72 | `PATCH /questionnaire-items/:id` | `questionnaire.write` | skip: human review |
| 73 | `POST /questionnaires/:id/approve` (confirm) | `questionnaire.approve` | skip: the human release gate |
| 74 | `GET /questionnaires/:id/export` | `questionnaire.export` | skip: binary download after approval |
| 75 | `POST /answers/draft` | `questionnaire.write` | `bastion_draft_answer` |
| 76 | `GET /answer-library` | `answer_library.read` | `bastion_search_answer_library` |
| 77 | `PATCH /answer-library/:id` | `answer_library.write` | skip: human curation |
| 78 | `GET /auditor-rooms` | `auditor_room.read` | skip: floored sharing admin |
| 79 | `POST /auditor-rooms` (token shown once; confirm) | `auditor_room.create` | skip: disclosure is a human act |
| 80 | `POST /auditor-rooms/:id/revoke` (confirm) | `auditor_room.revoke` | skip: human act |
| 81 | `GET /auditor-rooms/:id/access-log` | `auditor_room.read` | skip: floored |
| 82 | `GET /auditor-requests` | `auditor_room.read` | skip: floored |
| 83 | `PATCH /auditor-requests/:id` | `auditor_room.respond` | skip: floored human response |
| 84 | `POST /exports` (202) | `export.create` | skip: produces a binary packet |
| 85 | `GET /exports` | `export.read` | skip: floored |
| 86 | `GET /exports/:id/download` | `export.read` | skip: binary download |
| 87 | `GET /summary` | `control.read` | `bastion_coverage_summary` |
| 88 | `GET /search?q=` | `control.read` | skip: consumed by `search_everything` |
| 89 | `GET /settings` | `settings.read` | skip: admin |
| 90 | `PATCH /settings` | `settings.write` | skip: admin |
| 91 | `GET /audit` | `audit.read` | skip: floored |
| 92 | `GET /public/room` (header `X-Bastion-Room-Token`, optional passcode header) | token | skip: public token-gated |
| 93 | `GET /public/room/controls/:id` | token | skip: public |
| 94 | `GET /public/room/evidence/:id` (+ `?download=1`) | token | skip: public |
| 95 | `POST /public/room/requests` | token | skip: public |
| 96 | `POST /internal/events` | internal secret, internal network only | skip: service-to-service |
| 97 | `POST /internal/engines/:name` | internal secret, internal network only | skip: service-to-service |
| 98 | `GET /health`, `GET /health/ready`, `GET /metrics` | none | skip: health |

**Count:** 97 REST endpoints in rows 1-97, plus the three health routes. 34 rows map to an MCP
tool; 63 are intentional skips.

**Byte responses.** Every Bastion byte stream (rows 26, 31, 74, 86, 94 download) sends
`Content-Disposition: attachment`, `Content-Security-Policy: sandbox; default-src 'none'`,
`X-Content-Type-Options: nosniff`, and a content type from an allowlist (`application/pdf`,
`text/csv`, `image/png`, `image/jpeg`, `text/plain`, `application/json`,
`application/zip`, the xlsx type); anything else is `application/octet-stream`.

### 5.2 The auditor room (public)

| Bay today | Bastion | Why |
| --- | --- | --- |
| token in URL path | token in URL **fragment** (`/bastion/room#<token>`), sent as header `X-Bastion-Room-Token` | fragments never reach access logs or `Referer` |
| plaintext token (issue #122) | `token_sha256`, shown once | a DB read yields no working links |
| optional expiry | mandatory, default 30 days, ceiling `auditor_room_max_days` (max 180) | disclosure must lapse |
| none | optional 6-digit passcode (argon2) with a **per-room** failure counter: 5 misses lock the room and notify the creator | the passcode is the guessable part |
| per-route limit by socket IP | Fastify `trustProxy` set to `TRUST_PROXY_HOPS` (compose 1, Railway 2), 120 req/min per resolved client IP, per-IP failed-token counter (10 misses per 10 min, 15-min lockout) | the socket IP is nginx; a naive `trustProxy: true` trusts a spoofable left-most `X-Forwarded-For` |
| 404 for missing or revoked | 404 for missing, revoked, expired, or locked | existence is not confirmable |

Additional rules: every room request re-checks that the creator still holds
`auditor_room.create` (else 404); restricted evidence is exposed only through the frozen
`restricted_evidence_ids` allowlist chosen at creation, never by category; every `:id` in rows
93-94 must belong to the room's controls and period, not merely the org; cited refs are filtered
through `can_access` with the creator as asker; files stream through bastion-api with the section
5.1 headers. Every view writes `bastion_auditor_access_log`. The room shows the signed seal
history. Evidence requests are bounded (20 per hour per room).

### 5.3 Realtime: none in v1, by decision

No `/bastion/ws`. Long operations are run rows the SPA polls every 3 seconds while running.
Bursar's SPA opens `/bursar/ws` but bursar-api serves no WebSocket (issue #121), so it already
runs on polling; Bastion starts there deliberately.

### 5.4 MCP tools

`apps/mcp-server/src/tools/bastion-tools.ts`, client shaped like `createBursarClient`
(`bursar-tools.ts:55-80`), registered in `apps/mcp-server/src/server.ts`, env `BASTION_API_URL`
(ends in `/v1`). **Every tool declares a top-level `returns:` schema**, as
`scripts/check-tool-return-coverage.mjs` requires.

| # | Tool | Backing rows | Notes |
| --- | --- | --- | --- |
| 1 | `bastion_list_frameworks` | 2, 4, 7 | templates and requirement links |
| 2 | `bastion_list_controls` | 10 | filters: status, coverage kind, owner, framework |
| 3 | `bastion_control_status` | 12, 14 | effective status, counts-only explanation unless detail allowed |
| 4 | `bastion_evidence_for` | 23 | |
| 5 | `bastion_get_evidence` | 24 | |
| 6 | `bastion_verify_evidence` | 25 | |
| 7 | `bastion_coverage_summary` | 46, 87 | four numbers + setup progress |
| 8 | `bastion_coverage_gaps` | 47 | |
| 9 | `bastion_propose_fix` | 48 | files an `agent_proposals` row |
| 10 | `bastion_compile_framework` | 8, 9 | proposals only |
| 11 | `bastion_propose_assertion` | 15, 18 | lands `proposed` |
| 12 | `bastion_run_evaluation` | 20 | rate-limited |
| 13 | `bastion_list_evaluations` | 21, 22 | |
| 14 | `bastion_list_drift` | 56 | |
| 15 | `bastion_list_probes` | 19 | the closed menu |
| 16 | `bastion_attestation_status` | 62 | |
| 17 | `bastion_list_questionnaires` | 66 | |
| 18 | `bastion_get_questionnaire` | 68, 71 | |
| 19 | `bastion_questionnaire_autofill` | 70 | drafts only |
| 20 | `bastion_draft_answer` | 75 | |
| 21 | `bastion_list_manual_evidence` | 29, 30 | |
| 22 | `bastion_search_answer_library` | 76 | |
| 23 | `bastion_list_exceptions` | 53, 54 | |
| 24 | `bastion_propose_exception` | 55 | files an `agent_proposals` row |

**24 tools.** Tools surfacing evidence detail, restricted evidence, or questionnaire content take
`asker_user_id` and apply the intersection rule. No tool needs `confirm_action`, because every
destructive or disclosing action has no tool. The module header carries the "do not complete the
surface" warning (`bursar-tools.ts:40-48`).

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
| `bastion.evidence.redact` | | yes | | yes | yes |
| `bastion.feed.read` | yes | | | | |
| `bastion.feed.manage` | | yes | | | |
| `bastion.gap.read` | yes | | yes | | |
| `bastion.gap.dismiss` | | yes | | | |
| `bastion.fix.read` | yes | | | | |
| `bastion.fix.draft` | | | | | |
| `bastion.fix.mark_applied` | | | | | |
| `bastion.exception.read` | yes | | yes | | |
| `bastion.exception.propose` | | | | | |
| `bastion.exception.approve` | | yes | | | yes |
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
| `bastion.auditor_room.respond` | | yes | | | |
| `bastion.export.create` | | yes | | | |
| `bastion.export.read` | yes | yes | | | |
| `bastion.settings.read` | yes | | yes | | |
| `bastion.settings.write` | | yes | | | |
| `bastion.audit.read` | yes | yes | | | |

**Group grants:** `owner` and `admin` every row; `member` every row not floored; `viewer` the rows
marked `viewer` (nine reads plus `attestation.sign`); `guest` none. `evidence.redact` is
additionally restricted to the `owner` role in the service layer. `exception.approve` is the
permission Bastion checks on the human decider when reconciling an exception proposal (section
2.8); `exception.read` lets a viewer see why a control shows "accepted exception". `is_read` is set
only on actions that change nothing, because `packages/permissions/src/resolver.ts:204` lets a
`read`-scoped API key through any `is_read` action.

**Control owner exception (service rule):** a member who owns a control may read evidence detail
for that control and review evidence linked to it.

**Enforcement posture:** the hardcoded fail-closed boot invariant
(`apps/bursar-api/src/boot/assert-permissions-enforce.ts:34-47`, asserted at
`apps/bursar-api/src/server.ts:47-52`): `BASTION_PERMISSIONS_MODE = 'on'`,
`BASTION_PERMISSIONS_ON_UNKNOWN = 'deny'`, not env-configurable (burn issue #83).

---

## 6. Frontend and help

`apps/bastion/`: React 19, TanStack Query v5, Zustand, Tailwind v4, Radix, Motion. Structure
copied from `apps/bursar/src/` (path router with `BASE_PATH = '/bastion'`, layout, sidebar,
`lib/api.ts`, `hooks/use-bastion.ts`, `stores/auth.store.ts`). `vite.config.ts` sets `base:
'/bastion/'` and copies **every** `@bigbluebam/ui/*` alias from `apps/bursar/vite.config.ts:18-43`;
dev port 3024.

### 6.1 Pages

| Route | Page | What it shows |
| --- | --- | --- |
| `/bastion/` | **Readiness** | The four numbers (section 2.3), a framework picker, the **Setup** progress bar, days to audit, top five gaps with **Draft the fix**, last-checked time, and banners: no compliance project; checks are stale; scanning is off. |
| `/bastion/setup` | **Setup wizard** | Pick frameworks (plain descriptions), the ten-question profile, **choose or create the Compliance project** (required), compile, then **Review proposed checks** including each population ("These 6 repositories will be checked; add any we missed"). |
| `/bastion/controls` | **Controls** | Grouped by plain category; status words; framework codes as small chips (one control may show "CC6.2 · A.5.18"). |
| `/bastion/controls/:id` | **Control detail** | Plain explanation; how we check this; evidence timeline; accepted exceptions; what would fix this; linked evidence with expiry; the Bam task; **Check now**; **Accept this as an exception** (files a proposal). |
| `/bastion/coverage` | **Evidence map** | Controls by source column (Suite, Feeds, Uploads, Self-attested, Nothing). |
| `/bastion/gaps` | **What to fix first** | Ranked list, "Quick wins" toggle, proposal status. |
| `/bastion/evidence` | **Evidence locker** | Uploads, statements, feeds and their keys, owners, periods, expiry, review state, scan labels. |
| `/bastion/policies` | **Policies** | Linked articles and attestation coverage. |
| `/bastion/attest` | **Policies to read** | Personal list; the body rendered from row 61; **I have read and understood this**. |
| `/bastion/questionnaires` and `/:id` | **Questionnaires** | Upload, mapping, progress, answer grid ("Sure", "Check this", "Needs an expert"), **Approve**, **Download answers**. |
| `/bastion/review` | **Review queue** | Proposed checks, evidence awaiting review, stuck scans, fix and exception proposals, low-confidence answers, auditor requests. |
| `/bastion/sharing` | **Sharing** | Auditor rooms (create with preview, revoke, access log), audit packets. |
| `/bastion/settings` | **Settings** | Compliance project, remediation mode, check time and timezone, AI provider, expiry warnings, limits, feed storage. |
| `/bastion/room` | **Auditor room** (public) | Rendered before the auth gate, like `apps/bay/src/app.tsx:31,98`. |

### 6.2 Plain-language rules

- No raw UUIDs, hashes, probe keys, object keys, or SQL on any default view. A **Technical
  details** disclosure shows probe name, query fingerprint, and content hash (never an object key).
- Every status has a one-sentence reason (section 3.2); explanations are counts-only unless the
  viewer may see detail.
- Dates render in the viewer's timezone with relative text; expiry uses `endOfDayInTz`.
- Empty states teach what to do next.

### 6.3 State and shared components

TanStack Query keys per resource, optimistic updates with rollback for review actions,
`refetchInterval` polling on run rows only while running. Zustand: `auth.store.ts` and a small
`ui.store.ts`. `@bigbluebam/ui`: `launchpad`, `org-switcher`, `notifications-bell`, `help-center`
(`<HelpTrigger app="bastion" />`), `user-menu`, `sidebar-footer`, `impersonation-banner`
(attest and approve buttons are disabled with an explanation while impersonating),
`permissions-context` and `use-can`. The Launchpad icon (`castle`) is added in the last milestone
(section 12).

### 6.4 Help

`docs/apps/bastion/help.md`, `guide.md`, generated `help-index.json` (`build-help-index.mjs
--check`), `meta.json`, and screenshots from `packages/docs-capture/recipes/bastion/bastion.yaml`
(GILLIGAN only) with numbered filenames (`01-readiness.png`, ...) as the docs-capture bridge
writes them, also copied to `site/public/screenshots/bastion/`.

---

## 7. Background work

Engine logic lives in bastion-api, except the audit packet (worker). Jobs are registered in
`apps/worker/src/worker.ts` with a `registerBastionSweep` helper copied from
`registerBursarSweep` (`worker.ts:2605-2625`), which wraps every scheduler template in
`withRetention` and passes **`tz: 'UTC'`** to every `upsertJobScheduler`. Every producer
`Queue.add` (in bastion-api and in the worker's follow-on slices) passes `jobId = <run id or row
id>` plus `SCHEDULED_JOB_RETENTION` (`apps/worker/src/lib/job-retention.ts:12`). A unit test scans
for bare `upsertJobScheduler` and bare `add` calls in Bastion code. Queue names and job data types
live in `packages/shared/src/schemas/bastion.ts`, following Bursar's location
(`packages/shared/src/schemas/bursar.ts`). `apps/worker/src/jobs/bastion-shared.ts` resolves
`BASTION_API_INTERNAL_URL` and **throws when it is unset** (no compose-hostname fallback).

| Job | Schedule | Does |
| --- | --- | --- |
| `bastion-evaluate-tick` | `*/5 * * * *` | claims due nightly runs only (org local time reached at `evaluation_hour_local:evaluation_minute_offset`, first tick at or after it, `nightly_for_date` unique) and enqueues them; does no evaluation work |
| `bastion-evaluate-run` | event, `jobId = run.id`, concurrency 4 | drives a run with the `bursar-level.job.ts` loop (MAX_POLLS cap, 409 ends the attempt, 429 throws); each engine call runs one time-budgeted slice |
| `bastion-compile` | event, `jobId = run.id` | async-start LLM slices (section 7.3) |
| `bastion-questionnaire-autofill` | event, `jobId = questionnaire.id + attempt` | async-start LLM slices |
| `bastion-evidence-ingest` | event + `*/10 * * * *` | works rows by `next_attempt_at` with capped backoff (section 3.3); failures recorded via `recordWorkerError` |
| `bastion-outbox-drain` | `* * * * *` | delivers Bolt events and Bam task upserts/comments with backoff 30 s to 6 h, idempotency keys, then `dead` with a worker error |
| `bastion-gap-rank` | after each run + `30 6 * * *` | recomputes `bastion_gaps` |
| `bastion-evidence-expiry` | `10 6 * * *` | expiring and expired manual evidence and exceptions; enqueues control-scope runs |
| `bastion-attestation-nudge` | `0 14 * * *` | due attestations -> notifications + `attestation.overdue` |
| `bastion-proposal-reconcile` | `*/15 * * * *` | re-verifies decided proposals (section 2.8) |
| `bastion-ledger-seal` | `55 23 * * *` | writes signed seals + outbox rows; detects restores |
| `bastion-ledger-verify` | `40 4 * * 0` | budgeted re-hash with resume cursor |
| `bastion-evaluation-missed` | `0 * * * *` | orgs with no completed nightly run in 26 h -> `recordWorkerError` + `evaluation.missed` |
| `bastion-object-sweep` | `15 4 * * *` | deletes only objects older than 24 h with no DB row, re-checking the row and `stat` inside the loop, with progress logging |
| `bastion-object-backup` | `30 2 * * *` | mirrors new Bastion bucket objects to the backup destination (section 9.7) |
| `bastion-run-reaper` | `*/5 * * * *` | reverts runs past the lease to `partial`, unwedging frameworks (`compiling -> active`) and questionnaires (`answering -> mapping`) |
| `bastion-weekly-readiness` | `0 13 * * 1` | `readiness.weekly` via the outbox |
| `bastion-retention` | `20 5 * * *` | prunes processed ingest events and delivered outbox rows older than 30 days; calls `bastion_purge_access_log` per org; never touches evidence tables |
| `bastion-export-packet` | event, `jobId = packet.id` | builds the audit packet in the worker (section 7.2) |

**19 jobs.**

### 7.1 Progress logging (required)

Every long job logs before its first slow step and at each slice, with elapsed time, through
`@bigbluebam/logging`; the same counters are written to the run row so the UI and logs agree.

- evaluator: `bastion-evaluate: org 'Gilligan Travel Ltd' controls 31/64 assertions 75/150 (pass
  61, fail 6, unprovable 8) slice_ms=14200 elapsed_ms=48200`;
- compile: `bastion-compile: framework 'SOC 2' controls 30/64 proposed 51 dropped 2 llm_calls 30
  fallback=false`;
- autofill: `bastion-autofill: questionnaire 'Howell Industries Vendor Security Review' rows 40/96
  (high 22, medium 11, low 7)`, plus "throttled by the AI provider, resuming in 30 s" on 429;
- export: one line per stage (`collecting controls`, `writing evidence 120/412`, `rendering
  summary`, `zipping`, `uploading`);
- sweeps, verify, backup: `checked n/N`, budget remaining.

### 7.2 The audit packet

Built **in the worker** as one long job with its own lease and heartbeat (not through the engine
route). Streamed: `jszip.generateNodeStream({ streamFiles: true })` piped into
`@bigbluebam/storage` `put(key, stream)` (the S3 driver does a multipart upload when size is
unknown). Each content-addressed object is written once and referenced from the manifest.
Contents: `manifest.json` (every file's SHA-256, the signed seal history, the period),
`controls.csv`/`.jsonl` (with framework requirement codes), `evidence/<sha256>.json`, selected
manual evidence (restricted only from the allowlist), `attestations.csv`, `exceptions.csv`,
`drift.csv`, and `summary.pdf` (`pdf-lib`, rendered page by page and streamed). Packets over
`max_packet_bytes` or a period over 400 days are rejected up front with a plain message. Stage
progress checkpoints to `bastion_export_packets`. Stored in Bastion's bucket under a random key
and served with the section 5.1 headers.

### 7.3 Time budgets (the invariants a unit test enforces)

| Quantity | Value | Rule |
| --- | --- | --- |
| `BASTION_PROBE_TIMEOUT_MS` | 8,000 | per probe statement |
| Probe slice budget | stop starting probes at 15 s elapsed | worst case 15 + 8 = 23 s |
| `BASTION_ENGINE_TIMEOUT_MS` | 30,000 | > worst probe slice |
| LLM slices (compile, autofill) | **async-start**: the engine call returns 202 at once; the slice runs in bastion-api, stops starting LLM calls after 150 s, heartbeats after every call | worst case 150 + 60 = 210 s |
| Run lease | 300,000 | > worst LLM slice; heartbeat after every probe and every LLM call |

`probe slice < engine timeout < lease` and `LLM slice < lease` are asserted in
`test/time-budgets.test.ts`. Slices are **partitioned by control**: a slice takes whole controls
until the budget is reached, so a control's assertions are never split across slices.

**Status writes are conditional:** `UPDATE bastion_controls SET status = $s, last_evaluated_at =
$as_of ... WHERE id = $c AND organization_id = $o AND (last_evaluated_at IS NULL OR
last_evaluated_at < $as_of) RETURNING (old status via a CTE)`. Drift is emitted only when this
update changed the row. All run-row writes are fenced `WHERE id = $run AND claimed_by = $me AND
status = 'running'`; a zero-row update aborts the slice.

**LLM fairness.** The proxy caps calls per calling service (`apps/api/src/env.ts:115-116`: 4
concurrent, 120 per minute). bastion-api holds a Redis per-org semaphore (1 concurrent LLM call
per org) and a service-wide semaphore of 3, so one org's 1,200-call questionnaire cannot starve
others. Expected throughput: about 100 LLM calls per minute for the whole service, so a 96-row
questionnaire finishes in about 2-4 minutes when the proxy is idle.

---

## 8. Events and integration

### 8.1 Published (source `bastion`)

All via `publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)`
(`packages/shared/src/bolt-events.ts`, positional), bare event names, source `'bastion'`, every
pair registered in a `bastionEvents` array in `apps/bolt-api/src/services/event-catalog.ts`.
Bastion publishes **only through the outbox drainer**, never inline. Payloads carry refs and
scalars only.

| Event | Fired when | Key payload fields |
| --- | --- | --- |
| `framework.adopted` | a framework is adopted | `framework.id`, `controls.created`, `requirements.linked` |
| `assertions.compiled` | a compile run finishes | `framework.id`, `proposed.count`, `dropped.count`, `used_fallback` |
| `evaluation.completed` | a run finishes | `run.id`, `pass.count`, `fail.count`, `unprovable.count`, `partial_reason` |
| `evaluation.missed` | no nightly run in 26 h | `last_completed_at` |
| `control.drifted` | a control worsens | `control.id`, `from_status`, `to_status`, `reason`, `owner.id` |
| `control.recovered` | returns to pass | `control.id`, `from_status` |
| `evidence.uploaded` | manual evidence becomes active | `evidence.id`, `control.ids`, `valid_until` |
| `evidence.expiring` | within the warning window | `evidence.id`, `days_left`, `owner.id` |
| `evidence.expired` | at expiry | `evidence.id`, `control.ids` |
| `evidence.integrity_failed` | a re-hash mismatches (not a missing or redacted object) | `entry.seq`, `entry.kind`, `failure` |
| `evidence.redacted` | personal data redacted | `holder.kind`, `holder.id` |
| `ledger.sealed` | daily | `head.seq`, `head.hash`, `signature` |
| `ledger.restored` | a restore entry is appended | `prior_sealed_seq`, `head.seq` |
| `gap.fix_proposed` | a fix proposal is filed | `gap.id`, `template`, `proposal.id` |
| `exception.proposed` | an exception proposal is filed | `exception.id`, `control.id`, `expires_at` |
| `exception.approved` | a verified human approves it | `exception.id`, `control.id` |
| `exception.expired` | at expiry | `exception.id`, `control.id` |
| `attestation.overdue` | someone has not attested within cadence | `policy.id`, `user.id` |
| `questionnaire.drafted` | autofill finishes | `questionnaire.id`, band counts, `deal.id` |
| `questionnaire.approved` | approved for export | `questionnaire.id`, `deal.id` |
| `auditor_room.created` | a room is created | `room.id`, `expires_at` |
| `auditor_room.revoked` | a room is revoked or auto-locked | `room.id`, `reason` |
| `readiness.weekly` | Monday | `proven_native`, `proven_provided`, `not_met`, `cannot_prove`, `expiring_soon`, `setup_done`, `setup_total` |

**23 events.**

### 8.2 Consumed

`proposal.decided` (source `platform`) through the bolt-api dispatch hook into
`/v1/internal/events`, treated as a wake-up signal only (section 2.8). Machine feeds are the other
inbound path. Bin emits no events.

### 8.3 entity_links

Written in the same transaction as the row they describe, `ON CONFLICT DO NOTHING`, via a copy of
`apps/bursar-api/src/lib/entity-links.ts`:

- `bastion.control` -> `bam.task` (`related_to`);
- `bastion.manual_evidence` -> `bin.asset` (`derived_from`);
- `bastion.policy` -> `beacon.entry` (`references`);
- `bastion.questionnaire` -> `bond.deal` (`related_to`);
- `bastion.fix_draft` -> the applied `beacon.entry` or `bolt.rule` (`derived_from`).

### 8.4 Required changes outside apps/bastion*

| File | Change |
| --- | --- |
| **#124** `packages/shared/src/bolt-sources.ts` (new) | One `BOLT_SOURCES` const list including `'bursar'` and `'bastion'`. `apps/bolt-api/src/routes/event-ingestion.routes.ts:35` `z.enum`, `TRIGGER_SOURCES` (`apps/bolt-api/src/routes/automation.routes.ts:13`), `TriggerSourceV1` (`packages/shared/src/bolt-automation-versions/v1.ts:10`), and the Drizzle `pgEnum` (`bolt_automations.ts:15`) all derive from it; migration `0260` adds the missing enum values; `scripts/check-bolt-catalog.mjs` fails when any catalog `source` is missing from `BOLT_SOURCES` |
| **#125** `packages/shared/src/bolt-events.ts` | `publishBoltEvent` passes `AbortSignal.timeout(5000)` to its fetch, for every app |
| **#123** `apps/api/src/routes/upload.routes.ts:187-222` | `/files/*` serves only the `avatars/` prefix it was built for; any other key returns 404; drop `Cache-Control: public` for non-avatar paths. Bastion additionally uses its own bucket |
| `apps/api/src/routes/github-webhook.routes.ts` | On `ping` (line 137-138), store `hook.events` into `github_integrations.subscribed_events`; handle `pull_request_review`; append every `pull_request` closed/merged and `pull_request_review` submitted event to `github_pr_events` regardless of task references (task linking unchanged) |
| `apps/api/src/db/schema/github-pr-events.ts`, `github-integrations.ts` | the new table (`integration_id`, `project_id`, `org_id`, `repo_owner`, `repo_name`, `pr_number`, `event_kind`, `base_ref`, `is_default_branch`, `head_sha`, `author_login`, `merged_by_login`, `reviewer_login`, `review_state`, `review_commit_sha`, `task_refs text[]`, `occurred_at`, `delivery_id` unique, `received_at`) and the `subscribed_events` column |
| `apps/api/src/routes/internal-bastion.routes.ts` (new) | `POST /internal/bastion/tasks/upsert` (reopen semantics, section 2.5) and `POST /internal/bastion/tasks/:id/comment` (dedups on an `idempotency_key`), `requireServiceAuth`, attributed to `BASTION_SYSTEM_USER_ID`, modeled on `internal-helpdesk.routes.ts:51+`, keyed on the 0130 `(project_id, external_id)` index; `logActivity` puts them in `v_activity_unified` |
| `apps/api/src/lib/constants.ts` | `BASTION_SYSTEM_USER_ID` |
| `apps/api/src/services/visibility.service.ts` | six types: `bastion.control`, `bastion.evidence_snapshot`, `bastion.manual_evidence`, `bastion.policy`, `bastion.questionnaire`, `bastion.fix_draft` (restricted manual evidence also requires `read_restricted` or ownership) |
| `apps/mcp-server/src/tools/visibility-tools.ts:28` | the `can_access` description is generated from `SUPPORTED_ENTITY_TYPES` instead of a hand list (already stale) |
| `docs/reference/agent-conventions.md` | the six new types |
| `apps/mcp-server/src/tools/search-tools.ts` | a Bastion fetcher (row 88) mapped to `bastion.control` |
| `apps/bolt-api/src/services/` + `env.ts` | `bastion-subscriptions.ts`, `bastion-dispatch-hook.ts`, `BASTION_API_INTERNAL_URL` |
| `apps/worker/src/jobs/backup-database.job.ts` | reads the Bastion mirror status into the backup record (section 9.7) |
| `packages/structured-data/src/codecs/xlsx.ts` | new xlsx codec (section 15.4) |
| `packages/shared/src/schemas/bastion.ts` | Zod schemas, feed contract, queue contracts, `endOfDayInTz`, `effectiveStatus` |

### 8.5 Unified activity and search

`search_everything` includes Bastion controls and policies. Remediation tasks land in Bam's
`activity_log`, which `v_activity_unified` unions. Bastion's own administrative actions go to
`bastion_audit_log`; extending the unified view is not done in v1 (section 15.8).

---

## 9. Infrastructure, backup and DR

### 9.1 Compose service

Modeled on the `bursar-api` block (`docker-compose.yml:1041-1093`): build
`apps/bastion-api/Dockerfile`; env `DATABASE_URL`, `DATABASE_READ_URL`, `REDIS_URL`,
`SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL=http://api:4000`,
`BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_REGION`, **`BASTION_S3_BUCKET=${BASTION_S3_BUCKET:-bigbluebam-bastion}`** (own bucket; the
S3 driver's `ensureBucket` creates it), `BASTION_SEAL_SIGNING_KEY`, `BASTION_PD_HMAC_KEY`,
`BASTION_ROOM_IP_SALT`, `TRUST_PROXY_HOPS=1`, `PORT=4024`, `HOST=0.0.0.0`, `LOG_LEVEL`,
`CORS_ORIGIN`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `BASTION_LLM_TIMEOUT_MS=60000`,
`BASTION_ENGINE_TIMEOUT_MS=30000`, `BASTION_PROBE_TIMEOUT_MS=8000`. `depends_on`: migrate
(`service_completed_successfully`), postgres and redis (`service_healthy`), minio
(`service_started`). Healthcheck `curl -sf http://localhost:4024/health`.
`BASTION_API_URL=http://bastion-api:4024/v1` on mcp-server; `BASTION_API_INTERNAL_URL` on worker
and bolt-api. **The frontend gets `bastion-api: condition: service_started` in `depends_on`**
with the Bursar comment (`docker-compose.yml:310-317`). Redis is verify-only (512mb,
`noeviction`).

**Dockerfile.** Copied from bursar-api **plus the four `packages/storage` lines from
`apps/bin-api/Dockerfile:16,31,41,58`** (bursar-api does not build `@bigbluebam/storage`).

### 9.2 nginx

Hand-edit only `infra/nginx/nginx-with-site.conf` and `infra/nginx/nginx.conf`:

- `location /bastion/` (alias + `try_files ... /bastion/index.html`, which also serves
  `/bastion/room`);
- `location /bastion/api/` using a runtime-resolved upstream so a missing or crash-looping
  bastion-api returns 502 on its own routes instead of stopping nginx at load:
  `resolver 127.0.0.11 valid=10s; set $bastion_up bastion-api:4024; rewrite ^/bastion/api/(.*)$
  /$1 break; proxy_pass http://$bastion_up;` (the shape Railway's generated conf already uses);
- `location ~ ^/bastion/api/v1/internal/ { return 404; }`;
- `bastion` added to the shared static-asset regex (`nginx-with-site.conf:907`) **and** to the
  `index.html` no-cache regex (`nginx-with-site.conf:896`). Issue #127 adds the five missing
  siblings (basis, braid, bulwark, burn, bursar) in M0.

`infra/nginx/nginx.railway.conf` is **generated**: after the `services.mjs` entry exists, run
`node scripts/gen-railway-configs.mjs` and commit its output, including `railway/bastion-api.json`.
Gate: `docker compose exec frontend nginx -t`. No `/bastion/ws`.

### 9.3 Frontend image

`apps/frontend/Dockerfile`: `COPY apps/bastion/package.json ./apps/bastion/` (beside line 26),
`COPY apps/bastion/ ./apps/bastion/` (beside line 74), `&& pnpm --filter @bigbluebam/bastion build
\` (beside line 101), `COPY --from=build /app/apps/bastion/dist /usr/share/nginx/html/bastion`
(beside line 129). Serving `/bastion/` needs `docker compose build frontend` (rebuilds every SPA).

### 9.4 Deploy catalog and env hints

`scripts/deploy/shared/services.mjs`, with the env block, landed **in the same commit as its env
hints** (otherwise `internal('bastion-api')` throws):

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
  extra_watch_patterns: ['packages/storage/**', 'packages/permissions/**'],
  env: {
    required: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'INTERNAL_SERVICE_SECRET',
               'BBB_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL',
               'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'BASTION_S3_BUCKET',
               'BASTION_SEAL_SIGNING_KEY', 'BASTION_PD_HMAC_KEY', 'BASTION_ROOM_IP_SALT'],
    optional: ['DATABASE_READ_URL', 'S3_REGION', 'CORS_ORIGIN', 'LOG_LEVEL',
               'TRUST_PROXY_HOPS', 'BASTION_LLM_TIMEOUT_MS', 'BASTION_ENGINE_TIMEOUT_MS',
               'BASTION_PROBE_TIMEOUT_MS'],
  },
}
```

`scripts/deploy/shared/env-hints.mjs` (beside lines 296-309):

```js
BASTION_API_INTERNAL_URL:  { kind: 'computed', value: internal('bastion-api') },        // bare origin
BASTION_API_URL:           { kind: 'computed', value: `${internal('bastion-api')}/v1` }, // mcp client
BASTION_S3_BUCKET:         { kind: 'literal',  value: 'bigbluebam-bastion' },
BASTION_LLM_TIMEOUT_MS:    { kind: 'literal',  value: '60000' },
BASTION_ENGINE_TIMEOUT_MS: { kind: 'literal',  value: '30000' },
BASTION_PROBE_TIMEOUT_MS:  { kind: 'literal',  value: '8000' },
TRUST_PROXY_HOPS:          { kind: 'literal',  value: '2' },
BASTION_SEAL_SIGNING_KEY:  { kind: 'secret' },   // generated per service
BASTION_PD_HMAC_KEY:       { kind: 'secret' },
BASTION_ROOM_IP_SALT:      { kind: 'secret' },
```

The frozen allowlist in `scripts/check-env-hints.mjs` is not touched. Also: `bastion-api` in the
frontend entry's `needs`; `BASTION_API_INTERNAL_URL` on bolt-api and worker; `BASTION_API_URL` on
mcp-server's `env.optional`.

**Existing Railway services (issue #126).** `railway-orchestrator.mjs:669` `syncNew` only creates
missing services; it never adds new variables to existing ones, so worker, bolt-api, and
mcp-server would never receive the Bastion URLs. M0 fixes `syncNew` to fill missing `computed`
and `literal` hints on existing services, for every future app. Post-deploy check: the first
`bastion-evaluate-tick` log line on Railway, and `/bastion/api/health` through the ingress.

### 9.5 Health and scaling

`@bigbluebam/service-health`: exactly `/health`, `/health/ready`, `/metrics`; readiness checks
Postgres and Redis only (`apps/bursar-api/src/server.ts:126-140`). bastion-api is stateless and
horizontally scalable: run claims with fenced writes, per-org advisory ledger locks, Redis
semaphores and lockout counters. Evaluation load is spread by `evaluation_minute_offset`, and
probes run on `DATABASE_READ_URL` when set.

### 9.6 Registration checklist

| File | Change | Milestone |
| --- | --- | --- |
| `docker-compose.yml`, `apps/frontend/Dockerfile`, nginx (two hand-edited + generated Railway) | sections 9.1-9.3 | M1 |
| `scripts/deploy/shared/services.mjs`, `env-hints.mjs`, `railway/bastion-api.json` | section 9.4 | M1 |
| `.env.example` | the `BASTION_*` and `TRUST_PROXY_HOPS` vars with comments | M1 |
| `apps/bolt-api/src/services/event-catalog.ts` | `bastionEvents` (section 8.1) | M10 |
| `scripts/docs/lib/tool-source.mjs` | `APP_TOOL_MODULES` += `bastion: ['bastion-tools']`; `pnpm docs:catalog` | M10 |
| Published tool counts | `README.md` (lines 40, 57, 63, 346, 358, 390), `site/index.html:6`, `site/src/content/apps/introduction.md:15`, `site/src/lib/facts.ts` `MCP_TOOL_COUNT` (885 + 24 = 909 at authoring; regenerate, never hand-add), and the CLAUDE.md per-module count line | M10 |
| `docs/reference/mcp-endpoint-mapping.md` | a Bastion section mirroring section 5.1 with every skip in the doc's skip-marker form; the two new internal Bam routes in "Cross-app - Internal service-to-service endpoints" (line 1864); the GitHub webhook change in the Bam section; `## Surface summary` updated; the CLAUDE.md self-check prints `0` | M10 |
| `apps/mcp-server/src/tools/visibility-tools.ts`, `docs/reference/agent-conventions.md` | section 8.4 | M10 |
| `apps/api/src/routes/system-settings.routes.ts` | `LAUNCHPAD_APP_IDS` += `'bastion'`; `LAUNCHPAD_CATALOG` += `{ id: 'bastion', name: 'Bastion', description: 'Compliance & Controls', icon_name: 'castle', color: '#7c2d12', path: '/bastion/' }`; `ROOT_REDIRECT_VALUES` **and** `REDIRECT_MAP` | **M11 (last)** |
| `packages/ui/launchpad.tsx` `ICONS`, `site/src/pages/docs.tsx` `APP_ICON`/`APP_COLOR` | `castle` | M11 |
| `site/src/components/sections/bastion-section.tsx` + import in a page under `site/src/pages/` (as `operations.tsx:11` imports Bursar's) | marketing section | M11 |
| `site/public/screenshots/bastion/` | numbered PNGs from docs-capture | M11 |
| `README.md` `AUTODOCS:APP_SECTIONS` | `pnpm docs:readme` | M11 |
| `CLAUDE.md` | app table rows, route list, migrate dependents | M11 |
| `scripts/seed-gilligan/run-all.mjs` | the Compliance phase | M3 (grown each milestone) |

Before M11 Bastion is reachable by direct URL only (`/bastion/`), so
`pnpm check:app-completeness` (which checks every `LAUNCHPAD_CATALOG` app) stays green throughout.

### 9.7 Backup and DR

- `apps/worker/src/jobs/backup-database.job.ts` covers Postgres only. `bastion-object-backup`
  mirrors new objects from the Bastion bucket to the backup destination prefix
  `bastion-mirror/<org>/` daily, and the backup record notes the mirror cursor, so a platform
  restore can restore both.
- The verifier distinguishes `object_missing` (an infrastructure event, recorded as a worker
  error, no tamper event) from `hash_mismatch` (`evidence.integrity_failed`).
- After a database restore, the seal run appends a `restore` ledger entry citing the prior sealed
  head (section 3.4). Seals already published remain verifiable against their signatures.
- `ops.backup_fresh` passes only if the latest backup record also shows the Bastion mirror
  current, so Bastion does not certify backups that omit its own evidence.

---

## 10. Seed data (GILLIGAN)

`scripts/seed-gilligan/bastion.mjs` plus `bastion.expectations.mjs`, registered as a new last
phase `{ name: 'Compliance', files: ['bastion.mjs'] }` after "Support & email". **The seeder is
built incrementally from M3**: each milestone adds the rows its Playwright stories need and
extends `BASTION_SEED_EXPECTATIONS` in the same change. Never seeded:
`e2e-admin@bigbluebam.test`, "E2E Test Organization", "screenshots-demo".

### 10.1 The story

Gilligan Travel Ltd is preparing for its first SOC 2 review because Thurston Howell III's holding
company will only book the charter fleet through a vendor that passes its security review, and
Howell's European subsidiary has asked about ISO 27001 too. Skipper owns the program; the
Professor owns technical controls; Mary Ann owns people controls. The auditor is "Lagoon & Reef
CPAs".

### 10.2 What the seed creates

| Milestone | Rows |
| --- | --- |
| M3 | SOC 2 adopted, then ISO 27001 adopted (the MFA control shows both "CC6.1" and "A.5.17" chips); company profile; a "Compliance" Bam project set in settings; confirmed assertions; GitHub expected population of two repos ("Rescue Radio Firmware", "Lagoon Booking Site") |
| M4 | API key "Coconut Radio Bridge" (210 days) -> **Not met**; departed guest **Wrongway Feldman** still holding a key -> **Not met**; "Rescue Radio Firmware" integrated and subscribed to reviews, 11 merges, PR #42 "Boost antenna gain" merged by Gilligan with no review -> **Not met**; "Lagoon Booking Site" not integrated -> the control is **Can't prove yet** naming it; Blip app "Daily Coconut Count" at 30-day retention -> **Not met**; backups -> **Proven** ("Provided by your hosting platform"); Bursar vendor "Island Weather Feed" critical with award -> **Proven** |
| M5 | "Google Workspace 2-Step Verification report" by the Professor, accepted by Skipper, valid 12 more days -> **Proven by evidence you provided**, expiring; laptop encryption with nothing -> top gap; "Background checks for new crew" self-attested by Mary Ann; an HR feed "Crew roster export" with a feed key |
| M6 | an approved exception for the long-lived service key "Radio Relay" (compensating note: "IP-restricted, rotated with each radio firmware release"); an `evidence_request` fix proposal to the Professor; the drift task in the Compliance project |
| M7 | Beacon "Island Information Security Policy" linked; 5 of 7 attested; Gilligan and Lovey pending |
| M8 | "Howell Industries Vendor Security Review" (xlsx, 24 rows) linked to the Bond deal "Howell Holdings Charter Fleet", autofilled |
| M9 | auditor room "Lagoon & Reef CPAs, Type I readiness", 30 days, with two access-log rows; one packet |

### 10.3 One source for the numbers

`scripts/seed-gilligan/bastion.expectations.mjs` exports `BASTION_SEED_EXPECTATIONS`: the four
numbers per framework, setup progress, coverage-kind counts, the gap mapping cases present, the
top-ranked gap title, the exception count, questionnaire band counts, the attestation ratio, and
the ledger length after the seeded run. Playwright imports it, as
`apps/e2e/src/apps/bursar/bursar-expectations.d.ts` does for Bursar.

---

## 11. Test plan

### 11.1 Unit (Vitest)

Boot invariant; `time-budgets` (section 7.3); every probe's `paramsSchema` bounds and counts-only
`explain()`; the gap mapping table (every `(status, reason)` has exactly one row); four-number
classification including `mixed` and exceptions; `effectiveStatus` staleness; infrastructure
failure non-drift and the two-night rule; conditional status write (older `as_of` cannot
overwrite); compiler validation and fallback; crosswalk completeness (every SOC 2 and ISO
requirement maps to at least one control); manual assertion decision table (including scan
states and self-review in small teams); `endOfDayInTz` across DST; ledger canonicalizer goldens
and tamper detection; seal signing and verification; personal-data redaction keeps the chain
verifiable; Bolt rule shape allowlist rejects `send_webhook` and `send_email*`; injection pre-scan
on cited labels; proposal re-verification (agent decider, impersonated decider, foreign proposal
id all rejected); `rejectWhenImpersonating` on every vouching route; auditor token hashing,
fragment parsing, passcode lockout, creator-authority re-check, restricted allowlist, id scoping;
content-type allowlist and download headers; questionnaire banding; citation verification;
csv neutralization; `bin-asset-access` refusal cases; claim fencing; reaper unwedging; feed key
HMAC verification, quota 429, batch byte cap; no bare `upsertJobScheduler` or `add`; `rls-coverage`.

### 11.2 Integration (real Postgres, CI service container)

- **Probe goldens**, run **twice**: once as today, once with `BBB_RLS_ENFORCE=1`, asserting
  identical outcomes (including `access.departed_still_holding` catching a user whose membership
  was removed). Includes a missing-population case (one expected repo not integrated).
- **Immutability:** UPDATE of content columns, DELETE, cascade, TRUNCATE all raise; the access-log
  purge function deletes only rows older than 2 years.
- **Bolt ingest:** posting one Bastion event to `/events/ingest` returns 2xx (proves #124).
- **Cross-app:** GitHub `ping` stores `subscribed_events`; `pull_request_review` and merge
  deliveries land in `github_pr_events`; evaluation -> drift -> outbox -> task upsert; **drift,
  close the task, drift again: the task is open with a "Drifted again" comment**; recovery comment
  is posted once across a forced retry. Proposal decided -> verified -> fix draft approved -> task.
  Feed push with a repeated idempotency key is a no-op.
- **Files route:** a GET of any non-avatar key through `/files/` returns 404 (#123).
- **Proxy:** two different forwarded clients have independent lockout counters.

### 11.3 LLM corpus gates (recorded responses)

| Gate | Threshold |
| --- | --- |
| Compiler validity | 0 invalid probe keys or params reach `proposed` |
| Compiler coverage | every SOC 2 and ISO control receives an assertion or a manual spec |
| Questionnaire false confidence | 0 `high` answers citing a control whose effective status is not `pass` |
| Questionnaire injection | 0 `high` answers on the injection fixture rows |
| Fix-draft injection | 0 drafts whose name or description carries instructions from an injected PR title |
| Citation integrity | 0 persisted citations outside the retrieved set or failing `can_access` |

### 11.4 Playwright user stories (GILLIGAN, `BASTION_SEED_EXPECTATIONS`)

Before M10 stories run **only as Skipper** (SuperUser).

| # | Story | Milestone |
| --- | --- | --- |
| 1 | Skipper opens `/bastion/`; the four numbers match; "Proven by evidence you provided" is separate; the Setup bar is shown and no "Nobody has confirmed" row appears in the gap list | M5 |
| 2 | Switching the framework picker to ISO 27001 changes the numbers; the MFA control shows both requirement chips | M5 |
| 3 | The evidence locker shows the 2-Step report "expires in 12 days" | M5 |
| 4 | The top gap is laptop encryption; **Draft the fix** files a proposal to the Professor | M6 |
| 5 | The code-review control cites PR #42 and names "Lagoon Booking Site" as not connected; **Verify** says "This evidence is intact" | M6 |
| 6 | The "Radio Relay" key control shows "1 accepted exception" and counts as provided | M6 |
| 7 | The Howell questionnaire's disk-encryption row reads "We cannot currently prove this"; **Approve** is disabled until low rows are reviewed | M8 |
| 8 | Skipper creates an auditor room; the token shows once; the preview lists the chosen controls and restricted items | M9 |
| 9 | Anonymous auditor opens the link in a fresh context; views a control and evidence; the access log grows | M9 |
| 10 | After revoke, the link shows "This link is no longer available" and the API returns 404 | M9 |
| 11 | **Negative:** no raw UUID on home, controls list, or control detail (regex over visible text) | M9 |
| 12 | Gilligan (member) attests to the policy at `/bastion/attest`; coverage rises by one | M10 |
| 13 | **Negative:** Gilligan sees no Sharing actions; `POST /auditor-rooms` returns 403 | M10 |
| 14 | **Negative:** Skipper impersonating Gilligan cannot attest (button disabled, API 403) | M10 |
| 15 | **Help:** the HelpTrigger opens the Bastion guide | M10 |
| 16 | Bastion appears on the Launchpad and opens | M11 |

### 11.5 Convention gates

`pnpm db:check` (0 drift), `pnpm lint:migrations`, `pnpm check:bolt-catalog` (extended for
#124), `pnpm check:permission-catalog`, the section 4.6 probe-vs-table assertion,
`pnpm check:env-hints`, `node scripts/check-tool-return-coverage.mjs`,
`pnpm check:app-completeness` (from M11), the surface-map self-check printing `0` plus an updated
summary, `pnpm docs:catalog:check`, `node scripts/help/build-help-index.mjs --check`,
`grep -c bastion infra/nginx/*.conf` non-zero in all three, `docker compose exec frontend nginx
-t`, `tsc --noEmit`, Biome.

---

## 12. Milestones

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | **Platform prerequisites, fixing the fact, not the place.** #124: `BOLT_SOURCES` in `@bigbluebam/shared` with the ingest enum, `TRIGGER_SOURCES`, `TriggerSourceV1`, and the pgEnum derived from it; migration `0260`; `check-bolt-catalog.mjs` extension. #125: `AbortSignal.timeout` in `publishBoltEvent`. #123: `/files/*` restricted to `avatars/`. #126: `syncNew` fills missing hints on existing Railway services. #127: the five missing apps in the `index.html` no-cache regex. | a Bursar event posted to `/events/ingest` returns 2xx; `/files/<non-avatar key>` returns 404; a dry-run `syncNew` plan shows variable additions for existing services; `nginx -t` passes |
| **M1** | Scaffold `apps/bastion-api` (bursar skeleton + storage Dockerfile lines, own bucket, `trustProxy`) and `apps/bastion` (direct URL only); compose service + frontend `depends_on`; nginx (runtime resolver, internal deny, both regexes) then `gen-railway-configs.mjs`; `services.mjs` with env block and all hints in one commit; frontend Dockerfile four edits | `/bastion/` serves by direct URL; `/bastion/api/health` 200; `/bastion/api/v1/internal/x` returns 404 through nginx; stopping bastion-api leaves every other app up; `check:env-hints` green |
| **M2** | Migrations 0261-0268 + Drizzle + RLS loop + probe function skeletons; the GitHub webhook change | `db:check` 0 drift; immutability and `rls-coverage` tests green; `ping` stores `subscribed_events` |
| **M3** | Library (controls, SOC 2, ISO 27001, starter, crosswalk) with plain summaries; frameworks, controls, requirements, assertions; setup wizard incl. Compliance project; deterministic compile; seeder phase started | adopting SOC 2 then ISO with no LLM proposes assertions and shares controls |
| **M4** | All probes, the evaluator (tick + run queue, budgets, conditional writes, staleness, non-drifting infra failures), ledger, seals, outbox, verify | probe goldens green twice (RLS off and on); a seeded run completes with progress logs; tampering detected; a killed bolt-api does not lose a seal |
| **M5** | Manual evidence (Bin attach, scan states, stream copy, review, expiry, withdraw), personal data + redaction, feeds with per-feed keys and quotas, coverage graph, Readiness | Playwright 1-3 |
| **M6** | Gap mapping and ranking, fix drafting (deterministic Bolt shapes), exceptions, drift and the internal task route with reopen, proposal re-verification | Playwright 4-6; cross-app flows green |
| **M7** | LLM compile tailoring with populations; policies and attestation (served body) | compiler corpus gates |
| **M8** | Questionnaires: xlsx codec, mapping, autofill, banding, review, approval, export, answer library | questionnaire gates; Playwright 7 |
| **M9** | Auditor room (hardened), access log + purge, requests, export packet (worker, streamed), object sweep and backup mirror, help.md/guide.md | Playwright 8-11 |
| **M10** | Permission chain + group defaults; MCP tools with `returns:`; Bolt catalog; visibility types and tool description; `search_everything`; surface map; published tool counts; docs catalog; help gate against a rebuilt image | Playwright 12-15; section 11.5 gates green except app-completeness; section 4.6 probe matches section 5.5 |
| **M11** | **Launchpad registration last:** `LAUNCHPAD_*`, `ROOT_REDIRECT_VALUES`, `REDIRECT_MAP`, icon, marketing section, site screenshots, `pnpm docs:readme`, CLAUDE.md | Playwright 16; `pnpm check:app-completeness` green |

---

## 13. Reuse ledger

| Capability | Reused from | Genuinely new |
| --- | --- | --- |
| Fastify skeleton, error handler, shutdown | `apps/bursar-api/src/server.ts:54-196` | `trustProxy` hops |
| Permission enforcement invariant | `apps/bursar-api/src/boot/assert-permissions-enforce.ts` | the section 5.5 table |
| RLS binding and posture report | `apps/bursar-api/src/plugins/rls.ts:58-68` | probe definer functions |
| Auth (session, API key, impersonation) | `apps/bursar-api/src/plugins/auth.ts` | `rejectWhenImpersonating` |
| Health, readiness, metrics | `@bigbluebam/service-health` | nothing |
| Logging and error recording | `@bigbluebam/logging`; worker `recordWorkerError` | progress lines |
| Object storage | `@bigbluebam/storage` `createBootstrapDriver`, `put` with streams | own bucket, random keys |
| Upload and AV scan | Bin upload route, `bin-av-scan` | explicit scan-state mapping |
| Bin access checks | `apps/bursar-api/src/lib/bin-asset-access.ts` | nothing |
| LLM access | `apps/bursar-api/src/lib/llm-client.ts` -> `POST /internal/llm/chat` | per-org semaphore |
| Injection pre-scan | `apps/bursar-api/src/lib/injection-prescan.ts` | applied to cited labels |
| Advisory locks | `apps/burn-api/src/lib/advisory-lock.ts` | ledger lock |
| Run claims, reaper, drive loop | Bursar reaper engine; `apps/worker/src/jobs/bursar-level.job.ts` | time-budget slices |
| Immutability triggers | `0249_bursar_awards_baseline.sql` | hash chain, signed seals |
| Per-target ingest credentials | `apps/blip-api/src/db/schema/blip-ingest-keys.ts` | `bastion_feed_keys` |
| HITL queue | `agent_proposals` + `proposal_*` tools | re-verification on decide |
| Visibility preflight | `visibility-client.ts`, `visibility.service.ts` | six types |
| Cross-app links | `apps/bursar-api/src/lib/entity-links.ts` | five link specs |
| Bolt publish, catalog, intake | `publishBoltEvent`, `event-catalog.ts`, `bursar-dispatch-hook.ts` | outbox; one source list (#124) |
| Bam tasks from a satellite | `internal-helpdesk.routes.ts`, upsert index 0130 | reopen semantics |
| Guest links | Bay public review | hashed fragment tokens, passcode lockout, allowlists |
| Parsing, CSV safety | `@bigbluebam/structured-data`, `csv-safe.ts` | xlsx codec |
| PDF and zip | `pdf-lib`, `jszip` (worker deps) | streamed packet |
| Job retention | `withRetention`, `SCHEDULED_JOB_RETENTION` | nothing |
| MCP module | `bursar-tools.ts:55-80`, `register-tool.ts` | 24 tools |
| SPA shell, help | `apps/bursar/src/`, `@bigbluebam/ui`, `build-help-index.mjs` | Bastion pages |
| Seeding | `run-all.mjs`, expectations-constant pattern | `bastion.mjs` |

**Genuinely new:** the probe catalog as definer functions with populations, the crosswalked
org-level control model, the hash-chained ledger with signed seals and redactable personal data,
the manual-evidence lifecycle, the honest four-number coverage graph with one gap mapping,
exceptions, policy attestation, questionnaire banding tied to effective status, the hardened
auditor room, the xlsx codec, and the Bam GitHub review ledger.

---

## 14. Non-goals and v1.1

**Non-goals (v1):** not an auditor or certification body; no contract obligations (Bulwark) or
outbound vendor questionnaires (Bursar); no scanning, CSPM, or endpoint agents; no direct cloud,
MDM, IdP, or HRIS connectors (the feed API is the integration point); no LLM reading of uploaded
files; no running access reviews or training; no outbound email; Bastion never edits Beacon
articles or Bolt rules; no vector retrieval; no realtime.

**v1.1 candidates:**

| Item | Precondition |
| --- | --- |
| **Public trust page** (moved from v1 by round 1) | v1 usage of auditor rooms; legal review of public claims |
| **Custom frameworks extracted from a document by the LLM** (moved from v1) | the `verifyCite` corpus gates on a labelled framework corpus |
| S3 Object Lock (WORM) for the Bastion bucket | a bucket created with object lock |
| LLM check that an uploaded file matches its request | measured reviewer load |
| Native MFA control | the platform ships MFA |
| GitHub branch-protection evidence | a GitHub App or token read path |
| Extending `v_activity_unified` with satellite branches | a platform decision for all satellites |
| Sibling-app feeds (training, incidents, access reviews) | those apps ship and register events |
| Evidence retention and legal-hold policy | customer demand |
| Partitioning of snapshots, ledger, feed records | the 50 million row threshold |

---

## 15. Open questions and risks

1. **Framework text licensing (human decision, before M3).** v1 ships reference codes plus
   in-house plain summaries and never the AICPA or ISO wording. Legal should confirm.
2. **The platform has no MFA**, so the most-asked question is proven only by uploaded evidence.
3. **Inherited controls.** Backups are platform-scoped; on multi-tenant hosting they are the
   operator's control, labelled "Provided by your hosting platform".
4. **xlsx is new.** No package reads or writes xlsx; the dependency (likely `exceljs`) needs
   approval. CSV works from day one.
5. **Immutability is detection, not prevention**, until WORM in v1.1.
6. **The crosswalk is a judgement.** It ships as reviewed code with a completeness test, and admins
   can adjust requirement links; an auditor may disagree with a mapping.
7. **Remediation task default** is `create` with reopen semantics; `propose` is one setting away.
8. **`v_activity_unified` is not extended** in v1.
9. **No vector retrieval** for questionnaires; the corpus gate measures lexical recall.
10. **Platform defects this spec depends on, filed and scheduled:** #121 (Bursar WebSocket; Bastion
    avoids realtime), #122 (Bay plaintext tokens; Bastion hashes its own), #123 (`/files/*`,
    fixed in M0 and avoided by Bastion's own bucket), #124 (Bolt source list, fixed in M0), #125
    (`publishBoltEvent` timeout, fixed in M0), #126 (Railway env propagation, fixed in M0), #127
    (index.html no-cache regex, fixed in M0). Also noted: the GitHub webhook drops unlinked PRs
    (fixed in M2 as part of the Bam change), and `login_history` has no org column.
11. **Small-team self-review** is allowed under three humans and disclosed to the auditor.
12. **Questionnaire PII** is member-readable, not viewer-readable; tighter restriction is a human
    decision.
13. **`TRUST_PROXY_HOPS` on Railway** is assumed to be 2 (edge plus nginx); verify on the first
    deploy with the forwarded-client integration test against staging.
14. **Seal signing key rotation** is not specified beyond `signing_key_id`; v1 assumes one key per
    deploy and publishes the public key per seal.

---

## 16. Changelog

### Round 0

- Initial draft (2026-11-25).

### Round 1 (46 findings: 9 blocker, 31 major, 6 minor; 43 accepted, 3 adapted, 0 rejected)

**Orchestrator decisions applied:** trust page and custom-document framework extraction moved to
v1.1; multi-framework via option (b); Launchpad registration is the last milestone (M11); issues
#123-#127 scheduled as platform fixes in M0 (and #121/#122 cited where Bastion depends on the
pattern).

**Design**
- design-1 accepted: one authoritative `(status, reason) -> gap_kind -> severity -> template`
  table covering every reason including `evaluation_stale`; `attested_only` relief 0.6;
  `not_yet_confirmed` removed from the gap list and four numbers and shown as a Setup bar;
  `mixed` counts as provided; seed expectations assert it (sections 2.3, 3.2, 6.1, 10.3).
- design-2 accepted: review subscription read from the stored `ping` `hook.events`
  (`github_integrations.subscribed_events`) or any review delivery; a team with no reviews now
  gets `fail`; the precondition rule applied to every probe, which also changed `ops.backup_fresh`
  (zero backups is now `fail`) (sections 3.1, 8.4).
- design-3 accepted: human-confirmed `expected_population` on population probes, stated in every
  explanation and snapshot; a missing-repo golden (sections 3.1, 11.2).
- design-4 accepted: `bastion_exceptions`, ledgered, proposal-approved, expiring; three permission
  rows; `exceptions.csv` and room display (sections 2.6, 4.1, 5.5, 7.2).
- design-5 accepted, option (b): org-level controls keyed by `control_key`,
  `bastion_control_requirements`, static crosswalk in `library/`, `?framework_id=` filters;
  reasoning recorded in section 2.1.
- design-6 accepted: reopen-to-start-phase with a "Drifted again" comment under one external id;
  the Compliance project is a required setup step with a banner while unset (section 2.5).
- design-7 accepted (recommended option): the attestation page reads the exact hashed version body
  from bastion-api; linking requires org-wide visibility; `policy.current` cites Beacon's
  `expires_at` (section 3.6).
- design-8 accepted: trust page and custom-document extraction moved to v1.1; counts recomputed
  (section 14).
- design-9 accepted: per-feed keys on the Blip ingest-key pattern; `feed.write` removed (sections
  3.5, 4.1, 5.5).

**Stability**
- stability-1 accepted: time-budgeted slices, the 8 s / 15 s / 30 s / 300 s invariants with a test,
  tick split from a `bastion-evaluate-run` queue keyed by run id using the `bursar-level.job.ts`
  drive loop; LLM slices are async-start (section 7.3).
- stability-2 accepted: 36 h staleness via one `effectiveStatus`, non-drifting infrastructure
  failures with a two-night rule, `storage_unavailable` partial runs, `bastion-evaluation-missed`
  (section 3.2).
- stability-3 accepted: control-partitioned slices, conditional status writes, drift only on a
  changed row, three partial unique indexes including `nightly_for_date`, `as_of` everywhere
  (sections 4.1, 7.3).
- stability-4 accepted: access-log purge via a guarded definer function, `bastion-object-sweep`
  with a 24 h floor and re-checks, feed quotas and storage accounting, partitioning threshold
  recorded (sections 3.5, 4.1, 7).
- stability-5 accepted: explicit scan-state mapping, 24 h pending cap, attempts and backoff,
  copy-at-attach (section 3.3).
- stability-6 accepted: `bastion_outbox` with a drainer and idempotency keys, persisted seals
  retried until published, timeout via the #125 fix (sections 3.4, 7, 8.4).
- stability-7 accepted: canonical JSON with ms UTC timestamps, seq and org included, golden
  round-trip test, verify bounded to the next seal, budgeted weekly verify (section 3.4).
- stability-8 accepted: packet in the worker as one leased job, streamed zip and PDF, size and
  period caps, stage checkpoints (section 7.2).
- stability-9 accepted: `tz: 'UTC'` on every scheduler, `nightly_for_date` in org time with
  first-tick-after DST rule, `endOfDayInTz` shared helper, `jobId` plus `SCHEDULED_JOB_RETENTION`
  on every producer with a scanning test (sections 3.3, 7).

**Security**
- security-1 accepted: fixed at the source in M0 (#123, `/files/*` restricted to `avatars/`), plus
  Bastion's own bucket, random object keys, hash never part of a key, a negative test (sections
  3.3, 8.4, 11.2).
- security-2 accepted: probes as reviewed `SECURITY DEFINER` functions with explicit org
  predicates, a visibility floor per probe, goldens run twice with `BBB_RLS_ENFORCE=1` (section
  3.1).
- security-3 accepted: `rejectWhenImpersonating` on every vouching route, `impersonator_id` on the
  audit log, Playwright story 14 (section 2.8).
- security-4 accepted: decisions re-verified (own proposal id, human decider with the matching
  Bastion permission, not impersonated); internal routes denied at nginx (sections 2.8, 9.2).
- security-5 accepted: deterministic Bolt rule shapes with an action allowlist, LLM writes only
  name and description, pre-scan and delimiting of every cited label, a corpus gate (sections 2.4,
  11.3).
- security-6 accepted: `trustProxy` hops, per-room passcode counter with lock and notify, creator
  authority re-check, frozen restricted allowlist, id scoping to room controls and period,
  `can_access` with the creator as asker (section 5.2).
- security-7 accepted: attachment disposition, sandbox CSP, nosniff, content-type allowlist on
  every byte route including exports (section 5.1).
- security-8 accepted: same fix as design-9; batch byte cap and per-key rate limit added.
- security-9 adapted: personal data split into `bastion_personal_data` with HMAC commitments and
  one owner-only redaction route that writes a ledger entry; access-log purge through a definer
  function rather than exempting the table from the DELETE trigger, so the table stays protected
  against everything except the aged purge (sections 3.4, 4.1).
- security-10 accepted: counts-only explanations without detail rights, restricted titles hidden,
  canonical JSON hash including org and seq, Ed25519-signed seals with an env-held key printed into
  the packet and room (sections 3.1, 3.4).

**Best practices**
- best-practices-1 accepted: fixed as the fact in M0 (#124): one `BOLT_SOURCES` list driving the
  ingest enum, `TRIGGER_SOURCES`, `TriggerSourceV1`, and the pgEnum; migration `0260`;
  `check-bolt-catalog.mjs` extension; an ingest integration test (sections 4.4, 8.4, 12).
- best-practices-2 accepted: Launchpad registration moved to M11 with the marketing section, site
  screenshots, numbered help images, `pnpm docs:readme`; `check:app-completeness` added (sections
  9.6, 11.5, 12).
- best-practices-3 accepted: `returns:` on every tool, the four published count files plus the
  CLAUDE.md line regenerated, `check-tool-return-coverage.mjs` in the gates (sections 5.4, 9.6).
- best-practices-4 accepted: seeder grown per milestone from M3; Skipper-only stories before M10;
  member stories at M10 (sections 10, 11.4).
- best-practices-5 accepted: literal hints for the timeouts and bucket, `secret` hints for the
  salt, signing key, and HMAC key, landed with the catalog entry; `check:env-hints` in the gates
  (section 9.4).
- best-practices-6 adapted: same disposition as security-9 (guarded purge function, stated in the
  `0266` header), chosen over "keep forever" because the access log carries IP hashes that should
  age out.
- best-practices-7 accepted: `bastion.auditor_room.respond` added for row 83; row 63 gated on
  `attestation.read` and caller-scoped (section 5.5).
- best-practices-8 accepted: `withRetention` on every scheduler template, `SCHEDULED_JOB_RETENTION`
  on every follow-on enqueue, queue contracts in `packages/shared/src/schemas/bastion.ts` on
  Bursar's precedent (section 7).
- best-practices-9 accepted: surface-map rows for the internal Bam routes and webhook change,
  generated `can_access` description, agent-conventions types, `bolt.rule` naming (sections 8.3,
  8.4, 9.6).

**Infrastructure**
- infrastructure-1 accepted: #126 fixed in M0 (`syncNew` fills missing hints on existing
  services), `bastion-shared.ts` throws on an unset URL, a post-deploy check (sections 7, 9.4).
- infrastructure-2 accepted: own bucket `BASTION_S3_BUCKET` (default `bigbluebam-bastion`), stream
  plus hash from Bin instead of `copyTo`, and the #123 fix (sections 3.3, 9.1).
- infrastructure-3 accepted: frontend `depends_on` `service_started` and a runtime-resolved
  `proxy_pass` so a dead bastion-api cannot stop nginx (sections 9.1, 9.2).
- infrastructure-4 accepted: only the two hand-maintained confs are edited, the Railway conf and
  `railway/bastion-api.json` are generated and committed, `bastion` added to both regexes, #127
  fixed in M0 (section 9.2).
- infrastructure-5 accepted: duplicate of best-practices-2 and -5, same changes; the salt gets its
  own `secret` hint rather than a `SESSION_SECRET` derivation.
- infrastructure-6 accepted: `TRUST_PROXY_HOPS` (compose 1, Railway 2) with a hint and a
  two-client integration test (sections 5.2, 11.2).
- infrastructure-7 accepted: section 9.7 (object mirror job, missing vs mismatch, `restore` ledger
  entries, `ops.backup_fresh` requires the mirror to be current).
- infrastructure-8 adapted: per-org and service-wide Redis semaphores in bastion-api in front of
  the proxy (rather than BullMQ grouping, which the worker's BullMQ edition does not offer),
  stated throughput, read-replica probes with `SET LOCAL statement_timeout`, a per-org evaluation
  minute offset, the streamed packet in the worker (sections 7.2, 7.3, 9.5).
- infrastructure-9 accepted: the four `packages/storage` Dockerfile lines, `extra_watch_patterns`,
  scan-state mapping, capped retries with `recordWorkerError` (sections 3.3, 9.1, 9.4).
