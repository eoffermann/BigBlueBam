# Bolt: ID-vs-Name Mapping Strategy

**Status:** Design — no code changes proposed in this document. The intent is
to align on a path forward before any of the work below is scheduled.

**Authors:** Audit conducted across all 14 BigBlueBam apps and the Bolt event
ingestion path. Findings synthesized from six parallel agent reports stored
in this document's appendices and at the file paths cited inline.

---

## 1. Executive summary

Bolt rules wire **events** ("when X happens in app A") to **actions** (call
an MCP tool in app B). Today this works in narrow, happy-path scenarios but
breaks down whenever the rule author needs to refer to anything by a
human-friendly name. Three problems compound:

1. **Most MCP actions take only opaque UUIDs** — `channel_id`, `project_id`,
   `assignee_id`, `pipeline_id`, `stage_id`, `template_id`, `widget_id`,
   `report_id`, `client_id`, etc. A rule author writing "post to #general
   when a deal closes" has nowhere to turn — neither the event payload nor
   any MCP lookup tool gives them the channel UUID for `#general`.

2. **Event payloads are thin and undocumented in places where the producer
   actually emits more** — and worse, in several places the producer emits a
   *different shape* than the event catalog claims. Rule authors building
   templates against the catalog get empty strings at runtime.

3. **There are virtually no name-resolution tools** — no `find_user_by_email`,
   no `banter_get_channel_by_name`, no `bond_list_pipelines`, no
   `bench_list_widgets`. For a dozen high-value entities (phases, labels,
   states, calendars, board templates, scheduled reports, billing clients,
   key results), no MCP tool exists at all that returns them — nothing for
   a rule (or a human) to chain.

The audit found **322 MCP tools** across 24 source files. **45 of them are
HIGH-severity rule-authoring traps** — common automation targets that
require multiple opaque IDs with no resolution path. Below those, a much
larger MEDIUM tier (~80 tools) has *some* resolution path but it's clunky
or partial.

**There are also four hard bugs** in the producer/ingest path that have
nothing to do with strategy choice and just need fixing — the Bond producer
emits `bond.deal.*` event types that match nothing in the catalog (so no
Bond automation can ever fire), no producer forwards `actor.id` (so
`{{ actor.id }}` is always empty), Banter's `message.posted` payload is
flat where the catalog says nested (so `{{ event.channel.name }}` is always
empty), and the worker silently substitutes empty strings for missing
template paths with no warning anywhere.

**The proposed strategy is layered**, with the layers ordered so each one
delivers value without requiring the next:

- **Tier 0 — Fix the bugs.** Bond event-type prefix, actor forwarding,
  Banter shape mismatch, worker silent-empty handling. Without these, no
  amount of strategy work moves the needle.

- **Tier 1 — Enrich every event payload.** Producers should emit *all*
  IDs the rule author plausibly needs (to chain into any common action)
  *plus* canonical names and deep-link URLs (so messages can be
  human-readable). Document the catalog as a contract and validate
  producers against it in CI.

- **Tier 2 — Add resolver tools where they're missing.** ~25 small new
  MCP tools (`*_by_name`, `*_by_email`, `*_by_handle`, list-with-search)
  that turn the human-known identifier into the UUID a downstream action
  needs. These are the explicit "preflight lookup" path Bolt rules will
  chain.

- **Tier 3 — Accept name-or-id in the highest-severity action params.**
  Change the Zod schemas on a small number of canonical actions
  (`banter_post_message`, `bam_create_task`, `bond_move_deal_stage`, etc.)
  to accept either the UUID or the natural name/handle, with the server
  resolving server-side. This eliminates the preflight lookup for the
  90th-percentile common rule.

- **Tier 4 — Template-time resolvers in the worker.** Add a small set of
  pipe-style filters (`{{ event.task.assignee_id | user_email }}`) so
  rule values can be transformed at action execution. Lower priority
  because Tiers 1+3 cover most real cases.

- **Tier 5 — Strict template mode + UI hints.** Surface missing-path
  warnings in execution logs by default, with a per-rule "strict" toggle
  that fails the step on empty resolution. Improve the rule builder UI
  with autocomplete and lookup helpers.

The rest of this document quantifies the scope, walks through each tier,
and ends with a concrete prioritization recommendation.

---

## 2. How rules and events flow today

```
Producer service (e.g. apps/api/src/services/task.service.ts)
  │  publishBoltEvent('task.created', 'bam', { task }, orgId)
  ▼
POST /v1/events/ingest  →  apps/bolt-api/src/routes/event-ingestion.routes.ts
  │  {event_type, source, payload, org_id, actor_id?}
  │  • generates event_id
  │  • finds bolt_automations matching (org_id, source, event_type, enabled=true)
  │  • for each: enforces rate/cooldown, evaluates conditions, queues a job
  ▼
BullMQ "bolt-execute" queue
  ▼
Worker  →  apps/worker/src/jobs/bolt-execute.job.ts
  │  builds template context: { event: payload, actor: {...},
  │                              automation: {...}, stepResults: [] }
  │  for each action step:
  │    • resolveTemplateString('{{ event.task.id }}') etc.
  │    • POST to MCP server's /tools/call with the resolved parameters
```

Two things from this flow drive the rest of the document:

