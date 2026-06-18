import { FileSpreadsheet, Trello, Github, Bug, CalendarDays, Bot, Key } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

const importSources = [
  { icon: FileSpreadsheet, label: 'CSV' },
  { icon: Trello, label: 'Trello' },
  { icon: Bug, label: 'Jira' },
  { icon: Github, label: 'GitHub Issues' },
];

const extras = [
  { icon: CalendarDays, label: 'iCal Feed', description: 'Tasks with due dates exported as .ics calendar events.' },
  { icon: Key, label: 'API Keys', description: 'Scoped read/write/admin keys for AI agents and automations, with optional project restriction.' },
];

export function Integrations() {
  return (
    <SectionWrapper id="integrations" alternate dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Bring your data. Plug in your agents.
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Import existing projects in seconds. Give your AI agents scoped API keys and let them
            start contributing immediately, with the same permissions model and the same audit trail as human users.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Import sources */}
        <AnimatedReveal delay={0.1}>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-base font-semibold text-zinc-900">Import from</h3>
            <div className="grid grid-cols-2 gap-4">
              {importSources.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center gap-3 rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-3"
                >
                  <s.icon className="h-5 w-5 text-zinc-500" />
                  <span className="text-sm font-medium text-zinc-700">{s.label}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-zinc-500">
              Automatic phase and label creation for unmatched values during import.
            </p>
          </div>
        </AnimatedReveal>

        {/* MCP callout */}
        <AnimatedReveal delay={0.15}>
          <div className="rounded-xl border border-primary-200 bg-gradient-to-br from-primary-50 to-white p-6 shadow-sm">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600 text-white">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-zinc-900">MCP Server</h3>
                <Badge variant="blue">720+ tools</Badge>
              </div>
            </div>
            <p className="mb-4 text-sm text-zinc-600">
              A full Model Context Protocol server exposes every action across all sixteen apps
              (Bam, Banter, Beacon, Bearing, Bench, Bill, Blank, Blast, Blueprint, Board, Bolt,
              Bond, Book, Brief, Bureau, Helpdesk) plus cross-cutting platform capabilities (cross-app search,
              composite views, entity linking, scheduled posts, upserts, agent policies, outbound
              webhooks) to AI agents. Manage projects, search knowledge, automate workflows, track
              goals, collaborate visually, manage CRM pipelines, invoice clients, send campaigns,
              message your team, and triage tickets, all through structured tool calls.
            </p>
            <div className="rounded-lg border border-primary-200 bg-primary-100/50 p-3">
              <p className="text-xs font-medium text-primary-800">
                Supports Streamable HTTP, SSE, and stdio transports. Ships as a sidecar container with
                two-step confirmation for destructive actions.
              </p>
            </div>
          </div>
        </AnimatedReveal>

        {/* Extras */}
        {extras.map((e, i) => (
          <AnimatedReveal key={e.label} delay={0.2 + i * 0.075}>
            <div className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
                <e.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-zinc-900">{e.label}</h3>
                <p className="mt-1 text-sm text-zinc-600">{e.description}</p>
              </div>
            </div>
          </AnimatedReveal>
        ))}
      </div>
    </SectionWrapper>
  );
}
