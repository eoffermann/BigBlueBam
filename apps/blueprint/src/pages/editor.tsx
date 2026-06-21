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
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnConnect,
  type OnConnectEnd,
  type OnNodesChange,
  type OnEdgesChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  Archive,
  CameraIcon,
  Check,
  ChevronDown,
  CopyPlus,
  Download,
  Grid3x3,
  History,
  Layers,
  Layout,
  Link2,
  Loader2,
  Magnet,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { SHAPE_OPTIONS } from '@/components/canvas/node-types';
import { useDiagram, useDiagramGraph, useArchiveDiagram, useSnapshotVersion } from '@/hooks/use-diagrams';
import { useDiagramSync } from '@/hooks/use-diagram-sync';
import { useDiagramAwareness } from '@/hooks/use-diagram-awareness';
import { RemoteCursorsOverlay } from '@/components/canvas/remote-cursors-overlay';
import { RemoteSelectionOverlay } from '@/components/canvas/remote-selection-overlay';
import {
  useCreateNode,
  type CreateNodeInput,
  useUpdateNode,
  useMoveNode,
  useDeleteNode,
  useDuplicateNode,
  useCreateEdge,
  useUpdateEdge,
  useDeleteEdge,
  useApplyLayout,
  useExport,
  usePromoteGraphPlan,
  type PromoteGraphPlan,
} from '@/hooks/use-graph';
import { nodeTypes } from '@/components/canvas/node-types';
import { Inspector } from '@/components/canvas/inspector';
import { EditorPanels, type EditorPanelTab } from '@/components/canvas/editor-panels';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { api } from '@/lib/api';
import { downloadBlob } from '@/lib/utils';
import type { BlueprintEdge, BlueprintNode } from '@/hooks/use-diagrams';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

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

// Snap step for the optional snap-to-grid mode. Matches the Background
// dots gap (20) so snapped boxes land exactly on the visible grid.
const SNAP_GRID_SIZE = 20;

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

// Context-menu targets the editor switches between. Only one is
// active at a time; opening any clears the others. 'connect-drop' is
// the drag-a-connection-onto-empty-canvas palette: pick a shape and a
// node is created at the drop point, pre-wired to the drag's origin.
type ConnectDropMenu = {
  kind: 'connect-drop';
  x: number;
  y: number;
  flow_x: number;
  flow_y: number;
  source_node_id: string;
  source_handle: string | null;
  /** True when the drag started from a target handle — the new node
   *  becomes the edge's SOURCE so arrows keep pointing the way the
   *  user dragged. */
  source_is_target: boolean;
};

type ContextMenuState =
  | { kind: 'pane'; x: number; y: number; flow_x: number; flow_y: number }
  | { kind: 'node'; x: number; y: number; node_id: string }
  | { kind: 'edge'; x: number; y: number; edge_id: string }
  | ConnectDropMenu
  | null;

