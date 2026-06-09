import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlowProvider,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  Archive,
  CameraIcon,
  ChevronDown,
  Download,
  Layout,
  Loader2,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { SHAPE_OPTIONS } from '@/components/canvas/node-types';
import { useDiagram, useDiagramGraph, useArchiveDiagram, useSnapshotVersion } from '@/hooks/use-diagrams';
import {
  useCreateNode,
  useUpdateNode,
  useMoveNode,
  useDeleteNode,
  useCreateEdge,
  useUpdateEdge,
  useDeleteEdge,
  useApplyLayout,
  useExport,
} from '@/hooks/use-graph';
import { nodeTypes } from '@/components/canvas/node-types';
import { Inspector } from '@/components/canvas/inspector';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { api } from '@/lib/api';
import { downloadBlob } from '@/lib/utils';
import type { BlueprintEdge, BlueprintNode } from '@/hooks/use-diagrams';

interface EditorPageProps {
  diagramId: string;
  onNavigate: (path: string) => void;
}

const LAYOUT_ALGORITHMS: { value: string; label: string }[] = [
  { value: 'layered', label: 'Layered' },
  { value: 'force', label: 'Force-directed' },
  { value: 'tree', label: 'Tree' },
  { value: 'grid', label: 'Grid' },
];

const LAYOUT_DIRECTIONS: { value: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT'; label: string }[] = [
  { value: 'DOWN', label: 'Top to bottom' },
  { value: 'RIGHT', label: 'Left to right' },
  { value: 'UP', label: 'Bottom to top' },
  { value: 'LEFT', label: 'Right to left' },
];

/* ------------------------------------------------------------------ */
/*  Graph <-> React Flow translation                                  */
/* ------------------------------------------------------------------ */

function toRfNode(n: BlueprintNode): Node {
  return {
    id: n.id,
    type: n.shape,
    position: { x: n.position_x, y: n.position_y },
    data: {
      label: n.label,
      description: n.description,
      ref_entity_type: n.ref_entity_type,
      ref_entity_id: n.ref_entity_id,
      pinned: n.pinned,
      ...(n.style ?? {}),
    },
    width: n.width,
    height: n.height,
    draggable: !n.pinned,
    parentId: n.parent_node_id ?? undefined,
    style: { width: n.width, height: n.height },
  };
}

function toRfEdge(e: BlueprintEdge): Edge {
  return {
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    sourceHandle: e.source_handle ?? undefined,
    targetHandle: e.target_handle ?? undefined,
    label: e.label ?? undefined,
    type: e.kind === 'default' || !e.kind ? 'default' : 'smoothstep',
    markerEnd:
      e.marker_end === 'arrow'
        ? { type: MarkerType.Arrow }
        : e.marker_end === 'arrowclosed'
        ? { type: MarkerType.ArrowClosed }
        : undefined,
    data: { kind: e.kind },
  };
}

/* ------------------------------------------------------------------ */
/*  Editor                                                            */
/* ------------------------------------------------------------------ */

interface PaneContextMenu {
  screen_x: number;
  screen_y: number;
  flow_x: number;
  flow_y: number;
}

