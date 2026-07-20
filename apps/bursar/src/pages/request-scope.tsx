import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { scopeApi, type ScopeNode } from '../lib/api';

/**
 * M3 Scope Tree editor (spec 3.2 / 14). A BASIC functional page: it derives, shows the tree with
 * citations and strengths, applies library entries, surfaces the rival-promotion queue, and
 * confirms the scope. Polish (the full shell, matrix, diff) lands in M6.
 */

const STRENGTH_ORDER = ['mandatory', 'should_have', 'nice_to_have', 'informational'];

function strengthClass(s: string): string {
  switch (s) {
    case 'mandatory':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
    case 'should_have':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    case 'nice_to_have':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200';
    default:
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

export function RequestScopePage({ requestId }: { requestId: string }) {
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
  const promote = useMutation({ mutationFn: (nodeId: string) => scopeApi.promoteRival(nodeId), onSuccess: invalidate, onError });

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Loading scope...
      </div>
    );
  }
  if (!data) return <div className="p-8 text-zinc-500">Request not found.</div>;

  const { request, nodes, latest_run } = data.data;
  const rivalQueue = nodes.filter((n) => n.derived_from === 'rival_offer' && n.review_status === 'pending_review');
  const treeNodes = [...nodes]
    .filter((n) => !(n.derived_from === 'rival_offer' && n.review_status === 'pending_review'))
    .sort((a, b) => STRENGTH_ORDER.indexOf(a.normative_strength) - STRENGTH_ORDER.indexOf(b.normative_strength));

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold tracking-tight">{request.title}</h1>
          <span className="text-xs uppercase tracking-wide rounded px-2 py-1 bg-zinc-100 dark:bg-zinc-800">
            {request.scope_status}
          </span>
        </div>
        <p className="text-sm text-zinc-500">Scope tree (the ruler). Derive it, review citations, then confirm.</p>
      </header>

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
        <button
          onClick={() => {
            setError(null);
            derive.mutate();
          }}
          disabled={derive.isPending || request.scope_status === 'deriving'}
          className="inline-flex items-center gap-1.5 rounded bg-primary-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <RefreshCw className="w-4 h-4" aria-hidden /> Derive scope
        </button>
        <button
          onClick={() => {
            setError(null);
            confirm.mutate();
          }}
          disabled={confirm.isPending || request.scope_status !== 'derived'}
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <CheckCircle2 className="w-4 h-4" aria-hidden /> Confirm scope
        </button>
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
          <button
            onClick={() => {
              setError(null);
              apply.mutate();
            }}
            disabled={apply.isPending || !libraryIds.trim()}
            className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </section>

      {rivalQueue.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Rival-proposal queue ({rivalQueue.length})</h2>
          <ul className="space-y-2">
            {rivalQueue.map((n) => (
              <li key={n.id} className="rounded border border-zinc-200 dark:border-zinc-800 px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-sm">
                  {n.title} <span className="text-xs text-zinc-500">({n.contributing_offer_ids.length} offer(s))</span>
                </span>
                <button
                  onClick={() => {
                    setError(null);
                    promote.mutate(n.id);
                  }}
                  disabled={promote.isPending}
                  className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs"
                >
                  Promote
                </button>
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
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded border border-zinc-200 dark:border-zinc-800">
            {treeNodes.map((n) => (
              <NodeRow key={n.id} node={n} />
            ))}
          </ul>
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
        <span className={`text-[11px] rounded px-1.5 py-0.5 ${strengthClass(node.normative_strength)}`}>
          {node.normative_strength}
        </span>
        <span className="text-sm font-medium">{node.title}</span>
        <span className="text-[11px] text-zinc-500">{node.derived_from}</span>
        {node.cited_span?.verified === false && (
          <span className="text-[11px] text-amber-600" title="Citation did not verify against its line">
            unverified cite
          </span>
        )}
      </div>
      {quote && <p className="text-xs text-zinc-500 italic pl-1 border-l-2 border-zinc-200 dark:border-zinc-700">"{quote}"</p>}
    </li>
  );
}
