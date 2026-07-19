import { useState } from 'react';
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useEngagement,
  useChainFinancials,
  useBurndown,
  useDeliverables,
  useVariances,
  useWorkItems,
  useConfirmEnvelope,
  type DeliverableRow,
  type WorkItemRow,
} from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn } from '@/components/primitives';
import {
  EngagementStatusBadge,
  EnvelopeBasisBadge,
  ReviewStatusBadge,
  LifecycleStatusBadge,
  EnvelopeStateBadge,
  SeverityBadge,
  varianceKindLabel,
  ValuationBasisBadge,
  type EnvelopeState,
} from '@/components/badges';
import { MoneyFigure } from '@/components/money-figure';
import { BurnBar } from '@/components/burn-bar';
import { formatCents, formatDate, cn } from '@/lib/utils';

interface Props {
  engagementId: string;
  onNavigate: (path: string) => void;
}

function envelopeState(d: DeliverableRow): EnvelopeState {
  if (d.envelope_source === 'unpriced' || (d.is_active && d.envelope_amount == null)) return 'unpriced';
  if (d.is_active && d.envelope_amount != null) return 'priced';
  return 'unconfirmed';
}

export function EngagementDetailPage({ engagementId, onNavigate }: Props) {
  const canReadAll = useCan('burn.financials.read_all');
  const canConfirm = useCan('burn.envelope.confirm');
  const { data, isLoading, isError } = useEngagement(engagementId);
  const fin = useChainFinancials(engagementId);
  const burndown = useBurndown(engagementId);
  const deliverables = useDeliverables({ engagementId });
  const variances = useVariances({ engagementId });

  const eng = data?.data;
  const firstProject = eng?.project_ids?.[0];
  const workItems = useWorkItems(firstProject ? { projectId: firstProject } : { limit: 25 });

  if (isLoading) return <LoadingState />;
  if (isError || !eng) return <ErrorState message="Could not load this engagement." />;

  const money = fin.data?.data.money;
  const consumptionPct =
    money && 'contract_consumption_pct' in money ? money.contract_consumption_pct ?? null : null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        onClick={() => onNavigate('/')}
        className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Portfolio Board
      </button>

      <PageHeader
        title={eng.title}
        subtitle={`${eng.currency} · chain ${eng.chain_root_id.slice(0, 8)}`}
        actions={
          <div className="flex items-center gap-2">
            <EnvelopeBasisBadge basis={eng.envelope_basis as never} />
            <EngagementStatusBadge status={eng.status as never} />
          </div>
        }
      />

      {/* Headline + burn bar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card className="p-4 lg:col-span-1">
          {money ? <MoneyFigure money={money} /> : <div className="text-sm text-zinc-400">No figures yet.</div>}
          <div className="mt-3">
            <BurnBar pct={consumptionPct} />
          </div>
          {fin.data?.data.stale && (
            <p className="mt-2 text-[11px] text-amber-500">Figures are stale; a rollup refresh is pending.</p>
          )}
        </Card>

        {/* Burn-down step-ups */}
        <Card className="p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-2">Burn-down</h3>
          {burndown.isLoading ? (
            <div className="text-xs text-zinc-400 py-4">Loading...</div>
          ) : (
            <BurndownPanel data={burndown.data?.data} canReadAll={canReadAll} />
          )}
        </Card>
      </div>

      {/* Deliverable ledger */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">Deliverable ledger</h2>
        {deliverables.isLoading ? (
          <LoadingState />
        ) : (deliverables.data?.data.length ?? 0) === 0 ? (
          <EmptyState
            title="No deliverables extracted yet"
            hint="Deliverables are read from the signed document by the extraction pass, then confirmed by a human."
          />
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-2 font-medium">Deliverable</th>
                  <th className="px-4 py-2 font-medium">Envelope</th>
                  <th className="px-4 py-2 font-medium">Review</th>
                  <th className="px-4 py-2 font-medium">Lifecycle</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {deliverables.data!.data.map((d) => (
                  <DeliverableRowItem key={d.id} d={d} canReadAll={canReadAll} canConfirm={canConfirm} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {/* Variances */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">Variances</h2>
        {(variances.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-400">No variances on this chain.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {variances.data!.data.map((v) => (
                <li key={v.id} className="px-4 py-2.5 flex items-center gap-3">
                  <SeverityBadge severity={v.severity as never} />
                  <span className="text-sm text-zinc-700 dark:text-zinc-200">{varianceKindLabel(v.variance_kind as never)}</span>
                  {canReadAll && v.amount != null && (
                    <span className="text-xs text-zinc-400 ml-auto">{formatCents(v.amount)}</span>
                  )}
                  <button
                    onClick={() => onNavigate('/variances')}
                    className="text-xs text-primary-600 hover:underline ml-auto"
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {/* Work-item ledger */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">
          Work-item ledger
          {firstProject && <span className="ml-2 text-xs font-normal text-zinc-400">first linked project</span>}
        </h2>
        {workItems.isLoading ? (
          <LoadingState />
        ) : (workItems.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-400">No work items ingested for this chain yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {workItems.data!.data.map((wi) => (
                <WorkItemRowItem key={wi.id} wi={wi} canReadAll={canReadAll} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function BurndownPanel({
  data,
  canReadAll,
}: {
  data: import('@/hooks/use-burn').Burndown | undefined;
  canReadAll: boolean;
}) {
  if (!data) return <div className="text-xs text-zinc-400 py-4">No burn-down data.</div>;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1">
          Envelope step-ups ({data.step_ups.length})
        </div>
        {data.step_ups.length === 0 ? (
          <p className="text-xs text-zinc-400">No dated step-ups yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.step_ups.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <span className="text-zinc-400 w-24 shrink-0">{formatDate(s.at) || 'undated'}</span>
                <span className="font-medium">{s.kind}</span>
                {canReadAll && (
                  <span className="text-zinc-400">
                    {s.kind === 'engagement'
                      ? formatCents(s.contract_value_delta ?? s.contract_value)
                      : formatCents(s.envelope_amount_delta ?? s.envelope_amount)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="text-[11px] text-zinc-400">
        {data.points.length} daily snapshot{data.points.length === 1 ? '' : 's'} recorded · as of{' '}
        {formatDate(data.as_of)}
      </div>
    </div>
  );
}

function DeliverableRowItem({
  d,
  canReadAll,
  canConfirm,
}: {
  d: DeliverableRow;
  canReadAll: boolean;
  canConfirm: boolean;
}) {
  const state = envelopeState(d);
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <tr className="border-b border-zinc-50 dark:border-zinc-800/60 last:border-0">
        <td className="px-4 py-3 align-top">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{d.title}</div>
          {canReadAll && d.cited_span?.quote && (
            <p className="mt-1 text-[11px] italic text-zinc-400 line-clamp-2">
              “{d.cited_span.quote}”{d.clause_ref ? ` (${d.clause_ref})` : ''}
            </p>
          )}
        </td>
        <td className="px-4 py-3 align-top">
          <EnvelopeStateBadge state={state} />
          {canReadAll && d.envelope_amount != null && (
            <div className="mt-1 text-xs text-zinc-500">{formatCents(d.envelope_amount)}</div>
          )}
        </td>
        <td className="px-4 py-3 align-top">
          <ReviewStatusBadge status={d.review_status as never} />
        </td>
        <td className="px-4 py-3 align-top">
          <LifecycleStatusBadge status={d.lifecycle_status as never} />
        </td>
        <td className="px-4 py-3 align-top text-right">
          {canConfirm && state !== 'priced' && (
            <Btn size="sm" onClick={() => setDialog(true)}>
              Confirm envelope
            </Btn>
          )}
        </td>
      </tr>
      {dialog && (
        <tr>
          <td colSpan={5} className="px-4 pb-4">
            <EnvelopeConfirmDialog d={d} canReadAll={canReadAll} onClose={() => setDialog(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function EnvelopeConfirmDialog({
  d,
  canReadAll,
  onClose,
}: {
  d: DeliverableRow;
  canReadAll: boolean;
  onClose: () => void;
}) {
  const confirm = useConfirmEnvelope();
  const [amount, setAmount] = useState<string>(d.envelope_amount != null ? String(d.envelope_amount) : '');
  const [unpriced, setUnpriced] = useState(false);

  const submit = () => {
    confirm.mutate(
      {
        id: d.id,
        input: unpriced
          ? { envelope_amount: null, envelope_source: 'unpriced' }
          : { envelope_amount: amount === '' ? null : Number(amount), envelope_source: 'human' },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="h-4 w-4 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          Confirm the priced envelope
        </span>
      </div>
      {/* The verified quote sits beside the extracted number (spec 7.3), read_all only. */}
      {canReadAll && d.cited_span?.quote && (
        <blockquote className="mb-3 border-l-2 border-primary-300 pl-3 text-xs italic text-zinc-500">
          “{d.cited_span.quote}”{d.clause_ref ? ` — ${d.clause_ref}` : ''}
        </blockquote>
      )}
      <label className="flex items-center gap-2 mb-3 text-sm text-zinc-600 dark:text-zinc-300">
        <input type="checkbox" checked={unpriced} onChange={(e) => setUnpriced(e.target.checked)} />
        Confirm as unpriced (tracks hours only; can never deny)
      </label>
      {!unpriced && (
        <div className="mb-3">
          <label className="block text-xs text-zinc-500 mb-1">Envelope amount (minor units / cents)</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-48 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm"
            placeholder="e.g. 1800000"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Btn variant="primary" size="sm" onClick={submit} disabled={confirm.isPending}>
          Confirm envelope
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
      </div>
      {confirm.isError && <p className="mt-2 text-xs text-red-500">Could not confirm the envelope.</p>}
    </div>
  );
}

function sourceLink(wi: WorkItemRow): string | null {
  switch (wi.source_type) {
    case 'bam.time_entry':
    case 'bam.task':
      return '/b3/';
    case 'bill.expense':
    case 'bill.invoice':
    case 'bill.line_item':
      return '/bill/';
    default:
      return null;
  }
}

function WorkItemRowItem({ wi, canReadAll }: { wi: WorkItemRow; canReadAll: boolean }) {
  const href = sourceLink(wi);
  return (
    <li className="px-4 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-800 dark:text-zinc-100 truncate">
            {wi.title_snapshot ?? wi.source_id.slice(0, 8)}
          </span>
          <ValuationBasisBadge basis={wi.valuation_basis as never} />
        </div>
        <div className="text-[11px] text-zinc-400 font-mono">{wi.source_type}</div>
      </div>
      {canReadAll && wi.billable_amount != null && (
        <span className={cn('text-xs', 'text-zinc-500')}>{formatCents(wi.billable_amount, wi.currency ?? 'USD')}</span>
      )}
      {wi.minutes != null && <span className="text-xs text-zinc-400">{Math.round(wi.minutes / 60)}h</span>}
      {href && (
        <a href={href} title="Open source" className="text-zinc-300 hover:text-primary-500">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </li>
  );
}
