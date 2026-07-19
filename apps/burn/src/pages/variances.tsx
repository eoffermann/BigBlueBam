import { useState } from 'react';
import { FileWarning, ExternalLink } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useVariances,
  useUpdateVariance,
  useDraftChangeOrder,
  type VarianceRow,
} from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn } from '@/components/primitives';
import { SeverityBadge, VarianceStatusBadge, varianceKindLabel } from '@/components/badges';
import { formatCents, formatDateTime, cn } from '@/lib/utils';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function VariancesPage() {
  const canReadAll = useCan('burn.financials.read_all');
  const canWrite = useCan('burn.variance.write');
  const canDraft = useCan('burn.changeorder.draft');
  const [status, setStatus] = useState('open');
  const { data, isLoading, isError } = useVariances({ status: status || undefined });

  const rows = (data?.data ?? [])
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Variances & Change Orders"
        subtitle="Severity-ordered. Approving a drafted change order routes into the standard platform proposal flow."
      />

      <div className="flex gap-2 mb-4">
        {['open', 'acknowledged', 'resolved', 'dismissed', ''].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatus(s)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors',
              status === s
                ? 'bg-primary-600 text-white'
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message="Could not load variances." />
      ) : rows.length === 0 ? (
        <EmptyState title="No variances" hint="Nothing has drifted out of scope in this view." />
      ) : (
        <div className="space-y-3">
          {rows.map((v) => (
            <VarianceCard key={v.id} v={v} canReadAll={canReadAll} canWrite={canWrite} canDraft={canDraft} />
          ))}
        </div>
      )}
    </div>
  );
}

function VarianceCard({
  v,
  canReadAll,
  canWrite,
  canDraft,
}: {
  v: VarianceRow;
  canReadAll: boolean;
  canWrite: boolean;
  canDraft: boolean;
}) {
  const update = useUpdateVariance();
  const draft = useDraftChangeOrder();

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <SeverityBadge severity={v.severity as never} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {varianceKindLabel(v.variance_kind as never)}
            </span>
            <VarianceStatusBadge status={v.status as never} />
            {canReadAll && v.amount != null && (
              <span className="text-sm text-zinc-500">{formatCents(v.amount)}</span>
            )}
          </div>
          {v.detail?.note && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{v.detail.note}</p>}
          <div className="mt-1 text-[11px] text-zinc-400">
            Detected {formatDateTime(v.detected_at ?? v.created_at)}
            {v.detail?.refs?.length ? ` · ${v.detail.refs.length} ref(s)` : ''}
          </div>

          {v.proposal_id && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-primary-600">
              <FileWarning className="h-3.5 w-3.5" />
              <span>Change order drafted.</span>
              <a href="/b3/" className="inline-flex items-center gap-0.5 hover:underline">
                Approve in proposals <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {canWrite && v.status === 'open' && (
            <Btn size="sm" onClick={() => update.mutate({ id: v.id, input: { status: 'acknowledged' } })}>
              Acknowledge
            </Btn>
          )}
          {canWrite && v.status !== 'resolved' && v.status !== 'dismissed' && (
            <div className="flex gap-1.5">
              <Btn size="sm" variant="ghost" onClick={() => update.mutate({ id: v.id, input: { status: 'dismissed' } })}>
                Dismiss
              </Btn>
              <Btn size="sm" onClick={() => update.mutate({ id: v.id, input: { status: 'resolved' } })}>
                Resolve
              </Btn>
            </div>
          )}
          {canDraft && v.engagement_id && !v.proposal_id && (
            <Btn
              size="sm"
              variant="primary"
              disabled={draft.isPending}
              onClick={() =>
                draft.mutate({
                  variance_id: v.id,
                  engagement_id: v.engagement_id!,
                  deliverable_id: v.deliverable_id ?? null,
                })
              }
            >
              Draft change order
            </Btn>
          )}
        </div>
      </div>
    </Card>
  );
}
