import { cn } from '@/lib/utils';
import type {
  BurnEngagementStatus,
  BurnEnvelopeBasis,
  BurnMetricBasis,
  BurnRevenueBasis,
  BurnReviewStatus,
  BurnLifecycleStatus,
  BurnEnvelopeSource,
  BurnWorkItemAttributionState,
  BurnAttributionState,
  BurnUnscopedBucket,
  BurnPrecheckVerdict,
  BurnVarianceKind,
  BurnVarianceSeverity,
  BurnVarianceStatus,
  BurnGateMode,
  BurnValuationBasis,
} from '@bigbluebam/shared';

const pill =
  'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap';
const mono =
  'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono font-medium whitespace-nowrap';

const NEUTRAL = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
const GREEN = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
const AMBER = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
const RED = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
const ORANGE = 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
const BLUE = 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400';
const VIOLET = 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200';

// Portfolio-board chain health chip (spec 7.1).
export type BurnChainStatus = 'healthy' | 'at_risk' | 'overrun' | 'silent' | 'unlinked';

export function ChainStatusBadge({ status }: { status: BurnChainStatus }) {
  const styles: Record<BurnChainStatus, string> = {
    healthy: GREEN,
    at_risk: AMBER,
    overrun: RED,
    silent: VIOLET,
    unlinked: NEUTRAL,
  };
  const labels: Record<BurnChainStatus, string> = {
    healthy: 'Healthy',
    at_risk: 'At risk',
    overrun: 'Overrun',
    silent: 'Silent',
    unlinked: 'Unlinked',
  };
  return <span className={cn(pill, styles[status] ?? NEUTRAL)}>{labels[status] ?? status}</span>;
}

export function EngagementStatusBadge({ status }: { status: BurnEngagementStatus }) {
  const styles: Record<BurnEngagementStatus, string> = {
    draft: NEUTRAL,
    extracting: AMBER,
    active: GREEN,
    superseded: VIOLET,
    closed: NEUTRAL,
  };
  return <span className={cn(pill, styles[status] ?? NEUTRAL)}>{status}</span>;
}

const ENVELOPE_BASIS_LABELS: Record<BurnEnvelopeBasis, string> = {
  fixed: 'Fixed fee',
  time_and_materials: 'T&M',
  retainer: 'Retainer',
  not_to_exceed: 'Not to exceed',
};

export function EnvelopeBasisBadge({ basis }: { basis: BurnEnvelopeBasis }) {
  return <span className={cn(mono, NEUTRAL)}>{ENVELOPE_BASIS_LABELS[basis] ?? basis}</span>;
}

// The headline label derives from metric_basis + revenue_basis (spec 1.2.2). "Margin" is
// NEVER shown when the number is consumption; a field name is a claim.
const METRIC_BASIS_LABELS: Record<BurnMetricBasis, string> = {
  true_margin: 'Margin',
  contract_consumption: 'Contract consumption',
  suppressed: 'Consumption',
};

const REVENUE_BASIS_LABELS: Record<BurnRevenueBasis, string> = {
  contract_value: 'contract value',
  billable_recognized_capped: 'billable, capped',
  contract_value_per_period: 'per-period value',
  billable_recognized: 'billable recognized',
};

export function MetricBasisLabel({
  metricBasis,
  revenueBasis,
  inProgress,
}: {
  metricBasis: BurnMetricBasis;
  revenueBasis?: BurnRevenueBasis | null;
  inProgress?: boolean;
}) {
  const base = METRIC_BASIS_LABELS[metricBasis] ?? metricBasis;
  const rev = revenueBasis ? REVENUE_BASIS_LABELS[revenueBasis] : undefined;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {base}
        {rev ? <span className="text-zinc-400 dark:text-zinc-500"> · {rev}</span> : null}
      </span>
      {inProgress && (
        <span className={cn(pill, AMBER, 'text-[10px]')} title="Partial delivery; no final figure yet">
          in progress
        </span>
      )}
    </span>
  );
}

export function ReviewStatusBadge({ status }: { status: BurnReviewStatus }) {
  const styles: Record<BurnReviewStatus, string> = {
    pending_review: AMBER,
    confirmed: GREEN,
    rejected: NEUTRAL,
    superseded: VIOLET,
  };
  const labels: Record<BurnReviewStatus, string> = {
    pending_review: 'Pending review',
    confirmed: 'Confirmed',
    rejected: 'Rejected',
    superseded: 'Superseded',
  };
  return <span className={cn(pill, styles[status] ?? NEUTRAL)}>{labels[status] ?? status}</span>;
}

export function LifecycleStatusBadge({ status }: { status: BurnLifecycleStatus }) {
  const styles: Record<BurnLifecycleStatus, string> = {
    open: BLUE,
    complete: GREEN,
    closed: NEUTRAL,
  };
  return <span className={cn(pill, styles[status] ?? NEUTRAL)}>{status}</span>;
}

