import {
  BarChart3,
  ArrowRight,
  LayoutDashboard,
  Search,
  Clock,
  Database,
  Wand2,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: LayoutDashboard,
    title: 'Dashboards & Widgets',
    description:
      'Assemble named, shareable dashboards from chart, KPI, counter, and table widgets. Set each one Private, by Project, or Org-wide, add an auto-refresh for the wall-board, and drag widgets into the order you want.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Database,
    title: 'Curated Data Sources',
    description:
      'A compile-time registry allowlists exactly which tables Bench may read — tasks in Bam, deals in Bond, campaigns in Blast, goals in Bearing, and more. Every query is automatically scoped to your org. No warehouse, no copy-paste.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Wand2,
    title: 'Widget Wizard & Templates',
    description:
      'A four-step wizard (Data Source → Measures & Dimensions → Chart Type → Name & Style) builds a custom widget, or grab one from the prebuilt gallery and skip straight to the chart.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Search,
    title: 'Ad-hoc Explorer & Saved Queries',
    description:
      'Pick a source and get a results table with row count and timing on the spot. When a query earns its keep, save its definition and re-run it whenever you like.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Clock,
    title: 'Scheduled Reports',
    description:
      'Cron-driven dashboard snapshots aimed at Email, a Banter channel, or a Brief document, in PDF, PNG, or CSV. Heads up: delivery is wired but still a stub this release — the schedule stamps status, no artifact ships yet.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Bot,
    title: 'AI Analytics',
    description:
      '32 MCP tools let AI agents discover sources, run ad-hoc queries, build dashboards and widgets, and summarize a whole board in one call — plus anomaly detection and period comparison that have no UI equivalent. Try bench_summarize_dashboard, bench_query_ad_hoc, and bench_detect_anomalies.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BenchSection() {
  return (
    <SectionWrapper id="bench" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="blue" className="mb-4">
            Analytics
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The numbers were here all along
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Bench turns the data your team already creates across the suite — deals, campaigns,
            goals, tasks, knowledge-base activity — into shared dashboards, ad-hoc queries, and
            scheduled reports. No warehouse, no exports, no copy-paste: it charts the live tables
            through a curated registry, scoped to your org. And with 32 MCP tools, an AI agent can
            summarize a whole dashboard or sniff out an anomaly without anyone touching a chart.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bench/light/02-dashboard-view.png"
          alt="Bench dashboard with charts, KPI cards, and tables"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A dashboard that pulls from five apps at once — and tells you how long each widget took.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bench/light/03-explorer.png"
            alt="Bench ad-hoc explorer with a source picker and results table"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Ask a source a question, get a table back — row count and timing included.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/bench/light/04-widget-wizard.png"
            alt="Bench widget wizard stepping through source, fields, chart type, and style"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Four steps from "I have a hunch" to a chart on the board.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/bench/light/06-saved-queries.png"
            alt="Bench saved queries list with run and edit actions"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The good queries, kept — one click to run them again next quarter.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/bench/light/05-reports.png"
            alt="Bench scheduled reports list with delivery methods and cadences"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Snapshots on a cadence, headed for email, a channel, or a doc.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-blue-50 to-sky-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-6 w-6 text-blue-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bench/</code> — a
              dedicated SPA with cross-product data access for unified analytics.
            </p>
          </div>
          <Button href="/bench/" variant="primary" size="sm">
            Try Bench <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
