import { useState, useEffect } from 'react';
import {
  Loader2,
  Edit2,
  Star,
  Archive,
  ChevronDown,
  FolderOpen,
  Copy,
  ArrowUpFromLine,
  RotateCcw,
} from 'lucide-react';
import { useDocument, useToggleStar, useArchiveDocument, useDuplicateDocument, usePromoteToBeacon, useRestoreDocument } from '@/hooks/use-documents';
import { markdownToHtml } from '@/lib/markdown';
import { useCollaboration } from '@/hooks/use-collaboration';
import { useCollaborativeEditor, BriefEditorContent } from '@/components/editor/brief-editor';
import { useComments, useCreateComment, useResolveComment, useDeleteComment } from '@/hooks/use-comments';
import { useVersions } from '@/hooks/use-versions';
import { StatusBadge } from '@/components/document/status-badge';
import { CommentThread } from '@/components/document/comment-thread';
import { ExportMenu } from '@/components/document/export-menu';
import { LinkedItems } from '@/components/document/linked-items';
import { Button } from '@/components/common/button';
import { Avatar } from '@/components/common/avatar';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { useProjectName } from '@/hooks/use-projects';

interface DocumentDetailPageProps {
  idOrSlug: string;
  onNavigate: (path: string) => void;
}

export function DocumentDetailPage({ idOrSlug, onNavigate }: DocumentDetailPageProps) {
  const { data: doc, isLoading, refetch } = useDocument(idOrSlug);
  const { data: comments } = useComments(doc?.id);
  const { data: versions } = useVersions(doc?.id);
  const [showVersions, setShowVersions] = useState(false);
  const [commentText, setCommentText] = useState('');
  const projectName = useProjectName(doc?.project_id);
  const displayProjectName = doc?.project_name ?? projectName ?? null;

  const toggleStar = useToggleStar();
  const archiveDoc = useArchiveDocument();
  const duplicateDoc = useDuplicateDocument();
  const promoteToBeacon = usePromoteToBeacon();
  const restoreDoc = useRestoreDocument();
  const createComment = useCreateComment();
  const resolveComment = useResolveComment();
  const deleteComment = useDeleteComment();

  // Live reading: join the document's Yjs room read-only so the body
  // updates in real time (with the writers' cursors visible) while anyone
  // is editing — a reader is a participant, not a cache. Falls back to the
  // static html_snapshot below until the room syncs, and stays static for
  // docs whose Yjs state is empty (legacy content never opened for edit).
  const { ydoc, provider, isSynced } = useCollaboration(doc?.id ?? null);
  const liveEditor = useCollaborativeEditor({
    ydoc: doc ? ydoc : undefined,
    provider: doc ? provider : undefined,
    onUpdate: () => {},
    editable: false,
  });
  const [liveHasContent, setLiveHasContent] = useState(false);
  useEffect(() => {
    if (!isSynced) {
      setLiveHasContent(false);
      return;
    }
    const fragment = ydoc.getXmlFragment('default');
    const update = () => setLiveHasContent(fragment.length > 0);
    update();
    // observeDeep: a doc seeded by an editor moments later flips us live.
    fragment.observeDeep(update);
    return () => fragment.unobserveDeep(update);
  }, [isSynced, ydoc]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <p>Document not found.</p>
      </div>
    );
  }

  const handleStar = () => toggleStar.mutate(doc.id, { onSuccess: () => refetch() });
  const handleArchive = () => archiveDoc.mutate(doc.id, { onSuccess: () => onNavigate('/documents') });
  const handleRestore = () => restoreDoc.mutate(doc.id, { onSuccess: () => refetch() });
  const handleDuplicate = () => duplicateDoc.mutate(doc.id, {
    onSuccess: (res) => onNavigate(`/documents/${res.data.slug ?? res.data.id}`),
  });
  const handlePromote = () => promoteToBeacon.mutate(doc.id, {
    onSuccess: (res) => {
      window.location.href = `/beacon/${res.data.beacon_id}`;
    },
  });
  const handleAddComment = () => {
    if (!commentText.trim()) return;
    createComment.mutate(
      { documentId: doc.id, body: commentText.trim() },
      { onSuccess: () => setCommentText('') },
    );
  };
  const handleResolveComment = (commentId: string) => {
    resolveComment.mutate({ documentId: doc.id, commentId });
  };
  const handleDeleteComment = (commentId: string) => {
    deleteComment.mutate({ documentId: doc.id, commentId });
  };

  // Render the document body: live collaborative view when the Yjs room
  // has content, else html_snapshot, then markdown conversion, then plain_text
  const renderBody = () => {
    if (liveHasContent && liveEditor) {
      return (
        <article className="prose prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed document-content">
          <BriefEditorContent editor={liveEditor} />
        </article>
      );
    }
    if (doc.html_snapshot) {
      return (
        <article
          className="prose prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed document-content ProseMirror"
          dangerouslySetInnerHTML={{ __html: doc.html_snapshot }}
        />
      );
    }
    const md = doc.plain_text ?? '';
    if (md) {
      const html = markdownToHtml(md);
      return (
        <article
          className="prose prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed document-content ProseMirror"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    const text = doc.plain_text ?? '';
    if (text) {
      return (
        <article
          className="prose prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed document-content ProseMirror"
          dangerouslySetInnerHTML={{ __html: text.replace(/\n/g, '<br>') }}
        />
      );
    }
    return (
      <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">No content yet.</p>
    );
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main area */}
      <div className="flex-1 overflow-auto p-6 lg:p-8 min-w-0">
        {/* Title + status + actions row */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-2">
              {doc.icon && <span className="text-2xl">{doc.icon}</span>}
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {doc.title}
              </h1>
              <StatusBadge status={doc.status} />
            </div>
            {doc.summary && (
              <p className="text-zinc-600 dark:text-zinc-400 text-sm">{doc.summary}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleStar}
              title={doc.pinned ? 'Remove star' : 'Star document'}
            >
              <Star className={`h-4 w-4 ${doc.pinned ? 'text-yellow-500 fill-yellow-500' : ''}`} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onNavigate(`/documents/${idOrSlug}/edit`)}
            >
              <Edit2 className="h-4 w-4" />
              Edit
            </Button>
          </div>
        </div>

        {/* Body */}
        {renderBody()}

        {/* Action bar */}
        <div className="flex items-center gap-2 mt-8 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="ghost" size="sm" onClick={handleDuplicate} loading={duplicateDoc.isPending}>
            <Copy className="h-4 w-4" />
            Duplicate
          </Button>
          <ExportMenu documentId={doc.id} slug={doc.slug} />
          <Button variant="ghost" size="sm" onClick={handlePromote} loading={promoteToBeacon.isPending}>
            <ArrowUpFromLine className="h-4 w-4" />
            Promote to Beacon
          </Button>
          {doc.status === 'archived' ? (
            <Button variant="ghost" size="sm" onClick={handleRestore} loading={restoreDoc.isPending}>
              <RotateCcw className="h-4 w-4" />
              Restore
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={handleArchive} loading={archiveDoc.isPending} className="text-red-500 hover:text-red-700">
              <Archive className="h-4 w-4" />
              Archive
            </Button>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <aside className="w-80 shrink-0 border-l border-zinc-200 dark:border-zinc-800 overflow-auto p-5 hidden lg:block">
        <div className="space-y-5">
          {/* Status */}
          <SidebarField label="Status">
            <StatusBadge status={doc.status} />
          </SidebarField>

          {/* Author */}
          <SidebarField label="Author">
            <div className="flex items-center gap-2">
              <Avatar src={doc.creator_avatar_url} name={doc.creator_name} size="sm" />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {doc.creator_name ?? 'Unknown'}
              </span>
            </div>
          </SidebarField>

          {/* Project */}
          <SidebarField label="Project">
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {displayProjectName ?? 'Organization-wide'}
              </span>
            </div>
          </SidebarField>

          {/* Dates */}
          <SidebarField label="Created">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {formatDate(doc.created_at)}
            </span>
          </SidebarField>

          <SidebarField label="Last Updated">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {formatRelativeTime(doc.updated_at)}
            </span>
          </SidebarField>

          {doc.published_at && (
            <SidebarField label="Published">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {formatDate(doc.published_at)}
              </span>
            </SidebarField>
          )}

          {/* Word count */}
          <SidebarField label="Word Count">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {doc.word_count.toLocaleString()}
            </span>
          </SidebarField>

          {/* Version history */}
          <SidebarField label="Version">
            <div>
              <button
                onClick={() => setShowVersions(!showVersions)}
                className="flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:text-primary-600"
              >
                v{doc.version}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showVersions ? 'rotate-180' : ''}`} />
              </button>
              {showVersions && versions && versions.length > 0 && (
                <div className="mt-2 space-y-1.5 max-h-48 overflow-auto">
                  {versions.map((v) => (
                    <div key={v.id} className="text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium">v{v.version}</span>
                      {' '}&mdash;{' '}
                      {v.changed_by_name ?? 'Unknown'}
                      {' '}&middot;{' '}
                      {formatRelativeTime(v.created_at)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SidebarField>

          {/* Linked Items */}
          <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-3 uppercase tracking-wider">
              Linked Items
            </h3>
            <LinkedItems documentId={doc.id} />
          </div>

          {/* Comments section */}
          <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-3 uppercase tracking-wider">
              Comments ({comments?.length ?? 0})
            </h3>
            <div className="space-y-2">
              {comments?.map((comment) => (
                <CommentThread
                  key={comment.id}
                  comment={comment}
                  onResolve={handleResolveComment}
                  onDelete={handleDeleteComment}
                />
              ))}
            </div>

            {/* Add comment */}
            <div className="mt-3">
              <textarea
                placeholder="Add a comment..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-none"
              />
              <Button
                size="sm"
                className="mt-1.5"
                onClick={handleAddComment}
                disabled={!commentText.trim()}
                loading={createComment.isPending}
              >
                Comment
              </Button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
