import { useState } from 'react';
import { ClipboardCheck, Link2, FileEdit, Check, X } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BursarVerdict } from '@bigbluebam/shared';
import { PageHeader, Card, LoadingState, EmptyState, Btn, Pill } from '@/components/primitives';
import { useReview, useOverrideCoverage, useAliasReview, useDrafts, useDecideDraft } from '@/hooks/use-bursar';
import type { ReviewRow } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

type Tab = 'coverage' | 'aliases' | 'drafts';

export function ReviewQueuePage({ onNavigate }: Props) {
  const [tab, setTab] = useState<Tab>('coverage');
  const review = useReview();
  const aliases = useAliasReview();
  const drafts = useDrafts();

  const counts = {
    coverage: review.data?.data.length ?? 0,
    aliases: aliases.data?.data.length ?? 0,
    drafts: drafts.data?.data.length ?? 0,
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Review Queue"
        subtitle="Where a human adjudicates what the engine could not settle: coverage verdicts, payee links, and drafted correspondence."
      />

      <div className="mb-5 flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        <TabBtn label="Coverage adjudication" count={counts.coverage} active={tab === 'coverage'} onClick={() => setTab('coverage')} />
        <TabBtn label="Alias review" count={counts.aliases} active={tab === 'aliases'} onClick={() => setTab('aliases')} />
        <TabBtn label="Drafts" count={counts.drafts} active={tab === 'drafts'} onClick={() => setTab('drafts')} />
      </div>

      {tab === 'coverage' && <CoverageTab review={review} onNavigate={onNavigate} />}
      {tab === 'aliases' && <AliasTab aliases={aliases} onNavigate={onNavigate} />}
      {tab === 'drafts' && <DraftTab drafts={drafts} onNavigate={onNavigate} />}

      <p className="mt-6 text-xs text-zinc-400">
        Rival-proposal promotion is adjudicated in each request's Scope Tree editor, where the promoter can see the
        supporting offers before promoting a node into the counted tree.
      </p>
    </div>
  );
}

function TabBtn({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
        active
          ? 'border-primary-600 text-primary-700 dark:text-primary-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
      }`}
    >
      {label} <span className="text-xs text-zinc-400">({count})</span>
    </button>
  );
}

function CoverageTab({ review, onNavigate }: { review: ReturnType<typeof useReview>; onNavigate: (p: string) => void }) {
  const canOverride = useCan('bursar.coverage.override');
  if (review.isLoading) return <LoadingState />;
  if (review.isError || (review.data?.data.length ?? 0) === 0) {
    return <EmptyState title="No coverage to adjudicate" hint="Every verdict has cleared review, or the endpoint is not wired in yet." icon={<ClipboardCheck className="h-8 w-8" />} />;
  }
  return (
    <div className="space-y-3">
      {review.data!.data.map((r) => (
        <CoverageReviewRow key={r.id} row={r} canOverride={canOverride} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function CoverageReviewRow({ row, canOverride, onNavigate }: { row: ReviewRow; canOverride: boolean; onNavigate: (p: string) => void }) {
  const override = useOverrideCoverage();
  const [verdict, setVerdict] = useState<BursarVerdict>('covered');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{row.node_title}</div>
          <div className="text-xs text-zinc-400">
            {row.offer_label ?? 'Offer'}
            {' / '}
            <button className="text-primary-600 hover:underline" onClick={() => onNavigate(`/requests/${row.request_id}/level`)}>
              open matrix
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Pill tone="red">{row.verdict}</Pill>
          {row.withheld_reason && <Pill tone="amber">withheld: {row.withheld_reason}</Pill>}
          {row.confidence_band && <Pill tone={row.confidence_band === 'medium' ? 'violet' : 'zinc'}>{row.confidence_band}</Pill>}
        </div>
      </div>
      {canOverride && (
        <div className="mt-3">
          {!open ? (
            <Btn size="sm" onClick={() => setOpen(true)}>
              Adjudicate
            </Btn>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                <span className="block text-zinc-500 mb-1">Verdict</span>
                <select
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value as BursarVerdict)}
                  className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm"
                >
                  {(['covered', 'partial', 'excluded_explicit', 'absent', 'ambiguous', 'not_applicable'] as const).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs flex-1 min-w-[12rem]">
                <span className="block text-zinc-500 mb-1">Reason</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm"
                  placeholder="Why this verdict"
                />
              </label>
              <Btn
                size="sm"
                variant="primary"
                disabled={!reason.trim() || override.isPending}
                onClick={() => override.mutate({ id: row.id, input: { verdict, reason: reason.trim() } })}
              >
                Apply
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Btn>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function AliasTab({ aliases, onNavigate }: { aliases: ReturnType<typeof useAliasReview>; onNavigate: (p: string) => void }) {
  if (aliases.isLoading) return <LoadingState />;
  if (aliases.isError || (aliases.data?.data.length ?? 0) === 0) {
    return <EmptyState title="No aliases to review" hint="No payee strings are sitting between the match thresholds." icon={<Link2 className="h-8 w-8" />} />;
  }
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">Payee string</th>
            <th className="px-4 py-2 font-medium">Confidence</th>
            <th className="px-4 py-2 font-medium">Last seen</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {aliases.data!.data.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-200">{a.raw_payee}</td>
              <td className="px-4 py-2.5 text-zinc-500">{a.confidence}</td>
              <td className="px-4 py-2.5 text-zinc-500 text-xs">{formatDate(a.last_seen_at)}</td>
              <td className="px-4 py-2.5 text-right">
                {a.vendor_id && (
                  <button className="text-primary-600 hover:underline text-xs" onClick={() => onNavigate(`/vendors/${a.vendor_id}`)}>
                    vendor
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function DraftTab({ drafts, onNavigate }: { drafts: ReturnType<typeof useDrafts>; onNavigate: (p: string) => void }) {
  const decide = useDecideDraft();
  const canApprove = useCan('bursar.draft.approve');
  if (drafts.isLoading) return <LoadingState />;
  if (drafts.isError || (drafts.data?.data.length ?? 0) === 0) {
    return <EmptyState title="No drafts" hint="No clarification or negotiation drafts are pending approval." icon={<FileEdit className="h-8 w-8" />} />;
  }
  return (
    <div className="space-y-3">
      {drafts.data!.data.map((d) => (
        <Card key={d.id} className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Pill tone="sky">{d.kind.replace(/_/g, ' ')}</Pill>
                <Pill tone={d.status === 'pending' ? 'amber' : d.status === 'approved' ? 'green' : 'zinc'}>{d.status}</Pill>
              </div>
              {d.subject && <div className="mt-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">{d.subject}</div>}
              {d.body && <p className="mt-1 text-xs text-zinc-500 line-clamp-3 whitespace-pre-wrap">{d.body}</p>}
              {d.request_id && (
                <button className="mt-1 text-xs text-primary-600 hover:underline" onClick={() => onNavigate(`/requests/${d.request_id}`)}>
                  open request
                </button>
              )}
            </div>
            {canApprove && d.status === 'pending' && (
              <div className="flex items-center gap-1 shrink-0">
                <Btn size="sm" variant="primary" title="Approve" onClick={() => decide.mutate({ id: d.id, action: 'approve' })}>
                  <Check className="h-3.5 w-3.5" />
                </Btn>
                <Btn size="sm" variant="ghost" title="Reject" onClick={() => decide.mutate({ id: d.id, action: 'reject' })}>
                  <X className="h-3.5 w-3.5" />
                </Btn>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
