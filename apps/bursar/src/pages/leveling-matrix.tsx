import { useMemo, useState } from 'react';
import { Play, X, Grid3x3, GitCompareArrows } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn, Pill } from '@/components/primitives';
import { RealtimeIndicator } from '@/components/realtime-indicator';
import { useBursarRealtime } from '@/hooks/use-bursar-realtime';
import {
  useMatrix,
  useRequest,
  useLevelingRuns,
  useStartLeveling,
} from '@/hooks/use-bursar';
import type {
  ConfidenceBand,
  MatrixCoverage,
  MatrixOffer,
  MatrixTotal,
} from '@/lib/api';
import { formatCents, num } from '@/lib/utils';

interface Props {
  requestId: string;
  onNavigate: (path: string) => void;
}

const VERDICT_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  covered: 'green',
  partial: 'sky',
  excluded_explicit: 'red',
  absent: 'red',
  ambiguous: 'amber',
  not_applicable: 'zinc',
  unverified: 'zinc',
};
const VERDICT_LABEL: Record<string, string> = {
  covered: 'Covered',
  partial: 'Partial',
  excluded_explicit: 'Excluded',
  absent: 'Absent',
  ambiguous: 'Ambiguous',
  not_applicable: 'N/A',
  unverified: 'Unverified',
};

// A published gap that counts toward the headline aggregate: an explicit omission/exclusion the
// engine cleared. Medium-band verdicts are DELIBERATELY excluded here (UI rule 1).
function isCountedGap(c: MatrixCoverage): boolean {
  if (c.review_status !== 'published') return false;
  if (c.confidence_band === 'medium') return false;
  return c.verdict === 'absent' || c.verdict === 'excluded_explicit';
}

