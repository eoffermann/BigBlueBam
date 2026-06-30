import { useEffect, useMemo, useState } from 'react';
import {
  Radio,
  Pause,
  Play,
  ChevronDown,
  ChevronRight,
  Film,
  Loader2,
  ImageIcon,
} from 'lucide-react';
import {
  useViews,
  useCreateTimelapse,
  captureUrl,
  type BlipEntry,
  type SavedView,
  type CaptureRef,
  type PredicateTree,
} from '@/hooks/use-blip';
import { useBlipTail } from '@/hooks/use-blip-tail';
import { cn } from '@/lib/utils';

interface LiveViewerPageProps {
  appId: string;
  reportType: string;
}

const RESERVED_COLUMNS: Array<{ key: keyof BlipEntry; label: string }> = [
  { key: 'seq', label: 'seq' },
  { key: 'received_at', label: 'received_at' },
  { key: 'level', label: 'level' },
  { key: 'session_id', label: 'session_id' },
  { key: 'app_version', label: 'app_version' },
  { key: 'platform', label: 'platform' },
  { key: 'elapsed_ms', label: 'elapsed_ms' },
];

const LEVEL_STYLE: Record<string, string> = {
  debug: 'text-zinc-400',
  info: 'text-sky-500',
  warn: 'text-amber-500',
  error: 'text-red-500 font-semibold',
  fatal: 'text-red-600 font-bold',
};

