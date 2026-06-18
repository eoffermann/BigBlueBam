import { ChevronDown, Check, Calendar } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { usePeriodStore, type BearingPeriod } from '@/stores/period.store';
import { usePeriods } from '@/hooks/usePeriods';
import { cn, formatDate } from '@/lib/utils';
import { TimeRemainingBadge } from '@/components/common/TimeRemainingBadge';

export function PeriodSelector() {
  const { data } = usePeriods();
  const periods = data?.data ?? [];
  const selectedPeriodId = usePeriodStore((s) => s.selectedPeriodId);
  const setSelectedPeriod = usePeriodStore((s) => s.setSelectedPeriod);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const selected = periods.find((p) => p.id === selectedPeriodId);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 px-4 py-3 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
      >
        <Calendar className="h-5 w-5 text-primary-500" />
        <div className="text-left">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {selected?.name ?? 'Select a period'}
          </p>
          {selected && (
            <p className="text-xs text-zinc-500">
              {formatDate(selected.start_date)} - {formatDate(selected.end_date)}
            </p>
          )}
        </div>
        {selected && <TimeRemainingBadge endDate={selected.end_date} />}
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition-transform ml-2', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-80 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-2 max-h-80 overflow-y-auto">
          {periods.length === 0 && (
            <div className="px-4 py-3 text-sm text-zinc-500 italic">No periods created yet</div>
          )}
          {periods.map((period) => {
            const isSelected = selectedPeriodId === period.id;
            return (
              <button
                key={period.id}
                onClick={() => { setSelectedPeriod(period.id); setOpen(false); }}
                className={cn(
                  'flex items-center justify-between w-full px-4 py-3 text-sm transition-colors',
                  isSelected
                    ? 'bg-primary-50 dark:bg-primary-900/20'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                )}
              >
                <div className="text-left min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{period.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {formatDate(period.start_date)} - {formatDate(period.end_date)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <PeriodStatusDot status={period.status} />
                  {isSelected && <Check className="h-4 w-4 text-primary-600" />}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PeriodStatusDot({ status }: { status: BearingPeriod['status'] }) {
  const colors: Record<string, string> = {
    planning: 'bg-zinc-400',
    active: 'bg-green-500',
    completed: 'bg-blue-500',
    archived: 'bg-zinc-300',
  };

  return (
    <span className={cn('h-2 w-2 rounded-full', colors[status] ?? 'bg-zinc-400')} title={status} />
  );
}
