import { motion } from 'motion/react';
import {
  Users,
  Bot,
  ArrowLeftRight,
  Headset,
  Code,
  ClipboardCheck,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

const roles = [
  {
    icon: ClipboardCheck,
    human: 'Product Manager',
    ai: 'AI Project Coordinator',
    description: 'Triages incoming work, updates sprint scope, assigns tasks based on team capacity and priority.',
  },
  {
    icon: Code,
    human: 'Engineer',
    ai: 'AI Engineer',
    description: 'Picks up tickets, writes code, logs time, updates task status, and moves cards across the board.',
  },
  {
    icon: Headset,
    human: 'Support Rep',
    ai: 'AI Customer Agent',
    description: 'Responds to helpdesk tickets, escalates complex issues to humans, and closes resolved requests.',
  },
  {
    icon: MessageSquare,
    human: 'Team Lead',
    ai: 'AI Scrum Master',
    description: 'Runs carry-forward ceremonies, flags blocked tasks, generates sprint reports, and nudges overdue items.',
  },
];

const capabilities = [
  'Project & sprint planning',
  'Task management & bulk operations',
  'Reports & analytics (velocity, burndown, cycle time)',
  'Team collaboration & notifications',
  'Banter messaging (channels, DMs, threads, calls, scheduled posts)',
  'Brief document collaboration & graduation',
  'Bolt workflow automations & runtime observability',
  'Bearing goals & OKR tracking',
  'Board visual collaboration & canvas analysis',
  'Bond CRM pipeline, contact management & dedupe',
  'Helpdesk ticket operations & similar-ticket lookup',
  'Beacon knowledge base & graph search',
  'Blast email campaigns, segments & analytics',
  'Bill invoicing, expenses & revenue reporting',
  'Blank forms, submissions & conditional routing',
  'Book scheduling & mixed-roster availability',
  'Bench analytics dashboards & scheduled reports',
  'Cross-app search, composite views, entity linking',
  'Agent identity, proposals, policies & audit',
  'Platform administration',
];

export function AiCollaboration() {
  return (
    <SectionWrapper id="ai-collaboration" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-6 max-w-3xl text-center">
          <Badge variant="purple" className="mb-4">
            Core Philosophy
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            AI agents aren't add-ons.{' '}
            <span className="text-primary-600">They're teammates.</span>
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Most "AI" in a productivity tool is a chat box in the corner that summarizes the doc you
            just wrote — and 73% of vendors now charge extra for it. We took the other approach.
            BigBlueBam was architected from day one so agents operate at full parity with people:
            every action a person can take — creating tasks, managing sprints, responding to tickets
            — an agent does through the same system, with the same permissions and the same audit
            trail. No sidebar. No upcharge. It's the architecture.
          </p>
        </div>
      </AnimatedReveal>

      {/* Human ↔ AI role parity */}
      <AnimatedReveal delay={0.1}>
        <div className="mt-14 mb-14">
          <h3 className="mb-8 text-center text-sm font-semibold tracking-wider text-zinc-400 uppercase">
            Side by side, role by role
          </h3>
          <div className="grid gap-5 sm:grid-cols-2">
            {roles.map((role, i) => (
              <motion.div
                key={role.human}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
                className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
                    <role.icon className="h-5 w-5" />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      <Users className="h-3 w-3" />
                      {role.human}
                    </div>
                    <ArrowLeftRight className="h-3.5 w-3.5 text-zinc-300" />
                    <div className="flex items-center gap-1.5 rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-700">
                      <Bot className="h-3 w-3" />
                      {role.ai}
                    </div>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-zinc-600">{role.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </AnimatedReveal>

      {/* How it works */}
      <AnimatedReveal delay={0.2}>
        <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 via-white to-primary-50/30 p-8 md:p-10">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h3 className="text-xl font-bold text-zinc-900">Full parity through MCP</h3>
              <p className="mt-3 text-zinc-600">
                The built-in Model Context Protocol server exposes 720+ structured tools that mirror
                every UI action across all sixteen apps plus cross-cutting platform capabilities
                (agent identity, approval queues, visibility preflight, unified activity, cross-app
                search, composite views, entity linking, scheduled posts, upserts, attachment
                metadata, agent policies, outbound webhooks). AI agents authenticate with scoped
                API keys, operate under the same role-based permissions as humans, and leave the
                same audit trail in the activity log — no special back door, same rules as everyone.
              </p>
              <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <p className="text-sm text-amber-800">
                  <strong>Guardrails built in.</strong> Destructive actions (deleting tasks, completing
                  sprints, removing members) require a two-step confirmation flow with time-limited
                  tokens — for AI agents and humans alike.
                </p>
              </div>
            </div>
            <div>
              <h3 className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wider">
                720+ MCP tools across 16 apps + platform
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {capabilities.map((cap) => (
                  <div key={cap} className="flex items-center gap-2 text-sm text-zinc-700">
                    <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                    {cap}
                  </div>
                ))}
              </div>
              <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-900 p-4">
                <p className="mb-2 text-xs font-medium text-zinc-400">Example: AI agent moves a task</p>
                <pre className="overflow-x-auto text-xs leading-relaxed">
                  <code className="text-primary-300">
{`{
  "tool": "move_task",
  "task_id": "PROJ-142",
  "to_phase": "In Review",
  "comment": "PR merged, moving to review"
}`}
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </AnimatedReveal>

      {/* Escalation flow */}
      <AnimatedReveal delay={0.3}>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {[
            {
              step: '1',
              title: 'Agent picks up work',
              description: 'AI agents monitor the board, pick up assigned tasks, and begin executing — logging progress as they go.',
              color: 'bg-primary-600',
            },
            {
              step: '2',
              title: 'Escalates when needed',
              description: 'When an agent hits ambiguity, needs approval, or encounters something outside its scope, it escalates to a human.',
              color: 'bg-amber-500',
            },
            {
              step: '3',
              title: 'Human resolves, agent continues',
              description: 'The human teammate weighs in, and the agent picks right back up where it left off — full context preserved, nothing dropped on the floor.',
              color: 'bg-emerald-500',
            },
          ].map((item) => (
            <div key={item.step} className="relative rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className={`absolute -top-3 left-6 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${item.color}`}>
                {item.step}
              </div>
              <h3 className="mt-1 text-base font-semibold text-zinc-900">{item.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{item.description}</p>
            </div>
          ))}
        </div>
      </AnimatedReveal>

      {/* AI Provider Configuration callout */}
      <AnimatedReveal delay={0.4}>
        <div className="mt-10 rounded-xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-900">Bring Your Own LLM</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Configure AI providers at the system, organization, or project level. Supports
                <strong> Anthropic</strong>, <strong>OpenAI</strong>, and any{' '}
                <strong>OpenAI API-compatible endpoint</strong> — including Azure OpenAI, Together AI,
                Ollama, and local LLMs. API keys are encrypted at rest and never exposed in full.
              </p>
            </div>
          </div>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
