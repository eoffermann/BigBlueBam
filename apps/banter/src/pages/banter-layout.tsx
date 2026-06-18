import { useState, type ReactNode } from 'react';
import { ChevronRight, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BanterSidebar } from '@/components/sidebar/banter-sidebar';
import { ThreadPanel } from '@/components/threads/thread-panel';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { useAuthStore } from '@/stores/auth.store';
import { useChannelStore } from '@/stores/channel.store';
import { usePresence } from '@/hooks/use-presence';
import { useUnreadCounts } from '@/hooks/use-unread';
import { useRealtimeGlobal } from '@/hooks/use-realtime';
import { useChannels, channelDisplayName } from '@/hooks/use-channels';

type ActiveRoute = { page: string; slug?: string; id?: string };

interface BanterLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
  breadcrumbLabel?: string;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute, channelName?: string): Crumb[] {
  switch (route.page) {
    case 'channel':
      return [
        { label: 'Channels', href: '/browse' },
        { label: channelName ? `#${channelName}` : `#${route.slug ?? ''}` },
      ];
    case 'dm':
      return [
        { label: 'Direct Messages' },
        { label: channelName ?? 'Conversation' },
      ];
    case 'feed':
      return [{ label: 'Feed' }];
    case 'browse':
      return [{ label: 'Browse channels' }];
    case 'bookmarks':
      return [{ label: 'Bookmarks' }];
    case 'search':
      return [{ label: 'Search' }];
    case 'settings':
      return [{ label: 'Settings' }];
    case 'feed-settings':
      return [{ label: 'Settings', href: '/settings' }, { label: 'Feed ranking' }];
    case 'admin':
      return [{ label: 'Admin' }];
    case 'admin-calling':
      return [{ label: 'Admin' }, { label: 'Calling Settings' }];
    case 'call':
      return [{ label: 'Calls' }, { label: 'Playback' }];
    default:
      return [];
  }
}

export function BanterLayout({
  children,
  onNavigate,
  activeRoute,
  breadcrumbLabel,
}: BanterLayoutProps) {
  const activeThreadMessageId = useChannelStore((s) => s.activeThreadMessageId);
  const sidebarCollapsed = useChannelStore((s) => s.sidebarCollapsed);
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const user = useAuthStore((s) => s.user);
  const [searchQuery, setSearchQuery] = useState('');
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  // Global hooks
  usePresence();
  useUnreadCounts();
  useRealtimeGlobal();

  // Derive breadcrumb label from active route if not supplied
  const { data: channels } = useChannels();
  const derivedLabel = (() => {
    if (breadcrumbLabel) return breadcrumbLabel;
    if (!channels) return undefined;
    if (activeRoute.page === 'channel' && activeRoute.slug) {
      const ch = channels.find((c) => c.slug === activeRoute.slug);
      return ch?.name;
    }
    if (activeRoute.page === 'dm' && activeRoute.id) {
      const ch = channels.find((c) => c.id === activeRoute.id);
      return ch ? channelDisplayName(ch) : undefined;
    }
    return undefined;
  })();

  const crumbs = breadcrumbsFor(activeRoute, derivedLabel);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const q = searchQuery.trim();
      onNavigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
            <BanterSidebar onNavigate={onNavigate} activeRoute={activeRoute} />
          </aside>
        )}

        {/* Main column */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Header */}
          <header className="flex items-center justify-between h-14 px-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
            <div className="flex items-center gap-4">
              {/* Launchpad app switcher */}
              <nav className="flex items-center border-r border-zinc-200 dark:border-zinc-700 pr-4 mr-2">
                <LaunchpadTrigger onClick={() => setLaunchpadOpen(true)} />
              </nav>

              {/* Feed — the ranked, top-down landing view (§1). */}
              <button
                onClick={() => onNavigate('/feed')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors',
                  activeRoute.page === 'feed'
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-950 dark:text-primary-300'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
                title="Your Feed"
              >
                <Sparkles className="h-4 w-4" />
                Feed
              </button>

              {/* Breadcrumbs */}
              <div className="flex items-center gap-1 text-sm">
                {crumbs.map((crumb, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
                    {crumb.href ? (
                      <button
                        onClick={() => crumb.href && onNavigate(crumb.href!)}
                        className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        {crumb.label}
                      </button>
                    ) : (
                      <span className="text-zinc-900 dark:text-zinc-100 font-medium">{crumb.label}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <OrgSwitcher />
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search messages..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  className="w-64 rounded-lg border border-zinc-200 bg-zinc-50 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                />
              </div>
              <NotificationsBell inAppPrefix="/banter/" onNavigate={onNavigate} />
              <HelpTrigger app="banter" />
              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-hidden bg-white dark:bg-zinc-900 flex flex-col min-w-0">
            {children}
          </main>
        </div>

        {/* Thread panel */}
        {activeThreadMessageId && activeChannelId && (
          <aside className="w-[400px] flex-shrink-0 border-l border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 animate-slide-in-right">
            <ThreadPanel
              messageId={activeThreadMessageId}
              channelId={activeChannelId}
              onNavigate={onNavigate}
            />
          </aside>
        )}
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="banter" />
    </div>
  );
}
