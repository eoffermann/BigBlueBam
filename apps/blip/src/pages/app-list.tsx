import { useState } from 'react';
import { Activity, Loader2, Plus, Radio, RadioTower } from 'lucide-react';
import { useApps, useCreateApp, type TrackedApp } from '@/hooks/use-blip';
import { cn, formatRelativeTime } from '@/lib/utils';

interface AppListPageProps {
  onNavigate: (path: string) => void;
}

function CollectionBadge({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
        on
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
      )}
    >
      {on ? <RadioTower className="h-3 w-3" /> : <Radio className="h-3 w-3" />}
      {on ? 'Collecting' : 'Stopped'}
    </span>
  );
}

function CreateAppForm({ onCreated }: { onCreated: (app: TrackedApp) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateApp();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium"
      >
        <Plus className="h-4 w-4" />
        Declare app
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        create.mutate(
          { name: name.trim(), description: description.trim() || undefined },
          {
            onSuccess: (res) => {
              setOpen(false);
              setName('');
              setDescription('');
              onCreated(res.data);
            },
          },
        );
      }}
      className="flex items-end gap-2"
    >
      <div className="flex flex-col">
        <label className="text-xs text-zinc-500 mb-1">App name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rescue Beacon (iOS)"
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-col">
        <label className="text-xs text-zinc-500 mb-1">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="optional"
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={create.isPending || !name.trim()}
        className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Create
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300"
      >
        Cancel
      </button>
    </form>
  );
}

export function AppListPage({ onNavigate }: AppListPageProps) {
  const { data, isLoading, isError, error } = useApps();
  const apps = data?.data ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Tracked apps</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Each tracked app gets an ingest endpoint and keys. Embed them in your client to stream
            telemetry, then open the live viewer to watch it arrive.
          </p>
        </div>
        <CreateAppForm onCreated={(app) => onNavigate(`/apps/${app.id}`)} />
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load tracked apps</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : apps.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <Activity className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No tracked apps yet</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Declare an app to get an ingest endpoint and your first key.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Collection</th>
                <th className="px-4 py-3">Entries (24h)</th>
                <th className="px-4 py-3">Last entry</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr
                  key={app.id}
                  onClick={() => onNavigate(`/apps/${app.id}`)}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-primary-50/50 dark:hover:bg-primary-900/10 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Activity className="h-4 w-4 text-primary-500 shrink-0" />
                      <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {app.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <CollectionBadge on={app.collection_enabled} />
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                    {app.health?.entries_24h ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {app.health?.last_entry_at ? formatRelativeTime(app.health.last_entry_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
