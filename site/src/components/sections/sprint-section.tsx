import { ClipboardList, Play, BarChart3, IterationCcw } from 'lucide-react';
import clsx from 'clsx';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

const steps = [
  {
    icon: ClipboardList,
    title: 'Plan',
    description: 'Pull tasks from the backlog, set sprint goals, and review team capacity.',
    color: 'bg-primary-100 text-primary-600',
  },
  {
    icon: Play,
    title: 'Execute',
    description: 'Work the board. Real-time updates keep everyone in sync as tasks move across phases.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: BarChart3,
    title: 'Review',
    description: 'Sprint reports with velocity charts, completion rates, and per-member breakdowns.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: IterationCcw,
    title: 'Carry Forward',
    description: 'Incomplete tasks are presented for decision: carry forward, move to backlog, or cancel.',
    color: 'bg-orange-100 text-orange-600',
    badge: true,
  },
];

export function SprintSection() {
  return (
    <SectionWrapper id="sprints" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Sprints with a carry-forward ceremony
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Time-boxed iterations done right. When a sprint closes, unfinished work doesn't just
            disappear. It gets a formal review.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, i) => (
          <AnimatedReveal key={step.title} delay={i * 0.1}>
            <div className="relative rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              {/* Step number */}
              <div className="absolute -top-3 left-6 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">
                {i + 1}
              </div>
              <div className={clsx('mb-4 flex h-10 w-10 items-center justify-center rounded-lg', step.color)}>
                <step.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">
                {step.title}
                {step.badge && (
                  <Badge variant="orange" className="ml-2 align-middle">
                    CF 2
                  </Badge>
                )}
              </h3>
              <p className="mt-2 text-sm text-zinc-600">{step.description}</p>
            </div>
          </AnimatedReveal>
        ))}
      </div>

      <AnimatedReveal delay={0.4}>
        <div className="mt-10 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="text-sm font-medium text-primary-800">
            Tasks track their <strong>carry_forward_count</strong> and display a badge on the card, so
            your team always knows which work has been deferred and how many times.
          </p>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
