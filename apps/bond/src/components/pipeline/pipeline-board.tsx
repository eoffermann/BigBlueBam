import { useState, useMemo, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Search, Plus } from 'lucide-react';
import { StageColumn } from '@/components/pipeline/stage-column';
import { DealCard } from '@/components/pipeline/deal-card';
import { CreateDealDialog } from '@/components/pipeline/create-deal-dialog';
import { Button } from '@/components/common/button';
import { usePipeline } from '@/hooks/use-pipelines';
import { useDeals, useMoveDealStage, type Deal } from '@/hooks/use-deals';
import { usePipelineSync } from '@/hooks/use-pipeline-sync';
import { usePipelineStore } from '@/stores/pipeline.store';
import { usePipelineSummary } from '@/hooks/use-analytics';
import { cn, formatCurrencyCompact } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

type SwimlaneMode = 'none' | 'owner' | 'close_month';

const SWIMLANE_NONE_KEY = '__none__';
const SWIMLANE_NONE_LABEL = 'Unassigned';

function laneKeyFor(deal: Deal, mode: SwimlaneMode): string {
  if (mode === 'owner') {
    return deal.owner_id ?? SWIMLANE_NONE_KEY;
  }
  if (mode === 'close_month') {
    if (!deal.expected_close_date) return SWIMLANE_NONE_KEY;
    return deal.expected_close_date.slice(0, 7); // YYYY-MM
  }
  return SWIMLANE_NONE_KEY;
}

