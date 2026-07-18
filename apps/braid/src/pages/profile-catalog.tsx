import { useState } from 'react';
import { Search, UserRound, Building2, GitMerge } from 'lucide-react';
import { useProfiles } from '@/hooks/use-braid';
import { cn, formatRelativeTime } from '@/lib/utils';

interface ProfileCatalogPageProps {
  onNavigate: (path: string) => void;
}

function KindBadge({ kind }: { kind: 'person' | 'company' }) {
  const Icon = kind === 'person' ? UserRound : Building2;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      <Icon className="h-3 w-3" />
      {kind === 'person' ? 'Person' : 'Company'}
    </span>
  );
}

function StatusBadge({ status }: { status: 'active' | 'merged_away' | 'archived' }) {
  const styles =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : status === 'merged_away'
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium', styles)}>
      {status === 'active' ? 'Active' : status === 'merged_away' ? 'Merged away' : 'Archived'}
    </span>
  );
}

export function ProfileCatalogPage({ onNavigate }: ProfileCatalogPageProps) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'person' | 'company'>('');
  const [status, setStatus] = useState<'' | 'active' | 'merged_away' | 'archived'>('');

  const { data, isLoading, isError, error } = useProfiles({
    q: q.trim() || undefined,
    kind: kind || undefined,
    status: status || undefined,
    limit: 50,
  });
  const profiles = data?.data ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <GitMerge className="h-6 w-6 text-primary-500" />
            Golden profiles
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            One resolved identity per person or company, consolidated across Bond, Bill, Helpdesk, and
            Book source records.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, phone…"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 pl-8 pr-3 py-1.5 text-sm"
          />
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-3 py-1.5 text-sm"
        >
          <option value="">All kinds</option>
          <option value="person">Person</option>
          <option value="company">Company</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="merged_away">Merged away</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load profiles</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      ) : profiles.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <GitMerge className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No profiles yet</h3>
          <p className="text-sm text-zinc-500 mt-1">
            Profiles are minted automatically as source records resolve, or adjust your filters.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Identities</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr
                  key={profile.id}
                  onClick={() => onNavigate(`/profiles/${profile.id}`)}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-primary-50/50 dark:hover:bg-primary-900/10 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {profile.display_name ?? '(unnamed)'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <KindBadge kind={profile.kind} />
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                    {profile.primary_email ?? profile.primary_phone ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{profile.identity_count}</td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                    {profile.confidence != null ? `${Math.round(profile.confidence * 100)}%` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={profile.status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {formatRelativeTime(profile.updated_at)}
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
