# Bolt: Advanced UI Strategy

**Status:** Design exploration. No code changes proposed yet — this document
should drive the next round of UI work.

**Predecessor:** `docs/bolt-id-mapping-strategy.md` and the four phases of
work that landed under the `bolt-mcp-deepdive` branch (Phase A: producer/
worker bug fixes; Phase B: full event payload enrichment across 11 apps;
Phase C: ~30 new resolver tools; Phase D: name-or-id acceptance on ~70
canonical actions).

**Audience:** Anyone scoping the next phase of Bolt UI work, anyone deciding
how powerful Bolt should *feel* to its users, and anyone who needs a list of
concrete user stories the rule builder must be able to express.

---

## 1. Why this document exists

The four phases of MCP work just landed in `bolt-mcp-deepdive` raise the
ceiling of what's *technically* possible inside a Bolt rule by an order of
magnitude. Rule authors can now:

- Refer to channels, users, projects, deals, KRs, calendars, boards,
  invoices, and so on by their human names instead of UUIDs
- Reference any field of the triggering event in a `{{ event.* }}` template
  with confidence that it exists (because the producer now actually emits
  it and the catalog is the contract)
- Chain a fully-resolved `{{ actor.id }}` and `{{ actor.email }}` and
  `{{ actor.name }}` from the triggering user
- Trust that array/object payloads pass through cleanly to MCP tools
  instead of becoming `"[object Object]"` strings
- Get warnings when a template references a field that didn't resolve, and
  optionally fail-fast in strict mode

But **the UI hasn't caught up.** Today the rule builder is a five-section
form: WHEN (trigger) → IF (conditions) → THEN (actions), with a parameter
picker that we recently improved (typed parameter list, runtime template
autocomplete with viewport-aware positioning). That's solid for "post a
message when a task is completed". It's nowhere near solid for the kinds
of automations the underlying engine can now actually run.

This document explores how the UI should evolve to expose that power
without overwhelming people, then validates the design against several very
different complex user stories — and for each one, walks through what the
user needs from the UI to actually pull it off.

---

## 2. Design principles

Before any specific design proposals, here's the philosophy I want to
anchor on. These principles shape every decision below.

### 2.1 Progressive disclosure

A Bolt rule has three populations of authors:

1. **The newcomer.** Has never built a rule before. Probably arrived from
   a "let me automate this" moment of frustration in another app
   ("ugh, I wish someone would auto-post when this happens"). Wants the
   thing built in under five minutes. Will give up if anything looks
   intimidating.

2. **The power user.** Has built half a dozen rules. Knows what
   `{{ event.task.id }}` does. Wants to express something more nuanced
   than "when X then Y" — multi-step pipelines, conditional branches,
   error handling, retries.

3. **The systems author.** Has built dozens of rules. Treats Bolt as a
   programming environment. Wants version control over rules,
   testability, refactoring, and to compose rules out of smaller pieces.

A rule builder that looks like Zapier serves population 1 well and
populations 2-3 badly. A rule builder that looks like Apache NiFi serves
population 3 well and populations 1-2 badly. The trick is **progressive
disclosure**: start everyone in the simple view, let them opt into more
power as they need it, but don't make the simple view second-class.

The simple view stays. The advanced view extends it without replacing it.
Power-user features (branches, loops, error policies, dry-run, refactoring)
appear when they're relevant — not all the time.

### 2.2 The data is the UI

Bolt has unusually rich data flowing through it: events, payloads, condition
evaluation logs, action execution logs, template warnings, intermediate
step results, retry counts. Most rule builders waste this data — they show
you a "success/failure" pill and that's it.

I think Bolt should treat the **execution log as a first-class UI surface**,
not an afterthought. When something goes wrong (or right), the log should
be where the author goes to understand what actually happened, not the
rule definition. The log should also be **navigable** — clicking a value
in the log should jump you to where it came from in the rule. Authoring and
debugging are the same activity, just with different starting points.

### 2.3 Names over IDs, always

Phase D made name-or-id acceptance available at the schema level. The UI
should *always* show names by default. UUIDs should be visible only on
hover, in expert mode, or when there's a genuine ambiguity.

This applies to:
- The trigger event field picker (`{{ event.task.assignee_name }}` not
  `{{ event.task.assignee_id }}` — both work, but the name version is the
  default suggestion)
- The action parameter inputs (drop-down lists of channels by name, not
  by UUID; same for projects, pipelines, calendars, etc.)
- The execution log (resolved values shown as names where possible —
  "task FRND-42 'Fix login bug' was assigned to alice@example.com" not
  "task `7f3a...` was assigned to user `9c2b...`")

### 2.4 Conditions are queries, not boolean trees

Today's condition builder is a flat list of `field operator value`
predicates joined by AND/OR groups. That's adequate for simple rules
("only run when priority is high") but breaks down for queries like
"only run when the deal's company has had no activity in 30 days" or
"only run when the assignee is a member of the Engineering team". Those
questions need joins, time windows, and aggregations — they're queries,
not boolean trees.

I want to look at extending the condition builder with **query-like
operators** that can pull additional data from the source app at evaluation
time, similar to how Phase C added resolver tools but applied to the
condition evaluation phase instead of action execution. More on this in
§4.3.

### 2.5 Errors are part of the design surface

A rule that fails is still a rule. The author wants to know:
- Did it fail because the trigger never fired?
- Did it fail because the condition rejected it?
- Did it fail because a template didn't resolve?
- Did it fail because the MCP action returned an error?
- Did it fail because of a transient issue and a retry would work?

Each of those needs a different fix. The current "error_message" string
is the same for all of them, which means the author has to read it
carefully and guess. Errors should be **typed** — both at the engine
layer and in the UI's presentation — so the author can be guided to the
right next action.

---

## 3. Concrete UI proposals

These are the specific changes I think the rule builder needs. Each is
independent — they could ship in any order.

