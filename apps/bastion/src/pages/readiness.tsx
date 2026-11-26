import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { friendlyError } from '@/lib/errors';
import { useSummary } from '@/hooks/use-bastion';

// Readiness (spec 6.1, 2.3): the four numbers, never blended, with "Not set up yet" beside them
// and the denominator in the headline. Accepted risks count under Not met, never as proof.

export function expiresText(daysLeft: number): string {
  if (daysLeft < 0) return 'expired';
  if (daysLeft === 0) return 'expires today';
  return `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}

function Tile({ label, value, testId, tone }: { label: string; value: string; testId: string; tone: string }) {
  return (
    <div className={`rounded-xl border p-4 ${tone}`} data-testid={testId}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="mt-1 text-sm font-medium">{label}</p>
    </div>
  );
}

const GAP_WORDS: Record<string, string> = {
  failing: 'Not met',
  no_source: 'Nothing can prove this yet',
  manual_expired: 'Uploaded evidence expired',
  not_connected: 'Source not connected',
  manual_missing: 'Waiting for evidence',
  population_drift: 'Something new is not on the list',
  check_broken: 'The check could not run',
  insufficient_data: 'Not enough activity to tell',
  population_review: 'The list needs a fresh look',
  not_assessed: 'Not set up yet',
  manual_expiring: 'Evidence expiring soon',
  attested_only: 'Only a written statement',
};

export function ReadinessPage({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const [frameworkId, setFrameworkId] = useState('');
  const summary = useSummary({ framework_id: frameworkId || undefined });

  if (summary.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (summary.error || !summary.data) {
    return <p className="p-8 text-sm text-red-600">{summary.error ? friendlyError(summary.error) : 'Readiness could not be loaded.'}</p>;
  }
  const d = summary.data.data;
  const n = d.numbers;

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Readiness</h1>
        <div className="flex items-center gap-4">
          {d.days_to_audit !== null && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="days-to-audit">
              {d.days_to_audit >= 0 ? `${d.days_to_audit} days to the audit` : 'The audit date has passed'}
            </p>
          )}
          <select
            aria-label="Framework"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={frameworkId}
            onChange={(e) => setFrameworkId(e.target.value)}
          >
            <option value="">All frameworks</option>
            {d.frameworks.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {d.banners.length > 0 && (
        <ul className="space-y-2">
          {d.banners.map((b) => (
            <li
              key={b.code}
              className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{b.message}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-lg text-zinc-900 dark:text-zinc-100" data-testid="headline">
        {d.headline}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Proven by the suite" value={String(n.proven_by_suite)} testId="n-suite" tone="border-emerald-300 text-emerald-800 dark:text-emerald-300" />
        <Tile
          label="Proven by evidence you provided"
          value={String(n.proven_by_evidence)}
          testId="n-evidence"
          tone="border-sky-300 text-sky-800 dark:text-sky-300"
        />
        <div className="rounded-xl border border-red-300 p-4 text-red-800 dark:text-red-300" data-testid="n-not-met">
          <p className="text-3xl font-bold">{n.not_met}</p>
          <p className="mt-1 text-sm font-medium">{d.not_met_label}</p>
        </div>
        <Tile label="Can't prove yet" value={String(n.cant_prove)} testId="n-cant-prove" tone="border-zinc-300 text-zinc-800 dark:text-zinc-300" />
        <div className="rounded-xl border border-dashed border-amber-400 p-4 text-amber-800 dark:text-amber-300" data-testid="n-not-set-up">
          <p className="text-sm font-semibold">Not set up yet: {n.not_set_up}</p>
          <p className="mt-1 text-xs">Controls with no confirmed way to check them.</p>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">What to fix first</h2>
        {d.gaps_ranked ? (
          <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4">
            {d.top_gaps.map((g) => (
              <li key={g.id} className="flex justify-between gap-4 py-2 text-sm">
                <span className="text-zinc-900 dark:text-zinc-100">{g.control_title}</span>
                <span className="text-zinc-600 dark:text-zinc-400">{GAP_WORDS[g.gap_kind] ?? 'Needs attention'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            The ranked list of what to fix first appears after the nightly check has run.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Expiring soon</h2>
        {d.expiring_evidence.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No uploaded evidence expires in the next few weeks.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4">
            {d.expiring_evidence.map((e) => (
              <li key={e.id} className="flex justify-between gap-4 py-2 text-sm">
                <span className="text-zinc-900 dark:text-zinc-100">
                  {e.title}
                  {e.owner_name ? <span className="text-zinc-500"> ({e.owner_name})</span> : null}
                </span>
                <span className="text-amber-700 dark:text-amber-400">{expiresText(e.days_left)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.not_applicable.length > 0 && (
        <p className="text-xs text-zinc-500">
          {d.not_applicable.length} control{d.not_applicable.length === 1 ? ' does' : 's do'} not apply and {d.not_applicable.length === 1 ? 'is' : 'are'} left out of these numbers.
        </p>
      )}

      {onNavigate && (
        <div className="flex gap-3 text-sm">
          <button type="button" className="text-primary-600 hover:underline" onClick={() => onNavigate('/gaps')}>
            See everything to fix
          </button>
          <button type="button" className="text-primary-600 hover:underline" onClick={() => onNavigate('/coverage')}>
            Open the Evidence map
          </button>
          <button type="button" className="text-primary-600 hover:underline" onClick={() => onNavigate('/evidence')}>
            Open the Evidence locker
          </button>
        </div>
      )}
    </div>
  );
}