**(a) The rule author writes templates against `payload`**, not against the
documented `payload_schema`. The catalog is a UI hint, not a contract. If
the producer emits a field, the author can use it; if not, the template
silently resolves to `''`.

**(b) The action's parameter schema is the MCP tool's Zod schema.** That's
where `z.string().uuid()` lives. Whatever the catalog and the events look
like, the action will reject anything that isn't a valid UUID — and the
worker won't help, because it just stringifies whatever the template
resolves to and forwards it.

So the question "how does a rule author know the channel UUID for `#general`"
has exactly one of three answers:

1. **It's already in the event payload** (because the producer put it there)
2. **A preceding action step looks it up** (some `*_by_name` resolver tool
   the author can chain)
3. **The rule author hard-codes the UUID** (which means looking it up by
   hand, somewhere — usually the dashboard — and then never being able to
   share the rule)

Today, for many entity types, the answer is #3. That's the problem.

---

## 3. Quantified scope of the problem

### 3.1 By app — tools requiring opaque IDs

Counts come from the per-app audits in Appendix A. "HIGH severity" means a
tool that's a common automation target, requires multiple opaque IDs, and
has no resolution path; "MEDIUM" means some IDs have a workable two-step
path; "LOW" means the IDs are typically present in trigger event payloads.

| App         | Tools | HIGH | MEDIUM | LOW | Notes |
|-------------|------:|-----:|-------:|----:|-------|
| Bam         |   47  |   6  |    10  |  31 | Phases, labels, states, epics have NO listing tool at all |
| Banter      |   47  |   8  |    10  |  29 | No user-identity resolver anywhere; channel-id-only is the #1 pain |
| Beacon      |   29  |   0  |     6  |  23 | `beacon_get` accepts slug — pattern to copy |
| Brief       |   18  |   2  |     7  |   9 | `brief_get` accepts slug, but `brief_update` etc. don't — jarring inconsistency |
| Helpdesk    |    7  |   0  |     3  |   4 | Tickets likely have human numbers but only UUIDs accepted |
| Bond        |   20  |   3  |     5  |  12 | **No pipeline or stage listing tool exists** |
| Blast       |   13  |   2  |     0  |  11 | **No campaign listing tool at all** |
| Bearing     |   12  |   1  |     6  |   5 | **No key-result listing tool** — KRs only reachable via 2-hop |
| Bolt        |   14  |   2  |     2  |  10 | `bolt_enable` / `bolt_disable` by name impossible |
| Blank       |   11  |   0  |     6  |   5 | Form-by-slug/name missing |
| Book        |   10  |   1  |     3  |   6 | **No calendar listing tool exists** |
| Board       |   14  |   2  |     8  |   4 | Board templates fully unresolvable |
| Bench       |    8  |   2  |     1  |   5 | Widgets only nestable; scheduled reports have no listing |
| Bill        |   15  |   2  |     3  |  10 | **No billing-client listing tool exists** |
| **Total**   |  **265** | **31** | **70** | **164** | |

(Audits 1-4. The total is approximate because the agents counted slightly
different things — some auditing every `server.tool(...)` call, some
counting per-tool-file groupings. The trend is what matters.)

### 3.2 The HIGH-severity hot list

The 31 HIGH-severity tools cluster into a small number of canonical
"automation patterns" that every BigBlueBam customer will want to write:

| Pattern | Tools | Why it hurts |
|---------|-------|-------------|
| **"Post to #channel when X"** | `banter_post_message`, `banter_share_task`, `banter_share_sprint`, `banter_share_ticket` | Channel UUIDs aren't in cross-app events; humans think in channel names |
| **"DM the assignee/owner when X"** | `banter_send_dm`, `banter_send_group_dm`, `banter_add_channel_members`, `banter_add_group_members` | No user-identity resolver exists anywhere in the entire MCP surface |
| **"Create a task in project P, phase Q with label L when X"** | `create_task`, `update_task`, `move_task`, `bulk_update_tasks` | Phase, label, state are completely unresolvable from name |
| **"Open a deal in pipeline P, stage S when X"** | `bond_create_deal`, `bond_move_deal_stage` | Bond has no pipeline or stage listing tool — fully stranded |
| **"Send the Welcome campaign when X"** | `blast_send_campaign`, `blast_draft_campaign` | Blast has no campaign listing tool — fully stranded |
| **"Bump KR by N when X"** | `bearing_kr_update` | Bearing has no key-result listing tool — KRs only reachable via 2-hop through goals |
| **"Create a kickoff event on calendar C when X"** | `book_create_event` | No calendar listing tool exists |
| **"Add a sticky to board B when X"** | `board_add_sticky`, `board_add_text` | Board listing exists but no name search; cross-app rules have no path |
| **"Run report R when X" / "Query widget W when X"** | `bench_generate_report`, `bench_query_widget` | Neither has a listing tool |
| **"Bill client C for project P"** | `bill_create_invoice`, `bill_create_invoice_from_time` | No billing-client listing tool in `bill-tools.ts` |
| **"Create from template T"** | `create_from_template`, `brief_create`, `board_create` (template_id) | Templates listed only via project-scoped query, no by-name |
| **"Disable the Nightly Deploys rule during incidents"** | `bolt_enable`, `bolt_disable` | `bolt_list` has no name filter — bolt-on-bolt automation impossible |

