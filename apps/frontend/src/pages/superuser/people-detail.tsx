import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  MoreHorizontal,
  Shield,
  Loader2,
  Mail,
  Plus,
  Trash2,
  Star,
  Ban,
  ChevronDown,
  ChevronRight,
  LogIn,
  AlertTriangle,
} from 'lucide-react';
import type { SuperuserOrgListResponse } from '@bigbluebam/shared';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { superuserApi } from '@/lib/api/superuser';
import { UserPermissionsTab } from '@/components/superuser/user-permissions-tab';
import { ImpersonateDialog } from '@/components/superuser/impersonate-dialog';
import {
  superuserUsersApi,
  type OrgRole,
  type SuperuserUserDetail,
  type SuperuserUserFullMembership,
  type SuperuserUserSession,
  type SuperuserUserProject,
  type SuperuserAuditLogEntry,
} from '@/lib/api/superuser-users';
import { ApiError } from '@/lib/api';
import { formatDate, formatRelativeTime } from '@/lib/utils';

interface SuperuserPeopleDetailPageProps {
  userId: string;
  onNavigate: (path: string) => void;
}

type DetailTab = 'overview' | 'memberships' | 'projects' | 'permissions' | 'sessions' | 'activity';

const ORG_ROLE_OPTIONS: { value: OrgRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

export function SuperuserPeopleDetailPage({ userId, onNavigate }: SuperuserPeopleDetailPageProps) {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>('overview');

  // Gate
  useEffect(() => {
    if (currentUser && currentUser.is_superuser !== true) onNavigate('/');
  }, [currentUser, onNavigate]);

  const { data: detailRes, isLoading } = useQuery({
    queryKey: ['superuser', 'users', userId],
    queryFn: () => superuserUsersApi.getUser(userId),
    enabled: currentUser?.is_superuser === true,
  });
  const user = detailRes?.data;

  // Dialog state
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [showAddOrg, setShowAddOrg] = useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [confirmRemoveOrg, setConfirmRemoveOrg] = useState<SuperuserUserFullMembership | null>(null);
  const [showImpersonate, setShowImpersonate] = useState(false);
  const [confirmSuToggle, setConfirmSuToggle] = useState<'grant' | 'revoke' | null>(null);

  const invalidateUser = () => {
    queryClient.invalidateQueries({ queryKey: ['superuser', 'users', userId] });
    queryClient.invalidateQueries({ queryKey: ['superuser', 'users'] });
  };

  const setSuperuser = useMutation({
    mutationFn: (is: boolean) => superuserUsersApi.setSuperuserFlag(userId, is),
    onSuccess: () => {
      invalidateUser();
      setConfirmSuToggle(null);
    },
  });

  const revokeAll = useMutation({
    mutationFn: () => superuserUsersApi.revokeAllSessions(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'users', userId, 'sessions'] });
      setConfirmRevokeAll(false);
    },
  });

  if (!currentUser || currentUser.is_superuser !== true) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <Shell onNavigate={onNavigate}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell onNavigate={onNavigate}>
        <div className="max-w-7xl mx-auto px-6 py-10">
          <p className="text-sm text-zinc-500">User not found.</p>
          <Button variant="ghost" onClick={() => onNavigate('/superuser/people')} className="mt-4">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onNavigate={onNavigate}>
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <Avatar src={user.avatar_url} name={user.display_name} size="lg" />
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                  {user.display_name || user.email}
                </h1>
                {user.is_active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="danger">Disabled</Badge>
                )}
                {user.is_superuser && (
                  <Badge variant="danger" className="gap-1">
                    <Shield className="h-3 w-3" /> SuperUser
                  </Badge>
                )}
              </div>
              <p className="text-sm text-zinc-500 mt-1">{user.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => onNavigate('/superuser/people')}>
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
              {user.id !== currentUser.id && (
                <DropdownMenuItem onSelect={() => setShowImpersonate(true)}>
                  <LogIn className="h-4 w-4" /> Impersonate
                </DropdownMenuItem>
              )}
              {user.id !== currentUser.id && (
                <DropdownMenuItem
                  onSelect={() => setConfirmSuToggle(user.is_superuser ? 'revoke' : 'grant')}
                >
                  <Shield className="h-4 w-4" />
                  {user.is_superuser ? 'Revoke SuperUser' : 'Grant SuperUser'}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirmRevokeAll(true)}>
                <Ban className="h-4 w-4" /> Sign out everywhere
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          <TabButton active={tab === 'memberships'} onClick={() => setTab('memberships')}>
            Memberships
            <span className="ml-1.5 text-xs text-zinc-400 tabular-nums">
              {user.memberships.length}
            </span>
          </TabButton>
          <TabButton active={tab === 'projects'} onClick={() => setTab('projects')}>Projects</TabButton>
          <TabButton active={tab === 'permissions'} onClick={() => setTab('permissions')}>Permissions</TabButton>
          <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>Sessions</TabButton>
          <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>Activity</TabButton>
        </div>

        {tab === 'overview' && (
          <OverviewTab user={user} onChangeEmail={() => setShowChangeEmail(true)} />
        )}
        {tab === 'memberships' && (
          <MembershipsTab
            user={user}
            onAddOrg={() => setShowAddOrg(true)}
            onConfirmRemove={(m) => setConfirmRemoveOrg(m)}
          />
        )}
        {tab === 'projects' && <ProjectsTab userId={userId} />}
        {tab === 'permissions' && <UserPermissionsTab userId={userId} />}
        {tab === 'sessions' && (
          <SessionsTab userId={userId} onRevokeAll={() => setConfirmRevokeAll(true)} />
        )}
        {tab === 'activity' && <ActivityTab userId={userId} />}
      </div>

      {/* Change email dialog */}
      {showChangeEmail && (
        <ChangeEmailDialog
          user={user}
          onClose={() => setShowChangeEmail(false)}
          onSuccess={invalidateUser}
        />
      )}

      {/* Add to org dialog */}
      {showAddOrg && (
        <AddToOrgDialog
          user={user}
          onClose={() => setShowAddOrg(false)}
          onSuccess={invalidateUser}
        />
      )}

      {/* Confirm remove from org */}
      <Dialog
        open={!!confirmRemoveOrg}
        onOpenChange={(o) => {
          if (!o) setConfirmRemoveOrg(null);
        }}
        title="Remove from organization"
        description={
          confirmRemoveOrg
            ? `This removes ${user.display_name || user.email} from ${confirmRemoveOrg.org_name}. Their access to the org's projects will be revoked.`
            : ''
        }
      >
        {confirmRemoveOrg && (
          <RemoveOrgConfirmBody
            userId={userId}
            membership={confirmRemoveOrg}
            onClose={() => setConfirmRemoveOrg(null)}
            onSuccess={invalidateUser}
          />
        )}
      </Dialog>

      {/* Revoke all sessions confirm */}
      <Dialog
        open={confirmRevokeAll}
        onOpenChange={setConfirmRevokeAll}
        title="Sign out everywhere"
        description={`Revoke all active sessions for ${user.display_name || user.email}? They will need to log in again.`}
      >
        {revokeAll.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(revokeAll.error as Error)?.message ?? 'Revoke failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmRevokeAll(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={revokeAll.isPending} onClick={() => revokeAll.mutate()}>
            Sign out everywhere
          </Button>
        </div>
      </Dialog>

      {/* Impersonate dialog */}
      {showImpersonate && (
        <ImpersonateDialog
          user={user}
          onClose={() => setShowImpersonate(false)}
        />
      )}

      {/* Grant/revoke SuperUser confirm */}
      <Dialog
        open={!!confirmSuToggle}
        onOpenChange={(o) => {
          if (!o) setConfirmSuToggle(null);
        }}
        title={confirmSuToggle === 'grant' ? 'Grant SuperUser' : 'Revoke SuperUser'}
        description={
          confirmSuToggle === 'grant'
            ? `Grant SuperUser privileges to ${user.display_name || user.email}?`
            : `Revoke SuperUser privileges from ${user.display_name || user.email}?`
        }
      >
        {confirmSuToggle === 'grant' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This user will be able to view and modify data across <strong>every organization</strong> on this server.
            </span>
          </div>
        )}
        {setSuperuser.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(setSuperuser.error as Error)?.message ?? 'Action failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmSuToggle(null)}>
            Cancel
          </Button>
          <Button
            variant={confirmSuToggle === 'grant' ? 'danger' : 'primary'}
            loading={setSuperuser.isPending}
            onClick={() => setSuperuser.mutate(confirmSuToggle === 'grant')}
          >
            {confirmSuToggle === 'grant' ? 'Grant SuperUser' : 'Revoke SuperUser'}
          </Button>
        </div>
      </Dialog>
    </Shell>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────

function Shell({ onNavigate, children }: { onNavigate: (p: string) => void; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-3">
          <button
            onClick={() => onNavigate('/superuser/people')}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Back to users"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-red-100 dark:bg-red-900/30">
            <Shield className="h-4 w-4 text-red-600 dark:text-red-400" />
          </div>
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            SuperUser · User detail
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}

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
        'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex items-center ' +
        (active
          ? 'border-primary-600 text-primary-700 dark:text-primary-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')
      }
    >
      {children}
    </button>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3 last:border-0 last:pb-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

// ─── Overview Tab ───────────────────────────────────────────────────────────

function OverviewTab({ user, onChangeEmail }: { user: SuperuserUserDetail; onChangeEmail: () => void }) {
  return (
    <div className="space-y-5">
      {!user.is_active && user.disabled_at && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950 dark:border-red-900 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          Account disabled
          {user.disabled_by && ` by ${user.disabled_by.display_name || user.disabled_by.email}`}
          {` on ${formatDate(user.disabled_at)}.`}
        </div>
      )}

      <Card
        title="Identity"
        action={
          <Button size="sm" variant="secondary" onClick={onChangeEmail}>
            <Mail className="h-3.5 w-3.5" /> Change email
          </Button>
        }
      >
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Row label="Display name">
            <span className="text-zinc-700 dark:text-zinc-300">{user.display_name || '—'}</span>
          </Row>
          <Row label="Timezone">
            <span className="text-zinc-700 dark:text-zinc-300">{user.timezone || 'UTC'}</span>
          </Row>
          <Row label="Email">
            <div className="flex items-center gap-2 justify-end">
              <span className="text-zinc-700 dark:text-zinc-300">{user.email}</span>
              {user.email_verified ? (
                <Badge variant="success">Verified</Badge>
              ) : (
                <Badge variant="warning">Unverified</Badge>
              )}
            </div>
          </Row>
          <Row label="Avatar">
            <span className="text-zinc-700 dark:text-zinc-300">
              {user.avatar_url ? 'custom image' : 'default initials'}
            </span>
          </Row>
        </dl>

        {user.pending_email && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-200">
            Pending verification to <strong>{user.pending_email}</strong>
          </div>
        )}
      </Card>

      <Card title="Status">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Row label="Active">
            {user.is_active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="danger">Disabled</Badge>
            )}
          </Row>
          <Row label="SuperUser">
            {user.is_superuser ? (
              <Badge variant="danger">
                <Shield className="h-3 w-3 mr-1" /> Yes
              </Badge>
            ) : (
              <span className="text-zinc-500">No</span>
            )}
          </Row>
          <Row label="Created">
            <span className="text-zinc-700 dark:text-zinc-300">{formatDate(user.created_at)}</span>
          </Row>
          <Row label="Last seen">
            <span className="text-zinc-700 dark:text-zinc-300">
              {user.last_seen_at ? formatRelativeTime(user.last_seen_at) : 'Never'}
            </span>
          </Row>
          <Row label="Updated">
            <span className="text-zinc-700 dark:text-zinc-300">{formatDate(user.updated_at)}</span>
          </Row>
          {!user.is_active && user.disabled_at && (
            <>
              <Row label="Disabled at">
                <span className="text-zinc-700 dark:text-zinc-300">{formatDate(user.disabled_at)}</span>
              </Row>
              <Row label="Disabled by">
                <span className="text-zinc-700 dark:text-zinc-300">
                  {user.disabled_by?.display_name || user.disabled_by?.email || '—'}
                </span>
              </Row>
            </>
          )}
        </dl>
      </Card>
    </div>
  );
}

