import {
  Flame,
  ArrowRight,
  ScrollText,
  GaugeCircle,
  ShieldAlert,
  GitBranch,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: ScrollText,
    title: 'Reads the SOW, cites the clause',
    description:
      'Burn ingests your signed statement of work and turns it into a clause-cited ledger of exactly what was sold - each deliverable with its priced envelope. Every line links back to the contract language it came from, so scope is a document you can query, not a memory someone has to defend.',
    color: 'bg-orange-100 text-orange-700',
  },
  {
    icon: GaugeCircle,
    title: 'Classifies every unit of work in dollars',
    description:
      'Time entries, tasks, and expenses are classified against the ledger in dollars, not vibes. Each priced envelope shows what has been consumed against what was sold, and the work nobody sold lands in its own unscoped bucket instead of quietly eating your margin.',
    color: 'bg-amber-100 text-amber-700',
  },
  {
    icon: ShieldAlert,
    title: 'Catches the out-of-scope charge before it posts',
    description:
      'The flagship: a fail-open pre-transaction gate vets a billable expense against contract scope before it posts to a client invoice. Out-of-scope charges are blocked with a 409 and concrete remediation actions - but the gate NEVER blocks because something broke. If Burn is unsure or unavailable, the charge goes through.',
    color: 'bg-orange-100 text-orange-600',
  },
  {
    icon: GitBranch,
    title: 'Change orders, human-approved',
    description:
      'When work exceeds what was sold, Burn drafts a change order and routes it to a human approval queue instead of silently absorbing the overage or silently billing it. A person decides whether to expand scope, eat the cost, or push back - with the numbers already in front of them.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Flame,
    title: 'Real margin from effective-dated cost rates',
    description:
      'Burn tracks cost rates with effective dates, so a raise in March does not rewrite what a project cost in January. Margin is computed against the rate that was actually in force when the work happened, giving you a live burn-versus-budget picture that holds up to scrutiny.',
    color: 'bg-red-100 text-red-600',
  },
  {
    icon: Bot,
    title: 'Built for agents (17 MCP tools)',
    description:
      '17 burn_* MCP tools let an AI agent read the deliverable ledger, classify work in dollars, run the scope gate on a proposed charge, and open a change order with the same identity and audit trail as a human - while every approval stays behind the human queue and a confirm token.',
    color: 'bg-orange-100 text-orange-700',
  },
];

export function BurnSection() {
  return (
    <SectionWrapper id="burn" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="orange" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Stop billing work you never sold
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-zinc-600">
            A signed contract is a promise with a price on it, and the money leaks in the gap
            between what you sold and what you actually did - the task that ran long, the expense
            that was never in scope, the change nobody wrote up. Burn is the AI margin-and-scope
            monitor: it reads your signed SOW into a clause-cited ledger of what was sold with
            priced envelopes, classifies every unit of work against it in dollars, surfaces the
            work nobody sold, and - the flagship - vets a billable expense against contract scope
            BEFORE it posts to a client invoice. It blocks the out-of-scope charge while never
            blocking because something broke. Sized for an owner, PM, or finance lead at a services
            firm of two to fifty seats.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: the portfolio burn board. */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/burn/light/portfolio-board.png"
          alt="The Burn portfolio board showing each engagement's priced envelopes, dollars consumed, and margin against budget"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The portfolio board: every engagement's priced envelopes, dollars consumed against what
          was sold, and live margin - with the unscoped work called out instead of hidden.
        </p>
      </AnimatedReveal>

      <AnimatedReveal delay={0.13} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/burn/light/gate-console.png"
            alt="The Burn scope-gate console showing a billable charge vetted against contract scope, with a 409 block and remediation actions"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The scope gate: a billable charge vetted against the contract before it posts to an
            invoice - blocked with a 409 and remediation actions when it is out of scope, and let
            through whenever Burn is unsure, so it fails open.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.15} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/burn/light/unscoped-queue.png"
            alt="The Burn unscoped-work queue listing work classified outside any sold envelope, ready to route into a change order"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The unscoped queue: work that classified outside every sold envelope, gathered in one
            place and ready to route into a human-approved change order.
          </p>
        </div>
      </AnimatedReveal>

      {/* Dark-mode portfolio board: a distinct dark view; the whole suite is theme-aware. */}
      <AnimatedReveal delay={0.18} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/burn/dark/portfolio-board.png"
            alt="The Burn portfolio board in dark mode, with margin and burn-versus-budget bars on each engagement"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The portfolio board in dark mode, on the same shared shell as every other app in the suite.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.2}>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${feature.color}`}>
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
            <Flame className="h-6 w-6 text-orange-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/burn/</code>,
              the margin watchtower over Bam, Bill, and Bond: Burn reads the contract so the charge
              you never sold stops reaching the invoice.
            </p>
          </div>
          <Button href="/burn/" variant="primary" size="sm">
            Try Burn <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
