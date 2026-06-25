import { Film, Clapperboard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BaySidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [{ label: 'Review Library', icon: Film, path: '/', page: 'assets' }];

export function BaySidebar({ onNavigate, activePage }: BaySidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Clapperboard className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bay</span>
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
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
