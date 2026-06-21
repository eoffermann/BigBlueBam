import { motion } from 'motion/react';
import { Users, Video, MousePointerClick, DoorOpen, Bot } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

const points = [
  {
    icon: Users,
    title: 'See who is here',
    description:
      'Presence travels with you across every app, so you always know who is around and what they are looking at.',
  },
  {
    icon: Video,
    title: 'Ring them in',
    description:
      'Start or join a voice or video huddle in one tap, right from the thing you are working on. No link to send, no meeting to book.',
  },
  {
    icon: MousePointerClick,
    title: 'Work in the same place',
    description:
      'Documents, boards, and diagrams are co-edited live, with everyone\'s cursors and changes appearing as they happen.',
  },
  {
    icon: DoorOpen,
    title: 'A place to be',
    description:
      'Bureau gives the team live floors and rooms to gather in, the way an office does, so a quick question never needs a calendar.',
  },
  {
    icon: Bot,
    title: 'Agents in the room too',
    description:
      'Presence is not just for people. An AI agent can be invited into a call to listen and help.',
  },
];

export function PervasivePresence() {
  return (
    <SectionWrapper id="pervasive-presence" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-12 max-w-3xl text-center">
          <Badge variant="green" className="mb-4">
            Pervasive Presence
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Always together,{' '}
            <span className="text-primary-600">never in a meeting.</span>
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Every BigBlueBam app carries a presence dock, so you can see who you are working with and
            pull them into live voice or video the way you would lean over to their desk. No
            scheduling, no calendar invite, no "can you send a link." Just a tap. The team is
            together even when it is spread across the world.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid items-center gap-12 lg:grid-cols-2">
        {/* The dock, floating */}
        <AnimatedReveal>
          <div className="relative mx-auto max-w-sm">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-primary-100 via-purple-100 to-emerald-100 opacity-70 blur-2xl"
            />
            <motion.img
              src="/screenshots/introduction/light/01-bureau-widget.png"
              alt="The Bureau dock: presence and chat at the top, the Invite, Hunt, and Bring controls for pulling people together, and mic, camera, screen-share, and door controls for the huddle itself."
              width={440}
              height={380}
              loading="lazy"
              className="relative w-full rounded-2xl shadow-2xl ring-1 ring-zinc-900/10"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            />
            <p className="relative mt-4 text-center text-sm text-zinc-500">
              The Bureau dock follows you into every app. Drag it anywhere, collapse it to a bar, or
              ring a teammate without leaving the page.
            </p>
          </div>
        </AnimatedReveal>

        {/* The points */}
        <AnimatedReveal delay={0.1}>
          <div className="space-y-5">
            {points.map((p, i) => (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                className="flex items-start gap-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <p.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-zinc-900">{p.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-600">{p.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </AnimatedReveal>
      </div>

      <AnimatedReveal delay={0.2}>
        <p className="mx-auto mt-12 max-w-2xl text-center text-zinc-600">
          Voice and video here are not a scheduled call or a formal meeting. They are what happens
          when you bump into a colleague in the hall or stop by their desk: a quick question, a
          shared look at the same thing, then back to work.
        </p>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
