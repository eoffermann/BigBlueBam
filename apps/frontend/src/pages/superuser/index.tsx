import { useState, useMemo, useEffect } from 'react';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Search, LogIn, Loader2, Users, FolderKanban, ListChecks, TicketIcon, MessageSquare, Building2, UserPlus, TrendingUp, ArrowLeft, Settings, Mail, Download, Globe, Bot, ArrowRight, Plus, Pencil, Trash2, LayoutGrid, PhoneCall } from 'lucide-react';
import { api } from '@/lib/api';
import { exportCsv, todayStamp } from '@/lib/csv';
import type { SuperuserOrgListItem, SuperuserOrgListResponse } from '@bigbluebam/shared';
import { useAuthStore } from '@/stores/auth.store';
import { superuserApi } from '@/lib/api/superuser';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { Dialog } from '@/components/common/dialog';
import { formatRelativeTime } from '@/lib/utils';
import { PermissionsDivergencesPage } from './permissions-divergences';
import { PermissionsGroupsListPage } from './permissions/groups-list';
import { DeploySettingsCard } from '@/components/superuser/deploy-settings-card';

interface SuperuserPageProps {
  onNavigate: (path: string) => void;
}

type Tab = 'overview' | 'organizations' | 'platform' | 'beta-signups' | 'permissions';
type PermissionsSubTab = 'groups' | 'users' | 'divergences';

export function SuperuserPage({ onNavigate }: SuperuserPageProps) {
  const { user } = useAuthStore();
  const [tab, setTab] = useState<Tab>('overview');
  const [permissionsSubTab, setPermissionsSubTab] = useState<PermissionsSubTab>('groups');

  // Guard: only SuperUsers can see this page
  useEffect(() => {
    if (user && user.is_superuser !== true) {
      onNavigate('/');
    }
  }, [user, onNavigate]);

  if (!user || user.is_superuser !== true) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('/')}
              className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-red-100 dark:bg-red-900/30">
              <Shield className="h-4.5 w-4.5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">SuperUser Console</h1>
              <p className="text-xs text-zinc-500">Server-wide administration</p>
            </div>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-6 flex items-center gap-1 border-t border-zinc-100 dark:border-zinc-800">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </TabButton>
          <TabButton active={tab === 'organizations'} onClick={() => setTab('organizations')}>
            Organizations
          </TabButton>
          <TabButton active={tab === 'platform'} onClick={() => setTab('platform')}>
            Platform
          </TabButton>
          <TabButton active={tab === 'beta-signups'} onClick={() => setTab('beta-signups')}>
            Beta Signups
          </TabButton>
          <TabButton active={tab === 'permissions'} onClick={() => setTab('permissions')}>
            Permissions
          </TabButton>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {tab === 'overview' && <OverviewTab onNavigate={onNavigate} />}
        {tab === 'organizations' && <OrganizationsTab onNavigate={onNavigate} />}
        {tab === 'platform' && <PlatformTab />}
        {tab === 'beta-signups' && <BetaSignupsTab />}
        {tab === 'permissions' && (
          <PermissionsTab
            subTab={permissionsSubTab}
            onSubTabChange={setPermissionsSubTab}
            onNavigate={onNavigate}
          />
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ' +
        (active
          ? 'border-primary-600 text-primary-700 dark:text-primary-400'
          : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')
      }
    >
      {children}
    </button>
  );
}

// ─── Permissions Tab (Wave F.2 + F.3) ────────────────────────────────────────
// Three sub-tabs:
//   - Groups: permission-group CRUD + per-group defaults editor (F.2)
//   - Users: per-user effective permissions / overrides (F.3, stub until landed)
//   - Divergences: existing Wave-B shadow-mode telemetry dashboard

function PermissionsTab({
  subTab,
  onSubTabChange,
  onNavigate,
}: {
  subTab: PermissionsSubTab;
  onSubTabChange: (t: PermissionsSubTab) => void;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 self-start">
        <SubTabButton
          active={subTab === 'groups'}
          onClick={() => onSubTabChange('groups')}
        >
          Groups
        </SubTabButton>
        <SubTabButton
          active={subTab === 'users'}
          onClick={() => onSubTabChange('users')}
        >
          Users
        </SubTabButton>
        <SubTabButton
          active={subTab === 'divergences'}
          onClick={() => onSubTabChange('divergences')}
        >
          Divergences
        </SubTabButton>
      </div>

      {subTab === 'groups' && <PermissionsGroupsListPage onNavigate={onNavigate} />}
      {subTab === 'users' && (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            User permissions editor lands in Wave F.3. Use the SuperUser →
            People list for now to view individual user details.
          </p>
        </div>
      )}
      {subTab === 'divergences' && <PermissionsDivergencesPage />}
    </div>
  );
}

