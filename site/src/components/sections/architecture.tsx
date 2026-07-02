import { Server, Database, Github, Container, ArrowRight } from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const benefits = [
  {
    icon: Server,
    label: 'Runs on your servers',
    description: 'Your own hardware or your own cloud account. Not ours, unless you want it to be.',
  },
  {
    icon: Database,
    label: 'Your data stays yours',
    description: "It lives in a database you can read and export any time. No “contact sales to leave.”",
  },
  {
    icon: Github,
    label: 'Open source',
    description: 'Read every line, change what you want, and keep running it for as long as you like.',
  },
  {
    icon: Container,
    label: 'One command to start',
    description: 'A single docker compose up brings the whole thing up. No assembly required.',
  },
];

export function Architecture() {
  return (
    <SectionWrapper id="architecture" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Self-hosted. One command. No hostages.
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            A lot of software keeps your data in a format only it can read, then hides "export"
            behind a sales call. Not here. BigBlueBam is open source and runs on your own
            infrastructure, so your data and your stack stay yours. Your laptop today, someone else's
            cloud tomorrow, and your call either way.
          </p>
        </div>
      </AnimatedReveal>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {benefits.map((item, i) => (
          <AnimatedReveal key={item.label} delay={i * 0.08}>
            <div className="flex h-full flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
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

      <AnimatedReveal delay={0.4}>
        <div className="mt-10 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center">
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            <Badge variant="blue">804 MCP Tools</Badge>
            <Badge variant="blue">19 Apps</Badge>
            <Badge variant="blue">900+ Tests</Badge>
            <Badge variant="blue">MIT License</Badge>
          </div>
          <p className="mx-auto max-w-xl text-sm text-zinc-600">
            Want the actual stack: Postgres, Redis, the scaling story, the works? It is all on one
            page, and we are happy to nerd out about it.
          </p>
          <div className="mt-5 flex justify-center">
            <Button href="/technical#stack" variant="outline">
              Talk nerdy to me <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
