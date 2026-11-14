/**
 * Helpdesk Agent Queue page.
 *
 * Renders a minimal ticket queue for support agents within the Bam SPA.
 * Uses the Bam session cookie and calls GET /b3/api/internal/helpdesk/queue
 * on the Bam API, which proxies to helpdesk-api with the org's agent key.
 *
 * NOTE: The proxy endpoint GET /internal/helpdesk/queue must be created on
 * the Bam API (apps/api) to complete this flow. Until then, this page
 * shows an informative message when the endpoint returns 404.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/app-layout';

interface QueueTicket {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  first_response_at: string | null;
  sla_breached_at: string | null;
  assignee_name: string | null;
  sla_state: 'breached' | 'imminent' | 'ok';
}

interface HelpdeskAgentQueuePageProps {
  onNavigate: (path: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_on_customer: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  medium: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  low: 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300',
};

const SLA_BADGES: Record<string, { label: string; className: string }> = {
  breached: {
    label: 'SLA Breached',
    className: 'bg-red-500 text-white',
  },
  imminent: {
    label: 'SLA At Risk',
    className: 'bg-amber-500 text-white',
  },
  ok: {
    label: 'On Track',
    className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
};

export function HelpdeskAgentQueuePage({ onNavigate }: HelpdeskAgentQueuePageProps) {
  const [tickets, setTickets] = useState<QueueTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [slaFilter, setSlaFilter] = useState<string>('all');

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (slaFilter !== 'all') params.set('sla_state', slaFilter);

      const res = await fetch(`/b3/api/internal/helpdesk/queue?${params.toString()}`, {
        credentials: 'include',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as any)?.error?.message ?? `Request failed with status ${res.status}`);
        setTickets([]);
        return;
      }

      const body = await res.json();
      setTickets((body as any).data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch queue');
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, slaFilter]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  return (
    <AppLayout onNavigate={onNavigate} onCreateProject={() => { /* helpdesk queue has no project creation affordance */ }}>
      <div className="max-w-6xl mx-auto py-6 px-4">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Ticket Queue
          </h1>
          <button
            onClick={fetchQueue}
            disabled={loading}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="waiting_on_customer">Waiting on Customer</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>

          <select
            value={slaFilter}
            onChange={(e) => setSlaFilter(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm"
          >
            <option value="all">All SLA states</option>
            <option value="breached">Breached</option>
            <option value="imminent">At Risk</option>
            <option value="ok">On Track</option>
          </select>
        </div>

        {error && (
          <div className="mb-4 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {!loading && tickets.length === 0 && !error && (
          <div className="text-center py-12 text-zinc-500">
            No tickets in queue.
          </div>
        )}

        {tickets.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Subject</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Priority</th>
                  <th className="py-2 pr-3">Assignee</th>
                  <th className="py-2 pr-3">SLA</th>
                  <th className="py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => {
                  // Fallback object literal in case SLA_BADGES is keyed by a
                  // string not present; noUncheckedIndexedAccess treats the
                  // lookup (and even the .ok fallback) as possibly undefined.
                  const slaBadge = SLA_BADGES[t.sla_state] ?? SLA_BADGES.ok ?? { label: 'OK', className: 'bg-zinc-100 text-zinc-700' };
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                      onClick={() => {
                        if (t.task_id) {
                          onNavigate(`/tasks/${t.task_id}`);
                        }
                      }}
                    >
                      <td className="py-2 pr-3 font-mono text-zinc-400">
                        #{t.ticket_number}
                      </td>
                      <td className="py-2 pr-3 text-zinc-900 dark:text-zinc-100 font-medium max-w-md truncate">
                        {t.subject}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
                          {STATUS_LABELS[t.status] ?? t.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_COLORS[t.priority] ?? PRIORITY_COLORS.medium}`}
                        >
                          {t.priority}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                        {t.assignee_name ?? 'Unassigned'}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${slaBadge.className}`}
                        >
                          {slaBadge.label}
                        </span>
                      </td>
                      <td className="py-2 text-zinc-500 text-xs">
                        {new Date(t.updated_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
