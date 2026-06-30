import { useState } from 'react';
import { Timer, Save, Loader2, Gauge } from 'lucide-react';
import {
  useApp,
  useRetention,
  useSetRetention,
  useSetRateLimit,
  type RetentionPolicy,
  type RateLimitSpec,
} from '@/hooks/use-blip';

interface RetentionSettingsPageProps {
  appId: string;
}

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function RetentionSettingsPage({ appId }: RetentionSettingsPageProps) {
  const app = useApp(appId);
  const retention = useRetention(appId);
  const setRetention = useSetRetention(appId);
  const setRateLimit = useSetRateLimit(appId);

  // App-wide default retention policy (report_type === null)
  const appDefault: RetentionPolicy | undefined = retention.data?.data.find((p) => !p.report_type);

  const [maxAgeDays, setMaxAgeDays] = useState('');
  const [maxRows, setMaxRows] = useState('');
  const [maxBytes, setMaxBytes] = useState('');
  const [retentionType, setRetentionType] = useState('');
  const [savedR, setSavedR] = useState(false);

  // Rate limit
  const rl: RateLimitSpec = app.data?.data.default_rate_limit ?? {};
  const [refill, setRefill] = useState('');
  const [burst, setBurst] = useState('');
  const [savedRL, setSavedRL] = useState(false);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Timer className="h-6 w-6 text-primary-500" />
          Retention & rate limit
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          A new app is seeded with a 14-day app-wide retention default. Removing the age limit is an
          explicit edit, never a default.
        </p>
      </div>

      {/* Retention */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Retention policy</h2>
        {retention.isLoading ? (
          <div className="text-sm text-zinc-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <p className="text-xs text-zinc-500">
              Current app default:{' '}
              {appDefault?.max_age_days != null ? `${appDefault.max_age_days} days` : 'no age limit'}
              {appDefault?.max_rows != null ? `, ${appDefault.max_rows} rows max` : ''}
              {appDefault?.max_bytes != null ? `, ${appDefault.max_bytes} bytes max` : ''}.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Report type</label>
                <input
                  value={retentionType}
                  onChange={(e) => setRetentionType(e.target.value)}
                  placeholder="(blank = app default)"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm font-mono w-44"
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Max age (days)</label>
                <input
                  value={maxAgeDays}
                  onChange={(e) => setMaxAgeDays(e.target.value)}
                  placeholder="14"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-28"
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Max rows</label>
                <input
                  value={maxRows}
                  onChange={(e) => setMaxRows(e.target.value)}
                  placeholder="∞"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-28"
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Max bytes</label>
                <input
                  value={maxBytes}
                  onChange={(e) => setMaxBytes(e.target.value)}
                  placeholder="∞"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-32"
                />
              </div>
              <button
                type="button"
                disabled={setRetention.isPending}
                onClick={() =>
                  setRetention.mutate(
                    {
                      report_type: retentionType.trim() || null,
                      max_age_days: numOrNull(maxAgeDays),
                      max_rows: numOrNull(maxRows),
                      max_bytes: numOrNull(maxBytes),
                    },
                    {
                      onSuccess: () => {
                        setSavedR(true);
                        setTimeout(() => setSavedR(false), 2000);
                      },
                    },
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              >
                {setRetention.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {savedR ? 'Saved' : 'Save policy'}
              </button>
            </div>
          </>
        )}
      </section>

      {/* Rate limit */}
      <section className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-6">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary-500" /> App default rate limit
        </h2>
        <p className="text-xs text-zinc-500">
          Token bucket evaluated at the edge. Defaults: 256 KB body, 500 entries/batch. Current:{' '}
          {rl.refill_per_sec != null ? `${rl.refill_per_sec}/s refill` : 'unset'},{' '}
          {rl.burst != null ? `${rl.burst} burst` : 'unset burst'}.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Refill / sec</label>
            <input
              value={refill}
              onChange={(e) => setRefill(e.target.value)}
              placeholder={String(rl.refill_per_sec ?? '')}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-28"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-zinc-500 mb-1">Burst</label>
            <input
              value={burst}
              onChange={(e) => setBurst(e.target.value)}
              placeholder={String(rl.burst ?? '')}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-28"
            />
          </div>
          <button
            type="button"
            disabled={setRateLimit.isPending}
            onClick={() =>
              setRateLimit.mutate(
                {
                  ...rl,
                  refill_per_sec: numOrNull(refill) ?? rl.refill_per_sec,
                  burst: numOrNull(burst) ?? rl.burst,
                },
                {
                  onSuccess: () => {
                    setSavedRL(true);
                    setTimeout(() => setSavedRL(false), 2000);
                  },
                },
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {setRateLimit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {savedRL ? 'Saved' : 'Save rate limit'}
          </button>
        </div>
      </section>
    </div>
  );
}
