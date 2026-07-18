import { useState } from 'react';
import {
  ArrowLeftRight,
  Building2,
  Clock,
  Combine,
  History,
  Loader2,
  Mail,
  Phone,
  Scissors,
  Users,
  UserRound,
} from 'lucide-react';
import {
  useProfile,
  useProfileIdentities,
  useProfileTimeline,
  useProfileDecisions,
  useMergeProfiles,
  useSplitProfile,
} from '@/hooks/use-braid';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

interface ProfileDetailPageProps {
  profileId: string;
  onNavigate: (path: string) => void;
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Users;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800">
        <Icon className="h-4 w-4 text-primary-500" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ProfileDetailPage({ profileId, onNavigate }: ProfileDetailPageProps) {
  const profile = useProfile(profileId);
  const identities = useProfileIdentities(profileId);
  const timeline = useProfileTimeline(profileId);
  const decisions = useProfileDecisions(profileId);
  const mergeProfiles = useMergeProfiles();
  const splitProfile = useSplitProfile(profileId);

  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [selectedIdentityIds, setSelectedIdentityIds] = useState<Set<string>>(new Set());
  const [splitReason, setSplitReason] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  if (profile.isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading profile…
      </div>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-6">
          <h3 className="font-medium text-red-800 dark:text-red-300">Could not load this profile</h3>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">
            {profile.error instanceof Error ? profile.error.message : 'It may have been merged away or deleted.'}
          </p>
        </div>
      </div>
    );
  }

  const p = profile.data.data;
  const KindIcon = p.kind === 'person' ? UserRound : Building2;

