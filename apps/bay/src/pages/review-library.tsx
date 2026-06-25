import { Film, Image as ImageIcon, Video, Music, Box } from 'lucide-react';
import { useAssets, type MediaKind } from '@/hooks/use-bay';
import { cn, formatRelativeTime } from '@/lib/utils';

interface ReviewLibraryPageProps {
  onNavigate: (path: string) => void;
}

const mediaKindStyles: Record<MediaKind, string> = {
  image: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  video: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  audio: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  model: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const mediaKindIcon: Record<MediaKind, typeof Film> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  model: Box,
};

export function MediaKindBadge({ kind }: { kind: MediaKind }) {
  return (
    <span
      className={cn(
        'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize',
        mediaKindStyles[kind] ?? mediaKindStyles.image,
      )}
    >
      {kind}
    </span>
  );
}

export function ReviewLibraryPage({ onNavigate }: ReviewLibraryPageProps) {
  const { data, isLoading, isError, error } = useAssets();
  const assets = (data?.data ?? []).filter((a) => !a.archived_at);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bay — Review Library</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Media submitted for review and approval. Open an asset to inspect versions, leave annotations, and record a decision.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-12 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load review library</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : assets.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Film className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No assets in review</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Submit media for review and it will appear here, ready for annotations and approvals.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Media kind</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const Icon = mediaKindIcon[asset.media_kind] ?? Film;
                return (
                  <tr
                    key={asset.id}
                    onClick={() => onNavigate(`/assets/${asset.id}`)}
                    className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-primary-50/50 dark:hover:bg-primary-900/10 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="h-4 w-4 text-primary-500 shrink-0" />
                        <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {asset.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <MediaKindBadge kind={asset.media_kind} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {formatRelativeTime(asset.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
