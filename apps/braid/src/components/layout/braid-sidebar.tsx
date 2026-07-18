import { GitMerge, Users, ListChecks, SlidersHorizontal, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/braid-layout';

interface BraidSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

const nav: Array<{ label: string; icon: typeof Users; path: string; pages: ActiveRoute['page'][] }> = [
  { label: 'Profiles', icon: Users, path: '/', pages: ['profiles', 'profile-detail'] },
  { label: 'Review Queue', icon: ListChecks, path: '/review-queue', pages: ['review-queue'] },
  { label: 'Survivorship', icon: SlidersHorizontal, path: '/survivorship', pages: ['survivorship'] },
  { label: 'Settings', icon: SettingsIcon, path: '/settings', pages: ['settings'] },
];

export function BraidSidebar({ onNavigate, activeRoute }: BraidSidebarProps) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <GitMerge className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Braid</span>
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