### 3.1 The trigger picker becomes a "where do I start from?" wizard

Today: a two-dropdown form (source → event_type) followed by an empty
condition list and an empty action list. The author has to know what they
want before they start.

Proposed: a **context-first wizard**. The first screen is "what event do
you want to react to?" but the dropdowns are replaced by a search field
plus categorized cards: "When a task is..." / "When a customer..." /
"When someone in the team..." / "On a schedule...". Each card expands to
show specific events with one-line descriptions. The card layout is more
discoverable than a dropdown labeled "Source" that requires you to already
know which BBB app produces what events.

Once the user picks an event, the rest of the rule builder loads with the
event's payload schema pre-loaded into the autocomplete and the field
picker, so every subsequent step is informed by what data is actually
available.

### 3.2 The condition builder gets three new operator categories

Beyond the simple `equals / not_equals / contains / starts_with /
greater_than / matches_regex` operators we have today, the audit
identified three categories of conditions that real automations actually
want:

**(a) Set membership against external data.** "When the assignee is a
member of #engineering" or "when the customer is on the Pro plan". These
require an MCP-style lookup at evaluation time. The condition builder
needs an operator like `is in <group/list/segment/channel>` that takes a
resolver-tool-style picker (the same Phase C resolver tools that act as
preflight for actions can also act as preflight for conditions).

**(b) Time-window comparisons.** "When the task has been in 'In Review'
for more than 3 days" or "when the deal hasn't had an activity in 14
days". These need a stored timestamp on the entity and an operator like
`unchanged for at least <duration>`. The producer-side enrichment Phase B
landed gives us most of the timestamps we need (e.g.,
`days_in_previous_stage`, `last_verified_at`). We need new operators that
can compare against `now()` cleanly.

**(c) Cross-event correlation.** "When this is the third time today that
this user has commented on this task" or "when this is the second deal
this contact has lost in the last quarter". These need either an
aggregation over the bolt_executions log (we have it — the trigger_event
JSONB is searchable) or a more general "rate" condition. This is the
hardest of the three, and probably belongs in a later phase.

### 3.3 The action editor gets branches and loops

Today actions are a flat ordered list. Each fires sequentially. There's
no way to express "if step 1 succeeded, do step 2; otherwise do step 3"
or "for each item in this array, do these steps". Those are the bread
and butter of "real" automation systems.

Proposed:

- **Branch nodes** in the action list. A branch node has two child action
  lists: "if true" and "if false", and a condition expression. The branch
  condition is evaluated against the same template context as everything
  else, so authors can write `{{ event.task.priority == 'high' }}`-style
  expressions or pull in a previous step's result.

- **For-each nodes** in the action list. A for-each iterates over an
  array — typically `{{ event.task.label_ids }}` or
  `{{ step[N].result.tasks }}` — and runs its child actions once per
  element. Inside the loop body, `{{ item }}` and `{{ index }}` are
  available alongside the normal context.

- **Try/catch nodes** in the action list. Wraps a sub-list of actions and
  has a "if any of these fail" sub-list that runs as fallback. Replaces
  the per-action `on_error` policy for cases where the recovery is more
  complex than just "skip" or "retry".

These three additions cover ~95% of the "I wish I could…" requests I
expect from power users. They also keep the simple view simple: a flat
list of actions still works exactly the same way.

### 3.4 Inline execution preview

When the user is editing a rule, the rule builder should be able to
**preview what would happen** against a sample event. This is the single
biggest UX win in any automation tool — it transforms rule authoring
from "guess and check" to "see and adjust".

The preview surface should:

- Pull a recent matching event from the bolt_events log (or accept a
  hand-crafted JSON payload)
- Run the conditions against it and show pass/fail per condition with
  the resolved field values
- Run the actions in **dry-run mode** — resolve all templates against
  the sample event, but mark every MCP call as "would call" instead of
  actually calling. Show the resolved parameters.
