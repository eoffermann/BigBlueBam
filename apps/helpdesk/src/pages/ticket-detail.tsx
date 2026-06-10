import { useState, useRef, useEffect } from 'react';
import { useTicket, usePostMessage, useReopenTicket, useMarkDuplicate, useUnmarkDuplicate } from '@/hooks/use-tickets';
import { useRealtimeTicket } from '@/hooks/use-realtime-ticket';
import { useTicketMessages } from '@/hooks/use-ticket-messages';
import { useSendTyping } from '@/hooks/use-typing';
import { useTicketAttachments } from '@/hooks/use-attachments';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/common/button';
import { StatusBadge, PriorityBadge } from '@/components/common/badge';
import { RichTextEditor } from '@/components/common/rich-text-editor';
import { LoadOlderMessages } from '@/components/load-older-messages';
import { TypingIndicator } from '@/components/typing-indicator';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { api } from '@/lib/api';
import { ArrowLeft, Send, RotateCcw, CheckCircle, ChevronDown, MessageSquareShare, Copy, X, Paperclip } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface TicketDetailPageProps {
  ticketId: string;
  onNavigate: (path: string) => void;
}

export function TicketDetailPage({ ticketId, onNavigate }: TicketDetailPageProps) {
  useRealtimeTicket(ticketId);
  const { data: ticket, isLoading, error } = useTicket(ticketId);
  const postMessage = usePostMessage(ticketId);
  const reopenTicket = useReopenTicket(ticketId);
  const markDuplicate = useMarkDuplicate(ticketId);
  const unmarkDuplicate = useUnmarkDuplicate(ticketId);
  const { user } = useAuthStore();
  const { visibleMessages, hasMore, loadMore, totalMessages } = useTicketMessages(ticketId);
  const { sendTyping } = useSendTyping(ticketId);
  const { data: attachmentsData } = useTicketAttachments(ticketId);
  const attachments = attachmentsData?.data ?? [];

  const [replyText, setReplyText] = useState('');
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [duplicateInput, setDuplicateInput] = useState('');
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [showShareBanter, setShowShareBanter] = useState(false);
  const [banterChannelId, setBanterChannelId] = useState('');
  const [banterMessage, setBanterMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const isClosedOrResolved = ticket?.status === 'resolved' || ticket?.status === 'closed';

  const updatePriority = useMutation({
    mutationFn: (priority: string) =>
      api.post(`/tickets/${ticketId}/update-priority`, { priority }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helpdesk-ticket', ticketId] });
      setShowPriorityMenu(false);
    },
  });

  const closeTicket = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${ticketId}/close`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helpdesk-ticket', ticketId] });
    },
  });

  // Banter channels for "Share to Banter"
  const { data: banterChannelsRes } = useQuery({
    queryKey: ['banter-channels'],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>('/banter/api/v1/channels'),
    enabled: showShareBanter,
  });
  const banterChannels = (banterChannelsRes as { data?: { id: string; name: string }[] })?.data ?? [];

  // Share ticket to Banter mutation
  const shareToBanter = useMutation({
    mutationFn: (channelId: string) => {
      const ticketNum = ticket ? `#${ticket.ticket_number}` : '';
      const subject = ticket?.subject ?? '';
      const msgPrefix = banterMessage ? `${banterMessage}\n\n` : '';
      return api.post(`/banter/api/v1/channels/${channelId}/messages`, {
        content: `${msgPrefix}Shared from Helpdesk: **${ticketNum} -- ${subject}**\n\n> Status: ${ticket?.status ?? 'unknown'} | Priority: ${ticket?.priority ?? 'unknown'}${ticket?.category ? ` | Category: ${ticket.category}` : ''}\n\n[Open Ticket ->](/helpdesk/tickets/${ticketId})`,
        metadata: {
          bbb_entity: {
            type: 'ticket',
            id: ticketId,
            ticket_number: ticket?.ticket_number,
            subject,
          },
        },
      });
    },
    onSuccess: () => {
      setShowShareBanter(false);
      setBanterChannelId('');
      setBanterMessage('');
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages]);

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;

    try {
      await postMessage.mutateAsync({ body: replyText.trim() });
      setReplyText('');
    } catch {
      // error handled by mutation
    }
  };

  const handleReopen = async () => {
    try {
      await reopenTicket.mutateAsync();
    } catch {
      // error handled by mutation
    }
  };

  // HB-55: submit the mark-as-duplicate dialog. Surfaces the server's
  // error code verbatim into a user-facing sentence so customers can
  // understand why their submission was rejected (e.g. primary is
  // closed, primary is itself a duplicate, primary not owned by them).
  const handleSubmitDuplicate = async (e: React.FormEvent) => {
    e.preventDefault();
    setDuplicateError(null);
    const trimmed = duplicateInput.trim().replace(/^#/, '');
    if (!trimmed) {
      setDuplicateError('Please enter a ticket number.');
      return;
    }
    try {
      await markDuplicate.mutateAsync(trimmed);
      setShowDuplicateDialog(false);
      setDuplicateInput('');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'PRIMARY_IS_DUPLICATE') {
        setDuplicateError('That ticket is itself a duplicate. Point at its primary instead.');
      } else if (e?.code === 'PRIMARY_CLOSED') {
        setDuplicateError('That ticket is closed and cannot accept duplicates.');
      } else if (e?.code === 'NOT_FOUND') {
        setDuplicateError('No matching ticket found.');
      } else if (e?.code === 'VALIDATION_ERROR') {
        setDuplicateError(e.message ?? 'Invalid ticket number.');
      } else {
        setDuplicateError(e?.message ?? 'Failed to mark as duplicate.');
      }
    }
  };

  const handleUnmarkDuplicate = async () => {
    try {
      await unmarkDuplicate.mutateAsync();
    } catch {
      // error handled by mutation
    }
  };

  if (isLoading) {
    return (
      <div className="animate-pulse">
        {/* Back link placeholder */}
        <div className="h-4 w-28 bg-zinc-200 dark:bg-zinc-800 rounded mb-6" />

        {/* Header placeholder */}
        <div className="mb-6">
          <div className="h-6 w-2/3 bg-zinc-200 dark:bg-zinc-800 rounded mb-3" />
          <div className="flex flex-wrap items-center gap-2">
            <div className="h-5 w-16 bg-zinc-200 dark:bg-zinc-800 rounded-full" />
            <div className="h-5 w-20 bg-zinc-200 dark:bg-zinc-800 rounded-full" />
            <div className="h-5 w-24 bg-zinc-200 dark:bg-zinc-800 rounded-full" />
            <div className="h-4 w-32 bg-zinc-200 dark:bg-zinc-800 rounded ml-2" />
          </div>
        </div>

        {/* Description placeholder */}
        <div className="mb-6 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
          <div className="h-3 w-20 bg-zinc-200 dark:bg-zinc-800 rounded mb-3" />
          <div className="space-y-2">
            <div className="h-3 w-full bg-zinc-100 dark:bg-zinc-800 rounded" />
            <div className="h-3 w-5/6 bg-zinc-100 dark:bg-zinc-800 rounded" />
            <div className="h-3 w-4/6 bg-zinc-100 dark:bg-zinc-800 rounded" />
          </div>
        </div>

        {/* Message timeline placeholder */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <div className="p-4 space-y-4 min-h-[200px]">
            <div className="flex justify-start">
              <div className="max-w-[75%] w-64 rounded-xl bg-zinc-100 dark:bg-zinc-800 px-4 py-2.5 rounded-bl-sm">
                <div className="h-3 w-24 bg-zinc-200 dark:bg-zinc-700 rounded mb-2" />
                <div className="h-3 w-48 bg-zinc-200 dark:bg-zinc-700 rounded mb-1" />
                <div className="h-3 w-40 bg-zinc-200 dark:bg-zinc-700 rounded" />
              </div>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[75%] w-56 rounded-xl bg-zinc-200 dark:bg-zinc-800 px-4 py-2.5 rounded-br-sm">
                <div className="h-3 w-20 bg-zinc-300 dark:bg-zinc-700 rounded mb-2" />
                <div className="h-3 w-40 bg-zinc-300 dark:bg-zinc-700 rounded mb-1" />
                <div className="h-3 w-32 bg-zinc-300 dark:bg-zinc-700 rounded" />
              </div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[75%] w-72 rounded-xl bg-zinc-100 dark:bg-zinc-800 px-4 py-2.5 rounded-bl-sm">
                <div className="h-3 w-28 bg-zinc-200 dark:bg-zinc-700 rounded mb-2" />
                <div className="h-3 w-56 bg-zinc-200 dark:bg-zinc-700 rounded mb-1" />
                <div className="h-3 w-44 bg-zinc-200 dark:bg-zinc-700 rounded" />
              </div>
            </div>
          </div>
          <div className="border-t border-zinc-200 dark:border-zinc-800 p-4">
            <div className="h-20 w-full bg-zinc-100 dark:bg-zinc-800 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div>
        <button
          onClick={() => onNavigate('/tickets')}
          className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </button>
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3">
          Failed to load ticket. It may not exist or you may not have access.
        </div>
      </div>
    );
  }

  // Build a timeline combining messages and status changes
  type TimelineItem =
    | { kind: 'message'; data: (typeof ticket.messages)[number] }
    | { kind: 'status_change'; from_status: string; to_status: string; changed_at: string };

  const timeline: TimelineItem[] = [];

  for (const msg of visibleMessages) {
    timeline.push({ kind: 'message', data: msg });
  }

  if (ticket.status_changes) {
    for (const sc of ticket.status_changes) {
      timeline.push({
        kind: 'status_change',
        from_status: sc.from_status,
        to_status: sc.to_status,
        changed_at: sc.changed_at,
      });
    }
  }

  timeline.sort((a, b) => {
    const aTime = a.kind === 'message' ? a.data.created_at : a.changed_at;
    const bTime = b.kind === 'message' ? b.data.created_at : b.changed_at;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  return (
    <div>
      {/* Back */}
      <button
        onClick={() => onNavigate('/tickets')}
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to tickets
      </button>

      {/* Ticket header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            <span className="text-zinc-400 font-mono">#{ticket.ticket_number}</span>
            {' — '}
            {ticket.subject}
          </h1>
          <div className="ml-auto">
            <PresenceChipStrip
              url={`${window.location.origin}${window.location.pathname}`}
              surfaceApp="helpdesk"
              surfaceId={ticket.id}
              surfaceLabel={`#${ticket.ticket_number} — ${ticket.subject}`}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={ticket.status} />
          {/* Priority with dropdown to change */}
          <div className="relative">
            <button
              onClick={() => setShowPriorityMenu(!showPriorityMenu)}
              className="inline-flex items-center gap-1"
            >
              <PriorityBadge priority={ticket.priority} />
              <ChevronDown className="h-3 w-3 text-zinc-400" />
            </button>
            {showPriorityMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[120px]">
                {['low', 'medium', 'high'].map((p) => (
                  <button
                    key={p}
                    onClick={() => updatePriority.mutate(p)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${ticket.priority === p ? 'font-medium text-primary-600' : 'text-zinc-700 dark:text-zinc-300'}`}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {ticket.category && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {ticket.category}
            </span>
          )}
          <span className="text-sm text-zinc-400 ml-2">Created on {formatDate(ticket.created_at)}</span>
          {/* Share to Banter */}
          <div className="relative ml-auto">
            <button
              onClick={() => setShowShareBanter((v) => !v)}
              className="rounded-md p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="Share to Banter"
            >
              <MessageSquareShare className="h-4.5 w-4.5" />
            </button>
            {showShareBanter && (
              <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl border border-zinc-200 bg-white shadow-xl dark:bg-zinc-800 dark:border-zinc-700 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Share to Banter</h4>
                <div>
                  <label className="text-xs font-medium text-zinc-500 mb-1 block">Channel</label>
                  <select
                    value={banterChannelId}
                    onChange={(e) => setBanterChannelId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:bg-zinc-700 dark:border-zinc-600 dark:text-zinc-100"
                  >
                    <option value="">Select a channel...</option>
                    {banterChannels.map((ch) => (
                      <option key={ch.id} value={ch.id}>#{ch.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-500 mb-1 block">Message (optional)</label>
                  <textarea
                    value={banterMessage}
                    onChange={(e) => setBanterMessage(e.target.value)}
                    placeholder="Add a note..."
                    rows={2}
                    className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm resize-none dark:bg-zinc-700 dark:border-zinc-600 dark:text-zinc-100"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowShareBanter(false)}
                    className="px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => banterChannelId && shareToBanter.mutate(banterChannelId)}
                    disabled={!banterChannelId || shareToBanter.isPending}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                  >
                    {shareToBanter.isPending ? 'Sharing...' : 'Share'}
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* HB-55: Mark as duplicate (hidden once merged by an agent) */}
          {!isClosedOrResolved && !ticket.duplicate_of && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setDuplicateError(null); setShowDuplicateDialog(true); }}
            >
              <Copy className="h-3.5 w-3.5" />
              Mark as duplicate
            </Button>
          )}
          {/* Close button */}
          {!isClosedOrResolved && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { if (confirm('Close this ticket?')) closeTicket.mutate(); }}
              loading={closeTicket.isPending}
            >
              <CheckCircle className="h-3.5 w-3.5" />
              Close Ticket
            </Button>
          )}
        </div>
      </div>

      {/* HB-55: duplicate-of banner (visible when this ticket points at a primary) */}
      {ticket.duplicate_of && (
        <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-6">
          <span className="text-sm text-blue-800 dark:text-blue-300">
            This ticket was marked as a duplicate of{' '}
            <button
              onClick={() => onNavigate(`/tickets/${ticket.duplicate_of!.id}`)}
              className="font-semibold underline hover:text-blue-900 dark:hover:text-blue-200"
            >
              #{ticket.duplicate_of.ticket_number}
            </button>
            {'. '}
            Updates will be posted on that ticket.
          </span>
          {!ticket.merged_at && (
            <Button size="sm" variant="secondary" onClick={handleUnmarkDuplicate} loading={unmarkDuplicate.isPending}>
              <X className="h-3.5 w-3.5" />
              Unmark
            </Button>
          )}
        </div>
      )}

      {/* HB-55: "duplicates merged in" callout on the primary ticket */}
      {ticket.duplicates && ticket.duplicates.length > 0 && (
        <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 mb-6">
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2 uppercase tracking-wide">
            Duplicates of this ticket
          </div>
          <div className="flex flex-wrap gap-2">
            {ticket.duplicates.map((d) => (
              <button
                key={d.id}
                onClick={() => onNavigate(`/tickets/${d.id}`)}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
                title={d.subject}
              >
                <span className="font-mono text-zinc-400">#{d.ticket_number}</span>
                <span className="truncate max-w-[160px]">{d.subject}</span>
                {d.merged_at && <span className="text-[10px] text-zinc-400">(merged)</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* HB-55: Mark-as-duplicate dialog */}
      {showDuplicateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowDuplicateDialog(false)}>
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Mark as duplicate</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
              Enter the ticket number of your primary ticket. Your current ticket will point at it and updates should be posted there.
            </p>
            <form onSubmit={handleSubmitDuplicate} className="space-y-3">
              <input
                type="text"
                inputMode="numeric"
                value={duplicateInput}
                onChange={(e) => setDuplicateInput(e.target.value)}
                placeholder="e.g. #123"
                autoFocus
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {duplicateError && (
                <p className="text-xs text-red-600 dark:text-red-400">{duplicateError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowDuplicateDialog(false)}
                  className="px-3 py-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
                <Button type="submit" loading={markDuplicate.isPending} disabled={!duplicateInput.trim()}>
                  Confirm
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Description */}
      <div className="mb-6 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">Description</h2>
        <div
          className="rich-text-content text-sm text-zinc-800 dark:text-zinc-200"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdownToHtml(ticket.description)) }}
        />
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="mb-6 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-3 flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            Attachments ({attachments.length})
          </h2>
          <div className="space-y-2">
            {attachments.map((att) => {
              const sizeKb = Math.round((att.size_bytes ?? 0) / 1024);
              const blocked = att.scan_status === 'infected' || att.scan_status === 'failed';
              return (
                <div
                  key={att.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {att.filename}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {sizeKb} KB
                      {att.content_type ? ` • ${att.content_type}` : ''}
                      {att.scan_status ? ` • scan: ${att.scan_status}` : ''}
                    </span>
                  </div>
                  {att.url && !blocked ? (
                    <a
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                    >
                      Download
                    </a>
                  ) : (
                    <span className="text-xs text-zinc-400">Unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Resolved/Closed banner */}
      {isClosedOrResolved && (
        <div className="flex items-center justify-between bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-3 mb-6">
          <span className="text-sm text-yellow-800 dark:text-yellow-400">
            This ticket has been {ticket.status === 'resolved' ? 'resolved' : 'closed'}.
          </span>
          <Button size="sm" variant="secondary" onClick={handleReopen} loading={reopenTicket.isPending}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reopen
          </Button>
        </div>
      )}

      {/* Message timeline */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="p-4 space-y-4 min-h-[200px] max-h-[600px] overflow-y-auto">
          {hasMore && (
            <LoadOlderMessages
              hasMore={hasMore}
              remaining={totalMessages - visibleMessages.length}
              onClick={loadMore}
            />
          )}
          {timeline.length === 0 && (
            <p className="text-center text-sm text-zinc-400 py-8">No messages yet.</p>
          )}

          {timeline.map((item, i) => {
            if (item.kind === 'status_change') {
              return (
                <div key={`sc-${i}`} className="flex justify-center">
                  <span className="text-xs italic text-zinc-400 dark:text-zinc-500">
                    Status changed from{' '}
                    <span className="font-medium">{item.from_status.replace(/_/g, ' ')}</span> to{' '}
                    <span className="font-medium">{item.to_status.replace(/_/g, ' ')}</span>
                    {' — '}
                    {formatRelativeTime(item.changed_at)}
                  </span>
                </div>
              );
            }

            const msg = item.data;
            const isClient = msg.author_type === 'client';
            const isOwn = isClient && msg.author_id === user?.id;

            return (
              <div
                key={msg.id}
                className={`flex ${isClient ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[75%] rounded-xl px-4 py-2.5 ${
                    isClient
                      ? 'bg-primary-600 text-white rounded-br-sm'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-sm'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-xs font-medium ${
                        isClient ? 'text-primary-100' : 'text-zinc-500 dark:text-zinc-400'
                      }`}
                    >
                      {isOwn ? 'You' : msg.author_name}
                    </span>
                    <span
                      className={`text-xs ${
                        isClient ? 'text-primary-200' : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                    >
                      {formatRelativeTime(msg.created_at)}
                    </span>
                  </div>
                  <div
                    className="rich-text-content text-sm break-words"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdownToHtml(msg.body)) }}
                  />
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Reply box */}
        {!isClosedOrResolved && (
          <div className="border-t border-zinc-200 dark:border-zinc-800 p-4">
            <TypingIndicator ticketId={ticketId} />
            <form onSubmit={handleSendReply} className="space-y-3">
              <RichTextEditor
                value={replyText}
                onChange={(v) => {
                  setReplyText(v);
                  sendTyping();
                }}
                placeholder="Type your reply..."
                minRows={2}
                onImageUpload={async (file) => {
                  const formData = new FormData();
                  formData.append('file', file);
                  const res = await api.upload<{ url: string }>('/upload', formData);
                  return res.url ?? (res as unknown as { data: { url: string } }).data?.url ?? '';
                }}
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  loading={postMessage.isPending}
                  disabled={!replyText.trim()}
                >
                  <Send className="h-4 w-4" />
                  Send Reply
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
