import {
  Clapperboard,
  ArrowRight,
  Box,
  MapPin,
  ThumbsUp,
  Link2,
  Gauge,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Box,
    title: 'Actual 3D review',
    description:
      'Drop in an FBX, OBJ, or GLB and Bay converts it to GLB and renders it in a real three.js viewer. Orbit, pan, and zoom the model in the browser, no plugin, no "please install our desktop app," no export dance.',
    color: 'bg-indigo-100 text-indigo-600',
  },
  {
    icon: MapPin,
    title: 'Pins that remember the camera',
    description:
      'Annotations on a 3D model are anchored to the viewpoint you dropped them from. Click one and Bay flies the camera right back to it, so "the shoulder weighting is wrong" lands on the exact angle where the shoulder actually looks wrong.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Gauge,
    title: 'Model stats, no guessing',
    description:
      'Every uploaded model reports its triangle count, materials, and animation clips right in the viewer. Know whether that hero prop is 8k tris or 800k before it wrecks your frame budget.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: ThumbsUp,
    title: 'Decisions, not vibes',
    description:
      'Every reviewer records an explicit verdict per version: Approve, Reject, or Request Changes. The decision log is the single source of truth for "did this actually get signed off," so nobody ships on a maybe.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: Link2,
    title: 'Guest links that keep secrets',
    description:
      'Share a token-gated public review link with a client who has no account and no intention of getting one. A 48-hex path token is the only credential, scoped to exactly one asset, revocable the moment the notes stop being polite.',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: Bot,
    title: 'Agents review like everyone else',
    description:
      '14 MCP tools let an AI agent open an asset, drop frame- or viewpoint-anchored annotations, and record an approve/reject/changes decision through the same identity and audit trail as a human reviewer. No side door, no unsigned notes.',
    color: 'bg-purple-100 text-purple-600',
  },
];

export function BaySection() {
  return (
    <SectionWrapper id="bay" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Spin the model, drop a pin, argue about the shoulder weighting
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Media review usually means a video, a spreadsheet of timecodes, and an email thread that
            loses the plot by reply four. Bay puts the notes on the media: frame, timecode, and
            region annotations on video, per-reviewer approve/reject/request-changes decisions, and
            token-gated guest links for clients who will never make an account. Then it does the
            thing every other review tool punts on: real 3D. Upload an FBX, OBJ, or GLB, and Bay
            renders it in a three.js viewer you can orbit, pan, and zoom, with viewpoint-anchored
            pins that fly the camera back to exactly where the problem lives. 14 MCP tools mean an AI
            agent reviews through the same tools, identity, and audit trail as your art director.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot: the 3D model viewer */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bay/light/model-viewer.png"
          alt="Bay 3D model viewer rendering a GLB in three.js with orbit controls, model stats, and viewpoint-anchored annotations"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The model viewer: orbit/pan/zoom a converted GLB, read the triangle count, and pin notes
          to the camera angle they belong to.
        </p>
      </AnimatedReveal>

      {/* Detail screenshot: review library */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <AnimatedReveal delay={0.15} withScale>
          <FloatingFrame
            src="/screenshots/bay/light/review-library.png"
            alt="Bay review library showing media assets with review status and reviewer decisions"
          />
          <p className="mt-3 text-center text-sm text-zinc-500">
            The review library: every asset, its version, and where it stands in the approve/reject
            pipeline.
          </p>
        </AnimatedReveal>
        <AnimatedReveal delay={0.2}>
          <div className="flex h-full flex-col justify-center gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-8">
            <h3 className="text-xl font-semibold text-zinc-900">Video and 3D, one review surface</h3>
            <p className="text-sm text-zinc-600">
              Frame- and region-scoped notes for video and stills. Camera-anchored pins for 3D
              models. Per-reviewer decisions on both. The client never learns three tools, and you
              never reconcile three inboxes.
            </p>
            <p className="text-sm text-zinc-600">
              Bay leans on Bin for object storage and MinIO/S3 for the bytes, so a 200MB render
              upload is a first-class citizen, not a "please use a file-transfer service" apology.
            </p>
          </div>
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
            <Clapperboard className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bay/</code>, a dedicated
              SPA with token-gated guest review at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bay/r/:token</code>.
            </p>
          </div>
          <Button href="/bay/" variant="primary" size="sm">
            Try Bay <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