- Highlight any template warnings ("`{{ event.task.assignee_email }}`
  resolved to empty — the producer doesn't emit this field for this event")
- Estimate cost: number of API calls, total wall time based on past
  step durations from `bolt_execution_steps`

This is most of the plumbing the strict-mode template check from Phase A
needs anyway — strict mode is "preview at production time and fail if
anything's wrong"; this is the same code path with a sample event and a
"don't actually call" flag.

### 3.5 Execution log becomes a navigable artifact

Today the execution detail page is a list of steps with status pills and
a JSON dump per step. Proposed:

- Each step is collapsible/expandable. Collapsed view: status, action
  name, duration, key resolved values ("posted to #engineering",
  "updated task FRND-42").
- Expanded view: full resolved parameter set, full response, any
  template warnings, any retries.
- Resolved values that came from a template (`{{ event.task.id }}`) are
  **clickable** — clicking them jumps to the rule definition with that
  template highlighted, so the author can understand "where did this
  value come from".
- Resolved values that came from a resolver tool (e.g., `channel="general"`
  resolved to UUID `abc...`) show the resolver hop inline, so the author
  can see the full chain.
- The trigger_event payload is shown alongside the steps, with
  click-to-copy on every field path so the author can learn the
  field-path syntax by example.

### 3.6 Rule library and templates

The rule builder should ship with a library of pre-built templates,
organized by use case ("When a task is overdue, post to the assignee in
Banter and DM their manager", "When a deal moves to Closed Won, draft
an invoice and send the welcome campaign", etc). Each template should
be **forkable** — clicking "use this" creates a new rule pre-populated
with the template's structure, ready to be customized.

Templates should also be **shareable** — exported to JSON, importable,
postable to a public registry. This is how Bolt becomes more than a
one-org tool: a community of templates is a moat.

### 3.7 Rule organization: folders, tags, dependencies

Once an org has 20+ rules, the flat list becomes unmanageable. The rule
list needs:

- **Folders** for hierarchical organization
- **Tags** for cross-cutting categorization
- **Per-rule status indicators** showing health (recent failures? slow?
  triggered recently? never triggered?)
- **Dependency view** showing which rules feed which rules (rule A's
  action emits an event that triggers rule B). Cycle detection is
  important here.

### 3.8 Versioning and rollback

Every rule edit should be a version. The version history should be
viewable, diffable, and rollback-able. This is critical for production
automations because a rule edit at 4pm Friday that breaks something at
2am Saturday should be one click to revert, not a chain of "what did I
change?" archaeology.

### 3.9 Test mode / staging environment

A rule should be runnable in a test mode where:

- It listens for triggers like normal
- But all action calls go to a sandbox or are dry-runned
- Results are recorded and shown in a separate test-execution log

This lets authors validate a rule against real events for a few hours
before flipping it live.

---

## 4. User stories

The proposals above are abstract. Let me validate them by walking through
several very different complex automation scenarios — the kinds of things
sophisticated customers will want to build. For each, I'll describe what
the user is trying to accomplish, then walk through what they'd need from
the UI step by step, and confirm that the underlying engine can actually
execute the resulting rule.

### Story 1 — The Customer Onboarding Concierge

**Persona:** Alex, head of customer success at a 30-person SaaS company.
Just signed a new mid-market customer. Wants every new customer to get a
predictable, white-glove onboarding without anyone forgetting a step.

**Goal:** When a Bond deal moves to "Closed Won" stage, automatically:
1. Create a new Bam project from the "New Customer Onboarding" template,
   named after the customer
2. Invite the customer's primary contact to a kickoff Banter channel
3. Schedule a kickoff meeting on the Customer Success calendar two
   business days out
4. Create a Brief document from the "Onboarding Spec" template, linked
   to the new project
5. Add the customer to the "New Customers" Blast email segment for the
   Welcome series
6. Post a summary message in the #wins channel mentioning the deal owner
7. Open a tracking task in the "Customer Success" project assigned to
   the deal's owner with the customer's name in the title

**What Alex needs from the UI:**

1. **Trigger picker** — Alex picks "Bond" from the source cards, then
   "Deal stage changed to Closed Won". The autocomplete shows the
   available payload fields: `event.deal.title`, `event.deal.amount`,
   `event.deal.company_name`, `event.deal.contact_name`,
   `event.deal.contact_email`, `event.deal.owner_name`,
   `event.deal.owner_email`, etc. (Phase B made all of these available.)

2. **Condition** — Alex doesn't actually need a condition here; the
   `deal.stage_changed` event is already filtered to the new stage. But
   he might add "only when amount > $10k" using the simple operator
   builder.

3. **Action 1: Create the project.** Alex picks `bam_create_project`.
   The new parameter picker shows him `name`, `template_id`, `description`,
   `phase_set_id`. For `template_id`, it offers a dropdown of project
   templates (from `bam_list_templates` which Phase C added). For `name`,
   he types `{{ event.deal.company_name }} — Onboarding`. The autocomplete
   suggests `event.deal.company_name` from the trigger context.

4. **Action 2: Create the Banter channel.** `banter_create_channel`. Name
   the channel `customer-{{ event.deal.company_name | slug }}`. (For-each
   note: this needs a template filter — `slug` — that doesn't exist yet.
   Tier 4 from the strategy doc would add this.) Then
   `banter_add_channel_members` with the channel name (just resolved
   above) and `user_ids: [{{ event.deal.contact_email }},
   {{ event.deal.owner_email }}]` — Phase D made this work because
   `add_channel_members` accepts emails.

5. **Action 3: Schedule the kickoff meeting.** `book_create_event` on
   the "Customer Success" calendar (Alex types the calendar name, no
   UUID needed — Phase D). Title `{{ event.deal.company_name }} Kickoff`.
   Start time: this is where it gets interesting. Alex wants "two
   business days from now". That's a date-math template filter that
   doesn't exist yet (`{{ now | add_business_days(2) | start_of_day }}`).
   Tier 4 again.

6. **Action 4: Create the Brief document.** `brief_create` from the
   "Onboarding Spec" template, in the project just created. Alex needs
   to reference the project from step 1. The action editor's parameter
   picker should let him pick `{{ step[0].result.id }}` — the result of
   action 1. The current TemplateInput already supports this; it just
   needs a clearer label ("from a previous step") in the autocomplete.

7. **Action 5: Add to email segment.** Alex picks `blast_segment_add`
   (which… doesn't actually exist as a tool yet; only `blast_create_segment`
   exists. The strategy doc surfaced this — you can create a segment but
   not add a contact to one. **This is a gap that the user story revealed.**
   Either the rule needs to use a different mechanism (the segment is a
   query and the contact gets included automatically via the query), OR
   we need to add a `blast_segment_add_contact` MCP tool.

8. **Action 6: Post to #wins.** `banter_post_message(channel='wins',
   body='🎉 ${{ event.deal.amount }} deal closed by
   {{ event.deal.owner_name }} for {{ event.deal.company_name }}!
   Onboarding kicked off in #{{ step[1].result.handle }}')`. Phase D's
   name-accepting `channel` parameter makes this readable.

9. **Action 7: Open the tracking task.** `bam_create_task` in the
   "Customer Success" project, phase "Active", assignee
   `{{ event.deal.owner_email }}`, title `Onboarding:
   {{ event.deal.company_name }}`, due_date "two weeks from now"
   (another date-math filter), labels `['onboarding', 'priority']`.

**Coverage check:**

- **What works today (post-Phase D):** Steps 1, 4, 6, 7, 9, the
  channel-by-name in 2, the calendar-by-name in 3, the email-by-resolution
  in 2 and 3 and 7. That's most of the rule.
- **What's missing:**
  - Template filters for date math (`add_business_days`, `start_of_day`,
    `add_weeks`) — these are Tier 4 from the strategy doc
  - Template filter for slugification (`slug`) — also Tier 4
  - `blast_segment_add_contact` MCP tool — this is a real gap surfaced
    by the story
  - The "from a previous step" pattern needs better UI affordances
- **Engine capability:** every other piece of this rule can run today
  on the Phase A-D engine. The 7-step action list is well within
  bolt-execute.job.ts's wheelhouse; the only stretch is whether
  step ordering + cross-step references work for chains this long.
  Spot-check: yes, `step[N].result.*` works fine for arbitrary N.

**What this story tells us about the UI:**

- The "from a previous step" pattern is the single most important power-user
  affordance. The autocomplete needs a section for "Previous step results"
  that lists each preceding action by name and shows what fields its
  result returns (which means the action editor needs to know the
  *return* shape of each MCP tool, not just the *parameter* shape — same
  schema extraction, different field).
- Date math is critical. Every business automation needs it.
- Composite text needs interpolation that's friendlier than
  `${{ event.deal.amount }} deal closed by {{ event.deal.owner_name }}`.
  An interactive WYSIWYG-style template editor for `body` fields would
  help — let the user type plain text and click to insert variables.

### Story 2 — The Sprint Health Watchdog

**Persona:** Riley, engineering manager for a 15-engineer team. Wants to
catch sprint problems early instead of finding out at sprint review.

**Goal:** Every weekday at 9am, look at the active sprint and:
1. For every task that's been in the "In Review" phase for more than
   2 days, post a reminder DM to the assignee with a link to the task
2. For every task that's overdue, post in the project's Banter channel
   tagging the assignee
3. If the sprint's burndown is more than 20% behind a linear pace, post a
   warning in the team channel mentioning the sprint goal and tasks
   completed vs committed
4. If any task has been blocked for more than 3 days, escalate it: open
   a Brief document from the "Blocker Escalation" template, link the task,
   assign it to Riley, and post a high-priority message
5. Generate a one-paragraph status summary using the day's task activity
   and post it to #engineering-standup

**What Riley needs from the UI:**

1. **Trigger picker** — Riley picks "Schedule" → "On a cron schedule".
   Sets cron expression to `0 9 * * 1-5` (weekdays at 9am). The trigger
   payload is sparse — just `now` — so Riley will need to query for
   data inside the rule.

2. **Action 1: Get the active sprint.** This isn't really an action in
   the today sense — it's a *query* whose result feeds the actions
   below. Riley picks something like `bam_get_active_sprint(project_id)`
   for each project he wants to monitor. (Or, if there's only one
   project, hardcodes it.) The result is a sprint object with `task_ids`
   and metadata.

3. **Action 2 (for-each):** Iterate over `{{ step[0].result.tasks }}`
   filtered by `phase_name == 'In Review' AND days_in_phase > 2`. For
   each matching task, call `banter_send_dm(to_user_id={{ item.assignee_email }},
   body='👀 {{ item.title }} has been in review for
   {{ item.days_in_phase }} days. {{ item.url }}')`.

   **This needs the for-each node from §3.3.** It also needs filtering
   inside the for-each — either as an inline filter expression on the
   loop (`for each X in Y where Z`) or as a guard condition inside the
   loop body. Both work; the inline form is friendlier.

   It also needs `days_in_phase` to be a field on the task — which it
   isn't today. It can be computed from `last_phase_change_at`, which
   IS in the schema. So either the rule does the math (which means
   template filters, again) or the producer enriches the field at
   query time. The latter is cleaner.

4. **Action 3 (for-each):** Same pattern as action 2 but filtered by
   `due_date < now AND state.category != 'done'`. Posts to a project
   channel `banter_post_message(channel='engineering-{{ step[0].result.project_slug }}', ...)`.

5. **Action 4 (conditional):** This is a branch node. The condition is
   `step[0].result.burndown_pace_ratio < 0.8` (the sprint is below 80%
   of expected pace). The "if true" branch runs `banter_post_message`
   to the team channel with the warning. The "if false" branch is
   empty (or could be a positive "we're on track" message).

   **This needs the branch node from §3.3.** It also needs the sprint
   query to return a `burndown_pace_ratio` — which it can compute from
   data we already have (`tasks_completed`, `tasks_committed`,
   `start_date`, `end_date`, `now`).

6. **Action 5 (for-each + try/catch):** For every blocked task, run a
   sub-pipeline: create the Brief document, link it to the task, assign
   it, post the high-priority message. Wrap the whole thing in a
   try/catch so if Brief is having a bad day, the rest of the run still
   posts what it can.

   **This needs both the for-each AND the try/catch nodes from §3.3.**

7. **Action 6: AI-generated status summary.** Riley picks an
   `ai_summarize` tool (which doesn't exist as an MCP tool yet — would
   need to be added; Bench has `bench_summarize_dashboard` which is
   adjacent). Provides the day's task activity as input. Posts the
   result to `#engineering-standup`.

**Coverage check:**

- **What works today:** the cron trigger, the basic action list, the
  channel-by-name in actions 2/3/4, the email-by-resolution for the DM
  in action 2.
- **What's missing:**
  - For-each, branch, try/catch nodes (§3.3) — none exist today
  - Inline filter expressions on a for-each
  - `bam_get_active_sprint` MCP tool — there's `list_sprints` with a
    status filter, which is close
  - `days_in_phase` and `burndown_pace_ratio` enriched fields on the
    sprint/task query response
  - `ai_summarize` MCP tool (or whatever the AI surface should look like)
- **Engine capability:** the engine doesn't currently support for-each,
  branch, or try/catch nodes. These are real engine changes, not just
  UI changes.

**What this story tells us about the UI:**

- For-each, branch, and try/catch are not optional advanced features —
  they're table stakes for any rule that does aggregation or
  per-collection work. Without them, half of the natural use cases for
  Bolt aren't even expressible.
- "Compute a field from other fields" comes up constantly. Either
  template filters (Tier 4) handle it, or the producer needs to emit
  pre-computed fields (more Phase B work).
- The AI surface deserves its own design pass — it's adjacent to
  but distinct from the MCP tool model, because the inputs are
  unstructured text and the outputs need shaping.

### Story 3 — The Lead-to-Cash Pipeline

**Persona:** Jordan, founder of a 4-person consulting shop. Doesn't have
an ops person. Wants to wire up Bond, Blast, Bill, Book, and Bam so that
once a lead enters the pipeline, the right things happen automatically
end-to-end.

**Goal:** Build *five different rules* that compose into a full
lead-to-cash pipeline:

1. **Rule A:** When a Blank form submission comes in on the "Contact
   Sales" form → create a Bond contact, attach to or create a Bond
   company by domain match, log a "Form Submission" activity on the
   contact, add to the "New Leads" segment.

2. **Rule B:** When a Bond contact's lead score crosses 75 (rule's
   condition is `event.contact.lead_score >= 75 AND event.contact.lead_score - event.contact.previous_lead_score < 0`, i.e., crossed
   the threshold this update) → create a Bond deal in the Sales pipeline
   at the "Qualified" stage, owner = Jordan, amount = best-guess from
   the contact's company size, post in #sales channel.

3. **Rule C:** When a Bond deal moves to "Proposal Sent" stage → wait
   3 business days, then post a follow-up reminder DM to Jordan if the
   deal hasn't moved.

4. **Rule D:** When a Bond deal moves to "Closed Won" → run the Story 1
   onboarding pipeline as a sub-rule (pull in another rule's body).

5. **Rule E:** When a Bill invoice is finalized AND the related deal is
   tagged as "Net 30" → schedule a Book event 25 days out for "Check on
   payment status: invoice {{ event.invoice.number }}", create a Bam
   task in "Finance" project assigned to Jordan with the same title.

**What Jordan needs from the UI:**

1. **Rule A** is mostly a 4-action rule with name-based parameters
   throughout. Mostly works post-Phase D. The novel piece is "attach
   to or create a Bond company by domain match" — this is conditional
   logic (does the company exist? if yes, attach; if no, create) that
   needs the **branch node** from §3.3. It also needs `bond_find_company_by_domain` which doesn't exist yet (could be added as a Phase C
   follow-up).

2. **Rule B** introduces the "crossed a threshold" pattern. The current
   `previous_lead_score` field is in the catalog (Phase B work would
   have added it as part of `contact.updated`). The condition needs to
   express both the new and old values. Today's condition builder
   supports this (each condition row picks any field, including diff
   fields), but the AND of two conditions referencing the SAME source
   row is awkward. A "delta" or "changed_to" operator would be cleaner:
   `lead_score crossed_to >= 75`. **Add this to the §3.2 condition
   operator list.**

3. **Rule C** introduces **scheduled delays** ("wait 3 business days,
   then…"). This is fundamentally not expressible in today's rule model
   — every rule is "trigger → conditions → actions" with no time
   passing in between. Two ways to support this:

   a. **A `delay` action** that pauses the rule for a specified duration
      before running the next action. Implemented via BullMQ delayed
      jobs (which BullMQ supports natively). The rule's execution log
      shows the delay step with a "scheduled for X" timestamp.

   b. **A separate "scheduled rule" abstraction** where rule C fires
      its actions on a schedule rather than synchronously. Rule A
      becomes "when deal moves to Proposal Sent → schedule a 3-day
      check"; the check is its own rule.

   I'd go with (a) — `delay` as an action type. It composes more
   naturally with the existing model and doesn't require a new top-level
   abstraction. **The §3.3 list should include `delay` as a fourth
   special node type alongside branch / for-each / try-catch.**

   Rule C also needs a follow-up condition: "if the deal hasn't moved".
   That means the rule needs to query the deal's current state at
   wakeup time, not rely on the original trigger event. So the action
   right after the delay is `bond_get_deal({{ event.deal.id }})` and the
   subsequent branch node compares `step[N].result.stage_name` against
   the original `event.new_stage_name`.

4. **Rule D** introduces **rule composition** — calling another rule
   from within an action. This is a big architectural decision:
   - One option is a `bolt_run_rule(name)` MCP tool that triggers
     another rule synchronously, passing the current event payload.
   - Another option is making rules **callable as tools** automatically
     — every rule shows up in the action picker as a callable entity.
   - A third option is just letting the user define **shared sub-rules**
     that aren't full rules but action lists with named parameters.
     Closer to "functions" than "rules".

   I'd go with the third option for the simple case (shared
   sub-rules / "snippets") and add the `bolt_run_rule` tool for cases
   where you genuinely want one full rule to invoke another. This is a
   meaningful feature to design carefully.

5. **Rule E** is a multi-condition rule. The condition is a join across
   two entities (the invoice and its related deal). The deal's tags
   aren't in the invoice event payload, so the rule needs to fetch the
   deal as a step before the condition can be evaluated. Today's
   condition evaluation happens BEFORE any actions run, so this isn't
   expressible. Two fixes:

   a. **Lift the condition into a step**. Add an "if" branch node at
      the top of the action list whose condition is
      `step[0].result.tags.includes('Net 30')`. This means conditions
      become a special case of branches and the strict "WHEN/IF/THEN"
      separation softens.

   b. **Add a "fetch and condition" combinator** in the IF section that
      can pull data via a resolver tool and then test it. More elegant
      but requires extending the condition engine.

   I'd lean toward (a) — collapse the strict three-section model and
   let actions live anywhere. The simple case (no fetches) keeps
   working; the advanced case becomes possible.

**Coverage check:**

- **What works:** name-based parameters everywhere; the trigger picker;
  basic action chains; the contact + deal + invoice events have rich
  payloads after Phase B.
- **What's missing:** branch nodes, delays, rule composition,
  "crossed_to" condition operator, fetching data inside conditions,
  some specific MCP tools (find_company_by_domain).
- **Engine capability:** delay is the biggest engine change. It needs
  BullMQ delayed-job support in the worker and a way to round-trip
  the execution context across the wakeup. Branch nodes need an action
  type extension. Rule composition needs either a sync rule-calling
  mechanism or named sub-rule snippets.

**What this story tells us:**

- **Time-aware actions are essential.** A rule engine that can only
  fire and forget is half a rule engine. Delays unlock follow-ups,
  reminders, escalations, SLA checks.
- **Rule composition is the difference between Bolt as a toy and Bolt
  as a system.** Without it, rule files become huge and unmaintainable.
- **The strict WHEN/IF/THEN split** is probably wrong. Real rules
  interleave queries, conditions, and actions. The model should let
  you do that.

### Story 4 — The Quarterly OKR Conductor

**Persona:** Sam, COO at a 50-person company. Wants to run quarterly OKR
cycles end-to-end via automation: kick off the new period, nag people
to set goals, track progress, generate weekly status, and wrap up the
period at the end.

**Goal:** A *suite* of rules that together orchestrate a quarter:

1. **Start of period rule:** When a new Bearing period is created
   (`bearing.period_created` event — doesn't exist in the catalog yet)
   → create a "Q[N] OKRs" Brief document from a template, post a
   kickoff message in #leadership with a deadline, schedule a kickoff
   event on the Leadership calendar, create a Bam task assigned to
   each VP to "Submit your team's draft goals by [deadline]".

2. **Mid-period reminder rule (cron, weekly):** Every Friday at 4pm,
   compute progress per goal (`bearing_get_period_progress`), post a
   summary in each team's Banter channel mentioning the goal owner
   and current vs target, flag any KR that's "off track" (current
   pace < 80% of expected) for a 1:1 nudge.

3. **End-of-quarter wrap-up rule:** When a Bearing period status
   changes to "Closed" → snapshot final results into a Brief retro
   document, schedule a Leadership retro on the calendar 1 week out,
   post the retro doc link in #leadership, open a follow-up task for
   each missed goal.

4. **Per-KR cross-app sync:** When a Bond deal closes (Closed Won),
   automatically bump any KR tagged with that pipeline by the deal
   amount (`bearing_kr_update`). When a Bam task is completed and
   linked to a KR, increment that KR's count.

**What Sam needs:**

1. **All four rules** rely on event types that don't exist yet:
   - `bearing.period_created` — needs producer work
   - `bearing.period_closed` — needs producer work
   - "task completed AND linked to KR" — task.completed exists, but the
     linkage isn't in the payload (would need to be added via Phase B
     enrichment of `task.completed`)
   - "deal closed AND linked to KR" — same problem

2. **Rule 2** needs the cron scheduling that already exists, plus the
   for-each + branch pattern from §3.3 to iterate over goals. It also
   needs an aggregation: "current pace < 80% of expected" — that's
   computable from `key_result.target`, `key_result.current_value`,
   `period.start_date`, `period.end_date`, `now`. Either the engine
   computes it via template filters (Tier 4) or a `bearing_get_kr_pace`
   helper tool returns it pre-computed.

3. **Rule 1's "create a task per VP"** is a for-each over a fetched
   list (the VPs) — needs the for-each node + a `bam_list_users(role='VP')`
   resolver tool that doesn't exist yet (Phase C added user search but
   not by role).

