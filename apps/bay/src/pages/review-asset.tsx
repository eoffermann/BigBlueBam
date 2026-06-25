import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Box,
  Check,
  Image as ImageIcon,
  Layers,
  Loader2,
  Music,
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
  type Anchor,
  type AnchorType,
  type BayVersion,
  type DecisionValue,
  type MediaKind,
  type MediaMeta,
} from '@/hooks/use-bay';
import { useAuthStore } from '@/stores/auth.store';
import { cn, formatRelativeTime } from '@/lib/utils';
import { MediaKindBadge } from '@/pages/review-library';

interface ReviewAssetPageProps {
  assetId: string;
  onNavigate: (path: string) => void;
}

const mediaKindIcon: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  model: Box,
};

// ---------------------------------------------------------------------------
// Anchor rendering
// ---------------------------------------------------------------------------

function renderAnchor(anchor: Anchor): string {
  switch (anchor.type) {
    case 'frame':
      return `▶ frame ${anchor.frame}`;
    case 'timerange':
      return `◷ ${anchor.start_sec.toFixed(1)}–${anchor.end_sec.toFixed(1)}s`;
    case 'region':
      return `▱ region ${Math.round(anchor.x * 100)}%,${Math.round(anchor.y * 100)}% ${Math.round(
        anchor.w * 100,
      )}%×${Math.round(anchor.h * 100)}%`;
    case 'viewpoint':
      return `view: ${anchor.camera ?? 'camera'}`;
    default:
      return 'anchor';
  }
}

// ---------------------------------------------------------------------------
// Media placeholder
// ---------------------------------------------------------------------------

function MetaLabel({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-0.5 text-xs">
      <span className="text-zinc-400">{label}</span>
      <span className="font-medium text-zinc-800 dark:text-zinc-200">{value}</span>
    </span>
  );
}

