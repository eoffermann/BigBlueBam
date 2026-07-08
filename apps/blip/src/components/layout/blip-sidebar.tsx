import {
  Activity,
  KeyRound,
  ScrollText,
  Bell,
  Layers,
  ShieldAlert,
  Timer,
  ListTree,
  BookOpen,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import type { ActiveRoute } from '@/components/layout/blip-layout';

interface BlipSidebarProps {
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

// Per-app sub-nav (shown when an app is selected). `page` keys match parseRoute.
const appNav = [
  { label: 'Health', icon: Activity, suffix: '', pages: ['app-detail'] },
  { label: 'Keys', icon: KeyRound, suffix: '/keys', pages: ['keys'] },
  // 'Viewer' lands on the report-types list (pick a type to tail) but only
  // highlights once you are in an actual live viewer, so it no longer
  // double-highlights with 'Types' on the shared /types route.
  { label: 'Viewer', icon: Radio, suffix: '/types', pages: ['viewer'] },
  { label: 'Watches', icon: Bell, suffix: '/watches', pages: ['watches'] },
  { label: 'Views', icon: Layers, suffix: '/views', pages: ['views'] },
  { label: 'Transform', icon: ShieldAlert, suffix: '/transform', pages: ['transform'] },
  { label: 'Retention', icon: Timer, suffix: '/retention', pages: ['retention'] },
  { label: 'Types', icon: ListTree, suffix: '/types', pages: ['types'] },
  { label: 'Client setup', icon: BookOpen, suffix: '/client-setup', pages: ['client-setup'] },
];

export function BlipSidebar({ onNavigate, activeRoute }: BlipSidebarProps) {
  const user = useAuthStore((s) => s.user);
  const appId = activeRoute.id;

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Activity className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Blip</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        <button
          onClick={() => onNavigate('/')}
          className={cn(
            'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            activeRoute.page === 'apps'
              ? 'bg-sidebar-active text-white'
              : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
          )}
        >
          <ScrollText className="h-4 w-4 shrink-0" />
          Apps
        </button>

        {appId && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              App
            </p>
            {appNav.map((item) => {
              const Icon = item.icon;
              const isActive = item.pages.includes(activeRoute.page);
              return (
                <button
                  key={item.label}
                  onClick={() => onNavigate(`/apps/${appId}${item.suffix}`)}
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
          </div>
        )}
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
