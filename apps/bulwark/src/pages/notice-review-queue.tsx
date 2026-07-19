import { useMemo, useState } from 'react';
import { Send, Loader2, ShieldAlert, Inbox, CheckCircle2, Ban } from 'lucide-react';
import type { BulwarkNoticeDeadline } from '@bigbluebam/shared';
import { useCan } from '@bigbluebam/ui/use-can';
import { markdownToHtml, sanitizeHtml } from '@bigbluebam/ui/markdown';
import { useDeadlines, useApproveSendNotice, useDischargeDeadline } from '@/hooks/use-bulwark';
import { formatDateTime } from '@/lib/utils';
import { NoticeStatusBadge } from '@/components/badges';

interface Props {
  onNavigate: (path: string) => void;
}

// The drafted-notice review queue is the HITL boundary: the draft body is shown ONLY to
// bulwark.notice.draft holders (the API returns notice_draft null to everyone else).
export function NoticeReviewQueuePage({ onNavigate }: Props) {
  const canDraft = useCan('bulwark.notice.draft');
  // Pull open deadlines and keep those with a pending/approved draft. There is no notice_status
  // filter on the list route, so we filter client-side.
  const { data, isLoading, isError, error } = useDeadlines({ limit: 100 });
  const queue = useMemo(
    () =>
      (data?.data ?? []).filter(
        (d) => d.notice_status === 'drafted' || d.notice_status === 'approved',
      ),
    [data],
  );

  if (!canDraft) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-8 text-center">
          <ShieldAlert className="h-10 w-10 text-zinc-400 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">Restricted</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Drafted notice bodies are visible only to holders of the notice-draft permission.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Send className="h-6 w-6 text-primary-500" />
          Notice review queue
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Every drafted notice waits here for a human. Nothing is sent unattended. The recipient and
          attachments are fixed deterministically by Bulwark, not by the draft text.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-40 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load the queue</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : queue.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Inbox className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">Nothing to review</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Drafts appear here when a deadline notice is generated. Start one from the radar.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {queue.map((d) => (
            <NoticeCard key={d.id} deadline={d} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoticeCard({
  deadline,
  onNavigate,
}: {
  deadline: BulwarkNoticeDeadline;
  onNavigate: (path: string) => void;
}) {
  const approveSend = useApproveSendNotice();
  const discharge = useDischargeDeadline();
  const [sent, setSent] = useState(false);
  const draft = deadline.notice_draft;
  const bodyHtml = draft?.body_markdown ? sanitizeHtml(markdownToHtml(draft.body_markdown)) : '';

  return (
    <li className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <NoticeStatusBadge status={deadline.notice_status} />
            <span className="text-[11px] text-zinc-400">due {formatDateTime(deadline.due_at)}</span>
          </div>
          <button
            onClick={() => onNavigate(`/contracts/${deadline.contract_id}`)}
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline font-mono mt-0.5 inline-block"
          >
            contract {deadline.contract_id.slice(0, 8)}
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        {draft?.subject ? (
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{draft.subject}</p>
        ) : (
          <p className="text-sm text-zinc-400 italic mb-2">(no subject)</p>
        )}
        {bodyHtml ? (
          <div
            className="rich-text-content prose-sm max-w-none text-sm text-zinc-700 dark:text-zinc-300 border border-zinc-100 dark:border-zinc-800 rounded-lg p-3 bg-white dark:bg-zinc-900"
            // Sanitized above with the shared DOMPurify helper.
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <p className="text-sm text-zinc-400 italic">Draft body is empty.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
        <button
          type="button"
          disabled={approveSend.isPending || sent}
          onClick={() =>
            approveSend.mutate(deadline.id, {
              onSuccess: () => setSent(true),
            })
          }
          className="inline-flex items-center gap-1 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          {approveSend.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {sent ? 'Sent' : 'Approve and send'}
        </button>
        {/* No dedicated discard-draft endpoint exists (M4 gap). Declining routes through waiving
            the underlying deadline, the closest real action. */}
        <button
          type="button"
          disabled={discharge.isPending}
          onClick={() => {
            if (window.confirm('Decline this notice and waive the underlying deadline?')) {
              discharge.mutate({ id: deadline.id, input: { outcome: 'waived', confirm: true } });
            }
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          <Ban className="h-3.5 w-3.5" />
          Decline and waive
        </button>
        {(approveSend.isError || discharge.isError) && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {(approveSend.error ?? discharge.error) instanceof Error
              ? (approveSend.error ?? discharge.error as Error).message
              : 'Action failed.'}
          </span>
        )}
      </div>
    </li>
  );
}
