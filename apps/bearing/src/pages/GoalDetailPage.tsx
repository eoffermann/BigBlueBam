import { useState } from 'react';
import { ArrowLeft, Pencil, MessageSquarePlus, Loader2, MoreVertical, Trash2 } from 'lucide-react';
import { useGoal, useUpdateGoal, useDeleteGoal } from '@/hooks/useGoals';
import { KeyResultList } from '@/components/goal/KeyResultList';
import { ProgressChart } from '@/components/goal/ProgressChart';
import { UpdateFeed } from '@/components/goal/UpdateFeed';
import { PostUpdateDialog } from '@/components/goal/PostUpdateDialog';
import { WatcherList } from '@/components/goal/WatcherList';
import { StatusBadge } from '@/components/goal/StatusBadge';
import { ProgressBar } from '@/components/common/ProgressBar';
import { Avatar } from '@/components/common/avatar';
import { Badge } from '@/components/common/badge';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { TimeRemainingBadge } from '@/components/common/TimeRemainingBadge';
import { formatDate } from '@/lib/utils';
import { useBureauLocationLabel } from '@bigbluebam/bureau-client';

interface GoalDetailPageProps {
  id: string;
  onNavigate: (path: string) => void;
}

export function GoalDetailPage({ id, onNavigate }: GoalDetailPageProps) {
  const { data, isLoading } = useGoal(id);
  const goal = data?.data;
  // Bureau widget context: show the goal title, not the URL path.
  useBureauLocationLabel(goal?.title ?? null);
  const updateMutation = useUpdateGoal();
  const deleteMutation = useDeleteGoal();

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-400">
        <p className="text-lg font-medium">Goal not found</p>
        <Button variant="secondary" className="mt-4" onClick={() => onNavigate('/')}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const startEditing = () => {
    setEditTitle(goal.title);
    setEditDescription(goal.description ?? '');
    setIsEditing(true);
  };

  const saveEdit = () => {
    updateMutation.mutate(
      { id: goal.id, title: editTitle.trim(), description: editDescription.trim() || undefined },
      { onSuccess: () => setIsEditing(false) },
    );
  };

  const handleDelete = () => {
    if (window.confirm(`Delete goal "${goal.title}"? This cannot be undone.`)) {
      deleteMutation.mutate(goal.id, {
        onSuccess: () => onNavigate('/'),
      });
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => onNavigate('/')}
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Dashboard
      </button>

      <div className="flex gap-8">
        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-8">
          {/* Header */}
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {isEditing ? (
                  <div className="space-y-3">
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="text-xl font-bold"
                      autoFocus
                    />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Description..."
                      className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-zinc-100 resize-y min-h-[60px]"
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEdit} loading={updateMutation.isPending}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{goal.title}</h1>
                    {goal.description && (
                      <p className="text-sm text-zinc-500 mt-2">{goal.description}</p>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={goal.status} />
                <DropdownMenu
                  trigger={
                    <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  }
                >
                  <DropdownMenuItem onSelect={startEditing}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={handleDelete}>
                    <Trash2 className="h-4 w-4" />
                    Delete Goal
                  </DropdownMenuItem>
                </DropdownMenu>
              </div>
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-4 flex-wrap">
              {goal.owner ? (
                <div className="flex items-center gap-2">
                  <Avatar src={goal.owner.avatar_url} name={goal.owner.display_name} size="sm" />
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">{goal.owner.display_name}</span>
                </div>
              ) : null}
              <Badge variant="primary">{goal.scope}</Badge>
              {goal.period_name && <Badge>{goal.period_name}</Badge>}
              {goal.project_name && <Badge color="#059669">{goal.project_name}</Badge>}
            </div>

            {/* Progress bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Progress</span>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {Math.round(Number(goal.progress ?? 0))}%{goal.expected_progress != null ? ` (expected: ${Math.round(goal.expected_progress)}%)` : ''}
                </span>
              </div>
              <ProgressBar value={Number(goal.progress ?? 0)} expected={goal.expected_progress ?? 0} size="lg" showLabel={false} />
            </div>
          </div>

          {/* Key Results */}
          <KeyResultList goalId={goal.id} />

          {/* Updates section */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
                Status Updates
              </h3>
              <Button size="sm" variant="secondary" onClick={() => setUpdateDialogOpen(true)}>
                <MessageSquarePlus className="h-3.5 w-3.5" />
                Post Update
              </Button>
            </div>
            <UpdateFeed goalId={goal.id} />
          </div>
        </div>

        {/* Right sidebar */}
        <aside className="w-80 shrink-0 space-y-6">
          {/* Progress chart */}
          <ProgressChart periodId={goal.period_id} />

          {/* Time remaining */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4">
            <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">Period Timeline</h4>
            <TimeRemainingBadge endDate={null} />
            <div className="mt-2 text-xs text-zinc-500">
              Created {formatDate(goal.created_at)}
            </div>
          </div>

          {/* Watchers */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4">
            <WatcherList goalId={goal.id} />
          </div>
        </aside>
      </div>

      {/* Post update dialog */}
      <PostUpdateDialog
        goalId={goal.id}
        currentStatus={goal.status}
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
      />
    </div>
  );
}
