import * as RadixSelect from '@radix-ui/react-select';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  options: SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  className?: string;
}

// Radix Select 2.2+ rejects SelectItems with an empty-string value at render
// time. Historically callers used `{ value: '', label: 'Select…' }` to render
// a "no selection" placeholder row inside the dropdown. We transparently
// convert that pattern: strip empty-value options, promote the first
// stripped label into the placeholder prop, and normalize `value === ''`
// into an unset Radix value (which surfaces the placeholder anyway).
export function Select({ options, value, onValueChange, placeholder, label, error, className }: SelectProps) {
  const emptyOption = options.find((o) => o.value === '');
  const realOptions = options.filter((o) => o.value !== '');
  const effectivePlaceholder = placeholder ?? emptyOption?.label ?? 'Select...';
  const radixValue = value === '' ? undefined : value ?? undefined;

  const handleChange = (next: string) => {
    if (onValueChange) onValueChange(next);
  };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>}
      <RadixSelect.Root value={radixValue} onValueChange={handleChange}>
        <RadixSelect.Trigger
          className={cn(
            'inline-flex items-center justify-between rounded-lg border bg-white px-3 py-2 text-sm gap-2',
            'focus:outline-none focus:ring-2 focus:ring-primary-500',
            'dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100',
            error ? 'border-red-500' : 'border-zinc-300',
          )}
        >
          <RadixSelect.Value placeholder={effectivePlaceholder} />
          <RadixSelect.Icon>
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:bg-zinc-900 dark:border-zinc-700 z-50 max-h-[var(--radix-select-content-available-height)]"
            position="popper"
            sideOffset={4}
          >
            {/* Cap height + native scroll so long lists (e.g. the timezone
                picker) don't run off the screen. */}
            <RadixSelect.Viewport className="p-1 max-h-72 overflow-y-auto">
              {realOptions.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="ml-auto">
                    <Check className="h-4 w-4 text-primary-600" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
