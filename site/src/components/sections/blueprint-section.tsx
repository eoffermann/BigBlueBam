import { GitBranch, Layers, Workflow, Bot, ArrowRight } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

export function BlueprintSection() {
  return (
    <SectionWrapper id="blueprint" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Diagrams that an agent can read and write
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Blueprint is the structured-diagram product in the BigBlueBam suite. Where Board
            is a freeform whiteboard, Blueprint produces deliberate flowcharts, org charts,
            ERDs, mindmaps, swimlanes, and decision trees with auto-layout — and stores the
            graph as a queryable relational structure so an AI agent can build or refactor a
            whole diagram in a single call.
          </p>
        </div>
      </AnimatedReveal>

      {/* Feature highlights */}
      <AnimatedReveal delay={0.1}>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-sky-100 text-sky-600">
              <GitBranch className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900">Typed graph, not a blob</h3>
            <p className="mt-2 text-sm text-zinc-600">
              Nodes and edges live in relational tables. Every shape, every connection, every
              container is its own auditable row — searchable across diagrams and addressable
              by ID.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
              <Layers className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900">ELK auto-layout</h3>
            <p className="mt-2 text-sm text-zinc-600">
              The Eclipse Layout Kernel arranges layered flowcharts, force-directed graphs,
              radial trees, and rectangle-packed clusters. Pinned nodes stay put; everything
              else snaps into place.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
              <Workflow className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900">Cross-product references</h3>
            <p className="mt-2 text-sm text-zinc-600">
              A node can BE a Bam task, a Beacon entry, a Bond deal, or a Bearing goal.
              "Promote to task" creates a Bam task from a node and back-links it; the diagram
              becomes a live view of the work in flight.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
              <Bot className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900">20 MCP tools</h3>
            <p className="mt-2 text-sm text-zinc-600">
              <code className="rounded bg-emerald-50 px-1 text-xs">blueprint_generate</code>
              {' '}builds a whole diagram from a structured spec or natural-language description
              in one call, then auto-lays it out. Read-only tools surface the graph for context
              in any agent prompt.
            </p>
          </div>
        </div>
      </AnimatedReveal>

      {/* Use-cases */}
      <AnimatedReveal delay={0.2}>
        <div className="mx-auto mt-16 max-w-4xl">
          <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-8 shadow-sm">
            <h3 className="text-xl font-semibold text-zinc-900">What you can build</h3>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-sm font-semibold text-zinc-900">Flowcharts</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Branching processes with decision diamonds, parallelograms, and labeled flow
                  edges. Layered TD/LR layout.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">Org charts</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Reporting hierarchies generated from the org's actual membership in one
                  <code className="ml-1 rounded bg-white/70 px-1 text-xs">blueprint_generate</code>
                  {' '}call.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">Entity-relationship diagrams</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Container nodes with column rows; one-to-one, one-to-many, and many-to-many
                  edge kinds.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">Mindmaps</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Branch-by-branch idea explorations with radial-tree layout, exportable as
                  Mermaid for embedding in Brief and Beacon docs.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">Swimlane processes</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Lane containers partitioning the canvas; nodes lay out into their owner's
                  swimlane.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">Decision trees & architecture diagrams</div>
                <p className="mt-1 text-sm text-zinc-600">
                  Labeled yes/no branches, hexagonal infrastructure nodes, cylinder data
                  stores — same canvas, different shape palettes.
                </p>
              </div>
            </div>
          </div>
        </div>
      </AnimatedReveal>

      {/* CTA */}
      <AnimatedReveal delay={0.25}>
        <div className="mt-12 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-zinc-500">
            Reuses the suite's auth, project visibility, collaborators, comments, and Bolt-event
            stream. No new infrastructure.
          </p>
          <a
            href="/docs"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-600 hover:text-sky-800"
          >
            Read the developer docs <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
