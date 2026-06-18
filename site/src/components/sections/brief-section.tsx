import {
  FileText,
  ArrowRight,
  LayoutTemplate,
  Bot,
  PenTool,
  History,
  MessageSquare,
  Link2,
  GraduationCap,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: PenTool,
    title: 'Rich-Text Editor',
    description:
      'A Tiptap editor with headings, tables, code blocks, images, highlights, task lists, and slash commands. A live word count and Table of Contents keep long documents honest.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: LayoutTemplate,
    title: 'Templates',
    description:
      'Start from a pre-built shape — meeting notes, project briefs, RFCs, post-mortems, status reports — instead of a blinking cursor and good intentions.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: History,
    title: 'Version History',
    description:
      'Numbered snapshots of every document, with one-click rollback. The draft you liked better on Tuesday is still right there.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: MessageSquare,
    title: 'Comments & Review',
    description:
      'Threaded, text-anchored comments you can reply to and resolve. Feedback lands on the exact sentence it is about, not in a separate doc nobody reads.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Link2,
    title: 'Linked to the Work',
    description:
      'Link a document to its Bam tasks for requirements and specs, and to Beacon articles for related knowledge. The spec and the backlog finally know about each other.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: GraduationCap,
    title: 'Promote to Beacon',
    description:
      'When a document graduates from working draft to lasting knowledge, send it to your Beacon knowledge base in one step. No copy-paste, no second source of truth.',
    color: 'bg-emerald-100 text-emerald-600',
  },
];

export function BriefSection() {
  return (
    <SectionWrapper id="brief" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Docs that grow up to be knowledge
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            A real-time collaborative editor that lives alongside your board, not in a separate
            wiki you forget exists. Brief gives you rich text, templates, threaded comments, and
            version history — then lets the documents that matter graduate into Beacon. Link a doc
            to its Bam tasks, search across the suite, and let agents author and tidy it through 48
            MCP tools.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshots */}
      <div className="grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.1} withScale>
          <FloatingFrame src="/screenshots/brief/light/01-home.png" alt="Brief home with recent documents and quick-create actions" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Home base — recent documents, review counts, and a New Document button that doesn't make you hunt for it.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/brief/light/02-documents.png" alt="Brief document browser filtered by status" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The full library — filter by status, scan word counts, and see what's still in review.
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

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/brief/light/05-templates.png"
            alt="Brief template library across categories"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            A template for every meeting that should've been a doc — pick one and skip the empty page.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.3} withScale>
          <FloatingFrame
            src="/screenshots/brief/light/06-search.png"
            alt="Brief search across document titles, content, and authors"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Search by title, content, or author — the note you swear you wrote is findable again.
          </p>
        </AnimatedReveal>
      </div>

      {/* AI / MCP callout */}
      <AnimatedReveal delay={0.35}>
        <div className="mt-10 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-900">And yes — agents can do it too</h3>
              <p className="mt-2 text-sm text-zinc-600">
                Brief exposes <span className="font-semibold text-zinc-900">48 MCP tools</span> so an
                AI agent can author, edit, and curate documents the same way you do — create a doc
                (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">brief_create</code>),
                stream content into it
                (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">brief_append_content</code>),
                and graduate the keepers into your knowledge base
                (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">brief_promote_to_beacon</code>) —
                plus comments, versions, links, collaborators, templates, and search.
              </p>
            </div>
          </div>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.45}>
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <FileText className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/brief/</code> — a
              dedicated SPA sharing authentication and the project model with Bam and Beacon.
            </p>
          </div>
          <Button href="/brief/" variant="primary" size="sm">
            Try Brief <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
