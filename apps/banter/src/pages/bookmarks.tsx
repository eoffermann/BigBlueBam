import { Hash, Trash2, ExternalLink } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRelativeTime, truncate } from '@/lib/utils';

interface BookmarkEntry {
  id: string;
  message_id: string;
  channel_id: string;
  channel_name: string;
  channel_slug: string;
  message_content: string;
  message_author_display_name: string;
  created_at: string;
}

interface BookmarksPageProps {
  onNavigate: (path: string) => void;
}

export function BookmarksPage({ onNavigate }: BookmarksPageProps) {
  const queryClient = useQueryClient();

  const { data: bookmarks, isLoading } = useQuery({
    queryKey: ['bookmarks'],
    queryFn: () => api.get<{ data: BookmarkEntry[] }>('/bookmarks').then((r) => r.data),
  });

  const removeBookmark = useMutation({
    mutationFn: (bookmarkId: string) => api.delete(`/bookmarks/${bookmarkId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Bookmarks
        </h2>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full" />
          </div>
        )}

        {!isLoading && (!bookmarks || bookmarks.length === 0) && (
          <div className="text-center py-12 text-zinc-500">
            <p className="text-lg font-medium">No bookmarks yet</p>
            <p className="text-sm mt-1">
              Bookmark messages to save them for later reference
            </p>
          </div>
        )}

        <div className="space-y-2">
          {bookmarks?.map((bookmark) => (
            <div
              key={bookmark.id}
              className="flex items-start gap-3 p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                  <Hash className="h-3 w-3" />
                  <button
                    onClick={() => onNavigate(`/channels/${bookmark.channel_slug}`)}
                    className="hover:text-primary-500 transition-colors"
                  >
                    {bookmark.channel_name}
                  </button>
                  <span>-</span>
                  <span>{bookmark.message_author_display_name}</span>
                  <span>-</span>
                  <span>{formatRelativeTime(bookmark.created_at)}</span>
                </div>
                <p className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2">
                  {truncate(bookmark.message_content, 200)}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onNavigate(`/channels/${bookmark.channel_slug}`)}
                  className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                  title="Go to message"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
                <button
                  onClick={() => removeBookmark.mutate(bookmark.id)}
                  className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Remove bookmark"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