// The three distinct per-deliverable envelope states (spec 7.3). Only "confirmed & priced"
// gates.
export type EnvelopeState = 'unconfirmed' | 'unpriced' | 'priced';

export function EnvelopeStateBadge({ state }: { state: EnvelopeState }) {
  if (state === 'priced') return <span className={cn(pill, GREEN)}>Envelope priced</span>;
  if (state === 'unpriced')
    return (
      <span className={cn(pill, VIOLET)} title="Tracks hours only; can never deny">
        Envelope unpriced
      </span>
    );
  return (
    <span className={cn(pill, AMBER)} title="Not yet a gate input">
      Envelope unconfirmed
    </span>
  );
}

export function EnvelopeSourceBadge({ source }: { source: BurnEnvelopeSource }) {
  const labels: Record<BurnEnvelopeSource, string> = {
    proposed: 'proposed',
    human: 'confirmed',
    stated: 'stated',
    unpriced: 'unpriced',
  };
  return <span className={cn(mono, NEUTRAL)}>{labels[source] ?? source}</span>;
}

export function AttributionStateBadge({
  state,
}: {
  state: BurnWorkItemAttributionState | BurnAttributionState;
}) {
  const green = ['attributed', 'auto_attributed', 'confirmed'];
  const amber = ['pending', 'pending_attribution', 'pending_review'];
  const violet = ['unscoped'];
  const style = green.includes(state)
    ? GREEN
    : amber.includes(state)
      ? AMBER
      : violet.includes(state)
        ? VIOLET
        : NEUTRAL;
  return <span className={cn(pill, style)}>{state.replace(/_/g, ' ')}</span>;
}

export function ValuationBasisBadge({ basis }: { basis: BurnValuationBasis }) {
  const style = basis === 'unrated' ? AMBER : basis === 'none' ? NEUTRAL : BLUE;
  const labels: Record<BurnValuationBasis, string> = {
    rate: 'rated',
    expense: 'expense',
    invoice: 'invoice',
    none: 'signal only',
    unrated: 'awaiting valuation',
    no_cost_rate: 'no cost rate',
  };
  return <span className={cn(mono, style)}>{labels[basis] ?? basis}</span>;
}

const BUCKET_LABELS: Record<BurnUnscopedBucket, string> = {
  sold_by_nobody: 'Sold by nobody',
  unclassified: 'Unclassified',
  outside_contract: 'Outside any tracked contract',
};

export function bucketLabel(bucket: BurnUnscopedBucket): string {
  return BUCKET_LABELS[bucket] ?? bucket;
}

export function VerdictBadge({ verdict }: { verdict: BurnPrecheckVerdict }) {
  const styles: Record<BurnPrecheckVerdict, string> = {
    allow: GREEN,
    allow_with_note: BLUE,
    needs_mapping: AMBER,
    deny: RED,
  };
  const labels: Record<BurnPrecheckVerdict, string> = {
    allow: 'Allow',
    allow_with_note: 'Allow w/ note',
    needs_mapping: 'Needs mapping',
    deny: 'Deny',
  };
  return <span className={cn(pill, styles[verdict] ?? NEUTRAL)}>{labels[verdict] ?? verdict}</span>;
}

export function SeverityBadge({ severity }: { severity: BurnVarianceSeverity }) {
  const styles: Record<BurnVarianceSeverity, string> = {
    low: NEUTRAL,
    medium: AMBER,
    high: ORANGE,
    critical: RED,
  };
  return <span className={cn(pill, styles[severity] ?? NEUTRAL)}>{severity}</span>;
}

export function VarianceStatusBadge({ status }: { status: BurnVarianceStatus }) {
  const styles: Record<BurnVarianceStatus, string> = {
    open: BLUE,
    acknowledged: AMBER,
    resolved: GREEN,
    dismissed: NEUTRAL,
  };
  return <span className={cn(pill, styles[status] ?? NEUTRAL)}>{status}</span>;
}

const VARIANCE_KIND_LABELS: Record<BurnVarianceKind, string> = {
  unscoped_work: 'Unscoped work',
  envelope_overrun: 'Envelope overrun',
  envelope_at_risk: 'Envelope at risk',
  silent_deliverable: 'Silent deliverable',
  ungated_charge: 'Ungated charge',
  consumption_erosion: 'Consumption erosion',
  phantom_consumption: 'Phantom consumption',
  gate_outage: 'Gate outage',
  rule_overreach: 'Rule overreach',
  awaiting_valuation: 'Awaiting valuation',
  precheck_probing: 'Precheck probing',
};

export function varianceKindLabel(kind: BurnVarianceKind): string {
  return VARIANCE_KIND_LABELS[kind] ?? kind;
}

export function GateModeBadge({ mode }: { mode: BurnGateMode }) {
  const styles: Record<BurnGateMode, string> = {
    off: NEUTRAL,
    advisory: BLUE,
    blocking: GREEN,
  };
  return <span className={cn(pill, styles[mode] ?? NEUTRAL)}>{mode}</span>;
}