  function toggleIdentity(id: string) {
    setSelectedIdentityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400">
              <KindIcon className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                {p.display_name ?? '(unnamed)'}
              </h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {p.primary_email && (
                  <span className="flex items-center gap-1">
                    <Mail className="h-3.5 w-3.5" /> {p.primary_email}
                  </span>
                )}
                {p.primary_phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5" /> {p.primary_phone}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-right text-sm">
            <div className="text-zinc-500 dark:text-zinc-400">
              {p.identity_count} linked {p.identity_count === 1 ? 'identity' : 'identities'}
            </div>
            <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">
              Confidence: {p.confidence != null ? `${Math.round(p.confidence * 100)}%` : 'n/a'}
            </div>
            <div className="text-zinc-400 dark:text-zinc-500 mt-0.5">
              Updated {formatRelativeTime(p.updated_at)}
            </div>
          </div>
        </div>
      </div>

      {actionMessage && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {actionMessage}
        </div>
      )}

      {/* Member identities */}
      <Section title="Member identities" icon={Users}>
        {identities.isLoading ? (
          <div className="text-sm text-zinc-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (identities.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">No visible member identities.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {identities.data!.data.map((identity) => (
              <li key={identity.id} className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={selectedIdentityIds.has(identity.id)}
                  onChange={() => toggleIdentity(identity.id)}
                  className="h-4 w-4"
                />
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                  {identity.source_type}
                </span>
                <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate">{identity.source_id}</span>
                <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
                  {identity.link_kind} · linked {formatRelativeTime(identity.linked_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Cross-app timeline */}
      <Section title="Cross-app timeline" icon={Clock}>
        {timeline.isLoading ? (
          <div className="text-sm text-zinc-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (timeline.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">No visible activity yet.</p>
        ) : (
          <ul className="space-y-2">
            {timeline.data!.data.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 text-sm">
                <span className="text-zinc-400 dark:text-zinc-500 w-24 shrink-0">
                  {formatRelativeTime(entry.occurred_at)}
                </span>
                <span className="text-zinc-700 dark:text-zinc-300">{entry.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Decisions / audit */}
      <Section title="Decisions & audit" icon={History}>
        {decisions.isLoading ? (
          <div className="text-sm text-zinc-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (decisions.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">No merge or split decisions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {decisions.data!.data.map((decision) => (
              <li key={decision.id} className="py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium',
                      decision.kind === 'merge'
                        ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
                        : decision.kind === 'split'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                    )}
                  >
                    {decision.kind}
                  </span>
                  <span className="text-zinc-400 dark:text-zinc-500 text-xs">
                    {formatDate(decision.created_at)}
                  </span>
                  {decision.actor_type && (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">by {decision.actor_type}</span>
                  )}
                </div>
                {decision.reason && (
                  <p className="text-zinc-600 dark:text-zinc-300 mt-1">{decision.reason}</p>
                )}
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  {decision.affected_identity_ids.length} identities affected
                  {decision.absorbed_profile_id ? ` · absorbed ${decision.absorbed_profile_id}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Merge / split actions */}
      <Section title="Merge & split" icon={ArrowLeftRight}>
        <div className="space-y-6">
          {/* Merge with another profile */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2 flex items-center gap-1.5">
              <Combine className="h-3.5 w-3.5" /> Merge with another profile
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Other profile ID</label>
                <input
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value)}
                  placeholder="uuid"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm font-mono w-72"
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Reason (optional)</label>
                <input
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                  placeholder="Confirmed same person"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm w-64"
                />
              </div>
              <button
                type="button"
                disabled={!mergeTarget.trim() || mergeProfiles.isPending}
                onClick={() =>
                  mergeProfiles.mutate(
                    { profile_a_id: p.id, profile_b_id: mergeTarget.trim(), reason: mergeReason.trim() || undefined },
                    {
                      onSuccess: (res) => {
                        setMergeTarget('');
                        setMergeReason('');
                        setActionMessage('Merged. Now viewing the surviving profile.');
                        onNavigate(`/profiles/${res.data.id}`);
                      },
                    },
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              >
                {mergeProfiles.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Combine className="h-4 w-4" />}
                Merge
              </button>
            </div>
            {mergeProfiles.isError && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                {mergeProfiles.error instanceof Error ? mergeProfiles.error.message : 'Merge failed.'}
              </p>
            )}
          </div>

          {/* Split off selected identities */}
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2 flex items-center gap-1.5">
              <Scissors className="h-3.5 w-3.5" /> Split off checked identities
            </h3>
            <p className="text-xs text-zinc-500 mb-2">
              Check identities above that don't belong to this profile, then split them into a fresh
              profile.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col">
                <label className="text-xs text-zinc-500 mb-1">Reason (optional)</label>
                <input
                  value={splitReason}
                  onChange={(e) => setSplitReason(e.target.value)}
                  placeholder="Wrongly merged"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm w-64"
                />
              </div>
              <button
                type="button"
                disabled={selectedIdentityIds.size === 0 || splitProfile.isPending}
                onClick={() =>
                  splitProfile.mutate(
                    { identity_ids: Array.from(selectedIdentityIds), reason: splitReason.trim() || undefined },
                    {
                      onSuccess: () => {
                        setSelectedIdentityIds(new Set());
                        setSplitReason('');
                        setActionMessage('Split complete.');
                      },
                    },
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              >
                {splitProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                Split ({selectedIdentityIds.size})
              </button>
            </div>
            {splitProfile.isError && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                {splitProfile.error instanceof Error ? splitProfile.error.message : 'Split failed.'}
              </p>
            )}
          </div>

          {/* Undo a merge decision */}
          {decisions.data && decisions.data.data.some((d) => d.kind === 'merge') && (
            <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                Undo a past merge
              </h3>
              <div className="flex flex-wrap gap-2">
                {decisions.data.data
                  .filter((d) => d.kind === 'merge')
                  .map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      disabled={splitProfile.isPending}
                      onClick={() =>
                        splitProfile.mutate(
                          { merge_decision_id: d.id, reason: 'Unmerge from profile detail' },
                          { onSuccess: () => setActionMessage('Unmerged successfully.') },
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                    >
                      Undo merge from {formatDate(d.created_at)}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
