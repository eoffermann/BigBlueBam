import { Archive, FileBox } from 'lucide-react';
import { useAssets, type ScanStatus } from '@/hooks/use-bin';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';

interface AssetLibraryPageProps {
  onNavigate: (path: string) => void;
}

const scanStatusStyles: Record<ScanStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  clean: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  infected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

function ScanBadge({ status }: { status: ScanStatus }) {
  return (
    <span
      className={cn(
        'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize',
        scanStatusStyles[status] ?? scanStatusStyles.skipped,
      )}
    >
      {status}
    </span>
  );
}

export function AssetLibraryPage({ onNavigate }: AssetLibraryPageProps) {
  const { data, isLoading } = useAssets();
  const assets = data?.data ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bin — Asset Library</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Every file and dataset stored in your organization. Open a structured file to view its data.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse" />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Archive className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No assets yet</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Upload files or datasets and they will appear here in your Asset Library.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Size</th>
                <th className="px-4 py-3">Scan status</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr
                  key={asset.id}
                  onClick={() => onNavigate(`/assets/${asset.id}`)}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-primary-50/50 dark:hover:bg-primary-900/10 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileBox className="h-4 w-4 text-primary-500 shrink-0" />
                      <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{asset.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    <code className="text-xs">{asset.content_type ?? '—'}</code>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">
                    {formatBytes(asset.size)}
                  </td>
                  <td className="px-4 py-3">
                    <ScanBadge status={asset.scan_status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {formatRelativeTime(asset.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