// ─── Memberships Tab ────────────────────────────────────────────────────────

function MembershipsTab({
  user,
  onAddOrg,
  onConfirmRemove,
}: {
  user: SuperuserUserDetail;
  onAddOrg: () => void;
  onConfirmRemove: (m: SuperuserUserFullMembership) => void;
}) {
  const queryClient = useQueryClient();
  const userId = user.id;
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['superuser', 'users', userId] });
    queryClient.invalidateQueries({ queryKey: ['superuser', 'users'] });
  };

  const updateRole = useMutation({
    mutationFn: ({ orgId, role }: { orgId: string; role: OrgRole }) =>
      superuserUsersApi.updateMembershipRole(userId, orgId, role),
    onSuccess: invalidate,
  });

  const setDefault = useMutation({
    mutationFn: (orgId: string) => superuserUsersApi.setDefaultOrg(userId, orgId),
    onSuccess: invalidate,
  });

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Organization memberships</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Every org this user belongs to.</p>
        </div>
        <Button size="sm" onClick={onAddOrg}>
          <Plus className="h-4 w-4" /> Add to organization
        </Button>
      </div>

      {user.memberships.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">No org memberships.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                <th className="px-4 py-2.5 font-medium text-zinc-500">Organization</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Role</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Default</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Joined</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {user.memberships.map((m) => (
                <tr key={m.org_id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{m.org_name}</span>
                      <span className="text-xs text-zinc-500 font-mono">{m.org_slug}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Select
                      options={ORG_ROLE_OPTIONS}
                      value={m.role}
                      onValueChange={(v) =>
                        updateRole.mutate({ orgId: m.org_id, role: v as OrgRole })
                      }
                      className="w-28"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    {m.is_default ? (
                      <Badge variant="info">
                        <Star className="h-3 w-3 mr-1" /> Default
                      </Badge>
                    ) : (
                      <button
                        onClick={() => setDefault.mutate(m.org_id)}
                        disabled={setDefault.isPending}
                        className="text-xs text-primary-600 hover:text-primary-700 hover:underline disabled:opacity-50"
                      >
                        Set as default
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(m.joined_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => onConfirmRemove(m)}
                      className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                      title="Remove from org"
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
    </div>
  );
}

function RemoveOrgConfirmBody({
  userId,
  membership,
  onClose,
  onSuccess,
}: {
  userId: string;
  membership: SuperuserUserFullMembership;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => superuserUsersApi.removeMembership(userId, membership.org_id),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
  });

  const err = remove.error as ApiError | Error | null;
  const isLastMembership =
    err instanceof ApiError && err.code === 'LAST_MEMBERSHIP';

  return (
    <>
      {err && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300 mb-3">
          {isLastMembership
            ? 'Cannot remove — this is the user’s last organization membership.'
            : err.message}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
          Remove
        </Button>
      </div>
    </>
  );
}

// ─── Projects Tab ───────────────────────────────────────────────────────────

function ProjectsTab({ userId }: { userId: string }) {
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const { data, isLoading } = useQuery({
    queryKey: ['superuser', 'users', userId, 'projects', scope],
    queryFn: () => superuserUsersApi.listUserProjects(userId, scope),
  });
  const projects: SuperuserUserProject[] = data?.data ?? [];

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Project access</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Projects this user belongs to.</p>
        </div>
        <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-800">
          <ScopeBtn active={scope === 'active'} onClick={() => setScope('active')}>Active org</ScopeBtn>
          <ScopeBtn active={scope === 'all'} onClick={() => setScope('all')}>All orgs</ScopeBtn>
        </div>
      </div>
      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading...</p>
      ) : projects.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">No project memberships.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                <th className="px-4 py-2.5 font-medium text-zinc-500">Project</th>
                {scope === 'all' && <th className="px-4 py-2.5 font-medium text-zinc-500">Organization</th>}
                <th className="px-4 py-2.5 font-medium text-zinc-500">Role</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Joined</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={`${p.org_id}:${p.project_id}`} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{p.project_name}</span>
                      {p.is_archived && <Badge variant="warning">Archived</Badge>}
                    </div>
                  </td>
                  {scope === 'all' && (
                    <td className="px-4 py-2.5 text-zinc-500">{p.org_name}</td>
                  )}
                  <td className="px-4 py-2.5 capitalize text-zinc-700 dark:text-zinc-300">{p.role}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(p.joined_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScopeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 text-xs font-medium rounded-md transition-colors ' +
        (active
          ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
          : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')
      }
    >
      {children}
    </button>
  );
}

// ─── Sessions Tab ───────────────────────────────────────────────────────────

function SessionsTab({ userId, onRevokeAll }: { userId: string; onRevokeAll: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['superuser', 'users', userId, 'sessions'],
    queryFn: () => superuserUsersApi.listSessions(userId),
  });
  const sessions: SuperuserUserSession[] = data?.data ?? [];

  const revokeOne = useMutation({
    mutationFn: (sessionId: string) => superuserUsersApi.revokeSession(userId, sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['superuser', 'users', userId, 'sessions'] }),
  });

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Active sessions</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Sessions not yet expired.</p>
        </div>
        {sessions.length > 0 && (
          <Button size="sm" variant="danger" onClick={onRevokeAll}>
            <Ban className="h-4 w-4" /> Revoke all
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading...</p>
      ) : sessions.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">No active sessions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                <th className="px-4 py-2.5 font-medium text-zinc-500">Created</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Last used</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">Expires</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">IP</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500">User agent</th>
                <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2.5 text-zinc-500 whitespace-nowrap">
                    {formatRelativeTime(s.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 whitespace-nowrap">
                    {s.last_used_at ? formatRelativeTime(s.last_used_at) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 whitespace-nowrap">
                    {formatRelativeTime(s.expires_at)}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 font-mono text-xs">
                    {s.ip_address || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs truncate max-w-[260px]" title={s.user_agent || ''}>
                    {s.user_agent || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => revokeOne.mutate(s.id)}
                      disabled={revokeOne.isPending}
                      className="text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
                    >
                      Revoke
                    </button>
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

// ─── Activity Tab ───────────────────────────────────────────────────────────

function ActivityTab({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['superuser', 'audit-log', { target_user_id: userId }],
    queryFn: () =>
      superuserUsersApi.getAuditLog({ target_user_id: userId, limit: 50 }),
  });
  const entries: SuperuserAuditLogEntry[] = data?.data ?? [];

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent activity</h3>
        <p className="text-xs text-zinc-500 mt-0.5">Last 50 SuperUser actions targeting this user.</p>
      </div>
      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">No activity recorded.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {entries.map((e) => (
            <AuditEntry key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function humanAction(action: string): string {
  return action
    .split(/[._-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function AuditEntry({ entry }: { entry: SuperuserAuditLogEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;
  return (
    <li className="px-6 py-3">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className="flex items-start gap-3 w-full text-left"
        disabled={!hasDetails}
      >
        {hasDetails ? (
          open ? (
            <ChevronDown className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
          )
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {humanAction(entry.action)}
            </span>
            <span className="text-xs text-zinc-400">·</span>
            <span className="text-xs text-zinc-500" title={formatDate(entry.created_at)}>
              {formatRelativeTime(entry.created_at)}
            </span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            by SuperUser <code className="font-mono">{entry.superuser_id.slice(0, 8)}</code>
          </div>
        </div>
      </button>
      {open && hasDetails && (
        <pre className="mt-2 ml-7 rounded-md bg-zinc-50 dark:bg-zinc-800 p-3 text-xs font-mono text-zinc-700 dark:text-zinc-300 overflow-x-auto">
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      )}
    </li>
  );
}

// ─── Change-email dialog ────────────────────────────────────────────────────

function ChangeEmailDialog({
  user,
  onClose,
  onSuccess,
}: {
  user: SuperuserUserDetail;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState('');
  const change = useMutation({
    mutationFn: () => superuserUsersApi.changeEmail(user.id, email),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
  });
  const err = change.error as Error | null;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Change email"
      description={`Send a verification email to change ${user.display_name || user.email}'s address.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) change.mutate();
        }}
        className="space-y-4"
      >
        <Input
          type="email"
          label="New email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
          autoFocus
        />
        {err && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
            {err.message}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={change.isPending} disabled={!email.trim()}>
            Send verification
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Add-to-org dialog ──────────────────────────────────────────────────────

function AddToOrgDialog({
  user,
  onClose,
  onSuccess,
}: {
  user: SuperuserUserDetail;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { data, isLoading } = useQuery<SuperuserOrgListResponse>({
    queryKey: ['superuser', 'organizations', { all: true }],
    queryFn: () => superuserApi.listOrganizations({ limit: 200 }),
  });
  const allOrgs = data?.data ?? [];

  const currentIds = useMemo(() => new Set(user.memberships.map((m) => m.org_id)), [user.memberships]);
  const available = useMemo(() => allOrgs.filter((o) => !currentIds.has(o.id)), [allOrgs, currentIds]);

  const [orgId, setOrgId] = useState<string>('');
  const [role, setRole] = useState<OrgRole>('member');

  useEffect(() => {
    if (!orgId && available.length > 0) setOrgId(available[0]!.id);
  }, [available, orgId]);

  const add = useMutation({
    mutationFn: () => superuserUsersApi.addMembership(user.id, { org_id: orgId, role }),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
  });

  const err = add.error as ApiError | Error | null;
  const isAlreadyMember = err instanceof ApiError && err.code === 'ALREADY_MEMBER';

  const orgOptions = available.map((o) => ({ value: o.id, label: `${o.name} (${o.slug})` }));

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to organization"
      description={`Add ${user.display_name || user.email} to another organization.`}
    >
      {isLoading ? (
        <div className="py-8 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
        </div>
      ) : available.length === 0 ? (
        <p className="text-sm text-zinc-500 py-4">User is already a member of every organization.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (orgId) add.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Organization
            </label>
            <Select
              options={orgOptions}
              value={orgId}
              onValueChange={setOrgId}
              placeholder="Select an organization"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Role
            </label>
            <Select
              options={ORG_ROLE_OPTIONS}
              value={role}
              onValueChange={(v) => setRole(v as OrgRole)}
            />
          </div>
          {err && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
              {isAlreadyMember ? 'User is already a member of this organization.' : err.message}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={add.isPending} disabled={!orgId}>
              Add to org
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ImpersonateDialog now lives in components/superuser/impersonate-dialog.tsx,
// shared with the People Manager detail page (imported at the top of this file).
