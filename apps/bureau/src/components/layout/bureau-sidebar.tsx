import { Building2, DoorOpen, LayoutGrid, Settings, Users } from 'lucide-react';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useFloorsList } from '@/hooks/use-floors';

interface BureauSidebarProps {
  onNavigate: (path: string) => void;
  activeFloorId: string | null;
  /** True when the user is on /admin/* — used to highlight the admin section. */
  isOnAdmin: boolean;
}

function NavItem({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Building2;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors text-left',
        active
          ? 'bg-sidebar-active text-white'
          : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {badge != null && badge > 0 ? (
        <span
          className={cn(
            'text-[11px] font-semibold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center',
            active ? 'bg-white/20 text-white' : 'bg-zinc-800 text-zinc-400',
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function BureauSidebar({ onNavigate, activeFloorId, isOnAdmin }: BureauSidebarProps) {
  const user = useAuthStore((s) => s.user);
  const floorsQuery = useFloorsList();
  const floors = floorsQuery.data ?? [];

  // Admin section is gated on org admin / owner / superuser.
  // The API enforces this server-side; we hide the link to avoid confusion.
  const isOrgAdmin =
    user?.is_superuser === true ||
    user?.role === 'admin' ||
    user?.role === 'owner';

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Building2 className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold text-white">Bureau</span>
      </div>

      <nav className="flex-1 px-2 pb-3 space-y-0.5 overflow-y-auto custom-scrollbar">
        <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Floors
        </div>
        <NavItem
          active={!isOnAdmin && activeFloorId === null}
          onClick={() => onNavigate('/')}
          icon={LayoutGrid}
          label="All floors"
        />
        {floorsQuery.isLoading ? (
          <div className="px-3 py-2 text-xs text-zinc-500">Loading…</div>
        ) : null}
        {floors.map((f) => (
          <NavItem
            key={f.id}
            active={!isOnAdmin && activeFloorId === f.id}
            onClick={() => onNavigate(`/floors/${f.id}`)}
            icon={DoorOpen}
            label={f.name}
            badge={f.occupancy}
          />
        ))}

        {isOrgAdmin ? (
          <>
            <div className="px-2 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Admin
            </div>
            <NavItem
              active={isOnAdmin}
              onClick={() => onNavigate('/admin/floors')}
              icon={Settings}
              label="Edit floors"
            />
            <NavItem
              active={false}
              onClick={() => onNavigate('/admin/offices')}
              icon={Users}
              label="Offices"
            />
          </>
        ) : null}
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
