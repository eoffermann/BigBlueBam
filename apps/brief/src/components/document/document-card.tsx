import type { BriefDocument } from '@/hooks/use-documents';
import { StatusBadge } from '@/components/document/status-badge';
import { Avatar } from '@/components/common/avatar';
import { formatRelativeTime } from '@/lib/utils';
import { Star, FileText, Trash2 } from 'lucide-react';

interface DocumentCardProps {
  document: BriefDocument;
  onClick: () => void;
  /** Archive (soft-delete) this document from the list. Omitted hides the control. */
  onDelete?: () => void;
  deleting?: boolean;
}

export function DocumentCard({ document, onClick, onDelete, deleting }: DocumentCardProps) {
  return (
    // A div (not a button) so the Delete control can be a real nested button —
    // a button inside a button is invalid and swallows the inner click.
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className="group w-full cursor-pointer text-left rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 hover:border-primary-300 hover:bg-primary-50/30 dark:hover:border-primary-700 dark:hover:bg-primary-900/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-lg shrink-0">
            {document.icon ?? <FileText className="h-5 w-5 text-zinc-400" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {document.title}
              </h3>
              {document.pinned && (
                <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 shrink-0" />
              )}
            </div>
            {document.summary && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 break-words mb-2">
                {document.summary}
              </p>
            )}
            <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <div className="flex items-center gap-1.5">
                <Avatar src={document.creator_avatar_url} name={document.creator_name} size="sm" />
                <span>{document.creator_name ?? 'Unknown'}</span>
              </div>
              <span>{formatRelativeTime(document.updated_at)}</span>
              {document.word_count > 0 && (
                <span>{document.word_count.toLocaleString()} words</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={document.status} />
          {onDelete && document.status !== 'archived' && (
            <button
              type="button"
              data-document-delete
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              disabled={deleting}
              title="Delete document"
              aria-label={`Delete ${document.title}`}
              className="rounded-md p-1.5 text-zinc-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
