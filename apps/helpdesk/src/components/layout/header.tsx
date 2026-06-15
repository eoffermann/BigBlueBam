import { useAuthStore } from '@/stores/auth.store';
import { useTenantStore } from '@/stores/tenant.store';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { LifeBuoy } from 'lucide-react';

interface HeaderProps {
  onNavigate: (path: string) => void;
}

export function Header({ onNavigate }: HeaderProps) {
  const { user } = useAuthStore();
  const { orgName, projectName } = useTenantStore();

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
        {/* Left: Logo */}
        <button
          onClick={() => onNavigate('/tickets')}
          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
        >
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
            B
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">
              {orgName ?? 'BigBlueBam'}
            </span>
            <LifeBuoy className="h-3.5 w-3.5 text-primary-500" />
            <span className="text-sm text-zinc-500">
              {projectName ? `${projectName} support` : 'Helpdesk'}
            </span>
          </div>
        </button>

        {/* Center: Navigation */}
        <nav>
          <button
            onClick={() => onNavigate('/tickets')}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
          >
            My Tickets
          </button>
        </nav>

        {/* Right: Help + User menu */}
        <div className="flex items-center gap-1">
          <HelpTrigger app="helpdesk" />
          <UserMenu user={user} />
        </div>
      </div>
    </header>
  );
}
