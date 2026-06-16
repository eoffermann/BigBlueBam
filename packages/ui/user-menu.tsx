/**
 * Canonical UserMenu component shared across all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/user-menu' -> '<root>/packages/ui/user-menu.tsx'
 *
 * Renders the avatar in the upper right of each app's header and a
 * dropdown with:
 *   - user display name and email header (non-interactive)
 *   - Account settings (cross-app to /b3/settings so user-level
 *     settings are always reachable)
 *   - People (owners/admins/superusers only, cross-app /b3/people)
 *   - SuperUser Console (is_superuser only, cross-app /b3/superuser)
 *   - Sign out (POST /b3/api/auth/logout then reload to /b3/login)
 *
 * App-specific settings live in each app's own sidebar or settings
 * route - this component only surfaces user-level concerns.
 */

import { LogOut, Settings as SettingsIcon, Shield, Users, UsersRound, HelpCircle } from 'lucide-react';
import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Avatar from '@radix-ui/react-avatar';

export interface UserMenuUser {
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  role?: string | null;
  is_superuser?: boolean;
}

export interface UserMenuProps {
  user: UserMenuUser | null | undefined;
  /**
   * Absolute URL to land on after logout. Defaults to '/b3/login' so
   * the shared session flow is preserved across all apps.
   */
  logoutRedirect?: string;
  /**
   * Callback to navigate to the Help page. When provided, a Help
   * menu item is shown in the dropdown.
   */
  onHelp?: () => void;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function generateAvatarInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.substring(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function UserMenu({ user, logoutRedirect = '/b3/login', onHelp }: UserMenuProps) {
  const isSuperUser = user?.is_superuser === true;
  const canSeePeople =
    user?.role === 'owner' || user?.role === 'admin' || isSuperUser;

  const handleLogout = async () => {
    try {
      await fetch('/b3/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Even on failure, redirect to login - the server will force
      // re-authentication anyway.
    }
    window.location.href = logoutRedirect;
  };

  const initials = generateAvatarInitials(user?.display_name);

  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          aria-label="User menu"
        >
          <Avatar.Root className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            {user?.avatar_url && (
              <Avatar.Image
                src={user.avatar_url}
                alt={user.display_name ?? 'Avatar'}
                className="h-full w-full object-cover"
              />
            )}
            <Avatar.Fallback className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
              {initials}
            </Avatar.Fallback>
          </Avatar.Root>
        </button>
      </RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          align="end"
          sideOffset={4}
          className={cn(
            'z-50 min-w-[220px] overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-lg',
            'dark:bg-zinc-900 dark:border-zinc-700',
          )}
        >
          <RadixDropdownMenu.Label className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {user?.display_name ?? 'Signed in'}
            </p>
            <p className="text-xs text-zinc-500 truncate">{user?.email ?? ''}</p>
          </RadixDropdownMenu.Label>

          <RadixDropdownMenu.Item
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800"
            onSelect={() => {
              window.location.href = '/b3/settings';
            }}
          >
            <SettingsIcon className="h-4 w-4" />
            Account settings
          </RadixDropdownMenu.Item>

          {canSeePeople && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800"
              onSelect={() => {
                window.location.href = '/b3/people';
              }}
            >
              <Users className="h-4 w-4" />
              People
            </RadixDropdownMenu.Item>
          )}

          {canSeePeople && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800"
              onSelect={() => {
                window.location.href = '/b3/people-manager';
              }}
            >
              <UsersRound className="h-4 w-4" />
              People Manager
            </RadixDropdownMenu.Item>
          )}

          {isSuperUser && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800"
              onSelect={() => {
                window.location.href = '/b3/superuser';
              }}
            >
              <Shield className="h-4 w-4" />
              SuperUser Console
            </RadixDropdownMenu.Item>
          )}

          {onHelp && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800"
              onSelect={onHelp}
            >
              <HelpCircle className="h-4 w-4" />
              Help
            </RadixDropdownMenu.Item>
          )}

          <RadixDropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />

          <RadixDropdownMenu.Item
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 focus:bg-red-50 dark:focus:bg-red-950/40"
            onSelect={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </RadixDropdownMenu.Item>
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}
