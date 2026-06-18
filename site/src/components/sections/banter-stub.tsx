import {
  MessageSquare,
  Hash,
  Pin,
  Phone,
  Search,
  Link2,
  Bot,
  ArrowRight,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const features = [
  {
    icon: Hash,
    title: 'Channels & Threads',
    description:
      'Public or private channels with topics, descriptions, and pinned messages. Threaded replies keep a side conversation contextual — and can mirror back to the channel when everyone should see the answer.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: MessageSquare,
    title: 'DMs & Group DMs',
    description:
      'One-to-one direct messages, plus group DMs of three to eight people for the quick huddle that does not need a whole channel. Same people, same identity — no separate contact list to keep in sync.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Pin,
    title: 'Reactions, Pins & Bookmarks',
    description:
      'Emoji reactions so a thumbs-up does not need its own message. Pin the decision to the top of the channel, bookmark the thing you will need later, and stop scrolling for it.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Phone,
    title: 'Calls & Transcripts',
    description:
      'Live audio for a channel runs through the suite-wide Bureau call box, powered by LiveKit. Banter keeps the read-only history of past calls and their transcripts, searchable right where the talking happened.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Link2,
    title: 'Share the Work In',
    description:
      'Drop a Bam task or sprint, or a Helpdesk ticket, straight into a channel as a live reference. Type a task key and it renders as a chip with status — discussion stays next to the thing being discussed.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Bot,
    title: 'AI-Native Chat',
    description:
      '69 MCP tools let agents post, reply, react, DM, and search with the same authority as a person — for example banter_post_message, banter_schedule_post (queued for later, honoring per-channel quiet hours), and banter_subscribe_pattern (watch a channel and react when a message matches). Gated by org policy and per-entity visibility checks.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BanterStub() {
  return (
    <SectionWrapper id="banter" alternate dividerTop>
      {/* Header */}
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <Badge variant="blue">Team Chat</Badge>
            <Badge variant="orange">Beta</Badge>
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Where decisions stop getting lost
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Team chat is where decisions go to die in the scrollback — and the "AI" bolted onto it can
            recap a thread but can't actually <em>do</em> anything in it. Banter is real-time messaging —
            channels, threads, DMs, reactions, calls, scheduled posts — running on the same stack as your
            work, sharing one BigBlueBam login with the rest of the suite. Type a task key and it becomes a
            live chip linked to <a href="#bam" className="text-primary-600 underline-offset-2 hover:underline">Bam</a>;
            an agent in the channel can turn a message into a task and move the work, not just summarize it.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/banter/light/01-channel-view.png"
          alt="Banter channel view with channel sidebar, message timeline, and direct messages"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Channels down the side, conversation in the middle, the whole org in one place — and yes, the
          bots have accounts too.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/banter/light/03-thread.png"
            alt="Banter thread panel open beside a channel"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Threads tuck the tangent off to the side so the channel stays readable.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/banter/light/04-dms.png"
            alt="Banter direct message conversation"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Direct messages for the conversation that does not need an audience.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/banter/light/06-preferences.png"
            alt="Banter preferences — theme, notifications, and messaging options"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Theme, notifications, enter-to-send, compact mode — tuned to how you like to type.
          </p>
        </AnimatedReveal>
      </div>

      {/* Why not Slack? */}
      <AnimatedReveal delay={0.2}>
        <div className="mt-10 rounded-xl border border-primary-200 bg-gradient-to-br from-primary-50 to-white p-6 md:p-8">
          <h3 className="text-lg font-bold text-zinc-900">Why not just keep using Slack?</h3>
          <p className="mt-2 text-zinc-600">
            Because Banter shares authentication, the people directory, and deep cross-linking with the
            rest of BigBlueBam. Type{' '}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">BAM-247</code> in a channel and
            it links straight to the task. When an agent triages a Helpdesk ticket, it can post the
            update to <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">#support-triage</code>{' '}
            on the same audit trail your team posts on. Same users, same permissions, no second
            directory to keep in sync.
          </p>
        </div>
      </AnimatedReveal>

      {/* Feature highlights */}
      <AnimatedReveal delay={0.25}>
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

      {/* CTA */}
      <AnimatedReveal delay={0.3}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-sky-50 to-blue-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Search className="hidden h-6 w-6 text-blue-600 sm:block" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/banter/</code> — a dedicated
              SPA (in beta) sharing authentication and the people directory with Bam, Helpdesk, Beacon,
              Brief, and the rest of the suite. We are still polishing; tell us where it creaks.
            </p>
          </div>
          <Button href="/banter/" variant="primary" size="sm">
            Try Banter <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
