import { useRef, useState } from 'react';
import { Zap, Activity, Power, PowerOff, Plus, Search, MoreVertical, Copy, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { useAutomationList, useAutomationStats, useEnableAutomation, useDisableAutomation, useDeleteAutomation, useDuplicateAutomation, type TriggerSource, type BoltAutomation } from '@/hooks/use-automations';
import { Badge } from '@/components/common/badge';
import { Button } from '@/components/common/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { formatRelativeTime } from '@/lib/utils';

interface HomePageProps {
  onNavigate: (path: string) => void;
}

const sourceLabels: Record<TriggerSource, string> = {
  bam: 'Bam',
  banter: 'Banter',
  beacon: 'Beacon',
  brief: 'Brief',
  helpdesk: 'Helpdesk',
  schedule: 'Schedule',
  bond: 'Bond',
  blast: 'Blast',
  board: 'Board',
  bench: 'Bench',
  bearing: 'Bearing',
  bill: 'Bill',
  book: 'Book',
  blank: 'Blank',
};

const sourceColors: Record<TriggerSource, string> = {
  bam: '#2563eb',
  banter: '#7c3aed',
  beacon: '#059669',
  brief: '#d97706',
  helpdesk: '#dc2626',
  schedule: '#6b7280',
  bond: '#0891b2',
  blast: '#db2777',
  board: '#9333ea',
  bench: '#0d9488',
  bearing: '#ea580c',
  bill: '#16a34a',
  book: '#4f46e5',
  blank: '#64748b',
};

function StatsCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: typeof Zap; color: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-5">
      <div className="flex items-center justify-center h-10 w-10 rounded-lg" style={{ backgroundColor: `${color}15` }}>
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      <div>
        <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</p>
        <p className="text-sm text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

function AutomationCard({ automation, onNavigate }: { automation: BoltAutomation; onNavigate: (path: string) => void }) {
  const enableMutation = useEnableAutomation();
  const disableMutation = useDisableAutomation();
  const deleteMutation = useDeleteAutomation();
  const duplicateMutation = useDuplicateAutomation();

  // Radix closes the menu synchronously when an item is selected, so the
  // trailing `click` retargets onto this card (the item it landed on just
  // unmounted) and fires the card's open-navigation — which, after Delete, opens
  // the automation we just deleted. Arm a brief window after any menu action and
  // ignore the card click that lands inside it. (Menu items that DO navigate call
  // onNavigate themselves, so suppressing the redundant card click is harmless.)
  const suppressNavUntilRef = useRef(0);
  const runMenuAction = (fn: () => void) => {
    try {
      fn();
    } finally {
      suppressNavUntilRef.current = Date.now() + 500;
    }
  };
  const openAutomation = () => {
    if (Date.now() < suppressNavUntilRef.current) return;
    onNavigate(`/automations/${automation.id}`);
  };

  const toggleEnabled = () => {
    if (automation.enabled) {
      disableMutation.mutate(automation.id);
    } else {
      enableMutation.mutate(automation.id);
    }
  };

  return (
    <div
      className="flex items-center gap-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors cursor-pointer"
      onClick={openAutomation}
    >
      {/* Enabled indicator */}
      <button
        onClick={(e) => { e.stopPropagation(); toggleEnabled(); }}
        className={`shrink-0 p-2 rounded-lg transition-colors ${
          automation.enabled
            ? 'bg-green-100 text-green-600 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400'
            : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-500'
        }`}
        title={automation.enabled ? 'Disable' : 'Enable'}
      >
        {automation.enabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
      </button>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {automation.name}
          </h3>
          <Badge color={sourceColors[automation.trigger_source]}>
            {sourceLabels[automation.trigger_source]}
          </Badge>
        </div>
        <p className="text-xs text-zinc-500 truncate">
          {automation.trigger_event}
          {automation.description && ` — ${automation.description}`}
        </p>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right">
          <p className="text-xs text-zinc-400">Last run</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            {automation.last_executed_at ? formatRelativeTime(automation.last_executed_at) : 'Never'}
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs text-zinc-400">Actions</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-300">{automation.actions?.length ?? 0}</p>
        </div>

        {/* Actions menu */}
        <DropdownMenu
          trigger={
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          }
        >
          <DropdownMenuItem onSelect={() => runMenuAction(() => onNavigate(`/automations/${automation.id}`))}>
            <Zap className="h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runMenuAction(() => onNavigate(`/automations/${automation.id}/executions`))}>
            <Activity className="h-4 w-4" />
            View Executions
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runMenuAction(() => duplicateMutation.mutate(automation.id))}>
            <Copy className="h-4 w-4" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={() =>
              runMenuAction(() => {
                if (window.confirm(`Delete "${automation.name}"?`)) {
                  deleteMutation.mutate(automation.id);
                }
              })
            }
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function HomePage({ onNavigate }: HomePageProps) {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<TriggerSource | undefined>(undefined);
  const [enabledFilter, setEnabledFilter] = useState<boolean | undefined>(undefined);

  const { data: statsResponse, isLoading: statsLoading } = useAutomationStats();
  const {
    data: listResponse,
    isLoading: listLoading,
    error: listError,
  } = useAutomationList({
    source: sourceFilter,
    enabled: enabledFilter,
    search: search || undefined,
  });

  const stats = statsResponse?.data;
  const automations = listResponse?.data ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Automations</h1>
          <p className="text-sm text-zinc-500 mt-1">Create trigger-condition-action workflows to automate your work.</p>
        </div>
        <Button onClick={() => onNavigate('/new')}>
          <Plus className="h-4 w-4" />
          New Automation
        </Button>
      </div>

      {/* Stats */}
      {statsLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl border border-zinc-200 dark:border-zinc-700 animate-pulse bg-zinc-100 dark:bg-zinc-800" />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-3 gap-4">
          <StatsCard label="Total Automations" value={stats.total} icon={Zap} color="#2563eb" />
          <StatsCard label="Enabled" value={stats.enabled} icon={Power} color="#059669" />
          <StatsCard label="Disabled" value={stats.disabled} icon={PowerOff} color="#6b7280" />
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Search automations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
          />
        </div>

        {/* Source chips */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSourceFilter(undefined)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              sourceFilter === undefined
                ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            }`}
          >
            All
          </button>
          {(Object.keys(sourceLabels) as TriggerSource[]).map((source) => (
            <button
              key={source}
              onClick={() => setSourceFilter(sourceFilter === source ? undefined : source)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                sourceFilter === source
                  ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
              }`}
            >
              {sourceLabels[source]}
            </button>
          ))}
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-700 pl-3">
          <button
            onClick={() => setEnabledFilter(enabledFilter === true ? undefined : true)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              enabledFilter === true
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            }`}
          >
            Enabled
          </button>
          <button
            onClick={() => setEnabledFilter(enabledFilter === false ? undefined : false)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              enabledFilter === false
                ? 'bg-zinc-300 text-zinc-700 dark:bg-zinc-600 dark:text-zinc-200'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            }`}
          >
            Disabled
          </button>
        </div>
      </div>

      {/* List */}
      {listLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : listError ? (
        <div className="flex flex-col items-center justify-center py-16 text-red-600 dark:text-red-400">
          <AlertCircle className="h-12 w-12 mb-4 opacity-60" />
          <p className="text-lg font-medium">Couldn't load automations</p>
          <p className="text-sm mt-1 text-red-500 dark:text-red-300/80">
            {(listError as Error)?.message || 'Unexpected error'}
          </p>
          <p className="text-xs mt-3 text-zinc-500">
            The stats card above may show a count from a different code path. If
            it disagrees with this list, the list query failed at the server.
          </p>
        </div>
      ) : automations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
          <Zap className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">No automations found</p>
          <p className="text-sm mt-1">Create your first automation to get started.</p>
          <Button className="mt-4" onClick={() => onNavigate('/new')}>
            <Plus className="h-4 w-4" />
            New Automation
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {automations.map((automation) => (
            <AutomationCard
              key={automation.id}
              automation={automation}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
