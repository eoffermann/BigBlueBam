import { Zap, Activity, LayoutTemplate, FolderOpen, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project.store';
import { useAuthStore } from '@/stores/auth.store';
import { useProjects } from '@/hooks/use-projects';
import { useState, useRef, useEffect } from 'react';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BoltSidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [
  { label: 'Automations', icon: Zap, path: '/', page: 'home' },
  { label: 'Executions', icon: Activity, path: '/executions', page: 'executions' },
  { label: 'Templates', icon: LayoutTemplate, path: '/templates', page: 'templates' },
];

function ProjectScopeSelector() {
  const { projects } = useProjects();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const displayLabel = activeProject ? activeProject.name : 'All Projects';

  return (
    <div ref={ref} className="relative px-2 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-sidebar-hover transition-colors"
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="truncate flex-1 text-left">{displayLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg py-1 max-h-64 overflow-y-auto">
          <button
            onClick={() => { setActiveProject(null); setOpen(false); }}
            className={cn(
              'flex items-center justify-between w-full px-3 py-2 text-sm transition-colors',
              activeProjectId === null
                ? 'bg-sidebar-active text-white'
                : 'text-zinc-300 hover:bg-sidebar-hover',
            )}
          >
            <span>All Projects</span>
            {activeProjectId === null && <Check className="h-3.5 w-3.5 text-primary-400" />}
          </button>

          {projects.length > 0 && (
            <div className="my-1 h-px bg-zinc-700" />
          )}

          {projects.map((project) => {
            const isActive = activeProjectId === project.id;
            return (
              <button
                key={project.id}
                onClick={() => { setActiveProject(project.id); setOpen(false); }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-zinc-300 hover:bg-sidebar-hover',
                )}
              >
                <span
                  className="flex items-center justify-center h-5 w-5 rounded text-xs font-medium shrink-0"
                  style={{ backgroundColor: project.color ?? '#2563eb' }}
                >
                  {project.icon ?? project.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate flex-1 text-left">{project.name}</span>
                {isActive && <Check className="h-3.5 w-3.5 text-primary-400 shrink-0" />}
              </button>
            );
          })}

          {projects.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500 italic">No projects found</div>
          )}
        </div>
      )}
    </div>
  );
}

export function BoltSidebar({ onNavigate, activePage }: BoltSidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Zap className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bolt</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded px-1.5 py-0.5">
          beta
        </span>
      </div>

      {/* Project scope selector */}
      <ProjectScopeSelector />

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
