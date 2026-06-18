import { Radio, Shield, Activity, MessageSquare } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';

const bullets = [
  {
    icon: Radio,
    title: 'Real-time Sync',
    description: 'WebSocket + Redis PubSub broadcasts card moves, edits, and comments across all connected clients.',
  },
  {
    icon: Shield,
    title: 'Role-based Access',
    description: 'Five roles — Owner, Admin, Member, Viewer, Guest — plus platform SuperUser. Rank-gated actions contain credential compromise.',
  },
  {
    icon: Activity,
    title: 'Activity Log',
    description: 'Every change is recorded with who, what, and when. Partitioned monthly for performance.',
  },
  {
    icon: MessageSquare,
    title: 'Comments & Reactions',
    description: 'Threaded comments with rich text, @mentions, and emoji reactions on every task.',
  },
];

export function Collaboration() {
  return (
    <SectionWrapper id="collaboration" alternate dividerTop>
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <AnimatedReveal direction="right" delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bam/light/04-people.png"
            alt="People roster with roles across the team"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The whole roster in one view — humans and agents, same roles, same audit trail.
          </p>
        </AnimatedReveal>

        <AnimatedReveal direction="left">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
              Built for teams — human and AI
            </h2>
            <p className="mt-4 text-lg text-zinc-600">
              Multi-user from day one. Humans and AI agents see updates the moment they happen,
              operate under the same permissions, and leave the same audit trail.
            </p>
            <div className="mt-8 space-y-5">
              {bullets.map((b) => (
                <div key={b.title} className="flex gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
                    <b.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900">{b.title}</h3>
                    <p className="mt-0.5 text-sm text-zinc-600">{b.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </AnimatedReveal>
      </div>
    </SectionWrapper>
  );
}
