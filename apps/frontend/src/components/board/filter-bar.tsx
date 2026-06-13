import { useState, useEffect, useRef } from 'react';
import { Search, X, ChevronDown, Check } from 'lucide-react';
import { PRIORITIES } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/common/button';

interface FilterBarProps {
  filters: {
    assignee_id?: string;
    priority?: string;
    state_id?: string;
    epic_id?: string;
    search?: string;
  };
  onFilterChange: (filters: FilterBarProps['filters']) => void;
  assignees?: { id: string; display_name: string }[];
  states?: { id: string; name: string }[];
  epics?: { id: string; name: string }[];
}

interface MultiSelectDropdownProps {
  label: string;
  options: { value: string; label: string }[];
  selectedValues: string[];
  onToggle: (value: string) => void;
}

function MultiSelectDropdown({ label, options, selectedValues, onToggle }: MultiSelectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const hasSelections = selectedValues.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={hasSelections ? `${label}, ${selectedValues.length} selected` : label}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          hasSelections
            ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-700 dark:bg-zinc-800 dark:text-primary-400'
            : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-400',
        )}
      >
        {label}
        {hasSelections && (
          <span className="inline-flex items-center justify-center h-4 min-w-[16px] rounded-full bg-primary-600 text-white text-[10px] font-medium px-1">
            {selectedValues.length}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {isOpen && (
        <div role="listbox" aria-multiselectable="true" aria-label={label} className="absolute top-full left-0 mt-1 z-50 min-w-[200px] rounded-lg border border-zinc-200 bg-white shadow-lg dark:bg-zinc-900 dark:border-zinc-700 py-1">
          {options.map((option) => {
            const isSelected = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                onClick={() => onToggle(option.value)}
                role="option"
                aria-selected={isSelected}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800"
              >
                <div
                  aria-hidden="true"
                  className={cn(
                    'flex items-center justify-center h-4 w-4 rounded border transition-colors',
                    isSelected
                      ? 'bg-primary-600 border-primary-600'
                      : 'border-zinc-300 dark:border-zinc-600',
                  )}
                >
                  {isSelected && <Check className="h-3 w-3 text-white" />}
                </div>
                <span className={cn(
                  'text-zinc-700 dark:text-zinc-300',
                  isSelected && 'font-medium',
                )}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FilterBar({ filters, onFilterChange, assignees = [], states = [], epics = [] }: FilterBarProps) {
  const [searchValue, setSearchValue] = useState(filters.search ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = (value: string) => {
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onFilterChange({ ...filters, search: value || undefined });
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const priorityOptions = PRIORITIES.filter((p) => p !== 'none').map((p) => ({
    value: p,
    label: p.charAt(0).toUpperCase() + p.slice(1),
  }));

  const assigneeOptions = assignees.map((a) => ({ value: a.id, label: a.display_name }));
  const stateOptions = states.map((s) => ({ value: s.id, label: s.name }));
  const epicOptions = epics.map((e) => ({ value: e.id, label: e.name }));

  // Parse multi-select values from comma-separated string
  const selectedPriorities = filters.priority ? filters.priority.split(',') : [];
  const selectedAssignees = filters.assignee_id ? filters.assignee_id.split(',') : [];
  const selectedStates = filters.state_id ? filters.state_id.split(',') : [];
  const selectedEpics = filters.epic_id ? filters.epic_id.split(',') : [];

  const toggleFilter = (field: 'priority' | 'assignee_id' | 'state_id' | 'epic_id', value: string) => {
    const currentStr = filters[field] ?? '';
    const current = currentStr ? currentStr.split(',') : [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onFilterChange({
      ...filters,
      [field]: next.length > 0 ? next.join(',') : undefined,
    });
  };

  const hasAnyFilter = !!(filters.priority || filters.assignee_id || filters.state_id || filters.epic_id || filters.search);

  const clearFilters = () => {
    setSearchValue('');
    onFilterChange({});
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          id="board-search-input"
          type="text"
          placeholder="Filter tasks..."
          value={searchValue}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-48 rounded-lg border border-zinc-200 bg-white pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
        />
      </div>

      {/* Priority multi-select */}
      <MultiSelectDropdown
        label="Priority"
        options={priorityOptions}
        selectedValues={selectedPriorities}
        onToggle={(val) => toggleFilter('priority', val)}
      />

      {/* Assignee multi-select */}
      {assigneeOptions.length > 0 && (
        <MultiSelectDropdown
          label="Assignee"
          options={assigneeOptions}
          selectedValues={selectedAssignees}
          onToggle={(val) => toggleFilter('assignee_id', val)}
        />
      )}

      {/* State multi-select */}
      {stateOptions.length > 0 && (
        <MultiSelectDropdown
          label="State"
          options={stateOptions}
          selectedValues={selectedStates}
          onToggle={(val) => toggleFilter('state_id', val)}
        />
      )}

      {/* Epic multi-select */}
      {epicOptions.length > 0 && (
        <MultiSelectDropdown
          label="Epic"
          options={epicOptions}
          selectedValues={selectedEpics}
          onToggle={(val) => toggleFilter('epic_id', val)}
        />
      )}

      {/* Clear filters */}
      {hasAnyFilter && (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      )}
    </div>
  );
}
