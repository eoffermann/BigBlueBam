import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ApiError, type ControlRow } from '@/lib/api';
import { useControls, useSetup } from '@/hooks/use-bastion';

// Controls list stub (spec 6.1 /bastion/controls). M3 shows whether each control is set up; the
// effective states and evidence arrive with the evaluator (M4) and Readiness (M5).

const STATE_WORDS: Record<NonNullable<ControlRow['setup_state']>, string> = {
  set_up: 'Set up',
  not_set_up: 'Not set up yet',
  not_applicable: 'Does not apply',
};

function ControlItem({ c }: { c: ControlRow }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.title}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {c.requirements.map((r) => (
            <span
              key={r.id}
              title={r.framework_name}
              className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300"
            >
              {r.ref_code}
            </span>
          ))}
        </div>
      </div>
      <span className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">{c.setup_state ? STATE_WORDS[c.setup_state] : ''}</span>
    </li>
  );
}

export function ControlsPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [frameworkId, setFrameworkId] = useState('');
  const setup = useSetup();
  const controls = useControls({ framework_id: frameworkId || undefined });
  const frameworks = setup.data?.data.frameworks ?? [];

  if (controls.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (controls.error || !controls.data) {
    return (
      <p className="p-8 text-sm text-red-600">
        {controls.error instanceof ApiError ? controls.error.message : 'Controls could not be loaded.'}
      </p>
    );
  }
  const data = controls.data;
  const rows = data.data;
  const inScope = rows.filter((r) => r.setup_state !== 'not_applicable');
  const excluded = rows.filter((r) => r.setup_state === 'not_applicable');

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Controls</h1>
        <select
          aria-label="Framework"
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
          value={frameworkId}
          onChange={(e) => setFrameworkId(e.target.value)}
        >
          <option value="">All frameworks</option>
          {frameworks.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center space-y-3">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">Adopt a framework in Setup to see your controls.</p>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700"
            onClick={() => onNavigate('/setup')}
          >
            Go to Setup
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-6">
            <p className="text-lg text-zinc-900 dark:text-zinc-100">
              {data.counts.set_up} of {data.counts.total} controls set up
            </p>
            <p className="text-lg font-semibold text-amber-700 dark:text-amber-400" data-testid="not-set-up-count">
              Not set up yet: {data.counts.not_set_up}
            </p>
          </div>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4">
            {inScope.map((c) => (
              <ControlItem key={c.id} c={c} />
            ))}
          </ul>
          {excluded.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Does not apply ({excluded.length})</h2>
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 mt-2">
                {excluded.map((c) => (
                  <ControlItem key={c.id} c={c} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
