import { AlertTriangle, CheckCircle2, Grid3x3, ShieldAlert } from 'lucide-react';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState, Btn, Pill } from '@/components/primitives';
import { RealtimeIndicator } from '@/components/realtime-indicator';
import { useBursarRealtime } from '@/hooks/use-bursar-realtime';
import { useExclusionDiff, useRequest } from '@/hooks/use-bursar';
import type { DiffOffer, DiffRow, Verdict } from '@/lib/api';

interface Props {
  requestId: string;
  onNavigate: (path: string) => void;
}

const GAP_VERDICTS: Verdict[] = ['absent', 'excluded_explicit'];

const STATE_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  published: 'green',
  needs_review: 'amber',
  unverified: 'red',
  pending_review: 'amber',
};

function isBlanket(offer: DiffOffer): boolean {
  // The §4.3 blanket-cap defense is what stamps withheld_reason='blanket_cap'; a blanket claim is
  // an offer where the cap withheld one or more mandatory nodes. Prefer an explicit server flag if
  // the endpoint ever sends one.
  if (offer.blanket) return true;
  return offer.rows.some((r) => r.withheld_reason === 'blanket_cap');
}

export function ExclusionDiffPage({ requestId, onNavigate }: Props) {
  const request = useRequest(requestId);
  const diff = useExclusionDiff(requestId);
  const { status: rtStatus } = useBursarRealtime([`request:${requestId}`], (e) => {
    if (e.type === 'matrix.updated' || e.type === 'leveling.progress') diff.refetch();
  });

  const data = diff.data?.data;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Exclusion Diff"
        subtitle={request.data?.data.title}
        actions={
          <div className="flex items-center gap-2">
            <RealtimeIndicator status={rtStatus} />
            <Btn onClick={() => onNavigate(`/requests/${requestId}/level`)}>
              <Grid3x3 className="h-4 w-4" /> Leveling Matrix
            </Btn>
          </div>
        }
      />

      {diff.isLoading ? (
        <LoadingState label="Loading exclusion diff..." />
      ) : diff.isError ? (
        <ErrorState message="No diff yet. Confirm the scope and level the offers to build the exclusion diff." />
      ) : !data || data.offers.length === 0 ? (
        <EmptyState
          title="Nothing to compare yet"
          hint="Level the offers under this request to compare each against the mandatory scope."
        />
      ) : (
        <div className="space-y-8">
          <p className="text-sm text-zinc-500">
            Every mandatory scope node appears for every offer exactly once, in one of three states: published,
            needs review, or unverified. The three always sum to the mandatory-node count ({data.mandatory_count}).
          </p>
          {data.offers.map((offer) => (
            <OfferDiff key={offer.offer_id} offer={offer} mandatoryCount={data.mandatory_count} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfferDiff({ offer, mandatoryCount }: { offer: DiffOffer; mandatoryCount: number }) {
  const blocking = offer.blocking;
  const blanket = isBlanket(offer);
  const gaps = offer.rows.filter((r) => GAP_VERDICTS.includes(r.verdict));
  const unsubstantiated = offer.rows.filter(
    (r) => r.review_status === 'needs_review' || r.review_status === 'unverified',
  );
  // The §4.7 identity, asserted in the UI so a drift is visible.
  const sum = offer.published.length + offer.needs_review.length + offer.unverified.length;

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-4">
        <div className="font-medium text-zinc-900 dark:text-zinc-100">{offer.label ?? 'Offer'}</div>
        <div className="flex items-center gap-1.5 text-xs">
          <Pill tone="green">published {offer.published.length}</Pill>
          <Pill tone="amber">needs review {offer.needs_review.length}</Pill>
          <Pill tone="red">unverified {offer.unverified.length}</Pill>
          <span className="text-zinc-400" title="published + needs_review + unverified">
            = {sum} / {mandatoryCount}
          </span>
        </div>
      </div>

      {/* Blocking banner (§4.7): any needs_review or unverified node blocks a clean verdict. */}
      {blocking && (
        <div
          data-testid="diff-blocking-banner"
          className="px-4 py-3 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 text-sm flex gap-2 border-b border-red-200 dark:border-red-800"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>This offer is not clear.</strong> {unsubstantiated.length} mandatory node
            {unsubstantiated.length === 1 ? ' is' : 's are'} unverified or withheld from a verdict. No clean or
            fully-covered conclusion can be drawn while any node is in that state.
          </div>
        </div>
      )}

      {/* Blanket-claim framing (§4.7): list what the offer does not itemize. */}
      {blanket && (
        <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 text-sm border-b border-amber-200 dark:border-amber-800">
          <div className="flex gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <strong>This offer claims blanket coverage; here is what it does not itemize.</strong>
              <ul className="mt-2 space-y-1">
                {unsubstantiated.map((r) => (
                  <li key={r.scope_node_id} className="flex items-center gap-2">
                    <Pill tone={STATE_TONE[r.review_status] ?? 'zinc'}>{r.review_status}</Pill>
                    <span>{r.title}</span>
                    {r.withheld_reason && <span className="text-xs text-amber-700 dark:text-amber-300">({r.withheld_reason})</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* The clean affordance renders ONLY when nothing is needs_review/unverified (UI rule 2). */}
      {!blocking && gaps.length === 0 && (
        <div
          data-testid="diff-clean-state"
          className="px-4 py-3 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 text-sm flex gap-2"
        >
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>No gaps on mandatory scope. Every mandatory node is published as covered.</div>
        </div>
      )}

      {/* Every mandatory node, exactly once. */}
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">Mandatory node</th>
            <th className="px-4 py-2 font-medium">Verdict</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Withheld reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {offer.rows.map((r) => (
            <DiffRowView key={r.scope_node_id} row={r} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const VERDICT_LABEL: Record<string, string> = {
  covered: 'Covered',
  partial: 'Partial',
  excluded_explicit: 'Excluded',
  absent: 'Absent',
  ambiguous: 'Ambiguous',
  not_applicable: 'N/A',
  unverified: 'Unverified',
};
const VERDICT_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  covered: 'green',
  partial: 'sky',
  excluded_explicit: 'red',
  absent: 'red',
  ambiguous: 'amber',
  not_applicable: 'zinc',
  unverified: 'zinc',
};

function DiffRowView({ row }: { row: DiffRow }) {
  const gap = GAP_VERDICTS.includes(row.verdict);
  return (
    <tr className={gap ? 'bg-red-50/40 dark:bg-red-900/10' : undefined}>
      <td className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-100">{row.title}</td>
      <td className="px-4 py-2">
        <Pill tone={VERDICT_TONE[row.verdict] ?? 'zinc'}>{VERDICT_LABEL[row.verdict] ?? row.verdict}</Pill>
      </td>
      <td className="px-4 py-2">
        <Pill tone={STATE_TONE[row.review_status] ?? 'zinc'}>{row.review_status}</Pill>
      </td>
      <td className="px-4 py-2 text-zinc-500">{row.withheld_reason ?? '-'}</td>
    </tr>
  );
}
