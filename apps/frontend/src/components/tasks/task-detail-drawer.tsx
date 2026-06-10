import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  User,
  Tag,
  Hash,
  MessageSquare,
  CheckSquare,
  Square,
  Plus,
  Send,
  Copy,
  Check,
  Clock,
  Activity,
  Target,
  Flag,
  Layers,
  CopyPlus,
  Trash2,
  Zap,
  Headset,
  Paperclip,
  Download,
  Upload,
  Link2,
  Settings2,
  MessageSquareShare,
  GitCommit,
  GitPullRequest,
  ExternalLink,
} from 'lucide-react';
import type { Task, Priority, ApiResponse, PaginatedResponse } from '@bigbluebam/shared';
import { PRIORITIES } from '@bigbluebam/shared';
import { cn, formatDate, formatRelativeTime, isOverdue } from '@/lib/utils';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { Button } from '@/components/common/button';
import { Badge } from '@/components/common/badge';
import { Avatar } from '@/components/common/avatar';
import { Select } from '@/components/common/select';
import { RichTextEditor } from '@/components/common/rich-text-editor';
import { api } from '@/lib/api';
import { DatePicker } from '@/components/common/date-picker';
import { HelpdeskPanel } from '@/components/tasks/helpdesk-panel';
import {
  useTaskParents,
  useTaskSubtasks,
  useAddTaskParent,
  useRemoveTaskParent,
  type ParentTaskSummary,
} from '@/hooks/use-tasks';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface Member {
  id: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
}

interface CommentReaction {
  emoji: string;
  count: number;
  reacted: boolean;
}

interface CommentData {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  author?: { display_name: string; avatar_url: string | null };
  reactions?: CommentReaction[];
}

const REACTION_EMOJIS = ['\uD83D\uDC4D', '\u2764\uFE0F', '\uD83D\uDE80', '\uD83D\uDC40', '\uD83C\uDF89'];

interface ActivityEntry {
  id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  changes: Record<string, unknown>;
  created_at: string;
  actor?: { display_name: string };
}

interface TimeEntry {
  id: string;
  minutes: number;
  description: string;
  date: string;
  user?: { display_name: string };
  created_at: string;
}

interface Attachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  created_at: string;
}

interface TaskDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: (Task & {
    human_id?: string;
    labels?: { id: string; name: string; color: string }[];
    assignee?: { display_name: string; avatar_url: string | null } | null;
    reporter?: { display_name: string; avatar_url: string | null } | null;
    subtasks?: { id: string; title: string; human_id?: string; state_id: string | null; completed_at: string | null }[];
    state_name?: string;
    phase_name?: string;
  }) | null;
  onUpdate?: (taskId: string, data: Partial<Task>) => void;
  onDelete?: (taskId: string) => void;
  phases?: { id: string; name: string }[];
  projectId?: string;
  states?: { id: string; name: string; category: string }[];
  sprints?: { id: string; name: string }[];
}

