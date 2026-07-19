import { Check, X, ShieldAlert, PauseCircle, Power, AlertTriangle } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BurnGateMode } from '@bigbluebam/shared';
import {
  useSettings,
  useCalibration,
  usePrechecks,
  useUpdateSettings,
  useLabelPrecheck,
  useOverridePrecheck,
  type PrecheckRow,
  type CalibrationPrecondition,
} from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, Btn } from '@/components/primitives';
import { VerdictBadge, GateModeBadge } from '@/components/badges';
import { formatDateTime, formatPct, cn } from '@/lib/utils';

export function GateConsolePage() {
  const canWrite = useCan('burn.settings.write');
  const canMarkWrong = useCan('burn.precheck.mark_wrong');
  const canOverride = useCan('burn.precheck.override');
  const settings = useSettings();
  const calibration = useCalibration();
  const denies = usePrechecks({ verdict: 'deny', limit: 20 });
  const log = usePrechecks({ limit: 25 });
  const update = useUpdateSettings();

  if (settings.isLoading) return <LoadingState />;
  if (settings.isError || !settings.data) return <ErrorState message="Could not load gate settings." />;

  const s = settings.data.data;
  const cal = calibration.data?.data;
  const mode = s.gate_mode as BurnGateMode;

  const setMode = (next: BurnGateMode, acknowledge = false) => {
    if (!canWrite) return;
    // Weakening the spend control is the consequential direction; a confirm acknowledgement
    // stands in for the confirm_action token the backend requires (spec 5.6).
    if ((next === 'off' || next === 'advisory') && mode === 'blocking') {
      if (!window.confirm(`Weaken the gate to "${next}"? This stops blocking out-of-scope charges.`)) return;
    }
    update.mutate({ gate_mode: next, ...(acknowledge ? { acknowledge_blocking: true } : {}) });
  };

  const pause = () => {
    if (!canWrite) return;
    if (!window.confirm('Pause the gate for 24 hours?')) return;
    update.mutate({ gate_paused_until: new Date(Date.now() + 86_400_000).toISOString() });
  };

  const paused = s.gate_paused_until && new Date(s.gate_paused_until) > new Date();

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Gate Console"
        subtitle="The pre-transaction gate. Advisory is a complete product; blocking is earned, not switched on."
        actions={<GateModeBadge mode={mode} />}
      />

      {/* Auto-demotion banner */}
      {s.gate_demoted_at && (
        <Card className="mb-6 p-4 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
            <div className="text-sm text-amber-700 dark:text-amber-300">
              The gate was auto-demoted to a safer mode on {formatDateTime(s.gate_demoted_at)}. Re-promotion
              re-earns the calibration preconditions from that date.
            </div>
          </div>
        </Card>
      )}

      {/* Mode + kill switches */}
      <Card className="mb-6 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Gate mode</h3>
          {!canWrite && <span className="text-xs text-zinc-400">Owner/admin only</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModeButton label="Off" icon={Power} active={mode === 'off'} onClick={() => setMode('off')} disabled={!canWrite} />
          <ModeButton
            label="Advisory"
            icon={ShieldAlert}
            active={mode === 'advisory'}
            onClick={() => setMode('advisory')}
            disabled={!canWrite}
          />
          <ModeButton
            label="Blocking"
            icon={Check}
            active={mode === 'blocking'}
            onClick={() => setMode('blocking', true)}
            disabled={!canWrite || !cal?.eligible_for_blocking}
            title={!cal?.eligible_for_blocking ? 'All seven preconditions must be met first' : undefined}
          />
          <div className="ml-auto flex items-center gap-2">
            <Btn size="sm" variant="ghost" onClick={pause} disabled={!canWrite}>
              <PauseCircle className="h-4 w-4" /> {paused ? 'Paused' : 'Pause 24h'}
            </Btn>
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-400">
          Advisory mode is a complete product: you still get the queue, the variance inbox, change-order
          drafts, and every financial figure. Only the block itself waits for calibration.
        </p>
        <p className="mt-1 text-[11px] text-zinc-400">
          Enabled classes: {s.gate_enabled_refs?.join(', ') || 'none configured'}
        </p>
      </Card>

      {/* Coverage */}
      {cal && (
        <Card className="mb-6 p-4">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">Gate coverage</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <Metric label="Coverage (7d)" value={cal.gate_coverage_pct == null ? 'no gated writes' : formatPct(cal.gate_coverage_pct)} />
            <Metric label="Unavailable (burn-api down)" value={`${cal.gate_unavailable_days} day(s)`} />
            <Metric label="Not configured" value={`${cal.gate_not_configured_days} day(s)`} />
          </div>
        </Card>
      )}

      {/* Promotion wizard */}
      <Card className="mb-6 p-4">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">
          Promotion to blocking — standing against all seven preconditions
        </h3>
        {calibration.isLoading ? (
          <div className="text-xs text-zinc-400">Loading calibration...</div>
        ) : !cal ? (
          <div className="text-xs text-zinc-400">Calibration unavailable.</div>
        ) : (
          <ul className="space-y-2">
            {cal.preconditions.map((p) => (
              <PreconditionRow key={p.key} p={p} />
            ))}
          </ul>
        )}
      </Card>

      {/* Advisory denies — mandatory review + feedback control */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-1">
          Last advisory denies (mandatory review before promotion)
        </h2>
        <p className="text-xs text-zinc-400 mb-3">
          Only "wrong call" (owner/admin) enters the precision numerator; the two non-scoring options and
          "flag for review" feed nothing.
        </p>
        {denies.isLoading ? (
          <LoadingState />
        ) : (denies.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-400">No advisory denies recorded yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {denies.data!.data.map((row) => (
                <AdvisoryDenyRow key={row.id} row={row} canMarkWrong={canMarkWrong} canOverride={canOverride} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {/* Precheck log */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-3">Precheck log</h2>
        {log.isLoading ? (
          <LoadingState />
        ) : (log.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-400">No prechecks yet.</p>
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Class</th>
                  <th className="px-4 py-2 font-medium">Verdict</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">Mode</th>
                </tr>
              </thead>
              <tbody>
                {log.data!.data.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-50 dark:border-zinc-800/60 last:border-0">
                    <td className="px-4 py-2 text-zinc-500 text-xs">{formatDateTime(row.created_at)}</td>
                    <td className="px-4 py-2 text-xs font-mono text-zinc-500">{row.work_ref_type}</td>
                    <td className="px-4 py-2">
                      <VerdictBadge verdict={row.verdict as never} />
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">{row.verdict_reason.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-xs text-zinc-400">
                      {row.mode_at_decision}
                      {row.enforced ? ' · enforced' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}

function ModeButton({
  label,
  icon: Icon,
  active,
  onClick,
  disabled,
  title,
}: {
  label: string;
  icon: typeof Check;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        active
          ? 'bg-primary-600 text-white border-primary-600'
          : 'border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-400">{label}</div>
      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

function PreconditionRow({ p }: { p: CalibrationPrecondition }) {
  return (
    <li className="flex items-start gap-2">
      <span className={cn('mt-0.5', p.satisfied ? 'text-emerald-500' : 'text-zinc-300 dark:text-zinc-600')}>
        {p.satisfied ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <div className="text-sm text-zinc-700 dark:text-zinc-200">{p.label}</div>
        {!p.satisfied && p.shortfall && <div className="text-xs text-amber-500">{p.shortfall}</div>}
        {p.satisfied && (
          <div className="text-[11px] text-zinc-400">
            {String(p.actual)} / required {String(p.required)}
          </div>
        )}
      </div>
    </li>
  );
}

function AdvisoryDenyRow({
  row,
  canMarkWrong,
  canOverride,
}: {
  row: PrecheckRow;
  canMarkWrong: boolean;
  canOverride: boolean;
}) {
  const label = useLabelPrecheck();
  const override = useOverridePrecheck();
  const labeled = row.advisory_feedback;

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <VerdictBadge verdict={row.verdict as never} />
        <span className="text-xs font-mono text-zinc-500">{row.work_ref_type}</span>
        <span className="text-xs text-zinc-400">{row.verdict_reason.replace(/_/g, ' ')}</span>
        <span className="text-[11px] text-zinc-400 ml-auto">{formatDateTime(row.created_at)}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">This would have been blocked. Right call?</span>
        <FeedbackBtn
          active={labeled === 'right_call'}
          onClick={() => label.mutate({ id: row.id, input: { advisory_feedback: 'right_call' } })}
        >
          Yes
        </FeedbackBtn>
        <FeedbackBtn
          active={labeled === 'would_have_mapped'}
          onClick={() => label.mutate({ id: row.id, input: { advisory_feedback: 'would_have_mapped' } })}
        >
          I'd have mapped it
        </FeedbackBtn>
        {canMarkWrong && (
          <FeedbackBtn
            active={labeled === 'wrong_call'}
            tone="danger"
            onClick={() => label.mutate({ id: row.id, input: { advisory_feedback: 'wrong_call' } })}
          >
            No — wrong call
          </FeedbackBtn>
        )}
        <FeedbackBtn onClick={() => label.mutate({ id: row.id, input: { flag_for_review: true } })}>
          Flag for review
        </FeedbackBtn>
        {canOverride && (
          <FeedbackBtn
            onClick={() =>
              override.mutate({
                id: row.id,
                input: { override_reason_code: 'absorbed_cost', override_reason_text: 'Absorbed on this account.' },
              })
            }
          >
            Override
          </FeedbackBtn>
        )}
      </div>
    </li>
  );
}

function FeedbackBtn({
  children,
  onClick,
  active,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors',
        active
          ? tone === 'danger'
            ? 'bg-red-600 text-white border-red-600'
            : 'bg-primary-600 text-white border-primary-600'
          : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
      )}
    >
      {children}
    </button>
  );
}
