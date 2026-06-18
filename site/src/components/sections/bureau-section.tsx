import {
  Building,
  ArrowRight,
  Map,
  Radio,
  DoorOpen,
  Mic,
  CalendarClock,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Map,
    title: 'Floors & Rooms',
    description:
      'Lay out your office as floors on a canvas, with rooms you actually walk into — eight types, from a one-person office to a conference room or an open lounge.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: Radio,
    title: 'Live Presence',
    description:
      'A spatial floor map with a dot for every person who is around, their status, and the room they are in. It updates in real time as people move — no roll call required.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: DoorOpen,
    title: 'Knock, Summon & Hunt',
    description:
      'Knock on a closed office, ring one person to your screen, or hunt a teammate and jump to wherever they landed. Every move respects Do Not Disturb and what each person can actually open.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Mic,
    title: 'Built-in Audio',
    description:
      'Every room maps one-to-one to a live audio room, powered by LiveKit. Walk in and your mic connects — with camera, screen share, and an ephemeral room chat right in the docked box.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: CalendarClock,
    title: 'Room Booking',
    description:
      'Reserve a meeting space from the Room booking screen, with open or locked access. The reservation mirrors to a Book event and flips the room private right when your slot starts.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: Bot,
    title: 'AI Occupants',
    description:
      '37 MCP tools make agents first-class occupants: they read live presence, set status, locate people, knock, summon, and book rooms — bureau_set_status, bureau_book_room, bureau_locate_user — under the same permission checks as everyone else.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BureauSection() {
  return (
    <SectionWrapper id="bureau" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="new" className="mb-4">
            New · Virtual Office
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Your office, minus the commute
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Bureau gives a remote team the feel of a shared office: floors laid out on a map, rooms
            you walk into, and a live dot for everyone who is around. Where chat tells you what was
            said, Bureau tells you who is here and whether you can interrupt them — and a presence
            widget follows you into every other app in the suite. 37 MCP tools mean an AI agent can
            occupy the floor, locate a teammate, or book a room as naturally as you can.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame src="/screenshots/bureau/light/02-live-floor.png" alt="Bureau live floor map with rooms and occupant dots" />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A floor map where the dots are real people — click a room to walk in, audio and all.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/bureau/light/01-floor-directory.png" alt="Bureau floor directory with live occupancy counts" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Every floor at a glance, with live head counts so you know where the day is happening.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame src="/screenshots/bureau/light/08-presence-on-floor.png" alt="Bureau presence and status on the floor map" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Status and room for each person, updating live — no "you around?" pings needed.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame src="/screenshots/bureau/light/06-room-booking.png" alt="Bureau room booking screen with upcoming reservations" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Bookable rooms by floor — pick a window, lock the door, done.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-violet-50 to-indigo-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Building className="h-6 w-6 text-violet-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bureau/</code> — a
              dedicated SPA sharing authentication and the project model with the rest of the suite.
            </p>
          </div>
          <Button href="/bureau/" variant="primary" size="sm">
            Try Bureau <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
