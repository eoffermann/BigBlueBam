import {
  Activity,
  ArrowRight,
  Radio,
  Filter,
  BellRing,
  Wand2,
  Timer,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Radio,
    title: 'Ingest that just takes JSON',
    description:
      'Embed one write-only ingest key, POST any JSON report over a bearer token, and Blip discovers the report types and fields for you. No schema to declare, no SDK to bless. A single object, an array, or NDJSON all land the same way.',
    color: 'bg-sky-100 text-sky-600',
  },
  {
    icon: Activity,
    title: 'Live streaming log viewer',
    description:
      'Open the viewer next to your running app and watch entries stream in over WebSocket, with backfill, cursor resume, and server-side filtering. It is the tail -f you always wanted, minus the SSH session and the squinting.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Filter,
    title: 'Saved views + field indexing',
    description:
      'An auto-maintained field catalog means the columns you care about are already indexed, so filters are fast instead of hopeful. Pin a recurring filter as a saved view and stop retyping the same query every incident.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: BellRing,
    title: 'Watches, not a firehose',
    description:
      'Match a single slow frame or a window aggregate like an error spike, and Blip emits a throttled Bolt event, routed straight into a Banter channel. You get the alert that matters, not a per-entry pager storm at 3am.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: Wand2,
    title: 'Transforms + retention',
    description:
      'Edge PII transforms (drop, mask, hash, truncate) scrub sensitive fields before anything is stored, and per-app retention defaults to 14 days that never silently grows unbounded. Your telemetry stays lean and your legal team stays calm.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Bot,
    title: 'Agent-native telemetry',
    description:
      '38 MCP tools let AI agents declare apps, mint keys, query and cursor-tail entries, manage watches and views, freeze collections, and stitch timelapses, all under heartbeat and agent-policy gating with a can_access visibility preflight.',
    color: 'bg-purple-100 text-purple-600',
  },
];

export function BlipSection() {
  return (
    <SectionWrapper id="blip" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            Newest
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Your logs, out of the text file nobody reads
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Somewhere your app is writing log lines into a file that will be rotated away, unread,
            before anyone opens it. Blip is app-telemetry recording for your own software:
            declare an app, embed an ingest key, and POST JSON over a bearer token. Then watch it
            stream live, query the history, index the fields, set watches on the patterns that hurt,
            transform out the PII, and freeze a collection when you need it forever. It is
            observability that did not require a second mortgage, and 38 MCP tools let an agent
            instrument and interrogate your runtime as naturally as it files a task.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/blip/light/live-viewer.png"
          alt="Blip live streaming log viewer tailing telemetry entries in real time"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The live viewer: entries stream in over WebSocket as your app runs, filterable on the fly.
        </p>
      </AnimatedReveal>

      {/* Detail screenshots */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/blip/light/watch-management.png"
            alt="Blip watch management defining match and window-aggregate alert conditions"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Watches: turn a slow frame or an error spike into one throttled alert, not a pager storm.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2} withScale>
          <FloatingFrame
            src="/screenshots/blip/light/transform-editor.png"
            alt="Blip transform editor configuring edge PII redaction rules"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Transforms: drop, mask, hash, or truncate PII at the edge, before anything is stored.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.25} withScale>
          <FloatingFrame
            src="/screenshots/blip/light/saved-views.png"
            alt="Blip saved views listing reusable telemetry filters"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            Saved views over an indexed field catalog: pin the filter, stop retyping the query.
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
            <Timer className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/blip/</code>, with ingest
              at <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">POST /blip/ingest/v1</code>,
              a live WebSocket tail, and one-click timelapse to Bin.
            </p>
          </div>
          <Button href="/blip/" variant="primary" size="sm">
            Try Blip <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
