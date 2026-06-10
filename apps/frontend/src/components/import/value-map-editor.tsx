import { useMemo } from 'react';
import { Select } from '@/components/common/select';

// Sentinel option values used inside the value-map dropdowns. They cannot
// collide with real Bam values because real targets are lowercase slugs /
// phase names and these carry a __ prefix/suffix.
export const PASSTHROUGH = '__passthrough__';
export const LEAVE_UNSET = '__leave_unset__';

// A single value-map cell selection. PASSTHROUGH => omit the incoming value
// from value_maps entirely (server applies its existing passthrough rules).
// LEAVE_UNSET => emit `null` (field left unset for that row). Anything else
// is a concrete Bam value.
export type ValueChoice = string; // one of PASSTHROUGH | LEAVE_UNSET | <bam value>

interface ValueMapEditorProps {
  // target field this editor maps (priority | phase_name)
  field: 'priority' | 'phase_name';
  // distinct incoming values (already trimmed, de-duped) with occurrence counts
  distinctValues: { value: string; count: number }[];
  // current selection keyed by incoming value
  selections: Record<string, ValueChoice>;
  onChange: (selections: Record<string, ValueChoice>) => void;
  // valid Bam targets to offer (for phase_name these are existing phase names)
  bamValues?: { value: string; label: string }[];
}

const PRIORITY_VALUES: { value: string; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function ValueMapEditor({
  field,
  distinctValues,
  selections,
  onChange,
  bamValues,
}: ValueMapEditorProps) {
  const targetOptions = useMemo(() => {
    const base = field === 'priority' ? PRIORITY_VALUES : bamValues ?? [];
    return [
      { value: PASSTHROUGH, label: 'Passthrough (use as-is)' },
      { value: LEAVE_UNSET, label: 'Leave unset' },
      ...base,
    ];
  }, [field, bamValues]);

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-50 dark:bg-zinc-800">
            <th className="px-3 py-2 text-left font-medium text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              Incoming value
            </th>
            <th className="px-3 py-2 text-left font-medium text-zinc-500 border-b border-zinc-200 dark:border-zinc-700 w-16">
              Count
            </th>
            <th className="px-3 py-2 text-left font-medium text-zinc-500 border-b border-zinc-200 dark:border-zinc-700 w-56">
              Maps to
            </th>
          </tr>
        </thead>
        <tbody>
          {distinctValues.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-3 text-zinc-400 text-center">
                No non-empty values in this column.
              </td>
            </tr>
          )}
          {distinctValues.map(({ value, count }) => (
            <tr
              key={value}
              className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
            >
              <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300 truncate max-w-[180px]" title={value}>
                {value}
              </td>
              <td className="px-3 py-2 text-zinc-500">{count}</td>
              <td className="px-3 py-2">
                <Select
                  options={targetOptions}
                  value={selections[value] ?? PASSTHROUGH}
                  onValueChange={(val) =>
                    onChange({ ...selections, [value]: val })
                  }
                  className="w-full"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Serialize a per-incoming-value selection map into the wire shape for one
// value-mapped field. PASSTHROUGH entries are dropped (server passthrough);
// LEAVE_UNSET becomes null; concrete values pass through.
export function serializeValueMap(
  selections: Record<string, ValueChoice>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [incoming, choice] of Object.entries(selections)) {
    if (choice === PASSTHROUGH) continue;
    out[incoming] = choice === LEAVE_UNSET ? null : choice;
  }
  return out;
}

// Pre-seed obvious guesses for a priority column: P0..P4, Highest/Lowest,
// and exact case-insensitive matches against the valid set.
export function seedPriorityGuesses(
  distinctValues: { value: string }[],
): Record<string, ValueChoice> {
  const out: Record<string, ValueChoice> = {};
  for (const { value } of distinctValues) {
    const lower = value.toLowerCase().trim();
    const guess =
      lower === 'p0' || lower === 'highest' || lower === 'critical' || lower === 'blocker'
        ? 'critical'
        : lower === 'p1' || lower === 'high'
          ? 'high'
          : lower === 'p2' || lower === 'medium' || lower === 'normal'
            ? 'medium'
            : lower === 'p3' || lower === 'low' || lower === 'lowest'
              ? 'low'
              : lower === 'p4' || lower === 'none' || lower === 'trivial'
                ? LEAVE_UNSET
                : PASSTHROUGH;
    out[value] = guess;
  }
  return out;
}

// Pre-seed phase guesses: exact case-insensitive match to an existing phase
// maps to that phase; otherwise passthrough (server find-or-creates).
export function seedPhaseGuesses(
  distinctValues: { value: string }[],
  bamValues: { value: string }[],
): Record<string, ValueChoice> {
  const out: Record<string, ValueChoice> = {};
  const byLower = new Map(bamValues.map((b) => [b.value.toLowerCase().trim(), b.value]));
  for (const { value } of distinctValues) {
    const match = byLower.get(value.toLowerCase().trim());
    out[value] = match ?? PASSTHROUGH;
  }
  return out;
}
