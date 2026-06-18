# Bolt - Workflow Automation

Bolt is BigBlueBam's event-driven automation engine and the suite's event hub. You build rules of the form WHEN an event happens, IF conditions hold, THEN run an ordered list of actions. Every other app in the suite reports its activity to Bolt, so a single place watches the whole suite and reacts to it without anyone writing code.

## Key Features

- **Trigger, condition, action builder** with a Simple stacked editor (WHEN / IF / THEN) and a Visual node-graph canvas, switchable per rule. The graph is compiled to a linear ordered action list on save.
- **Event catalog** of over 130 trigger events across Bam (task and sprint changes), Bond (deal stage moves), Helpdesk (tickets and SLA breaches), Blast, Beacon, Brief, Board, Bearing, Bill, Book, Blank, Bench, Banter, and a Schedule (cron) source.
- **Conditions and filters** with 13 operators and AND/OR grouping that gate whether a rule runs, plus variable interpolation between steps (`{{ event.* }}`, `{{ step[N].result.* }}`).
- **Execution Log** with per-automation and organization-wide views, per-step traces (trigger event, condition evaluation, step timeline), retry of failed runs, and single-event tracing.
- **Templates** with 16 pre-built automation blueprints for common workflows, instantiated and customized in the editor.
- **Guards** including per-rule hourly rate limits, cooldowns, and an internal chain-depth limit that prevents rules from triggering each other in a loop.

## Integrations

Bolt is the integration hub of BigBlueBam. Every app publishes its events to Bolt through a shared helper using bare-name-plus-explicit-source naming (the event is `deal.rotting` with source `bond`, not `bond.deal.rotting`). Bolt listens to those events and performs actions back across the suite: creating Bam tasks, posting Banter messages, updating records, sending emails and webhooks, and more. Each action is an MCP tool call executed by the background worker, so automations reach into any app without hand-wired integrations.

Bolt is also built for AI agents. It exposes 26 MCP tools that let an agent author, operate, test, and observe automations, and it rides the suite's shared agentic platform: agent identity and heartbeat, approval proposals, a unified cross-app activity view, visibility checks (`can_access`), per-agent policy kill switches and allowlists, and HMAC-signed outbound webhooks that fan subscribed events to agent runners.

## Getting Started

Open Bolt from the app switcher at `/bolt/`. Browse Templates for a head start or click New Automation to build from scratch. Pick a trigger source and event, add conditions to filter which events should proceed, then add the actions to run. Save the rule as a draft or save and enable it, then watch it run in the Execution Log and open any run to see its trigger event, condition evaluation, and step-by-step results.