export function TaskDetailDrawer({
  open,
  onOpenChange,
  task,
  onUpdate,
  onDelete,
  phases = [],
  projectId,
  states = [],
  sprints = [],
}: TaskDetailDrawerProps) {
  const queryClient = useQueryClient();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [description, setDescription] = useState('');
  const [newComment, setNewComment] = useState('');
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'comments' | 'activity' | 'helpdesk'>('details');
  const [copiedId, setCopiedId] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [showTimeForm, setShowTimeForm] = useState(false);
  const [timeMinutes, setTimeMinutes] = useState('');
  const [timeDate, setTimeDate] = useState(() => new Date().toISOString().split('T')[0]!);
  const [timeDescription, setTimeDescription] = useState('');
  const [showShareBanter, setShowShareBanter] = useState(false);
  const [banterChannelId, setBanterChannelId] = useState('');
  const [banterMessage, setBanterMessage] = useState('');

  const descriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch members for assignee picker
  const { data: membersRes } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get<PaginatedResponse<Member>>(`/projects/${projectId}/members`),
    enabled: !!projectId,
  });
  const members = membersRes?.data ?? [];

  // Fetch epics for epic picker
  const { data: epicsRes } = useQuery({
    queryKey: ['epics', projectId],
    queryFn: () => api.get<PaginatedResponse<{ id: string; name: string; color: string | null }>>(`/projects/${projectId}/epics`),
    enabled: !!projectId && open,
  });
  const epics = epicsRes?.data ?? [];

  const epicOptions = [
    { value: '__none__', label: 'No Epic' },
    ...epics.map((e) => ({ value: e.id, label: e.name })),
  ];

  // Fetch custom field definitions
  const { data: customFieldsRes } = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () =>
      api.get<PaginatedResponse<{
        id: string;
        name: string;
        field_type: string;
        is_required: boolean;
        is_visible_on_card: boolean;
        options?: { label: string; color: string }[];
      }>>(`/projects/${projectId}/custom-fields`),
    enabled: !!projectId && open,
  });
  const customFieldDefs = customFieldsRes?.data ?? [];

  // Fetch comments
  const { data: commentsRes } = useQuery({
    queryKey: ['task-comments', task?.id],
    queryFn: () => api.get<PaginatedResponse<CommentData>>(`/tasks/${task!.id}/comments`),
    enabled: !!task?.id && open,
  });
  const comments = commentsRes?.data ?? [];

  // Fetch activity
  const { data: activityRes } = useQuery({
    queryKey: ['task-activity', task?.id],
    queryFn: () => api.get<PaginatedResponse<ActivityEntry>>(`/tasks/${task!.id}/activity`),
    enabled: !!task?.id && open && activeTab === 'activity',
  });
  const activities = activityRes?.data ?? [];

  // Post comment mutation
  const postComment = useMutation({
    mutationFn: (body: string) =>
      api.post<ApiResponse<CommentData>>(`/tasks/${task!.id}/comments`, { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-comments', task?.id] });
      setNewComment('');
    },
  });

  // Create subtask mutation
  const createSubtask = useMutation({
    mutationFn: (title: string) =>
      api.post<ApiResponse<Task>>(`/projects/${projectId}/tasks`, {
        title,
        parent_task_id: task!.id,
        phase_id: task!.phase_id,
        priority: 'medium' as Priority,
        sprint_id: task!.sprint_id,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', task?.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'subtasks', task?.id] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      setNewSubtaskTitle('');
    },
  });

  // Duplicate task mutation
  const duplicateTask = useMutation({
    mutationFn: () =>
      api.post<ApiResponse<Task>>(`/tasks/${task!.id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  // Toggle reaction mutation
  const toggleReaction = useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: string; emoji: string }) =>
      api.post(`/comments/${commentId}/reactions`, { emoji }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-comments', task?.id] });
    },
  });

  // Fetch time entries
  const { data: timeEntriesRes } = useQuery({
    queryKey: ['task-time-entries', task?.id],
    queryFn: () => api.get<{ data: TimeEntry[] }>(`/tasks/${task!.id}/time-entries`),
    enabled: !!task?.id && open,
  });
  const timeEntries = timeEntriesRes?.data ?? [];
  const totalMinutesLogged = timeEntries.reduce((sum, e) => sum + e.minutes, 0);

  // Create time entry mutation
  const createTimeEntry = useMutation({
    mutationFn: (data: { minutes: number; date: string; description: string }) =>
      api.post(`/tasks/${task!.id}/time-entries`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-time-entries', task?.id] });
      setShowTimeForm(false);
      setTimeMinutes('');
      setTimeDate(new Date().toISOString().split('T')[0]!);
      setTimeDescription('');
    },
  });

  // Fetch attachments
  const { data: attachmentsRes } = useQuery({
    queryKey: ['task-attachments', task?.id],
    queryFn: () => api.get<{ data: Attachment[] }>(`/tasks/${task!.id}/attachments`),
    enabled: !!task?.id && open,
  });
  const attachments = attachmentsRes?.data ?? [];

  // Fetch GitHub refs (commits + PRs linked to this task)
  interface GithubRef {
    id: string;
    ref_type: 'commit' | 'pull_request';
    ref_id: string;
    ref_url: string;
    ref_title: string | null;
    author_name: string | null;
    status: string | null;
    created_at: string;
  }
  const { data: githubRefsRes } = useQuery({
    queryKey: ['task-github-refs', task?.id],
    queryFn: () => api.get<{ data: GithubRef[] }>(`/tasks/${task!.id}/github-refs`),
    enabled: !!task?.id && open,
  });
  const githubRefs = githubRefsRes?.data ?? [];

  // Upload and attach file
  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await api.upload<{ data: { url: string; filename: string; size: number } }>('/upload', formData);
      const uploadData = uploadRes.data ?? (uploadRes as unknown as { url: string; filename: string; size: number });
      return api.post(`/tasks/${task!.id}/attachments`, {
        url: uploadData.url,
        filename: uploadData.filename ?? file.name,
        size: uploadData.size ?? file.size,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-attachments', task?.id] });
    },
  });

  // Delete attachment
  const deleteAttachment = useMutation({
    mutationFn: (id: string) => api.delete(`/attachments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-attachments', task?.id] });
    },
  });

  // Banter channels for "Share to Banter"
  const { data: banterChannelsRes } = useQuery({
    queryKey: ['banter-channels'],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>('/banter/api/v1/channels'),
    enabled: showShareBanter,
  });
  const banterChannels = banterChannelsRes?.data ?? [];

  // Share to Banter mutation
  const shareToBanter = useMutation({
    mutationFn: (channelId: string) => {
      const humanIdStr = task?.human_id ?? '';
      const descPreview = (task?.description ?? '').slice(0, 120);
      return api.post(`/banter/api/v1/channels/${channelId}/messages`, {
        content: `Shared from BigBlueBam: **${humanIdStr} — ${task?.title}**\n\n> ${descPreview}${(task?.description ?? '').length > 120 ? '...' : ''}\n\n[Open in BigBlueBam →](/b3/projects/${projectId}/board)`,
        metadata: {
          bbb_entity: {
            type: 'task',
            id: task?.id,
            human_id: humanIdStr,
            title: task?.title,
          },
        },
      });
    },
    onSuccess: () => {
      setShowShareBanter(false);
      setBanterChannelId('');
      setBanterMessage('');
    },
  });

  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen && task) {
      setTitleValue(task.title);
      setDescription(task.description ?? '');
      setActiveTab('details');
      setIsEditingDescription(false);
    }
    onOpenChange(isOpen);
  };

  useEffect(() => {
    if (task && open) {
      setTitleValue(task.title);
      setDescription(task.description ?? '');
    }
  }, [task?.id, open]);

  const handleTitleSave = () => {
    if (task && titleValue.trim() && titleValue !== task.title) {
      onUpdate?.(task.id, { title: titleValue.trim() });
    }
    setEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSave();
    } else if (e.key === 'Escape') {
      setTitleValue(task?.title ?? '');
      setEditingTitle(false);
    }
  };

  const handleDescriptionChange = (value: string) => {
    setDescription(value);
    if (descriptionTimerRef.current) {
      clearTimeout(descriptionTimerRef.current);
    }
    descriptionTimerRef.current = setTimeout(() => {
      if (task && value !== (task.description ?? '')) {
        onUpdate?.(task.id, { description: value });
      }
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (descriptionTimerRef.current) {
        clearTimeout(descriptionTimerRef.current);
      }
    };
  }, []);

  const handleCopyHumanId = useCallback(() => {
    if (!task) return;
    const humanId = task.human_id ?? `#${(task as Task & { task_number?: number }).task_number ?? ''}`;
    navigator.clipboard.writeText(humanId).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  }, [task]);

  const handlePostComment = () => {
    if (!newComment.trim() || !task) return;
    postComment.mutate(newComment.trim());
  };

  const handleAddSubtask = () => {
    if (!newSubtaskTitle.trim() || !task || !projectId) return;
    createSubtask.mutate(newSubtaskTitle.trim());
  };

  const handleToggleSubtask = (subtask: { id: string; completed_at: string | null }) => {
    // Toggle between done state and re-opening
    const doneState = states.find((s) => s.category === 'done');
    const todoState = states.find((s) => s.category === 'todo');
    if (subtask.completed_at) {
      // Re-open: set to todo state
      if (todoState) {
        onUpdate?.(subtask.id, { state_id: todoState.id } as Partial<Task>);
      }
    } else {
      // Mark done
      if (doneState) {
        onUpdate?.(subtask.id, { state_id: doneState.id } as Partial<Task>);
      }
    }
  };

  const priorityOptions = PRIORITIES.map((p) => ({
    value: p,
    label: p.charAt(0).toUpperCase() + p.slice(1),
  }));

  const phaseOptions = phases.map((p) => ({ value: p.id, label: p.name }));

  const stateOptions = states.map((s) => ({ value: s.id, label: s.name }));

  const sprintOptions = [
    { value: '__none__', label: 'No Sprint' },
    ...sprints.map((s) => ({ value: s.id, label: s.name })),
  ];

  const memberOptions = [
    { value: '__none__', label: 'Unassigned' },
    ...members.map((m) => ({ value: m.id, label: m.display_name })),
  ];

  // Subtasks come from the dedicated /tasks/:id/subtasks endpoint, which
  // unions the legacy parent_task_id self-FK with the many-to-many
  // task_parent_links join table. The previously-embedded task.subtasks
  // field on the Task type was never actually populated by the API, which
  // is why this section silently showed nothing until B3 Frndo Launch.
  // NOTE: this hook MUST live above the `if (!task) return null` early-exit
  // below so the hook order stays consistent across renders.
  const subtasksQuery = useTaskSubtasks(task?.id);

  if (!task) return null;

  const humanId = task.human_id ?? `#${(task as Task & { task_number?: number }).task_number ?? ''}`;
  const overdue = isOverdue(task.due_date);

  const subtasks = subtasksQuery.data?.data ?? [];
  const doneSubtasks = subtasks.filter((s) => s.completed_at != null);
  const subtaskProgress = subtasks.length > 0 ? Math.round((doneSubtasks.length / subtasks.length) * 100) : 0;

  return (
    <RadixDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 bg-black/30 z-40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild>
              <motion.div
                className="fixed top-0 right-0 h-full w-full max-w-3xl bg-white dark:bg-zinc-900 shadow-2xl z-50 flex flex-col"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCopyHumanId}
                      className="flex items-center gap-1.5 text-sm font-mono text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
                      title="Copy task ID"
                      aria-label={`Copy task ID ${humanId}`}
                    >
                      {humanId}
                      {copiedId ? (
                        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>
                    {stateOptions.length > 0 ? (
                      <Select
                        options={stateOptions}
                        value={task.state_id ?? undefined}
                        onValueChange={(val) => onUpdate?.(task.id, { state_id: val })}
                        placeholder="State"
                        className="w-36"
                      />
                    ) : (
                      <Badge variant="default">{task.state_name ?? 'Unknown'}</Badge>
                    )}
                    <Select
                      options={priorityOptions}
                      value={task.priority}
                      onValueChange={(val) => onUpdate?.(task.id, { priority: val as Priority })}
                      placeholder="Priority"
                      className="w-32"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <PresenceChipStrip
                      url={`${window.location.origin}${window.location.pathname}`}
                      surfaceApp="bam"
                      surfaceId={task.id}
                      surfaceLabel={task.title}
                    />
                    <div className="relative">
                      <button
                        onClick={() => setShowShareBanter((v) => !v)}
                        className="rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        title="Share to Banter"
                        aria-label="Share to Banter"
                        aria-haspopup="dialog"
                        aria-expanded={showShareBanter}
                      >
                        <MessageSquareShare className="h-4.5 w-4.5" aria-hidden="true" />
                      </button>
                      {showShareBanter && (
                        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl border border-zinc-200 bg-white shadow-xl dark:bg-zinc-800 dark:border-zinc-700 p-4 space-y-3">
                          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Share to Banter</h4>
                          <div>
                            <label htmlFor="share-banter-channel" className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">Channel</label>
                            <select
                              id="share-banter-channel"
                              value={banterChannelId}
                              onChange={(e) => setBanterChannelId(e.target.value)}
                              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:bg-zinc-700 dark:border-zinc-600 dark:text-zinc-100"
                            >
                              <option value="">Select a channel...</option>
                              {banterChannels.map((ch) => (
                                <option key={ch.id} value={ch.id}>#{ch.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label htmlFor="share-banter-message" className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">Message (optional)</label>
                            <textarea
                              id="share-banter-message"
                              value={banterMessage}
                              onChange={(e) => setBanterMessage(e.target.value)}
                              placeholder="Add a note..."
                              rows={2}
                              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm resize-none dark:bg-zinc-700 dark:border-zinc-600 dark:text-zinc-100"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setShowShareBanter(false)}
                              className="px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => banterChannelId && shareToBanter.mutate(banterChannelId)}
                              disabled={!banterChannelId || shareToBanter.isPending}
                              className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                            >
                              {shareToBanter.isPending ? 'Sharing...' : 'Share'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => duplicateTask.mutate()}
                      disabled={duplicateTask.isPending}
                      className="rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
                      title="Duplicate task"
                      aria-label="Duplicate task"
                    >
                      <CopyPlus className="h-4.5 w-4.5" aria-hidden="true" />
                    </button>
                    <RadixDialog.Close
                      aria-label="Close task details"
                      className="rounded-md p-1.5 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      <X className="h-5 w-5" aria-hidden="true" />
                    </RadixDialog.Close>
                  </div>
                </div>

                <RadixDialog.Title className="sr-only">{task.title}</RadixDialog.Title>
                <RadixDialog.Description className="sr-only">Task detail view for {humanId}</RadixDialog.Description>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                  <div className="flex gap-6 p-6">
                    {/* Main content */}
                    <div className="flex-1 min-w-0 space-y-6">
                      {/* Inline editable title */}
                      {editingTitle ? (
                        <input
                          className="w-full text-xl font-semibold bg-transparent border-b-2 border-primary-500 outline-none text-zinc-900 dark:text-zinc-100"
                          value={titleValue}
                          onChange={(e) => setTitleValue(e.target.value)}
                          onBlur={handleTitleSave}
                          onKeyDown={handleTitleKeyDown}
                          autoFocus
                        />
                      ) : (
                        <h2
                          className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 cursor-pointer hover:text-primary-600 transition-colors"
                          onClick={() => {
                            setTitleValue(task.title);
                            setEditingTitle(true);
                          }}
                        >
                          {task.title}
                        </h2>
                      )}

                      {/* Tabs */}
                      <div className="flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
                        {(['details', 'comments', 'activity'] as const).map((tab) => (
                          <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={cn(
                              'px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px flex items-center gap-1.5',
                              activeTab === tab
                                ? 'border-primary-600 text-primary-600'
                                : 'border-transparent text-zinc-500 hover:text-zinc-700',
                            )}
                          >
                            {tab === 'details' && <Layers className="h-3.5 w-3.5" />}
                            {tab === 'comments' && <MessageSquare className="h-3.5 w-3.5" />}
                            {tab === 'activity' && <Activity className="h-3.5 w-3.5" />}
                            {tab.charAt(0).toUpperCase() + tab.slice(1)}
                            {tab === 'comments' && comments.length > 0 && (
                              <span className="text-xs bg-zinc-200 dark:bg-zinc-700 rounded-full px-1.5">
                                {comments.length}
                              </span>
                            )}
                          </button>
                        ))}
                        {Boolean(task.custom_fields?.helpdesk_ticket_id) && (
                          <button
                            onClick={() => setActiveTab('helpdesk')}
                            className={cn(
                              'px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px flex items-center gap-1.5',
                              activeTab === 'helpdesk'
                                ? 'border-primary-600 text-primary-600'
                                : 'border-transparent text-zinc-500 hover:text-zinc-700',
                            )}
                          >
                            <Headset className="h-3.5 w-3.5" /> Helpdesk
                          </button>
                        )}
                      </div>

                      {/* Details Tab */}
                      {activeTab === 'details' && (
                        <div className="space-y-5">
                          {/* Description */}
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <label className="text-sm font-medium text-zinc-500">Description</label>
                              {!isEditingDescription && (
                                <button
                                  onClick={() => setIsEditingDescription(true)}
                                  className="text-xs text-primary-600 hover:text-primary-700"
                                >
                                  Edit
                                </button>
                              )}
                            </div>
                            {isEditingDescription ? (
                              <div className="space-y-2">
                                <RichTextEditor
                                  value={description}
                                  onChange={handleDescriptionChange}
                                  placeholder="Add a description..."
                                  minRows={5}
                                  defaultPreview={false}
                                  onImageUpload={async (file) => {
                                    const formData = new FormData();
                                    formData.append('file', file);
                                    const res = await api.upload<{ url: string }>('/upload', formData);
                                    return res.url ?? (res as unknown as { data: { url: string } }).data?.url ?? '';
                                  }}
                                />
                                <button
                                  onClick={() => setIsEditingDescription(false)}
                                  className="text-xs text-zinc-500 hover:text-zinc-700"
                                >
                                  Done editing
                                </button>
                              </div>
                            ) : description?.trim() ? (
                              <div
                                className="rich-text-content text-sm text-zinc-800 dark:text-zinc-200 cursor-pointer rounded-lg border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 p-2 -m-2 transition-colors"
                                onClick={() => setIsEditingDescription(true)}
                                dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdownToHtml(description)) }}
                              />
                            ) : (
                              <button
                                onClick={() => setIsEditingDescription(true)}
                                className="text-sm text-zinc-400 hover:text-zinc-600 py-2"
                              >
                                Click to add a description...
                              </button>
                            )}
                          </div>

                          {/* Parent tasks (B3 Frndo Launch). Many-to-many:
                              a task can have multiple parents because more
                              than one parent might depend on the same shared
                              work. Listed read-only here as chips with a
                              remove button; an inline picker below lets the
                              user attach an additional parent by ID. */}
                          <ParentTasksSection
                            taskId={task.id}
                            projectId={projectId}
                          />

                          {/* Subtasks */}
                          <div>
                            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
                              <CheckSquare className="h-4 w-4" />
                              Subtasks
                              {subtasks.length > 0 && (
                                <span className="text-zinc-400">
                                  ({doneSubtasks.length}/{subtasks.length})
                                </span>
                              )}
                            </h3>

                            {subtasks.length > 0 && (
                              <>
                                <div className="w-full h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden mb-3">
                                  <div
                                    className="h-full rounded-full bg-primary-500 transition-all duration-300"
                                    style={{ width: `${subtaskProgress}%` }}
                                  />
                                </div>
                                <div className="space-y-1 mb-3">
                                  {subtasks.map((sub) => {
                                    const isDone = sub.completed_at != null;
                                    return (
                                      <div
                                        key={sub.id}
                                        className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                                        onClick={() => handleToggleSubtask(sub)}
                                      >
                                        {isDone ? (
                                          <CheckSquare className="h-4 w-4 text-primary-600 shrink-0" />
                                        ) : (
                                          <Square className="h-4 w-4 text-zinc-400 shrink-0" />
                                        )}
                                        <span className={cn('text-sm flex-1', isDone && 'line-through text-zinc-400')}>
                                          {sub.human_id && (
                                            <span className="font-mono text-xs text-zinc-400 mr-1.5">{sub.human_id}</span>
                                          )}
                                          {sub.title}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            )}

                            {/* Add subtask input */}
                            {projectId && (
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  placeholder="Add a subtask..."
                                  value={newSubtaskTitle}
                                  onChange={(e) => setNewSubtaskTitle(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddSubtask();
                                  }}
                                  className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                                />
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={!newSubtaskTitle.trim()}
                                  loading={createSubtask.isPending}
                                  onClick={handleAddSubtask}
                                >
                                  <Plus className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>

                          {/* Labels */}
                          {task.labels && (task.labels as unknown as { id: string; name: string; color: string }[]).length > 0 && (
                            <div>
                              <h3 className="text-sm font-medium text-zinc-500 mb-1.5">Labels</h3>
                              <div className="flex flex-wrap gap-1.5">
                                {(task.labels as unknown as { id: string; name: string; color: string }[]).map((label) => (
                                  <Badge key={label.id} variant="custom" color={label.color}>
                                    {label.name}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Attachments */}
                          <div>
                            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
                              <Paperclip className="h-4 w-4" />
                              Attachments
                              {attachments.length > 0 && (
                                <span className="text-zinc-400">({attachments.length})</span>
                              )}
                            </h3>
                            <label className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm text-zinc-500 hover:border-primary-400 hover:text-primary-600 cursor-pointer transition-colors mb-3">
                              <Upload className="h-4 w-4" />
                              Upload File
                              <input
                                type="file"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) uploadAttachment.mutate(file);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                            {uploadAttachment.isPending && (
                              <p className="text-xs text-zinc-400 mb-2">Uploading...</p>
                            )}
                            {attachments.length > 0 && (
                              <div className="space-y-2">
                                {attachments.map((att) => (
                                  <div
                                    key={att.id}
                                    className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                                  >
                                    <Paperclip className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm text-zinc-700 dark:text-zinc-300 truncate">{att.filename}</p>
                                      <p className="text-xs text-zinc-400">
                                        {att.size > 1048576
                                          ? `${(att.size / 1048576).toFixed(1)} MB`
                                          : `${Math.round(att.size / 1024)} KB`}
                                        {' '}&middot; {formatDate(att.created_at)}
                                      </p>
                                    </div>
                                    <a
                                      href={att.url}
                                      download={att.filename}
                                      className="p-1 rounded text-zinc-500 hover:text-primary-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                                      title="Download"
                                      aria-label={`Download ${att.filename}`}
                                    >
                                      <Download className="h-4 w-4" aria-hidden="true" />
                                    </a>
                                    <button
                                      onClick={() => deleteAttachment.mutate(att.id)}
                                      className="p-1 rounded text-zinc-500 hover:text-red-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                                      title="Delete attachment"
                                      aria-label={`Delete attachment ${att.filename}`}
                                    >
                                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* GitHub refs */}
                          {githubRefs.length > 0 && (
                            <div>
                              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
                                <GitPullRequest className="h-4 w-4" />
                                Linked
                                <span className="text-zinc-400">({githubRefs.length})</span>
                              </h3>
                              <div className="space-y-2">
                                {githubRefs.map((ref) => {
                                  const isCommit = ref.ref_type === 'commit';
                                  const statusColor =
                                    ref.status === 'merged'
                                      ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                                      : ref.status === 'closed'
                                        ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                                        : 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300';
                                  return (
                                    <div
                                      key={ref.id}
                                      className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                                    >
                                      {isCommit ? (
                                        <GitCommit className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                      ) : (
                                        <GitPullRequest className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                      )}
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm text-zinc-700 dark:text-zinc-300 truncate">
                                          {ref.ref_title ?? (isCommit ? ref.ref_id.slice(0, 7) : `#${ref.ref_id}`)}
                                        </p>
                                        <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                                          {isCommit ? (
                                            <span className="font-mono">{ref.ref_id.slice(0, 7)}</span>
                                          ) : (
                                            <span>#{ref.ref_id}</span>
                                          )}
                                          {ref.author_name && <span>&middot; {ref.author_name}</span>}
                                          {!isCommit && ref.status && (
                                            <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium capitalize', statusColor)}>
                                              {ref.status}
                                            </span>
                                          )}
                                        </p>
                                      </div>
                                      <a
                                        href={ref.ref_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1 rounded text-zinc-500 hover:text-primary-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                                        title="View on GitHub"
                                        aria-label="View on GitHub (opens in new tab)"
                                      >
                                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                                      </a>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Banter mentions */}
                          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                              <MessageSquareShare className="h-4 w-4 shrink-0" />
                              <span>
                                Referenced in Banter:{' '}
                                <a
                                  href={`/banter/search?q=${encodeURIComponent(humanId)}`}
                                  className="text-primary-600 hover:text-primary-700 hover:underline transition-colors"
                                >
                                  Search for mentions &rarr;
                                </a>
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Comments Tab */}
                      {activeTab === 'comments' && (
                        <div className="space-y-4">
                          {comments.length > 0 ? (
                            comments.map((comment) => (
                              <div key={comment.id} className="group flex gap-3">
                                <Avatar
                                  src={comment.author?.avatar_url}
                                  name={comment.author?.display_name}
                                  size="sm"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                      {comment.author?.display_name ?? 'Unknown'}
                                    </span>
                                    <span className="text-xs text-zinc-400">
                                      {formatRelativeTime(comment.created_at)}
                                    </span>
                                  </div>
                                  <div
                                    className="rich-text-content text-sm text-zinc-700 dark:text-zinc-300"
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdownToHtml(comment.body)) }}
                                  />
                                  {/* Reactions */}
                                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                                    {(comment.reactions ?? []).map((r) => (
                                      <button
                                        key={r.emoji}
                                        onClick={() =>
                                          toggleReaction.mutate({ commentId: comment.id, emoji: r.emoji })
                                        }
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border transition-colors',
                                          r.reacted
                                            ? 'bg-primary-50 border-primary-200 dark:bg-zinc-800 dark:border-primary-800'
                                            : 'bg-zinc-50 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700',
                                        )}
                                      >
                                        <span>{r.emoji}</span>
                                        <span className="text-zinc-600 dark:text-zinc-400">{r.count}</span>
                                      </button>
                                    ))}
                                    {/* Add reaction buttons */}
                                    <div className="flex items-center gap-0.5 ml-1">
                                      {REACTION_EMOJIS.filter(
                                        (e) => !(comment.reactions ?? []).some((r) => r.emoji === e),
                                      ).map((emoji) => (
                                        <button
                                          key={emoji}
                                          onClick={() =>
                                            toggleReaction.mutate({ commentId: comment.id, emoji })
                                          }
                                          className="opacity-40 hover:opacity-100 rounded p-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:opacity-100"
                                          title={`React with ${emoji}`}
                                          aria-label={`React with ${emoji}`}
                                        >
                                          {emoji}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-zinc-400 py-4">No comments yet. Start a conversation.</p>
                          )}

                          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
                            <RichTextEditor
                              value={newComment}
                              onChange={setNewComment}
                              placeholder="Write a comment..."
                              minRows={2}
                              compact
                              onImageUpload={async (file) => {
                                const formData = new FormData();
                                formData.append('file', file);
                                const res = await api.upload<{ url: string }>('/upload', formData);
                                return res.url ?? (res as unknown as { data: { url: string } }).data?.url ?? '';
                              }}
                            />
                          </div>
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              disabled={!newComment.trim()}
                              loading={postComment.isPending}
                              onClick={handlePostComment}
                            >
                              <Send className="h-4 w-4" />
                              Comment
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Activity Tab */}
                      {activeTab === 'activity' && (
                        <div className="space-y-3">
                          {activities.length > 0 ? (
                            activities.map((entry) => (
                              <div key={entry.id} className="flex items-start gap-3 py-2">
                                <div className="mt-0.5 h-6 w-6 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                                  <Activity className="h-3 w-3 text-zinc-400" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                                    <span className="font-medium">
                                      {entry.actor?.display_name ?? 'Someone'}
                                    </span>{' '}
                                    {entry.action}
                                  </p>
                                  <span className="text-xs text-zinc-400">
                                    {formatRelativeTime(entry.created_at)}
                                  </span>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-zinc-400 py-4">No activity recorded yet.</p>
                          )}
                        </div>
                      )}

                      {/* Helpdesk Tab */}
                      {activeTab === 'helpdesk' && Boolean(task.custom_fields?.helpdesk_ticket_id) && (
                        <HelpdeskPanel ticketId={task.custom_fields.helpdesk_ticket_id as string} />
                      )}
                    </div>

                    {/* Metadata sidebar */}
                    <div className="w-56 shrink-0 space-y-4">
                      {/* Assignee */}
                      <div>
                        <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                          <User className="h-3 w-3" /> Assignee
                        </label>
                        {memberOptions.length > 1 ? (
                          <Select
                            options={memberOptions}
                            value={task.assignee_id ?? '__none__'}
                            onValueChange={(val) =>
                              onUpdate?.(task.id, { assignee_id: val === '__none__' ? null : val } as Partial<Task>)
                            }
                            className="w-full"
                          />
                        ) : task.assignee ? (
                          <div className="flex items-center gap-2">
                            <Avatar src={task.assignee.avatar_url} name={task.assignee.display_name} size="sm" />
                            <span className="text-sm">{task.assignee.display_name}</span>
                          </div>
                        ) : (
                          <span className="text-sm text-zinc-400">Unassigned</span>
                        )}
                      </div>

                      {/* Reporter */}
                      <div>
                        <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                          <Flag className="h-3 w-3" /> Reporter
                        </label>
                        {task.reporter ? (
                          <div className="flex items-center gap-2">
                            <Avatar src={task.reporter.avatar_url} name={task.reporter.display_name} size="sm" />
                            <span className="text-sm text-zinc-700 dark:text-zinc-300">{task.reporter.display_name}</span>
                          </div>
                        ) : (
                          <span className="text-sm text-zinc-400">Unknown</span>
                        )}
                      </div>

                      {/* Sprint */}
                      {sprintOptions.length > 1 && (
                        <div>
                          <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                            <Target className="h-3 w-3" /> Sprint
                          </label>
                          <Select
                            options={sprintOptions}
                            value={task.sprint_id ?? '__none__'}
                            onValueChange={(val) =>
                              onUpdate?.(task.id, { sprint_id: val === '__none__' ? null : val } as Partial<Task>)
                            }
                            className="w-full"
                          />
                        </div>
                      )}

                      {/* Phase */}
                      {phaseOptions.length > 0 && (
                        <div>
                          <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                            <Layers className="h-3 w-3" /> Phase
                          </label>
                          <Select
                            options={phaseOptions}
                            value={task.phase_id}
                            onValueChange={(val) => onUpdate?.(task.id, { phase_id: val })}
                            className="w-full"
                          />
                        </div>
                      )}

                      {/* Epic */}
                      {epicOptions.length > 1 && (
                        <div>
                          <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                            <Zap className="h-3 w-3" /> Epic
                          </label>
                          <Select
                            options={epicOptions}
                            value={(task as Task & { epic_id?: string | null }).epic_id ?? '__none__'}
                            onValueChange={(val) =>
                              onUpdate?.(task.id, { epic_id: val === '__none__' ? null : val } as Partial<Task>)
                            }
                            className="w-full"
                          />
                        </div>
                      )}

                      {/* Story Points */}
                      <div>
                        <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                          <Hash className="h-3 w-3" /> Story Points
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={task.story_points ?? ''}
                          onChange={(e) => {
                            const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
                            onUpdate?.(task.id, { story_points: val } as Partial<Task>);
                          }}
                          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                          placeholder="0"
                        />
                      </div>

                      {/* Time Tracking */}
                      <div>
                        <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                          <Clock className="h-3 w-3" /> Time Logged
                        </label>
                        <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1.5">
                          {totalMinutesLogged > 0
                            ? `${Math.floor(totalMinutesLogged / 60)}h ${totalMinutesLogged % 60}m`
                            : '0h 0m'}
                        </p>
                        {!showTimeForm ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setShowTimeForm(true)}
                            className="w-full"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Log Time
                          </Button>
                        ) : (
                          <div className="space-y-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
                            <input
                              type="number"
                              min={1}
                              placeholder="Minutes"
                              value={timeMinutes}
                              onChange={(e) => setTimeMinutes(e.target.value)}
                              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                            />
                            <input
                              type="date"
                              value={timeDate}
                              onChange={(e) => setTimeDate(e.target.value)}
                              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                            />
                            <input
                              type="text"
                              placeholder="Description (optional)"
                              value={timeDescription}
                              onChange={(e) => setTimeDescription(e.target.value)}
                              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                            />
                            <div className="flex gap-1.5">
                              <Button
                                size="sm"
                                className="flex-1"
                                disabled={!timeMinutes || parseInt(timeMinutes) <= 0}
                                loading={createTimeEntry.isPending}
                                onClick={() =>
                                  createTimeEntry.mutate({
                                    minutes: parseInt(timeMinutes),
                                    date: timeDate,
                                    description: timeDescription,
                                  })
                                }
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setShowTimeForm(false)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                        {timeEntries.length > 0 && (
                          <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                            {timeEntries.slice(0, 5).map((entry) => (
                              <div key={entry.id} className="text-xs text-zinc-500 flex justify-between">
                                <span>{entry.minutes}m {entry.description && `- ${entry.description}`}</span>
                                <span>{entry.date?.split('T')[0]}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Start Date */}
                      <div>
                        <DatePicker
                          label="Start Date"
                          value={task.start_date?.split('T')[0] ?? ''}
                          onChange={(val) =>
                            onUpdate?.(task.id, {
                              start_date: val || null,
                            } as Partial<Task>)
                          }
                        />
                      </div>

                      {/* Due Date */}
                      <div>
                        <DatePicker
                          label="Due Date"
                          value={task.due_date?.split('T')[0] ?? ''}
                          onChange={(val) =>
                            onUpdate?.(task.id, {
                              due_date: val || null,
                            } as Partial<Task>)
                          }
                          className={cn(
                            overdue && 'border-red-300 text-red-600',
                          )}
                        />
                      </div>

                      {/* Labels */}
                      <div>
                        <label className="text-xs font-medium text-zinc-500 mb-1 block flex items-center gap-1">
                          <Tag className="h-3 w-3" /> Labels
                        </label>
                        {task.labels && (task.labels as unknown as { id: string; name: string; color: string }[]).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {(task.labels as unknown as { id: string; name: string; color: string }[]).map((l) => (
                              <Badge key={l.id} variant="custom" color={l.color}>
                                {l.name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-sm text-zinc-400">None</span>
                        )}
                      </div>

                      {/* Custom Fields */}
                      {customFieldDefs.length > 0 && (
                        <div>
                          <label className="text-xs font-medium text-zinc-500 mb-1.5 block flex items-center gap-1">
                            <Settings2 className="h-3 w-3" /> Custom Fields
                          </label>
                          <div className="space-y-2">
                            {customFieldDefs.map((field) => {
                              const cfValue = task.custom_fields?.[field.id] ?? task.custom_fields?.[field.name];
                              const handleCfChange = (value: unknown) => {
                                onUpdate?.(task.id, {
                                  custom_fields: {
                                    ...task.custom_fields,
                                    [field.id]: value,
                                  },
                                } as Partial<Task>);
                              };
                              return (
                                <div key={field.id}>
                                  <label className="text-[11px] text-zinc-400 mb-0.5 block">{field.name}</label>
                                  {field.field_type === 'text' && (
                                    <input
                                      type="text"
                                      value={(cfValue as string) ?? ''}
                                      onChange={(e) => handleCfChange(e.target.value)}
                                      className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                                      placeholder={field.name}
                                    />
                                  )}
                                  {field.field_type === 'number' && (
                                    <input
                                      type="number"
                                      value={(cfValue as number) ?? ''}
                                      onChange={(e) =>
                                        handleCfChange(e.target.value === '' ? null : Number(e.target.value))
                                      }
                                      className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                                      placeholder="0"
                                    />
                                  )}
                                  {field.field_type === 'date' && (
                                    <DatePicker
                                      value={(cfValue as string) ?? ''}
                                      onChange={(val) => handleCfChange(val || null)}
                                    />
                                  )}
                                  {field.field_type === 'select' && (
                                    <Select
                                      options={[
                                        { value: '__none__', label: 'None' },
                                        ...(field.options ?? []).map((o) => ({
                                          value: o.label,
                                          label: o.label,
                                        })),
                                      ]}
                                      value={(cfValue as string) ?? '__none__'}
                                      onValueChange={(val) => handleCfChange(val === '__none__' ? null : val)}
                                      className="w-full"
                                    />
                                  )}
                                  {field.field_type === 'checkbox' && (
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={!!cfValue}
                                        onChange={(e) => handleCfChange(e.target.checked)}
                                        className="rounded border-zinc-300"
                                      />
                                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                                        {cfValue ? 'Yes' : 'No'}
                                      </span>
                                    </label>
                                  )}
                                  {field.field_type === 'url' && (
                                    <div className="flex items-center gap-1">
                                      <Link2 className="h-3 w-3 text-zinc-400 shrink-0" />
                                      <input
                                        type="url"
                                        value={(cfValue as string) ?? ''}
                                        onChange={(e) => handleCfChange(e.target.value)}
                                        className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                                        placeholder="https://..."
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-400 space-y-1">
                        <p>Created {formatDate(task.created_at)}</p>
                        <p>Updated {formatDate(task.updated_at)}</p>
                      </div>

                      {/* Delete task */}
                      {onDelete && (
                        <div className="pt-2">
                          <button
                            onClick={() => {
                              if (confirm('Are you sure you want to delete this task? This action cannot be undone.')) {
                                onDelete(task.id);
                              }
                            }}
                            className="flex items-center gap-1.5 w-full rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete Task
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

// ─── Parent tasks section (B3 Frndo Launch) ────────────────────────────────
//
// Many-to-many: a task can have multiple parent tasks because more than one
// parent task might legitimately depend on the same shared piece of work.
// The legacy single-parent self-FK (tasks.parent_task_id) still drives the
// existing denormalized subtask counters; this many-to-many view sits on
// top of the new task_parent_links join table (+ a defensive union with the
// legacy column so a single-parent subtask backfilled from before this
// feature still shows its parent).

interface ParentTasksSectionProps {
  taskId: string;
  projectId: string | undefined;
}

interface TaskSearchResult {
  id: string;
  human_id: string | null;
  title: string;
  completed_at: string | null;
}

function ParentTasksSection({ taskId, projectId }: ParentTasksSectionProps) {
  const { data: parentsRes } = useTaskParents(taskId);
  const parents = (parentsRes?.data ?? []) as ParentTaskSummary[];
  const addParent = useAddTaskParent();
  const removeParent = useRemoveTaskParent();

  const [showPicker, setShowPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);

  // Project task list for the picker — only fetched when the picker is open.
  const { data: tasksRes } = useQuery({
    queryKey: ['project-tasks-flat', projectId, pickerSearch],
    queryFn: () =>
      api.get<PaginatedResponse<TaskSearchResult>>(`/projects/${projectId}/tasks`, {
        search: pickerSearch || undefined,
        limit: '20',
      }),
    enabled: !!projectId && showPicker,
  });
  const candidateTasks = (tasksRes?.data ?? []).filter(
    (t) => t.id !== taskId && !parents.some((p) => p.id === t.id),
  );

  async function handleAdd(parentTaskId: string) {
    setPickerError(null);
    try {
      await addParent.mutateAsync({ taskId, parentTaskId });
      setShowPicker(false);
      setPickerSearch('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add parent';
      setPickerError(message);
    }
  }

  if (parents.length === 0 && !showPicker) {
    return (
      <div>
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
          <Link2 className="h-4 w-4" />
          Parent tasks
        </h3>
        <button
          onClick={() => setShowPicker(true)}
          className="text-xs text-zinc-500 hover:text-primary-600"
        >
          + Add a parent task
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
        <Link2 className="h-4 w-4" />
        Parent tasks
        {parents.length > 0 && <span className="text-zinc-400">({parents.length})</span>}
      </h3>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {parents.map((p) => {
          const isDone = p.completed_at != null;
          return (
            <span
              key={p.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                // The original styling used bg-primary-50 (≈ #eff6ff, almost
                // white) with text-primary-800 — technically dark blue but it
                // read as "light blue on white" because the background was
                // too faint to anchor the eye. Bumped to bg-primary-100 +
                // text-primary-900 + font-medium to match the existing Badge
                // variant treatment, and dropped the opacity-70 on human_id
                // which was further washing the chip out. Also fixed the
                // dark-mode classes that targeted the nonexistent
                // primary-950 step.
                isDone
                  ? 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                  : 'border-primary-300 bg-primary-100 text-primary-900 dark:border-primary-700 dark:bg-primary-900/40 dark:text-primary-100',
              )}
            >
              {p.human_id && (
                <span className="font-mono text-[10px] tracking-tight">{p.human_id}</span>
              )}
              <span className="truncate max-w-[16rem]">{p.title}</span>
              <button
                type="button"
                onClick={() =>
                  removeParent.mutate({ taskId, parentTaskId: p.id })
                }
                className="ml-0.5 -mr-1 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                title="Remove parent"
                aria-label="Remove parent"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>

      {!showPicker ? (
        <button
          onClick={() => setShowPicker(true)}
          className="text-xs text-zinc-500 hover:text-primary-600"
        >
          + Add another parent
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2 bg-zinc-50 dark:bg-zinc-800/40">
          <input
            type="text"
            autoFocus
            placeholder="Search tasks by title or ID..."
            value={pickerSearch}
            onChange={(e) => setPickerSearch(e.target.value)}
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {pickerError && (
            <p className="text-xs text-red-600 dark:text-red-400">{pickerError}</p>
          )}
          <div className="max-h-40 overflow-y-auto">
            {candidateTasks.length === 0 ? (
              <p className="text-xs text-zinc-400 py-2 text-center">No matches</p>
            ) : (
              candidateTasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleAdd(t.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white dark:hover:bg-zinc-900"
                >
                  {t.human_id && (
                    <span className="font-mono text-[10px] text-zinc-400">{t.human_id}</span>
                  )}
                  <span className="truncate">{t.title}</span>
                </button>
              ))
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => {
                setShowPicker(false);
                setPickerSearch('');
                setPickerError(null);
              }}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
