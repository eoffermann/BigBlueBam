# Bolt automation templates — functionality audit (2026-06-13)

Bolt ships pre-built automation templates and a set of seeded "live" demo
automations. Their subjects were sound but their trigger/condition/action
config was wrong almost everywhere, so they did not do what they claimed.
This pass rebuilt the fixable ones, flagged the ones that genuinely need an
agent-in-the-loop, and brought the seed data into line with the real event
catalog and action registry.

Scope of files touched:

- `apps/bolt-api/src/services/template.service.ts` — 15 inline templates.
- `apps/bolt-api/src/templates/banter-approval-dm.ts` — the 16th template.
- `scripts/seed-bolt.sql` — 12 seeded live automations + sample executions.

Authoritative references used to verify every change:

- Trigger events + payload field names: `apps/bolt-api/src/services/event-catalog.ts`.
- Action registry (allowed `mcp_tool` names): `getAvailableActions()` in the same file.
- LIVE MCP tool signatures (what the worker actually calls): the
  `registerTool({ name, input })` blocks in `apps/mcp-server/src/tools/*-tools.ts`.
- Condition operators: `apps/bolt-api/src/services/condition-engine.ts`.
- Payload wrapping + filter semantics: `apps/bolt-api/src/routes/event-ingestion.routes.ts`.
- Action-param templating + dispatch: `apps/worker/src/jobs/bolt-execute.job.ts`.

---

## Two systemic bugs (guidance for future template authors)

### Bug A — condition fields must be prefixed `event.`

At evaluation time the event payload is wrapped:

```
{ event: <the ingested payload>, actor: { id, type } }
```

(see `event-ingestion.routes.ts`, the `fullPayload` object). A condition whose
`field` is `task.priority` resolves against the *wrapper*, finds no top-level
`task` key, returns `undefined`, and the condition silently never matches. The
field must be `event.task.priority`. Every condition that reads the event body
must start with `event.`.

Templates that had bare (unprefixed) condition fields and were fixed:
`tpl_notify_task_overdue`, `tpl_auto_assign_ticket`, `tpl_high_priority_task_alert`,
`tpl_new_member_onboard`.

### Bug B — action param keys must match the LIVE MCP tool signature

The worker (`bolt-execute.job.ts → callMcpTool`) forwards resolved parameters
**verbatim** to `POST /tools/call` as `arguments`. It does no key remapping and
no schema validation. So the param keys in a template must be exactly what the
live MCP tool's `input` Zod schema names. The wrong keys seen across templates:

| Tool | Wrong keys used | Correct LIVE keys |
| --- | --- | --- |
| `banter_send_dm` | `user_id`, `message` | `to_user_id`, `content` |
| `banter_post_message` | `channel_name`, `message` | `channel_id`, `content` (`channel_id` accepts a bare channel name / `#name`, so only the keys were wrong) |

Two more sub-rules under Bug B:

- **`{{ actor.name }}` does not exist** in the action template context. The
  worker only populates `actor.id` and `actor.type`. Use `{{ event.actor.name }}`
  (the bam/brief event payloads carry `actor.name`). Same for org: there is no
  top-level `{{ org.* }}`; use `{{ event.org.* }}`.
- **Unknown tool names hard-fail at dispatch.** `banter_send_message`,
  `helpdesk_assign_ticket`, `helpdesk_update_priority`, `helpdesk_reply_ticket`,
  and `helpdesk_update_ticket` are not registered. They were replaced with real
  tools (`banter_post_message`, `update_ticket_status`, `reply_to_ticket`).

### Drift note discovered during the audit

`apps/bolt-api/src/services/mcp-tool-schemas.generated.ts` is **stale for
`banter_send_dm`**: the generated schema lists the param as `user_id`, but the
live MCP tool (`apps/mcp-server/src/tools/banter-tools.ts`) names it
`to_user_id`. The worker calls the live tool, so `to_user_id` is correct at
runtime. The generated file feeds only the rule-builder's typed param picker,
so the UI will mislabel this one param until the generator is re-run. Tracked as
an open question below.

Two other catalog-vs-reality mismatches worth recording:

