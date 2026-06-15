import { useState, useMemo } from 'react';
import { Plus, Search, Loader2, FolderOpen, X } from 'lucide-react';
import { useDocumentList, useArchiveDocument, type DocumentStatus, type DocumentListFilters } from '@/hooks/use-documents';
import { useFolders } from '@/hooks/use-folders';
import { DocumentCard } from '@/components/document/document-card';
import { Button } from '@/components/common/button';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project.store';
import { useProjectName } from '@/hooks/use-projects';

interface DocumentListPageProps {
  onNavigate: (path: string) => void;
  folderId?: string | null;
}

const STATUS_CHIPS: { value: DocumentStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_review', label: 'In Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'archived', label: 'Archived' },
];

export function DocumentListPage({ onNavigate, folderId }: DocumentListPageProps) {
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | 'all'>('all');
  const [searchText, setSearchText] = useState('');
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeProjectName = useProjectName(activeProjectId);
  const { data: folders } = useFolders(activeProjectId);
  const activeFolder = useMemo(
    () => (folderId ? folders?.find((f) => f.id === folderId) : null),
    [folders, folderId],
  );

  const filters: DocumentListFilters = {};
  if (statusFilter !== 'all') filters.status = statusFilter;
  if (searchText.trim()) filters.search = searchText.trim();
  if (activeProjectId) filters.project_id = activeProjectId;
  if (folderId) filters.folder_id = folderId;

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useDocumentList(filters);

  const allDocs = data?.pages.flatMap((p) => p.data) ?? [];
  // Archived docs are the "trash": shown only under the Archived filter, never
  // in the active views — so deleting (archiving) a doc removes it from the
  // list the user is looking at instead of lingering with an "Archived" badge.
  const documents =
    statusFilter === 'archived' ? allDocs : allDocs.filter((d) => d.status !== 'archived');
  const archiveDoc = useArchiveDocument();

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search documents..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-60 rounded-lg border border-zinc-200 bg-zinc-50 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
            />
          </div>

          {/* Status filter chips */}
          <div className="flex items-center gap-1">
            {STATUS_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setStatusFilter(chip.value)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  statusFilter === chip.value
                    ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700',
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Project scope indicator */}
          <div className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
            <FolderOpen className="h-3.5 w-3.5" />
            <span>
              {activeProjectName
                ? `Showing docs for: ${activeProjectName}`
                : 'Showing all org documents'}
            </span>
          </div>

          {/* Folder filter chip */}
          {activeFolder && (
            <button
              type="button"
              onClick={() => onNavigate('/documents')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300 text-xs font-medium hover:bg-primary-200 dark:hover:bg-primary-900/60"
              title="Clear folder filter"
            >
              <FolderOpen className="h-3 w-3" />
              {activeFolder.name}
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <Button size="sm" onClick={() => onNavigate('/new')}>
          <Plus className="h-4 w-4" />
          New Document
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-zinc-500 dark:text-zinc-400">No documents yet. Create your first one.</p>
            <Button size="sm" className="mt-4" onClick={() => onNavigate('/new')}>
              <Plus className="h-4 w-4" />
              New Document
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-3 max-w-4xl">
              {documents.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  document={doc}
                  onClick={() => onNavigate(`/documents/${doc.slug ?? doc.id}`)}
                  onDelete={() => {
                    if (window.confirm(`Delete "${doc.title}"? You can restore it from the Archived filter.`)) {
                      archiveDoc.mutate(doc.id);
                    }
                  }}
                  deleting={archiveDoc.isPending && archiveDoc.variables === doc.id}
                />
              ))}
            </div>

            {hasNextPage && (
              <div className="flex justify-center mt-6">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  loading={isFetchingNextPage}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
