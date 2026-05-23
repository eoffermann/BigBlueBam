// Wave F.3 — SuperUser per-user permissions editor.
// Mounted as a tab inside `/b3/superuser/people/:id`. Renders three sections:
//   1. Group memberships (one row per scope; dropdown to reassign, reattach button)
//   2. Explicit overrides (table of account_permissions rows; remove button)
//   3. Effective matrix browser (collapsible accordion grouped by app/resource
//      with search, source badge, and per-row toggle)
//
// Backed by the F-contract endpoints under /superuser/permissions/users/:id.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Trash2,
  Undo2,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/common/badge';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import {
  superuserPermissionsApi,
  type EffectiveEntry,
  type EffectiveSource,
  type PermissionCatalogItem,
  type PermissionGroupListItem,
  type ScopeType,
  type UserMembership,
  type UserOverride,
  type UserPermissionsResponse,
} from '@/lib/api/superuser-permissions';
import { formatDate } from '@/lib/utils';

interface UserPermissionsTabProps {
  userId: string;
}

const SCOPE_LABEL: Record<ScopeType, string> = {
  global: 'Global',
  org: 'Org',
  project: 'Project',
};

const SOURCE_LABEL: Record<EffectiveSource, string> = {
  group_default: 'group',
  override: 'override',
  snapshot: 'snapshot',
  superuser_bypass: 'SU bypass',
  implicit_deny: 'implicit deny',
};

function scopeKey(scope: { scope_type: ScopeType; scope_id: string | null }): string {
  return `${scope.scope_type}:${scope.scope_id ?? ''}`;
}

export function UserPermissionsTab({ userId }: UserPermissionsTabProps) {
  const queryClient = useQueryClient();
  const queryKey = ['superuser', 'permissions', 'user', userId];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => superuserPermissionsApi.getUserPermissions(userId),
  });

  const { data: groupsData } = useQuery({
    queryKey: ['superuser', 'permissions', 'groups'],
    queryFn: () => superuserPermissionsApi.listGroups(),
  });

  const { data: catalogData } = useQuery({
    queryKey: ['superuser', 'permissions', 'catalog', { limit: 2000 }],
    queryFn: () => superuserPermissionsApi.listCatalog({ limit: 2000 }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error || !data?.data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load permissions: {(error as Error | undefined)?.message ?? 'unknown error'}
      </div>
    );
  }

  const payload = data.data;
  const allGroups: PermissionGroupListItem[] = groupsData?.data ?? [];
  const catalog: PermissionCatalogItem[] = catalogData?.data?.items ?? [];

  return (
    <div className="space-y-6">
      {payload.user.is_superuser && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            This user has the SuperUser flag set. Every catalog permission resolves to
            allowed via the resolver short-circuit, so per-permission overrides have
            no effect for them.
          </span>
        </div>
      )}

      <MembershipsSection
        userId={userId}
        memberships={payload.memberships}
        allGroups={allGroups}
        onChanged={invalidate}
      />

      <OverridesSection
        userId={userId}
        overrides={payload.overrides}
        onChanged={invalidate}
      />

      <EffectiveMatrixSection
        userId={userId}
        effective={payload.effective_matrix}
        memberships={payload.memberships}
        catalog={catalog}
        onChanged={invalidate}
        isSuperuser={payload.user.is_superuser}
      />
    </div>
  );
}

// ─── Section card wrapper ───────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ─── Section 1 — Memberships ────────────────────────────────────────────────

