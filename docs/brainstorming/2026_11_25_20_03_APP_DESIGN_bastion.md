# Bastion - App Design Specification

> **STATUS: BUILD-READY, review rounds 1-3 folded in (final round under the three-round cap).**
> This document is the build input for Bastion. Where it disagrees with the session submission,
> this document wins. Where it disagrees with the monorepo, the monorepo wins and section 15
> records the discrepancy. Every round 1-3 finding has a disposition line in section 16.

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
9. Infrastructure, secrets, backup and DR
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
currently evidence, ranked by audit risk, each with a drafted fix. Setup work is visible as its
own count ("41 of 64 controls checked; 23 not set up yet") next to the four numbers, and after a
14-day grace period unassessed controls enter the ranked list at low severity (section 2.3), so
nothing silently drops out of view.

**Test once, comply many.** Controls are org-level. SOC 2 and ISO 27001 requirements map onto the
same internal controls through a static crosswalk, so one MFA report, one Bam task, and one
evidence trail serve both frameworks. Applicability is decided **per requirement**, so the ISO
Statement of Applicability can exclude a requirement that SOC 2 still needs (section 2.1).

### 1.3 Honest scope: the suite cannot see everything

Seat E's recorded reservation is correct and the design treats it as a first-class requirement:
much SOC 2 evidence lives outside the suite (cloud infrastructure, device management, HR
systems, the identity provider). Bastion answers it three ways (section 3.3):

1. **Uploaded and manual evidence is a first-class path**, held to the same rules as native
   evidence: immutable copy, SHA-256 hash, a named owner, a coverage period, an expiry, a
   citation, a second-person review, and a place in the same tamper-evident ledger.
2. **Machine feeds** let an external system push records with a per-feed credential, frozen the
   same way.
