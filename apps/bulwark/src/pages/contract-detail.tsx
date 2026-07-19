import {
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  ArrowUpRight,
  ScrollText,
  AlertTriangle,
} from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { useContract, useReExtract, useDeleteContract } from '@/hooks/use-bulwark';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import {
  ContractStatusBadge,
  ObligationTypeBadge,
  ReviewStatusBadge,
  ArmedBadge,
} from '@/components/badges';

interface Props {
  contractId: string;
  onNavigate: (path: string) => void;
}

export function ContractDetailPage({ contractId, onNavigate }: Props) {
  const { data, isLoading, isError, error } = useContract(contractId);
  const canWrite = useCan('bulwark.contract.write');
  const canDelete = useCan('bulwark.contract.delete');
  const reExtract = useReExtract();
  const del = useDeleteContract();

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <div className="h-8 w-64 rounded bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
        <div className="h-32 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load contract</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'This contract may not exist or you may not have access.'}
          </p>
        </div>
      </div>
    );
  }

  const c = data.data;
  const rollup = c.rollup;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary-500 shrink-0" />
            <span className="truncate">{c.title}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <ContractStatusBadge status={c.status} />
            <span className="text-xs text-zinc-500">{c.contract_kind}</span>
            <span className="text-xs text-zinc-400">extraction: {c.extraction_status}</span>
            {c.extracted_at && (
              <span className="text-xs text-zinc-400">extracted {formatRelativeTime(c.extracted_at)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canWrite && (
            <button
              type="button"
              disabled={reExtract.isPending}
              onClick={() => reExtract.mutate(c.id)}
              className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              {reExtract.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Extract
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              disabled={del.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Delete this tracked contract? Its obligations and live deadline clocks are destroyed. The Bin document is not affected.',
                  )
                ) {
                  del.mutate(c.id, { onSuccess: () => onNavigate('/') });
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          )}
        </div>
      </div>

      {reExtract.isSuccess && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2">Extraction re-queued.</p>
      )}

      {/* Amendment / supersession */}
      {(c.contract_kind === 'amendment' || c.supersedes_contract_id) && c.supersedes_contract_id && (
        <div className="mb-4 rounded-lg border border-primary-200 dark:border-primary-900/40 bg-primary-50/60 dark:bg-primary-900/10 p-3 flex items-center gap-2">
          <ArrowUpRight className="h-4 w-4 text-primary-600 dark:text-primary-400" />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">This contract supersedes</span>
          <button
            onClick={() => onNavigate(`/contracts/${c.supersedes_contract_id}`)}
            className="text-sm font-mono text-primary-600 dark:text-primary-400 hover:underline"
          >
            {c.supersedes_contract_id.slice(0, 8)}
          </button>
        </div>
      )}

      {/* Rollup */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <RollupCard label="Obligations" value={rollup.obligations.total} />
        <RollupCard label="Pending review" value={rollup.obligations.pending} tone={rollup.obligations.pending > 0 ? 'amber' : undefined} />
        <RollupCard label="Armed" value={rollup.obligations.armed} tone="green" />
        <RollupCard label="Open deadlines" value={rollup.deadlines.open} />
        <RollupCard label="Missed" value={rollup.deadlines.missed} tone={rollup.deadlines.missed > 0 ? 'red' : undefined} />
      </div>

      {/* Metadata */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800 mb-6">
        <MetaRow label="Counterparty" value={c.counterparty_id ? `${c.counterparty_type ?? 'party'} ${c.counterparty_id.slice(0, 8)}` : 'unset (notice send fails closed)'} warn={!c.counterparty_id} />
        <MetaRow label="Project (job)" value={c.project_id ? c.project_id.slice(0, 8) : 'none (org-scoped)'} />
        <MetaRow label="Effective" value={formatDate(c.effective_date) || 'unset'} />
        <MetaRow label="Expiry" value={formatDate(c.expiry_date) || 'unset'} />
        <MetaRow label="Timezone" value={c.timezone} />
        <MetaRow label="Jurisdiction" value={c.jurisdiction ?? 'unset'} />
        <MetaRow label="Bin document" value={c.bin_asset_id.slice(0, 8)} />
      </div>

      {/* Obligations */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
          <ScrollText className="h-4 w-4 text-primary-500" />
          Obligations
        </h2>
        <button
          onClick={() => onNavigate('/')}
          className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
        >
          Open in ledger to confirm / bind
        </button>
      </div>
      {c.obligations.length === 0 ? (
        <div className="text-center py-10 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 text-sm text-zinc-500">
          No obligations extracted yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {c.obligations.map((o) => (
            <li
              key={o.id}
              className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 flex flex-wrap items-center gap-2"
            >
              <ObligationTypeBadge type={o.obligation_type} />
              <ReviewStatusBadge status={o.review_status} />
              <ArmedBadge armed={o.is_armed} />
              <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate flex-1 min-w-0">{o.title}</span>
              {o.clause_ref && <span className="text-[11px] font-mono text-zinc-400">clause {o.clause_ref}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RollupCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'green' | 'red';
}) {
  const toneCls =
    tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'green'
        ? 'text-emerald-600 dark:text-emerald-400'
        : tone === 'red'
          ? 'text-red-600 dark:text-red-400'
          : 'text-zinc-900 dark:text-zinc-100';
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 px-3 py-3">
      <div className={`text-2xl font-bold ${toneCls}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

function MetaRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span
        className={`text-sm font-mono flex items-center gap-1 ${
          warn ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-800 dark:text-zinc-200'
        }`}
      >
        {warn && <AlertTriangle className="h-3.5 w-3.5" />}
        {value}
      </span>
    </div>
  );
}
