import {
  Scale,
  ArrowRight,
  ListTree,
  LayoutGrid,
  GitCompareArrows,
  Snowflake,
  Radar,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: ListTree,
    title: 'Derives the scope, cites the line',
    description:
      'Bursar reads your RFP into a cited scope tree - the ruler every bid is measured against. Each requirement links back to the request language it came from, and mandatory items are flagged as mandatory. Rival-derived nodes stay in a promotion queue until a human accepts them, so a competitor cannot smuggle a requirement into your comparison.',
    color: 'bg-indigo-100 text-indigo-700',
  },
  {
    icon: LayoutGrid,
    title: 'Levels the quotes, surfaces the silence',
    description:
      'Competing offers are normalized into one coverage matrix, node by node. The hard part is not what a bid says - it is what it is silent about. The absence engine finds the crew training that is missing and the installation that is quietly excluded, values each gap only when the evidence supports it, and produces a gap-adjusted comparable total that a bare sticker price hides.',
    color: 'bg-violet-100 text-violet-700',
  },
  {
    icon: GitCompareArrows,
    title: 'The blanket-claim defense',
    description:
      'A vendor that answers "everything is included at no additional charge" is not covered - it is unproven. Cumulative anti-blanket caps catch coordinated blanket lines, publish zero coverage from them, and render every mandatory node the offer never itemized under a plain banner: this offer claims blanket coverage; here is what it does not itemize.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Snowflake,
    title: 'Freezes the award into a baseline',
    description:
      'When you award, Bursar freezes the accepted offer into an immutable, clause-cited baseline: what you got, what you knowingly excluded, and what was simply absent at award. There is no edit control on a baseline row. That frozen record is the reference every later charge is checked against - not a memory, not a spreadsheet someone can quietly change.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: Radar,
    title: 'Watches the spend against the baseline',
    description:
      'Bursar reads observed spend - Bill expenses flow in through the event inbox - and checks it against the frozen baseline for price drift, out-of-scope charges, unbaselined vendors, and renewal cliffs. A finding it cannot put a dollar figure on reads as "not quantified", never as a fabricated number. The scope-gap gate is advisory: it flags, it never blocks a payment.',
    color: 'bg-sky-100 text-sky-700',
  },
  {
    icon: Bot,
    title: 'Built for agents (20 MCP tools)',
    description:
      '20 bursar_* MCP tools let an AI agent read the scope tree, level quotes, pull the coverage matrix and the exclusion diff, inspect a frozen baseline, and surface drift and renewal findings - with the same identity and audit trail as a human. Sealed bids stay sealed, every award and adjudication stays a human act behind a confirm token, and financial flooring narrows to the person the agent acts for.',
    color: 'bg-indigo-100 text-indigo-700',
  },
];

export function BursarSection() {
  return (
    <SectionWrapper id="bursar" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="purple" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The cheapest bid is rarely the cheapest deal
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-zinc-600">
            Every procurement decision hides in the gap between what a vendor quotes and what a
            vendor is silent about - the training that is not included, the exclusion buried on the
            last page, the charge that shows up months after the award. Bursar is the AI
            procurement-leveling and spend-baseline monitor: it derives a cited scope tree from your
            RFP, levels competing offers into one coverage matrix that surfaces what each bid leaves
            out, freezes the award into an immutable clause-cited baseline, then watches observed
            spend against it for drift, out-of-scope charges, and renewal cliffs. Sized for an owner,
            operations lead, or finance lead at a firm of two to fifty seats.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: the leveling matrix, the punchline of the app. */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bursar/light/leveling-matrix.png"
          alt="The Bursar leveling matrix: competing offers as columns, scope nodes as rows, with covered / partial / excluded / absent verdicts and a gap-adjusted comparable total per offer"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The leveling matrix: every offer against every scope node, sorted by a gap-adjusted
          comparable total - so the bid that is silent about a mandatory requirement stops looking
          like the cheapest one.
        </p>
      </AnimatedReveal>

      <AnimatedReveal delay={0.13} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bursar/light/exclusion-diff.png"
            alt="The Bursar exclusion diff: every mandatory scope node shown exactly once per offer, with a blocking banner when any node is unverified and a blanket-claim callout"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The exclusion diff: every mandatory node appears exactly once, a blocking banner refuses
            a clean verdict while anything is unverified, and a blanket bid is unfolded into the list
            of what it never itemized.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.15} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bursar/light/vendor-portfolio.png"
            alt="The Bursar vendor portfolio, with award status as a first-class column and vendors that have spend but no award on file called out"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The vendor portfolio: award status is a first-class column, so a vendor with spend but no
            award on file is the thing you notice, not the thing you miss.
          </p>
        </div>
      </AnimatedReveal>

      {/* Dark-mode leveling matrix: theme-aware like the rest of the suite. */}
      <AnimatedReveal delay={0.18} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bursar/dark/leveling-matrix.png"
            alt="The Bursar leveling matrix in dark mode, on the same shared shell as every other app in the suite"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The leveling matrix in dark mode, on the same shared shell as every other app in the suite.
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
            <Scale className="h-6 w-6 text-indigo-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bursar/</code>,
              the leveling desk over Bond, Bill, and Bin: Bursar reads the offers so the silence in a
              quote stops costing you after the award.
            </p>
          </div>
          <Button href="/bursar/" variant="primary" size="sm">
            Try Bursar <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
