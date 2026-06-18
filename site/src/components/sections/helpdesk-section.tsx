import {
  Headset,
  ArrowRight,
  Ticket,
  MessagesSquare,
  ArrowRightLeft,
  GaugeCircle,
  KeyRound,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: KeyRound,
    title: 'Branded Portal & Sign-In',
    description:
      'Every org gets its own support site at /helpdesk/<org>/, with customer accounts that are completely separate from your staff login. Customers never need a Bam account, and never see your internal board.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Ticket,
    title: 'Ticket Lifecycle',
    description:
      'Open → In Progress → Waiting on Customer → Resolved → Closed, with Low/Medium/High priorities (and an agent-only Critical) plus optional categories. Customers watch the status move in real time.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: MessagesSquare,
    title: 'Threaded Conversations',
    description:
      'Customer replies and agent replies in one thread, with internal agent notes that stay invisible to the customer, inline images, and file attachments. No reply-all chains, no lost context.',
    color: 'bg-green-100 text-green-600',
  },
  {
    icon: ArrowRightLeft,
    title: 'Tickets Become Bam Tasks',
    description:
      'Every ticket spawns a linked task in the portal’s default project, so support work lives next to your other project work. Close the ticket and its task lands in a terminal state automatically.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: GaugeCircle,
    title: 'Per-Org SLA & Settings',
    description:
      'Configure each portal’s default project, categories, welcome message, signup rules, and verification. SLA badges and similar-ticket search keep the agent queue honest.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: Bot,
    title: 'AI Triage',
    description:
      '11 MCP tools let AI agents search and triage tickets, find similar open ones before a duplicate piles up, reconcile requesters by email, post replies, and move status, including helpdesk_search_tickets, helpdesk_find_similar_tickets, helpdesk_upsert_user, and more.',
    color: 'bg-green-100 text-green-600',
  },
];

export function HelpdeskSection() {
  return (
    <SectionWrapper id="helpdesk" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Support Portal
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Tickets that talk to the work
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            A bug report lands in the support tool, gets retyped into the project tool, the customer
            repeats themselves twice, and nobody on the engineering board ever hears the ticket
            exists. Helpdesk runs on the same stack as the work: every ticket becomes a Bam task on
            your board, SLA tracking is built into the queue, and with 11 MCP tools an AI agent can
            triage, dedupe, and reply right alongside your team.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/helpdesk/light/01-portal-entry.png"
          alt="Helpdesk customer sign-in portal"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A clean, branded front door. The only part of the suite your customers ever see.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/helpdesk/light/02-ticket-list.png"
            alt="Helpdesk My Tickets list with status, priority, and category"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Customers track their own tickets: status, priority, and category, with no email follow-ups.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/helpdesk/light/03-ticket-detail.png"
            alt="Helpdesk ticket detail with threaded customer and agent conversation"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            One thread for the whole conversation. Agent replies show, internal notes don&rsquo;t.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/helpdesk/light/04-new-ticket.png"
            alt="Helpdesk new ticket form with subject, category, priority, and description"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Filing a ticket: subject, category, priority, and a rich-text box for the details.
          </p>
        </AnimatedReveal>
      </div>

      {/* Feature highlights */}
      <AnimatedReveal delay={0.2}>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <div
                className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${feature.color}`}
              >
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">{feature.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.3}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Headset className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/helpdesk/</code>, a
              separate customer-facing SPA that shares authentication and the project model with Bam,
              so tickets land on the same board as the rest of your work. Customers never see it.
            </p>
          </div>
          <Button href="/helpdesk/" variant="primary" size="sm">
            Try Helpdesk <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
