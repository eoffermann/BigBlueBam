import { Loader2, AlertCircle, CheckCircle2, Plus } from 'lucide-react';

// Shape of the /import/csv/preview response (wire contract).
export interface ImportPreviewReport {
  total_rows: number;
  will_create: number;
  will_skip: number;
  new_phases: string[];
  new_labels: string[];
  unmapped_values: Record<string, string[]>;
  unresolved_assignees: { row: number; value: string }[];
  invalid_urls: { row: number; column: string; value: string }[];
  duplicate_titles: { row: number; title: string }[];
}

interface ImportConfirmStepProps {
  report: ImportPreviewReport | null;
  loading: boolean;
  error: string | null;
}

// Build stable, collision-free React keys for a string list that may contain
// duplicate entries, without falling back to the array index as the key.
function dedupeForKeys(items: string[]): { key: string; item: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = (seen.get(item) ?? 0) + 1;
    seen.set(item, n);
    return { key: `${item}#${n}`, item };
  });
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'neutral' }) {
  const toneClasses =
    tone === 'good'
      ? 'text-green-600 dark:text-green-400'
      : tone === 'warn'
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-zinc-700 dark:text-zinc-300';
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-3">
      <p className={`text-2xl font-semibold ${toneClasses}`}>{value}</p>
      <p className="text-xs text-zinc-500">{label}</p>
    </div>
  );
}

function ListSection({
  icon,
  title,
  items,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  tone?: 'warn' | 'neutral';
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p
        className={`text-sm font-medium flex items-center gap-1.5 ${
          tone === 'warn'
            ? 'text-yellow-700 dark:text-yellow-400'
            : 'text-zinc-700 dark:text-zinc-300'
        }`}
      >
        {icon}
        {title} ({items.length})
      </p>
      <ul className="text-xs text-zinc-500 pl-6 list-disc space-y-0.5 max-h-24 overflow-y-auto">
        {dedupeForKeys(items).map(({ key, item }) => (
          <li key={key} className="truncate" title={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ImportConfirmStep({ report, loading, error }: ImportConfirmStepProps) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        <p className="text-sm text-zinc-500">Previewing import…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="text-sm text-zinc-700 dark:text-zinc-300">Could not preview import</p>
        <p className="text-xs text-zinc-500 max-w-sm text-center">{error}</p>
      </div>
    );
  }

  if (!report) return null;

  const unmappedEntries = Object.entries(report.unmapped_values).filter(
    ([, vals]) => vals.length > 0,
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Will create" value={report.will_create} tone="good" />
        <StatCard label="Will skip" value={report.will_skip} tone={report.will_skip > 0 ? 'warn' : 'neutral'} />
        <StatCard label="Total rows" value={report.total_rows} tone="neutral" />
      </div>

      <ListSection
        icon={<Plus className="h-3.5 w-3.5" />}
        title="New phases"
        items={report.new_phases}
      />
      <ListSection
        icon={<Plus className="h-3.5 w-3.5" />}
        title="New labels"
        items={report.new_labels}
      />

      {unmappedEntries.map(([field, vals]) => (
        <ListSection
          key={field}
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          title={`Unmapped ${field} values (passthrough)`}
          items={vals}
          tone="warn"
        />
      ))}

      <ListSection
        icon={<AlertCircle className="h-3.5 w-3.5" />}
        title="Unresolved assignees"
        items={report.unresolved_assignees.map((u) => `Row ${u.row}: ${u.value}`)}
        tone="warn"
      />
      <ListSection
        icon={<AlertCircle className="h-3.5 w-3.5" />}
        title="Invalid URLs (skipped)"
        items={report.invalid_urls.map((u) => `Row ${u.row} [${u.column}]: ${u.value}`)}
        tone="warn"
      />
      <ListSection
        icon={<AlertCircle className="h-3.5 w-3.5" />}
        title="Duplicate titles"
        items={report.duplicate_titles.map((d) => `Row ${d.row}: ${d.title}`)}
        tone="warn"
      />

      {report.will_create > 0 &&
        unmappedEntries.length === 0 &&
        report.unresolved_assignees.length === 0 &&
        report.invalid_urls.length === 0 &&
        report.duplicate_titles.length === 0 && (
          <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            No warnings — ready to import.
          </p>
        )}
    </div>
  );
}
