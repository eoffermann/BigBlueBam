-- Seed Bolt demo data
-- Run via orchestrator: node scripts/seed-all.mjs (substitutes :org_id / :user_N)
-- idempotent: skip-if-any-automation-already-present
--
-- AUTHORING NOTES (see docs/functionality-audits/bolt-templates-audit-2026-06-13.md):
--   * trigger_filter (the JSONB column below) is evaluated by
--     event-ingestion.routes.ts against the RAW payload object WITHOUT the
--     `event.` prefix and by literal dot-path split. So for a task.created
--     event whose payload has `task.priority`, the correct filter key is
--     "task.priority" — NOT "priority" and NOT "event.task.priority". This is
--     the OPPOSITE convention from bolt_conditions.field, which DOES require
--     the `event.` prefix because conditions run against the wrapped payload
--     `{ event, actor }`. The two systems disagree on purpose; see the audit
--     doc "seed-bolt.sql findings" section.
--   * Action mcp_tool names MUST be tools that exist in the action registry
--     (event-catalog.ts getAvailableActions) AND are registered live in the
--     MCP server. The four tools this seed used previously
--     (banter_send_message, helpdesk_assign_ticket, helpdesk_update_priority,
--     helpdesk_reply_ticket) are NOT registered and hard-fail at dispatch.
--     They are replaced below with banter_post_message, update_ticket_status,
--     and reply_to_ticket.
--   * banter_send_dm takes { to_user_id, content }; banter_post_message takes
--     { channel_id, content } (channel_id accepts a bare channel name).
--   * {{ actor.name }} does not exist in the action template context (only
--     {{ actor.id }} / {{ actor.type }}); use {{ event.actor.name }}.

DO $$
DECLARE
  v_org UUID := :org_id;
  v_proj UUID;
  v_u1 UUID := :user_1;
  v_u2 UUID := :user_2;
  v_u3 UUID := :user_3;
  v_u4 UUID := :user_4;
  v_u5 UUID := :user_5;
  v_u6 UUID := :user_6;

  a1 UUID; a2 UUID; a3 UUID; a4 UUID; a5 UUID;
  a6 UUID; a7 UUID; a8 UUID; a9 UUID; a10 UUID;
  a11 UUID; a12 UUID;
  e1 UUID; e2 UUID; e3 UUID; e4 UUID; e5 UUID;
