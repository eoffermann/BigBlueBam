// Wave F.2 — SuperUser permissions groups list.
// Renders all permission_groups (built-in + custom) in a sortable table
// with create/edit/delete affordances. Routes into the per-group editor
// at /b3/superuser/permissions/groups/:id.

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Pencil, Trash2, ShieldCheck, Lock } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { Badge } from '@/components/common/badge';
import { formatRelativeTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import {
  superuserPermissionsApi,
  type PermissionGroupListItem,
  type ScopeType,
  type CreateGroupInput,
} from '@/lib/api/superuser-permissions';

interface PermissionsGroupsListProps {
  onNavigate: (path: string) => void;
}

type SortKey = 'name' | 'member_count';

const SCOPE_OPTIONS: { value: ScopeType; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'org', label: 'Organization' },
  { value: 'project', label: 'Project' },
];

export function PermissionsGroupsListPage({ onNavigate }: PermissionsGroupsListProps) {
  const queryClient = useQueryClient();
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PermissionGroupListItem | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['superuser', 'permissions', 'groups'],
    queryFn: () => superuserPermissionsApi.listGroups(),
  });

  const groups = useMemo(() => {
    const raw = data?.data ?? [];
    const sorted = [...raw].sort((a, b) => {
      if (sortKey === 'member_count') {
        return sortDir === 'asc' ? a.member_count - b.member_count : b.member_count - a.member_count;
      }
      return sortDir === 'asc'
        ? a.name.localeCompare(b.name)
        : b.name.localeCompare(a.name);
    });
    return sorted;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'member_count' ? 'desc' : 'asc');
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['superuser', 'permissions', 'groups'] });

  const deleteMut = useMutation({
    mutationFn: (id: string) => superuserPermissionsApi.deleteGroup(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary-600" /> Permission groups
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
            Built-in + custom groups. Click a row to edit per-permission defaults.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New Group
        </Button>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">
              <SortHeader onClick={() => toggleSort('name')}>Name{sortIndicator('name')}</SortHeader>
              <th className="px-4 py-2.5">Scope</th>
              <SortHeader align="right" onClick={() => toggleSort('member_count')}>
                Members{sortIndicator('member_count')}
              </SortHeader>
              <th className="px-4 py-2.5 text-right">Granted</th>
              <th className="px-4 py-2.5 text-right">Denied</th>
              <th className="px-4 py-2.5">Updated</th>
              <th className="px-4 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center">
                  <Loader2 className="h-5 w-5 animate-spin text-primary-500 mx-auto" />
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-red-600 dark:text-red-400">
                  Failed to load groups: {(error as Error).message}
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-zinc-500">
                  No groups found.
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <tr
                  key={g.id}
                  onClick={() => onNavigate(`/superuser/permissions/groups/${g.id}`)}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{g.name}</span>
                      {g.is_builtin && (
                        <Badge variant="default" className="uppercase text-[10px] tracking-wider">
                          <Lock className="h-2.5 w-2.5 mr-1" />
                          Built-in
                        </Badge>
                      )}
                    </div>
                    {g.description && (
                      <div className="text-xs text-zinc-500 mt-0.5">{g.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs capitalize">{g.scope_type}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {g.member_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                    {g.grant_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-red-700 dark:text-red-400">
                    {g.deny_count}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">
                    {g.updated_at ? formatRelativeTime(g.updated_at) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onNavigate(`/superuser/permissions/groups/${g.id}`)}
                        title="Edit group"
                        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {!g.is_builtin && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(g)}
                          title="Delete group"
                          className="rounded-md p-1.5 text-zinc-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-700 dark:hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        groups={data?.data ?? []}
        onSuccess={invalidate}
      />

      <DeleteGroupDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={(id) => deleteMut.mutate(id)}
        pending={deleteMut.isPending}
        error={deleteMut.error as ApiError | null}
      />
    </div>
  );
}

function SortHeader({
  onClick,
  align = 'left',
  children,
}: {
  onClick?: () => void;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  return (
    <th
      onClick={onClick}
      className={
        'px-4 py-2.5 cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300 ' +
        (align === 'right' ? 'text-right' : 'text-left')
      }
    >
      {children}
    </th>
  );
}

// ─── Create group dialog ────────────────────────────────────────────────────

function CreateGroupDialog({
  open,
  onOpenChange,
  groups,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: PermissionGroupListItem[];
  onSuccess: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('global');
  const [scopeId, setScopeId] = useState('');
  const [cloneFromId, setCloneFromId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setScopeType('global');
      setScopeId('');
      setCloneFromId('');
      setError(null);
    }
  }, [open]);

  const createMut = useMutation({
    mutationFn: (body: CreateGroupInput) => superuserPermissionsApi.createGroup(body),
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (scopeType !== 'global' && !scopeId.trim()) {
      setError('Scope ID is required for org and project scope.');
      return;
    }
    const body: CreateGroupInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      scope_type: scopeType,
      scope_id: scopeType === 'global' ? null : scopeId.trim(),
      clone_from_group_id: cloneFromId || undefined,
    };
    createMut.mutate(body);
  };

  // Show all live (non-deleted) groups as clone sources.
  const cloneOptions = useMemo(
    () => [
      { value: '', label: 'Default (Member-like)' },
      ...groups
        .filter((g) => !g.deleted_at)
        .map((g) => ({
          value: g.id,
          label: `${g.name}${g.is_builtin ? ' (built-in)' : ''}`,
        })),
    ],
    [groups],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New permission group"
      description="Creates a custom group. The new group's defaults are seeded from the chosen clone source (or Member defaults if none picked)."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Name
          </label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Channel Moderator"
            maxLength={100}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Description
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Can manage one banter channel"
            maxLength={500}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Scope
          </label>
          <Select
            options={SCOPE_OPTIONS}
            value={scopeType}
            onValueChange={(v) => setScopeType(v as ScopeType)}
          />
        </div>
        {scopeType !== 'global' && (
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              {scopeType === 'org' ? 'Organization ID' : 'Project ID'}
            </label>
            <Input
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              placeholder="UUID"
            />
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Clone defaults from
          </label>
          <Select
            options={cloneOptions}
            value={cloneFromId}
            onValueChange={setCloneFromId}
            placeholder="Default (Member-like)"
          />
        </div>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={createMut.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" loading={createMut.isPending}>
            Create group
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Delete confirmation ────────────────────────────────────────────────────

function DeleteGroupDialog({
  target,
  onClose,
  onConfirm,
  pending,
  error,
}: {
  target: PermissionGroupListItem | null;
  onClose: () => void;
  onConfirm: (id: string) => void;
  pending: boolean;
  error: ApiError | null;
}) {
  if (!target) {
    return <Dialog open={false} onOpenChange={onClose} title="">{null}</Dialog>;
  }
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title="Delete permission group?"
      description={`Soft-deletes "${target.name}". Cannot be undone via the UI.`}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          <div className="font-semibold">{target.name}</div>
          <div className="mt-1 text-xs">
            {target.member_count} members · {target.grant_count} grants · {target.deny_count} denies
          </div>
          {target.member_count > 0 && (
            <div className="mt-2 text-xs">
              ⚠ Group has live memberships — server will return 409 unless reassigned first.
            </div>
          )}
        </div>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400">{error.message}</div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onConfirm(target.id)} loading={pending}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
