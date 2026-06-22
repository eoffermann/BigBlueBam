import {
  PlusCircle,
  FileText,
  Search,
  LayoutTemplate,
  Clock,
  Star,
  BookOpen,
  Send,
} from 'lucide-react';
import { useDocumentStats, useRecentDocuments, useStarredDocuments } from '@/hooks/use-documents';
import { StatusBadge } from '@/components/document/status-badge';
import { Avatar } from '@/components/common/avatar';
import { formatRelativeTime } from '@/lib/utils';

interface HomePageProps {
  onNavigate: (path: string) => void;
}

export function HomePage({ onNavigate }: HomePageProps) {
  const { data: stats } = useDocumentStats();
  const { data: recentDocs } = useRecentDocuments();
  const { data: starredDocs } = useStarredDocuments();

  const totalDocs = stats?.total ?? 0;
  const inReviewCount = stats?.in_review ?? 0;
  const recentCount = stats?.recent ?? 0;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Brief</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Welcome to Brief, your team's collaborative document editor.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={<BookOpen className="h-5 w-5 text-primary-500" />}
          label="Total Documents"
          value={totalDocs}
          onClick={() => onNavigate('/documents')}
        />
        <StatCard
          icon={<Send className="h-5 w-5 text-yellow-500" />}
          label="In Review"
          value={inReviewCount}
          accent={inReviewCount > 0 ? 'yellow' : undefined}
          onClick={() => onNavigate('/documents')}
        />
        <StatCard
          icon={<Clock className="h-5 w-5 text-green-500" />}
          label="Recently Updated"
          value={recentCount}
          onClick={() => onNavigate('/documents')}
        />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <ActionCard
          icon={<PlusCircle className="h-5 w-5" />}
          title="New Document"
          description="Start writing a new document"
          onClick={() => onNavigate('/new')}
        />
        <ActionCard
          icon={<FileText className="h-5 w-5" />}
          title="Browse"
          description="View all your documents"
          onClick={() => onNavigate('/documents')}
        />
        <ActionCard
          icon={<Search className="h-5 w-5" />}
          title="Search"
          description="Find documents quickly"
          onClick={() => onNavigate('/search')}
        />
        <ActionCard
          icon={<LayoutTemplate className="h-5 w-5" />}
          title="Templates"
          description="Start from a template"
          onClick={() => onNavigate('/templates')}
        />
      </div>

      {/* Recent documents */}
      {recentDocs && recentDocs.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-400" />
            Recent Documents
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
            {recentDocs.slice(0, 8).map((doc) => (
              <button
                key={doc.id}
                onClick={() => onNavigate(`/documents/${doc.slug ?? doc.id}`)}
                className="w-full text-left px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{doc.icon ?? ''}</span>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {doc.title}
                    </p>
                  </div>
                  {doc.summary && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 break-words mt-0.5">
                      {doc.summary}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    <Avatar src={doc.creator_avatar_url} name={doc.creator_name} size="sm" />
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {doc.creator_name ?? 'Unknown'}
                    </span>
                    <span className="text-xs text-zinc-400">
                      {formatRelativeTime(doc.updated_at)}
                    </span>
                  </div>
                </div>
                <StatusBadge status={doc.status} />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Starred documents */}
      {starredDocs && starredDocs.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 flex items-center gap-2">
            <Star className="h-4 w-4 text-yellow-500" />
            Starred Documents
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
            {starredDocs.slice(0, 5).map((doc) => (
              <button
                key={doc.id}
                onClick={() => onNavigate(`/documents/${doc.slug ?? doc.id}`)}
                className="w-full text-left px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{doc.icon ?? ''}</span>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {doc.title}
                    </p>
                  </div>
                </div>
                <StatusBadge status={doc.status} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: 'yellow';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 text-left hover:border-primary-300 hover:bg-primary-50/30 dark:hover:border-primary-700 dark:hover:bg-primary-900/10 transition-colors"
    >
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {value}
          </p>
          <p className={`text-xs ${accent === 'yellow' && value > 0 ? 'text-yellow-600 dark:text-yellow-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {label}
          </p>
        </div>
      </div>
    </button>
  );
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 text-left hover:border-primary-300 hover:bg-primary-50/50 dark:hover:border-primary-700 dark:hover:bg-primary-900/10 transition-colors"
    >
      <div className="text-primary-600 dark:text-primary-400 mb-2">{icon}</div>
      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      <p className="mt-1 text-sm text-zinc-500">{description}</p>
    </button>
  );
}