4. **Rule 4 (per-KR cross-app sync)** introduces a different pattern:
   the rule's CONDITION needs to consult an external link table
   ("is this deal/task linked to a KR?"). That's a query inside a
   condition — exactly the §2.4 / §3.2 case. Without it, the rule has
   to fire on EVERY deal closed and short-circuit early when there's
   no link, which is wasteful but possible.

**Coverage check:**

- **What works:** cron triggers, name-based actions, KR updates,
  user resolution by email.
- **What's missing:** ~5 events that need to be added to producers
  (period.created, period.closed, task.completed enriched with linked KRs,
  similar for deal.closed), for-each + branch nodes, query-in-condition
  capability, several specific helper tools.
- **Engine capability:** doable but requires substantial Phase B-C
  follow-up work plus the engine extensions for for-each / branch.

**What this story tells us:**

- A **suite of rules** acting as a coordinated workflow is a real
  pattern. Folders (§3.7) help organize; dependency view (§3.7) helps
  understand interactions. We may want a "rule pack" abstraction that
  bundles related rules together with shared variables and shared
  documentation.
- The **catalog is never finished** — every new use case finds events
  that aren't yet emitted. Adding new events should be cheap. Producers
  should not be hand-coded; they should declaratively export events
  from a manifest. (This is basically Tier 1 done right — have
  producers register their events in code that's mechanically merged
  with the catalog at build time.)
