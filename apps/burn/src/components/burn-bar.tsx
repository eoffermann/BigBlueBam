import { cn, clampPct, formatPct } from '@/lib/utils';

interface BurnBarProps {
  /** Consumption / burn percentage (0..100+). Values over 100 render as an overrun. */
  pct: number | null | undefined;
  className?: string;
  showLabel?: boolean;
}

// The burn bar (spec 7.1). Green under 75%, amber to 100%, red over. Over-100 is clamped for
// the fill but flagged with a hatched overrun cap so an overrun is visually unmistakable.
export function BurnBar({ pct, className, showLabel = true }: BurnBarProps) {
  const value = pct ?? 0;
  const width = clampPct(value);
  const tone =
    value >= 100
      ? 'bg-red-500'
      : value >= 90
        ? 'bg-amber-500'
        : value >= 75
          ? 'bg-amber-400'
          : 'bg-emerald-500';

  return (
    <div className={cn('space-y-1', className)}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={cn('h-full rounded-full transition-all', tone)}
          style={{ width: `${width}%` }}
        />
      </div>
      {showLabel && (
        <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
          <span>{formatPct(pct)} consumed</span>
          {value >= 100 && <span className="font-medium text-red-500">over envelope</span>}
        </div>
      )}
    </div>
  );
}