BEGIN
  -- Resolve a project for this org (orchestrator does not substitute :project_id).
  SELECT id INTO v_proj FROM projects WHERE org_id = v_org ORDER BY created_at LIMIT 1;

  -- Idempotency guard
  IF EXISTS (SELECT 1 FROM bolt_automations WHERE org_id = v_org LIMIT 1) THEN
    RAISE NOTICE 'Bolt seed: automations already exist for this org, skipping.';
    RETURN;
  END IF;

  -- ── Automations ──
  a1 := gen_random_uuid(); a2 := gen_random_uuid(); a3 := gen_random_uuid();
  a4 := gen_random_uuid(); a5 := gen_random_uuid(); a6 := gen_random_uuid();
  a7 := gen_random_uuid(); a8 := gen_random_uuid(); a9 := gen_random_uuid();
  a10 := gen_random_uuid(); a11 := gen_random_uuid(); a12 := gen_random_uuid();

  INSERT INTO bolt_automations (id, org_id, project_id, name, description, enabled, trigger_source, trigger_event, trigger_filter, max_executions_per_hour, cooldown_seconds, created_by, last_executed_at) VALUES
    -- a1: trigger_filter key is "task.priority" (raw-payload path, no event. prefix);
    -- "critical" is a valid default priority slug (migration 0183 seed set).
    (a1, v_org, v_proj, 'Notify on Critical Task', 'Posts to #engineering when a critical task is created', true, 'bam', 'task.created', '{"task.priority": "critical"}', 100, 0, v_u1, NOW() - INTERVAL '2 hours'),
    (a2, v_org, v_proj, 'Overdue Task Alert', 'DMs the assignee when a task is overdue by 2+ days', true, 'bam', 'task.overdue', NULL, 50, 300, v_u2, NOW() - INTERVAL '6 hours'),
    (a3, v_org, v_proj, 'Sprint Complete Report', 'Posts sprint report to #engineering when a sprint completes', true, 'bam', 'sprint.completed', NULL, 10, 0, v_u1, NOW() - INTERVAL '7 days'),
    -- a4: trigger_filter key is "ticket.category" (raw-payload path).
    (a4, v_org, v_proj, 'Helpdesk Auto-Progress Billing', 'Moves billing tickets to in-progress and notifies the billing channel', true, 'helpdesk', 'ticket.created', '{"ticket.category": "billing"}', 100, 0, v_u3, NOW() - INTERVAL '1 hour'),
    (a5, v_org, v_proj, 'SLA Breach Escalation', 'Moves breached tickets to in-progress and DMs the on-call lead', true, 'helpdesk', 'ticket.sla_breach', NULL, 50, 60, v_u3, NOW() - INTERVAL '3 days'),
    (a6, v_org, v_proj, 'Beacon Expiry Reminder', 'Posts reminder to #knowledge when a beacon expires', true, 'beacon', 'beacon.expired', NULL, 100, 0, v_u4, NOW() - INTERVAL '1 day'),
    (a7, v_org, v_proj, 'New Document Notification', 'Notifies project channel when a Brief document is created', true, 'brief', 'document.created', NULL, 100, 0, v_u5, NOW() - INTERVAL '5 hours'),
    (a8, v_org, NULL, 'Weekly Status Reminder', 'Posts a weekly status-update reminder every Monday at 9am', true, 'schedule', 'cron.fired', NULL, 1, 0, v_u1, NOW() - INTERVAL '7 days'),
    (a9, v_org, v_proj, 'Task Moved to Review', 'Notifies the assignee when a task enters the Review phase', true, 'bam', 'task.moved', NULL, 100, 0, v_u6, NOW() - INTERVAL '4 hours'),
    -- a10: NEEDS-AGENT — task.completed has no linked_ticket_id. Disabled so it
    -- stays inert; the guard condition (event.task.linked_ticket_id is_not_empty)
    -- would never match anyway. An agent must map task -> ticket.
    (a10, v_org, v_proj, 'Close Ticket on Task Complete (needs agent)', 'Replies to a linked helpdesk ticket when a task completes — requires an agent to resolve the task->ticket mapping (no linked_ticket_id in the event)', false, 'bam', 'task.completed', NULL, 100, 0, v_u2, NOW() - INTERVAL '12 hours'),
    (a11, v_org, v_proj, 'Document Promoted to Beacon', 'Posts to #knowledge when a Brief doc graduates to Beacon', true, 'brief', 'document.promoted', NULL, 50, 0, v_u4, NULL),
    -- a12: trigger_filter targets the nested "mentioned_user.name" string in the
    -- message.mentioned payload (there is no bare "mentioned_user" scalar).
    (a12, v_org, v_proj, 'Critical Mention Alert', 'DMs the mentioned user when @oncall is mentioned in any channel', false, 'banter', 'message.mentioned', '{"mentioned_user.name": "oncall"}', 30, 60, v_u6, NULL);

  -- ── Conditions (only where meaningful — automations without conditions always run) ──
  -- NOTE: bolt_conditions.field DOES require the `event.` prefix (wrapped payload).
  INSERT INTO bolt_conditions (automation_id, sort_order, field, operator, value, logic_group) VALUES
    (a2, 0, 'event.task.days_overdue', 'greater_than', '2', 'and'),
    (a4, 0, 'event.ticket.category', 'equals', '"billing"', 'and'),
    -- task.moved exposes a FLAT to_phase_name, not nested to_phase.name.
    (a9, 0, 'event.to_phase_name', 'equals', '"Review"', 'and'),
    (a10, 0, 'event.task.linked_ticket_id', 'is_not_empty', 'null', 'and'),
    (a12, 0, 'event.mentioned_user.name', 'equals', '"oncall"', 'and');

  -- ── Actions ──
  INSERT INTO bolt_actions (automation_id, sort_order, mcp_tool, parameters, on_error) VALUES
    -- a1: Notify on Critical Task → post to #engineering
    (a1, 0, 'banter_post_message', '{"channel_id": "engineering", "content": "🚨 Critical task created: **{{ event.task.title }}** by {{ event.actor.name }}"}', 'stop'),
    -- a2: Overdue Task Alert → DM the assignee
    (a2, 0, 'banter_send_dm', '{"to_user_id": "{{ event.task.assignee_id }}", "content": "⏰ Your task **{{ event.task.title }}** is {{ event.task.days_overdue }} days overdue. Please update or reschedule."}', 'stop'),
    -- a3: Sprint Complete Report → post summary to #engineering
    (a3, 0, 'banter_post_message', '{"channel_id": "engineering", "content": "🏁 Sprint completed: **{{ event.sprint.name }}** — {{ event.tasks_completed }} tasks done, {{ event.tasks_carried_forward }} carried forward."}', 'stop'),
    -- a4: Helpdesk Auto-Progress → move ticket to in_progress + notify channel
    (a4, 0, 'update_ticket_status', '{"ticket_id": "{{ event.ticket.id }}", "status": "in_progress"}', 'stop'),
    (a4, 1, 'banter_post_message', '{"channel_id": "billing-alerts", "content": "💳 New billing ticket: {{ event.ticket.subject }}"}', 'continue'),
    -- a5: SLA Breach → move ticket to in_progress + post to #escalations.
    -- (There is no priority-update tool registered, so status is bumped instead.
    -- The ticket.sla_breach payload carries NO user reference — no actor, no
    -- assigned-agent — so we post to a channel rather than DM a recipient that
    -- cannot be resolved from the event.)
    (a5, 0, 'update_ticket_status', '{"ticket_id": "{{ event.ticket.id }}", "status": "in_progress"}', 'stop'),
    (a5, 1, 'banter_post_message', '{"channel_id": "escalations", "content": "🔴 SLA breach on ticket: {{ event.ticket.subject }} ({{ event.sla.type }}), deadline {{ event.sla.deadline }}"}', 'continue'),
    -- a6: Beacon Expiry → post reminder to #knowledge
    (a6, 0, 'banter_post_message', '{"channel_id": "knowledge", "content": "📚 Beacon expired: **{{ event.beacon.title }}** — please review and update or archive."}', 'stop'),
    -- a7: New Doc Notification → post to #project-updates
    (a7, 0, 'banter_post_message', '{"channel_id": "project-updates", "content": "📝 New document: **{{ event.document.title }}** by {{ event.actor.name }}"}', 'stop'),
    -- a8: Weekly Status Reminder → post to #engineering
    (a8, 0, 'banter_post_message', '{"channel_id": "engineering", "content": "📊 Weekly status check-in for {{ now }}: please update your task statuses and flag blockers before standup."}', 'stop'),
    -- a9: Task Moved to Review → DM the assignee
    (a9, 0, 'banter_send_dm', '{"to_user_id": "{{ event.task.assignee_id }}", "content": "👀 Your task **{{ event.task.title }}** moved to Review. Please take a look."}', 'stop'),
    -- a10: Close Ticket (NEEDS AGENT, disabled) → reply to ticket + notify channel.
    -- ticket_id can never resolve from this event; an agent must supply it.
    (a10, 0, 'reply_to_ticket', '{"ticket_id": "{{ event.task.linked_ticket_id }}", "body": "This issue has been resolved. The linked task **{{ event.task.title }}** is now complete."}', 'stop'),
    (a10, 1, 'banter_post_message', '{"channel_id": "support-triage", "content": "✅ Ticket auto-resolved: task **{{ event.task.title }}** completed."}', 'continue'),
    -- a11: Doc Promoted to Beacon → notify #knowledge
    (a11, 0, 'banter_post_message', '{"channel_id": "knowledge", "content": "🎓 Brief document promoted to Beacon: **{{ event.document.title }}**"}', 'stop'),
    -- a12: Critical Mention → DM the mentioned user
    (a12, 0, 'banter_send_dm', '{"to_user_id": "{{ event.mentioned_user.id }}", "content": "📢 @oncall was mentioned in #{{ event.channel.name }}: {{ event.message.content }}"}', 'stop');

  -- ── Schedules ──
  INSERT INTO bolt_schedules (automation_id, next_run_at, last_run_at) VALUES
    (a8, (date_trunc('week', NOW()) + INTERVAL '7 days' + INTERVAL '9 hours'), NOW() - INTERVAL '7 days');

  -- ── Executions (sample history) ──
  e1 := gen_random_uuid(); e2 := gen_random_uuid(); e3 := gen_random_uuid();
  e4 := gen_random_uuid(); e5 := gen_random_uuid();

  INSERT INTO bolt_executions (id, automation_id, status, trigger_event, started_at, completed_at, duration_ms, conditions_met, condition_log) VALUES
    (e1, a1, 'success', '{"task": {"id": "t1", "title": "Fix login timeout", "priority": "critical"}}', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours' + INTERVAL '320 milliseconds', 320, true, '[{"field": "event.task.priority", "operator": "equals", "value": "critical", "actual": "critical", "result": true}]'),
    (e2, a2, 'success', '{"task": {"id": "t2", "title": "Update API docs", "assignee_id": "u3", "days_overdue": 3}}', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours' + INTERVAL '450 milliseconds', 450, true, '[{"field": "event.task.days_overdue", "operator": "greater_than", "value": 2, "actual": 3, "result": true}]'),
    (e3, a4, 'success', '{"ticket": {"id": "tk1", "subject": "Billing dispute", "category": "billing"}}', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour' + INTERVAL '680 milliseconds', 680, true, '[{"field": "event.ticket.category", "operator": "equals", "value": "billing", "actual": "billing", "result": true}]'),
    -- e4: now a SUCCESS — the assignee is present and banter_send_dm gets a real
    -- to_user_id. (Previously a deliberately-broken sample with user_id: null.)
    (e4, a9, 'success', '{"task": {"id": "t4", "title": "Design new dashboard", "assignee_id": "u5"}, "to_phase_name": "Review"}', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours' + INTERVAL '410 milliseconds', 410, true, '[{"field": "event.to_phase_name", "operator": "equals", "value": "Review", "actual": "Review", "result": true}]'),
    (e5, a6, 'success', '{"beacon": {"id": "b1", "title": "Deployment Runbook", "last_verified_at": "2026-02-15"}}', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '280 milliseconds', 280, true, '[]');

  -- ── Execution Steps ──
  INSERT INTO bolt_execution_steps (execution_id, action_id, step_index, mcp_tool, parameters_resolved, status, response, duration_ms) VALUES
    (e1, (SELECT id FROM bolt_actions WHERE automation_id = a1 AND sort_order = 0), 0, 'banter_post_message', '{"channel_id": "engineering", "content": "🚨 Critical task created: **Fix login timeout** by Eddie Offermann"}', 'success', '{"ok": true, "message_id": "m1"}', 320),
    (e2, (SELECT id FROM bolt_actions WHERE automation_id = a2 AND sort_order = 0), 0, 'banter_send_dm', '{"to_user_id": "u3", "content": "⏰ Your task **Update API docs** is 3 days overdue."}', 'success', '{"ok": true}', 450),
    (e3, (SELECT id FROM bolt_actions WHERE automation_id = a4 AND sort_order = 0), 0, 'update_ticket_status', '{"ticket_id": "tk1", "status": "in_progress"}', 'success', '{"ok": true, "status": "in_progress"}', 340),
    (e3, (SELECT id FROM bolt_actions WHERE automation_id = a4 AND sort_order = 1), 1, 'banter_post_message', '{"channel_id": "billing-alerts", "content": "💳 New billing ticket: Billing dispute"}', 'success', '{"ok": true}', 340),
    (e4, (SELECT id FROM bolt_actions WHERE automation_id = a9 AND sort_order = 0), 0, 'banter_send_dm', '{"to_user_id": "u5", "content": "👀 Your task **Design new dashboard** moved to Review."}', 'success', '{"ok": true}', 410),
    (e5, (SELECT id FROM bolt_actions WHERE automation_id = a6 AND sort_order = 0), 0, 'banter_post_message', '{"channel_id": "knowledge", "content": "📚 Beacon expired: **Deployment Runbook** — please review."}', 'success', '{"ok": true}', 280);

  RAISE NOTICE 'Seeded 12 automations, 5 conditions, 16 actions, 1 schedule, 5 executions, 6 execution steps';
END $$;