- **Cross-app links** (KR ↔ deal, KR ↔ task) are the connective tissue
  that makes a multi-app suite valuable. Today these are implicit.
  They should be explicit and queryable.

### Story 5 — The Compliance & Audit Sentinel

**Persona:** Pat, security lead at a healthcare-adjacent company. Has to
prove to auditors that certain things never happen or always happen.

**Goal:** A set of rules that act as automated guardrails:

1. **Rule A:** When ANYONE deletes a Beacon entry → create a Helpdesk
   ticket with priority high, assign to Pat, attach the deleted
   beacon's content as the body, post in #security-alerts.

2. **Rule B:** When a Bam task in the "Compliance" project is moved to
   "Done" → run a checklist: confirm a Brief document is linked,
   confirm there's at least one comment from a "compliance approver"
   role, confirm a label "audit-reviewed" is set. If ANY check fails,
   move the task back to "Review", post in #compliance-ops, and DM the
   assignee.

3. **Rule C:** Every weekday at 2am, sweep all Bond contacts for any
   that have personal data fields (email, phone) AND haven't been
   active in 24 months. For each, post a notification in #compliance-ops
   asking whether to anonymize.

4. **Rule D:** When a Bolt automation itself is enabled or disabled
   (meta-rule!) → log an entry to a Brief audit document, post in
   #security-changes with who did it and why (rule's description).

