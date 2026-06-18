import { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  History,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  useComments,
  useAddComment,
  usePatchComment,
  type BlueprintComment,
} from '@/hooks/use-comments';
import {
  useCollaborators,
  useAddCollaborator,
  useRemoveCollaborator,
  type CollaboratorRole,
} from '@/hooks/use-collaborators';
import { usePeople, usePeopleMap } from '@/hooks/use-people';
import {
  useVersions,
  useSnapshotVersion,
  useRestoreVersion,
  type BlueprintNode,
} from '@/hooks/use-diagrams';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { cn, formatRelativeTime, generateAvatarInitials } from '@/lib/utils';

export type EditorPanelTab = 'comments' | 'collaborators' | 'versions';

const ROLE_OPTIONS: { value: CollaboratorRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'commenter', label: 'Commenter' },
  { value: 'viewer', label: 'Viewer' },
];

function currentUserId(): string | null {
  try {
    const store = (globalThis as Record<string, unknown>).__blueprintAuthStore as
      | { getState?: () => { user?: { id?: string } } }
      | undefined;
    return store?.getState?.()?.user?.id ?? null;
  } catch {
    return null;
  }
}

/* ================================================================== */
/*  Comments panel                                                    */
/* ================================================================== */

function CommentItem({
  comment,
  authorName,
  nodeLabel,
  onResolveToggle,
  busy,
}: {
  comment: BlueprintComment;
  authorName: string;
  nodeLabel: string | null;
  onResolveToggle: () => void;
  busy: boolean;
}) {
  const html = useMemo(
    () => sanitizeHtml(markdownToHtml(comment.body)),
    [comment.body],
  );
  return (
    <div
      className={cn(
        'rounded-lg border p-3 space-y-2',
        comment.resolved
          ? 'border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 opacity-70'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900/40 text-[10px] font-semibold text-primary-700 dark:text-primary-300">
            {generateAvatarInitials(authorName)}
          </span>
          <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate">
            {authorName}
          </span>
        </div>
        <span className="text-[10px] text-zinc-400 shrink-0">
          {formatRelativeTime(comment.created_at)}
        </span>
      </div>

      {nodeLabel !== null && (
        <div className="inline-flex items-center gap-1 rounded bg-zinc-100 dark:bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:text-zinc-400 max-w-full">
          <span className="truncate">on {nodeLabel}</span>
        </div>
      )}

      <div
        className="prose prose-sm dark:prose-invert max-w-none text-sm text-zinc-700 dark:text-zinc-200 break-words [&_p]:my-0.5"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <div className="flex items-center justify-between pt-1">
        {comment.edited_at && (
          <span className="text-[10px] text-zinc-400 italic">edited</span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onResolveToggle}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-50',
            comment.resolved
              ? 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              : 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30',
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : comment.resolved ? (
            <RotateCcw className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {comment.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}

function CommentsPanel({
  diagramId,
  selectedNodeId,
  nodesById,
}: {
  diagramId: string;
  selectedNodeId: string | null;
  nodesById: Map<string, BlueprintNode>;
}) {
  const { data, isLoading } = useComments(diagramId);
  const people = usePeopleMap();
  const addComment = useAddComment(diagramId);
  const patchComment = usePatchComment(diagramId);

  const [draft, setDraft] = useState('');
  const [anchorToNode, setAnchorToNode] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  const comments = data?.data ?? [];
  const visible = showResolved ? comments : comments.filter((c) => !c.resolved);
  const resolvedCount = comments.filter((c) => c.resolved).length;

  const selectedNodeLabel = selectedNodeId
    ? nodesById.get(selectedNodeId)?.label ?? null
    : null;

  function submit() {
    const text = draft.trim();
    if (!text) return;
    addComment.mutate(
      {
        body: text,
        body_plain: text,
        node_id: anchorToNode && selectedNodeId ? selectedNodeId : null,
      },
      { onSuccess: () => setDraft('') },
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-10 px-2">
            <MessageSquare className="mx-auto h-6 w-6 text-zinc-300 dark:text-zinc-600" />
            <p className="mt-2 text-xs text-zinc-500">
              No comments yet. Add the first one below.
            </p>
          </div>
        ) : (
          visible.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              authorName={people.nameFor(c.author_id)}
              nodeLabel={c.node_id ? nodesById.get(c.node_id)?.label ?? 'a node' : null}
              busy={patchComment.isPending}
              onResolveToggle={() =>
                patchComment.mutate({
                  commentId: c.id,
                  input: { resolved: !c.resolved },
                })
              }
            />
          ))
        )}

        {resolvedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="w-full text-center text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 py-1"
          >
            {showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Add a comment. Markdown works. Cmd/Ctrl+Enter to post."
          className="w-full resize-none rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-primary-500 outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <label
            className={cn(
              'flex items-center gap-1.5 text-[11px] select-none',
              selectedNodeId ? 'text-zinc-600 dark:text-zinc-300 cursor-pointer' : 'text-zinc-400 cursor-not-allowed',
            )}
            title={selectedNodeId ? 'Anchor this comment to the selected node' : 'Select a node to anchor a comment to it'}
          >
            <input
              type="checkbox"
              disabled={!selectedNodeId}
              checked={anchorToNode && !!selectedNodeId}
              onChange={(e) => setAnchorToNode(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
            />
            {selectedNodeId ? (
              <span className="truncate max-w-[160px]">Pin to {selectedNodeLabel ?? 'node'}</span>
            ) : (
              'Diagram-level comment'
            )}
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || addComment.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {addComment.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Collaborators panel                                               */
/* ================================================================== */

function AddCollaborator({ diagramId }: { diagramId: string }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const { data: results, isLoading } = usePeople(search);
  const addCollaborator = useAddCollaborator(diagramId);
  const { data: existing } = useCollaborators(diagramId);
  const me = currentUserId();

  const existingIds = useMemo(
    () => new Set((existing?.data ?? []).map((c) => c.user_id)),
    [existing],
  );
  const candidates = (results ?? []).filter(
    (p) => p.id !== me && !existingIds.has(p.id),
  );

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Add by name or email"
          className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 outline-none placeholder:text-zinc-400"
        />
        {open && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setSearch('');
            }}
            className="text-zinc-400 hover:text-zinc-600"
            aria-label="Close search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto custom-scrollbar rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
          {isLoading ? (
            <div className="flex items-center justify-center py-4 text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : candidates.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-zinc-500">
              {search.trim() ? 'No matching people.' : 'Start typing to find people.'}
            </div>
          ) : (
            candidates.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={addCollaborator.isPending}
                onClick={() =>
                  addCollaborator.mutate(
                    { user_id: p.id, role: 'editor' },
                    {
                      onSuccess: () => {
                        setOpen(false);
                        setSearch('');
                      },
                    },
                  )
                }
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {generateAvatarInitials(p.display_name || p.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-800 dark:text-zinc-100">
                    {p.display_name || p.email}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-400">{p.email}</span>
                </span>
                <UserPlus className="h-3.5 w-3.5 text-zinc-400" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function CollaboratorsPanel({ diagramId }: { diagramId: string }) {
  const { data, isLoading } = useCollaborators(diagramId);
  const people = usePeopleMap();
  const addCollaborator = useAddCollaborator(diagramId);
  const removeCollaborator = useRemoveCollaborator(diagramId);

  const collaborators = data?.data ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-200 dark:border-zinc-800 p-3">
        <AddCollaborator diagramId={diagramId} />
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : collaborators.length === 0 ? (
          <div className="text-center py-10 px-2">
            <Users className="mx-auto h-6 w-6 text-zinc-300 dark:text-zinc-600" />
            <p className="mt-2 text-xs text-zinc-500">
              No direct collaborators. People with project or org access can still
              see this diagram.
            </p>
          </div>
        ) : (
          collaborators.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/40 px-2.5 py-2"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                {generateAvatarInitials(people.nameFor(c.user_id))}
              </span>
              <span className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-100 truncate">
                {people.nameFor(c.user_id)}
              </span>
              <select
                value={c.role}
                disabled={addCollaborator.isPending}
                onChange={(e) =>
                  addCollaborator.mutate({
                    user_id: c.user_id,
                    role: e.target.value as CollaboratorRole,
                  })
                }
                className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-1.5 py-1 text-xs text-zinc-700 dark:text-zinc-200"
                aria-label="Collaborator role"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={removeCollaborator.isPending}
                onClick={() => removeCollaborator.mutate(c.user_id)}
                title="Remove collaborator"
                className="p-1.5 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Versions panel                                                    */
/* ================================================================== */

function VersionsPanel({ diagramId }: { diagramId: string }) {
  const { data, isLoading } = useVersions(diagramId);
  const people = usePeopleMap();
  const snapshot = useSnapshotVersion(diagramId);
  const restore = useRestoreVersion(diagramId);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);

  const versions = data?.data ?? [];

  function onSnapshot() {
    const label = window.prompt('Snapshot label (optional)');
    // A cancelled prompt returns null; an empty string is a deliberate
    // unlabeled snapshot. Either way we send null for no label.
    snapshot.mutate(label?.trim() || null);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-200 dark:border-zinc-800 p-3">
        <button
          type="button"
          onClick={onSnapshot}
          disabled={snapshot.isPending}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {snapshot.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Save snapshot
        </button>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : versions.length === 0 ? (
          <div className="text-center py-10 px-2">
            <History className="mx-auto h-6 w-6 text-zinc-300 dark:text-zinc-600" />
            <p className="mt-2 text-xs text-zinc-500">
              No saved versions yet. Save a snapshot to capture the current graph.
            </p>
          </div>
        ) : (
          versions.map((v) => (
            <div
              key={v.id}
              className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/40 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  <span className="rounded bg-zinc-100 dark:bg-zinc-700 px-1.5 py-0.5 text-[10px] font-mono">
                    v{v.version_number}
                  </span>
                  {v.label || <span className="text-zinc-400 italic">Unlabeled</span>}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-400">
                <span>{people.nameFor(v.created_by)}</span>
                <span>{formatRelativeTime(v.created_at)}</span>
              </div>

              {confirmRestore === v.version_number ? (
                <div className="flex items-center gap-2 pt-1">
                  <span className="flex-1 text-[11px] text-amber-600 dark:text-amber-400">
                    Replace the current graph with v{v.version_number}?
                  </span>
                  <button
                    type="button"
                    disabled={restore.isPending}
                    onClick={() =>
                      restore.mutate(v.version_number, {
                        onSuccess: () => setConfirmRestore(null),
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {restore.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRestore(null)}
                    className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRestore(v.version_number)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <RotateCcw className="h-3 w-3" /> Restore
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Container — the right-side panel that hosts the three tabs        */
/* ================================================================== */

const TABS: { value: EditorPanelTab; label: string; icon: typeof MessageSquare }[] = [
  { value: 'comments', label: 'Comments', icon: MessageSquare },
  { value: 'collaborators', label: 'People', icon: Users },
  { value: 'versions', label: 'History', icon: History },
];

interface EditorPanelsProps {
  diagramId: string;
  activeTab: EditorPanelTab;
  onTabChange: (tab: EditorPanelTab) => void;
  onClose: () => void;
  selectedNodeId: string | null;
  nodesById: Map<string, BlueprintNode>;
}

export function EditorPanels({
  diagramId,
  activeTab,
  onTabChange,
  onClose,
  selectedNodeId,
  nodesById,
}: EditorPanelsProps) {
  return (
    <aside className="w-[320px] shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-2 h-11 shrink-0">
        <div className="flex items-center gap-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.value === activeTab;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => onTabChange(t.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                  active
                    ? 'bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Close panel"
          title="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {activeTab === 'comments' && (
          <CommentsPanel
            diagramId={diagramId}
            selectedNodeId={selectedNodeId}
            nodesById={nodesById}
          />
        )}
        {activeTab === 'collaborators' && <CollaboratorsPanel diagramId={diagramId} />}
        {activeTab === 'versions' && <VersionsPanel diagramId={diagramId} />}
      </div>
    </aside>
  );
}
