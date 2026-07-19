import {
  Flame,
  LayoutDashboard,
  Inbox,
  AlertTriangle,
  ShieldCheck,
  Coins,
  Settings as SettingsIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/burn-layout';

interface BurnSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

const nav: Array<{
  label: string;
  icon: typeof LayoutDashboard;
  path: string;
  pages: ActiveRoute['page'][];
}> = [
  { label: 'Portfolio Board', icon: LayoutDashboard, path: '/', pages: ['board', 'engagement-detail'] },
  { label: 'Unscoped Queue', icon: Inbox, path: '/unscoped', pages: ['unscoped'] },
  { label: 'Variances', icon: AlertTriangle, path: '/variances', pages: ['variances'] },
  { label: 'Gate Console', icon: ShieldCheck, path: '/gate', pages: ['gate'] },
  { label: 'Cost Rates', icon: Coins, path: '/settings/cost-rates', pages: ['cost-rates'] },
  { label: 'Settings', icon: SettingsIcon, path: '/settings', pages: ['settings', 'rules'] },
];

export function BurnSidebar({ onNavigate, activeRoute }: BurnSidebarProps) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Flame className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Burn</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        {nav.map((item) => {
          const Icon = item.icon;
          const isActive = item.pages.includes(activeRoute.page);
          return (
            <button
              key={item.label}
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
