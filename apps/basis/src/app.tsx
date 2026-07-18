import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import type { CreateBasisMetricInput } from '@bigbluebam/shared';
import { useAuthStore } from '@/stores/auth.store';
import { BasisLayout, type ActiveRoute } from '@/components/layout/basis-layout';
import { api, getDataSources, type Metric } from './lib/api';

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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// Explicit bg + text for both themes: a transparent select renders its native
// option popup as white-on-white in dark mode. Setting the select's background
// makes both the field and its options readable in light and dark.
const SELECT_CLASS =
  'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm';

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

  // Definition builder: pull Bench's governed data-source catalog so a human
  // picks a real source + real fields from dropdowns instead of typing strings.
  const { data: sources = [] } = useQuery({ queryKey: ['data-sources'], queryFn: getDataSources });
  const [form, setForm] = useState({
    slug: '',
    name: '',
    unit: 'count',
    favorable: 'up',
    sourceKey: '',
    measureField: '',
    agg: '',
    timeCol: '',
    dimension: '',
  });
  const src = sources.find((s) => `${s.product}/${s.entity}` === form.sourceKey);
  const measures = src?.measures ?? [];
  const selectedMeasure = measures.find((m) => m.field === form.measureField);
  const aggs = selectedMeasure?.aggregations ?? [];
  const temporalDims = (src?.dimensions ?? []).filter((d) => d.type === 'temporal');
  const catDims = (src?.dimensions ?? []).filter((d) => d.type === 'categorical');

  // Pick a source: reset the field selections and default the time column to the
  // first temporal dimension so the common case needs one click.
  function pickSource(key: string) {
    const s = sources.find((x) => `${x.product}/${x.entity}` === key);
    const firstTemporal = (s?.dimensions ?? []).find((d) => d.type === 'temporal');
    setForm((f) => ({
      ...f,
      sourceKey: key,
      measureField: '',
      agg: '',
      timeCol: firstTemporal?.field ?? '',
      dimension: '',
    }));
  }
  function pickMeasure(field: string) {
    const m = measures.find((x) => x.field === field);
    setForm((f) => ({ ...f, measureField: field, agg: m?.aggregations[0] ?? '' }));
  }
  // Auto-suggest a snake_case slug from the name until the user edits slug.
  function setName(name: string) {
    setForm((f) => {
      const auto = f.slug === '' || f.slug === slugify(f.name);
      return { ...f, name, slug: auto ? slugify(name) : f.slug };
    });
  }

  const ready = !!(form.slug && form.name && src && form.measureField && form.agg && form.timeCol);
  const create = useMutation({
    mutationFn: () =>
      api.createMetric({
        slug: form.slug,
        name: form.name,
        unit: form.unit as CreateBasisMetricInput['unit'],
        favorable_direction: form.favorable as CreateBasisMetricInput['favorable_direction'],
        definition: {
          source_product: src!.product,
          source_entity: src!.entity,
          measure: {
            field: form.measureField,
            agg: form.agg as CreateBasisMetricInput['definition']['measure']['agg'],
          },
          default_dimensions: form.dimension ? [form.dimension] : [],
          time_column: form.timeCol,
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
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1 text-sm"
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(metrics ?? []).map((m: Metric) => (
              <tr
                key={m.id}
                data-testid="metric-row"
                onClick={() => nav(`/metrics/${m.id}`)}
                className="group cursor-pointer border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <td className="py-2 font-medium text-primary-600 group-hover:underline">{m.name}</td>
                <td className="text-zinc-500">{m.slug}</td>
                <td className="text-zinc-500">{m.unit}</td>
                <td>
                  <Badge cert={m.certification} />
                </td>
                <td className="text-right text-xs text-zinc-400 group-hover:text-primary-600">View →</td>
              </tr>
            ))}
            {(metrics ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-zinc-400">
                  No metrics yet. Define one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <div className="mt-8 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
        <h2 className="mb-1 font-semibold">Define a metric</h2>
        <p className="mb-4 text-sm text-zinc-500">
          Pick a governed data source and the field to measure. The dropdowns come
          from Bench's approved catalog, so you reference real columns, not free text.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Identity */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Name</span>
            <input
              data-testid="field-name"
              placeholder="e.g. Daily Coconut Count"
              value={form.name}
              onChange={(e) => setName(e.target.value)}
              className={SELECT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Slug (unique id)</span>
            <input
              data-testid="field-slug"
              placeholder="daily_coconut_count"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              className={SELECT_CLASS}
            />
          </label>

          {/* Source picker */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Data source</span>
            <select
              data-testid="field-source"
              value={form.sourceKey}
              onChange={(e) => pickSource(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Select a source…</option>
              {sources.map((s) => (
                <option key={`${s.product}/${s.entity}`} value={`${s.product}/${s.entity}`}>
                  {s.label} ({s.product}.{s.entity})
                </option>
              ))}
            </select>
          </label>

          {/* Measure + aggregation (populated from the source) */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">Measure</span>
              <select
                data-testid="field-measure"
                value={form.measureField}
                onChange={(e) => pickMeasure(e.target.value)}
                disabled={!src}
                className={SELECT_CLASS}
              >
                <option value="">Field…</option>
                {measures.map((m) => (
                  <option key={m.field} value={m.field}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">Aggregation</span>
              <select
                data-testid="field-agg"
                value={form.agg}
                onChange={(e) => setForm({ ...form, agg: e.target.value })}
                disabled={!selectedMeasure}
                className={SELECT_CLASS}
              >
                <option value="">Agg…</option>
                {aggs.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Time column + optional default dimension (from the source) */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Time column</span>
            <select
              data-testid="field-timecol"
              value={form.timeCol}
              onChange={(e) => setForm({ ...form, timeCol: e.target.value })}
              disabled={!src}
              className={SELECT_CLASS}
            >
              <option value="">When measured…</option>
              {temporalDims.map((d) => (
                <option key={d.field} value={d.field}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Default breakdown dimension (optional)</span>
            <select
              data-testid="field-dimension"
              value={form.dimension}
              onChange={(e) => setForm({ ...form, dimension: e.target.value })}
              disabled={!src}
              className={SELECT_CLASS}
            >
              <option value="">None</option>
              {catDims.map((d) => (
                <option key={d.field} value={d.field}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          {/* Presentation */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Unit</span>
            <select
              data-testid="field-unit"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              className={SELECT_CLASS}
            >
              {['currency', 'count', 'percent', 'ratio', 'duration_ms'].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Favorable direction</span>
            <select
              data-testid="field-favorable"
              value={form.favorable}
              onChange={(e) => setForm({ ...form, favorable: e.target.value })}
              className={SELECT_CLASS}
            >
              {['up', 'down', 'neutral'].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>

        {create.isError && (
          <p data-testid="create-error" className="mt-3 text-sm text-red-600">
            {(create.error as Error).message}
          </p>
        )}
        <button
          data-testid="create-metric"
          disabled={!ready || create.isPending}
          onClick={() => create.mutate()}
          className="mt-4 rounded-lg bg-primary-600 hover:bg-primary-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 transition-colors"
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
  const def = data.currentVersion?.definition;

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
      {m.description && <p className="mt-1 text-sm text-zinc-500">{m.description}</p>}

      {/* Current value over the last 30 days */}
      <MetricValue id={id} unit={m.unit} />

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

      {/* How this metric is defined */}
      <h2 className="mt-8 mb-2 font-semibold">Definition</h2>
      {def ? (
        <div data-testid="definition" className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 text-sm">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
            <dt className="text-zinc-500">Source</dt>
            <dd className="font-medium">
              {def.source_product}.{def.source_entity}
            </dd>
            <dt className="text-zinc-500">Measure</dt>
            <dd className="font-medium">
              {def.measure.agg}({def.measure.field})
            </dd>
            <dt className="text-zinc-500">Time column</dt>
            <dd className="font-medium">{def.time_column}</dd>
            {def.default_dimensions && def.default_dimensions.length > 0 && (
              <>
                <dt className="text-zinc-500">Breakdown by</dt>
                <dd className="font-medium">{def.default_dimensions.join(', ')}</dd>
              </>
            )}
            {def.filters && def.filters.length > 0 && (
              <>
                <dt className="text-zinc-500">Filters</dt>
                <dd className="font-medium">
                  {def.filters.map((f) => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join(' and ')}
                </dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No current definition.</p>
      )}

      <h2 className="mt-8 mb-2 font-semibold">Version history</h2>
      <ul className="space-y-1 text-sm" data-testid="versions">
        {(versions ?? []).map((v) => {
          const d = v.definition;
          return (
            <li key={v.id} className="rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2">
              <div>
                v{v.version_number} · {new Date(v.created_at).toLocaleString()}
                {v.change_note ? ` · ${v.change_note}` : ''}
              </div>
              {d && (
                <div className="text-xs text-zinc-500">
                  {d.source_product}.{d.source_entity} · {d.measure.agg}({d.measure.field})
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The metric's current scalar value over a trailing 30-day window. Degrades
// gracefully: a Bench outage (503) or a bad definition (400) shows a note, never
// a crash.
function MetricValue({ id, unit }: { id: string; unit: string }) {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400_000);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['value', id],
    queryFn: () => api.getValue(id, from.toISOString(), to.toISOString()),
    retry: false,
  });
  return (
    <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Current value · last 30 days</div>
      {isLoading ? (
        <div className="mt-1 text-2xl font-semibold text-zinc-400">…</div>
      ) : isError ? (
        <div className="mt-1 text-sm text-amber-600" data-testid="value-error">
          {(error as { code?: string })?.code === 'DEFINITION_RESOLVE_FAILED'
            ? 'Definition does not resolve against its source.'
            : 'Value unavailable right now (Bench query service).'}
        </div>
      ) : (
        <div className="mt-1 text-3xl font-semibold" data-testid="metric-value">
          {data?.value == null ? '—' : data.value.toLocaleString()}
          <span className="ml-2 text-sm font-normal text-zinc-500">{unit}</span>
        </div>
      )}
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
