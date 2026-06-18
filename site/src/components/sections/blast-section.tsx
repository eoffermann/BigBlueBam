import {
  Mail,
  ArrowRight,
  Paintbrush,
  Filter,
  Send,
  BarChart3,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Paintbrush,
    title: 'Visual Builder',
    description:
      'Drag-and-drop blocks (heading, text, image, button, columns, social) into email-safe HTML, or drop into raw-HTML mode. Preview at desktop, tablet, and phone widths before anyone hits send.',
    color: 'bg-red-100 text-red-600',
  },
  {
    icon: Mail,
    title: 'Versioned Templates',
    description:
      'Save a house style once and reuse it. Every edit bumps the version automatically, and the footer ships with an unsubscribe link so your sends clear the CAN-SPAM gate.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Filter,
    title: 'Segment Builder',
    description:
      'Saved filters over your Bond CRM contacts (lifecycle stage, lead source, score, location, last contacted) joined with all or any conditions, with a cached match count you can recalculate.',
    color: 'bg-pink-100 text-pink-600',
  },
  {
    icon: Send,
    title: 'Delivery & Tracking',
    description:
      'Open pixels, click redirects, bounce and complaint handling, and org-wide unsubscribe suppression all run on their own. Sends go through one shared platform SMTP relay, with SPF/DKIM/DMARC domain verification.',
    color: 'bg-red-100 text-red-600',
  },
  {
    icon: BarChart3,
    title: 'Analytics',
    description:
      'Opens, clicks, bounces, and unsubscribes roll up per campaign and across the org, with a weekly engagement trend, top-clicked-links table, and a per-recipient delivery log.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Bot,
    title: 'AI Campaign Management',
    description:
      '28 MCP tools let AI agents draft email content, suggest subject lines, build and preview segments, assemble a campaign, and review results, with blast_draft_email_content, blast_suggest_subject_lines, and blast_preview_segment among them. Sends stay gated behind a human by default.',
    color: 'bg-pink-100 text-pink-600',
  },
];

export function BlastSection() {
  return (
    <SectionWrapper id="blast" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="pink" className="mb-4">
            Email Campaigns
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Your email tool has never met your CRM.
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Export a list, re-import it somewhere else, watch the charge climb per contact, and pray
            at the black box that is your deliverability. Blast runs campaigns, templates, segments,
            and delivery analytics on the same stack as Bond, so a segment is built straight from
            real CRM data and the open and click rates land next to the deal. 28 MCP tools let an AI
            agent draft the copy and assemble the send, though the send itself waits for a human by
            default.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame src="/screenshots/blast/light/01-campaigns.png" alt="Blast campaigns list with status and open/click rates" />
        <p className="mt-3 text-center text-sm text-zinc-500">
          Every campaign in one table: status, sent count, and open rates that fill in after the send.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame src="/screenshots/blast/light/04-template-editor.png" alt="Blast template editor with drag-and-drop blocks and live preview" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Build the email with blocks, preview it across devices, and let the version number sort itself out.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame src="/screenshots/blast/light/06-segment-builder.png" alt="Blast segment builder filtering Bond CRM contacts" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Filter Bond contacts into a segment: all conditions, any condition, your call.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame src="/screenshots/blast/light/07-analytics.png" alt="Blast analytics dashboard with open and click rates" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Opens, clicks, bounces, and a weekly trend: the numbers, without the wishful rounding.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.3} withScale>
          <FloatingFrame src="/screenshots/blast/light/02-campaign-new.png" alt="Blast new campaign form with content mode toggle" />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Name it, pick an audience, and choose your content mode: visual, raw HTML, or a saved template.
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
        <div className="mt-10 flex flex-col items-center gap-4 rounded-xl border border-zinc-200 bg-gradient-to-r from-red-50 to-rose-50 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-3">
            <Mail className="h-6 w-6 text-red-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/blast/</code>, a
              dedicated SPA sharing authentication and the contact model with Bond, Bam, and Beacon.
            </p>
          </div>
          <Button href="/blast/" variant="primary" size="sm">
            Try Blast <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
