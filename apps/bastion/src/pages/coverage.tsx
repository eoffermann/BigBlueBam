import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { friendlyError } from '@/lib/errors';
import type { CoverageRow } from '@/lib/api';
import { useCoverage } from '@/hooks/use-bastion';

// Evidence map (spec 6.1): every control by where its proof comes from.

const COLUMNS: Array<{ key: keyof CoverageRow['columns']; label: string }> = [
  { key: 'native', label: 'Checked by the suite' },
  { key: 'feed', label: 'Automated feed' },
  { key: 'manual_file', label: 'Uploaded evidence' },
  { key: 'self_attested', label: 'Self-attested' },
];

function Mark({ n }: { n: number }) {
  return <span className={n > 0 ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-zinc-300 dark:text-zinc-700'}>{n > 0 ? 'Yes' : '-'}</span>;
}

export function CoveragePage() {
  const [frameworkId, setFrameworkId] = useState('');
  const coverage = useCoverage({ framework_id: frameworkId || undefined });

  if (coverage.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (coverage.error || !coverage.data) {
    return <p className="p-8 text-sm text-red-600">{coverage.error ? friendlyError(coverage.error) : 'The Evidence map could not be loaded.'}</p>;
  }
  const c = coverage.data;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Evidence map</h1>
        <select
          aria-label="Framework"
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
          value={frameworkId}
          onChange={(e) => setFrameworkId(e.target.value)}
        >
          <option value="">All frameworks</option>
          {c.frameworks.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{c.headline}</p>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-600 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
            <th className="py-2 pr-4 font-medium">Control</th>
            {COLUMNS.map((col) => (
              <th key={col.key} className="py-2 px-2 font-medium">
                {col.label}
              </th>
            ))}
            <th className="py-2 pl-2 font-medium">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {c.data.map((r) => (
            <tr key={r.control_id}>
              <td className="py-2 pr-4 text-zinc-900 dark:text-zinc-100">{r.title}</td>
              {COLUMNS.map((col) => (
                <td key={col.key} className="py-2 px-2">
                  <Mark n={r.columns[col.key]} />
                </td>
              ))}
              <td className="py-2 pl-2">
                <p className="text-zinc-900 dark:text-zinc-100">{r.state_words}</p>
                {r.reason_words && <p className="text-xs text-zinc-500">{r.reason_words}</p>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-300 dark:border-zinc-700 font-semibold" data-testid="coverage-totals">
            <td className="py-2 pr-4">Controls</td>
            {COLUMNS.map((col) => (
              <td key={col.key} className="py-2 px-2">
                {c.totals[col.key]}
              </td>
            ))}
            <td className="py-2 pl-2">Not set up yet: {c.totals.none}</td>
          </tr>
        </tfoot>
      </table>

      {c.not_applicable.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Does not apply ({c.not_applicable.length})</h2>
          <ul className="mt-2 text-sm text-zinc-600 dark:text-zinc-400 list-disc pl-5">
            {c.not_applicable.map((n) => (
              <li key={n.control_id}>{n.title}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