function SubTabButton({
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
        'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' +
        (active
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
          : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300')
      }
    >
      {children}
    </button>
  );
}

// ─── Overview Tab ───────────────────────────────────────────────────────────

function OverviewTab({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['superuser', 'overview'],
    queryFn: () => superuserApi.getOverview(),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load overview
      </div>
    );
  }

  const stats: { label: string; value: number; icon: React.ComponentType<{ className?: string }>; accent?: string }[] = [
    { label: 'Organizations', value: data.total_orgs, icon: Building2 },
    { label: 'Users', value: data.total_users, icon: Users },
    { label: 'Active Sessions', value: data.total_active_sessions, icon: TrendingUp },
    { label: 'Projects', value: data.total_projects, icon: FolderKanban },
    { label: 'Tasks', value: data.total_tasks, icon: ListChecks },
    { label: 'Tickets', value: data.total_tickets, icon: TicketIcon },
    { label: 'Banter Channels', value: data.total_banter_channels, icon: MessageSquare },
  ];

  const growth = [
    { label: 'New Users (7d)', value: data.new_users_7d },
    { label: 'New Users (30d)', value: data.new_users_30d },
    { label: 'New Orgs (7d)', value: data.new_orgs_7d },
    { label: 'New Orgs (30d)', value: data.new_orgs_30d },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
          Admin tools
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <AdminToolCard
            icon={Users}
            title="All users"
            description="Search, disable, or promote any user on the server."
            onClick={() => onNavigate('/superuser/people')}
          />
          <AdminToolCard
            icon={Bot}
            title="Agent policies"
            description="Enable or disable agents in the active org. §15 kill switch."
            onClick={() => onNavigate('/superuser/agents')}
          />
          <AdminToolCard
            icon={PhoneCall}
            title="Platform calling"
            description="LiveKit credentials, voice agent URL, and the global calling kill switch."
            onClick={() => onNavigate('/superuser/platform-calling')}
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
          Server Totals
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {stats.map((s) => (
            <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
          <UserPlus className="inline h-4 w-4 mr-1" />
          Recent Growth
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {growth.map((g) => (
            <GrowthCard key={g.label} label={g.label} value={g.value} />
          ))}
        </div>
      </section>
    </div>
  );
}

function AdminToolCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-primary-400 dark:hover:border-primary-600 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary-100 dark:bg-primary-900/30">
          <Icon className="h-4.5 w-4.5 text-primary-600 dark:text-primary-400" />
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-primary-600 group-hover:translate-x-0.5 transition-all" />
      </div>
      <div className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
    </button>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
        <Icon className="h-4 w-4 text-zinc-400" />
      </div>
      <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function GrowthCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-primary-200 dark:border-primary-900/50 bg-primary-50/50 dark:bg-primary-900/10 p-4">
      <div className="text-xs font-medium text-primary-700 dark:text-primary-400 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
        +{value.toLocaleString()}
      </div>
    </div>
  );
}

// ─── Organizations Tab ──────────────────────────────────────────────────────

type OrgDialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; org: SuperuserOrgListItem }
  | { mode: 'delete'; org: SuperuserOrgListItem };

