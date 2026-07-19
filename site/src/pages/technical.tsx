import { motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  Github,
  ShieldCheck,
  Container,
  Database,
  Server,
  Globe,
  Layers,
  Phone,
  Bot,
  ArrowUpRight,
} from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { Button } from '@/components/ui/button';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

/**
 * "Talk nerdy to me": the deep technical page (the landing-page-ultra).
 *
 * Everything the home page deliberately keeps out of the way lives here, in
 * full and unapologetic detail: how agent parity actually works through MCP,
 * the whole self-hosted stack, and the bring-your-own-LLM model. The home page
 * sells the outcome and links here; this page is for the CTO/CAIO and the
 * curious builder who want to see how the sausage is made. No em dashes.
 */

const capabilities = [
  'Project & sprint planning',
  'Task management & bulk operations',
  'Reports & analytics (velocity, burndown, cycle time)',
  'Team collaboration & notifications',
  'Banter messaging (channels, DMs, threads, calls, scheduled posts)',
  'Brief document collaboration & graduation',
  'Bolt workflow automations & runtime observability',
  'Bearing goals & OKR tracking',
  'Board visual collaboration & canvas analysis',
  'Bond CRM pipeline, contact management & dedupe',
  'Helpdesk ticket operations & similar-ticket lookup',
  'Beacon knowledge base & graph search',
  'Blast email campaigns, segments & analytics',
  'Bill invoicing, expenses & revenue reporting',
  'Blank forms, submissions & conditional routing',
  'Book scheduling & mixed-roster availability',
  'Bench analytics dashboards & scheduled reports',
  'Cross-app search, composite views, entity linking',
  'Agent identity, proposals, policies & audit',
  'Platform administration',
];

const stack = [
  { icon: Container, label: 'Docker Compose', description: 'The whole stack, one command to spin up' },
  { icon: Database, label: 'PostgreSQL 16', description: 'Row-level security, JSONB custom fields, partitioned activity log' },
  { icon: Server, label: 'Redis 7', description: 'Sessions, cache, PubSub, job queues' },
  { icon: Layers, label: 'MinIO / S3', description: 'Attachment storage, swap for any S3 provider' },
  { icon: Globe, label: 'nginx', description: 'Single entry point, TLS termination, reverse proxy' },
  { icon: Phone, label: 'LiveKit SFU', description: 'WebRTC media server for Banter voice and video' },
  { icon: Bot, label: 'Voice Agent', description: 'AI voice call participation (STT, LLM, TTS)' },
  { icon: ArrowUpRight, label: 'Horizontal scaling', description: 'Stateless app containers scale freely' },
];

