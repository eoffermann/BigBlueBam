import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// A collapsible, type-aware hierarchical viewer for tree-shaped structured data
// (JSON / YAML). Objects and arrays are expandable nodes; scalars render with
// type-appropriate coloring. Top levels start expanded; deep levels collapse.

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="text-zinc-400 italic">null</span>;
  switch (typeof value) {
    case 'string':
      return <span className="text-emerald-700 dark:text-emerald-400 break-words whitespace-pre-wrap">"{value}"</span>;
    case 'number':
      return <span className="text-blue-600 dark:text-blue-400">{String(value)}</span>;
    case 'boolean':
      return <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>;
    default:
      return <span className="text-zinc-600 dark:text-zinc-300">{String(value)}</span>;
  }
}

function Node({
  label,
  value,
  depth,
  isLast,
}: {
  label: string | null;
  value: Json;
  depth: number;
  isLast: boolean;
}) {
  const container = Array.isArray(value) || isObject(value);
  // Expand the first two levels by default; collapse deeper containers.
  const [open, setOpen] = useState(depth < 2);

  const keyLabel =
    label != null ? (
      <span className="text-zinc-800 dark:text-zinc-200 font-medium">{label}</span>
    ) : null;

  if (!container) {
    return (
      <div className="leading-6">
        {keyLabel}
        {keyLabel && <span className="text-zinc-400">: </span>}
        <Scalar value={value} />
        {!isLast && <span className="text-zinc-300 dark:text-zinc-600">,</span>}
      </div>
    );
  }

  const entries: [string | null, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const count = entries.length;
  const open_brace = Array.isArray(value) ? '[' : '{';
  const close_brace = Array.isArray(value) ? ']' : '}';
  const summary = Array.isArray(value)
    ? `${count} ${count === 1 ? 'item' : 'items'}`
    : `${count} ${count === 1 ? 'field' : 'fields'}`;

  return (
    <div className="leading-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded px-0.5 -ml-0.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        )}
        {keyLabel}
        {keyLabel && <span className="text-zinc-400">: </span>}
        <span className="text-zinc-400">{open_brace}</span>
        {!open && (
          <>
            <span className="text-zinc-400 text-xs mx-1">{summary}</span>
            <span className="text-zinc-400">{close_brace}</span>
          </>
        )}
      </button>
      {open && (
        <>
          <div className="border-l border-zinc-200 dark:border-zinc-700 ml-[7px] pl-4">
            {entries.map(([k, v], i) => (
              <Node key={k ?? i} label={k} value={v} depth={depth + 1} isLast={i === count - 1} />
            ))}
          </div>
          <div className="text-zinc-400 ml-[7px]">
            {close_brace}
            {!isLast && <span className="text-zinc-300 dark:text-zinc-600">,</span>}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonTree({ data }: { data: Json }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-4 font-mono text-[13px] overflow-auto custom-scrollbar text-zinc-700 dark:text-zinc-300">
      <Node label={null} value={data} depth={0} isLast />
    </div>
  );
}
