// Wave F.2 — Per-group permissions editor.
// Two-column layout:
//   - Left: collapsible app → resource tree (filters the right pane).
//   - Right: rows of (permission id, description, toggle).
// Bulk operations:
//   - Glob input (grant <glob> / deny <glob>) stages all matches into dirty state.
//   - Save Changes → PUT /defaults with set_true / set_false arrays.
//   - Reset to defaults → POST /reset (with confirmation).
// Dirty state is held locally and only flushed on Save.
//
// Performance strategy: instead of rendering all 1047 rows we filter the
// right pane by the selected app (and resource if drilled in). At most we
// render the rows for one app at a time (≈100-150 perms each). Combined
// with a search box at the top this keeps the React tree small while
// still letting an operator audit the whole catalog.

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronDown,
  Save,
  RotateCcw,
  Lock,
  Search,
  X,
  AlertTriangle,
  ShieldAlert,
  Eye,
} from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Dialog } from '@/components/common/dialog';
import { Badge } from '@/components/common/badge';
import { ApiError } from '@/lib/api';
import {
  superuserPermissionsApi,
  type PermissionCatalogItem,
  type PermissionGroupDetail,
  type SetDefaultsInput,
} from '@/lib/api/superuser-permissions';

interface GroupDetailProps {
  groupId: string;
  onNavigate: (path: string) => void;
}

type DirtyMap = Record<string, boolean>; // permission_id → desired granted state

