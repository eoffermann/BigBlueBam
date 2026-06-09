/**
 * Export dropdown for the Timeline view. Three PNG variants (at the
 * three native zoom levels), an editable SVG, a generic gantt CSV, an
 * MS Project / GanttProject XML, and TaskJuggler source.
 *
 * The PNG variants ship at three color schemes — priority (default,
 * matches the on-screen view), phase (cycle through a 10-color palette,
 * useful when assignee-grouped charts get visually muddled), and a
 * single-color monochrome (printable). Each variant is rendered fresh
 * from the underlying task data, so the user gets a sharp result
 * regardless of how the on-screen timeline is currently scrolled or
 * zoomed.
 */
import { useState, useRef, useEffect } from 'react';
import { Download, ChevronDown, FileImage, FileText, FileCode, Loader2 } from 'lucide-react';
import type { Phase, Task } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';
import {
  buildGanttSvg,
  svgToPng,
  buildGanttCsv,
  buildMsProjectXml,
  buildTaskJugglerProject,
  downloadBlob,
  slugify,
  type GanttExportOptions,
} from '@/lib/timeline-export';

interface TimelineExportMenuProps {
  phases: (Phase & { tasks: Task[] })[];
  projectName: string;
  groupBy: 'phase' | 'assignee';
}

type PngVariant = {
  label: string;
  filenameSuffix: string;
  opts: Pick<GanttExportOptions, 'zoom' | 'colorScheme' | 'pxPerDay'>;
};

const PNG_VARIANTS: PngVariant[] = [
  { label: 'PNG · Week · Priority colors', filenameSuffix: 'week-priority', opts: { zoom: 'week', colorScheme: 'priority' } },
  { label: 'PNG · Day · Priority colors', filenameSuffix: 'day-priority', opts: { zoom: 'day', colorScheme: 'priority' } },
  { label: 'PNG · Month · Phase colors', filenameSuffix: 'month-phase', opts: { zoom: 'month', colorScheme: 'phase' } },
  { label: 'PNG · Week · Phase colors', filenameSuffix: 'week-phase', opts: { zoom: 'week', colorScheme: 'phase' } },
  { label: 'PNG · Week · Monochrome (print)', filenameSuffix: 'week-mono', opts: { zoom: 'week', colorScheme: 'monochrome' } },
];

export function TimelineExportMenu({ phases, projectName, groupBy }: TimelineExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const slug = slugify(projectName);
  const stamp = new Date().toISOString().split('T')[0];

  async function exportPng(variant: PngVariant) {
    setBusy(variant.filenameSuffix);
    try {
      const { svg, width, height } = buildGanttSvg(phases, {
        projectName,
        groupBy,
        showTodayMarker: true,
        ...variant.opts,
      } as GanttExportOptions);
      const blob = await svgToPng(svg, width, height, 2);
      downloadBlob(blob, `${slug}-timeline-${variant.filenameSuffix}-${stamp}.png`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  function exportSvg() {
    setBusy('svg');
    try {
      const { svg } = buildGanttSvg(phases, {
        projectName,
        groupBy,
        zoom: 'week',
        colorScheme: 'priority',
        showTodayMarker: true,
      });
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      downloadBlob(blob, `${slug}-timeline-${stamp}.svg`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  function exportCsv() {
    setBusy('csv');
    try {
      const csv = buildGanttCsv(phases, projectName);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `${slug}-gantt-${stamp}.csv`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  function exportMspdi() {
    setBusy('xml');
    try {
      const xml = buildMsProjectXml(phases, projectName);
      const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      downloadBlob(blob, `${slug}-msproject-${stamp}.xml`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  function exportTjp() {
    setBusy('tjp');
    try {
      const tjp = buildTaskJugglerProject(phases, projectName);
      const blob = new Blob([tjp], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `${slug}-taskjuggler-${stamp}.tjp`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
      >
        <Download className="h-3.5 w-3.5" />
        Export
        <ChevronDown className="h-3 w-3 text-zinc-400" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl z-50 py-1 max-h-[80vh] overflow-y-auto text-sm">
          <SectionLabel>Raster (PNG)</SectionLabel>
          {PNG_VARIANTS.map((v) => (
            <Row
              key={v.filenameSuffix}
              icon={<FileImage className="h-3.5 w-3.5" />}
              busy={busy === v.filenameSuffix}
              onClick={() => void exportPng(v)}
            >
              {v.label}
            </Row>
          ))}
          <SectionLabel>Vector / Design</SectionLabel>
          <Row
            icon={<FileImage className="h-3.5 w-3.5" />}
            busy={busy === 'svg'}
            onClick={exportSvg}
          >
            SVG · Illustrator / Inkscape
          </Row>
          <SectionLabel>Gantt tool formats</SectionLabel>
          <Row
            icon={<FileText className="h-3.5 w-3.5" />}
            busy={busy === 'csv'}
            onClick={exportCsv}
          >
            CSV · Instagantt, Smartsheet, sheets
          </Row>
          <Row
            icon={<FileCode className="h-3.5 w-3.5" />}
            busy={busy === 'xml'}
            onClick={exportMspdi}
          >
            XML · MS Project / GanttProject
          </Row>
          <Row
            icon={<FileCode className="h-3.5 w-3.5" />}
            busy={busy === 'tjp'}
            onClick={exportTjp}
          >
            TJP · TaskJuggler source
          </Row>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold text-zinc-400 dark:text-zinc-500 border-t first:border-t-0 border-zinc-100 dark:border-zinc-800 mt-1 first:mt-0">
      {children}
    </div>
  );
}

function Row({
  icon,
  busy,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs',
        busy
          ? 'opacity-60 cursor-wait'
          : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
      )}
    >
      <span className="w-4 inline-flex items-center justify-center shrink-0">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      </span>
      <span className="flex-1 truncate">{children}</span>
    </button>
  );
}
