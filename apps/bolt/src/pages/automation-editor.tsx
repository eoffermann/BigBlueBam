import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Zap, Play, Save, Settings2, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import {
  useAutomation,
  useCreateAutomation,
  useUpdateAutomation,
  useTestAutomation,
  type TriggerSource,
  type BoltCondition,
  type BoltAction,
} from '@/hooks/use-automations';
import { useProjectStore } from '@/stores/project.store';
import { useGraphEditorStore } from '@/stores/graph-editor.store';
import { TriggerSelector } from '@/components/builder/trigger-selector';
import { ConditionList } from '@/components/builder/condition-list';
import { ActionList } from '@/components/builder/action-list';
import { CronEditor } from '@/components/builder/cron-editor';
import { TriggerFilterList } from '@/components/builder/trigger-filter-list';
import { GraphEditorView } from '@/components/graph/graph-editor-view';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { validateAutomationForm } from '@/lib/automation-validation';
import { validateGraph, type GraphValidationError } from '@/lib/graph-validation';
import { cn } from '@/lib/utils';
import { useBureauLocationLabel } from '@bigbluebam/bureau-client';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface AutomationEditorPageProps {
  id?: string;
  onNavigate: (path: string) => void;
}

export function AutomationEditorPage({ id, onNavigate }: AutomationEditorPageProps) {
  const isNew = !id;
  const projectId = useProjectStore((s) => s.activeProjectId);

  const { data: existing, isLoading } = useAutomation(id);
  // Bureau widget context: show the automation name, not the URL path.
  useBureauLocationLabel(existing?.data?.name ?? null);
  const createMutation = useCreateAutomation();
  const updateMutation = useUpdateAutomation();
  const testMutation = useTestAutomation();

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [triggerSource, setTriggerSource] = useState<TriggerSource | undefined>(undefined);
  const [triggerEvent, setTriggerEvent] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<Record<string, unknown>>({});
  const [cronExpression, setCronExpression] = useState('');
  const [cronTimezone, setCronTimezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  });
  const [conditions, setConditions] = useState<BoltCondition[]>([]);
  const [actions, setActions] = useState<BoltAction[]>([]);
  const [maxExecutionsPerHour, setMaxExecutionsPerHour] = useState(60);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [showFilterEditor, setShowFilterEditor] = useState(false);

  // Editor mode: simple (form) or visual (graph canvas)
  const [editorMode, setEditorMode] = useState<'simple' | 'visual'>('simple');
  const [graphErrors, setGraphErrors] = useState<GraphValidationError[]>([]);

  // Validation state
  // Only show errors after a save attempt (not on initial load)
  const [hasSubmitAttempt, setHasSubmitAttempt] = useState(false);
  const errorBannerRef = useRef<HTMLDivElement>(null);

  // Populate from existing automation
  useEffect(() => {
    if (existing?.data) {
      const a = existing.data;
      setName(a.name);
      setDescription(a.description ?? '');
      setEnabled(a.enabled);
      setTriggerSource(a.trigger_source);
      setTriggerEvent(a.trigger_event);
      setTriggerFilter(a.trigger_filter ?? {});
      setCronExpression(a.cron_expression ?? '');
      if (a.cron_timezone) setCronTimezone(a.cron_timezone);
      setConditions(a.conditions);
      setActions(a.actions);
      setMaxExecutionsPerHour(a.max_executions_per_hour);
      setCooldownSeconds(a.cooldown_seconds);

      // If the automation has a saved graph, load it and default to visual mode
      if (a.graph) {
        useGraphEditorStore.getState().loadFromGraph(a.graph);
        setEditorMode('visual');
      }
    }
  }, [existing]);

  // Make the selected node URL-addressable (`?node=<id>`) so opening the node
  // inspector is a deep link a Bureau Bring/Invite/summon can carry — the same
  // mechanism as Bam's `?task=`. Without this, node selection lived only in the
  // Zustand store, so a follower brought to the visual editor never saw which
  // node the leader had open.
  const selectedNodeId = useGraphEditorStore((s) => s.selectedNodeId);
  // Write: reflect the current selection into the URL (replaceState — no
  // history spam, and it does NOT fire popstate, so it can't loop with the
  // reader below).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get('node');
    if (selectedNodeId) {
      if (current === selectedNodeId) return;
      url.searchParams.set('node', selectedNodeId);
    } else {
      if (!current) return;
      url.searchParams.delete('node');
    }
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [selectedNodeId]);
  // Read: apply `?node=` to the store after the graph loads (re-runs on
  // `existing`, since loadFromGraph clears the selection) and on every
  // in-session popstate — which is exactly what Bring/Invite/summon dispatch
  // when they navigate the follower. Only selects a node that exists in the
  // loaded graph; clears when the param is gone.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const selectFromUrl = () => {
      const nodeId = new URLSearchParams(window.location.search).get('node');
      const store = useGraphEditorStore.getState();
      if (nodeId && store.nodes.some((n) => n.id === nodeId)) {
        if (store.selectedNodeId !== nodeId) store.selectNode(nodeId);
      } else if (!nodeId && store.selectedNodeId) {
        store.selectNode(null);
      }
    };
    selectFromUrl();
    window.addEventListener('popstate', selectFromUrl);
    return () => window.removeEventListener('popstate', selectFromUrl);
  }, [existing]);

  const validationErrors = useMemo(
    () =>
      validateAutomationForm({
        name,
        description: description || null,
        trigger_source: triggerSource as TriggerSource,
        trigger_event: triggerEvent,
        cron_timezone: cronTimezone,
        max_executions_per_hour: maxExecutionsPerHour,
        cooldown_seconds: cooldownSeconds,
      }),
    [name, description, triggerSource, triggerEvent, cronTimezone, maxExecutionsPerHour, cooldownSeconds],
  );

  const hasFormErrors = Object.keys(validationErrors).length > 0;
  const hasErrors = editorMode === 'visual' ? (hasFormErrors || graphErrors.length > 0) : hasFormErrors;
  const showErrors = hasSubmitAttempt && hasErrors;

  if (!isNew && isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  const handleSave = async (enableOnSave = false) => {
    setHasSubmitAttempt(true);

    // Run graph validation when in visual mode
    if (editorMode === 'visual') {
      const store = useGraphEditorStore.getState();
      const gErrors = validateGraph(store.nodes, store.edges);
      setGraphErrors(gErrors);
      if (gErrors.length > 0 || hasFormErrors) {
        errorBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    } else if (hasFormErrors) {
      errorBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const payload: Record<string, unknown> = {
      name,
      description: description || null,
      enabled: enableOnSave ? true : enabled,
      trigger_source: triggerSource!,
      trigger_event: triggerEvent,
      trigger_filter: Object.keys(triggerFilter).length > 0 ? triggerFilter : null,
      cron_expression: cronExpression || null,
      cron_timezone: cronTimezone,
      conditions,
      actions,
      max_executions_per_hour: maxExecutionsPerHour,
      cooldown_seconds: cooldownSeconds,
      project_id: projectId,
    };

    // Include graph payload when in visual mode
    if (editorMode === 'visual') {
      payload.graph = useGraphEditorStore.getState().toGraph();
    }

    if (isNew) {
      const result = await createMutation.mutateAsync(payload as Parameters<typeof createMutation.mutateAsync>[0]);
      onNavigate(`/automations/${result.data.id}`);
    } else {
      await updateMutation.mutateAsync({ id: id!, ...payload } as Parameters<typeof updateMutation.mutateAsync>[0]);
    }

    // Mark graph clean after successful save
    if (editorMode === 'visual') {
      useGraphEditorStore.getState().markClean();
    }
  };

  const handleTest = async () => {
    if (id) {
      // The /test route evaluates conditions against a simulated event. Seed
      // the event with the trigger filter (the closest thing to a real
      // matching payload the editor knows about) so the dry run is meaningful;
      // the route still validates with an empty object if there's no filter.
      await testMutation.mutateAsync({ id, event: triggerFilter ?? {} });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  // Build a minimal linear graph from current simple-form state
  const buildGraphFromFormState = () => {
    const store = useGraphEditorStore.getState();
    store.reset();

    const yStep = 150;
    let y = 50;

    // Trigger node
    if (triggerSource) {
      store.addNode('trigger', { x: 250, y });
      y += yStep;
    }

    // Condition nodes
    for (const _cond of conditions) {
      store.addNode('condition', { x: 250, y });
      y += yStep;
    }

    // Action nodes
    for (const _act of actions) {
      store.addNode('action', { x: 250, y });
      y += yStep;
    }

    // Wire linearly
    const nodes = useGraphEditorStore.getState().nodes;
    for (let i = 0; i < nodes.length - 1; i++) {
      store.onConnect({
        source: nodes[i]!.id,
        target: nodes[i + 1]!.id,
        sourceHandle: null,
        targetHandle: null,
      });
    }

    // Populate trigger node data from form
    if (triggerSource && nodes.length > 0) {
      store.updateNodeData(nodes[0]!.id, {
        kind: 'trigger',
        source: triggerSource,
        event: triggerEvent,
        filter: triggerFilter,
      });
    }

    // Populate condition node data
    const conditionNodes = nodes.filter((n) => n.data?.kind === 'condition');
    conditionNodes.forEach((node, i) => {
      const cond = conditions[i];
      if (cond) {
        store.updateNodeData(node.id, {
          kind: 'condition',
          field: cond.field,
          operator: cond.operator,
          value: cond.value,
          logicGroup: cond.logic_group ?? 'and',
        });
      }
    });

    // Populate action node data
    const actionNodes = nodes.filter((n) => n.data?.kind === 'action');
    actionNodes.forEach((node, i) => {
      const act = actions[i];
      if (act) {
        store.updateNodeData(node.id, {
          kind: 'action',
          mcpTool: act.mcp_tool,
          parameters: act.parameters,
          onError: act.on_error ?? 'fail',
          retryCount: act.retry_count ?? 0,
          retryDelayMs: 1000,
        });
      }
    });
  };

  // Filter entry count for the toggle label
  const filterEntryCount = Object.keys(triggerFilter).length;

  return (
    <div className="flex h-full">
      {/* Main editor area */}
      <div className={cn('flex-1 overflow-y-auto p-6', editorMode === 'visual' ? 'flex flex-col' : 'space-y-6')}>
        <div className={cn('space-y-6', editorMode === 'simple' && 'max-w-3xl mx-auto', editorMode === 'visual' && 'flex flex-col flex-1 min-h-0')}>

          {/* A7: Validation error banner */}
          {showErrors && (
            <div
              ref={errorBannerRef}
              className="rounded-xl border-2 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                    Please fix the following errors before saving:
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {Object.entries(validationErrors).map(([field, message]) => (
                      <li key={field} className="text-xs text-red-600 dark:text-red-400">
                        • {message}
                      </li>
                    ))}
                    {editorMode === 'visual' && graphErrors.map((err, i) => (
                      <li key={`graph-${i}`} className="text-xs text-red-600 dark:text-red-400">
                        • {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Title */}
          <div>
            {/* Presence: who else is viewing this saved automation. Renders
                nothing when nobody else is present, so it cannot break the
                page. Only mount once the automation has an id (unsaved drafts
                have no surface to share yet). */}
            {id && existing?.data && (
              <div className="flex justify-end mb-2">
                <PresenceChipStrip
                  url={`${window.location.origin}${window.location.pathname}`}
                  surfaceApp="bolt"
                  surfaceId={existing.data.id}
                  surfaceLabel={existing.data.name}
                />
              </div>
            )}
            <input
              type="text"
              placeholder="Automation name..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                'w-full text-2xl font-bold text-zinc-900 dark:text-zinc-100 bg-transparent border-b outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600 pb-1 transition-colors',
                showErrors && validationErrors['name']
                  ? 'border-red-500'
                  : 'border-transparent',
              )}
            />
            {showErrors && validationErrors['name'] && (
              <p className="text-xs text-red-500 mt-1">{validationErrors['name']}</p>
            )}
            <input
              type="text"
              placeholder="Add a description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full text-sm text-zinc-500 bg-transparent border-none outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600 mt-1"
            />
          </div>

          {/* Editor mode toggle */}
          <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5 w-fit">
            <button
              type="button"
              onClick={() => {
                if (editorMode === 'visual') {
                  const store = useGraphEditorStore.getState();
                  if (store.isDirty && !window.confirm('Unsaved graph changes may be lost. Switch to Simple mode?')) {
                    return;
                  }
                }
                setEditorMode('simple');
                setGraphErrors([]);
              }}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                editorMode === 'simple'
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => {
                if (editorMode === 'simple') {
                  // Load existing graph if available, otherwise build a minimal one from form state
                  const store = useGraphEditorStore.getState();
                  if (store.nodes.length === 0 && existing?.data?.graph) {
                    store.loadFromGraph(existing.data.graph);
                  } else if (store.nodes.length === 0) {
                    // Build a simple linear graph from form state
                    buildGraphFromFormState();
                  }
                }
                setEditorMode('visual');
              }}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                editorMode === 'visual'
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              Visual
            </button>
          </div>

          {/* Visual graph editor — fills remaining viewport height */}
          {editorMode === 'visual' && (
            <div className="rounded-xl border-2 border-zinc-200 dark:border-zinc-700 overflow-hidden flex-1" style={{ minHeight: 500 }}>
              <GraphEditorView />
            </div>
          )}

          {/* WHEN / IF / THEN sections — simple mode only */}
          {editorMode === 'simple' && (<>
          <div className={cn(
            'rounded-xl border-2',
            showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event'])
              ? 'border-red-400 dark:border-red-700'
              : 'border-blue-200 dark:border-blue-800/50',
          )}>
            <div className={cn(
              'px-5 py-3 border-b',
              showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event'])
                ? 'bg-red-50 dark:bg-red-900/10 border-red-300 dark:border-red-700'
                : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50',
            )}>
              <h2 className={cn(
                'text-sm font-semibold flex items-center gap-2',
                showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event'])
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-blue-700 dark:text-blue-400',
              )}>
                <Zap className="h-4 w-4" />
                WHEN — Trigger
                {showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event']) && (
                  <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                )}
              </h2>
              <p className={cn(
                'text-xs mt-0.5',
                showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event'])
                  ? 'text-red-500 dark:text-red-400/70'
                  : 'text-blue-500 dark:text-blue-400/70',
              )}>
                {showErrors && (validationErrors['trigger_source'] || validationErrors['trigger_event'])
                  ? (validationErrors['trigger_source'] || validationErrors['trigger_event'])
                  : 'Define what event starts this automation.'}
              </p>
            </div>
            <div className="p-5 bg-white dark:bg-zinc-900 space-y-4">
              <TriggerSelector
                source={triggerSource}
                eventType={triggerEvent}
                onSourceChange={setTriggerSource}
                onEventTypeChange={setTriggerEvent}
              />

              {/* Cron expression for schedule triggers */}
              {triggerSource === 'schedule' && (
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Schedule</label>
                  <CronEditor
                    value={cronExpression}
                    onChange={setCronExpression}
                    timezone={cronTimezone}
                    onTimezoneChange={setCronTimezone}
                  />
                </div>
              )}

              {/* Optional filter */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowFilterEditor(!showFilterEditor)}
                  className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                >
                  {showFilterEditor ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {filterEntryCount > 0
                    ? `Filter (${filterEntryCount} ${filterEntryCount === 1 ? 'rule' : 'rules'})`
                    : 'Add trigger filter'}
                </button>

                {showFilterEditor && (
                  <TriggerFilterList
                    value={triggerFilter}
                    onChange={setTriggerFilter}
                    triggerSource={triggerSource}
                    triggerEvent={triggerEvent}
                  />
                )}
              </div>
            </div>
          </div>

          {/* IF section (amber) */}
          <div className="rounded-xl border-2 border-amber-200 dark:border-amber-800/50 overflow-hidden">
            <div className="bg-amber-50 dark:bg-amber-900/20 px-5 py-3 border-b border-amber-200 dark:border-amber-800/50">
              <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                IF — Conditions
                <span className="text-xs font-normal text-amber-500">(optional)</span>
              </h2>
              <p className="text-xs text-amber-500 dark:text-amber-400/70 mt-0.5">
                Only run actions when these conditions are met.
              </p>
            </div>
            <div className="p-5 bg-white dark:bg-zinc-900">
              <ConditionList conditions={conditions} onChange={setConditions} triggerSource={triggerSource} triggerEvent={triggerEvent} />
            </div>
          </div>

          {/* THEN section (green) */}
          <div className="rounded-xl border-2 border-green-200 dark:border-green-800/50 overflow-hidden">
            <div className="bg-green-50 dark:bg-green-900/20 px-5 py-3 border-b border-green-200 dark:border-green-800/50">
              <h2 className="text-sm font-semibold text-green-700 dark:text-green-400 flex items-center gap-2">
                <Play className="h-4 w-4" />
                THEN — Actions
              </h2>
              <p className="text-xs text-green-500 dark:text-green-400/70 mt-0.5">
                Define the MCP tools to execute in order.
              </p>
            </div>
            <div className="p-5 bg-white dark:bg-zinc-900">
              <ActionList
                actions={actions}
                onChange={setActions}
                triggerSource={triggerSource}
                triggerEvent={triggerEvent}
              />
            </div>
          </div>
          </>)}
        </div>
      </div>

      {/* Settings sidebar */}
      <div className="w-72 shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 overflow-y-auto">
        <div className="p-5 space-y-5">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Settings</h3>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-700 dark:text-zinc-300">Enabled</label>
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                enabled ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Rate limits */}
          <div className="space-y-3">
            <Input
              label="Max Executions / Hour"
              type="number"
              min={1}
              max={1000}
              value={maxExecutionsPerHour}
              onChange={(e) => setMaxExecutionsPerHour(Number(e.target.value) || 60)}
              error={showErrors ? validationErrors['max_executions_per_hour'] : undefined}
            />
            <Input
              label="Cooldown (seconds)"
              type="number"
              min={0}
              max={3600}
              value={cooldownSeconds}
              onChange={(e) => setCooldownSeconds(Number(e.target.value) || 0)}
              error={showErrors ? validationErrors['cooldown_seconds'] : undefined}
            />
          </div>

          {/* Summary */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
            <h4 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Summary</h4>
            <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-1">
              <p>Trigger: {triggerSource ? `${triggerSource} / ${triggerEvent || '(no event)'}` : 'Not configured'}</p>
              <p>Conditions: {conditions.length === 0 ? 'None (always run)' : `${conditions.length} rule(s)`}</p>
              <p>Actions: {actions.length === 0 ? 'None' : `${actions.length} step(s)`}</p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="space-y-2 pt-2">
            {!isNew && (
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={handleTest}
                loading={testMutation.isPending}
                disabled={!id}
              >
                <Play className="h-4 w-4" />
                Test Run
              </Button>
            )}

            {testMutation.data && (
              <div
                className={cn(
                  'text-xs p-2 rounded-lg border',
                  testMutation.data.data.passed
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800'
                    : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
                )}
              >
                {testMutation.data.data.message}
              </div>
            )}
            {testMutation.isError && (
              <div className="text-xs p-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
                Test run failed. Check the trigger and conditions, then try again.
              </div>
            )}

            {/* A7: buttons stay enabled; validation runs on click */}
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => handleSave(false)}
              loading={isSaving}
            >
              <Save className="h-4 w-4" />
              Save Draft
            </Button>

            <Button
              size="sm"
              className="w-full"
              onClick={() => handleSave(true)}
              loading={isSaving}
            >
              <Zap className="h-4 w-4" />
              Save & Enable
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
