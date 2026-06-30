import { useState } from 'react';
import { Layers, Plus, Loader2, Trash2, Star } from 'lucide-react';
import {
  useReportTypes,
  useViews,
  useCreateView,
  useDeleteView,
  type SavedView,
  type PredicateTree,
  type PredicateOperator,
} from '@/hooks/use-blip';
import { cn } from '@/lib/utils';

interface SavedViewsPageProps {
  appId: string;
}

const OPERATORS: PredicateOperator[] = [
  'eq', 'neq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_set', 'is_not_set',
];

function buildFilter(field: string, operator: PredicateOperator, raw: string): PredicateTree | null {
  if (!field.trim()) return null;
  let value: unknown = raw;
  if (operator === 'in' || operator === 'not_in') {
    value = raw.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (operator === 'is_set' || operator === 'is_not_set') {
    value = undefined;
  } else if (/^-?\d+(\.\d+)?$/.test(raw.trim())) {
    value = Number(raw);
  }
  return { op: 'and', conditions: [{ field: field.trim(), operator, value }] };
}

function ViewList({ appId, reportType }: { appId: string; reportType: string }) {
  const { data, isLoading } = useViews(appId, reportType);
  const createView = useCreateView(appId, reportType);
  const deleteView = useDeleteView(appId, reportType);

  const [name, setName] = useState('');
  const [field, setField] = useState('level');
  const [operator, setOperator] = useState<PredicateOperator>('in');
  const [value, setValue] = useState('error, fatal');
  const [scope, setScope] = useState<'private' | 'org'>('private');

  const views = data?.data ?? [];

  return (
    <div className="space-y-4">
      {/* Create */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const filter = buildFilter(field, operator, value);
          createView.mutate(
            {
              tracked_app_id: appId,
              report_type: reportType,
              name: name.trim(),
              scope,
              spec: { filter, liveTail: true, pageSize: 100 },
            },
            { onSuccess: () => setName('') },
          );
        }}
        className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-3"
      >
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">New view</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Errors only"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-40"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Field</label>
            <input
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="level or payload:fn"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm font-mono w-44"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Operator</label>
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value as PredicateOperator)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              {OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          {operator !== 'is_set' && operator !== 'is_not_set' && (
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500 mb-1">Value</label>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="error, fatal"
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-36"
              />
            </div>
          )}
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'private' | 'org')}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value="private">private</option>
              <option value="org">org</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={createView.isPending || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {createView.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </button>
        </div>
      </form>

      {/* List */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        {isLoading ? (
          <div className="p-4 text-sm text-zinc-500">Loading…</div>
        ) : views.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">
            No saved views. A default view (all reserved columns, live tail) is always available in the viewer.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {views.map((v: SavedView) => (
              <li key={v.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {v.is_default && <Star className="h-3.5 w-3.5 text-amber-500" />}
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{v.name}</span>
                    <span
                      className={cn(
                        'inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium',
                        v.scope === 'org'
                          ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400'
                          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                      )}
                    >
                      {v.scope}
                    </span>
                  </div>
                  <code className="text-xs text-zinc-400">{JSON.stringify(v.spec.filter ?? {})}</code>
                </div>
                <button
                  onClick={() => deleteView.mutate(v.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900/50 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SavedViewsPage({ appId }: SavedViewsPageProps) {
  const types = useReportTypes(appId);
  const [reportType, setReportType] = useState<string>('');

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Layers className="h-6 w-6 text-primary-500" />
          Saved views
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          A view is a filter + columns + sort over one report type. Pick a report type to manage its views.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-zinc-500">Report type</label>
        <select
          value={reportType}
          onChange={(e) => setReportType(e.target.value)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
        >
          <option value="">Select…</option>
          {types.data?.data.map((t) => (
            <option key={t.report_type} value={t.report_type}>
              {t.report_type}
            </option>
          ))}
        </select>
      </div>

      {reportType ? (
        <ViewList appId={appId} reportType={reportType} />
      ) : (
        <div className="text-sm text-zinc-500">Choose a report type above to see and create views.</div>
      )}
    </div>
  );
}
