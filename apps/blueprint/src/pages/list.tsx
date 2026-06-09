import { useMemo, useState } from 'react';
import {
  Archive,
  Boxes,
  GitBranch,
  Globe,
  ListTree,
  Lock,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  Sparkles,
  Star,
  Users,
  Workflow,
  Layers,
  ChevronDown,
} from 'lucide-react';
import {
  useDiagrams,
  useTemplates,
  useStarDiagram,
  useUnstarDiagram,
  useArchiveDiagram,
  type DiagramFilter,
  type Diagram,
  type DiagramTemplate,
} from '@/hooks/use-diagrams';
import { useProjects } from '@/hooks/use-projects';
import { useCreateDiagram, useGenerateFromBam } from '@/hooks/use-diagrams';
import { Dialog } from '@/components/common/dialog';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { DiagramFilterKey } from '@/components/layout/blueprint-sidebar';

interface DiagramListPageProps {
  onNavigate: (path: string) => void;
  filter: DiagramFilterKey;
  newDialogOpen: boolean;
  onNewDialogOpenChange: (open: boolean) => void;
}

const visibilityIcon = {
  private: Lock,
  project: Users,
  organization: Globe,
};

const TYPE_ICON: Record<string, typeof Network> = {
  flowchart: Workflow,
  graph: Network,
  sequence: GitBranch,
  class: Boxes,
  mindmap: ListTree,
};

function typeIcon(diagramType: string) {
  return TYPE_ICON[diagramType] ?? Layers;
}

function filterToQuery(filter: DiagramFilterKey): DiagramFilter {
  if (filter === 'all') return {};
  if (filter === 'starred') return { starred: true };
  if (filter === 'archived') return { include_archived: true };
  return { diagram_type: filter };
}

function filterTitle(filter: DiagramFilterKey): string {
  if (filter === 'all') return 'All diagrams';
  if (filter === 'starred') return 'Starred diagrams';
  if (filter === 'archived') return 'Archived diagrams';
  return `${filter.charAt(0).toUpperCase() + filter.slice(1)} diagrams`;
}

