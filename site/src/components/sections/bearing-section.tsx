import {
  Target,
  ArrowRight,
  TrendingUp,
  CalendarRange,
  FolderKanban,
  AlertTriangle,
  MessageSquare,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Target,
    title: 'Objectives & Key Results',
    description:
      'Every goal carries measurable key results — Number, Percentage, Currency, or Yes/No — each with a start, target, and current value. The goal score is the average of its KRs, so progress is math, not vibes.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: TrendingUp,
    title: 'Progress That Rolls Itself Up',
    description:
      'Link a key result to a Bam epic, project, sprint, or task and it advances as that work reaches done. No quarterly slider-dragging ritual, no stale numbers.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: AlertTriangle,
    title: 'At-Risk Triage',
    description:
      'A status engine compares where a goal is against where it should be by now and flags it on track, at risk, or behind. The At Risk view sorts the worst offenders to the top.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: MessageSquare,
    title: 'Check-Ins & Status Updates',
    description:
      'Record new key-result values and post a status narrative to the team. Each update snapshots progress at that moment, so the history reads like a story instead of a guess.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: CalendarRange,
    title: 'Time Periods & Watchers',
    description:
      'Organize goals into quarters, halves, years, or custom ranges with a draft → active → completed → archived lifecycle. Watchers get an email the moment a goal’s status turns.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Bot,
    title: 'AI Goal-Keeping',
    description:
      '30 MCP tools let AI agents provision a whole quarter of objectives, wire key results to real Bam delivery, run a weekly at-risk sweep, and post the period report to Banter — alongside your team, not instead of it. Try bearing_goal_create, bearing_kr_link, and bearing_at_risk.',
    color: 'bg-purple-100 text-purple-600',
  },
];

export function BearingSection() {
  return (
    <SectionWrapper id="bearing" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="purple" className="mb-4">
            Goals &amp; OKRs
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Goals that update themselves
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Set objectives, attach measurable key results, and watch progress roll up from the work
            your team is already doing. Bearing links key results to Bam epics, projects, and tasks,
            organizes everything into time periods, and runs a status engine that flags goals as
            on-track, at-risk, or behind before the quarter quietly slips away — backed by 30 MCP
            tools, so an AI agent can stand up a full quarter and run the Friday status sweep for you.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bearing/light/01-dashboard.png"
          alt="Bearing goals dashboard with summary stats and period filtering"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The quarter at a glance — every objective, its real percentage, and who is on the hook.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bearing/light/02-goal-detail.png"
            alt="Bearing goal detail with key results, progress bars, and status updates"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            One goal, its key results, and the check-in history that got it there.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/bearing/light/04-at-risk.png"
            alt="Bearing At Risk view listing goals that are falling behind pace"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The goals raising their hand for help, worst-off sorted to the top.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/bearing/light/05-periods.png"
            alt="Bearing time periods and cycles list"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Quarters, sprints, whatever you measure in — the windows your goals answer to.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-indigo-50 to-purple-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Target className="h-6 w-6 text-indigo-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bearing/</code> — a
              dedicated SPA sharing authentication and the project model with Bam, Beacon, Brief, Bolt, Board, and Bond.
            </p>
          </div>
          <Button href="/bearing/" variant="primary" size="sm">
            Try Bearing <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
