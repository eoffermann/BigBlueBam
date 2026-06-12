/**
 * Recent chats — recovery surface for the widget's ephemeral room chats.
 *
 * Lists every chat thread the signed-in user was present for (joining a
 * room's chat records participation), searchable by room name or message
 * text. Clicking a thread pops a transcript window. Org admins/owners and
 * SuperUsers additionally get retention controls there: extend a thread's
 * lifetime up to one week, or retain it permanently. Everything else
 * expires 24 hours after each message was sent.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquareText, Search, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

interface ChatRoomSummary {
  room_key: string;
  label: string | null;
  app: string | null;
  retention_hours: number;
  retain_forever: boolean;
  last_message_at: string | null;
  message_count: number;
}

interface ChatMessage {
  id: string;
  author_id: string | null;
  author_name: string;
  author_avatar_url?: string | null;
  body: string;
  created_at: string;
}

const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: '24', label: '24 hours (default)' },
  { value: '48', label: '2 days' },
  { value: '72', label: '3 days' },
  { value: '168', label: '1 week (max)' },
  { value: 'forever', label: 'Retain permanently' },
];

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function retentionText(room: ChatRoomSummary): string {
  if (room.retain_forever) return 'retained permanently';
  return room.retention_hours === 24 ? 'expires after 24h' : `expires after ${room.retention_hours}h`;
}

export function ChatsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    user?.is_superuser === true || user?.role === 'admin' || user?.role === 'owner';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [rooms, setRooms] = useState<ChatRoomSummary[] | null>(null);
  const [openRoom, setOpenRoom] = useState<ChatRoomSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<{ data: ChatRoomSummary[] }>(
      `/chat/rooms${debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : ''}`,
    )
      .then((res) => {
        if (!cancelled) setRooms(res.data ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chats');
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  useEffect(() => {
    if (!openRoom) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    api<{ data: ChatMessage[] }>(
      `/chat/rooms/${encodeURIComponent(openRoom.room_key)}/messages`,
    )
      .then((res) => {
        if (!cancelled) setMessages(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [openRoom]);

  const retentionValue = useMemo(() => {
    if (!openRoom) return '24';
    return openRoom.retain_forever ? 'forever' : String(openRoom.retention_hours);
  }, [openRoom]);

  const applyRetention = async (value: string) => {
    if (!openRoom) return;
    setSavingRetention(true);
    try {
      const body =
        value === 'forever'
          ? { retain_forever: true }
          : { retention_hours: parseInt(value, 10), retain_forever: false };
      const res = await api<{ data: { retention_hours: number; retain_forever: boolean } }>(
        `/chat/rooms/${encodeURIComponent(openRoom.room_key)}/retention`,
        { method: 'PATCH', body },
      );
      const updated = { ...openRoom, ...res.data };
      setOpenRoom(updated);
      setRooms((rs) =>
        (rs ?? []).map((r) => (r.room_key === updated.room_key ? updated : r)),
      );
    } catch {
      // keep prior value; the select re-renders from openRoom
    } finally {
      setSavingRetention(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquareText className="h-5 w-5 text-primary-500" />
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Recent chats</h1>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Room chats you were present for. Messages expire 24 hours after they were sent
        unless an admin extends or retains the thread.
      </p>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by room name or message text…"
          className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-9 pr-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {rooms === null ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
        </div>
      ) : rooms.length === 0 ? (
        <p className="text-sm text-zinc-400 py-8 text-center">
          {debouncedSearch
            ? 'No chats match that search.'
            : 'No room chats yet — open the chat panel on the Bureau widget anywhere in the suite.'}
        </p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {rooms.map((room) => (
            <button
              key={room.room_key}
              type="button"
              onClick={() => setOpenRoom(room)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
            >
              <MessageSquareText className="h-4 w-4 text-zinc-400 shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                  {room.label || room.room_key}
                </span>
                <span className="block text-xs text-zinc-400">
                  {room.message_count} message{room.message_count === 1 ? '' : 's'} ·{' '}
                  {retentionText(room)}
                  {room.retain_forever && (
                    <ShieldCheck className="inline h-3 w-3 ml-1 text-emerald-500" aria-label="Retained" />
                  )}
                </span>
              </span>
              <span className="text-xs text-zinc-400 shrink-0">
                {formatWhen(room.last_message_at)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Transcript popup */}
      {openRoom && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => setOpenRoom(null)}
          />
          <div
            role="dialog"
            aria-label={`Chat transcript: ${openRoom.label ?? openRoom.room_key}`}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(560px,calc(100vw-2rem))] max-h-[80vh] flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {openRoom.label || openRoom.room_key}
                </div>
                <div className="text-xs text-zinc-400">{retentionText(openRoom)}</div>
              </div>
              {isAdmin && (
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  Retention
                  <select
                    value={retentionValue}
                    disabled={savingRetention}
                    onChange={(e) => void applyRetention(e.target.value)}
                    className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-xs text-zinc-900 dark:text-zinc-100"
                  >
                    {RETENTION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                onClick={() => setOpenRoom(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Close transcript"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {messages === null ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
                </div>
              ) : messages.length === 0 ? (
                <p className="text-sm text-zinc-400 py-6 text-center">
                  All messages in this chat have expired.
                </p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className="mb-3">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {m.author_name}
                    </span>{' '}
                    <span className="text-xs text-zinc-400">{formatWhen(m.created_at)}</span>
                    <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
                      {m.body}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