export function DiagramListPage({
  onNavigate,
  filter,
  newDialogOpen,
  onNewDialogOpenChange,
}: DiagramListPageProps) {
  const query = useDiagrams(filterToQuery(filter));
  const starMutation = useStarDiagram();
  const unstarMutation = useUnstarDiagram();
  const archiveMutation = useArchiveDiagram();

  const [search, setSearch] = useState('');
  const [fromBamDialogOpen, setFromBamDialogOpen] = useState(false);

  const allDiagrams = query.data?.data ?? [];
  const filteredDiagrams = useMemo(() => {
    let list = allDiagrams;
    if (filter === 'archived') {
      list = list.filter((d) => d.is_archived);
    } else if (filter === 'starred') {
      list = list.filter((d) => d.starred);
    } else if (filter !== 'all') {
      list = list.filter((d) => d.diagram_type === filter && !d.is_archived);
    } else {
      list = list.filter((d) => !d.is_archived);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((d) => d.name.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [allDiagrams, filter, search]);

  return (
    <>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{filterTitle(filter)}</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Design flowcharts, graphs, and reference diagrams. Promote any node into a Bam task with one click.
            </p>
          </div>
          <div className="inline-flex items-center rounded-lg overflow-hidden shadow-sm">
            <button
              onClick={() => onNewDialogOpenChange(true)}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 transition-colors text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              New diagram
            </button>
            <DropdownMenu
              trigger={
                <button
                  className="px-2 py-2 bg-primary-700 text-white hover:bg-primary-800 border-l border-primary-500/50"
                  aria-label="More creation options"
                  title="Other ways to start a diagram"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              }
            >
              <DropdownMenuItem onSelect={() => onNewDialogOpenChange(true)}>
                <Plus className="h-4 w-4" /> Blank diagram or template
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFromBamDialogOpen(true)}>
                <Workflow className="h-4 w-4" /> From Bam project tasks…
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search diagrams…"
            className="w-full pl-10 pr-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
        </div>

        {query.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-44 rounded-xl bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
            ))}
          </div>
        ) : filteredDiagrams.length === 0 ? (
          <EmptyState filter={filter} hasSearch={!!search} onCreate={() => onNewDialogOpenChange(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDiagrams.map((d) => (
              <DiagramCard
                key={d.id}
                diagram={d}
                onOpen={() => onNavigate(`/d/${d.id}`)}
                onToggleStar={() => (d.starred ? unstarMutation.mutate(d.id) : starMutation.mutate(d.id))}
                onArchive={() => {
                  if (!window.confirm(`Archive "${d.name}"?`)) return;
                  archiveMutation.mutate(d.id);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <NewDiagramDialog
        open={newDialogOpen}
        onOpenChange={onNewDialogOpenChange}
        onCreated={(id) => onNavigate(`/d/${id}`)}
      />

      <FromBamDialog
        open={fromBamDialogOpen}
        onOpenChange={setFromBamDialogOpen}
        onCreated={(id) => onNavigate(`/d/${id}`)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Card                                                              */
/* ------------------------------------------------------------------ */

function DiagramCard({
  diagram,
  onOpen,
  onToggleStar,
  onArchive,
}: {
  diagram: Diagram;
  onOpen: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
}) {
  const VisIcon = visibilityIcon[diagram.visibility] ?? Lock;
  const TypeIcon = typeIcon(diagram.diagram_type);
  return (
    <div
      onClick={onOpen}
      className={cn(
        'group relative rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-5 hover:border-primary-300 dark:hover:border-primary-700 transition-colors cursor-pointer',
        diagram.is_archived && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-300 shrink-0">
            <TypeIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 truncate" title={diagram.name}>
              {diagram.name}
            </h3>
            <div className="text-[11px] text-zinc-500 capitalize">{diagram.diagram_type}</div>
          </div>
        </div>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onToggleStar}
            className={cn(
              'p-1 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors',
              diagram.starred && 'text-amber-500',
            )}
            title={diagram.starred ? 'Unstar' : 'Star'}
          >
            <Star className={cn('h-4 w-4', diagram.starred && 'fill-amber-500')} />
          </button>
          <DropdownMenu
            trigger={
              <button className="p-1 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            }
          >
            <DropdownMenuItem onSelect={onOpen}>
              <Sparkles className="h-4 w-4" /> Open editor
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleStar}>
              <Star className="h-4 w-4" />
              {diagram.starred ? 'Unstar' : 'Star'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive} destructive>
              <Archive className="h-4 w-4" /> Archive
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </div>
      {diagram.description && (
        <p className="text-sm text-zinc-500 line-clamp-2 mb-3 min-h-[2.5rem]">{diagram.description}</p>
      )}
      {!diagram.description && <div className="min-h-[2.5rem]" />}
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <div className="flex items-center gap-1.5">
          <VisIcon className="h-3.5 w-3.5" />
          <span className="capitalize">{diagram.visibility}</span>
        </div>
        <span>{formatRelativeTime(diagram.updated_at)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                       */
/* ------------------------------------------------------------------ */

function EmptyState({
  filter,
  hasSearch,
  onCreate,
}: {
  filter: DiagramFilterKey;
  hasSearch: boolean;
  onCreate: () => void;
}) {
  const Icon =
    filter === 'starred' ? Star : filter === 'archived' ? Archive : filter === 'all' ? Sparkles : typeIcon(filter);
  let title = 'No diagrams yet';
  let subtitle = 'Create a flowchart, graph, or system map to get started.';
  if (hasSearch) {
    title = 'No matching diagrams';
    subtitle = 'Try a different search or clear the query.';
  } else if (filter === 'starred') {
    title = 'No starred diagrams';
    subtitle = 'Star a diagram to find it here later.';
  } else if (filter === 'archived') {
    title = 'No archived diagrams';
    subtitle = 'Archived diagrams are hidden from the default list.';
  } else if (filter !== 'all') {
    title = `No ${filter} diagrams`;
    subtitle = 'Create one to start populating this view.';
  }
  return (
    <div className="text-center py-20">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-300">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-base font-medium text-zinc-700 dark:text-zinc-300">{title}</h3>
      <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>
      {!hasSearch && (
        <button
          onClick={onCreate}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium"
        >
          <Plus className="h-4 w-4" /> New diagram
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  New Diagram dialog                                                */
/* ------------------------------------------------------------------ */

interface NewDiagramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}

function NewDiagramDialog({ open, onOpenChange, onCreated }: NewDiagramDialogProps) {
  const createMutation = useCreateDiagram();
  const projectsQuery = useProjects();
  const templatesQuery = useTemplates();

  const [name, setName] = useState('');
  const [diagramType, setDiagramType] = useState('flowchart');
  const [projectId, setProjectId] = useState<string>('');
  const [visibility, setVisibility] = useState<'organization' | 'project' | 'private'>('project');
  const [templateId, setTemplateId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const projects = projectsQuery.data?.projects ?? [];
  const templates = templatesQuery.data?.data ?? [];
  const compatibleTemplates = useMemo(
    () => templates.filter((t) => t.diagram_type === diagramType || !templates.some((x) => x.diagram_type === diagramType)),
    [templates, diagramType],
  );

  const reset = () => {
    setName('');
    setDiagramType('flowchart');
    setProjectId('');
    setVisibility('project');
    setTemplateId('');
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    createMutation.mutate(
      {
        name: trimmed,
        diagram_type: diagramType,
        project_id: projectId || null,
        visibility: visibility === 'project' && !projectId ? 'private' : visibility,
        template_id: templateId || undefined,
      },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          reset();
          onCreated(res.data.id);
        },
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create diagram'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="New diagram"
      description="Pick a name, type, and (optionally) a template to start from."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="bp-new-name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Name
          </label>
          <input
            id="bp-new-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="System architecture, user flow…"
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="bp-new-type" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Type
            </label>
            <select
              id="bp-new-type"
              value={diagramType}
              onChange={(e) => setDiagramType(e.target.value)}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
            >
              <option value="flowchart">Flowchart</option>
              <option value="graph">Graph</option>
              <option value="sequence">Sequence</option>
              <option value="class">Class</option>
              <option value="mindmap">Mind map</option>
            </select>
          </div>
          <div>
            <label htmlFor="bp-new-project" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Project (optional)
            </label>
            <select
              id="bp-new-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
            >
              <option value="">None — org-wide</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">Visibility</legend>
          <div className="grid grid-cols-3 gap-2">
            <VisibilityRadio
              icon={Lock}
              value="private"
              label="Private"
              hint="Only you"
              current={visibility}
              onSelect={setVisibility}
            />
            <VisibilityRadio
              icon={Users}
              value="project"
              label="Project"
              hint={projectId ? 'Project members' : 'Org if no project'}
              current={visibility}
              onSelect={setVisibility}
            />
            <VisibilityRadio
              icon={Globe}
              value="organization"
              label="Organization"
              hint="Everyone in org"
              current={visibility}
              onSelect={setVisibility}
            />
          </div>
        </fieldset>

        <div>
          <label htmlFor="bp-new-template" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Template (optional)
          </label>
          <select
            id="bp-new-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          >
            <option value="">Blank canvas</option>
            {compatibleTemplates.map((t: DiagramTemplate) => (
              <option key={t.id} value={t.id}>
                {t.name} {t.is_system && '· system'}
              </option>
            ))}
          </select>
          {templatesQuery.isLoading && (
            <div className="text-[11px] text-zinc-500 mt-1">Loading templates…</div>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 text-sm px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="px-4 py-2 text-sm rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium disabled:opacity-50 inline-flex items-center gap-2"
          >
            {createMutation.isPending && <Sparkles className="h-4 w-4 animate-pulse" />}
            Create diagram
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function VisibilityRadio({
  icon: Icon,
  value,
  label,
  hint,
  current,
  onSelect,
}: {
  icon: typeof Lock;
  value: 'private' | 'project' | 'organization';
  label: string;
  hint: string;
  current: 'private' | 'project' | 'organization';
  onSelect: (v: 'private' | 'project' | 'organization') => void;
}) {
  const active = current === value;
  return (
    <label
      className={cn(
        'flex flex-col items-start gap-1 rounded-lg border p-3 cursor-pointer transition-colors',
        active
          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
          : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', active ? 'text-primary-600 dark:text-primary-300' : 'text-zinc-500')} />
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
      </div>
      <span className="text-[11px] text-zinc-500">{hint}</span>
      <input
        type="radio"
        name="visibility"
        value={value}
        checked={active}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  FromBamDialog                                                     */
/* ------------------------------------------------------------------ */

interface FromBamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (diagramId: string) => void;
}

function FromBamDialog({ open, onOpenChange, onCreated }: FromBamDialogProps) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data?.projects ?? [];
  const mutation = useGenerateFromBam();

  const [projectId, setProjectId] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [autoLayout, setAutoLayout] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProjectId('');
    setIncludeCompleted(false);
    setAutoLayout(true);
    setError(null);
    mutation.reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setError('Pick a Bam project to pull tasks from.');
      return;
    }
    setError(null);
    try {
      const res = await mutation.mutateAsync({
        project_id: projectId,
        include_completed: includeCompleted,
        auto_layout: autoLayout,
      });
      onCreated(res.data.diagram_id);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Generate from Bam project"
      description="Materialize a Blueprint diagram with one node per task and edges drawn from existing parent/child links. Linked nodes stay in sync with their Bam tasks afterwards."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="bp-frombam-project"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
          >
            Project
          </label>
          <select
            id="bp-frombam-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
              className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
            />
            Include completed tasks
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoLayout}
              onChange={(e) => setAutoLayout(e.target.checked)}
              className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
            />
            Run auto-layout (layered, top-to-bottom)
          </label>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 text-sm px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !projectId}
            className="px-3 py-1.5 text-sm rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
