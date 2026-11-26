import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BastionRestoreResolution, BastionSettingsUpdate } from '@bigbluebam/shared';
import { friendlyError } from '@/lib/errors';
import type { SettingsView } from '@/lib/api';
import { useAcknowledgeRestore, useDeliveryProblems, useRetryDelivery, useSettings, useUpdateSettings } from '@/hooks/use-bastion';

// Settings (spec 6.1): how Bastion checks, files fixes and shares; Delivery problems (updates
// Bastion could not deliver to other apps, with Try again); Evidence integrity (restores waiting
// for an owner, key fingerprints, the off-site evidence backup). Save sends only what changed.

const MB = 1024 * 1024;
const RESTORE_NOTE = 'You are viewing Bastion as another person. Only that person can resolve a gap in the evidence history.';

const MIRROR_WORDS: Record<string, string> = {
  completed: 'Copied',
  partial: 'Partly copied, continues after the next backup',
  failed: 'The last copy failed',
  not_configured: 'Not set up',
  running: 'Copying now',
};

type Form = SettingsView['settings'];

const input = 'mt-1 block w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm';
const card = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3';
const secondary = 'px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50';

/** Only the fields that differ from what the server sent (PATCH body). */
export function changedFields(before: Form, after: Form): BastionSettingsUpdate {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as Array<keyof Form>) {
    if (after[k] !== before[k]) out[k] = after[k];
  }
  return out as BastionSettingsUpdate;
}

