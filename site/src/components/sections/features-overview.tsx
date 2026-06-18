import { motion } from 'motion/react';
import {
  Columns3,
  Settings2,
  IterationCcw,
  SquareStack,
  LayoutGrid,
  Radio,
  Keyboard,
  Shield,
  Clock,
  FormInput,
  Import,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FeatureCard } from '@/components/ui/feature-card';
import { AnimatedReveal } from '@/components/ui/animated-reveal';

const features = [
  {
    icon: Columns3,
    title: 'Kanban Board',
    description: 'Drag-and-drop task cards across configurable columns with smooth spring animations.',
  },
  {
    icon: Settings2,
    title: 'Configurable Phases',
    description: 'Define your own workflow stages per project — nothing is hardcoded.',
  },
  {
    icon: IterationCcw,
    title: 'Sprint Management',
    description: 'Time-boxed iterations with velocity tracking and carry-forward ceremony.',
  },
  {
    icon: SquareStack,
    title: 'Rich Task Cards',
    description: 'Priority, labels, story points, due dates, subtasks, comments, and attachments.',
  },
  {
    icon: LayoutGrid,
    title: 'Multiple Views',
    description: 'Board, List, Timeline/Gantt, and Calendar views for every project.',
  },
  {
    icon: Radio,
    title: 'Real-time Collaboration',
    description: 'Live updates via WebSocket — see card moves, edits, and comments instantly.',
  },
  {
    icon: Keyboard,
    title: 'Keyboard-First',
    description: 'Full keyboard navigation plus a Cmd+K command palette for power users.',
  },
  {
    icon: Shield,
    title: 'Role-Based Access',
    description: 'Owner, Admin, Member, and Viewer roles — the same model governs humans and AI agents.',
  },
  {
    icon: Clock,
    title: 'Time Tracking',
    description: 'Per-user, per-day time entries with reporting and task-level estimates.',
  },
  {
    icon: FormInput,
    title: 'Custom Fields',
    description: 'Text, number, date, select, multi-select, URL, checkbox, and user fields.',
  },
  {
    icon: Import,
    title: 'Import & Export',
    description: 'Import from CSV, Trello, Jira, and GitHub Issues. Export to iCal.',
  },
  {
    icon: Bot,
    title: 'AI-Native MCP',
    description: 'AI agents operate at full parity via 720+ structured tools with per-agent policy gates, approval queues, and full audit trail.',
  },
];

export function FeaturesOverview() {
  return (
    <SectionWrapper id="features" alternate dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Everything your team needs to ship
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            A complete toolkit for human and AI teammates alike — designed for teams that value
            flexibility, speed, and agentic workflows.
          </p>
        </div>
      </AnimatedReveal>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-60px' }}
        variants={{
          visible: { transition: { staggerChildren: 0.075 } },
        }}
        className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
      >
        {features.map((f) => (
          <motion.div
            key={f.title}
            variants={{
              hidden: { opacity: 0, y: 16 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
            }}
          >
            <FeatureCard icon={f.icon} title={f.title} description={f.description} />
          </motion.div>
        ))}
      </motion.div>
    </SectionWrapper>
  );
}
