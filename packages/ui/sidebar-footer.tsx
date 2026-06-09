/**
 * Canonical platform-admin footer that sits at the bottom of every
 * BigBlueBam app's sidebar. Surfaces the same destinations the
 * upper-right UserMenu does — Account Settings, People, SuperUser
 * Console — so users always have two consistent ways to reach
 * platform-level pages from any app.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/sidebar-footer' -> '<root>/packages/ui/sidebar-footer.tsx'
 *
 * Items rendered (in order, with the same gating as UserMenu):
 *   - SuperUser     → /b3/superuser           (is_superuser only)
 *   - All users     → /b3/superuser/people    (is_superuser only)
 *   - People        → /b3/people              (owner/admin/superuser)
 *   - Account Settings → /b3/settings          (always)
 *
 * Navigation is a hard cross-app jump (window.location.href) so the
 * component works identically inside B3 and inside any other SPA —
 * there's no per-app router contract to thread through. Same model
 * as packages/ui/user-menu.tsx.
 *
 * Styling is intentionally palette-light: text-zinc-700 dark for the
 * standard items, text-red-* for SuperUser entries, and hover states
 * that work on both light and dark sidebars. App-specific sidebars
 * remain free to render their own app-nav above this footer; this
 * component only owns the bottom platform-admin block.
 */

import { Settings, Shield, Users, UsersRound } from 'lucide-react';

export interface SidebarFooterUser {
  role?: string | null;
  is_superuser?: boolean | null;
}

export interface SidebarPlatformFooterProps {
  user: SidebarFooterUser | null | undefined;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const baseItem =
  'flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm transition-colors text-left';
const standardItem =
  'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800';
const superUserItem =
  'text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40';

export function SidebarPlatformFooter({ user }: SidebarPlatformFooterProps) {
  const isSuperUser = user?.is_superuser === true;
  const canSeePeople =
    user?.role === 'owner' || user?.role === 'admin' || isSuperUser;

  const go = (path: string) => () => {
    window.location.href = path;
  };

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-2">
      {isSuperUser && (
        <button
          type="button"
          onClick={go('/b3/superuser')}
          className={cn(baseItem, superUserItem)}
        >
          <Shield className="h-4 w-4" />
          SuperUser
        </button>
      )}
      {isSuperUser && (
        <button
          type="button"
          onClick={go('/b3/superuser/people')}
          className={cn(baseItem, superUserItem)}
        >
          <UsersRound className="h-4 w-4" />
          All users
        </button>
      )}
      {canSeePeople && (
        <button
          type="button"
          onClick={go('/b3/people')}
          className={cn(baseItem, standardItem)}
        >
          <Users className="h-4 w-4" />
          People
        </button>
      )}
      <button
        type="button"
        onClick={go('/b3/settings')}
        className={cn(baseItem, standardItem)}
      >
        <Settings className="h-4 w-4" />
        Account Settings
      </button>
    </div>
  );
}
