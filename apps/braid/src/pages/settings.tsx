import { useEffect, useState } from 'react';
import { Loader2, Save, Settings as SettingsIcon } from 'lucide-react';
import { useSettings, useUpdateSettings, BRAID_SOURCE_TYPES } from '@/hooks/use-braid';
import type { BraidSourceType } from '@bigbluebam/shared';
import { formatRelativeTime } from '@/lib/utils';

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function SettingsPage() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  const [autoMergeThreshold, setAutoMergeThreshold] = useState('0.9');
  const [reviewThreshold, setReviewThreshold] = useState('0.7');
  const [requireStrongSignal, setRequireStrongSignal] = useState(true);
  const [enabledSources, setEnabledSources] = useState<Set<BraidSourceType>>(new Set());
  const [rescanMaxAgeDays, setRescanMaxAgeDays] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = settings.data?.data;
    if (!s) return;
    setAutoMergeThreshold(String(s.auto_merge_threshold));
    setReviewThreshold(String(s.review_threshold));
    setRequireStrongSignal(s.require_strong_signal_for_auto);
    setEnabledSources(new Set(s.enabled_source_types));
    setRescanMaxAgeDays(s.rescan_max_age_days != null ? String(s.rescan_max_age_days) : '');
  }, [settings.data]);

  function toggleSource(src: BraidSourceType) {
    setEnabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });
  }

  if (settings.isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  if (settings.isError) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load settings</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {settings.error instanceof Error ? settings.error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      </div>
    );
  }

  const s = settings.data?.data;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-primary-500" />
          Settings
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Tune the auto-merge / review-queue split and control which source types Braid resolves.
        </p>
        {s?.last_rescan_at && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
            Last full rescan {formatRelativeTime(s.last_rescan_at)}.
          </p>
        )}
      </div>

      {/* Thresholds */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Decision thresholds</h2>
        <p className="text-xs text-zinc-500">
          Scores at or above the auto-merge threshold link automatically. Scores between the review
          threshold and the auto-merge threshold are queued for human review. Lower scores are ignored.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Auto-merge threshold (0-1)</label>
            <input
              value={autoMergeThreshold}
              onChange={(e) => setAutoMergeThreshold(e.target.value)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm w-28"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Review threshold (0-1)</label>
            <input
              value={reviewThreshold}
              onChange={(e) => setReviewThreshold(e.target.value)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm w-28"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={requireStrongSignal}
            onChange={(e) => setRequireStrongSignal(e.target.checked)}
            className="h-4 w-4"
          />
          Require at least one strong signal for auto-merge
        </label>
      </section>

      {/* Enabled source types */}
      <section className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-6">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Enabled source types</h2>
        <p className="text-xs text-zinc-500">
          Only source records from an enabled type are ingested and resolved into golden profiles.
        </p>
        <div className="flex flex-wrap gap-2">
          {BRAID_SOURCE_TYPES.map((src) => (
            <label
              key={src}
              className="inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 text-zinc-700 dark:text-zinc-200"
            >
              <input
                type="checkbox"
                checked={enabledSources.has(src)}
                onChange={() => toggleSource(src)}
                className="h-4 w-4"
              />
              <span className="font-mono">{src}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Rescan cadence */}
      <section className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-6">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Rescan cadence</h2>
        <p className="text-xs text-zinc-500">
          The nightly rescan diffs each enabled source table directly, so the live event path can drop
          without producing a stale blind spot. Leave blank for the default cadence.
        </p>
        <div className="flex flex-col w-40">
          <label className="text-xs text-zinc-500 mb-1">Max rescan age (days)</label>
          <input
            value={rescanMaxAgeDays}
            onChange={(e) => setRescanMaxAgeDays(e.target.value)}
            placeholder="default"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm"
          />
        </div>
      </section>

      <div className="pt-2">
        <button
          type="button"
          disabled={updateSettings.isPending}
          onClick={() =>
            updateSettings.mutate(
              {
                auto_merge_threshold: numOrNull(autoMergeThreshold) ?? undefined,
                review_threshold: numOrNull(reviewThreshold) ?? undefined,
                require_strong_signal_for_auto: requireStrongSignal,
                enabled_source_types: Array.from(enabledSources),
                rescan_max_age_days: numOrNull(rescanMaxAgeDays),
              },
              {
                onSuccess: () => {
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                },
              },
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved' : 'Save settings'}
        </button>
        {updateSettings.isError && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-2">
            {updateSettings.error instanceof Error ? updateSettings.error.message : 'Could not save settings.'}
          </p>
        )}
      </div>
    </div>
  );
}
