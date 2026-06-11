/**
 * SuperUser Console → Logs tab.
 *
 * Two modes:
 *   - System Console: every 5xx the api emits + every worker job
 *     failure, surfaced from the system_errors table.
 *   - Audit Log: every action recorded in v_activity_unified (Bam
 *     activity_log, Bond activities, helpdesk ticket activity, … —
 *     normalized into one stream by the existing view).
 *
 * Both modes share the same control surface: search box, paginated
 * list, expand-row to see the full payload/stack/details.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Mode = 'errors' | 'audit';

interface ErrorRow {
  id: string;
  service: string;
  request_id: string | null;
  method: string | null;
  route: string | null;
  status_code: number | null;
  error_code: string | null;
  message: string;
  stack: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  user_id: string | null;
  org_id: string | null;
}

interface AuditRow {
  id: string;
  source_app: string | null;
  entity_type: string | null;
  entity_id: string | null;
  project_id: string | null;
  organization_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  action: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

interface ErrorsResponse {
  data: {
    rows: ErrorRow[];
    total: number;
    services: { service: string; n: number }[];
  };
}

interface AuditResponse {
  data: {
    rows: AuditRow[];
    total: number;
    sources: { source_app: string | null; n: number }[];
  };
}

const PAGE_SIZE = 50;

export function SuperuserLogsTab() {
  const [mode, setMode] = useState<Mode>('errors');
  const [q, setQ] = useState('');
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Reset paging when switching mode or changing filters.
  const resetPaging = () => setPage(0);

  // Build endpoint + params per mode.
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (mode === 'errors' && serviceFilter) params.set('service', serviceFilter);
  if (mode === 'audit' && sourceFilter) params.set('source_app', sourceFilter);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(page * PAGE_SIZE));

  const endpoint =
    mode === 'errors'
      ? `/superuser/system-errors?${params}`
      : `/superuser/activity-log?${params}`;

  const query = useQuery({
    queryKey: ['superuser-logs', mode, q, serviceFilter, sourceFilter, page],
    queryFn: () => api.get<ErrorsResponse | AuditResponse>(endpoint),
    // Auto-refresh every 10s so operators see new errors land without
    // hammering refresh. The TanStack debounce coalesces user typing.
    refetchInterval: 10_000,
  });

  const rows = query.data?.data?.rows ?? [];
  const total = query.data?.data?.total ?? 0;
  const services =
    mode === 'errors'
      ? ((query.data as ErrorsResponse | undefined)?.data?.services ?? [])
      : [];
  const sources =
    mode === 'audit'
      ? ((query.data as AuditResponse | undefined)?.data?.sources ?? [])
      : [];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4 max-w-6xl">
      {/* Mode toggle */}
      <div className="flex items-center gap-2">
        <ModeButton
          active={mode === 'errors'}
          onClick={() => {
            setMode('errors');
            resetPaging();
          }}
          icon={<AlertOctagon className="h-4 w-4" />}
          label="System Console"
          subtitle="Errors from every service"
        />
        <ModeButton
          active={mode === 'audit'}
          onClick={() => {
            setMode('audit');
            resetPaging();
          }}
          icon={<ListChecks className="h-4 w-4" />}
          label="Audit Log"
          subtitle="Actions across api, MCP, permissions"
        />
        <button
          type="button"
          onClick={() => query.refetch()}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <RefreshCw
            className={
              'h-3.5 w-3.5 ' +
              (query.isFetching ? 'animate-spin' : '')
            }
          />
          {query.isFetching ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {/* Controls: search + per-mode filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              resetPaging();
            }}
            placeholder={
              mode === 'errors'
                ? 'Search message, route, error code…'
                : 'Search action, entity, details…'
            }
            className="w-full pl-9 pr-9 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQ('');
                resetPaging();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {mode === 'errors' && (
          <select
            value={serviceFilter}
            onChange={(e) => {
              setServiceFilter(e.target.value);
              resetPaging();
            }}
            className="px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s.service} value={s.service}>
                {s.service} ({s.n})
              </option>
            ))}
          </select>
        )}

        {mode === 'audit' && (
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              resetPaging();
            }}
            className="px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.source_app ?? ''} value={s.source_app ?? ''}>
                {s.source_app ?? '(none)'} ({s.n})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Results */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
          </div>
        ) : query.isError ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-400">
            Failed to load: {(query.error as Error).message}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-zinc-500">
            {q || serviceFilter || sourceFilter
              ? 'No entries match the current filters.'
              : mode === 'errors'
                ? 'No errors yet. The system has been behaving.'
                : 'No audit entries.'}
          </div>
        ) : mode === 'errors' ? (
          <ErrorRows
            rows={rows as ErrorRow[]}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
        ) : (
          <AuditRows
            rows={rows as AuditRow[]}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 px-4 py-2 text-xs text-zinc-500">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{' '}
              {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="px-2">
                Page {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────

function ModeButton({
  active,
  onClick,
  icon,
  label,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-start gap-2 px-3 py-2 rounded-md border text-left transition-colors min-w-[220px] ' +
        (active
          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-900 dark:text-primary-100'
          : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-700')
      }
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs opacity-70">{subtitle}</span>
      </span>
    </button>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  // YYYY-MM-DD HH:MM:SS (UTC-ish — operators usually want timestamps,
  // not relative times, when debugging).
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function ErrorRows({
  rows,
  expandedId,
  setExpandedId,
}: {
  rows: ErrorRow[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {rows.map((r) => {
        const expanded = expandedId === r.id;
        return (
          <li key={r.id} className="text-sm">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : r.id)}
              className="w-full flex items-start gap-3 px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-950 transition-colors"
            >
              <span className="font-mono text-xs text-zinc-500 shrink-0 mt-0.5 w-[170px]">
                {fmtTime(r.created_at)}
              </span>
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded font-semibold uppercase tracking-wide bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 shrink-0">
                {r.service}
              </span>
              {r.status_code != null && (
                <span className="text-xs font-mono text-zinc-500 shrink-0">
                  {r.status_code}
                </span>
              )}
              {r.method && r.route && (
                <span className="font-mono text-xs text-zinc-500 truncate shrink-0 max-w-[300px]">
                  {r.method} {r.route}
                </span>
              )}
              <span className="text-zinc-900 dark:text-zinc-100 truncate">
                {r.message}
              </span>
            </button>
            {expanded && (
              <div className="bg-zinc-50 dark:bg-zinc-950 border-t border-zinc-100 dark:border-zinc-800 px-4 py-3 text-xs space-y-2">
                <Detail label="error_code" value={r.error_code} />
                <Detail label="request_id" value={r.request_id} />
                <Detail label="user_id" value={r.user_id} />
                <Detail label="org_id" value={r.org_id} />
                {r.payload && Object.keys(r.payload).length > 0 && (
                  <Pre label="payload" body={JSON.stringify(r.payload, null, 2)} />
                )}
                {r.stack && <Pre label="stack" body={r.stack} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AuditRows({
  rows,
  expandedId,
  setExpandedId,
}: {
  rows: AuditRow[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {rows.map((r) => {
        const expanded = expandedId === r.id;
        return (
          <li key={r.id} className="text-sm">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : r.id)}
              className="w-full flex items-start gap-3 px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-950 transition-colors"
            >
              <span className="font-mono text-xs text-zinc-500 shrink-0 mt-0.5 w-[170px]">
                {fmtTime(r.created_at)}
              </span>
              {r.source_app && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded font-semibold uppercase tracking-wide bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 shrink-0">
                  {r.source_app}
                </span>
              )}
              {r.actor_type && (
                <span className="text-xs text-zinc-500 shrink-0">{r.actor_type}</span>
              )}
              <span className="text-zinc-900 dark:text-zinc-100 truncate">
                {r.action ?? '(no action)'}{' '}
                {r.entity_type && (
                  <span className="text-zinc-500">— {r.entity_type}</span>
                )}
              </span>
            </button>
            {expanded && (
              <div className="bg-zinc-50 dark:bg-zinc-950 border-t border-zinc-100 dark:border-zinc-800 px-4 py-3 text-xs space-y-2">
                <Detail label="actor_id" value={r.actor_id} />
                <Detail label="entity_id" value={r.entity_id} />
                <Detail label="project_id" value={r.project_id} />
                <Detail label="organization_id" value={r.organization_id} />
                {r.details && Object.keys(r.details).length > 0 && (
                  <Pre label="details" body={JSON.stringify(r.details, null, 2)} />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-zinc-500 w-24 shrink-0">{label}</span>
      <span className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{value}</span>
    </div>
  );
}

function Pre({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <span className="block text-zinc-500 mb-1">{label}</span>
      <pre className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto max-h-72 whitespace-pre-wrap break-all">
        {body}
      </pre>
    </div>
  );
}
