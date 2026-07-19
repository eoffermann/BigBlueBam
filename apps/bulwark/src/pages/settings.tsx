import { useEffect, useState } from 'react';
import { Loader2, Save, Settings as SettingsIcon, Lock } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { useSettings, useUpdateSettings, type UpdateSettingsInput } from '@/hooks/use-bulwark';
import { formatRelativeTime } from '@/lib/utils';

function numOr(v: string, fallback: number): number {
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : fallback;
}

export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const canWrite = useCan('bulwark.settings.write');

  const [tz, setTz] = useState('UTC');
  const [autoConfirm, setAutoConfirm] = useState('0.95');
  const [critical, setCritical] = useState('24');
  const [high, setHigh] = useState('72');
  const [medium, setMedium] = useState('168');
  const [autoDraft, setAutoDraft] = useState(false);
  const [autoDraftMax, setAutoDraftMax] = useState('20');
  const [llmDailyCap, setLlmDailyCap] = useState('100');
  const [chaseCadence, setChaseCadence] = useState('7');
  const [coiLead, setCoiLead] = useState('30');
  const [dischargeRetention, setDischargeRetention] = useState('365');
  const [inboxRetention, setInboxRetention] = useState('400');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = settings.data?.data;
    if (!s) return;
    setTz(s.default_timezone);
    setAutoConfirm(String(s.auto_confirm_threshold));
    setCritical(String(s.radar_lead_times.critical_hours));
    setHigh(String(s.radar_lead_times.high_hours));
    setMedium(String(s.radar_lead_times.medium_hours));
    setAutoDraft(s.auto_draft_notices);
    setAutoDraftMax(String(s.auto_draft_max_per_sweep));
    setLlmDailyCap(String(s.notice_llm_daily_cap));
    setChaseCadence(String(s.chase_cadence_days));
    setCoiLead(String(s.coi_expiry_lead_days));
    setDischargeRetention(String(s.discharged_deadline_retention_days));
    setInboxRetention(String(s.inbox_retention_days));
  }, [settings.data]);

  if (settings.isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
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
  const inputCls =
    'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm disabled:opacity-60';

  function save() {
    const input: UpdateSettingsInput = {
      default_timezone: tz.trim() || 'UTC',
      auto_confirm_threshold: numOr(autoConfirm, 0.95),
      radar_lead_times: {
        critical_hours: numOr(critical, 24),
        high_hours: numOr(high, 72),
        medium_hours: numOr(medium, 168),
      },
      auto_draft_notices: autoDraft,
      auto_draft_max_per_sweep: numOr(autoDraftMax, 20),
      notice_llm_daily_cap: numOr(llmDailyCap, 100),
      chase_cadence_days: numOr(chaseCadence, 7),
      coi_expiry_lead_days: numOr(coiLead, 30),
      discharged_deadline_retention_days: numOr(dischargeRetention, 365),
      inbox_retention_days: numOr(inboxRetention, 400),
    };
    update.mutate(input, {
      onSuccess: () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      },
    });
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-primary-500" />
          Settings
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Org-wide tunables for extraction, the radar, drafting caps, and retention.
        </p>
        {s?.last_radar_sweep_at && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
            Last radar sweep {formatRelativeTime(s.last_radar_sweep_at)}.
          </p>
        )}
        {!canWrite && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5" />
            These settings are read-only for your role. Owner or admin can change them.
          </p>
        )}
      </div>

      <Section title="Extraction and timezone">
        <Field label="Default timezone (IANA)">
          <input value={tz} onChange={(e) => setTz(e.target.value)} disabled={!canWrite} className={`${inputCls} w-56`} />
        </Field>
        <Field
          label="Auto-confirm threshold (0-1)"
          hint="Display-only auto-confirm floor. Never arms a claim-or-money-waiving obligation on model confidence alone."
        >
          <input value={autoConfirm} onChange={(e) => setAutoConfirm(e.target.value)} disabled={!canWrite} className={`${inputCls} w-28`} />
        </Field>
      </Section>

      <Section title="Radar lead times (hours)">
        <div className="flex flex-wrap gap-4">
          <Field label="Critical">
            <input value={critical} onChange={(e) => setCritical(e.target.value)} disabled={!canWrite} className={`${inputCls} w-24`} />
          </Field>
          <Field label="High">
            <input value={high} onChange={(e) => setHigh(e.target.value)} disabled={!canWrite} className={`${inputCls} w-24`} />
          </Field>
          <Field label="Medium">
            <input value={medium} onChange={(e) => setMedium(e.target.value)} disabled={!canWrite} className={`${inputCls} w-24`} />
          </Field>
        </div>
      </Section>

      <Section title="Notice drafting">
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={autoDraft}
            onChange={(e) => setAutoDraft(e.target.checked)}
            disabled={!canWrite}
            className="h-4 w-4"
          />
          Auto-draft notices during radar sweeps (off by default)
        </label>
        <div className="flex flex-wrap gap-4">
          <Field label="Max auto-drafts per sweep">
            <input value={autoDraftMax} onChange={(e) => setAutoDraftMax(e.target.value)} disabled={!canWrite} className={`${inputCls} w-28`} />
          </Field>
          <Field label="Notice LLM daily cap">
            <input value={llmDailyCap} onChange={(e) => setLlmDailyCap(e.target.value)} disabled={!canWrite} className={`${inputCls} w-28`} />
          </Field>
        </div>
      </Section>

      <Section title="Compliance and retention">
        <div className="flex flex-wrap gap-4">
          <Field label="Chase cadence (days)">
            <input value={chaseCadence} onChange={(e) => setChaseCadence(e.target.value)} disabled={!canWrite} className={`${inputCls} w-28`} />
          </Field>
          <Field label="COI expiry lead (days)">
            <input value={coiLead} onChange={(e) => setCoiLead(e.target.value)} disabled={!canWrite} className={`${inputCls} w-28`} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Discharged deadline retention (days)">
            <input
              value={dischargeRetention}
              onChange={(e) => setDischargeRetention(e.target.value)}
              disabled={!canWrite}
              className={`${inputCls} w-32`}
            />
          </Field>
          <Field label="Inbox retention (days)" hint="Must be at least the discharged-deadline retention, so a late redelivery cannot re-arm.">
            <input
              value={inboxRetention}
              onChange={(e) => setInboxRetention(e.target.value)}
              disabled={!canWrite}
              className={`${inputCls} w-32`}
            />
          </Field>
        </div>
      </Section>

      {canWrite && (
        <div className="pt-2">
          <button
            type="button"
            disabled={update.isPending}
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saved ? 'Saved' : 'Save settings'}
          </button>
          {update.isError && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-2">
              {update.error instanceof Error ? update.error.message : 'Could not save settings.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-6 first:border-t-0 first:pt-0">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-zinc-500">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-zinc-400 max-w-sm">{hint}</p>}
    </div>
  );
}
