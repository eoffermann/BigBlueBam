import {
  ShieldCheck,
  ArrowRight,
  ScrollText,
  CalendarClock,
  BellRing,
  FileSignature,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: ScrollText,
    title: 'Reads your contracts, cites the clause',
    description:
      'Bulwark ingests your executed contracts and extracts a clause-cited ledger of every obligation - notice windows, renewals, insurance and COI requirements, retention periods, lien deadlines. Every entry links back to the exact language it came from, so nothing is a black-box assertion.',
    color: 'bg-emerald-100 text-emerald-700',
  },
  {
    icon: CalendarClock,
    title: 'A live, monitored obligation calendar',
    description:
      'Dense PDFs become a timezone-correct deadline calendar. Auto-renewal opt-out windows, cure periods, certificate-of-insurance renewals, and lien filing dates all land on one timeline instead of hiding on page 34 of an MSA nobody reopens.',
    color: 'bg-teal-100 text-teal-700',
  },
  {
    icon: BellRing,
    title: 'Watches the work you actually do',
    description:
      'Bulwark watches your real project, billing, and scheduling activity across the suite, so an obligation tied to a milestone, an invoice, or a booking fires when the underlying thing happens - not just on a fixed date a human forgot to set.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: FileSignature,
    title: 'AI-drafted notices, human-approved',
    description:
      'When a deadline nears, Bulwark pre-drafts the notice - the renewal opt-out, the COI request, the lien warning - and routes it to a human approval queue. Nothing is ever sent automatically; a person reviews and approves before anything leaves the building.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: ShieldCheck,
    title: 'Never miss a contractual deadline again',
    description:
      'The obligations that cost you money are the quiet ones: the notice you had to give 60 days out, the certificate that lapsed, the renewal that auto-extended because nobody opted out. Bulwark turns those into monitored, alerting line items you can see coming.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: Bot,
    title: 'Built for agents (16 MCP tools)',
    description:
      '16 MCP tools let an AI agent read the obligation ledger, trace a deadline back to its clause, and draft a notice with the same identity and audit trail as a human - while every send stays behind the human approval queue and a confirm token.',
    color: 'bg-rose-100 text-rose-600',
  },
];

export function BulwarkSection() {
  return (
    <SectionWrapper id="bulwark" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Never miss a contractual deadline again
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-zinc-600">
            Every executed contract is a stack of quiet obligations - a notice you owe 60 days out, a
            certificate of insurance that has to stay current, a renewal that auto-extends unless
            someone opts out, a lien deadline that does not forgive a late filing. Bulwark is the
            AI contract-obligation monitor: it reads your signed contracts, extracts a clause-cited
            ledger of every obligation, watches your real project, billing, and scheduling activity,
            and fires timezone-correct deadline alerts with AI-drafted, human-approved notices before
            anything is sent. It turns dense contracts into a live, monitored obligation calendar,
            sized for a contractor or engagement of two to fifty seats.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: the clause-cited obligation ledger. */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bulwark/light/ledger.png"
          alt="The Bulwark obligation ledger listing extracted contract obligations with deadlines and clause citations"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The obligation ledger: every notice window, renewal, COI requirement, retention period, and
          lien deadline extracted from your contracts, each cited back to its clause.
        </p>
      </AnimatedReveal>

      <AnimatedReveal delay={0.13} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bulwark/light/obligation-detail.png"
            alt="A Bulwark obligation detail view showing the deadline, the source clause it was extracted from, and the watched activity that drives it"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Obligation detail: the deadline, the exact contract language it came from, and the real
            project, billing, or scheduling activity Bulwark is watching to trigger it.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.15} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bulwark/light/approval-queue.png"
            alt="The Bulwark approval queue listing AI-drafted notices awaiting a human decision before they are sent"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The approval queue: AI-drafted notices - renewal opt-outs, COI requests, lien warnings -
            wait here for a human to review and approve before anything is sent.
          </p>
        </div>
      </AnimatedReveal>

      {/* Dark-mode radar: a distinct dark view; the whole suite is theme-aware. */}
      <AnimatedReveal delay={0.18} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bulwark/dark/radar.png"
            alt="The Bulwark deadline radar in dark mode, with live countdowns on armed obligation clocks"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The deadline radar in dark mode, on the same shared shell as every other app in the suite.
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
            <ShieldCheck className="h-6 w-6 text-emerald-700" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bulwark/</code>,
              the obligation watchtower over Bam, Bill, and Book: Bulwark reads the contract so your
              deadlines stop hiding in it.
            </p>
          </div>
          <Button href="/bulwark/" variant="primary" size="sm">
            Try Bulwark <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