function CaptureThumb({ refKey }: { refKey: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    captureUrl(refKey, true)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [refKey]);

  if (failed) {
    return (
      <div className="h-12 w-12 rounded border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-400">
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  if (!url) {
    return (
      <div className="h-12 w-12 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="capture"
        className="h-12 w-12 rounded border border-zinc-200 dark:border-zinc-700 object-cover hover:ring-2 ring-primary-500"
      />
    </a>
  );
}

function CaptureStrip({ entry }: { entry: BlipEntry }) {
  const captures = (entry.payload?.screen_captures as CaptureRef[] | undefined) ?? [];
  if (entry.capture_count <= 0) return null;
  return (
    <div className="flex items-center gap-2 mt-1">
      {captures.length === 0 ? (
        // Edge stripped base64; worker hasn't stored refs yet (§23.3).
        <span className="text-xs text-zinc-400 italic">
          {entry.capture_count} capture(s) pending…
        </span>
      ) : (
        captures.map((c, i) =>
          c.pending ? (
            <div
              key={i}
              className="h-12 w-12 rounded border border-dashed border-zinc-300 dark:border-zinc-600 flex items-center justify-center text-[10px] text-zinc-400"
            >
              pending
            </div>
          ) : (
            <CaptureThumb key={i} refKey={c.thumb_key || c.object_key} />
          ),
        )
      )}
    </div>
  );
}

function EntryRow({ entry }: { entry: BlipEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer font-mono text-xs"
      >
        <td className="px-2 py-1.5 text-zinc-400">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        {RESERVED_COLUMNS.map((col) => {
          const v = entry[col.key];
          return (
            <td
              key={col.label}
              className={cn(
                'px-2 py-1.5 whitespace-nowrap',
                col.key === 'level' && v ? LEVEL_STYLE[String(v)] ?? '' : 'text-zinc-700 dark:text-zinc-300',
              )}
            >
              {v == null ? <span className="text-zinc-300 dark:text-zinc-600">—</span> : String(v)}
            </td>
          );
        })}
        <td className="px-2 py-1.5 text-zinc-400">
          {entry.capture_count > 0 ? `${entry.capture_count} img` : ''}
        </td>
      </tr>
      {open && (
        <tr className="bg-zinc-50 dark:bg-zinc-900/60">
          <td colSpan={RESERVED_COLUMNS.length + 2} className="px-4 py-2">
            <CaptureStrip entry={entry} />
            <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-950 text-zinc-100 p-3 text-xs">
              <code>{JSON.stringify(entry.payload, null, 2)}</code>
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function LiveViewerPage({ appId, reportType }: LiveViewerPageProps) {
  const views = useViews(appId, reportType);
  const [viewId, setViewId] = useState<string>('');
  const createTimelapse = useCreateTimelapse(appId);
  const [timelapseMsg, setTimelapseMsg] = useState<string | null>(null);

  const activeView: SavedView | undefined = useMemo(
    () => views.data?.data.find((v) => v.id === viewId),
    [views.data, viewId],
  );
  const filter: PredicateTree | null = activeView?.spec.filter ?? null;

  const tail = useBlipTail({
    trackedAppId: appId,
    reportType,
    filter,
    maxEntries: activeView?.spec.pageSize ?? 200,
  });

  const anyCaptures = tail.entries.some((e) => e.capture_count > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Radio className="h-5 w-5 text-primary-500" />
            <span className="font-mono">{reportType}</span>
          </h1>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
              tail.connected
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                tail.connected ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400',
              )}
            />
            {tail.connected ? 'Live' : 'Connecting…'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={viewId}
            onChange={(e) => setViewId(e.target.value)}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
          >
            <option value="">Default view (all reserved columns)</option>
            {views.data?.data.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => tail.setPaused(!tail.paused)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium',
              tail.paused
                ? 'border-emerald-300 text-emerald-700 dark:text-emerald-400'
                : 'border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200',
            )}
          >
            {tail.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {tail.paused ? 'Resume' : 'Pause'}
          </button>

          <button
            type="button"
            disabled={createTimelapse.isPending || !anyCaptures}
            title={anyCaptures ? 'Compile capture-bearing entries into a video' : 'No captures in view'}
            onClick={() => {
              createTimelapse.mutate(
                {
                  report_type: reportType,
                  filter: filter ?? undefined,
                  frame_duration_sec: 0.5,
                  image_selection: 'first',
                },
                {
                  onSuccess: (res) =>
                    setTimelapseMsg(`Timelapse job ${res.data.id} queued (${res.data.status}).`),
                  onError: (err) =>
                    setTimelapseMsg(err instanceof Error ? err.message : 'Failed to queue timelapse.'),
                },
              );
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {createTimelapse.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Film className="h-4 w-4" />
            )}
            Compile to video
          </button>
        </div>
      </div>

      {/* Sampling banner (§8.3) */}
      {tail.droppedPerSec > 0 && (
        <div className="px-6 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-900/40">
          Sampling under load: {tail.droppedPerSec}/sec not shown. The durable store keeps everything.
        </div>
      )}
      {timelapseMsg && (
        <div className="px-6 py-1.5 bg-primary-50 dark:bg-primary-900/20 text-xs text-primary-800 dark:text-primary-300 border-b border-primary-200 dark:border-primary-900/40 flex items-center justify-between">
          <span>{timelapseMsg}</span>
          <button onClick={() => setTimelapseMsg(null)} className="underline">
            dismiss
          </button>
        </div>
      )}
      {tail.error && (
        <div className="px-6 py-1.5 bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300 border-b border-red-200 dark:border-red-900/40">
          {tail.error}
        </div>
      )}

      {/* Stream table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800/80 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-2 py-2 w-6" />
              {RESERVED_COLUMNS.map((c) => (
                <th key={c.label} className="px-2 py-2 font-mono">
                  {c.label}
                </th>
              ))}
              <th className="px-2 py-2">captures</th>
            </tr>
          </thead>
          <tbody>
            {tail.entries.length === 0 ? (
              <tr>
                <td colSpan={RESERVED_COLUMNS.length + 2} className="px-4 py-12 text-center text-sm text-zinc-500">
                  {tail.paused
                    ? 'Paused. Resume to stream live entries.'
                    : 'Waiting for entries… run your instrumented client to see them arrive.'}
                </td>
              </tr>
            ) : (
              tail.entries.map((e) => <EntryRow key={`${e.seq}-${e.id}`} entry={e} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
