import { Lock } from 'lucide-react';
import type { BurnMoneyBlock } from '@bigbluebam/shared';
import { cn, formatCents, formatPct } from '@/lib/utils';
import { MetricBasisLabel } from '@/components/badges';

// Renders the discriminated BurnMoneyBlock (spec 1.2.2) as a headline figure + basis label.
// The `suppressed` variant has NO cost/margin key at all: it is the member-tier response, and
// ContributorFloorNotice explains why the cost figures are absent rather than banded.
export function MoneyFigure({ money, size = 'lg' }: { money: BurnMoneyBlock; size?: 'md' | 'lg' }) {
  const amountClass = size === 'lg' ? 'text-2xl font-semibold' : 'text-lg font-semibold';

  if (money.metric_basis === 'true_margin') {
    const inProgress = money.margin_state === 'in_progress';
    return (
      <div className="space-y-1">
        <MetricBasisLabel
          metricBasis="true_margin"
          revenueBasis={money.revenue_basis}
          inProgress={inProgress}
        />
        <div className={cn(amountClass, marginTone(money.margin_amount))}>
          {formatCents(money.margin_amount, money.currency)}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatPct(money.margin_pct)} margin · {formatPct(money.cost_rate_coverage_pct)} cost coverage
        </div>
      </div>
    );
  }

  if (money.metric_basis === 'contract_consumption') {
    const inProgress = money.completion_state === 'in_progress';
    return (
      <div className="space-y-1">
        <MetricBasisLabel
          metricBasis="contract_consumption"
          revenueBasis={money.revenue_basis}
          inProgress={inProgress}
        />
        <div className={cn(amountClass, 'text-zinc-900 dark:text-zinc-100')}>
          {formatPct(money.contract_consumption_pct)}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatCents(money.attributed_billable, money.currency)} of{' '}
          {formatCents(money.contract_value, money.currency)} contract value
        </div>
      </div>
    );
  }

  // suppressed
  return (
    <div className="space-y-1">
      <MetricBasisLabel metricBasis="suppressed" revenueBasis={money.revenue_basis} />
      <div className={cn(amountClass, 'text-zinc-900 dark:text-zinc-100')}>
        {formatPct(money.contract_consumption_pct)}
      </div>
      <ContributorFloorNotice reason={money.suppressed_reason} />
    </div>
  );
}

function marginTone(cents: number | null): string {
  if (cents == null) return 'text-zinc-900 dark:text-zinc-100';
  if (cents < 0) return 'text-red-600 dark:text-red-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

const SUPPRESSED_REASON_TEXT: Record<string, string> = {
  insufficient_permission: 'Cost and margin are hidden; you do not hold financial read-all.',
  insufficient_contributors:
    'Cost and margin are hidden: too few contributors on this chain to aggregate without exposing an individual rate.',
  unresolved_viewer: 'Cost and margin are hidden: your access scope could not be resolved.',
};

export function ContributorFloorNotice({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-zinc-400">
      <Lock className="h-3 w-3 mt-0.5 shrink-0" />
      <span>{SUPPRESSED_REASON_TEXT[reason] ?? 'Cost and margin figures are not available to you.'}</span>
    </div>
  );
}
