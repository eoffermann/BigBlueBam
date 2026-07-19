import {
  GitMerge,
  ArrowRight,
  Fingerprint,
  ScanSearch,
  Gauge,
  ListChecks,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Fingerprint,
    title: 'One golden record per customer',
    description:
      'Bond contact, Bill client, Helpdesk requester, Book attendee: Braid clusters every app\'s copy of the same person or company into a single golden profile with a stable id, so "how many customers do we have" finally has one honest answer.',
    color: 'bg-indigo-100 text-indigo-700',
  },
  {
    icon: ScanSearch,
    title: 'AI identity resolution with evidence',
    description:
      'Every proposed link carries a reproducible evidence trail - exact email, exact phone, embedding similarity, and the full weight set that produced the score - so two admins looking at the same candidate see the same number and the same reasons, not a black-box guess.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: GitMerge,
    title: 'Human-in-the-loop merge review',
    description:
      'Confident matches merge automatically; everything else lands in a review queue with a best-effort rationale, where a human clicks merge, split, or reject. No golden record changes without either strong evidence or a person\'s say-so.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: Gauge,
    title: 'Confidence bands (auto-merge / review)',
    description:
      'An exact email or phone match plus a high score auto-merges; a strong-but-uncertain score waits for review; a weak score is quietly suppressed with a cooldown instead of nagging you about the same non-match every night.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: ListChecks,
    title: 'Survivorship rules you control',
    description:
      'When two records disagree on a name, email, or phone, an org-configurable survivorship rule decides the winner and keeps the losing value in the evidence trail, so a merge never silently throws data away.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Bot,
    title: 'Built for agents (13 MCP tools)',
    description:
      '13 MCP tools, led by the flagship braid_resolve, let an agent look up any record\'s golden id, read a profile, or propose a merge with the same identity and audit trail as a human reviewer. Merges and splits stay behind a confirm token.',
    color: 'bg-rose-100 text-rose-600',
  },
];

export function BraidSection() {
  return (
    <SectionWrapper id="braid" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            One customer, one record - across every app
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            The same person is a Bond contact, a Bill client, and a dozen different Book event
            attendees - and nothing in the stack has ever decided they are one person. Braid is the
            identity-resolution layer under the whole suite: an AI core that clusters those scattered
            rows into one confidence-scored golden profile per real person or company, attaches an
            evidence trail to every link, and routes anything uncertain to a human reviewer before it
            touches the truth. The flagship braid_resolve tool hands every other app the same golden
            id, so a customer count, a campaign audience, or an invoice-to-deal rollup means the same
            thing everywhere.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: the golden-profile catalog. */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/braid/light/catalog.png"
          alt="The Braid golden-profile catalog listing resolved customer records with confidence scores"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The profile catalog: one golden record per customer, with confidence scores and a live
          identity count.
        </p>
      </AnimatedReveal>

      <AnimatedReveal delay={0.13} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/braid/light/detail.png"
            alt="A Braid golden profile detail view showing merged identities, evidence, and survivorship-resolved attributes"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Profile detail: every source identity that was merged in, the evidence that justified
            each link, and which value won under your survivorship rules.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.15} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/braid/light/review-queue.png"
            alt="The Braid merge review queue listing pending candidates with match scores awaiting a human decision"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The review queue: candidates below the auto-merge threshold wait here, with a
            best-effort rationale, until a human merges, splits, or rejects them.
          </p>
        </div>
      </AnimatedReveal>

      {/* Dark-mode catalog: the whole suite is theme-aware. */}
      <AnimatedReveal delay={0.18} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/braid/dark/catalog.png"
            alt="The Braid profile catalog in dark mode, with readable confidence badges"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Light or dark, on the same shared shell as every other app in the suite.
          </p>
        </div>
      </AnimatedReveal>

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
            <GitMerge className="h-6 w-6 text-indigo-700" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/braid/</code>,
              the identity layer under Bond, Bill, Helpdesk, and Book: Braid decides who's who so
              every other app doesn't have to guess.
            </p>
          </div>
          <Button href="/braid/" variant="primary" size="sm">
            Try Braid <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