function EditorInner({ diagramId, onNavigate }: EditorPageProps) {
  const diagramQuery = useDiagram(diagramId);
  const graphQuery = useDiagramGraph(diagramId);
  // Live document sync: refetches the graph when anyone else mutates
  // this diagram. The reconciliation effect below applies it without
  // touching the local viewport — shared document, independent camera.
  useDiagramSync(diagramId);
  // T3 awareness: live remote cursors + selection highlights. Own socket on a
  // separate channel — decoupled from the structural sync above, so it can
  // never trigger a graph refetch and can fail without affecting the editor.
  const {
    cursors: remoteCursors,
    selections: remoteSelections,
    sendCursor: sendAwarenessCursor,
    sendSelection: sendAwarenessSelection,
  } = useDiagramAwareness(diagramId);
  const archiveMutation = useArchiveDiagram();
  const snapshotMutation = useSnapshotVersion(diagramId);

  const createNode = useCreateNode(diagramId);
  const updateNode = useUpdateNode(diagramId);
  const moveNode = useMoveNode(diagramId);
  const deleteNode = useDeleteNode(diagramId);
  const duplicateNode = useDuplicateNode(diagramId);
  const promoteGraphPlan = usePromoteGraphPlan(diagramId);
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
  // Seed the selection from the `?node=` deep link at mount. Without this the
  // state starts null, and the write-effect below fires on its first run
  // (before the graph has loaded, so the read-effect can't apply the param yet)
  // sees `selectedNodeId === null` next to an existing `?node=`, and STRIPS the
  // param — so a brought/invited follower never lands on the leader's node. The
  // read-effect validates this id against the loaded graph and clears it if the
  // node turns out not to exist. (Same mount-order trap as Bam's ?task= drawer.)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('node');
  });
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  // Right-side collaboration panel (comments / collaborators / versions).
  // null = closed; the Inspector takes the right column when no panel is open.
  const [panelTab, setPanelTab] = useState<EditorPanelTab | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // Exact viewport-transformed coordinates for "create node here"
  // gestures (pane right-click, connection dropped on empty canvas).
  const { screenToFlowPosition } = useReactFlow();

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
  // Set by createNodeAndSelect: the id of a just-created node that
  // should come out of the next graph rebuild visually selected. The
  // refetch lands after the mutation resolves, so plain state wouldn't
  // survive the rebuild — React Flow only shows selection via the
  // `selected` flag on the rebuilt node objects.
  const pendingSelectRef = useRef<string | null>(null);
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
      const pending = pendingSelectRef.current;
      const pendingPresent = pending !== null && graph.nodes.some((n) => n.id === pending);
      if (pendingPresent) pendingSelectRef.current = null;
      const prevSelected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return graph.nodes.map((n) => {
        const next = toRfNode(n);
        // A freshly-created node wins selection outright; otherwise
        // carry the user's existing selection across the rebuild.
        if (pendingPresent ? n.id === pending : prevSelected.has(n.id)) next.selected = true;
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
  /*  Selected-node deep link (`?node=<id>`)                             */
  /* ------------------------------------------------------------------ */

  // Make the selected node URL-addressable so opening a node's inspector is a
  // deep link a Bureau Bring/Invite/summon can carry — the same mechanism as
  // Bam's `?task=`. Without this, node selection lived only in component state,
  // so a follower brought to a diagram never saw which node the leader had open.
  //
  // Write: reflect the current selection into the URL (replaceState — no history
  // spam, and it does NOT fire popstate, so it can't loop with the reader
  // below). The diagram route lives in the pathname (`/blueprint/d/:id`), which
  // this never touches, so the query-only rewrite can't disturb routing.
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

  // Read: apply `?node=` to the selection after the graph loads (re-runs on
  // `graph`) and on every in-session popstate — which is exactly what
  // Bring/Invite/summon dispatch when they navigate the follower. Only selects
  // a node that exists in the loaded graph; clears when the param is gone. The
  // `graph` guard keeps mount-time from clobbering a deep link before the nodes
  // are known.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const selectFromUrl = () => {
      const nodeId = new URLSearchParams(window.location.search).get('node');
      if (nodeId && (graph?.nodes.some((n) => n.id === nodeId) ?? false)) {
        setSelectedNodeId((prev) => (prev === nodeId ? prev : nodeId));
        setSelectedEdgeId(null);
      } else if (!nodeId) {
        setSelectedNodeId((prev) => (prev === null ? prev : null));
      } else if (graph) {
        // Param points to a node that isn't in the loaded graph (stale link, or
        // the seed value from the mount initializer for a deleted node). Now
        // that the graph IS known, clear the phantom selection.
        setSelectedNodeId((prev) => (prev === null ? prev : null));
      }
    };
    selectFromUrl();
    window.addEventListener('popstate', selectFromUrl);
    return () => window.removeEventListener('popstate', selectFromUrl);
  }, [graph]);

  // Mirror a *programmatic* node selection (the `?node=` deep link, or the live
  // popstate a Bring/Invite/summon dispatches) onto React Flow's `selected`
  // flag, so the followed node is visibly highlighted on the canvas — not just
  // opened in the inspector. Click-driven selection already keeps the two in
  // sync (React Flow sets `selected` and fires onSelectionChange together); this
  // covers the case where selectedNodeId changes without a canvas click, AND the
  // graph-rebuild above (which wipes selection) running on the same load tick.
  // The `changed` guard returns the same array reference when nothing differs,
  // so React bails the re-render and this can't loop with onSelectionChange.
  useEffect(() => {
    setRfNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const shouldSelect = n.id === selectedNodeId;
        if (n.selected === shouldSelect) return n;
        changed = true;
        return { ...n, selected: shouldSelect };
      });
      return changed ? next : prev;
    });
  }, [selectedNodeId, rfNodes]);

  /* ------------------------------------------------------------------ */
  /*  Delete-confirmation chokepoint (declared before onNodesChange so   */
  /*  the React Flow remove path can also route through it).             */
  /* ------------------------------------------------------------------ */

  // Three-way confirmation modal state. When the user removes a node
  // that has a linked Bam task, we surface a dialog instead of the bare
  // window.confirm so they can opt-in to also deleting the linked task.
  const [nodeDeletePrompt, setNodeDeletePrompt] = useState<{
    nodeId: string;
    label: string;
    taskId: string;
  } | null>(null);

  const doDeleteNodeRaw = useCallback(
    (nodeId: string, alsoDeleteTaskId?: string) => {
      deleteNode.mutate(nodeId, {
        onSuccess: () => {
          if (alsoDeleteTaskId) {
            fetch(`/b3/api/tasks/${alsoDeleteTaskId}`, {
              method: 'DELETE',
              credentials: 'include',
            }).catch((err) => {
              window.alert(
                `Blueprint node deleted, but the linked Bam task removal failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
        },
      });
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
    },
    [deleteNode, selectedNodeId],
  );

  const confirmAndDeleteNode = useCallback(
    (nodeId: string) => {
      const node = nodesById.get(nodeId);
      const linkedTaskId =
        node?.ref_entity_type === 'bam.task' && node.ref_entity_id
          ? node.ref_entity_id
          : null;
      if (linkedTaskId) {
        setNodeDeletePrompt({
          nodeId,
          label: node?.label || 'this node',
          taskId: linkedTaskId,
        });
        return;
      }
      if (!window.confirm('Delete this node and its connected edges?')) return;
      doDeleteNodeRaw(nodeId);
    },
    [nodesById, doDeleteNodeRaw],
  );

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
          // Roll back the React Flow local-state remove and re-route
          // through the dialog so a linked Bam-task gets the prompt.
          // The graph will refetch on settle and resync; in the meantime
          // we re-insert the node so the canvas doesn't flash. The
          // window.confirm path (no link) commits the delete promptly.
          const node = nodesById.get(change.id);
          if (node) {
            setRfNodes((nds) => {
              const stillThere = nds.some((n) => n.id === change.id);
              if (stillThere) return nds;
              return [...nds, toRfNode(node)];
            });
          }
          confirmAndDeleteNode(change.id);
        }
      }
    },
    [moveNode, updateNode, confirmAndDeleteNode, nodesById, selectedNodeId],
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

  // Dragging a connection onto empty canvas opens the add-node palette
  // at the drop point instead of silently discarding the gesture — pick
  // a shape and the node is created there, pre-wired to the origin.
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // Landed on a real handle: onConnect already made the edge.
      if (connectionState.isValid) return;
      const fromNode = connectionState.fromNode;
      if (!fromNode) return;
      const wrap = canvasWrapRef.current;
      if (!wrap) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const rect = wrap.getBoundingClientRect();
      const flow = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      setContextMenu({
        kind: 'connect-drop',
        x: point.clientX - rect.left,
        y: point.clientY - rect.top,
        flow_x: flow.x,
        flow_y: flow.y,
        source_node_id: fromNode.id,
        source_handle: connectionState.fromHandle?.id ?? null,
        source_is_target: connectionState.fromHandle?.type === 'target',
      });
    },
    [screenToFlowPosition],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const node = params.nodes[0];
      const edge = params.edges[0];
      setSelectedNodeId(node?.id ?? null);
      setSelectedEdgeId(node ? null : edge?.id ?? null);
      // Broadcast our selection so other viewers see a colored ring (T3).
      sendAwarenessSelection(
        params.nodes.map((n) => n.id),
        params.edges.map((e) => e.id),
      );
    },
    [sendAwarenessSelection],
  );

  // Broadcast our cursor (in flow coordinates) as it moves over the canvas.
  // The hook throttles sends; this handler is passive (no preventDefault), so
  // it can't interfere with React Flow's own pointer handling.
  const onAwarenessPointerMove = useCallback(
    (event: React.MouseEvent) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      sendAwarenessCursor(flow.x, flow.y);
    },
    [screenToFlowPosition, sendAwarenessCursor],
  );

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

  // Snap-to-grid: while ON, React Flow quantizes node drags to the
  // SNAP_GRID_SIZE lattice so boxes line up as you move them. Persisted
  // per-browser like the last-used shape.
  const [snapToGrid, setSnapToGrid] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('bp.snapToGrid') === '1';
  });

  const toggleSnapToGrid = useCallback(() => {
    setSnapToGrid((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('bp.snapToGrid', next ? '1' : '0');
      } catch {
        // ignore quota / disabled storage
      }
      return next;
    });
  }, []);

  // One-shot cleanup: round every existing node onto the grid. Local
  // React Flow state moves immediately for instant feedback; the
  // per-node move mutations persist + broadcast to other viewers.
  const onSnapAllToGrid = useCallback(() => {
    if (!graph) return;
    const snap = (v: number) => Math.round(v / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
    setRfNodes((nds) =>
      nds.map((rn) => ({
        ...rn,
        position: { x: snap(rn.position.x), y: snap(rn.position.y) },
      })),
    );
    for (const n of graph.nodes) {
      const sx = snap(n.position_x);
      const sy = snap(n.position_y);
      if (sx !== n.position_x || sy !== n.position_y) {
        moveNode.mutate({ nodeId: n.id, position_x: sx, position_y: sy });
      }
    }
  }, [graph, moveNode]);

  const persistLastShape = useCallback((shape: string) => {
    setLastShape(shape);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('bp.lastShape', shape);
      } catch {
        // ignore quota / disabled storage
      }
    }
  }, []);

  // Every node-creation path funnels through here so a new node is
  // always selected immediately — inspector open, ready to type. The
  // pendingSelect ref carries the React Flow `selected` flag across
  // the post-create graph refetch (see the reconciliation effect).
  const createNodeAndSelect = useCallback(
    async (input: CreateNodeInput): Promise<string | null> => {
      try {
        const res = await createNode.mutateAsync(input);
        const id = res.data.id;
        pendingSelectRef.current = id;
        setSelectedNodeId(id);
        setSelectedEdgeId(null);
        return id;
      } catch {
        return null; // surfaced via the mutation's error state
      }
    },
    [createNode],
  );

  const addNodeWithShape = useCallback(
    (shape: string) => {
      void createNodeAndSelect({
        label: 'New node',
        shape,
        position_x: 80 + Math.random() * 200,
        position_y: 80 + Math.random() * 200,
      });
      persistLastShape(shape);
    },
    [createNodeAndSelect, persistLastShape],
  );

  // Connect-drop palette pick: create the node at the drop point, then
  // wire it to the drag's origin. Edge direction follows the drag — a
  // drag out of a source handle makes the new node the target, a drag
  // out of a target handle makes it the source.
  const onAddConnectedNode = useCallback(
    (shape: string, drop: ConnectDropMenu) => {
      void (async () => {
        const id = await createNodeAndSelect({
          label: 'New node',
          shape,
          position_x: drop.flow_x,
          position_y: drop.flow_y,
        });
        if (!id) return;
        createEdge.mutate(
          drop.source_is_target
            ? {
                source_node_id: id,
                target_node_id: drop.source_node_id,
                target_handle: drop.source_handle,
                marker_end: 'arrowclosed',
              }
            : {
                source_node_id: drop.source_node_id,
                target_node_id: id,
                source_handle: drop.source_handle,
                marker_end: 'arrowclosed',
              },
        );
        persistLastShape(shape);
      })();
    },
    [createNodeAndSelect, createEdge, persistLastShape],
  );

  const onAddNode = useCallback(() => addNodeWithShape(lastShape), [addNodeWithShape, lastShape]);

  // Per-node action helpers reused by both the keyboard shortcuts and the
  // right-click menu. Returning early when nothing's selected keeps every
  // call site terse.
  const doDuplicateNode = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) return;
      duplicateNode.mutate({ nodeId });
    },
    [duplicateNode],
  );

  const doDeleteSelected = useCallback(() => {
    if (selectedNodeId) {
      confirmAndDeleteNode(selectedNodeId);
    } else if (selectedEdgeId) {
      deleteEdge.mutate(selectedEdgeId);
      setSelectedEdgeId(null);
    }
  }, [confirmAndDeleteNode, deleteEdge, selectedNodeId, selectedEdgeId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (inField) return;

      // Add a new node with the last-used shape.
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onAddNode();
        return;
      }

      // Cmd/Ctrl-D — duplicate the selected node.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        if (!selectedNodeId) return;
        e.preventDefault();
        doDuplicateNode(selectedNodeId);
        return;
      }

      // Delete/Backspace — delete the selected node or edge. React Flow's
      // built-in delete key handling fires onNodesChange/onEdgesChange
      // remove events; we wire our own here too so the keystroke also
      // triggers a mutation when ReactFlow doesn't have focus.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedNodeId && !selectedEdgeId) return;
        e.preventDefault();
        doDeleteSelected();
        return;
      }

      // Escape — close any open context menu and clear selection.
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onAddNode, selectedNodeId, selectedEdgeId, doDuplicateNode, doDeleteSelected]);

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

  // Promote-graph state. We keep it in the editor so the progress modal
  // can stream per-step status while the SPA executes the plan.
  const [promotionProgress, setPromotionProgress] = useState<{
    label: string;
    done: number;
    total: number;
    failures: string[];
    summary?: { tasks_created: number; links_created: number; reused: number };
  } | null>(null);

  const runPromoteGraph = useCallback(
    async (projectId: string, edgeDirection: PromoteGraphPlan['edge_direction']) => {
      const resp = await promoteGraphPlan.mutateAsync({
        project_id: projectId,
        edge_direction: edgeDirection,
      });
      const plan = resp.data;
      const total = plan.total_steps;
      let done = 0;
      const failures: string[] = [];
      const taskByNode = new Map<string, string>();

      setPromotionProgress({
        label: 'Creating Bam tasks…',
        done: 0,
        total,
        failures: [],
      });

      // Step 1: create one Bam task per blueprint node (or reuse the
      // existing_task_id when the node was already linked).
      for (const entry of plan.tasks_to_create) {
        if (entry.existing_task_id) {
          taskByNode.set(entry.blueprint_node_id, entry.existing_task_id);
          done += 1;
          setPromotionProgress((prev) =>
            prev ? { ...prev, done, label: `Reusing existing task for ${entry.payload.title}…` } : prev,
          );
          continue;
        }
        try {
          const res = await fetch(`/b3/api/projects/${plan.project_id}/tasks`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: entry.payload.title,
              description: entry.payload.description ?? undefined,
              phase_id: entry.payload.phase_id ?? undefined,
              sprint_id: entry.payload.sprint_id ?? undefined,
              priority: entry.payload.priority,
            }),
          });
          if (!res.ok) {
            failures.push(`Task "${entry.payload.title}": HTTP ${res.status}`);
          } else {
            const json = (await res.json()) as { data?: { id?: string } };
            if (json.data?.id) {
              taskByNode.set(entry.blueprint_node_id, json.data.id);
              // Back-link the blueprint node to the new Bam task so the
              // two-way sync hook (label/description) fires on future edits.
              await fetch(
                `/blueprint/api/v1/diagrams/${plan.diagram_id}/nodes/${entry.blueprint_node_id}/link-entity`,
                {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ref_entity_type: 'bam.task',
                    ref_entity_id: json.data.id,
                  }),
                },
              ).catch(() => {
                // back-link best-effort; the task still exists in bam
              });
            }
          }
        } catch (err) {
          failures.push(
            `Task "${entry.payload.title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        done += 1;
        setPromotionProgress((prev) =>
          prev ? { ...prev, done, label: `Created ${done}/${total}: ${entry.payload.title}` } : prev,
        );
      }

      // Step 2: wire parent/child links between the just-created tasks
      // using the new B3 Frndo Launch task_parent_links endpoint.
      setPromotionProgress((prev) =>
        prev ? { ...prev, label: 'Linking parent/child tasks…' } : prev,
      );
      let linksCreated = 0;
      for (const link of plan.parent_links_to_create) {
        const childTaskId = taskByNode.get(link.child_blueprint_node_id);
        const parentTaskId = taskByNode.get(link.parent_blueprint_node_id);
        if (!childTaskId || !parentTaskId) {
          failures.push(`Parent link skipped: missing task mapping for edge ${link.source_edge_id}`);
          done += 1;
          continue;
        }
        try {
          const res = await fetch(`/b3/api/tasks/${childTaskId}/parents`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent_task_id: parentTaskId }),
          });
          if (!res.ok) {
            failures.push(`Parent link failed: HTTP ${res.status}`);
          } else {
            linksCreated += 1;
          }
        } catch (err) {
          failures.push(`Parent link error: ${err instanceof Error ? err.message : String(err)}`);
        }
        done += 1;
        setPromotionProgress((prev) =>
          prev ? { ...prev, done } : prev,
        );
      }

      // Refresh the graph so the new ref_entity_id badges show up.
      await graphQuery.refetch();

      const reused = plan.tasks_to_create.filter((t) => t.existing_task_id).length;
      const tasksCreated = plan.tasks_to_create.length - reused - failures.filter((f) => f.startsWith('Task ')).length;
      setPromotionProgress((prev) =>
        prev
          ? {
              ...prev,
              done: total,
              label: failures.length === 0 ? 'Done!' : `Done with ${failures.length} issue(s)`,
              failures,
              summary: { tasks_created: tasksCreated, links_created: linksCreated, reused },
            }
          : prev,
      );
    },
    [promoteGraphPlan, graphQuery],
  );

  const onPromoteGraph = () => {
    const projectId =
      diagram?.project_id ??
      window.prompt(
        'Bam project ID for the new tasks (uuid). Save the diagram with a project to skip this prompt next time.',
      );
    if (!projectId) return;
    const directionInput = window.prompt(
      "Edge direction:\n  'source-parent' (default): A->B means A is the parent of B\n  'target-parent': A->B means B is the parent of A\n  'none': skip parent links",
      'source-parent',
    );
    const edgeDirection: PromoteGraphPlan['edge_direction'] =
      directionInput === 'target-parent' || directionInput === 'none'
        ? directionInput
        : 'source-parent';
    runPromoteGraph(projectId, edgeDirection).catch((err) => {
      window.alert(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
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

        {/* Collaboration panels: comments / people / version history */}
        <div className="flex items-center gap-0.5 pl-2 border-l border-zinc-200 dark:border-zinc-700">
          <PanelToggleButton
            label="Comments"
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            active={panelTab === 'comments'}
            onClick={() => setPanelTab((t) => (t === 'comments' ? null : 'comments'))}
          />
          <PanelToggleButton
            label="People"
            icon={<Users className="h-3.5 w-3.5" />}
            active={panelTab === 'collaborators'}
            onClick={() => setPanelTab((t) => (t === 'collaborators' ? null : 'collaborators'))}
          />
          <PanelToggleButton
            label="History"
            icon={<History className="h-3.5 w-3.5" />}
            active={panelTab === 'versions'}
            onClick={() => setPanelTab((t) => (t === 'versions' ? null : 'versions'))}
          />
        </div>

        {/* Snapshot + export + archive */}
        <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-200 dark:border-zinc-700">
          <PresenceChipStrip
            url={`${window.location.origin}${window.location.pathname}${window.location.search}`}
            surfaceApp="blueprint"
            surfaceId={diagramId}
            surfaceLabel={diagram.name}
          />
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
            onClick={onPromoteGraph}
            disabled={promoteGraphPlan.isPending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-sky-600 hover:bg-sky-700 text-white shadow-sm disabled:opacity-50"
            title="Create one Bam task per node and wire parent/child links"
          >
            <Workflow className="h-3.5 w-3.5" /> Promote to Bam
          </button>

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

      {/* Promote-to-Bam progress overlay */}
      {promotionProgress && (
        <PromotionProgressOverlay
          progress={promotionProgress}
          onClose={() => setPromotionProgress(null)}
        />
      )}

      {/* Delete-node prompt that surfaces linked Bam-task removal */}
      {nodeDeletePrompt && (
        <NodeDeletePromptDialog
          prompt={nodeDeletePrompt}
          onCancel={() => setNodeDeletePrompt(null)}
          onDeleteNodeOnly={() => {
            doDeleteNodeRaw(nodeDeletePrompt.nodeId);
            setNodeDeletePrompt(null);
          }}
          onDeleteBoth={() => {
            doDeleteNodeRaw(nodeDeletePrompt.nodeId, nodeDeletePrompt.taskId);
            setNodeDeletePrompt(null);
          }}
        />
      )}

      {/* Canvas + inspector */}
      <div className="flex flex-1 min-h-0">
        <div
          ref={canvasWrapRef}
          className="flex-1 min-w-0 relative"
          onMouseMove={onAwarenessPointerMove}
        >
          <CanvasContextMenu
            state={contextMenu}
            onClose={() => setContextMenu(null)}
            lastShape={lastShape}
            nodesById={nodesById}
            edgesById={edgesById}
            diagramId={diagramId}
            selectedAlgo={selectedAlgo}
            layoutDirection={layoutDirection}
            onAddNodeAt={(shape, x, y) => {
              void createNodeAndSelect({
                label: 'New node',
                shape,
                position_x: x,
                position_y: y,
              });
              persistLastShape(shape);
            }}
            onAddConnectedNode={onAddConnectedNode}
            snapToGrid={snapToGrid}
            onToggleSnap={toggleSnapToGrid}
            onSnapAllToGrid={onSnapAllToGrid}
            onChangeShape={(nodeId, shape) => updateNode.mutate({ nodeId, input: { shape } })}
            onTogglePin={(nodeId, pinned) => updateNode.mutate({ nodeId, input: { pinned } })}
            onSetFill={(nodeId, color) => {
              const cur = nodesById.get(nodeId);
              const next = { ...(cur?.style ?? {}) } as Record<string, unknown>;
              if (color === null) delete next.fillColor;
              else next.fillColor = color;
              updateNode.mutate({ nodeId, input: { style: next } });
            }}
            onDuplicate={(nodeId) => doDuplicateNode(nodeId)}
            onDeleteNode={(nodeId) => confirmAndDeleteNode(nodeId)}
            onPromoteToTask={() => onPromoteToTask()}
            onLinkEntityRequest={() => {
              const refType = window.prompt('Reference type (e.g. bam.task, beacon.entry):');
              if (!refType) return;
              const refId = window.prompt('Reference UUID:');
              if (!refId) return;
              onLinkEntity(refType, refId);
            }}
            onChangeEdgeKind={(edgeId, kind) => updateEdge.mutate({ edgeId, input: { kind } })}
            onChangeEdgeMarker={(edgeId, marker_end) =>
              updateEdge.mutate({ edgeId, input: { marker_end } })
            }
            onDeleteEdge={(edgeId) => {
              deleteEdge.mutate(edgeId);
              if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
            }}
            onApplyLayout={(algorithm, direction) => applyLayout.mutate({ algorithm, direction })}
            onSnapshot={onSnapshot}
            onExport={onExport}
            onArchive={onArchive}
          />
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
            onConnectEnd={onConnectEnd}
            snapToGrid={snapToGrid}
            snapGrid={[SNAP_GRID_SIZE, SNAP_GRID_SIZE]}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onSelectionChange={onSelectionChange}
            // React Flow's own delete-key handling. Backspace would steal
            // the keystroke from form fields elsewhere, so we restrict it
            // to the explicit Delete key; the global Esc/Delete handler
            // above also covers the case when ReactFlow isn't focused.
            deleteKeyCode={['Delete']}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              setContextMenu(null);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              const wrap = canvasWrapRef.current;
              if (!wrap) return;
              const rect = wrap.getBoundingClientRect();
              const mouse = event as React.MouseEvent;
              const flow = screenToFlowPosition({ x: mouse.clientX, y: mouse.clientY });
              setContextMenu({
                kind: 'pane',
                x: mouse.clientX - rect.left,
                y: mouse.clientY - rect.top,
                flow_x: flow.x,
                flow_y: flow.y,
              });
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              const wrap = canvasWrapRef.current;
              if (!wrap) return;
              const rect = wrap.getBoundingClientRect();
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
              setContextMenu({
                kind: 'node',
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                node_id: node.id,
              });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              const wrap = canvasWrapRef.current;
              if (!wrap) return;
              const rect = wrap.getBoundingClientRect();
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
              setContextMenu({
                kind: 'edge',
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                edge_id: edge.id,
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
          {/* T3 awareness overlays — remote cursors + selection rings. Both
              use the live viewport so they track pan/zoom; pointer-events off
              so they never intercept canvas interaction. */}
          <RemoteSelectionOverlay selections={remoteSelections} nodes={rfNodes} />
          <RemoteCursorsOverlay cursors={remoteCursors} />
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
            confirmAndDeleteNode(selectedNodeId);
          }}
          onDeleteEdge={() => {
            if (!selectedEdgeId) return;
            deleteEdge.mutate(selectedEdgeId);
            setSelectedEdgeId(null);
          }}
          onLinkEntity={onLinkEntity}
          onPromoteToTask={onPromoteToTask}
        />
        {panelTab && (
          <EditorPanels
            diagramId={diagramId}
            activeTab={panelTab}
            onTabChange={setPanelTab}
            onClose={() => setPanelTab(null)}
            selectedNodeId={selectedNodeId}
            nodesById={nodesById}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PanelToggleButton — top-bar toggles for the collaboration panels   */
/* ------------------------------------------------------------------ */

function PanelToggleButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-pressed={active}
      className={
        active
          ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300 font-medium'
          : 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }
    >
      {icon}
      {label}
    </button>
  );
}

export function EditorPage(props: EditorPageProps) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  NodeDeletePromptDialog                                            */
/* ------------------------------------------------------------------ */

interface NodeDeletePrompt {
  nodeId: string;
  label: string;
  taskId: string;
}

function NodeDeletePromptDialog({
  prompt,
  onCancel,
  onDeleteNodeOnly,
  onDeleteBoth,
}: {
  prompt: NodeDeletePrompt;
  onCancel: () => void;
  onDeleteNodeOnly: () => void;
  onDeleteBoth: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-[460px] max-w-full rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl">
        <div className="p-5 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              <Trash2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Delete "{prompt.label}"?
              </h3>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                This node is linked to a Bam task (
                <code className="font-mono text-[11px] bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
                  {prompt.taskId.slice(0, 8)}…
                </code>
                ). Removing the node removes its place on this diagram. Do you also want to
                delete the linked Bam task itself? Any subtasks, comments, time entries, and
                activity on the task will go with it.
              </p>
            </div>
          </div>
        </div>
        <div className="p-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDeleteNodeOnly}
            className="px-3 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Delete node only
          </button>
          <button
            type="button"
            onClick={onDeleteBoth}
            className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700"
          >
            Delete node + task
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PromotionProgressOverlay                                          */
/* ------------------------------------------------------------------ */

interface PromotionProgress {
  label: string;
  done: number;
  total: number;
  failures: string[];
  summary?: { tasks_created: number; links_created: number; reused: number };
}

function PromotionProgressOverlay({
  progress,
  onClose,
}: {
  progress: PromotionProgress;
  onClose: () => void;
}) {
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 100;
  const finished = progress.done >= progress.total;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="w-[420px] max-w-[92vw] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {finished ? 'Promotion complete' : 'Promoting graph to Bam tasks'}
          </div>
          {finished && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2 break-words min-h-[1.2em]">
          {progress.label}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="h-full bg-primary-600 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 text-[11px] text-zinc-500 text-right">
          {progress.done}/{progress.total} ({pct}%)
        </div>
        {progress.summary && (
          <div className="mt-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
            <div>
              Created <strong>{progress.summary.tasks_created}</strong> task
              {progress.summary.tasks_created === 1 ? '' : 's'}
              {progress.summary.reused > 0 && (
                <> · reused {progress.summary.reused} existing</>
              )}
              {progress.summary.links_created > 0 && (
                <> · wired {progress.summary.links_created} parent link
                {progress.summary.links_created === 1 ? '' : 's'}</>
              )}
              .
            </div>
          </div>
        )}
        {progress.failures.length > 0 && (
          <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 px-3 py-2 text-xs text-red-900 dark:text-red-200 max-h-[120px] overflow-auto">
            <div className="font-medium mb-1">{progress.failures.length} issue(s):</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {progress.failures.slice(0, 5).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
              {progress.failures.length > 5 && <li>… and {progress.failures.length - 5} more</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CanvasContextMenu                                                 */
/* ------------------------------------------------------------------ */

interface CanvasContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  lastShape: string;
  nodesById: Map<string, BlueprintNode>;
  edgesById: Map<string, BlueprintEdge>;
  diagramId: string;
  selectedAlgo: string;
  layoutDirection: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
  onAddNodeAt: (shape: string, x: number, y: number) => void;
  onAddConnectedNode: (shape: string, drop: ConnectDropMenu) => void;
  snapToGrid: boolean;
  onToggleSnap: () => void;
  onSnapAllToGrid: () => void;
  onChangeShape: (nodeId: string, shape: string) => void;
  onTogglePin: (nodeId: string, pinned: boolean) => void;
  onSetFill: (nodeId: string, color: string | null) => void;
  onDuplicate: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onPromoteToTask: () => void;
  onLinkEntityRequest: () => void;
  onChangeEdgeKind: (edgeId: string, kind: string) => void;
  onChangeEdgeMarker: (edgeId: string, marker: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onApplyLayout: (algorithm: string, direction: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT') => void;
  onSnapshot: () => void;
  onExport: (format: 'json' | 'mermaid') => void;
  onArchive: () => void;
}

const CONTEXT_COLOR_OPTIONS: { value: string | null; label: string; swatch: string }[] = [
  { value: '#ffffff', label: 'White', swatch: '#ffffff' },
  { value: '#fee2e2', label: 'Red', swatch: '#fee2e2' },
  { value: '#fef3c7', label: 'Amber', swatch: '#fef3c7' },
  { value: '#dcfce7', label: 'Green', swatch: '#dcfce7' },
  { value: '#dbeafe', label: 'Blue', swatch: '#dbeafe' },
  { value: '#ede9fe', label: 'Violet', swatch: '#ede9fe' },
  { value: '#fce7f3', label: 'Pink', swatch: '#fce7f3' },
  { value: '#f4f4f5', label: 'Zinc', swatch: '#f4f4f5' },
  { value: null, label: 'Clear', swatch: 'transparent' },
];

function CanvasContextMenu({
  state,
  onClose,
  lastShape,
  nodesById,
  edgesById,
  selectedAlgo,
  layoutDirection,
  onAddNodeAt,
  onAddConnectedNode,
  snapToGrid,
  onToggleSnap,
  onSnapAllToGrid,
  onChangeShape,
  onTogglePin,
  onSetFill,
  onDuplicate,
  onDeleteNode,
  onPromoteToTask,
  onLinkEntityRequest,
  onChangeEdgeKind,
  onChangeEdgeMarker,
  onDeleteEdge,
  onApplyLayout,
  onSnapshot,
  onExport,
  onArchive,
}: CanvasContextMenuProps) {
  if (!state) return null;

  // Convenience runner: every menu item closes the menu after firing.
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl';

  return (
    <>
      {/* Click-away veil. Sits beneath the menu and absorbs the next
          click so the user dismisses by clicking anywhere else. */}
      <div className="fixed inset-0 z-10" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        role="menu"
        className="absolute z-20 min-w-[220px] max-w-[260px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-1 text-sm"
        style={{ left: state.x, top: state.y }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {state.kind === 'pane' && (
          <PaneMenuContent
            lastShape={lastShape}
            selectedAlgo={selectedAlgo}
            layoutDirection={layoutDirection}
            snapToGrid={snapToGrid}
            run={run}
            onAddNodeAt={(shape) => onAddNodeAt(shape, state.flow_x, state.flow_y)}
            onToggleSnap={onToggleSnap}
            onSnapAllToGrid={onSnapAllToGrid}
            onApplyLayout={onApplyLayout}
            onSnapshot={onSnapshot}
            onExport={onExport}
            onArchive={onArchive}
          />
        )}
        {state.kind === 'connect-drop' && (
          <ConnectDropMenuContent
            lastShape={lastShape}
            run={run}
            onPick={(shape) => onAddConnectedNode(shape, state)}
          />
        )}
        {state.kind === 'node' &&
          (() => {
            const node = nodesById.get(state.node_id);
            if (!node) return <NoTargetMissing label="Node" />;
            return (
              <NodeMenuContent
                node={node}
                modKey={modKey}
                run={run}
                onChangeShape={(shape) => onChangeShape(node.id, shape)}
                onTogglePin={() => onTogglePin(node.id, !node.pinned)}
                onSetFill={(c) => onSetFill(node.id, c)}
                onDuplicate={() => onDuplicate(node.id)}
                onDelete={() => onDeleteNode(node.id)}
                onPromoteToTask={onPromoteToTask}
                onLinkEntityRequest={onLinkEntityRequest}
              />
            );
          })()}
        {state.kind === 'edge' &&
          (() => {
            const edge = edgesById.get(state.edge_id);
            if (!edge) return <NoTargetMissing label="Edge" />;
            return (
              <EdgeMenuContent
                edge={edge}
                run={run}
                onChangeKind={(kind) => onChangeEdgeKind(edge.id, kind)}
                onChangeMarker={(marker) => onChangeEdgeMarker(edge.id, marker)}
                onDelete={() => onDeleteEdge(edge.id)}
              />
            );
          })()}
      </div>
    </>
  );
}

function NoTargetMissing({ label }: { label: string }) {
  return (
    <div className="px-3 py-3 text-xs text-zinc-500">
      {label} no longer exists. Close this menu and try again.
    </div>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-400 select-none">
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  icon,
  children,
  shortcut,
  destructive,
  trailing,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  shortcut?: string;
  destructive?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={
        'w-full flex items-center gap-2 px-3 py-1.5 text-left ' +
        (destructive
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 dark:text-red-400'
          : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800')
      }
    >
      {icon && <span className="shrink-0 w-4 inline-flex items-center justify-center">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
      {shortcut && (
        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{shortcut}</span>
      )}
    </button>
  );
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />;
}

/* ------ Pane menu ------ */

function PaneMenuContent({
  lastShape,
  selectedAlgo,
  layoutDirection,
  snapToGrid,
  run,
  onAddNodeAt,
  onToggleSnap,
  onSnapAllToGrid,
  onApplyLayout,
  onSnapshot,
  onExport,
  onArchive,
}: {
  lastShape: string;
  selectedAlgo: string;
  layoutDirection: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
  snapToGrid: boolean;
  run: (fn: () => void) => () => void;
  onAddNodeAt: (shape: string) => void;
  onToggleSnap: () => void;
  onSnapAllToGrid: () => void;
  onApplyLayout: (algorithm: string, direction: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT') => void;
  onSnapshot: () => void;
  onExport: (format: 'json' | 'mermaid') => void;
  onArchive: () => void;
}) {
  return (
    <>
      <MenuLabel>Add node</MenuLabel>
      {SHAPE_OPTIONS.map((s) => (
        <MenuItem
          key={s.value}
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={run(() => onAddNodeAt(s.value))}
          trailing={
            s.value === lastShape ? (
              <span className="text-[9px] text-primary-600 font-medium uppercase tracking-wide">
                Last
              </span>
            ) : null
          }
        >
          {s.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Reorganize</MenuLabel>
      {LAYOUT_ALGORITHMS.map((algo) => (
        <MenuItem
          key={algo.value}
          icon={<Layout className="h-3.5 w-3.5" />}
          onClick={run(() => onApplyLayout(algo.value, layoutDirection))}
          trailing={
            algo.value === selectedAlgo ? (
              <span className="text-[9px] text-zinc-400 uppercase tracking-wide">Current</span>
            ) : null
          }
        >
          {algo.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Align</MenuLabel>
      <MenuItem
        icon={<Magnet className="h-3.5 w-3.5" />}
        onClick={run(onToggleSnap)}
        trailing={
          snapToGrid ? (
            <Check className="h-3.5 w-3.5 text-primary-600" aria-hidden="true" />
          ) : null
        }
      >
        Snap to grid
      </MenuItem>
      <MenuItem icon={<Grid3x3 className="h-3.5 w-3.5" />} onClick={run(onSnapAllToGrid)}>
        Snap nodes to grid now
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<CameraIcon className="h-3.5 w-3.5" />} onClick={run(onSnapshot)}>
        Save snapshot
      </MenuItem>
      <MenuItem
        icon={<Download className="h-3.5 w-3.5" />}
        onClick={run(() => onExport('mermaid'))}
      >
        Export as Mermaid
      </MenuItem>
      <MenuItem icon={<Download className="h-3.5 w-3.5" />} onClick={run(() => onExport('json'))}>
        Export as JSON
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Archive className="h-3.5 w-3.5" />} onClick={run(onArchive)} destructive>
        Archive diagram
      </MenuItem>
    </>
  );
}

/* ------ Connect-drop menu (connection released over empty canvas) ------ */

function ConnectDropMenuContent({
  lastShape,
  run,
  onPick,
}: {
  lastShape: string;
  run: (fn: () => void) => () => void;
  onPick: (shape: string) => void;
}) {
  return (
    <>
      <MenuLabel>Add connected node</MenuLabel>
      {SHAPE_OPTIONS.map((s) => (
        <MenuItem
          key={s.value}
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={run(() => onPick(s.value))}
          trailing={
            s.value === lastShape ? (
              <span className="text-[9px] text-primary-600 font-medium uppercase tracking-wide">
                Last
              </span>
            ) : null
          }
        >
          {s.label}
        </MenuItem>
      ))}
    </>
  );
}

/* ------ Node menu ------ */

function NodeMenuContent({
  node,
  modKey,
  run,
  onChangeShape,
  onTogglePin,
  onSetFill,
  onDuplicate,
  onDelete,
  onPromoteToTask,
  onLinkEntityRequest,
}: {
  node: BlueprintNode;
  modKey: string;
  run: (fn: () => void) => () => void;
  onChangeShape: (shape: string) => void;
  onTogglePin: () => void;
  onSetFill: (color: string | null) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPromoteToTask: () => void;
  onLinkEntityRequest: () => void;
}) {
  const currentFill = (node.style?.fillColor as string | undefined) ?? null;
  return (
    <>
      <MenuItem
        icon={<CopyPlus className="h-3.5 w-3.5" />}
        onClick={run(onDuplicate)}
        shortcut={`${modKey}+D`}
      >
        Duplicate
      </MenuItem>
      <MenuItem
        icon={node.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        onClick={run(onTogglePin)}
      >
        {node.pinned ? 'Unpin (allow auto-layout)' : 'Pin position'}
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Change shape</MenuLabel>
      {SHAPE_OPTIONS.map((s) => (
        <MenuItem
          key={s.value}
          icon={<Square className="h-3.5 w-3.5" />}
          onClick={run(() => onChangeShape(s.value))}
          trailing={
            s.value === node.shape ? (
              <Check className="h-3.5 w-3.5 text-primary-600" />
            ) : null
          }
        >
          {s.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Fill color</MenuLabel>
      <div className="px-3 py-1.5 flex flex-wrap gap-1.5">
        {CONTEXT_COLOR_OPTIONS.map((c) => (
          <button
            key={c.label}
            onClick={run(() => onSetFill(c.value))}
            title={c.label}
            className={
              'h-5 w-5 rounded-md border ' +
              (currentFill === c.value
                ? 'border-primary-500 ring-2 ring-primary-300'
                : 'border-zinc-200 dark:border-zinc-700')
            }
            style={{ background: c.swatch === 'transparent' ? undefined : c.swatch }}
          >
            {c.value === null && (
              <span className="block text-[9px] leading-5 text-zinc-500">×</span>
            )}
          </button>
        ))}
      </div>
      <MenuSeparator />
      <MenuItem icon={<Link2 className="h-3.5 w-3.5" />} onClick={run(onLinkEntityRequest)}>
        Link to entity…
      </MenuItem>
      <MenuItem icon={<Layers className="h-3.5 w-3.5" />} onClick={run(onPromoteToTask)}>
        Promote to Bam task
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={run(onDelete)}
        shortcut="Del"
        destructive
      >
        Delete node
      </MenuItem>
    </>
  );
}

/* ------ Edge menu ------ */

const EDGE_KINDS_MENU: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'flow', label: 'Flow' },
  { value: 'reference', label: 'Reference' },
  { value: 'inherits', label: 'Inherits' },
];

const EDGE_MARKERS_MENU: { value: string; label: string }[] = [
  { value: 'arrowclosed', label: 'Filled arrow' },
  { value: 'arrow', label: 'Open arrow' },
  { value: 'none', label: 'No arrow' },
];

function EdgeMenuContent({
  edge,
  run,
  onChangeKind,
  onChangeMarker,
  onDelete,
}: {
  edge: BlueprintEdge;
  run: (fn: () => void) => () => void;
  onChangeKind: (kind: string) => void;
  onChangeMarker: (marker: string) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <MenuLabel>Edge kind</MenuLabel>
      {EDGE_KINDS_MENU.map((k) => (
        <MenuItem
          key={k.value}
          onClick={run(() => onChangeKind(k.value))}
          trailing={
            k.value === edge.kind ? (
              <Check className="h-3.5 w-3.5 text-primary-600" />
            ) : null
          }
        >
          {k.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>End marker</MenuLabel>
      {EDGE_MARKERS_MENU.map((m) => (
        <MenuItem
          key={m.value}
          onClick={run(() => onChangeMarker(m.value))}
          trailing={
            m.value === edge.marker_end ? (
              <Check className="h-3.5 w-3.5 text-primary-600" />
            ) : null
          }
        >
          {m.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={run(onDelete)}
        shortcut="Del"
        destructive
      >
        Delete edge
      </MenuItem>
    </>
  );
}
