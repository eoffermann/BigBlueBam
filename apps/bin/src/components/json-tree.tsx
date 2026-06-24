import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';

// A collapsible, type-aware hierarchical viewer/editor for tree-shaped structured
// data (JSON / YAML). Objects and arrays are expandable nodes; scalars render
// with type-appropriate coloring and are click-to-edit; arrays of similar
// dictionaries render as embedded grids (like the CSV/JSONL editors) whose cells
// are also editable. Every edit commits a path patch (-> a new version).

type Json = unknown;
type Path = (string | number)[];
type OnEdit = (path: Path, value: string) => void;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: Json): boolean {
  return v == null || typeof v !== 'object';
}

/**
 * Decide whether an array is "tabular" — a list of similar dictionaries that
 * should render as a grid. Heuristic mirrors the structured-data shape detector:
 * >=2 plain-object rows of scalar cells with >=0.7 average key-coverage.
 */
function tabularColumns(value: Json): string[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!value.every((v) => isObject(v))) return null;
  const rows = value as Record<string, Json>[];
  const colOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        colOrder.push(k);
      }
      if (!isScalar(row[k])) return null;
    }
  }
  const union = colOrder.length;
  if (union === 0) return null;
  const avgCoverage =
    rows.reduce((sum, r) => sum + Object.keys(r).length / union, 0) / rows.length;
  return avgCoverage >= 0.7 ? colOrder : null;
}

function cellText(value: Json): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function scalarClass(value: Json): string {
  if (value === null) return 'text-zinc-400 italic';
  switch (typeof value) {
    case 'string':
      return 'text-emerald-700 dark:text-emerald-400';
    case 'number':
      return 'text-blue-600 dark:text-blue-400';
    case 'boolean':
      return 'text-purple-600 dark:text-purple-400';
    default:
      return 'text-zinc-600 dark:text-zinc-300';
  }
}

// Click-to-edit scalar. Renders the value; on click shows an input that commits
// on Enter/blur and cancels on Escape. Quotes strings in display only.
function EditableScalar({
  value,
  path,
  onEdit,
  disabled,
  quoteStrings,
}: {
  value: Json;
  path: Path;
  onEdit?: OnEdit;
  disabled: boolean;
  quoteStrings?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editable = !!onEdit && !disabled;

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== cellText(value)) onEdit?.(path, draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setEditing(false);
            if (draft !== cellText(value)) onEdit?.(path, draft);
          } else if (e.key === 'Escape') {
            setEditing(false);
          }
        }}
        className="rounded border border-primary-400 bg-white dark:bg-zinc-900 px-1.5 py-0.5 text-[13px] outline-none ring-2 ring-primary-500/30 min-w-[6rem]"
      />
    );
  }

  const display =
    value === null ? 'null' : quoteStrings && typeof value === 'string' ? `"${value}"` : String(value);

  return (
    <span
      onClick={() => {
        if (!editable) return;
        setDraft(cellText(value));
        setEditing(true);
      }}
      className={`${scalarClass(value)} ${
        editable ? 'cursor-text hover:bg-primary-50/60 dark:hover:bg-primary-900/10 rounded px-0.5' : ''
      } break-words whitespace-pre-wrap`}
      title={editable ? 'Click to edit' : undefined}
    >
      {display}
    </span>
  );
}

function EmbeddedTable({
  columns,
  rows,
  basePath,
  onEdit,
  disabled,
}: {
  columns: string[];
  rows: Record<string, Json>[];
  basePath: Path;
  onEdit?: OnEdit;
  disabled: boolean;
}) {
  return (
    <div className="my-1 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-auto custom-scrollbar">
      <table className="w-full text-[13px] font-sans">
        <thead>
          <tr className="bg-zinc-100/70 dark:bg-zinc-800/60 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {columns.map((c) => (
              <th key={c} className="px-3 py-1.5 whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
              {columns.map((c) => (
                <td key={c} className="px-3 py-1.5 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                  {c in row ? (
                    <EditableScalar
                      value={row[c]}
                      path={[...basePath, i, c]}
                      onEdit={onEdit}
                      disabled={disabled}
                    />
                  ) : (
                    <span className="text-zinc-300 dark:text-zinc-600">—</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Node({
  label,
  value,
  depth,
  isLast,
  path,
  onEdit,
  disabled,
}: {
  label: string | null;
  value: Json;
  depth: number;
  isLast: boolean;
  path: Path;
  onEdit?: OnEdit;
  disabled: boolean;
}) {
  const container = Array.isArray(value) || isObject(value);
  const [open, setOpen] = useState(depth < 2);

  const keyLabel =
    label != null ? <span className="text-zinc-800 dark:text-zinc-200 font-medium">{label}</span> : null;

  if (!container) {
    return (
      <div className="leading-6">
        {keyLabel}
        {keyLabel && <span className="text-zinc-400">: </span>}
        <EditableScalar value={value} path={path} onEdit={onEdit} disabled={disabled} quoteStrings />
        {!isLast && <span className="text-zinc-300 dark:text-zinc-600">,</span>}
      </div>
    );
  }

  const tableCols = tabularColumns(value);
  const entries: [string | null, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const count = entries.length;
  const open_brace = Array.isArray(value) ? '[' : '{';
  const close_brace = Array.isArray(value) ? ']' : '}';
  const summary = tableCols
    ? `${count} rows × ${tableCols.length} cols`
    : Array.isArray(value)
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
        {tableCols ? (
          <span className="text-zinc-400 text-xs">{summary}</span>
        ) : (
          <>
            <span className="text-zinc-400">{open_brace}</span>
            {!open && (
              <>
                <span className="text-zinc-400 text-xs mx-1">{summary}</span>
                <span className="text-zinc-400">{close_brace}</span>
              </>
            )}
          </>
        )}
      </button>
      {open && tableCols && (
        <div className="ml-[7px] pl-4">
          <EmbeddedTable
            columns={tableCols}
            rows={value as Record<string, Json>[]}
            basePath={path}
            onEdit={onEdit}
            disabled={disabled}
          />
        </div>
      )}
      {open && !tableCols && (
        <>
          <div className="border-l border-zinc-200 dark:border-zinc-700 ml-[7px] pl-4">
            {entries.map(([k, v], i) => (
              <Node
                key={k ?? i}
                label={k}
                value={v}
                depth={depth + 1}
                isLast={i === count - 1}
                path={[...path, Array.isArray(value) ? i : (k as string)]}
                onEdit={onEdit}
                disabled={disabled}
              />
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

export function JsonTree({
  data,
  onEdit,
  disabled = false,
}: {
  data: Json;
  onEdit?: OnEdit;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-4 font-mono text-[13px] overflow-auto custom-scrollbar text-zinc-700 dark:text-zinc-300">
      {onEdit && (
        <p className="text-[11px] text-zinc-400 mb-2 font-sans inline-flex items-center gap-1">
          <Pencil className="h-3 w-3" /> click any value or grid cell to edit
        </p>
      )}
      <Node label={null} value={data} depth={0} isLast path={[]} onEdit={onEdit} disabled={disabled} />
    </div>
  );
}
