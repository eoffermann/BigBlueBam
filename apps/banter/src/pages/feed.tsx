import { useMemo, useState } from 'react';
import {
  Sparkles,
  AtSign,
  Reply,
  MessageSquare,
  ExternalLink,
  X,
  Check,
  Inbox,
  Loader2,
} from 'lucide-react';
import {
  useFeed,
  useFeedEntry,
  useMarkFeedSeen,
  useDismissFeedEntry,
  type FeedEntry,
  type FeedFilters,
} from '@/hooks/use-feed';
import { cn } from '@/lib/utils';

interface FeedPageProps {
  entryId?: string;
  onNavigate: (path: string) => void;
}

/**
 * Banter Feed — the ranked, top-down stream (banter-feed-design-document.md §1).
 * Most-recently-active content floats up; content you relate to outranks the
 * rest. A permalink (/banter/feed/:id) focuses one entry at the top.
 */
export function FeedPage({ entryId, onNavigate }: FeedPageProps) {
  const [unseenOnly, setUnseenOnly] = useState(false);
  const filters: FeedFilters = unseenOnly ? { unseen: true } : {};
  const feed = useFeed(filters);
  const focused = useFeedEntry(entryId);
  const markSeen = useMarkFeedSeen();
  const dismiss = useDismissFeedEntry();

  const entries = useMemo(
    () => feed.data?.pages.flatMap((p) => p.data) ?? [],
    [feed.data],
  );
  const unseenIds = entries.filter((e) => !e.seen).map((e) => e.id);

  const openEntry = (entry: FeedEntry) => {
    if (!entry.seen) markSeen.mutate({ entry_ids: [entry.id] });
    if (entry.open_in_app) onNavigate(entry.open_in_app);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary-500" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Feed</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setUnseenOnly((v) => !v)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              unseenOnly
                ? 'bg-primary-50 text-primary-700 dark:bg-primary-950 dark:text-primary-300'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            {unseenOnly ? 'Showing unread' : 'All'}
          </button>
          <button
            disabled={unseenIds.length === 0 || markSeen.isPending}
            onClick={() => markSeen.mutate({ entry_ids: unseenIds })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Check className="h-4 w-4" />
            Mark all read
          </button>
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4 space-y-2">
          {/* Focused permalink entry */}
          {entryId && focused.data && (
            <div className="mb-4">
              <p className="text-xs uppercase tracking-wide text-zinc-400 mb-1 px-1">
                Linked item
              </p>
              <FeedEntryCard
                entry={focused.data}
                focused
                onOpen={() => openEntry(focused.data!)}
                onDismiss={() => dismiss.mutate(focused.data!.id)}
              />
            </div>
          )}

          {feed.isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            </div>
          )}

          {!feed.isLoading && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center text-zinc-400">
              <Inbox className="h-10 w-10 mb-3" />
              <p className="text-base font-medium text-zinc-500 dark:text-zinc-400">
                Your feed is quiet
              </p>
              <p className="text-sm mt-1">
                Posts in channels you follow and activity that concerns you will show up here.
              </p>
            </div>
          )}

          {entries.map((entry) => (
            <FeedEntryCard
              key={entry.id}
              entry={entry}
              onOpen={() => openEntry(entry)}
              onDismiss={() => dismiss.mutate(entry.id)}
            />
          ))}

          {feed.hasNextPage && (
            <div className="flex justify-center py-4">
              <button
                onClick={() => feed.fetchNextPage()}
                disabled={feed.isFetchingNextPage}
                className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry card
// ---------------------------------------------------------------------------

const CATEGORY_META: Record<string, { label: string; icon: typeof Sparkles; tone: string }> = {
  'banter.mention': { label: 'Mention', icon: AtSign, tone: 'text-amber-600 dark:text-amber-400' },
  'mention.cross_app': { label: 'Mention', icon: AtSign, tone: 'text-amber-600 dark:text-amber-400' },
  'banter.thread.reply': { label: 'Thread reply', icon: Reply, tone: 'text-sky-600 dark:text-sky-400' },
  'banter.channel_post': { label: 'Channel', icon: MessageSquare, tone: 'text-zinc-500' },
  'approval.awaiting_me': { label: 'Needs your approval', icon: Sparkles, tone: 'text-rose-600 dark:text-rose-400' },
};

function categoryMeta(category: string) {
  return (
    CATEGORY_META[category] ?? {
      label: category.replace(/[._]/g, ' '),
      icon: Sparkles,
      tone: 'text-zinc-500',
    }
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function FeedEntryCard({
  entry,
  focused,
  onOpen,
  onDismiss,
}: {
  entry: FeedEntry;
  focused?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const meta = categoryMeta(entry.category);
  const Icon = meta.icon;
  const initials = (entry.author?.display_name ?? '?').slice(0, 1).toUpperCase();

  return (
    <div
      className={cn(
        'group relative rounded-xl border px-4 py-3 transition-colors cursor-pointer',
        focused
          ? 'border-primary-300 bg-primary-50/50 dark:border-primary-800 dark:bg-primary-950/30'
          : entry.seen
            ? 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
            : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
      )}
      onClick={onOpen}
    >
      <div className="flex items-start gap-3">
        {/* Unseen dot */}
        {!entry.seen && (
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-primary-500" />
        )}

        {/* Avatar */}
        <div className="flex-shrink-0">
          {entry.author?.avatar_url ? (
            <img
              src={entry.author.avatar_url}
              alt=""
              className="h-9 w-9 rounded-full object-cover"
            />
          ) : (
            <div className="h-9 w-9 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              {initials}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon className={cn('h-3.5 w-3.5 flex-shrink-0', meta.tone)} />
            <span className={cn('text-xs font-medium', meta.tone)}>{meta.label}</span>
            <span className="text-xs text-zinc-400">· {timeAgo(entry.last_activity_at)}</span>
          </div>
          <p
            className={cn(
              'text-sm mt-0.5 truncate',
              entry.seen
                ? 'text-zinc-600 dark:text-zinc-400'
                : 'text-zinc-900 dark:text-zinc-100 font-medium',
            )}
          >
            {entry.title}
          </p>
          {entry.preview && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">
              {entry.preview}
            </p>
          )}
          {entry.engagement_count > 0 && (
            <p className="text-xs text-zinc-400 mt-1">{entry.engagement_count} reactions/replies</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {entry.open_in_app && (
            <button
              title="Open in app"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
