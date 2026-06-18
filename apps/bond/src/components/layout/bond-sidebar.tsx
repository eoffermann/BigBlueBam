import {
  Handshake,
  LayoutDashboard,
  Users,
  Building2,
  BarChart3,
  Settings,
  ChevronDown,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePipelineStore } from '@/stores/pipeline.store';
import { useAuthStore } from '@/stores/auth.store';
import { usePipelines } from '@/hooks/use-pipelines';
import { useState, useRef, useEffect } from 'react';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BondSidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [
  { label: 'Pipeline Board', icon: LayoutDashboard, path: '/', page: 'pipeline' },
  { label: 'Contacts', icon: Users, path: '/contacts', page: 'contacts' },
  { label: 'Companies', icon: Building2, path: '/companies', page: 'companies' },
  { label: 'Analytics', icon: BarChart3, path: '/analytics', page: 'analytics' },
  { label: 'Bond Settings', icon: Settings, path: '/settings/pipelines', page: 'settings' },
];

function PipelineScopeSelector() {
  const { data } = usePipelines();
  const pipelines = data?.data ?? [];
  const activePipelineId = usePipelineStore((s) => s.activePipelineId);
  const setActivePipeline = usePipelineStore((s) => s.setActivePipeline);
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

  // Auto-select the default pipeline (or the first) once pipelines load, so a
  // fresh visit to the board isn't stuck on "No pipeline selected".
  useEffect(() => {
    if (!activePipelineId && pipelines.length > 0) {
      const def = pipelines.find((p) => p.is_default) ?? pipelines[0];
      if (def) setActivePipeline(def.id);
    }
  }, [activePipelineId, pipelines, setActivePipeline]);

  const activePipeline = pipelines.find((p) => p.id === activePipelineId);
  const displayLabel = activePipeline ? activePipeline.name : 'Default Pipeline';

  return (
    <div ref={ref} className="relative px-2 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-sidebar-hover transition-colors"
      >
        <Handshake className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="truncate flex-1 text-left">{displayLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg py-1 max-h-64 overflow-y-auto">
          {pipelines.map((pipeline) => {
            const isActive = activePipelineId === pipeline.id;
            return (
              <button
                key={pipeline.id}
                onClick={() => { setActivePipeline(pipeline.id); setOpen(false); }}
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-zinc-300 hover:bg-sidebar-hover',
                )}
              >
                <span className="truncate">{pipeline.name}</span>
                {isActive && <Check className="h-3.5 w-3.5 text-primary-400 shrink-0" />}
              </button>
            );
          })}

          {pipelines.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500 italic">No pipelines found</div>
          )}
        </div>
      )}
    </div>
  );
}

export function BondSidebar({ onNavigate, activePage }: BondSidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Handshake className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bond</span>
      </div>

      {/* Pipeline scope selector */}
      <PipelineScopeSelector />

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
