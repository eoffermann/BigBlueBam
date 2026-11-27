import {
  Castle,
  ArrowRight,
  Moon,
  ListChecks,
  Wrench,
  FileQuestion,
  DoorOpen,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { APP_TOOL_COUNTS } from '@/lib/facts';

// Screenshots are the numbered files the docs-capture bridge writes from
// packages/docs-capture/recipes/bastion/bastion.yaml (GILLIGAN workspace only),
// synced to site/public/screenshots/bastion/{light,dark}/ by the docs publish stage.
const features = [
  {
    icon: Moon,
    title: 'Checks every night, from what actually happened',
    description:
      'Bastion maps one shared control library to SOC 2 and ISO 27001, then checks each control every night against what really happened in the suite: who signed in with two-step verification, which merges were reviewed, which keys are past their replacement date. Every result is written to a tamper-evident evidence ledger, sealed daily, so the proof is there when the auditor asks for it.',
    color: 'bg-stone-100 text-stone-700',
  },
  {
    icon: ListChecks,
    title: 'Four numbers, never blended',
    description:
      'Readiness keeps four numbers apart: proven by the suite, proven by evidence you provided, not met (with the risks you accepted counted separately), and what nothing can prove yet. Controls nobody has set up are shown beside them, not hidden in a percentage. You always know which green came from a machine and which came from a file someone uploaded.',
    color: 'bg-blue-100 text-blue-700',
  },
  {
    icon: Wrench,
    title: 'The top gap, with the fix already drafted',
    description:
      'What to fix first ranks the controls nothing can prove yet by how much each one matters to your business, and drafts a fix for each: a Bam task for the control owner, or a request for the evidence that is missing. A person approves it in the review queue before anything is filed. When a risk is accepted instead, the reason, the owner and the expiry date stay on the control.',
    color: 'bg-amber-100 text-amber-700',
  },
  {
    icon: FileQuestion,
    title: 'Questionnaires answered from proof, not hope',
    description:
      'Drop in a customer security questionnaire and Bastion drafts every answer from what it can prove, cites the evidence behind it, and says how sure it is: Sure, Check this, or Needs an expert. It never claims what it cannot prove, and a person approves before anything goes back to the customer, in the customer\'s own spreadsheet layout.',
    color: 'bg-emerald-100 text-emerald-700',
  },
  {
    icon: DoorOpen,
    title: 'A private room for your auditor',
    description:
      'Share readiness with an auditor through a token-gated room with an optional passcode, an expiry and an access log you can read. Restricted evidence stays hidden unless you include it. Build an audit packet with the Statement of Applicability whose contents can be verified against the ledger, and revoke the room the moment the review is over.',
    color: 'bg-violet-100 text-violet-700',
  },
  {
    icon: Bot,
    title: `Built for agents (${APP_TOOL_COUNTS.bastion} MCP tools)`,
    description:
      `${APP_TOOL_COUNTS.bastion} bastion_* MCP tools let an AI agent read readiness and the evidence map, run an evaluation, propose checks, draft fixes and questionnaire answers, and manage feeds and rooms, with the same identity and audit trail as a person. The vouching acts stay human: confirming a check, attesting to a policy, approving a fix or a questionnaire, and opening an auditor room all require a signed-in person, never an API key.`,
    color: 'bg-stone-100 text-stone-700',
  },
];

export function BastionSection() {
  return (
    <SectionWrapper id="bastion" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="default" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Ready for the audit before anyone asks
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-zinc-600">
            A customer wants a security review, a questionnaire lands in your inbox, or the SOC 2
            auditor is on the calendar, and the proof is scattered across a dozen tools and a few
            people&apos;s memories. Bastion is continuous compliance readiness for SOC 2 and ISO
            27001: it checks your controls every night against what actually happened in the suite,
            keeps tamper-evident proof of each result, and tells you first which controls nothing
            can prove yet, with a fix already drafted. Sized for an owner or operations lead at a
            firm of two to fifty seats who has never run an audit before.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: Readiness, the four numbers kept apart. */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bastion/light/01-readiness.png"
          alt="Bastion Readiness: proven by the suite, proven by evidence you provided, not met with risks accepted, and can't prove yet, with not set up yet beside them"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Readiness: four numbers that are never blended into one score, so you can see which proof
          came from the suite and which came from a file someone uploaded.
        </p>
      </AnimatedReveal>

      <AnimatedReveal delay={0.13} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bastion/light/06-what-to-fix-first.png"
            alt="Bastion What to fix first: the controls nothing can prove yet, ranked, each with a drafted fix, and the accepted risks"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            What to fix first: the gaps ranked by how much each one matters, each with a fix
            already drafted for a person to approve.
          </p>
        </div>
      </AnimatedReveal>

      <AnimatedReveal delay={0.15} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bastion/light/04-control-detail.png"
            alt="A Bastion control: its state in plain words, the failing item, the accepted risk with its reason and expiry, and the evidence history"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            A control in detail: the state in plain words, the one item that fails, the risk you
            accepted and why, and every check that ran.
          </p>
        </div>
      </AnimatedReveal>

      {/* Dark-mode Readiness: theme-aware like the rest of the suite. */}
      <AnimatedReveal delay={0.18} withScale>
        <div className="mt-8 mx-auto max-w-3xl">
          <FloatingFrame
            src="/screenshots/bastion/dark/01-readiness.png"
            alt="Bastion Readiness in dark mode, on the same shared shell as every other app in the suite"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Readiness in dark mode, on the same shared shell as every other app in the suite.
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
            <Castle className="h-6 w-6 text-stone-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bastion/</code>,
              reading proof from every app in the suite: Bastion keeps the evidence so the audit is a
              review of what already happened, not a scramble to reconstruct it.
            </p>
          </div>
          <Button href="/bastion/" variant="primary" size="sm">
            Try Bastion <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
