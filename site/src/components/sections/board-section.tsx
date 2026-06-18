import {
  PenTool,
  ArrowRight,
  Maximize2,
  Users,
  StickyNote,
  Layers,
  History,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Maximize2,
    title: 'Infinite Canvas',
    description:
      'An Excalidraw-powered canvas with sticky notes, shapes, connectors, frames, freehand drawing, text, and images. Zoom out as far as the idea goes; it never runs out of room.',
    color: 'bg-cyan-100 text-cyan-600',
  },
  {
    icon: Users,
    title: 'Real-Time + Audio',
    description:
      'Multi-user editing with live cursors, presence, and reconnect replay — plus a LiveKit voice huddle right on the board, so you can talk while you draw without opening another tab.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: StickyNote,
    title: 'Sticky-to-Task',
    description:
      'Promote brainstorm stickies straight into tracked Bam tasks in the project and phase you name, linked back to the source notes. The wall of ideas becomes a backlog by Monday.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Layers,
    title: 'Live Embeds',
    description:
      'Drop Bam tasks, Beacon articles, Brief docs, and Bearing goals onto the canvas as live cards — the workshop sits next to the work it is about, not a screenshot of it.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: History,
    title: 'Templates & Version History',
    description:
      'Start from retro, brainstorm, planning, architecture, or strategy templates. Save a named snapshot before a big change, and restore it later when "before" turns out to be better.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: Bot,
    title: 'AI Canvas Reading',
    description:
      '40 MCP tools let AI agents read and summarize the canvas, drop stickies and text, arrange shapes, and run the sticky-to-task pipeline — board_add_sticky, board_promote_to_tasks, board_read_elements, and more.',
    color: 'bg-emerald-100 text-emerald-600',
  },
];

export function BoardSection() {
  return (
    <SectionWrapper id="board" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Where good ideas go to get organized
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            An infinite-canvas whiteboard for brainstorming, diagramming, and live planning — with
            real-time multi-user editing, a built-in voice huddle, and a sticky-to-task pipeline that
            turns a wall of ideas into tracked work on the Bam board. It shares your login and projects
            with the rest of the suite, and 40 MCP tools let an AI agent read the canvas, add shapes,
            and promote stickies to tasks right alongside you.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot — the signature populated canvas */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/board/light/02-canvas-populated.png"
          alt="Board infinite canvas populated with sticky notes, shapes, and freehand sketches"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A canvas that earns its keep — sticky notes, sketches, and shapes, no real-estate limit in sight.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/board/light/01-all-boards.png"
            alt="Board library showing all whiteboards"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Every board in one library — starred, archived, and scoped to the project it belongs to.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/board/light/03-templates.png"
            alt="Board template picker with retro, brainstorm, planning, and architecture options"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Templates for retros, brainstorms, planning, and architecture — skip the blank-page stare.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/board/light/04-version-history.png"
            alt="Board version history with named snapshots to restore"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Named snapshots you can roll back to, for when "before" turns out to be better.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <PenTool className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/board/</code> — a
              dedicated SPA sharing authentication and the project model with Bam, Beacon, Brief, Bolt, Bearing, and Bond.
            </p>
          </div>
          <Button href="/board/" variant="primary" size="sm">
            Try Board <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
