import { useState } from 'react';
import {
  ScrollText,
  Loader2,
  Check,
  X,
  Pencil,
  Zap,
  FileText,
  ChevronRight,
  Quote,
  AlarmClockPlus,
  Plus,
} from 'lucide-react';
import type {
  BulwarkContract,
  BulwarkContractKind,
  BulwarkObligation,
  BulwarkObligationType,
} from '@bigbluebam/shared';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useContracts,
  useContractObligations,
  usePatchObligation,
  useRegisterContract,
  useSettings,
  useTriggerObligation,
} from '@/hooks/use-bulwark';
import { cn } from '@/lib/utils';
import {
  ObligationTypeBadge,
  ReviewStatusBadge,
  ArmedBadge,
  ContractStatusBadge,
} from '@/components/badges';

const CONTRACT_KINDS: BulwarkContractKind[] = [
  'subcontract',
  'sow',
  'msa',
  'grant_award',
  'lease',
  'amendment',
  'other',
];

const OBLIGATION_TYPES: BulwarkObligationType[] = [
  'notice',
  'insurance',
  'indemnity',
  'payment',
  'retention',
  'flow_down',
  'renewal',
  'termination',
  'lien',
  'other',
];

interface Props {
  onNavigate: (path: string) => void;
}

export function ObligationLedgerPage({ onNavigate }: Props) {
  const contractsQuery = useContracts({ limit: 100 });
  const contracts = contractsQuery.data?.data ?? [];
  const canWrite = useCan('bulwark.contract.write');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const activeId = selectedId ?? contracts[0]?.id ?? null;
  const selected = contracts.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex h-full">
      {/* Contract picker */}
      <div className="w-72 shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto custom-scrollbar bg-zinc-50/60 dark:bg-zinc-950/30">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Contracts
          </h2>
          {canWrite && (
            <button
              onClick={() => setShowRegister(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-2 py-1 text-xs font-medium shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Register
            </button>
          )}
        </div>
        {contractsQuery.isLoading ? (
          <div className="p-3 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
            ))}
          </div>
        ) : contracts.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500 space-y-3">
            <p>No contracts tracked yet. Register one from a Bin asset to build its obligation ledger.</p>
            {canWrite && (
              <button
                onClick={() => setShowRegister(true)}
                className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-xs font-medium"
              >
                <Plus className="h-3.5 w-3.5" />
                Register contract
              </button>
            )}
          </div>
        ) : (
          <ul className="p-2 space-y-1">
            {contracts.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'w-full text-left rounded-lg px-3 py-2 transition-colors',
                    c.id === activeId
                      ? 'bg-primary-50 dark:bg-primary-900/20 ring-1 ring-primary-300 dark:ring-primary-800'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {c.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 pl-5">
                    <ContractStatusBadge status={c.status} />
                    <span className="text-[11px] text-zinc-400">{c.contract_kind}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Ledger */}
      <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar">
        {selected ? (
          <ContractLedger contract={selected} onNavigate={onNavigate} />
        ) : (
          <div className="p-10 text-center text-sm text-zinc-500">
            Select a contract to view its clause-cited obligation ledger.
          </div>
        )}
      </div>

      {showRegister && canWrite && (
        <RegisterContractModal
          onClose={() => setShowRegister(false)}
          onRegistered={(id) => {
            setShowRegister(false);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}

function RegisterContractModal({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: (contractId: string) => void;
}) {
  const settingsQuery = useSettings();
  const register = useRegisterContract();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<BulwarkContractKind>('subcontract');
  const [binAssetId, setBinAssetId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [timezone, setTimezone] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const defaultTz = settingsQuery.data?.data.default_timezone ?? '';

  function submit() {
    register.mutate(
      {
        title: title.trim(),
        contract_kind: kind,
        bin_asset_id: binAssetId.trim(),
        project_id: projectId.trim() || null,
        counterparty_type: counterpartyId.trim() ? 'bond.company' : null,
        counterparty_id: counterpartyId.trim() || null,
        timezone: timezone.trim() || defaultTz || undefined,
        effective_date: effectiveDate || null,
        expiry_date: expiryDate || null,
      },
      { onSuccess: (res) => onRegistered(res.data.id) },
    );
  }

  const inputCls =
    'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2.5 py-1.5 text-sm';
  const labelCls = 'text-[11px] text-zinc-500';
  const canSubmit = title.trim().length > 0 && binAssetId.trim().length > 0 && !register.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/40 dark:bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-5 py-3.5">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary-500" />
            Register contract
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <p className="text-xs text-zinc-500">
            Point Bulwark at the executed document in Bin. Its obligation ledger populates after
            extraction runs.
          </p>

          <div className="flex flex-col gap-1">
            <label className={labelCls}>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Acme subcontract - Phase 2"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className={labelCls}>Contract kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as BulwarkContractKind)} className={inputCls}>
                {CONTRACT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>Timezone</label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder={defaultTz || 'America/New_York'}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelCls}>Bin asset id</label>
            <input
              value={binAssetId}
              onChange={(e) => setBinAssetId(e.target.value)}
              placeholder="uuid"
              className={cn(inputCls, 'font-mono text-xs')}
            />
            <span className="text-[10px] text-zinc-400">Bin asset id of the executed document.</span>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelCls}>Project (job)</label>
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="uuid (optional)"
              className={cn(inputCls, 'font-mono text-xs')}
            />
            <span className="text-[10px] text-zinc-400">Leave blank for an org-scoped contract.</span>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelCls}>Counterparty (bond.company id)</label>
            <input
              value={counterpartyId}
              onChange={(e) => setCounterpartyId(e.target.value)}
              placeholder="uuid (optional)"
              className={cn(inputCls, 'font-mono text-xs')}
            />
            <span className="text-[10px] text-zinc-400">
              Leave blank to set later; notice send fails closed until set.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className={labelCls}>Effective date</label>
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>Expiry date</label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {register.isError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">
              {register.error instanceof Error ? register.error.message : 'Could not register the contract.'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 dark:border-zinc-800 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {register.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Register contract
          </button>
        </div>
      </div>
    </div>
  );
}

function ContractLedger({
  contract,
  onNavigate,
}: {
  contract: BulwarkContract;
  onNavigate: (path: string) => void;
}) {
  const { data, isLoading, isError, error } = useContractObligations(contract.id);
  const [filter, setFilter] = useState<string>('');
  const obligations = (data?.data ?? []).filter((o) => !filter || o.review_status === filter);

  const filters: Array<{ key: string; label: string }> = [
    { key: '', label: 'All' },
    { key: 'pending_review', label: 'Pending' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'auto_confirmed', label: 'Auto' },
    { key: 'rejected', label: 'Rejected' },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-1">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <ScrollText className="h-6 w-6 text-primary-500" />
          {contract.title}
        </h1>
        <button
          onClick={() => onNavigate(`/contracts/${contract.id}`)}
          className="inline-flex items-center gap-1 text-sm text-primary-600 dark:text-primary-400 hover:underline shrink-0"
        >
          Contract detail <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Each obligation is extracted best-effort from the executed document and cited to its clause.
        Confirm before a claim-or-money-waiving clock can arm.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
              filter === f.key
                ? 'bg-primary-600 text-white border-primary-600'
                : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <ErrorBox message={error instanceof Error ? error.message : 'Could not load obligations.'} />
      ) : obligations.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <ScrollText className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No obligations</h3>
          <p className="text-sm text-zinc-500 mt-1">
            {contract.extraction_status === 'extracted'
              ? 'Nothing matched this filter.'
              : 'Extraction has not produced obligations yet.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {obligations.map((o) => (
            <ObligationCard key={o.id} obligation={o} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ObligationCard({ obligation }: { obligation: BulwarkObligation }) {
  const canWrite = useCan('bulwark.obligation.write');
  const canDeadline = useCan('bulwark.deadline.write');
  const patch = usePatchObligation();
  const trigger = useTriggerObligation();
  const [editing, setEditing] = useState(false);
  const [showTrigger, setShowTrigger] = useState(false);

  const span = obligation.cited_span;
  const binding = obligation.event_binding as { source?: string; event_type?: string; unbound?: boolean };
  const isPending = obligation.review_status === 'pending_review';
  const isConfirmed = obligation.review_status === 'confirmed' || obligation.review_status === 'auto_confirmed';
  const canManualTrigger = isConfirmed && (binding?.unbound === true);

  return (
    <li className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <ObligationTypeBadge type={obligation.obligation_type} />
              <ReviewStatusBadge status={obligation.review_status} />
              <ArmedBadge armed={obligation.is_armed} />
              {obligation.clause_ref && (
                <span className="text-[11px] font-mono text-zinc-400">clause {obligation.clause_ref}</span>
              )}
              {obligation.confidence != null && (
                <span className="text-[11px] text-zinc-400 inline-flex items-center gap-0.5">
                  <Zap className="h-3 w-3" /> {Math.round(obligation.confidence * 100)}%
                </span>
              )}
            </div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{obligation.title}</p>
            {obligation.trigger_description && (
              <p className="text-xs text-zinc-500 mt-0.5">{obligation.trigger_description}</p>
            )}
            {span?.quote && (
              <blockquote
                className={cn(
                  'mt-2 flex gap-2 rounded-lg border-l-2 px-3 py-2 text-xs',
                  span.verified
                    ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-900/10 text-zinc-700 dark:text-zinc-200'
                    : 'border-amber-400 bg-amber-50/60 dark:bg-amber-900/10 text-zinc-700 dark:text-zinc-200',
                )}
              >
                <Quote className="h-3.5 w-3.5 shrink-0 text-zinc-400 mt-0.5" />
                <span>
                  <span className="italic">&ldquo;{span.quote}&rdquo;</span>
                  <span className="block mt-1 text-[10px] uppercase tracking-wide text-zinc-400">
                    {span.section ? `Section ${span.section}` : 'Unsectioned'}
                    {span.page != null ? ` - page ${span.page}` : ''}
                    {' - '}
                    {span.verified ? 'span verified against source' : 'span not verified'}
                  </span>
                </span>
              </blockquote>
            )}
            {(binding?.source || binding?.event_type) && (
              <p className="mt-2 text-[11px] text-zinc-400 font-mono">
                bound to {binding.source ?? '?'} / {binding.event_type ?? '?'}
                {binding?.unbound ? ' (manual-trigger)' : ''}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
            {isPending && (
              <button
                type="button"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ id: obligation.id, input: { review_status: 'confirmed' } })}
                className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
              >
                {patch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Confirm
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-2.5 py-1.5 text-xs font-medium"
            >
              <Pencil className="h-3.5 w-3.5" />
              {editing ? 'Cancel' : 'Edit / bind'}
            </button>
            {isPending && (
              <button
                type="button"
                disabled={patch.isPending}
                onClick={() => {
                  if (window.confirm('Reject this obligation? It will be marked rejected and cannot arm.')) {
                    patch.mutate({ id: obligation.id, input: { review_status: 'rejected', confirm: true } });
                  }
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </button>
            )}
            {canManualTrigger && canDeadline && (
              <button
                type="button"
                onClick={() => setShowTrigger((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-300 dark:border-amber-900/50 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/10 px-2.5 py-1.5 text-xs font-medium"
              >
                <AlarmClockPlus className="h-3.5 w-3.5" />
                Mark occurred
              </button>
            )}
          </div>
        )}

        {editing && canWrite && <EditForm obligation={obligation} onDone={() => setEditing(false)} patch={patch} />}
        {showTrigger && canManualTrigger && (
          <TriggerForm
            onSubmit={(occurredAt) =>
              trigger.mutate(
                { id: obligation.id, occurredAt },
                { onSuccess: () => setShowTrigger(false) },
              )
            }
            pending={trigger.isPending}
            error={trigger.error instanceof Error ? trigger.error.message : null}
          />
        )}
      </div>
    </li>
  );
}

function EditForm({
  obligation,
  onDone,
  patch,
}: {
  obligation: BulwarkObligation;
  onDone: () => void;
  patch: ReturnType<typeof usePatchObligation>;
}) {
  const binding = obligation.event_binding as { source?: string; event_type?: string; unbound?: boolean };
  const rule = (obligation.deadline_rule ?? {}) as Record<string, unknown>;
  const [title, setTitle] = useState(obligation.title);
  const [type, setType] = useState<BulwarkObligationType>(obligation.obligation_type);
  const [source, setSource] = useState(binding?.source ?? '');
  const [eventType, setEventType] = useState(binding?.event_type ?? '');
  const [unbound, setUnbound] = useState(binding?.unbound === true);
  const [offsetDays, setOffsetDays] = useState(String((rule.offset_days as number) ?? 5));
  const [unit, setUnit] = useState<string>((rule.unit as string) ?? 'calendar_days');
  const [from, setFrom] = useState<string>((rule.from as string) ?? 'trigger_event');

  function save() {
    const input: Parameters<typeof patch.mutate>[0]['input'] = {
      title: title.trim(),
      obligation_type: type,
      event_binding: {
        source: source.trim() || 'bam',
        event_type: eventType.trim() || 'task.overdue',
        unbound,
      },
      deadline_rule: {
        offset_days: Number(offsetDays) || 0,
        unit: unit as 'calendar_days' | 'business_days',
        from: from as 'trigger_event' | 'contract_effective_date' | 'contract_expiry_date',
        timezone: (rule.timezone as string) ?? 'UTC',
        roll_forward: (rule.roll_forward as boolean) ?? true,
        grace_hours: (rule.grace_hours as number) ?? 0,
      },
    };
    patch.mutate({ id: obligation.id, input }, { onSuccess: onDone });
  }

  const inputCls =
    'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-xs';

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-3 space-y-3">
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-zinc-500">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as BulwarkObligationType)} className={inputCls}>
            {OBLIGATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 self-end pb-1.5">
          <input type="checkbox" checked={unbound} onChange={(e) => setUnbound(e.target.checked)} className="h-4 w-4" />
          Manual trigger only (unbound)
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Event source</label>
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="bam" className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Event type</label>
          <input
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="task.overdue"
            className={inputCls}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Offset days</label>
          <input value={offsetDays} onChange={(e) => setOffsetDays(e.target.value)} className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Unit</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
            <option value="calendar_days">calendar_days</option>
            <option value="business_days">business_days</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">From</label>
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls}>
            <option value="trigger_event">trigger_event</option>
            <option value="contract_effective_date">contract_effective_date</option>
            <option value="contract_expiry_date">contract_expiry_date</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={patch.isPending}
          onClick={save}
          className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          {patch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save binding
        </button>
        {patch.isError && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {patch.error instanceof Error ? patch.error.message : 'Save failed.'}
          </span>
        )}
      </div>
    </div>
  );
}

function TriggerForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (occurredAt: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const [when, setWhen] = useState(() => new Date().toISOString().slice(0, 16));
  return (
    <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-900/10 p-3">
      <p className="text-xs text-zinc-600 dark:text-zinc-300 mb-2">
        Record that the triggering event happened. This starts the deadline clock from the time you enter.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-zinc-500">Occurred at</label>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-xs"
          />
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => onSubmit(new Date(when).toISOString())}
          className="inline-flex items-center gap-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlarmClockPlus className="h-3.5 w-3.5" />}
          Start the clock
        </button>
      </div>
      {error && <p className="text-[11px] text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
      <h3 className="font-medium text-red-800 dark:text-red-300">Something went wrong</h3>
      <p className="text-sm text-red-700 dark:text-red-400 mt-1">{message}</p>
    </div>
  );
}
