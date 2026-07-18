import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import { Launchpad } from '@bigbluebam/ui/launchpad';
import { api, type Metric } from './lib/api';

/* ----------------------------- routing (lean) ---------------------------- */
function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const nav = (p: string) => {
    window.history.pushState(null, '', p);
    setPath(p);
  };
  return [path, nav];
}

const CERT_COLORS: Record<string, string> = {
  certified: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  deprecated: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function Badge({ cert }: { cert: string }) {
  return (
    <span
      data-testid="cert-badge"
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CERT_COLORS[cert] ?? CERT_COLORS.draft}`}
    >
      {cert}
    </span>
  );
}

/* ------------------------------- top bar --------------------------------- */
function TopBar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-6 py-3">
      <a href="/basis/" className="flex items-center gap-2 font-semibold text-indigo-600">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">B</span>
        Basis
        <span className="text-xs font-normal text-zinc-400">Metric Layer</span>
      </a>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Launchpad"
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="hidden sm:inline">Launchpad</span>
      </button>
      <Launchpad isOpen={open} onClose={() => setOpen(false)} currentApp="basis" />
    </header>
  );
}

/* ------------------------------- catalog --------------------------------- */
function Catalog({ nav }: { nav: (p: string) => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const { data: metrics, isLoading } = useQuery({
    queryKey: ['metrics', filter],
    queryFn: () => api.listMetrics(filter || undefined),
  });

  const [form, setForm] = useState({
    slug: '',
    name: '',
    unit: 'currency',
    source_product: 'bill',
    source_entity: 'invoices',
    field: 'amount',
    agg: 'sum',
    time_column: 'created_at',
  });
  const create = useMutation({
    mutationFn: () =>
      api.createMetric({
        slug: form.slug,
        name: form.name,
        unit: form.unit,
        definition: {
          source_product: form.source_product,
          source_entity: form.source_entity,
          measure: { field: form.field, agg: form.agg },
          default_dimensions: [],
          time_column: form.time_column,
        },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['metrics'] });
      nav(`/basis/metrics/${res.metric.id}`);
    },
  });

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metric Catalog</h1>
        <select
          data-testid="cert-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
        >
          <option value="">All</option>
          <option value="certified">Certified</option>
          <option value="draft">Draft</option>
          <option value="deprecated">Deprecated</option>
        </select>
      </div>

      {isLoading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : (
        <table className="w-full text-sm" data-testid="metrics-table">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-zinc-500">
              <th className="py-2">Name</th>
              <th>Slug</th>
              <th>Unit</th>
              <th>Certification</th>
            </tr>
          </thead>
          <tbody>
            {(metrics ?? []).map((m: Metric) => (
              <tr
                key={m.id}
                data-testid="metric-row"
                onClick={() => nav(`/basis/metrics/${m.id}`)}
                className="cursor-pointer border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <td className="py-2 font-medium">{m.name}</td>
                <td className="text-zinc-500">{m.slug}</td>
                <td className="text-zinc-500">{m.unit}</td>
                <td>
                  <Badge cert={m.certification} />
                </td>
              </tr>
            ))}
            {(metrics ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-zinc-400">
                  No metrics yet. Define one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <div className="mt-8 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
        <h2 className="mb-3 font-semibold">Define a metric</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ['slug', 'slug (snake_case)'],
              ['name', 'name'],
              ['source_product', 'source product'],
              ['source_entity', 'source entity'],
              ['field', 'measure field'],
              ['time_column', 'time column'],
            ] as const
          ).map(([k, label]) => (
            <input
              key={k}
              data-testid={`field-${k}`}
              placeholder={label}
              value={(form as Record<string, string>)[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
            />
          ))}
          <select
            data-testid="field-unit"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
          >
            {['currency', 'count', 'percent', 'ratio', 'duration_ms'].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select
            data-testid="field-agg"
            value={form.agg}
            onChange={(e) => setForm({ ...form, agg: e.target.value })}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
          >
            {['sum', 'count', 'avg', 'min', 'max'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {create.isError && (
          <p data-testid="create-error" className="mt-2 text-sm text-red-600">
            {(create.error as Error).message}
          </p>
        )}
        <button
          data-testid="create-metric"
          disabled={!form.slug || !form.name || create.isPending}
          onClick={() => create.mutate()}
          className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create draft metric'}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- detail --------------------------------- */
function Detail({ id, nav }: { id: string; nav: (p: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['metric', id], queryFn: () => api.getMetric(id) });
  const { data: versions } = useQuery({ queryKey: ['versions', id], queryFn: () => api.listVersions(id) });

  const onDone = {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metric', id] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  };
  const certify = useMutation({ mutationFn: () => api.certify(id), ...onDone });
  const decertify = useMutation({ mutationFn: () => api.decertify(id), ...onDone });
  const deprecate = useMutation({ mutationFn: () => api.deprecate(id), ...onDone });

  if (isLoading) return <div className="p-6 text-zinc-500">Loading…</div>;
  if (!data) return <div className="p-6 text-zinc-500">Metric not found.</div>;
  const m = data.metric;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <button onClick={() => nav('/basis/')} className="mb-4 text-sm text-indigo-600">
        ← Catalog
      </button>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold" data-testid="metric-name">
          {m.name}
        </h1>
        <Badge cert={m.certification} />
      </div>
      <p className="text-zinc-500">
        {m.slug} · {m.unit} · favorable {m.favorable_direction}
      </p>

      <div className="mt-4 flex gap-2">
        {m.certification !== 'certified' && (
          <button
            data-testid="certify"
            onClick={() => certify.mutate()}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white"
          >
            Certify
          </button>
        )}
        {m.certification === 'certified' && (
          <button
            data-testid="decertify"
            onClick={() => decertify.mutate()}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white"
          >
            Decertify
          </button>
        )}
        {m.certification !== 'deprecated' && (
          <button
            data-testid="deprecate"
            onClick={() => deprecate.mutate()}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white"
          >
            Deprecate
          </button>
        )}
      </div>

      <h2 className="mt-8 mb-2 font-semibold">Version history</h2>
      <ul className="space-y-1 text-sm" data-testid="versions">
        {(versions ?? []).map((v) => (
          <li key={v.id} className="rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2">
            v{v.version_number} · {new Date(v.created_at).toLocaleString()}
            {v.change_note ? ` · ${v.change_note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------- app ----------------------------------- */
export function App() {
  const [path, nav] = usePath();
  const detailMatch = path.match(/^\/basis\/metrics\/([^/]+)/);
  return (
    <div className="min-h-screen">
      <TopBar />
      {detailMatch ? <Detail id={detailMatch[1]!} nav={nav} /> : <Catalog nav={nav} />}
    </div>
  );
}
