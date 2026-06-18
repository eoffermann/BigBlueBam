import {
  ClipboardList,
  ArrowRight,
  GitBranch,
  Paperclip,
  MailCheck,
  ShieldCheck,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: ClipboardList,
    title: 'Form Builder',
    description:
      'Drag fields from a palette of 20-plus types — text, email, number, date, select, rating, NPS, file upload, page break — and watch a live preview build itself as you go.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: GitBranch,
    title: 'Conditional Logic',
    description:
      'Show, hide, or skip fields and whole pages based on earlier answers. Respondents only see the questions that actually apply to them.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: Paperclip,
    title: 'Real File Uploads',
    description:
      'File-upload fields store the actual files in object storage, checked by a worker against a type allowlist and size cap. Downloads land right on the responses table.',
    color: 'bg-fuchsia-100 text-fuchsia-600',
  },
  {
    icon: MailCheck,
    title: 'Notify on Submit',
    description:
      'Every submission can email a confirmation to the respondent and a heads-up to your team — and, if you like, drop a note in a Banter channel. No inbox to babysit.',
    color: 'bg-violet-100 text-violet-600',
  },
  {
    icon: ShieldCheck,
    title: 'Sign-In & Domain Gating',
    description:
      'Keep a form public, or require sign-in and lock submissions to an allowed list of email domains. Stack it with per-email, max-response, and expiration limits.',
    color: 'bg-purple-100 text-purple-600',
  },
  {
    icon: Bot,
    title: 'AI Form Operations',
    description:
      '20 MCP tools let AI agents generate a form from a plain-language brief, add and reorder fields, publish it, export submissions, and summarize the free-text answers for you.',
    color: 'bg-fuchsia-100 text-fuchsia-600',
  },
];

export function BlankSection() {
  return (
    <SectionWrapper id="blank" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="purple" className="mb-4">
            Forms
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Where form responses stop dying
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Form answers fall into a tab someone's supposed to read and turn into work — and nobody
            does. Blank is a visual form builder with conditional logic that lives on the same stack
            as the work, so a submission can route straight into it: spin up a Bam task or a Helpdesk
            ticket the moment someone hits Submit, instead of waiting in a sheet forever. And because
            it's all real MCP tools, an agent can read the responses and act on them too.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame src="/screenshots/blank/light/02-form-builder.png" alt="Blank form builder with field palette and live preview" />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Drag a field, see it appear. The preview keeps up with you, not the other way around.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/blank/light/03-form-preview.png" alt="Blank published form preview as a respondent sees it" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            What your respondents actually see — clean, themed, and ready to fill in.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame src="/screenshots/blank/light/04-responses.png" alt="Blank responses table with uploaded-file download links" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Every answer in a table — uploaded files included, one click to download.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame src="/screenshots/blank/light/05-analytics.png" alt="Blank form analytics with submission trend and per-field breakdown" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Totals, a 30-day trend, and per-field breakdowns — no spreadsheet required.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.3} withScale>
          <FloatingFrame src="/screenshots/blank/light/07-access-and-notifications.png" alt="Blank access gating and submission notification settings" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Decide who can submit and who gets pinged — sign-in, allowed domains, and email alerts.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-violet-50 to-purple-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <ClipboardList className="h-6 w-6 text-violet-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/blank/</code> — a
              dedicated SPA sharing authentication and the workspace model with Bam and Beacon.
            </p>
          </div>
          <Button href="/blank/" variant="primary" size="sm">
            Try Blank <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
