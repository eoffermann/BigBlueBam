import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { UserPlus, Search, Eye, Download, UserX, UserCheck, Trash2, ChevronDown } from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Select } from '@/components/common/select';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import { Dialog } from '@/components/common/dialog';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/common/dropdown-menu';
import { useAuthStore } from '@/stores/auth.store';
import {
  listPeople,
  peopleManagerApi,
  type ScopedPerson,
  type PersonMembership,
} from '@/lib/api/people-manager';
import { BulkActionBar, useBulkRun } from '@/components/people/bulk-action-bar';
import { formatRelativeTime } from '@/lib/utils';
import { exportCsv, todayStamp, type CsvColumn } from '@/lib/csv';
import { InviteDialog } from './invite-dialog';

interface PeopleManagerPageProps {
  onNavigate: (path: string) => void;
}

/** Roles the bulk "Change role" verb can set (owner is excluded — transfer
 *  ownership is a distinct, owner-only flow; the server also rejects it here). */
const BULK_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'guest', label: 'Guest' },
];

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

const PAGE_LIMIT = 50;

/** Flatten a person's per-org memberships into "Org · role" chips. */
function MembershipChips({ memberships }: { memberships: PersonMembership[] }) {
  if (memberships.length === 0) {
    return <span className="text-zinc-400">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {memberships.map((m) => (
        <span
          key={m.org_id}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-0.5 text-xs"
          title={`${m.org_name} · ${m.role}`}
        >
          <span className="font-medium text-zinc-700 dark:text-zinc-200 truncate max-w-[140px]">
            {m.org_name || m.org_id}
          </span>
          <span className="text-zinc-400 capitalize">{m.role}</span>
        </span>
      ))}
    </div>
  );
}

