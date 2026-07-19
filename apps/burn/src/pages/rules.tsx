import { useState } from 'react';
import { Wand2, Trash2, Plus } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BurnSourceType, BurnNonBillableReason, BurnRuleOutcomeKind } from '@bigbluebam/shared';
import { useRules, useCreateRule, useDeleteRule } from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, EmptyState, Btn } from '@/components/primitives';
import { formatPct, cn } from '@/lib/utils';

const SOURCE_TYPES: BurnSourceType[] = ['bam.task', 'bam.time_entry', 'bill.expense', 'bill.line_item', 'bill.invoice'];
const NON_BILLABLE_REASONS: BurnNonBillableReason[] = ['internal', 'pre_sales', 'pto', 'warranty', 'overhead', 'rework'];
// Same guard as the shared schema TITLE_PATTERN_SAFE: glob/substring only, no regex metacharacters.
const TITLE_PATTERN_SAFE = /^[^\\^$.|?*+()[\]{}]*$/;

export function RulesPage() {
  const canWrite = useCan('burn.rule.write');
  const rules = useRules();
  const del = useDeleteRule();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="Attribution Rules"
        subtitle="Deterministic rules run before any retrieval or LLM call. Owner/admin authoring; a rule can neutralize the gate, so it is constrained."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setShowForm((s) => !s)}>
              <Plus className="h-4 w-4" /> New rule
            </Btn>
          ) : undefined
        }
      />

      {showForm && canWrite && <RuleForm onDone={() => setShowForm(false)} />}

      {rules.isLoading ? (
        <LoadingState />
      ) : (rules.data?.data.length ?? 0) === 0 ? (
        <EmptyState title="No rules yet" hint="Create a rule to deterministically attribute a class of work, or exclude it as non-billable." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-4 py-2 font-medium">Matched</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.data!.data.map((r) => (
                <tr key={r.id} className="border-b border-zinc-50 dark:border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-400 font-mono text-xs">{r.priority}</td>
                  <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {r.name}
                    {!r.is_enabled && <span className="ml-2 text-[11px] text-zinc-400">(disabled)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {r.outcome_kind === 'non_billable'
                      ? `non-billable · ${r.outcome_reason ?? ''}`
                      : 'attribute'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {r.match_count} · {formatPct(r.last_match_pct == null ? null : Number(r.last_match_pct))}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canWrite && (
                      <button onClick={() => del.mutate(r.id)} className="text-zinc-300 hover:text-red-500" title="Delete rule">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RuleForm({ onDone }: { onDone: () => void }) {
  const create = useCreateRule();
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(100);
  const [sourceTypes, setSourceTypes] = useState<Set<BurnSourceType>>(new Set());
  const [titlePattern, setTitlePattern] = useState('');
  const [projectIds, setProjectIds] = useState('');
  const [outcomeKind, setOutcomeKind] = useState<BurnRuleOutcomeKind>('non_billable');
  const [deliverableId, setDeliverableId] = useState('');
  const [reason, setReason] = useState<BurnNonBillableReason>('internal');
  const [localError, setLocalError] = useState<string | null>(null);

  const patternInvalid = titlePattern !== '' && !TITLE_PATTERN_SAFE.test(titlePattern);
  const projectIdList = projectIds
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const hasDiscriminator = sourceTypes.size > 0 || titlePattern !== '' || projectIdList.length > 0;

  const submit = () => {
    setLocalError(null);
    if (!hasDiscriminator) {
      setLocalError('A rule match must constrain at least one discriminating key.');
      return;
    }
    if (patternInvalid) {
      setLocalError('Title pattern may not contain regex metacharacters; use glob or substring only.');
      return;
    }
    const match: Record<string, unknown> = {};
    if (sourceTypes.size > 0) match.source_types = Array.from(sourceTypes);
    if (titlePattern) match.title_pattern = titlePattern;
    if (projectIdList.length > 0) match.project_ids = projectIdList;

    create.mutate(
      {
        name,
        priority,
        match: match as never,
        outcome_kind: outcomeKind,
        ...(outcomeKind === 'attribute'
          ? { outcome_deliverable_id: deliverableId || null }
          : { outcome_reason: reason }),
      } as never,
      { onSuccess: onDone },
    );
  };

  const toggleSource = (st: BurnSourceType) =>
    setSourceTypes((s) => {
      const n = new Set(s);
      n.has(st) ? n.delete(st) : n.add(st);
      return n;
    });

  return (
    <Card className="mb-4 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
        <Wand2 className="h-4 w-4 text-primary-500" /> New attribution rule
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. PTO is non-billable" />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Priority (lower runs first)</span>
          <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className={inputCls} />
        </label>
      </div>

      <div>
        <span className="block text-xs text-zinc-500 mb-1">Match — source types</span>
        <div className="flex flex-wrap gap-1.5">
          {SOURCE_TYPES.map((st) => (
            <button
              key={st}
              onClick={() => toggleSource(st)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] font-mono border transition-colors',
                sourceTypes.has(st)
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
              )}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Title pattern (glob or substring only)</span>
          <input
            value={titlePattern}
            onChange={(e) => setTitlePattern(e.target.value)}
            className={cn(inputCls, patternInvalid && 'border-red-400')}
            placeholder="e.g. PTO"
          />
          {patternInvalid && <span className="text-[11px] text-red-500">No regex metacharacters allowed.</span>}
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Project IDs (comma-separated, optional)</span>
          <input value={projectIds} onChange={(e) => setProjectIds(e.target.value)} className={inputCls} placeholder="uuid, uuid" />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Outcome</span>
          <select value={outcomeKind} onChange={(e) => setOutcomeKind(e.target.value as BurnRuleOutcomeKind)} className={inputCls}>
            <option value="non_billable">Exclude as non-billable</option>
            <option value="attribute">Attribute to a deliverable</option>
          </select>
        </label>
        {outcomeKind === 'attribute' ? (
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">Deliverable ID</span>
            <input value={deliverableId} onChange={(e) => setDeliverableId(e.target.value)} className={inputCls} placeholder="uuid" />
          </label>
        ) : (
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">Non-billable reason</span>
            <select value={reason} onChange={(e) => setReason(e.target.value as BurnNonBillableReason)} className={inputCls}>
              {NON_BILLABLE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!hasDiscriminator && (
        <p className="text-[11px] text-amber-500">
          Add at least one discriminating key (source type, title pattern, or project) — an empty match would
          silently attribute the whole ledger.
        </p>
      )}
      {(localError || create.isError) && (
        <p className="text-xs text-red-500">
          {localError ?? 'The rule was rejected. It may match too large a share of the trailing window.'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          size="sm"
          disabled={!name || !hasDiscriminator || patternInvalid || create.isPending}
          onClick={submit}
        >
          Create rule
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}

const inputCls =
  'w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm';
