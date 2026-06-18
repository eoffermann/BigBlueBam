import { GripVertical, Layers, ArrowRightLeft, ArrowRight } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';

const highlights = [
  {
    icon: GripVertical,
    title: 'Drag & Drop',
    description: 'Move tasks between phases with smooth spring-physics animations. Multi-select supported.',
  },
  {
    icon: Layers,
    title: 'Swimlanes',
    description: 'Group by assignee, epic, label, priority, or any custom field for at-a-glance organization.',
  },
  {
    icon: ArrowRightLeft,
    title: 'Configurable Phases',
    description: 'Define exactly the workflow columns your project needs, from two to twenty.',
  },
];

export function KanbanShowcase() {
  return (
    <SectionWrapper id="kanban" dividerTop>
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <AnimatedReveal direction="left">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
              A board that adapts to your workflow
            </h2>
            <p className="mt-4 text-lg text-zinc-600">
              Not another rigid Kanban tool. Bam lets you define phases, states, and swimlanes
              that match how your team actually works.
            </p>
            <div className="mt-8 space-y-6">
              {highlights.map((h) => (
                <div key={h.title} className="flex gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
                    <h.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-900">{h.title}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{h.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </AnimatedReveal>

        <AnimatedReveal direction="right" delay={0.15} withScale>
          <FloatingFrame src="/screenshots/bam/light/01-board.png" alt="Kanban board grouped into phase swimlanes" />
        </AnimatedReveal>
      </div>

      {/* CTA */}
      <AnimatedReveal delay={0.3}>
        <div className="mt-12 flex items-center justify-center gap-4 text-center">
          <Button href="/b3/" variant="primary" size="md">
            Try Bam <ArrowRight className="h-4 w-4" />
          </Button>
          <Button href="#cta" variant="outline" size="md">
            Get Started
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
