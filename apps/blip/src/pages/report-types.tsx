import { useState } from 'react';
import { ListTree, Radio, Gauge, Database, Loader2 } from 'lucide-react';
import {
  useReportTypes,
  useFieldCatalog,
  useIndexField,
  useSetMetric,
  type FieldCatalogEntry,
} from '@/hooks/use-blip';
import { cn, formatRelativeTime } from '@/lib/utils';

interface ReportTypesPageProps {
  appId: string;
  onNavigate: (path: string) => void;
}

const TYPE_BADGE: Record<string, string> = {
  string: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  number: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  bool: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  object: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  array: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  mixed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function FieldCatalog({ appId, reportType }: { appId: string; reportType: string }) {
  const { data, isLoading } = useFieldCatalog(appId, reportType);
  const indexField = useIndexField(appId, reportType);
  const setMetric = useSetMetric(appId, reportType);
  const fields = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-zinc-500 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading field catalog…
      </div>
    );
  }
  if (fields.length === 0) {
    return <div className="p-4 text-sm text-zinc-500">No observed fields yet.</div>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
          <th className="px-4 py-2">Field path</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Observations</th>
          <th className="px-4 py-2">Last seen</th>
          <th className="px-4 py-2 text-right">Flags</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f: FieldCatalogEntry) => (
          <tr key={f.id} className="border-t border-zinc-100 dark:border-zinc-800">
            <td className="px-4 py-2 font-mono text-zinc-900 dark:text-zinc-100">{f.field_path}</td>
            <td className="px-4 py-2">
              <span
                className={cn(
                  'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium',
                  TYPE_BADGE[f.inferred_type] ?? TYPE_BADGE.mixed,
                )}
              >
                {f.inferred_type}
              </span>
            </td>
            <td className="px-4 py-2 text-zinc-500">{String(f.observation_count)}</td>
            <td className="px-4 py-2 text-zinc-500">{formatRelativeTime(f.last_seen)}</td>
            <td className="px-4 py-2">
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setMetric.mutate({ fieldPath: f.field_path, is_metric: !f.is_metric })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                    f.is_metric
                      ? 'border-violet-300 bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300 dark:border-violet-900/50'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                  title="Include in the numeric Bench rollup"
                >
                  <Gauge className="h-3.5 w-3.5" />
                  {f.is_metric ? 'Metric' : 'Mark metric'}
                </button>
                <button
                  disabled={f.is_indexed || indexField.isPending}
                  onClick={() => indexField.mutate(f.field_path)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                    f.is_indexed
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-900/50'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-60',
                  )}
                  title="Create a btree expression index on this field"
                >
                  <Database className="h-3.5 w-3.5" />
                  {f.is_indexed ? 'Indexed' : 'Index'}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportTypesPage({ appId, onNavigate }: ReportTypesPageProps) {
  const { data, isLoading } = useReportTypes(appId);
  const types = data?.data ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <ListTree className="h-6 w-6 text-primary-500" />
          Report types
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Discovered from incoming data. Expand one to inspect its field catalog, mark Bench metrics,
          or promote a hot field to an index. Open the live viewer to tail it.
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : types.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <ListTree className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No report types yet</h3>
          <p className="text-sm text-zinc-500 mt-1">They appear automatically as reports arrive.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {types.map((t) => (
            <div
              key={t.report_type}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3">
                <button
                  onClick={() => setExpanded((e) => (e === t.report_type ? null : t.report_type))}
                  className="flex items-center gap-2 min-w-0 text-left"
                >
                  <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {t.report_type}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {t.entry_count != null ? `${t.entry_count} entries` : ''}
                  </span>
                </button>
                <button
                  onClick={() => onNavigate(`/apps/${appId}/types/${encodeURIComponent(t.report_type)}`)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <Radio className="h-3.5 w-3.5" /> Live viewer
                </button>
              </div>
              {expanded === t.report_type && (
                <div className="border-t border-zinc-100 dark:border-zinc-800">
                  <FieldCatalog appId={appId} reportType={t.report_type} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
