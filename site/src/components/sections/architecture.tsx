import { Container, Database, Server, Globe, Layers, ArrowUpRight, Phone, Bot } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';

const stack = [
  { icon: Container, label: 'Docker Compose', description: 'The whole stack, one command to spin up' },
  { icon: Database, label: 'PostgreSQL 16', description: 'RLS, JSONB, partitioned tables' },
  { icon: Server, label: 'Redis 7', description: 'Sessions, cache, PubSub, job queues' },
  { icon: Layers, label: 'MinIO / S3', description: 'Attachment storage, swap for any S3 provider' },
  { icon: Globe, label: 'nginx', description: 'Single entry point, TLS termination, reverse proxy' },
  { icon: Phone, label: 'LiveKit SFU', description: 'WebRTC media server for Banter voice/video' },
  { icon: Bot, label: 'Voice Agent', description: 'AI voice call participation (STT/LLM/TTS)' },
  { icon: ArrowUpRight, label: 'Horizontal Scaling', description: 'Stateless app containers scale freely' },
];

export function Architecture() {
  return (
    <SectionWrapper id="architecture" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Self-hosted. One command.
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Your data, your infrastructure. The entire platform runs from a single{' '}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm font-mono">
              docker compose up
            </code>{' '}
            with no vendor lock-in.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {stack.map((item, i) => (
          <AnimatedReveal key={item.label} delay={i * 0.075}>
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
            <Badge variant="blue">720+ MCP Tools</Badge>
            <Badge variant="blue">16 Apps</Badge>
            <Badge variant="blue">900+ Tests</Badge>
            <Badge variant="blue">MIT License</Badge>
          </div>
          <p className="text-center text-sm text-zinc-600">
            Application containers (Bam, Banter, Beacon, Bearing, Bench, Bill, Blank, Blast, Blueprint,
            Board, Bolt, Bond, Book, Brief, Bureau, Helpdesk APIs plus the MCP server, worker, voice
            agent, and their frontends) are stateless and scale freely. Data services (PostgreSQL,
            Redis, MinIO, Qdrant, LiveKit) can be swapped for managed cloud equivalents by changing
            environment variables only — your laptop today, someone else's cloud tomorrow.
          </p>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
