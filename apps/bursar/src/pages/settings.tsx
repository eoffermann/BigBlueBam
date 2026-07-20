import { useEffect, useState } from 'react';
import { SlidersHorizontal, Lock } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BursarSettingsUpdate } from '@bigbluebam/shared';
import { PageHeader, Card, LoadingState, ErrorState, Btn, Pill } from '@/components/primitives';
import { useSettings, useUpdateSettings, useLibrary } from '@/hooks/use-bursar';
import type { OrgSettingsRow } from '@/lib/api';
import { num } from '@/lib/utils';

type Form = Partial<Record<keyof OrgSettingsRow, unknown>>;

export function SettingsPage() {
  const canWrite = useCan('bursar.settings.write');
  const { data, isLoading, isError } = useSettings();
  const update = useUpdateSettings();
  const [form, setForm] = useState<Form>({});

  useEffect(() => {
    if (data?.data) setForm(data.data as Form);
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState message="Could not load settings." />;
  const s = data.data;

  const set = (k: keyof OrgSettingsRow, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const val = (k: keyof OrgSettingsRow) => (form[k] ?? s[k]) as never;

  const parseList = (v: unknown): string[] =>
    typeof v === 'string'
      ? v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)
      : Array.isArray(v)
        ? (v as string[])
        : [];

  const save = () => {
    if (!canWrite) return;
    const patch: BursarSettingsUpdate = {
      node_term_overlap_floor: num(val('node_term_overlap_floor')),
      evidence_concentration_floor: num(val('evidence_concentration_floor')),
      blanket_fanout_cap: num(val('blanket_fanout_cap')),
      blanket_cumulative_cap: num(val('blanket_cumulative_cap')),
      parse_quality_floor: num(val('parse_quality_floor')),
      payee_match_threshold: num(val('payee_match_threshold')),
      payee_auto_accept_threshold: num(val('payee_auto_accept_threshold')),
      price_drift_threshold_pct: num(val('price_drift_threshold_pct')),
      max_offers_per_run: num(val('max_offers_per_run')),
      max_llm_calls_per_run: num(val('max_llm_calls_per_run')),
      max_nodes_per_run: num(val('max_nodes_per_run')),
      max_lines_per_window: num(val('max_lines_per_window')),
      window_overlap_lines: num(val('window_overlap_lines')),
      retention_days: num(val('retention_days')),
      digest_day: num(val('digest_day')),
      digest_hour: num(val('digest_hour')),
      blanket_lexicon: parseList(form.blanket_lexicon ?? s.blanket_lexicon),
      exclusion_lexicon: parseList(form.exclusion_lexicon ?? s.exclusion_lexicon),
      renewal_lead_bands: parseList(form.renewal_lead_bands ?? s.renewal_lead_bands),
    };
    update.mutate(patch);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Detector thresholds, run caps, lexicons, and the scope library. Weakening a weight is audited with a before/after diff."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={save} disabled={update.isPending}>
              <SlidersHorizontal className="h-4 w-4" /> Save
            </Btn>
          ) : undefined
        }
      />

      <Card className="p-5 space-y-4 mb-6">
        <SectionTitle>Thresholds and weights</SectionTitle>
        <NumberRow label="Node term overlap floor" hint="Minimum term overlap for a line to match a node (spec 3.5). Band 0 to 1." step={0.01} value={num(val('node_term_overlap_floor'))} onChange={(v) => set('node_term_overlap_floor', v)} disabled={!canWrite} />
        <NumberRow label="Evidence concentration floor" hint="Below this, matches too concentrated on one line are held for review. Band 0 to 1." step={0.01} value={num(val('evidence_concentration_floor'))} onChange={(v) => set('evidence_concentration_floor', v)} disabled={!canWrite} />
        <NumberRow label="Blanket fanout cap" hint="Max distinct nodes one blanket line may cover before the cap withholds the rest." step={1} value={num(val('blanket_fanout_cap'))} onChange={(v) => set('blanket_fanout_cap', v)} disabled={!canWrite} />
        <NumberRow label="Blanket cumulative cap" hint="Max cumulative blanket-covered nodes per offer (the load-bearing §4.3 defense)." step={1} value={num(val('blanket_cumulative_cap'))} onChange={(v) => set('blanket_cumulative_cap', v)} disabled={!canWrite} />
        <NumberRow label="Parse quality floor" hint="Below this parse quality an offer cannot produce an absent verdict. Band 0 to 1." step={0.01} value={num(val('parse_quality_floor'))} onChange={(v) => set('parse_quality_floor', v)} disabled={!canWrite} />
        <NumberRow label="Payee match threshold" hint="Below this a payee string is not linked. Band 0 to 1." step={0.01} value={num(val('payee_match_threshold'))} onChange={(v) => set('payee_match_threshold', v)} disabled={!canWrite} />
        <NumberRow label="Payee auto-accept threshold" hint="At or above this a payee link is auto-accepted; between the two it is queued for review." step={0.01} value={num(val('payee_auto_accept_threshold'))} onChange={(v) => set('payee_auto_accept_threshold', v)} disabled={!canWrite} />
        <NumberRow label="Price drift threshold (%)" hint="Spend above the baseline by more than this raises a drift finding." step={1} value={num(val('price_drift_threshold_pct'))} onChange={(v) => set('price_drift_threshold_pct', v)} disabled={!canWrite} />
      </Card>

      <Card className="p-5 space-y-4 mb-6">
        <SectionTitle>Run caps</SectionTitle>
        <NumberRow label="Max offers per run" step={1} value={num(val('max_offers_per_run'))} onChange={(v) => set('max_offers_per_run', v)} disabled={!canWrite} />
        <NumberRow label="Max LLM calls per run" step={1} value={num(val('max_llm_calls_per_run'))} onChange={(v) => set('max_llm_calls_per_run', v)} disabled={!canWrite} />
        <NumberRow label="Max nodes per run" step={1} value={num(val('max_nodes_per_run'))} onChange={(v) => set('max_nodes_per_run', v)} disabled={!canWrite} />
        <NumberRow label="Max lines per window" step={1} value={num(val('max_lines_per_window'))} onChange={(v) => set('max_lines_per_window', v)} disabled={!canWrite} />
        <NumberRow label="Window overlap lines" step={1} value={num(val('window_overlap_lines'))} onChange={(v) => set('window_overlap_lines', v)} disabled={!canWrite} />
        <NumberRow label="Retention (days)" step={1} value={num(val('retention_days'))} onChange={(v) => set('retention_days', v)} disabled={!canWrite} />
      </Card>

      <Card className="p-5 space-y-4 mb-6">
        <SectionTitle>Lexicons</SectionTitle>
        <ListRow label="Blanket lexicon" hint="Phrases that signal a blanket coverage claim. One per line or comma-separated." value={form.blanket_lexicon ?? s.blanket_lexicon} onChange={(v) => set('blanket_lexicon', v)} disabled={!canWrite} />
        <ListRow label="Exclusion lexicon" hint="Phrases that signal an explicit exclusion." value={form.exclusion_lexicon ?? s.exclusion_lexicon} onChange={(v) => set('exclusion_lexicon', v)} disabled={!canWrite} />
        <ListRow label="Renewal lead bands" hint="Named lead-time bands for the renewal radar, e.g. 90d, 30d, 7d." value={form.renewal_lead_bands ?? s.renewal_lead_bands} onChange={(v) => set('renewal_lead_bands', v)} disabled={!canWrite} />
      </Card>

      <LibrarySection />

      {update.isError && <p className="mt-3 text-sm text-red-500">Could not save settings.</p>}
      {update.isSuccess && <p className="mt-3 text-sm text-emerald-500">Settings saved.</p>}
      {!canWrite && <p className="mt-3 text-xs text-zinc-400">Owner/admin only; you are viewing read-only.</p>}
    </div>
  );
}