5. **Rule E:** When a user logs in from a new IP (event would need to
   exist) → DM the user a verification link, log to the audit Brief.

**What Pat needs:**

1. **Most rules need conditions that combine multiple checks** with
   AND/OR groups. Today's condition builder handles this, but rule
   B's checklist is really three separate sub-conditions ("is X
   linked", "is Y commented", "is Z labeled") that should be displayed
   as a checklist for clarity. **The condition builder UI should
   visually group "all of these" / "any of these" / "none of these"
   sections.**

2. **Rule B's checklist conditions** need to query state that isn't
   in the trigger event (the linked Brief, the comments by role, the
   labels). Same query-in-condition pattern as Story 4 rule 2.

3. **Rule A** needs the deleted Beacon's content in the event payload
   — but `beacon.deleted` (or `beacon.retired`) might not include the
   full content. **Phase B's enrichment didn't go this deep**;
   producer side would need to grab the content before deletion.

4. **Rule D** is meta-Bolt — rules about Bolt itself. Bolt-tools.ts has
   `bolt_enable` and `bolt_disable` (Phase D made them name-acceptable),
   but the *events* "automation enabled" and "automation disabled" don't
   exist in the catalog. Adding them would let rules react to other
   rules being changed.

5. **Rule E** depends on an event the api doesn't currently emit
   ("user.logged_in_from_new_ip"). This is a security audit feature
   that would need to be added at the auth layer.

