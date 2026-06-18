import { motion } from 'motion/react';
import {
  Users,
  Bot,
  ArrowLeftRight,
  Headset,
  Code,
  ClipboardCheck,
  MessageSquare,
  ArrowRight,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const roles = [
  {
    icon: ClipboardCheck,
    human: 'Product Manager',
    ai: 'AI Project Coordinator',
    description: 'Triages incoming work, updates sprint scope, assigns tasks based on team capacity and priority.',
  },
  {
    icon: Code,
    human: 'Engineer',
    ai: 'AI Engineer',
    description: 'Picks up tickets, writes code, logs time, updates task status, and moves cards across the board.',
  },
  {
    icon: Headset,
    human: 'Support Rep',
    ai: 'AI Customer Agent',
    description: 'Responds to helpdesk tickets, escalates complex issues to humans, and closes resolved requests.',
  },
  {
    icon: MessageSquare,
    human: 'Team Lead',
    ai: 'AI Scrum Master',
    description: 'Runs carry-forward ceremonies, flags blocked tasks, generates sprint reports, and nudges overdue items.',
  },
];

export function AiCollaboration() {
  return (
    <SectionWrapper id="ai-collaboration" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-6 max-w-3xl text-center">
          <Badge variant="purple" className="mb-4">
            Core Philosophy
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            AI agents aren't add-ons.{' '}
            <span className="text-primary-600">They're teammates.</span>
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Most "AI" in a productivity tool is a chat box in the corner that summarizes the doc you
            just wrote, and plenty of vendors charge extra for that. We took a different approach. An
            agent can do real work on your actual boards, tickets, and deals, with the same
            permissions a person has. It is real parity built into the platform, not a sidebar
            bolted on the edge.
          </p>
        </div>
      </AnimatedReveal>

      {/* Human and AI role parity */}
      <AnimatedReveal delay={0.1}>
        <div className="mt-14 mb-14">
          <h3 className="mb-2 text-center text-sm font-semibold tracking-wider text-zinc-400 uppercase">
            Side by side, role by role
          </h3>
          <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-zinc-500">
            Each of these is a role an agent can take. You bring the agent; BigBlueBam gives it the
            same access your team has.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            {roles.map((role, i) => (
              <motion.div
                key={role.human}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
                className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
                    <role.icon className="h-5 w-5" />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      <Users className="h-3 w-3" />
                      {role.human}
                    </div>
                    <ArrowLeftRight className="h-3.5 w-3.5 text-zinc-300" />
                    <div className="flex items-center gap-1.5 rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-700">
                      <Bot className="h-3 w-3" />
                      {role.ai}
                    </div>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-zinc-600">{role.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </AnimatedReveal>

      {/* Escalation flow */}
      <AnimatedReveal delay={0.2}>
        <div className="grid gap-5 md:grid-cols-3">
          {[
            {
              step: '1',
              title: 'An agent can pick up work',
              description: 'An agent can watch the board, pick up assigned tasks, and start working, logging progress as it goes.',
              color: 'bg-primary-600',
            },
            {
              step: '2',
              title: 'Escalates when needed',
              description: 'When an agent hits ambiguity, needs approval, or runs into something outside its lane, it hands off to a human.',
              color: 'bg-amber-500',
            },
            {
              step: '3',
              title: 'Human resolves, agent continues',
              description: 'The human teammate weighs in, and the agent picks right back up where it left off. Full context preserved, nothing dropped on the floor.',
              color: 'bg-emerald-500',
            },
          ].map((item) => (
            <div key={item.step} className="relative rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className={`absolute -top-3 left-6 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${item.color}`}>
                {item.step}
              </div>
              <h3 className="mt-1 text-base font-semibold text-zinc-900">{item.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{item.description}</p>
            </div>
          ))}
        </div>
      </AnimatedReveal>

      {/* "How does that actually work" gate to the technical page */}
      <AnimatedReveal delay={0.3}>
        <div className="mt-10 rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 via-white to-primary-50/30 p-8 text-center md:p-10">
          <h3 className="text-xl font-bold text-zinc-900">
            "But how does an agent do all that safely?"
          </h3>
          <p className="mx-auto mt-3 max-w-2xl text-zinc-600">
            Short version: agents use the exact same tools your team's buttons use, under the same
            role-based permissions, and everything they touch shows up in the same audit log. The
            risky moves (deleting things, closing out a sprint) need a human to confirm. There is no
            special back door.
          </p>
          <div className="mt-6 flex justify-center">
            <Button href="/technical#mcp-parity" variant="outline">
              Talk nerdy to me <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            The long version has the API keys, the permission model, the audit trail, and the actual
            tool calls. We will show you all of it.
          </p>
        </div>
      </AnimatedReveal>

      {/* Bring your own LLM (kept light; details live on the technical page) */}
      <AnimatedReveal delay={0.4}>
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-900">Use whatever AI you want</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Bring your own model. It works with the major providers and with private or local
                models, so you are never locked to one AI vendor any more than you are locked to us.
              </p>
            </div>
          </div>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
