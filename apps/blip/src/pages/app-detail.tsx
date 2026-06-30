import {
  Activity,
  KeyRound,
  Loader2,
  Radio,
  RadioTower,
  ListTree,
  AlertTriangle,
} from 'lucide-react';
import {
  useApp,
  useReportTypes,
  useKeys,
  useSetCollection,
  type TrackedAppHealth,
} from '@/hooks/use-blip';
import { cn, formatRelativeTime } from '@/lib/utils';

interface AppDetailPageProps {
  appId: string;
  onNavigate: (path: string) => void;
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-400">{sub}</div>}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-0.5 h-10">
      {data.map((v, i) => (
        <div
          key={i}
          className="flex-1 bg-primary-500/70 rounded-sm"
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  );
}

export function AppDetailPage({ appId, onNavigate }: AppDetailPageProps) {
  const { data, isLoading, isError, error } = useApp(appId);
  const types = useReportTypes(appId);
  const keys = useKeys(appId);
  const setCollection = useSetCollection(appId);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-zinc-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading app…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load app</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'Not found.'}
          </p>
        </div>
      </div>
    );
  }

  const app = data.data;
  const health: TrackedAppHealth = app.health ?? {};
  const on = app.collection_enabled;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary-500" />
            {app.name}
          </h1>
          {app.description && <p className="text-sm text-zinc-500 mt-1">{app.description}</p>}
        </div>
        <button
          type="button"
          disabled={setCollection.isPending}
          onClick={() => setCollection.mutate(!on)}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60',
            on
              ? 'border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white',
          )}
        >
          {setCollection.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : on ? (
            <Radio className="h-4 w-4" />
          ) : (
            <RadioTower className="h-4 w-4" />
          )}
          {on ? 'Stop collection' : 'Start collection'}
        </button>
      </div>

      {/* Health */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Entries 24h" value={health.entries_24h ?? '—'} />
        <Stat label="Total entries" value={health.entries_total ?? '—'} />
        <Stat label="Active keys" value={health.active_keys ?? keys.data?.data.filter((k) => k.status === 'active').length ?? '—'} />
        <Stat label="Report types" value={health.report_type_count ?? types.data?.data.length ?? '—'} />
      </div>

      {(health.dead_letter_count || health.rejected_24h) ? (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 dark:text-amber-300">
            {health.rejected_24h ? `${health.rejected_24h} reports rejected in the last 24h. ` : ''}
            {health.dead_letter_count ? `${health.dead_letter_count} entries failed durable write (dead-letter).` : ''}
          </div>
        </div>
      ) : null}

      {health.volume_sparkline && health.volume_sparkline.length > 0 && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">
            Recent volume
          </div>
          <Sparkline data={health.volume_sparkline} />
        </div>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          onClick={() => onNavigate(`/apps/${appId}/keys`)}
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <KeyRound className="h-5 w-5 text-primary-500 mb-2" />
          <div className="font-medium text-zinc-900 dark:text-zinc-100">Ingest keys</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {keys.data?.data.length ?? 0} key(s) — mint, suspend, revoke
          </div>
        </button>
        <button
          onClick={() => onNavigate(`/apps/${appId}/types`)}
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <ListTree className="h-5 w-5 text-primary-500 mb-2" />
          <div className="font-medium text-zinc-900 dark:text-zinc-100">Report types</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {types.data?.data.length ?? 0} observed — open a live viewer
          </div>
        </button>
        <button
          onClick={() => onNavigate(`/apps/${appId}/watches`)}
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <Activity className="h-5 w-5 text-primary-500 mb-2" />
          <div className="font-medium text-zinc-900 dark:text-zinc-100">Watches</div>
          <div className="text-xs text-zinc-500 mt-0.5">Match / window alerts to Bolt</div>
        </button>
      </div>

      {/* Report types list */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/60 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Report types
        </div>
        {types.isLoading ? (
          <div className="p-4 text-sm text-zinc-500">Loading…</div>
        ) : (types.data?.data.length ?? 0) === 0 ? (
          <div className="p-4 text-sm text-zinc-500">
            No report types observed yet. They appear automatically as reports arrive.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {types.data!.data.map((t) => (
              <li key={t.report_type}>
                <button
                  onClick={() => onNavigate(`/apps/${appId}/types/${encodeURIComponent(t.report_type)}`)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                >
                  <span className="font-mono text-zinc-900 dark:text-zinc-100">{t.report_type}</span>
                  <span className="text-xs text-zinc-400">
                    {t.entry_count != null ? `${t.entry_count} entries` : ''}
                    {t.last_seen ? ` · ${formatRelativeTime(t.last_seen)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