function NumberField({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label className="block text-sm">
      {label}
      <input type="number" className={input} value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function SettingsForm({ view }: { view: SettingsView }) {
  const canWrite = useCan('bastion.settings.write');
  const update = useUpdateSettings();
  const [form, setForm] = useState<Form>(view.settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(view.settings), [view.settings]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const diff = changedFields(view.settings, form);
  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        if (Object.keys(diff).length === 0) return;
        update.mutate(diff, { onSuccess: () => setSaved(true) });
      }}
    >
      <div className="text-sm">
        <span className="font-medium">Compliance project: </span>
        {view.compliance_project ? (view.compliance_project.name ?? 'Set') : 'Not chosen yet'}.{' '}
        <a className="text-primary-700 dark:text-primary-300 hover:underline" href="/bastion/setup">
          Change it in Setup
        </a>
      </div>
      <fieldset className="text-sm space-y-1" disabled={!canWrite}>
        <legend className="font-medium">When fixes are needed</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="remediation" checked={form.remediation_tasks === 'create'} onChange={() => set('remediation_tasks', 'create')} />
          Create tasks
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="remediation" checked={form.remediation_tasks === 'propose'} onChange={() => set('remediation_tasks', 'propose')} />
          Only propose
        </label>
      </fieldset>
      <fieldset className="grid sm:grid-cols-2 gap-3" disabled={!canWrite}>
        <NumberField label="Check time (hour of the day, 0 to 23)" value={form.evaluation_hour_local} min={0} max={23} onChange={(n) => set('evaluation_hour_local', n)} />
        <label className="block text-sm">
          Timezone
          <input className={input} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
        </label>
        <label className="block text-sm">
          AI provider
          <select className={input} value={form.llm_provider_id ?? ''} onChange={(e) => set('llm_provider_id', e.target.value || null)}>
            <option value="">Use the default</option>
            {view.ai_providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Warn me before evidence expires (days)" value={form.manual_expiry_warn_days} min={1} max={365} onChange={(n) => set('manual_expiry_warn_days', n)} />
        <NumberField label="Treat checks as stale after (hours)" value={form.stale_after_hours} min={12} max={168} onChange={(n) => set('stale_after_hours', n)} />
        <NumberField label="Not assessed grace (days)" value={form.not_assessed_grace_days} min={0} max={90} onChange={(n) => set('not_assessed_grace_days', n)} />
        <NumberField label="Auditor links last at most (days)" value={form.auditor_room_max_days} min={1} max={180} onChange={(n) => set('auditor_room_max_days', n)} />
        <NumberField label="Largest audit packet (MB)" value={Math.round(form.max_packet_bytes / MB)} min={10} max={10240} onChange={(n) => set('max_packet_bytes', n * MB)} />
        <NumberField label={'Questionnaire "Sure" floor'} value={form.questionnaire_high_floor} min={0.5} max={0.99} step={0.01} onChange={(n) => set('questionnaire_high_floor', n)} />
        <NumberField label={'Questionnaire "Check this" floor'} value={form.questionnaire_medium_floor} min={0.1} max={0.95} step={0.01} onChange={(n) => set('questionnaire_medium_floor', n)} />
        <NumberField label="Most rows in one questionnaire" value={form.max_rows_per_questionnaire} min={10} max={5000} onChange={(n) => set('max_rows_per_questionnaire', n)} />
        <NumberField label="Most AI calls for one compile" value={form.max_llm_calls_per_compile} min={0} max={5000} onChange={(n) => set('max_llm_calls_per_compile', n)} />
        <NumberField label="Most AI calls for one questionnaire" value={form.max_llm_calls_per_questionnaire} min={0} max={10000} onChange={(n) => set('max_llm_calls_per_questionnaire', n)} />
      </fieldset>
      {update.error && <p className="text-sm text-red-600">{friendlyError(update.error)}</p>}
      {saved && <p className="text-sm text-green-700">Saved.</p>}
      {canWrite && (
        <button type="submit" className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50" disabled={Object.keys(diff).length === 0 || update.isPending}>
          Save settings
        </button>
      )}
    </form>
  );
}

function DeliveryProblems() {
  const canWrite = useCan('bastion.settings.write');
  const problems = useDeliveryProblems(canWrite);
  const retry = useRetryDelivery();
  const [message, setMessage] = useState<string | null>(null);
  if (!canWrite) return null;
  const rows = problems.data?.data ?? [];
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Delivery problems</h2>
      <p className="text-xs text-zinc-500">Updates Bastion could not deliver to other apps after many tries.</p>
      {rows.length === 0 && <p className="text-sm text-zinc-500">Everything was delivered.</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((p) => (
          <li key={p.id} className="py-2 text-sm space-y-1">
            <div className="flex items-center justify-between gap-3">
              <p>
                {p.what}, {new Date(p.created_at).toLocaleString()}. Tried {p.attempts} {p.attempts === 1 ? 'time' : 'times'}.
              </p>
              <button type="button" className={secondary} disabled={retry.isPending} onClick={() => retry.mutate(p.id, { onSuccess: (r) => setMessage(r.data.message) })}>
                Try again
              </button>
            </div>
            {p.last_error && (
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer">Technical details</summary>
                {p.event ? <p>Event: {p.event}</p> : null}
                <p>{p.last_error}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
      {message && <p className="text-sm text-green-700">{message}</p>}
      {retry.error && <p className="text-sm text-red-600">{friendlyError(retry.error)}</p>}
    </section>
  );
}

function EvidenceIntegrity({ view }: { view: SettingsView }) {
  const canAck = useCan('bastion.ledger.acknowledge_restore');
  const impersonating = getImpersonation() !== null;
  const ack = useAcknowledgeRestore();
  const [confirm, setConfirm] = useState<{ id: string; resolution: BastionRestoreResolution } | null>(null);
  const restores = view.evidence_integrity.restores_awaiting;
  const backup = view.offsite_backup;
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Evidence integrity</h2>
      {restores.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No gaps in the evidence history are waiting for you.</p>
      ) : (
        <ul className="space-y-2">
          {restores.map((r) => (
            <li key={r.id} className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-2">
              <p>
                {r.status === 'pending_ack'
                  ? 'The database was restored from a backup, so some evidence history was lost.'
                  : 'Some evidence history is missing and no restore explains it.'}{' '}
                Found {new Date(r.detected_at).toLocaleString()}
                {r.lost_from_seq != null && r.lost_to_seq != null ? `, entries ${r.lost_from_seq} to ${r.lost_to_seq}` : ''}. New evidence is paused until an owner looks at this.
              </p>
              {canAck && (
                <div className="flex gap-2">
                  {r.status === 'pending_ack' ? (
                    <button type="button" className={secondary} disabled={impersonating} title={impersonating ? RESTORE_NOTE : undefined} onClick={() => setConfirm({ id: r.id, resolution: 'restore_acknowledged' })}>
                      Acknowledge restore
                    </button>
                  ) : (
                    <button type="button" className={secondary} disabled={impersonating} title={impersonating ? RESTORE_NOTE : undefined} onClick={() => setConfirm({ id: r.id, resolution: 'continue_unexplained' })}>
                      Continue without an explanation
                    </button>
                  )}
                </div>
              )}
              {confirm?.id === r.id && (
                <section aria-label="Confirm" className="space-y-2">
                  <p>
                    {confirm.resolution === 'restore_acknowledged'
                      ? 'Record that this history was lost by a restore? Auditors will see "History lost by restore" for these entries.'
                      : 'Continue recording without an explanation? Auditors will always see "Unexplained gap" for these entries.'}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white disabled:opacity-50" disabled={ack.isPending} onClick={() => ack.mutate(confirm, { onSuccess: () => setConfirm(null) })}>
                      Yes, continue
                    </button>
                    <button type="button" className={secondary} onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </div>
                </section>
              )}
            </li>
          ))}
        </ul>
      )}
      {impersonating && restores.length > 0 && <p className="text-xs text-amber-700">{RESTORE_NOTE}</p>}
      {ack.error && <p className="text-sm text-red-600">{friendlyError(ack.error)}</p>}
      <div className="text-sm space-y-1">
        <p className="font-medium">Off-site evidence backup</p>
        <p>
          {backup.configured ? 'Set up.' : 'Not set up. Ask whoever runs this installation to add one.'}
          {backup.last_backup_at ? ` Last database backup ${new Date(backup.last_backup_at).toLocaleString()}.` : ' No database backup yet.'}
          {backup.last_mirror_status ? ` Evidence copy: ${MIRROR_WORDS[backup.last_mirror_status] ?? backup.last_mirror_status}.` : ''}
        </p>
      </div>
      <details className="text-xs text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer">Technical details: key fingerprints</summary>
        <ul className="mt-1 font-mono">
          {view.evidence_integrity.seal_keys.map((k) => (
            <li key={k.fingerprint}>
              Seal signing key {k.fingerprint}
              {k.current ? ' (current)' : ' (retired)'}
            </li>
          ))}
          <li>Personal-data key {view.evidence_integrity.personal_data_key}</li>
        </ul>
      </details>
    </section>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isLoading) return <Loader2 className="m-6 h-6 w-6 animate-spin text-zinc-400" />;
  if (settings.error) return <p className="m-6 text-sm text-amber-700">{friendlyError(settings.error)}</p>;
  const view = settings.data?.data;
  if (!view) return null;
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">How Bastion checks your controls, files fixes and shares evidence.</p>
      </div>
      <SettingsForm view={view} />
      <DeliveryProblems />
      <EvidenceIntegrity view={view} />
    </div>
  );
}
