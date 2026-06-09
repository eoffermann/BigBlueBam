import { useMemo } from 'react';
import {
  Network,
  GitBranch,
  Workflow,
  Boxes,
  ListTree,
  Sparkles,
  Star,
  Archive,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type DiagramFilterKey = 'all' | 'starred' | 'archived' | string;

interface BlueprintSidebarProps {
  activeFilter: DiagramFilterKey;
  onFilterChange: (filter: DiagramFilterKey) => void;
  diagramTypeCounts?: Record<string, number>;
  totalCount?: number;
  starredCount?: number;
  archivedCount?: number;
  onNewDiagram: () => void;
}

// The shape vocabulary the API understands. Keeping this client-side
// map authoritative for the sidebar (rather than fetching it) lets the
// nav render instantly on first paint; the per-type counts come from
// the parent which derives them off the loaded diagram list.
const DIAGRAM_TYPES: { id: string; label: string; icon: typeof Network }[] = [
  { id: 'flowchart', label: 'Flowcharts', icon: Workflow },
  { id: 'graph', label: 'Graphs', icon: Network },
  { id: 'sequence', label: 'Sequence', icon: GitBranch },
  { id: 'class', label: 'Class', icon: Boxes },
  { id: 'mindmap', label: 'Mind maps', icon: ListTree },
];

function FilterPill({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Network;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-sidebar-active text-white'
          : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {count != null && (
        <span
          className={cn(
            'text-[11px] font-semibold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center',
            active ? 'bg-white/20 text-white' : 'bg-zinc-800 text-zinc-400',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function BlueprintSidebar({
  activeFilter,
  onFilterChange,
  diagramTypeCounts,
  totalCount,
  starredCount,
  archivedCount,
  onNewDiagram,
}: BlueprintSidebarProps) {
  const sortedTypes = useMemo(() => {
    // Always show the canonical core types, but if the org has data
    // for a custom type the API surfaces we'll render that too.
    const known = new Set(DIAGRAM_TYPES.map((t) => t.id));
    const extras = Object.keys(diagramTypeCounts ?? {})
      .filter((id) => !known.has(id))
      .sort();
    return [
      ...DIAGRAM_TYPES,
      ...extras.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), icon: Layers })),
    ];
  }, [diagramTypeCounts]);

  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-600 text-white font-bold text-sm">
          <Sparkles className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold text-white">Blueprint</span>
      </div>

      {/* New diagram CTA */}
      <div className="px-3 pb-3">
        <button
          onClick={onNewDiagram}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium px-3 py-2 transition-colors shadow-sm"
        >
          <Sparkles className="h-4 w-4" />
          New diagram
        </button>
      </div>

      {/* Filter pills */}
      <nav className="flex-1 px-2 pb-3 space-y-0.5 overflow-y-auto custom-scrollbar">
        <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Library
        </div>
        <FilterPill
          active={activeFilter === 'all'}
          onClick={() => onFilterChange('all')}
          icon={Layers}
          label="All diagrams"
          count={totalCount}
        />
        <FilterPill
          active={activeFilter === 'starred'}
          onClick={() => onFilterChange('starred')}
          icon={Star}
          label="Starred"
          count={starredCount}
        />
        <FilterPill
          active={activeFilter === 'archived'}
          onClick={() => onFilterChange('archived')}
          icon={Archive}
          label="Archived"
          count={archivedCount}
        />

        <div className="px-2 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          By type
        </div>
        {sortedTypes.map((t) => (
          <FilterPill
            key={t.id}
            active={activeFilter === t.id}
            onClick={() => onFilterChange(t.id)}
            icon={t.icon}
            label={t.label}
            count={diagramTypeCounts?.[t.id] ?? 0}
          />
        ))}
      </nav>
    </div>
  );
}
