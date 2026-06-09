import { useEffect, useState } from 'react';
import { Link2, Lock, Trash2, Pin, PinOff, Palette } from 'lucide-react';
import type { BlueprintEdge, BlueprintNode } from '@/hooks/use-diagrams';
import type { UpdateEdgeInput, UpdateNodeInput } from '@/hooks/use-graph';
import { SHAPE_OPTIONS } from '@/components/canvas/node-types';
import { RichTextEditor } from '@/components/common/rich-text-editor';
import { cn } from '@/lib/utils';

interface InspectorProps {
  /** Either a node or an edge — whichever is currently selected. */
  selectedNode: BlueprintNode | null;
  selectedEdge: BlueprintEdge | null;
  onUpdateNode: (input: UpdateNodeInput) => void;
  onUpdateEdge: (input: UpdateEdgeInput) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
  onLinkEntity: (refType: string, refId: string) => void;
  onPromoteToTask: () => void;
}

const EDGE_KINDS: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'flow', label: 'Flow' },
  { value: 'reference', label: 'Reference' },
  { value: 'inherits', label: 'Inherits' },
];

const MARKER_END_OPTIONS: { value: string; label: string }[] = [
  { value: 'arrowclosed', label: 'Filled arrow' },
  { value: 'arrow', label: 'Open arrow' },
  { value: 'none', label: 'None' },
];

const PRESET_COLORS = [
  '#ffffff', // white
  '#fee2e2', // red-100
  '#fef3c7', // amber-100
  '#dcfce7', // green-100
  '#dbeafe', // blue-100
  '#ede9fe', // violet-100
  '#fce7f3', // pink-100
  '#f4f4f5', // zinc-100
];

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-primary-500 outline-none',
        props.className,
      )}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'w-full px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-primary-500 outline-none',
        props.className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Node panel                                                        */
/* ------------------------------------------------------------------ */

interface NodePanelProps {
  node: BlueprintNode;
  onUpdate: (input: UpdateNodeInput) => void;
  onDelete: () => void;
  onLinkEntity: (refType: string, refId: string) => void;
  onPromoteToTask: () => void;
}

