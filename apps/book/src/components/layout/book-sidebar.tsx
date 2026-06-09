import {
  Calendar,
  CalendarDays,
  CalendarRange,
  Link2,
  Clock,
  Plug,
  GanttChart,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BookSidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [
  { label: 'Week', icon: CalendarDays, path: '/', page: 'week' },
  { label: 'Day', icon: Calendar, path: '/day', page: 'day' },
  { label: 'Month', icon: CalendarRange, path: '/month', page: 'month' },
  { label: 'Timeline', icon: GanttChart, path: '/timeline', page: 'timeline' },
  { label: 'Booking Pages', icon: Link2, path: '/booking-pages', page: 'booking-pages' },
];

const settingsItems = [
  { label: 'Calendars', icon: CalendarRange, path: '/settings/calendars', page: 'calendars' },
  { label: 'Working Hours', icon: Clock, path: '/settings/working-hours', page: 'working-hours' },
  { label: 'Connections', icon: Plug, path: '/settings/connections', page: 'connections' },
];

export function BookSidebar({ onNavigate, activePage }: BookSidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-blue-600 text-white font-bold text-sm">
          <Calendar className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Book</span>
      </div>

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

        <div className="pt-4 pb-1 px-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Settings</span>
        </div>

        {settingsItems.map((item) => {
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