export function LevelingMatrixPage({ requestId, onNavigate }: Props) {
  const canRun = useCan('bursar.leveling.run');
  const request = useRequest(requestId);
  const matrix = useMatrix(requestId);
  const runs = useLevelingRuns(requestId);
  const start = useStartLeveling(requestId);
  const [selected, setSelected] = useState<{ node_id: string; offer: MatrixOffer; cov: MatrixCoverage | null } | null>(
    null,
  );

  const { status: rtStatus } = useBursarRealtime([`request:${requestId}`], (e) => {
    if (e.type === 'matrix.updated' || e.type === 'leveling.progress') {
      matrix.refetch();
      runs.refetch();
    }
  });

  const liveRun = (runs.data?.data ?? []).find((r) => r.status === 'running') ?? null;

  const model = useMemo(() => {
    const d = matrix.data?.data;
    if (!d) return null;
    const covByKey = new Map<string, MatrixCoverage>();
    for (const c of d.coverage) covByKey.set(`${c.offer_id}:${c.scope_node_id}`, c);
    const totalsByOffer = new Map<string, Map<string, MatrixTotal>>();
    for (const t of d.totals) {
      const m = totalsByOffer.get(t.offer_id) ?? new Map<string, MatrixTotal>();
      m.set(t.total_kind, t);
      totalsByOffer.set(t.offer_id, m);
    }
    // Sort offers by the server-chosen key: gap_adjusted only when renderable, else stated.
    const sortKey = d.sort_key;
    const offers = [...d.offers].sort((a, b) => {
      const ta = num(totalsByOffer.get(a.id)?.get(sortKey)?.amount_minor, Number.POSITIVE_INFINITY);
      const tb = num(totalsByOffer.get(b.id)?.get(sortKey)?.amount_minor, Number.POSITIVE_INFINITY);
      return ta - tb;
    });
    return { nodes: d.nodes, offers, covByKey, totalsByOffer, sortKey };
  }, [matrix.data]);

  // Headline aggregate across the whole matrix, medium band excluded. The contributing band set is
  // published on a data attribute so Playwright can assert medium never contributed.
  const headline = useMemo(() => {
    const d = matrix.data?.data;
    if (!d) return { gapCount: 0, bands: [] as string[] };
    let gapCount = 0;
    const bands = new Set<string>();
    for (const c of d.coverage) {
      if (isCountedGap(c)) {
        gapCount++;
        bands.add(c.confidence_band ?? 'unbanded');
      }
    }
    return { gapCount, bands: [...bands].sort() };
  }, [matrix.data]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Leveling Matrix"
        subtitle={request.data?.data.title}
        actions={
          <div className="flex items-center gap-2">
            <RealtimeIndicator status={rtStatus} />
            <Btn onClick={() => onNavigate(`/requests/${requestId}/diff`)}>
              <GitCompareArrows className="h-4 w-4" /> Exclusion Diff
            </Btn>
            {canRun && (
              <Btn variant="primary" onClick={() => start.mutate({})} disabled={start.isPending || !!liveRun}>
                <Play className="h-4 w-4" /> {liveRun ? 'Leveling...' : 'Level offers'}
              </Btn>
            )}
          </div>
        }
      />

      <RunProgress runId={liveRun?.id} runs={runs.data?.data ?? []} />

      {/* Headline aggregate. data-contributing-bands proves medium was never counted (UI rule 1). */}
      <div
        className="mb-4 flex items-center gap-3 text-sm"
        data-testid="matrix-headline-aggregate"
        data-contributing-bands={headline.bands.join(',')}
      >
        <span className="text-zinc-500">Published gaps (medium band excluded):</span>
        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{headline.gapCount}</span>
        {model && (
          <span className="text-xs text-zinc-400">
            sorted by {model.sortKey === 'gap_adjusted' ? 'gap-adjusted comparable total' : 'stated total'}
          </span>
        )}
      </div>

      {matrix.isLoading ? (
        <LoadingState label="Loading matrix..." />
      ) : matrix.isError ? (
        <ErrorState message="No matrix yet. Confirm the scope, then level the offers to build one." />
      ) : !model || model.offers.length === 0 || model.nodes.length === 0 ? (
        <EmptyState
          title="Nothing to level yet"
          hint="Add offers under this request and run leveling to populate the coverage grid."
          icon={<Grid3x3 className="h-8 w-8" />}
        />
      ) : (
        <div className="flex gap-4">
          <Card className="overflow-x-auto flex-1">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <th className="px-3 py-2 font-medium sticky left-0 bg-white dark:bg-zinc-900">Scope node</th>
                  {model.offers.map((o) => (
                    <OfferHeader key={o.id} offer={o} totals={model.totalsByOffer.get(o.id)} sortKey={model.sortKey} />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {model.nodes.map((n) => (
                  <tr key={n.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="px-3 py-2 sticky left-0 bg-white dark:bg-zinc-900">
                      <div className="flex items-center gap-1.5">
                        {n.normative_strength === 'mandatory' && <Pill tone="red">M</Pill>}
                        <span className="font-medium text-zinc-800 dark:text-zinc-100">{n.title}</span>
                      </div>
                    </td>
                    {model.offers.map((o) => {
                      const cov = model.covByKey.get(`${o.id}:${n.id}`) ?? null;
                      return (
                        <td key={o.id} className="px-3 py-2 text-center">
                          <VerdictChip cov={cov} onClick={() => setSelected({ node_id: n.id, offer: o, cov })} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {selected && (
            <CellDetail
              node={model.nodes.find((n) => n.id === selected.node_id)?.title ?? 'Node'}
              offer={selected.offer}
              cov={selected.cov}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OfferHeader({
  offer,
  totals,
  sortKey,
}: {
  offer: MatrixOffer;
  totals: Map<string, MatrixTotal> | undefined;
  sortKey: 'gap_adjusted' | 'stated';
}) {
  const primary = totals?.get(sortKey);
  const renderable = primary?.renderable !== false;
  const gapCount = primary?.unvalued_gap_count ?? 0;
  return (
    <th className="px-3 py-2 font-medium align-top min-w-[9rem]">
      <div className="text-zinc-800 dark:text-zinc-100 normal-case">{offer.label ?? 'Offer'}</div>
      <div className="mt-1 normal-case">
        {renderable ? (
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {formatCents(primary?.amount_minor ?? null, offer.currency ?? 'USD')}
          </span>
        ) : (
          // Spec 10.2: when gaps cannot be valued we NEVER fabricate a number; we show the count.
          <span className="text-xs text-amber-600 dark:text-amber-400" title="Comparable total not renderable">
            {gapCount} unpriced gap{gapCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {offer.blanket_suspected && (
        <div className="mt-1 normal-case">
          <Pill tone="amber">blanket</Pill>
        </div>
      )}
    </th>
  );
}

function VerdictChip({ cov, onClick }: { cov: MatrixCoverage | null; onClick: () => void }) {
  if (!cov) {
    return (
      <button onClick={onClick} className="text-[11px] text-zinc-400 hover:underline" title="No coverage row yet">
        -
      </button>
    );
  }
  const withheld = cov.review_status === 'needs_review' && cov.withheld_reason;
  const isMedium = cov.confidence_band === 'medium';
  return (
    <button onClick={onClick} className="inline-flex flex-col items-center gap-0.5" title="Open evidence">
      <span
        // A medium-band verdict is visually distinct (dashed violet ring) and carries a testid
        // whose value names the band, so Playwright can assert it is excluded from aggregates.
        data-testid={isMedium ? 'verdict-medium-band' : undefined}
        data-band={cov.confidence_band ?? 'unbanded'}
        className={
          isMedium
            ? 'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200 ring-1 ring-dashed ring-violet-400'
            : undefined
        }
      >
        {isMedium ? (
          <span>{VERDICT_LABEL[cov.verdict] ?? cov.verdict} (medium)</span>
        ) : (
          <Pill tone={VERDICT_TONE[cov.verdict] ?? 'zinc'}>{VERDICT_LABEL[cov.verdict] ?? cov.verdict}</Pill>
        )}
      </span>
      {withheld && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">withheld: {cov.withheld_reason}</span>
      )}
    </button>
  );
}

function bandLabel(b: ConfidenceBand): string {
  return b ? b : 'unbanded';
}

function CellDetail({
  node,
  offer,
  cov,
  onClose,
}: {
  node: string;
  offer: MatrixOffer;
  cov: MatrixCoverage | null;
  onClose: () => void;
}) {
  const hasEvidence =
    !!cov &&
    (cov.cited_span?.quote != null ||
      (cov.matched_line_ids?.length ?? 0) > 0 ||
      (cov.rejected_candidates?.length ?? 0) > 0);
  return (
    <Card className="w-80 shrink-0 p-4 space-y-3 h-fit">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{node}</div>
          <div className="text-xs text-zinc-500">{offer.label ?? 'Offer'}</div>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!cov ? (
        <p className="text-sm text-zinc-500">No coverage row for this cell yet.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone={VERDICT_TONE[cov.verdict] ?? 'zinc'}>{VERDICT_LABEL[cov.verdict] ?? cov.verdict}</Pill>
            <Pill tone={cov.confidence_band === 'medium' ? 'violet' : 'zinc'}>band: {bandLabel(cov.confidence_band)}</Pill>
            <Pill tone="zinc">{cov.review_status}</Pill>
            {cov.withheld_reason && <Pill tone="amber">withheld: {cov.withheld_reason}</Pill>}
          </div>

          {cov.delta_kind && (
            <div className="text-xs text-zinc-500">
              Delta: {cov.delta_kind}
              {cov.delta_amount_minor != null && ` (${formatCents(cov.delta_amount_minor, offer.currency ?? 'USD')})`}
            </div>
          )}

          {/* Cited span. */}
          {cov.cited_span?.quote && (
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Cited span</div>
              <p className="text-xs text-zinc-500 italic border-l-2 border-zinc-200 dark:border-zinc-700 pl-2">
                "{cov.cited_span.quote}"
                {cov.cited_span.cited_line != null && (
                  <span className="not-italic text-zinc-400"> (line {cov.cited_span.cited_line})</span>
                )}
              </p>
            </div>
          )}

          {/* Matched lines. */}
          {(cov.matched_line_ids?.length ?? 0) > 0 && (
            <div className="text-xs text-zinc-500">Matched lines: {cov.matched_line_ids!.length}</div>
          )}

          {/* For an absent verdict: the rejected candidates the engine considered and dropped. */}
          {cov.verdict === 'absent' && (cov.rejected_candidates?.length ?? 0) > 0 && (
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Rejected candidates</div>
              <ul className="space-y-1">
                {cov.rejected_candidates!.map((r, i) => (
                  <li key={i} className="text-xs text-zinc-500">
                    {typeof r === 'string' ? r : r.quote || r.reason || `line ${r.line ?? '?'}`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasEvidence && (
            <p className="text-xs text-zinc-400">
              The evidence trail (cited span, matched lines, rejected candidates) opens here when the coverage row
              carries it.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function RunProgress({ runId, runs }: { runId: string | undefined; runs: Array<{ id: string; status: string; offer_count: number; node_count: number; offers_done?: number | null; nodes_done?: number | null; windows_done?: number | null; windows_total?: number | null; error: string | null }> }) {
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  if (!run) return null;
  if (run.status === 'rejected_limits') {
    return (
      <div className="mb-4 rounded border border-red-300 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 px-3 py-2 text-sm">
        {run.error ?? 'Leveling rejected: too many offers for one run.'}
      </div>
    );
  }
  if (run.status !== 'running' && run.status !== 'partial') return null;
  const offers = `offer ${num(run.offers_done, 0)}/${run.offer_count}`;
  const nodes = `node ${num(run.nodes_done, 0)}/${run.node_count}`;
  const windows =
    run.windows_total != null ? `window ${num(run.windows_done, 0)}/${num(run.windows_total, 0)}` : null;
  return (
    <div className="mb-4 rounded border border-sky-300 bg-sky-50 dark:bg-sky-900/30 text-sky-900 dark:text-sky-100 px-3 py-2 text-sm">
      Leveling in progress: {offers}, {nodes}
      {windows ? `, ${windows}` : ''}. Progress refreshes every 5 seconds.
    </div>
  );
}