function NodePanel({ node, onUpdate, onDelete, onLinkEntity, onPromoteToTask }: NodePanelProps) {
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? '');
  const [refType, setRefType] = useState(node.ref_entity_type ?? '');
  const [refId, setRefId] = useState(node.ref_entity_id ?? '');
  // Local state for the numeric size inputs so the user can finish typing
  // a multi-digit number before we round-trip. The previous version bound
  // the inputs straight to node.width/node.height which both (a) caused
  // a query-refetch race that snapped the input back mid-type and (b)
  // meant the input commit only landed when the stamp comparison
  // happened to invalidate — i.e. when shape changed too.
  const [width, setWidth] = useState(String(node.width));
  const [height, setHeight] = useState(String(node.height));
  const fillColor = (node.style?.fillColor as string | undefined) ?? '';

  // Reset local state when the selected node changes.
  useEffect(() => {
    setLabel(node.label);
    setDescription(node.description ?? '');
    setRefType(node.ref_entity_type ?? '');
    setRefId(node.ref_entity_id ?? '');
    setWidth(String(node.width));
    setHeight(String(node.height));
  }, [node.id, node.label, node.description, node.ref_entity_type, node.ref_entity_id, node.width, node.height]);

  function commitWidth() {
    const next = Number.parseInt(width, 10);
    if (!Number.isFinite(next) || next < 40 || next > 2000) {
      setWidth(String(node.width));
      return;
    }
    if (next !== node.width) onUpdate({ width: next });
  }
  function commitHeight() {
    const next = Number.parseInt(height, 10);
    if (!Number.isFinite(next) || next < 30 || next > 2000) {
      setHeight(String(node.height));
      return;
    }
    if (next !== node.height) onUpdate({ height: next });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Node</div>
          <div className="text-[11px] text-zinc-500 font-mono truncate" title={node.id}>
            {node.id.slice(0, 8)}…
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={node.pinned ? 'Unpin' : 'Pin position'}
            onClick={() => onUpdate({ pinned: !node.pinned })}
            className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {node.pinned ? <Pin className="h-4 w-4 text-primary-600" /> : <PinOff className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Delete node"
            onClick={onDelete}
            className="p-1.5 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <Field label="Label" htmlFor="bp-node-label">
        <TextInput
          id="bp-node-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== node.label && onUpdate({ label })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </Field>

      <Field label="Description">
        {/* Markdown editor shared with Bam task descriptions. The editor
            commits on every change so the user can preview before saving;
            we still debounce writes via the same commit-on-different
            pattern the other inputs use. */}
        <RichTextEditor
          value={description}
          onChange={(next) => {
            setDescription(next);
            if (next !== (node.description ?? '')) {
              onUpdate({ description: next || null });
            }
          }}
          placeholder="Describe this node… **bold**, *italic*, `code`, [links](url) all work."
          minRows={3}
          compact
        />
      </Field>

      <Field label="Shape" htmlFor="bp-node-shape">
        <Select
          id="bp-node-shape"
          value={node.shape}
          onChange={(e) => onUpdate({ shape: e.target.value })}
        >
          {SHAPE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Width" htmlFor="bp-node-width">
          <TextInput
            id="bp-node-width"
            type="number"
            min={40}
            max={2000}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            onBlur={commitWidth}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </Field>
        <Field label="Height" htmlFor="bp-node-height">
          <TextInput
            id="bp-node-height"
            type="number"
            min={30}
            max={2000}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            onBlur={commitHeight}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </Field>
      </div>

      <Field label="Fill color">
        <div className="flex items-center gap-2 flex-wrap">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onUpdate({ style: { ...node.style, fillColor: c } })}
              className={cn(
                'h-6 w-6 rounded-md border',
                fillColor === c
                  ? 'border-primary-500 ring-2 ring-primary-300'
                  : 'border-zinc-200 dark:border-zinc-700',
              )}
              style={{ background: c }}
              title={c}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              const next = { ...node.style };
              delete (next as Record<string, unknown>).fillColor;
              onUpdate({ style: next });
            }}
            className="h-6 px-2 text-[11px] rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 inline-flex items-center gap-1"
          >
            <Palette className="h-3 w-3" /> Clear
          </button>
        </div>
      </Field>

      <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          <Link2 className="h-3.5 w-3.5" />
          Linked entity
        </div>
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <TextInput
            placeholder="type"
            value={refType}
            onChange={(e) => setRefType(e.target.value)}
          />
          <TextInput
            placeholder="entity id (uuid)"
            value={refId}
            onChange={(e) => setRefId(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!refType || !refId}
            onClick={() => onLinkEntity(refType, refId)}
            className="flex-1 px-2.5 py-1.5 text-xs rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
          >
            <Link2 className="h-3.5 w-3.5" /> Link
          </button>
          <button
            type="button"
            onClick={onPromoteToTask}
            className="flex-1 px-2.5 py-1.5 text-xs rounded-md bg-primary-600 text-white hover:bg-primary-700 inline-flex items-center justify-center gap-1.5"
          >
            <Lock className="h-3.5 w-3.5" /> Promote to task
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Edge panel                                                        */
/* ------------------------------------------------------------------ */

interface EdgePanelProps {
  edge: BlueprintEdge;
  onUpdate: (input: UpdateEdgeInput) => void;
  onDelete: () => void;
}

function EdgePanel({ edge, onUpdate, onDelete }: EdgePanelProps) {
  const [label, setLabel] = useState(edge.label ?? '');

  useEffect(() => {
    setLabel(edge.label ?? '');
  }, [edge.id, edge.label]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Edge</div>
          <div className="text-[11px] text-zinc-500 font-mono truncate" title={edge.id}>
            {edge.id.slice(0, 8)}…
          </div>
        </div>
        <button
          type="button"
          title="Delete edge"
          onClick={onDelete}
          className="p-1.5 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <Field label="Label" htmlFor="bp-edge-label">
        <TextInput
          id="bp-edge-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== (edge.label ?? '') && onUpdate({ label: label || null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </Field>

      <Field label="Kind" htmlFor="bp-edge-kind">
        <Select
          id="bp-edge-kind"
          value={edge.kind}
          onChange={(e) => onUpdate({ kind: e.target.value })}
        >
          {EDGE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="End marker" htmlFor="bp-edge-marker">
        <Select
          id="bp-edge-marker"
          value={edge.marker_end}
          onChange={(e) => onUpdate({ marker_end: e.target.value })}
        >
          {MARKER_END_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inspector container                                               */
/* ------------------------------------------------------------------ */

export function Inspector({
  selectedNode,
  selectedEdge,
  onUpdateNode,
  onUpdateEdge,
  onDeleteNode,
  onDeleteEdge,
  onLinkEntity,
  onPromoteToTask,
}: InspectorProps) {
  return (
    <aside className="w-[320px] shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-y-auto custom-scrollbar">
      <div className="p-4">
        {selectedNode ? (
          <NodePanel
            node={selectedNode}
            onUpdate={onUpdateNode}
            onDelete={onDeleteNode}
            onLinkEntity={onLinkEntity}
            onPromoteToTask={onPromoteToTask}
          />
        ) : selectedEdge ? (
          <EdgePanel edge={selectedEdge} onUpdate={onUpdateEdge} onDelete={onDeleteEdge} />
        ) : (
          <EmptyState />
        )}
      </div>
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-12 px-2">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
        <Palette className="h-5 w-5 text-zinc-400" />
      </div>
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing selected</h3>
      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
        Click a node or edge to edit it.
        Press <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-[10px]">N</kbd> to add a new node.
      </p>
    </div>
  );
}
