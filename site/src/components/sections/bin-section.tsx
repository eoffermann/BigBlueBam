import {
  HardDrive,
  ArrowRight,
  Upload,
  ShieldCheck,
  History,
  FolderTree,
  Table2,
  Bot,
} from 'lucide-react';
import { SectionWrapper } from '@/components/ui/section-wrapper';
import { FloatingFrame } from '@/components/ui/floating-frame';
import { AnimatedReveal } from '@/components/ui/animated-reveal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const features = [
  {
    icon: Upload,
    title: 'Upload anything, no ceremony',
    description:
      'Drag in a 4K master, a spreadsheet, a font, a firmware blob, whatever. Bin writes the bytes straight to object storage (MinIO/S3), no size-limit sad face, no "please contact sales for larger files."',
    color: 'bg-blue-100 text-blue-600',
  },
  {
    icon: ShieldCheck,
    title: 'Virus-scanned on the way in',
    description:
      'Every upload gets scanned before anyone touches it. Clean files go live; suspect files get quarantined. Your teammates never become the reason IT sends another all-hands email.',
    color: 'bg-emerald-100 text-emerald-600',
  },
  {
    icon: History,
    title: 'Versioned, so nothing vanishes',
    description:
      'Re-upload over an existing asset and Bin keeps the old one as a version instead of silently overwriting your afternoon. Roll back, compare, or just sleep better knowing "final_final_v7" was never the plan.',
    color: 'bg-amber-100 text-amber-600',
  },
  {
    icon: FolderTree,
    title: 'Folders and tags that actually scale',
    description:
      'Nest folders however your brain works, tag across the grain, and find things by either. It is the file tree you wanted, minus the shared network drive that mysteriously became read-only in 2019.',
    color: 'bg-rose-100 text-rose-600',
  },
  {
    icon: Table2,
    title: 'Datasets open in a live editor',
    description:
      'CSV, JSON, and YAML open in a real structured-data grid and tree editor with real-time co-editing. Media and 3D models hand off to Bay for review. The right viewer for the right bytes, not a download link and a shrug.',
    color: 'bg-teal-100 text-teal-600',
  },
  {
    icon: Bot,
    title: 'Agent-native storage',
    description:
      '19 MCP tools let agents upload, version, tag, move, and fetch assets, and read or edit structured datasets, so an AI can manage your files with the same authority as a human, gated by a visibility preflight.',
    color: 'bg-purple-100 text-purple-600',
  },
];

export function BinSection() {
  return (
    <SectionWrapper id="bin" dividerTop>
      <AnimatedReveal>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Badge variant="green" className="mb-4">
            New
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            The drive that isn't just a drive
          </h2>
          <p className="mt-4 text-lg text-zinc-600">
            Your files are scattered across a chat thread, a shared drive nobody remembers the
            password to, and someone's Downloads folder. Bin is where they actually live: upload any
            file and it gets virus-scanned, versioned, foldered, and tagged, then opened in the right
            place. Media and 3D models jump straight to Bay for review; datasets open in a live
            grid/tree editor you can co-edit in real time. Bin is also the plumbing the rest of the
            suite stands on, storing the media bytes behind Bay and the capture/export bytes behind
            Blip. 19 MCP tools let an AI agent manage assets and edit datasets as naturally as it
            files a task.
          </p>
        </div>
      </AnimatedReveal>

      {/* Hero screenshot */}
      <AnimatedReveal delay={0.1} withScale>
        <FloatingFrame
          src="/screenshots/bin/light/asset-library.png"
          alt="Bin asset library with folders, tags, and versioned files"
        />
        <p className="mt-3 text-center text-sm text-zinc-500">
          The asset library: folders, tags, versions, and previews, all backed by object storage.
        </p>
      </AnimatedReveal>

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
            <HardDrive className="h-6 w-6 text-primary-600" />
            <p className="text-sm font-medium text-zinc-700">
              Served at{' '}
              <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">/bin/</code>, the object-storage
              backbone that powers Bay and Blip, sharing your platform login.
            </p>
          </div>
          <Button href="/bin/" variant="primary" size="sm">
            Try Bin <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </AnimatedReveal>
    </SectionWrapper>
  );
}
