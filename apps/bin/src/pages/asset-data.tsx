import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Download, FileWarning, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAsset, useData, usePatchRows, usePatchTree, useArrayOp, type InferredField } from '@/hooks/use-bin';
import { useBinRealtime } from '@/hooks/use-bin-realtime';
import { JsonTree } from '@/components/json-tree';
import { api, ApiError } from '@/lib/api';

interface AssetDataPageProps {
  assetId: string;
  onNavigate: (path: string) => void;
}

function SchemaChips({ fields }: { fields: InferredField[] }) {
  if (!fields?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {fields.map((f) => (
        <span
          key={f.key}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-0.5 text-xs"
        >
          <span className="font-medium text-zinc-800 dark:text-zinc-200">{f.key}</span>
          <span className="text-zinc-400">:</span>
          <span className="text-primary-600 dark:text-primary-400 font-mono">{f.type}</span>
        </span>
      ))}
    </div>
  );
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function FriendlyError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-6 flex items-start gap-3">
      <FileWarning className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
      <div>
        <h3 className="font-medium text-amber-800 dark:text-amber-300">{title}</h3>
        <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">{message}</p>
      </div>
    </div>
  );
}

// One editable table cell. Click to edit; Enter or blur commits a single-cell
// patch (which mints a new immutable version server-side), Escape cancels.
function EditableCell({
  value,
  onCommit,
  disabled,
}: {
  value: unknown;
  onCommit: (next: string) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (editing) {
    return (
      <td className="px-2 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== cellText(value)) onCommit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditing(false);
              if (draft !== cellText(value)) onCommit(draft);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="w-full rounded border border-primary-400 bg-white dark:bg-zinc-900 px-2 py-1 text-sm outline-none ring-2 ring-primary-500/30"
        />
      </td>
    );
  }

  return (
    <td
      onClick={() => {
        if (disabled) return;
        setDraft(cellText(value));
        setEditing(true);
      }}
      className={`group px-4 py-2 text-zinc-700 dark:text-zinc-300 whitespace-nowrap max-w-xs truncate ${
        disabled ? '' : 'cursor-text hover:bg-primary-50/60 dark:hover:bg-primary-900/10'
      }`}
      title={disabled ? undefined : 'Click to edit'}
    >
      <span className="inline-flex items-center gap-1.5">
        {cellText(value) || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
        {!disabled && (
          <Pencil className="h-3 w-3 text-zinc-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </span>
    </td>
  );
}

export function AssetDataPage({ assetId, onNavigate }: AssetDataPageProps) {
  const assetQuery = useAsset(assetId);
  const dataQuery = useData(assetId);
  const patch = usePatchRows(assetId);
  const treePatch = usePatchTree(assetId);
  const arrayOp = useArrayOp(assetId);

  const asset = assetQuery.data?.data;
  const heading = asset?.name ?? 'Asset';

  // Live edits + presence: other editors' commits refetch this view, and we
  // show who else is in the editor.
  const { members } = useBinRealtime(assetId);

  const renderBody = () => {
    if (dataQuery.isLoading) {
      return (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      );
    }

    if (dataQuery.isError) {
      const err = dataQuery.error;
      if (err instanceof ApiError) {
        if (err.status === 409) {
          return (
            <FriendlyError
              title="Not available yet"
              message={
                err.message ||
                'This asset is not servable yet (its security scan has not cleared). Try again once the scan completes.'
              }
            />
          );
        }
        if (err.status === 422) {
          return (
            <FriendlyError
              title="Not a structured-data file"
              message={
                err.message ||
                'This asset is not in a structured-data format (CSV, JSON, and similar). There is no table or tree to show.'
              }
            />
          );
        }
      }
      return (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-red-800 dark:text-red-300">Could not load data</h3>
            <p className="text-sm text-red-700 dark:text-red-400 mt-1">
              {err instanceof Error ? err.message : 'An unexpected error occurred.'}
            </p>
          </div>
        </div>
      );
    }

    const data = dataQuery.data?.data;
    if (!data) return null;

    if (data.shape === 'tree') {
      return (
        <div>
          {treePatch.isError && (
            <p className="text-xs text-red-500 mb-2">
              {treePatch.error instanceof Error ? treePatch.error.message : 'Edit failed.'}
            </p>
          )}
          {treePatch.isPending && (
            <p className="text-xs text-primary-500 mb-2 inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> saving…
            </p>
          )}
          <JsonTree
            data={data.data}
            disabled={treePatch.isPending || arrayOp.isPending}
            onEdit={(path, value) => treePatch.mutate([{ path, value }])}
            onArrayOp={(op) => arrayOp.mutate(op)}
          />
        </div>
      );
    }

    // record shape
    return (
      <div>
        <SchemaChips fields={data.schema?.fields ?? []} />
        <p className="text-xs text-zinc-500 mb-3 flex items-center gap-2">
          <span>
            {data.total.toLocaleString()} {data.total === 1 ? 'row' : 'rows'}
            {data.rows.length < data.total ? ` (showing ${data.rows.length})` : ''}
          </span>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="text-zinc-400">click a cell to edit</span>
          {patch.isPending && (
            <span className="inline-flex items-center gap-1 text-primary-500">
              <Loader2 className="h-3 w-3 animate-spin" /> saving…
            </span>
          )}
        </p>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {data.columns.map((col) => (
                  <th key={col} className="px-4 py-2.5 whitespace-nowrap">
                    {col}
                  </th>
                ))}
                <th className="px-2 py-2.5 w-10" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-t border-zinc-100 dark:border-zinc-800 group/row"
                >
                  {data.columns.map((col) => (
                    <EditableCell
                      key={col}
                      value={row[col]}
                      disabled={patch.isPending}
                      onCommit={(next) =>
                        patch.mutate([{ index: data.offset + i, set: { [col]: next } }])
                      }
                    />
                  ))}
                  <td className="px-2 py-2 text-center">
                    <button
                      type="button"
                      title="Delete row"
                      disabled={arrayOp.isPending}
                      onClick={() => arrayOp.mutate({ op: 'delete', index: data.offset + i })}
                      className="text-zinc-300 dark:text-zinc-600 hover:text-red-500 opacity-0 group-hover/row:opacity-100 transition-opacity disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={arrayOp.isPending}
            onClick={() => arrayOp.mutate({ op: 'append' })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add row
          </button>
          {arrayOp.isPending && (
            <span className="inline-flex items-center gap-1 text-xs text-primary-500">
              <Loader2 className="h-3 w-3 animate-spin" /> saving…
            </span>
          )}
        </div>
        {(patch.isError || arrayOp.isError) && (
          <p className="text-xs text-red-500 mt-2">
            {(patch.error || arrayOp.error) instanceof Error
              ? ((patch.error || arrayOp.error) as Error).message
              : 'Edit failed.'}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <button
        onClick={() => onNavigate('/')}
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Asset Library
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">{heading}</h1>
          {asset?.content_type && (
            <p className="text-sm text-zinc-500">
              <code className="text-xs">{asset.content_type}</code>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {members.length > 0 && (
            <div className="flex items-center -space-x-2" title={`${members.map((m) => m.name).join(', ')} also here`}>
              {members.slice(0, 5).map((m) => (
                <span
                  key={m.conn_id}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-white dark:border-zinc-900 text-[11px] font-semibold text-white"
                  style={{ backgroundColor: m.color }}
                  title={m.name}
                >
                  {m.name.slice(0, 2).toUpperCase()}
                </span>
              ))}
              {members.length > 5 && (
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-white dark:border-zinc-900 bg-zinc-400 text-[11px] font-semibold text-white">
                  +{members.length - 5}
                </span>
              )}
            </div>
          )}
          {asset && (asset.scan_status === 'clean' || asset.scan_status === 'skipped') && (
            <a
              href={api.rawUrl(`/v1/assets/${asset.id}/raw`)}
              download={asset.name}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
            >
              <Download className="h-4 w-4" /> Download
            </a>
          )}
        </div>
      </div>

      {renderBody()}
    </div>
  );
}
