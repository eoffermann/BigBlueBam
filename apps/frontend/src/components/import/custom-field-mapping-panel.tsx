import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import type { CustomFieldType } from './custom-field-infer';

// Per-column custom-field editing state. Only meaningful for columns mapped to
// "Create custom field…" — existing-field columns are fully determined by their
// `cf:<name>` target and need no extra input.
export interface CustomFieldState {
  field_name: string;
  field_type: CustomFieldType;
}

const TYPE_OPTIONS: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'URL' },
];

interface CustomFieldMappingPanelProps {
  // Columns mapped to "Create custom field…" (new-field columns only).
  columns: string[];
  // Per-column inferred type (used as the default when state is unset).
  inferredTypes: Record<string, CustomFieldType>;
  configs: Record<string, CustomFieldState>;
  onChange: (configs: Record<string, CustomFieldState>) => void;
}

export function CustomFieldMappingPanel({
  columns,
  inferredTypes,
  configs,
  onChange,
}: CustomFieldMappingPanelProps) {
  if (columns.length === 0) return null;

  const update = (column: string, patch: Partial<CustomFieldState>) => {
    const current: CustomFieldState = configs[column] ?? {
      field_name: column,
      field_type: inferredTypes[column] ?? 'text',
    };
    onChange({ ...configs, [column]: { ...current, ...patch } });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        New custom fields are created on import. The type is inferred from a
        sample of the column; override it if the guess is wrong.
      </p>
      {columns.map((column) => {
        const cfg: CustomFieldState = configs[column] ?? {
          field_name: column,
          field_type: inferredTypes[column] ?? 'text',
        };
        return (
          <div
            key={column}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-3"
          >
            <p
              className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate"
              title={column}
            >
              {column}
            </p>
            <Input
              id={`cf-name-${column}`}
              label="Field name"
              placeholder={column}
              value={cfg.field_name}
              onChange={(e) => update(column, { field_name: e.target.value })}
            />
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">Type</span>
              <Select
                options={TYPE_OPTIONS}
                value={cfg.field_type}
                onValueChange={(val) => update(column, { field_type: val as CustomFieldType })}
                className="w-48"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