export function PermissionsGroupDetailPage({ groupId, onNavigate }: GroupDetailProps) {
  const queryClient = useQueryClient();

  // Fetch the group + its full defaults map.
  const groupQuery = useQuery({
    queryKey: ['superuser', 'permissions', 'group', groupId],
    queryFn: () => superuserPermissionsApi.getGroup(groupId),
  });

  // Fetch the entire catalog. The contract guarantees `defaults` covers
  // every catalog id, so we use catalog as the authoritative ordering /
  // metadata source.
  const catalogQuery = useQuery({
    queryKey: ['superuser', 'permissions', 'catalog', 'all'],
    queryFn: () => superuserPermissionsApi.listCatalog({ limit: 2000 }),
  });

  const group = groupQuery.data?.data;
  const catalogItems: PermissionCatalogItem[] = catalogQuery.data?.data.items ?? [];

  // ─── Header editable fields (non-built-in only) ──────────────────────────
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');

  useEffect(() => {
    if (group) {
      setNameDraft(group.group.name);
      setDescDraft(group.group.description ?? '');
    }
  }, [group]);

  // ─── Dirty toggle state ──────────────────────────────────────────────────
  const [dirty, setDirty] = useState<DirtyMap>({});

  // Reset dirty when the group is refetched (after save).
  useEffect(() => {
    setDirty({});
  }, [groupQuery.dataUpdatedAt]);

  // ─── Filter / navigation state for the left tree ─────────────────────────
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Globs for bulk grant/deny.
  const [globInput, setGlobInput] = useState('');

  // Compute effective grant state: dirty overrides defaults.
  const effective = useCallback(
    (permId: string): boolean => {
      if (permId in dirty) return dirty[permId]!;
      return group?.defaults?.[permId] ?? false;
    },
    [dirty, group],
  );

  // Build the app → resource → perms tree.
  const tree = useMemo(() => {
    const t: Record<string, Record<string, PermissionCatalogItem[]>> = {};
    for (const item of catalogItems) {
      if (!t[item.app]) t[item.app] = {};
      if (!t[item.app]![item.resource]) t[item.app]![item.resource] = [];
      t[item.app]![item.resource]!.push(item);
    }
    return t;
  }, [catalogItems]);

  const appList = useMemo(() => Object.keys(tree).sort(), [tree]);

  // Compute granted/denied totals (incl. dirty edits).
  const counts = useMemo(() => {
    if (!group || catalogItems.length === 0) return { granted: 0, denied: 0 };
    let granted = 0;
    let denied = 0;
    for (const item of catalogItems) {
      if (effective(item.id)) granted++;
      else denied++;
    }
    return { granted, denied };
  }, [group, catalogItems, effective]);

  const dirtyCount = Object.keys(dirty).length;

  // Build the rows the right pane will render.
  const visibleRows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return catalogItems
      .filter((it) => {
        if (selectedApp && it.app !== selectedApp) return false;
        if (selectedResource && it.resource !== selectedResource) return false;
        if (s && !it.id.toLowerCase().includes(s) && !it.description.toLowerCase().includes(s)) {
          return false;
        }
        return true;
      })
      // Order by id for stability.
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [catalogItems, selectedApp, selectedResource, search]);

  // ─── Mutations ───────────────────────────────────────────────────────────

  const saveMut = useMutation({
    mutationFn: (body: SetDefaultsInput) => superuserPermissionsApi.setDefaults(groupId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'group', groupId] });
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'groups'] });
      setDirty({});
    },
  });

  const resetMut = useMutation({
    mutationFn: () => superuserPermissionsApi.resetGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'group', groupId] });
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'groups'] });
      setDirty({});
    },
  });

  const updateMut = useMutation({
    mutationFn: () =>
      superuserPermissionsApi.updateGroup(groupId, {
        name: nameDraft.trim(),
        description: descDraft.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'group', groupId] });
      queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'groups'] });
    },
  });

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const toggleOne = (item: PermissionCatalogItem) => {
    const current = effective(item.id);
    const originalDefault = group?.defaults?.[item.id] ?? false;
    setDirty((prev) => {
      const next = { ...prev };
      const desired = !current;
      if (desired === originalDefault) {
        delete next[item.id];
      } else {
        next[item.id] = desired;
      }
      return next;
    });
  };

  const expandGlob = useCallback(
    (glob: string): PermissionCatalogItem[] => {
      const trimmed = glob.trim();
      if (!trimmed) return [];
      // Convert glob "<app>.*", "<app>.<resource>.*" or exact id to a predicate.
      // Map * → .* and . → \.
      const pattern = '^' + trimmed.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$';
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return [];
      }
      return catalogItems.filter((it) => re.test(it.id));
    },
    [catalogItems],
  );

  const applyGlob = (glob: string, granted: boolean) => {
    const matches = expandGlob(glob);
    if (matches.length === 0) return;
    setDirty((prev) => {
      const next = { ...prev };
      for (const m of matches) {
        const originalDefault = group?.defaults?.[m.id] ?? false;
        if (granted === originalDefault) {
          delete next[m.id];
        } else {
          next[m.id] = granted;
        }
      }
      return next;
    });
  };

  const handleSave = () => {
    const set_true: string[] = [];
    const set_false: string[] = [];
    for (const [pid, desired] of Object.entries(dirty)) {
      if (desired) set_true.push(pid);
      else set_false.push(pid);
    }
    saveMut.mutate({ set_true, set_false });
  };

  const isBuiltin = group?.group.is_builtin ?? false;
  const nameDirty = group ? nameDraft.trim() !== group.group.name : false;
  const descDirty = group ? descDraft.trim() !== (group.group.description ?? '') : false;
  const headerDirty = (nameDirty && !isBuiltin) || descDirty;

  // ─── Render ──────────────────────────────────────────────────────────────

  if (groupQuery.isLoading || catalogQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (groupQuery.error || !group) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load group: {(groupQuery.error as Error | undefined)?.message ?? 'not found'}
        <div className="mt-2">
          <Button variant="secondary" onClick={() => onNavigate('/superuser')}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header / breadcrumbs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onNavigate('/superuser')}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Back to groups"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="text-sm text-zinc-500">Permissions / Groups /</div>
        <div className="font-semibold text-zinc-900 dark:text-zinc-100">{group.group.name}</div>
        {isBuiltin && (
          <Badge variant="default" className="uppercase text-[10px] tracking-wider">
            <Lock className="h-2.5 w-2.5 mr-1" />
            Built-in
          </Badge>
        )}
      </div>

      {/* Header card: name + description (editable) + counts + save bar */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 flex flex-col gap-3">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500 mb-1">
                Name
              </label>
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                disabled={isBuiltin}
                maxLength={100}
              />
              {isBuiltin && (
                <p className="mt-1 text-xs text-zinc-500">
                  Built-in group names cannot be renamed (maps to legacy_role).
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500 mb-1">
                Description
              </label>
              <Input
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Describe what this group is for"
                maxLength={500}
              />
            </div>
            {headerDirty && (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => updateMut.mutate()} loading={updateMut.isPending}>
                  <Save className="h-3.5 w-3.5" /> Save header
                </Button>
                {updateMut.error && (
                  <span className="text-xs text-red-600">
                    {(updateMut.error as Error).message}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <CountTile label="Granted" value={counts.granted} accent="emerald" />
            <CountTile label="Denied" value={counts.denied} accent="red" />
            <CountTile label="Members" value={group.member_count} accent="zinc" />
          </div>
        </div>
      </div>

      {/* Bulk + save bar */}
      <div className="sticky top-0 z-10 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[280px]">
          <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Bulk:</span>
          <Input
            value={globInput}
            onChange={(e) => setGlobInput(e.target.value)}
            placeholder="bam.task.*"
            className="text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyGlob(globInput, true)}
            disabled={!globInput.trim()}
            title="Stage matching perms as granted"
          >
            Grant
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyGlob(globInput, false)}
            disabled={!globInput.trim()}
            title="Stage matching perms as denied"
          >
            Deny
          </Button>
          {globInput.trim() && (
            <span className="text-xs text-zinc-500 whitespace-nowrap">
              matches {expandGlob(globInput).length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              {dirtyCount} change{dirtyCount === 1 ? '' : 's'} pending
            </span>
          )}
          <Button
            variant="secondary"
            onClick={() => setResetConfirmOpen(true)}
            disabled={resetMut.isPending}
          >
            <RotateCcw className="h-4 w-4" /> Reset to defaults
          </Button>
          <Button
            onClick={handleSave}
            loading={saveMut.isPending}
            disabled={dirtyCount === 0 || saveMut.isPending}
          >
            <Save className="h-4 w-4" /> Save Changes
          </Button>
        </div>
      </div>
      {saveMut.error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          Save failed: {(saveMut.error as ApiError).message}
        </div>
      )}
      {resetMut.error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          Reset failed: {(resetMut.error as ApiError).message}
        </div>
      )}

      {/* Two-column tree + rows */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <aside className="lg:col-span-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 max-h-[70vh] overflow-y-auto">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Apps</div>
          <button
            onClick={() => {
              setSelectedApp(null);
              setSelectedResource(null);
            }}
            className={`w-full text-left text-sm rounded-md px-2 py-1 mb-1 ${
              selectedApp === null
                ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
            }`}
          >
            All apps ({catalogItems.length})
          </button>
          {appList.map((app) => {
            const isExpanded = expandedApps.has(app);
            const resources = Object.keys(tree[app] ?? {}).sort();
            const totalInApp = resources.reduce(
              (s, r) => s + (tree[app]?.[r]?.length ?? 0),
              0,
            );
            return (
              <div key={app}>
                <button
                  onClick={() => {
                    setSelectedApp(app);
                    setSelectedResource(null);
                    setExpandedApps((prev) => {
                      const next = new Set(prev);
                      if (next.has(app)) next.delete(app);
                      else next.add(app);
                      return next;
                    });
                  }}
                  className={`w-full text-left text-sm rounded-md px-2 py-1 flex items-center gap-1.5 ${
                    selectedApp === app && !selectedResource
                      ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="font-medium">{app}</span>
                  <span className="ml-auto text-xs text-zinc-400 tabular-nums">{totalInApp}</span>
                </button>
                {isExpanded && (
                  <div className="ml-5 mt-1 flex flex-col gap-0.5 mb-2">
                    {resources.map((r) => {
                      const count = tree[app]?.[r]?.length ?? 0;
                      const isSelected = selectedApp === app && selectedResource === r;
                      return (
                        <button
                          key={r}
                          onClick={() => {
                            setSelectedApp(app);
                            setSelectedResource(r);
                          }}
                          className={`text-left text-xs rounded-md px-2 py-1 flex items-center ${
                            isSelected
                              ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                              : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          <span className="truncate">{r}</span>
                          <span className="ml-auto text-zinc-400 tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        <section className="lg:col-span-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search permission id or description..."
                className="pl-9"
              />
            </div>
            <div className="text-xs text-zinc-500">
              {visibleRows.length} of {catalogItems.length} perms
            </div>
            {(selectedApp || selectedResource || search) && (
              <button
                onClick={() => {
                  setSelectedApp(null);
                  setSelectedResource(null);
                  setSearch('');
                }}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center gap-1"
              >
                <X className="h-3 w-3" /> Clear filters
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50 sticky top-0">
                <tr className="text-left text-xs uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2 font-medium">Permission</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Allow</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-zinc-500">
                      No permissions match this filter.
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((item) => {
                    const allowed = effective(item.id);
                    const isDirty = item.id in dirty;
                    return (
                      <tr
                        key={item.id}
                        className={
                          'hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ' +
                          (isDirty ? 'bg-amber-50/30 dark:bg-amber-900/10' : '')
                        }
                      >
                        <td className="px-3 py-2 font-mono text-xs text-zinc-900 dark:text-zinc-100 align-top">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{item.id}</span>
                            {item.is_destructive && (
                              <span title="Destructive" className="inline-flex items-center text-red-600">
                                <ShieldAlert className="h-3 w-3" />
                              </span>
                            )}
                            {item.is_read && (
                              <span title="Read-only" className="inline-flex items-center text-blue-500">
                                <Eye className="h-3 w-3" />
                              </span>
                            )}
                            {item.requires_superuser && (
                              <Badge variant="default" className="text-[9px] tracking-wider uppercase">
                                SU
                              </Badge>
                            )}
                            {isDirty && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 uppercase font-semibold">
                                · changed
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 align-top">
                          {item.description}
                        </td>
                        <td className="px-3 py-2 text-right align-top">
                          <Toggle checked={allowed} onChange={() => toggleOne(item)} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Reset confirmation */}
      <Dialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset group to defaults?"
        description={
          isBuiltin
            ? 'Restores the migration-seeded baseline for this built-in group. Any custom edits to its defaults will be discarded.'
            : 'Restores defaults from the original clone source (or Member defaults if none). Any custom edits will be discarded.'
        }
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              This will overwrite every permission default for{' '}
              <span className="font-semibold">{group.group.name}</span>. Unsaved local toggles will
              be lost.
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setResetConfirmOpen(false)}
              disabled={resetMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                resetMut.mutate();
                setResetConfirmOpen(false);
              }}
              loading={resetMut.isPending}
            >
              <RotateCcw className="h-4 w-4" /> Reset defaults
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Toggle switch ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
        (checked ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700')
      }
    >
      <span
        className={
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ' +
          (checked ? 'translate-x-4.5' : 'translate-x-0.5')
        }
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

// ─── Stat tile ─────────────────────────────────────────────────────────────

function CountTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'emerald' | 'red' | 'zinc';
}) {
  const colorMap = {
    emerald: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-900/50',
    red: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-900/50',
    zinc: 'text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800',
  } as const;
  return (
    <div
      className={`rounded-lg border px-3 py-2 flex items-center justify-between ${colorMap[accent]}`}
    >
      <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

// Unused helper retained for the type definition used elsewhere.
export type { PermissionGroupDetail };
