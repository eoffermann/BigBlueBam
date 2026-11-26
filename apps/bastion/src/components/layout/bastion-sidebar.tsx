import { Castle, Gauge, ListChecks, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/bastion-layout';

interface BastionSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

// Each milestone adds its pages here (spec 6.1).
const nav: Array<{
  label: string;
  icon: typeof Gauge;
  path: string;
  pages: ActiveRoute['page'][];
}> = [
  { label: 'Readiness', icon: Gauge, path: '/', pages: ['home'] },
  { label: 'Controls', icon: ListChecks, path: '/controls', pages: ['controls'] },
  { label: 'Setup', icon: Settings2, path: '/setup', pages: ['setup'] },
];

export function BastionSidebar({ onNavigate, activeRoute }: BastionSidebarProps) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Castle className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bastion</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        {nav.map((item) => {
          const Icon = item.icon;
          const isActive = item.pages.includes(activeRoute.page);
          return (
            <button
              key={item.label}
              type="button"
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
