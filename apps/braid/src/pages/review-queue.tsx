import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListChecks, Loader2, X, Zap } from 'lucide-react';
import { useCandidates, useMergeCandidate, useRejectCandidate } from '@/hooks/use-braid';
import type { BraidEvidence } from '@bigbluebam/shared';
import { cn, formatRelativeTime } from '@/lib/utils';

interface ReviewQueuePageProps {
  onNavigate: (path: string) => void;
}

function EvidenceDetail({ evidence }: { evidence: BraidEvidence }) {
  if (evidence.shape === 'direct') {
    return (
      <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
        <p className="text-zinc-400 dark:text-zinc-500">Model: {evidence.model}</p>
        <ul className="space-y-0.5">
          {evidence.features.map((f, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{f.kind}</span>
              <span>score {f.score.toFixed(2)}</span>
              <span className="text-zinc-400">weight {f.weight.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
      <p className="text-zinc-400 dark:text-zinc-500">
        Bridged via identity {evidence.bridge_identity_id} · model {evidence.model}
      </p>
      <ul className="space-y-0.5">
        {evidence.links.map((l, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">
              {l.profile}: {l.kind}
            </span>
            <span>score {l.score.toFixed(2)}</span>
            {l.strong && <span className="text-emerald-600 dark:text-emerald-400">strong</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewQueuePage({ onNavigate }: ReviewQueuePageProps) {
  const { data, isLoading, isError, error } = useCandidates({ status: 'pending', limit: 50 });
  const mergeCandidate = useMergeCandidate();
  const rejectCandidate = useRejectCandidate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);

  const candidates = data?.data ?? [];

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <ListChecks className="h-6 w-6 text-primary-500" />
          Merge review queue
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Below-threshold matches surfaced for human review, sorted by score. Confirm to merge the two
          profiles, or reject to record a lasting no-match.
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load the review queue</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <ListChecks className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">Queue is empty</h3>
          <p className="text-sm text-zinc-500 mt-1">Nothing needs review right now.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {candidates.map((candidate) => {
            const isExpanded = expanded.has(candidate.id);
            const isBusy = pendingId === candidate.id && (mergeCandidate.isPending || rejectCandidate.isPending);
            return (
              <li key={candidate.id} className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <div className="flex items-center gap-4 px-4 py-3">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Zap
                      className={cn(
                        'h-4 w-4',
                        candidate.score >= 0.85 ? 'text-emerald-500' : 'text-amber-500',
                      )}
                    />
                    <span className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                      {Math.round(candidate.score * 100)}%
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <button
                        onClick={() => onNavigate(`/profiles/${candidate.profile_a_id}`)}
                        className="font-mono text-primary-600 dark:text-primary-400 hover:underline truncate"
                      >
                        {candidate.profile_a_id}
                      </button>
                      <span className="text-zinc-400">↔</span>
                      <button
                        onClick={() => onNavigate(`/profiles/${candidate.profile_b_id}`)}
                        className="font-mono text-primary-600 dark:text-primary-400 hover:underline truncate"
                      >
                        {candidate.profile_b_id}
                      </button>
                    </div>
                    {candidate.rationale && (
                      <p className="text-xs text-zinc-500 mt-0.5">{candidate.rationale}</p>
                    )}
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                      Queued {formatRelativeTime(candidate.created_at)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(candidate.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-2.5 py-1.5 text-xs font-medium"
                    >
                      Evidence
                      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setPendingId(candidate.id);
                        rejectCandidate.mutate({ id: candidate.id });
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
                    >
                      {isBusy && rejectCandidate.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setPendingId(candidate.id);
                        mergeCandidate.mutate({ id: candidate.id });
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
                    >
                      {isBusy && mergeCandidate.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Confirm
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 px-4 py-3">
                    <EvidenceDetail evidence={candidate.evidence} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
