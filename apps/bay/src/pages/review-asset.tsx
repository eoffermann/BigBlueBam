import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Box,
  Check,
  Crosshair,
  Download,
  FlagTriangleRight,
  Image as ImageIcon,
  Layers,
  Loader2,
  Music,
  Share2,
  SquareDashedMousePointer,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';
import {
  useAsset,
  useVersions,
  useAnnotations,
  useCreateAnnotation,
  useResolveAnnotation,
  useDecisions,
  useSetDecision,
  useUploadVersion,
  useArchiveAsset,
  useCreateReviewLink,
  binRawUrl,
  type Anchor,
  type BayAnnotation,
  type BayVersion,
  type DecisionValue,
  type MediaKind,
  type MediaMeta,
  type ModelAnimationClip,
  type ViewpointAnchor,
  type ViewpointAnnotation,
} from '@/hooks/use-bay';
import { ModelViewer } from '@/components/model-viewer';
import { useBayRealtime } from '@/hooks/use-bay-realtime';
import { useAuthStore } from '@/stores/auth.store';
import { cn, formatRelativeTime } from '@/lib/utils';
import { MediaKindBadge } from '@/pages/review-library';

interface ReviewAssetPageProps {
  assetId: string;
  onNavigate: (path: string) => void;
}

// Mints a public, token-gated share link and copies it to the clipboard. The
// guest opens it at /bay/r/:token (no login) to view + comment.
function ShareReviewButton({ assetId }: { assetId: string }) {
  const createLink = useCreateReviewLink(assetId);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = (u: string) => {
    navigator.clipboard?.writeText(u).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  const mint = async () => {
    const res = await createLink.mutateAsync({ allow_comments: true });
    setUrl(res.data.url);
    copy(res.data.url);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={createLink.isPending}
        onClick={mint}
        title="Create a public review link"
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 disabled:opacity-60"
      >
        {createLink.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        Share
      </button>
      {url && (
        <div className="absolute right-0 top-full mt-2 z-20 w-80 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-lg">
          <p className="text-xs text-zinc-500 mb-1.5">
            Public review link {copied && <span className="text-emerald-600">· copied!</span>}
          </p>
          <div className="flex gap-1.5">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => copy(url)}
              className="rounded bg-primary-600 hover:bg-primary-700 text-white px-2 py-1 text-xs"
            >
              Copy
            </button>
          </div>
          <button
            type="button"
            onClick={() => setUrl(null)}
            className="mt-2 text-xs text-zinc-400 hover:text-zinc-600"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

type MediaEl = HTMLVideoElement | HTMLAudioElement;

const mediaKindIcon: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  model: Box,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2);
  return `${m}:${r.padStart(5, '0')}`;
}

// Defensive: anchors are opaque JSONB authored by humans, agents, or older
// seeders — never throw on an unexpected shape.
function renderAnchor(anchor: Anchor | null | undefined): string {
  if (!anchor || typeof anchor !== 'object') return 'anchor';
  const a = anchor as Record<string, unknown>;
  switch (a.type) {
    case 'frame': {
      const t = a.time_sec != null ? ` @ ${fmtTime(num(a.time_sec))}` : '';
      return `▶ frame ${num(a.frame)}${t}`;
    }
    case 'timerange': {
      const start = num(a.start_sec ?? a.start);
      const end = num(a.end_sec ?? a.end);
      return `◷ ${fmtTime(start)}–${fmtTime(end)}`;
    }
    case 'region': {
      const box = `▱ region ${Math.round(num(a.x) * 100)}%,${Math.round(num(a.y) * 100)}% ${Math.round(
        num(a.w) * 100,
      )}%×${Math.round(num(a.h) * 100)}%`;
      const t = a.time_sec != null ? ` @ ${fmtTime(num(a.time_sec))}` : '';
      return box + t;
    }
    case 'viewpoint': {
      const surface = a.surface as { mode?: string } | undefined;
      const time = a.time as { frame?: number } | undefined;
      const suffix = time?.frame != null ? ` · f${num(time.frame)}` : '';
      if (surface?.mode === 'geometry') return `◉ spot${suffix}`;
      if (surface?.mode === 'screen') return `▱ spot (screen)${suffix}`;
      return `⊕ viewpoint${suffix}`;
    }
    default:
      return 'anchor';
  }
}

// One annotation row in the rail. Shared by the flat list and the grouped
// (per-clip) model layout.
function AnnotationRow({
  a,
  onAnchorClick,
  onToggleResolve,
  resolving,
}: {
  a: BayAnnotation;
  onAnchorClick: (anchor: Anchor) => void;
  onToggleResolve: () => void;
  resolving: boolean;
}) {
  return (
    <li
      className={cn(
        'rounded-lg border p-3',
        a.resolved
          ? 'border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30 opacity-75'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900',
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <button
          type="button"
          onClick={() => onAnchorClick(a.anchor)}
          title="Jump to this moment / show region"
          className="inline-flex items-center gap-1 rounded-md bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/40 cursor-pointer"
        >
          {renderAnchor(a.anchor)}
        </button>
        <button
          onClick={onToggleResolve}
          disabled={resolving}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50',
            a.resolved
              ? 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              : 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20',
          )}
        >
          <Check className="h-3.5 w-3.5" />
          {a.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      <p className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">{a.body}</p>
      <p className="text-xs text-zinc-400 mt-1.5">
        {a.author_name ?? a.author_id ?? 'Unknown'} · {formatRelativeTime(a.created_at)}
      </p>
    </li>
  );
}

function MetaLabel({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-0.5 text-xs">
      <span className="text-zinc-400">{label}</span>
      <span className="font-medium text-zinc-800 dark:text-zinc-200">{value}</span>
    </span>
  );
}

// Compact triangle count, e.g. 1850000 → "1.85M tris".
function fmtTris(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Model stats from media_meta (§7.5): tris, materials, unit, up-axis.
function ModelMetaChips({ meta }: { meta: MediaMeta }) {
  const tris = meta.counts?.triangles;
  const materials = meta.counts?.materials;
  const unit = meta.source_unit;
  const up = meta.source_up_axis;
  const anims = meta.animations?.length ?? 0;
  return (
    <>
      {tris != null && <MetaLabel label="tris" value={`${fmtTris(tris)} tris`} />}
      {materials != null && <MetaLabel label="materials" value={String(materials)} />}
      {unit && <MetaLabel label="scale" value={`1 unit = 1 ${unit}`} />}
      {up && <MetaLabel label="axis" value={`y-up (src ${up}-up)`} />}
      {meta.has_animation && anims > 0 && (
        <MetaLabel label="animation" value={`${anims} clip${anims === 1 ? '' : 's'}`} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Interactive media stage (drag-select region; reports playback time)
// ---------------------------------------------------------------------------

interface DragRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function MediaStage({
  kind,
  version,
  mediaRef,
  regionMode,
  regionOverlay,
  highlightRegion,
  onRegion,
  onTime,
  modelAnnotations,
  onCaptureViewpoint,
  focusAnchor,
}: {
  kind: MediaKind;
  version: BayVersion | undefined;
  mediaRef: React.MutableRefObject<MediaEl | null>;
  regionMode: boolean;
  regionOverlay: DragRect | null;
  highlightRegion: DragRect | null;
  onRegion: (rect: DragRect) => void;
  onTime: (t: number) => void;
  modelAnnotations: ViewpointAnnotation[];
  onCaptureViewpoint: (anchor: ViewpointAnchor) => void;
  focusAnchor: ViewpointAnchor | null;
}) {
  const Icon = mediaKindIcon[kind] ?? ImageIcon;
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const binId = version?.bin_asset_id ?? null;
  const src = binId ? binRawUrl(binId) : null;
  // Prefer the worker-generated web-friendly proxy for video/audio (reliable
  // seeking + broad codec support); fall back to the original on error. Images
  // serve fine natively. The poster is a still/waveform; it 404s harmlessly
  // before the transcode lands.
  const [useProxy, setUseProxy] = useState(true);
  const poster = binId && kind === 'video' ? binRawUrl(binId, 'poster') : undefined;
  const playableSrc =
    binId && (kind === 'video' || kind === 'audio') && useProxy ? binRawUrl(binId, 'proxy') : src;
  // Region capture is available on spatial media (image always; video only in
  // "draw region" mode so it doesn't fight the native transport controls).
  const regionEnabled = src != null && (kind === 'image' || (kind === 'video' && regionMode));

  useEffect(() => {
    setFailed(false);
    setUseProxy(true);
  }, [binId]);

  // First failure on a proxy → retry with the original; failure on the original
  // → show the placeholder.
  const onMediaError = () => {
    if (useProxy) setUseProxy(false);
    else setFailed(true);
  };

  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const posOf = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const handlers = regionEnabled
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          const p = posOf(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (!drag) return;
          const p = posOf(e);
          setDrag({ ...drag, x1: p.x, y1: p.y });
        },
        onPointerUp: () => {
          if (!drag) return;
          const x = Math.min(drag.x0, drag.x1);
          const y = Math.min(drag.y0, drag.y1);
          const w = Math.abs(drag.x1 - drag.x0);
          const h = Math.abs(drag.y1 - drag.y0);
          setDrag(null);
          if (w > 0.01 && h > 0.01) {
            onRegion({
              x: Number(x.toFixed(4)),
              y: Number(y.toFixed(4)),
              w: Number(w.toFixed(4)),
              h: Number(h.toFixed(4)),
            });
          }
        },
      }
    : {};

  const liveRect = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : regionOverlay;

  const placeholder = (
    <div className="aspect-video w-full bg-zinc-100 dark:bg-zinc-800/50 flex flex-col items-center justify-center gap-3">
      <div className="flex items-center justify-center h-16 w-16 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-primary-500">
        <Icon className="h-8 w-8" />
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {!src
          ? 'No media attached to this version yet — upload one above.'
          : 'Media not available yet (still scanning, or upload incomplete).'}
      </p>
    </div>
  );

  let media: React.ReactNode = placeholder;
  if (src && !failed) {
    if (kind === 'image') {
      // eslint-disable-next-line @next/next/no-img-element
      media = <img src={src} alt="" className="block max-h-[28rem] w-full object-contain bg-zinc-50 dark:bg-zinc-900" onError={() => setFailed(true)} />;
    } else if (kind === 'video') {
      media = (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded review media has no caption track
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={playableSrc ?? undefined}
          poster={poster}
          controls
          onTimeUpdate={(e) => onTime((e.target as HTMLVideoElement).currentTime)}
          className="block w-full max-h-[28rem] bg-black"
          onError={onMediaError}
        />
      );
    } else if (kind === 'audio') {
      media = (
        <div className="aspect-video w-full bg-zinc-100 dark:bg-zinc-800/50 flex flex-col items-center justify-center gap-4 p-6">
          <Icon className="h-10 w-10 text-primary-500" />
          {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded review media has no caption track */}
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={playableSrc ?? undefined}
            controls
            onTimeUpdate={(e) => onTime((e.target as HTMLAudioElement).currentTime)}
            className="w-full max-w-md"
            onError={onMediaError}
          />
        </div>
      );
    } else if (kind === 'model' && binId) {
      media = (
        <ModelViewer
          src={binRawUrl(binId, 'proxy')}
          mediaMeta={version?.media_meta as MediaMeta | null | undefined}
          annotations={modelAnnotations}
          onCaptureViewpoint={onCaptureViewpoint}
          focusAnchor={focusAnchor}
        />
      );
    } else {
      media = (
        <div className="aspect-video w-full bg-zinc-100 dark:bg-zinc-800/50 flex flex-col items-center justify-center gap-3">
          <Icon className="h-8 w-8 text-primary-500" />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">3D preview not supported yet — download to view.</p>
        </div>
      );
    }
  }

  return (
    <div
      ref={boxRef}
      className={cn('relative select-none', regionEnabled && 'cursor-crosshair')}
      {...handlers}
    >
      {media}
      {liveRect && (
        <div
          className="absolute border-2 border-primary-500 bg-primary-500/15 pointer-events-none"
          style={{
            left: `${liveRect.x * 100}%`,
            top: `${liveRect.y * 100}%`,
            width: `${liveRect.w * 100}%`,
            height: `${liveRect.h * 100}%`,
          }}
        />
      )}
      {highlightRegion && (
        <div
          className="absolute border-2 border-amber-400 bg-amber-400/20 pointer-events-none ring-2 ring-amber-400/40"
          style={{
            left: `${highlightRegion.x * 100}%`,
            top: `${highlightRegion.y * 100}%`,
            width: `${highlightRegion.w * 100}%`,
            height: `${highlightRegion.h * 100}%`,
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version stack
// ---------------------------------------------------------------------------

function VersionStack({
  versions,
  activeId,
  onSelect,
}: {
  versions: BayVersion[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <Layers className="h-4 w-4 text-zinc-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Versions</h3>
      </div>
      {versions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-zinc-500">No versions yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {versions.map((v) => {
            const isActive = v.id === activeId;
            return (
              <li key={v.id}>
                <button
                  onClick={() => onSelect(v.id)}
                  className={cn(
                    'flex w-full items-center justify-between px-4 py-2.5 text-sm text-left transition-colors',
                    isActive
                      ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40 text-zinc-700 dark:text-zinc-300',
                  )}
                >
                  <span className="font-medium">v{v.version_number}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">{formatRelativeTime(v.created_at)}</span>
                    {isActive && <Check className="h-4 w-4 text-primary-500" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capture toolbar — media-driven anchor capture
// ---------------------------------------------------------------------------

function CaptureToolbar({
  kind,
  mediaRef,
  fps,
  currentTime,
  regionMode,
  setRegionMode,
  setAnchor,
  markIn,
  setMarkIn,
}: {
  kind: MediaKind;
  mediaRef: React.MutableRefObject<MediaEl | null>;
  fps: number;
  currentTime: number;
  regionMode: boolean;
  setRegionMode: (b: boolean) => void;
  setAnchor: (a: Anchor) => void;
  markIn: number | null;
  setMarkIn: (n: number | null) => void;
}) {
  const now = () => mediaRef.current?.currentTime ?? currentTime;
  const timed = kind === 'video' || kind === 'audio';
  const spatial = kind === 'image' || kind === 'video';

  if (kind === 'model') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
        <Crosshair className="h-3.5 w-3.5" /> use “Remember viewpoint” or “Spot” on the 3D viewer to set the anchor
      </span>
    );
  }

  if (!timed && !spatial) return null;

  const btn =
    'inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {timed && (
        <>
          <span className="text-xs text-zinc-400 tabular-nums">{fmtTime(currentTime)}</span>
          <button
            type="button"
            className={btn}
            onClick={() => {
              const t = now();
              setMarkIn(Number(t.toFixed(2)));
              setAnchor({ type: 'timerange', start_sec: Number(t.toFixed(2)), end_sec: Number(t.toFixed(2)) });
            }}
          >
            <FlagTriangleRight className="h-3.5 w-3.5" /> Mark in
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => {
              const t = Number(now().toFixed(2));
              const start = markIn ?? t;
              setAnchor({ type: 'timerange', start_sec: Math.min(start, t), end_sec: Math.max(start, t) });
            }}
          >
            <FlagTriangleRight className="h-3.5 w-3.5 rotate-180" /> Mark out
          </button>
          {kind === 'video' && (
            <button
              type="button"
              className={btn}
              onClick={() => {
                const t = now();
                setAnchor({ type: 'frame', frame: Math.round(t * fps), time_sec: Number(t.toFixed(2)) });
              }}
            >
              <Crosshair className="h-3.5 w-3.5" /> Capture frame
            </button>
          )}
        </>
      )}
      {kind === 'video' && (
        <button
          type="button"
          aria-pressed={regionMode}
          className={cn(btn, regionMode && 'bg-primary-50 dark:bg-primary-900/20 border-primary-400 text-primary-700 dark:text-primary-300')}
          onClick={() => setRegionMode(!regionMode)}
        >
          <SquareDashedMousePointer className="h-3.5 w-3.5" /> {regionMode ? 'Drawing… drag on video' : 'Draw region'}
        </button>
      )}
      {kind === 'image' && (
        <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
          <SquareDashedMousePointer className="h-3.5 w-3.5" /> drag on the image to select a region
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Annotations panel
// ---------------------------------------------------------------------------

function AnnotationsPanel({
  versionId,
  kind,
  mediaRef,
  fps,
  currentTime,
  regionMode,
  setRegionMode,
  pendingAnchor,
  setPendingAnchor,
  markIn,
  setMarkIn,
  onAnchorClick,
  modelClips,
}: {
  versionId: string | undefined;
  kind: MediaKind;
  mediaRef: React.MutableRefObject<MediaEl | null>;
  fps: number;
  currentTime: number;
  regionMode: boolean;
  setRegionMode: (b: boolean) => void;
  pendingAnchor: Anchor | null;
  setPendingAnchor: (a: Anchor | null) => void;
  markIn: number | null;
  setMarkIn: (n: number | null) => void;
  onAnchorClick: (anchor: Anchor) => void;
  modelClips?: ModelAnimationClip[];
}) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const { data, isLoading, isError, error } = useAnnotations(versionId, includeResolved);
  const create = useCreateAnnotation(versionId);
  const resolve = useResolveAnnotation(versionId);
  const [body, setBody] = useState('');
  const annotations = data?.data ?? [];

  // For model assets, group the rail (§7.4): static/viewpoint notes (no time)
  // first, then per-clip notes grouped by clip_id and sorted by frame.
  const modelGroups = useMemo(() => {
    if (kind !== 'model') return null;
    const timeOf = (a: BayAnnotation) =>
      (a.anchor as { time?: { clip_id?: string | null; frame?: number } })?.time;
    const statics: BayAnnotation[] = [];
    const byClip = new Map<string, BayAnnotation[]>();
    for (const a of annotations) {
      const t = timeOf(a);
      if (!t || t.clip_id == null) {
        statics.push(a);
      } else {
        const list = byClip.get(t.clip_id) ?? [];
        list.push(a);
        byClip.set(t.clip_id, list);
      }
    }
    const clipName = (id: string) => modelClips?.find((c) => c.id === id)?.name ?? id;
    const clipSections = [...byClip.entries()]
      .map(([clipId, list]) => ({
        clipId,
        name: clipName(clipId),
        items: [...list].sort(
          (a, b) =>
            ((a.anchor as { time?: { frame?: number } }).time?.frame ?? 0) -
            ((b.anchor as { time?: { frame?: number } }).time?.frame ?? 0),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { statics, clipSections };
  }, [kind, annotations, modelClips]);

  const submit = () => {
    if (!body.trim() || !versionId || !pendingAnchor) return;
    create.mutate(
      { anchor: pendingAnchor, body: body.trim() },
      {
        onSuccess: () => {
          setBody('');
          setPendingAnchor(null);
          setMarkIn(null);
          setRegionMode(false);
        },
      },
    );
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Annotations</h3>
        <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
            className="rounded border-zinc-300 dark:border-zinc-600"
          />
          Show resolved
        </label>
      </div>

      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError ? (
          <p className="text-sm text-red-500">{error instanceof Error ? error.message : 'Could not load annotations.'}</p>
        ) : annotations.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2">No annotations on this version yet.</p>
        ) : modelGroups ? (
          // Model rail (§7.4): static/viewpoint notes, then per-clip groups.
          <div className="space-y-3">
            {modelGroups.statics.length > 0 && (
              <ul className="space-y-2">
                {modelGroups.statics.map((a) => (
                  <AnnotationRow
                    key={a.id}
                    a={a}
                    onAnchorClick={onAnchorClick}
                    onToggleResolve={() => resolve.mutate({ id: a.id, resolved: !a.resolved })}
                    resolving={resolve.isPending}
                  />
                ))}
              </ul>
            )}
            {modelGroups.clipSections.map((section) => (
              <div key={section.clipId} className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  {section.name}
                </p>
                <ul className="space-y-2">
                  {section.items.map((a) => (
                    <AnnotationRow
                      key={a.id}
                      a={a}
                      onAnchorClick={onAnchorClick}
                      onToggleResolve={() => resolve.mutate({ id: a.id, resolved: !a.resolved })}
                      resolving={resolve.isPending}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {annotations.map((a) => (
              <AnnotationRow
                key={a.id}
                a={a}
                onAnchorClick={onAnchorClick}
                onToggleResolve={() => resolve.mutate({ id: a.id, resolved: !a.resolved })}
                resolving={resolve.isPending}
              />
            ))}
          </ul>
        )}

        {/* Composer */}
        {versionId && (
          <div className="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-700 p-3 space-y-3">
            <CaptureToolbar
              kind={kind}
              mediaRef={mediaRef}
              fps={fps}
              currentTime={currentTime}
              regionMode={regionMode}
              setRegionMode={setRegionMode}
              setAnchor={setPendingAnchor}
              markIn={markIn}
              setMarkIn={setMarkIn}
            />
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-400">Anchor:</span>
              {pendingAnchor ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 font-medium text-primary-700 dark:text-primary-300">
                  {renderAnchor(pendingAnchor)}
                  <button onClick={() => setPendingAnchor(null)} className="ml-1 text-primary-400 hover:text-primary-600" title="Clear anchor">
                    ✕
                  </button>
                </span>
              ) : (
                <span className="text-zinc-400 italic">capture one above (mark in/out, frame, or drag a region)</span>
              )}
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Leave an annotation…"
              rows={2}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30 resize-y"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={submit}
                disabled={!body.trim() || !pendingAnchor || create.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
                title={!pendingAnchor ? 'Capture an anchor first' : undefined}
              >
                {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Add annotation
              </button>
              {create.isError && (
                <span className="text-xs text-red-500">
                  {create.error instanceof Error ? create.error.message : 'Failed to post.'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decisions panel
// ---------------------------------------------------------------------------

const DECISION_VALUES: DecisionValue[] = ['approved', 'changes_requested', 'rejected', 'pending'];

const decisionStyles: Record<DecisionValue, string> = {
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  changes_requested: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  pending: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

function decisionLabel(d: DecisionValue): string {
  return d === 'changes_requested' ? 'changes requested' : d;
}

function DecisionBadge({ decision }: { decision: DecisionValue }) {
  return (
    <span
      className={cn(
        'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize',
        decisionStyles[decision] ?? decisionStyles.pending,
      )}
    >
      {decisionLabel(decision)}
    </span>
  );
}

function DecisionsPanel({ versionId }: { versionId: string | undefined }) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data, isLoading, isError, error } = useDecisions(versionId);
  const setDecision = useSetDecision(versionId);
  const decisions = useMemo(() => data?.data ?? [], [data]);
  const myDecision = decisions.find((d) => d.reviewer_id === currentUserId);
  const [comment, setComment] = useState('');

  const choose = (decision: DecisionValue) => {
    if (!versionId) return;
    setDecision.mutate({ decision, comment: comment.trim() || undefined }, { onSuccess: () => setComment('') });
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Decisions</h3>
      </div>

      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError ? (
          <p className="text-sm text-red-500">{error instanceof Error ? error.message : 'Could not load decisions.'}</p>
        ) : decisions.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2">No decisions recorded for this version yet.</p>
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li key={d.id} className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3">
                <div className="flex items-center justify-between gap-2">
                  <DecisionBadge decision={d.decision} />
                  <span className="text-xs text-zinc-400">{formatRelativeTime(d.created_at)}</span>
                </div>
                {d.comment && (
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1.5 whitespace-pre-wrap">{d.comment}</p>
                )}
                <p className="text-xs text-zinc-400 mt-1.5">{d.reviewer_name ?? d.reviewer_id}</p>
              </li>
            ))}
          </ul>
        )}

        {versionId && (
          <div className="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-700 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-zinc-500">Your decision</p>
              {myDecision && <DecisionBadge decision={myDecision.decision} />}
            </div>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comment…"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30"
            />
            <div className="flex flex-wrap gap-2">
              {DECISION_VALUES.map((d) => (
                <button
                  key={d}
                  onClick={() => choose(d)}
                  disabled={setDecision.isPending}
                  className={cn(
                    'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:opacity-50',
                    myDecision?.decision === d
                      ? decisionStyles[d]
                      : 'border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
                  )}
                >
                  {decisionLabel(d)}
                </button>
              ))}
            </div>
            {setDecision.isError && (
              <span className="text-xs text-red-500">
                {setDecision.error instanceof Error ? setDecision.error.message : 'Failed to save.'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ReviewAssetPage({ assetId, onNavigate }: ReviewAssetPageProps) {
  const assetQuery = useAsset(assetId);
  const versionsQuery = useVersions(assetId);

  const asset = assetQuery.data?.data;
  const versions = useMemo(() => {
    const list = versionsQuery.data?.data ?? [];
    return [...list].sort((a, b) => b.version_number - a.version_number);
  }, [versionsQuery.data]);

  const [activeVersionId, setActiveVersionId] = useState<string | undefined>(undefined);
  const uploadVersion = useUploadVersion(assetId);
  const archive = useArchiveAsset(assetId);
  const fileInput = useRef<HTMLInputElement>(null);

  // Interactive-anchoring state.
  const mediaRef = useRef<MediaEl | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [pendingAnchor, setPendingAnchor] = useState<Anchor | null>(null);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [regionMode, setRegionMode] = useState(false);
  // Clicking an annotation drives these: a highlighted region overlay and/or a
  // loop window for timerange anchors.
  const [highlightRegion, setHighlightRegion] = useState<DragRect | null>(null);
  const loopRef = useRef<{ start: number; end: number } | null>(null);
  // Model review: clicking a viewpoint note flies the 3D camera back to it. A
  // fresh object each time so the viewer re-runs its focus even for the same note.
  const [focusAnchor, setFocusAnchor] = useState<ViewpointAnchor | null>(null);

  useEffect(() => {
    if (activeVersionId) return;
    if (asset?.current_version_id && versions.some((v) => v.id === asset.current_version_id)) {
      setActiveVersionId(asset.current_version_id);
    } else if (versions.length > 0) {
      setActiveVersionId(versions[0]!.id);
    }
  }, [asset?.current_version_id, versions, activeVersionId]);

  const activeVersion = versions.find((v) => v.id === activeVersionId);
  const kind = asset?.media_kind ?? 'image';
  const fps = num((activeVersion?.media_meta as { fps?: number } | null)?.fps, 30) || 30;

  // Model markers: read the same (unresolved) annotations the rail shows and keep
  // only viewpoint anchors. TanStack dedupes this against the panel's own query.
  const modelAnnotationsQuery = useAnnotations(kind === 'model' ? activeVersionId : undefined, false);
  const modelAnnotations = useMemo<ViewpointAnnotation[]>(() => {
    if (kind !== 'model') return [];
    return (modelAnnotationsQuery.data?.data ?? [])
      .filter((a) => (a.anchor as { type?: string })?.type === 'viewpoint')
      .map((a) => ({
        id: a.id,
        anchor: a.anchor as ViewpointAnchor,
        body: a.body,
        author_name: a.author_name,
        resolved: a.resolved,
      }));
  }, [kind, modelAnnotationsQuery.data]);

  // Live updates: annotations/decisions from other reviewers (and guests)
  // appear without a manual refresh.
  useBayRealtime(activeVersionId);

  // Reset capture state when the active version changes.
  useEffect(() => {
    setPendingAnchor(null);
    setMarkIn(null);
    setRegionMode(false);
    setCurrentTime(0);
    setHighlightRegion(null);
    setFocusAnchor(null);
    loopRef.current = null;
  }, [activeVersionId]);

  const onRegion = (rect: DragRect) => {
    const a: Anchor = { type: 'region', ...rect };
    if (kind === 'video') {
      const t = mediaRef.current?.currentTime ?? currentTime;
      a.time_sec = Number(t.toFixed(2));
      a.frame = Math.round(t * fps);
    }
    setPendingAnchor(a);
    setRegionMode(false);
  };

  // Time updates from the media element; also enforce an active loop window.
  const handleTime = (t: number) => {
    setCurrentTime(t);
    const loop = loopRef.current;
    if (loop && mediaRef.current && (t >= loop.end || t < loop.start - 0.1)) {
      mediaRef.current.currentTime = loop.start;
    }
  };

  // Clicking an annotation: jump the playhead to its moment, loop a timerange,
  // and/or highlight its region.
  const seek = (t: number, play = false) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, t);
    if (play && typeof (el as HTMLVideoElement).play === 'function') void (el as HTMLVideoElement).play();
  };
  const onAnchorClick = (anchor: Anchor) => {
    const a = anchor as Record<string, unknown>;
    if (a.type === 'region') {
      setHighlightRegion({ x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h) });
      loopRef.current = null;
      if (a.time_sec != null) seek(num(a.time_sec));
    } else if (a.type === 'frame') {
      setHighlightRegion(null);
      loopRef.current = null;
      seek(a.time_sec != null ? num(a.time_sec) : num(a.frame) / fps);
    } else if (a.type === 'timerange') {
      setHighlightRegion(null);
      const start = num(a.start_sec ?? a.start);
      const end = num(a.end_sec ?? a.end);
      loopRef.current = end > start ? { start, end } : null;
      seek(start, true);
    } else if (a.type === 'viewpoint') {
      // Fly the 3D camera back to the remembered view (fresh object each click so
      // the viewer re-focuses even when the same note is clicked twice).
      setHighlightRegion(null);
      loopRef.current = null;
      setFocusAnchor({ ...(anchor as ViewpointAnchor) });
    }
  };

  const onPickVersion = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadVersion.mutate(file, { onSuccess: () => setActiveVersionId(undefined) });
    e.target.value = '';
  };

  const onDelete = () => {
    if (!confirm('Archive this review asset? Its review history is kept but it leaves the library.')) return;
    archive.mutate(undefined, { onSuccess: () => onNavigate('/') });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <button
        onClick={() => onNavigate('/')}
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Review Library
      </button>

      {assetQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : assetQuery.isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load asset</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {assetQuery.error instanceof Error ? assetQuery.error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : asset ? (
        <>
          <div className="flex items-center justify-between gap-3 mb-6">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{asset.name}</h1>
              <MediaKindBadge kind={asset.media_kind} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input ref={fileInput} type="file" className="hidden" onChange={onPickVersion} />
              <button
                type="button"
                disabled={uploadVersion.isPending}
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              >
                {uploadVersion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploadVersion.isPending ? 'Uploading…' : 'Upload version'}
              </button>
              <ShareReviewButton assetId={asset.id} />
              {activeVersion?.bin_asset_id && (
                <a
                  href={binRawUrl(activeVersion.bin_asset_id)}
                  download={asset.name}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
              )}
              <button
                type="button"
                disabled={archive.isPending}
                onClick={onDelete}
                title="Archive this review asset"
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-900/40 text-red-600 dark:text-red-400 px-3 py-1.5 text-sm hover:bg-red-50 dark:hover:bg-red-900/10 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
          </div>
          {uploadVersion.isError && (
            <p className="text-xs text-red-500 mb-3">
              {uploadVersion.error instanceof Error ? uploadVersion.error.message : 'Upload failed.'}
            </p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <MediaStage
                  kind={kind}
                  version={activeVersion}
                  mediaRef={mediaRef}
                  regionMode={regionMode}
                  regionOverlay={pendingAnchor?.type === 'region' ? pendingAnchor : null}
                  highlightRegion={highlightRegion}
                  onRegion={onRegion}
                  onTime={handleTime}
                  modelAnnotations={modelAnnotations}
                  onCaptureViewpoint={(anchor) => setPendingAnchor(anchor)}
                  focusAnchor={focusAnchor}
                />
                {activeVersion?.media_meta && (
                  <div className="flex flex-wrap gap-1.5 p-3 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-700">
                    {kind === 'model' ? (
                      <ModelMetaChips meta={activeVersion.media_meta as MediaMeta} />
                    ) : (
                      <>
                        {activeVersion.media_meta.width != null && activeVersion.media_meta.height != null && (
                          <MetaLabel label="dimensions" value={`${activeVersion.media_meta.width}×${activeVersion.media_meta.height}`} />
                        )}
                        {activeVersion.media_meta.duration_sec != null && (
                          <MetaLabel label="duration" value={`${activeVersion.media_meta.duration_sec.toFixed(1)}s`} />
                        )}
                        {(activeVersion.media_meta as { fps?: number }).fps != null && (
                          <MetaLabel label="fps" value={String((activeVersion.media_meta as { fps?: number }).fps)} />
                        )}
                        {activeVersion.media_meta.codec && <MetaLabel label="codec" value={String(activeVersion.media_meta.codec)} />}
                      </>
                    )}
                  </div>
                )}
              </div>
              <AnnotationsPanel
                versionId={activeVersionId}
                kind={kind}
                mediaRef={mediaRef}
                fps={fps}
                currentTime={currentTime}
                regionMode={regionMode}
                setRegionMode={setRegionMode}
                pendingAnchor={pendingAnchor}
                setPendingAnchor={setPendingAnchor}
                markIn={markIn}
                setMarkIn={setMarkIn}
                onAnchorClick={onAnchorClick}
                modelClips={(activeVersion?.media_meta as MediaMeta | null | undefined)?.animations}
              />
            </div>

            <div className="space-y-6">
              {versionsQuery.isLoading ? (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400 mx-auto" />
                </div>
              ) : (
                <VersionStack versions={versions} activeId={activeVersionId} onSelect={setActiveVersionId} />
              )}
              <DecisionsPanel versionId={activeVersionId} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