function MediaPlaceholder({ kind, meta }: { kind: MediaKind; meta: MediaMeta | null }) {
  const Icon = mediaKindIcon[kind] ?? ImageIcon;
  const labels: { label: string; value: string }[] = [];
  if (meta) {
    if (meta.width != null && meta.height != null) {
      labels.push({ label: 'dimensions', value: `${meta.width}×${meta.height}` });
    }
    if (meta.duration_sec != null) {
      labels.push({ label: 'duration', value: `${meta.duration_sec.toFixed(1)}s` });
    }
    if (meta.codec) {
      labels.push({ label: 'codec', value: String(meta.codec) });
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="aspect-video w-full bg-zinc-100 dark:bg-zinc-800/50 flex flex-col items-center justify-center gap-3 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center justify-center h-16 w-16 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-primary-500">
          <Icon className="h-8 w-8" />
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Preview proxy coming soon</p>
      </div>
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 p-3 bg-white dark:bg-zinc-900">
          {labels.map((l) => (
            <MetaLabel key={l.label} label={l.label} value={l.value} />
          ))}
        </div>
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Versions
        </h3>
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
// Anchor builder
// ---------------------------------------------------------------------------

const ANCHOR_TYPES: AnchorType[] = ['frame', 'timerange', 'region', 'viewpoint'];

function defaultAnchorFor(type: AnchorType): Anchor {
  switch (type) {
    case 'frame':
      return { type: 'frame', frame: 0 };
    case 'timerange':
      return { type: 'timerange', start_sec: 0, end_sec: 1 };
    case 'region':
      return { type: 'region', x: 0, y: 0, w: 0.2, h: 0.2 };
    case 'viewpoint':
      return { type: 'viewpoint', camera: 'front' };
  }
}

function numInput(value: number, onChange: (n: number) => void, label: string, step = 1) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
      {label}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30"
      />
    </label>
  );
}

function AnchorBuilder({ anchor, onChange }: { anchor: Anchor; onChange: (a: Anchor) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
        Anchor type
        <select
          value={anchor.type}
          onChange={(e) => onChange(defaultAnchorFor(e.target.value as AnchorType))}
          className="rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30"
        >
          {ANCHOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      {anchor.type === 'frame' &&
        numInput(anchor.frame, (n) => onChange({ ...anchor, frame: n }), 'frame')}

      {anchor.type === 'timerange' && (
        <>
          {numInput(anchor.start_sec, (n) => onChange({ ...anchor, start_sec: n }), 'start (s)', 0.1)}
          {numInput(anchor.end_sec, (n) => onChange({ ...anchor, end_sec: n }), 'end (s)', 0.1)}
        </>
      )}

      {anchor.type === 'region' && (
        <>
          {numInput(anchor.x, (n) => onChange({ ...anchor, x: n }), 'x', 0.05)}
          {numInput(anchor.y, (n) => onChange({ ...anchor, y: n }), 'y', 0.05)}
          {numInput(anchor.w, (n) => onChange({ ...anchor, w: n }), 'w', 0.05)}
          {numInput(anchor.h, (n) => onChange({ ...anchor, h: n }), 'h', 0.05)}
        </>
      )}

      {anchor.type === 'viewpoint' && (
        <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
          camera
          <input
            type="text"
            value={anchor.camera ?? ''}
            onChange={(e) => onChange({ ...anchor, camera: e.target.value })}
            className="w-28 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30"
          />
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Annotations panel
// ---------------------------------------------------------------------------

function AnnotationsPanel({ versionId }: { versionId: string | undefined }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const { data, isLoading, isError, error } = useAnnotations(versionId, includeResolved);
  const create = useCreateAnnotation(versionId);
  const resolve = useResolveAnnotation(versionId);

  const [body, setBody] = useState('');
  const [anchor, setAnchor] = useState<Anchor>(() => defaultAnchorFor('frame'));

  const annotations = data?.data ?? [];

  const submit = () => {
    if (!body.trim() || !versionId) return;
    create.mutate(
      { anchor, body: body.trim() },
      {
        onSuccess: () => {
          setBody('');
          setAnchor(defaultAnchorFor('frame'));
        },
      },
    );
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Annotations
        </h3>
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
        {/* List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError ? (
          <p className="text-sm text-red-500">
            {error instanceof Error ? error.message : 'Could not load annotations.'}
          </p>
        ) : annotations.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2">No annotations on this version yet.</p>
        ) : (
          <ul className="space-y-2">
            {annotations.map((a) => (
              <li
                key={a.id}
                className={cn(
                  'rounded-lg border p-3',
                  a.resolved
                    ? 'border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30 opacity-75'
                    : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900',
                )}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="inline-flex items-center rounded-md bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300">
                    {renderAnchor(a.anchor)}
                  </span>
                  <button
                    onClick={() => resolve.mutate({ id: a.id, resolved: !a.resolved })}
                    disabled={resolve.isPending}
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
                  {a.author_id} · {formatRelativeTime(a.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {/* Composer */}
        {versionId && (
          <div className="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-700 p-3 space-y-3">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Leave an annotation…"
              rows={2}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:ring-2 focus:ring-primary-500/30 resize-y"
            />
            <AnchorBuilder anchor={anchor} onChange={setAnchor} />
            <div className="flex items-center gap-3">
              <button
                onClick={submit}
                disabled={!body.trim() || create.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
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
    setDecision.mutate(
      { decision, comment: comment.trim() || undefined },
      { onSuccess: () => setComment('') },
    );
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Decisions
        </h3>
      </div>

      <div className="p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError ? (
          <p className="text-sm text-red-500">
            {error instanceof Error ? error.message : 'Could not load decisions.'}
          </p>
        ) : decisions.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2">No decisions recorded for this version yet.</p>
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <DecisionBadge decision={d.decision} />
                  <span className="text-xs text-zinc-400">{formatRelativeTime(d.created_at)}</span>
                </div>
                {d.comment && (
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1.5 whitespace-pre-wrap">
                    {d.comment}
                  </p>
                )}
                <p className="text-xs text-zinc-400 mt-1.5">{d.reviewer_id}</p>
              </li>
            ))}
          </ul>
        )}

        {/* My decision control */}
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

  // Default to the current/newest version once data arrives.
  useEffect(() => {
    if (activeVersionId) return;
    if (asset?.current_version_id && versions.some((v) => v.id === asset.current_version_id)) {
      setActiveVersionId(asset.current_version_id);
    } else if (versions.length > 0) {
      setActiveVersionId(versions[0]!.id);
    }
  }, [asset?.current_version_id, versions, activeVersionId]);

  const activeVersion = versions.find((v) => v.id === activeVersionId);

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
          <div className="flex items-center gap-3 mb-6">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{asset.name}</h1>
            <MediaKindBadge kind={asset.media_kind} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: media + versions */}
            <div className="lg:col-span-2 space-y-6">
              <MediaPlaceholder kind={asset.media_kind} meta={activeVersion?.media_meta ?? null} />
              <AnnotationsPanel versionId={activeVersionId} />
            </div>

            {/* Right: version stack + decisions */}
            <div className="space-y-6">
              {versionsQuery.isLoading ? (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400 mx-auto" />
                </div>
              ) : (
                <VersionStack
                  versions={versions}
                  activeId={activeVersionId}
                  onSelect={setActiveVersionId}
                />
              )}
              <DecisionsPanel versionId={activeVersionId} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
