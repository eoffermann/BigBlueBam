import { Ruler, ArrowRight, BadgeCheck, GitBranch, Sparkles, ShieldCheck } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Ruler,
    title: 'One definition per number',
    description:
      'Define "MRR" or "pipeline" once - owner, unit, direction, and the query it runs - and every app, chart, and agent reads the same certified definition. No more three different revenue numbers from three different apps.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: BadgeCheck,
    title: 'Certify the truth',
    description:
      'A metric starts as a draft and is promoted to certified in one deliberate step - the org-wide source of truth. A Bench widget binds to it, so the KPI labeled "MRR" everywhere resolves to the certified definition and presentation.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: GitBranch,
    title: 'Immutable version lineage',
    description:
      'Every definition change mints a new immutable version. You can always see exactly how a metric was defined at any point in time - no silent redefinition of what "revenue" meant last quarter.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Sparkles,
    title: 'Why did it change?',
    description:
      'When a certified metric moves, Basis decomposes the delta across a dimension - an exact, auditable breakdown for additive measures - and separately surfaces the concrete cross-app activity that may have contributed.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: ShieldCheck,
    title: 'Shared number, private breakdown',
    description:
      'The certified value is exact and org-shared, but its per-entity breakdown is access-scoped: a viewer missing access to some entities gets a k-anonymous breakdown that never lets them back out a hidden entity’s amount.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Ruler,
    title: 'Built for agents',
    description:
      'MCP tools let an agent read the same certified metrics you do and ask "why did X change" on your behalf - with the human’s identity attached so per-entity visibility is enforced, and truth-flips gated behind confirmation.',
    color: 'bg-rose-100 text-rose-600',
  },
];

export function BasisSection() {
  return (
    <SectionWrapper id="basis" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            One trusted number, and why it moved
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Somewhere your team is arguing about which "revenue" is right, and nobody can say why a
            KPI dropped without an afternoon of pivot-table archaeology. Basis is a governed metric
            layer: define each number once, certify it as the source of truth, keep an immutable
            history of how it was defined, and let an AI core explain - in plain language - exactly
            why a certified metric moved. It is the semantic layer that used to require a data team,
            sized for a team of two to fifty.
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
            <Ruler className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/basis/</code>,
              adjacent to Bench: Basis defines and explains, Bench renders.
            </p>
          </div>
          <Button href="/basis/" variant="primary" size="sm">
            Try Basis <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
