import { useState } from 'react';
import { useTickets, useRealtimeTicketsList } from '@/hooks/use-tickets';
import { Button } from '@/components/common/button';
import { StatusBadge, PriorityBadge } from '@/components/common/badge';
import { formatRelativeTime } from '@/lib/utils';
import { Plus, Inbox, Search } from 'lucide-react';

interface TicketsListPageProps {
  onNavigate: (path: string) => void;
}

const VIEWED_STORAGE_PREFIX = 'helpdesk-ticket-viewed-';

function getViewedAt(ticketId: string): string | null {
  try {
    return localStorage.getItem(VIEWED_STORAGE_PREFIX + ticketId);
  } catch {
    return null;
  }
}

function markViewed(ticketId: string): void {
  try {
    localStorage.setItem(VIEWED_STORAGE_PREFIX + ticketId, new Date().toISOString());
  } catch {
    // ignore
  }
}

function isUnread(ticketId: string, updatedAt: string): boolean {
  const viewedAt = getViewedAt(ticketId);
  if (!viewedAt) return true;
  return new Date(updatedAt).getTime() > new Date(viewedAt).getTime();
}

// Canonical ticket statuses as stored in tickets.status. Must match the values
// the API returns / the StatusBadge labels (open, in_progress,
// waiting_on_customer, resolved, closed). The previous list used stale values
// (awaiting_customer / awaiting_internal) that never matched any real ticket,
// so every chip filtered the list down to zero rows.
const STATUS_FILTERS = ['', 'open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'] as const;

const STATUS_FILTER_LABELS: Record<string, string> = {
  '': 'all',
  open: 'open',
  in_progress: 'in progress',
  waiting_on_customer: 'waiting on customer',
  resolved: 'resolved',
  closed: 'closed',
};

export function TicketsListPage({ onNavigate }: TicketsListPageProps) {
  const { data: tickets, isLoading, error } = useTickets();
  useRealtimeTicketsList();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const q = query.trim().toLowerCase();
  const filtered = (tickets ?? []).filter((t) => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (!q) return true;
    return (
      t.subject.toLowerCase().includes(q) ||
      String(t.ticket_number).includes(q) ||
      (t.category ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">My Tickets</h1>
        <Button onClick={() => onNavigate('/tickets/new')}>
          <Plus className="h-4 w-4" />
          New Ticket
        </Button>
      </div>

      {/* Search + status filter */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search subject, number, or category..."
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 pl-9 pr-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
          />
        </div>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-1 rounded-md text-xs font-medium ${
                statusFilter === s
                  ? 'bg-primary-600 text-white'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
            >
              {STATUS_FILTER_LABELS[s] ?? (s ? s.replace(/_/g, ' ') : 'all')}
            </button>
          ))}
        </div>
      </div>

      {/* Loading - skeleton rows */}
      {isLoading && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[60px_1fr_120px_90px_110px_120px] gap-4 px-4 py-3 border-b border-zinc-50 dark:border-zinc-800/50 last:border-b-0 animate-pulse"
            >
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-8" />
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-3/4" />
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-16" />
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-14" />
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-20" />
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-16" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3">
          Failed to load tickets. Please try again.
        </div>
      )}

      {/* Empty state */}
      {tickets && tickets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Inbox className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-4" />
          <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-1">No tickets yet</h2>
          <p className="text-zinc-500 mb-6">Create your first one!</p>
          <Button onClick={() => onNavigate('/tickets/new')}>
            <Plus className="h-4 w-4" />
            New Ticket
          </Button>
        </div>
      )}

      {/* No search match */}
      {tickets && tickets.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12 text-sm text-zinc-500">
          No tickets match your search.
        </div>
      )}

      {/* Ticket list */}
      {tickets && tickets.length > 0 && filtered.length > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {/* Table header */}
          <div className="hidden sm:grid sm:grid-cols-[60px_1fr_120px_90px_110px_120px] gap-4 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 text-xs font-medium text-zinc-500 uppercase tracking-wider">
            <span>#</span>
            <span>Subject</span>
            <span>Status</span>
            <span>Priority</span>
            <span>Category</span>
            <span>Updated</span>
          </div>

          {/* Rows */}
          {filtered.map((ticket) => {
            const unread = isUnread(ticket.id, ticket.updated_at);
            return (
              <button
                key={ticket.id}
                onClick={() => {
                  markViewed(ticket.id);
                  onNavigate(`/tickets/${ticket.id}`);
                }}
                className="w-full text-left grid grid-cols-1 sm:grid-cols-[60px_1fr_120px_90px_110px_120px] gap-2 sm:gap-4 px-4 py-3 border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors last:border-b-0"
              >
                <span className="text-sm text-zinc-400 font-mono">#{ticket.ticket_number}</span>
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-2">
                  {unread && (
                    <span
                      aria-label="New activity"
                      title="New activity"
                      className="inline-flex items-center gap-1 flex-shrink-0"
                    >
                      <span className="h-2 w-2 rounded-full bg-primary-500" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">
                        New
                      </span>
                    </span>
                  )}
                  <span className="truncate">{ticket.subject}</span>
                </span>
                <span>
                  <StatusBadge status={ticket.status} />
                </span>
                <span>
                  <PriorityBadge priority={ticket.priority} />
                </span>
                <span className="text-sm text-zinc-500 truncate">{ticket.category ?? '--'}</span>
                <span className="text-sm text-zinc-400">{formatRelativeTime(ticket.updated_at)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
