import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw, Grid3x3, GitCompareArrows } from 'lucide-react';
import { scopeApi, type ScopeNode } from '@/lib/api';
import { PageHeader, Card, LoadingState, ErrorState, Btn, Pill } from '@/components/primitives';
import { RealtimeIndicator } from '@/components/realtime-indicator';
import { useBursarRealtime } from '@/hooks/use-bursar-realtime';

/**
 * Scope Tree editor (spec 3.2 / 14). Derives, shows the tree with citations and strengths,
 * applies library entries, surfaces the rival-promotion queue, and confirms the scope. The
 * confirmed tree is the ruler that the Leveling Matrix and Exclusion Diff measure offers against.
 */

interface Props {
  requestId: string;
  onNavigate: (path: string) => void;
}

const STRENGTH_ORDER = ['mandatory', 'should_have', 'nice_to_have', 'informational'];

const STRENGTH_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  mandatory: 'red',
  should_have: 'amber',
  nice_to_have: 'sky',
  informational: 'zinc',
};

export function RequestScopePage({ requestId, onNavigate }: Props) {
  const qc = useQueryClient();
  const [libraryIds, setLibraryIds] = useState('');
  const [clearInjection, setClearInjection] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['scope', requestId] });
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong');

  const { data, isLoading } = useQuery({
    queryKey: ['scope', requestId],
    queryFn: () => scopeApi.get(requestId),
    refetchInterval: (q) => (q.state.data?.data.request.scope_status === 'deriving' ? 2000 : false),
  });

  // Realtime scope.progress accelerates the derive spinner; the 2s poll above is the fallback.
  const { status: rtStatus } = useBursarRealtime([`request:${requestId}`], (e) => {
    if (e.type === 'scope.progress' || e.type === 'matrix.updated') invalidate();
  });

  const derive = useMutation({ mutationFn: () => scopeApi.derive(requestId), onSuccess: invalidate, onError });
  const confirm = useMutation({
    mutationFn: () => scopeApi.confirm(requestId, clearInjection),
    onSuccess: invalidate,
    onError,
  });
  const apply = useMutation({
    mutationFn: () =>
      scopeApi.applyLibrary(
        requestId,
        libraryIds
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      setLibraryIds('');
      invalidate();
    },
    onError,
  });
  const promote = useMutation({
    mutationFn: (nodeId: string) => scopeApi.promoteRival(nodeId),
    onSuccess: invalidate,
    onError,
  });

  if (isLoading) return <LoadingState label="Loading scope..." />;
  if (!data) return <ErrorState message="Request not found." />;

  const { request, nodes, latest_run } = data.data;
  const rivalQueue = nodes.filter((n) => n.derived_from === 'rival_offer' && n.review_status === 'pending_review');
  const treeNodes = [...nodes]
    .filter((n) => !(n.derived_from === 'rival_offer' && n.review_status === 'pending_review'))
    .sort((a, b) => STRENGTH_ORDER.indexOf(a.normative_strength) - STRENGTH_ORDER.indexOf(b.normative_strength));
  const confirmed = request.scope_status === 'confirmed' || request.scope_status === 'awarded';

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <PageHeader
        title={request.title}
        subtitle="Scope tree (the ruler). Derive it, review citations, then confirm."
        actions={
          <div className="flex items-center gap-2">
            <RealtimeIndicator status={rtStatus} />
            <Pill tone="zinc">{request.scope_status}</Pill>
          </div>
        }
      />

      {confirmed && (
        <div className="flex flex-wrap gap-2">
          <Btn variant="primary" onClick={() => onNavigate(`/requests/${requestId}/level`)}>
            <Grid3x3 className="h-4 w-4" /> Leveling Matrix
          </Btn>
          <Btn onClick={() => onNavigate(`/requests/${requestId}/diff`)}>
            <GitCompareArrows className="h-4 w-4" /> Exclusion Diff
          </Btn>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-300 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {request.injection_suspected && (
        <div className="rounded border border-amber-400 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 px-3 py-2 text-sm flex gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            <strong>Request manipulation suspected.</strong> Confirm is blocked until the flagged spans are
            cleared. Signals: {(request.injection_signals?.categories ?? []).join(', ') || 'see finding'}.
          </div>
        </div>
      )}

      {latest_run && latest_run.status === 'partial' && (
        <div className="rounded border border-orange-400 bg-orange-50 dark:bg-orange-900/30 text-orange-900 dark:text-orange-100 px-3 py-2 text-sm">
          {latest_run.error ?? `Derivation was partial (${latest_run.chunks_failed} section(s) unread).`}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Btn
          variant="primary"
          onClick={() => {
            setError(null);
            derive.mutate();
          }}
          disabled={derive.isPending || request.scope_status === 'deriving'}
        >
          <RefreshCw className="w-4 h-4" /> Derive scope
        </Btn>
        <Btn
          onClick={() => {
            setError(null);
            confirm.mutate();
          }}
          disabled={confirm.isPending || request.scope_status !== 'derived'}
        >
          <CheckCircle2 className="w-4 h-4" /> Confirm scope
        </Btn>
        {request.injection_suspected && (
          <label className="inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={clearInjection} onChange={(e) => setClearInjection(e.target.checked)} />
            Clear injection flag on confirm (admin)
          </label>
        )}
      </div>

      <section className="space-y-2">
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="block text-zinc-500 mb-1">Apply library entries (comma / space separated UUIDs)</span>
            <input
              value={libraryIds}
              onChange={(e) => setLibraryIds(e.target.value)}
              placeholder="library-uuid-1, library-uuid-2"
              className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
            />
          </label>
          <Btn
            onClick={() => {
              setError(null);
              apply.mutate();
            }}
            disabled={apply.isPending || !libraryIds.trim()}
          >
            Apply
          </Btn>
        </div>
      </section>

      {rivalQueue.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Rival-proposal queue ({rivalQueue.length})</h2>
          <p className="text-xs text-zinc-500">
            A rival-derived node is a proposal only. It never auto-publishes; a human promotes it into the counted tree.
          </p>
          <ul className="space-y-2">
            {rivalQueue.map((n) => (
              <li
                key={n.id}
                className="rounded border border-zinc-200 dark:border-zinc-800 px-3 py-2 flex items-center justify-between gap-3"
              >
                <span className="text-sm">
                  {n.title}{' '}
                  <span className="text-xs text-zinc-500">({n.contributing_offer_ids.length} offer(s))</span>
                </span>
                <Btn
                  size="sm"
                  onClick={() => {
                    setError(null);
                    promote.mutate(n.id);
                  }}
                  disabled={promote.isPending}
                >
                  Promote
                </Btn>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Scope nodes ({treeNodes.length})</h2>
        {treeNodes.length === 0 ? (
          <p className="text-sm text-zinc-500">No nodes yet. Derive the scope to populate the tree.</p>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {treeNodes.map((n) => (
                <NodeRow key={n.id} node={n} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function NodeRow({ node }: { node: ScopeNode }) {
  const quote = node.cited_span?.quote;
  return (
    <li className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={STRENGTH_TONE[node.normative_strength] ?? 'zinc'}>{node.normative_strength}</Pill>
        <span className="text-sm font-medium">{node.title}</span>
        <span className="text-[11px] text-zinc-500">{node.derived_from}</span>
        {node.cited_span?.verified === false && (
          <span className="text-[11px] text-amber-600" title="Citation did not verify against its line">
            unverified cite
          </span>
        )}
      </div>
      {quote && (
        <p className="text-xs text-zinc-500 italic pl-1 border-l-2 border-zinc-200 dark:border-zinc-700">"{quote}"</p>
      )}
    </li>
  );
}
