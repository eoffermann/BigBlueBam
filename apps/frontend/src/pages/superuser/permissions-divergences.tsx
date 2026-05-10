// Wave B SuperUser dashboard. Pulls the divergence summary + recent log
// from the api and surfaces the two views:
//   1. Summary table (default): one row per (permission_id, route) pair
//      with counts. Operators audit by patrolling the rows with the
//      highest divergence counts.
//   2. Drill-down: click a row to see the raw log entries for that pair.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Loader2, Database } from 'lucide-react';
import { api } from '@/lib/api';

interface DivergenceSummaryRow {
  permission_id: string;
  route_method: string | null;
  route_path: string | null;
  observations: number;
  divergences: number;
  first_seen: string | null;
  last_seen: string | null;
  sample_reason: string | null;
}

interface DivergenceLogRow {
  id: string;
  ts: string;
  request_id: string | null;
  user_id: string | null;
  permission_id: string;
  scope_type: string;
  scope_id: string | null;
  legacy_decision: string;
  resolved_decision: string;
  resolved_reason: string;
  route_method: string | null;
  route_path: string | null;
  is_divergent: boolean;
}

interface DrillDown {
  permission_id: string;
  route_path: string | null;
  route_method: string | null;
}

export function PermissionsDivergencesPage() {
  const [drilldown, setDrilldown] = useState<DrillDown | null>(null);

  const summary = useQuery({
    queryKey: ['perm-div-summary'],
    queryFn: () =>
      api
        .get<{ data: DivergenceSummaryRow[] }>('/superuser/permissions/divergences/summary')
        .then((r) => r.data),
  });

  const log = useQuery({
    queryKey: ['perm-div-log', drilldown?.permission_id, drilldown?.route_path],
    enabled: drilldown != null,
    queryFn: () =>
      api.get<{ data: DivergenceLogRow[]; next_cursor: string | null }>(
        '/superuser/permissions/divergences',
        {
          permission_id: drilldown!.permission_id,
          route_path: drilldown!.route_path ?? undefined,
          only_divergent: 'true',
          limit: 100,
        },
      ),
  });

  const totalObservations = (summary.data ?? []).reduce((s, r) => s + r.observations, 0);
  const totalDivergences = (summary.data ?? []).reduce((s, r) => s + r.divergences, 0);
  const divergenceRate =
    totalObservations > 0 ? ((totalDivergences / totalObservations) * 100).toFixed(2) : '—';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Permissions divergence log
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Wave B telemetry. Each row is one (permission, route) pair where the new resolver
            ran in shadow mode. <strong>The legacy role gate is still authoritative.</strong>{' '}
            A non-zero divergence count means the resolver disagreed with the legacy gate on
            at least one request — investigate before flipping{' '}
            <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
              BBB_PERMISSIONS_ENFORCE=on
            </code>.
          </p>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Sample observations" value={totalObservations.toLocaleString()} />
        <Stat label="Divergences" value={totalDivergences.toLocaleString()} />
        <Stat label="Divergence rate" value={`${divergenceRate}%`} />
      </div>

      {/* Summary table */}
      {summary.isLoading ? (
        <Loading label="Loading divergence summary…" />
      ) : (summary.data ?? []).length === 0 ? (
        <Empty label="No divergences observed yet. The dashboard will populate as Wave-B-annotated routes receive traffic." />
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Permission</th>
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 font-medium text-right">Observations</th>
                <th className="px-3 py-2 font-medium text-right">Divergences</th>
                <th className="px-3 py-2 font-medium">Sample reason</th>
              </tr>
            </thead>
            <tbody>
              {(summary.data ?? []).map((row) => (
                <tr
                  key={`${row.permission_id}-${row.route_path}-${row.route_method}`}
                  className="border-t border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 cursor-pointer"
                  onClick={() =>
                    setDrilldown({
                      permission_id: row.permission_id,
                      route_path: row.route_path,
                      route_method: row.route_method,
                    })
                  }
                >
                  <td className="px-3 py-2 font-mono text-xs">{row.permission_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.route_method} {row.route_path}
                  </td>
                  <td className="px-3 py-2 text-right">{row.observations.toLocaleString()}</td>
                  <td
                    className={`px-3 py-2 text-right ${
                      row.divergences > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : ''
                    }`}
                  >
                    {row.divergences.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {row.sample_reason ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Drill-down */}
      {drilldown && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold">
                {drilldown.route_method} {drilldown.route_path} → {drilldown.permission_id}
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">Recent divergent requests</p>
            </div>
            <button
              onClick={() => setDrilldown(null)}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Close
            </button>
          </div>
          {log.isLoading ? (
            <Loading label="Loading log entries…" />
          ) : (log.data?.data ?? []).length === 0 ? (
            <Empty label="No divergent entries for this pair." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left">
                    <th className="px-2 py-1">Time</th>
                    <th className="px-2 py-1">Request</th>
                    <th className="px-2 py-1">User</th>
                    <th className="px-2 py-1">Legacy</th>
                    <th className="px-2 py-1">Resolved</th>
                    <th className="px-2 py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(log.data?.data ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="px-2 py-1 font-mono">
                        {new Date(row.ts).toLocaleString()}
                      </td>
                      <td className="px-2 py-1 font-mono">{row.request_id ?? '—'}</td>
                      <td className="px-2 py-1 font-mono">{row.user_id ?? '—'}</td>
                      <td className="px-2 py-1">
                        <Decision value={row.legacy_decision} />
                      </td>
                      <td className="px-2 py-1">
                        <Decision value={row.resolved_decision} />
                      </td>
                      <td className="px-2 py-1 text-zinc-600 dark:text-zinc-400">
                        {row.resolved_reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-950">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-500 py-6 justify-center">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
      <Database className="h-4 w-4 inline-block mr-2" />
      {label}
    </div>
  );
}

function Decision({ value }: { value: string }) {
  if (value === 'allow')
    return <span className="text-green-700 dark:text-green-400 font-medium">allow</span>;
  if (value === 'deny')
    return <span className="text-red-700 dark:text-red-400 font-medium">deny</span>;
  return <span className="text-zinc-500">{value}</span>;
}