- The bam task-event payload annotates `task.priority` as enum
  `['low','medium','high','urgent']`, but priorities are per-org configurable
  since migration 0183 and the **default seed set is**
  `['critical','high','medium','low','none']`. So `urgent` is not a default
  slug and `critical` *is*. `create_task` (the MCP tool) accepts
  `critical|high|medium|low|none`. Conditions in the rebuilt templates match on
  `high`/`critical`.
- `task.moved` exposes the destination phase as a **flat** `to_phase_name`, not
  a nested `to_phase.name`. Both the template and the seed condition were wrong
  here.

---

## All 16 templates

| Template | Stated purpose | Was broken how | Resolution |
| --- | --- | --- | --- |
| `tpl_notify_task_overdue` | DM assignee when a task is overdue | cond `task.assignee_id` unprefixed; DM used `user_id`/`message` | **Rebuilt.** `event.task.assignee_id`; `to_user_id`/`content`. |
| `tpl_auto_assign_ticket` | Move high-priority tickets to in-progress | cond `ticket.priority` unprefixed | **Rebuilt.** `event.ticket.priority`. Action `update_ticket_status` was already correct. |
| `tpl_sprint_complete_summary` | Post summary on sprint completion | `banter_post_message` used `channel_name`/`message` | **Rebuilt.** `channel_id`/`content`. |
| `tpl_beacon_expiry_alert` | Notify on beacon expiry | `channel_name`/`message` | **Rebuilt.** `channel_id`/`content`. |
| `tpl_task_comment_to_banter` | Mirror task comments to a channel | `channel_name`/`message`; referenced raw `event.task.id` | **Rebuilt.** `channel_id`/`content`; uses `event.task.human_id` + `event.actor.name`. |
| `tpl_brief_approved_to_beacon` | Promote published doc to Beacon | called `beacon_create` with a non-existent `source_document_id` and no required `body_markdown` | **Rebuilt** via `brief_promote_to_beacon` (needs only `id`, which the payload has). Functional; see note below on curation. |
| `tpl_sla_breach_escalate` | Notify + open follow-up task on SLA breach | `channel_name`/`message`; `create_task` missing required `project_id`+`phase_id` | **Rebuilt.** Banter keys fixed; `create_task` now carries `project_id`/`phase_id` placeholders with an explicit "set these before enabling" note (the event has no project context). |
| `tpl_high_priority_task_alert` | Alert on high-priority task creation | two unprefixed `or` conds; `critical` invalid for this path; `channel_name`/`message` | **Rebuilt.** One `event.task.priority in ['high','critical']` cond; `channel_id`/`content`. |
| `tpl_daily_standup_reminder` | Daily standup reminder (cron) | `channel_name`/`message` | **Rebuilt.** `channel_id`/`content`; description tells the user to supply a `cron_expression` at instantiate. |
| `tpl_new_document_notification` | Notify on new Brief document | `channel_name`/`message`; `{{ event.actor.id }}` shown as author | **Rebuilt.** `channel_id`/`content`; `{{ event.actor.name }}`. |
| `tpl_weekly_status_update` | "Generate a weekly report" | implied a generated report; `channel_name`/`message` | **Rebuilt as a reminder** (renamed "Weekly status reminder"); honest copy + fixed keys. Real report generation would need an agent or a `bench_generate_report` step. |
| `tpl_task_moved_to_review` | Notify reviewer when task hits Review | cond `event.to_phase.name` (wrong shape); `user_id`/`message`; "reviewer" copy misleading | **Rebuilt.** `event.to_phase_name`; `to_user_id`/`content`; copy now honestly says it DMs the assignee (no reviewer field exists). |
| `tpl_banter_approval_dm` | DM approver on approval request | `user_id` (should be `to_user_id`) | **Rebuilt.** Single key change; `content` was already correct. |
| `tpl_new_member_onboard` | Welcome + onboarding tasks on member join | no member-join event exists; per-person task gen needs an agent | **Needs agent.** Marked PLACEHOLDER in name + description; left as the narrow "new DM channel" welcome it can actually do. |
| `tpl_close_ticket_on_task_complete` | Resolve linked ticket on task complete | `task.completed` has no `linked_ticket_id`; tool `helpdesk_update_ticket` not registered | **Needs agent.** Renamed "(requires agent)"; swapped to the real `update_ticket_status`; guard condition keeps it inert until an agent supplies the mapping. |
| `tpl_bond_deal_close_invoice` | Auto-create invoice when a deal is won | wrong event `deal.status_changed`; `bill_create_invoice` needs a Bill `client_id` the payload lacks; `{{ actor.name }}`/`{{ org.id }}`/`event.deal.value`/`event.deal.name` all wrong | **Needs agent** for the invoice step. Switched to real `deal.won` event; replaced the broken invoice action with a working owner DM (correct `deal.title`/`deal.amount`/`deal.owner_id`). |

