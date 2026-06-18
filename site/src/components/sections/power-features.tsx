import { Command, Keyboard, FormInput, Copy, BookmarkCheck, Clock } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';

const features = [
  {
    icon: Command,
    title: 'Command Palette',
    description:
      'Hit Cmd+K to jump to any project, task, or action. Fuzzy search across your entire workspace, so your mouse can take a coffee break.',
    screenshot: '/screenshots/bam/light/05-my-work.png',
    screenshotAlt: 'My Work, every task assigned to you, in one place',
  },
  {
    icon: Keyboard,
    title: 'Keyboard Shortcuts',
    description:
      'Every action is reachable from the keyboard. Navigate the board with arrow keys, grab and drop cards with Space.',
  },
  {
    icon: FormInput,
    title: 'Custom Fields',
    description:
      'Add text, number, date, select, multi-select, URL, checkbox, or user-picker fields to any project.',
  },
  {
    icon: Copy,
    title: 'Task Templates',
    description:
      'Create reusable blueprints with title patterns, default field values, and auto-generated subtasks.',
  },
  {
    icon: BookmarkCheck,
    title: 'Saved Views',
    description:
      'Persist filter, sort, and swimlane configurations per user or share them with the whole project.',
  },
  {
    icon: Clock,
    title: 'Time Tracking',
    description:
      'Log time entries per user, per day. View reports by task, sprint, or team member.',
  },
];

export function PowerFeatures() {
  return (
    <SectionWrapper id="power-features" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Power features for power users
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Keyboard-first design with deep customization. Everything a fast team needs, nothing it
            doesn't.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Command palette with screenshot */}
        <AnimatedReveal delay={0.1} withScale className="lg:col-span-2">
          <div className="grid items-center gap-8 rounded-2xl border border-zinc-200 bg-zinc-50 p-6 lg:grid-cols-2 lg:p-8">
            <div>
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
                <Command className="h-5 w-5" />
              </div>
              <h3 className="text-xl font-semibold text-zinc-900">{features[0].title}</h3>
              <p className="mt-2 text-zinc-600">{features[0].description}</p>
            </div>
            <div>
              <FloatingFrame src={features[0].screenshot!} alt={features[0].screenshotAlt!} />
              <p className="mt-3 text-center text-sm text-zinc-500">
                One keystroke from here to anywhere, with every task you own a few letters away.
              </p>
            </div>
          </div>
        </AnimatedReveal>

        {/* Remaining features as cards */}
        {features.slice(1).map((f, i) => (
          <AnimatedReveal key={f.title} delay={0.1 + (i + 1) * 0.075}>
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{f.description}</p>
            </div>
          </AnimatedReveal>
        ))}
      </div>
    </SectionWrapper>
  );
}
