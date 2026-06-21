# Bolt help.md - Review

**Verdict: APPROVED**

One-line rationale: Every template section is present and filled, every frontend
view/action has followable how-to steps, all spot-checked UI labels and counts
trace to code, and the three critical disclosures (Test Run broken, linear
no-branching engine, AI-authoring/versioning as API-only) are documented exactly
as the code requires.

---

## What was verified against code

### Template completeness
All four required sections present and filled: Overview (with Key concepts plus
Where to find it), Feature reference (with Working with AI agents), User Stories
(8 stories), Related. Matches the help-doc-authoring skill output contract.

### Critical disclosures (the three the task required)
1. Test Run broken state - documented correctly. The doc Known issue block
   accurately states both defects:
   - useTestAutomation (apps/bolt/src/hooks/use-automations.ts:219-224) POSTs
     /automations/:id/test with no body; handleTest
     (apps/bolt/src/pages/automation-editor.tsx:171-175) calls mutateAsync(id)
     only. The route requires event: z.record(z.unknown())
     (apps/bolt-api/src/routes/automation.routes.ts:179-180,500), so the call
     400s as VALIDATION_ERROR.
   - The editor success banner reads testMutation.data.data.execution_id
     (automation-editor.tsx:575), but testAutomation returns only
     { passed, log, message } (apps/bolt-api/src/services/automation.service.ts:906-927)
     with no execution_id. Both defects are called out in the doc.
   - The doc also correctly states a test only evaluates conditions and never
     runs actions.
2. Linear (no-branching) engine - documented correctly. The doc Note on flow and
   the Visual-mode note both state actions run as a single linear ordered list
   and that the graph is flattened on save. Confirmed: compileGraphToRows /
   topoOrder (apps/bolt-api/src/services/bolt-graph-compiler.ts:71-193)
   topologically orders nodes into a linear sort_order action list; conditions
   gate the whole automation. The doc correctly affirms {{ step[N].result.* }}
   interpolation IS real (apps/worker/src/jobs/bolt-execute.job.ts:99,137,543).
3. AI-authoring and versioning as API-only - documented correctly. The doc
   Working with AI agents section explicitly marks both as backend/API-only with
   no in-app UI. Confirmed: zero frontend callers of /ai/generate, /ai/explain,
   or /versions anywhere under apps/bolt/src/. Routes exist but are never wired
   to a screen.

### Counts (all code-backed)
- 15 MCP tools = 13 core + 2 observability. Exactly 13 bolt_* tools in
  apps/mcp-server/src/tools/bolt-tools.ts + 2 in bolt-observability-tools.ts
  (bolt_event_trace, bolt_recent_events).
- 14 trigger sources in home.tsx:13-28 (sourceLabels), order matches the doc
  chip list exactly.
- 13 condition operators in
  apps/bolt/src/components/builder/condition-row.tsx:23-37 (ALL_OPERATORS),
  match the doc list exactly.
- 16 templates = 15 in template.service.ts + 1 banterApprovalDmTemplate imported
  from templates/banter-approval-dm.ts (template.service.ts:5,466).
- 11 cron presets in cron-editor.tsx:83-95 (PRESETS).
- Max Executions / Hour 1 to 1000 default 60 and Cooldown 0 to 3600 default 0:
  input bounds min=1 max=1000 / min=0 max=3600 in automation-editor.tsx:528-545.
  The doc documents the UI bounds (not the looser API bounds), the right choice
  for a help doc.

### UI labels (all spot-checks traced to code)
WHEN - Trigger / IF - Conditions / THEN - Actions (editor 399/466/483),
Trigger Source / Event Type (trigger-selector 36/58), Always run
(condition-list:46), Add Condition (condition-list:72), Add Action
(action-list:71), On Error / Retry Count / Show advanced
(action-editor:299/315/293), Save Draft / Save & Enable (editor:588/598),
Test Run (editor:569), Please fix the following errors before saving:
(editor:277), Only one trigger allowed (node-palette:130), Select a node on the
canvas to configure it. (node-inspector:50), Unsaved graph changes may be lost.
Switch to Simple mode? (editor:329), Total Automations/Enabled/Disabled
(home:206-208), Search automations... (home:219), New Automation (home:193),
Last run (home:112), Execution Log / History of all automation runs across your
organization. (exec-log:104-105), All automations (exec-log:132), Back to
Executions / Retry / Trigger Event / Condition Evaluation / Execution Steps /
Duration / Conditions Met / Steps / Completed (execution-detail), Templates /
Start with a pre-built automation template and customize it. / Use Template
(template-browser:81-83,59), Please log in to BigBlueBam first to access Bolt. /
Go to BigBlueBam Login (app.tsx:128-130), ? opens HelpViewer (app.tsx:101,138).

### Behavior claims (all code-backed)
- Duplicate clones to <name> (copy) starting disabled
  (automation.service.ts:861,868).
- Retry only on failed/partial + RATE_LIMITED 429 over hourly cap
  (execution.service.ts:188-191,217-221); UI button gated to failed/partial
  (execution-detail.tsx:62).
- max_chain_depth loop guard (event-ingestion.routes.ts:206,223;
  bolt-automations.ts:52).
- Related-section events all exist in catalog: task.created (50), task.moved
  (154), task.overdue (246), sprint.completed (447), ticket.created (904),
  ticket.sla_breach (939), deal.won (1051), deal.rotting (1076).
- cron.fired schedule event (event-catalog.ts:973).

### Conventions
- No em dashes in help.md (grep count: 0). The doc renders section labels with
  spaced hyphens (WHEN - Trigger) even though the rendered UI label uses an em
  dash; this is the correct skill convention and does not misrepresent the UI.
- All 5 referenced screenshots exist under
  docs/apps/bolt/screenshots/light/ (01-automations, 02-editor, 03-detail,
  04-executions, 05-templates).png; dark variants also present. The doc
  correctly notes screenshot 03 is labeled Automation detail but actually shows
  the execution-detail page, and explains there is no standalone
  automation-detail view.

### Story coverage (all required arcs present and followable)
- Setup: Create your first automation from a template + Create an automation by
  hand.
- Core loop: Auto-create a Bam task when a Bond deal goes stale, Schedule a
  recurring automation.
- Collaboration / cross-app: the Bond -> Bolt -> Bam chain story.
- Search / reporting / monitoring: Watch a run and read its detail, Retry a
  failed run.
- Agent flow: Operate Bolt from an AI agent.

---

## Accuracy findings

No inaccurate claims found. Every label, count, and feature claim spot-checked
traced to a route, component, service, or MCP tool. The doc correctly resists
the marketing-driven errors flagged in the dossier (no visible AI button, no
branching, no working Test Run, no versioning UI).

## Optional polish (non-blocking, not required for approval)

1. help.md, Simple mode, To add actions step 1. The doc quotes the empty-state
   as "Add at least one action...". The exact string is "Add at least one action
   to define what happens." (action-list.tsx:46). The ellipsis abbreviation is
   acceptable but could be quoted in full.
2. help.md, Per-automation executions. The doc gives the heading
   <name> - Executions; the page also renders a subtitle "Execution history for
   this automation." (automation-executions.tsx:48) not mentioned in the doc.
   Minor; the heading claim itself is correct.
3. help.md Templates note. The doc says Bolt ships 16 templates - correct.
   Noting for traceability the count splits 15 + 1 across two files.