---

## The five agent-in-the-loop templates — what an agent would need to do

1. **`tpl_brief_approved_to_beacon`** (now functional via `brief_promote_to_beacon`,
   but agent adds value). `beacon_create` requires `body_markdown`, which the
   `document.published` payload does not carry — that is why the original
   `beacon_create` wiring was unfixable in pure Bolt. `brief_promote_to_beacon`
   sidesteps this because the Brief API reads the document body itself; it needs
   only the document id. The remaining gap an agent could close: curated
   visibility, summary, and tag mapping. An agent would call
   `brief_promote_to_beacon`, then `beacon_update` to set visibility/tags.

2. **`tpl_new_member_onboard`.** There is no member-join trigger event in the
   catalog. The closest, `banter channel.created`, fires on channel creation,
   not on a person joining an org/project. Even with a join signal, deciding
   *which* onboarding tasks apply to *which* role and assigning owners is a
   judgement call. An agent subscribed to the real join signal would: look up
   the new member's role/team, select an onboarding task template, call
   `create_task` per item with the right project/phase/assignee, and post a
   tailored welcome.

3. **`tpl_close_ticket_on_task_complete`.** The `task.completed` payload has no
   `linked_ticket_id`, and Bolt has no task→ticket resolver reachable from an
   action. An agent would take the completed task id, search Helpdesk for the
   ticket linked to it (via an entity-link lookup or a ticket whose body/links
   reference the task), and call `update_ticket_status` (or `reply_to_ticket`)
   on the resolved ticket. The guard condition (`event.task.linked_ticket_id
   is_not_empty`) keeps the template inert in the meantime.

4. **`tpl_bond_deal_close_invoice`.** Both `bill_create_invoice` and
   `bill_create_invoice_from_deal` require a Bill `client_id`. The `deal.won`
   payload carries only a Bond company/contact, with no Bill client reference,
   and there is no Bond-company→Bill-client resolver in the dispatch path. An
   agent would: read the won deal, find or create the matching Bill client
   (`bill_list_clients` search, else create), then call
   `bill_create_invoice_from_deal` with `deal_id = {{ event.deal.id }}` and the
   resolved `client_id`. The owner-notification DM in the rebuilt template works
   as-is and tells the owner exactly that.

5. **(Honorable mention) `tpl_sla_breach_escalate`'s `create_task` step.** Not
   agent-required, but not self-contained either: `create_task` needs both
   `project_id` and `phase_id`, and the `ticket.sla_breach` payload has no
   project context. The template ships with `REPLACE_WITH_PROJECT` /
   `REPLACE_WITH_PHASE` placeholders and an explicit instruction to set them
   before enabling. An org that wants this fully hands-off could instead route
   the breach to an agent that picks the right project per ticket category.

---

## seed-bolt.sql findings

The 12 seeded automations had the same Bug A / Bug B problems plus a few of
their own:

- **Four non-existent tools** were referenced and replaced:
  `banter_send_message` → `banter_post_message` (a1, a3, a6, a7, a8, a11);
  `helpdesk_assign_ticket` → `update_ticket_status` (a4);
  `helpdesk_update_priority` → `update_ticket_status` (a5, with a note that no
  priority-update tool is registered, so status is bumped instead);
  `helpdesk_reply_ticket` → `reply_to_ticket` with `{ ticket_id, body }` (a10).
- **`banter_send_dm` actions** were switched from `user_id`/`message` to
  `to_user_id`/`content` (a2, a9, a12).
- **a5's notify step cannot DM anyone.** The `ticket.sla_breach` payload carries
  no user reference at all (no `actor`, no assigned-agent id), so the original
  `banter_send_dm` to `event.ticket.assigned_agent_id` could never resolve a
  recipient. It was changed to a `banter_post_message` into an `escalations`
  channel (a literal channel name that does resolve).
