import { Input } from '@/components/common/input';

// One column's link-mapping config, as edited in the panel. Serializes 1:1
// to the wire `link_mappings[]` entry (column + label + fetch_title).
export interface LinkMappingConfig {
  column: string;
  label: string; // empty string => no static label (sent as null)
  fetch_title: boolean;
}

interface LinksMappingPanelProps {
  // columns the user has mapped to the Links target
  columns: string[];
  configs: Record<string, LinkMappingConfig>;
  onChange: (configs: Record<string, LinkMappingConfig>) => void;
}

export function LinksMappingPanel({ columns, configs, onChange }: LinksMappingPanelProps) {
  if (columns.length === 0) return null;

  const update = (column: string, patch: Partial<LinkMappingConfig>) => {
    const current = configs[column] ?? { column, label: '', fetch_title: false };
    onChange({ ...configs, [column]: { ...current, ...patch, column } });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Each non-empty cell in a Links column becomes a task link. Cells may hold
        several URLs separated by spaces or commas; bare domains get{' '}
        <code className="text-xs">https://</code> prepended.
      </p>
      {columns.map((column) => {
        const cfg = configs[column] ?? { column, label: '', fetch_title: false };
        return (
          <div
            key={column}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-3"
          >
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate" title={column}>
              {column}
            </p>
            <Input
              id={`link-label-${column}`}
              label="Static title (optional)"
              placeholder="e.g. Spec"
              value={cfg.label}
              onChange={(e) => update(column, { label: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.fetch_title}
                onChange={(e) => update(column, { fetch_title: e.target.checked })}
                className="rounded border-zinc-300 dark:border-zinc-600 text-primary-600 focus:ring-primary-500"
              />
              Fetch page titles
            </label>
          </div>
        );
      })}
    </div>
  );
}

// Serialize the per-column configs (for the currently-mapped Links columns)
// into the wire `link_mappings[]`. label '' => null.
export function serializeLinkMappings(
  columns: string[],
  configs: Record<string, LinkMappingConfig>,
): { column: string; label: string | null; fetch_title: boolean }[] {
  return columns.map((column) => {
    const cfg = configs[column] ?? { column, label: '', fetch_title: false };
    return {
      column,
      label: cfg.label.trim() ? cfg.label.trim() : null,
      fetch_title: cfg.fetch_title,
    };
  });
}
