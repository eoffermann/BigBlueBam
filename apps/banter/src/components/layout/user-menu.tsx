import { LogOut } from 'lucide-react';
import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Avatar from '@radix-ui/react-avatar';
import { useCan } from '@bigbluebam/ui/use-can';
import { bbbPost } from '@/lib/bbb-api';
import { useAuthStore } from '@/stores/auth.store';
import { cn, generateAvatarInitials } from '@/lib/utils';

interface UserMenuProps {
  /**
   * Called for in-app navigation targets (Banter SPA routes like /settings).
   * Cross-app targets (/b3/people, /b3/superuser, /b3/login) bypass this and
   * use window.location.href directly.
   */
  onNavigate?: (path: string) => void;
  /**
   * Whether this Banter app has its own /settings route. If false, the
   * Settings menu item will navigate cross-app to /b3/settings instead.
   * Defaults to true.
   */
  hasLocalSettings?: boolean;
}

/**
 * Banter port of Bam's user avatar dropdown menu. Menu items:
 *   - name/email header (non-clickable)
 *   - Settings → onNavigate('/settings') (or /b3/settings if hasLocalSettings=false)
 *   - People → /b3/people (owner/admin/superuser only, cross-app)
 *   - SuperUser Console → /b3/superuser (is_superuser only, cross-app)
 *   - Sign out → POST /b3/api/auth/logout, redirect to /b3/login
 */
export function UserMenu({ onNavigate, hasLocalSettings = true }: UserMenuProps) {
  const user = useAuthStore((s) => s.user);

  // Bam's /auth/me returns is_superuser; the Banter auth store currently
  // doesn't surface it explicitly, so we read it off the raw object if
  // present (the shared user object includes it).
  const isSuperUser =
    (user as unknown as { is_superuser?: boolean } | null)?.is_superuser === true;
  // Wave E.D: gate the People menu entry on the per-action permission
  // for listing org members (GET /org/members → bam.org_member.list).
  // SuperUser bypass is already baked into the matrix server-side.
  const canSeePeople = useCan('bam.org_member.list');

  const handleSettings = () => {
    if (hasLocalSettings && onNavigate) {
      onNavigate('/settings');
    } else {
      window.location.href = '/b3/settings';
    }
  };

  const handleLogout = async () => {
    try {
      await bbbPost('/auth/logout');
    } catch {
      // Even on failure, redirect to login — the server will force
      // re-authentication anyway.
    }
    window.location.href = '/b3/login';
  };

  const initials = generateAvatarInitials(user?.display_name);

  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-2 rounded-lg p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="User menu"
        >
          <Avatar.Root className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            {user?.avatar_url && (
              <Avatar.Image
                src={user.avatar_url}
                alt={user.display_name}
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
            'z-50 min-w-[200px] overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-lg',
            'dark:bg-zinc-900 dark:border-zinc-700',
          )}
        >
          <RadixDropdownMenu.Label className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {user?.display_name}
            </p>
            <p className="text-xs text-zinc-500 truncate">{user?.email}</p>
          </RadixDropdownMenu.Label>

          <RadixDropdownMenu.Item
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onSelect={handleSettings}
          >
            Settings
          </RadixDropdownMenu.Item>

          {canSeePeople && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onSelect={() => {
                window.location.href = '/b3/people';
              }}
            >
              People
            </RadixDropdownMenu.Item>
          )}

          {isSuperUser && (
            <RadixDropdownMenu.Item
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onSelect={() => {
                window.location.href = '/b3/superuser';
              }}
            >
              SuperUser Console
            </RadixDropdownMenu.Item>
          )}

          <RadixDropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />

          <RadixDropdownMenu.Item
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
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