function LibrarySection() {
  const library = useLibrary();
  return (
    <Card className="p-5 space-y-3">
      <SectionTitle>Scope library</SectionTitle>
      <p className="text-xs text-zinc-400">
        Reusable scope entries. Global built-in rows are read-only; your org's own entries can be edited.
      </p>
      {library.isLoading ? (
        <div className="py-4 text-center text-xs text-zinc-400">Loading...</div>
      ) : library.isError || (library.data?.data.length ?? 0) === 0 ? (
        <p className="text-xs text-zinc-400 py-2">No library entries yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {library.data!.data.map((row) => (
            <li key={row.id} className="py-2 flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-zinc-800 dark:text-zinc-100">{row.title}</div>
                {row.description && <div className="text-xs text-zinc-400 truncate">{row.description}</div>}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Pill tone="zinc">{row.normative_strength}</Pill>
                {row.is_global && (
                  <Pill tone="sky" testId="library-global-readonly">
                    <Lock className="h-3 w-3 mr-0.5" /> global (read-only)
                  </Pill>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{children}</div>;
}

function NumberRow({
  label,
  hint,
  value,
  onChange,
  step,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
        {hint && <div className="text-xs text-zinc-400">{hint}</div>}
      </div>
      <input
        type="number"
        value={value}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm disabled:opacity-60"
      />
    </div>
  );
}

function ListRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: unknown;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? (value as string[]).join('\n') : '';
  return (
    <div>
      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
      {hint && <div className="text-xs text-zinc-400 mb-1">{hint}</div>}
      <textarea
        value={text}
        rows={3}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm disabled:opacity-60"
      />
    </div>
  );
}
