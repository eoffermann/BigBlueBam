import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Hash, Check, Loader2, Search } from 'lucide-react';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';

/**
 * Add many users to many Banter channels at once. Shared by the People Manager
 * bulk-action bar (existing selected users) and the project-invite "set up
 * default channels" flow (newly onboarded users). Talks to banter-api directly
 * (same browser origin) via POST /banter/api/v1/channels/bulk-add-members, which
 * is org-admin/SuperUser gated and org-scoped server-side.
 *
 * Callers pass the target user ids and an optional label for the heading.
 */

interface BrowseChannel {
  id: string;
  name: string;
  slug: string;
  member_count?: number;
}

function readCsrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function orgHeader(orgId?: string): Record<string, string> {
  return orgId ? { 'X-Org-Id': orgId } : {};
}

async function banterGet<T>(path: string, orgId?: string): Promise<T> {
  const res = await fetch(`/banter/api/v1${path}`, {
    credentials: 'include',
    headers: orgHeader(orgId),
  });
  if (!res.ok) throw new Error(`Failed to load (${res.status})`);
  return (await res.json()) as T;
}

async function banterPost<T>(path: string, body: unknown, orgId?: string): Promise<T> {
  const csrf = readCsrfToken();
  const res = await fetch(`/banter/api/v1${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...orgHeader(orgId),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export function AddToChannelsDialog({
  userIds,
  orgId,
  targetLabel,
  onClose,
  onDone,
}: {
  userIds: string[];
  /** Org being managed — scopes the channel list + the add to that org.
   *  Omit to use the caller's active-org session context. */
  orgId?: string;
  /** e.g. "3 people" or "the 4 invited users" — shown in the heading. */
  targetLabel?: string;
  onClose: () => void;
  onDone?: (addedCount: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);

  // Org public channels (the browse list) — the candidates an admin can add
  // people to during onboarding.
  const channelsQ = useQuery({
    queryKey: ['banter-browse-channels', orgId ?? 'session'],
    queryFn: () => banterGet<{ data: BrowseChannel[] }>('/channels/browse', orgId).then((r) => r.data),
  });

  const channels = useMemo(() => {
    const all = channelsQ.data ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)) : all;
  }, [channelsQ.data, query]);

  const add = useMutation({
    mutationFn: () =>
      banterPost<{ data: { added: number; channels: number; users: number } }>(
        '/channels/bulk-add-members',
        { channel_ids: [...selected], user_ids: userIds },
        orgId,
      ),
    onSuccess: (res) => {
      const n = res.data.added;
      setResult(`Added ${n} membership${n === 1 ? '' : 's'} across ${res.data.channels} channel${res.data.channels === 1 ? '' : 's'}.`);
      onDone?.(n);
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const err = add.error as Error | null;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to channels"
      description={`Add ${targetLabel ?? `${userIds.length} user${userIds.length === 1 ? '' : 's'}`} to the channels you pick below.`}
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels…"
            className="pl-9"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
          {channelsQ.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
            </div>
          ) : channels.length === 0 ? (
            <p className="px-3 py-6 text-sm text-center text-zinc-400">No channels found.</p>
          ) : (
            channels.map((c) => {
              const on = selected.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border ${
                      on
                        ? 'bg-primary-600 border-primary-600 text-white'
                        : 'border-zinc-300 dark:border-zinc-600'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <Hash className="h-4 w-4 text-zinc-400 flex-shrink-0" />
                  <span className="flex-1 text-sm text-zinc-800 dark:text-zinc-200 truncate">{c.name}</span>
                  {typeof c.member_count === 'number' && (
                    <span className="text-xs text-zinc-400">{c.member_count}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {err && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
            {err.message}
          </div>
        )}
        {result && (
          <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-700 dark:bg-green-950 dark:border-green-900 dark:text-green-300">
            {result}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={selected.size === 0 || userIds.length === 0}
          >
            Add to {selected.size} channel{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