6. **Rule A's "create a Helpdesk ticket" action** — `helpdesk_create_ticket`
   — needs to be a tool that doesn't currently exist (the existing tools
   are reply_to_ticket, update_ticket_status, list_tickets, get_ticket,
   helpdesk_get_ticket_by_number, helpdesk_search_tickets). Helpdesk
   ticket *creation* is a customer-portal action, not an MCP tool.
   Adding `helpdesk_create_ticket(subject, body, priority, assignee_id)`
   would be straightforward.

**Coverage check:**

- **What works:** condition builder fundamentals, the actions that
  exist (post message, DM, update task, create Brief).
- **What's missing:** several specific events (beacon.deleted with
  full content, automation.enabled/disabled, user.new_ip),
  helpdesk_create_ticket tool, query-in-condition capability,
  visual condition grouping.
- **Engine capability:** doable. The new pieces are mostly catalog
  + producer + tool additions, not engine changes.

**What this story tells us:**

- **Audit rules need to be testable AND immutable.** An automation
  that's supposed to fire on every deletion can't be silently
  disabled — there should be a "this is a compliance rule, require
  approval to disable" flag, with a separate audit log of approve/
  deny events. This is a meta-feature on top of the rule definition.
- **Condition checklists** ("must be true: X, Y, Z") are a recurring
  pattern that deserves first-class UI support — show me which
  checks passed and which failed, not just "true" or "false".
- **Bolt-on-Bolt observability** is genuinely useful. Compliance use
  cases need to monitor what other rules are doing, including their
  enable/disable state. Add events for that.

---

## 5. Synthesis: what the user stories revealed

Five very different rules. Each requires capabilities the current Bolt
doesn't have. Patterns that came up more than once:

### 5.1 Universal needs (every story)

- **Name-based picker UI** for every parameter that takes a UUID. Phase D
  made this possible at the schema level; the UI must default to it.
- **Template autocomplete that knows the trigger event's payload** and
  shows previews of the resolved values. We have the autocomplete; we
  need it to show "what this would resolve to right now" for any
  payload field.
- **"From a previous step" parameter syntax** with discoverable UI.
  Already partially supported via `{{ step[N].result.* }}`; needs to
  surface in the autocomplete with the action name and (ideally) the
  return shape of that action.

### 5.2 New engine capabilities (multiple stories)

- **For-each** (Stories 2, 4) — iterate over an array
- **Branch / if** (Stories 1, 2, 3, 5) — conditional sub-actions
- **Try/catch** (Stories 2) — error recovery
- **Delay** (Stories 3, 5) — pause for time
- **Query-in-condition** (Stories 3, 4, 5) — fetch data before evaluating
  conditions
- **Rule composition** (Story 3) — call one rule from another, or share
  named action snippets

### 5.3 Template filter library (Stories 1, 2, 4)

- Date math: `add_days`, `add_business_days`, `start_of_day`,
  `format_date`, `format_relative`
- String transforms: `slug`, `truncate`, `upper`, `lower`,
  `replace`, `extract_email`, `extract_url`
- Math: `multiply`, `divide`, `round`, `format_currency`
- Array: `length`, `first`, `last`, `join`, `filter`, `map`
- Logical: `default(value)` (use this if undefined),
  `coalesce(a, b, c)` (first non-empty)

These map to Tier 4 from the strategy doc. None exist today. Adding them
is a contained piece of worker work.

### 5.4 Catalog gaps

The stories surfaced specific events and tools that need to exist:

**Events:**
- `bearing.period_created`, `bearing.period_closed`
- `bolt.automation_enabled`, `bolt.automation_disabled` (meta-events)
- `task.linked_to_kr` (or enrich `task.completed` with linked KRs)
- `deal.linked_to_kr`
- `user.logged_in_from_new_ip`
- `task.phase_changed_to_blocked` and similar phase-specific events
- `beacon.deleted` (with full content snapshot)

**MCP tools:**
- `bam_get_active_sprint(project_id)`
- `bam_list_users(role)` — search by role
- `bond_find_company_by_domain(domain)`
- `blast_segment_add_contact(segment_id, contact_id)`
- `helpdesk_create_ticket(subject, body, priority, assignee_id)`
- `bolt_run_rule(name, payload)` — sub-rule invocation
- `ai_summarize(input, prompt)` — AI text summarization
- `bearing_get_period_progress(period_id)` — pre-computed pace metrics

