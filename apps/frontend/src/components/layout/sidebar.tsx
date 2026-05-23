import { LayoutDashboard, Settings, User, Plus, Shield, Users, UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProjects } from '@/hooks/use-projects';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';

interface SidebarProps {
  currentProjectId?: string;
  onNavigate: (path: string) => void;
  onCreateProject: () => void;
}

export function Sidebar({ currentProjectId, onNavigate, onCreateProject }: SidebarProps) {
  const { data: projectsResponse } = useProjects();
  const projects = projectsResponse?.data ?? [];
  const user = useAuthStore((s) => s.user);
  // Wave E.D: gate the People sidebar entry on the per-action permission
  // for listing org members (GET /org/members → bam.org_member.list).
  const canListOrgMembers = useCan('bam.org_member.list');

  return (
    <aside className="flex flex-col h-full w-60 bg-sidebar text-zinc-300 border-r border-zinc-800">
      <div className="flex items-center gap-2 px-4 py-4 border-b border-zinc-800">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          B
        </div>
        <span className="font-semibold text-white text-lg">Bam</span>
      </div>

      <nav className="flex-1 overflow-y-auto custom-scrollbar py-2">
        <div className="px-3 mb-1">
          <button
            onClick={() => onNavigate('/')}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm hover:bg-sidebar-hover transition-colors"
          >
            <LayoutDashboard className="h-4 w-4" />
            Dashboard
          </button>
          <button
            onClick={() => onNavigate('/my-work')}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm hover:bg-sidebar-hover transition-colors"
          >
            <User className="h-4 w-4" />
            My Work
          </button>
        </div>

        <div className="px-3 mt-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider px-3">Projects</span>
            <button
              onClick={onCreateProject}
              className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label="Create project"
              title="Create project"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onNavigate(`/projects/${project.id}/board`)}
              className={cn(
                'flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm transition-colors',
                currentProjectId === project.id
                  ? 'bg-sidebar-active text-white'
                  : 'hover:bg-sidebar-hover',
              )}
            >
              <span
                className="flex items-center justify-center h-5 w-5 rounded text-xs font-medium shrink-0"
                style={{ backgroundColor: project.color ?? '#2563eb' }}
              >
                {project.icon ?? project.name.charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{project.name}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="border-t border-zinc-800 px-3 py-2">
        {user?.is_superuser === true && (
          <button
            onClick={() => onNavigate('/superuser')}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm text-red-300 hover:bg-sidebar-hover transition-colors"
          >
            <Shield className="h-4 w-4" />
            SuperUser
          </button>
        )}
        {user?.is_superuser === true && (
          <button
            onClick={() => onNavigate('/superuser/people')}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm text-red-300 hover:bg-sidebar-hover transition-colors"
          >
            <UsersRound className="h-4 w-4" />
            All users
          </button>
        )}
        {canListOrgMembers && (
          <button
            onClick={() => onNavigate('/people')}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm hover:bg-sidebar-hover transition-colors"
          >
            <Users className="h-4 w-4" />
            People
          </button>
        )}
        <button
          onClick={() => onNavigate('/settings')}
          className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm hover:bg-sidebar-hover transition-colors"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      </div>
    </aside>
  );
}