function EditorInner({ diagramId, onNavigate }: EditorPageProps) {
  const diagramQuery = useDiagram(diagramId);
  const graphQuery = useDiagramGraph(diagramId);
  const archiveMutation = useArchiveDiagram();
  const snapshotMutation = useSnapshotVersion(diagramId);

  const createNode = useCreateNode(diagramId);
  const updateNode = useUpdateNode(diagramId);
  const moveNode = useMoveNode(diagramId);
  const deleteNode = useDeleteNode(diagramId);
  const createEdge = useCreateEdge(diagramId);
  const updateEdge = useUpdateEdge(diagramId);
  const deleteEdge = useDeleteEdge(diagramId);
  const applyLayout = useApplyLayout(diagramId);
  const exportMutation = useExport(diagramId);

  const diagram = diagramQuery.data?.data;
  const graph = graphQuery.data?.data;

  // Local React Flow node/edge state. We seed it from the server graph
  // on first load, then mirror changes back as the user drags/drops.
  // This avoids round-trip latency on every node-drag tick.
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [paneMenu, setPaneMenu] = useState<PaneContextMenu | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  // Sidecar maps so we can look up the original blueprint_node/edge row
  // for the inspector without re-fetching. Updated by an effect below.
  const nodesById = useMemo(() => {
    const m = new Map<string, BlueprintNode>();
    for (const n of graph?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [graph?.nodes]);
  const edgesById = useMemo(() => {
    const m = new Map<string, BlueprintEdge>();
    for (const e of graph?.edges ?? []) m.set(e.id, e);
    return m;
  }, [graph?.edges]);

  const layoutAlgorithm = diagram?.layout_algorithm ?? 'layered';
  const [layoutDirection, setLayoutDirection] = useState<'DOWN' | 'RIGHT' | 'UP' | 'LEFT'>('DOWN');
  const [selectedAlgo, setSelectedAlgo] = useState<string>(layoutAlgorithm);

  // Sync server graph -> local React Flow state whenever the query
  // refreshes. The stamp captures every server-controlled field that
  // should propagate to the canvas: position, label, shape, AND
  // width/height/style — otherwise inspector edits to those fields
  // never reach the rendered node and only "stick" the next time
  // a stamped-in field happens to change too.
  //
  // On refresh, we preserve the user's current React Flow selection
  // by re-applying the `selected` flag to nodes/edges whose ids match
  // what was previously selected. Without this, changing shape (or any
  // other server-controlled field) would silently deselect the node
  // because React Flow doesn't know the rebuilt array corresponds to
  // the old one.
  const lastGraphRef = useRef<string>('');
  useEffect(() => {
    if (!graph) return;
    const stamp = `${graph.nodes.length}:${graph.edges.length}:${graph.nodes
      .map(
        (n) =>
          `${n.id}@${n.position_x},${n.position_y}|${n.label}|${n.shape}|${n.width}x${n.height}|${JSON.stringify(n.style ?? {})}`,
      )
      .join(',')}|${graph.edges
      .map((e) => `${e.id}:${e.label ?? ''}:${e.kind}:${e.marker_end}`)
      .join(',')}`;
    if (stamp === lastGraphRef.current) return;
    lastGraphRef.current = stamp;
    setRfNodes((prev) => {
      const prevSelected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return graph.nodes.map((n) => {
        const next = toRfNode(n);
        if (prevSelected.has(n.id)) next.selected = true;
        return next;
      });
    });
    setRfEdges((prev) => {
      const prevSelected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return graph.edges.map((e) => {
        const next = toRfEdge(e);
        if (prevSelected.has(e.id)) next.selected = true;
        return next;
      });
    });
  }, [graph]);

  useEffect(() => {
    setSelectedAlgo(diagram?.layout_algorithm ?? 'layered');
  }, [diagram?.layout_algorithm]);

  /* ------------------------------------------------------------------ */
  /*  React Flow change handlers                                        */
  /* ------------------------------------------------------------------ */

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
      // Persist drag-settle and resize-settle to the server. Both
      // 'position' and 'dimensions' events arrive with a dragging/resizing
      // flag that we only persist on the FALSE transition so the API isn't
      // hit on every tick.
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          moveNode.mutate({
            nodeId: change.id,
            position_x: change.position.x,
            position_y: change.position.y,
          });
        }
        if (
          change.type === 'dimensions' &&
          change.resizing === false &&
          change.dimensions
        ) {
          updateNode.mutate({
            nodeId: change.id,
            input: {
              width: Math.round(change.dimensions.width),
              height: Math.round(change.dimensions.height),
            },
          });
        }
        if (change.type === 'remove') {
          deleteNode.mutate(change.id);
          if (selectedNodeId === change.id) setSelectedNodeId(null);
        }
      }
    },
    [moveNode, updateNode, deleteNode, selectedNodeId],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setRfEdges((eds) => applyEdgeChanges(changes, eds));
      for (const change of changes) {
        if (change.type === 'remove') {
          deleteEdge.mutate(change.id);
          if (selectedEdgeId === change.id) setSelectedEdgeId(null);
        }
      }
    },
    [deleteEdge, selectedEdgeId],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      createEdge.mutate({
        source_node_id: connection.source,
        target_node_id: connection.target,
        source_handle: connection.sourceHandle ?? null,
        target_handle: connection.targetHandle ?? null,
        marker_end: 'arrowclosed',
      });
    },
    [createEdge],
  );

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    const node = params.nodes[0];
    const edge = params.edges[0];
    setSelectedNodeId(node?.id ?? null);
    setSelectedEdgeId(node ? null : edge?.id ?? null);
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_, edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  /* ------------------------------------------------------------------ */
  /*  Keyboard shortcuts                                                */
  /* ------------------------------------------------------------------ */

  // Remember the last shape the user added so the plain "Add node" button
  // repeats that choice. Persisted across reloads via localStorage so the
  // diagram-type vocabulary the user is working in survives a refresh.
  const [lastShape, setLastShape] = useState<string>(() => {
    if (typeof window === 'undefined') return 'rounded';
    return localStorage.getItem('bp.lastShape') ?? 'rounded';
  });

  const addNodeWithShape = useCallback(
    (shape: string) => {
      createNode.mutate({
        label: 'New node',
        shape,
        position_x: 80 + Math.random() * 200,
        position_y: 80 + Math.random() * 200,
      });
      setLastShape(shape);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('bp.lastShape', shape);
        } catch {
          // ignore quota / disabled storage
        }
      }
    },
    [createNode],
  );

  const onAddNode = useCallback(() => addNodeWithShape(lastShape), [addNodeWithShape, lastShape]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (inField) return;
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onAddNode();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onAddNode]);

  /* ------------------------------------------------------------------ */
  /*  Top-bar actions                                                   */
  /* ------------------------------------------------------------------ */

  const onApplyLayout = () => {
    applyLayout.mutate({ algorithm: selectedAlgo, direction: layoutDirection });
  };

  const onSnapshot = () => {
    const label = window.prompt('Snapshot label (optional)');
    snapshotMutation.mutate(label?.trim() || null);
  };

  const onArchive = () => {
    if (!window.confirm('Archive this diagram? It will be hidden from the default list.')) return;
    archiveMutation.mutate(diagramId, {
      onSuccess: () => onNavigate('/'),
    });
  };

  const onExport = async (format: 'json' | 'mermaid') => {
    try {
      // The export endpoint returns the body directly (JSON or text/plain).
      // We hit fetch ourselves so we can read the raw response without the
      // api client mangling content-type. The endpoint accepts session
      // cookies via credentials: 'include'.
      const res = await fetch(`/blueprint/api/v1/diagrams/${diagramId}/export?format=${format}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const body = await res.text();
      const ext = format === 'mermaid' ? 'mmd' : 'json';
      const name = (diagram?.name ?? 'diagram').replace(/[^a-zA-Z0-9-_]/g, '_');
      downloadBlob(`${name}.${ext}`, body, format === 'mermaid' ? 'text/plain' : 'application/json');
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const onLinkEntity = (refType: string, refId: string) => {
    if (!selectedNodeId) return;
    api
      .post(`/diagrams/${diagramId}/nodes/${selectedNodeId}/link-entity`, {
        ref_entity_type: refType,
        ref_entity_id: refId,
      })
      .then(() => graphQuery.refetch())
      .catch((err) => window.alert(err instanceof Error ? err.message : 'Link failed'));
  };

  const onPromoteToTask = () => {
    if (!selectedNodeId) return;
    const projectId = diagram?.project_id ?? window.prompt('Project ID (uuid) to receive the new task');
    if (!projectId) return;
    api
      .post<{ data: { task_payload: Record<string, unknown> } }>(
        `/diagrams/${diagramId}/nodes/${selectedNodeId}/promote-to-task`,
        { project_id: projectId },
      )
      .then((res) => {
        const payload = res.data.task_payload;
        // The blueprint-api returns a payload the caller posts to Bam.
        // The SPA already shares Bam's session cookie so we can do the
        // second hop here without an internal service token.
        return fetch(`/b3/api/projects/${payload.project_id}/tasks`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`Task creation failed (${r.status})`);
          const json = (await r.json()) as { data?: { id?: string } };
          if (json.data?.id) {
            window.alert(`Created Bam task ${json.data.id}. Linking…`);
            return api.post(`/diagrams/${diagramId}/nodes/${selectedNodeId}/link-entity`, {
              ref_entity_type: 'bam.task',
              ref_entity_id: json.data.id,
            });
          }
        });
      })
      .then(() => graphQuery.refetch())
      .catch((err) => window.alert(err instanceof Error ? err.message : 'Promote failed'));
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                            */
  /* ------------------------------------------------------------------ */

  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edgesById.get(selectedEdgeId) ?? null : null;

  if (diagramQuery.isLoading || graphQuery.isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!diagram) {
    return (
      <div className="h-full w-full flex items-center justify-center text-zinc-500">
        Diagram not found.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      {/* Editor top-bar */}
      <div className="flex items-center gap-3 px-4 h-12 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <button
          onClick={() => onNavigate('/')}
          className="flex items-center justify-center h-8 w-8 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Back to diagrams"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {diagram.name}
            </span>
            <span className="text-[10px] uppercase tracking-wider rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 px-1.5 py-0.5 font-medium">
              {diagram.diagram_type}
            </span>
          </div>
          <div className="text-[11px] text-zinc-500 truncate">
            {graph?.nodes.length ?? 0} nodes · {graph?.edges.length ?? 0} edges
          </div>
        </div>

        {/* Split-button "Add node": clicking the body uses the last shape;
            the chevron opens a menu for picking a different shape. The
            most-recently-used shape is highlighted in the menu. */}
        <div className="inline-flex items-center rounded-md border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <button
            onClick={onAddNode}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title={`Add ${SHAPE_OPTIONS.find((s) => s.value === lastShape)?.label ?? 'node'}`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add {SHAPE_OPTIONS.find((s) => s.value === lastShape)?.label.toLowerCase() ?? 'node'}</span>
            <kbd className="ml-1 font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
              N
            </kbd>
          </button>
          <DropdownMenu
            trigger={
              <button
                className="px-1.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 border-l border-zinc-200 dark:border-zinc-700"
                title="Pick a shape"
                aria-label="Pick node shape"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            }
          >
            {SHAPE_OPTIONS.map((s) => (
              <DropdownMenuItem
                key={s.value}
                onSelect={() => addNodeWithShape(s.value)}
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="flex-1">{s.label}</span>
                {s.value === lastShape && (
                  <span className="text-[10px] text-primary-600 font-medium uppercase tracking-wide">
                    Last
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        </div>

        {/* Layout controls */}
        <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-200 dark:border-zinc-700">
          <select
            value={selectedAlgo}
            onChange={(e) => setSelectedAlgo(e.target.value)}
            className="px-2 py-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
          >
            {LAYOUT_ALGORITHMS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            value={layoutDirection}
            onChange={(e) =>
              setLayoutDirection(e.target.value as 'DOWN' | 'RIGHT' | 'UP' | 'LEFT')
            }
            className="px-2 py-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
          >
            {LAYOUT_DIRECTIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <button
            onClick={onApplyLayout}
            disabled={applyLayout.isPending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50"
          >
            {applyLayout.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Layout className="h-3.5 w-3.5" />
            )}
            Apply layout
          </button>
        </div>

        {/* Snapshot + export + archive */}
        <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-200 dark:border-zinc-700">
          <button
            onClick={onSnapshot}
            disabled={snapshotMutation.isPending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            title="Save a snapshot (version)"
          >
            {snapshotMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CameraIcon className="h-3.5 w-3.5" />
            )}
            Save snapshot
          </button>

          <DropdownMenu
            trigger={
              <button className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Download className="h-3.5 w-3.5" /> Export
              </button>
            }
          >
            <DropdownMenuItem onSelect={() => onExport('mermaid')}>
              <Download className="h-4 w-4" /> Mermaid (.mmd)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onExport('json')}>
              <Download className="h-4 w-4" /> JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => graphQuery.refetch()}>
              <RotateCcw className="h-4 w-4" /> Reload from server
            </DropdownMenuItem>
          </DropdownMenu>

          <button
            onClick={onArchive}
            disabled={archiveMutation.isPending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600 disabled:opacity-50"
            title="Archive diagram"
          >
            <Archive className="h-3.5 w-3.5" /> Archive
          </button>
        </div>
      </div>

      {/* Canvas + inspector */}
      <div className="flex flex-1 min-h-0">
        <div ref={canvasWrapRef} className="flex-1 min-w-0 relative">
          {paneMenu && (
            <div
              role="menu"
              className="absolute z-20 min-w-[180px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1"
              style={{ left: paneMenu.screen_x, top: paneMenu.screen_y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400">
                Add node
              </div>
              {SHAPE_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  role="menuitem"
                  onClick={() => {
                    createNode.mutate({
                      label: 'New node',
                      shape: s.value,
                      position_x: paneMenu.flow_x,
                      position_y: paneMenu.flow_y,
                    });
                    setLastShape(s.value);
                    try {
                      localStorage.setItem('bp.lastShape', s.value);
                    } catch {
                      // ignore quota / disabled storage
                    }
                    setPaneMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="flex-1">{s.label}</span>
                  {s.value === lastShape && (
                    <span className="text-[10px] text-primary-600 font-medium uppercase tracking-wide">
                      Last
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {exportMutation.isPending && (
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 shadow-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting…
            </div>
          )}
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onSelectionChange={onSelectionChange}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              setPaneMenu(null);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              const wrap = canvasWrapRef.current;
              if (!wrap) return;
              const rect = wrap.getBoundingClientRect();
              const mouse = event as React.MouseEvent;
              setPaneMenu({
                screen_x: mouse.clientX - rect.left,
                screen_y: mouse.clientY - rect.top,
                // The flow coordinate of the click — used so the new node
                // appears AT the cursor rather than a random offset.
                // React Flow's project() API needs the viewport transform;
                // for the MVP we approximate with relative-to-canvas pixels.
                flow_x: mouse.clientX - rect.left,
                flow_y: mouse.clientY - rect.top,
              });
            }}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeStrokeWidth={3}
              nodeColor={(n) => {
                const fill = (n.data as { fillColor?: string } | undefined)?.fillColor;
                return fill ?? '#3b82f6';
              }}
            />
          </ReactFlow>
        </div>
        <Inspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          onUpdateNode={(input) =>
            selectedNodeId && updateNode.mutate({ nodeId: selectedNodeId, input })
          }
          onUpdateEdge={(input) =>
            selectedEdgeId && updateEdge.mutate({ edgeId: selectedEdgeId, input })
          }
          onDeleteNode={() => {
            if (!selectedNodeId) return;
            if (!window.confirm('Delete this node and its connected edges?')) return;
            deleteNode.mutate(selectedNodeId);
            setSelectedNodeId(null);
          }}
          onDeleteEdge={() => {
            if (!selectedEdgeId) return;
            deleteEdge.mutate(selectedEdgeId);
            setSelectedEdgeId(null);
          }}
          onLinkEntity={onLinkEntity}
          onPromoteToTask={onPromoteToTask}
        />
      </div>
    </div>
  );
}

export function EditorPage(props: EditorPageProps) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