**Enrichments to existing tools:**
- `bam_get_task_with_phase_duration` — current task list response
  doesn't include `days_in_phase`

### 5.5 The "WHEN/IF/THEN" model is too rigid

Three stories (3, 4, 5) wanted to interleave queries, conditions, and
actions. The current strict three-section split forces the rule into a
shape it doesn't naturally take.

The model should evolve toward **a single ordered list of nodes**, where
each node is one of:
- A trigger (one per rule, must be first)
- A condition (filters whether the rule continues)
- A query / fetch (loads data into the step results)
- An action (performs an MCP tool call)
- A control-flow node (branch, for-each, try/catch, delay)

The current "WHEN/IF/THEN" view is a *projection* of this list — show
me only the trigger, only the conditions, only the actions. Power users
can switch to the full ordered view to interleave.

---

## 6. Recommended implementation order

If we adopted this strategy, here's the order I'd ship things:

### Phase E1 — UI catch-up (no engine changes)

The rule builder should fully exploit what the engine already supports
post-Phase D:

1. Event-aware autocomplete with resolved-value previews
2. Name-based dropdowns for every parameter the schema now accepts
3. "From a previous step" autocomplete category, with the ability to
   click a step in the action list and have it inserted as
   `{{ step[N].result.* }}`
4. Inline execution preview (dry-run against a sample event)
5. Execution log made navigable + click-to-jump between log and rule
6. Visual condition grouping ("all of:", "any of:", "none of:")

### Phase E2 — Engine + UI for control flow

Adds the four power-user nodes that unlock most of the user stories:

1. Branch / if node (engine + UI)
2. For-each node (engine + UI)
3. Delay node (engine + UI; needs BullMQ delayed jobs)
4. Try/catch node (engine + UI; supersedes the per-action `on_error`
   for complex cases)

Each is a meaningful engine change. They should ship together because
they share the same node-type abstraction.

### Phase E3 — Template filters (Tier 4 from the strategy doc)

Date math, string transforms, math, array helpers, logical fallbacks.
Implemented in the worker's `resolveTemplateString`. Mostly mechanical
once the registry shape is decided.

### Phase E4 — Query-in-condition + new event types

Gradual additions to the catalog: events that user stories need
(`bearing.period_created`, `bolt.automation_enabled`, `user.new_ip`,
etc.) and a small extension to the condition engine to support
"fetch then test" preconditions.

### Phase E5 — Rule composition

Probably a "named action snippet" abstraction first (simple, easy to
explain), with a `bolt_run_rule` MCP tool as a follow-up for
heavier-weight cases.

### Phase E6 — Templates, library, sharing

Once the rule builder is powerful enough to express interesting things,
provide a starter library and let users share templates. This is the
"network effect" phase.

### Phase E7 — Versioning, dependency view, test mode

Production-grade features for orgs with large rule fleets. Lower
priority — only matters once people have a lot of rules.

---

## 7. Open questions

Things I'd want to settle before any of this work begins:

**(a) Named sub-rules vs full rule composition.** Story 3 needs a way
for one rule to invoke another. Three options (snippet, full call,
auto-tool) have different ergonomic profiles. Probably worth doing a
focused spike to feel each one out before committing.

**(b) WYSIWYG-style template editor for `body` fields.** Story 1's
multi-line message body wants a friendlier surface than a raw template
string. A text area where you click-to-insert variables, with live
preview, would be much better. But it's a real piece of frontend work.

**(c) AI-tool surface.** Story 2's `ai_summarize` and Story 1's
"draft a welcome message" are two examples of AI-assisted actions that
don't fit the pure-MCP model (the input is unstructured prose). This
deserves its own design pass — should AI actions be MCP tools (with
prompt + model + temperature parameters), or a separate node type, or
something else?

**(d) Strict mode vs lenient mode for ambiguous resolvers.** Phase D's
disambiguation policy is "single match → use it; multiple matches →
fail". Story 3's "company by domain" wants a different policy (create
if not found, fail if multiple). Let the rule author pick per-tool, or
have global "strict / lenient" preferences? Probably per-tool with sane
defaults.

**(e) How do we test rules?** Phase A added strict template mode but
didn't add a "test this rule against a saved fixture" feature. The
inline execution preview from §3.4 covers some of this, but not the
"replay against last week's events to see what would have happened"
case. Worth thinking about what testing means here.

**(f) Permissions.** Who can author rules? Who can disable a rule
written by someone else? Who can see another person's execution log?
These aren't UI questions per se but they affect the UI design — a
rule list page that can't show another user's rules is a different
page than one that can.

---

## 8. Recommendation

If this resonates, the order I'd start in is:

1. **Build Phase E1 (UI catch-up).** It's the highest-leverage piece
   because it makes everything Phases A-D enabled actually visible to
   users. Maybe 1-2 weeks of focused frontend work.

2. **Spike on Phase E2 (control flow).** Pick branch or for-each as
   the first one and build it end-to-end (engine + UI) to find out
   what's hard. Then ship the other three to the same pattern.
   Maybe 2-3 weeks.

3. **Phase E3 (template filters)** can ship in parallel with E2 since
   it's a worker change with no UI dependency. Half a week of work.

4. **Then revisit this document** with the user stories in hand and
   pick what Phase E4-E7 looks like based on what people are actually
   asking for at that point.

Total: 4-6 weeks of focused work to take Bolt from "the engine is
powerful, but the UI doesn't show it" to "the UI matches the engine
and people can express most real automations in it without leaving the
visual builder."

Beyond that we're into network-effect territory (templates, sharing,
community library) and production-grade fleet management (versioning,
dependency graphs, test mode), which are real features but not on the
critical path for "make the existing engine usable".