- **`{{ actor.name }}`** in actions (a1, a3, a7, a9) was changed to
  `{{ event.actor.name }}`.
- **The deliberately-failed sample execution** (e4) used a `banter_send_dm`
  with `user_id: null` and an automation (a9) whose payload set `reviewer_id:
  null`. It is now a clean success: the trigger payload carries a real
  `assignee_id`, the condition reads the flat `to_phase_name`, and the step
  resolves `to_user_id` properly. The `UPDATE ... SET error_message` line for e4
  was removed.
- **`a10` (Close Ticket on Task Complete) is now `enabled = false`** because it
  needs an agent (see above); its guard condition would never match anyway.

### The trigger_filter vs condition prefix conflict (NOT rearchitected — documented)

`bolt_automations.trigger_filter` (a JSONB column) and `bolt_conditions.field`
use **opposite** path conventions, and this is load-bearing for the seed:

- `trigger_filter` is evaluated in `event-ingestion.routes.ts` against the
  **raw** `event.payload` object, by literal dot-path split, with **no
  `event.` prefix**. For a `task.created` event whose payload nests
  `task.priority`, the correct filter key is `"task.priority"`. The original
  seed used `{"priority": "critical"}` (wrong path — there is no top-level
  `priority`) so the filter never matched. Fixed to `{"task.priority":
  "critical"}`. Likewise a4 `{"category": ...}` → `{"ticket.category": ...}` and
  a12 `{"mentioned_user": ...}` → `{"mentioned_user.name": ...}`.
- `bolt_conditions.field` is evaluated against the **wrapped** payload and
  **does** require the `event.` prefix (Bug A).

So in the same automation, the trigger_filter says `task.priority` and the
condition says `event.task.priority`, and both are correct. This is confusing
but intentional in the current code; this audit documents it rather than
changing the evaluation code, per the task constraints. If a future change
unifies the two, the seed filters and the per-template conditions must move
together.

---

## How the changes were verified

- **Trigger events** (`deal.won`, `document.published`, `document.promoted`,
  `task.moved`, `ticket.created`, `ticket.sla_breach`, `beacon.expired`,
  `cron.fired`, …) were each confirmed present in `event-catalog.ts`, and the
  specific payload fields referenced in conditions/actions (e.g.
  `to_phase_name`, `deal.amount`, `deal.owner_id`, `task.days_overdue`,
  `mentioned_user.id`) were confirmed in those events' `payload_schema`.
- **Action tool names** were confirmed against `getAvailableActions()` (the
  allowlist) — every tool used (`banter_send_dm`, `banter_post_message`,
  `update_ticket_status`, `reply_to_ticket`, `create_task`,
  `brief_promote_to_beacon`) is in that list.
- **Action param keys** were confirmed against the LIVE `registerTool({ input })`
  Zod schemas in `apps/mcp-server/src/tools/*-tools.ts` (banter, helpdesk, task,
  beacon, brief, bill), because the worker forwards keys verbatim and the
  generated schema file proved stale for `banter_send_dm`.
- **Condition operators** (`equals`, `in`, `is_not_empty`, `greater_than`) were
  confirmed against `condition-engine.ts`.
- `pnpm --filter @bigbluebam/bolt-api typecheck` passes clean.

---

## Open questions

1. **Regenerate `mcp-tool-schemas.generated.ts`.** It is stale for
   `banter_send_dm` (`user_id` vs the live `to_user_id`) and possibly other
   tools. Re-running `scripts/extract-mcp-tool-schemas.mjs` would fix the
   rule-builder's typed param picker. Out of scope here (would touch a generated
   file and possibly other apps).
2. **Fix the `task.priority` enum in `event-catalog.ts`** to reflect the
   per-org default slugs (`critical|high|medium|low|none`) instead of the stale
   `low|medium|high|urgent`. Out of scope (separate from template content).
3. **Consider a registered `helpdesk` priority-update tool.** The SLA-breach
   automation wants to raise priority, but no priority-update tool exists, so
   the seed bumps status instead. If priority escalation is a real product
   need, a tool should be added.
4. **Decide the long-term `trigger_filter` convention.** The raw-path filter vs
   `event.`-prefixed condition split is a footgun. Either is fine in isolation;
   having both is the problem.