export function PeopleManagerPage({ onNavigate }: PeopleManagerPageProps) {
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Filters drive the server query params.
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // Org filter: 'all' (every visible org) or a specific org id. A SINGLE org
  // is required to bulk-edit memberships (it pins the X-Org-Id context — see
  // the bulk verbs below).
  const [orgFilter, setOrgFilter] = useState<string>('all');

  // Cursor of the page currently being requested (undefined = first page).
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Accumulated rows across "Load more" pages for the active filter set.
  const [accumulated, setAccumulated] = useState<ScopedPerson[]>([]);

  // Selection state + the shared bulk-run engine (plan §7 / M5).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const bulk = useBulkRun<ScopedPerson>(
    (p) => p.user.id,
    (p) => p.user.display_name || p.user.email,
  );
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);
  // Explicit in-bar org pick, used only when the selection spans several orgs
  // and the roster isn't already filtered to one.
  const [bulkOrgPick, setBulkOrgPick] = useState<string>('');

  const [showInvite, setShowInvite] = useState(false);

  const queryParams = useMemo(
    () => ({
      search: search.trim() || undefined,
      is_active:
        statusFilter === 'active'
          ? true
          : statusFilter === 'disabled'
            ? false
            : undefined,
      role: roleFilter === 'all' ? undefined : roleFilter,
      org_id: orgFilter === 'all' ? undefined : orgFilter,
      limit: PAGE_LIMIT,
    }),
    [search, statusFilter, roleFilter, orgFilter],
  );

  // Stable key for the filter set (excludes cursor). Changing any filter
  // resets paging + accumulation + selection. We use the React-recommended
  // "adjust state during render" pattern (track the previous key) rather than
  // an effect, so the reset is synchronous and there is no stale-page flash.
  const filterKey = JSON.stringify(queryParams);
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setCursor(undefined);
    setAccumulated([]);
    setSelectedIds(new Set());
  }

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['people-manager', 'list', filterKey, cursor ?? null],
    queryFn: () => listPeople({ ...queryParams, cursor }),
    placeholderData: keepPreviousData,
  });

  // Fold each fetched page into the accumulator. First page (no cursor)
  // replaces; subsequent pages append, deduped by user id.
  useEffect(() => {
    if (!data) return;
    if (cursor === undefined) {
      setAccumulated(data.data);
      return;
    }
    setAccumulated((prev) => {
      const seen = new Set(prev.map((p) => p.user.id));
      const merged = prev.slice();
      for (const p of data.data) {
        if (!seen.has(p.user.id)) merged.push(p);
      }
      return merged;
    });
  }, [data, cursor]);

  const people = accumulated;
  const nextCursor = data?.next_cursor ?? null;

  const loadMore = () => {
    if (data?.next_cursor) setCursor(data.next_cursor);
  };

  // Distinct orgs across every loaded row, for the org filter dropdown. We
  // accumulate org_id → name as pages load so the option list grows with the
  // roster. (There is no dedicated "my orgs" list endpoint wired into this
  // page; the loaded memberships are the authoritative visible set.)
  const orgOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const p of people) {
      for (const m of p.memberships) {
        if (!byId.has(m.org_id)) byId.set(m.org_id, m.org_name || m.org_id);
      }
    }
    const opts = Array.from(byId.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: 'all', label: 'All orgs' }, ...opts];
  }, [people]);

  // A single org is selected iff the filter is pinned to one (not 'all'). Only
  // then do we have an unambiguous X-Org-Id for membership-mutation verbs.
  const singleOrgId = orgFilter === 'all' ? null : orgFilter;
  const singleOrgName =
    singleOrgId == null
      ? null
      : (orgOptions.find((o) => o.value === singleOrgId)?.label ?? singleOrgId);

  const selectedPeople = useMemo(
    () => people.filter((p) => selectedIds.has(p.user.id)),
    [people, selectedIds],
  );

  // Org context for the bulk membership verbs. Resolve in order: the roster's
  // pinned Org filter → the single org common to the whole selection → an
  // explicit in-bar pick (shown when the selection spans several orgs). '' when
  // none resolves yet. This makes the verbs usable for the common single-org
  // case WITHOUT first pinning the roster filter (the M5 dead-by-default bug).
  const bulkOrgCandidates = useMemo(() => {
    const byId = new Map<string, string>();
    for (const p of selectedPeople) {
      for (const m of p.memberships) {
        if (!byId.has(m.org_id)) byId.set(m.org_id, m.org_name || m.org_id);
      }
    }
    return Array.from(byId, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [selectedPeople]);
  const effectiveBulkOrg: string =
    singleOrgId ??
    (bulkOrgCandidates.length === 1
      ? (bulkOrgCandidates[0]?.value ?? '')
      : bulkOrgCandidates.some((c) => c.value === bulkOrgPick)
        ? bulkOrgPick
        : '');
  const effectiveBulkOrgName =
    bulkOrgCandidates.find((c) => c.value === effectiveBulkOrg)?.label ??
    singleOrgName ??
    effectiveBulkOrg;

  const clearSelection = () => setSelectedIds(new Set());

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['people-manager', 'list'] });

  /**
   * Find the selected person's membership row in the pinned single org. Used
   * by every membership-mutation verb to read the per-(person,org) `caps`
   * flags. A selected person who is NOT a member of the pinned org has no row
   * here and is skipped ('no-membership').
   */
  const membershipInOrg = (p: ScopedPerson): PersonMembership | undefined =>
    !effectiveBulkOrg ? undefined : p.memberships.find((m) => m.org_id === effectiveBulkOrg);

  /**
   * Fan a membership mutation out across the selected people, scoped to the
   * pinned single org via `peopleManagerApi.*` (which sets X-Org-Id = that
   * org). Each row is skipped unless its membership in that org carries the
   * relevant `caps` flag; self is skipped where the verb forbids it. Skips are
   * counted in the toast tally. The server re-checks rank on every call.
   */
  const runMembershipBulk = (
    label: string,
    action: (orgId: string, p: ScopedPerson) => Promise<unknown>,
    opts: {
      capOf: (m: PersonMembership) => boolean;
      skipSelf?: boolean;
      /** Skip rows that are already in the desired state (no-op). */
      isNoop?: (m: PersonMembership) => boolean;
    },
    onSettled?: () => void,
  ) => {
    const orgId = effectiveBulkOrg || null;
    if (!orgId) return Promise.resolve();
    return bulk.runBulk(
      {
        label,
        targets: selectedPeople,
        action: (p) => action(orgId, p),
        skip: (p) => {
          if (opts.skipSelf && p.user.id === currentUserId) return 'self';
          const m = membershipInOrg(p);
          if (!m) return 'no-membership';
          if (!opts.capOf(m)) return 'caps';
          if (opts.isNoop?.(m)) return 'noop';
          return null;
        },
      },
      onSettled ?? invalidate,
    );
  };

  const bulkSetActive = (isActive: boolean) =>
    // Enable/disable is an account-level toggle gated by the per-org
    // `caps.disable` flag; we don't filter no-ops here because the row only
    // carries account-level `is_active`, not a per-membership state.
    runMembershipBulk(
      isActive ? 'Enabling' : 'Disabling',
      (orgId, p) => peopleManagerApi.setActive(orgId, p.user.id, isActive),
      { capOf: (m: PersonMembership) => m.caps.disable, skipSelf: true },
    );

  const bulkUpdateRole = (role: string) =>
    runMembershipBulk(
      `Changing role to ${role}`,
      (orgId, p) => peopleManagerApi.updateRole(orgId, p.user.id, role),
      {
        capOf: (m) => m.caps.manage_role,
        skipSelf: false,
        isNoop: (m) => m.role === role,
      },
    );

  const bulkRemove = () =>
    runMembershipBulk(
      'Removing from org',
      (orgId, p) => peopleManagerApi.removeFromOrg(orgId, p.user.id),
      { capOf: (m) => m.caps.remove, skipSelf: true },
      () => {
        // Drop removed ids from the selection once the mutations settle.
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const p of selectedPeople) next.delete(p.user.id);
          return next;
        });
        setConfirmBulkRemove(false);
        invalidate();
      },
    );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked = people.length > 0 && people.every((p) => selectedIds.has(p.user.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const p of people) next.delete(p.user.id);
      } else {
        for (const p of people) next.add(p.user.id);
      }
      return next;
    });
  };

  const handleExportCsv = () => {
    const selected = people.filter((p) => selectedIds.has(p.user.id));
    const rows = selected.length > 0 ? selected : people;
    const columns: CsvColumn<ScopedPerson>[] = [
      { header: 'id', value: (r) => r.user.id },
      { header: 'email', value: (r) => r.user.email },
      { header: 'display_name', value: (r) => r.user.display_name },
      { header: 'is_active', value: (r) => r.user.is_active },
      { header: 'last_seen_at', value: (r) => r.user.last_seen_at ?? '' },
      {
        header: 'orgs',
        value: (r) => r.memberships.map((m) => `${m.org_name} (${m.role})`).join('; '),
      },
      { header: 'org_count', value: (r) => r.memberships.length },
    ];
    exportCsv(`people-manager-${todayStamp()}.csv`, rows, columns);
  };

  return (
    <AppLayout
      breadcrumbs={[{ label: 'People Manager' }]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              People Manager
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              Manage people across every organization you can see.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handleExportCsv} disabled={people.length === 0}>
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Button onClick={() => setShowInvite(true)}>
              <UserPlus className="h-4 w-4" />
              Invite
            </Button>
          </div>
        </div>

        <InviteDialog open={showInvite} onOpenChange={setShowInvite} />

        {/* Filters */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md">
            <label
              htmlFor="pm-search"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block"
            >
              Search
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
              <input
                id="pm-search"
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
          <Select
            label="Org"
            options={orgOptions}
            value={orgFilter}
            onValueChange={setOrgFilter}
            className="w-48"
          />
          {selectedIds.size > 0 && (
            <span className="ml-auto inline-flex items-center rounded-full bg-primary-100 dark:bg-primary-900/40 px-2.5 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300 tabular-nums">
              {selectedIds.size} selected
            </span>
          )}
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {isLoading ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-400">Loading people...</p>
          ) : people.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-400">
              No people match the current filters.
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
                        onChange={toggleSelectAll}
                        className="rounded border-zinc-300 dark:border-zinc-700"
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Name</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Email</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Org(s)</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Status</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500">Last seen</th>
                    <th className="px-4 py-2.5 font-medium text-zinc-500 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr
                      key={p.user.id}
                      className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.user.id)}
                          onChange={() => toggleSelect(p.user.id)}
                          className="rounded border-zinc-300 dark:border-zinc-700"
                          aria-label={`Select ${p.user.display_name}`}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => onNavigate(`/people-manager/${p.user.id}`)}
                          className="flex items-center gap-2.5 text-left rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        >
                          <Avatar src={p.user.avatar_url} name={p.user.display_name} size="sm" />
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                            {p.user.display_name || '—'}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {p.user.email}
                      </td>
                      <td className="px-4 py-2.5">
                        <MembershipChips memberships={p.memberships} />
                      </td>
                      <td className="px-4 py-2.5">
                        {p.user.is_active ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="danger">Disabled</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-500">
                        {p.user.last_seen_at ? formatRelativeTime(p.user.last_seen_at) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => onNavigate(`/people-manager/${p.user.id}`)}
                          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Load more */}
        {nextCursor && (
          <div className="flex justify-center">
            <Button variant="secondary" onClick={loadMore} loading={isFetching}>
              Load more
            </Button>
          </div>
        )}
        {!nextCursor && people.length > 0 && (
          <p className="text-center text-xs text-zinc-400">
            {people.length} {people.length === 1 ? 'person' : 'people'} shown · end of list
          </p>
        )}
      </div>

      {/* Floating bulk-action bar + live progress toast (shared primitive). */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        onClear={clearSelection}
        progress={bulk.progress}
        onDismissProgress={bulk.dismiss}
      >
        {(() => {
          // Membership-edit verbs act in ONE org (unambiguous X-Org-Id). The
          // org is resolved from the roster filter, a single common org, or the
          // explicit in-bar pick below. Only genuinely-ambiguous multi-org
          // selections leave the verbs disabled until the operator picks.
          const membershipDisabled = !effectiveBulkOrg;
          const needsPick = !singleOrgId && bulkOrgCandidates.length > 1;
          const membershipTooltip = membershipDisabled
            ? 'Choose which org these membership changes apply to.'
            : `Applies in ${effectiveBulkOrgName}`;
          return (
            <>
              {needsPick && (
                <Select
                  options={[{ value: '', label: 'Apply in org…' }, ...bulkOrgCandidates]}
                  value={bulkOrgPick}
                  onValueChange={setBulkOrgPick}
                  className="w-44"
                />
              )}
              <DropdownMenu
                trigger={
                  <button
                    type="button"
                    disabled={membershipDisabled}
                    title={membershipTooltip}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    Change role
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                }
              >
                {BULK_ROLE_OPTIONS.map((opt) => (
                  <DropdownMenuItem key={opt.value} onSelect={() => bulkUpdateRole(opt.value)}>
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenu>

              <button
                type="button"
                disabled={membershipDisabled}
                title={membershipTooltip}
                onClick={() => bulkSetActive(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <UserX className="h-3.5 w-3.5" />
                Disable
              </button>
              <button
                type="button"
                disabled={membershipDisabled}
                title={membershipTooltip}
                onClick={() => bulkSetActive(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <UserCheck className="h-3.5 w-3.5" />
                Enable
              </button>

              <button
                type="button"
                disabled={membershipDisabled}
                title={membershipTooltip}
                onClick={() => setConfirmBulkRemove(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 dark:border-red-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
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
            </>
          );
        })()}
      </BulkActionBar>

      {/* Bulk remove-from-org confirmation. */}
      <Dialog
        open={confirmBulkRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmBulkRemove(false);
        }}
        title="Remove from organization"
        description={
          effectiveBulkOrg
            ? `Remove ${selectedPeople.length} ${
                selectedPeople.length === 1 ? 'person' : 'people'
              } from ${effectiveBulkOrgName}? People you can't remove (no permission, or not a member of this org) are skipped.`
            : 'Choose which org to remove these people from.'
        }
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmBulkRemove(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={bulkRemove} disabled={!effectiveBulkOrg}>
            Remove
          </Button>
        </div>
      </Dialog>
    </AppLayout>
  );
}
