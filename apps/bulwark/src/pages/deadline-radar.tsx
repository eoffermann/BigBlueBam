import { useState } from 'react';
import {
  Radar,
  Loader2,
  CheckCircle2,
  Ban,
  Clock,
  AlertTriangle,
  FileSignature,
} from 'lucide-react';
import type { BulwarkNoticeDeadline } from '@bigbluebam/shared';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useDeadlines,
  useWaiverRisks,
  useDischargeDeadline,
  useDraftNotice,
} from '@/hooks/use-bulwark';
import { cn, formatCountdown, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { DeadlineStatusBadge, NoticeStatusBadge, SeverityBadge } from '@/components/badges';

interface Props {
  onNavigate: (path: string) => void;
}

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'missed', label: 'Missed' },
  { key: 'discharged', label: 'Discharged' },
  { key: 'waived', label: 'Waived' },
  { key: '', label: 'All' },
];

export function DeadlineRadarPage({ onNavigate }: Props) {
  const [status, setStatus] = useState('open');
  const deadlinesQuery = useDeadlines({ status: status || undefined, limit: 100 });
  const risksQuery = useWaiverRisks({ status: 'open', limit: 100 });

  const deadlines = deadlinesQuery.data?.data ?? [];
  const risks = risksQuery.data?.data ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Radar className="h-6 w-6 text-primary-500" />
          Deadline radar
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Armed deadlines fired against logged events, with live countdowns. Discharge when satisfied,
          or waive to close a clock the org has decided not to act on.
        </p>
      </div>

      {/* Open waiver risks banner */}
      {risks.length > 0 && (
        <div className="mb-5 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-900/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {risks.length} open waiver risk{risks.length === 1 ? '' : 's'}
            </h2>
          </div>
          <ul className="space-y-1.5">
            {risks.slice(0, 6).map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-xs">
                <SeverityBadge severity={r.severity} />
                <span className="text-zinc-700 dark:text-zinc-300">{r.reason.replace(/_/g, ' ')}</span>
                <button
                  onClick={() => onNavigate(`/contracts/${r.contract_id}`)}
                  className="text-primary-600 dark:text-primary-400 hover:underline font-mono truncate"
                >
                  {r.contract_id.slice(0, 8)}
                </button>
                <span className="text-zinc-400">{formatRelativeTime(r.detected_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status filter */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
              status === f.key
                ? 'bg-primary-600 text-white border-primary-600'
                : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {deadlinesQuery.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
          ))}
        </div>
      ) : deadlinesQuery.isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load the radar</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {deadlinesQuery.error instanceof Error ? deadlinesQuery.error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : deadlines.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Radar className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">Radar clear</h3>
          <p className="text-sm text-zinc-500 mt-1">No deadlines match this filter.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {deadlines.map((d) => (
            <DeadlineRow key={d.id} deadline={d} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeadlineRow({
  deadline,
  onNavigate,
}: {
  deadline: BulwarkNoticeDeadline;
  onNavigate: (path: string) => void;
}) {
  const canDeadline = useCan('bulwark.deadline.write');
  const canNotice = useCan('bulwark.notice.draft');
  const discharge = useDischargeDeadline();
  const draftNotice = useDraftNotice();

  const countdown = formatCountdown(deadline.due_at);
  const isOpen = deadline.status === 'open';
  const busy = discharge.isPending;

  return (
    <li className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 px-4 py-3">
        {/* Countdown */}
        <div className="flex items-center gap-2 shrink-0 w-40">
          <Clock
            className={cn(
              'h-4 w-4',
              deadline.status === 'discharged'
                ? 'text-emerald-500'
                : countdown.overdue
                  ? 'text-red-500'
                  : 'text-amber-500',
            )}
          />
          <div>
            <div
              className={cn(
                'text-sm font-semibold',
                countdown.overdue && isOpen
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-zinc-900 dark:text-zinc-100',
              )}
            >
              {isOpen ? countdown.label : deadline.status}
            </div>
            <div className="text-[11px] text-zinc-400">{formatDateTime(deadline.due_at)}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DeadlineStatusBadge status={deadline.status} />
            <NoticeStatusBadge status={deadline.notice_status} />
            <span className="text-[11px] text-zinc-400">anchor: {deadline.anchor_source}</span>
          </div>
          <button
            onClick={() => onNavigate(`/contracts/${deadline.contract_id}`)}
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline font-mono mt-1 inline-block"
          >
            contract {deadline.contract_id.slice(0, 8)}
          </button>
        </div>

        {/* Actions */}
        {isOpen && (
          <div className="flex items-center gap-2 shrink-0">
            {canNotice && deadline.notice_status === 'none' && (
              <button
                type="button"
                disabled={draftNotice.isPending}
                onClick={() =>
                  draftNotice.mutate(deadline.id, { onSuccess: () => onNavigate('/notices') })
                }
                className="inline-flex items-center gap-1 rounded-lg border border-primary-300 dark:border-primary-800 text-primary-700 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/10 px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
              >
                {draftNotice.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileSignature className="h-3.5 w-3.5" />
                )}
                Draft notice
              </button>
            )}
            {canDeadline && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => discharge.mutate({ id: deadline.id, input: { outcome: 'discharged' } })}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
                >
                  {busy && discharge.variables?.input.outcome === 'discharged' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Discharge
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Waive this deadline? This closes the clock without discharging the obligation.')) {
                      discharge.mutate({ id: deadline.id, input: { outcome: 'waived', confirm: true } });
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
                >
                  <Ban className="h-3.5 w-3.5" />
                  Waive
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {discharge.isError && (
        <p className="px-4 pb-3 text-[11px] text-red-600 dark:text-red-400">
          {discharge.error instanceof Error ? discharge.error.message : 'Action failed.'}
        </p>
      )}
    </li>
  );
}
