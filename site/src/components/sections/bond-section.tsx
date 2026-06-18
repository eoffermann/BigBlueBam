import {
  Handshake,
  ArrowRight,
  Users,
  Building2,
  TrendingUp,
  Search,
  CalendarClock,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Users,
    title: 'Contacts & Companies',
    description:
      'A real contact database with company hierarchy, custom fields, tags, and merge/duplicate detection — so the same person stops showing up three times.',
    color: 'bg-pink-100 text-pink-600',
  },
  {
    icon: TrendingUp,
    title: 'Pipeline Board',
    description:
      'A Kanban deal board with configurable stages, drag-and-drop, and weighted pipeline value per stage. The forecast does the multiplication for you.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: CalendarClock,
    title: 'Activity Timeline',
    description:
      'Log calls, emails, meetings, notes, and tasks against any contact, company, or deal. Stale deals raise their hand before they go cold.',
    color: 'bg-fuchsia-100 text-fuchsia-600',
  },
  {
    icon: Building2,
    title: 'Cross-Product Links',
    description:
      'Link a deal to its Bam project, Helpdesk tickets, Beacon articles, and Brief documents. The whole story of an account, in one place.',
    color: 'bg-pink-100 text-pink-600',
  },
  {
    icon: Search,
    title: 'Smart Search',
    description:
      'Full-text and semantic search across contacts, companies, deals, and every activity note you ever dashed off.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Bot,
    title: 'AI Pipeline Management',
    description:
      '69 MCP tools let AI agents create and advance deals, log activities, score leads, generate pipeline forecasts, upsert contacts by email, and flag likely duplicates — alongside your reps, not instead of them.',
    color: 'bg-fuchsia-100 text-fuchsia-600',
  },
];

export function BondSection() {
  return (
    <SectionWrapper id="bond" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="pink" className="mb-4">
            CRM
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The CRM nobody updates
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Every CRM is the tool nobody updates, because it lives a continent away from the work —
            and the deal you finally won closes to silence while the kickoff and the invoice sit on
            someone's to-do list. Bond puts the pipeline on the same stack as your projects: a won
            deal can spin up a Bam project and a Bill invoice, and an agent can log the call you
            forgot to log. It moves contacts, companies, and deals through configurable stages with
            activity logging, cross-product links, and 69 MCP tools, so an AI agent advances a deal
            or surfaces a duplicate as naturally as it files a task.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame src="/screenshots/bond/light/01-pipeline-board.png" alt="Bond pipeline board with deals across stages" />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A pipeline with deals actually moving through it — weighted value per stage, no wishful thinking.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/bond/light/02-deal-detail.png" alt="Bond deal detail with activity timeline" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Every call, email, and note on a deal — in order, in one place.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame src="/screenshots/bond/light/03-contacts-list.png" alt="Bond contacts list" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Contacts and companies that know which deals they belong to.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame src="/screenshots/bond/light/06-analytics.png" alt="Bond pipeline analytics and forecast" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Forecasts and pipeline health, without a spreadsheet in sight.
          </p>
        </AnimatedReveal>
      </div>

      {/* Feature highlights */}
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-pink-50 to-rose-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Handshake className="h-6 w-6 text-pink-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bond/</code> — a
              dedicated SPA sharing authentication and the project model with Bam, Beacon, Brief, Bolt, Bearing, and Board.
            </p>
          </div>
          <Button href="/bond/" variant="primary" size="sm">
            Try Bond <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
