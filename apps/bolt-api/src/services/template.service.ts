// ---------------------------------------------------------------------------
// Pre-built automation templates
// ---------------------------------------------------------------------------

import { banterApprovalDmTemplate } from '../templates/banter-approval-dm.js';

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_source: string;
  trigger_event: string;
  conditions: {
    sort_order: number;
    field: string;
    operator: string;
    value: unknown;
    logic_group: string;
  }[];
  actions: {
    sort_order: number;
    mcp_tool: string;
    parameters: Record<string, unknown>;
    on_error: string;
  }[];
}

// ---------------------------------------------------------------------------
// TEMPLATE AUTHORING RULES (read before editing — see audit doc
// docs/functionality-audits/bolt-templates-audit-2026-06-13.md):
//
//   1. CONDITION FIELDS are evaluated against the *wrapped* payload
//      `{ event: <ingested payload>, actor: { id, type } }` (see
//      event-ingestion.routes.ts). Every condition `field` that reads the
//      event body MUST start with `event.` — e.g. `event.task.priority`,
//      NOT `task.priority`. A bare `task.priority` resolves to undefined and
//      the condition silently never matches.
//
//   2. ACTION PARAM KEYS must match the LIVE MCP tool signature (the worker
//      forwards params verbatim to POST /tools/call — see
//      apps/worker/src/jobs/bolt-execute.job.ts, which does NOT remap keys).
//      Verified live signatures used below:
//        banter_send_dm      -> { to_user_id, content }
//        banter_post_message -> { channel_id, content }  (channel_id accepts
//                               a bare channel name / #name, not only a UUID)
//        update_ticket_status-> { ticket_id, status }    (status enum: open |
//                               in_progress | waiting_on_client | resolved |
//                               closed)
//        create_task         -> { project_id, phase_id (BOTH required), title,
//                               description?, priority? }
//        brief_promote_to_beacon -> { id }
//      NOTE: mcp-tool-schemas.generated.ts is STALE for banter_send_dm (it
//      lists `user_id`); trust the live tool — it is `to_user_id`.
//
//   3. Action templating only exposes `{{ event.* }}`, `{{ actor.id|type }}`,
//      `{{ automation.* }}`, `{{ now }}`, `{{ step[N].result.* }}`. There is
//      NO `{{ actor.name }}` (actor context is only { id, type }); use
//      `{{ event.actor.name }}` for a display name. There is no top-level
//      `{{ org.* }}` either — use `{{ event.org.* }}`.
//
//   4. Priority slugs are per-org configurable (migration 0183). The default
//      seed set is critical | high | medium | low | none. The bam task-event
//      catalog still annotates the enum as low|medium|high|urgent, which is
//      stale — `urgent` is not a default slug and `critical` is. Conditions
//      below match on `high`/`critical`.
// ---------------------------------------------------------------------------

