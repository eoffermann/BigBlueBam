/**
 * Custom React Flow node renderers, one per shape vocabulary entry the
 * blueprint-api recognizes.
 *
 * Every shape uses the same payload contract:
 *
 *   data: { label, description?, ref_entity_type?, ref_entity_id?, ...style }
 *
 * The visual shells (`bp-node-shell`) are styled with Tailwind so they pick
 * up the BigBlueBam zinc/blue palette and dark-mode tokens. Selection state
 * is driven by React Flow itself via the `.react-flow__node.selected`
 * class which our `globals.css` translates to an outline ring.
 *
 * Adding a new shape: drop another `<Shape>Node` component below, register
 * it in the exported `nodeTypes` map. The shape strings here must match
 * what `apps/blueprint-api` writes into `blueprint_nodes.shape`.
 */
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BlueprintNodeData extends Record<string, unknown> {
  label: string;
  description?: string | null;
  ref_entity_type?: string | null;
  ref_entity_id?: string | null;
  fillColor?: string;
  textColor?: string;
  borderColor?: string;
  pinned?: boolean;
}

function NodeHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
    </>
  );
}

/**
 * Resizer for the selected node. Rendered only when `selected` is true so
 * the eight corner/edge handles don't crowd the diagram when nothing is
 * picked. Minimum size matches the inspector's numeric bounds; the
 * resize-end handler in editor.tsx persists the new width/height.
 */
function SelectedResizer({ selected }: { selected: boolean | undefined }) {
  if (!selected) return null;
  return (
    <NodeResizer
      isVisible={true}
      minWidth={40}
      minHeight={30}
      maxWidth={2000}
      maxHeight={2000}
      lineClassName="!border-primary-500"
      handleClassName="!bg-primary-500 !border-white"
    />
  );
}

function NodeBody({
  data,
  className,
  innerStyle,
}: {
  data: BlueprintNodeData;
  className?: string;
  innerStyle?: React.CSSProperties;
}) {
  const refLabel = data.ref_entity_type
    ? `${data.ref_entity_type}${data.ref_entity_id ? '·linked' : ''}`
    : null;
  return (
    <div
      className={cn(
        'bp-node-shell relative h-full w-full px-3 py-2 flex flex-col justify-center text-center select-none',
        className,
      )}
      style={innerStyle}
    >
      <div className="text-sm font-medium leading-tight break-words text-zinc-900 dark:text-zinc-100">
        {data.label || 'Untitled'}
      </div>
      {data.description && (
        <div className="mt-0.5 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400 line-clamp-2">
          {data.description}
        </div>
      )}
      {refLabel && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded-full bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide">
          <Link2 className="h-2.5 w-2.5" />
          {refLabel}
        </div>
      )}
    </div>
  );
}

function styleFromData(data: BlueprintNodeData) {
  const fill = (data.fillColor as string | undefined) ?? undefined;
  const text = (data.textColor as string | undefined) ?? undefined;
  const border = (data.borderColor as string | undefined) ?? undefined;
  return {
    backgroundColor: fill,
    color: text,
    borderColor: border,
  } as React.CSSProperties;
}

function RoundedNode({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  return (
    <div className="relative" style={{ width: '100%', height: '100%' }}>
      <SelectedResizer selected={selected} />
      <NodeHandles />
      <NodeBody
        data={d}
        className="rounded-2xl border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 shadow-sm"
        innerStyle={styleFromData(d)}
      />
    </div>
  );
}

function RectangleNode({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  return (
    <div className="relative" style={{ width: '100%', height: '100%' }}>
      <SelectedResizer selected={selected} />
      <NodeHandles />
      <NodeBody
        data={d}
        className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 shadow-sm"
        innerStyle={styleFromData(d)}
      />
    </div>
  );
}

function DiamondNode({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  const style = styleFromData(d);
  return (
    <div className="relative" style={{ width: '100%', height: '100%' }}>
      <SelectedResizer selected={selected} />
      <NodeHandles />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full pointer-events-none"
      >
        <polygon
          points="50,2 98,50 50,98 2,50"
          fill={style.backgroundColor ?? 'currentColor'}
          stroke={style.borderColor ?? 'currentColor'}
          strokeWidth="1.5"
          className="text-zinc-300 dark:text-zinc-600 fill-white dark:fill-zinc-800"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <NodeBody data={d} className="bp-node-shell" innerStyle={{ color: style.color }} />
      </div>
    </div>
  );
}

function EllipseNode({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  return (
    <div className="relative" style={{ width: '100%', height: '100%' }}>
      <SelectedResizer selected={selected} />
      <NodeHandles />
      <NodeBody
        data={d}
        className="rounded-[999px] border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 shadow-sm"
        innerStyle={styleFromData(d)}
      />
    </div>
  );
}

function HexagonNode({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  const style = styleFromData(d);
  return (
    <div className="relative" style={{ width: '100%', height: '100%' }}>
      <SelectedResizer selected={selected} />
      <NodeHandles />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full pointer-events-none"
      >
        <polygon
          points="25,2 75,2 98,50 75,98 25,98 2,50"
          fill={style.backgroundColor ?? 'currentColor'}
          stroke={style.borderColor ?? 'currentColor'}
          strokeWidth="1.5"
          className="text-zinc-300 dark:text-zinc-600 fill-white dark:fill-zinc-800"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <NodeBody data={d} className="bp-node-shell" innerStyle={{ color: style.color }} />
      </div>
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  rounded: RoundedNode,
  rectangle: RectangleNode,
  // Mermaid's vocabulary uses "process" interchangeably with rectangle —
  // alias them so an imported flowchart renders correctly. Same for
  // "decision" → diamond and "start"/"end" → rounded.
  process: RectangleNode,
  diamond: DiamondNode,
  decision: DiamondNode,
  ellipse: EllipseNode,
  start: EllipseNode,
  end: EllipseNode,
  hexagon: HexagonNode,
  preparation: HexagonNode,
};

export const SHAPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'rounded', label: 'Rounded' },
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'hexagon', label: 'Hexagon' },
];
