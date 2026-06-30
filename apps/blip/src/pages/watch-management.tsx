import { useState } from 'react';
import { Bell, Plus, Loader2, Trash2, FlaskConical, History } from 'lucide-react';
import {
  useReportTypes,
  useWatches,
  useCreateWatch,
  useSetWatchEnabled,
  useDeleteWatch,
  useTestWatch,
  useWatchHistory,
  type Watch,
  type WatchKind,
  type PredicateTree,
  type WindowPredicate,
  type PredicateOperator,
} from '@/hooks/use-blip';
import { cn, formatRelativeTime } from '@/lib/utils';

interface WatchManagementPageProps {
  appId: string;
}

const MATCH_OPS: PredicateOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'is_set'];
const WINDOW_AGGS = ['count', 'rate', 'avg', 'min', 'max', 'p50', 'p95', 'p99'] as const;
const WINDOW_CMPS = ['gt', 'gte', 'lt', 'lte'] as const;

function buildMatchPredicate(field: string, op: PredicateOperator, raw: string): PredicateTree {
  let value: unknown = raw;
  if (op === 'in' || op === 'not_in') value = raw.split(',').map((s) => s.trim()).filter(Boolean);
  else if (op === 'is_set') value = undefined;
  else if (/^-?\d+(\.\d+)?$/.test(raw.trim())) value = Number(raw);
  return { op: 'and', conditions: [{ field, operator: op, value }] };
}

function WatchHistory({ watchId }: { watchId: string }) {
  const { data, isLoading } = useWatchHistory(watchId);
  const events = data?.data ?? [];
  if (isLoading) return <div className="px-4 py-2 text-xs text-zinc-500">Loading history…</div>;
  if (events.length === 0)
    return <div className="px-4 py-2 text-xs text-zinc-500">No firings yet.</div>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {events.map((ev) => (
        <li key={ev.id} className="px-4 py-2 text-xs flex items-center justify-between">
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{ev.event_name}</span>
          <span className="text-zinc-400">{formatRelativeTime(ev.fired_at)}</span>
        </li>
      ))}
    </ul>
  );
}

export function WatchManagementPage({ appId }: WatchManagementPageProps) {
  const types = useReportTypes(appId);
  const { data, isLoading } = useWatches(appId);
  const createWatch = useCreateWatch(appId);
  const setEnabled = useSetWatchEnabled(appId);
  const deleteWatch = useDeleteWatch(appId);
  const testWatch = useTestWatch(appId);

  const [name, setName] = useState('');
  const [reportType, setReportType] = useState('');
  const [kind, setKind] = useState<WatchKind>('match');
  const [cooldown, setCooldown] = useState(60);
  // match
  const [field, setField] = useState('elapsed_ms');
  const [op, setOp] = useState<PredicateOperator>('gt');
  const [val, setVal] = useState('500');
  // window
  const [windowSec, setWindowSec] = useState(60);
  const [agg, setAgg] = useState<(typeof WINDOW_AGGS)[number]>('count');
  const [aggField, setAggField] = useState('');
  const [cmp, setCmp] = useState<(typeof WINDOW_CMPS)[number]>('gt');
  const [threshold, setThreshold] = useState('20');

  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const watches = data?.data ?? [];

  function currentPredicate(): PredicateTree | WindowPredicate {
    if (kind === 'match') return buildMatchPredicate(field, op, val);
    return {
      window_sec: windowSec,
      aggregate: { op: agg, field: aggField.trim() || undefined },
      comparator: { operator: cmp, value: Number(threshold) },
    };
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Bell className="h-6 w-6 text-primary-500" />
          Watches
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Server-side conditions that emit a Bolt event when satisfied. Match watches fire per-entry at
          the edge; window watches alert on a sustained aggregate over a trailing window.
        </p>
      </div>

      {/* Create */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          createWatch.mutate(
            {
              name: name.trim(),
              report_type: reportType || null,
              kind,
              predicate: currentPredicate(),
              cooldown_sec: cooldown,
            },
            { onSuccess: () => setName('') },
          );
        }}
        className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-3"
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="slow-frame"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-36"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Report type</label>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value="">all types</option>
              {types.data?.data.map((t) => (
                <option key={t.report_type} value={t.report_type}>
                  {t.report_type}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Kind</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as WatchKind)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value="match">match (per-entry)</option>
              <option value="window">window (aggregate)</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Cooldown (s)</label>
            <input
              type="number"
              value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-20"
            />
          </div>
        </div>

        {/* Predicate builder */}
        {kind === 'match' ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Field</label>
              <input
                value={field}
                onChange={(e) => setField(e.target.value)}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm font-mono w-44"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Operator</label>
              <select
                value={op}
                onChange={(e) => setOp(e.target.value as PredicateOperator)}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {MATCH_OPS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            {op !== 'is_set' && (
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Value</label>
                <input
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-32"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Window (s)</label>
              <input
                type="number"
                value={windowSec}
                onChange={(e) => setWindowSec(Number(e.target.value))}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-24"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Aggregate</label>
              <select
                value={agg}
                onChange={(e) => setAgg(e.target.value as (typeof WINDOW_AGGS)[number])}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {WINDOW_AGGS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            {agg !== 'count' && agg !== 'rate' && (
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Field</label>
                <input
                  value={aggField}
                  onChange={(e) => setAggField(e.target.value)}
                  placeholder="elapsed_ms"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm font-mono w-36"
                />
              </div>
            )}
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Comparator</label>
              <select
                value={cmp}
                onChange={(e) => setCmp(e.target.value as (typeof WINDOW_CMPS)[number])}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {WINDOW_CMPS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Threshold</label>
              <input
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-24"
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={createWatch.isPending || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {createWatch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create watch
          </button>
          <button
            type="button"
            disabled={testWatch.isPending}
            onClick={() =>
              testWatch.mutate(
                { report_type: reportType || null, kind, predicate: currentPredicate() },
                {
                  onSuccess: (res) =>
                    setTestMsg(
                      `Dry-run: ${res.matched_count ?? res.data.length} match(es)` +
                        (res.value != null ? `, value ${res.value}` : '') +
                        ' over recent history.',
                    ),
                  onError: (err) =>
                    setTestMsg(err instanceof Error ? err.message : 'Test failed.'),
                },
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 disabled:opacity-60"
          >
            {testWatch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            Test
          </button>
          {testMsg && <span className="text-xs text-zinc-500">{testMsg}</span>}
        </div>
      </form>

      {/* List */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        {isLoading ? (
          <div className="p-4 text-sm text-zinc-500">Loading…</div>
        ) : watches.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">No watches yet.</div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {watches.map((w: Watch) => (
              <li key={w.id}>
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{w.name}</span>
                      <span
                        className={cn(
                          'inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium',
                          w.kind === 'window'
                            ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                            : 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
                        )}
                      >
                        {w.kind}
                      </span>
                      <span className="text-xs text-zinc-400 font-mono">
                        {w.report_type ?? 'all types'} · cooldown {w.cooldown_sec}s
                      </span>
                    </div>
                    <code className="text-xs text-zinc-400">{JSON.stringify(w.predicate)}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setOpenHistory((h) => (h === w.id ? null : w.id))}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      <History className="h-3.5 w-3.5" /> History
                    </button>
                    <button
                      onClick={() => setEnabled.mutate({ id: w.id, enabled: !w.enabled })}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                        w.enabled
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-900/50'
                          : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800',
                      )}
                    >
                      {w.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete watch ${w.name}?`)) deleteWatch.mutate(w.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900/50 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {openHistory === w.id && (
                  <div className="border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
                    <WatchHistory watchId={w.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