3. **The coverage graph never blends sources or risk.** The home screen reports four separate
   numbers (proven by the suite, proven by evidence you provided, not met, can't prove yet) plus
   "not set up yet". Accepted exceptions count under **Not met** with a "risk accepted" sub-count;
   they are never counted as proof.

### 1.4 Category boundary (adjacent, not on top)

| App | Object | Counterparty | Bastion's relationship |
| --- | --- | --- | --- |
| **Bulwark** | Clause owed under an executed contract | Customer or vendor | None. Bastion never reads contracts. |
| **Bursar** | Vendor offers and spend | Vendors | Optional read-only probe input: "critical vendors have an award on file" (CC9.2). No writes. |
| **Beacon** | Knowledge articles, verification | Staff | Bastion links policy articles and records who attested to which version. Beacon remains the editor. |
| **Bam** | Tasks, GitHub integration | Team | Remediation tasks via a new internal route; PR review events from a new Bam-owned ledger. |
| **Bin** | Files | Team | Upload path for manual evidence (reuses Bin upload and AV scan); Bastion copies bytes into its own bucket. |
| **Bay** | Media review guest links | External reviewer | The auditor room borrows the guest-link pattern, hardened (section 5.2). |

**The enforceable boundary:** Bastion writes zero rows in any other app's tables. Its only
cross-app writes go through api-owned internal routes (Bam tasks and comments; closing the
platform proposals it mirrors) and the platform `entity_links` and `agent_proposals` inserts.
Policy and Bolt rule drafts are applied by a human under that human's own session.

### 1.5 Cadence

Daily background value (nightly evaluation, drift tasks) plus episodic spikes (an incoming
questionnaire, an audit window). The retention mechanism is the drift task in Bam and the weekly
`readiness.weekly` Bolt event an org can route to Banter, deliverable once the platform Bolt
source list includes `bastion` (milestone M0, issue #124).

---

## 2. AI-native design

Bastion has four AI mechanisms. Each has a deterministic core; the LLM only fills in the parts
where language is the work. **The LLM never writes SQL, never decides a control's status, never
chooses a Bolt action, and never sends anything outside the org unattended.**

### 2.1 Controls, frameworks, and the compiler

**Org-level controls with a requirement mapping.** The library in
`apps/bastion-api/src/library/` defines:

- `controls.ts`: the internal control catalog, each with a stable `control_key` (for example
  `access.offboarding`, `change.peer_review`, `auth.mfa`), a plain title and summary, a category, a
  `risk_weight` (1-5), `suggested_assertions[]`, and `suggested_manual_evidence[]`.
- `soc2.ts`, `iso27001.ts`, `starter.ts`: each framework's requirement list as
  `{ ref_code, title, plain_summary, control_keys[] }`. This is the static SOC 2 to ISO 27001
  crosswalk: two requirements naming the same `control_key` share one internal control.

Adopting a framework creates `bastion_controls` rows only for `control_key`s the org lacks, and
always creates `bastion_control_requirements` rows linking controls to that framework's
`ref_code`s. Assertions, evidence, gaps, exceptions, and Bam tasks stay single. Every list and the
summary take `?framework_id=` to show one framework's view.

**Applicability is per requirement (the ISO Statement of Applicability).**
`bastion_control_requirements` carries `applicability` (`applicable`, `not_applicable`) and a
required `not_applicable_reason`. A control counts in a framework's view only through its
applicable links. Its org-level applicability is derived: `not_applicable` only when every link
is. Bastion generates `statement_of_applicability.csv` (ref_code, title, applicable,
justification, implementing control, current status) for ISO frameworks, served by row 8, shown in
the auditor room, and included in the packet. An ISO packet cannot be built until every Annex A
requirement has an applicability decision (unit-tested).

**Archiving a framework** retires every control whose only links were to that framework
(`lifecycle = 'retired'`): retired controls leave all numbers, gaps, and evaluation, and keep
their history. A control whose derived applicability is `not_applicable` (every requirement link
excluded) is treated the same way: its assertions are **not evaluated** and produce no snapshots
until a link becomes applicable again.

Why the shared-control model (round-1 option b) fits: the library already carries a per-control
key and per-requirement `ref_code`, the second framework is the stated customer journey, and the
cost is one mapping table with per-link applicability. The crosswalk is a judgement; it ships as
reviewed code with a completeness test (every requirement maps to at least one control) and an
admin may add or remove a requirement link (audited).

Org-authored **custom controls** are allowed (`control_key = 'custom:<slug>'`). Custom frameworks
extracted from a document by the LLM are v1.1.

**The compile flow (built-in frameworks only in v1):**

1. **Company profile interview.** Ten plain questions.
2. **Tailoring (LLM, optional).** For each new control the compiler sends the control summary, the
   profile, the list of connected sources, and the probe catalog (section 3.1) as a closed menu.
   The model returns JSON: probe keys, parameters (including a proposed `expected_population`),
   thresholds, a manual-evidence spec, or a per-requirement "not applicable" with a reason.
3. **Validation (deterministic).** Probe keys must exist; parameters must pass the probe's Zod
   schema; thresholds must sit in range. Anything else is dropped with a recorded reason.
4. **Everything lands as `proposed`.** A human confirms each assertion, including the required
   **"This is the complete list"** confirmation on any population (stored as
   `population_confirmed_at` and `population_confirmed_by` in the params).
5. **Deterministic fallback.** With no LLM, the library's suggestions are proposed verbatim and
   the population is proposed from the connected set; the wizard requires the person to confirm
   completeness or add members.

Confirmed assertions are content-immutable; an edit creates a superseding `proposed` row.

### 2.2 The nightly evaluator

Fully deterministic. For each confirmed assertion it evaluates the probe, manual evidence, or
feed, writes a canonical evidence document, hashes it, and appends it to the ledger. **A control
is aggregated in whichever slice writes its last missing snapshot for the run**, and its status is
written with a conditional update (section 7.3). Stored status is the worst of its assertions
(`fail` > `unprovable` > `pass`). Readers never use stored status directly; they call
`effectiveStatus` (section 3.2), which applies exceptions and staleness. Infrastructure failures
never count as compliance failures.

### 2.3 The coverage graph, the numbers, and gap ranking

The graph is `control -> assertion -> evidence source`, where a source is `native` (probe),
`feed`, `manual_file`, `self_attested`, or `none`. Each control gets a `coverage_kind`.

**Effective states** (from `effectiveStatus`): `pass`, `pass_with_exception` (UI: **"Not met,
risk accepted"**), `fail`, `unprovable`. `pass_with_exception` means the raw outcome failed and
every failing item is covered by an active, approved exception.

**The numbers (authoritative rule).** Over active controls with at least one applicable
requirement link in the selected framework view:

| Number | A control counts here when |
| --- | --- |
| Proven by the suite | effective `pass` and every passing assertion is `native` or `feed` |
| Proven by evidence you provided | effective `pass` and any passing assertion is manual or self-attested (includes `mixed`) |
| Not met | effective `fail` **or** `pass_with_exception`; shown as "Not met: 6 (1 risk accepted)" |
| Can't prove yet | effective `unprovable` |
| **Not set up yet** (shown beside the four) | no confirmed assertion, or every assertion rejected |

The headline always carries its denominator ("41 of 64 controls checked; 23 not set up yet") on
Readiness, in `bastion_coverage_summary`, in `readiness.weekly`, in the packet, and in the
auditor room (where unassessed controls show as **"Not assessed"**). `not_applicable` controls are
excluded and listed separately.

**The gap mapping (the one authoritative table).** Implementations must not invent another
mapping; `BASTION_SEED_EXPECTATIONS` asserts it.

| Condition | `gap_kind` | Severity | Default fix template |
| --- | --- | --- | --- |
| effective `fail` | `failing` | 1.00 | by probe (`config_change`, `bolt_rule`, `process_change`) or `evidence_request` for manual `shows_exception` |
| `unprovable / no_evidence_source` | `no_source` | 0.90 | `evidence_request` |
| `unprovable / manual_evidence_expired` | `manual_expired` | 0.85 | `evidence_request` |
| `unprovable / source_not_connected` | `not_connected` | 0.80 | `connect_source` |
| `unprovable / manual_evidence_missing` | `manual_missing` | 0.80 | `evidence_request` |
| population probe returns unlisted members | `population_drift` | 0.70 | `config_change` ("Add 'Coral Reef Booking' to the repositories Bastion checks"); approval files a superseding assertion for one-click confirmation |
| `unprovable / probe_error` (second distinct night) | `check_broken` | 0.60 | none (operator issue, `recordWorkerError`) |
| `unprovable / insufficient_data` | `insufficient_data` | 0.40 | none (informational) |
| population confirmed more than 180 days ago | `population_review` | 0.40 | `confirm_check` |
| no confirmed assertion, adopted more than 14 days ago, or all assertions rejected (no grace) | `not_assessed` | 0.30 | `confirm_check` |
| effective `pass` with manual evidence in the warning window | `manual_expiring` | 0.50 x (1 - days_left / warn_window) | `evidence_request` |
| effective `pass` with only self-attested evidence | `attested_only` | 0.54 (0.90 x 0.6) | `evidence_request` |
| `pass_with_exception` | (no gap; listed under "Accepted risks" with owner and expiry) | n/a | n/a |
| `unprovable / evaluation_stale` | **org-level only**: one derived `stale` row computed at read time from `effectiveStatus`, never stored, never per control | n/a | none (Readiness banner + `evaluation.missed`) |

```
risk = control.risk_weight (1..5) x severity x audit_proximity
audit_proximity = 1 + max(0, 90 - days_to_nearest_audit_target) / 90
```

Fix template costs: `confirm_check` 1 (deterministic link to the review screen), `config_change`
1, `connect_source` 2, `bolt_rule` 2, `evidence_request` 2, `policy_draft` 3, `process_change` 5.
One override: a `population_review` gap carries cost 2 although its template is `confirm_check`,
so 180-day re-confirmations do not outrank real failures under "Quick wins".
Sort by risk descending, cost ascending; "Quick wins" sorts by `risk / cost`. The LLM never sets
risk or picks the template.

### 2.4 Fix drafting and deciding

For a selected gap, Bastion files a mirrored platform proposal (`agent_proposals`) with
`proposed_action = 'bastion.fix.<template>'`, `owning_app = 'bastion'` (issue #128 column),
`require_human_decider = true`, approver = the control owner (fallback: an org admin),
`expires_at` = now + 14 days. The draft lives in `bastion_fix_drafts`.

**Every Bastion proposal is decided inside Bastion** (`POST /fix-drafts/:id/decide`, section
2.8). The platform's generic decide route returns 409 `DECIDE_IN_APP` for `owning_app =
'bastion'` with a link to the Bastion review screen.

| Template | What is drafted | What happens on approval |
| --- | --- | --- |
| `confirm_check` | Deterministic link | none beyond opening the review screen; the human confirms assertions there |
| `evidence_request` | LLM: a plain request to the named owner, with an example | Bam task to the owner (via the outbox) |
| `policy_draft` | LLM: Markdown policy text | **Create in Beacon as a draft** (approver's session); `mark-applied` records it |
| `bolt_rule` | **Deterministic** shape from `library/bolt-rule-shapes.ts` keyed by `(gap_kind, probe_key)`; actions only `create_task` (compliance project) and `banter_post` (internal channel); LLM writes only name and description; `send_webhook` and `send_email*` rejected | **Create in Bolt (turned off)** under the approver's session |
| `connect_source`, `config_change` | Template text with exact steps or values | Human does it; the next evaluation proves it. For `population_drift`, approval also files the superseding assertion |
| `process_change` | LLM: a short procedure plus the manual evidence it will produce | Files a `proposed` manual assertion (still needs confirmation) |

Every cited label passes the injection pre-scan
(`apps/bursar-api/src/lib/injection-prescan.ts`) and is delimited as data before it enters a
prompt. Citations pass `can_access` at write and at read.

### 2.5 Drift handling

Worsening stored status for a non-infrastructure reason, or a worsening of effective state caused
by an exception expiring or being revoked (section 2.6), writes a `bastion_drift_events` row and,
in the same transaction, outbox rows (`ordering_key = 'control:<id>'`) for `control.drifted` and
the Bam task upsert. One task per control (`external_id = 'bastion:control:<control_id>'`); if
it sits in a terminal phase (`phases.is_terminal`), the route moves it to the start phase and
comments "Drifted again on {date}: {reason}". Comments address the task by `external_id`, so they
never depend on an earlier delivery's result. On recovery Bastion publishes `control.recovered`
and comments; it never closes the task.

A compliance project is a required setup step (**Create a "Compliance" project for me** or **Use
an existing project**); while unset, Readiness shows a banner and drift rows record
`task_status = 'no_project'`. `remediation_tasks` is `create` (default) or `propose`.

### 2.6 Exceptions (accepted risk)

A `bastion_exceptions` row names one control, optionally one assertion and one cited entity, a
reason, a compensating-control note, and `expires_at`. **Scope and limits:**

- **Single-entity exceptions** (one cited ref, for example the long-lived "Radio Relay" service
  key) may last up to 365 days.
- **Assertion-wide exceptions** may last up to 90 days, and cover only the refs failing at
  approval, frozen on the row as `frozen_refs`. A new failure after approval is not covered.
- **Approver differs from proposer.** The control owner proposes or is notified; a human holding
  `bastion.exception.approve` decides in Bastion (`POST /exceptions/:id/decide`). In orgs with
  fewer than three humans the proposer may approve, labelled "approved by the proposer (small
  team)" everywhere the exception appears.
- Approved exceptions are immutable and ledgered (entry kind `exception`).

**Effects.** Snapshots keep the raw outcome. The effective state becomes `pass_with_exception`,
counted under **Not met** with the "risk accepted" sub-count, never as proof. It creates no
`failing` gap but appears under "Accepted risks". The owner and expiry are shown on every surface
that shows the control. The questionnaire caps answers citing it at `medium` and the draft names
the exception. The auditor room and `exceptions.csv` show it.

**Approval and expiry reach the task queue.** On approval, Bastion comments on the control's Bam
task ("Risk accepted until {date}: {reason}") through the outbox. When an exception expires (or is
revoked) and the control's effective state worsens, `bastion-evidence-expiry` writes a
`bastion_drift_events` row with reason `exception_expired` and, in the same transaction, outbox
rows for `control.drifted` and the task upsert, using the reopen-to-start-phase rule with the
comment "Accepted risk expired on {date}". It also publishes `exception.expired`.

### 2.7 Security-questionnaire autofill

1. A questionnaire file (xlsx or csv) arrives as a Bin asset, optionally linked to a Bond deal.
2. **Parse (deterministic)** with `@bigbluebam/structured-data` (csv now; xlsx is a new codec) and
   a column-mapping step.
3. **Pre-scan** every question; a suspect row is forced to `low`.
4. **Retrieve (lexical)** with Postgres full-text search over the answer library, control
   summaries, confirmed assertion statements, and linked policy titles.
5. **Draft (LLM)** citing candidate ids only.
6. **Verify and band (deterministic).** Cited ids must be in the retrieved set and pass
   `can_access`. Any cited control whose effective state is `fail` or `unprovable` forces `low`;
   `pass_with_exception` caps at `medium` and the draft says "accepted exception: {reason}".
   Bastion never drafts a confident "Yes" it cannot prove.
7. **Review and approve.** `low`/`medium` rows go to the review queue; a floored, non-impersonated
   **Approve** precedes export (formula-neutralized, `packages/shared/src/csv-safe.ts:26-66`).
8. **Learn.** Approved answers enter `bastion_answer_library`, marked stale when a cited control's
   **stored** status changes (not on `evaluation_stale`, which is computed at read time, so one
   missed night cannot stale the whole library).

### 2.8 What agents may do, and guardrails

| Action | Autonomous | Needs a human |
| --- | --- | --- |
| Read controls, status, coverage, gaps, drift, exceptions, evidence summaries | yes (counts-only unless the asker may see detail) | |
| Verify evidence | yes | |
| Run a compile (proposals only) | yes | confirming |
| Propose an assertion | yes | confirmation |
| Run an evaluation (1 full run per org per hour; 1 control run per control at a time) | yes | |
| Draft questionnaire answers | yes | approve and export |
| Propose a fix or an exception | yes | **a human decides inside Bastion** |
| Upload, withdraw, redact evidence; acknowledge a restore | no tool | a human |
| Sign a policy attestation | **never** | the person, not impersonated |
| Rooms, settings | no tool | floored humans |

**Guardrails.**

- **Agent policies** via `registerTool` (`apps/mcp-server/src/lib/register-tool.ts`); fail closed
  until an operator allowlists `bastion.*`.
- **`asker_user_id` narrows, never widens** (`bursar-tools.ts:19-28`).
- **Decisions are made where the rule is enforced (issue #128, both halves).**
  1. *Platform fact, M0:* a migration adds `decided_by`, `decided_by_kind`,
     `decided_impersonator_id`, `owning_app`, and `require_human_decider` to `agent_proposals`.
     `proposals.routes.ts` sets the three decision columns on every decide, rejects a non-human
     or impersonated decider when `require_human_decider` is true, and returns 409
     `DECIDE_IN_APP` when `owning_app` is set. Every other proposal consumer benefits.
  2. *Bastion:* `POST /fix-drafts/:id/decide` and `POST /exceptions/:id/decide` run `requireCan`
     (`fix.decide` plus the control-owner-or-`control.write` rule; `exception.approve` plus
     approver-differs-from-proposer), `rejectWhenImpersonating`, and `request.user.kind ===
     'human'`. Bastion then closes the mirrored proposal through the api-owned internal route
     `POST /internal/bastion/proposals/:id/close` (via the outbox), which records the decider in
     the #128 columns and emits the platform `proposal.decided`. Bastion **ignores** any
     `proposal.decided` for a `bastion.*` action whose decision it did not make, records
     `decision_rejected` on the row, and raises a worker error.
- **Impersonation cannot vouch.** `rejectWhenImpersonating` (403 `IMPERSONATION_NOT_ALLOWED`) on
  attest, manual-evidence create and supersede, link review, assertion confirm and reject, both
  decide routes, questionnaire approve, auditor-room create, revoke and unlock, redaction, and
  restore acknowledgement. Every other write records `impersonator_id`.
- **Visibility preflight** on every citation, at write and at read.
- **Closed probe menu**, probe SQL in hardened definer functions (section 3.1).
- **Internal routes unreachable from outside**: `location ~ ^/bastion/api/v1/internal/ { return 404; }`.
- **No outbound transport.**

---

## 3. The evidence engine

### 3.1 The probe catalog (native evidence)

**Where the SQL lives, and how it is hardened.** Under `BBB_RLS_ENFORCE=1`,
`0116_rls_foundation.sql:97-104` hides sessions of users with no membership in the current org,
so a probe inside `runInOrgScope` would pass `access.departed_still_holding` exactly when it
should fail. Probes therefore run as `SECURITY DEFINER` functions from migration
`0268_bastion_probe_functions.sql`: `bastion_probe_<key>_v<n>(org uuid, as_of timestamptz,
params jsonb) RETURNS jsonb`. These are the first definer functions in the repo (the `0143`
precedent deliberately avoids them), so each one, in the same file:

- is `STABLE` with `SET search_path = pg_catalog, public, pg_temp` (`pg_temp` last);
- is followed by `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, leaving owner execute (the owner is
  the migrating `POSTGRES_USER`, which is also the role every service connects as today), and a
  guarded grant for the future non-superuser role, which does not exist yet (`bam_app` is only a
  default name in `apps/api/src/boot/rls-boot.ts`, created by nothing):
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bam_app') THEN GRANT EXECUTE ON
  FUNCTION ... TO bam_app; END IF; END $$;` so `0268` never aborts on a database without that role;
- raises unless `org = current_setting('app.current_org_id', true)::uuid`, so callers must be
  inside `runInOrgScope` for that same org and a definer function cannot be pointed at another
  tenant;
- carries an explicit org predicate in every query.

An integration test asserts `proconfig` (the search_path) on every `pg_proc` row named
`bastion_%`, and that `proacl` grants no `PUBLIC` execute; it accepts the owner-only ACL (today's
real posture) and an ACL that additionally grants `bam_app` when that role exists.
A new probe version is a new function in a new migration. `query_fingerprint` is the SHA-256 of
`pg_get_functiondef(oid)` read at boot. (The round-1 "visibility floor" compared the definer path
with itself and could never fail; it is removed.)

The TypeScript side (`apps/bastion-api/src/probes/<key>.ts`) exports `{ key, version,
paramsSchema, preconditions(), explain(result, detailAllowed) }` and calls the function through
**`runInOrgScopeRead(orgId, fn)`**, a read-pool twin of `runInOrgScope`
(`apps/bursar-api/src/plugins/rls.ts:58-68` binds only the primary pool): it runs `BEGIN READ
ONLY`, `set_config('app.current_org_id', org, true)`, and `SET LOCAL statement_timeout =
BASTION_PROBE_TIMEOUT_MS` on the `DATABASE_READ_URL` pool (falling back to the primary pool when
unset), so the org guard passes on the read connection. It first measures replica lag (`as_of -
pg_last_xact_replay_timestamp()`); a NULL replay timestamp (the read URL is the primary, as the
Railway hint at `env-hints.mjs:90-94` sets it) counts as zero lag; above 30 seconds it runs on the
primary. A replica recovery-conflict cancellation is a
non-drifting infrastructure failure. Replica lag is recorded on the snapshot. Every probe reads
`run.as_of`, never `now()`.

**Population rule.** Population probes take a human-confirmed `expected_population` and return
both the members checked and `population_unlisted` (connected but not expected). Unlisted members
open a `population_drift` gap; a population confirmed more than 180 days ago opens
`population_review`. Every `explain()` and snapshot states the population checked.

**Precondition rule.** No precondition may be satisfiable only by the control operating.

| Key | Source (verified in repo) | Precondition (else `unprovable`) | Default predicate | Cited refs |
| --- | --- | --- | --- | --- |
| `keys.max_age` | `api_keys` (`org_id`, `created_at`, `rotated_at`) | none | no key older than 90 days since `coalesce(rotated_at, created_at)` | key ref |
| `keys.unused_active` | `api_keys.last_used_at` | none | no key unused for 60+ days | key ref |
| `access.departed_still_holding` | `users`, `organization_memberships`, `api_keys`, `sessions.active_org_id` | none | zero departed people still hold a key or live session | person ref |
| `access.dormant_accounts` | `organization_memberships`, `login_history` (joined via `user_id`), `sessions.last_used_at` | none | zero human members with no sign-in for 90 days | person ref |
| `access.privileged_roster` | `organization_memberships.role`, `users.is_superuser` | none | at most 3 owners/admins | person ref |
| `auth.failed_login_spikes` | `login_history` | none | 0 hours with 10+ failures for one account | person ref, hour |
| `agents.policy_coverage` | `users.kind`, `agent_policies` | none | every agent has a policy row, no bare `*` allowlist | agent ref |
| `agents.human_approval` | `agent_proposals` (incl. the #128 decider columns) | none | at most 5 expired undecided in 30 days, and every decided proposal with `require_human_decider` has `decided_by_kind = 'human'` | proposal ref |
| `change.merge_reviewed` | **new** `github_pr_events`, `github_integrations.subscribed_events` | every expected repo has an enabled integration | 100% of default-branch merges had a non-author approval before merge. `subscribed_events` NULL is **unknown**, not "not subscribed": the predicate still runs, zero-approval merges yield `fail`, and `explain()` adds "we could not confirm GitHub sends review events; in GitHub open the webhook's Recent Deliveries and click Redeliver on the ping". Subscribed list known and lacking `pull_request_review` is `source_not_connected` | PR ref |
| `change.merge_traceable` | `github_pr_events.task_refs` | every expected repo integrated | at least 90% of merges reference a Bam task | PR ref |
| `ops.backup_fresh` (inherited) | `platform_backups` + the Bastion off-site mirror status (section 9.7) | **off-site evidence backup configured** (else `source_not_connected`) | a completed backup within 26 hours whose mirror is current (zero backups is `fail`) | counts only |
| `ops.restore_tested` (inherited) | `platform_restores` | none | a completed restore within 365 days | counts only |
| `logging.retention_floor` | `blip_retention_policies` + `blip_tracked_apps` | every expected app is tracked | at least 90 days (null = unlimited) | tracked app ref |
| `logging.audit_trail_alive` | `v_activity_unified` | none | activity in the last 7 days | counts only |
| `automation.failure_rate` | `bolt_executions` + `bolt_automations` | none (no automation is `insufficient_data`) | at most 5% failed in 30 days | automation ref |
| `policy.attested` | `bastion_policy_attestations` | a linked policy | 100% of required people attested to the current version within cadence | person ref |
| `policy.current` | `beacon_entries` (`status`, `visibility`, `expires_at`, `last_verified_at`) | a linked policy | Active, org-visible, not expiring within 30 days, verified within 365 days | article ref |
| `platform.superuser_access` | `superuser_audit_log.target_org_id` | none | informational; at most N actions in 30 days | action, date |
| `vendors.critical_have_award` | `bursar_vendors`, `bursar_awards` | none | every critical vendor has an active award | vendor ref |
| `feed.fresh` | `bastion_feed_records` | the feed exists | a record within cadence, optional count predicate | feed record ref |

**Inherited controls** are labelled "Provided by your hosting platform" (section 15.3).
**No native probe, and says so:** MFA (the platform has none), device encryption, cloud
configuration, background checks, physical security, GitHub branch protection.

**Personal data.** Cited refs in the hashed document are `{ entity_type, entity_id }` only; labels
live in `bastion_personal_data` (section 3.4). `explain()` is counts-only unless the viewer holds
`read_detail` or owns the control.

### 3.2 Outcomes, reason codes, staleness

Stored statuses: `pass`, `fail`, `unprovable` (UI: **Proven**, **Not met**, **Can't prove
yet**; the effective state `pass_with_exception` reads **Not met, risk accepted**). Every
`unprovable` carries one reason:

| Reason | Plain UI text |
| --- | --- |
| `not_yet_confirmed` | "Nobody has confirmed how to check this yet." (Not set up yet count) |
| `no_evidence_source` | "Nothing in the suite can show this. Upload evidence or connect a source." |
| `source_not_connected` | "This could be checked automatically, but {source} isn't connected." |
| `manual_evidence_missing` | "Waiting for {owner} to upload {what}." |
| `manual_evidence_expired` | "The evidence {owner} uploaded expired on {date}." |
| `insufficient_data` | "There wasn't enough activity in the period to tell." |
| `probe_error` | "The check couldn't run. We'll try again tonight." |
| `evaluation_stale` (computed) | "This hasn't been checked since {date}, so we can't vouch for it." |

**`effectiveStatus(control, now)`** is the only way any reader obtains a status. It returns
`unprovable/evaluation_stale` when `last_evaluated_at` is older than `stale_after_hours` (36).
Otherwise it works **per assertion, then aggregates**: each confirmed assertion's latest outcome
becomes `pass_with_exception` when it failed and active exceptions cover all of its failing refs
(or the whole assertion, within `frozen_refs`); the control's effective state is the worst over
its assertions in the order `fail` > `unprovable` > `pass_with_exception` > `pass`. So a covered
failure next to an unprovable sibling reads **Can't prove yet**, and gaps are computed per
assertion from the same per-assertion states (the sibling's `manual_missing` gap stays on the
list).

**Infrastructure failures do not drift.** A `probe_error`, storage write failure, lock timeout, or
replica conflict keeps the previous stored status and sets `stale_reason`.
`consecutive_error_nights` counts **distinct `nightly_for_date` values** with a `probe_error`
(manual runs do not count) and resets on any success; only a second distinct night changes status
to `unprovable/probe_error`. Bucket unavailability ends the slice without writing and leaves the
run resumable (section 7.3). `bastion-evaluation-missed` fires once per org per missed period:
its outbox row is keyed `evaluation_missed:<org>:<last_completed_at>`.

### 3.3 Uploaded and manual evidence (the answer to Seat E)

| Kind | Example | Trust level shown |
| --- | --- | --- |
| `file` | Google Workspace 2-Step Verification report, AWS IAM credential report, a pen-test PDF | "Uploaded evidence" |
| `attestation_statement` | "All six laptops have FileVault on. Checked by the Professor on 2026-11-02." | "Self-attested" |
| `feed_record` | Records pushed by a machine feed | "Automated feed" |

**Upload path.** The SPA uploads to Bin (so `bin-av-scan` runs), then calls
`POST /manual-evidence`. bastion-api applies the four checks of `assertBinAssetReadable`, pins
`current_version_id`, and streams the pinned bytes, hashing as it goes, into Bastion's own bucket
under a random key. Before each `put`, it inserts a `bastion_object_intents` row; the intent is
deleted in the same transaction that inserts the object row (section 3.4).

**Scan states:**

| Bin `scan_status` | Bastion outcome |
| --- | --- |
| `clean` | copy at attach |
| `skipped` | copy at attach; labelled "Not virus-scanned (scanning is off on this installation)" |
| `pending` | `pending_scan`; retried with backoff; after 24 h it surfaces in the review queue, automatic retries drop to once a day, and the review-queue **Check again** retries immediately |
| `infected` | `blocked`, `infected` |
| `error` | `blocked`, `scan_failed`, plain message |

An asset that moved to a newer version before the pinned version was copied is `blocked` with
`changed_before_scan`.

**Required metadata** (what, source system, owner, produced, period, restricted?, uploader
statement). `valid_until` is an end-of-day instant in the org timezone from the shared
`endOfDayInTz` helper.

**Evaluation of a manual assertion.** `pass` if at least one `active` linked item is current,
covers the window, and is `accepted` by a reviewer other than the uploader (under three humans,
self-acceptance is allowed and labelled). `shows_exception` yields `fail`. Otherwise
`unprovable`.

**Withdrawal and redaction.** Withdraw sets `withdrawn` and writes a ledger entry. **Redacting a
manual-evidence holder sets its status to `withdrawn` with reason `redacted` in the same
transaction** and enqueues control-scope runs for every linked assertion, so the control drops to
"Can't prove yet" unless another item covers it. Redacting snapshot or attestation labels does
not change outcomes; the commitment remains.

### 3.4 Immutability, the ledger, seals, restores, personal data

**Canonical form** (`apps/bastion-api/src/lib/ledger-canonical.ts`, shared by writer and
verifier):

```
entry_hash = hex_lower( sha256( canonical_json({
  org, epoch, seq, kind, id, content_sha256, personal_data_hmac, pd_hmac_key_id, prev, recorded_at
}) ) )
```

Sorted keys, no whitespace, integers as JSON integers, `recorded_at` set in the application and
stored truncated to milliseconds as UTC ISO with `Z`, `prev` lowercase hex (genesis: 64 zeros).
`epoch` starts at 1 and increments when a restore is detected (a provisional epoch, below). A golden test round-trips
rows through Postgres.

- Appends are serialized per org with `pg_advisory_xact_lock`, under `SET LOCAL lock_timeout =
  '3s'` (a timeout ends the slice cleanly), with no outbound HTTP inside.
- **Four-path immutability** (`0249_bursar_awards_baseline.sql` pattern: `BEFORE UPDATE` with a
  `WHEN` clause naming the protected columns, `BEFORE DELETE`, `ON DELETE RESTRICT`, `BEFORE
  TRUNCATE`). Protected columns per table: `bastion_evidence_snapshots` (all);
  `bastion_evidence_objects` (`content_sha256`, `object_key`, `size_bytes`, `content_type`,
  `created_at`; `holder_count`, `mirrored_at`, `bytes_redacted_at` change in normal operation);
  `bastion_manual_evidence` (every column except `status`, `blocked_reason`, `attempts`,
  `next_attempt_at`, `superseded_by_id`, `withdrawn_*`, `redacted_at`, `updated_at`);
  `bastion_feed_records` (all); `bastion_policy_attestations` (all); `bastion_exceptions` (every
  column except `status` and `updated_at` once `active`); `bastion_ledger_entries` (all);
  `bastion_ledger_seals` (every column except `object_written_at`, `published_at`). DELETE is
  rejected on all of them, except that `bastion_evidence_objects` rows are never deleted (redaction
  sets `bytes_redacted_at`).
- **Shared objects are reference-counted.** `bastion_evidence_objects` is content-addressed, so
  identical bytes are stored once; redaction deletes bytes only when the last non-redacted holder
  of that object is redacted.

**Seals.** `bastion-ledger-seal` writes a `bastion_ledger_seals` row per org per UTC day
(`epoch`, `head_seq`, `head_hash`, Ed25519 `signature`, `signing_key_id`) and outbox rows
(`ordering_key = 'seal:<org>'`) that (1) write the same signed seal as an object
`seals/<org>/<seal_date>.json` in the Bastion bucket and (2) publish `ledger.sealed`. The bucket
object survives a database restore. `GET /ledger/seals` and the packet publish **every**
`signing_key_id` with its public key, so old seals stay verifiable after a key change.

**Restore detection (by identity, never automatically benign).** The check compares
**identity, not position**: the database entry at the highest bucket-sealed `(epoch, head_seq)`
must exist and its `entry_hash` must equal that seal object's `head_hash`. The highest seal is
taken across **all** seal objects for the org, not the newest by date. The check runs:

- at boot;
- at the start of **every ledger-append batch** (an evaluation slice, a manual-evidence or feed
  write, an attestation, an exception), cheaply: the verified seal is cached per org and
  re-checked when a newer seal object appears or when `max(platform_restores.completed_at)`
  changes, so an in-place restore from the Backup app (`apps/worker/src/worker.ts:2676-2706`, no
  bastion-api restart) is caught on the next append;
- in every seal run.

On a mismatch or a missing entry:

1. A `bastion_ledger_restores` row is opened with the lost range, and the range is also written as
   an object `restores/<org>/<id>.json` in the Bastion bucket, so it survives a further database
   rewrite. `ledger.restore_detected` is published; the object sweep pauses for the org.
2. **A provisional epoch opens immediately**, whatever the eventual status: the next entry uses
   `epoch = highest_sealed_epoch + 1` and `seq = highest bucket-sealed head_seq + 1`, so no sealed
   `(epoch, seq)` is ever reused, even while waiting for acknowledgement and even if the gap is
   never explained.
3. **While a restore row is `pending_ack` or `unmatched` and not yet reconciled, ledger appends
   for that org are blocked**: the running evaluation slice ends and the run goes `partial` with
   reason `restore_pending`, which the normal resume logic picks up once the row is resolved.
   Reads, verification, and the auditor room keep working.
4. If a completed `platform_restores` row lines up with the gap, the row is `pending_ack`. A
   non-impersonating **owner** acknowledges it (`POST /ledger/restores/:id/acknowledge`); a
   `restore` ledger entry is appended as the first entry of the provisional epoch,
   `ledger.restored` is published, and appends resume. Acknowledgement changes the label from
   "Unexplained gap" to "History lost by restore"; it never changes numbering.
5. With no matching restore record, the row is `unmatched` and `evidence.integrity_failed` is
   published. An owner can **resume appends** under the provisional epoch (a separate,
   confirm-gated, non-impersonated action on the same route with `resolution = 'continue_unexplained'`),
   but the gap stays labelled "Unexplained gap" forever.

**The seal run refuses to sign a head below the highest bucket-sealed `(epoch, head_seq)`**, so a
rewound ledger can never produce a "newer" seal that makes the gap look normal. The auditor room
and packet show every lost range, read from the bucket objects, as "History lost by restore,
epoch E seq X-Y" or "Unexplained gap, epoch E seq X-Y".

Expected behavior, recorded so nobody files it as a bug: seal objects are written through the
outbox, so if the database is restored before the newest seal object was delivered, detection
works against the previous seal object and reports a wider lost range.

**Verification** walks from an entry to the next seal and reports `intact`, `hash_mismatch`,
`object_missing`, `redacted`, `pd_mismatch` (personal-data commitment no longer matches), or
`key_changed` (the row's `pd_hmac_key_id` is not the current key). `object_missing` is an
infrastructure event for alerting, and is shown to the auditor as **"Evidence file missing"**;
it is never hidden. Rendering also checks the personal-data commitment and shows `pd_mismatch`.

**Personal data** lives in `bastion_personal_data` (mutable); immutable rows carry only
`personal_data_hmac` and `pd_hmac_key_id`. One owner-only, confirm-gated, non-impersonated
redaction route blanks the data, applies the manual-evidence rule above, and appends a
`redaction` ledger entry.

**Access-log purge.** `bastion_auditor_access_log` rejects UPDATE and TRUNCATE; its DELETE
trigger allows only rows with `accessed_at < now() - interval '2 years'`. The definer function
`bastion_purge_access_log(org)` is the documented caller, but **the age predicate is the guard**:
any session can set a custom GUC, and every service shares one role today, so a caller check would
be theatre. A test asserts a direct `DELETE` of a recent row fails regardless of session settings.

**Honest limit.** Triggers, the chain, and off-database signed seals make tampering detectable,
not impossible. WORM storage is v1.1.

### 3.5 Machine feeds

- **Contract** `bastionFeedRecordSchema` in `packages/shared/src/schemas/bastion.ts`; subject and
  attributes go to `bastion_personal_data`.
- **Per-feed credentials** (Blip's ingest-key pattern): `bastion_feed_keys` with public `key_id`,
  `secret_hmac` keyed by `BASTION_FEED_KEY_PEPPER` (a stable secret, section 9.4), shown once,
  7-day rotation grace, recorded on every record as `feed_key_id`.
- **Pre-org lookups** go through definer resolvers `bastion_resolve_feed_key(key_id)` and
  `bastion_resolve_room(token_sha256)` returning only `(id, org_id)`, hardened like the probes
  (minus the org guard), so they still resolve under `BBB_RLS_ENFORCE=1`.
- **Limits.** 500 records and 2 MB per batch; 60 requests per minute per key; a per-feed daily
  quota tracked by `quota_day` and `records_on_quota_day` (reset when the UTC day changes),
  returning 429 when exceeded.
- **Sibling apps** via bolt-api `bastion-dispatch-hook.ts`, modeled on
  `bursar-dispatch-hook.ts`.

### 3.6 Policy attestation (Beacon)

Linking requires the Beacon article's `visibility` to be `Organization` or `Public`.
`GET /policies/:id/body` re-checks that visibility on every request (and refuses with "This
policy is no longer shared with everyone" if it was narrowed), then serves the exact
`beacon_versions.body_markdown` that bastion-api hashes. **I have read and understood this**
records the version and body hash. A new version resets the requirement. Agents and impersonated
sessions cannot attest.

---

## 4. Data model and migrations

All tables prefixed `bastion_`, org-scoped by `organization_id`, Drizzle schema in
`apps/bastion-api/src/db/schema/` plus a `bbb-refs.ts` stub. No cross-schema FKs.

### 4.1 Tables

**Frameworks and controls**

- **`bastion_frameworks`**: `id`, `organization_id`, `template_key`, `template_version`, `name`,
  `status` (`compiling`,`active`,`archived`), `audit_target_date`, `period_start`, `period_end`,
  `adopted_at`, `adopted_by`, timestamps.
- **`bastion_controls`**: `id`, `organization_id`, `control_key`, `title`, `plain_summary`,
  `category`, `risk_weight`, `owner_user_id`, `lifecycle` (`active`,`retired`), `status`
  (`pass`,`fail`,`unprovable`), `status_reason`, `stale_reason`, `consecutive_error_nights`,
  `last_error_night date`, `coverage_kind`, `active_exception_count`, `last_evaluated_at`,
  `status_changed_at`, `tsv`, timestamps. Unique `(organization_id, control_key)`. Derived
  applicability is computed, not stored.
- **`bastion_control_requirements`**: `id`, `organization_id`, `control_id`, `framework_id`,
  `ref_code`, `requirement_title`, `applicability` (`applicable`,`not_applicable`),
  `not_applicable_reason` (required when not applicable), `decided_by`, `decided_at`, `source`
  (`crosswalk`,`admin`), `removed_at`. Unique `(organization_id, framework_id, ref_code,
  control_id)`.
- **`bastion_assertions`**: `id`, `organization_id`, `control_id`, `kind` (`probe`,`manual`,
  `feed`), `probe_key`, `probe_version`, `params jsonb` (includes `expected_population`,
  `population_confirmed_at`, `population_confirmed_by`), `predicate jsonb`,
  `manual_evidence_spec jsonb` (`what`, `example`, `cadence_days`, `required_window_days`),
  `feed_id`, `plain_statement`, `proposed_by` (`library`,`compiler`,`human`,`agent`),
  `compile_run_id`, `review_status` (`proposed`,`confirmed`,`rejected`,`superseded`),
  `supersedes_id`, `confirmed_by`, `confirmed_at`, `created_by`, timestamps. Content immutable
  once confirmed (trigger).
- **`bastion_compile_runs`**: `id`, `organization_id`, `framework_id`, `status`
  (`queued`,`running`,`succeeded`,`partial`,`failed`), `controls_total`, `controls_done`,
  `assertions_proposed`, `assertions_dropped`, `drop_reasons jsonb`, `llm_calls_used`,
  `used_fallback`, `resume_count`, `claimed_by`, `heartbeat_at`, `error`, timestamps.
- **`bastion_org_settings`**: `organization_id` PK, `llm_provider_id`, `compliance_project_id`,
  `remediation_tasks` (`create`,`propose`), `timezone`, `evaluation_hour_local` (3),
  `evaluation_minute_offset` (hash of org id, 0-59), `stale_after_hours` (36),
  `not_assessed_grace_days` (14), `manual_expiry_warn_days` (30), `questionnaire_high_floor`
  (0.80), `questionnaire_medium_floor` (0.55), `max_llm_calls_per_compile` (400),
  `max_llm_calls_per_questionnaire` (1200), `max_rows_per_questionnaire` (1000),
  `auditor_room_max_days` (90), `max_packet_bytes` (2 GiB), `company_profile jsonb`,
  `offsite_backup_configured` (computed at boot), `bucket_check_status`, `updated_by`,
  `updated_at`.
- **`bastion_audit_log`**: `id`, `organization_id`, `actor_id`, `actor_kind`, `impersonator_id`,
  `action`, `subject_type`, `subject_id`, `details jsonb`, `created_at`. Append-only.

**Evaluation and evidence**

- **`bastion_evaluation_runs`**: `id`, `organization_id`, `trigger` (`nightly`,`manual`,`agent`),
  `scope` (`all`,`control`), `control_id`, `nightly_for_date date`, `as_of`, `status`
  (`queued`,`running`,`succeeded`,`partial`,`failed`), `partial_reason`, `resume_count`,
  `controls_total`, `controls_done`, `pass_count`, `fail_count`, `unprovable_count`,
  `claimed_by`, `heartbeat_at`, `started_by`, timestamps. Partial uniques: `(organization_id)
  WHERE status IN ('queued','running') AND scope = 'all'`; `(organization_id, control_id) WHERE
  status IN ('queued','running') AND scope = 'control'`; `(organization_id, nightly_for_date)
  WHERE trigger = 'nightly'`. A `partial` nightly row is **resumed in place** (section 7.3),
  never duplicated.
- **`bastion_evidence_objects`**: `organization_id`, `content_sha256`, `object_key`, `size_bytes`,
  `content_type`, `holder_count`, `created_at`, `bytes_redacted_at`, `mirrored_at`. PK
  `(organization_id, content_sha256)`.
- **`bastion_object_intents`**: `organization_id`, `object_key`, `created_at`. PK `object_key`.
  Deleted in the transaction that inserts the object row.
- **`bastion_evidence_snapshots`**: `id`, `organization_id`, `evaluation_run_id`,
  `assertion_id` (RESTRICT), `control_id`, `outcome`, `unprovable_reason`, `probe_key`,
  `probe_version`, `params jsonb`, `query_fingerprint`, `population_checked jsonb`,
  `population_unlisted jsonb`, `window_start`, `window_end`, `summary jsonb` (counts),
  `cited_refs jsonb` (`{entity_type, entity_id}` only, capped 200), `overflow_count`,
  `manual_evidence_ids uuid[]`, `exception_ids uuid[]`, `feed_record_count`, `replica_lag_ms`,
  `content_sha256`, `personal_data_hmac`, `pd_hmac_key_id`, `ledger_seq`, `created_at`.
  Immutable. Unique `(organization_id, evaluation_run_id, assertion_id)` (makes resumption
  idempotent). Index `(organization_id, control_id, created_at DESC)`.
- **`bastion_manual_evidence`**: `id`, `organization_id`, `kind` (`file`,
  `attestation_statement`), `title`, `description`, `source_system`, `bin_asset_id`,
  `bin_asset_version_id`, `content_sha256`, `size_bytes`, `content_type`, `scan_label`
  (`clean`,`not_scanned`), `owner_user_id`, `uploaded_by`, `produced_on`, `period_start`,
  `period_end`, `valid_until timestamptz`, `sensitivity` (`standard`,`restricted`),
  `uploader_statement_at`, `status` (`pending_scan`,`active`,`superseded`,`withdrawn`,
  `blocked`), `blocked_reason`, `attempts`, `next_attempt_at`, `superseded_by_id`,
  `withdrawn_reason` (includes `redacted`), `withdrawn_by`, `withdrawn_at`, `redacted_at`,
  `personal_data_hmac`, `pd_hmac_key_id`, `ledger_seq`, timestamps. Content columns immutable
  after `active`.
- **`bastion_manual_evidence_links`**: `id`, `organization_id`, `manual_evidence_id`,
  `assertion_id`, `review_verdict` (`pending`,`accepted`,`shows_exception`), `reviewed_by`,
  `reviewed_at`, `review_note`, `small_team_self_review`, `linked_by`, `linked_at`,
  `unlinked_at`. Unique `(organization_id, manual_evidence_id, assertion_id)`.
- **`bastion_evidence_feeds`**: `id`, `organization_id`, `feed_key`, `label`, `feed_kind`,
  `source_kind` (`api_push`,`bolt_event`), `bolt_source`, `bolt_event_type`, `cadence_days`,
  `daily_record_quota` (5,000), `quota_day date`, `records_on_quota_day`, `bytes_total`,
  `status`, `last_record_at`, timestamps. Unique `(organization_id, feed_key)`.
- **`bastion_feed_keys`**: `id`, `organization_id`, `feed_id`, `key_id` (unique), `secret_hmac`,
  `fingerprint`, `last4`, `label`, `status` (`active`,`grace`,`revoked`), `grace_expires_at`,
  `predecessor_id`, `created_by`, `created_at`, `last_used_at`, `revoked_at`.
- **`bastion_feed_records`**: `id`, `organization_id`, `feed_id`, `feed_key_id`,
  `idempotency_key`, `occurred_at`, `payload_sha256`, `personal_data_hmac`, `pd_hmac_key_id`,
  `ledger_seq`, `received_at`. Unique `(organization_id, feed_id, idempotency_key)`. Immutable.
- **`bastion_personal_data`**: `id`, `organization_id`, `holder_kind`
  (`snapshot`,`manual_evidence`,`feed_record`,`attestation`,`exception`), `holder_id`, `data
  jsonb` (16 KB CHECK), `data_hmac`, `pd_hmac_key_id`, `redacted_at`, `redacted_by`,
  `redaction_reason`. Unique `(organization_id, holder_kind, holder_id)`. Mutable by design.
- **`bastion_ingest_events`**: `id`, `organization_id`, `source`, `event_type`,
  `source_idempotency_key`, `payload jsonb`, `status`, `claimed_by`, `heartbeat_at`,
  `attempts`, `next_attempt_at`, timestamps. Unique `(organization_id, source_idempotency_key)`.
- **`bastion_outbox`**: `id`, `organization_id`, `kind` (`bolt_event`,`bam_task_upsert`,
  `bam_task_comment`,`proposal_close`,`seal_object`), `ordering_key`, `idempotency_key`,
  `payload jsonb`, `status` (`pending`,`delivered`,`dead`), `attempts`, `redrive_count`,
  `next_attempt_at`, `last_error`, `claimed_by`, `heartbeat_at`, `delivered_at`, `created_at`.
  Unique `(organization_id, idempotency_key)`; index `(ordering_key, created_at) WHERE status =
  'pending'`.
- **`bastion_ledger_entries`**: `organization_id`, `epoch`, `seq`, `entry_kind` (plus
  `restore`), `entry_id`, `content_sha256`, `personal_data_hmac`, `pd_hmac_key_id`,
  `prev_entry_hash`, `entry_hash`, `recorded_at`. PK `(organization_id, seq)`.
- **`bastion_ledger_seals`**: `organization_id`, `seal_date`, `epoch`, `head_seq`, `head_hash`,
  `signature`, `signing_key_id`, `object_written_at`, `published_at`. PK `(organization_id,
  seal_date)`.
- **`bastion_ledger_restores`**: `id`, `organization_id`, `detected_at`, `db_head_seq`,
  `bucket_seal_date`, `bucket_epoch`, `bucket_head_seq`, `bucket_head_hash`, `lost_from_seq`,
  `lost_to_seq`, `provisional_epoch`, `object_key` (the `restores/<org>/<id>.json` copy),
  `platform_restore_id`, `status` (`pending_ack`,`acknowledged`,`unmatched`), `resolution`
  (`restore_acknowledged`,`continue_unexplained`, null while appends are blocked),
  `resolved_by`, `resolved_at`.

**Gaps, drift, fixes, exceptions**

- **`bastion_drift_events`**: `id`, `organization_id`, `control_id`, `evaluation_run_id`,
  `from_status`, `to_status`, `reason`, `snapshot_id`, `bam_task_id`, `task_status`
  (`pending`,`created`,`reopened`,`updated`,`no_project`,`proposed`), `proposal_id`,
  `acknowledged_by`, `acknowledged_at`, `detected_at`. Unique `(organization_id,
  evaluation_run_id, control_id)`.
- **`bastion_gaps`**: `id`, `organization_id`, `control_id`, `assertion_id`, `gap_kind` (CHECK
  holds the 12 stored kinds of section 2.3: `failing`, `no_source`, `manual_expired`,
  `not_connected`, `manual_missing`, `population_drift`, `check_broken`, `insufficient_data`,
  `population_review`, `not_assessed`, `manual_expiring`, `attested_only`; the `stale` row is
  derived at read time), `risk_score numeric(8,4)`, `fix_template`, `fix_cost`, `status`
  (`open`,`proposed`,`resolved`,`dismissed`), `dismissed_reason`, `dismissed_by`, `computed_at`.
  Unique `(organization_id, control_id, assertion_id, gap_kind)`.
- **`bastion_fix_drafts`**: `id`, `organization_id`, `gap_id`, `template` (CHECK seven values),
  `title`, `body_markdown`, `payload jsonb`, `cited_refs jsonb`, `dropped_citation_count`,
  `proposal_id`, `status` (`proposed`,`approved`,`rejected`,`expired`,`applied`,
  `decision_rejected`), `decided_by`, `decided_at`, `applied_entity_type`, `applied_entity_id`,
  `created_by`, `created_by_kind`, timestamps.
- **`bastion_exceptions`**: `id`, `organization_id`, `control_id`, `assertion_id`, `scope`
  (`entity`,`assertion`), `cited_entity_type`, `cited_entity_id`, `frozen_refs jsonb`, `reason`,
  `compensating_note`, `proposal_id`, `status` (`proposed`,`active`,`expired`,`rejected`),
  `proposed_by`, `decided_by`, `decided_at`, `small_team_self_approval`, `expires_at NOT NULL`,
  `personal_data_hmac`, `pd_hmac_key_id`, `ledger_seq`, timestamps. CHECK `expires_at` at most
  365 days after creation for `entity`, 90 for `assertion`. Content immutable once `active`.

**Policies**

- **`bastion_policies`**: `id`, `organization_id`, `beacon_entry_id`, `title_cache`, `audience
  jsonb`, `cadence_days`, `owner_user_id`, `status` (`active`,`retired`), timestamps. Unique
  `(organization_id, beacon_entry_id)`.
- **`bastion_policy_attestations`**: `id`, `organization_id`, `policy_id`, `beacon_entry_id`,
  `beacon_version int`, `body_sha256`, `user_id`, `attested_at`, `personal_data_hmac`,
  `pd_hmac_key_id`, `ledger_seq`. Unique `(organization_id, policy_id, beacon_version, user_id)`.
  Immutable.

**Questionnaires**

- **`bastion_questionnaires`**: `id`, `organization_id`, `title`, `requester_label`,
  `bond_deal_id`, `bond_company_id`, `source_bin_asset_id`, `source_bin_asset_version_id`,
  `source_sha256`, `format` (`xlsx`,`csv`), `column_map jsonb`, `status`
  (`uploaded`,`mapping`,`answering`,`in_review`,`approved`,`exported`,`failed`),
  `injection_suspected`, `row_count`, `rows_done`, `low_count`, `medium_count`, `high_count`,
  `resume_count`, `due_date`, `owner_user_id`, `claimed_by`, `heartbeat_at`, `approved_by`,
  `approved_at`, timestamps.
- **`bastion_questionnaire_items`**: `id`, `organization_id`, `questionnaire_id`, `sheet_name`,
  `row_index`, `section`, `question_text` (4000), `answer_kind` (`yes_no`,`text`,`yes_no_text`),
  `draft_answer`, `draft_yes_no`, `final_answer`, `final_yes_no`, `cited_refs jsonb`,
  `dropped_citation_count`, `confidence`, `confidence_band` (`high`,`medium`,`low`),
  `band_reasons jsonb`, `review_status` (`pending`,`accepted`,`edited`,`needs_owner`),
  `assigned_to`, `reviewed_by`, `reviewed_at`. Unique `(organization_id, questionnaire_id,
  sheet_name, row_index)`.
- **`bastion_answer_library`**: `id`, `organization_id`, `question_text`, `answer_text`, `yes_no`,
  `cited_refs jsonb`, `source_item_id`, `approved_by`, `approved_at`, `stale`, `stale_reason`,
  `retired_at`, `tsv` (generated, GIN).

**Sharing**

- **`bastion_auditor_rooms`**: `id`, `organization_id`, `framework_id`, `label`, `token_sha256`
  (unique), `token_hint`, `passcode_hash` (argon2, nullable), `passcode_failures`, `locked_at`,
  `unlocked_by`, `unlocked_at`, `period_start`, `period_end`, `control_ids uuid[]`,
  `restricted_evidence_ids uuid[]` (frozen allowlist), `expires_at NOT NULL`, `revoked_at`,
  `created_by`, `last_accessed_at`, `access_count`, timestamps. CHECK `expires_at <= created_at +
  interval '180 days'`.
- **`bastion_auditor_access_log`**: `id`, `organization_id`, `room_id`, `accessed_at`,
  `view_kind` (`overview`,`control`,`evidence`,`download`,`request`), `object_ref`, `ip_hash`,
  `user_agent_trunc`. UPDATE and TRUNCATE rejected; DELETE allowed only for rows older than two
  years (section 3.4).
- **`bastion_auditor_requests`**: `id`, `organization_id`, `room_id`, `control_id`,
  `requester_name`, `body` (5000), `status` (`open`,`answered`,`closed`), `answered_by`,
  `answer_note`, timestamps.
- **`bastion_export_packets`**: `id`, `organization_id`, `framework_id`, `period_start`,
  `period_end`, `include_restricted`, `status`, `stage`, `stage_progress`, `object_key`,
  `content_sha256`, `size_bytes`, `requested_by`, `claimed_by`, `heartbeat_at`, `error`,
  timestamps.

**Count:** 35 `bastion_` tables (enumerated in section 4.1.1), plus Bam-owned
`github_pr_events`, one added column on `github_integrations`, and five added columns on
`agent_proposals`.

#### 4.1.1 Enumerated table list

1 `bastion_frameworks`, 2 `bastion_controls`, 3 `bastion_control_requirements`,
4 `bastion_assertions`, 5 `bastion_compile_runs`, 6 `bastion_org_settings`,
7 `bastion_audit_log`, 8 `bastion_evaluation_runs`, 9 `bastion_evidence_objects`,
10 `bastion_object_intents`, 11 `bastion_evidence_snapshots`, 12 `bastion_manual_evidence`,
13 `bastion_manual_evidence_links`, 14 `bastion_evidence_feeds`, 15 `bastion_feed_keys`,
16 `bastion_feed_records`, 17 `bastion_personal_data`, 18 `bastion_ingest_events`,
19 `bastion_outbox`, 20 `bastion_ledger_entries`, 21 `bastion_ledger_seals`,
22 `bastion_ledger_restores`, 23 `bastion_drift_events`, 24 `bastion_gaps`,
25 `bastion_fix_drafts`, 26 `bastion_exceptions`, 27 `bastion_policies`,
28 `bastion_policy_attestations`, 29 `bastion_questionnaires`, 30 `bastion_questionnaire_items`,
31 `bastion_answer_library`, 32 `bastion_auditor_rooms`, 33 `bastion_auditor_access_log`,
34 `bastion_auditor_requests`, 35 `bastion_export_packets`.

**Volume.** High-volume tables are snapshots, ledger entries, and feed records; the `0264` header
records that monthly `created_at` partitioning becomes mandatory past 50 million rows
platform-wide.

### 4.2 Reused platform tables

`users`, `organizations`, `organization_memberships`, `sessions`, `login_history`, `api_keys`,
`agent_policies`, `agent_proposals` (insert, read, and the #128 decider columns), `entity_links`
(insert), `superuser_audit_log`, `platform_backups`, `platform_restores` (backup probes and
restore matching), `v_activity_unified`, `github_integrations`, `phases`, `beacon_entries`,
`beacon_versions`, `blip_tracked_apps`, `blip_retention_policies`, `bolt_automations`,
`bolt_executions`, `bin_assets`, `bin_asset_versions`, `bursar_vendors`, `bursar_awards`,
`bond_deals`, `bond_companies`, `llm_providers` (via the internal proxy only).

### 4.3 RLS posture

Generated `DO $$` loop over `bastion\_%` (`0251_bursar_rls.sql:20-50` pattern). Pre-org lookups
use the definer resolvers (section 3.5). Probes use hardened definer functions with an org guard.
bastion-api adopts Bursar's transaction-scoped binding and reports posture at boot; every query
carries an explicit `organization_id` predicate; `test/rls-coverage.test.ts` checks every table.

### 4.4 Migration plan

Anchor: **current tip + 1, observed at authoring time** (tip today: `0259`).

| # | File | Contents |
| --- | --- | --- |
| 0260 | `0260_bolt_trigger_source_values.sql` | **#124.** `ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS` for each source the enum lacks today, listed explicitly: `'basis'`, `'braid'`, `'bulwark'`, `'burn'`, `'bursar'`, `'blueprint'`, `'bureau'`, `'bin'`, `'bay'`, `'blip'`, `'bastion'` (re-verify against `BOLT_SOURCES` at authoring). No new value is used in the same file |
| 0261 | `0261_agent_proposals_decider.sql` | **#128.** `ADD COLUMN IF NOT EXISTS decided_by uuid`, `decided_by_kind` (the existing `actor_type` enum), `decided_impersonator_id uuid`, `owning_app text`, `require_human_decider boolean NOT NULL DEFAULT false` on `agent_proposals`; plus `bastion_mirror_status text` and `bastion_mirror_cursor timestamptz` on `platform_backups` (both additive, both with Drizzle updates in apps/api) |
| 0262 | `0262_github_pr_events.sql` | **Bam-owned.** `github_pr_events` and `github_integrations.subscribed_events text[]` |
| 0263 | `0263_bastion_core.sql` | tables 1-7; Bastion System sentinel user `...0000b5` |
| 0264 | `0264_bastion_evidence.sql` | tables 8-22; immutability triggers; partitioning note |
| 0265 | `0265_bastion_gaps_policies.sql` | tables 23-28 |
| 0266 | `0266_bastion_questionnaires.sql` | tables 29-31 |
| 0267 | `0267_bastion_sharing.sql` | tables 32-35; the age-guarded access-log DELETE trigger and purge function (header states the age predicate is the guard) |
| 0268 | `0268_bastion_probe_functions.sql` | probe functions v1 and the two resolvers, each hardened (search_path, REVOKE from PUBLIC, owner execute, `bam_app` grant only inside an `IF EXISTS` guard, org guard) |
| 0269 | `0269_bastion_rls.sql` | generated RLS loop |
| M10 | `<observed>_permissions_seed_actions_delta_025.sql` | emitted by the delta generator; number observed |
| M10 | `<observed + 1>_bastion_builtin_group_defaults.sql` | authored only after the delta applies |

Twelve migration files. Headers, `IF NOT EXISTS`, `DROP ... IF EXISTS` before triggers and
policies, `CREATE OR REPLACE FUNCTION`. No destructive ALTERs.

### 4.5 The permission procedure (M10)

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
checksummed, and never re-run (the `0259` header records two occurrences). **Interim posture
M1-M9:** `bastion.*` actions do not exist, so the fail-closed boot invariant denies every
non-SuperUser; development and Playwright run only as Skipper (seeded SuperUser) until M10.

### 4.6 The probe is the gate

The CI assertion parses section 5.5. Sanity target only: `owner = admin = 50`, `member = 25`,
`viewer = 10`, `guest = 0`. **If this line disagrees with the table, the table wins.**

---

## 5. API surface, MCP tools, permissions

Base `/bastion/api/v1/...`; cursor pagination; platform error envelope; 202 + run id for long
operations; `?framework_id=` on lists and the summary.

### 5.1 REST endpoints

| # | Method and path | Permission | MCP tool |
| --- | --- | --- | --- |
| 1 | `GET /library/templates` | `framework.read` | skip: static catalog, in `bastion_list_frameworks` |
| 2 | `GET /frameworks` | `framework.read` | `bastion_list_frameworks` |
| 3 | `POST /frameworks` | `framework.write` | skip: setup is a human act |
| 4 | `GET /frameworks/:id` | `framework.read` | `bastion_list_frameworks` |
| 5 | `PATCH /frameworks/:id` | `framework.write` | skip: human admin |
| 6 | `POST /frameworks/:id/archive` (confirm; retires single-framework controls) | `framework.write` | skip: destructive human act |
| 7 | `GET /frameworks/:id/requirements` | `framework.read` | `bastion_list_frameworks` |
| 8 | `GET /frameworks/:id/statement-of-applicability` (csv) | `framework.read` | skip: binary download |
| 9 | `POST /frameworks/:id/compile` (202) | `framework.compile` | `bastion_compile_framework` |
| 10 | `GET /frameworks/:id/compile-runs` | `framework.read` | `bastion_compile_framework` |
| 11 | `GET /controls` | `control.read` | `bastion_list_controls` |
| 12 | `POST /controls` | `control.write` | skip: human admin |
| 13 | `GET /controls/:id` | `control.read` | `bastion_control_status` |
| 14 | `PATCH /controls/:id` | `control.write` | skip: human admin |
| 15 | `PATCH /control-requirements/:id` (applicability + reason) | `control.write` | skip: human applicability decision |
| 16 | `GET /controls/:id/assertions` | `control.read` | `bastion_control_status` |
| 17 | `POST /controls/:id/assertions` | `assertion.propose` | `bastion_propose_assertion` |
| 18 | `POST /assertions/:id/confirm` | `assertion.confirm` | skip: human gate |
| 19 | `POST /assertions/:id/reject` | `assertion.confirm` | skip: human gate |
| 20 | `POST /assertions/:id/revise` | `assertion.propose` | `bastion_propose_assertion` |
| 21 | `GET /probes` | `control.read` | `bastion_list_probes` |
| 22 | `POST /evaluations` (202) | `evaluation.run` | `bastion_run_evaluation` |
| 23 | `GET /evaluations` | `control.read` | `bastion_list_evaluations` |
| 24 | `GET /evaluations/:id` | `control.read` | `bastion_list_evaluations` |
| 25 | `GET /controls/:id/evidence` | `evidence.read` | `bastion_evidence_for` |
| 26 | `GET /evidence/:id` | `evidence.read` | `bastion_get_evidence` |
| 27 | `GET /evidence/:id/verify` | `evidence.read` | `bastion_verify_evidence` |
| 28 | `GET /evidence/:id/download` | `evidence.read_detail` | skip: binary download |
| 29 | `GET /ledger/seals` (all keys) | `evidence.read` | skip: verification material |
| 30 | `GET /ledger/restores` | `evidence.read` | skip: integrity admin surface |
| 31 | `POST /ledger/restores/:id/acknowledge` (confirm, owner; `resolution` = `restore_acknowledged` or `continue_unexplained`) | `ledger.acknowledge_restore` | skip: human integrity act |
| 32 | `POST /manual-evidence` | `evidence.upload` | skip: a human attests |
| 33 | `GET /manual-evidence` | `evidence.read` | `bastion_list_manual_evidence` |
| 34 | `GET /manual-evidence/:id` | `evidence.read` (+ restricted) | `bastion_list_manual_evidence` |
| 35 | `GET /manual-evidence/:id/download` | `evidence.read_detail` (+ restricted) | skip: binary download |
| 36 | `POST /manual-evidence/:id/links` | `evidence.link` | skip: human curation |
| 37 | `DELETE /manual-evidence/:id/links/:assertion_id` | `evidence.link` | skip: human curation |
| 38 | `POST /manual-evidence/:id/links/:assertion_id/review` | `evidence.review` | skip: human adjudication |
| 39 | `POST /manual-evidence/:id/withdraw` (confirm) | `evidence.withdraw` | skip: destructive human act |
| 40 | `POST /manual-evidence/:id/supersede` | `evidence.upload` | skip: human attests |
| 41 | `POST /personal-data/:id/redact` (confirm, owner) | `evidence.redact` | skip: destructive human act |
| 42 | `GET /feeds` | `feed.read` | skip: admin configuration |
| 43 | `POST /feeds` | `feed.manage` | skip: admin configuration |
| 44 | `PATCH /feeds/:id` | `feed.manage` | skip: admin configuration |
| 45 | `GET /feeds/:id/keys` | `feed.manage` | skip: credential admin |
| 46 | `POST /feeds/:id/keys` | `feed.manage` | skip: credential admin |
| 47 | `POST /feed-keys/:id/revoke` | `feed.manage` | skip: credential admin |
| 48 | `POST /feeds/:feed_key/records` | per-feed key | skip: machine ingest with its own credential |
| 49 | `GET /feeds/:id/records` | `feed.read` | skip: admin inspection |
| 50 | `GET /coverage` | `control.read` | `bastion_coverage_summary` |
| 51 | `GET /gaps` | `gap.read` | `bastion_coverage_gaps` |
| 52 | `POST /gaps/:id/propose-fix` | `fix.draft` | `bastion_propose_fix` |
| 53 | `POST /gaps/:id/dismiss` | `gap.dismiss` | skip: human adjudication |
| 54 | `GET /fix-drafts` | `fix.read` | skip: read in the Bastion review queue |
| 55 | `GET /fix-drafts/:id` | `fix.read` | skip: read in the Bastion review queue |
| 56 | `POST /fix-drafts/:id/decide` | `fix.decide` | skip: humans decide in Bastion (#128) |
| 57 | `POST /fix-drafts/:id/mark-applied` | `fix.mark_applied` | skip: records a human's action elsewhere |
| 58 | `GET /exceptions` | `exception.read` | `bastion_list_exceptions` |
| 59 | `GET /exceptions/:id` | `exception.read` | `bastion_list_exceptions` |
| 60 | `POST /exceptions` | `exception.propose` | `bastion_propose_exception` |
| 61 | `POST /exceptions/:id/decide` (confirm) | `exception.approve` | skip: humans decide in Bastion (#128) |
| 62 | `GET /drift` | `drift.read` | `bastion_list_drift` |
| 63 | `POST /drift/:id/acknowledge` | `drift.acknowledge` | skip: human acknowledgement |
| 64 | `GET /policies` | `policy.read` | skip: covered by `bastion_attestation_status` |
| 65 | `POST /policies` | `policy.write` | skip: human admin |
| 66 | `PATCH /policies/:id` | `policy.write` | skip: human admin |
| 67 | `GET /policies/:id/body` | `attestation.read` | skip: UI reading surface |
| 68 | `GET /policies/:id/attestations` | `attestation.read` | `bastion_attestation_status` |
| 69 | `GET /me/attestations` | `attestation.read` | skip: personal UI list |
| 70 | `POST /policies/:id/attest` | `attestation.sign` | skip: humans only |
| 71 | `POST /policies/:id/request-attestations` | `attestation.request` | skip: admin nudge |
| 72 | `GET /questionnaires` | `questionnaire.read` | `bastion_list_questionnaires` |
| 73 | `POST /questionnaires` | `questionnaire.write` | skip: file intake |
| 74 | `GET /questionnaires/:id` | `questionnaire.read` | `bastion_get_questionnaire` |
| 75 | `PATCH /questionnaires/:id` | `questionnaire.write` | skip: human mapping |
| 76 | `POST /questionnaires/:id/autofill` (202) | `questionnaire.write` | `bastion_questionnaire_autofill` |
| 77 | `GET /questionnaires/:id/items` | `questionnaire.read` | `bastion_get_questionnaire` |
| 78 | `PATCH /questionnaire-items/:id` | `questionnaire.write` | skip: human review |
| 79 | `POST /questionnaires/:id/approve` (confirm) | `questionnaire.approve` | skip: human release gate |
| 80 | `GET /questionnaires/:id/export` | `questionnaire.export` | skip: binary download |
| 81 | `POST /answers/draft` | `questionnaire.write` | `bastion_draft_answer` |
| 82 | `GET /answer-library` | `answer_library.read` | `bastion_search_answer_library` |
| 83 | `PATCH /answer-library/:id` | `answer_library.write` | skip: human curation |
| 84 | `GET /auditor-rooms` | `auditor_room.read` | skip: floored |
| 85 | `POST /auditor-rooms` (confirm) | `auditor_room.create` | skip: disclosure is a human act |
| 86 | `POST /auditor-rooms/:id/revoke` (confirm) | `auditor_room.revoke` | skip: human act |
| 87 | `POST /auditor-rooms/:id/unlock` | `auditor_room.create` | skip: human act after a passcode lockout |
| 88 | `GET /auditor-rooms/:id/access-log` | `auditor_room.read` | skip: floored |
| 89 | `GET /auditor-requests` | `auditor_room.read` | skip: floored |
| 90 | `PATCH /auditor-requests/:id` | `auditor_room.respond` | skip: floored human response |
| 91 | `POST /exports` (202) | `export.create` | skip: binary packet |
| 92 | `GET /exports` | `export.read` | skip: floored |
| 93 | `GET /exports/:id/download` | `export.read` | skip: binary download |
| 94 | `GET /summary` | `control.read` | `bastion_coverage_summary` |
| 95 | `GET /search?q=` | `control.read` | skip: consumed by `search_everything` |
| 96 | `GET /settings` | `settings.read` | skip: admin |
| 97 | `PATCH /settings` | `settings.write` | skip: admin |
| 98 | `GET /delivery-problems` (dead outbox rows) | `settings.write` | skip: operator surface |
| 99 | `POST /delivery-problems/:id/retry` | `settings.write` | skip: operator re-drive |
| 100 | `GET /audit` | `audit.read` | skip: floored |
| 101 | `GET /public/room` | room token | skip: public |
| 102 | `GET /public/room/controls/:id` | room token | skip: public |
| 103 | `GET /public/room/evidence/:id` (+ `?download=1`) | room token | skip: public |
| 104 | `POST /public/room/requests` | room token | skip: public |
| 105 | `POST /internal/events` | internal secret, internal network only | skip: service-to-service |
| 106 | `POST /internal/engines/:name` | internal secret, internal network only | skip: service-to-service |
| 107 | `GET /health`, `GET /health/ready`, `GET /metrics` | none | skip: health |

**Count:** 106 REST endpoints in rows 1-106, plus the three health routes. 34 rows map to an MCP
tool; 72 are intentional skips.

**Byte responses** (rows 8, 28, 35, 80, 93, 103 download) send `Content-Disposition:
attachment`, `Content-Security-Policy: sandbox; default-src 'none'`, `nosniff`, and an allowlisted
content type, else `application/octet-stream`.

### 5.2 The auditor room (public)

Hardened version of Bay's guest link (`apps/bay-api/src/routes/public-review.routes.ts:8-11`):

| Bay today | Bastion | Why |
| --- | --- | --- |
| token in URL path | token in URL **fragment** (`/bastion/room#<token>`), sent as header `X-Bastion-Room-Token` | fragments never reach access logs or `Referer` |
| plaintext token (issue #122) | `token_sha256`, shown once | a DB read yields no working links |
| optional expiry | mandatory, default 30 days, ceiling `auditor_room_max_days` (max 180) | disclosure must lapse |
| none | optional 6-digit passcode (argon2) with a per-room failure counter | the passcode is the guessable part |
| per-route limit by socket IP | Fastify `trustProxy` set to `BASTION_TRUST_PROXY_HOPS` (compose 1, Railway 2), 120 requests per minute per resolved client IP, failed-token counter (10 misses per 10 minutes, 15-minute lockout) | the socket IP is nginx; a naive `trustProxy: true` trusts a spoofable `X-Forwarded-For` |
| 404 for missing or revoked | 404 for missing, revoked, expired, or locked | existence is not confirmable |

Every room request re-checks that the creator still holds `auditor_room.create` (else 404);
restricted evidence is exposed only through the frozen `restricted_evidence_ids` allowlist; every
`:id` in rows 102-103 must belong to the room's controls and period; cited refs pass `can_access`
with the creator as asker; files stream through bastion-api with the section 5.1 headers; every
view writes `bastion_auditor_access_log`; evidence requests are bounded (20 per hour per room).
In addition:

- Lockout counters are keyed by **(client IP, room)**, so a wrong hop count cannot lock every room
  at once.
- A passcode lockout (5 misses) notifies the creator, and the creator can **Unlock** from the
  access-log view (row 87).
- The token lookup uses `bastion_resolve_room` (works under RLS enforcement).
- The room shows the Statement of Applicability for ISO frameworks, accepted risks, "Not assessed"
  controls, the signed seal history with every public key, and any "History lost by restore" or
  "Evidence file missing" notices.
- Room-scoped reads expose no evidence outside the room's controls, period, and restricted
  allowlist, whatever ids are supplied.

### 5.3 Realtime: none in v1

Polling on run rows. (Bursar's `/bursar/ws` has no server, issue #121.)

### 5.4 MCP tools

`apps/mcp-server/src/tools/bastion-tools.ts`, client shaped like `createBursarClient`, every tool
with a top-level `returns:` schema. **The file `bastion-tools.ts` is created only in the M11 merge
unit**, together with its `server.ts` registration, `APP_TOOL_MODULES`, the published tool counts,
`pnpm docs:catalog`, the CLAUDE.md count line, and the Launchpad entry. Two checks read the tools
directory rather than `server.ts`: `scripts/check-tool-return-coverage.mjs` counts
`registerTool(server, {` in every `*-tools.ts` file, and `listAllToolModules()`
(`scripts/docs/lib/tool-source.mjs:397-403`) files any unmapped module under "platform". So at M10
the HTTP client and the tool handlers are built and unit-tested at
`apps/mcp-server/src/clients/bastion-client.ts` and `apps/mcp-server/src/tools-pending/bastion.ts`
(paths that match neither check), and M11 moves the handlers into `bastion-tools.ts`.

| # | Tool | Backing rows |
| --- | --- | --- |
| 1 | `bastion_list_frameworks` | 2, 4, 7 |
| 2 | `bastion_list_controls` | 11 |
| 3 | `bastion_control_status` | 13, 16 |
| 4 | `bastion_evidence_for` | 25 |
| 5 | `bastion_get_evidence` | 26 |
| 6 | `bastion_verify_evidence` | 27 |
| 7 | `bastion_coverage_summary` | 50, 94 |
| 8 | `bastion_coverage_gaps` | 51 |
| 9 | `bastion_propose_fix` | 52 |
| 10 | `bastion_compile_framework` | 9, 10 |
| 11 | `bastion_propose_assertion` | 17, 20 |
| 12 | `bastion_run_evaluation` | 22 |
| 13 | `bastion_list_evaluations` | 23, 24 |
| 14 | `bastion_list_drift` | 62 |
| 15 | `bastion_list_probes` | 21 |
| 16 | `bastion_attestation_status` | 68 |
| 17 | `bastion_list_questionnaires` | 72 |
| 18 | `bastion_get_questionnaire` | 74, 77 |
| 19 | `bastion_questionnaire_autofill` | 76 |
| 20 | `bastion_draft_answer` | 81 |
| 21 | `bastion_list_manual_evidence` | 33, 34 |
| 22 | `bastion_search_answer_library` | 82 |
| 23 | `bastion_list_exceptions` | 58, 59 |
| 24 | `bastion_propose_exception` | 60 |

**24 tools**, `asker_user_id` intersection on detail-bearing reads, no tool for any decision,
disclosure, or destructive act.

### 5.5 Permissions (the single source of truth)

`requires_superuser` false for every row; "floored" = owner and admin.

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
| `bastion.ledger.acknowledge_restore` | | yes | | | yes |
| `bastion.feed.read` | yes | | | | |
| `bastion.feed.manage` | | yes | | | |
| `bastion.gap.read` | yes | | yes | | |
| `bastion.gap.dismiss` | | yes | | | |
| `bastion.fix.read` | yes | | | | |
| `bastion.fix.draft` | | | | | |
| `bastion.fix.decide` | | | | | |
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

**Group grants:** owner and admin every row; member every non-floored row; viewer the rows marked
`viewer`; guest none. Service-layer rules on top: `evidence.redact` and
`ledger.acknowledge_restore` require the `owner` role; `fix.decide` requires the caller to own the
control or hold `control.write`; `exception.approve` requires the decider to differ from the
proposer (small-team rule). `is_read` only on actions that change nothing
(`packages/permissions/src/resolver.ts:204`). Enforcement is the hardcoded fail-closed boot
invariant (`apps/bursar-api/src/boot/assert-permissions-enforce.ts:34-47`).

---

## 6. Frontend and help

`apps/bastion/`: React 19, TanStack Query v5, Zustand, Tailwind v4, Radix, Motion. Structure
copied from `apps/bursar/src/` (path router with `BASE_PATH = '/bastion'`,
`components/layout/bastion-layout.tsx` and `bastion-sidebar.tsx`, `lib/api.ts`,
`hooks/use-bastion.ts`, `stores/auth.store.ts`). `apps/bastion/vite.config.ts` sets `base:
'/bastion/'` and copies **every** `@bigbluebam/ui/*` alias from `apps/bursar/vite.config.ts:18-43`
(an unresolved alias breaks the whole frontend image, because the Dockerfile chains builds with
`&&`). Dev `server.port: 3024`, proxying `/bastion/api` to `localhost:4024`.

### 6.1 Pages

| Route | Page | What it shows |
| --- | --- | --- |
| `/bastion/` | **Readiness** | The four numbers with "Not set up yet" beside them and the denominator, "N risk accepted" under Not met, framework picker, days to audit, top gaps, banners (no compliance project; checks stale; scanning off; evidence storage not set up; off-site backup not configured; a pending restore acknowledgement; delivery problems) |
| `/bastion/setup` | **Setup wizard** | Frameworks, profile, Compliance project (required), compile, **Review proposed checks** with "This is the complete list" confirmation per population, ISO applicability decisions |
| `/bastion/controls`, `/:id` | **Controls / Control detail** | Effective state words ("Not met, risk accepted" shows owner and expiry), requirement chips, evidence timeline, exceptions, fixes, the Bam task, **Check now**, **Accept this as a risk** |
| `/bastion/coverage` | **Evidence map** | Controls by source column |
| `/bastion/gaps` | **What to fix first** | Ranked list, "Quick wins", "Accepted risks" section |
| `/bastion/evidence` | **Evidence locker** | Uploads, statements, feeds and keys, scan labels, stuck scans with **Check again** |
| `/bastion/policies` | **Policies** | Linked Beacon articles, audience, cadence, who has and hasn't read the current version |
| `/bastion/attest` | **Policies to read** | Every member's personal list; the body from row 67; **I have read and understood this** |
| `/bastion/questionnaires`, `/:id` | **Questionnaires** | Upload, column mapping, progress with time estimates from the section 7.3 throughput, the answer grid with confidence words ("Sure", "Check this", "Needs an expert"), citations as named chips, exception notes, **Approve**, **Download answers** |
| `/bastion/review` | **Review queue** | Proposed checks, evidence awaiting review, stuck scans, **fix and exception decisions (decided here)**, low-confidence answers, auditor requests |
| `/bastion/sharing` | **Sharing** | Rooms (create, preview, revoke, unlock, access log), packets, Statement of Applicability download |
| `/bastion/settings` | **Settings** | Compliance project, remediation mode, check time and timezone, AI provider, expiry warnings, limits, feed storage, **Delivery problems** (dead outbox rows, retry) and **Evidence integrity** (restores awaiting acknowledgement, key fingerprints) |
| `/bastion/room` | **Auditor room** (public) | Rendered before the auth gate |

### 6.2 Plain-language rules

- No raw UUIDs, hashes, probe keys, object keys, or SQL on any default view. A **Technical
  details** disclosure shows the probe name, query fingerprint, and content hash (never an object
  key).
- Every status has a one-sentence reason (section 3.2); explanations are counts-only unless the
  viewer may see detail ("3 API keys are older than 90 days").
- Dates render in the viewer's timezone with relative text; expiry uses `endOfDayInTz`.
- Empty states teach the next step ("Nothing can prove this yet. You can upload a report from the
  system that knows, or write a statement.").
- While impersonating, vouching buttons (attest, approve, decide, accept evidence) are disabled
  with an explanation.

### 6.3 State and shared components

TanStack Query keys per resource (`['bastion','controls',filters]`), optimistic updates with
rollback for review actions, `refetchInterval` polling on run rows only while they run. Zustand:
`auth.store.ts` (copied) and a small `ui.store.ts` (gap sort mode, framework view, collapsed
groups). `@bigbluebam/ui`: `launchpad`, `org-switcher`, `notifications-bell`, `help-center`
(`<HelpTrigger app="bastion" />`, as `apps/bursar/src/components/layout/bursar-layout.tsx:126`),
`user-menu`, `sidebar-footer`, `impersonation-banner`, `permissions-context` and `use-can` (hide
floored actions rather than showing an unexplained disabled button). The Launchpad icon `castle`
(lucide `Castle`, added to `packages/ui/launchpad.tsx` `ICONS` beside `'shield-check'` at line 90)
and the `site/src/pages/docs.tsx` `APP_ICON`/`APP_COLOR` entries land in M11.

### 6.4 Help

`docs/apps/bastion/help.md`, `guide.md`, generated `help-index.json` (checked with `node
scripts/help/build-help-index.mjs --check`), `meta.json`, and screenshots from
`packages/docs-capture/recipes/bastion/bastion.yaml` (GILLIGAN only) with numbered filenames
(`01-readiness.png`, ...) as the docs-capture bridge writes them, also copied to
`site/public/screenshots/bastion/`. The guide explains, in plain language: each status; "Not met,
risk accepted"; "Not set up yet"; why uploads are not automatic; restores and "history lost";
what an auditor sees; that Bastion is not an auditor.

---

## 7. Background work

Registered with `registerBastionSweep` (copied from `registerBursarSweep`,
`apps/worker/src/worker.ts:2605-2625`), wrapping every scheduler in `withRetention` with `tz:
'UTC'`; every producer `add` passes `jobId` and `SCHEDULED_JOB_RETENTION`; a scanning unit test
enforces both. Queue contracts in `packages/shared/src/schemas/bastion.ts`. `bastion-shared.ts`
throws when `BASTION_API_INTERNAL_URL` is unset. The only worker job that touches the Bastion
bucket directly is `bastion-export-packet`, which builds its driver with
`createBootstrapDriver({ S3_BUCKET: env.BASTION_S3_BUCKET, ... })`, never
`apps/worker/src/utils/storage.ts`. The object sweep and the off-site mirror are thin worker
callers into bastion-api engines (`object-sweep`, `mirror-objects`), so the backup credentials stay
in bastion-api.

| Job | Schedule | Does |
| --- | --- | --- |
| `bastion-evaluate-tick` | `*/5 * * * *` | claims due nightly runs; **re-queues a `partial` nightly run for today in place** (`resume_count` < 3, same `as_of`); **re-enqueues every `queued` run (any kind: evaluation, compile, autofill) whose `updated_at` is more than 2 minutes old**, so a released run is never orphaned |
| `bastion-evaluate-run` | event, concurrency 4 | drives a run with the `bursar-level.job.ts` loop, polling every 10 s with `MAX_POLLS = 540` (90 minutes; the job re-enqueues itself under a new `jobId` if the run is still live); slices skip assertions already snapshotted in the run; a 409 against a claim whose `heartbeat_at` is stale waits 30 s and retries instead of ending the attempt |
| `bastion-compile` | event | async-start LLM slices, resumable; polls every 15 s, `MAX_POLLS = 960` (4 hours, above the 1-2 hour compile estimate), then re-enqueues itself |
| `bastion-questionnaire-autofill` | event | async-start LLM slices, resumable; polls every 10 s, `MAX_POLLS = 360` (1 hour, above the 16-32 minute estimate), then re-enqueues itself |
| `bastion-evidence-ingest` | event + `*/10 * * * *` | backoff, 24 h cap then daily, `recordWorkerError` on failure |
| `bastion-outbox-drain` | `* * * * *` | delivers the **oldest pending row per `ordering_key`** only (a backing-off row blocks those behind it); backoff 30 s to 6 h, then `dead` with a worker error and a `/metrics` counter. **A `dead` row stops blocking its key**, so later rows proceed; an operator re-drive replays it only if no newer row of the same kind for that key has been delivered, otherwise it is marked `superseded` |
| `bastion-gap-rank` | after each run + `30 6 * * *` | recomputes stored gaps |
| `bastion-evidence-expiry` | `10 6 * * *` | expiring evidence and exceptions; control-scope runs |
| `bastion-attestation-nudge` | `0 14 * * *` | due attestations |
| `bastion-proposal-reconcile` | `*/15 * * * *` | expires drafts whose mirrored proposal expired; flags any proposal decided outside Bastion as `decision_rejected` |
| `bastion-ledger-seal` | `55 23 * * *` | seals, seal objects via the outbox, restore detection |
| `bastion-ledger-verify` | `40 4 * * 0` | budgeted re-hash, resume cursor |
| `bastion-evaluation-missed` | `0 * * * *` | idempotent per org and `last_completed_at` |
| `bastion-object-sweep` | `15 4 * * *` | calls bastion-api's `object-sweep` engine, which scans only `bastion_object_intents` older than 24 h (cost bounded by failed writes); paused for an org with an open restore row |
| `bastion-object-backup` | event, **enqueued by `backup-database.job.ts` after the backup has recorded `completed`**, `jobId = backup.id` | calls bastion-api's `mirror-objects` engine (async-start, polled), which mirrors objects with `mirrored_at IS NULL` to the off-site destination within a per-run budget (5,000 objects or 2 GiB) with a resume cursor and progress lines, sets `mirrored_at`, and writes `platform_backups.bastion_mirror_status` and `bastion_mirror_cursor`; a mirror failure never changes the backup's own status |
| `bastion-run-reaper` | `*/5 * * * *` | releases claims on resumable runs whose heartbeat exceeded the lease (`claimed_by = NULL`, status `queued`, **`resume_count` incremented on every release**) up to `resume_count` 3; only then `partial`; unwedges frameworks and questionnaires |
| `bastion-weekly-readiness` | `0 13 * * 1` | via the outbox |
| `bastion-retention` | `20 5 * * *` | prunes processed ingest and delivered outbox rows older than 30 days; calls the access-log purge |
| `bastion-export-packet` | event | the packet, in the worker; personal-data commitments are verified by calling bastion-api's `POST /v1/internal/engines/verify-commitments` (row 106), so the HMAC key lives only in bastion-api |

**19 jobs.**

### 7.1 Progress logging (required)

Every long job logs a start line **before** its first slow step and a line per slice with elapsed
time, through `@bigbluebam/logging`; the same counters are written to the run row so the UI and
the logs agree:

- evaluator: `bastion-evaluate: org 'Gilligan Travel Ltd' controls 31/64 assertions 75/150 (pass
  61, fail 6, unprovable 8) slice_ms=11800 elapsed_ms=48200 resume=0`;
- compile: `bastion-compile: framework 'SOC 2' controls 30/64 proposed 51 dropped 2 llm_calls 30
  fallback=false`;
- autofill: `bastion-autofill: questionnaire 'Howell Industries Vendor Security Review' rows 40/96
  (high 22, medium 11, low 7)`, plus "waiting for an AI slot (org limit 1)" and "throttled by the
  AI provider, resuming in 30 s";
- export: one line per stage (`collecting controls`, `writing evidence 120/412`, `rendering
  summary`, `zipping`, `uploading`);
- sweep, verify, backup mirror: `checked n/N`, `objects n/N`, budget remaining.

### 7.2 The audit packet

Built in the worker as one leased job. The zip is streamed
(`jszip.generateNodeStream({ streamFiles: true })` into `put`). `summary.pdf` is built in memory
with `pdf-lib` (one page per control keeps it small) and added as one entry. Contents: manifest
(file hashes, every seal with every public key, restore notices), `controls.csv`/`.jsonl`,
evidence JSON, selected manual files, `attestations.csv`, `exceptions.csv`, `drift.csv`,
`statement_of_applicability.csv` for ISO, `summary.pdf`. Caps: `max_packet_bytes` and a 400-day
period. The worker never holds `BASTION_PD_HMAC_KEY`: it sends batches of `{holder_kind,
holder_id}` to bastion-api's internal `verify-commitments` engine (row 106), which returns
`intact`, `pd_mismatch`, `key_changed`, or `redacted` per holder, and the packet records those
results in the manifest.

### 7.3 Time budgets, resumption, and fairness

| Quantity | Value |
| --- | --- |
| `BASTION_PROBE_TIMEOUT_MS` | 8,000 |
| Per-assertion write budget | object `put` timeout 5,000 + ledger `lock_timeout` 3,000 |
| Probe slice | stop starting probes at 12 s elapsed: worst 12 + 8 + 5 + 3 = 28 s |
| `BASTION_ENGINE_TIMEOUT_MS` | 30,000 |
| LLM slices | async-start; stop starting calls at 150 s **including slot waits**; heartbeat after every call and every 20 s while waiting for a slot; worst 150 + 60 = 210 s |
| Run lease | 300,000 |

`test/time-budgets.test.ts` asserts `12 + probe timeout + write budget < engine timeout` and `LLM
slice < lease`. **A control's assertions may span slices**; a control is aggregated in the slice
that writes its last missing snapshot (the conditional update counts the run's snapshots against
the control's confirmed assertions). Status writes are conditional on `last_evaluated_at <
$as_of`, drift only when the row changed, run-row writes fenced on `claimed_by`.

**Resumption.** `partial` nightly runs resume in place (tick above). On SIGTERM, bastion-api stops
starting LLM calls, lets the current call finish, and releases its claims (status `queued`,
`resume_count` incremented). Compose sets **`stop_grace_period: 75s`** on bastion-api (Docker's
default 10 s would kill a 60 s LLM call), and Railway gets the equivalent
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=75` as a `literal` hint. Every release increments
`resume_count`, and every re-enqueue uses `jobId = run.id + ':' + resume_count`, so it is never
deduplicated against a completed job still retained by `removeOnComplete`. The tick re-enqueues
any `queued` run idle for more than 2 minutes, so a released run is never orphaned and never
holds the partial unique index against tomorrow's nightly run. Completed items are kept and
skipped, so a deploy does not send a questionnaire back to mapping. A `restore_pending` partial
(section 3.4) resumes only after the restore row is resolved.

**LLM fairness (leased permits).** Copied from `admitLlmCall` in
`apps/api/src/routes/internal-llm.routes.ts`: Redis sorted sets (`bastion:llm:svc`, and
`bastion:llm:org:<org>`) of random tokens scored by admit time; on every admit, tokens older than
the hold window (90 s, above `BASTION_LLM_TIMEOUT_MS`) are purged; `ZREM` in `finally`. Limits:
3 service-wide, 1 per org. **Fails open when Redis is down**, as the proxy does (its own cap still
applies). **Throughput, restated:** at roughly 10-20 s per call, the service does at most about
9-18 calls per minute and one org about 3-6, so a 96-row questionnaire takes roughly 16-32 minutes
and a 400-call compile 1-2 hours. The UI's estimates use these figures.

---

## 8. Events and integration

### 8.1 Published (source `bastion`)

Events are enqueued with a typed helper, `enqueueBastionEvent('control.drifted', payload, ...)`,
whose first argument is always a string literal; `scripts/check-bolt-catalog.mjs` is extended to
treat `enqueueBastionEvent(` as a `'bastion'` publisher. `BASTION_EVENT_TYPES` is an exported
const tuple, and a unit test asserts it equals the `bastionEvents` set in
`apps/bolt-api/src/services/event-catalog.ts`. **`bastionEvents` is registered in M4**, in the
same change as the outbox. The drainer calls `publishBoltEvent` positionally.

| Event | Fired when |
| --- | --- |
| `framework.adopted` | a framework is adopted |
| `assertions.compiled` | a compile run finishes |
| `evaluation.completed` | a run finishes |
| `evaluation.missed` | no nightly run in 26 h (once per missed period) |
| `control.drifted` | stored status worsens |
| `control.recovered` | returns to pass |
| `evidence.uploaded` | manual evidence becomes active |
| `evidence.expiring` | warning window |
| `evidence.expired` | expiry |
| `evidence.integrity_failed` | hash mismatch or an unmatched ledger gap |
| `evidence.redacted` | personal data redacted |
| `ledger.sealed` | daily |
| `ledger.restore_detected` | the database head is behind the bucket seal |
| `ledger.restored` | an owner acknowledged a matched restore |
| `gap.fix_proposed` | a fix proposal is filed |
| `exception.proposed` | an exception proposal is filed |
| `exception.approved` | approved in Bastion |
| `exception.expired` | expiry |
| `attestation.overdue` | someone has not attested within cadence |
| `questionnaire.drafted` | autofill finishes |
| `questionnaire.approved` | approved for export |
| `auditor_room.created` | a room is created |
| `auditor_room.revoked` | revoked or auto-locked |
| `readiness.weekly` | Monday (four numbers, not-set-up count, risk-accepted count, denominator) |

**24 events**, refs and scalars only.

### 8.2 Consumed

`proposal.decided` (platform), used only to detect a Bastion proposal decided outside Bastion
(section 2.8). Machine feeds are the other inbound path.

### 8.3 entity_links

Written in the same transaction as the row they describe, `ON CONFLICT DO NOTHING`, via a copy of
`apps/bursar-api/src/lib/entity-links.ts` (`entity_links` uses `org_id`):

- `bastion.control` -> `bam.task` (`related_to`);
- `bastion.manual_evidence` -> `bin.asset` (`derived_from`);
- `bastion.policy` -> `beacon.entry` (`references`);
- `bastion.questionnaire` -> `bond.deal` (`related_to`);
- `bastion.fix_draft` -> the applied `beacon.entry` or `bolt.rule` (`derived_from`).

### 8.4 Required changes outside apps/bastion*

| Item | Change | Milestone |
| --- | --- | --- |
| **#124** | `packages/shared/src/bolt-sources.ts` `BOLT_SOURCES`; the ingest `z.enum`, `TRIGGER_SOURCES`, `TriggerSourceV1`, and the Drizzle pgEnum derive from it; migration `0260`; `check-bolt-catalog.mjs` fails when a catalog source is missing from `BOLT_SOURCES`; **a `db-drift.yml` step asserts `SELECT unnest(enum_range(NULL::bolt_trigger_source))` equals `BOLT_SOURCES`**, naming missing values | M0 |
| **#125** | `AbortSignal.timeout(5000)` in `publishBoltEvent` | M0 |
| **#123** | `/files/*` serves only `avatars/` | M0 |
| **#126** | `syncNew` propagates to existing services **only hints marked `propagate: true`** (initially the `*_API_INTERNAL_URL` and `*_API_URL` computed hints), never overwrites a present variable, prints the planned diff in CI, and upserts with `skipDeploys` then one redeploy per service | M0 |
| **#127** | the five missing apps in the `index.html` no-cache regex | M0 |
| **#128** | migration `0261`; the Drizzle schema `apps/api/src/db/schema/agent-proposals.ts` gains the five columns (`decided_by_kind` reuses `actorTypeEnum`) so `db:check` stays green; `proposals.routes.ts` sets `decided_by`, `decided_by_kind`, `decided_impersonator_id`, enforces `require_human_decider`, returns 409 `DECIDE_IN_APP` for `owning_app` | M0 |
| Railway generator | `scripts/gen-railway-configs.mjs` also rewrites `set $<var> <host>:<port>;` for known services to `.railway.internal:8080`, and replaces any location-level `resolver 127.0.0.11` with `__RESOLVER__`; unit test | M0 |
| Deploy secrets | `scripts/deploy/shared/secrets.mjs` `generateSecrets()` gains a **stable secret** class: generated only when no live value exists (existing `.env`, or live service variables on Railway), never rehydrated from `[REDACTED]` state (`scripts/deploy/main.mjs:151-165`) | M0 |
| GitHub | `ping` stores `hook.events`; `pull_request_review` handled; every merge and review appended to `github_pr_events` | M2 |
| `apps/api/src/routes/internal-bastion.routes.ts` | `POST /internal/bastion/tasks/upsert` (reopen semantics), `POST /internal/bastion/tasks/comment` (by `external_id`, idempotency key), `POST /internal/bastion/proposals/:id/close` (accepts only proposals with `owning_app = 'bastion'` whose named decider is a `kind = 'human'` member of the proposal's org; records the decider in the #128 columns and emits `proposal.decided`); `requireServiceAuth`; `BASTION_SYSTEM_USER_ID` | M6 |
| Visibility | six `bastion.*` types; generated `can_access` description in `visibility-tools.ts:28`; `agent-conventions.md` | M10 |
| Search | `search_everything` fetcher | M10 |
| bolt-api | `bastion-subscriptions.ts`, `bastion-dispatch-hook.ts`, `BASTION_API_INTERNAL_URL` | M4 |
| Backup | `backup-database.job.ts` records its own `completed` status first (unchanged), then enqueues `bastion-object-backup` with `jobId = backup.id`; `platform_backups` gains `bastion_mirror_status` and `bastion_mirror_cursor` (migration `0261`, Drizzle `platform-backups.ts`) | M9 |
| xlsx | `packages/structured-data/src/codecs/xlsx.ts` | M8 |

### 8.5 Unified activity and search

- **Search:** `search_everything` includes Bastion controls and policies (row 95), filtered by
  `can_access` in asker mode.
- **Activity:** remediation tasks and their comments land in Bam's `activity_log`, which
  `v_activity_unified` already unions. Bastion's own administrative actions go to
  `bastion_audit_log` (row 100). Extending `v_activity_unified` with a Bastion branch is not done
  in v1: no satellite has extended the view since `0129_activity_unified_view.sql`, and doing so
  means restating the whole view body (section 15.8).

---

## 9. Infrastructure, secrets, backup and DR

### 9.1 Compose services

**bastion-api**, modeled on the `bursar-api` block (`docker-compose.yml:1041-1093`): build
`apps/bastion-api/Dockerfile`; env `DATABASE_URL`, `DATABASE_READ_URL`, `REDIS_URL`,
`SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL=http://api:4000`,
`BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_REGION`, `PORT=4024`, `HOST=0.0.0.0`, `LOG_LEVEL`, `CORS_ORIGIN`, `RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW_MS`, `BASTION_LLM_TIMEOUT_MS=60000`, `BASTION_ENGINE_TIMEOUT_MS=30000`,
`BASTION_PROBE_TIMEOUT_MS=8000`; `depends_on` migrate (`service_completed_successfully`),
postgres and redis (`service_healthy`), minio (`service_started`); healthcheck `curl -sf
http://localhost:4024/health`; networks `backend` and `frontend`. Bolt-api and api are
request-time dependencies only, kept out of `depends_on`. Pool capped at `max: 10`; Postgres
already runs `max_connections=200`; Redis is verify-only (512mb, `noeviction`). Also:

- Secrets use `${VAR:-}` (never `:?`, which would abort `docker compose up` for the whole suite):
  `BASTION_SEAL_SIGNING_KEY`, `BASTION_PD_HMAC_KEY`, `BASTION_ROOM_IP_SALT`,
  `BASTION_FEED_KEY_PEPPER`. bastion-api **refuses to start** when one is empty or malformed, with
  a plain message naming the `.env` line ("BASTION_PD_HMAC_KEY is missing. Run ./scripts/deploy.sh
  to generate it, or add a 64-character hex value to .env. Do not change it once set.").
- `BASTION_S3_BUCKET=${BASTION_S3_BUCKET:-bigbluebam-bastion}`; `BASTION_TRUST_PROXY_HOPS=${BASTION_TRUST_PROXY_HOPS:-1}`.
- Off-site backup: `BASTION_BACKUP_S3_ENDPOINT`, `BASTION_BACKUP_S3_BUCKET`,
  `BASTION_BACKUP_S3_ACCESS_KEY`, `BASTION_BACKUP_S3_SECRET_KEY` (all `:-`, unset by default).
- S3 variables are optional for bastion-api: if storage was skipped at deploy, it starts and every
  evidence write returns "Evidence storage isn't set up" with a Readiness banner. At boot it runs
  a put, stat, delete check on its bucket and records `bucket_check_status`; readiness stays
  Postgres and Redis only.

bastion-api also sets **`stop_grace_period: 75s`** so a SIGTERM drain can finish an in-flight LLM
call (section 7.3).

**worker** gains `BASTION_S3_BUCKET` and `BASTION_API_INTERNAL_URL` only. It does **not** get
`BASTION_PD_HMAC_KEY` or the `BASTION_BACKUP_S3_*` credentials: the packet verifies commitments
through bastion-api's internal engine, and the off-site mirror and object sweep run as bastion-api
engines that worker jobs merely trigger, so each secret lives in exactly one service.
**frontend** gets `bastion-api: condition: service_started`. The Dockerfile adds the four `packages/storage` lines from
`apps/bin-api/Dockerfile:16,31,41,58`.

**Bucket naming on AWS S3 and R2.** The deploy storage prompt (`promptStorageChoice`) asks for the
Bastion bucket name, defaulting to `${S3_BUCKET}-bastion`, because a literal global name is
almost certainly taken on AWS and scoped IAM keys often cannot create buckets. MinIO keeps the
literal default.

### 9.2 nginx

Hand-edit `infra/nginx/nginx-with-site.conf` (compose-mounted) with `location /bastion/`, the
runtime-resolved `/bastion/api/` block, the internal deny, and both regexes (assets at `:907`,
`index.html` no-cache at `:896`). `infra/nginx/nginx.conf` gets the same blocks **only after
confirming which stack mounts it** (`docker-compose.multi.yml`); if that stack is not on Docker's
embedded DNS, it uses a literal upstream instead of `127.0.0.11`. `nginx.railway.conf` and
`railway/bastion-api.json` are regenerated with the M0-extended generator. M1 gates:
`grep -c 'bastion-api.railway.internal:8080' infra/nginx/nginx.railway.conf` >= 1 and
`grep -c 127.0.0.11 infra/nginx/nginx.railway.conf` = 0, plus `nginx -t`.

### 9.3 Frontend image

`apps/frontend/Dockerfile`: `COPY apps/bastion/package.json ./apps/bastion/` (beside line 26),
`COPY apps/bastion/ ./apps/bastion/` (beside line 74), `&& pnpm --filter @bigbluebam/bastion build
\` (beside line 101), `COPY --from=build /app/apps/bastion/dist /usr/share/nginx/html/bastion`
(beside line 129). The SPA dist is not bind-mounted, so serving `/bastion/` needs `docker compose
build frontend`, which rebuilds every SPA (the slow step of M1).

### 9.4 Deploy catalog and env hints

`scripts/deploy/shared/services.mjs`, modeled on the bursar entry (lines 355-385), **with the env
block** (a missing one resolves to empty arrays and deploys with no `DATABASE_URL`), landed in the
same commit as its env hints:

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
               'BBB_API_INTERNAL_URL', 'BOLT_API_INTERNAL_URL', 'BASTION_S3_BUCKET',
               'BASTION_SEAL_SIGNING_KEY', 'BASTION_PD_HMAC_KEY', 'BASTION_ROOM_IP_SALT',
               'BASTION_FEED_KEY_PEPPER'],
    optional: ['DATABASE_READ_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_REGION',
               'CORS_ORIGIN', 'LOG_LEVEL', 'BASTION_TRUST_PROXY_HOPS', 'BASTION_LLM_TIMEOUT_MS',
               'BASTION_ENGINE_TIMEOUT_MS', 'BASTION_PROBE_TIMEOUT_MS',
               'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
               'BASTION_BACKUP_S3_ENDPOINT', 'BASTION_BACKUP_S3_BUCKET',
               'BASTION_BACKUP_S3_ACCESS_KEY', 'BASTION_BACKUP_S3_SECRET_KEY'],
  },
}
```

Also: `bastion-api` in the frontend entry's `needs`; `BASTION_API_INTERNAL_URL` on the bolt-api
and worker entries; `BASTION_API_URL` on mcp-server's `env.optional`; the **worker** entry gains
only `BASTION_S3_BUCKET` in `env.optional` (the packet job needs it; the worker already has the
shared `S3_*` credentials). The off-site backup credentials and the HMAC key stay on bastion-api
alone, because the mirror and sweep run as bastion-api engines and commitment checks go through
bastion-api (env hints are one flat global map, so a secret cannot be generated on one service and
referenced on another). On Railway, internal URLs use port 8080. **M1 gate:** the `syncNew`
dry-run plan shows `BASTION_S3_BUCKET` and `BASTION_API_INTERNAL_URL` being added to the existing
worker service.

`env-hints.mjs` (landed with the catalog entry):

```js
BASTION_API_INTERNAL_URL:  { kind: 'computed', value: internal('bastion-api'), propagate: true },
BASTION_API_URL:           { kind: 'computed', value: `${internal('bastion-api')}/v1`, propagate: true },
BASTION_S3_BUCKET:         { kind: 'literal', value: 'bigbluebam-bastion', propagate: true },
RAILWAY_DEPLOYMENT_DRAINING_SECONDS: { kind: 'literal', value: '75' },   // bastion-api SIGTERM drain
BASTION_LLM_TIMEOUT_MS:    { kind: 'literal', value: '60000' },
BASTION_ENGINE_TIMEOUT_MS: { kind: 'literal', value: '30000' },
BASTION_PROBE_TIMEOUT_MS:  { kind: 'literal', value: '8000' },
BASTION_TRUST_PROXY_HOPS:  { kind: 'literal', value: '2' },
BASTION_SEAL_SIGNING_KEY:  { kind: 'secret', value: '<generate>', stable: true,
  note: '64-hex Ed25519 seed (32 bytes), wrapped as PKCS8 at boot. MUST stay STABLE. Change it only through the documented rotation, which registers a new signing_key_id and keeps every old public key published; a silent change makes new seals unverifiable against the published keys.' },
BASTION_PD_HMAC_KEY:       { kind: 'secret', value: '<generate>', stable: true,
  note: '64-hex HMAC key for personal-data commitments. MUST stay STABLE: a new value makes every existing commitment report key_changed. Escrow it with the database backup.' },
BASTION_ROOM_IP_SALT:      { kind: 'secret', value: '<generate>', stable: true,
  note: '64-hex salt for auditor-room IP hashes. Changing it only splits old and new access-log hashes.' },
BASTION_FEED_KEY_PEPPER:   { kind: 'secret', value: '<generate>', stable: true,
  note: '64-hex pepper for feed-key HMACs. MUST stay STABLE: a new value invalidates every feed key.' },
BASTION_BACKUP_S3_ENDPOINT:   { kind: 'literal', value: '' },
BASTION_BACKUP_S3_BUCKET:     { kind: 'literal', value: '' },
BASTION_BACKUP_S3_ACCESS_KEY: { kind: 'secret', value: '', note: 'Off-site evidence backup; leave empty to disable (ops.backup_fresh then reports cannot prove).' },
BASTION_BACKUP_S3_SECRET_KEY: { kind: 'secret', value: '', note: 'As above.' },
```

`.env.example` documents each, including that compose installs behind Cloudflare or Caddy need
`BASTION_TRUST_PROXY_HOPS=2`. **Signing-key rotation** is the only supported way to change the
signing key: a new seed gets a new `signing_key_id`, and every old public key stays published.

### 9.5 Health and scaling

`@bigbluebam/service-health` registers exactly `/health`, `/health/ready`, and `/metrics`;
readiness checks Postgres and Redis only (`apps/bursar-api/src/server.ts:126-140`), so a MinIO,
LLM proxy, or bolt-api outage never takes Bastion out of rotation. bastion-api is stateless and
scales horizontally: run claims with fenced writes, per-org advisory ledger locks, leased Redis
permits, and Redis lockout counters make concurrent instances and BullMQ retries safe. Nightly load
is spread by `evaluation_minute_offset`; probes run on `DATABASE_READ_URL` when it is set and
replica lag is under 30 seconds.

### 9.6 Registration checklist

| File | Change | Milestone |
| --- | --- | --- |
| compose, frontend Dockerfile, nginx, generated Railway conf | sections 9.1-9.3 | M1 |
| `services.mjs`, `env-hints.mjs`, `railway/bastion-api.json`, `.env.example` | section 9.4 | M1 |
| `event-catalog.ts` `bastionEvents` | section 8.1 | **M4** |
| `docs/reference/mcp-endpoint-mapping.md` | Bastion section (rows 1-106, skip-marker form); internal Bam routes under "Cross-app - Internal service-to-service endpoints"; GitHub webhook change under Bam; **notes on the #123 `/files/*` change, the #124 ingest source change, and the #128 `DECIDE_IN_APP` behavior**, with Bastion proposals marked "decide in Bastion"; summary updated | M10 |
| Visibility tool, agent conventions | section 8.4 | M10 |
| **One merge unit at M11:** `server.ts` registration of `bastion-tools`, `APP_TOOL_MODULES`, `pnpm docs:catalog`, published tool counts (`README.md` lines 40, 57, 63, 346, 358, 390; `site/index.html:6`; `site/src/content/apps/introduction.md:15`; `site/src/lib/facts.ts` `MCP_TOOL_COUNT` to 909), the CLAUDE.md per-module line, `LAUNCHPAD_*`, `ROOT_REDIRECT_VALUES`, `REDIRECT_MAP`, icon, marketing section, site screenshots, `pnpm docs:readme` (including the "23 apps" prose at README lines 63 and 390), CLAUDE.md app rows | | **M11** |
| `scripts/seed-gilligan/run-all.mjs` | Compliance phase | M3, grown per milestone |

### 9.7 Backup, keys, and DR

- **Off-site evidence mirror.** `backup-database.job.ts` records the database backup's own
  `completed` status first, exactly as today, then enqueues `bastion-object-backup` with `jobId =
  backup.id`. That job triggers bastion-api's `mirror-objects` engine, which copies objects with
  `mirrored_at IS NULL` to the separately configured `BASTION_BACKUP_S3_*` destination (ideally
  another provider or host; never the shared bucket) within a per-run budget of 5,000 objects or
  2 GiB, resuming from a cursor with progress lines, and writes
  `platform_backups.bastion_mirror_status` and `bastion_mirror_cursor`. **A mirror failure,
  timeout, or a long first pass never fails, delays, or changes the database backup.** Because the
  mirror follows each backup, there is no schedule race.
- **"Current" defined:** every object created before the backup's `started_at` minus 1 hour has
  `mirrored_at` set, as recorded by that backup's `bastion_mirror_cursor`; `ops.backup_fresh`
  reads both the backup status and the mirror status.
- **When the destination is unset**, the job logs "No off-site evidence backup is configured" and
  `ops.backup_fresh` reports `unprovable / source_not_connected`, never `pass`.
- **Object restore runbook.** The worker has no CLI, so bastion-api ships one
  (`apps/bastion-api/src/cli.ts`, built to `dist/cli.js`) with a `restore-objects --from-backup`
  command that copies the mirror back into the Bastion bucket, logging `objects n/N` as it goes.
  Compose: `docker compose exec bastion-api node dist/cli.js restore-objects --from-backup`.
  Railway: `railway ssh --service bastion-api -- node dist/cli.js restore-objects --from-backup`.
  (M9.)
- **Seals and restore records** are objects in the Bastion bucket and therefore mirrored too;
  restore detection is section 3.4. Bucket objects can be deleted by anyone holding the shared S3
  credentials, which is inside the stated honest limit; the guide tells auditors to keep their own
  copies of the signed seals and packets they receive.
- **Key escrow.** `BASTION_SEAL_SIGNING_KEY`, `BASTION_PD_HMAC_KEY`, and `BASTION_FEED_KEY_PEPPER`
  must be exported and escrowed with the database backup; a rebuilt host without them cannot sign
  new seals under the old key id, verify commitments, or accept existing feed keys. Each row
  records `signing_key_id` or `pd_hmac_key_id`, so a key change reports `key_changed`, not
  `hash_mismatch`.

---

## 10. Seed data (GILLIGAN)

`scripts/seed-gilligan/bastion.mjs` plus `bastion.expectations.mjs`, registered in
`scripts/seed-gilligan/run-all.mjs` as a new last phase `{ name: 'Compliance', files:
['bastion.mjs'] }` after "Support & email" (it needs Bam, Bond, Beacon, Bin, Blip, Bolt, and Bursar
data from earlier phases), plus the docs-capture recipe. **The seeder is built incrementally from
M3**: each milestone adds the rows its Playwright stories need and extends
`BASTION_SEED_EXPECTATIONS` in the same change. Never seeded: `e2e-admin@bigbluebam.test`, "E2E
Test Organization", "screenshots-demo".

### 10.1 The story

Gilligan Travel Ltd is preparing for its first SOC 2 review because Thurston Howell III's holding
company will only book the charter fleet through a vendor that passes its security review, and
Howell's European subsidiary has asked about ISO 27001 too. Skipper owns the program; the
Professor owns technical controls; Mary Ann owns people controls. The auditor is "Lagoon & Reef
CPAs".

### 10.2 What the seed creates

| Milestone | Rows |
| --- | --- |
| M3 | SOC 2 then ISO 27001 adopted (MFA control shows "CC6.1" and "A.5.17"); ISO physical-security requirements marked not applicable ("We operate from a shared island hut with no server room"); Compliance project; GitHub population of two repos confirmed as complete; four controls left unconfirmed so "Not set up yet: 4" shows |
| M4 | "Coconut Radio Bridge" key 210 days old: **Not met**; Wrongway Feldman still holding a key: **Not met**; "Rescue Radio Firmware" with PR #42 merged without review: **Not met**; its webhook predates 0262, so `subscribed_events` is NULL and the note asks for a ping redelivery; "Lagoon Booking Site" not integrated: **Can't prove yet**; a third repo "Coral Reef Booking" connected but not in the list: `population_drift` gap; Blip "Daily Coconut Count" at 30 days: **Not met**; backups completed but no off-site destination: **Can't prove yet** ("off-site evidence backup not configured"); "Island Weather Feed" critical with award: **Proven** |
| M5 | 2-Step report by the Professor, accepted by Skipper, 12 days left: **Proven by evidence you provided**, expiring; laptop encryption with nothing: top gap; Mary Ann's self-attested background checks; the "Crew roster export" feed with a key |
| M6 | Exception for the "Radio Relay" service key, proposed by the Professor and approved by Skipper in Bastion: **Not met, risk accepted** (owner and expiry shown); an `evidence_request` fix to the Professor; the drift task |
| M7 | "Island Information Security Policy", 5 of 7 attested |
| M8 | "Howell Industries Vendor Security Review" (xlsx, 24 rows), autofilled; the Radio Relay row is `medium` naming the exception |
| M9 | auditor room "Lagoon & Reef CPAs, Type I readiness" with two access-log rows; one ISO packet with the Statement of Applicability |

### 10.3 One source for the numbers

`BASTION_SEED_EXPECTATIONS`: the four numbers and not-set-up count per framework, the risk-accepted
sub-count, coverage kinds, the gap mapping cases present, the top gap, questionnaire bands, the
attestation ratio, SoA row count, and ledger length. Playwright imports it.

---

## 11. Test plan

### 11.1 Unit

Vitest, with `@bigbluebam/db-stubs` where no SQL is needed. Boot invariant (refuses any mode
other than `on`/`deny`); every probe's `paramsSchema` bounds and counts-only `explain()`;
compiler validation (unknown probe key, out-of-range threshold dropped) and deterministic
fallback; crosswalk completeness (every SOC 2 and ISO requirement maps to a control); conditional
status write (an older `as_of` cannot overwrite); manual assertion decision table (scan states,
current or expired, pending review, accepted, `shows_exception`, uncovered period, small-team
self-review); `endOfDayInTz` across DST; ledger canonicalizer goldens and tamper detection; seal
signing and verification with multiple key ids; personal-data redaction keeps the chain
verifiable; Bolt rule shape allowlist rejects `send_webhook` and `send_email*`; injection
pre-scan on cited labels; `rejectWhenImpersonating` on every vouching route; auditor token
hashing, fragment parsing, passcode lockout and unlock, creator-authority re-check, restricted
allowlist, id scoping; content-type allowlist and download headers; questionnaire banding;
citation verification; csv neutralization; `bin-asset-access` refusal cases; claim fencing;
reaper behavior; feed key HMAC verification, quota 429, batch byte cap; no bare
`upsertJobScheduler` or `add`; `rls-coverage`; per-assertion exception aggregation (**a covered
fail plus an unprovable sibling gives Can't prove yet, and the `manual_missing` gap is present**);
a not-applicable control is not evaluated; `population_review` cost 2; dead outbox rows stop
blocking and re-drive marks superseded rows; poll caps exceed the stated run durations; a NULL
replay timestamp counts as zero lag; the proposal-close route rejects non-Bastion proposals and
non-human or non-member deciders; seal refusal below the highest bucket-sealed head; `effectiveStatus` (pass_with_exception, staleness precedence); the
numbers table including the not-set-up count and the risk-accepted sub-count; the full gap mapping
(12 stored kinds, derived `stale`, grace period, all-rejected without grace); exception scope
(`frozen_refs` ignores a new failure), 90 and 365 day caps, approver-differs-from-proposer and
small-team labelling; questionnaire `medium` cap on exceptions; answer-library staleness ignores
`evaluation_stale`; redact the only accepted file, then the control drops to "Can't prove yet";
shared-object reference counting; `subscribed_events` NULL yields `fail` on zero-approval merges
with the ping note; `population_drift` and `population_review`; `consecutive_error_nights` by
distinct night and reset; idempotent `evaluation.missed`; feed quota day rollover; time budgets
(`12 + 8 + 5 + 3 < 30`); slices spanning a control; resumption skipping done items; leased LLM
permits expiring after 90 s and failing open; outbox ordering per key and comments by
`external_id`; canonical form with `epoch`; restore detection states (normal, pending_ack,
acknowledged, unmatched); verify results including `pd_mismatch` and `key_changed`;
`BASTION_EVENT_TYPES` equals `bastionEvents`; SoA completeness blocks an ISO packet; decide routes
reject agents, impersonators, and the proposer; env refusal messages for each missing secret.

### 11.2 Integration

Real Postgres in the CI service container. **Probe goldens**, run three times (as today, with
`BBB_RLS_ENFORCE=1`, and with `DATABASE_READ_URL` pointing at a separate pool so the org guard is
exercised through `runInOrgScopeRead`), asserting identical outcomes, including `access.departed_still_holding`
catching a user whose membership was removed, a missing-population repo, and a NULL
`subscribed_events`. **Immutability:** UPDATE of content columns, DELETE, cascade, and TRUNCATE
raise on every immutable table. **Bolt ingest:** a Bastion event posted to `/events/ingest`
returns 2xx. **Cross-app:** `ping` stores `subscribed_events`; review and merge deliveries land in
`github_pr_events`; evaluation, drift, outbox, task upsert; drift, close the task, drift again:
the task is open with a "Drifted again" comment; the recovery comment is posted once across a
forced retry; a fix decided in Bastion closes its mirrored proposal; a feed push with a repeated
idempotency key is a no-op; **exception approved, task closed, exception expires: the task is open
with "Accepted risk expired"**; **kill bastion-api mid-slice: the run completes after the tick
re-enqueues it, and the next night's run is created**; the packet's commitment checks go through
bastion-api with no HMAC key in the worker; a failing mirror leaves the backup `completed`.
**Files route:** a non-avatar key through `/files/` returns 404.
**Proxy:** two forwarded clients have independent lockout counters. Also: definer functions' `proconfig` and `proacl` (search_path, no PUBLIC execute)
and the org guard raising for a foreign org; a direct `SET LOCAL bastion.purge_access_log='on'` +
DELETE of a recent row fails; resolvers work with `BBB_RLS_ENFORCE=1`; **restore with restart**:
seal, `pg_dump`, append, seal, restore the dump, boot, expect `ledger.restore_detected`,
`pending_ack` only when a matching `platform_restores` row exists, `unmatched` plus
`evidence.integrity_failed` without it; then append after detection (blocked until resolved),
resolve, append, seal again, and assert no sealed `(epoch, seq)` is reused, the seal run refused
any head below the highest bucket seal, and the gap is still reported the next day from the
`restores/` bucket object; **restore in place with no restart**: seal, append, restore the dump
through the platform restore job while bastion-api runs, run an evaluation, and assert a restore
row exists, the run went `partial` with `restore_pending`, and no sequence number was reused;
partial nightly resumes the same day; the platform decide route returns 409 `DECIDE_IN_APP` for a
Bastion proposal and records `decided_by_kind` for others; a Bolt rule on `bastion` source
triggers (enum value present); the `db-drift` enum check fails when a value is missing; packet
built where the worker's `S3_BUCKET` differs from `BASTION_S3_BUCKET`; generator output for the
runtime-resolved block; `syncNew` dry-run plan contains only the Bastion URL additions.

### 11.3 LLM corpus gates

Deterministic via recorded responses.

| Gate | Threshold |
| --- | --- |
| Compiler validity | 0 invalid probe keys or params reach `proposed` |
| Compiler coverage | every SOC 2 and ISO control receives an assertion, a manual spec, or a per-requirement applicability decision |
| Questionnaire false confidence | 0 `high` answers citing a control whose effective state is not `pass` (including `pass_with_exception`) |
| Questionnaire injection | 0 `high` answers on the injection fixture rows |
| Fix-draft injection | 0 drafts whose name or description carries instructions from an injected PR title |
| Citation integrity | 0 persisted citations outside the retrieved set or failing `can_access` |

Fixtures: a 40-question synthetic questionnaire with labelled answerable and unanswerable rows,
8 injection-shaped rows, and an exception-covered control. Recorded caveat: stubs never exercise
the real proxy timeout or concurrency.

### 11.4 Playwright user stories (GILLIGAN; Skipper-only before M10)

| # | Story | Milestone |
| --- | --- | --- |
| 1 | Readiness shows the four numbers, "Not set up yet: 4", the denominator, and "Proven by evidence you provided" separately | M5 |
| 2 | ISO view changes the numbers; the SoA lists the not-applicable physical requirements | M5 |
| 3 | The 2-Step report shows "expires in 12 days" | M5 |
| 4 | Top gap is laptop encryption; **Draft the fix** files a proposal decided in the review queue | M6 |
| 5 | Code-review control cites PR #42, names "Lagoon Booking Site", shows the ping note; "Coral Reef Booking" appears as a population gap | M6 |
| 6 | "Radio Relay" control reads **"Not met, risk accepted"** with owner and expiry, and counts under Not met | M6 |
| 7 | The Howell questionnaire's encryption row is `low` ("We cannot currently prove this") and the Radio Relay row is `medium` naming the exception; **Approve** is disabled until low rows are reviewed | M8 |
| 8 | Create an auditor room; token once; preview lists controls, restricted items, SoA | M9 |
| 9 | Anonymous auditor views a control and evidence; the access log grows | M9 |
| 10 | After revoke, "This link is no longer available" and 404 | M9 |
| 11 | No raw UUID on home, controls, or control detail | M9 |
| 12 | Gilligan attests; coverage rises | M10 |
| 13 | Gilligan sees no Sharing actions; `POST /auditor-rooms` is 403 | M10 |
| 14 | Skipper impersonating Gilligan cannot attest or decide | M10 |
| 15 | Help opens the Bastion guide | M10 |
| 16 | Bastion appears on the Launchpad; `/docs` lists 24 Bastion tools | M11 |

### 11.5 Convention gates

`pnpm db:check` (0 drift), `pnpm lint:migrations`, `pnpm check:bolt-catalog` (extended for #124
and `enqueueBastionEvent`), the `db-drift` enum check, `pnpm check:permission-catalog`, the section
4.6 probe-vs-table assertion, `pnpm check:env-hints`, `node scripts/check-tool-return-coverage.mjs`,
the definer-function assertion, the surface-map self-check printing `0` plus an updated summary,
`pnpm docs:catalog:check`, `pnpm docs:readme:check`, `node scripts/help/build-help-index.mjs
--check`, `grep -c bastion infra/nginx/*.conf` non-zero in all three, the two Railway grep gates,
`docker compose exec frontend nginx -t`, `tsc --noEmit`, Biome; `pnpm check:app-completeness`
from M11.

---

## 12. Milestones

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | **Platform prerequisites, fixing the fact:** #124 (shared `BOLT_SOURCES`, `0260` with the explicit list, catalog check, `db-drift` enum check); #125; #123; #126 scoped (`propagate: true`, no overwrite, diff, `skipDeploys`); #127; **#128** (`0261`, decide route, 409 `DECIDE_IN_APP`); Railway generator handles `set $var host:port` and the resolver; stable-secret class in `generateSecrets()` | Bursar and Bastion events ingest 2xx; enum check green; `/files/<non-avatar>` 404; `syncNew` dry-run shows only `propagate` additions; a generic decide of an `owning_app` proposal returns 409 and other decides record `decided_by_kind`; generator unit test green; `pnpm db:check` (0 drift, including the `agent_proposals` and `platform_backups` Drizzle updates) and `pnpm lint:migrations` green for `0260` and `0261` |
| **M1** | Scaffold, own bucket with boot check, `BASTION_TRUST_PROXY_HOPS`, compose (`:-` secrets, refusal messages), worker env, nginx with runtime resolver and internal deny, generated Railway conf, catalog + hints, SPA by direct URL | `/bastion/` serves; health 200; internal path 404 through nginx; the two Railway grep gates; stopping bastion-api leaves other apps up; `check:env-hints` green; a fresh `.env` without the keys gives the plain refusal, not a suite abort; the `syncNew` dry-run adds `BASTION_S3_BUCKET` and `BASTION_API_INTERNAL_URL` to the existing worker |
| **M2** | Migrations 0262-0269, Drizzle, RLS loop, hardened probe and resolver functions; GitHub change | `db:check` 0 drift; definer-function assertion green; `ping` stores `subscribed_events` |
| **M3** | Library, crosswalk, per-requirement applicability, setup wizard, deterministic compile, seeder started | SOC 2 then ISO share controls; SoA completeness test green |
| **M4** | Probes (with `runInOrgScopeRead`), evaluator (budgets, resumption, orphan re-enqueue, staleness), ledger, seals with bucket objects, identity-based restore detection with provisional epochs and append blocking, outbox with ordering, **`bastionEvents` registered**, bolt-api dispatch hook, `stop_grace_period: 75s` | probe goldens three times (RLS off, RLS on, separate read pool); both restore integration tests (restart and in place); the kill-mid-slice test; outbox ordering test |
| **M5** | Manual evidence, personal data and redaction, feeds, coverage, Readiness | Playwright 1-3 |
| **M6** | Gaps, fixes, exceptions, decide routes, internal Bam routes (tasks, comments, proposal close), proposal reconcile | Playwright 4-6 |
| **M7** | LLM tailoring with populations; policies and attestation | compiler gates |
| **M8** | Questionnaires and the xlsx codec | questionnaire gates; Playwright 7 |
| **M9** | Auditor room, packet (commitments verified via bastion-api), object sweep engine (intents), off-site mirror enqueued after a successful backup, the bastion-api `restore-objects` CLI, help | Playwright 8-11; packet smoke test with differing buckets; **Railway staging smoke test: one packet built and downloaded**; a failing mirror leaves the backup `completed` |
| **M10** | Permission chain; MCP client and handlers built and tested at `src/clients/bastion-client.ts` and `src/tools-pending/bastion.ts` (no `*-tools.ts` file yet); visibility; search; surface map | Playwright 12-15; section 4.6 probe matches section 5.5; `check-tool-return-coverage` and `docs:catalog:check` still green |
| **M11** | **One merge unit:** create `bastion-tools.ts` and register it, docs catalog, published counts, CLAUDE.md, Launchpad, marketing section, screenshots, README | Playwright 16; `check:app-completeness`, `check-tool-return-coverage`, and `docs:catalog:check` green |

Milestone history: round 2 added #128, the generator change, the stable-secret class, and the
enum check to M0, moved event registration to M4, and moved MCP registration to M11. Round 3
added the `db:check`/`lint:migrations` gate to M0, the worker propagation gate to M1, the
restore and kill-mid-slice tests to M4, the Railway packet smoke test to M9, and kept the
`bastion-tools.ts` file itself out of the tree until M11.

---

## 13. Reuse ledger

| Capability | Reused from | Genuinely new |
| --- | --- | --- |
| Fastify skeleton, error handler, shutdown | `apps/bursar-api/src/server.ts:54-196` | `trustProxy` hops |
| Permission enforcement invariant | `apps/bursar-api/src/boot/assert-permissions-enforce.ts` | the section 5.5 table |
| RLS binding and posture report | `apps/bursar-api/src/plugins/rls.ts:58-68` | hardened definer probes and resolvers |
| Auth (session, API key, impersonation) | `apps/bursar-api/src/plugins/auth.ts` | `rejectWhenImpersonating` |
| Health, readiness, metrics | `@bigbluebam/service-health` | nothing |
| Logging and error recording | `@bigbluebam/logging`; worker `recordWorkerError` | progress lines |
| Object storage | `@bigbluebam/storage` `createBootstrapDriver`, streaming `put` | own bucket, random keys, intents |
| Upload and AV scan | Bin upload route, `bin-av-scan` | explicit scan-state mapping |
| Bin access checks | `apps/bursar-api/src/lib/bin-asset-access.ts` | nothing |
| LLM access | `apps/bursar-api/src/lib/llm-client.ts` -> `POST /internal/llm/chat` | per-org permits |
| Leased permits | `admitLlmCall` (`apps/api/src/routes/internal-llm.routes.ts`) | org and service sets |
| Injection pre-scan | `apps/bursar-api/src/lib/injection-prescan.ts` | applied to cited labels |
| Advisory locks | `apps/burn-api/src/lib/advisory-lock.ts` | ledger lock with `lock_timeout` |
| Run claims, reaper, drive loop | Bursar reaper engine; `apps/worker/src/jobs/bursar-level.job.ts` | time budgets, in-place resumption |
| Immutability triggers | `0249_bursar_awards_baseline.sql` | hash chain, signed seals, bucket seal objects |
| Per-target ingest credentials | `apps/blip-api/src/db/schema/blip-ingest-keys.ts` | `bastion_feed_keys` |
| Stable secret notes | `BLIP_INGEST_PEPPER` hint (`env-hints.mjs:102-121`) | stable-secret class in `generateSecrets()` |
| HITL queue | `agent_proposals` + `proposal_*` tools | decider columns and `DECIDE_IN_APP` (#128) |
| Visibility preflight | `visibility-client.ts`, `visibility.service.ts` | six types |
| Cross-app links | `apps/bursar-api/src/lib/entity-links.ts` | five link specs |
| Bolt publish, catalog, intake | `publishBoltEvent`, `event-catalog.ts`, `bursar-dispatch-hook.ts` | outbox with ordering; `BOLT_SOURCES` (#124) |
| Bam tasks from a satellite | `internal-helpdesk.routes.ts`, upsert index 0130 | reopen semantics, comments by external id |
| Guest links | Bay public review | hashed fragment tokens, passcode lockout and unlock, allowlists |
| Backups | `backup-database.job.ts`, `platform_restores` | off-site evidence mirror, restore matching |
| Parsing, CSV safety | `@bigbluebam/structured-data`, `csv-safe.ts` | xlsx codec |
| PDF and zip | `pdf-lib`, `jszip` (worker deps) | streamed packet, SoA |
| Job retention | `withRetention`, `SCHEDULED_JOB_RETENTION` | nothing |
| MCP module | `bursar-tools.ts:55-80`, `register-tool.ts` | 24 tools |
| SPA shell, help | `apps/bursar/src/`, `@bigbluebam/ui`, `build-help-index.mjs` | Bastion pages |
| Seeding | `run-all.mjs`, expectations-constant pattern | `bastion.mjs` |

**Genuinely new:** the probe catalog as hardened definer functions with populations; the
crosswalked control model with per-requirement applicability and the SoA; the hash-chained ledger
with signed seals, bucket seal objects, epochs, and restore reconciliation; redactable personal
data; the manual-evidence lifecycle; the honest numbers with "not set up" and "risk accepted";
scoped exceptions; policy attestation; questionnaire banding tied to effective state; the
hardened auditor room; the xlsx codec; the Bam GitHub review ledger; and `DECIDE_IN_APP`
proposal ownership, a platform change every app can use.

---

## 14. Non-goals and v1.1

**Non-goals (v1):** not an auditor or certification body (every exported and shared surface says
so); no contract obligations (Bulwark) or outbound vendor questionnaires (Bursar); no scanning,
CSPM, or endpoint agents; no direct cloud, MDM, IdP, or HRIS connectors (the feed API is the
integration point); no LLM reading of uploaded files; no running access reviews or training; no
outbound email; Bastion never edits Beacon articles or Bolt rules; no vector retrieval; no
realtime.

**v1.1 candidates:**

| Item | Precondition |
| --- | --- |
| Public trust page (moved from v1 in round 1) | v1 auditor-room usage; legal review of public claims |
| LLM extraction of custom frameworks from a document (moved from v1) | `verifyCite` corpus gates on a labelled framework corpus |
| S3 Object Lock (WORM) for the Bastion bucket | a bucket created with object lock |
| LLM check that an uploaded file matches its request | measured reviewer load |
| Native MFA control | the platform ships MFA |
| GitHub branch-protection evidence | a GitHub App or token read path |
| Extending `v_activity_unified` with satellite branches | a platform decision for all satellites |
| Sibling-app feeds (training, incidents, access reviews) | those apps ship and register events |
| Evidence retention and legal hold | customer demand |
| Partitioning of snapshots, ledger, feed records | the 50 million row threshold |

---

## 15. Open questions and risks

1. **Framework text licensing** (legal, before M3).
2. **No platform MFA**; uploaded evidence only.
3. **Inherited controls** labelled as platform-provided.
4. **xlsx dependency** (`exceljs` or equivalent) needs approval.
5. **Immutability is detection, not prevention** until WORM.
6. **The crosswalk is a judgement**, with per-requirement applicability to compensate.
7. **Remediation default** `create` with reopen semantics.
8. **`v_activity_unified` not extended.**
9. **Lexical retrieval only.**
10. **Platform issues scheduled:** #121, #122 (patterns Bastion avoids); #123, #124, #125, #126,
    #127, #128 (fixed in M0).
11. **Small-team rules** (self-review, self-approval) are disclosed everywhere.
12. **Questionnaire PII** is member-readable, not viewer-readable.
13. **`BASTION_TRUST_PROXY_HOPS` on Railway** assumed 2; verified on the first deploy.
14. **Key escrow is an operator duty.** Losing `BASTION_PD_HMAC_KEY` makes commitments
    unverifiable (`key_changed`), though evidence bytes and the chain remain verifiable.
15. **Restore acknowledgement** depends on a recorded `platform_restores` row. A restore performed
    outside the platform's restore job (a manual `psql` restore) can only ever be `unmatched`;
    that is deliberate, and the guide tells operators to restore through the platform.
16. **LLM throughput** limits large questionnaires to tens of minutes; acceptable for v1, revisit
    if customers routinely bring 300+ row questionnaires.

---

## 16. Changelog

### Round 0

- Initial draft (2026-11-25).

### Round 1 (46 findings: 43 accepted, 3 adapted, 0 rejected)

Dispositions recorded in the round 1 revision, unchanged: design-1 to design-9 accepted;
stability-1 to stability-9 accepted; security-1 to -8 and -10 accepted, security-9 adapted;
best-practices-1 to -5 and -7 to -9 accepted, best-practices-6 adapted; infrastructure-1 to -7 and
-9 accepted, infrastructure-8 adapted. Trust page and custom-document extraction moved to v1.1;
option (b) multi-framework; Launchpad last; #123-#127 scheduled in M0.

### Round 2 (3 blockers and 26 majors: 26 accepted, 3 adapted, 0 rejected; 31 minors: 29 folded in, 2 adapted, 0 deferred)

**Orchestrator decisions applied:** security-1 done both ways (#128 columns in M0, plus Bastion
decide routes and mirrored-proposal closing); exceptions as `pass_with_exception` shown as "Not
met, risk accepted" with the medium cap, approver-differs rule, frozen refs, and 90-day
assertion-wide cap; restore detection against bucket seal objects with `epoch`, matched to a
platform restore and owner-acknowledged, never automatically benign; off-site mirror to a separate
destination, `unprovable` when unset.

**Design**
- design-1 accepted: `pass_with_exception` counted under Not met with a risk-accepted sub-count,
  never as proof; questionnaire capped at `medium`; `frozen_refs`; 90-day assertion-wide and
  365-day entity caps (sections 2.3, 2.6, 2.7, 10, 11.4 story 6).
- design-2 accepted: "Not set up yet" count and denominator everywhere the numbers appear;
  `not_assessed` gap after a 14-day grace, immediately when all assertions are rejected (sections
  1.2, 2.3).
- design-3 accepted: `stale` has no template and is one org-level row derived at read time
  (section 2.3; also the design minor about deriving at read time).
- design-4 accepted: NULL `subscribed_events` is "unknown"; the predicate still runs; the ping
  redelivery note; goldens include NULL (section 3.1).
- design-5 accepted: redacting a manual-evidence holder withdraws it and re-evaluates linked
  controls (section 3.3).
- design-6 accepted: `population_unlisted`, `population_drift` (0.70, `config_change` filing a
  superseding assertion), required "complete list" confirmation, `population_review` after 180
  days (sections 2.1, 2.3, 3.1).
- design-7 accepted: per-requirement applicability, derived control applicability, generated
  `statement_of_applicability.csv` in the room and ISO packet, completeness test (section 2.1).

**Security**
- security-1 (blocker) accepted, both options per the orchestrator: #128 migration `0261` and
  decide-route changes in M0; Bastion decide routes with `requireCan`, `rejectWhenImpersonating`,
  and a human check; mirrored proposals closed through an api internal route; foreign decisions
  ignored (sections 2.4, 2.6, 2.8, 8.4).
- security-2 accepted: seal objects in the bucket, `epoch`, matched-and-acknowledged restores
  only, lost ranges shown, unmatched gaps raise `evidence.integrity_failed` (section 3.4).
- security-3 accepted: same changes as design-1, plus owner and expiry on every surface.

**Stability**
- stability-A accepted: assertions may span slices; aggregation when the last snapshot lands;
  `lock_timeout` 3 s; `put` timeout 5 s; restated invariant `12 + 8 + 5 + 3 < 30` (section 7.3).
- stability-B accepted: partial nightly runs resume in place up to 3 times; the reaper releases
  claims rather than terminating resumable runs (section 7).
- stability-C accepted: same as security-2, with the restore integration test (section 11.2).
- stability-D accepted: `bastion_object_intents` bounds the sweep; sweep pauses during an open
  restore; shared objects reference-counted for redaction (sections 3.4, 4.1, 7).
- stability-E accepted: `ordering_key` with oldest-per-key delivery, comments addressed by
  `external_id`, operator re-drive (rows 98-99) and a `/metrics` counter (section 7).
- stability-F accepted: leased sorted-set permits, heartbeats while waiting, wait counted against
  the budget, SIGTERM drain, resumable compile and autofill (section 7.3).
- stability-G accepted: "current" defined against the backup's `started_at`; mirror pass run by
  the backup job; worker gets the bucket variables and builds its own driver; packet smoke test
  with differing buckets (sections 7, 9.1, 9.7).

**Best practices**
- best-practices-1 (blocker) accepted: `enqueueBastionEvent` with a literal name recognized by
  the catalog check, a `BASTION_EVENT_TYPES` equality test, `bastionEvents` registered in M4
  (section 8.1).
- best-practices-2 accepted: a `db-drift.yml` step comparing the live enum with `BOLT_SOURCES`
  (section 8.4).
- best-practices-3 adapted (with infrastructure-N2): secret hints carry `value: '<generate>'`, a
  `stable` flag, and notes; key format defined as 64-hex Ed25519 seed; rotation via
  `signing_key_id`; compose uses `:-` (not `:?`, which aborts the whole suite, per the
  infrastructure reviewer) and bastion-api refuses to start with a plain message (section 9).
- best-practices-4 accepted: MCP registration and every publication piece move into one M11 merge
  unit (sections 5.4, 9.6, 12).
- best-practices-5 accepted: hardened definer pattern (search_path with `pg_temp` last, REVOKE
  PUBLIC, GRANT to the app role, org guard) and a `pg_proc` assertion (section 3.1).

**Infrastructure**
- infrastructure-N1 (blocker) accepted: generator extended in M0 for `set $var host:port` and the
  resolver line, with a unit test and two M1 grep gates (sections 8.4, 9.2).
- infrastructure-N2 accepted: stable-secret class in `generateSecrets()` that never regenerates or
  rehydrates; `:-` in compose with a refusal message; `pd_hmac_key_id` and `key_changed`; key
  escrow in section 9.7.
- infrastructure-N3 accepted: same as security-2.
- infrastructure-N4 accepted: separate `BASTION_BACKUP_S3_*` destination; unset means
  `ops.backup_fresh` is `unprovable`; object-restore command (section 9.7).
- infrastructure-N5 accepted: bucket-name prompt for S3 and R2 defaulting to `${S3_BUCKET}-bastion`,
  boot put/stat/delete check, worker bucket env and driver (section 9.1).
- infrastructure-N6 adapted: propagation is opt-in per hint (`propagate: true`), never
  overwrites, prints the diff, and batches with `skipDeploys`; the initial opt-in set is the
  `*_API_INTERNAL_URL` and `*_API_URL` computed hints across all apps rather than Bastion's alone,
  because the #126 defect affects every app and the opt-in flag already bounds the blast radius
  (section 8.4).
- infrastructure-N7 adapted (with stability-F): permits copy the proxy's `admitLlmCall` pattern
  and fail open on a Redis outage; throughput restated as about 9-18 calls per minute service-wide
  (16-32 minutes for 96 rows); the round-1 figure was wrong (section 7.3).

**Minors** (29 folded in, 2 adapted, none deferred)
- Design: retired controls on archive (2.1); answer-library staleness on stored status only
  (2.7); stale gap derived at read time (2.3); exception approver named (2.6).
- Security: definer hardening (3.1); purge guard (**adapted**: reworded so the age predicate is
  the stated guard, because every service shares one superuser role and a caller check cannot
  distinguish them; a test proves recent rows cannot be deleted); RLS-safe resolvers (3.5);
  `object_missing` shown to auditors (3.4); `pd_mismatch` on read (3.4); redacted evidence stops
  counting (3.3); every public key published (3.4); feed pepper env (3.5, 9.4); room **Unlock**
  (5.2); body route re-checks visibility (3.6).
- Stability: distinct-night error counting (3.2); idempotent `evaluation.missed` (3.2); quota day
  rollover (3.5); daily retry plus **Check again** after the scan cap (3.3); replica-lag check
  (3.1); purge GUC wording (same adaptation as the security minor); `summary.pdf` wording (7.2).
- Best practices: explicit `0260` list without same-file use (4.4); purge guard reworded and
  tested (3.4); `BASTION_TRUST_PROXY_HOPS` renamed (9.4); README "23 apps" prose and
  `docs:readme:check` (9.6, 11.5); surface-map notes for #123, #124, #128 (9.6).
- Infrastructure: replica recovery conflicts are non-drifting and lag is recorded (3.1); hop count
  in `.env.example` and lockout keyed by (IP, room) (5.2, 9.4); secret hints with value and note
  (9.4); bastion-api starts without storage and shows a banner (9.1); confirm the `nginx.conf`
  stack before the runtime resolver (9.2).

### Round 3 (1 blocker and 9 majors: 8 accepted, 2 adapted, 0 rejected; 14 minors: all folded in, none deferred)

**Orchestrator notes applied:** the guarded `bam_app` grant plus owner execute, with an
owner-only-tolerant `proacl` test; identity-based restore detection at every append batch with
provisional epochs, append blocking, seal refusal, bucket restore objects, and an in-place restore
test; the HMAC key kept in bastion-api with packet verification through an internal engine and
`BASTION_S3_BUCKET` propagated; the mirror enqueued after the backup records success, with its own
status and cursor columns and a budget; `bastion-tools.ts` created only in M11.

- design-1 accepted: exceptions apply per assertion, then aggregate with `fail` > `unprovable` >
  `pass_with_exception` > `pass`; gaps are computed per assertion; unit case added (sections 3.2,
  11.1).
- design-2 accepted: exception expiry or revocation that worsens effective state writes a drift
  row with reason `exception_expired`, `control.drifted`, and a task upsert with reopen; approval
  comments "Risk accepted until {date}"; integration case added (sections 2.5, 2.6, 11.2).
- security-1 accepted: a provisional epoch opens at detection regardless of status, `seq`
  continues from the highest bucket-sealed head, acknowledgement only relabels, the seal run
  refuses a head below the highest bucket seal, lost ranges are written as `restores/` bucket
  objects, and the restore test now appends and seals after detection (sections 3.4, 4.1, 11.2).
- stability-1 accepted: the tick re-enqueues any `queued` run idle over 2 minutes; `resume_count`
  increments on every release and is part of the `jobId`; a 409 against a stale heartbeat waits and
  retries; `stop_grace_period: 75s` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=75`; kill-mid-slice
  test (sections 7, 7.3, 9.1, 9.4, 11.2).
- stability-2 accepted: identity comparison (`entry_hash` at the highest sealed seq), checked at
  the start of every append batch with a per-org cache invalidated by a newer seal object or a
  changed `max(platform_restores.completed_at)`; appends blocked while a restore row is
  unresolved, with runs going `partial` / `restore_pending`; in-place restore test with no restart
  (sections 3.4, 7.3, 11.2).
- best-practices-1 (blocker) adapted per the orchestrator: REVOKE from PUBLIC, owner execute, and
  `GRANT ... TO bam_app` only inside an `IF EXISTS (SELECT 1 FROM pg_roles ...)` guard; the
  `proacl` test accepts the owner-only posture (sections 3.1, 4.4).
- best-practices-2 accepted: `runInOrgScopeRead` binds the GUC, `READ ONLY`, and the timeout on the
  read pool; a NULL replay timestamp is zero lag; goldens run a third time against a separate read
  pool (sections 3.1, 11.2, 12).
- best-practices-3 accepted: `bastion-tools.ts` is created only in the M11 merge unit; M10 builds
  and tests under `src/clients/bastion-client.ts` and `src/tools-pending/bastion.ts`, which neither
  `check-tool-return-coverage.mjs` nor `listAllToolModules()` reads (sections 5.4, 12).
- infrastructure-R3-1 adapted: beyond the requested fix (HMAC key only in bastion-api, packet
  verification through the internal `verify-commitments` engine, `BASTION_S3_BUCKET` with
  `propagate: true`, M1 propagation gate, M9 Railway packet smoke test), the off-site mirror and
  object sweep also became bastion-api engines that worker jobs trigger, because the
  `BASTION_BACKUP_S3_*` secrets would otherwise hit the same flat-hint propagation gap on the
  worker (sections 7, 7.2, 9.1, 9.4, 12).
- infrastructure-R3-2 accepted: the backup records `completed` first, then enqueues the mirror with
  `jobId = backup.id`; `platform_backups.bastion_mirror_status` and `bastion_mirror_cursor`
  (migration `0261`); a 5,000 object or 2 GiB per-run budget with a resume cursor; a mirror failure
  never changes the backup's status (sections 7, 8.4, 9.7).

**Minors**
- Design: not-applicable controls are not evaluated (2.1); `population_review` carries cost 2
  (2.3).
- Security: the proposal-close route accepts only `owning_app = 'bastion'` proposals with a human
  member decider (8.4); the org guard on the read pool (same fix as best-practices-2, 3.1); the
  guide tells auditors to keep their own copies of seals (9.7).
- Infrastructure: the restore command is a real bastion-api CLI with compose and Railway forms
  (9.7); the job table and section 9.7 now agree on how the mirror runs (7, 9.7).
- Stability: the exact protected columns per immutable table, including the operational columns
  on `bastion_evidence_objects` (3.4); a dead outbox row stops blocking its key (7); poll intervals
  and caps sized above the stated durations, with self re-enqueue (7); the mirror budget and
  non-failing behavior (9.7); the wider lost range when a seal object was not yet delivered is
  documented as expected (3.4).
- Best practices: the Drizzle update for the five `agent_proposals` columns with `decided_by_kind`
  on `actorTypeEnum` (4.4, 8.4); `pnpm db:check` and `pnpm lint:migrations` in the M0 gate (12).

**Counts after round 3:** unchanged from round 2 (35 tables; 106 REST endpoints plus 3 health
routes, 34 with a tool and 72 skips; 24 tools; 50 permissions; 24 events; 19 jobs; 12 migration
files). The new engines (`verify-commitments`, `mirror-objects`, `object-sweep`) run behind the
existing row 106, and the new columns live in existing tables and migrations.
