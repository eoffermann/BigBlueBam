import {
  GitBranch,
  Layers,
  MessageSquare,
  Workflow,
  ListChecks,
  Bot,
  Network,
  ArrowRight,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: GitBranch,
    title: 'A typed graph, not a blob',
    description:
      'Every node and edge is a real row in a real table — styled, nested, searchable across diagrams, and addressable by ID. Diagrams you can query, not just stare at.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Layers,
    title: 'ELK auto-layout',
    description:
      'The Eclipse Layout Kernel untangles your spaghetti in one click — layered, force-directed, tree, or grid. Pinned nodes stay put; everything else snaps into line.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: MessageSquare,
    title: 'Comments, People & History',
    description:
      'Three panels right on the canvas: comments anchored to a node or the whole diagram, per-diagram collaborators at owner/editor/commenter/viewer roles, and a version timeline you can browse and roll back.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Workflow,
    title: 'Mermaid in, Mermaid out',
    description:
      'Export to Mermaid or JSON for embedding in Brief and Beacon docs — and import a Mermaid block straight back into an editable graph. The round trip actually round-trips.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: ListChecks,
    title: 'Promote to Bam tasks',
    description:
      'Turn a single node — or a whole graph — into Bam tasks with back-links, or generate a diagram from a project’s tasks. The picture and the work stay in two-way sync.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Bot,
    title: 'AI builds the diagram',
    description:
      '36 MCP tools let an agent draft a diagram from a process description, lay it out, and link nodes to entities in one go. Try blueprint_add_node, blueprint_apply_layout, and blueprint_generate_from_bam — alongside you, not instead of you.',
    color: 'bg-indigo-100 text-indigo-600',
  },
];

export function BlueprintSection() {
  return (
    <SectionWrapper id="blueprint" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Your diagram died the moment you drew it
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            A flowchart, an org chart, an ERD — the instant it's finished it's a dead picture, stuck
            in yet another diagramming subscription, that no automation and no AI can actually read
            or rebuild. Blueprint stores each one as a typed graph of nodes and edges instead of an
            opaque image, with one-click ELK auto-layout and Mermaid import and export — so an agent
            can build, query, and rewrite the diagram with the same authority as a person, and any
            node can become a task in Bam.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/blueprint/light/02-diagram-editor.png"
          alt="Blueprint editor with a laid-out node graph, inspector, and top toolbar"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          A canvas with a shape palette, an inspector, and a one-click layout that does the tidying
          for you.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/blueprint/light/06-comments-collaboration.png"
            alt="Blueprint Comments panel open with threaded comments anchored to nodes"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Comments, People, and History — pinned to the node they’re actually about.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/blueprint/light/01-diagram-list.png"
            alt="Blueprint diagram library grouped by type with starred and archived filters"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            A tidy library, sorted by type — star the ones you live in, archive the rest.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/blueprint/light/03-new-diagram-dialog.png"
            alt="Blueprint new-diagram dialog with type, project, visibility, and template options"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Pick a type, a visibility, and a starting template. Blank canvas is always an option.
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

      {/* CTA bar */}
      <AnimatedReveal delay={0.3}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-sky-50 to-indigo-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Network className="h-6 w-6 text-sky-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/blueprint/</code> — a
              dedicated SPA sharing authentication and the project model with Bam, Beacon, Brief,
              Bond, Bearing, and Board.
            </p>
          </div>
          <Button href="/blueprint/" variant="primary" size="sm">
            Try Blueprint <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
