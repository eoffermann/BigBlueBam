import {
  Zap,
  ArrowRight,
  Workflow,
  Radio,
  Bot,
  ClipboardList,
  LayoutTemplate,
  Activity,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Workflow,
    title: 'Visual Rule Builder',
    description:
      'WHEN something happens, IF conditions hold, THEN run an ordered list of actions. Build it in a stacked Simple editor or a node-graph canvas — and flip between the two on the same rule.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Radio,
    title: 'Cross-App Triggers',
    description:
      'Over 130 events from every app in the suite, plus a cron Schedule source. A deal closing in Bond, a ticket breaching SLA, a sprint completing in Bam — Bolt is listening to all of it.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: LayoutTemplate,
    title: 'Templates',
    description:
      '16 pre-built blueprints for the workflows everyone ends up wanting — overdue-task nudges, SLA escalations, sprint recaps. Pick one, tweak it, ship it.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: ClipboardList,
    title: 'Execution Log & Retries',
    description:
      'Every run is recorded with its trigger event, condition trail, and step-by-step timeline. Something fail? Retry it with one click instead of re-creating the world.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Activity,
    title: 'Observability',
    description:
      'Trace any single event to see exactly which rules matched, skipped, or fired — and why. The kind of receipts you want when a rule does something surprising at 3am.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Bot,
    title: 'AI Automation',
    description:
      '24 MCP tools let an AI agent author, test, operate, and observe automations — bolt_create to build a rule, bolt_test to dry-run it, bolt_event_trace to explain a match — with the same policy guardrails and approvals as everything else.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BoltSection() {
  return (
    <SectionWrapper id="bolt" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Automation without the duct tape
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Automating across tools usually means duct-taping five apps together with a brittle
            third-party connector that breaks the moment an API changes — and bills you per task run.
            Bolt is a visual trigger-condition-action engine that already lives inside the suite:
            events from Bam, Bond, Banter, and the rest are right there, no connectors to buy. WHEN an
            event fires, IF your conditions hold, THEN run an ordered chain of actions across any app —
            with execution logs you can actually read, and 24 MCP tools so agents can build and inspect
            rules too.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bolt/light/01-automations.png"
          alt="Bolt automations dashboard listing active rules with trigger badges"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The automation dashboard — each rule shows its trigger event, an enable toggle, and when it
          last ran.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bolt/light/02-editor.png"
            alt="Bolt Simple editor showing WHEN trigger, IF conditions, THEN actions"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Pick a trigger, gate it with conditions, then stack the actions to run. WHEN / IF / THEN,
            top to bottom.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/bolt/light/03-automation-detail.png"
            alt="Bolt visual node-graph canvas wiring a trigger to a condition to an action"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Prefer wires to stacks? Same rule, drawn as a node graph — trigger to condition to action.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/bolt/light/05-templates.png"
            alt="Bolt templates gallery of pre-built automation blueprints"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Sixteen pre-built blueprints, because you are not the first person to want an overdue-task
            nudge.
          </p>
        </AnimatedReveal>
      </div>

      {/* Feature highlights */}
      <AnimatedReveal delay={0.2}>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <div
                className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${feature.color}`}
              >
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">{feature.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.3}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Zap className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bolt/</code> — a
              dedicated SPA sharing authentication and the project model with Bam, Beacon, and Brief.
            </p>
          </div>
          <Button href="/bolt/" variant="primary" size="sm">
            Try Bolt <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
