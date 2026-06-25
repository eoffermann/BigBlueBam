import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useResolveReview, mediaKindFromMime } from '@/hooks/use-bay';
import { ReviewAssetPage } from '@/pages/review-asset';

interface ReviewByBinAssetProps {
  binAssetId: string;
  onNavigate: (path: string) => void;
}

interface BinAsset {
  id: string;
  name: string;
  content_type: string;
  current_version_id: string | null;
}

function orgHeaders(): Record<string, string> {
  try {
    const org = (
      globalThis as { __bayAuthStore?: { getState?: () => { user?: { org_id?: string } } } }
    ).__bayAuthStore?.getState?.()?.user?.org_id;
    return org ? { 'X-Org-Id': org } : {};
  } catch {
    return {};
  }
}

/**
 * Opens a review by BIN asset id. Fetches the Bin asset for its metadata,
 * find-or-creates the 1:1 Bay review for it, then renders the existing
 * ReviewAssetPage against the resolved Bay asset id.
 */
export function ReviewByBinAsset({ binAssetId, onNavigate }: ReviewByBinAssetProps) {
  const binQuery = useQuery({
    queryKey: ['bay', 'bin-asset', binAssetId],
    queryFn: async (): Promise<BinAsset> => {
      const res = await fetch(`/bin/api/v1/assets/${binAssetId}`, {
        credentials: 'include',
        headers: orgHeaders(),
      });
      if (!res.ok) throw new Error(`Bin asset not found (${res.status})`);
      const json = (await res.json()) as { data: BinAsset };
      return json.data;
    },
  });

  const resolve = useResolveReview();
  const [bayAssetId, setBayAssetId] = useState<string | undefined>(undefined);
  // Resolve exactly once per bin asset, after the Bin metadata loads.
  const resolvedFor = useRef<string | null>(null);

  const binAsset = binQuery.data;

  useEffect(() => {
    if (!binAsset) return;
    if (resolvedFor.current === binAsset.id) return;
    resolvedFor.current = binAsset.id;
    resolve.mutate(
      {
        bin_asset_id: binAsset.id,
        content_type: binAsset.content_type,
        name: binAsset.name,
        media_kind: mediaKindFromMime(binAsset.content_type),
        bin_version_id: binAsset.current_version_id,
      },
      { onSuccess: (res) => setBayAssetId(res.data.id) },
    );
    // resolve is stable across renders for our purposes; binAsset drives this.
  }, [binAsset]);

  if (binQuery.isError || resolve.isError) {
    const err = binQuery.error ?? resolve.error;
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <button
          onClick={() => onNavigate('/')}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Review Library
        </button>
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not open this media for review</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {binQuery.isError
              ? "We couldn't find that media file in your Bin file store."
              : err instanceof Error
                ? err.message
                : 'An unexpected error occurred while preparing the review.'}
          </p>
        </div>
      </div>
    );
  }

  if (!bayAssetId) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return <ReviewAssetPage assetId={bayAssetId} onNavigate={onNavigate} />;
}
