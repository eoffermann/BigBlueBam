import { useMemo, useState } from 'react';
import { Loader2, MessageSquare, Reply, Trash2 } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { Button } from '@/components/common/button';
import { Avatar } from '@/components/common/avatar';
import { useAuthStore } from '@/stores/auth.store';
import {
  useBeaconComments,
  useCreateBeaconComment,
  useDeleteBeaconComment,
  type BeaconComment,
} from '@/hooks/use-comments';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { formatRelativeTime } from '@/lib/utils';

interface CommentsSectionProps {
  beaconId: string;
}

interface CommentNode extends BeaconComment {
  children: CommentNode[];
}

/**
 * Flatten the chronological server response into a tree keyed by parent_id.
 * Orphans (parent_id set but parent was deleted) surface at the root so the
 * conversation is never silently lost.
 */
function buildTree(comments: BeaconComment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const c of comments) {
    byId.set(c.id, { ...c, children: [] });
  }
  const roots: CommentNode[] = [];
  for (const c of comments) {
    const node = byId.get(c.id)!;
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function CommentsSection({ beaconId }: CommentsSectionProps) {
  const { data: comments, isLoading, error } = useBeaconComments(beaconId);
  const currentUser = useAuthStore((s) => s.user);
  const createMutation = useCreateBeaconComment(beaconId);
  const deleteMutation = useDeleteBeaconComment(beaconId);

  const [topLevelBody, setTopLevelBody] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');

  const tree = useMemo(() => buildTree(comments ?? []), [comments]);
  // Wave E.D: replace inline role/is_superuser check with the per-action
  // permission for deleting any beacon comment (DELETE /beacons/:id/comments/:cid →
  // beacon.beacon_comment.delete). Authors can still delete their own; this
  // controls cross-author delete (canDelete below ORs in author identity).
  const isAdmin = useCan('beacon.beacon_comment.delete');

  const handleTopLevelSubmit = () => {
    const body = topLevelBody.trim();
    if (!body) return;
    createMutation.mutate(
      { body_markdown: body, parent_id: null },
      { onSuccess: () => setTopLevelBody('') },
    );
  };

  const handleReplySubmit = (parentId: string) => {
    const body = replyBody.trim();
    if (!body) return;
    createMutation.mutate(
      { body_markdown: body, parent_id: parentId },
      {
        onSuccess: () => {
          setReplyBody('');
          setReplyingTo(null);
        },
      },
    );
  };

  const handleDelete = (commentId: string) => {
    if (window.confirm('Delete this comment? Replies will also be removed.')) {
      deleteMutation.mutate(commentId);
    }
  };

  return (
    <section className="mt-10 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
          Comments
          {comments ? (
            <span className="ml-2 text-zinc-400 font-normal normal-case">({comments.length})</span>
          ) : null}
        </h2>
      </div>

      {/* New top-level comment */}
      <div className="mb-6">
        <textarea
          value={topLevelBody}
          onChange={(e) => setTopLevelBody(e.target.value)}
          placeholder="Add a comment. Markdown supported."
          rows={3}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y min-h-[72px]"
        />
        <div className="flex items-center justify-end mt-2">
          <Button
            size="sm"
            onClick={handleTopLevelSubmit}
            disabled={!topLevelBody.trim()}
            loading={createMutation.isPending && !replyingTo}
          >
            Post Comment
          </Button>
        </div>
      </div>

      {/* Render thread */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading comments...
        </div>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load comments: {(error as Error).message}
        </p>
      )}
      {!isLoading && !error && tree.length === 0 && (
        <p className="text-sm text-zinc-400 italic">No comments yet. Be the first.</p>
      )}

      <ul className="space-y-4">
        {tree.map((node) => (
          <CommentNodeView
            key={node.id}
            node={node}
            currentUserId={currentUser?.id}
            isAdmin={!!isAdmin}
            onReply={(parentId) => {
              setReplyingTo(parentId);
              setReplyBody('');
            }}
            onDelete={handleDelete}
            isDeleting={deleteMutation.isPending}
            replyingTo={replyingTo}
            replyBody={replyBody}
            setReplyBody={setReplyBody}
            onReplySubmit={handleReplySubmit}
            onReplyCancel={() => {
              setReplyingTo(null);
              setReplyBody('');
            }}
            replyPending={createMutation.isPending && replyingTo !== null}
            depth={0}
          />
        ))}
      </ul>
    </section>
  );
}

interface CommentNodeViewProps {
  node: CommentNode;
  currentUserId: string | undefined;
  isAdmin: boolean;
  onReply: (parentId: string) => void;
  onDelete: (commentId: string) => void;
  isDeleting: boolean;
  replyingTo: string | null;
  replyBody: string;
  setReplyBody: (v: string) => void;
  onReplySubmit: (parentId: string) => void;
  onReplyCancel: () => void;
  replyPending: boolean;
  depth: number;
}

function CommentNodeView({
  node,
  currentUserId,
  isAdmin,
  onReply,
  onDelete,
  isDeleting,
  replyingTo,
  replyBody,
  setReplyBody,
  onReplySubmit,
  onReplyCancel,
  replyPending,
  depth,
}: CommentNodeViewProps) {
  const canDelete = isAdmin || node.author_id === currentUserId;
  const canReply = depth < 4;
  const bodyHtml = node.body_html ?? sanitizeHtml(markdownToHtml(node.body_markdown));
  const isReplying = replyingTo === node.id;

  return (
    <li>
      <div className="flex gap-3">
        <Avatar src={node.author_avatar_url} name={node.author_name ?? node.author_email ?? 'User'} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {node.author_name ?? node.author_email ?? 'Unknown'}
            </span>
            <span className="text-xs text-zinc-400">{formatRelativeTime(node.created_at)}</span>
          </div>

          <div
            className="prose prose-sm prose-zinc dark:prose-invert max-w-none text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />

          <div className="flex items-center gap-3 mt-2 text-xs">
            {canReply && (
              <button
                onClick={() => onReply(node.id)}
                className="flex items-center gap-1 text-zinc-500 hover:text-primary-600 transition-colors"
              >
                <Reply className="h-3 w-3" />
                Reply
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => onDelete(node.id)}
                disabled={isDeleting}
                className="flex items-center gap-1 text-zinc-500 hover:text-red-600 transition-colors disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            )}
          </div>

          {isReplying && (
            <div className="mt-3">
              <textarea
                autoFocus
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder="Reply..."
                rows={2}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y min-h-[60px]"
              />
              <div className="flex items-center justify-end gap-2 mt-1.5">
                <Button size="sm" variant="ghost" onClick={onReplyCancel}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={() => onReplySubmit(node.id)}
                  disabled={!replyBody.trim()}
                  loading={replyPending}
                >
                  Reply
                </Button>
              </div>
            </div>
          )}

          {node.children.length > 0 && (
            <ul className="mt-4 pl-4 border-l-2 border-zinc-100 dark:border-zinc-800 space-y-4">
              {node.children.map((child) => (
                <CommentNodeView
                  key={child.id}
                  node={child}
                  currentUserId={currentUserId}
                  isAdmin={isAdmin}
                  onReply={onReply}
                  onDelete={onDelete}
                  isDeleting={isDeleting}
                  replyingTo={replyingTo}
                  replyBody={replyBody}
                  setReplyBody={setReplyBody}
                  onReplySubmit={onReplySubmit}
                  onReplyCancel={onReplyCancel}
                  replyPending={replyPending}
                  depth={depth + 1}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
