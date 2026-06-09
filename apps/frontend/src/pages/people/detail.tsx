import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  MoreHorizontal,
  Crown,
  UserX,
  UserCheck,
  Trash2,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  Plus,
  Loader2,
  X as XIcon,
} from 'lucide-react';
import type { PaginatedResponse, Project } from '@bigbluebam/shared';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';
import { api, ApiError } from '@/lib/api';
import {
  peopleApi,
  canActOn,
  type ProjectMemberRole,
  type PersonProjectMembership,
  type ApiKeyRecord,
  type ApiKeyScope,
  type ActivityEntry,
} from '@/lib/api/people';
import { formatDate, formatRelativeTime } from '@/lib/utils';

interface PersonDetailPageProps {
  userId: string;
  onNavigate: (path: string) => void;
}

type DetailTab = 'overview' | 'projects' | 'access' | 'activity';

const API_KEY_SCOPE_OPTIONS: { value: ApiKeyScope; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'read_write', label: 'Read / Write' },
  { value: 'admin', label: 'Admin' },
];

const PROJECT_ROLE_OPTIONS: { value: ProjectMemberRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const ORG_ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

export function PersonDetailPage({ userId, onNavigate }: PersonDetailPageProps) {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>('overview');

  // Fetch member detail
  const { data: detailRes, isLoading } = useQuery({
    queryKey: ['people', 'member', userId],
    queryFn: () => peopleApi.getMember(userId),
  });
  const member = detailRes?.data;

  // Identity form state
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [timezoneInput, setTimezoneInput] = useState('');
  const [identityDirty, setIdentityDirty] = useState(false);

  useEffect(() => {
    if (member) {
      setDisplayNameInput(member.display_name ?? '');
      setTimezoneInput(member.timezone ?? 'UTC');
      setIdentityDirty(false);
    }
  }, [member?.id, member?.display_name, member?.timezone]);

  // Dialogs
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [showAddProjects, setShowAddProjects] = useState(false);

  // Reset-password dialog
  const [resetOpen, setResetOpen] = useState(false);
  const [resetMode, setResetMode] = useState<'generate' | 'manual'>('generate');
  const [resetManual, setResetManual] = useState('');
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetCopied, setResetCopied] = useState(false);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['people'] });
  };

  // --- Mutations ---
  const updateProfile = useMutation({
    mutationFn: () =>
      peopleApi.updateProfile(userId, {
        display_name: displayNameInput,
        timezone: timezoneInput,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['people', 'member', userId] });
      queryClient.invalidateQueries({ queryKey: ['people', 'members'] });
      setIdentityDirty(false);
    },
  });

  // P1-25: banner shown when a PATCH races another admin (HTTP 409).
  const [versionConflict, setVersionConflict] = useState<string | null>(null);

  const updateOrgRole = useMutation({
    mutationFn: (role: string) =>
      // Send the current version so concurrent edits produce a 409 instead
      // of silently clobbering a peer admin's change.
      peopleApi.updateRole(userId, role, member?.version),
    onSuccess: () => {
      setVersionConflict(null);
      invalidateAll();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.code === 'VERSION_CONFLICT') {
        setVersionConflict(
          "This user's role was just updated by someone else — refresh to see the latest",
        );
        // Refetch so the Select snaps to the server-side value and the
        // cached version is current before the next attempt.
        queryClient.invalidateQueries({ queryKey: ['people', 'member', userId] });
      }
    },
  });

  const setActive = useMutation({
    mutationFn: (isActive: boolean) =>
      peopleApi.setActive(userId, isActive, member?.version),
    onSuccess: () => {
      setVersionConflict(null);
      invalidateAll();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.code === 'VERSION_CONFLICT') {
        setVersionConflict(
          "This user was just updated by someone else — refresh to see the latest",
        );
        queryClient.invalidateQueries({ queryKey: ['people', 'member', userId] });
      }
    },
  });

  const transfer = useMutation({
    mutationFn: () => peopleApi.transferOwnership(userId),
    onSuccess: () => {
      invalidateAll();
      // Also refetch current user role (demotion)
      queryClient.invalidateQueries({ queryKey: ['me'] });
      setConfirmTransfer(false);
    },
  });

  const removeMember = useMutation({
    mutationFn: () => peopleApi.removeMember(userId),
    onSuccess: () => {
      invalidateAll();
      onNavigate('/people');
    },
  });

  const resetPassword = useMutation({
    mutationFn: (password: string | undefined) => peopleApi.resetPassword(userId, password),
    onSuccess: (res) => {
      setResetResult(res.data.password);
      setResetCopied(false);
    },
  });

  const closeResetDialog = () => {
    setResetOpen(false);
    setResetMode('generate');
    setResetManual('');
    setResetResult(null);
    setResetCopied(false);
    resetPassword.reset();
  };

  // Wave E.D: the Transfer-ownership endpoint
  // (POST /org/members/:userId/transfer-ownership →
  // bam.org_member_transfer_ownership.create). The matrix already
  // reflects SuperUser bypass, so the explicit is_superuser disjunct
  // is no longer needed. Must be called BEFORE the early returns
  // below — otherwise the hook count changes between the loading
  // render and the resolved render, violating Rules of Hooks and
  // crashing the whole tree to a black screen.
  const callerIsOwner = useCan('bam.org_member_transfer_ownership.create');

  // --- Render guards ---
  if (isLoading) {
    return (
      <AppLayout
        breadcrumbs={[{ label: 'People', href: '/people' }, { label: '...' }]}
        onNavigate={onNavigate}
        onCreateProject={() => onNavigate('/')}
      >
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </AppLayout>
    );
  }

  if (!member) {
    return (
      <AppLayout
        breadcrumbs={[{ label: 'People', href: '/people' }, { label: 'Not found' }]}
        onNavigate={onNavigate}
        onCreateProject={() => onNavigate('/')}
      >
        <div className="max-w-7xl mx-auto px-6 py-10">
          <p className="text-sm text-zinc-500">Member not found.</p>
          <Button variant="ghost" onClick={() => onNavigate('/people')} className="mt-4">
            <ArrowLeft className="h-4 w-4" /> Back to People
          </Button>
        </div>
      </AppLayout>
    );
  }

  const canAct = canActOn(currentUser, member);
  const isSelf = member.id === currentUser?.id;

  return (
    <AppLayout
      breadcrumbs={[
        { label: 'People', href: '/people' },
        { label: member.display_name || member.email },
      ]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <Avatar src={member.avatar_url} name={member.display_name} size="lg" />
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                  {member.display_name || member.email}
                </h1>
                {member.is_active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="danger">Disabled</Badge>
                )}
                <span className="text-xs capitalize text-zinc-500 border border-zinc-200 dark:border-zinc-700 rounded-full px-2 py-0.5">
                  {member.role}
                </span>
              </div>
              <p className="text-sm text-zinc-500 mt-1">{member.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => onNavigate('/people')}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <DropdownMenu
              trigger={
                <button
                  className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  title="Actions"
                  aria-label="User actions"
                  aria-haspopup="menu"
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
              }
            >
              {canAct && (
                <DropdownMenuItem onSelect={() => setResetOpen(true)}>
                  <KeyRound className="h-4 w-4" /> Reset password
                </DropdownMenuItem>
              )}
              {canAct && (
                <DropdownMenuItem
                  onSelect={() => {
                    /* stub */
                  }}
                >
                  <Lock className="h-4 w-4" /> Force password change
                </DropdownMenuItem>
              )}
              {canAct && !isSelf && (
                <DropdownMenuItem onSelect={() => setActive.mutate(!member.is_active)}>
                  {member.is_active ? (
                    <>
                      <UserX className="h-4 w-4" /> Disable account
                    </>
                  ) : (
                    <>
                      <UserCheck className="h-4 w-4" /> Enable account
                    </>
                  )}
                </DropdownMenuItem>
              )}
              {callerIsOwner && !isSelf && member.role !== 'owner' && (
                <DropdownMenuItem onSelect={() => setConfirmTransfer(true)}>
                  <Crown className="h-4 w-4" /> Transfer ownership
                </DropdownMenuItem>
              )}
              {canAct && !isSelf && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setConfirmRemove(true)}>
                    <Trash2 className="h-4 w-4" /> Remove from org
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenu>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </TabButton>
          <TabButton active={tab === 'projects'} onClick={() => setTab('projects')}>
            Projects
          </TabButton>
          {(canAct || isSelf) && (
            <TabButton active={tab === 'access'} onClick={() => setTab('access')}>
              Access
            </TabButton>
          )}
          {canAct && (
            <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
              Activity
            </TabButton>
          )}
        </div>

        {tab === 'overview' && (
          <div className="space-y-5">
            {!member.is_active && member.disabled_at && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950 dark:border-red-900 px-4 py-3 text-sm text-red-800 dark:text-red-200">
                Account disabled
                {member.disabled_by && ` by ${member.disabled_by.display_name || member.disabled_by.email}`}
                {` on ${formatDate(member.disabled_at)}.`}
              </div>
            )}

            {/* Identity card */}
            <Card title="Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  id="detail-display-name"
                  label="Display name"
                  value={displayNameInput}
                  onChange={(e) => {
                    setDisplayNameInput(e.target.value);
                    setIdentityDirty(true);
                  }}
                  disabled={!canAct && !isSelf}
                />
                <Input
                  id="detail-timezone"
                  label="Timezone"
                  value={timezoneInput}
                  onChange={(e) => {
                    setTimezoneInput(e.target.value);
                    setIdentityDirty(true);
                  }}
                  disabled={!canAct && !isSelf}
                  placeholder="UTC"
                />
              </div>
              <div className="text-xs text-zinc-500 mt-3">
                Avatar:{' '}
                <span className="text-zinc-700 dark:text-zinc-300">
                  {member.avatar_url ? 'custom image' : 'default initials'}
                </span>{' '}
                (editing coming soon)
              </div>
              {(canAct || isSelf) && (
                <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDisplayNameInput(member.display_name ?? '');
                      setTimezoneInput(member.timezone ?? 'UTC');
                      setIdentityDirty(false);
                    }}
                    disabled={!identityDirty}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => updateProfile.mutate()}
                    loading={updateProfile.isPending}
                    disabled={!identityDirty}
                  >
                    Save
                  </Button>
                </div>
              )}
              {updateProfile.isError && (
                <p className="text-sm text-red-600 mt-2">
                  {(updateProfile.error as Error)?.message ?? 'Save failed'}
                </p>
              )}
            </Card>

            {/* Membership card */}
            <Card title="Membership">
              {versionConflict && (
                <div
                  className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
                  role="alert"
                >
                  {versionConflict}
                </div>
              )}
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                <Row label="Role">
                  {canAct ? (
                    <Select
                      options={ORG_ROLE_OPTIONS}
                      value={member.role}
                      onValueChange={(role) => updateOrgRole.mutate(role)}
                      className="w-32"
                    />
                  ) : (
                    <span className="capitalize text-zinc-700 dark:text-zinc-300">{member.role}</span>
                  )}
                </Row>
                <Row label="Default org">
                  {member.is_default_org ? (
                    <Badge variant="info">Yes</Badge>
                  ) : (
                    <span className="text-zinc-500">No</span>
                  )}
                </Row>
                <Row label="Joined">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {formatDate(member.joined_at)}
                  </span>
                </Row>
                <Row label="Last seen">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {member.last_seen_at ? formatRelativeTime(member.last_seen_at) : 'Never'}
                  </span>
                </Row>
                {!member.is_active && (
                  <>
                    <Row label="Disabled at">
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {formatDate(member.disabled_at)}
                      </span>
                    </Row>
                    <Row label="Disabled by">
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {member.disabled_by?.display_name || member.disabled_by?.email || '—'}
                      </span>
                    </Row>
                  </>
                )}
              </dl>
            </Card>
          </div>
        )}

        {tab === 'projects' && (
          <ProjectsTab
            userId={userId}
            canAct={canAct}
            onAddClick={() => setShowAddProjects(true)}
          />
        )}

        {tab === 'access' && (canAct || isSelf) && (
          <AccessTab
            userId={userId}
            canAct={canAct}
            isSelf={isSelf}
            callerIsOwner={callerIsOwner}
            onOpenReset={() => setResetOpen(true)}
          />
        )}

        {tab === 'activity' && canAct && <ActivityTab userId={userId} />}
      </div>

      {/* Add-projects modal */}
      {showAddProjects && (
        <AddProjectsDialog
          userId={userId}
          onClose={() => setShowAddProjects(false)}
        />
      )}

      {/* Transfer ownership confirm */}
      <Dialog
        open={confirmTransfer}
        onOpenChange={setConfirmTransfer}
        title="Transfer ownership"
        description={
          currentUser?.is_superuser_viewing
            ? `Promote ${member.display_name || member.email} to owner of this organization? You are acting as a SuperUser and will not be demoted.`
            : currentUser?.role === 'owner'
            ? `Promote ${member.display_name || member.email} to owner and demote yourself to admin?`
            : `Promote ${member.display_name || member.email} to owner of this organization?`
        }
      >
        {transfer.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(transfer.error as Error)?.message ?? 'Transfer failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmTransfer(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={transfer.isPending} onClick={() => transfer.mutate()}>
            Transfer ownership
          </Button>
        </div>
      </Dialog>

      {/* Confirm remove */}
      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove from organization"
        description={`Remove ${member.display_name || member.email} from this organization? Their access will be revoked.`}
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={removeMember.isPending}
            onClick={() => removeMember.mutate()}
          >
            Remove
          </Button>
        </div>
      </Dialog>

      {/* Reset password */}
      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!open) closeResetDialog();
        }}
        title={resetResult ? 'Password reset complete' : 'Reset password'}
        description={
          resetResult
            ? `Share this password with ${member.email}. It will not be shown again.`
            : `Reset the password for ${member.display_name || member.email}.`
        }
      >
        {!resetResult ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              resetPassword.mutate(resetMode === 'manual' ? resetManual : undefined);
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

// --- Supporting components ---

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ' +
        (active
          ? 'border-primary-600 text-primary-700 dark:text-primary-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')
      }
    >
      {children}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3 last:border-0 last:pb-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ProjectsTab({
  userId,
  canAct,
  onAddClick,
}: {
  userId: string;
  canAct: boolean;
  onAddClick: () => void;
}) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['people', 'member', userId, 'projects'],
    queryFn: () => peopleApi.listMemberProjects(userId),
  });
  const memberships = data?.data ?? [];

  const invalidateProjects = () => {
    queryClient.invalidateQueries({ queryKey: ['people', 'member', userId, 'projects'] });
    queryClient.invalidateQueries({ queryKey: ['people', 'member', userId] });
  };

  const updateRole = useMutation({
    mutationFn: ({ projectId, role }: { projectId: string; role: ProjectMemberRole }) =>
      peopleApi.updateMemberProjectRole(userId, projectId, role),
    onSuccess: invalidateProjects,
  });

  const remove = useMutation({
    mutationFn: (projectId: string) => peopleApi.removeMemberFromProject(userId, projectId),
    onSuccess: invalidateProjects,
  });

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Project access</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Projects this user belongs to in the current organization.
          </p>
        </div>
        {canAct && (
          <Button size="sm" onClick={onAddClick}>
            <Plus className="h-4 w-4" /> Add to project
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading...</p>
      ) : memberships.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">
          Not a member of any project in this org.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                <th className="px-4 py-2.5 font-medium text-zinc-500">Project</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Role</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Joined</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((m: PersonProjectMembership) => (
                <tr
                  key={m.project_id}
                  className="border-b border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {m.project_name}
                      </span>
                      {m.is_archived && <Badge variant="warning">Archived</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {canAct ? (
                      <Select
                        options={PROJECT_ROLE_OPTIONS}
                        value={m.role}
                        onValueChange={(v) =>
                          updateRole.mutate({
                            projectId: m.project_id,
                            role: v as ProjectMemberRole,
                          })
                        }
                        className="w-28"
                      />
                    ) : (
                      <span className="capitalize text-zinc-700 dark:text-zinc-300">{m.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(m.joined_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {canAct && (
                      <button
                        onClick={() => remove.mutate(m.project_id)}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        title="Remove from project"
                        disabled={remove.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddProjectsDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: allProjectsRes } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<PaginatedResponse<Project>>('/projects'),
  });
  const allProjects = allProjectsRes?.data ?? [];

  const { data: membershipRes } = useQuery({
    queryKey: ['people', 'member', userId, 'projects'],
    queryFn: () => peopleApi.listMemberProjects(userId),
  });
  const currentMemberships = membershipRes?.data ?? [];
  const currentIds = useMemo(
    () => new Set(currentMemberships.map((m) => m.project_id)),
    [currentMemberships],
  );

  const availableProjects = useMemo(
    () => allProjects.filter((p) => !currentIds.has(p.id)),
    [allProjects, currentIds],
  );

  const [selections, setSelections] = useState<Record<string, ProjectMemberRole>>({});

  const toggle = (projectId: string) => {
    setSelections((prev) => {
      const next = { ...prev };
      if (next[projectId]) {
        delete next[projectId];
      } else {
        next[projectId] = 'member';
      }
      return next;
    });
  };

  const setRole = (projectId: string, role: ProjectMemberRole) => {
    setSelections((prev) => ({ ...prev, [projectId]: role }));
  };

  const add = useMutation({
    mutationFn: () =>
      peopleApi.addMemberToProjects(userId, {
        assignments: Object.entries(selections).map(([project_id, role]) => ({
          project_id,
          role,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['people', 'member', userId, 'projects'] });
      queryClient.invalidateQueries({ queryKey: ['people', 'member', userId] });
      onClose();
    },
  });

  const selectedCount = Object.keys(selections).length;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to project(s)"
      description="Pick one or more projects and a role per assignment."
    >
      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {availableProjects.length === 0 ? (
          <p className="text-sm text-zinc-500 py-6 text-center">
            User is already on every project in this organization.
          </p>
        ) : (
          availableProjects.map((project) => {
            const isSelected = !!selections[project.id];
            return (
              <div
                key={project.id}
                className={
                  'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ' +
                  (isSelected
                    ? 'border-primary-300 bg-primary-50 dark:bg-primary-950/30 dark:border-primary-800'
                    : 'border-zinc-200 dark:border-zinc-700')
                }
              >
                <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(project.id)}
                    className="rounded border-zinc-300 dark:border-zinc-700"
                  />
                  <span
                    className="flex items-center justify-center h-6 w-6 rounded text-xs font-medium text-white shrink-0"
                    style={{ backgroundColor: project.color ?? '#2563eb' }}
                  >
                    {project.icon ?? project.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {project.name}
                  </span>
                </label>
                {isSelected && (
                  <Select
                    options={PROJECT_ROLE_OPTIONS}
                    value={selections[project.id]}
                    onValueChange={(v) => setRole(project.id, v as ProjectMemberRole)}
                    className="w-28"
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {add.isError && (
        <p className="text-sm text-red-600 mt-3">
          {(add.error as Error)?.message ?? 'Add failed'}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-4 mt-4 border-t border-zinc-100 dark:border-zinc-800">
        <span className="text-xs text-zinc-500">{selectedCount} selected</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            <XIcon className="h-4 w-4" /> Cancel
          </Button>
          <Button
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={selectedCount === 0}
          >
            Add selected
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Access tab ---

function AccessTab({
  userId,
  canAct,
  isSelf,
  callerIsOwner,
  onOpenReset,
}: {
  userId: string;
  canAct: boolean;
  isSelf: boolean;
  callerIsOwner: boolean;
  onOpenReset: () => void;
}) {
  const queryClient = useQueryClient();

  // Admin actions that require caller to OUTRANK target — not available when
  // acting on self (canAct is false for self anyway; double-gate for clarity).
  const adminActionsAllowed = canAct && !isSelf;

  const [confirmForceChange, setConfirmForceChange] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [forceSuccess, setForceSuccess] = useState(false);
  const [revokedCount, setRevokedCount] = useState<number | null>(null);
  const [resetLinkStatus, setResetLinkStatus] = useState<
    { email_sent: boolean; smtp_configured: boolean; expires_in_minutes: number } | null
  >(null);

  const forceChange = useMutation({
    mutationFn: () => peopleApi.forcePasswordChange(userId),
    onSuccess: () => {
      setConfirmForceChange(false);
      setForceSuccess(true);
      setTimeout(() => setForceSuccess(false), 5000);
    },
  });

  const signOutAll = useMutation({
    mutationFn: () => peopleApi.signOutEverywhere(userId),
    onSuccess: (res) => {
      setConfirmSignOut(false);
      setRevokedCount(res.data.revoked);
      setTimeout(() => setRevokedCount(null), 5000);
    },
  });

  const sendResetLink = useMutation({
    mutationFn: () => peopleApi.sendPasswordResetLink(userId),
    onSuccess: (res) => {
      setResetLinkStatus({
        email_sent: res.data.email_sent,
        smtp_configured: res.data.smtp_configured,
        expires_in_minutes: res.data.expires_in_minutes,
      });
      setTimeout(() => setResetLinkStatus(null), 8000);
    },
  });

  // --- API keys ---
  const { data: keysRes, isLoading: keysLoading } = useQuery({
    queryKey: ['people', 'member', userId, 'api-keys'],
    queryFn: () => peopleApi.listApiKeys(userId),
  });
  const keys = keysRes?.data ?? [];

  const invalidateKeys = () =>
    queryClient.invalidateQueries({ queryKey: ['people', 'member', userId, 'api-keys'] });

  const revokeKey = useMutation({
    mutationFn: (keyId: string) => peopleApi.revokeApiKey(userId, keyId),
    onSuccess: invalidateKeys,
  });

  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [showCreateKey, setShowCreateKey] = useState(false);

  return (
    <div className="space-y-5">
      {/* Password card — admin-only, only when acting on someone ranked strictly below */}
      {adminActionsAllowed && (
        <Card title="Password & sessions">
          {forceSuccess && (
            <div className="mb-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200">
              User will be forced to set a new password on their next login.
            </div>
          )}
          {revokedCount != null && (
            <div className="mb-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200">
              Revoked {revokedCount} session{revokedCount === 1 ? '' : 's'}.
            </div>
          )}
          {resetLinkStatus && (
            <div
              className={
                resetLinkStatus.email_sent
                  ? 'mb-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200'
                  : 'mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200'
              }
            >
              {resetLinkStatus.email_sent ? (
                <>
                  Password reset link sent. Expires in {resetLinkStatus.expires_in_minutes}{' '}
                  minute{resetLinkStatus.expires_in_minutes === 1 ? '' : 's'}.
                </>
              ) : (
                <>
                  Token minted, but SMTP is{' '}
                  {resetLinkStatus.smtp_configured ? 'misconfigured' : 'not configured'} — the
                  email was not delivered. Use "Reset password" to set a password directly.
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onOpenReset}>
              <KeyRound className="h-4 w-4" /> Reset password
            </Button>
            <Button
              variant="secondary"
              loading={sendResetLink.isPending}
              onClick={() => sendResetLink.mutate()}
            >
              <Mail className="h-4 w-4" /> Send password reset link
            </Button>
            <Button variant="secondary" onClick={() => setConfirmForceChange(true)}>
              <Lock className="h-4 w-4" /> Force password change
            </Button>
            <Button variant="secondary" onClick={() => setConfirmSignOut(true)}>
              <LogOut className="h-4 w-4" /> Sign out everywhere
            </Button>
          </div>
        </Card>
      )}

      {/* API keys card */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">API keys</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Tokens for programmatic access. Shown once at creation.
            </p>
          </div>
          <Button size="sm" onClick={() => setShowCreateKey(true)}>
            <Plus className="h-4 w-4" /> Create API key
          </Button>
        </div>

        {keysLoading ? (
          <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading...</p>
        ) : keys.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-zinc-400">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-800/50">
                <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Name</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Scope</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Prefix</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Last used</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Expires</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500">Created</th>
                  <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k: ApiKeyRecord) => (
                  <tr key={k.id} className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {k.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          k.scope === 'admin'
                            ? 'danger'
                            : k.scope === 'read_write'
                            ? 'info'
                            : 'default'
                        }
                      >
                        {k.scope}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {k.key_prefix}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">
                      {k.last_used_at ? formatRelativeTime(k.last_used_at) : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">
                      {k.expires_at ? formatDate(k.expires_at) : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">{formatDate(k.created_at)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {revokeConfirmId === k.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-xs text-zinc-600 dark:text-zinc-400 mr-1">
                            Revoke?
                          </span>
                          <button
                            onClick={() => {
                              revokeKey.mutate(k.id, {
                                onSuccess: () => setRevokeConfirmId(null),
                              });
                            }}
                            disabled={revokeKey.isPending}
                            className="rounded-md border border-red-200 dark:border-red-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setRevokeConfirmId(null)}
                            className="rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setRevokeConfirmId(k.id)}
                          className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                          title="Revoke"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Force password change confirm */}
      <Dialog
        open={confirmForceChange}
        onOpenChange={setConfirmForceChange}
        title="Force password change"
        description="User will be forced to set a new password on their next login."
      >
        {forceChange.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(forceChange.error as Error)?.message ?? 'Action failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmForceChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={forceChange.isPending}
            onClick={() => forceChange.mutate()}
          >
            Force change
          </Button>
        </div>
      </Dialog>

      {/* Sign out everywhere confirm */}
      <Dialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title="Sign out everywhere"
        description="Revoke all active sessions for this user. They will need to log in again on every device."
      >
        {signOutAll.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(signOutAll.error as Error)?.message ?? 'Action failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmSignOut(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={signOutAll.isPending}
            onClick={() => signOutAll.mutate()}
          >
            Sign out everywhere
          </Button>
        </div>
      </Dialog>

      {showCreateKey && (
        <CreateApiKeyDialog
          userId={userId}
          callerCanGrantAdmin={callerIsOwner}
          onClose={() => setShowCreateKey(false)}
          onCreated={invalidateKeys}
        />
      )}
    </div>
  );
}

function CreateApiKeyDialog({
  userId,
  callerCanGrantAdmin,
  onClose,
  onCreated,
}: {
  userId: string;
  callerCanGrantAdmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const scopeOptions = callerCanGrantAdmin
    ? API_KEY_SCOPE_OPTIONS
    : API_KEY_SCOPE_OPTIONS.filter((opt) => opt.value !== 'admin');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read');
  const [expiresDays, setExpiresDays] = useState<number | ''>('');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      peopleApi.createApiKey(userId, {
        name,
        scope,
        project_ids: [],
        expires_days: expiresDays === '' ? undefined : Number(expiresDays),
      }),
    onSuccess: (res) => {
      setToken(res.data.token);
      onCreated();
    },
  });

  const close = () => {
    setName('');
    setScope('read');
    setExpiresDays('');
    setToken(null);
    setCopied(false);
    create.reset();
    onClose();
  };

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={token ? 'API key created' : 'Create API key'}
      description={
        token
          ? 'Copy this token now. It will not be shown again.'
          : 'Create a new API key for this user.'
      }
    >
      {!token ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length === 0) return;
            create.mutate();
          }}
          className="space-y-4"
        >
          <Input
            id="api-key-name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. CI deploy bot"
            required
            autoFocus
          />

          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">Scope</div>
            <div className="space-y-1.5">
              {scopeOptions.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={scope === opt.value}
                    onChange={() => setScope(opt.value)}
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">{opt.label}</span>
                </label>
              ))}
            </div>
            {!callerCanGrantAdmin && (
              <p
                className="mt-2 text-xs text-zinc-500 dark:text-zinc-400"
                title="Admin-scope keys can only be created by an organization owner."
              >
                Admin-scope keys can only be created by an organization owner.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="api-key-expires"
              className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1"
            >
              Expires in (days)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="api-key-expires"
                type="number"
                min={1}
                value={expiresDays}
                onChange={(e) => setExpiresDays(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Never"
                className="w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
              />
              {[30, 90, 365].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setExpiresDays(d)}
                  className="rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  {d}d
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Leave blank for a key that never expires. Project restriction can be added later.
            </p>
          </div>

          {create.isError && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
              {(create.error as Error)?.message ?? 'Create failed'}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={name.trim().length === 0}>
              Create key
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200">
            Shown only once. Copy it now.
          </div>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-900 dark:text-zinc-100 break-all">
              {token}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(token);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="shrink-0 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="flex items-center justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// --- Activity tab ---

function formatActionLabel(action: string): string {
  const spaced = action.replace(/\./g, ' ').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const INLINE_DETAIL_KEYS = ['from', 'to', 'status', 'phase', 'title', 'name'];

function ActivityTab({ userId }: { userId: string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['people', 'member', userId, 'activity', cursor ?? 'first'],
    queryFn: () => peopleApi.getActivity(userId, { limit: 50, cursor }),
  });

  useEffect(() => {
    if (!data) return;
    if (cursor === undefined) {
      setEntries(data.data);
    } else {
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...data.data.filter((e) => !seen.has(e.id))];
      });
    }
    setNextCursor(data.next_cursor);
  }, [data, cursor]);

  if (isLoading && entries.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-6 py-10 text-center text-sm text-zinc-400">
        Loading activity...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-6 py-10 text-center text-sm text-zinc-400">
        No activity recorded for this user in this org.
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <ol className="relative border-l border-zinc-200 dark:border-zinc-800 ml-2">
        {entries.map((entry) => {
          const details = entry.details ?? {};
          const inlineKeys = Object.keys(details).filter((k) => INLINE_DETAIL_KEYS.includes(k));
          const hasExtra = Object.keys(details).some((k) => !INLINE_DETAIL_KEYS.includes(k));
          const isExpanded = expanded[entry.id];

          return (
            <li key={entry.id} className="mb-5 ml-5 last:mb-0">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-primary-500 ring-2 ring-white dark:ring-zinc-900" />
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {formatActionLabel(entry.action)}
                  {entry.project_name && (
                    <span className="text-zinc-500 font-normal">
                      {' in '}
                      <span className="text-zinc-700 dark:text-zinc-300">{entry.project_name}</span>
                    </span>
                  )}
                </div>
                <time
                  className="text-xs text-zinc-500 shrink-0"
                  title={formatDate(entry.created_at)}
                >
                  {formatRelativeTime(entry.created_at)}
                </time>
              </div>

              {inlineKeys.length > 0 && (
                <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {inlineKeys.map((k) => (
                    <span key={k}>
                      <span className="text-zinc-500">{k}:</span>{' '}
                      <span className="font-mono">{String(details[k])}</span>
                    </span>
                  ))}
                </div>
              )}

              {entry.impersonator_id && (
                <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  via impersonation by {entry.impersonator_id}
                </div>
              )}

              {hasExtra && (
                <div className="mt-1.5">
                  <button
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))
                    }
                    className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                  >
                    {isExpanded ? 'Hide details' : 'Show details'}
                  </button>
                  {isExpanded && (
                    <pre className="mt-1.5 rounded-md bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-300 overflow-x-auto">
                      {JSON.stringify(details, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {nextCursor && (
        <div className="flex items-center justify-center pt-4 mt-2 border-t border-zinc-100 dark:border-zinc-800">
          <Button
            variant="secondary"
            size="sm"
            loading={isFetching && cursor !== undefined}
            onClick={() => setCursor(nextCursor)}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