These 12 patterns are the headline use cases for any "no-code automation
suite" pitch. **All 12 are blocked today** for any rule author who doesn't
already have UUIDs in hand from somewhere else.

### 3.3 The four bugs that need fixing regardless of strategy

These were uncovered by the event-payload + producer audit (Audit 5). They
are not strategy decisions — they are defects:

#### Bug 1 — Bond emits event types that match nothing in the catalog

`apps/bond-api/src/services/deal.service.ts` calls
`publishBoltEvent('bond.deal.stage_changed', ...)` (note the `bond.`
prefix). The catalog declares `event_type: 'deal.stage_changed'` (no
prefix). The ingest route filters automations with
`eq(boltAutomations.trigger_event, event.event_type)` — exact match. So
**no automation configured against any Bond event ever fires**. This affects
`deal.created`, `deal.updated`, `deal.stage_changed`, `deal.won`, and
`deal.lost`. (Worth checking whether `contact.*` and `activity.*` have the
same prefix issue — agent didn't verify.)

#### Bug 2 — `actor.id` is empty everywhere

No producer I checked (Bam, Banter, Bond) forwards `actor_id` as the
ingest endpoint's top-level field, *and* no producer puts an `actor` object
inside the payload. The catalog advertises `actor.id` on almost every
event. **Both `{{ actor.id }}` and `{{ event.actor.id }}` resolve to empty
string for every event the system emits.**

#### Bug 3 — Banter's `message.posted` payload shape doesn't match the catalog

Catalog says: `message.id`, `message.content`, `channel.id`, `channel.name`,
`actor.id`. Producer emits: `{ message: <full row>, channel_id: <flat>,
author_id: <flat> }`. Result: `{{ event.channel.id }}`,
`{{ event.channel.name }}`, and `{{ event.actor.id }}` all resolve to empty
strings. Rule authors following the catalog get nothing.

The Bam producer is the *opposite* problem — it emits the *full* `tasks`
row under `{ task }`, which is a *superset* of what the catalog documents.
That's better than missing fields but means the field picker in the rule
builder shows 7 options when ~25 are actually available.

#### Bug 4 — Worker silently substitutes empty strings for missing paths

`apps/worker/src/jobs/bolt-execute.job.ts:resolveTemplateString` returns
`''` for any `{{ ... }}` whose path doesn't resolve, with no warning logged
anywhere. Combined with bugs 1-3 above, this means rules can be authored,
fire on the right events, pass conditions, and then quietly pass empty
strings to MCP tools — which then either reject the call with a cryptic
"required field missing", or worse, accept it and produce wrong data. There
is no "strict" mode and no execution-log surface.

Secondary subtlety: the same function does `String(value)` coercion, so a
field that *is* an array (e.g. `{{ event.task.labels }}`) silently becomes
a comma-joined string, and an object (`{{ event.submission.answers }}`)
becomes `"[object Object]"`. Both are accepted by Zod string schemas and
forwarded to the action.

**Until these four bugs are fixed, the rest of this document is moot** —
no strategy can survive a layer this leaky.

---

## 4. Why the current state exists

It's worth being explicit about how we got here, because the strategy
addresses each cause separately:

**(a) Bolt was added on top of an existing MCP tool surface that was
designed for AI agents, not rule authors.** AI agents don't mind UUIDs —
they have full context, can call lookup tools transparently, and will retry
on failure. Rule authors are humans writing declarative configurations,
with none of those affordances. The MCP tool schemas were never reviewed
through the rule-authoring lens.

**(b) Each producer emits whatever payload was convenient to construct at
the call site.** There's no producer-side schema enforcement, no shared
"event factory" library that ensures the same field shapes across
producers, and no CI check that compares producer output to the catalog.

**(c) The catalog is documentation, not a contract.** The rule builder
reads it for autocomplete; nothing else does. So drift between catalog and
producer is invisible until a rule fails at runtime — and even then it
fails silently, see Bug 4.

**(d) Resolver tools were added ad-hoc per app, by whoever was building
that app's tools, with no cross-app pattern.** Beacon got `beacon_search`,
`beacon_suggest`, and slug-accepting `beacon_get`. Bond got
`bond_search_contacts`. Bam got nothing — no `find_user_by_email`, no
`get_task_by_human_id`, no phase/label/state listing. Coverage is uneven
and the patterns aren't consistent.

**(e) The slug-accepting pattern exists in exactly two places** —
`beacon_get` and `brief_get` — and **only on the read tools, not the
write tools**. So `beacon_get` accepts a slug but `beacon_update`,
`beacon_publish`, `beacon_tag_add`, etc. don't. This is arguably worse
than no slug support at all, because it primes the rule author to expect
the pattern everywhere.

---

## 5. The strategy

The strategy is layered. Each tier delivers value on its own; later tiers
build on earlier ones but aren't blocked by them.

### Tier 0 — Fix the bugs (P0)

The four bugs in §3.3. None of these are strategy decisions; they're
defects that need fixing regardless of which path forward is chosen.
Approximate scope:

- **Bond event-type prefix**: change `publishBoltEvent('bond.deal.*', ...)`
  to `publishBoltEvent('deal.*', ...)` in `apps/bond-api/src/services/`.
  Verify `contact.service.ts` and `activity.service.ts` aren't affected.
  Add a regression test that imports the catalog and asserts every
  producer call site uses an `event_type` from the catalog.
- **Actor forwarding**: update each producer's `bolt-events.ts` helper to
  accept and forward `actor_id` (and `actor_type`). Update every producer
  call site to pass the request's `user.id`.
- **Banter shape**: change Banter producers to emit nested `channel.id`,
  `channel.name`, `actor.id` matching the catalog — OR update the catalog
  to match the producer (the latter is less work but more disruptive to
  rule authors).
- **Worker template resolution**: log a warning to
  `bolt_execution_steps.metadata` when a `{{ ... }}` path resolves to
  empty. Add a per-automation `template_strict` flag (default `false`)
  that fails the step on empty resolution. Stop coercing arrays/objects
  to strings — either pass them through as JSON, or fail the step with a
  clear error.

These four fixes are independent of each other and can be done in
parallel. The catalog/producer alignment work that follows in Tier 1 will
catch any other shape mismatches we missed.

### Tier 1 — Enrich event payloads (the foundational fix)

The biggest single lever. For every event, the producer should emit all
of:

- **Every ID a downstream action might need.** A `task.created` event
  should carry not just `task.id` but `task.project_id`, `task.phase_id`,
  `task.assignee_id`, `task.sprint_id`, `task.epic_id`, `task.parent_id`,
  `task.label_ids[]`, `task.state_id`, `task.reporter_id`. So that *any*
  task-related action can be chained without needing a name lookup.
- **Canonical human-readable names** for every entity referenced. Both for
  message composition and as a "did this resolve to the right thing?"
  sanity check for rule authors. `task.project_name`, `task.phase_name`,
  `task.assignee_name`, `task.assignee_email`.
- **Deep-link URLs** for every primary entity. `task.url`, `ticket.url`,
  `deal.url`, `document.url`, etc. Almost every rule that posts to chat
  or sends an email wants a "click here" link, and rule authors shouldn't
  have to string-concat UUIDs against a frontend base URL.
- **Org context.** `org.id`, `org.name`, `org.slug`. Some rules want to
  build URLs against the org's custom subdomain.
- **Actor identity.** Once Bug 2 is fixed, also include `actor.name`,
  `actor.email`, `actor.avatar_url` so notification rules can attribute
  actions ("Jane closed deal X").
- **Recently-changed values for `*.updated` events.** Currently
  `task.updated`'s `changes` is a diff of IDs only. Authors writing
  "moved from 'Backlog' to 'In Progress'" need the names too, not just
  the IDs.

**Concrete deliverables:**

1. **An updated event catalog** in `apps/bolt-api/src/services/event-catalog.ts`
   that documents the full set of fields each event will carry (not just
   the minimum). The catalog becomes the contract.
2. **A producer-side schema library** — probably in `packages/shared/src/bolt-events/`
   — that exports a typed `BoltEventPayload<TEventType>` per event, plus
   factory functions like `taskCreatedPayload(task, project, phase, assignee, actor, baseUrl)`
   that build the full payload from the source service's available data.
3. **Updates to every producer** to use the factories. This is mechanical
   but spans every `*-api/src/services/` directory.
4. **A CI check** that imports the catalog and asserts every producer call
   site emits a payload that matches the documented schema. Catches drift
   forever.

Concrete enrichments per event are listed in Appendix B.

**Why this is the highest-leverage tier:** every action that takes a UUID
the rule author can't know becomes usable as long as that UUID is in the
event payload. For event-driven rules (the majority), this *removes* the
ID problem entirely — the author just writes `{{ event.task.assignee_id }}`
and the worker fills it in.

It does NOT solve the manual-rule problem ("when a cron fires, post to
#general"), where there's no triggering event. Those need Tiers 2 + 3.

### Tier 2 — Add resolver tools where they're missing

For the entities that have NO listing tool today, add small, obvious
resolver tools that take a name (or email, or handle, or slug) and return
the matching entity's ID. These can be chained as preceding action steps
in a Bolt rule, called by an AI agent doing name resolution at authoring
time, or used by anyone debugging a rule manually.

**Proposed new tools (~25):**

**Bam (the biggest gap):**
- `bam_list_phases(project_id)` → `[{ id, name, position, state_category }]`
- `bam_list_labels(project_id?)` → `[{ id, name, color }]`
- `bam_list_states(project_id)` → `[{ id, name, category }]`
- `bam_list_epics(project_id)` → `[{ id, title, status }]`
- `bam_get_task_by_human_id(human_id)` → task (e.g. "FRND-42" → task)
- `bam_find_user_by_email(email)` → user
- `bam_find_user(query)` → users matching name or email

**Banter (the highest-pain area):**
- `banter_get_channel_by_name(name_or_handle)` → channel (accepts `general`,
  `#general`, or the slug)
- `banter_find_user_by_email(email)` → user
- `banter_find_user_by_handle(handle)` → user (accepts `@alice` or `alice`)
- `banter_get_user_group_by_handle(handle)` → group (the existing
  `banter_create_user_group` already takes a handle parameter — close the
  loop)
- `banter_list_users(query?)` → users (the missing user discovery tool)

**Bond:**
- `bond_list_pipelines()` → `[{ id, name, default }]`
- `bond_list_stages(pipeline_id?)` → `[{ id, name, pipeline_id, position }]`
- `bond_get_deal_by_name(query)` → deals (Bond has search for contacts but
  not deals)

**Blast:**
- `blast_list_campaigns(search?, status?)` → campaigns

**Bearing:**
- `bearing_list_key_results(goal_id?, owner_id?, search?)` → KRs
- `bearing_get_period_by_label(label)` → period (accepts "Q2 2026")

**Book:**
- `book_list_calendars()` → `[{ id, name, owner_id }]`
- `book_find_event_by_title(query, calendar_id?)` → events

**Board:**
- `board_list_templates()` → `[{ id, name, category }]`
- `board_get_by_name(name, project_id?)` → board

**Bench:**
- `bench_list_widgets(dashboard_id?)` → widgets
- `bench_list_scheduled_reports(search?)` → reports

**Bill:**
- `bill_list_clients(search?)` → clients

**Bolt (self-management):**
- `bolt_get_automation_by_name(name)` → automation

These tools are small, mechanical, and don't change any existing behavior.
Once they exist, every HIGH-severity tool from §3.2 has a workable
preflight-then-action pattern that rule authors can use.

**Why Tier 2 alone isn't enough:** chaining a lookup-then-action means
every rule has at least two steps. For "post to #general when X" the rule
becomes:

```
Step 1: banter_get_channel_by_name("general") → step[0].result.id
Step 2: banter_post_message(channel_id={{ step[0].result.id }}, body="...")
```

That works, but it's clunky for the most common pattern. Tier 3 makes it
one step.

### Tier 3 — Accept name-or-id in canonical action params

For the highest-severity actions, change the parameter schema to accept
either the UUID or a natural identifier. The MCP tool's handler resolves
internally before calling the underlying API.

**The exact pattern:** instead of `channel_id: z.string().uuid()`, use
something like:

```ts
channel: z.string().describe(
  'Channel UUID, name (with or without #), or handle'
)
```

Then in the handler:

```ts
const channel = isUuid(input.channel)
  ? input.channel
  : await resolveChannelByName(orgId, input.channel.replace(/^#/, ''));
```

If resolution fails or is ambiguous, the tool returns a clear error
naming the candidates. This is the same pattern `beacon_get` uses for
slug-or-uuid today.

**Top candidates for name-or-id support (the canonical actions):**

| Tool | Name-accepting param | Notes |
|------|---------------------|-------|
| `banter_post_message` | `channel` (name/handle/uuid) | THE most common Bolt action |
| `banter_send_dm` | `to` (email/handle/uuid) | Top "DM the assignee" pattern |
| `banter_share_task` / `banter_share_sprint` / `banter_share_ticket` | `channel` | Cross-app posts |
| `banter_add_channel_members` | `channel`, `users[]` (email/handle/uuid each) | Onboarding |
| `bam_create_task` | `project`, `phase`, `assignee`, `labels[]` | Top Bam action |
| `bam_update_task` | `assignee`, `state` | "Reassign to Bob, set to Done" |
| `bam_move_task` | `phase` | Kanban automation |
| `bond_create_deal` | `pipeline`, `stage`, `owner` | Top CRM action |
| `bond_move_deal_stage` | `stage` | Top CRM action |
| `blast_send_campaign` | `campaign` (name/uuid) | THE Blast action |
| `blast_draft_campaign` | `template`, `segment` | Drafting |
| `bearing_kr_update` | `key_result` (title or goal-scoped name) | Top OKR action |
| `book_create_event` | `calendar` (name/uuid) | Top calendar action |
| `book_create_event` attendees | `attendees[]` (emails/uuids) | Common |
| `board_add_sticky` / `board_add_text` | `board` (name/uuid) | Top whiteboard action |
| `bill_create_invoice` / `bill_create_invoice_from_time` | `client` (name/uuid) | Top billing action |

That's ~15 actions. Each is small. The rule author's experience for the
common case becomes:

```
Step 1: banter_post_message(channel="general", body="Deal closed: {{ event.deal.title }}")
```

One step. No preflight. No UUID anywhere.

**Disambiguation:** `banter_get_channel_by_name("general")` may return one
result or zero or many (private channels with the same name across
workspaces, etc.). The action's resolver should:

- Return a clear error with the candidates if ambiguous
- Allow a `<name>:<additional-key>` syntax for disambiguation if needed
  (e.g. `general:engineering` for a sub-namespace)
- Cache results for the duration of a single `bolt-execute` job

### Tier 4 — Template-time resolvers in the worker

A more powerful but lower-priority option: extend the worker's template
syntax to support pipe-style filters that can transform a value at
resolution time.

```
body: "Task assigned to {{ event.task.assignee_id | user_email }}"
to:   "{{ event.task.assignee_id | user_email }}"
url:  "{{ event.task.id | task_url }}"
```

Filters would be a small registered set:

- `| user_email` — given a user UUID, look up the email
- `| user_name`
- `| channel_name` — given a channel UUID, look up the name
- `| task_url` — given a task UUID, build the canonical task URL
- `| as_iso_date`, `| as_relative_date` — date formatting
- `| truncate(N)` — string truncation

This is more general than Tier 3 because it applies to *any* field, not
just the first-arg field of an action. But it requires the worker to call
back into the source apps for each filter, which means HTTP traffic per
template per execution.

**Why it's lower priority:** Tier 1's payload enrichment makes most of
these filters unnecessary. If `task.assignee_email` is already in the
payload, you don't need `| user_email`. Filters become important only for
cases where the payload couldn't carry the field for some reason (e.g.
because the rule fires on a non-task event but still wants to look up a
user the rule author already knows about).

### Tier 5 — Strict template mode + UI hints

Two small UX improvements that mostly fall out of the other tiers but
deserve their own line item:

1. **Strict mode on template resolution.** Per-rule toggle. Default off
   (current behavior — empty strings on missing paths). When on, any
   `{{ }}` that resolves to empty fails the step with a clear error
   naming the unresolved path. This catches drift early. Even with strict
   mode off, missing-path warnings should be logged to
   `bolt_execution_steps.metadata` so rule authors can see them in the
   execution log.
2. **UI hints in the rule builder:**
   - The action editor's parameter picker (already added in a prior round)
     should mark fields as "name-accepting" once Tier 3 lands, with a
     hint like "type a channel name or paste a UUID".
   - The condition builder should warn (yellow squiggle) if a referenced
     field path isn't in the documented payload schema for the selected
     trigger event.
   - When a Tier 2 resolver tool exists, the rule builder could offer a
     "look up by name" inline button next to ID fields that opens a
     small picker — running the resolver tool in the background and
     returning the UUID for the author to confirm.

---

## 6. Prioritization

Recommended order, with rationale.

### Phase A — Stop the bleeding (1-2 days)

**Tier 0, all four bugs.** These don't need design discussion. They are
defects, they break Bond automation entirely, they cause silent corruption
in template resolution, and the fixes are all small.

The Bond prefix bug alone means **Bond automation is non-functional today**.
Anyone trying to write a rule against a Bond event finds out the rule
never fires, with no error and no log. This must be fixed immediately
regardless of strategy.

### Phase B — The foundational fix (1-2 weeks)

**Tier 1, payload enrichment.** This is the largest single piece of work
in the strategy and the highest-leverage. It involves:

- Cataloging the complete payload shape for every event (~50 events)
- Building the producer-side schema library
- Updating every producer call site
- Adding the CI catalog/producer alignment check

After this, **most event-driven rules just work** because the IDs are
already in the payload. The MCP action's UUID requirement stops being a
problem because `{{ event.task.assignee_id }}` resolves to a real UUID.

This phase also implicitly fixes Bug 3 (Banter shape mismatch) because
the producer rewrite will align with the catalog by construction.

### Phase C — Cover the manual-rule case (1 week)

**Tier 2, add resolver tools.** Mechanical work — ~25 small new tools that
follow obvious patterns. Once Tier 1 has landed, only manually-authored
rules (no triggering event) need these. The work is parallelizable across
apps.

### Phase D — Smooth the common case (1 week)

**Tier 3, name-or-id on canonical actions.** Touches ~15 MCP tool
schemas. The resolver functions reuse the Tier 2 lookup logic.
Backwards-compatible — UUIDs still work.

After Phase D, the common rule pattern is a single step with no UUIDs
visible anywhere in the rule definition.

### Phase E — Polish (ongoing)

**Tiers 4 + 5.** Template filters and UI improvements. Lower priority,
can be picked up incrementally as users hit specific pain points.

### Total estimate

Phases A through D could ship in roughly 4-5 weeks of focused work for
one engineer, less if parallelized. Phase A alone is a day or two and
should be done immediately.

---

## 7. Risks and open questions

**(a) Schema migration for the catalog.** Tier 1 changes the documented
shape of every event. Rules built against today's catalog will continue
to work as long as we only *add* fields and never *remove* or *rename*
them. We should commit to additive-only changes for the catalog and
introduce a versioning scheme if a breaking change ever becomes
necessary.

**(b) Producer payload size.** Some events will grow significantly —
e.g., `task.created` going from ~7 fields to ~25, with names and URLs
included. For events that fire often (`message.posted`), this matters
for both the producer's serialization cost and the bolt-api's storage
cost in `bolt_executions.trigger_event`. Mitigation: drop unused fields
from the stored copy *after* condition evaluation (storing only what
actually was templated into actions). Or accept the cost — these
payloads are still <2KB even at the high end.

**(c) Tier 3 disambiguation surprises.** "Post to #general" sounds great
until two channels are named `general` (e.g., a private channel and a
public one). The resolver needs a clear, predictable disambiguation
policy that's documented in the tool's description. Default policy: if
there's an exact case-insensitive name match in *one* place, use it; if
there are multiple matches, fail with a clear error listing them.

**(d) Email-based user resolution and privacy.** Adding
`banter_find_user_by_email` means anyone with a Bolt rule can probe for
whether a given email belongs to an org member. This is similar to
Slack's behavior and probably acceptable, but we should make the
decision explicitly rather than accidentally.

**(e) Worker filter calls (Tier 4).** If we go this route, every
template filter in every action in every rule potentially makes an HTTP
call to a source app at execution time. We should bound this — cap at N
filter calls per step, cache aggressively within a single execution, and
make sure the call timeout doesn't dominate the action's own timeout.

**(f) Backwards compatibility with the existing audit branch's
event-catalog.ts.** We've already shipped a static event-catalog.ts that
documents one set of fields. Tier 1's enrichment expands that, which is
purely additive — existing rules keep working. The CI alignment check
is what guarantees this.

**(g) The "did this rule actually do anything?" problem.** Today, with
silent empty-string resolution, a misconfigured rule fires successfully
every time and produces silently broken results. After Tier 0's strict
mode, the rule fails loudly — but it still fires. Worth thinking about
whether we want a "dry-run" or "validate" mode for rules that surfaces
template resolution warnings without actually executing the action.

---

## 8. Recommendation

Adopt the strategy as-laid-out, in five phases:

1. **Phase A (immediate).** Fix Tier 0's four bugs. Especially Bug 1
   (Bond prefix) — this is the highest-impact fix in the entire document
   because it unblocks an entire app's automation.

2. **Phase B (next).** Tier 1 — the foundational payload enrichment.
   This is the heaviest work but the single biggest leverage point. Most
   real rules become possible after this lands.

3. **Phase C.** Tier 2 — fill in the missing resolver tools for the
   ~25 entities that have no listing tool today.

4. **Phase D.** Tier 3 — name-or-id on the ~15 canonical actions. Makes
   the common case a single step.

5. **Phase E (ongoing).** Tiers 4 and 5 as polish.

Once you've reviewed and accepted this, I can produce a detailed
implementation plan for any phase — starting with Phase A as the obvious
next step, since those four bugs are real defects shipping in production
and are blocking any kind of meaningful Bolt usage in Bond and any rule
that references `actor.id`.

---

## Appendix A — Per-app HIGH-severity tools

Full per-tool detail is in the agent reports stored in this conversation's
memory. The HIGH-severity hot list:

**Bam (6):** `create_task`, `update_task`, `move_task`, `complete_sprint`,
`create_from_template`, `bulk_update_tasks`

**Banter (8):** `banter_post_message`, `banter_send_dm`,
`banter_send_group_dm`, `banter_add_channel_members`,
`banter_add_group_members`, `banter_share_task`, `banter_share_sprint`,
`banter_share_ticket`

**Brief (2):** `brief_create`, `brief_append_content`

**Bond (3):** `bond_create_deal`, `bond_move_deal_stage`, `bond_log_activity`
(MEDIUM in the report but worth promoting)

**Blast (2):** `blast_send_campaign`, `blast_draft_campaign`

**Bearing (1):** `bearing_kr_update`

**Bolt (2):** `bolt_enable`, `bolt_disable`

**Book (1):** `book_create_event`

**Board (2):** `board_add_sticky`, `board_add_text`

**Bench (2):** `bench_query_widget`, `bench_generate_report`

**Bill (2):** `bill_create_invoice`, `bill_create_invoice_from_time`

---

## Appendix B — Required event payload enrichments by source

This is the field-level acceptance criteria for Tier 1. Every event listed
should grow to include all of the fields in its "Add" column.

### bam

| Event | Currently has | Add |
|-------|--------------|-----|
| `task.created` | task.id, task.title, task.project_id, task.phase_id, task.assignee_id, task.priority, actor.id | task.human_id, task.description, task.due_date, task.start_date, task.story_points, task.labels[], task.label_names[], task.sprint_id, task.epic_id, task.parent_task_id, task.state_id, task.reporter_id, task.url, task.assignee_name, task.assignee_email, task.reporter_name, task.reporter_email, project.name, project.slug, project.key, phase.name, sprint.name, actor.name, actor.email |
| `task.updated` | task.id, task.title, changes, actor.id | task.project_id, task.phase_id, task.assignee_id, task.state_id, task.url, task.human_id, project.name, phase.name, assignee.name, assignee.email, actor.name, actor.email; `changes` should include both id and name for renamed entities |
| `task.moved` | task.id, from_phase_id, to_phase_id, actor.id | task.title, task.human_id, task.assignee_id, task.url, from_phase_name, to_phase_name, project.name, project.slug, sprint.name, actor.name, actor.email |
| `task.assigned` | task.id, task.title, assignee.id, previous_assignee.id, actor.id | task.project_id, task.phase_id, task.url, task.priority, task.due_date, assignee.name, assignee.email, previous_assignee.name, previous_assignee.email, project.name, actor.name, actor.email |
| `task.completed` | task.id, task.title, task.project_id, actor.id | task.human_id, task.assignee_id, task.assignee_name, task.assignee_email, task.sprint_id, task.story_points, task.url, project.name, phase.name, sprint.name, actor.name, actor.email |
| `task.overdue` | task.id, task.title, task.due_date, task.assignee_id | task.project_id, task.phase_id, task.priority, task.url, task.days_overdue, task.assignee_name, task.assignee_email, project.name |
| `task.deleted` | task.id, task.title, task.project_id, actor.id | task.human_id, task.assignee_id, task.sprint_id, project.name, actor.name, actor.email |
| `comment.created` | task.id, comment.id, comment.body, actor.id | task.title, task.human_id, task.project_id, task.assignee_id, task.url, comment.mentions[], project.name, project.slug, actor.name, actor.email |
| `epic.completed` | epic.id, epic.title, epic.project_id, tasks_completed, actor.id | epic.url, epic.owner_id, project.name, project.slug, actor.name, actor.email |
| `sprint.started` | sprint.id, sprint.name, sprint.project_id, actor.id | sprint.start_date, sprint.end_date, sprint.goal, sprint.task_count, sprint.url, project.name, actor.name, actor.email |
| `sprint.completed` | sprint.id, sprint.name, sprint.project_id, tasks_completed, tasks_carried_forward, actor.id | sprint.start_date, sprint.end_date, sprint.velocity, sprint.url, tasks_total, story_points_completed, story_points_committed, project.name, actor.name, actor.email |

### banter

| Event | Currently has | Add |
|-------|--------------|-----|
| `message.posted` | message.id, message.content, channel.id, channel.name, actor.id (catalog says — actually emits flat) | message.url, message.thread_parent_id, message.is_reply, message.mentions[], message.attachments[], channel.type, actor.name, actor.email, actor.display_name, actor.avatar_url |
| `message.edited` | message.id, message.content, channel.id, actor.id | channel.name, channel.type, message.previous_content, message.url, actor.name, actor.email |
| `message.mentioned` | message.id, message.content, mentioned_user.id, channel.id, actor.id | mentioned_user.name, mentioned_user.email, channel.name, channel.type, message.url, actor.name, actor.email |
| `channel.created` | channel.id, channel.name, channel.type, actor.id | channel.description, channel.member_count, channel.url, actor.name, actor.email |
| `reaction.added` | message.id, reaction.emoji, channel.id, actor.id | message.author_id, message.author_name, channel.name, channel.type, actor.name, actor.email |

### bond

(Note: producer is currently broken — see Bug 1. The catalog needs to win
this disagreement.)

| Event | Currently has | Add |
|-------|--------------|-----|
| `deal.created` | deal.id, deal.title, deal.amount, deal.stage, deal.company_id, deal.contact_id, actor.id | deal.pipeline_id, deal.stage_id, deal.owner_id, deal.owner_name, deal.owner_email, deal.currency, deal.probability, deal.close_date, deal.url, deal.company_name, deal.contact_name, deal.contact_email, actor.name, actor.email |
| `deal.stage_changed` | deal.id, deal.title, previous_stage, new_stage, actor.id | previous_stage_id, new_stage_id, deal.amount, deal.pipeline_id, deal.owner_id, deal.url, days_in_previous_stage, owner.name, owner.email, actor.name, actor.email |
| `deal.won` / `deal.lost` | deal.id, deal.title, deal.amount, ..., actor.id | deal.pipeline_id, deal.owner_id, deal.company_id, deal.contact_id, deal.url, owner.name, owner.email, contact.name, contact.email, company.name, actor.name, actor.email |
| `contact.created` | contact.id, contact.name, contact.email, contact.company_id, actor.id | contact.phone, contact.owner_id, contact.url, contact.company_name, owner.name, owner.email, actor.name, actor.email |
| `activity.logged` | activity.id, activity.type, activity.subject, activity.contact_id, activity.deal_id, actor.id | activity.body, activity.contact_name, activity.contact_email, activity.deal_title, activity.deal_amount, actor.name, actor.email |

### Other sources

Similar enrichment patterns apply to brief, helpdesk, blast, board,
bearing, bill, book, blank — full per-event tables in the agent reports.
The pattern is always the same: every entity ID gets a name companion,
every primary entity gets a `*.url`, every event gets a fully-populated
`actor` object.

---

## Appendix C — Proposed new resolver tools

The full ~25 tools listed in §5's Tier 2 section. Each follows the same
pattern: takes a human identifier (name, email, handle, slug, query),
returns the matching entity (or list, with disambiguation) including its
UUID. No mutations, no side effects, idempotent.

These can be added in any order and don't require any of the other tiers
to ship first.

---

## Appendix D — Source agent reports

Six audit reports informed this strategy document. They are too long to
inline but the per-tool detail is preserved in the original conversation
transcript:

1. **Bam tools audit** — 47 tools, identifies the catastrophic gap that no
   `search_*` / `find_*` / `*_by_name` tool exists in Bam at all.
2. **Communication & knowledge tools audit** — 101 tools across Banter,
   Beacon, Brief, Helpdesk. Identifies the user-identity-resolver gap as
   the single biggest cross-app pain point.
3. **Business tools audit** — 58 tools across Bond, Blast, Bearing, Bolt.
   Identifies Bond's missing pipeline/stage tools and Blast's missing
   campaign listing as the worst gaps.
4. **Operations tools audit** — 58 tools across Blank, Book, Board,
   Bench, Bill. Identifies five entirely-unresolvable entity types
   (calendars, board templates, widgets, scheduled reports, billing
   clients).
5. **Event payload + ingestion audit** — found the four hard bugs in
   §3.3 plus the broader pattern that the catalog drifts from producers
   without any enforcement.
6. **Resolver tool inventory** — found 31 existing resolver-style tools
   across 15 apps, with strong coverage for Beacon and Bond contacts but
   wide gaps elsewhere, and zero coverage for user identity.
