import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, Lock } from 'lucide-react';
import { Button } from '@/components/common/button';
import { cn, formatRelativeTime } from '@/lib/utils';

interface TicketMessage {
  id: string;
  ticket_id: string;
  author_type: string;
  author_id: string;
  author_name: string;
  body: string;
  is_internal: boolean;
  created_at: string;
}

interface TicketDetail {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  priority: string;
  client_name: string;
  client_email: string;
  category: string | null;
  created_at: string;
  resolved_at: string | null;
  messages: TicketMessage[];
}

// HB-52: Echo csrf_token cookie in X-CSRF-Token header for cross-app
// admin writes from the Bam SPA into helpdesk-api (authenticated via
// the Bam `session` cookie).
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

async function helpdeskGet<T>(path: string): Promise<T> {
  const res = await fetch(`/helpdesk-api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Helpdesk API error: ${res.status}`);
  const json = await res.json();
  return json.data ?? json;
}

async function helpdeskPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const csrfToken = readCsrfToken();
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`/helpdesk-api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Helpdesk API error: ${res.status}`);
  const json = await res.json();
  return json.data ?? json;
}

interface HelpdeskPanelProps {
  ticketId: string;
}

export function HelpdeskPanel({ ticketId }: HelpdeskPanelProps) {
  const queryClient = useQueryClient();
  const [replyBody, setReplyBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);

  const { data: ticket, isLoading, error } = useQuery({
    queryKey: ['helpdesk-ticket', ticketId],
    queryFn: () => helpdeskGet<TicketDetail>(`/tickets/${ticketId}`),
    enabled: !!ticketId,
  });

  const sendMessage = useMutation({
    mutationFn: (data: { body: string; is_internal: boolean }) =>
      helpdeskPost(`/tickets/${ticketId}/messages`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helpdesk-ticket', ticketId] });
      setReplyBody('');
      setIsInternal(false);
    },
  });

  const handleSend = () => {
    if (!replyBody.trim()) return;
    sendMessage.mutate({ body: replyBody.trim(), is_internal: isInternal });
  };

  if (isLoading) {
    return <p className="text-sm text-zinc-400 py-4">Loading ticket...</p>;
  }

  if (error || !ticket) {
    return <p className="text-sm text-red-500 py-4">Failed to load ticket details.</p>;
  }

  const allMessages = ticket.messages ?? [];

  const statusColors: Record<string, string> = {
    open: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    in_progress: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300',
    waiting_on_customer: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
    resolved: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    closed: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
  };

  return (
    <div className="space-y-4">
      {/* Ticket info */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-mono text-zinc-500">#{ticket.ticket_number}</span>
          <span className={cn('text-xs font-medium rounded-full px-2 py-0.5', statusColors[ticket.status] ?? statusColors.open)}>
            {ticket.status.replace('_', ' ')}
          </span>
        </div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{ticket.subject}</p>
        <div className="text-xs text-zinc-500 space-y-0.5">
          <p>Client: {ticket.client_name} ({ticket.client_email})</p>
          {ticket.category && <p>Category: {ticket.category}</p>}
          <p>Created: {formatRelativeTime(ticket.created_at)}</p>
          {ticket.resolved_at && <p>Resolved: {formatRelativeTime(ticket.resolved_at)}</p>}
        </div>
      </div>

      {/* Messages timeline */}
      <div className="space-y-3 max-h-80 overflow-y-auto">
        {allMessages.length > 0 ? (
          allMessages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'rounded-lg p-3 text-sm',
                msg.is_internal
                  ? 'bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 border-dashed'
                  : msg.author_type === 'client'
                    ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600'
                    : 'bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-700',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {msg.author_name}
                  {msg.is_internal && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-yellow-600 dark:text-yellow-400">
                      <Lock className="h-2.5 w-2.5" /> Internal
                    </span>
                  )}
                  {msg.author_type === 'system' && (
                    <span className="ml-1 text-zinc-400">(system)</span>
                  )}
                </span>
                <span className="text-xs text-zinc-400">{formatRelativeTime(msg.created_at)}</span>
              </div>
              <p className="text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">{msg.body}</p>
            </div>
          ))
        ) : (
          <p className="text-sm text-zinc-400">No messages yet.</p>
        )}
      </div>

      {/* Reply form */}
      <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
              className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
            />
            <Lock className="h-3 w-3" />
            Internal Note
          </label>
        </div>
        <textarea
          placeholder={isInternal ? 'Write an internal note...' : 'Reply to client...'}
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              handleSend();
            }
          }}
          rows={3}
          className={cn(
            'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y',
            'dark:bg-zinc-800 dark:text-zinc-100',
            isInternal
              ? 'border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-950'
              : 'border-zinc-200 bg-white dark:border-zinc-700',
          )}
        />
        {sendMessage.isError && (
          <p className="text-xs text-red-500">Failed to send message. Please try again.</p>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!replyBody.trim()}
            loading={sendMessage.isPending}
            onClick={handleSend}
          >
            <Send className="h-4 w-4" />
            {isInternal ? 'Add Note' : 'Reply to Client'}
          </Button>
        </div>
      </div>
    </div>
  );
}