function OrganizationsTab({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<keyof SuperuserOrgListItem>('last_activity_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [dialog, setDialog] = useState<OrgDialogState>({ mode: 'closed' });
  const queryClient = useQueryClient();

  const invalidateOrgs = () =>
    queryClient.invalidateQueries({ queryKey: ['superuser', 'organizations'] });

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery<
    SuperuserOrgListResponse,
    Error
  >({
    queryKey: ['superuser', 'organizations', { search }],
    queryFn: ({ pageParam }) =>
      superuserApi.listOrganizations({
        cursor: pageParam as string | null | undefined,
        search: search || undefined,
        limit: 50,
      }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const rows: SuperuserOrgListItem[] = useMemo(() => {
    const flat = (data?.pages ?? []).flatMap((p) => p.data);
    const sorted = [...flat].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return sorted;
  }, [data, sortKey, sortDir]);

  const switchContext = useMutation({
    mutationFn: (orgId: string) => superuserApi.switchContext(orgId),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      // Refresh the authenticated user so active_org_id updates
      await useAuthStore.getState().fetchMe();
      onNavigate('/');
    },
  });

  const toggleSort = (key: keyof SuperuserOrgListItem) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIndicator = (key: keyof SuperuserOrgListItem) =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none z-10" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or slug..."
            className="pl-9"
          />
        </div>
        <div className="text-xs text-zinc-500">
          {rows.length} {rows.length === 1 ? 'org' : 'orgs'}
        </div>
        <div className="flex-1" />
        <Button onClick={() => setDialog({ mode: 'create' })}>
          <Plus className="h-4 w-4" />
          New organization
        </Button>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">
              <SortHeader onClick={() => toggleSort('name')}>Name{sortIndicator('name')}</SortHeader>
              <SortHeader onClick={() => toggleSort('slug')}>Slug{sortIndicator('slug')}</SortHeader>
              <SortHeader onClick={() => toggleSort('member_count')} align="right">
                Members{sortIndicator('member_count')}
              </SortHeader>
              <SortHeader onClick={() => toggleSort('project_count')} align="right">
                Projects{sortIndicator('project_count')}
              </SortHeader>
              <SortHeader onClick={() => toggleSort('task_count')} align="right">
                Tasks{sortIndicator('task_count')}
              </SortHeader>
              <SortHeader onClick={() => toggleSort('last_activity_at')}>
                Last Activity{sortIndicator('last_activity_at')}
              </SortHeader>
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
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-zinc-500">
                  No organizations found
                </td>
              </tr>
            ) : (
              rows.map((org) => (
                <tr key={org.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                  <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100 font-medium">{org.name}</td>
                  <td className="px-4 py-3 text-zinc-500 font-mono text-xs">{org.slug}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {org.member_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {org.project_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {org.task_count}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">
                    {org.last_activity_at ? formatRelativeTime(org.last_activity_at) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setDialog({ mode: 'edit', org })}
                        title="Rename or change plan"
                        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ mode: 'delete', org })}
                        title="Delete organization"
                        className="rounded-md p-1.5 text-zinc-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-700 dark:hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => switchContext.mutate(org.id)}
                        loading={switchContext.isPending && switchContext.variables === org.id}
                        disabled={switchContext.isPending}
                      >
                        <LogIn className="h-3.5 w-3.5" />
                        Enter
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}

      <OrgDialog
        state={dialog}
        onClose={() => setDialog({ mode: 'closed' })}
        onSuccess={invalidateOrgs}
      />
    </div>
  );
}

function OrgDialog({
  state,
  onClose,
  onSuccess,
}: {
  state: OrgDialogState;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('free');
  const [error, setError] = useState<string | null>(null);

  // Prefill form when dialog opens
  useEffect(() => {
    if (state.mode === 'create') {
      setName('');
      setPlan('free');
      setError(null);
    } else if (state.mode === 'edit') {
      setName(state.org.name);
      setPlan('free'); // list response has no plan; let user re-set if desired
      setError(null);
    } else if (state.mode === 'delete') {
      setError(null);
    }
  }, [state]);

  const createMut = useMutation({
    mutationFn: () => superuserApi.createOrganization({ name: name.trim(), plan: plan.trim() || 'free' }),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateMut = useMutation({
    mutationFn: (id: string) => superuserApi.updateOrganization(id, { name: name.trim(), plan: plan.trim() || 'free' }),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => superuserApi.deleteOrganization(id),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (state.mode === 'closed') {
    return <Dialog open={false} onOpenChange={onClose} title="">{null}</Dialog>;
  }

  if (state.mode === 'delete') {
    const org = state.org;
    return (
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title="Delete organization?"
        description={`This permanently removes "${org.name}" and CASCADE-deletes every user, project, task, and ticket in it.`}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            <div>
              <span className="font-semibold">{org.name}</span>{' '}
              <span className="font-mono text-xs">({org.slug})</span>
            </div>
            <div className="mt-1 text-xs">
              {org.member_count} members · {org.project_count} projects · {org.task_count} tasks
            </div>
          </div>
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={deleteMut.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteMut.mutate(org.id)}
              loading={deleteMut.isPending}
            >
              <Trash2 className="h-4 w-4" />
              Delete organization
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const isEdit = state.mode === 'edit';
  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (isEdit) {
      updateMut.mutate(state.org.id);
    } else {
      createMut.mutate();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={isEdit ? 'Edit organization' : 'New organization'}
      description={
        isEdit
          ? 'Renaming regenerates the slug. Existing URLs with the old slug will break.'
          : 'Creates a new org. You can enter it afterwards via the Enter button.'
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Name
          </label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
            maxLength={255}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Plan
          </label>
          <Input
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            placeholder="free"
            maxLength={50}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Billing plan identifier. Defaults to "free".
          </p>
        </div>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={createMut.isPending || updateMut.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={createMut.isPending || updateMut.isPending}>
            {isEdit ? 'Save changes' : 'Create organization'}
          </Button>
        </div>
      </form>
    </Dialog>
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

// ─── Platform Tab ───────────────────────────────────────────────────────────
// Platform-wide settings: public-signup toggle + root redirect selector.

interface PlatformSettingsResponse {
  data: {
    public_signup_disabled: boolean;
    helpdesk_signup_disabled: boolean;
    updated_at: string | null;
    updated_by: string | null;
  };
}

interface SystemSettingRow {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: string;
}

const ROOT_REDIRECT_OPTIONS = [
  { value: 'site', label: 'Marketing Site (/)' },
  { value: 'b3', label: 'Bam (/b3/)' },
  { value: 'banter', label: 'Banter (/banter/)' },
  { value: 'beacon', label: 'Beacon (/beacon/)' },
  { value: 'brief', label: 'Brief (/brief/)' },
  { value: 'bolt', label: 'Bolt (/bolt/)' },
  { value: 'bearing', label: 'Bearing (/bearing/)' },
  { value: 'board', label: 'Board (/board/)' },
  { value: 'bond', label: 'Bond (/bond/)' },
  { value: 'helpdesk', label: 'Helpdesk (/helpdesk/)' },
];

function PlatformTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['superuser', 'platform-settings'],
    queryFn: () => api.get<PlatformSettingsResponse>('/superuser/platform-settings'),
  });

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api.patch<{
        data: { public_signup_disabled: boolean; helpdesk_signup_disabled: boolean };
      }>('/superuser/platform-settings', { public_signup_disabled: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'platform-settings'] });
    },
  });

  const toggleHelpdesk = useMutation({
    mutationFn: (next: boolean) =>
      api.patch<{
        data: { public_signup_disabled: boolean; helpdesk_signup_disabled: boolean };
      }>('/superuser/platform-settings', { helpdesk_signup_disabled: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superuser', 'platform-settings'] });
    },
  });

  // Root redirect setting
  const { data: redirectData, isLoading: redirectLoading } = useQuery({
    queryKey: ['system-settings', 'root_redirect'],
    queryFn: () => api.get<{ data: SystemSettingRow }>('/system-settings/root_redirect'),
  });

  const updateRedirect = useMutation({
    mutationFn: (value: string) =>
      api.put<{ data: SystemSettingRow }>('/system-settings/root_redirect', { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings', 'root_redirect'] });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  const disabled = data.data.public_signup_disabled;
  const helpdeskDisabled = data.data.helpdesk_signup_disabled;
  const currentRedirect = redirectData?.data?.value as string ?? 'site';

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
            <Settings className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              BigBlueBam signup
            </h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              When disabled, the "Create one" link on the BigBlueBam login
              page sends prospects to a beta-gate and a notify-me form
              instead of the signup page. Existing accounts keep working.
              Helpdesk has a separate switch below — closing internal signup
              no longer blocks customers from filing tickets.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => toggle.mutate(!disabled)}
                disabled={toggle.isPending}
                className={
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
                  (disabled ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-700')
                }
                role="switch"
                aria-checked={disabled}
                aria-label="Disable public signup"
              >
                <span
                  className={
                    'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
                    (disabled ? 'translate-x-5' : 'translate-x-0.5')
                  }
                />
              </button>
              <div className="text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {disabled ? 'Signup disabled' : 'Signup open'}
                </span>
                {data.data.updated_at && (
                  <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                    · last changed {new Date(data.data.updated_at).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            {toggle.isError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                Failed to update: {(toggle.error as Error).message}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
            <Settings className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Helpdesk customer signup
            </h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Independent of BigBlueBam signup above. When disabled, the
              Helpdesk login page hides "Create one" and the
              POST /helpdesk/auth/register endpoint rejects new
              customer self-signup with SIGNUP_DISABLED. Existing
              customer accounts and ticket flow continue to work.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => toggleHelpdesk.mutate(!helpdeskDisabled)}
                disabled={toggleHelpdesk.isPending}
                className={
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
                  (helpdeskDisabled ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-700')
                }
                role="switch"
                aria-checked={helpdeskDisabled}
                aria-label="Disable helpdesk customer signup"
              >
                <span
                  className={
                    'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
                    (helpdeskDisabled ? 'translate-x-5' : 'translate-x-0.5')
                  }
                />
              </button>
              <div className="text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {helpdeskDisabled ? 'Helpdesk signup disabled' : 'Helpdesk signup open'}
                </span>
              </div>
            </div>
            {toggleHelpdesk.isError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                Failed to update: {(toggleHelpdesk.error as Error).message}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
            <Globe className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Domain Root Redirect
            </h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Choose which app loads when users visit the root domain.
              "Marketing Site" serves the landing page; all other options
              redirect visitors to the selected app.
            </p>
            <div className="mt-4 max-w-xs">
              {redirectLoading ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                </div>
              ) : (
                <Select
                  options={ROOT_REDIRECT_OPTIONS}
                  value={currentRedirect}
                  onValueChange={(val) => updateRedirect.mutate(val)}
                  placeholder="Select redirect target..."
                />
              )}
            </div>
            {redirectData?.data?.updated_at && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Last changed {new Date(redirectData.data.updated_at).toLocaleString()}
              </p>
            )}
            {updateRedirect.isError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                Failed to update: {(updateRedirect.error as Error).message}
              </p>
            )}
            {updateRedirect.isSuccess && (
              <p className="mt-2 text-xs text-green-600 dark:text-green-400">
                Saved. Changes take effect immediately for new visitors.
              </p>
            )}
          </div>
        </div>
      </section>

      <LaunchpadDefaultsCard />
      <DeploySettingsCard />
    </div>
  );
}

// ─── Launchpad Defaults (SuperUser) ─────────────────────────────────────────

const LAUNCHPAD_APP_CATALOG: { id: string; name: string; description: string }[] = [
  { id: 'b3', name: 'Bam', description: 'Project Management' },
  { id: 'banter', name: 'Banter', description: 'Team Messaging' },
  { id: 'beacon', name: 'Beacon', description: 'Knowledge Base' },
  { id: 'bond', name: 'Bond', description: 'CRM' },
  { id: 'blast', name: 'Blast', description: 'Email Campaigns' },
  { id: 'bill', name: 'Bill', description: 'Invoicing' },
  { id: 'blank', name: 'Blank', description: 'Forms' },
  { id: 'book', name: 'Book', description: 'Scheduling' },
  { id: 'bench', name: 'Bench', description: 'Analytics' },
  { id: 'brief', name: 'Brief', description: 'Documents' },
  { id: 'bolt', name: 'Bolt', description: 'Automations' },
  { id: 'bearing', name: 'Bearing', description: 'Goals & OKRs' },
  { id: 'board', name: 'Board', description: 'Whiteboards' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support' },
];

function LaunchpadDefaultsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['system-settings', 'launchpad_default_apps'],
    queryFn: async () => {
      try {
        return await api.get<{ data: { value: unknown } }>(
          '/system-settings/launchpad_default_apps',
        );
      } catch {
        // 404 is the expected "no override yet" state — return null sentinel.
        return { data: { value: null } } as { data: { value: unknown } };
      }
    },
  });

  // Decode the stored JSON-string value back into an array (or null).
  const stored: string[] | null = (() => {
    const raw = data?.data?.value;
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as string[]) : null;
      } catch {
        return null;
      }
    }
    return null;
  })();

  // Local edit state. `null` means "all enabled (no override)".
  const [draft, setDraft] = useState<string[] | null>(null);
  useEffect(() => {
    setDraft(stored);
  }, [data]);

  const isOverride = draft !== null;
  const enabledSet = new Set(isOverride ? (draft as string[]) : LAUNCHPAD_APP_CATALOG.map((a) => a.id));

  const save = useMutation({
    mutationFn: (apps: string[] | null) =>
      api.put<{ data: unknown }>('/system-settings/launchpad_default_apps', { value: apps }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings', 'launchpad_default_apps'] });
    },
  });

  const toggleApp = (id: string) => {
    if (!isOverride) {
      // Switching from "all enabled" → explicit list of all minus this one.
      const allMinus = LAUNCHPAD_APP_CATALOG.map((a) => a.id).filter((x) => x !== id);
      setDraft(allMinus);
      return;
    }
    const current = draft as string[];
    if (current.includes(id)) {
      setDraft(current.filter((x) => x !== id));
    } else {
      setDraft([...current, id]);
    }
  };

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
          <LayoutGrid className="h-5 w-5 text-purple-600 dark:text-purple-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Launchpad defaults
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Choose which apps appear in the Launchpad for orgs that have not set their
            own override. Org admins can always narrow this further from their org
            settings; they cannot enable apps you have disabled here.
          </p>

          {isLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="mt-4 flex items-center gap-3 text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Mode:</span>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className={`rounded-md px-2 py-1 text-xs ${
                    !isOverride
                      ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  All enabled (default)
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(stored ?? LAUNCHPAD_APP_CATALOG.map((a) => a.id))}
                  className={`rounded-md px-2 py-1 text-xs ${
                    isOverride
                      ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  Explicit list
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {LAUNCHPAD_APP_CATALOG.map((app) => {
                  const checked = enabledSet.has(app.id);
                  return (
                    <label
                      key={app.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                        checked
                          ? 'border-primary-300 bg-primary-50/50 dark:border-primary-700 dark:bg-primary-900/20'
                          : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                      } ${!isOverride ? 'opacity-60' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!isOverride}
                        onChange={() => toggleApp(app.id)}
                        className="rounded border-zinc-300 dark:border-zinc-700"
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {app.name}
                        </div>
                        <div className="text-[11px] text-zinc-500 truncate">
                          {app.description}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button
                  onClick={() => save.mutate(draft)}
                  loading={save.isPending}
                  disabled={
                    save.isPending ||
                    JSON.stringify(draft ?? null) === JSON.stringify(stored ?? null)
                  }
                >
                  Save changes
                </Button>
                {save.isSuccess && (
                  <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>
                )}
                {save.isError && (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    Failed: {(save.error as Error).message}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Beta Signups Tab ───────────────────────────────────────────────────────

interface BetaSignup {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  ip_address: string | null;
  created_at: string;
}

function BetaSignupsTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['superuser', 'beta-signups'],
    queryFn: () => api.get<{ data: BetaSignup[] }>('/superuser/beta-signups'),
  });

  const rows = data?.data ?? [];

  function handleExport() {
    exportCsv(`beta-signups-${todayStamp()}.csv`, rows, [
      { header: 'Created', value: (r) => r.created_at },
      { header: 'Name', value: (r) => r.name },
      { header: 'Email', value: (r) => r.email },
      { header: 'Phone', value: (r) => r.phone ?? '' },
      { header: 'Message', value: (r) => r.message ?? '' },
      { header: 'IP', value: (r) => r.ip_address ?? '' },
    ]);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load beta signups: {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary-600" /> Notify-me submissions
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
            {rows.length} submission{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No signups yet. Submissions from the notify-me form will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs uppercase text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Submitted</th>
                <th className="px-4 py-2.5 text-left">Name</th>
                <th className="px-4 py-2.5 text-left">Email</th>
                <th className="px-4 py-2.5 text-left">Phone</th>
                <th className="px-4 py-2.5 text-left">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {r.name}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                    <a href={`mailto:${r.email}`} className="text-primary-600 hover:underline">
                      {r.email}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400">
                    {r.phone ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400 max-w-md">
                    {r.message ? (
                      <span className="line-clamp-2" title={r.message}>{r.message}</span>
                    ) : '—'}
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
