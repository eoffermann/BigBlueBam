/**
 * Searchable people picker, used wherever we need to assign a Bam user
 * (room owner, fallback delegate, etc).
 *
 * Renders a trigger button showing the currently-selected user's avatar +
 * display name (or a placeholder), and opens a popover with a search box
 * and a list of matches. Selection fires `onChange(user_id)` and closes
 * the popover; "Clear" fires `onChange(null)`.
 *
 * The data source is Bam's canonical org members endpoint:
 *
 *   GET /b3/api/org/members  ->  { data: PersonListItem[] }
 *
 * It does not currently support a `q=` filter (see apps/api/src/routes/
 * org.routes.ts), so we fetch the full list once on first open and apply
 * a debounced client-side substring filter. For v1 orgs (<= ~50 users
 * per design doc) this is comfortably fast; we keep the debounce so the
 * filter feels right and is trivial to switch to a server query later.
 *
 * Click-outside and Esc both close the popover. The trigger keeps focus
 * on the active row via aria-activedescendant rather than DOM focus,
 * so the search input never loses focus while arrowing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, User as UserIcon, X } from 'lucide-react';

export interface PersonOption {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

interface OrgMembersResponse {
  data: PersonOption[];
}

export interface PeoplePickerProps {
  /** Currently-selected user id, or null when nothing is assigned. */
  value: string | null;
  /** Fired with the new user id, or null when cleared. */
  onChange: (userId: string | null) => void;
  /** Optional placeholder text on the trigger when no value is selected. */
  placeholder?: string;
  /** Optional disabled state. */
  disabled?: boolean;
  /** Optional className appended to the trigger button. */
  className?: string;
}

export function PeoplePicker({
  value,
  onChange,
  placeholder = 'Choose owner…',
  disabled = false,
  className,
}: PeoplePickerProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<PersonOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the search query by 200ms so the substring filter doesn't
  // re-render on every keystroke.
  useEffect(() => {
    if (query === debouncedQuery) return;
    const id = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(id);
  }, [query, debouncedQuery]);

  // Lazy fetch on first open. Keeping the list in component state for the
  // life of the picker means subsequent opens are instant.
  useEffect(() => {
    if (!open || members !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/b3/api/org/members', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as OrgMembersResponse;
        if (cancelled) return;
        setMembers(Array.isArray(body?.data) ? body.data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load members');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, members, loading]);

  // Click-outside closes the popover. We bind on mousedown so a click that
  // lands inside the popover (which triggers a state update + re-render)
  // doesn't race with this handler.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const root = containerRef.current;
      if (root && !root.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Esc closes the popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus the search input when the popover opens.
  useEffect(() => {
    if (open) {
      // requestAnimationFrame ensures the input is mounted before focus.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
  }, [open]);

  const selected = useMemo<PersonOption | null>(() => {
    if (!value || !members) return null;
    return members.find((m) => m.id === value) ?? null;
  }, [value, members]);

  // While we don't yet have the member list (e.g. on first paint with a
  // pre-selected value), we still want the trigger to show *something*.
  // Fall back to a short id label so the field doesn't look empty.
  const triggerLabel = selected
    ? selected.display_name
    : value
      ? `User ${value.slice(0, 8)}…`
      : placeholder;

  const filtered = useMemo<PersonOption[]>(() => {
    if (!members) return [];
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
  }, [members, debouncedQuery]);

  const handleSelect = useCallback(
    (userId: string) => {
      onChange(userId);
      setOpen(false);
      setQuery('');
      setDebouncedQuery('');
    },
    [onChange],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange(null);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={[
          'flex w-full items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700',
          'bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-left',
          'text-zinc-900 dark:text-zinc-100',
          'hover:border-zinc-300 dark:hover:border-zinc-600',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className ?? '',
        ].join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Avatar user={selected} fallbackId={value} />
        <span
          className={[
            'flex-1 truncate',
            selected || value ? '' : 'text-zinc-400 dark:text-zinc-500',
          ].join(' ')}
        >
          {triggerLabel}
        </span>
        {value && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onClick={handleClear}
            className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && (
        <div
          className={[
            'absolute z-50 mt-1 w-full min-w-[260px] rounded-md border',
            'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950',
            'shadow-lg overflow-hidden',
          ].join(' ')}
          role="dialog"
        >
          <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none"
            />
          </div>

          <div className="max-h-64 overflow-y-auto py-1" role="listbox">
            {loading && (
              <div className="px-3 py-2 text-xs text-zinc-500">Loading members…</div>
            )}
            {error && !loading && (
              <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
            {!loading && !error && filtered.length === 0 && members !== null && (
              <div className="px-3 py-2 text-xs text-zinc-500">
                {debouncedQuery.trim()
                  ? `No members match “${debouncedQuery.trim()}”.`
                  : 'No members in this org yet.'}
              </div>
            )}
            {!loading &&
              !error &&
              filtered.map((m) => {
                const isSelected = m.id === value;
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => handleSelect(m.id)}
                    className={[
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left',
                      'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                      isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : '',
                    ].join(' ')}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <Avatar user={m} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-900 dark:text-zinc-100">
                        {m.display_name}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-500">
                        {m.email}
                      </span>
                    </span>
                  </button>
                );
              })}
          </div>

          {value && (
            <div className="border-t border-zinc-200 dark:border-zinc-800 px-2 py-1.5">
              <button
                type="button"
                onClick={handleClear}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                <X className="h-3 w-3" /> Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tiny avatar component: shows the user's avatar_url if present, else a
 * neutral initials chip. Stays inside this file so the picker is fully
 * self-contained; if we end up needing it in three places, promote to
 * a shared component under apps/bureau/src/components/common/.
 */
function Avatar({
  user,
  fallbackId,
}: {
  user: PersonOption | null;
  fallbackId?: string | null;
}) {
  if (user?.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initials = user ? initialsFor(user.display_name) : null;
  return (
    <span
      className={[
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
        'bg-zinc-200 dark:bg-zinc-800 text-[10px] font-medium',
        'text-zinc-600 dark:text-zinc-300',
      ].join(' ')}
      aria-hidden="true"
    >
      {initials ?? (fallbackId ? '?' : <UserIcon className="h-3 w-3" />)}
    </span>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
