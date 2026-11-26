import { useState, useMemo } from 'react';
import { ArrowUpDown, FilterX } from 'lucide-react';
import type { SearchResult, RetrievalStages } from '@/hooks/use-search';
import { ResultCard } from './result-card';

// ── Sort modes (§5.5.2) ────────────────────────────────────────────

type SortMode = 'relevance' | 'freshness' | 'expiry' | 'authority';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'freshness', label: 'Freshness' },
  { value: 'expiry', label: 'Expiry (soonest)' },
  { value: 'authority', label: 'Authority' },
];

function sortResults(results: SearchResult[], mode: SortMode): SearchResult[] {
  const copy = [...results];
  switch (mode) {
    case 'relevance':
      return copy.sort((a, b) => b.relevance_score - a.relevance_score);
    case 'freshness':
      return copy.sort((a, b) => {
        const aTime = a.last_verified_at ? new Date(a.last_verified_at).getTime() : 0;
        const bTime = b.last_verified_at ? new Date(b.last_verified_at).getTime() : 0;
        return bTime - aTime;
      });
    case 'expiry':
      return copy.sort((a, b) => {
        const aTime = a.expires_at ? new Date(a.expires_at).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expires_at ? new Date(b.expires_at).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
    case 'authority':
      return copy.sort((a, b) => {
        const aScore = a.verification_count + a.linked_beacons.length;
        const bScore = b.verification_count + b.linked_beacons.length;
        return bScore - aScore;
      });
    default:
      return copy;
  }
}

// ── Retrieval transparency summary ──────────────────────────────────

function RetrievalSummary({
  totalCandidates,
  stages,
}: {
  totalCandidates: number;
  stages: RetrievalStages;
}) {
  const parts: string[] = [];
  if (stages.semantic_hits > 0) parts.push(`${stages.semantic_hits} semantic`);
  if (stages.tag_expansion_hits > 0) parts.push(`${stages.tag_expansion_hits} tag-expanded`);
  if (stages.link_traversal_hits > 0) parts.push(`${stages.link_traversal_hits} link-traversed`);
  if (stages.fulltext_fallback_hits > 0) parts.push(`${stages.fulltext_fallback_hits} keyword fallback`);

  return (
    <p className="text-sm text-zinc-500 dark:text-zinc-400">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {totalCandidates} Beacon{totalCandidates !== 1 ? 's' : ''} found
      </span>
      {parts.length > 0 && (
        <>: {parts.join(' \u00b7 ')}</>
      )}
    </p>
  );
}

// ── Related tags suggestion (sparse state) ──────────────────────────

function RelatedTagsSuggestion({
  results,
  currentTags,
  onAddTag,
}: {
  results: SearchResult[];
  currentTags: string[];
  onAddTag: (tag: string) => void;
}) {
  const relatedTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const r of results) {
      for (const t of r.tags) {
        if (!currentTags.includes(t)) tagSet.add(t);
      }
    }
    return [...tagSet].slice(0, 8);
  }, [results, currentTags]);

  if (relatedTags.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-3 mt-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">
        Related tags you might try:
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {relatedTags.map((tag) => (
          <button
            key={tag}
            onClick={() => onAddTag(tag)}
            className="inline-flex items-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700 dark:hover:bg-primary-900/20 dark:hover:border-primary-700 dark:hover:text-primary-400 transition-colors cursor-pointer"
          >
            + {tag}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main result list ────────────────────────────────────────────────

interface ResultListProps {
  results: SearchResult[];
  totalCandidates: number;
  retrievalStages: RetrievalStages;
  currentTags: string[];
  isLoading: boolean;
  hasActiveQuery: boolean;
  onNavigate: (path: string) => void;
  onAddTag: (tag: string) => void;
  onClearFilters: () => void;
}

export function ResultList({
  results,
  totalCandidates,
  retrievalStages,
  currentTags,
  isLoading,
  hasActiveQuery,
  onNavigate,
  onAddTag,
  onClearFilters,
}: ResultListProps) {
  const [sortMode, setSortMode] = useState<SortMode>('relevance');
  const sorted = useMemo(() => sortResults(results, sortMode), [results, sortMode]);

  // Check if all results are stale (PendingReview or Archived)
  const allStale = results.length > 0 && results.every(
    (r) => r.status === 'PendingReview' || r.status === 'Archived',
  );

  // Don't render anything if no query has been entered
  if (!hasActiveQuery) {
    return (
      <div className="py-16 text-center">
        <p className="text-zinc-400 dark:text-zinc-500">
          Enter a search term or select filters to find Beacons.
        </p>
      </div>
    );
  }

  // Loading state
  if (isLoading && results.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        <p className="mt-3 text-sm text-zinc-400 dark:text-zinc-500">Searching...</p>
      </div>
    );
  }

  // Empty state
  if (results.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-zinc-500 dark:text-zinc-400 mb-2">
          No Beacons match your current filters.
        </p>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 mb-4">
          Try removing tag filters, broadening your search, or searching org-wide.
        </p>
        <button
          onClick={onClearFilters}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
        >
          <FilterX className="h-4 w-4" />
          Clear all filters
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header: retrieval summary + sort control */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <RetrievalSummary totalCandidates={totalCandidates} stages={retrievalStages} />

        <div className="flex items-center gap-1.5 shrink-0">
          <ArrowUpDown className="h-3.5 w-3.5 text-zinc-400" />
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* All-stale warning */}
      {allStale && (
        <div className="mb-4 rounded-lg border border-yellow-200 dark:border-yellow-800/50 bg-yellow-50 dark:bg-yellow-900/20 px-4 py-3">
          <p className="text-sm text-yellow-800 dark:text-yellow-300">
            All matching Beacons are awaiting review. Consider verifying or creating new content.
          </p>
        </div>
      )}

      {/* Results */}
      <div className="space-y-3">
        {sorted.map((result) => (
          <ResultCard
            key={result.beacon_id}
            result={result}
            onNavigate={onNavigate}
            onAddTag={onAddTag}
          />
        ))}
      </div>

      {/* Sparse state: show related tags if < 3 results */}
      {results.length > 0 && results.length < 3 && (
        <RelatedTagsSuggestion
          results={results}
          currentTags={currentTags}
          onAddTag={onAddTag}
        />
      )}
    </div>
  );
}
