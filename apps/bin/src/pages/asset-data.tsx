import { AlertTriangle, ArrowLeft, FileWarning, Loader2 } from 'lucide-react';
import { useAsset, useData, type InferredField } from '@/hooks/use-bin';
import { ApiError } from '@/lib/api';

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

export function AssetDataPage({ assetId, onNavigate }: AssetDataPageProps) {
  const assetQuery = useAsset(assetId);
  const dataQuery = useData(assetId);

  const asset = assetQuery.data?.data;
  const heading = asset?.name ?? 'Asset';

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
        <pre className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-4 text-xs leading-relaxed overflow-auto text-zinc-800 dark:text-zinc-200 custom-scrollbar">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      );
    }

    // record shape
    return (
      <div>
        <SchemaChips fields={data.schema?.fields ?? []} />
        <p className="text-xs text-zinc-500 mb-3">
          {data.total.toLocaleString()} {data.total === 1 ? 'row' : 'rows'}
          {data.rows.length < data.total ? ` (showing ${data.rows.length})` : ''}
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
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                >
                  {data.columns.map((col) => (
                    <td key={col} className="px-4 py-2 text-zinc-700 dark:text-zinc-300 whitespace-nowrap max-w-xs truncate">
                      {cellText(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">{heading}</h1>
      {asset?.content_type && (
        <p className="text-sm text-zinc-500 mb-6">
          <code className="text-xs">{asset.content_type}</code>
        </p>
      )}

      {renderBody()}
    </div>
  );
}