function laneLabelFor(deal: Deal, mode: SwimlaneMode): string {
  if (mode === 'owner') {
    return deal.owner_name ?? SWIMLANE_NONE_LABEL;
  }
  if (mode === 'close_month') {
    if (!deal.expected_close_date) return 'No close date';
    const [y, m] = deal.expected_close_date.slice(0, 7).split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  return SWIMLANE_NONE_LABEL;
}

interface PipelineBoardProps {
  onNavigate: (path: string) => void;
  pipelineId?: string;
}

export function PipelineBoard({ onNavigate, pipelineId: propPipelineId }: PipelineBoardProps) {
  const storePipelineId = usePipelineStore((s) => s.activePipelineId);
  const activePipelineId = propPipelineId ?? storePipelineId;

  const { data: pipelineData, isLoading: pipelineLoading } = usePipeline(activePipelineId);
  const pipeline = pipelineData?.data;

  const { data: dealsData, isLoading: dealsLoading } = useDeals({
    pipeline_id: activePipelineId ?? undefined,
  });
  const deals = dealsData?.data ?? [];

  const { data: summaryData } = usePipelineSummary(activePipelineId ?? undefined);
  const summary = summaryData?.data;

  const moveDealStage = useMoveDealStage();

  // T1: subscribe to live deal events on this pipeline so another viewer's
  // drags/creates/closes refresh this board within ~200ms. No-op until the
  // /bond/ws endpoint is reachable, so it never breaks the board.
  usePipelineSync(activePipelineId);

  const [search, setSearch] = useState('');
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createStageId, setCreateStageId] = useState<string>('');
  const [swimlaneMode, setSwimlaneMode] = useState<SwimlaneMode>('none');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const stages = useMemo(
    () => (pipeline?.stages ?? []).sort((a, b) => a.sort_order - b.sort_order),
    [pipeline?.stages],
  );

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of stages) {
      map.set(stage.id, []);
    }
    for (const deal of deals) {
      const filtered = search
        ? deal.name.toLowerCase().includes(search.toLowerCase()) ||
          deal.company_name?.toLowerCase().includes(search.toLowerCase())
        : true;
      if (filtered) {
        const list = map.get(deal.stage_id);
        if (list) list.push(deal);
      }
    }
    return map;
  }, [deals, stages, search]);

  // Compute an ordered list of swimlane keys observed across filtered deals.
  // Ordering: owner-mode lanes by label (alpha), close_month lanes by key
  // (chronological since keys are YYYY-MM), with unassigned lane pinned last.
  const swimlaneOrder = useMemo(() => {
    if (swimlaneMode === 'none') {
      return [{ key: SWIMLANE_NONE_KEY, label: SWIMLANE_NONE_LABEL }];
    }
    const seen = new Map<string, string>();
    for (const [, list] of dealsByStage) {
      for (const deal of list) {
        const key = laneKeyFor(deal, swimlaneMode);
        if (!seen.has(key)) seen.set(key, laneLabelFor(deal, swimlaneMode));
      }
    }
    const entries = Array.from(seen.entries())
      .filter(([k]) => k !== SWIMLANE_NONE_KEY)
      .map(([key, label]) => ({ key, label }));
    if (swimlaneMode === 'close_month') {
      entries.sort((a, b) => a.key.localeCompare(b.key));
    } else {
      entries.sort((a, b) => a.label.localeCompare(b.label));
    }
    if (seen.has(SWIMLANE_NONE_KEY)) {
      entries.push({ key: SWIMLANE_NONE_KEY, label: SWIMLANE_NONE_LABEL });
    }
    if (entries.length === 0) {
      entries.push({ key: SWIMLANE_NONE_KEY, label: SWIMLANE_NONE_LABEL });
    }
    return entries;
  }, [dealsByStage, swimlaneMode]);

  const dealsByStageAndLane = useMemo(() => {
    const nested = new Map<string, Map<string, Deal[]>>();
    for (const [stageId, list] of dealsByStage) {
      const inner = new Map<string, Deal[]>();
      for (const lane of swimlaneOrder) inner.set(lane.key, []);
      for (const deal of list) {
        const laneKey = swimlaneMode === 'none' ? SWIMLANE_NONE_KEY : laneKeyFor(deal, swimlaneMode);
        const bucket = inner.get(laneKey);
        if (bucket) bucket.push(deal);
      }
      nested.set(stageId, inner);
    }
    return nested;
  }, [dealsByStage, swimlaneMode, swimlaneOrder]);

  const activeDragDeal = activeDragId ? deals.find((d) => d.id === activeDragId) : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const dealId = active.id as string;
      const targetStageId = over.id as string;

      const deal = deals.find((d) => d.id === dealId);
      if (!deal || deal.stage_id === targetStageId) return;

      // Check if it's a valid stage
      const targetStage = stages.find((s) => s.id === targetStageId);
      if (!targetStage) return;

      moveDealStage.mutate({ dealId, stageId: targetStageId });
    },
    [deals, stages, moveDealStage],
  );

  const handleOpenDeal = useCallback(
    (dealId: string) => {
      onNavigate(`/deals/${dealId}`);
    },
    [onNavigate],
  );

  const handleAddDeal = useCallback((stageId: string) => {
    setCreateStageId(stageId);
    setCreateDialogOpen(true);
  }, []);

  if (pipelineLoading || dealsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
          No pipeline selected
        </h2>
        <p className="text-sm text-zinc-500 mb-4">
          Select a pipeline from the sidebar or create your first one.
        </p>
        <Button onClick={() => onNavigate('/settings/pipelines')}>
          <Plus className="h-4 w-4" />
          Create Pipeline
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Board header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {pipeline.name}
          </h2>
          {summary?.totals && (
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <span>{summary.totals.deal_count ?? 0} deals</span>
              <span className="text-zinc-300 dark:text-zinc-600">|</span>
              <span>Total: {formatCurrencyCompact(summary.totals.total_value)}</span>
              <span className="text-zinc-300 dark:text-zinc-600">|</span>
              <span>Weighted: {formatCurrencyCompact(summary.totals.weighted_value)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Swimlane grouping */}
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-800">
            <label className="sr-only" htmlFor="bond-swimlane-mode">Group by</label>
            <span className="px-2 text-xs text-zinc-500 select-none">Group</span>
            {(['none', 'owner', 'close_month'] as const).map((mode) => (
              <button
                key={mode}
                id={mode === 'none' ? 'bond-swimlane-mode' : undefined}
                onClick={() => setSwimlaneMode(mode)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  swimlaneMode === mode
                    ? 'bg-primary-600 text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700',
                )}
              >
                {mode === 'none' ? 'None' : mode === 'owner' ? 'Owner' : 'Close month'}
              </button>
            ))}
          </div>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search deals..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleAddDeal(stages[0]?.id ?? '')}
            disabled={stages.length === 0}
          >
            <Plus className="h-4 w-4" />
            Add Deal
          </Button>
        </div>
      </div>

      {/* Kanban board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 h-full p-4 min-w-max">
            {stages.map((stage) => {
              const stageDeals = dealsByStage.get(stage.id) ?? [];
              const laneMap = dealsByStageAndLane.get(stage.id);
              const laneGroups =
                swimlaneMode === 'none' || !laneMap
                  ? null
                  : swimlaneOrder
                      .map((lane) => ({
                        key: lane.key,
                        label: lane.label,
                        deals: laneMap.get(lane.key) ?? [],
                      }))
                      .filter((g) => g.deals.length > 0);
              return (
                <StageColumn
                  key={stage.id}
                  stage={stage}
                  deals={stageDeals}
                  swimlanes={laneGroups}
                  onOpenDeal={handleOpenDeal}
                  onAddDeal={handleAddDeal}
                />
              );
            })}
          </div>

          <DragOverlay>
            {activeDragDeal ? (
              <div className="w-[280px] opacity-90">
                <DealCard
                  deal={activeDragDeal}
                  onOpen={() => {}}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Create deal dialog */}
      <CreateDealDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        pipelineId={pipeline.id}
        stageId={createStageId}
        onSuccess={(dealId) => onNavigate(`/deals/${dealId}`)}
      />
    </div>
  );
}
