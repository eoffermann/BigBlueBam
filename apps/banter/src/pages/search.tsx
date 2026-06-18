import { useState, useEffect } from 'react';
import { Search as SearchIcon, Hash, Filter, Paperclip } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn, formatRelativeTime, truncate } from '@/lib/utils';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { useChannels } from '@/hooks/use-channels';

interface SearchResult {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_slug: string;
  author_display_name: string;
  content: string;
  created_at: string;
}

interface SearchPageProps {
  onNavigate: (path: string) => void;
}

interface OrgMember {
  id: string;
  display_name: string;
}

export function SearchPage({ onNavigate }: SearchPageProps) {
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Filter state
  const [channelFilter, setChannelFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hasAttachments, setHasAttachments] = useState(false);

  // Channels for filter dropdown
  const { data: channels } = useChannels();

  // Org members for author filter dropdown
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  useEffect(() => {
    fetch('/b3/api/org/members', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j.data) setOrgMembers(j.data);
      })
      .catch(() => {});
  }, []);

  const { data: results, isLoading } = useQuery({
    queryKey: ['search', searchTerm, channelFilter, authorFilter, dateFrom, dateTo, hasAttachments],
    queryFn: () =>
      api
        .get<{ data: SearchResult[] }>('/search/messages', {
          q: searchTerm,
          channel_id: channelFilter || undefined,
          author_id: authorFilter || undefined,
          after: dateFrom || undefined,
          before: dateTo || undefined,
          has_attachments: hasAttachments ? true : undefined,
        })
        .then((r) => r.data),
    enabled: searchTerm.length >= 2,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchTerm(query.trim());
  };

  const activeFilterCount =
    (channelFilter ? 1 : 0) +
    (authorFilter ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0) +
    (hasAttachments ? 1 : 0);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Search</h2>
      </header>

      <div className="px-6 py-4 space-y-3">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search messages..."
              className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors',
              showFilters || activeFilterCount > 0
                ? 'border-primary-400 dark:border-primary-600 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600',
            )}
          >
            <Filter className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 h-5 w-5 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
        </form>

        {/* Filter panel */}
        {showFilters && (
          <div className="grid grid-cols-2 gap-3 p-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
            {/* Channel filter */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                Channel
              </label>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
              >
                <option value="">All channels</option>
                {channels?.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    # {ch.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Author filter */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                Author
              </label>
              <select
                value={authorFilter}
                onChange={(e) => setAuthorFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
              >
                <option value="">Anyone</option>
                {orgMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </div>

            {/* Date from */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                From date
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
              />
            </div>

            {/* Date to */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                To date
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary-400 dark:focus:border-primary-600 transition-colors"
              />
            </div>

            {/* Has attachments toggle */}
            <div className="col-span-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-zinc-400" />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">Has attachments</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={hasAttachments}
                onClick={() => setHasAttachments(!hasAttachments)}
                className={cn(
                  'relative inline-flex h-6 w-10 items-center rounded-full transition-colors',
                  hasAttachments ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-600',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                    hasAttachments ? 'translate-x-5' : 'translate-x-1',
                  )}
                />
              </button>
            </div>

            {/* Clear filters */}
            {activeFilterCount > 0 && (
              <div className="col-span-2">
                <button
                  type="button"
                  onClick={() => {
                    setChannelFilter('');
                    setAuthorFilter('');
                    setDateFrom('');
                    setDateTo('');
                    setHasAttachments(false);
                  }}
                  className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                >
                  Clear all filters
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 pb-6">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full" />
          </div>
        )}

        {searchTerm && !isLoading && (!results || results.length === 0) && (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-lg font-medium">No results found</p>
            <p className="text-sm mt-1">Try different keywords</p>
          </div>
        )}

        {!searchTerm && (
          <div className="text-center py-12 text-zinc-500">
            <SearchIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg font-medium">Search across all channels</p>
            <p className="text-sm mt-1">Find messages, files, and more</p>
          </div>
        )}

        <div className="space-y-2">
          {results?.map((result) => (
            <button
              key={result.id}
              onClick={() => onNavigate(`/channels/${result.channel_slug}`)}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 hover:border-primary-300 dark:hover:border-primary-700 transition-colors"
            >
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                <Hash className="h-3 w-3" />
                <span>{result.channel_name}</span>
                <span>-</span>
                <span>{result.author_display_name}</span>
                <span>-</span>
                <span>{formatRelativeTime(result.created_at)}</span>
              </div>
              <div
                className="rich-text-content text-sm text-zinc-800 dark:text-zinc-200 line-clamp-3"
                dangerouslySetInnerHTML={{
                  __html: sanitizeHtml(markdownToHtml(truncate(result.content, 300))),
                }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
