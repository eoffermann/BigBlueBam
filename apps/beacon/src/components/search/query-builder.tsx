import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { Search, ChevronDown, ChevronRight, X, Plus, Bookmark } from 'lucide-react';
import { useSearchStore } from '@/stores/search.store';
import { useBeaconTags } from '@/hooks/use-beacons';
import { useBeaconSearchCount, useSaveQuery } from '@/hooks/use-search';
import { useProjects } from '@/hooks/use-projects';
import { cn } from '@/lib/utils';

// ── Tag typeahead ───────────────────────────────────────────────────

function TagInput({ onAdd }: { onAdd: (tag: string) => void }) {
  const [input, setInput] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: allTags } = useBeaconTags();
  const selectedTags = useSearchStore((s) => s.tags);

  const filtered = (allTags ?? [])
    .filter((t) => t && typeof t.tag === 'string')
    .filter((t) => !selectedTags.includes(t.tag))
    .filter((t) => t.tag.toLowerCase().includes(input.toLowerCase()))
    .slice(0, 12);

  const handleSelect = (name: string) => {
    onAdd(name);
    setInput('');
    setShowDropdown(false);
    setHighlightIdx(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && highlightIdx >= 0 && filtered[highlightIdx]) {
      e.preventDefault();
      handleSelect(filtered[highlightIdx].tag);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowDropdown(true);
            setHighlightIdx(-1);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => {
            // Delay to allow click on dropdown item
            setTimeout(() => setShowDropdown(false), 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Add tag..."
          className="w-28 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
        <Plus className="h-3.5 w-3.5 text-zinc-400" />
      </div>

      {showDropdown && input.length > 0 && filtered.length > 0 && (
        <div className="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1 max-h-48 overflow-y-auto">
          {filtered.map((tag, idx) => (
            <button
              key={tag.tag}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(tag.tag)}
              className={cn(
                'w-full text-left px-3 py-1.5 text-sm flex items-center justify-between',
                idx === highlightIdx
                  ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                  : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
              )}
            >
              <span>{tag.tag}</span>
              <span className="text-xs text-zinc-400">{tag.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project selector (multi-select chips) ───────────────────────────

function ProjectSelector() {
  const projectIds = useSearchStore((s) => s.projectIds);
  const setProjectIds = useSearchStore((s) => s.setProjectIds);
  const { projects } = useProjects();
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    if (showPicker) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPicker]);

  const getProjectName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? id.slice(0, 8) + '...';

  const available = projects.filter((p) => !projectIds.includes(p.id));

  return (
    <div className="flex items-center gap-1.5 flex-wrap" ref={pickerRef}>
      {projectIds.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-full bg-primary-100 dark:bg-primary-900/30 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300"
        >
          {getProjectName(id)}
          <button
            onClick={() => setProjectIds(projectIds.filter((p) => p !== id))}
            className="hover:text-primary-900 dark:hover:text-primary-100"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {projectIds.length === 0 && (
        <span className="text-sm text-zinc-400 dark:text-zinc-500 italic">
          All accessible projects
        </span>
      )}

      <div className="relative">
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>

        {showPicker && available.length > 0 && (
          <div className="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1 max-h-48 overflow-y-auto">
            {available.map((project) => (
              <button
                key={project.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setProjectIds([...projectIds, project.id]);
                  setShowPicker(false);
                }}
                className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                <span
                  className="flex items-center justify-center h-4 w-4 rounded text-[10px] font-medium shrink-0"
                  style={{ backgroundColor: project.color ?? '#2563eb' }}
                >
                  {project.icon ?? project.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{project.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status checkboxes ───────────────────────────────────────────────

const STATUS_OPTIONS = ['Active', 'PendingReview', 'Archived', 'Draft', 'Retired'] as const;
const STATUS_LABELS: Record<string, string> = {
  Active: 'Active',
  PendingReview: 'Pending Review',
  Archived: 'Archived',
  Draft: 'Draft',
  Retired: 'Retired',
};

// ── Visibility options ──────────────────────────────────────────────

const VISIBILITY_OPTIONS = ['Public', 'Organization', 'Project', 'Private'] as const;

// ── Save Query dialog ───────────────────────────────────────────────

function SaveQueryDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'Private' | 'Project' | 'Organization'>('Private');
  const toSearchRequest = useSearchStore((s) => s.toSearchRequest);
  const saveQuery = useSaveQuery();

  const handleSave = () => {
    if (!name.trim()) return;
    saveQuery.mutate(
      { name: name.trim(), query_body: toSearchRequest(), scope },
      {
        onSuccess: () => {
          setName('');
          setScope('Private');
          onClose();
        },
      },
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
          Save Search Query
        </h3>

        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Deployment docs"
          className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 mb-4 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />

        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          Scope
        </label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
          className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 mb-4 focus:outline-none focus:ring-1 focus:ring-primary-500"
        >
          <option value="Private">Private (only me)</option>
          <option value="Project">Project</option>
          <option value="Organization">Organization</option>
        </select>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saveQuery.isPending}
            className="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {saveQuery.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main query builder ──────────────────────────────────────────────

export function QueryBuilder() {
  const {
    queryText,
    setQueryText,
    tags,
    addTag,
    removeTag,
    statusFilters,
    toggleStatus,
    expiresAfter,
    setExpiresAfter,
    includeGraphExpansion,
    setIncludeGraphExpansion,
    includeTagExpansion,
    setIncludeTagExpansion,
    includeFulltextFallback,
    setIncludeFulltextFallback,
    visibilityMax,
    setVisibilityMax,
    advancedExpanded,
    setAdvancedExpanded,
    toSearchRequest,
  } = useSearchStore();

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [debouncedRequest, setDebouncedRequest] = useState(() => toSearchRequest(0));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the count request at 300ms
  const updateDebouncedRequest = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedRequest(toSearchRequest(0));
    }, 300);
  }, [toSearchRequest]);

  // Re-trigger debounced count on any filter change
  useEffect(() => {
    updateDebouncedRequest();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [
    queryText, tags, statusFilters, expiresAfter,
    includeGraphExpansion, includeTagExpansion, includeFulltextFallback,
    visibilityMax, updateDebouncedRequest,
  ]);

  const { data: matchCount, isFetching: countFetching } = useBeaconSearchCount(debouncedRequest);

  // Freshness helper: convert days input to ISO timestamp
  const handleFreshnessChange = (days: string) => {
    const n = Number.parseInt(days, 10);
    if (Number.isNaN(n) || n <= 0) {
      setExpiresAfter(null);
      return;
    }
    const d = new Date();
    d.setDate(d.getDate() + n);
    setExpiresAfter(d.toISOString());
  };

  const currentFreshnessDays = (() => {
    if (!expiresAfter) return '';
    const diff = new Date(expiresAfter).getTime() - Date.now();
    const days = Math.round(diff / (1000 * 60 * 60 * 24));
    return days > 0 ? String(days) : '';
  })();

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-5">
      {/* Primary tier: search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          type="text"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Search Beacons..."
          className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 pl-9 pr-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>

      {/* Primary tier: project scope + tags */}
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400 font-medium shrink-0">Project:</span>
          <ProjectSelector />
        </div>

        <div className="flex items-start gap-2 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400 font-medium shrink-0 pt-0.5">Tags:</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-700 dark:text-zinc-300"
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <TagInput onAdd={addTag} />
          </div>
        </div>
      </div>

      {/* Advanced tier toggle */}
      <button
        onClick={() => setAdvancedExpanded(!advancedExpanded)}
        className="mt-3 flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
      >
        {advancedExpanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Advanced filters
      </button>

      {/* Advanced tier */}
      {advancedExpanded && (
        <div className="mt-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-3">
          {/* Status checkboxes */}
          <div className="flex items-start gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium shrink-0 w-20">
              Status:
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              {STATUS_OPTIONS.map((status) => (
                <label key={status} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusFilters.includes(status)}
                    onChange={() => toggleStatus(status)}
                    className="rounded border-zinc-300 dark:border-zinc-600 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {STATUS_LABELS[status]}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Freshness range */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium shrink-0 w-20">
              Freshness:
            </span>
            <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <span>Expiring within</span>
              <input
                type="number"
                min={0}
                value={currentFreshnessDays}
                onChange={(e) => handleFreshnessChange(e.target.value)}
                placeholder="--"
                className="w-16 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <span>days</span>
            </div>
          </div>

          {/* Retrieval toggles */}
          <div className="flex items-start gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium shrink-0 w-20">
              Retrieval:
            </span>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeGraphExpansion}
                  onChange={(e) => setIncludeGraphExpansion(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-600 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-zinc-700 dark:text-zinc-300">Graph expansion</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeTagExpansion}
                  onChange={(e) => setIncludeTagExpansion(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-600 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-zinc-700 dark:text-zinc-300">Tag neighbors</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeFulltextFallback}
                  onChange={(e) => setIncludeFulltextFallback(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-600 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-zinc-700 dark:text-zinc-300">Keyword fallback</span>
              </label>
            </div>
          </div>

          {/* Visibility ceiling */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium shrink-0 w-20">
              Visibility:
            </span>
            <select
              value={visibilityMax ?? ''}
              onChange={(e) => setVisibilityMax(e.target.value || null)}
              className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="">Default (your highest)</option>
              {VISIBILITY_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Footer: count + save */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {countFetching ? (
            <span className="animate-pulse">Counting...</span>
          ) : matchCount != null ? (
            <>~{matchCount} Beacons match</>
          ) : (
            'Enter a query or select filters'
          )}
        </span>

        <button
          onClick={() => setSaveDialogOpen(true)}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Bookmark className="h-3.5 w-3.5" />
          Save query
        </button>
      </div>

      <SaveQueryDialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)} />
    </div>
  );
}
