import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  Plus,
  Loader2,
  Trash2,
  UserCheck,
  UserX,
  X as XIcon,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import { ResetPasswordDialog } from '@/components/people/reset-password-dialog';
import { RevealOnceSecret } from '@/components/people/reveal-once-secret';
import { ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { UserPermissionsTab } from '@/components/superuser/user-permissions-tab';
import {
  superuserPermissionsApi,
  type ScopeType,
  type PermissionGroupListItem,
} from '@/lib/api/superuser-permissions';
import {
  getPerson,
  listOrgProjects,
  peopleManagerApi,
  type PersonMembership,
  type ProjectMembership,
  type ProjectMemberRole,
  type ApiKeyRecord,
  type ApiKeyScope,
  type ActivityEntry,
} from '@/lib/api/people-manager';
import { formatDate, formatRelativeTime } from '@/lib/utils';

interface PeopleManagerDetailPageProps {
  userId: string;
  onNavigate: (path: string) => void;
}

type DetailTab = 'overview' | 'memberships' | 'projects' | 'permissions' | 'access' | 'activity';

const ORG_ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

const PROJECT_ROLE_OPTIONS: { value: ProjectMemberRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const API_KEY_SCOPE_OPTIONS: { value: ApiKeyScope; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'read_write', label: 'Read / Write' },
  { value: 'admin', label: 'Admin' },
];

/**
 * People Manager v2 — person detail (plan §7, milestone M3).
 *
 * Fetches the person via the M1 list endpoint's `user_id` filter
 * (`getPerson`), which returns the person PLUS their per-org memberships,
 * each carrying server-computed capability flags (`caps`). ALL gating is
 * driven from those server caps — the page never re-derives rank client-side.
 *
 * Every mutation reuses an existing `/org/members/*` endpoint with the
 * `X-Org-Id` header set to the org the action targets (the org whose
 * membership row the operator is acting on). The server re-checks rank in
 * that org, so this page is defense-in-depth safe across the accessor's
 * visible orgs.
 */
export function PeopleManagerDetailPage({ userId, onNavigate }: PeopleManagerDetailPageProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>('overview');
  // The Permissions tab mounts the SuperUser-only permission matrix; its
  // backing endpoints (/superuser/permissions/*) are SU-gated, so the tab is
  // only ever shown to SuperUsers (plan §7 / §11.3, milestone M4).
  const isSuperuser = useAuthStore((s) => s.user?.is_superuser === true);

  const { data: person, isLoading } = useQuery({
    queryKey: ['people-manager', 'person', userId],
    queryFn: () => getPerson(userId),
  });

  const memberships = person?.memberships ?? [];

  // The org used for profile/identity edits: the first membership whose caps
  // grant admin authority (manage_projects implies admin/owner of that org).
  // Falls back to the first membership so a read-only view still resolves an
  // org for the (disabled) inputs.
  const profileMembership = useMemo<PersonMembership | undefined>(
    () => memberships.find((m) => m.caps.manage_projects) ?? memberships[0],
    [memberships],
  );

  const invalidatePerson = () => {
    queryClient.invalidateQueries({ queryKey: ['people-manager', 'person', userId] });
    queryClient.invalidateQueries({ queryKey: ['people-manager', 'list'] });
  };

  const [resetCtx, setResetCtx] = useState<{ orgId: string } | null>(null);

  if (isLoading) {
    return (
      <AppLayout
        breadcrumbs={[{ label: 'People Manager', href: '/people-manager' }, { label: '...' }]}
        onNavigate={onNavigate}
        onCreateProject={() => onNavigate('/')}
      >
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </AppLayout>
    );
  }

  if (!person) {
    return (
      <AppLayout
        breadcrumbs={[{ label: 'People Manager', href: '/people-manager' }, { label: 'Not found' }]}
        onNavigate={onNavigate}
        onCreateProject={() => onNavigate('/')}
      >
        <div className="max-w-7xl mx-auto px-6 py-10">
          <p className="text-sm text-zinc-500">
            This person is not visible to you, or no longer exists.
          </p>
          <Button variant="ghost" onClick={() => onNavigate('/people-manager')} className="mt-4">
            <ArrowLeft className="h-4 w-4" /> Back to People Manager
          </Button>
        </div>
      </AppLayout>
    );
  }

  const u = person.user;
  // Caps the caller has in ANY visible org with this person — drives which
  // tabs/actions appear at all.
  const canResetAnywhere = memberships.some((m) => m.caps.reset_password);
  const canManageKeysAnywhere = memberships.some((m) => m.caps.manage_keys);
  const canManageProjectsAnywhere = memberships.some((m) => m.caps.manage_projects);
  const showAccessTab = canResetAnywhere || canManageKeysAnywhere;
  const showActivityTab = memberships.some(
    (m) => m.caps.manage_projects || m.caps.manage_role,
  );
  // Soft-delete is account-level; caps.delete_account already encodes full
  // eligibility (admin in every org the target is in, not self, not a SU).
  const deletableMembership = memberships.find((m) => m.caps.delete_account);

  const resetLabel = u.display_name || u.email;

  return (
    <AppLayout
      breadcrumbs={[
        { label: 'People Manager', href: '/people-manager' },
        { label: u.display_name || u.email },
      ]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <Avatar src={u.avatar_url} name={u.display_name} size="lg" />
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                  {u.display_name || u.email}
                </h1>
                {u.is_active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="danger">Disabled</Badge>
                )}
              </div>
              <p className="text-sm text-zinc-500 mt-1">{u.email}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {memberships.map((m) => (
                  <span
                    key={m.org_id}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-0.5 text-xs"
                  >
                    <span className="font-medium text-zinc-700 dark:text-zinc-200">
                      {m.org_name || m.org_id}
                    </span>
                    <span className="text-zinc-400 capitalize">{m.role}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <Button variant="secondary" onClick={() => onNavigate('/people-manager')}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </TabButton>
          <TabButton active={tab === 'memberships'} onClick={() => setTab('memberships')}>
            Memberships
          </TabButton>
          {canManageProjectsAnywhere && (
            <TabButton active={tab === 'projects'} onClick={() => setTab('projects')}>
              Projects
            </TabButton>
          )}
          {isSuperuser && (
            <TabButton active={tab === 'permissions'} onClick={() => setTab('permissions')}>
              Permissions
            </TabButton>
          )}
          {showAccessTab && (
            <TabButton active={tab === 'access'} onClick={() => setTab('access')}>
              Access
            </TabButton>
          )}
          {showActivityTab && (
            <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
              Activity
            </TabButton>
          )}
        </div>

        {tab === 'overview' && (
          <OverviewTab
            user={u}
            membership={profileMembership}
            onSaved={invalidatePerson}
          />
        )}

        {tab === 'memberships' && (
          <MembershipsTab
            userId={userId}
            memberships={memberships}
            onChanged={invalidatePerson}
            onRemovedLast={() => onNavigate('/people-manager')}
          />
        )}

        {tab === 'projects' && canManageProjectsAnywhere && (
          <ProjectsTab userId={userId} memberships={memberships} />
        )}

        {tab === 'permissions' && isSuperuser && (
          <PermissionsTab userId={userId} memberships={memberships} />
        )}

        {tab === 'access' && showAccessTab && (
          <AccessTab
            userId={userId}
            memberships={memberships}
            onOpenReset={(orgId) => setResetCtx({ orgId })}
          />
        )}

        {tab === 'activity' && showActivityTab && (
          <ActivityTab userId={userId} memberships={memberships} />
        )}

        {deletableMembership && (
          <DangerZone
            userId={userId}
            orgId={deletableMembership.org_id}
            label={u.display_name || u.email}
            onDeleted={() => onNavigate('/people-manager')}
          />
        )}
      </div>

      {resetCtx && (
        <ResetPasswordDialog
          open={true}
          onOpenChange={(o) => {
            if (!o) setResetCtx(null);
          }}
          targetLabel={resetLabel}
          onReset={async (password) => {
            const res = await peopleManagerApi.resetPassword(resetCtx.orgId, userId, password);
            return res.data.password;
          }}
        />
      )}
    </AppLayout>
  );
}

// ─── Danger zone: soft-delete the account (plan §1) ──────────────────────────

function DangerZone({
  userId,
  orgId,
  label,
  onDeleted,
}: {
  userId: string;
  orgId: string;
  label: string;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const del = useMutation({
    mutationFn: () => peopleManagerApi.deleteAccount(orgId, userId, reason.trim() || undefined),
    onSuccess: () => {
      setConfirm(false);
      onDeleted();
    },
  });
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-4">
      <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">Danger zone</h3>
      <p className="mt-1 max-w-2xl text-xs text-red-700/80 dark:text-red-400/80">
        Soft-delete this account: removed from every organization, sessions and API keys revoked,
        and the email tombstoned (freeing it for a fresh invite). Authored content is preserved.
        This cannot be undone.
      </p>
      <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirm(true)}>
        <Trash2 className="h-4 w-4" /> Delete account
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={(o) => {
          if (!o) setConfirm(false);
        }}
        title={`Delete ${label}?`}
        description="This soft-deletes the account across all orgs and frees the email for re-invite. It cannot be undone."
      >
        <div className="space-y-3">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason (optional — recorded in the audit log)"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white px-2.5 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-950 dark:border-zinc-700 dark:text-zinc-100"
          />
          {del.isError && <p className="text-xs text-red-600">{(del.error as Error).message}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
              Delete account
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Shared layout helpers ───────────────────────────────────────────────────

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
      type="button"
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-primary-600 text-primary-700 dark:text-primary-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
      }`}
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

// ─── Overview / Identity ─────────────────────────────────────────────────────

function OverviewTab({
  user,
  membership,
  onSaved,
}: {
  user: { id: string; email: string; display_name: string; is_active: boolean; last_seen_at: string | null };
  membership: PersonMembership | undefined;
  onSaved: () => void;
}) {
  // Profile editing requires an org where the caller has admin authority. We
  // resolve the member detail (for timezone) from that org via X-Org-Id.
  const canEdit = !!membership && membership.caps.manage_projects;
  const orgId = membership?.org_id;

  const { data: detailRes } = useQuery({
    queryKey: ['people-manager', 'member-detail', orgId, user.id],
    queryFn: () => peopleManagerApi.getMemberInOrg(orgId ?? '', user.id),
    enabled: !!orgId,
  });
  const detail = detailRes?.data;

  const [displayName, setDisplayName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [dirty, setDirty] = useState(false);

  const detailDisplayName = detail?.display_name;
  const detailTimezone = detail?.timezone;
  const detailId = detail?.id;
  const userDisplayName = user.display_name;
  useEffect(() => {
    if (detailId) {
      setDisplayName(detailDisplayName ?? '');
      setTimezone(detailTimezone ?? 'UTC');
      setDirty(false);
    } else {
      setDisplayName(userDisplayName ?? '');
      setTimezone('UTC');
    }
  }, [detailId, detailDisplayName, detailTimezone, userDisplayName]);

  const save = useMutation({
    mutationFn: () =>
      peopleManagerApi.updateProfile(orgId ?? '', user.id, {
        display_name: displayName,
        timezone,
      }),
    onSuccess: () => {
      setDirty(false);
      onSaved();
    },
  });

  return (
    <div className="space-y-5">
      <Card title="Identity">
        {!canEdit && (
          <p className="mb-3 text-xs text-zinc-500">
            You can view this profile but do not have rights to edit it in any org you
            share with this person.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            id="pm-detail-display-name"
            label="Display name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setDirty(true);
            }}
            disabled={!canEdit}
          />
          <Input
            id="pm-detail-timezone"
            label="Timezone"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setDirty(true);
            }}
            disabled={!canEdit}
            placeholder="UTC"
          />
        </div>
        {canEdit && membership && (
          <p className="text-xs text-zinc-500 mt-3">
            Edits apply in <span className="font-medium">{membership.org_name}</span>.
          </p>
        )}
        {canEdit && (
          <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <Button
              variant="ghost"
              onClick={() => {
                setDisplayName(detail?.display_name ?? user.display_name ?? '');
                setTimezone(detail?.timezone ?? 'UTC');
                setDirty(false);
              }}
              disabled={!dirty}
            >
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
          </div>
        )}
        {save.isError && (
          <p className="text-sm text-red-600 mt-2">
            {(save.error as Error)?.message ?? 'Save failed'}
          </p>
        )}
      </Card>

      <Card title="Status">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-zinc-500">Status</dt>
            <dd>
              {user.is_active ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="danger">Disabled</Badge>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-zinc-500">Last seen</dt>
            <dd className="text-zinc-700 dark:text-zinc-300">
              {user.last_seen_at ? formatRelativeTime(user.last_seen_at) : 'Never'}
            </dd>
          </div>
          {detail && !detail.is_active && detail.disabled_at && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-zinc-500">Disabled</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                {formatDate(detail.disabled_at)}
                {detail.disabled_by &&
                  ` by ${detail.disabled_by.display_name || detail.disabled_by.email}`}
              </dd>
            </div>
          )}
        </dl>
      </Card>
    </div>
  );
}

// ─── Memberships ──────────────────────────────────────────────────────────────

function MembershipsTab({
  userId,
  memberships,
  onChanged,
  onRemovedLast,
}: {
  userId: string;
  memberships: PersonMembership[];
  onChanged: () => void;
  onRemovedLast: () => void;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Organization memberships
        </h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          This person's memberships across the orgs you can see. Actions are scoped to
          each org and gated by your rank there.
        </p>
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {memberships.map((m) => (
          <MembershipRow
            key={m.org_id}
            userId={userId}
            membership={m}
            isOnlyMembership={memberships.length === 1}
            onChanged={onChanged}
            onRemovedLast={onRemovedLast}
          />
        ))}
      </div>
    </div>
  );
}

function MembershipRow({
  userId,
  membership,
  isOnlyMembership,
  onChanged,
  onRemovedLast,
}: {
  userId: string;
  membership: PersonMembership;
  isOnlyMembership: boolean;
  onChanged: () => void;
  onRemovedLast: () => void;
}) {
  const { caps, org_id, org_name, role } = membership;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  // The member's version (for optimistic-concurrency on role/active edits) is
  // not in the list payload, so fetch the org-scoped detail lazily when this
  // row can act.
  const canAct = caps.manage_role || caps.disable;
  const { data: detailRes } = useQuery({
    queryKey: ['people-manager', 'member-detail', org_id, userId],
    queryFn: () => peopleManagerApi.getMemberInOrg(org_id, userId),
    enabled: canAct,
  });
  const version = detailRes?.data.version;
  const isActive = detailRes?.data.is_active ?? true;

  const updateRole = useMutation({
    mutationFn: (newRole: string) =>
      peopleManagerApi.updateRole(org_id, userId, newRole, version),
    onSuccess: () => {
      setConflict(null);
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setConflict('Role was changed by someone else — refresh to see the latest.');
        onChanged();
      }
    },
  });

  const setActive = useMutation({
    mutationFn: (next: boolean) => peopleManagerApi.setActive(org_id, userId, next, version),
    onSuccess: () => {
      setConflict(null);
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setConflict('This user was changed by someone else — refresh to see the latest.');
        onChanged();
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => peopleManagerApi.removeFromOrg(org_id, userId),
    onSuccess: () => {
      setConfirmRemove(false);
      if (isOnlyMembership) onRemovedLast();
      else onChanged();
    },
  });

  return (
    <div className="px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{org_name || org_id}</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {caps.disable ? (
              isActive ? (
                <Badge variant="success">Active here</Badge>
              ) : (
                <Badge variant="danger">Disabled here</Badge>
              )
            ) : (
              <span className="capitalize">{role}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {caps.manage_role ? (
            <Select
              options={ORG_ROLE_OPTIONS}
              value={role}
              onValueChange={(r) => updateRole.mutate(r)}
              className="w-32"
            />
          ) : (
            <span className="text-sm capitalize text-zinc-700 dark:text-zinc-300 px-2">
              {role}
            </span>
          )}

          {caps.disable && (
            <Button
              size="sm"
              variant="secondary"
              loading={setActive.isPending}
              onClick={() => setActive.mutate(!isActive)}
            >
              {isActive ? (
                <>
                  <UserX className="h-4 w-4" /> Disable
                </>
              ) : (
                <>
                  <UserCheck className="h-4 w-4" /> Enable
                </>
              )}
            </Button>
          )}

          {caps.remove && (
            <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          )}
        </div>
      </div>

      {conflict && (
        <div
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          role="alert"
        >
          {conflict}
        </div>
      )}
      {(updateRole.isError && !(updateRole.error instanceof ApiError && updateRole.error.status === 409)) && (
        <p className="mt-2 text-xs text-red-600">{(updateRole.error as Error).message}</p>
      )}

      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove from organization"
        description={`Remove this person from ${org_name || 'this org'}? Their access there will be revoked.`}
      >
        {remove.isError && (
          <p className="text-sm text-red-600 mb-3">{(remove.error as Error)?.message ?? 'Remove failed'}</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Projects (per-org) ───────────────────────────────────────────────────────

function ProjectsTab({
  userId,
  memberships,
}: {
  userId: string;
  memberships: PersonMembership[];
}) {
  const manageableOrgs = memberships.filter((m) => m.caps.manage_projects);

  if (manageableOrgs.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-6 py-10 text-center text-sm text-zinc-400">
        You can't manage this person's projects in any shared org.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {manageableOrgs.map((m) => (
        <OrgProjectsCard key={m.org_id} userId={userId} membership={m} />
      ))}
    </div>
  );
}

function OrgProjectsCard({
  userId,
  membership,
}: {
  userId: string;
  membership: PersonMembership;
}) {
  const queryClient = useQueryClient();
  const orgId = membership.org_id;
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['people-manager', 'member-projects', orgId, userId],
    queryFn: () => peopleManagerApi.listMemberProjects(orgId, userId),
  });
  const projects = data?.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ['people-manager', 'member-projects', orgId, userId],
    });

  const updateRole = useMutation({
    mutationFn: ({ projectId, role }: { projectId: string; role: ProjectMemberRole }) =>
      peopleManagerApi.updateMemberProjectRole(orgId, userId, projectId, role),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (projectId: string) =>
      peopleManagerApi.removeMemberFromProject(orgId, userId, projectId),
    onSuccess: invalidate,
  });

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {membership.org_name || orgId}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">Projects in this organization.</p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" /> Add to project
        </Button>
      </div>

      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading…</p>
      ) : projects.length === 0 ? (
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
              {projects.map((p: ProjectMembership) => (
                <tr key={p.project_id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {p.project_name}
                      </span>
                      {p.is_archived && <Badge variant="warning">Archived</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Select
                      options={PROJECT_ROLE_OPTIONS}
                      value={p.role}
                      onValueChange={(v) =>
                        updateRole.mutate({ projectId: p.project_id, role: v as ProjectMemberRole })
                      }
                      className="w-28"
                    />
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(p.joined_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => remove.mutate(p.project_id)}
                      disabled={remove.isPending}
                      className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                      title="Remove from project"
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

      {showAdd && (
        <AddProjectsDialog
          orgId={orgId}
          orgName={membership.org_name || orgId}
          userId={userId}
          existingIds={new Set(projects.map((p) => p.project_id))}
          onClose={() => setShowAdd(false)}
          onAdded={invalidate}
        />
      )}
    </div>
  );
}

function AddProjectsDialog({
  orgId,
  orgName,
  userId,
  existingIds,
  onClose,
  onAdded,
}: {
  orgId: string;
  orgName: string;
  userId: string;
  existingIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { data: orgProjects } = useQuery({
    queryKey: ['people-manager', 'org-projects', orgId],
    queryFn: () => listOrgProjects(orgId),
  });

  const available = useMemo(
    () => (orgProjects ?? []).filter((p) => !existingIds.has(p.id)),
    [orgProjects, existingIds],
  );

  const [selections, setSelections] = useState<Record<string, ProjectMemberRole>>({});

  const toggle = (id: string) =>
    setSelections((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = 'member';
      return next;
    });

  const setRole = (id: string, role: ProjectMemberRole) =>
    setSelections((prev) => ({ ...prev, [id]: role }));

  const add = useMutation({
    mutationFn: () =>
      peopleManagerApi.addMemberToProjects(
        orgId,
        userId,
        Object.entries(selections).map(([project_id, role]) => ({ project_id, role })),
      ),
    onSuccess: () => {
      onAdded();
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
      title={`Add to project(s) — ${orgName}`}
      description="Pick one or more projects in this org and a role per assignment."
    >
      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {available.length === 0 ? (
          <p className="text-sm text-zinc-500 py-6 text-center">
            On every project in this organization already.
          </p>
        ) : (
          available.map((project) => {
            const isSelected = !!selections[project.id];
            return (
              <div
                key={project.id}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  isSelected
                    ? 'border-primary-300 bg-primary-50 dark:bg-primary-950/30 dark:border-primary-800'
                    : 'border-zinc-200 dark:border-zinc-700'
                }`}
              >
                <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(project.id)}
                    className="rounded border-zinc-300 dark:border-zinc-700"
                  />
                  <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {project.name}
                  </span>
                  <span className="text-xs font-mono text-zinc-400">{project.task_id_prefix}</span>
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
        <p className="text-sm text-red-600 mt-3">{(add.error as Error)?.message ?? 'Add failed'}</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-4 mt-4 border-t border-zinc-100 dark:border-zinc-800">
        <span className="text-xs text-zinc-500">{selectedCount} selected</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            <XIcon className="h-4 w-4" /> Cancel
          </Button>
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={selectedCount === 0}>
            Add selected
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Permissions (SuperUser-only matrix + Add-membership) ─────────────────────
//
// Mounts the existing SU permission matrix (`UserPermissionsTab`) AS-IS (plan
// §7 / §11.3, milestone M4). The matrix can reassign or reattach a membership
// at a scope, but has no way to ADD one at a scope where the person has no
// membership yet. We add that affordance in this wrapper (NOT inside
// `UserPermissionsTab`, so the SU `/superuser/people/:id` page that also mounts
// it is untouched). On success we invalidate the exact query key the matrix
// reads from, so it refetches and shows the new membership row.

function PermissionsTab({
  userId,
  memberships,
}: {
  userId: string;
  memberships: PersonMembership[];
}) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          SuperUser permission matrix: group memberships, explicit overrides, and the
          effective permission set per scope.
        </p>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" /> Add membership
        </Button>
      </div>

      <UserPermissionsTab userId={userId} />

      {showAdd && (
        <AddMembershipDialog
          userId={userId}
          memberships={memberships}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

const SCOPE_TYPE_LABEL: Record<ScopeType, string> = {
  global: 'Global',
  org: 'Org',
  project: 'Project',
};

function AddMembershipDialog({
  userId,
  memberships,
  onClose,
}: {
  userId: string;
  memberships: PersonMembership[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  // Scope choices: Global, plus each org the person belongs to (within the
  // accessor's visible scope). Encoded as `scope_type:scope_id` so a single
  // <Select> can carry both. Project scope is out of scope for v1 (the matrix
  // itself only writes overrides at org/global; per-project membership is
  // managed via the Projects tab).
  const scopeOptions = useMemo(() => {
    const opts: { value: string; label: string; scope_type: ScopeType; scope_id: string | null }[] = [
      { value: 'global:', label: 'Global', scope_type: 'global', scope_id: null },
    ];
    for (const m of memberships) {
      opts.push({
        value: `org:${m.org_id}`,
        label: `Org: ${m.org_name || m.org_id}`,
        scope_type: 'org',
        scope_id: m.org_id,
      });
    }
    return opts;
  }, [memberships]);

  const [scopeValue, setScopeValue] = useState<string>(scopeOptions[0]?.value ?? 'global:');
  const [groupId, setGroupId] = useState<string>('');

  const selectedScope = useMemo(
    () => scopeOptions.find((o) => o.value === scopeValue) ?? scopeOptions[0],
    [scopeOptions, scopeValue],
  );

  const { data: groupsData, isLoading: groupsLoading } = useQuery({
    queryKey: ['superuser', 'permissions', 'groups'],
    queryFn: () => superuserPermissionsApi.listGroups(),
  });
  const allGroups: PermissionGroupListItem[] = groupsData?.data ?? [];

  // Filter groups to those matching the chosen scope_type and (when the group
  // is scope-bound) scope_id — same rule `UserPermissionsTab`'s MembershipRow
  // uses. A group with a null scope_id applies to any scope of its type.
  const availableGroups = useMemo(() => {
    if (!selectedScope) return [];
    return allGroups.filter((g) => {
      if (g.deleted_at !== null) return false;
      if (g.scope_type !== selectedScope.scope_type) return false;
      if (g.scope_id !== null && g.scope_id !== selectedScope.scope_id) return false;
      return true;
    });
  }, [allGroups, selectedScope]);

  const groupOptions = availableGroups.map((g) => ({ value: g.id, label: g.name }));

  // Reset the group choice whenever the scope changes (the prior group may not
  // be valid for the new scope) — pick the first available group, if any.
  useEffect(() => {
    const first = availableGroups[0]?.id ?? '';
    setGroupId((prev) => (availableGroups.some((g) => g.id === prev) ? prev : first));
  }, [availableGroups]);

  const add = useMutation({
    mutationFn: () => {
      if (!selectedScope) {
        return Promise.reject(new Error('Pick a scope'));
      }
      if (!groupId) {
        return Promise.reject(new Error('Pick a group'));
      }
      return superuserPermissionsApi.setUserMembership(userId, {
        scope_type: selectedScope.scope_type,
        scope_id: selectedScope.scope_id,
        group_id: groupId,
      });
    },
    onSuccess: () => {
      // Refetch the matrix the wrapper mounts (same key UserPermissionsTab reads).
      queryClient.invalidateQueries({
        queryKey: ['superuser', 'permissions', 'user', userId],
      });
      onClose();
    },
  });

  const err = add.error as Error | null;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add membership"
      description="Assign this person to a permission group at a scope. Reassign an existing scope from the matrix below."
    >
      <div className="space-y-4">
        <div>
          <Select
            label="Scope"
            options={scopeOptions.map((o) => ({ value: o.value, label: o.label }))}
            value={scopeValue}
            onValueChange={setScopeValue}
          />
          {selectedScope && (
            <p className="mt-1 text-[11px] text-zinc-400">
              {SCOPE_TYPE_LABEL[selectedScope.scope_type]} scope
              {selectedScope.scope_id ? ` · ${selectedScope.scope_id.slice(0, 8)}` : ''}
            </p>
          )}
        </div>

        <div>
          <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            Group
          </span>
          {groupsLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading groups…
            </div>
          ) : groupOptions.length === 0 ? (
            <p className="text-sm text-zinc-500 py-2">
              No permission groups exist for this scope.
            </p>
          ) : (
            <Select
              options={groupOptions}
              value={groupId}
              onValueChange={setGroupId}
              placeholder="Select a group"
            />
          )}
        </div>

        {err && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
            {err.message}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            <XIcon className="h-4 w-4" /> Cancel
          </Button>
          <Button
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={!groupId || groupOptions.length === 0}
          >
            Add membership
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Access (password / sessions / keys), per-org ─────────────────────────────

function AccessTab({
  userId,
  memberships,
  onOpenReset,
}: {
  userId: string;
  memberships: PersonMembership[];
  onOpenReset: (orgId: string) => void;
}) {
  // Password/session ops use the first org where the caller can reset; API keys
  // use the first org where the caller can manage keys (admin-scope owner-only
  // is gated per-org by transfer_ownership-style caps).
  const resetMembership = memberships.find((m) => m.caps.reset_password);
  const keysMembership = memberships.find((m) => m.caps.manage_keys);

  return (
    <div className="space-y-5">
      {resetMembership && (
        <PasswordSessionsCard
          userId={userId}
          membership={resetMembership}
          onOpenReset={() => onOpenReset(resetMembership.org_id)}
        />
      )}
      {keysMembership && <ApiKeysCard userId={userId} membership={keysMembership} />}
    </div>
  );
}

function PasswordSessionsCard({
  userId,
  membership,
  onOpenReset,
}: {
  userId: string;
  membership: PersonMembership;
  onOpenReset: () => void;
}) {
  const orgId = membership.org_id;
  const [confirmForce, setConfirmForce] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [forceSuccess, setForceSuccess] = useState(false);
  const [revokedCount, setRevokedCount] = useState<number | null>(null);
  const [linkStatus, setLinkStatus] = useState<
    { email_sent: boolean; smtp_configured: boolean; expires_in_minutes: number } | null
  >(null);

  // Force-password-change — WIRED to POST /org/members/:userId/force-password-change
  // (the old /b3/people header item was a dead stub; plan §7/§12).
  const forceChange = useMutation({
    mutationFn: () => peopleManagerApi.forcePasswordChange(orgId, userId),
    onSuccess: () => {
      setConfirmForce(false);
      setForceSuccess(true);
      setTimeout(() => setForceSuccess(false), 5000);
    },
  });

  const signOut = useMutation({
    mutationFn: () => peopleManagerApi.signOutEverywhere(orgId, userId),
    onSuccess: (res) => {
      setConfirmSignOut(false);
      setRevokedCount(res.data.revoked);
      setTimeout(() => setRevokedCount(null), 5000);
    },
  });

  const sendLink = useMutation({
    mutationFn: () => peopleManagerApi.sendResetLink(orgId, userId),
    onSuccess: (res) => {
      setLinkStatus({
        email_sent: res.data.email_sent,
        smtp_configured: res.data.smtp_configured,
        expires_in_minutes: res.data.expires_in_minutes,
      });
      setTimeout(() => setLinkStatus(null), 8000);
    },
  });

  return (
    <Card title={`Password & sessions — ${membership.org_name || orgId}`}>
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
      {linkStatus && (
        <div
          className={
            linkStatus.email_sent
              ? 'mb-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200'
              : 'mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200'
          }
        >
          {linkStatus.email_sent ? (
            <>
              Password reset link sent. Expires in {linkStatus.expires_in_minutes} minute
              {linkStatus.expires_in_minutes === 1 ? '' : 's'}.
            </>
          ) : (
            <>
              Token minted, but SMTP is{' '}
              {linkStatus.smtp_configured ? 'misconfigured' : 'not configured'} — no email sent.
              Use "Reset password" to set a password directly.
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onOpenReset}>
          <KeyRound className="h-4 w-4" /> Reset password
        </Button>
        <Button variant="secondary" loading={sendLink.isPending} onClick={() => sendLink.mutate()}>
          <Mail className="h-4 w-4" /> Send password reset link
        </Button>
        <Button variant="secondary" onClick={() => setConfirmForce(true)}>
          <Lock className="h-4 w-4" /> Force password change
        </Button>
        <Button variant="secondary" onClick={() => setConfirmSignOut(true)}>
          <LogOut className="h-4 w-4" /> Sign out everywhere
        </Button>
      </div>

      <Dialog
        open={confirmForce}
        onOpenChange={setConfirmForce}
        title="Force password change"
        description="User will be forced to set a new password on their next login."
      >
        {forceChange.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(forceChange.error as Error)?.message ?? 'Action failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmForce(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={forceChange.isPending} onClick={() => forceChange.mutate()}>
            Force change
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title="Sign out everywhere"
        description="Revoke all active sessions for this user. They will need to log in again on every device."
      >
        {signOut.isError && (
          <p className="text-sm text-red-600 mb-3">
            {(signOut.error as Error)?.message ?? 'Action failed'}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmSignOut(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={signOut.isPending} onClick={() => signOut.mutate()}>
            Sign out everywhere
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function ApiKeysCard({
  userId,
  membership,
}: {
  userId: string;
  membership: PersonMembership;
}) {
  const queryClient = useQueryClient();
  const orgId = membership.org_id;
  // Admin-scope keys are owner-only; transfer_ownership cap is the owner signal.
  const canGrantAdmin = membership.caps.transfer_ownership;
  const [showCreate, setShowCreate] = useState(false);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['people-manager', 'member-keys', orgId, userId],
    queryFn: () => peopleManagerApi.listApiKeys(orgId, userId),
  });
  const keys = data?.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['people-manager', 'member-keys', orgId, userId] });

  const revoke = useMutation({
    mutationFn: (keyId: string) => peopleManagerApi.revokeApiKey(orgId, userId, keyId),
    onSuccess: invalidate,
  });

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            API keys — {membership.org_name || orgId}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Tokens for programmatic access. Shown once at creation.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> Create API key
        </Button>
      </div>

      {isLoading ? (
        <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading…</p>
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
                        k.scope === 'admin' ? 'danger' : k.scope === 'read_write' ? 'info' : 'default'
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
                  <td className="px-4 py-2.5 text-right">
                    {revokeConfirmId === k.id ? (
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400 mr-1">Revoke?</span>
                        <button
                          type="button"
                          onClick={() =>
                            revoke.mutate(k.id, { onSuccess: () => setRevokeConfirmId(null) })
                          }
                          disabled={revoke.isPending}
                          className="rounded-md border border-red-200 dark:border-red-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevokeConfirmId(null)}
                          className="rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
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

      {showCreate && (
        <CreateApiKeyDialog
          orgId={orgId}
          userId={userId}
          canGrantAdmin={canGrantAdmin}
          onClose={() => setShowCreate(false)}
          onCreated={invalidate}
        />
      )}
    </div>
  );
}

function CreateApiKeyDialog({
  orgId,
  userId,
  canGrantAdmin,
  onClose,
  onCreated,
}: {
  orgId: string;
  userId: string;
  canGrantAdmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const scopeOptions = canGrantAdmin
    ? API_KEY_SCOPE_OPTIONS
    : API_KEY_SCOPE_OPTIONS.filter((o) => o.value !== 'admin');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read');
  const [expiresDays, setExpiresDays] = useState<number | ''>('');
  const [token, setToken] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      peopleManagerApi.createApiKey(orgId, userId, {
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
        token ? 'Copy this token now. It will not be shown again.' : 'Create a new API key for this user.'
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
            id="pm-api-key-name"
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
            {!canGrantAdmin && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Admin-scope keys can only be created by an organization owner.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="pm-api-key-expires"
              className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1"
            >
              Expires in (days)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="pm-api-key-expires"
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
          <RevealOnceSecret secret={token} message="Shown only once. Copy it now." />
          <div className="flex items-center justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ─── Activity (per-org) ───────────────────────────────────────────────────────

function formatActionLabel(action: string): string {
  const spaced = action.replace(/\./g, ' ').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const INLINE_DETAIL_KEYS = ['from', 'to', 'status', 'phase', 'title', 'name'];

function ActivityTab({
  userId,
  memberships,
}: {
  userId: string;
  memberships: PersonMembership[];
}) {
  const orgs = memberships.filter((m) => m.caps.manage_projects || m.caps.manage_role);
  const firstOrgId = orgs[0]?.org_id ?? '';
  const [activeOrg, setActiveOrg] = useState<string>(firstOrgId);

  if (orgs.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-6 py-10 text-center text-sm text-zinc-400">
        No org where you can view this person's activity.
      </div>
    );
  }

  const effectiveOrg = activeOrg || firstOrgId;

  return (
    <div className="space-y-4">
      {orgs.length > 1 && (
        <Select
          label="Organization"
          options={orgs.map((m) => ({ value: m.org_id, label: m.org_name || m.org_id }))}
          value={activeOrg}
          onValueChange={setActiveOrg}
          className="w-64"
        />
      )}
      <OrgActivityFeed key={effectiveOrg} orgId={effectiveOrg} userId={userId} />
    </div>
  );
}

function OrgActivityFeed({ orgId, userId }: { orgId: string; userId: string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['people-manager', 'member-activity', orgId, userId, cursor ?? 'first'],
    queryFn: () => peopleManagerApi.getActivity(orgId, userId, { limit: 50, cursor }),
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
        Loading activity…
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
                <time className="text-xs text-zinc-500 shrink-0" title={formatDate(entry.created_at)}>
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
              {hasExtra && (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))}
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
