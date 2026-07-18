import { Ruler, LibraryBig } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/basis-layout';

interface BasisSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

export function BasisSidebar({ onNavigate, activeRoute }: BasisSidebarProps) {
  const user = useAuthStore((s) => s.user);
  const onCatalog = activeRoute.page === 'catalog' || activeRoute.page === 'metric';

  return (
    <div className="flex flex-col h-full">
      {/* Logo area — matches the shared shell: colored badge + suite-app name */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Ruler className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Basis</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        <button
          onClick={() => onNavigate('/')}
          className={cn(
            'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            onCatalog
              ? 'bg-sidebar-active text-white'
              : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
          )}
        >
          <LibraryBig className="h-4 w-4 shrink-0" />
          Metric Catalog
        </button>
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
