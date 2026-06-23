import { Target, AlertTriangle, Calendar, User, LayoutDashboard, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePeriodStore } from '@/stores/period.store';
import { useAuthStore } from '@/stores/auth.store';
import { usePeriods } from '@/hooks/usePeriods';
import { useState, useRef, useEffect } from 'react';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BearingSidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/', page: 'dashboard' },
  { label: 'My Goals', icon: User, path: '/my-goals', page: 'my-goals' },
  { label: 'At Risk', icon: AlertTriangle, path: '/at-risk', page: 'at-risk' },
  { label: 'Periods', icon: Calendar, path: '/periods', page: 'periods' },
];

function PeriodScopeSelector() {
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

  // Auto-select first active period if none selected
  useEffect(() => {
    if (!selectedPeriodId && periods.length > 0) {
      const activePeriod = periods.find((p) => p.status === 'active') ?? periods[0];
      if (activePeriod) {
        setSelectedPeriod(activePeriod.id);
      }
    }
  }, [selectedPeriodId, periods, setSelectedPeriod]);

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId);
  const displayLabel = selectedPeriod ? selectedPeriod.name : 'Select Period';

  return (
    <div ref={ref} className="relative px-2 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-sidebar-hover transition-colors"
      >
        <Calendar className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="truncate flex-1 text-left">{displayLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg py-1 max-h-64 overflow-y-auto">
          {periods.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500 italic">No periods found</div>
          )}
          {periods.map((period) => {
            const isActive = selectedPeriodId === period.id;
            return (
              <button
                key={period.id}
                onClick={() => { setSelectedPeriod(period.id); setOpen(false); }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-zinc-300 hover:bg-sidebar-hover',
                )}
              >
                <span className="truncate flex-1 text-left">{period.name}</span>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full',
                  period.status === 'active' ? 'bg-green-900/30 text-green-400' :
                  period.status === 'completed' ? 'bg-blue-900/30 text-blue-400' :
                  period.status === 'planning' ? 'bg-zinc-800 text-zinc-400' :
                  'bg-zinc-800 text-zinc-500',
                )}>
                  {period.status}
                </span>
                {isActive && <Check className="h-3.5 w-3.5 text-primary-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BearingSidebar({ onNavigate, activePage }: BearingSidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Target className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bearing</span>
      </div>

      {/* Period scope selector */}
      <PeriodScopeSelector />

      {/* Nav items */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        {navItems.map((item) => {
          const isActive = activePage === item.page;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => onNavigate(item.path)}
              className={cn(
                'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-active text-white'
                  : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
