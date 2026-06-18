import { Loader2 } from 'lucide-react';
import { Avatar } from '@/components/common/avatar';
import { StatusBadge } from '@/components/goal/StatusBadge';
import { useGoalUpdates, type GoalUpdate } from '@/hooks/useGoals';
import { formatRelativeTime, formatProgress } from '@/lib/utils';

interface UpdateFeedProps {
  goalId: string;
}

function UpdateEntry({ update }: { update: GoalUpdate }) {
  return (
    <div className="flex gap-3 py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <Avatar src={update.author?.avatar_url} name={update.author?.display_name ?? 'Unknown'} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {update.author?.display_name ?? 'Unknown'}
          </span>
          <span className="text-xs text-zinc-400">{formatRelativeTime(update.created_at)}</span>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 whitespace-pre-wrap">{update.body}</p>
        <div className="flex items-center gap-3 mt-2">
          <StatusBadge status={update.status_at_time} />
          <span className="text-xs text-zinc-500">
            {formatProgress(update.progress_at_time)} progress
          </span>
        </div>
      </div>
    </div>
  );
}

export function UpdateFeed({ goalId }: UpdateFeedProps) {
  const { data, isLoading } = useGoalUpdates(goalId);
  const updates = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (updates.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-zinc-400">No updates yet</p>
        <p className="text-xs text-zinc-400 mt-1">Post a status update to keep your team informed.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {updates.map((update) => (
        <UpdateEntry key={update.id} update={update} />
      ))}
    </div>
  );
}
