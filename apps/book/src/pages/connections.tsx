import { useState } from 'react';
import { Plug, Plus, RefreshCw, Trash2, Rss, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  useConnections,
  useCreateIcsConnection,
  useSyncConnection,
  useDeleteConnection,
  type Connection,
  type SyncResult,
} from '@/hooks/use-connections';
import { useCalendars } from '@/hooks/use-calendars';

interface ConnectionsPageProps {
  onNavigate?: (path: string) => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function statusBadge(c: Connection) {
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium';
  switch (c.sync_status) {
    case 'active':
      return <span className={`${base} bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300`}><CheckCircle2 className="h-3 w-3" />Active</span>;
    case 'error':
      return <span className={`${base} bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300`}><AlertCircle className="h-3 w-3" />Error</span>;
    case 'needs_config':
      return <span className={`${base} bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300`}><AlertCircle className="h-3 w-3" />Needs setup</span>;
    default:
      return <span className={`${base} bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}>Pending</span>;
  }
}

export function ConnectionsPage({ onNavigate: _onNavigate }: ConnectionsPageProps) {
  const { data: connectionsData, isLoading } = useConnections();
  const { data: calendarsData } = useCalendars();
  const createIcs = useCreateIcsConnection();
  const syncConnection = useSyncConnection();
  const deleteConnection = useDeleteConnection();

  const [feedUrl, setFeedUrl] = useState('');
  const [feedName, setFeedName] = useState('');
  const [targetCalendarId, setTargetCalendarId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<Record<string, SyncResult>>({});

  const connections = connectionsData?.data ?? [];
  const calendars = calendarsData?.data ?? [];

  const calendarName = (id: string | null) =>
    calendars.find((c) => c.id === id)?.name ?? (id ? 'Unknown calendar' : 'Auto-selected');

  const handleConnectIcs = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const url = feedUrl.trim();
    if (!url) {
      setFormError('Enter an .ics feed URL.');
      return;
    }
    try {
      await createIcs.mutateAsync({
        feed_url: url,
        name: feedName.trim() || undefined,
        calendar_id: targetCalendarId || undefined,
      });
      setFeedUrl('');
      setFeedName('');
      setTargetCalendarId('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create connection.');
    }
  };

  const handleSync = async (id: string) => {
    try {
      const res = await syncConnection.mutateAsync(id);
      setLastSyncResult((prev) => ({ ...prev, [id]: res.data }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Sync failed.');
    }
  };

  const handleDelete = async (id: string) => {
    await deleteConnection.mutateAsync(id);
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Plug className="h-6 w-6 text-blue-600" />
          External Calendar Connections
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Subscribe to an external calendar feed (.ics URL) to pull its events into Book.
          Google and Outlook two-way sync require operator-supplied credentials.
        </p>
      </div>

      {/* ICS feed connect form — the working, no-credentials path */}
      <form
        onSubmit={handleConnectIcs}
        className="p-4 border border-zinc-200 dark:border-zinc-700 rounded-xl space-y-3"
      >
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-lg bg-orange-50 dark:bg-orange-950/30 flex items-center justify-center">
            <Rss className="h-5 w-5 text-orange-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subscribe to an .ics feed</h3>
            <p className="text-xs text-zinc-500">Paste any public iCalendar (.ics) URL, including webcal links.</p>
          </div>
        </div>

        <input
          type="text"
          value={feedUrl}
          onChange={(e) => setFeedUrl(e.target.value)}
          placeholder="https://example.com/calendar.ics"
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={feedName}
            onChange={(e) => setFeedName(e.target.value)}
            placeholder="Label (optional)"
            className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
          />
          <select
            value={targetCalendarId}
            onChange={(e) => setTargetCalendarId(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
          >
            <option value="">Auto-select calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {formError && <p className="text-xs text-red-600">{formError}</p>}

        <button
          type="submit"
          disabled={createIcs.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {createIcs.isPending ? 'Connecting...' : 'Connect feed'}
        </button>
      </form>

      {/* OAuth provider cards — disabled, with a clear reason */}
      <div className="grid gap-3">
        <div className="flex items-center justify-between p-4 border border-zinc-200 dark:border-zinc-700 rounded-xl opacity-70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 dark:bg-red-950/30 flex items-center justify-center">
              <span className="text-lg font-bold text-red-600">G</span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Google Calendar</h3>
              <p className="text-xs text-zinc-500">Two-way sync. Requires operator OAuth credentials.</p>
            </div>
          </div>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-zinc-100 dark:bg-zinc-800 rounded-lg cursor-not-allowed"
            disabled
            title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server to enable"
          >
            <Plus className="h-3.5 w-3.5" />
            Connect
          </button>
        </div>

        <div className="flex items-center justify-between p-4 border border-zinc-200 dark:border-zinc-700 rounded-xl opacity-70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center">
              <span className="text-lg font-bold text-blue-600">M</span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Microsoft Outlook</h3>
              <p className="text-xs text-zinc-500">Two-way sync. Requires operator OAuth credentials.</p>
            </div>
          </div>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-zinc-100 dark:bg-zinc-800 rounded-lg cursor-not-allowed"
            disabled
            title="Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the server to enable"
          >
            <Plus className="h-3.5 w-3.5" />
            Connect
          </button>
        </div>
      </div>

      {/* Connected feeds list */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Your connections</h2>
        {isLoading ? (
          <div className="text-center py-8 text-zinc-400 text-sm">Loading connections...</div>
        ) : connections.length === 0 ? (
          <div className="text-center py-8 text-zinc-400">
            <p className="text-sm">No external calendars connected yet.</p>
            <p className="text-xs mt-1">Subscribe to an .ics feed above to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {connections.map((c) => {
              const result = lastSyncResult[c.id];
              return (
                <div
                  key={c.id}
                  className="p-3 border border-zinc-200 dark:border-zinc-700 rounded-lg space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs uppercase font-semibold text-zinc-400">{c.provider}</span>
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {c.name || c.external_calendar_id}
                      </span>
                      {statusBadge(c)}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleSync(c.id)}
                        disabled={syncConnection.isPending}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
                        title="Sync now"
                      >
                        <RefreshCw className={`h-3 w-3 ${syncConnection.isPending ? 'animate-spin' : ''}`} />
                        Sync now
                      </button>
                      <button
                        onClick={() => handleDelete(c.id)}
                        disabled={deleteConnection.isPending}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 bg-red-50 dark:bg-red-950/30 rounded hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
                        title="Disconnect"
                      >
                        <Trash2 className="h-3 w-3" />
                        Disconnect
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>Calendar: {calendarName(c.calendar_id)}</span>
                    <span>Last sync: {relativeTime(c.last_sync_at)}</span>
                    <span>{c.last_sync_event_count} events</span>
                  </div>
                  {c.sync_error && (
                    <p className="text-xs text-red-600">{c.sync_error}</p>
                  )}
                  {result && (
                    <p className="text-xs text-green-600">
                      Synced: {result.imported} pulled, {result.created} added, {result.updated} updated, {result.removed} removed.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
