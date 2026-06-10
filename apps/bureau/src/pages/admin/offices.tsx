/**
 * Admin offices page — the index for /admin/offices.
 *
 * One row per type='office' room across every live floor in the org.
 * Each row shows the floor + room name, the current owner (or
 * "Unassigned"), and a reassign action that opens a small searchable
 * people picker. The picker hits Bam's /b3/api/org/members so the
 * candidate list is the active org's members, not whatever is locally
 * cached in the Bureau auth store.
 *
 * Permission gating mirrors floor-list.tsx exactly: org admin/owner or
 * SuperUser. Anyone else gets the same friendly access-denied panel —
 * the API also 403s, but we hide the link in the sidebar and we hide
 * the page contents here so we don't lure a member in just to bounce
 * them off the assign call.
 *
 * Data source: GET /v1/offices (added alongside this page). One round
 * trip; no per-floor fan-out.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Building2,
  Loader2,
  Search,
  Shield,
  UserCircle,
  UserCog,
  X,
} from 'lucide-react';
import { api, BureauApiError, readCsrfToken } from '@/lib/api';
import { useAuthStore, type BureauUser } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}
function canManageOffices(user: BureauUser | null): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return roleLevel(user.role) >= roleLevel('admin');
}

interface OfficeOwner {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
}

interface OfficeRow {
  id: string;
  floor_id: string;
  floor_name: string;
  name: string;
  type: string;
  privacy_default: string;
  owner: OfficeOwner | null;
  updated_at: string;
}

interface OfficeListResponse {
  data: OfficeRow[];
}

interface OrgMember {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  role?: string;
  is_active?: boolean;
}

interface OrgMembersResponse {
  data: OrgMember[];
}

export function AdminOfficesPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pickerOfficeId, setPickerOfficeId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['bureau', 'admin', 'offices'],
    queryFn: async () => {
      const res = await api<OfficeListResponse>('/offices');
      return res.data;
    },
    enabled: canManageOffices(user),
  });

  const assignMutation = useMutation({
    mutationFn: async (input: { room_id: string; user_id: string }) => {
      const res = await api<{ data: { id: string } }>('/offices/assign', {
        method: 'POST',
        body: input,
      });
      return res.data;
    },
    onSuccess: () => {
      setErrorMessage(null);
      setPickerOfficeId(null);
      queryClient.invalidateQueries({ queryKey: ['bureau', 'admin', 'offices'] });
    },
    onError: (err) => {
      const msg = err instanceof BureauApiError ? err.message : String(err);
      setErrorMessage(msg);
    },
  });

  if (!canManageOffices(user)) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-6 flex items-start gap-3">
          <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Office administration requires admin or owner
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
              Ask the org owner to give you the admin role, or follow up via
              your SuperUser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Failed to load offices: {(listQuery.error as Error).message}
          </div>
        </div>
      </div>
    );
  }

  const offices = listQuery.data ?? [];
  const activeOffice = offices.find((o) => o.id === pickerOfficeId) ?? null;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Admin · Offices
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Every personal office across every floor. Reassign the owner with a
            click — the new owner will see this room under <em>My office</em>{' '}
            immediately, and the previous owner loses owner-mode privileges
            (door, knock approvals, etc).
          </p>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300 flex-1">
            {errorMessage}
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-700 dark:text-red-300 hover:opacity-70"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {offices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <Building2 className="mx-auto h-10 w-10 text-zinc-400" />
          <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            No offices yet
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Add some <code>type='office'</code> rooms to a floor in the canvas
            editor and they&apos;ll show up here.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Floor / Office</th>
                <th className="px-4 py-2 text-left font-medium">Owner</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {offices.map((office) => (
                <OfficeRowView
                  key={office.id}
                  office={office}
                  busy={
                    assignMutation.isPending &&
                    assignMutation.variables?.room_id === office.id
                  }
                  onOpenPicker={() => setPickerOfficeId(office.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeOffice && (
        <OwnerPickerDialog
          office={activeOffice}
          onCancel={() => setPickerOfficeId(null)}
          onPick={(member) =>
            assignMutation.mutate({
              room_id: activeOffice.id,
              user_id: member.id,
            })
          }
          busy={assignMutation.isPending}
        />
      )}
    </div>
  );
}

interface OfficeRowViewProps {
  office: OfficeRow;
  busy: boolean;
  onOpenPicker: () => void;
}

function OfficeRowView({ office, busy, onOpenPicker }: OfficeRowViewProps) {
  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {office.name}
            </div>
            <div className="text-xs text-zinc-500 truncate">
              {office.floor_name}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        {office.owner ? (
          <div className="flex items-center gap-2">
            <Avatar
              url={office.owner.avatar_url}
              name={office.owner.display_name}
            />
            <div className="min-w-0">
              <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {office.owner.display_name}
              </div>
              {office.owner.email && (
                <div className="text-xs text-zinc-500 truncate">
                  {office.owner.email}
                </div>
              )}
            </div>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-2 py-0.5">
            <UserCircle className="h-3 w-3" />
            Unassigned
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={onOpenPicker}
          disabled={busy}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700',
            'px-2.5 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300',
            'hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50',
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <UserCog className="h-3 w-3" />
          )}
          Reassign owner
        </button>
      </td>
    </tr>
  );
}

interface OwnerPickerDialogProps {
  office: OfficeRow;
  onCancel: () => void;
  onPick: (member: OrgMember) => void;
  busy: boolean;
}

/**
 * Lightweight searchable people picker. Pulls /b3/api/org/members once
 * and filters client-side; the endpoint doesn't support a server-side
 * ?q= filter (see apps/api/src/routes/org.routes.ts), and for typical
 * org sizes (<= a few hundred members) filtering in the browser is
 * fast enough. The Todo #4 picker can replace this with a shared
 * component when it lands.
 */
