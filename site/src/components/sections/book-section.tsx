import {
  Calendar,
  ArrowRight,
  CalendarRange,
  Link2,
  Clock,
  Users,
  Plug,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: CalendarRange,
    title: 'Week, Day, Month & Timeline',
    description:
      'Four ways to look at the same time. Week, day, and month for the calendar grid — plus a cross-app timeline that lines up Book events with Bam task due dates and Bond deal close dates, day by day.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Link2,
    title: 'Public Booking Pages',
    description:
      'Publish a scheduling link at /book/meet/<slug> with durations, buffers, and your brand. Outside people pick a slot and book themselves; each booking creates or updates a matching Bond contact by email.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Clock,
    title: 'Working Hours = Availability',
    description:
      'Set the hours you actually work, per day of the week. Book subtracts your busy events from those windows to compute real free slots — the same math your booking pages offer to visitors.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Users,
    title: 'Team Meeting-Time Finder',
    description:
      'Ask for a time that works across several people and Book finds the overlap. It handles mixed human-and-agent rosters too: agents bring unlimited virtual availability, humans bring their working hours.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Plug,
    title: 'External Calendar Sync',
    description:
      'Subscribe to any public iCalendar (.ics) feed — webcal links included — and its events mirror onto a Book calendar, refreshed on a recurring sweep. Google and Outlook two-way sync run on the same engine, ready to flip on once an operator adds OAuth.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Bot,
    title: 'AI Scheduling',
    description:
      '25 MCP tools let AI agents create, update, cancel, and RSVP to events, find a meeting time across a roster, and read team availability — book_find_meeting_time, book_create_event, book_get_team_availability, and the rest — right next to your reps, not instead of them.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BookSection() {
  return (
    <SectionWrapper id="book" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="blue" className="mb-4">
            Scheduling
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The booking link that knows what the meeting's about
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            The scheduling link everyone pastes in their signature is one more monthly bill, living
            off in its own tab — it has no idea when your team is actually free or what any of this is
            even for. Book does availability rules, public booking pages, and timezone-aware events on
            the same stack as the work, so what gets booked links straight to the Bam task or Bond
            deal it's for. It finds time across a whole roster, not just one calendar — and through 25
            MCP tools, an AI agent can find the slot and book it too.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame src="/screenshots/book/light/01-week-view.png" alt="Book week view with events laid across a seven-day grid" />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A week you can actually read — events in their lanes, drag-to-reschedule, no spreadsheet cosplay.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/book/light/02-month-view.png" alt="Book month view with events on each day" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The whole month at a glance, for when "sometime next week" needs a date.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame src="/screenshots/book/light/03-timeline.png" alt="Book cross-app timeline grouping events by day" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            One timeline, three apps — Book events beside Bam due dates and Bond close dates.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame src="/screenshots/book/light/07-connections.png" alt="Book external calendar connections with an active ICS subscription" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Subscribe to an outside .ics feed and watch its events arrive — Google and Outlook are next in line.
          </p>
        </AnimatedReveal>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.3} withScale>
          <FloatingFrame src="/screenshots/book/light/04-booking-pages.png" alt="Book booking pages with a published public scheduling link" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            A public link that lets clients book you — and quietly files them in Bond on the way in.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.35} withScale>
          <FloatingFrame src="/screenshots/book/light/05-working-hours.png" alt="Book working hours editor with per-day availability windows" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Tell it when you work once; it does the availability math forever after.
          </p>
        </AnimatedReveal>
      </div>

      {/* Feature highlights */}
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Calendar className="h-6 w-6 text-blue-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/book/</code> — a
              dedicated SPA sharing authentication and the calendar model with Bam, Banter, and Board.
            </p>
          </div>
          <Button href="/book/" variant="primary" size="sm">
            Try Book <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
