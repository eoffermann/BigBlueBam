import { ShieldCheck, ScrollText, Radar, Send, ClipboardCheck, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/bulwark-layout';

interface BulwarkSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

const nav: Array<{ label: string; icon: typeof ScrollText; path: string; pages: ActiveRoute['page'][] }> = [
  { label: 'Obligation Ledger', icon: ScrollText, path: '/', pages: ['ledger', 'contract-detail'] },
  { label: 'Deadline Radar', icon: Radar, path: '/radar', pages: ['radar'] },
  { label: 'Notice Queue', icon: Send, path: '/notices', pages: ['notices'] },
  { label: 'Compliance', icon: ClipboardCheck, path: '/compliance', pages: ['compliance'] },
  { label: 'Settings', icon: SettingsIcon, path: '/settings', pages: ['settings'] },
];

export function BulwarkSidebar({ onNavigate, activeRoute }: BulwarkSidebarProps) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <ShieldCheck className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bulwark</span>
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
