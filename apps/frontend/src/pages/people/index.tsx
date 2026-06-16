import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import {
  UserPlus,
  MoreHorizontal,
  Search,
  KeyRound,
  UserX,
  UserCheck,
  Trash2,
  Eye,
  Download,
  Upload,
  ChevronDown,
  X,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/common/dropdown-menu';
import { useAuthStore } from '@/stores/auth.store';
import { api, ApiError } from '@/lib/api';
import type { PaginatedResponse, Project } from '@bigbluebam/shared';
import {
  peopleApi,
  canActOn,
  type PersonListItem,
  type MemberRole,
} from '@/lib/api/people';
import { formatRelativeTime } from '@/lib/utils';
import { useOrgSummary } from '@/hooks/use-org-summary';
import { exportCsv, todayStamp, type CsvColumn } from '@/lib/csv';
import { BulkInviteDialog } from './bulk-invite-dialog';
import { ImportMembersDialog, IMPORT_FORMATS, type ImportFormat } from './import-members-dialog';

interface PeoplePageProps {
  onNavigate: (path: string) => void;
}

const ROLE_FILTER_OPTIONS = [
  { value: 'all', label: 'All roles' },
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
];

const EDITABLE_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

const BULK_ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

interface BulkProgress {
  label: string;
  done: number;
  total: number;
  succeeded: number;
  failed: { id: string; name: string; reason: string }[];
  skipped: { id: string; name: string; reason: string }[];
  finished: boolean;
}

export function PeoplePage({ onNavigate }: PeoplePageProps) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Bulk-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);

  const { data: orgSummary } = useOrgSummary();

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false);
  const [showBulkInvite, setShowBulkInvite] = useState(false);
  // Import dialog — null when closed, otherwise the chosen source format.
  const [importFormat, setImportFormat] = useState<ImportFormat | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteDisplayName, setInviteDisplayName] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteProjectIds, setInviteProjectIds] = useState<Set<string>>(new Set());
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // Projects in this org — used by the invite dialog so the admin can
  // assign the new member to one or more projects at create time, instead
  // of having to navigate into the user editor afterwards (B3 Frndo Launch).
  // Only fetched once the invite modal opens so we don't pay the cost on
  // every page load.
  const { data: projectsRes } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<PaginatedResponse<Project>>('/projects'),
    enabled: showInvite,
  });
  const orgProjects = projectsRes?.data ?? [];

  const toggleInviteProject = (projectId: string) => {
    setInviteProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Confirm-remove state
  const [confirmRemove, setConfirmRemove] = useState<PersonListItem | null>(null);

  // Reset-password dialog
  const [resetTarget, setResetTarget] = useState<PersonListItem | null>(null);
  const [resetMode, setResetMode] = useState<'generate' | 'manual'>('generate');
  const [resetManual, setResetManual] = useState('');
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetCopied, setResetCopied] = useState(false);

  // --- Queries ---
  const { data: membersRes, isLoading } = useQuery({
    queryKey: ['people', 'members'],
    queryFn: () => peopleApi.listMembers(),
  });
  const members = membersRes?.data ?? [];

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (q) {
        const hay = `${m.display_name ?? ''} ${m.email ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleFilter !== 'all' && m.role !== roleFilter) return false;
      if (statusFilter === 'active' && !m.is_active) return false;
      if (statusFilter === 'disabled' && m.is_active) return false;
      return true;
    });
  }, [members, search, roleFilter, statusFilter]);

  // --- Mutations ---
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['people', 'members'] });

  const invite = useMutation({
    mutationFn: peopleApi.inviteMember,
    onSuccess: (res, vars) => {
      invalidate();
      // B3 Frndo Launch: surface email-delivery status so the admin knows
      // whether the invitee actually got an onboarding email or whether
      // they need to hand off credentials manually.
      const base = res.data.was_existing
        ? `Added ${vars.email} to this organization.`
        : `User created for ${vars.email}.`;
      const emailSuffix = res.data.email_sent
        ? ' Invitation email sent.'
        : ' SMTP not configured — share access manually (use "Send password reset link" or "Reset password").';
      const projectCount = vars.project_ids?.length ?? 0;
      const projectSuffix =
        projectCount > 0
          ? ` Added to ${projectCount} project${projectCount === 1 ? '' : 's'}.`
          : '';
      setInviteSuccess(base + projectSuffix + emailSuffix);
      setInviteEmail('');
      setInviteDisplayName('');
      setInviteRole('member');
      setInviteProjectIds(new Set());
    },
  });

  // P1-25: banner shown when a concurrent edit wins the race (HTTP 409).
  const [versionConflictMsg, setVersionConflictMsg] = useState<string | null>(null);
  const handleVersionConflict = (err: unknown, subject: string) => {
    if (err instanceof ApiError && err.status === 409 && err.code === 'VERSION_CONFLICT') {
      setVersionConflictMsg(
        `${subject} was just updated by someone else — refreshing the list`,
      );
      invalidate();
      return true;
    }
    return false;
  };

  const updateRole = useMutation({
    mutationFn: ({ userId, role, version }: { userId: string; role: string; version?: number }) =>
      peopleApi.updateRole(userId, role, version),
    onSuccess: () => {
      setVersionConflictMsg(null);
      invalidate();
    },
    onError: (err) => {
      handleVersionConflict(err, 'This user');
    },
  });

  const setActive = useMutation({
    mutationFn: ({
      userId,
      isActive,
      version,
    }: { userId: string; isActive: boolean; version?: number }) =>
      peopleApi.setActive(userId, isActive, version),
    onSuccess: () => {
      setVersionConflictMsg(null);
      invalidate();
    },
    onError: (err) => {
      handleVersionConflict(err, 'This user');
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => peopleApi.removeMember(userId),
    onSuccess: () => {
      invalidate();
      setConfirmRemove(null);
    },
  });

  const resetPassword = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password?: string }) =>
      peopleApi.resetPassword(userId, password),
    onSuccess: (res) => {
      setResetResult(res.data.password);
      setResetCopied(false);
    },
  });

  const closeResetDialog = () => {
    setResetTarget(null);
    setResetMode('generate');
    setResetManual('');
    setResetResult(null);
    setResetCopied(false);
    resetPassword.reset();
  };

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    invite.mutate({
      email: inviteEmail.trim(),
      display_name: inviteDisplayName.trim() || undefined,
      role: inviteRole,
      project_ids: inviteProjectIds.size > 0 ? Array.from(inviteProjectIds) : undefined,
    });
  };

  // --- Render helpers ---
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked =
    filteredMembers.length > 0 &&
    filteredMembers.every((m) => selectedIds.has(m.id));

  // Selected rows resolved against the currently-loaded member list.
  const selectedMembers = useMemo(
    () => members.filter((m) => selectedIds.has(m.id)),
    [members, selectedIds],
  );

  const clearSelection = () => setSelectedIds(new Set());

  /**
   * Run `action` against every selected member in parallel, showing a live
   * progress state. Targets the caller cannot act on are skipped with
   * reason "rank". Any thrown error is captured as a per-target failure.
   */
  async function runBulk(
    label: string,
    targets: PersonListItem[],
    action: (m: PersonListItem) => Promise<unknown>,
    opts: { skipSelf?: boolean; requireRank?: boolean } = {
      skipSelf: true,
      requireRank: true,
    },
  ) {
    const skipped: BulkProgress['skipped'] = [];
    const runnable: PersonListItem[] = [];
    for (const m of targets) {
      const name = m.display_name || m.email;
      if (opts.skipSelf && m.id === user?.id) {
        skipped.push({ id: m.id, name, reason: 'self' });
        continue;
      }
      if (opts.requireRank && !canActOn(user, m)) {
        skipped.push({ id: m.id, name, reason: 'rank' });
        continue;
      }
      runnable.push(m);
    }

    const total = runnable.length;
    const failed: BulkProgress['failed'] = [];
    let done = 0;
    let succeeded = 0;

    setBulkProgress({
      label,
      done: 0,
      total,
      succeeded: 0,
      failed: [],
      skipped,
      finished: total === 0,
    });

    if (total === 0) {
      // Nothing to do — still invalidate in case caller expects a refresh.
      invalidate();
      return;
    }

    await Promise.all(
      runnable.map(async (m) => {
        try {
          await action(m);
          succeeded += 1;
        } catch (err) {
          const name = m.display_name || m.email;
          const reason = (err as Error)?.message ?? 'failed';
          failed.push({ id: m.id, name, reason });
        } finally {
          done += 1;
          setBulkProgress((prev) =>
            prev
              ? {
                  ...prev,
                  done,
                  succeeded,
                  failed: [...failed],
                  finished: done === total,
                }
              : prev,
          );
        }
      }),
    );

    invalidate();
  }

  const bulkSetActive = (isActive: boolean) =>
    runBulk(
      isActive ? 'Enabling' : 'Disabling',
      selectedMembers.filter((m) => m.is_active !== isActive),
      (m) => peopleApi.setActive(m.id, isActive, m.version),
    );

  const bulkUpdateRole = (role: string) =>
    runBulk(
      `Changing role to ${role}`,
      selectedMembers.filter((m) => m.role !== role),
      (m) => peopleApi.updateRole(m.id, role, m.version),
    );

  const bulkRemove = () =>
    runBulk(
      'Removing',
      selectedMembers,
      (m) => peopleApi.removeMember(m.id),
    ).then(() => {
      // Drop removed ids from the selection set once the mutations settle.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const m of selectedMembers) next.delete(m.id);
        return next;
      });
      setConfirmBulkRemove(false);
    });

  const handleExportCsv = () => {
    const rows = selectedMembers.length > 0 ? selectedMembers : filteredMembers;
    const columns: CsvColumn<PersonListItem>[] = [
      { header: 'id', value: (r) => r.id },
      { header: 'email', value: (r) => r.email },
      { header: 'display_name', value: (r) => r.display_name },
      { header: 'role', value: (r) => r.role },
      { header: 'is_active', value: (r) => r.is_active },
      { header: 'last_seen_at', value: (r) => r.last_seen_at ?? '' },
      { header: 'org_name', value: () => orgSummary?.name ?? '' },
      { header: 'org_slug', value: () => orgSummary?.slug ?? '' },
      {
        header: 'projects_count',
        // Not returned by /org/members today — left blank. When the endpoint
        // grows a memberships array, derive with `r.memberships?.length ?? ''`.
        value: () => '',
      },
    ];
    const slug = orgSummary?.slug ?? 'org';
    exportCsv(`people-${slug}-${todayStamp()}.csv`, rows, columns);
  };

  return (
    <AppLayout
      breadcrumbs={[{ label: 'People' }]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">People</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Manage members of your organization.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Upload className="h-4 w-4" />
                  Import
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              }
            >
              <DropdownMenuLabel>Import members from</DropdownMenuLabel>
              {(Object.keys(IMPORT_FORMATS) as ImportFormat[]).map((key) => (
                <DropdownMenuItem key={key} onSelect={() => setImportFormat(key)}>
                  <Upload className="h-4 w-4" />
                  {IMPORT_FORMATS[key].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenu>
            <Button variant="ghost" onClick={() => setShowBulkInvite(true)}>
              <UserPlus className="h-4 w-4" />
              Invite more
            </Button>
            <Button onClick={() => setShowInvite(true)}>
              <UserPlus className="h-4 w-4" />
              Invite member
            </Button>
          </div>
        </div>

        <BulkInviteDialog open={showBulkInvite} onOpenChange={setShowBulkInvite} />
        <ImportMembersDialog
          open={importFormat !== null}
          format={importFormat ?? 'generic'}
          onOpenChange={(o) => {
            if (!o) setImportFormat(null);
          }}
        />

        {versionConflictMsg && (
          <div
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 flex items-center justify-between"
            role="alert"
          >
            <span>{versionConflictMsg}</span>
            <button
              type="button"
              className="text-amber-900/70 hover:text-amber-900 dark:text-amber-200/70 dark:hover:text-amber-200"
              onClick={() => setVersionConflictMsg(null)}
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Filters row */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md">
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
              Search
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
              />
            </div>
          </div>
          <Select
            label="Role"
            options={ROLE_FILTER_OPTIONS}
            value={roleFilter}
            onValueChange={setRoleFilter}
            className="w-40"
          />
          <Select
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onValueChange={setStatusFilter}
            className="w-36"
          />
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {isLoading ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading people...</p>
          ) : filteredMembers.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-400">
              {members.length === 0 ? 'No people found.' : 'No matches for current filters.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-800/50">
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                    <th className="px-4 py-2.5 w-8">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={() => {
                          setSelectedIds((prev) => {
                            if (allChecked) {
                              const next = new Set(prev);
                              for (const m of filteredMembers) next.delete(m.id);
                              return next;
                            }
                            const next = new Set(prev);
                            for (const m of filteredMembers) next.add(m.id);
                            return next;
                          });
                        }}
                        className="rounded border-zinc-300 dark:border-zinc-700"
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Name</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Email</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Role</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Status</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Last seen</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map((m) => {
                    const canAct = canActOn(user, m);
                    const isSelf = m.id === user?.id;
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
                        onClick={() => onNavigate(`/people/${m.id}`)}
                      >
                        <td
                          className="px-4 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(m.id)}
                            onChange={() => toggleSelect(m.id)}
                            className="rounded border-zinc-300 dark:border-zinc-700"
                            aria-label={`Select ${m.display_name}`}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Avatar src={m.avatar_url} name={m.display_name} size="sm" />
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {m.display_name || '—'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{m.email}</td>
                        <td
                          className="px-4 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canAct ? (
                            <Select
                              options={EDITABLE_ROLE_OPTIONS}
                              value={m.role}
                              onValueChange={(role) =>
                                updateRole.mutate({ userId: m.id, role, version: m.version })
                              }
                              className="w-28"
                            />
                          ) : (
                            <span className="capitalize text-zinc-700 dark:text-zinc-300">{m.role}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {m.is_active ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="danger">Disabled</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-500">
                          {m.last_seen_at ? formatRelativeTime(m.last_seen_at) : '—'}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DropdownMenu
                            trigger={
                              <button
                                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                                title="Actions"
                                aria-label="User actions"
                                aria-haspopup="menu"
                              >
                                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                              </button>
                            }
                          >
                            <DropdownMenuItem onSelect={() => onNavigate(`/people/${m.id}`)}>
                              <Eye className="h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            {canAct && (
                              <DropdownMenuItem onSelect={() => setResetTarget(m)}>
                                <KeyRound className="h-4 w-4" />
                                Reset password
                              </DropdownMenuItem>
                            )}
                            {canAct && !isSelf && (
                              <DropdownMenuItem
                                onSelect={() =>
                                  setActive.mutate({
                                    userId: m.id,
                                    isActive: !m.is_active,
                                    version: m.version,
                                  })
                                }
                              >
                                {m.is_active ? (
                                  <>
                                    <UserX className="h-4 w-4" />
                                    Disable
                                  </>
                                ) : (
                                  <>
                                    <UserCheck className="h-4 w-4" />
                                    Enable
                                  </>
                                )}
                              </DropdownMenuItem>
                            )}
                            {canAct && !isSelf && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive onSelect={() => setConfirmRemove(m)}>
                                  <Trash2 className="h-4 w-4" />
                                  Remove
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

      {/* Floating bulk-action toolbar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            key="bulk-toolbar"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[min(calc(100vw-2rem),56rem)] max-w-4xl"
          >
            <div className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 shadow-lg shadow-zinc-900/10 dark:shadow-black/40">
              <span className="inline-flex items-center rounded-full bg-primary-100 dark:bg-primary-900/40 px-2.5 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300 tabular-nums">
                {selectedIds.size} selected
              </span>

              <DropdownMenu
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Change role
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                }
              >
                {BULK_ROLE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onSelect={() => bulkUpdateRole(opt.value)}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenu>

              <button
                type="button"
                onClick={() => bulkSetActive(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <UserX className="h-3.5 w-3.5" />
                Disable
              </button>
              <button
                type="button"
                onClick={() => bulkSetActive(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <UserCheck className="h-3.5 w-3.5" />
                Enable
              </button>

              <button
                type="button"
                onClick={() => setConfirmBulkRemove(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 dark:border-red-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove from org
              </button>

              <button
                type="button"
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>

              <div className="flex-1" />
              <button
                type="button"
                onClick={clearSelection}
                className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Clear selection
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk-action progress toast */}
      <AnimatePresence>
        {bulkProgress && (
          <motion.div
            key="bulk-progress"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-24 right-6 z-50 w-80 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
          >
            <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {bulkProgress.finished
                  ? 'Done'
                  : `${bulkProgress.label} ${bulkProgress.done} of ${bulkProgress.total}…`}
              </div>
              <button
                type="button"
                onClick={() => setBulkProgress(null)}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-4 py-3 space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
              {!bulkProgress.finished && bulkProgress.total > 0 && (
                <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-primary-500 transition-all"
                    style={{
                      width: `${Math.round(
                        (bulkProgress.done / bulkProgress.total) * 100,
                      )}%`,
                    }}
                  />
                </div>
              )}
              {bulkProgress.finished && (
                <>
                  <div>
                    {bulkProgress.succeeded} succeeded
                    {bulkProgress.failed.length > 0 &&
                      `, ${bulkProgress.failed.length} failed`}
                    {bulkProgress.skipped.length > 0 &&
                      `, ${bulkProgress.skipped.length} skipped`}
                  </div>
                  {bulkProgress.failed.length > 0 && (
                    <ul className="space-y-0.5 text-red-600 dark:text-red-400 max-h-24 overflow-auto">
                      {bulkProgress.failed.map((f) => (
                        <li key={`f-${f.id}`}>
                          {f.name}: {f.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {bulkProgress.skipped.length > 0 && (
                    <ul className="space-y-0.5 text-zinc-500 max-h-24 overflow-auto">
                      {bulkProgress.skipped.map((s) => (
                        <li key={`s-${s.id}`}>
                          {s.name}: skipped ({s.reason})
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk-remove confirmation */}
      <Dialog
        open={confirmBulkRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmBulkRemove(false);
        }}
        title="Remove members"
        description={`Remove ${selectedMembers.length} member${
          selectedMembers.length === 1 ? '' : 's'
        } from this organization? Targets you do not outrank will be skipped.`}
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmBulkRemove(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={bulkRemove}>
            Remove {selectedMembers.length}
          </Button>
        </div>
      </Dialog>

      {/* Invite modal */}
      <Dialog
        open={showInvite}
        onOpenChange={(open) => {
          setShowInvite(open);
          if (!open) {
            setInviteSuccess(null);
            invite.reset();
          }
        }}
        title="Invite member"
        description="Add a new user to your organization."
      >
        {inviteSuccess ? (
          <div className="space-y-4">
            <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200">
              {inviteSuccess}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setInviteSuccess(null);
                }}
              >
                Invite another
              </Button>
              <Button
                onClick={() => {
                  setInviteSuccess(null);
                  setShowInvite(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleInvite} className="space-y-4">
            <Input
              id="people-invite-email"
              label="Email"
              type="email"
              placeholder="user@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
            />
            <Input
              id="people-invite-name"
              label="Display name"
              placeholder="Optional"
              value={inviteDisplayName}
              onChange={(e) => setInviteDisplayName(e.target.value)}
            />
            <Select
              label="Role"
              options={[
                { value: 'member', label: 'Member' },
                { value: 'admin', label: 'Admin' },
                { value: 'viewer', label: 'Viewer' },
              ]}
              value={inviteRole}
              onValueChange={setInviteRole}
            />

            {/* Project assignments (B3 Frndo Launch). Optional — if none
                are selected the user is just added to the org with no
                project access. They start as 'member' on every selected
                project; admins can tune per-project roles afterwards from
                the user-detail Projects tab. */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Add to projects (optional)
              </label>
              {orgProjects.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  No projects yet — you can add this user to projects later.
                </p>
              ) : (
                <>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                    {orgProjects.map((p) => {
                      const checked = inviteProjectIds.has(p.id);
                      return (
                        <label
                          key={p.id}
                          className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleInviteProject(p.id)}
                            className="rounded text-primary-600 focus:ring-primary-500"
                          />
                          <span className="text-zinc-900 dark:text-zinc-100 truncate">{p.name}</span>
                          {p.task_id_prefix && (
                            <span className="text-xs font-mono text-zinc-400">
                              {p.task_id_prefix}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {inviteProjectIds.size === 0
                      ? 'No projects selected — user will be added to the org only.'
                      : `Will be added as 'member' on ${inviteProjectIds.size} project${
                          inviteProjectIds.size === 1 ? '' : 's'
                        }.`}
                  </p>
                </>
              )}
            </div>

            {invite.isError && (
              <p className="text-sm text-red-600">
                {(invite.error as Error)?.message ?? 'Failed to invite member.'}
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowInvite(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={invite.isPending}
                disabled={!inviteEmail.trim()}
              >
                Invite
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Confirm remove */}
      <Dialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        title="Remove member"
        description={
          confirmRemove
            ? `Remove ${confirmRemove.display_name || confirmRemove.email} from this organization?`
            : ''
        }
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => confirmRemove && remove.mutate(confirmRemove.id)}
          >
            Remove
          </Button>
        </div>
      </Dialog>

      {/* Reset password */}
      <Dialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) closeResetDialog();
        }}
        title={resetResult ? 'Password reset complete' : 'Reset password'}
        description={
          resetResult
            ? `Share this password with ${resetTarget?.email}. It will not be shown again.`
            : `Reset the password for ${resetTarget?.display_name || resetTarget?.email}.`
        }
      >
        {!resetResult ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!resetTarget) return;
              resetPassword.mutate({
                userId: resetTarget.id,
                password: resetMode === 'manual' ? resetManual : undefined,
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={resetMode === 'generate'}
                  onChange={() => setResetMode('generate')}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Auto-generate a strong password
                  </div>
                  <div className="text-xs text-zinc-500">16 chars, alphanumeric</div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={resetMode === 'manual'}
                  onChange={() => setResetMode('manual')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Enter a password manually
                  </div>
                  <div className="text-xs text-zinc-500 mb-2">Minimum 12 characters</div>
                  {resetMode === 'manual' && (
                    <Input
                      type="text"
                      value={resetManual}
                      onChange={(e) => setResetManual(e.target.value)}
                      placeholder="new password"
                      minLength={12}
                      autoFocus
                    />
                  )}
                </div>
              </label>
            </div>

            {resetPassword.isError && (
              <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
                {(resetPassword.error as Error)?.message || 'Reset failed'}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={closeResetDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={resetPassword.isPending}
                disabled={resetMode === 'manual' && resetManual.length < 12}
              >
                Reset password
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200">
              This password is shown <strong>only once</strong>. Copy it now.
            </div>
            <div className="flex items-stretch gap-2">
              <code className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-900 dark:text-zinc-100 break-all">
                {resetResult}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(resetResult);
                  setResetCopied(true);
                  setTimeout(() => setResetCopied(false), 2000);
                }}
                className="shrink-0 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                {resetCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="flex items-center justify-end">
              <Button onClick={closeResetDialog}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </AppLayout>
  );
}

// Suppress unused-import warning for types in case someone imports MemberRole externally
export type { MemberRole };
