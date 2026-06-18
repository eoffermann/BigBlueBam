import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Columns3, List, GanttChart, Calendar } from 'lucide-react';
import clsx from 'clsx';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';

const views = [
  { key: 'board', label: 'Board', icon: Columns3, src: '/screenshots/bam/light/01-board.png', alt: 'Board view' },
  { key: 'list', label: 'List', icon: List, src: '/screenshots/bam/light/04-list-view.png', alt: 'List view' },
  { key: 'timeline', label: 'Timeline', icon: GanttChart, src: '/screenshots/bam/light/09-timeline.png', alt: 'Timeline view' },
  { key: 'calendar', label: 'Calendar', icon: Calendar, src: '/screenshots/bam/light/10-calendar.png', alt: 'Calendar view' },
];

export function ViewsShowcase() {
  const [active, setActive] = useState('board');
  const current = views.find((v) => v.key === active)!;

  return (
    <SectionWrapper id="views" alternate dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Four ways to see your work
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Switch between views instantly. Every view shares the same filters and saved
            configurations.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.1} withScale>
        {/* Tab bar */}
        <div className="mb-8 flex justify-center">
          <div className="inline-flex gap-1 rounded-lg border border-zinc-200 bg-white p-1 shadow-sm">
            {views.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setActive(v.key)}
                className={clsx(
                  'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                  active === v.key
                    ? 'bg-primary-600 text-white shadow-sm'
                    : 'text-zinc-600 hover:text-zinc-900',
                )}
              >
                <v.icon className="h-4 w-4" />
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {/* Screenshot */}
        <div className="relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={current.key}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.25 }}
            >
              <FloatingFrame src={current.src} alt={current.alt} />
            </motion.div>
          </AnimatePresence>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