function OwnerPickerDialog({
  office,
  onCancel,
  onPick,
  busy,
}: OwnerPickerDialogProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const membersQuery = useQuery({
    queryKey: ['bureau', 'admin', 'org-members'],
    queryFn: async () => {
      const csrf = readCsrfToken();
      const res = await fetch('/b3/api/org/members', {
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': csrf } : undefined,
      });
      if (!res.ok) {
        throw new Error(`Failed to load members (${res.status})`);
      }
      const json = (await res.json()) as OrgMembersResponse;
      return json.data;
    },
    // 30s stale time: this is a per-dialog popover, the data doesn't
    // change minute-to-minute, and the user is going to make exactly
    // one selection.
    staleTime: 30_000,
  });

  const members = membersQuery.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = members.filter((m) => m.is_active !== false);
    if (!q) return pool.slice(0, 20);
    return pool
      .filter(
        (m) =>
          m.display_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [members, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl"
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Reassign {office.name}
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {office.floor_name}
              {office.owner ? (
                <>
                  {' · currently '}
                  <span className="text-zinc-700 dark:text-zinc-300 font-medium">
                    {office.owner.display_name}
                  </span>
                </>
              ) : (
                ' · currently unassigned'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email…"
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
        <div className="border-t border-zinc-200 dark:border-zinc-800 max-h-80 overflow-y-auto">
          {membersQuery.isLoading ? (
            <div className="p-6 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : membersQuery.error ? (
            <div className="p-4 text-sm text-red-600 dark:text-red-400">
              Failed to load members:{' '}
              {(membersQuery.error as Error).message}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">
              No matching members.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.map((m) => {
                const isCurrent = office.owner?.id === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => onPick(m)}
                      disabled={busy || isCurrent}
                      className={cn(
                        'w-full text-left px-5 py-2.5 flex items-center gap-3',
                        'hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                    >
                      <Avatar url={m.avatar_url} name={m.display_name} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {m.display_name}
                        </div>
                        <div className="text-xs text-zinc-500 truncate">
                          {m.email}
                        </div>
                      </div>
                      {isCurrent && (
                        <span className="text-[10px] uppercase tracking-wide font-medium text-zinc-500">
                          Current
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface AvatarProps {
  url: string | null;
  name: string;
}

function Avatar({ url, name }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-7 w-7 rounded-full object-cover shrink-0 bg-zinc-200 dark:bg-zinc-800"
      />
    );
  }
  return (
    <div className="h-7 w-7 rounded-full shrink-0 bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 text-[10px] font-semibold flex items-center justify-center">
      {initials || '?'}
    </div>
  );
}
