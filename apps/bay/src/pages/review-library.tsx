import { useRef } from 'react';
import { Film, Image as ImageIcon, Video, Music, Box, Loader2, Upload } from 'lucide-react';
import {
  useBinMediaAssets,
  uploadFileToBin,
  mediaKindFromMime,
  type MediaKind,
} from '@/hooks/use-bay';
import { useMutation } from '@tanstack/react-query';
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
  const { data, isLoading, isError, error } = useBinMediaAssets();
  const assets = data ?? [];
  const fileInput = useRef<HTMLInputElement>(null);

  // Upload bytes into Bin, then open the review for the new Bin asset. The
  // find-or-create of the Bay review happens on the review page itself.
  const upload = useMutation({
    mutationFn: (file: File) => uploadFileToBin(file),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      upload.mutate(file, { onSuccess: (binAssetId) => onNavigate(`/review/${binAssetId}`) });
    }
    e.target.value = '';
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bay — Review Library</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Media files from your Bin file store. Open one to inspect versions, leave annotations, and record a decision.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <input ref={fileInput} type="file" className="hidden" onChange={onPick} />
          <button
            type="button"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {upload.isPending ? 'Uploading…' : 'Upload media'}
          </button>
          {upload.isError && (
            <span className="text-xs text-red-500">
              {upload.error instanceof Error ? upload.error.message : 'Upload failed'}
            </span>
          )}
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
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load media library</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : assets.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Film className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No media files yet</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Upload an image, video, or audio file and it will appear here, ready for annotations and approvals.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Media kind</th>
                <th className="px-4 py-3">Tags</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const kind = mediaKindFromMime(asset.content_type);
                const Icon = mediaKindIcon[kind] ?? Film;
                const tags = asset.tags ?? [];
                return (
                  <tr
                    key={asset.id}
                    onClick={() => onNavigate(`/review/${asset.id}`)}
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
                      <MediaKindBadge kind={kind} />
                    </td>
                    <td className="px-4 py-3">
                      {tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-300 dark:text-zinc-600">—</span>
                      )}
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
