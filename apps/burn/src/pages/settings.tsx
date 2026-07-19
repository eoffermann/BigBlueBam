import { useEffect, useState } from 'react';
import { SlidersHorizontal, Wand2, ChevronRight } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { useSettings, useUpdateSettings, type OrgSettings } from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, Btn } from '@/components/primitives';

interface Props {
  onNavigate: (path: string) => void;
}

// Bands mirror the DB CHECKs (spec 2.3.6 / 7.7).
const num = (s: string | number | null | undefined, fallback = 0): number => {
  if (s == null) return fallback;
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isNaN(n) ? fallback : n;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function SettingsPage({ onNavigate }: Props) {
  const canWrite = useCan('burn.settings.write');
  const { data, isLoading, isError } = useSettings();
  const update = useUpdateSettings();

  const [form, setForm] = useState<Partial<OrgSettings>>({});
  useEffect(() => {
    if (data?.data) setForm(data.data);
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState message="Could not load settings." />;

  const s = data.data;
  const autoAttr = num(form.auto_attribute_threshold, num(s.auto_attribute_threshold, 0.9));

  const save = () => {
    if (!canWrite) return;
    update.mutate({
      auto_attribute_threshold: clamp(num(form.auto_attribute_threshold, autoAttr), 0.75, 0.99),
      review_threshold: clamp(num(form.review_threshold, num(s.review_threshold)), 0.3, autoAttr - 0.05),
      pending_review_max_age_days: num(form.pending_review_max_age_days, s.pending_review_max_age_days),
      reconcile_window_days: num(form.reconcile_window_days, s.reconcile_window_days),
      overage_bucket_amount: num(form.overage_bucket_amount, s.overage_bucket_amount),
      min_contributors_for_cost_aggregate: num(
        form.min_contributors_for_cost_aggregate,
        s.min_contributors_for_cost_aggregate,
      ),
      match_ceiling_pct: num(form.match_ceiling_pct, num(s.match_ceiling_pct)),
      embedding_enabled: form.embedding_enabled ?? s.embedding_enabled,
      banter_signal_enabled: form.banter_signal_enabled ?? s.banter_signal_enabled,
      vcs_signal_enabled: form.vcs_signal_enabled ?? s.vcs_signal_enabled,
    });
  };

  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Attribution thresholds and signals. Values are clamped to the same bands the database enforces."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={save} disabled={update.isPending}>
              <SlidersHorizontal className="h-4 w-4" /> Save
            </Btn>
          ) : undefined
        }
      />

      {/* Rules editor link */}
      <button onClick={() => onNavigate('/settings/rules')} className="w-full text-left mb-6">
        <Card className="p-4 flex items-center gap-3 hover:border-primary-300 dark:hover:border-primary-700 transition-colors">
          <Wand2 className="h-5 w-5 text-primary-500" />
          <div className="flex-1">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Attribution rules</div>
            <div className="text-xs text-zinc-400">
              Deterministic rules that run before any LLM call. Owner/admin authoring.
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-zinc-400" />
        </Card>
      </button>

      <Card className="p-5 space-y-5">
        <NumberRow
          label="Auto-attribute threshold"
          hint="At or above this confidence, attribution is applied autonomously. Band 0.75–0.99."
          value={autoAttr}
          step={0.01}
          min={0.75}
          max={0.99}
          disabled={!canWrite}
          onChange={(v) => set('auto_attribute_threshold', v as never)}
        />
        <NumberRow
          label="Review threshold"
          hint={`Below auto-attribute and at or above this, the item is queued for a human. Band 0.30–${(autoAttr - 0.05).toFixed(2)}.`}
          value={num(form.review_threshold, num(s.review_threshold))}
          step={0.01}
          min={0.3}
          max={autoAttr - 0.05}
          disabled={!canWrite}
          onChange={(v) => set('review_threshold', v as never)}
        />
        <NumberRow
          label="Pending review max age (days)"
          hint="A pending-review item older than this ages out of the queue."
          value={num(form.pending_review_max_age_days, s.pending_review_max_age_days)}
          step={1}
          min={1}
          disabled={!canWrite}
          onChange={(v) => set('pending_review_max_age_days', v as never)}
        />
        <NumberRow
          label="Reconcile window (days)"
          hint="How long after ingest a work item is re-read for edits and deletes."
          value={num(form.reconcile_window_days, s.reconcile_window_days)}
          step={1}
          min={1}
          disabled={!canWrite}
          onChange={(v) => set('reconcile_window_days', v as never)}
        />
        <NumberRow
          label="Overage bucket (minor units)"
          hint="Overage shown to non-financial callers is quantized up to this bucket, so probing cannot recover the exact envelope."
          value={num(form.overage_bucket_amount, s.overage_bucket_amount)}
          step={1000}
          min={1}
          disabled={!canWrite}
          onChange={(v) => set('overage_bucket_amount', v as never)}
        />
        <NumberRow
          label="Min contributors for cost aggregate"
          hint="Below this many contributors, cost and margin are suppressed so an individual rate cannot be reverse-solved."
          value={num(form.min_contributors_for_cost_aggregate, s.min_contributors_for_cost_aggregate)}
          step={1}
          min={1}
          max={100}
          disabled={!canWrite}
          onChange={(v) => set('min_contributors_for_cost_aggregate', v as never)}
        />
        <NumberRow
          label="Rule match ceiling (%)"
          hint="A rule that would match more than this fraction of the trailing window is rejected at write time."
          value={num(form.match_ceiling_pct, num(s.match_ceiling_pct))}
          step={1}
          min={0}
          max={100}
          disabled={!canWrite}
          onChange={(v) => set('match_ceiling_pct', v as never)}
        />

        <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
          <ToggleRow
            label="Embedding retrieval (Qdrant)"
            hint="Off by default; there is no working embedding provider in the tree today. Lexical retrieval is the shipped path."
            checked={form.embedding_enabled ?? s.embedding_enabled}
            disabled={!canWrite}
            onChange={(v) => set('embedding_enabled', v as never)}
          />
          <ToggleRow
            label="Banter signal"
            hint="Opt-in: Banter threads become a classification signal (never priced)."
            checked={form.banter_signal_enabled ?? s.banter_signal_enabled}
            disabled={!canWrite}
            onChange={(v) => set('banter_signal_enabled', v as never)}
          />
          <ToggleRow
            label="VCS signal"
            hint="Opt-in: commits become a classification signal (never priced)."
            checked={form.vcs_signal_enabled ?? s.vcs_signal_enabled}
            disabled={!canWrite}
            onChange={(v) => set('vcs_signal_enabled', v as never)}
          />
        </div>
      </Card>

      {update.isError && <p className="mt-3 text-sm text-red-500">Could not save settings.</p>}
      {update.isSuccess && <p className="mt-3 text-sm text-emerald-500">Settings saved.</p>}
      {!canWrite && <p className="mt-3 text-xs text-zinc-400">Owner/admin only; you are viewing read-only.</p>}
    </div>
  );
}

function NumberRow({
  label,
  hint,
  value,
  onChange,
  step,
  min,
  max,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
        <div className="text-xs text-zinc-400">{hint}</div>
      </div>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm disabled:opacity-60"
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
        <div className="text-xs text-zinc-400">{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 shrink-0"
      />
    </label>
  );
}
