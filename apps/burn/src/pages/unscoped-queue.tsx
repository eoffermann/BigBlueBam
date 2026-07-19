import { useEffect, useMemo, useState } from 'react';
import { Check, X, Ban, FileWarning, Wand2, Plus } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BurnUnscopedBucket, BurnNonBillableReason } from '@bigbluebam/shared';
import {
  useUnscoped,
  useDeliverables,
  useUpdateAttribution,
  useBulkAttributions,
  useDraftChangeOrder,
  type UnscopedRow,
} from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn } from '@/components/primitives';
import { AttributionStateBadge, bucketLabel, ValuationBasisBadge } from '@/components/badges';
import { formatCents, cn } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

const BUCKETS: { id: BurnUnscopedBucket; hint: string }[] = [
  { id: 'sold_by_nobody', hint: 'Work mapped to an engagement but to no deliverable anyone sold.' },
  { id: 'unclassified', hint: 'The classifier could not place this with enough confidence.' },
  { id: 'outside_contract', hint: 'No active engagement covers this work at all.' },
];

const NON_BILLABLE_REASONS: BurnNonBillableReason[] = [
  'internal',
  'pre_sales',
  'pto',
  'warranty',
  'overhead',
  'rework',
];

export function UnscopedQueuePage({ onNavigate }: Props) {
  const canReadAll = useCan('burn.financials.read_all');
  const canWrite = useCan('burn.attribution.write');
  const canRule = useCan('burn.rule.write');
  const [bucket, setBucket] = useState<BurnUnscopedBucket>('sold_by_nobody');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const [picker, setPicker] = useState<string | null>(null); // attribution id whose picker is open

  const { data, isLoading, isError } = useUnscoped(bucket);
  const rows = useMemo(() => data?.data ?? [], [data]);
  const update = useUpdateAttribution();
  const bulk = useBulkAttributions();
  const draftCO = useDraftChangeOrder();

  useEffect(() => {
    setSelected(new Set());
    setFocusIdx(0);
    setPicker(null);
  }, [bucket]);

  const act = (row: UnscopedRow | undefined, verb: string) => {
    if (!row || !canWrite) return;
    if (verb === 'c') update.mutate({ id: row.id, input: { state: 'confirmed' } });
    else if (verb === 'u') update.mutate({ id: row.id, input: { state: 'unscoped' } });
    else if (verb === 'n')
      update.mutate({ id: row.id, input: { state: 'excluded_non_billable', non_billable_reason: 'internal' } });
    else if (verb === 'a') setPicker(row.id);
    else if (verb === 'o' && row.engagement_id)
      draftCO.mutate({ engagement_id: row.engagement_id, deliverable_id: null });
    else if (verb === 'r' && canRule) onNavigate('/settings/rules');
  };

  // Keyboard shortcuts (spec 7.2): a attribute, c confirm, u unscoped, n non-billable,
  // o change order, r rule from cluster.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (!['a', 'c', 'u', 'n', 'o', 'r', 'j', 'k'].includes(e.key)) return;
      const row = rows[focusIdx];
      if (e.key === 'j') setFocusIdx((i) => Math.min(rows.length - 1, i + 1));
      else if (e.key === 'k') setFocusIdx((i) => Math.max(0, i - 1));
      else act(row, e.key);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, focusIdx, canWrite, canRule]);

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const bulkApply = (state: 'unscoped' | 'excluded_non_billable') => {
    if (selected.size === 0) return;
    bulk.mutate(
      {
        attribution_ids: Array.from(selected),
        action:
          state === 'excluded_non_billable'
            ? { state, non_billable_reason: 'internal' }
            : { state },
      },
      { onSuccess: () => setSelected(new Set()) },
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Unscoped Queue"
        subtitle="Work someone is doing that nobody sold. Three buckets, three figures, never summed."
      />

      {/* Bucket tabs */}
      <div className="flex flex-wrap gap-2 mb-1">
        {BUCKETS.map((b) => (
          <button
            key={b.id}
            onClick={() => setBucket(b.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              bucket === b.id
                ? 'bg-primary-600 text-white'
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {bucketLabel(b.id)}
          </button>
        ))}
      </div>
      <p className="text-xs text-zinc-400 mb-4">{BUCKETS.find((b) => b.id === bucket)?.hint}</p>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <Card className="mb-4 p-3 flex items-center justify-between bg-primary-50 dark:bg-primary-900/10 border-primary-200 dark:border-primary-800">
          <span className="text-sm text-zinc-700 dark:text-zinc-200">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Btn size="sm" onClick={() => bulkApply('unscoped')} disabled={!canWrite || bulk.isPending}>
              Mark unscoped
            </Btn>
            <Btn size="sm" onClick={() => bulkApply('excluded_non_billable')} disabled={!canWrite || bulk.isPending}>
              Mark non-billable
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Btn>
          </div>
        </Card>
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message="Could not load the unscoped queue." />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing in this bucket" hint="Every unit of work here has found its priced envelope." />
      ) : (
        <>
          <div className="text-[11px] text-zinc-400 mb-2">
            Keys: <kbd>a</kbd> attribute · <kbd>c</kbd> confirm · <kbd>u</kbd> unscoped · <kbd>n</kbd>{' '}
            non-billable · <kbd>o</kbd> change order{canRule ? ' · ' : ''}
            {canRule && (
              <>
                <kbd>r</kbd> rule
              </>
            )}{' '}
            · <kbd>j</kbd>/<kbd>k</kbd> move
          </div>
          <Card>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((row, i) => (
                <UnscopedRowItem
                  key={row.id}
                  row={row}
                  focused={i === focusIdx}
                  selected={selected.has(row.id)}
                  canReadAll={canReadAll}
                  canWrite={canWrite}
                  canRule={canRule}
                  onFocus={() => setFocusIdx(i)}
                  onToggleSel={() => toggleSel(row.id)}
                  onAct={(verb) => act(row, verb)}
                  pickerOpen={picker === row.id}
                  onClosePicker={() => setPicker(null)}
                />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function UnscopedRowItem({
  row,
  focused,
  selected,
  canReadAll,
  canWrite,
  canRule,
  onFocus,
  onToggleSel,
  onAct,
  pickerOpen,
  onClosePicker,
}: {
  row: UnscopedRow;
  focused: boolean;
  selected: boolean;
  canReadAll: boolean;
  canWrite: boolean;
  canRule: boolean;
  onFocus: () => void;
  onToggleSel: () => void;
  onAct: (verb: string) => void;
  pickerOpen: boolean;
  onClosePicker: () => void;
}) {
  const update = useUpdateAttribution();
  const [nbOpen, setNbOpen] = useState(false);
  const wi = row.work_item;

  return (
    <li
      className={cn('p-3', focused && 'bg-primary-50/40 dark:bg-primary-900/10')}
      onMouseEnter={onFocus}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSel}
          className="mt-1"
          aria-label="Select row"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate">
              {wi.title_snapshot ?? row.work_item_id.slice(0, 8)}
            </span>
            <AttributionStateBadge state={row.state as never} />
            <ValuationBasisBadge basis={wi.valuation_basis as never} />
            <span className="text-[11px] text-zinc-400 font-mono">{wi.source_type}</span>
          </div>
          {wi.text_snapshot && (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">{wi.text_snapshot}</p>
          )}
          <div className="mt-1 text-[11px] text-zinc-400">
            {canReadAll && wi.billable_amount != null
              ? `${formatCents(wi.billable_amount, wi.currency ?? 'USD')} billable`
              : null}
            {wi.minutes != null ? ` · ${Math.round(wi.minutes / 60)}h logged` : null}
          </div>
        </div>

        {canWrite && (
          <div className="flex items-center gap-1 shrink-0 relative">
            <Btn size="sm" variant="primary" onClick={() => onAct('a')} title="Attribute to a deliverable (a)">
              <Wand2 className="h-3.5 w-3.5" /> Attribute
            </Btn>
            <Btn size="sm" onClick={() => onAct('c')} title="Confirm (c)">
              <Check className="h-3.5 w-3.5" />
            </Btn>
            <Btn size="sm" onClick={() => onAct('u')} title="Mark unscoped (u)">
              <X className="h-3.5 w-3.5" />
            </Btn>
            <Btn size="sm" onClick={() => setNbOpen((o) => !o)} title="Mark non-billable (n)">
              <Ban className="h-3.5 w-3.5" />
            </Btn>
            {row.engagement_id && (
              <Btn size="sm" onClick={() => onAct('o')} title="Raise a change order (o)">
                <FileWarning className="h-3.5 w-3.5" />
              </Btn>
            )}
            {canRule && (
              <Btn size="sm" variant="ghost" onClick={() => onAct('r')} title="Create a rule from this cluster (r)">
                <Plus className="h-3.5 w-3.5" />
              </Btn>
            )}

            {nbOpen && (
              <div className="absolute right-0 top-8 z-10 w-44 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1">
                {NON_BILLABLE_REASONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      update.mutate({ id: row.id, input: { state: 'excluded_non_billable', non_billable_reason: r } });
                      setNbOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {r.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <DeliverablePicker
          engagementId={row.engagement_id}
          onPick={(deliverableId) => {
            update.mutate(
              { id: row.id, input: { state: 'confirmed', deliverable_id: deliverableId } },
              { onSuccess: onClosePicker },
            );
          }}
          onClose={onClosePicker}
        />
      )}
    </li>
  );
}

function DeliverablePicker({
  engagementId,
  onPick,
  onClose,
}: {
  engagementId: string | null;
  onPick: (deliverableId: string) => void;
  onClose: () => void;
}) {
  const { data, isLoading } = useDeliverables(engagementId ? { engagementId } : {});
  const items = data?.data ?? [];
  return (
    <div className="mt-3 ml-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Attribute to deliverable</span>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
          <X className="h-4 w-4" />
        </button>
      </div>
      {isLoading ? (
        <div className="text-xs text-zinc-400 py-2">Loading deliverables...</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-zinc-400 py-2">No deliverables available for this engagement.</div>
      ) : (
        <ul className="space-y-1 max-h-60 overflow-auto">
          {items.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => onPick(d.id)}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-700 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800 flex items-center justify-between gap-2"
              >
                <span className="truncate">{d.title}</span>
                <span className="text-[10px] text-zinc-400 shrink-0">
                  {d.envelope_source === 'unpriced' ? 'unpriced' : d.is_active ? 'priced' : 'unconfirmed'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