const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'tpl_notify_task_overdue',
    name: 'Notify on overdue task',
    description: 'Send a Banter DM to the assignee when a task becomes overdue.',
    category: 'notifications',
    trigger_source: 'bam',
    trigger_event: 'task.overdue',
    conditions: [
      {
        sort_order: 0,
        field: 'event.task.assignee_id',
        operator: 'is_not_empty',
        value: null,
        logic_group: 'and',
      },
    ],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_send_dm',
        parameters: {
          to_user_id: '{{ event.task.assignee_id }}',
          content:
            'Your task "{{ event.task.title }}" is now overdue. Due date was {{ event.task.due_date }}.',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_auto_assign_ticket',
    name: 'Auto-progress high-priority tickets',
    description: 'Automatically move high-priority helpdesk tickets to in-progress when they come in.',
    category: 'helpdesk',
    trigger_source: 'helpdesk',
    trigger_event: 'ticket.created',
    conditions: [
      {
        sort_order: 0,
        field: 'event.ticket.priority',
        operator: 'equals',
        value: 'high',
        logic_group: 'and',
      },
    ],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'update_ticket_status',
        parameters: {
          ticket_id: '{{ event.ticket.id }}',
          status: 'in_progress',
        },
        on_error: 'stop',
      },
    ],
  },
  {
    id: 'tpl_sprint_complete_summary',
    name: 'Sprint completion summary',
    description:
      'Post a summary to a Banter channel when a sprint is completed. Set the target channel by editing the "general" channel name in the action after instantiating.',
    category: 'notifications',
    trigger_source: 'bam',
    trigger_event: 'sprint.completed',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'general',
          content:
            'Sprint "{{ event.sprint.name }}" completed! {{ event.tasks_completed }} tasks done, {{ event.tasks_carried_forward }} carried forward.',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_beacon_expiry_alert',
    name: 'Alert on beacon expiry',
    description: 'Post a Banter message when a beacon entry expires so it can be reviewed.',
    category: 'knowledge',
    trigger_source: 'beacon',
    trigger_event: 'beacon.expired',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'knowledge-ops',
          content:
            'Beacon entry "{{ event.beacon.title }}" has expired. Please review and update or archive.',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_task_comment_to_banter',
    name: 'Mirror task comments to Banter',
    description: 'Post task comments to a project Banter channel for visibility.',
    category: 'sync',
    trigger_source: 'bam',
    trigger_event: 'comment.created',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'project-updates',
          content:
            'New comment on {{ event.task.human_id }} "{{ event.task.title }}" by {{ event.actor.name }}: {{ event.comment.body }}',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    // NEEDS-AGENT (partial): pure-Bolt promotion is wired here via
    // brief_promote_to_beacon, which only needs the document id that the
    // document.published payload carries. This DOES function end-to-end for
    // documents that are eligible for promotion. The original wiring was
    // broken because it called beacon_create with a non-existent
    // `source_document_id` param and omitted the required `body_markdown`.
    // The remaining caveat (an agent could add value): brief_promote_to_beacon
    // applies Brief's own default visibility/tags; if you want curated
    // visibility, summary, or tag mapping, an agent step should call
    // beacon_update after promotion. See the audit doc.
    id: 'tpl_brief_approved_to_beacon',
    name: 'Auto-promote published docs to Beacon',
    description:
      'When a Brief document is published, promote it into a Beacon knowledge article via brief_promote_to_beacon (which pulls the document body itself). For curated visibility/tags, follow up with an agent or a beacon_update step.',
    category: 'knowledge',
    trigger_source: 'brief',
    trigger_event: 'document.published',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'brief_promote_to_beacon',
        parameters: {
          id: '{{ event.document.id }}',
        },
        on_error: 'stop',
      },
    ],
  },
  {
    id: 'tpl_sla_breach_escalate',
    name: 'Escalate SLA breaches',
    description:
      'Post to an escalations channel and open a follow-up task when a ticket breaches SLA. IMPORTANT: create_task requires a project_id AND a phase_id — set them on the second action after instantiating (the ticket.sla_breach payload carries no project context, so they cannot be templated from the event).',
    category: 'helpdesk',
    trigger_source: 'helpdesk',
    trigger_event: 'ticket.sla_breach',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'escalations',
          content:
            'SLA breach on ticket "{{ event.ticket.subject }}" ({{ event.sla.type }}). Deadline: {{ event.sla.deadline }}',
        },
        on_error: 'continue',
      },
      {
        sort_order: 1,
        mcp_tool: 'create_task',
        parameters: {
          // REQUIRED: replace these two placeholders with a real project name/UUID
          // and a phase name/UUID before enabling. create_task rejects the call
          // without both. They cannot come from the event — ticket.sla_breach has
          // no project context.
          project_id: 'REPLACE_WITH_PROJECT',
          phase_id: 'REPLACE_WITH_PHASE',
          title: 'SLA breach: {{ event.ticket.subject }}',
          description: 'Follow up on SLA breach for ticket {{ event.ticket.id }} ({{ event.sla.type }}, deadline {{ event.sla.deadline }}).',
          priority: 'high',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    // NEEDS-AGENT: there is no member-join trigger event in the catalog (the
    // closest is banter channel.created, which fires on channel creation, not
    // on a person joining an org/project), and per-person onboarding task
    // generation needs an agent to decide which tasks/owners apply. This
    // template is shipped DISABLED-by-intent: it fires only on the narrow
    // "a new DM channel was created" case and just posts a welcome line. Do
    // not rely on it for real onboarding. See the audit doc for what an agent
    // would need to do.
    id: 'tpl_new_member_onboard',
    name: 'New member onboarding (requires agent — placeholder)',
    description:
      'PLACEHOLDER / NOT FUNCTIONAL for real onboarding: no member-join event exists in the Bolt catalog, and generating per-person onboarding tasks needs an agent step. As wired it only posts a welcome message into a newly-created DM channel. Use an agent runner subscribed to the relevant signal to do real onboarding.',
    category: 'onboarding',
    trigger_source: 'banter',
    trigger_event: 'channel.created',
    conditions: [
      {
        sort_order: 0,
        field: 'event.channel.type',
        operator: 'equals',
        value: 'dm',
        logic_group: 'and',
      },
    ],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: '{{ event.channel.id }}',
          content: 'Welcome! Here are some resources to get started...',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_high_priority_task_alert',
    name: 'Alert on high-priority task creation',
    description: 'Post to a channel when a high- or critical-priority task is created.',
    category: 'notifications',
    trigger_source: 'bam',
    trigger_event: 'task.created',
    conditions: [
      {
        // A single `in` condition replaces the previous two unprefixed `or`
        // rows. `critical`/`high` are the real default high-end priority
        // slugs (migration 0183 seed set); `urgent` from the stale event
        // catalog annotation is not a default slug.
        sort_order: 0,
        field: 'event.task.priority',
        operator: 'in',
        value: ['high', 'critical'],
        logic_group: 'and',
      },
    ],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'alerts',
          content:
            'New {{ event.task.priority }} priority task {{ event.task.human_id }}: "{{ event.task.title }}"',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_daily_standup_reminder',
    name: 'Daily standup reminder',
    description:
      'Send a daily standup reminder to a Banter channel on a cron schedule. Supply a cron_expression when instantiating (e.g. "0 9 * * 1-5" for 9am weekdays).',
    category: 'schedule',
    trigger_source: 'schedule',
    trigger_event: 'cron.fired',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'standup',
          content:
            'Good morning! Time for standup. What did you work on yesterday? What are you working on today? Any blockers?',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_new_document_notification',
    name: 'New document notification',
    description: 'Post to a project Banter channel when a new Brief document is created.',
    category: 'notifications',
    trigger_source: 'brief',
    trigger_event: 'document.created',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'project-updates',
          content: 'New document created: "{{ event.document.title }}" by {{ event.actor.name }}',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_weekly_status_update',
    name: 'Weekly status reminder',
    description:
      'Post a weekly status-update REMINDER to a channel on a cron schedule (e.g. Monday morning). This nudges the team to update their own task statuses — it does NOT auto-generate a report (that would need an agent or a bench_generate_report step). Supply a cron_expression when instantiating (e.g. "0 9 * * 1").',
    category: 'schedule',
    trigger_source: 'schedule',
    trigger_event: 'cron.fired',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_post_message',
        parameters: {
          channel_id: 'general',
          content:
            'Weekly status check-in: please update your task statuses and flag any blockers before standup.',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    id: 'tpl_task_moved_to_review',
    name: 'Task moved to review',
    description:
      'DM the task assignee via Banter when their task is moved into the Review phase. (There is no separate "reviewer" field on a task, so the assignee is notified.)',
    category: 'notifications',
    trigger_source: 'bam',
    trigger_event: 'task.moved',
    conditions: [
      {
        // The task.moved payload exposes the destination phase as a FLAT
        // `to_phase_name`, not a nested `to_phase.name`.
        sort_order: 0,
        field: 'event.to_phase_name',
        operator: 'equals',
        value: 'Review',
        logic_group: 'and',
      },
    ],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_send_dm',
        parameters: {
          to_user_id: '{{ event.task.assignee_id }}',
          content:
            'Your task "{{ event.task.title }}" has been moved to Review. Please take a look.',
        },
        on_error: 'continue',
      },
    ],
  },
  {
    // NEEDS-AGENT: task.completed carries no linked_ticket_id, and there is no
    // task->ticket resolver reachable from a Bolt action, so this cannot be
    // wired in pure Bolt. The template is shipped DISABLED-by-intent with a
    // condition that will never match (event.task.linked_ticket_id is always
    // undefined), so it is inert until an agent supplies the mapping. See the
    // audit doc for what an agent would need to do.
    id: 'tpl_close_ticket_on_task_complete',
    name: 'Close ticket on task complete (requires agent)',
    description:
      'NOT FUNCTIONAL in pure Bolt: the task.completed event carries no linked-ticket id and Bolt has no task->ticket resolver. An agent must map the completed task back to its helpdesk ticket and call update_ticket_status. Left here as a documented starting point; the guard condition keeps it inert.',
    category: 'sync',
    trigger_source: 'bam',
    trigger_event: 'task.completed',
    conditions: [
      {
        sort_order: 0,
        field: 'event.task.linked_ticket_id',
        operator: 'is_not_empty',
        value: null,
        logic_group: 'and',
      },
    ],
    actions: [
      {
        // update_ticket_status is a real tool, but ticket_id can never resolve
        // from this event. The guard condition above prevents this from ever
        // running with an empty ticket_id.
        sort_order: 0,
        mcp_tool: 'update_ticket_status',
        parameters: {
          ticket_id: '{{ event.task.linked_ticket_id }}',
          status: 'resolved',
        },
        on_error: 'continue',
      },
    ],
  },
  // Wave 3.2: Banter approval DM template. Defined in templates/
  // banter-approval-dm.ts so future approval-workflow templates can
  // live alongside it without bloating this file.
  banterApprovalDmTemplate,
  // Bill P2: Bond deal-close auto-invoice template.
  // NEEDS-AGENT: switched to the real `deal.won` trigger event (the old
  // `deal.status_changed` event does not exist in the catalog). The invoice
  // step itself cannot run in pure Bolt: both bill_create_invoice and
  // bill_create_invoice_from_deal require a Bill `client_id`, and the deal.won
  // payload has no Bill client reference (only a Bond company/contact). An
  // agent must resolve-or-create the matching Bill client first, then create
  // the invoice. The DM step IS functional and stays wired so the deal owner
  // is still notified to act. See the audit doc.
  {
    id: 'tpl_bond_deal_close_invoice',
    name: 'Create invoice on deal close (requires agent for the invoice step)',
    description:
      'When a Bond deal is won, notify the deal owner to raise an invoice. The actual invoice creation cannot run in pure Bolt — bill_create_invoice / bill_create_invoice_from_deal both need a Bill client_id that the deal.won payload does not carry. An agent must resolve/create the Bill client and then create the invoice. The owner DM below works as-is.',
    category: 'billing',
    trigger_source: 'bond',
    trigger_event: 'deal.won',
    conditions: [],
    actions: [
      {
        sort_order: 0,
        mcp_tool: 'banter_send_dm',
        parameters: {
          to_user_id: '{{ event.deal.owner_id }}',
          content:
            'Deal "{{ event.deal.title }}" was just won ({{ event.deal.amount }} {{ event.deal.currency }}, {{ event.deal.company_name }}). Time to raise an invoice in Bill — pick the matching billing client, then bill_create_invoice_from_deal with deal_id {{ event.deal.id }}.',
        },
        on_error: 'continue',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listTemplates(): AutomationTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): AutomationTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function instantiateTemplate(
  template: AutomationTemplate,
  overrides: {
    name?: string;
    description?: string | null;
    project_id?: string | null;
    cron_expression?: string | null;
    cron_timezone?: string;
  },
) {
  return {
    name: overrides.name ?? template.name,
    description: overrides.description ?? template.description,
    project_id: overrides.project_id ?? null,
    trigger_source: template.trigger_source,
    trigger_event: template.trigger_event,
    cron_expression: overrides.cron_expression ?? null,
    cron_timezone: overrides.cron_timezone ?? 'UTC',
    conditions: template.conditions,
    actions: template.actions,
  };
}
