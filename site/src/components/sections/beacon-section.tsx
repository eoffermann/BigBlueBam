import {
  BookOpen,
  ArrowRight,
  Clock,
  Search,
  Bot,
  GitFork,
  History,
  ShieldCheck,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Clock,
    title: 'Knowledge with a shelf life',
    description:
      'Every article carries an expiry date and a freshness signal — Verified recently, Content is stale, Expiring soon, or Needs verification. Verify an article to reset the clock; the rot never sneaks up on you.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Search,
    title: 'Hybrid search',
    description:
      'Find knowledge by meaning, not just keywords. Semantic vectors, tag expansion, link traversal, and a keyword fallback all run together — and each result tells you why it matched.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: GitFork,
    title: 'Knowledge Graph',
    description:
      'Typed links (Related To, Supersedes, Depends On, Conflicts With, See Also) plus implicit tag-affinity edges form a navigable map. Walk neighbors out three hops and see what changed recently.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: ShieldCheck,
    title: 'Fridge Cleanout',
    description:
      'A freshness-focused governance dashboard with Overview, At-Risk, Archived, and Agent Activity tabs. Verify what is about to expire and retire stale articles in bulk — yes, that is really what we named it.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: History,
    title: 'Versioned lifecycle',
    description:
      'Articles move through Draft, Active, Pending Review, Archived, and Retired, with a version snapshot on every edit and per-scope expiry policies for how long knowledge stays trusted.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Bot,
    title: 'Agent-native knowledge',
    description:
      '38 MCP tools let AI agents author, verify, challenge, and idempotently upsert entries by slug, plus run grounding retrieval and traverse the graph — beacon_search_context, beacon_verify, and beacon_upsert_by_slug among them, all gated by a visibility preflight.',
    color: 'bg-purple-100 text-purple-600',
  },
];

export function BeaconSection() {
  return (
    <SectionWrapper id="beacon" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The wiki nobody trusts, fixed
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            The company wiki goes stale the week it's written, search returns either nothing or
            everything, and the one answer you need is stranded three tools away from where you're
            actually working. Beacon is a knowledge base with real full-text and semantic search, a
            typed Knowledge Graph, access policies, and built-in freshness governance — so the answer
            lives next to the work and stops rotting when the facts change. It shares your platform
            login and pulls projects from Bam, and 38 MCP tools let an AI agent read and write
            knowledge as naturally as it files a task.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/beacon/light/01-knowledge-home.png"
          alt="Beacon Knowledge Home with stats, quick actions, and recent activity"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Knowledge Home — total beacons, what is at risk this week, and quick ways in.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/beacon/light/06-search-results.png"
            alt="Beacon hybrid search results with match-source badges"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Search by meaning — and every result owns up to why it matched.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/beacon/light/04-graph-explorer.png"
            alt="Beacon Knowledge Graph explorer showing connected articles"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The Knowledge Graph — how your articles connect, links and shared tags alike.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/beacon/light/05-governance-dashboard.png"
            alt="Beacon Fridge Cleanout governance dashboard with freshness score"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Fridge Cleanout — freshness score, at-risk articles, and what to clear out.
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
            <BookOpen className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/beacon/</code> — a
              dedicated SPA sharing authentication and the project model with Bam.
            </p>
          </div>
          <Button href="/beacon/" variant="primary" size="sm">
            Try Beacon <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