export function TechnicalPage() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-zinc-900 via-zinc-900 to-primary-950 py-20 md:py-28">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(99,102,241,0.25)_0%,_transparent_60%)]" />
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.06]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <a
                href="/"
                className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-400 transition-colors hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to the human-friendly tour
              </a>
              <Badge variant="purple" className="mb-4">
                Talk nerdy to me
              </Badge>
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Okay. Let's talk shop.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-zinc-300">
                You clicked the button, so here is the part the home page keeps out of the way: how
                agent parity actually works, the whole stack you run yourself, and the bring-your-own
                model behind it. We are proud of this part. Pour a coffee.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Full parity through MCP */}
        <SectionWrapper id="mcp-parity">
          <AnimatedReveal>
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <Badge variant="blue" className="mb-4">
                How agents can do real work
              </Badge>
              <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
                Full parity through MCP
              </h2>
              <p className="mt-4 text-lg text-zinc-600">
                When we say agents are teammates, this is what we mean, mechanically.
              </p>
            </div>
          </AnimatedReveal>

          <AnimatedReveal delay={0.1}>
            <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 via-white to-primary-50/30 p-8 md:p-10">
              <div className="grid gap-10 lg:grid-cols-2">
                <div>
                  <h3 className="text-xl font-bold text-zinc-900">One server, every action</h3>
                  <p className="mt-3 text-zinc-600">
                    The built-in Model Context Protocol server exposes 833 structured tools that
                    mirror every UI action across all nineteen apps, plus cross-cutting platform
                    capabilities: agent identity, approval queues, visibility preflight, unified
                    activity, cross-app search, composite views, entity linking, scheduled posts,
                    upserts, attachment metadata, agent policies, and outbound webhooks. AI agents
                    authenticate with scoped API keys, operate under the same role-based permissions
                    as humans, and leave the same audit trail in the activity log. There is no
                    special back door. Same rules as everyone.
                  </p>
                  <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                    <p className="text-sm text-amber-800">
                      <strong>Guardrails built in.</strong> Destructive actions (deleting tasks,
                      completing sprints, removing members) require a two-step confirmation flow with
                      time-limited tokens, for AI agents and humans alike.
                    </p>
                  </div>
                </div>
                <div>
                  <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                    833 MCP tools across 19 apps and the platform
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {capabilities.map((cap) => (
                      <div key={cap} className="flex items-center gap-2 text-sm text-zinc-700">
                        <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                        {cap}
                      </div>
                    ))}
                  </div>
                  <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-900 p-4">
                    <p className="mb-2 text-xs font-medium text-zinc-400">Example: an agent moving a task</p>
                    <pre className="overflow-x-auto text-xs leading-relaxed">
                      <code className="text-primary-300">
{`{
  "tool": "move_task",
  "task_id": "PROJ-142",
  "to_phase": "In Review",
  "comment": "PR merged, moving to review"
}`}
                      </code>
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          </AnimatedReveal>

          {/* Bring your own LLM */}
          <AnimatedReveal delay={0.2}>
            <div className="mt-8 rounded-xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-6 shadow-sm">
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
                  <Bot className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-zinc-900">Bring your own LLM</h3>
                  <p className="mt-1 text-sm text-zinc-600">
                    Configure AI providers at the system, organization, or project level. It supports{' '}
                    <strong>Anthropic</strong>, <strong>OpenAI</strong>, and any{' '}
                    <strong>OpenAI API-compatible endpoint</strong>, including Azure OpenAI, Together
                    AI, Ollama, and local models. API keys are encrypted at rest and never exposed in
                    full. You are not locked to one AI vendor any more than you are locked to us.
                  </p>
                </div>
              </div>
            </div>
          </AnimatedReveal>
        </SectionWrapper>

        {/* The stack */}
        <SectionWrapper id="stack" dividerTop>
          <AnimatedReveal>
            <div className="mx-auto mb-12 max-w-2xl text-center">
              <Badge variant="blue" className="mb-4">
                Self-hosted by design
              </Badge>
              <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
                The whole stack, one command
              </h2>
              <p className="mt-4 text-lg text-zinc-600">
                It all comes up from a single{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm">
                  docker compose up
                </code>
                . Run it on a laptop today and someone else's cloud tomorrow. Nothing here is a black
                box.
              </p>
            </div>
          </AnimatedReveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {stack.map((item, i) => (
              <AnimatedReveal key={item.label} delay={i * 0.06}>
                <div className="flex items-start gap-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900">{item.label}</h3>
                    <p className="mt-0.5 text-sm text-zinc-500">{item.description}</p>
                  </div>
                </div>
              </AnimatedReveal>
            ))}
          </div>

          <AnimatedReveal delay={0.5}>
            <div className="mt-10 rounded-xl border border-zinc-200 bg-zinc-50 p-6">
              <div className="mb-4 flex flex-wrap justify-center gap-2">
                <Badge variant="blue">833 MCP Tools</Badge>
                <Badge variant="blue">19 Apps</Badge>
                <Badge variant="blue">900+ Tests</Badge>
                <Badge variant="blue">MIT License</Badge>
              </div>
              <p className="text-center text-sm text-zinc-600">
                Every application container (the Bam, Banter, Beacon, Bearing, Bench, Bill, Blank,
                Blast, Blueprint, Board, Bolt, Bond, Book, Brief, Bureau, and Helpdesk APIs, plus the
                MCP server, worker, voice agent, and their frontends) is stateless and scales freely.
                The data services (PostgreSQL, Redis, MinIO, Qdrant, LiveKit) swap for managed cloud
                equivalents by changing environment variables only. Your laptop today, someone else's
                cloud tomorrow.
              </p>
            </div>
          </AnimatedReveal>
        </SectionWrapper>

        {/* CTA */}
        <SectionWrapper dark dividerTop className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary-900/20 via-transparent to-primary-800/10" />
          <div className="relative mx-auto max-w-2xl text-center">
            <AnimatedReveal>
              <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Read the whole thing. We mean it.
              </h2>
              <p className="mt-4 text-lg text-primary-200">
                It is open source. Clone it, run it, read every line, and host it wherever you like.
                The deploy guide and the full docs go deeper than this page does.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button href="/deploy" variant="white" size="lg">
                  Deploy guide <ArrowRight className="h-4 w-4" />
                </Button>
                <Button
                  href="https://github.com/eoffermann/BigBlueBam"
                  variant="outline"
                  size="lg"
                  className="!border-primary-400/30 !text-zinc-200 hover:!bg-primary-900/50 hover:!text-zinc-100"
                >
                  <Github className="h-4 w-4" /> View on GitHub
                </Button>
              </div>
            </AnimatedReveal>
          </div>
        </SectionWrapper>
      </main>
      <Footer />
    </div>
  );
}
