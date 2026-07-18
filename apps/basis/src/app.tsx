import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import type { CreateBasisMetricInput } from '@bigbluebam/shared';
import { useAuthStore } from '@/stores/auth.store';
import { BasisLayout, type ActiveRoute } from '@/components/layout/basis-layout';
import { api, type Metric } from './lib/api';

const BASE_PATH = '/basis';

/* ----------------------------- routing (lean) ---------------------------- */
type Route = { page: 'catalog' } | { page: 'metric'; id: string } | { page: 'help' };

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) return path.slice(BASE_PATH.length) || '/';
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);
  if (p === '/help') return { page: 'help' };
  const m = p.match(/^\/metrics\/([^/]+)/);
  if (m) return { page: 'metric', id: m[1]! };
  return { page: 'catalog' };
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
        // The <select> options are constrained to valid enum members in the UI,
        // so narrow the free-form form strings to the shared input enums here.
        unit: form.unit as CreateBasisMetricInput['unit'],
        favorable_direction: 'up',
        definition: {
          source_product: form.source_product,
          source_entity: form.source_entity,
          measure: {
            field: form.field,
            agg: form.agg as CreateBasisMetricInput['definition']['measure']['agg'],
          },
          default_dimensions: [],
          time_column: form.time_column,
        },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['metrics'] });
      nav(`/metrics/${res.metric.id}`);
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
                onClick={() => nav(`/metrics/${m.id}`)}
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
          className="mt-3 rounded-lg bg-primary-600 hover:bg-primary-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 transition-colors"
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
      <button onClick={() => nav('/')} className="mb-4 text-sm text-primary-600 hover:text-primary-700">
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
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // Apply saved theme on mount (shared 'bbam-theme' key).
  useEffect(() => {
    const savedTheme = localStorage.getItem('bbam-theme') ?? 'system';
    const root = document.documentElement;
    root.classList.remove('dark');
    if (savedTheme === 'dark') {
      root.classList.add('dark');
    } else if (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    }
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    const full = `${BASE_PATH}${path}`;
    window.history.pushState(null, '', full);
    setRoute(parseRoute(full));
  }, []);

  // "?" opens Help for the current app (suite convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inInput = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if (e.key === '?' && !inInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigate('/help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Breadcrumb title for the metric detail page (shares the ['metric', id]
  // react-query cache, so no extra request).
  const metricId = route.page === 'metric' ? route.id : undefined;
  const { data: metricForCrumb } = useQuery({
    queryKey: ['metric', metricId],
    queryFn: () => api.getMetric(metricId!),
    enabled: !!metricId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl">
            B
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Basis Metric Layer</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Basis.</p>
          <a
            href="/b3/"
            className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  if (route.page === 'help') {
    return <HelpViewer appSlug="basis" onBack={() => navigate('/')} />;
  }

  const activeRoute: ActiveRoute =
    route.page === 'metric'
      ? { page: 'metric', id: route.id, label: metricForCrumb?.metric.name }
      : { page: 'catalog' };

  return (
    <BasisLayout onNavigate={navigate} activeRoute={activeRoute}>
      {route.page === 'metric' ? (
        <Detail id={route.id} nav={navigate} />
      ) : (
        <Catalog nav={navigate} />
      )}
    </BasisLayout>
  );
}