function MembershipsSection({
  userId,
  memberships,
  allGroups,
  onChanged,
}: {
  userId: string;
  memberships: UserMembership[];
  allGroups: PermissionGroupListItem[];
  onChanged: () => void;
}) {
  return (
    <SectionCard
      title="Group memberships"
      description="One row per scope. Changing the group fires immediately. Reattach drops overrides at that scope."
    >
      {memberships.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-zinc-400">
          No group memberships. Use Add membership to assign one.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {memberships.map((m) => (
            <MembershipRow
              key={scopeKey(m)}
              userId={userId}
              membership={m}
              allGroups={allGroups}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function MembershipRow({
  userId,
  membership,
  allGroups,
  onChanged,
}: {
  userId: string;
  membership: UserMembership;
  allGroups: PermissionGroupListItem[];
  onChanged: () => void;
}) {
  // Filter groups that match this scope_type AND scope_id (or global).
  const availableGroups = useMemo(() => {
    return allGroups.filter((g) => {
      if (g.deleted_at !== null) return false;
      if (g.scope_type !== membership.scope_type) return false;
      // For org/project, also match scope_id when set on the group; built-in
      // global groups for org/project have scope_id null in some seeds and
      // are reused per-scope. We tolerate both — null scope_id means "applies
      // to any scope of this type".
      if (g.scope_id !== null && g.scope_id !== membership.scope_id) return false;
      return true;
    });
  }, [allGroups, membership.scope_type, membership.scope_id]);

  const groupOptions = availableGroups.map((g) => ({ value: g.id, label: g.name }));
  // Ensure the current group is selectable even if the listGroups response
  // hasn't loaded yet or is filtered out for some reason.
  if (!groupOptions.find((o) => o.value === membership.group.id)) {
    groupOptions.unshift({ value: membership.group.id, label: membership.group.name });
  }

  const setMembership = useMutation({
    mutationFn: (groupId: string) =>
      superuserPermissionsApi.setUserMembership(userId, {
        scope_type: membership.scope_type,
        scope_id: membership.scope_id,
        group_id: groupId,
      }),
    onSuccess: onChanged,
  });

  const reattach = useMutation({
    mutationFn: () =>
      superuserPermissionsApi.reattachUser(userId, {
        scope_type: membership.scope_type,
        scope_id: membership.scope_id,
      }),
    onSuccess: onChanged,
  });

  const isDetached = membership.detached_at !== null;
  const scopeLabel =
    membership.scope_type === 'global'
      ? 'Global'
      : `${SCOPE_LABEL[membership.scope_type]}: ${membership.scope_name ?? membership.scope_id?.slice(0, 8) ?? '—'}`;

  return (
    <li className="flex flex-wrap items-center gap-3 px-6 py-3 text-sm">
      <div className="min-w-[160px]">
        <div className="text-zinc-900 dark:text-zinc-100 font-medium">{scopeLabel}</div>
        {membership.scope_id && membership.scope_name && (
          <div className="text-[11px] font-mono text-zinc-400">
            {membership.scope_id.slice(0, 8)}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-1">
        <Select
          options={groupOptions}
          value={membership.group.id}
          onValueChange={(v) => setMembership.mutate(v)}
          className="w-44"
        />
        {membership.group.is_builtin && (
          <Badge variant="info">Built-in</Badge>
        )}
        {setMembership.isPending && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
        )}
        {setMembership.isError && (
          <span className="text-xs text-red-600">
            {(setMembership.error as Error).message}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {isDetached && <Badge variant="warning">Detached</Badge>}
        {isDetached && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => reattach.mutate()}
            loading={reattach.isPending}
          >
            <Undo2 className="h-3.5 w-3.5" /> Reattach
          </Button>
        )}
      </div>
    </li>
  );
}

// ─── Section 2 — Overrides ──────────────────────────────────────────────────

function OverridesSection({
  userId,
  overrides,
  onChanged,
}: {
  userId: string;
  overrides: UserOverride[];
  onChanged: () => void;
}) {
  const remove = useMutation({
    mutationFn: (o: UserOverride) =>
      superuserPermissionsApi.clearUserOverride(userId, o.permission_id, {
        scope_type: o.scope_type,
        scope_id: o.scope_id,
      }),
    onSuccess: onChanged,
  });

  return (
    <SectionCard
      title="Explicit overrides"
      description={`${overrides.length} per-permission override${overrides.length === 1 ? '' : 's'}. Snapshot rows were auto-frozen by the detach trigger.`}
    >
      {overrides.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-zinc-400">
          No overrides. The user inherits all permissions from their group memberships.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                <th className="px-4 py-2.5 font-medium text-zinc-500">Scope</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Permission</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Decision</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Set by</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Set at</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr
                  key={`${scopeKey(o)}:${o.permission_id}`}
                  className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
                >
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-300">
                    <span className="font-medium">{SCOPE_LABEL[o.scope_type]}</span>
                    {o.scope_id && (
                      <span className="ml-1 text-[11px] font-mono text-zinc-400">
                        {o.scope_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                      {o.permission_id}
                    </span>
                    {o.is_snapshot && (
                      <span className="ml-2 text-[11px] text-zinc-400">(snapshot)</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {o.granted ? (
                      <Badge variant="success">Allow</Badge>
                    ) : (
                      <Badge variant="danger">Deny</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-zinc-500">
                    {o.set_by ? o.set_by.slice(0, 8) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {formatDate(o.set_at)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400 max-w-[260px] truncate"
                    title={o.notes ?? ''}
                  >
                    {o.notes || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => remove.mutate(o)}
                      disabled={remove.isPending}
                      className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors disabled:opacity-50"
                      title="Remove override"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Section 3 — Effective matrix ───────────────────────────────────────────

interface MatrixRow {
  id: string;
  description: string;
  app: string;
  resource: string;
  granted: boolean;
  source: EffectiveSource;
  requires_superuser: boolean;
}

function EffectiveMatrixSection({
  userId,
  effective,
  memberships,
  catalog,
  onChanged,
  isSuperuser,
}: {
  userId: string;
  effective: Record<string, EffectiveEntry>;
  memberships: UserMembership[];
  catalog: PermissionCatalogItem[];
  onChanged: () => void;
  isSuperuser: boolean;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [openApps, setOpenApps] = useState<Set<string>>(new Set());

  // Compose the rows. Prefer catalog ordering (which gives us description
  // and app/resource grouping); fall back to entries that exist only in the
  // effective matrix (shouldn't happen, but be defensive).
  const rows: MatrixRow[] = useMemo(() => {
    const out: MatrixRow[] = [];
    const seen = new Set<string>();
    for (const c of catalog) {
      const eff = effective[c.id];
      if (!eff) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        description: c.description,
        app: c.app,
        resource: c.resource,
        granted: eff.granted,
        source: eff.source,
        requires_superuser: c.requires_superuser,
      });
    }
    for (const [id, eff] of Object.entries(effective)) {
      if (seen.has(id)) continue;
      const parts = id.split('.');
      out.push({
        id,
        description: '',
        app: parts[0] ?? 'unknown',
        resource: parts[1] ?? 'unknown',
        granted: eff.granted,
        source: eff.source,
        requires_superuser: false,
      });
    }
    return out;
  }, [catalog, effective]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [rows, search]);

  // Group by app for accordion rendering.
  const grouped = useMemo(() => {
    const m = new Map<string, MatrixRow[]>();
    for (const r of filtered) {
      const list = m.get(r.app) ?? [];
      list.push(r);
      m.set(r.app, list);
    }
    // sort apps alphabetically and rows within each app
    const apps = [...m.keys()].sort();
    return apps.map((app) => ({
      app,
      rows: (m.get(app) ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    }));
  }, [filtered]);

  const grantedCount = rows.filter((r) => r.granted).length;

  // When a user has multiple memberships, picking which scope to write the
  // override under is ambiguous. We pick the org scope first (most common
  // case), fall back to global, then project.
  const primaryScope = useMemo(() => {
    return (
      memberships.find((m) => m.scope_type === 'org') ??
      memberships.find((m) => m.scope_type === 'global') ??
      memberships.find((m) => m.scope_type === 'project') ??
      null
    );
  }, [memberships]);

  const queryKey = ['superuser', 'permissions', 'user', userId];

  const setOverride = useMutation({
    mutationFn: ({ id, granted }: { id: string; granted: boolean }) => {
      if (!primaryScope) {
        return Promise.reject(new Error('No scope available to write override'));
      }
      return superuserPermissionsApi.setUserOverride(userId, id, {
        scope_type: primaryScope.scope_type,
        scope_id: primaryScope.scope_id,
        granted,
        notes:
          granted
            ? 'Manually allowed via SuperUser console'
            : 'Manually denied via SuperUser console',
      });
    },
    onMutate: async ({ id, granted }) => {
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData<UserPermissionsResponse>(queryKey);
      if (prev) {
        queryClient.setQueryData<UserPermissionsResponse>(queryKey, {
          ...prev,
          data: {
            ...prev.data,
            effective_matrix: {
              ...prev.data.effective_matrix,
              [id]: { granted, source: 'override' },
            },
          },
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKey, ctx.prev);
    },
    onSettled: onChanged,
  });

  const clearOverride = useMutation({
    mutationFn: ({ id }: { id: string }) => {
      if (!primaryScope) {
        return Promise.reject(new Error('No scope available to clear override'));
      }
      return superuserPermissionsApi.clearUserOverride(userId, id, {
        scope_type: primaryScope.scope_type,
        scope_id: primaryScope.scope_id,
      });
    },
    onSettled: onChanged,
  });

  const toggleApp = (app: string) => {
    setOpenApps((s) => {
      const next = new Set(s);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  };

  const onTogglePermission = (row: MatrixRow) => {
    if (row.source === 'superuser_bypass') return; // disabled
    if (row.source === 'override' || row.source === 'snapshot') {
      // Remove the override — falls back to group default.
      clearOverride.mutate({ id: row.id });
    } else {
      // group_default or implicit_deny — write the inverse override.
      setOverride.mutate({ id: row.id, granted: !row.granted });
    }
  };

  return (
    <SectionCard
      title="Effective permission matrix"
      description={`${grantedCount.toLocaleString()} of ${rows.length.toLocaleString()} permissions allowed${
        primaryScope
          ? ` · writing overrides at ${SCOPE_LABEL[primaryScope.scope_type]} scope`
          : ''
      }`}
    >
      <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none z-10" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by id or description..."
            className="pl-9 h-8 text-xs"
          />
        </div>
        <div className="text-xs text-zinc-500 tabular-nums">
          {filtered.length} match{filtered.length === 1 ? '' : 'es'}
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-zinc-400">No permissions match.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {grouped.map(({ app, rows: appRows }) => {
            const isOpen = openApps.has(app) || search.trim().length > 0;
            const appGranted = appRows.filter((r) => r.granted).length;
            return (
              <li key={app}>
                <button
                  type="button"
                  onClick={() => toggleApp(app)}
                  className="flex items-center gap-2 w-full px-6 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {app}
                  </span>
                  <span className="text-xs text-zinc-500 tabular-nums">
                    {appGranted}/{appRows.length} allowed
                  </span>
                </button>
                {isOpen && (
                  <ul className="bg-zinc-50/40 dark:bg-zinc-900/40">
                    {appRows.map((row) => (
                      <MatrixRowItem
                        key={row.id}
                        row={row}
                        onToggle={() => onTogglePermission(row)}
                        disabled={
                          row.source === 'superuser_bypass' ||
                          isSuperuser ||
                          setOverride.isPending ||
                          clearOverride.isPending
                        }
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function MatrixRowItem({
  row,
  onToggle,
  disabled,
}: {
  row: MatrixRow;
  onToggle: () => void;
  disabled: boolean;
}) {
  const sourceBadge =
    row.source === 'override' ? (
      <Badge variant="primary">override</Badge>
    ) : row.source === 'snapshot' ? (
      <Badge variant="info">snapshot</Badge>
    ) : row.source === 'superuser_bypass' ? (
      <Badge variant="danger">SU bypass</Badge>
    ) : row.source === 'implicit_deny' ? (
      <Badge variant="default">implicit deny</Badge>
    ) : (
      <Badge variant="default">group</Badge>
    );

  return (
    <li className="flex items-center gap-3 pl-12 pr-6 py-2 text-xs border-t border-zinc-100/60 dark:border-zinc-800/60">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-zinc-700 dark:text-zinc-300 truncate">{row.id}</div>
        {row.description && (
          <div className="text-[11px] text-zinc-500 truncate">{row.description}</div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {sourceBadge}
        {row.requires_superuser && (
          <Badge variant="warning">SU-only</Badge>
        )}
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className={
            'inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
            (row.granted
              ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50'
              : 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50')
          }
          title={
            disabled && row.source === 'superuser_bypass'
              ? 'SuperUser bypass is a global flag, not a per-permission grant'
              : row.granted
                ? 'Click to deny'
                : 'Click to allow'
          }
        >
          {row.granted ? 'Allowed' : 'Denied'}
        </button>
        <span className="text-[10px] text-zinc-400 hidden sm:inline">
          {SOURCE_LABEL[row.source]}
        </span>
      </div>
    </li>
  );
}
