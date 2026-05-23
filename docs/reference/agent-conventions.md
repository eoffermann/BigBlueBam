# Agent Conventions

Status: living document (Wave 2).
Audience: anyone building an agent runner that speaks to the BigBlueBam MCP
server or an agent-adjacent service on top of the platform.

This document collects the behavioural rules agents MUST follow so they do
not leak data, do not drift from the canonical entity vocabulary, and stay
legible to auditors and human operators. It is deliberately short; for
architectural context see `AGENTIC_TODO.md` and Section 26 of the design
document.

## 1. Visibility preflight - the `can_access` contract

**Rule.** Any agent that posts cross-app results into a shared surface MUST
preflight every cited entity through the visibility preflight tool for the
surface's intended audience, and MUST filter out anything that is not
allowed.

"Shared surface" here means any place where the cited entity will be seen
by someone other than the agent itself or its owning service account. In
practice this covers Banter channels, helpdesk ticket public replies,
Brief document comments, Beacon links inside published entries, and any
other place where "the asker" and "the citation audience" might differ.

**Tool.** `can_access(asker_user_id, entity_type, entity_id)` (MCP)
delegates to `POST /v1/visibility/can_access` on the Bam API. Response:

```json
{
  "data": {
    "allowed": true | false,
    "reason": "ok" | "not_found" | "cross_org" | "not_project_member" |
              "private_document_no_collaborator" | "bond_restricted_role_not_owner" |
              "beacon_private_not_owner" | "beacon_project_not_member" |
              "unsupported_entity_type",
    "entity_org_id": "<uuid, when resolvable>"
  }
}
```

Every non-`ok` reason means "do not surface". The reason code is for
telemetry (and, when applicable, for deciding whether to escalate to a
human operator with "I found something but could not cite it").

## 2. Canonical `entity_type` list (Wave 2)

Only the following entity types have preflight coverage. Any other value
returns `allowed: false, reason: 'unsupported_entity_type'`.

| entity_type        | physical table          | visibility rule (summary)                                                          |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| `bam.task`         | `tasks`                 | project member, or org admin/owner                                                 |
| `bam.project`      | `projects`              | project member, or org admin/owner                                                 |
| `bam.sprint`       | `sprints`               | project member of the sprint's project, or org admin/owner                         |
| `helpdesk.ticket`  | `tickets` (helpdesk)    | project member if `project_id` is set; otherwise "same org" (inbound triage)       |
| `bond.deal`        | `bond_deals`            | same org; for role member/viewer, also `owner_id === asker_user_id`                |
| `bond.contact`     | `bond_contacts`         | same org; for role member/viewer, also `owner_id === asker_user_id`                |
| `bond.company`     | `bond_companies`        | same org                                                                           |
| `brief.document`   | `brief_documents`       | mirrors `documentVisibilityPredicate` (org / private / project with collaborators) |
| `beacon.entry`     | `beacon_entries`        | mirrors Beacon graph visibility (Organization / Private owner / Project member)    |

**Forward pointer:** Wave 3 will extend coverage to Bearing (goals/KRs),
Board (rooms), Blast (campaigns), Book (events), Bill (invoices), Blank
(forms), Banter (messages and channels), and Bolt (rules). Until then
agents that cite those entity kinds MUST NOT surface them cross-audience.

## 3. Determining `asker_user_id`

The `asker_user_id` is the human whose visibility gates the surface, not
the agent's own service account.

- **Banter message replies.** The message author whose thread the agent is
  replying into.
- **Helpdesk ticket.** The `helpdesk_user_id` when it has been linked to
  a Bam user (via the helpdesk-user mapping); otherwise fall back to the
  assigned agent or the ticket's `created_by` if it was internally filed.
  Never cite on behalf of an unmapped external customer: they do not have
  Bam visibility and every preflight will deny.
- **Brief comment / suggestion.** The user who owns the comment thread the
  agent is annotating.
- **Bolt rule running "on behalf of" a user.** Use the `actor_id` on the
  triggering event if it is a human; otherwise the agent is running
  without a human asker and MUST NOT cite any private entity.
- **Scheduled digest / cron-style post.** No asker. Cite only
  `visibility='Organization'` (or equivalent "public inside this org")
  entities, and run a preflight against a synthetic "least-privileged"
  member of the org to confirm.

When in doubt, err on the side of using the strictest asker you can
justify. Citing more than the audience is allowed to see is a leak.

## 4. Handling `unsupported_entity_type`

If the preflight returns `reason: 'unsupported_entity_type'` the agent
MUST NOT surface the entity until a preflight branch exists for that
type. Treat the absence of a rule as "deny by default".

This rule applies recursively: if a composite result (for example a
cross-app search hit) includes any unsupported entity type, drop that
hit rather than returning a partially-filtered list without announcing
what was dropped.

## 5. Delegated scope tokens (Wave 3 sketch)

Wave 2 ships only the preflight. Wave 3 will add a delegated-scope model:
an agent invoked on behalf of a human may mint a short-lived token that
is scoped to the asker's effective visibility, then run the surfacing
query through that token so RLS enforces the filter without requiring the
agent to call `can_access` per entity.

Design not finalized; tracked in `AGENTIC_TODO.md` §11 and §12. Until the
delegated-token flow lands, the preflight is mandatory.

## 6. HITL (human-in-the-loop) inbox routing

Agent-authored proposals that require human approval (Wave 2 Section 9)
will land in a unified Approvals UI at `/b3/approvals`. Agents that need
confirmation before a destructive action MUST use the proposal surface
rather than inventing their own approval channel, so humans see one list
instead of several.

The existing `confirm_action` MCP tool (the 60-second token dance) is the
low-latency path for in-conversation confirmations; it stays. The
`/b3/approvals` surface is for proposals that outlive a conversation or
that a human other than the asker needs to approve.

## 7. Audit expectations

- `can_access` denials triggered by an agent on behalf of a different
  human (asker_user_id differs from the caller's user id) are logged to
  `activity_log` with action `visibility.preflight_denied`. Agents do
  NOT need to log this themselves; the API route does it.
- Agents SHOULD call `agent_heartbeat` at least once per minute while
  running, and `agent_self_report` at the end of each logical run, so the
  `agent_runners` and `activity_log` audit trail stays populated.
- Per AGENTIC_TODO §10, every `activity_log` row has
  `actor_type ∈ {human, agent, service}` which is populated
  automatically from `users.kind`. Agents do not need to stamp
  `actor_type` manually unless they want to.

## 8. Related references

- `AGENTIC_TODO.md` - the capability-vs-tool gap analysis, including this
  section (§11).
- `apps/api/src/services/visibility.service.ts` - authoritative preflight
  logic. The `SUPPORTED_ENTITY_TYPES` export is the single source of
  truth for the allowlist above.
- `apps/mcp-server/src/tools/visibility-tools.ts` - MCP tool wrapper.
- `apps/brief-api/src/services/document.service.ts::documentVisibilityPredicate`
  and
  `apps/beacon-api/src/services/graph.service.ts` - the per-app
  predicates that the preflight mirrors. Keep the preflight service in
  lockstep when those rules change.
